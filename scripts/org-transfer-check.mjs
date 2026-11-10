/**
 * P1-B 验收：组织级数据导出 / 导入（试用共享 → 付费独立实例迁移）
 *
 *   node --no-warnings scripts/org-transfer-check.mjs
 *   node --no-warnings scripts/org-transfer-check.mjs --provision-probe
 *     （内部使用：由主脚本拉起的子进程，用来跑真实编排器冒烟）
 *
 * 隔离原则：全程使用临时 SQLite + ENV_FILE 空文件，不碰生产库 / 线上服务。
 * 主进程不 import db.js（它在模块求值期就锁定库文件），只用 node:sqlite 直接造数据；
 * 导出 / 导入 / 初始化 / 备份一律走真实 CLI 子进程，等价于生产调用路径。
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import {
  TABLE_ORDER, EXCLUDED_TABLES, SNAPSHOT_FORMAT,
  checksumOf, assertSnapshot, seal, unseal, readSnapshotFile,
  canonicalTables, countRows,
} from '../src/org-snapshot.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date().toISOString();

let pass = 0;
let fail = 0;
function section(name) {
  console.log(`\n=== ${name} ===`);
}
function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  [OK] ${name}`);
  } else {
    fail++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

/** 用真实 CLI 子进程执行；从输出尾部解析最后一行 JSON（前面可能有 [db] 日志） */
function runCli(rel, env = {}, args = [], timeout = 90000) {
  const r = spawnSync(process.execPath, ['--no-warnings', join(ROOT, rel), ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      ENV_FILE: env.ENV_FILE || join(ROOT, 'scripts', '__no_such_env__'),
      DB_TYPE: 'sqlite',
      ...env,
    },
    encoding: 'utf8',
    timeout,
  });
  let json = null;
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  for (const line of text.split(/\r?\n/).reverse()) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try { json = JSON.parse(s); break; } catch { /* 继续向前找 */ }
  }
  return { status: r.status, json, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

/** 按 pragma table_info 自动补齐 NOT NULL 无默认值的列，避免手写 DDL 细节出错 */
function insertRow(sdb, table, obj) {
  const info = sdb.prepare(`pragma table_info(${table})`).all();
  const row = { ...obj };
  for (const c of info) {
    if (row[c.name] !== undefined) continue;
    if (['created_at', 'updated_at', 'applied_at', 'received_at', 'expires_at'].includes(c.name)) {
      row[c.name] = NOW;
      continue;
    }
    if (Number(c.notnull) === 1 && c.dflt_value === null && Number(c.pk) === 0) {
      row[c.name] = /INT|REAL|NUM|BOOL/i.test(String(c.type)) ? 0 : '';
    }
  }
  const keys = Object.keys(row).filter((k) => info.some((c) => c.name === k));
  sdb.prepare(
    `insert into ${table}(${keys.join(',')}) values(${keys.map(() => '?').join(',')})`
  ).run(...keys.map((k) => (row[k] === undefined ? null : row[k])));
}

// ---------------------------------------------------------------------------
// 子进程分支：真实编排器冒烟（主进程通过 --provision-probe 拉起）
// ---------------------------------------------------------------------------
if (process.argv.includes('--provision-probe')) {
  const { provisionTenant } = await import('../src/tenant-provision.js');
  try {
    const out = await provisionTenant(String(process.env.PROBE_CODE || ''));
    console.log(JSON.stringify({ ok: true, out }));
    process.exit(0);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'org-transfer-'));
const emptyEnv = join(tmp, 'empty.env');
writeFileSync(emptyEnv, '');
const dbA = join(tmp, 'source.db');       // 试用共享实例库
const dbB = join(tmp, 'target.db');       // 全新独立实例库
const dbC = join(tmp, 'nonempty.db');     // 已有业务数据的目标库（应拒绝导入）
const snapFile = join(tmp, 'snapshot.json');
const snapFile2 = join(tmp, 'snapshot-by-email.json');
const PASS = 'p1b-test-passphrase';
const CLI_ENV = { ENV_FILE: emptyEnv };

function initDb(file, orgName) {
  return runCli('scripts/init-tenant.mjs', {
    ...CLI_ENV,
    CRM_DB: file,
    TENANT_ORG_NAME: orgName,
    TENANT_ADMIN_USER: 'admin',
    TENANT_ADMIN_PASS: 'test-pass-123',
    TENANT_ADMIN_NAME: `${orgName} 管理员`,
  });
}

try {
  /* ==================== TC-1 隔离建库与造数 ==================== */
  section('TC-1 隔离建库与试用组织造数');
  const i1 = initDb(dbA, '共享实例');
  const i2 = initDb(dbB, '付费独立实例');
  const i3 = initDb(dbC, '非空目标库');
  ok('1-1 三个隔离库初始化成功',
    i1.status === 0 && i2.status === 0 && i3.status === 0 && i1.json?.ok === true,
    `${i1.status}/${i2.status}/${i3.status} ${i1.stderr.slice(0, 120)}`);
  ok('1-2 库文件已生成', existsSync(dbA) && existsSync(dbB) && existsSync(dbC));

  const a = new DatabaseSync(dbA);
  // 组织：1=共享根（init 已建），2=试用组织（导出源），3=别的租户（边界对照）
  insertRow(a, 'org_units', { id: 2, parent_id: 1, path: '/1/2/', name: '试用组织', type: 'group', level: 2 });
  insertRow(a, 'org_units', { id: 3, parent_id: 1, path: '/1/3/', name: '别的租户', type: 'group', level: 2 });
  insertRow(a, 'users', { id: 2, username: 'trial1', name: '试用甲', org_id: 2 });
  insertRow(a, 'users', { id: 3, username: 'trial2', name: '试用乙', org_id: 2 });
  insertRow(a, 'users', { id: 4, username: 'other', name: '其它租户', org_id: 3 });

  // 源组织业务数据（含循环引用、用户引用、唯一约束候选）
  insertRow(a, 'accounts', { id: 1, name: '源客户', org_id: 2, owner_id: 2, created_by: 2 });
  insertRow(a, 'accounts', { id: 2, name: '别的租户客户', org_id: 3, owner_id: 4, created_by: 4 });
  insertRow(a, 'contacts', { id: 1, account_id: 1, name: '联系人甲', created_by: 2 });
  insertRow(a, 'contacts', { id: 2, account_id: 2, name: '联系人乙', created_by: 4 });
  insertRow(a, 'products', { id: 1, code: 'P-SRC-1', name: '源产品', org_id: 2, created_by: 2 });
  insertRow(a, 'products', { id: 2, code: 'P-OTHER-2', name: '别的产品', org_id: 3, created_by: 4 });
  insertRow(a, 'leads', { id: 1, name: '源线索', org_id: 2, owner_id: 2, account_id: 1, contact_id: 1, created_by: 2 });
  insertRow(a, 'leads', { id: 2, name: '别的线索', org_id: 3, owner_id: 4, account_id: 2 });
  insertRow(a, 'opportunities', { id: 1, name: '源商机', org_id: 2, account_id: 1, owner_id: 2, created_by: 2, contract_id: 1 });
  insertRow(a, 'opportunities', { id: 2, name: '别的商机', org_id: 3, account_id: 2, owner_id: 4 });
  insertRow(a, 'quotations', { id: 1, no: 'Q-SRC-1', org_id: 2, opportunity_id: 1, account_id: 1, created_by: 2 });
  insertRow(a, 'quotations', { id: 2, no: 'Q-OTHER-2', org_id: 3, opportunity_id: 2, account_id: 2, created_by: 4 });
  insertRow(a, 'quotation_items', { id: 1, quotation_id: 1, product_id: 1, name: '报价项甲' });
  insertRow(a, 'quotation_items', { id: 2, quotation_id: 2, product_id: 2, name: '报价项乙' });
  insertRow(a, 'quote_sends', { id: 1, quotation_id: 1, channel: 'email', target: 'x@test.local', status: 'sent', sent_by: 2 });
  insertRow(a, 'quote_sends', { id: 2, quotation_id: 2, channel: 'email', target: 'y@test.local', status: 'sent', sent_by: 4 });
  insertRow(a, 'contracts', { id: 1, no: 'C-SRC-1', title: '源合同', org_id: 2, opportunity_id: 1, account_id: 1, quotation_id: 1, owner_id: 2, created_by: 2 });
  insertRow(a, 'contracts', { id: 2, no: 'C-OTHER-2', title: '别的合同', org_id: 3, opportunity_id: 2, account_id: 2, owner_id: 4 });
  insertRow(a, 'payment_plans', { id: 1, contract_id: 1, seq: 1, due_date: '2026-12-01', amount: 100 });
  insertRow(a, 'payment_plans', { id: 2, contract_id: 2, seq: 1, due_date: '2026-12-01', amount: 200 });
  insertRow(a, 'invoices', { id: 1, no: 'INV-SRC-1', contract_id: 1, account_id: 1, amount: 100, apply_by: 2 });
  insertRow(a, 'invoices', { id: 2, no: 'INV-OTHER-2', contract_id: 2, account_id: 2, amount: 200, apply_by: 4 });
  insertRow(a, 'payments', { id: 1, no: 'PAY-SRC-1', contract_id: 1, account_id: 1, amount: 100, created_by: 2 });
  insertRow(a, 'payments', { id: 2, no: 'PAY-OTHER-2', contract_id: 2, account_id: 2, amount: 200, created_by: 4 });
  insertRow(a, 'payment_allocations', { id: 1, payment_id: 1, invoice_id: 1, amount: 100 });
  insertRow(a, 'payment_allocations', { id: 2, payment_id: 2, invoice_id: 2, amount: 200 });
  insertRow(a, 'approvals', { id: 1, type: 'quote', target_type: 'quotation', target_id: 1, title: '源审批', applicant_id: 2, org_id: 2 });
  insertRow(a, 'approvals', { id: 2, type: 'quote', target_type: 'quotation', target_id: 2, title: '别的审批', applicant_id: 4, org_id: 3 });
  insertRow(a, 'approval_steps', { id: 1, approval_id: 1, seq: 1, role: 'admin', label: '一审', approver_id: 3 });
  insertRow(a, 'approval_steps', { id: 2, approval_id: 2, seq: 1, role: 'admin', label: '一审', approver_id: 4 });
  insertRow(a, 'pool_events', { id: 1, lead_id: 1, org_id: 2, actor_id: 2, action: 'claim', to_owner: 2 });
  insertRow(a, 'pool_events', { id: 2, lead_id: 2, org_id: 3, actor_id: 4, action: 'claim', to_owner: 4 });
  // 同一 period 两个用户各一条目标：重映射后 user_id 合并，必须去重，否则违反 UNIQUE(user_id, period)
  insertRow(a, 'targets', { id: 1, user_id: 2, org_id: 2, period: '2026-Q1', amount: 1000 });
  insertRow(a, 'targets', { id: 2, user_id: 3, org_id: 2, period: '2026-Q1', amount: 2000 });
  insertRow(a, 'activities', { id: 1, target_type: 'account', target_id: 1, type: 'visit', content: '源跟进', user_id: 2 });
  insertRow(a, 'activities', { id: 2, target_type: 'account', target_id: 2, type: 'visit', content: '别的跟进', user_id: 4 });
  insertRow(a, 'attachments', { id: 1, target_type: 'account', target_id: 1, name: 'a.txt', size: 10, path: '/a.txt', uploaded_by: 2 });
  insertRow(a, 'attachments', { id: 2, target_type: 'account', target_id: 2, name: 'b.txt', size: 10, path: '/b.txt', uploaded_by: 4 });
  insertRow(a, 'audit_logs', { id: 1, user_id: 2, user_name: '试用甲', action: 'login' });
  insertRow(a, 'audit_logs', { id: 2, user_id: 4, user_name: '其它租户', action: 'login' });
  insertRow(a, 'handovers', { id: 1, user_id: 2, to_user_id: 3, created_by: 2 });
  insertRow(a, 'handovers', { id: 2, user_id: 4, to_user_id: 4, created_by: 4 });
  // 平台层 / 集成凭据 / 日志：都不该进快照
  insertRow(a, 'tenants', { id: 1, code: 'T-TEST', name: '试用转正租户', owner_email: 'boss@test.local', org_id: 2, user_id: 2, instance_state: 'pending' });
  insertRow(a, 'trial_accounts', { id: 1, email: 'boss@test.local', org_id: 2, user_id: 2, expires_at: NOW });
  insertRow(a, 'api_clients', { id: 1, name: '名录凭据', client_id: 'cid-src', key_prefix: 'kp', key_hash: 'kh', org_id: 2, directory_token: 'secret-token', directory_tier: 'pro' });
  insertRow(a, 'api_logs', { id: 1, method: 'GET', path: '/api/leads', status: 200 });
  // contract_templates 由 migrate() 预置内置模板，固定 id 会撞主键，用大 id 回避
  insertRow(a, 'contract_templates', { id: 999, code: 'TPL-SRC', name: '源模板', clauses: '[]' });
  a.close();
  ok('1-3 源库业务数据构造完成', true);

  const cDb = new DatabaseSync(dbC);
  insertRow(cDb, 'accounts', { id: 9, name: '已有客户', org_id: 1 });
  cDb.close();
  ok('1-4 非空目标库已写入 1 行', true);

  /* ==================== TC-2 快照契约（纯逻辑） ==================== */
  section('TC-2 快照契约：校验和 / 篡改 / 加解密');
  const exp = runCli('scripts/org-export.mjs', {
    ...CLI_ENV, CRM_DB: dbA, ORG_ID: '2', ORG_SNAPSHOT_FILE: snapFile, ORG_SNAPSHOT_PASS: PASS,
  });
  ok('2-1 导出 CLI 成功', exp.status === 0 && exp.json?.ok === true, `${exp.status} ${exp.stderr.slice(0, 160)}`);
  ok('2-2 快照文件已落盘', existsSync(snapFile));

  const wrapped = JSON.parse(readFileSync(snapFile, 'utf8'));
  ok('2-3 落盘为加密格式', wrapped.enc === 1 && wrapped.format === SNAPSHOT_FORMAT);
  ok('2-4 口令正确可解封并校验通过', !throws(() => assertSnapshot(unseal(wrapped, PASS))));
  ok('2-5 口令错误被拒绝', throws(() => unseal(wrapped, 'wrong-pass')));
  ok('2-6 readSnapshotFile 正确口令通过', !throws(() => readSnapshotFile(wrapped, PASS)));
  ok('2-7 readSnapshotFile 错误口令拒绝', throws(() => readSnapshotFile(wrapped, 'wrong-pass')));

  const snap = unseal(wrapped, PASS);
  ok('2-8 checksum 可复算', checksumOf(snap) === snap.checksum, snap.checksum);
  ok('2-9 countRows 与表数据一致', countRows(snap) === TABLE_ORDER.reduce((n, t) => n + snap.tables[t].length, 0));
  ok('2-10 键顺序不影响 checksum', (() => {
    const shuffled = { ...snap, tables: Object.fromEntries(Object.entries(snap.tables).reverse()) };
    return checksumOf(shuffled) === snap.checksum;
  })());
  ok('2-11 canonicalTables 结果稳定', canonicalTables(snap.tables) === canonicalTables(Object.fromEntries(Object.entries(snap.tables).reverse())));

  const tampered = { ...snap, tables: { ...snap.tables, accounts: [{ ...snap.tables.accounts[0], name: '篡改' }] } };
  ok('2-12 篡改数据被校验和拒绝', throws(() => assertSnapshot(tampered)));
  ok('2-13 版本不符被拒绝', throws(() => assertSnapshot({ ...snap, version: 99 })));
  ok('2-14 格式不符被拒绝', throws(() => assertSnapshot({ ...snap, format: 'other' })));
  ok('2-15 缺表被拒绝', throws(() => assertSnapshot({ ...snap, tables: { ...snap.tables, accounts: undefined } })));

  /* ==================== TC-3 导出边界 ==================== */
  section('TC-3 导出边界：只带本组织业务数据');
  ok('3-1 快照表集合 = TABLE_ORDER', JSON.stringify(Object.keys(snap.tables).sort()) === JSON.stringify([...TABLE_ORDER].sort()));
  ok('3-2 平台层表全部不在快照', EXCLUDED_TABLES.every((t) => !Object.prototype.hasOwnProperty.call(snap.tables, t)),
    EXCLUDED_TABLES.filter((t) => Object.prototype.hasOwnProperty.call(snap.tables, t)).join(','));
  ok('3-3 accounts 只导出源组织 1 条', snap.tables.accounts.length === 1 && snap.tables.accounts[0].name === '源客户');
  ok('3-4 关联表按主外键收敛（quotation_items 1 条）', snap.tables.quotation_items.length === 1);
  ok('3-5 回款链按 contract_id 收敛（payments 1 条）', snap.tables.payments.length === 1 && snap.tables.payments[0].no === 'PAY-SRC-1');
  ok('3-6 用户引用表按源用户过滤（activities 1 条）', snap.tables.activities.length === 1 && snap.tables.activities[0].user_id === 2);
  ok('3-7 targets 导出 2 条（去重留给导入）', snap.tables.targets.length === 2);
  ok('3-8 集成凭据 api_clients 未进入快照', snap.tables.api_clients === undefined);
  ok('3-9 快照不含用户/组织行', snap.tables.users === undefined && snap.tables.org_units === undefined);

  /* ==================== TC-4 导入到全新独立实例库 ==================== */
  section('TC-4 导入：重映射 / 循环引用 / 去重 / 幂等');
  const imp = runCli('scripts/org-import.mjs', {
    ...CLI_ENV, CRM_DB: dbB, ORG_SNAPSHOT_FILE: snapFile, ORG_SNAPSHOT_PASS: PASS, ORG_NAME: '付费独立实例',
  });
  ok('4-1 导入 CLI 成功', imp.status === 0 && imp.json?.ok === true, `${imp.status} ${imp.stderr.slice(0, 200)}`);
  ok('4-2 返回导入行数', Number(imp.json?.importedRows) > 0, JSON.stringify(imp.json || {}).slice(0, 160));
  ok('4-3 targets 唯一约束冲突已去重', Number(imp.json?.skippedRows) === 1, String(imp.json?.skippedRows));
  ok('4-4 导入后无外键违规', Number(imp.json?.fkViolations?.length || 0) === 0, JSON.stringify(imp.json?.fkViolations || []).slice(0, 200));

  const b = new DatabaseSync(dbB);
  const countOf = (t) => Number(b.prepare(`select count(*) c from ${t}`).get().c);
  const expected = Object.fromEntries(TABLE_ORDER.map((t) => [t, snap.tables[t].length]));
  expected.targets = 1; // 去重后
  ok('4-5 各表行数与快照一致（targets 去重后 1 条）',
    TABLE_ORDER.every((t) => countOf(t) === expected[t]),
    TABLE_ORDER.filter((t) => countOf(t) !== expected[t]).map((t) => `${t}:${countOf(t)}≠${expected[t]}`).join(','));
  ok('4-6 org_id 全部重映射到目标根组织',
    ['accounts', 'leads', 'opportunities', 'products', 'quotations', 'contracts', 'approvals', 'pool_events', 'targets']
      .every((t) => b.prepare(`select count(*) c from ${t} where org_id <> 1`).get().c === 0));

  const USER_REF_CHECKS = [
    ['accounts', 'owner_id'], ['accounts', 'created_by'], ['contacts', 'created_by'],
    ['leads', 'owner_id'], ['leads', 'created_by'], ['opportunities', 'owner_id'],
    ['opportunities', 'created_by'], ['quotations', 'created_by'],
    ['contracts', 'owner_id'], ['contracts', 'created_by'], ['invoices', 'apply_by'],
    ['payments', 'created_by'], ['approvals', 'applicant_id'], ['approval_steps', 'approver_id'],
    ['activities', 'user_id'], ['attachments', 'uploaded_by'], ['audit_logs', 'user_id'],
    ['handovers', 'user_id'], ['handovers', 'to_user_id'], ['handovers', 'created_by'],
    ['quote_sends', 'sent_by'], ['targets', 'user_id'], ['products', 'created_by'],
    ['pool_events', 'actor_id'], ['pool_events', 'to_owner'],
  ];
  const badRefs = USER_REF_CHECKS.filter(([t, col]) => {
    const rows = b.prepare(`select distinct ${col} v from ${t} where ${col} is not null`).all();
    return rows.some((r) => Number(r.v) !== 1);
  });
  ok('4-7 用户引用列全部重映射到目标管理员', badRefs.length === 0, JSON.stringify(badRefs));

  const opp = b.prepare('select * from opportunities where id=1').get();
  const con = b.prepare('select * from contracts where id=1').get();
  ok('4-8 循环引用完整保留', Number(opp?.contract_id) === 1 && Number(con?.opportunity_id) === 1,
    `opp.contract_id=${opp?.contract_id} con.opportunity_id=${con?.opportunity_id}`);
  ok('4-9 settings 幂等 marker 已写入',
    b.prepare("select value from settings where key='org_transfer.snapshot'").get()?.value === snap.checksum);
  ok('4-10 目标库管理员与根组织仍是原本那套',
    Number(b.prepare("select count(*) c from users where username='admin'").get().c) === 1 &&
    Number(b.prepare('select count(*) c from org_units where parent_id is null').get().c) === 1);
  b.close();

  const imp2 = runCli('scripts/org-import.mjs', {
    ...CLI_ENV, CRM_DB: dbB, ORG_SNAPSHOT_FILE: snapFile, ORG_SNAPSHOT_PASS: PASS,
  });
  ok('4-11 重复导入幂等返回 already', imp2.status === 0 && imp2.json?.already === true && Number(imp2.json?.rows) === 0,
    `${imp2.status} ${imp2.stderr.slice(0, 160)}`);

  /* ==================== TC-5 拒绝场景 ==================== */
  section('TC-5 前置校验与失败拒绝');
  const imp3 = runCli('scripts/org-import.mjs', {
    ...CLI_ENV, CRM_DB: dbC, ORG_SNAPSHOT_FILE: snapFile, ORG_SNAPSHOT_PASS: PASS,
  });
  ok('5-1 目标库非空时拒绝导入（409）',
    imp3.status !== 0 && imp3.json?.ok === false && /已有数据/.test(String(imp3.json?.error || '')),
    `${imp3.status} ${JSON.stringify(imp3.json || {}).slice(0, 200)}`);
  const imp4 = runCli('scripts/org-import.mjs', {
    ...CLI_ENV, CRM_DB: dbB, ORG_SNAPSHOT_FILE: snapFile, ORG_SNAPSHOT_PASS: 'wrong-pass',
  });
  ok('5-2 错误口令拒绝导入', imp4.status !== 0, `${imp4.status} ${imp4.stdout.slice(0, 120)}`);
  const exp404 = runCli('scripts/org-export.mjs', {
    ...CLI_ENV, CRM_DB: dbA, EMAIL: 'nobody@test.local', ORG_SNAPSHOT_FILE: snapFile2, ORG_SNAPSHOT_PASS: PASS,
  });
  ok('5-3 邮箱定位不到组织时报错', exp404.status !== 0, `${exp404.status}`);
  const expEmail = runCli('scripts/org-export.mjs', {
    ...CLI_ENV, CRM_DB: dbA, EMAIL: 'boss@test.local', ORG_SNAPSHOT_FILE: snapFile2, ORG_SNAPSHOT_PASS: PASS,
  });
  ok('5-4 locateOrgByEmail 能定位试用组织', expEmail.status === 0 && Number(expEmail.json?.orgId) === 2,
    `${expEmail.status} ${JSON.stringify(expEmail.json || {}).slice(0, 160)}`);
  const expBadOrg = runCli('scripts/org-export.mjs', {
    ...CLI_ENV, CRM_DB: dbA, ORG_ID: '9999', ORG_SNAPSHOT_FILE: snapFile2, ORG_SNAPSHOT_PASS: PASS,
  });
  ok('5-5 组织不存在时导出报错', expBadOrg.status !== 0, `${expBadOrg.status}`);

  /* ==================== TC-6 备份清单自检 ==================== */
  section('TC-6 备份清单（tenants 漏表修复）');
  const backupDir = join(tmp, 'backups');
  const bk = runCli('src/backup.js', { ...CLI_ENV, CRM_DB: dbA, CRM_BACKUP_DIR: backupDir });
  ok('6-1 备份不再因漏表中止', bk.status === 0, `${bk.status} ${bk.stdout.slice(0, 200)} ${bk.stderr.slice(0, 200)}`);
  ok('6-2 自检报告无遗漏', /无遗漏/.test(bk.stdout), bk.stdout.slice(0, 200));
  const bkFiles = existsSync(backupDir) ? readdirSync(backupDir) : [];
  const files = bkFiles.length ? readFileSync(join(backupDir, bkFiles[0]), 'utf8') : '{}';
  let dump = {};
  try { dump = JSON.parse(files); } catch { /* 保持空 */ }
  ok('6-3 备份内容含 tenants 表', Array.isArray(dump?.tables?.tenants), Object.keys(dump?.tables || {}).slice(0, 8).join(','));

  /* ==================== TC-7 真实编排器跨实例冒烟 ==================== */
  section('TC-7 编排器：试用共享 → 付费独立实例 全链路');
  const probe = runCli('scripts/org-transfer-check.mjs', {
    ...CLI_ENV,
    CRM_DB: dbA,
    TENANT_ROOT: join(tmp, 'tenants'),
    TENANT_PORT_BASE: '18900',
    PROBE_CODE: 'T-TEST',
  }, ['--provision-probe'], 120000);
  ok('7-1 编排器执行成功', probe.status === 0 && probe.json?.ok === true && probe.json?.out?.ok === true,
    `${probe.status} ${JSON.stringify(probe.json || {}).slice(0, 220)} ${probe.stderr.slice(0, 160)}`);
  ok('7-2 编排结果标记迁移完成', String(probe.json?.out?.migrationState) === 'done',
    String(probe.json?.out?.migrationState));

  const shared = new DatabaseSync(dbA);
  const tenantRow = shared.prepare("select * from tenants where code='T-TEST'").get();
  ok('7-3 共享库台账 instance_state=provisioned', String(tenantRow?.instance_state) === 'provisioned', String(tenantRow?.instance_state));
  ok('7-4 共享库台账 migration_state=done', String(tenantRow?.migration_state) === 'done', String(tenantRow?.migration_state));
  ok('7-5 迁移备注含导入行数与 checksum', /已导入 \d+ 行/.test(String(tenantRow?.migration_note || '')) && /checksum=/.test(String(tenantRow?.migration_note || '')),
    String(tenantRow?.migration_note).slice(0, 160));
  shared.close();

  const targetFile = join(tmp, 'tenants', 't-test', 'data', 'crm.db');
  ok('7-6 独立实例库已生成', existsSync(targetFile), targetFile);
  if (existsSync(targetFile)) {
    const tb = new DatabaseSync(targetFile);
    ok('7-7 独立实例已装入试用业务数据',
      Number(tb.prepare('select count(*) c from accounts').get().c) === 1 &&
      Number(tb.prepare('select count(*) c from contracts').get().c) === 1,
      `accounts=${tb.prepare('select count(*) c from accounts').get().c}`);
    ok('7-8 独立实例内 org_id / owner_id 已重映射',
      Number(tb.prepare('select count(*) c from accounts where org_id is null or owner_id is null').get().c) === 0);
    ok('7-9 加密快照导入成功后已删除',
      !existsSync(join(tmp, 'tenants', 't-test', 'migration', 'org-snapshot.json')));
    tb.close();
  }
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 偶发占用，忽略 */ }
}

console.log(`\n结果：${pass}/${pass + fail} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
