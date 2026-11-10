import { randomBytes } from 'node:crypto';
import { all, one, run, tx, nowIso, DB_ENGINE, migrate, idOf } from './db.js';
import { HttpError } from './http.js';
import { hashPassword } from './password.js';
import {
  SNAPSHOT_FORMAT, SNAPSHOT_VERSION, ORG_TABLES, FK_RULES, USER_RULES,
  TABLE_ORDER, USER_REF_COLS, DEDUP_KEYS, checksumOf, assertSnapshot, countRows,
} from './org-snapshot.js';

/**
 * 组织数据导出 / 导入（P1-B）
 *
 * 场景：试用共享实例 → 付费独立实例。导出在共享实例进程内完成（当前连接即源库），
 *      快照加密落盘后，由编排器以子进程把 CRM_DB 指向目标实例库再导入。
 *
 * 边界：
 *   - 只导出 org_id 命中的业务表 + 主外键关联表，平台层表（tenants/trial_accounts/
 *     sessions/settings/api_clients/api_logs/contract_templates）不进快照。
 *   - 用户与组织不迁移；org_id 统一重映射到目标根组织，用户引用列统一重映射到目标管理员。
 *   - 首期只支持 SQLite 目标库（独立实例默认单文件 SQLite）；PG 明确报错，不静默降级。
 *   - 导入前置：目标库业务表必须为空，且靠 settings 里的 snapshot 校验和保证幂等。
 */

/** 导出指定组织的业务快照 */
export async function exportOrg(orgId) {
  const org = await one('select * from org_units where id=?', Number(orgId));
  if (!org) throw new HttpError(404, '组织不存在');

  const userIds = (await all('select id from users where org_id=?', org.id)).map((r) => Number(r.id));
  const tables = {};

  for (const t of ORG_TABLES) {
    tables[t] = await all(`select * from ${t} where org_id=?`, org.id);
  }

  for (const [t, rules] of Object.entries(FK_RULES)) {
    const parts = [];
    const args = [];
    for (const [col, parent] of rules) {
      const ids = (tables[parent] || []).map((r) => r.id).filter((v) => v !== undefined && v !== null);
      if (!ids.length) continue;
      parts.push(`${col} in (${ids.map(() => '?').join(',')})`);
      args.push(...ids);
    }
    tables[t] = parts.length
      ? await all(`select * from ${t} where ${parts.join(' or ')}`, ...args)
      : [];
  }

  for (const [t, cols] of Object.entries(USER_RULES)) {
    const parts = [];
    const args = [];
    for (const col of cols) {
      if (!userIds.length) continue;
      parts.push(`${col} in (${userIds.map(() => '?').join(',')})`);
      args.push(...userIds);
    }
    tables[t] = parts.length
      ? await all(`select * from ${t} where ${parts.join(' or ')}`, ...args)
      : [];
  }

  const snap = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    exportedAt: nowIso(),
    source: { orgId: Number(org.id), orgName: org.name, engine: DB_ENGINE },
    tables,
    counts: {},
    checksum: '',
  };
  snap.checksum = checksumOf(snap);
  snap.counts = Object.fromEntries(TABLE_ORDER.map((t) => [t, (tables[t] || []).length]));
  return snap;
}

const MARKER_KEY = 'org_transfer.snapshot';

/**
 * 收集所有指向 users 表的列：DDL 外键元数据 + 命名约定。
 * 只靠手写集合容易漏列（漏了就会留下指向「源库用户 id」的悬空引用），
 * 所以用 pragma foreign_key_list 动态补集。
 */
async function collectUserRefCols() {
  const cols = new Set(USER_REF_COLS);
  for (const t of TABLE_ORDER) {
    let fks = [];
    try {
      fks = await all(`pragma foreign_key_list(${t})`);
    } catch {
      continue;
    }
    for (const fk of fks) {
      if (String(fk.table).toLowerCase() === 'users' && fk.from) cols.add(String(fk.from));
    }
  }
  return cols;
}

