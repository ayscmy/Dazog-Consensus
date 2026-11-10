import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { one, all, run, nowIso, ROOT_DIR } from './db.js';
import { exportOrg } from './org-transfer.js';
import { seal } from './org-snapshot.js';

/**
 * 租户实例编排（最小闭环）
 *
 * 形态：共享一份代码 + 每租户独立数据目录/库/进程。
 * 本模块负责「建实例」：分配端口、建目录、初始化库与管理员、写回 tenants 台账；
 * 并在实例启动前把试用共享实例里的组织数据搬进独立实例库（P1-B）。
 * 启停与健康检查见 scripts/tenant-ctl.mjs；生产环境建议用 systemd 模板（见 docs/26）。
 */

export const TENANT_ROOT = process.env.TENANT_ROOT || join(ROOT_DIR, 'tenants');
export const PORT_BASE = Number(process.env.TENANT_PORT_BASE || 18200);
export const PUBLIC_BASE = String(process.env.TENANT_PUBLIC_BASE || 'crm.example.com').replace(/^\.+|\.+$/g, '');

const SECRET = String(process.env.CRM_SECRET || 'mserm-tenant-provision-secret');
const KEY = createHash('sha256').update(SECRET).digest();

function enc(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}

function dec(token) {
  try {
    const [v, iv, tag, body] = String(token || '').split('.');
    if (v !== 'v1') return '';
    const d = createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function genPassword(len = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  const buf = randomBytes(len);
  for (let i = 0; i < len; i++) s += chars[buf[i] % chars.length];
  return s;
}

async function allocatePort() {
  const row = await one('select max(port) m from tenants where port is not null');
  return Math.max(PORT_BASE, Number(row?.m || 0) + 1);
}

function slugOf(code) {
  return String(code).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/** 子进程输出可能夹带 [db] 补列日志，取最后一行 JSON 解析 */
function parseLastJson(child) {
  const text = `${child.stdout || ''}\n${child.stderr || ''}`;
  for (const line of text.split(/\r?\n/).reverse()) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      return JSON.parse(s);
    } catch {
      // 继续向前找
    }
  }
  return null;
}

/**
 * 把试用共享实例里的组织业务数据搬进独立实例库（P1-B）。
 *
 * 边界：导出发生在当前进程（连的是共享实例库），导入在子进程里把 CRM_DB 指向目标库，
 *      官网全程不接触快照。快照加密落盘，导入成功后删除，避免业务数据长期留在实例目录。
 * 失败只把 tenants.migration_state 标为 failed，不把整个实例判死，也不吞掉错误。
 */
async function migrateOrgData(t, dbFile, dir, password) {
  if (!t.org_id) {
    return { state: 'skipped', note: '无试用组织数据（tenants.org_id 为空）' };
  }
  await run(
    "update tenants set migration_state='running', migration_note=?, updated_at=? where id=?",
    '正在导出试用组织快照', nowIso(), t.id
  );

  let snapFile = '';
  try {
    const snap = await exportOrg(t.org_id);
    snapFile = join(dir, 'migration', 'org-snapshot.json');
    mkdirSync(dirname(snapFile), { recursive: true });
    writeFileSync(snapFile, JSON.stringify(seal(snap, password)), 'utf8');

    const child = spawnSync(process.execPath, ['--no-warnings', join(ROOT_DIR, 'scripts', 'org-import.mjs')], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ENV_FILE: join(dir, '.env'),
        CRM_DB: dbFile,
        ORG_SNAPSHOT_FILE: snapFile,
        ORG_SNAPSHOT_PASS: password,
        ORG_NAME: t.name,
      },
      encoding: 'utf8',
      timeout: 120000,
    });
    const out = parseLastJson(child);
    if (child.status !== 0 || !out?.ok) {
      throw new Error(`导入子进程失败：${(child.stderr || child.stdout || '').trim().slice(0, 360)}`);
    }

    rmSync(snapFile, { force: true });
    snapFile = '';
    const fk = Number(out.fkViolations?.length || 0);
    const note = [
      `已导入 ${Number(out.importedRows || 0)} 行`,
      out.skippedRows ? `去重跳过 ${out.skippedRows} 行` : '',
      out.already ? '（目标库已完成同一次导入）' : '',
      fk ? `外键待核对 ${fk} 处` : '',
      `checksum=${out.checksum}`,
    ].filter(Boolean).join('；');
    await run(
      'update tenants set migration_state=?, migration_note=?, updated_at=? where id=?',
      'done', note.slice(0, 900), nowIso(), t.id
    );
    return {
      state: 'done', note, checksum: out.checksum,
      rows: Number(out.importedRows || 0), fkViolations: fk,
    };
  } catch (e) {
    // 保留加密快照供排查；运维可重跑 provision:tenant --code=xxx 重试
    const note = String(e.message || e).slice(0, 900);
    await run(
      'update tenants set migration_state=?, migration_note=?, updated_at=? where id=?',
      'failed', note, nowIso(), t.id
    );
    return { state: 'failed', note, snapshotFile: snapFile || undefined };
  }
}

