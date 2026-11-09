/**
 * 租户实例编排验收（P0-5）
 *
 *   node scripts/tenant-provision-check.mjs     （npm run test:provision）
 *
 * 真实链路：建实例（目录 + 独立库 + 管理员）→ 启动进程 → /healthz → 管理员登录 → 停止。
 * 安全边界：租户目录与主库都在临时目录；端口随机避开常用段；结束时确保停进程并清理。
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'crm-provision-check-'));
const emptyEnv = join(tmp, 'empty.env');
writeFileSync(emptyEnv, '');

const PORT_BASE = 19400 + Math.floor(Math.random() * 300);
Object.assign(process.env, {
  ENV_FILE: emptyEnv,
  DB_TYPE: 'sqlite',
  CRM_DB: join(tmp, 'master.db'),
  CRM_SECRET: 'provision-check-secret',
  PORT: '0',
  CRM_LOG: '0',
  TENANT_ROOT: join(tmp, 'tenants'),
  TENANT_PORT_BASE: String(PORT_BASE),
  TENANT_PUBLIC_BASE: 'tenants.test.local',
});

let pass = 0;
let fail = 0;
const bad = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; bad.push(name); console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

const db = await import('../src/db.js');
await db.migrate();
const now = db.nowIso();
const code = 'T-202611-TEST';
await db.run(
  `insert into tenants(code,name,plan,status,owner_email,instance_state,expires_at,seats,lead_quota,api_quota,created_at,updated_at)
   values(?,?,?,'active',?,'pending',?,10,2000,0,?,?)`,
  code, '验收租户', 'starter', 'p@test.local',
  new Date(Date.now() + 365 * 86400000).toISOString(), now, now
);

const { provisionTenant } = await import('../src/tenant-provision.js');
const ctl = (cmd) => spawnSync(process.execPath, ['--no-warnings', join(ROOT, 'scripts', 'tenant-ctl.mjs'), cmd, `--code=${code}`], {
  env: { ...process.env },
  encoding: 'utf8',
  timeout: 40000,
});
const ctlJson = (cmd) => {
  const r = ctl(cmd);
  try { return JSON.parse(String(r.stdout || '').trim()); } catch { return { raw: r.stdout, stderr: r.stderr, status: r.status }; }
};

async function waitHealth(port, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return await res.json();
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

let provisioned = null;
try {
  /* ==================== TC-P1 建实例 ==================== */
  section('TC-P1 创建实例');
  provisioned = await provisionTenant(code);
  ok('P1-1 编排成功', provisioned.ok === true, JSON.stringify(provisioned).slice(0, 160));
  ok('P1-2 分配了端口', Number(provisioned.port) >= PORT_BASE, String(provisioned.port));
  ok('P1-3 目录已创建', existsSync(provisioned.dir), provisioned.dir);
  ok('P1-4 独立数据库已生成', existsSync(provisioned.dbFile), provisioned.dbFile);
  ok('P1-5 生成 12 位管理员密码', String(provisioned.adminPassword || '').length === 12, String(provisioned.adminPassword || '').length);
  ok('P1-6 子域名已生成', /^t-202611-test\.tenants\.test\.local$/.test(provisioned.subdomain || ''), provisioned.subdomain);

  const sdb = new DatabaseSync(provisioned.dbFile);
  const admin = sdb.prepare(
    "select u.username, r.role from users u join user_roles r on r.user_id = u.id where u.username = 'admin'"
  ).get();
  const org = sdb.prepare('select count(*) c from org_units').get();
  sdb.close();
  ok('P1-7 租户库内管理员已建', admin && admin.role === 'admin', JSON.stringify(admin));
  ok('P1-8 租户库内已建根组织', Number(org?.c) >= 1, String(org?.c));

  const row = await db.one('select * from tenants where code=?', code);
  ok('P1-9 台账状态为 provisioned', row.instance_state === 'provisioned', row.instance_state);
  ok('P1-10 台账记录端口与目录', Number(row.port) === Number(provisioned.port) && row.data_dir === provisioned.dir);

  /* ==================== TC-P2 幂等 ==================== */
  section('TC-P2 重复编排幂等');
  const again = await provisionTenant(code);
  ok('P2-1 重复编排返回 already', again.already === true, JSON.stringify(again).slice(0, 120));
  ok('P2-2 端口不变', again.port === provisioned.port, `${again.port} vs ${provisioned.port}`);
  ok('P2-3 密码可还原', again.adminPassword === provisioned.adminPassword, '密码不一致');

  /* ==================== TC-P3 启动与健康 ==================== */
  section('TC-P3 启动实例');
  const start = ctlJson('start');
  ok('P3-1 start 成功', start.ok === true && Number(start.pid) > 0, JSON.stringify(start));
  const health = await waitHealth(provisioned.port);
  ok('P3-2 /healthz 返回 200', Boolean(health?.ok), JSON.stringify(health));
  ok('P3-3 健康信息含 service/db', health?.service === 'mserm-crm' && health?.db === 'sqlite', JSON.stringify(health));

  let login = null;
  try {
    const res = await fetch(`http://127.0.0.1:${provisioned.port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: provisioned.adminPassword }),
    });
    login = { status: res.status, json: await res.json().catch(() => ({})) };
  } catch (e) {
    login = { status: 0, error: String(e.message || e) };
  }
  ok('P3-4 管理员可登录实例', login.status === 200 && Boolean(login.json?.user), JSON.stringify(login).slice(0, 160));

  const status = ctlJson('status');
  ok('P3-5 status 显示运行中', status.alive === true && status.health?.ok === true, JSON.stringify(status).slice(0, 160));

  /* ==================== TC-P4 停止 ==================== */
  section('TC-P4 停止实例');
  const stop = ctlJson('stop');
  ok('P4-1 stop 成功', stop.ok === true, JSON.stringify(stop));
  await new Promise((r) => setTimeout(r, 1200));
  let down = false;
  try {
    const res = await fetch(`http://127.0.0.1:${provisioned.port}/healthz`, { signal: AbortSignal.timeout(1500) });
    down = !res.ok;
  } catch { down = true; }
  ok('P4-2 停止后健康检查不可达', down);
  const row2 = await db.one('select instance_state from tenants where code=?', code);
  ok('P4-3 台账状态为 stopped', row2.instance_state === 'stopped', row2.instance_state);
} finally {
  // 兜底：无论成败都停一次，避免留下孤儿进程
  try { ctl('stop'); } catch { /* 忽略 */ }
  await new Promise((r) => setTimeout(r, 500));
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n===== 租户实例编排验收：${pass} 通过 / ${fail} 失败 =====`);
if (bad.length) console.log('未通过：' + bad.join('、'));
process.exit(fail === 0 ? 0 : 1);