/** 导入快照到当前连接的库（CLI / 编排器通过 CRM_DB 指向目标实例库） */
export async function importOrg(snapshot, opts = {}) {
  const snap = assertSnapshot(snapshot);
  if (DB_ENGINE !== 'sqlite') {
    throw new HttpError(400, '首期组织导入仅支持 SQLite 目标库；PostgreSQL 请先用备份/恢复工具');
  }
  await migrate();

  const marker = await one('select value from settings where key=?', MARKER_KEY);
  if (marker?.value === snap.checksum) {
    return { ok: true, already: true, checksum: snap.checksum, rows: 0 };
  }

  // 防覆盖：目标库若已有业务数据且不是同一次导入，拒绝执行
  for (const t of TABLE_ORDER) {
    const c = await one(`select count(*) as c from ${t}`);
    if (Number(c?.c || 0) > 0) {
      throw new HttpError(409, `目标库表 ${t} 已有数据，为避免覆盖请先清空或使用全新实例库`);
    }
  }

  let root = await one('select * from org_units where parent_id is null order by id limit 1');
  if (!root) {
    const r = await run(
      "insert into org_units(name,type,path,level,created_at) values(?,?,?,?,?)",
      String(opts.orgName || snap.source?.orgName || '迁移导入组织').slice(0, 80), 'group', '/', 1, nowIso()
    );
    const id = idOf(r);
    await run('update org_units set path=? where id=?', `/${id}/`, id);
    root = await one('select * from org_units where id=?', id);
  }

  let admin = await one('select * from users order by id limit 1');
  let generatedPassword = null;
  if (!admin) {
    generatedPassword = randomBytes(9).toString('base64url');
    const r = await run(
      `insert into users(username,name,password,email,phone,org_id,title,status,created_at)
       values(?,?,?,?,?,?,?,?,?)`,
      'admin', '系统管理员', hashPassword(generatedPassword), null, null,
      root.id, '系统管理员', 'active', nowIso()
    );
    const uid = idOf(r);
    await run('insert into user_roles(user_id,role) values(?,?)', uid, 'admin');
    admin = { id: uid };
  }

  const rootId = Number(root.id);
  const adminId = Number(admin.id);
  const userRefCols = await collectUserRefCols();
  const remap = (col, value) => {
    if (col === 'org_id') return rootId;
    if (userRefCols.has(col) && value !== null && value !== undefined) return adminId;
    return value;
  };

  // 循环引用（opportunities.contract_id ↔ contracts.opportunity_id）无法按拓扑顺序插入，
  // 且跨组织引用在迁移后可能悬空；事务内临时关闭外键检查，导入后恢复并做 foreign_key_check。
  await run('PRAGMA foreign_keys=OFF');
  let skipped = 0;
  try {
    await tx(async () => {
      for (const t of TABLE_ORDER) {
        const info = await all(`pragma table_info(${t})`);
        const allowed = new Set(info.map((c) => String(c.name)));
        const rows = snap.tables[t] || [];
        if (!rows.length) continue;
        const dedupCols = (DEDUP_KEYS[t] || []).filter((c) => allowed.has(c));
        const seen = dedupCols.length ? new Set() : null;
        for (const row of rows) {
          const cols = Object.keys(row).filter((c) => allowed.has(c));
          if (!cols.length) continue;
          const vals = cols.map((c) => remap(c, row[c]));
          if (seen) {
            const key = dedupCols.map((c) => {
              const i = cols.indexOf(c);
              return i < 0 ? '' : String(vals[i]);
            }).join('\u0001');
            if (seen.has(key)) { skipped++; continue; }
            seen.add(key);
          }
          await run(
            `insert into ${t}(${cols.map((c) => `"${c}"`).join(',')}) values(${cols.map(() => '?').join(',')})`,
            ...vals
          );
        }
      }
      await run(
        'insert or replace into settings(key,value,updated_at) values(?,?,?)',
        MARKER_KEY, snap.checksum, nowIso()
      );
    });
  } finally {
    await run('PRAGMA foreign_keys=ON');
  }

  // 不静默吞掉引用问题：把 foreign_key_check 的结果返回给编排器写入迁移备注。
  let fkViolations = [];
  try {
    fkViolations = (await all('pragma foreign_key_check')).map((v) => ({
      table: String(v.table), rowid: v.rowid, parent: String(v.parent), fkid: v.fkid,
    }));
  } catch {
    // 极老的 SQLite 无此 pragma，忽略
  }

  return {
    ok: true,
    rows: countRows(snap),
    importedRows: countRows(snap) - skipped,
    skippedRows: skipped,
    orgId: rootId,
    adminUserId: adminId,
    checksum: snap.checksum,
    generatedPassword,
    fkViolations,
  };
}

/** 按 email 定位组织（官网只传会员邮箱，不必知道 CRM 内部 org_id） */
export async function locateOrgByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) throw new HttpError(400, '缺少 email');
  const t = await one('select org_id from tenants where owner_email=? and org_id is not null order by id desc limit 1', e);
  if (t?.org_id) return Number(t.org_id);
  const a = await one('select org_id from trial_accounts where email=? and org_id is not null order by id desc limit 1', e);
  if (a?.org_id) return Number(a.org_id);
  throw new HttpError(404, '该邮箱在 CRM 中没有可迁移的组织');
}