/**
 * 建实例（幂等）：已 provisioned/running 的租户直接返回既有信息。
 * 返回的管理员密码只在这里出现一次，同时以 AES 密文存库，重试可还原。
 */
export async function provisionTenant(code) {
  const t = await one('select * from tenants where code = ?', code);
  if (!t) throw new Error(`租户不存在：${code}`);

  if (['provisioned', 'running'].includes(t.instance_state) && t.data_dir && t.port) {
    const result = {
      ok: true, already: true,
      code: t.code, port: Number(t.port), dir: t.data_dir,
      adminUser: 'admin', adminPassword: dec(t.admin_password),
      instanceState: t.instance_state,
      migrationState: t.migration_state || 'pending',
    };
    // 实例已启动时不碰它的库文件；未启动且迁移未完成/失败则允许重跑迁移
    const migState = String(t.migration_state || 'pending');
    if (t.org_id && t.instance_state !== 'running' && ['pending', 'failed', 'running'].includes(migState)) {
      const dbFile = join(t.data_dir, 'data', 'crm.db');
      result.migration = await migrateOrgData(t, dbFile, t.data_dir, dec(t.admin_password) || '');
      result.migrationState = result.migration.state;
    }
    return result;
  }

  const slug = slugOf(t.code);
  const dir = join(TENANT_ROOT, slug);
  const dataDir = join(dir, 'data');
  const dbFile = join(dataDir, 'crm.db');
  mkdirSync(dataDir, { recursive: true });

  const port = t.port ? Number(t.port) : await allocatePort();
  const password = dec(t.admin_password) || genPassword(12);

  // 租户自己的 .env：独立库、独立端口、关闭对外试用接口
  const envText = [
    `# 租户 ${t.code} · 由编排器生成，请勿手改端口`,
    'HOST=127.0.0.1',
    `PORT=${port}`,
    'DB_TYPE=sqlite',
    `CRM_DB=${dbFile}`,
    'CRM_LOG=0',
    '',
  ].join('\n');
  writeFileSync(join(dir, '.env'), envText);

  const child = spawnSync(process.execPath, ['--no-warnings', join(ROOT_DIR, 'scripts', 'init-tenant.mjs')], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ENV_FILE: join(dir, '.env'),
      CRM_DB: dbFile,
      TENANT_ORG_NAME: t.name,
      TENANT_ADMIN_USER: 'admin',
      TENANT_ADMIN_PASS: password,
      TENANT_ADMIN_NAME: `${t.name} 管理员`,
    },
    encoding: 'utf8',
    timeout: 60000,
  });

  if (child.status !== 0) {
    await run("update tenants set instance_state='failed', updated_at=? where id=?", nowIso(), t.id);
    throw new Error(`初始化失败：${(child.stderr || child.stdout || '').trim().slice(0, 400)}`);
  }

  // P1-B：试用共享 → 付费独立实例的数据搬家（必须在实例启动前完成，避免写库冲突）
  const migration = await migrateOrgData(t, dbFile, dir, password);

  await run(
    `update tenants set port=?, data_dir=?, subdomain=?, instance_state='provisioned',
       admin_password=?, updated_at=? where id=?`,
    port, dir, `${slug}.${PUBLIC_BASE}`, enc(password), nowIso(), t.id
  );

  return {
    ok: true,
    code: t.code,
    port,
    dir,
    dataDir,
    dbFile,
    subdomain: `${slug}.${PUBLIC_BASE}`,
    adminUser: 'admin',
    adminPassword: password,
    instanceState: 'provisioned',
    migrationState: migration.state,
    migrationNote: migration.note,
    url: `http://127.0.0.1:${port}`,
  };
}

/** 列出待编排租户 */
export async function listPending() {
  return await all(`select code from tenants where instance_state in ('pending','failed') order by id`);
}

/** 遍历待编排租户 */
export async function provisionAllPending() {
  const rows = await listPending();
  const out = [];
  for (const r of rows) {
    try {
      out.push(await provisionTenant(r.code));
    } catch (e) {
      out.push({ ok: false, code: r.code, error: String(e.message || e) });
    }
  }
  return out;
}
