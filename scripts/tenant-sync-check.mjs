/**
 * 订阅状态同步 + 只读闸门验收（P1-A，CRM 侧）
 *
 *   node scripts/tenant-sync-check.mjs    （npm run test:tenant-sync）
 *
 * 覆盖：sync-status 两道门、状态映射与幂等、登录冻结/解冻联动、
 *       宽限期只读闸门（纯逻辑 + dispatch 集成）、豁免路径、恢复 active 后放行。
 *
 * 安全边界：临时 SQLite + ENV_FILE 空文件，绝不连生产库；不占端口。
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'crm-tenant-sync-'));

const emptyEnv = join(tmp, 'empty.env');
writeFileSync(emptyEnv, '');
Object.assign(process.env, {
  ENV_FILE: emptyEnv,
  DB_TYPE: 'sqlite',
  CRM_DB: join(tmp, 'crm.db'),
  CRM_SECRET: 'tenant-sync-check-secret',
  PORT: '0',
  TRIAL_API_KEY: 'tenant-sync-check-key',
  TRIAL_DAYS: '14',
  TRIAL_RETAIN_DAYS: '30',
});

let pass = 0;
let fail = 0;
const bad = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; bad.push(name); console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }
const iso = (t) => new Date(t).toISOString();

const db = await import('../src/db.js');
if (db.DB_ENGINE !== 'sqlite' || !String(db.DB_FILE).startsWith(tmp)) {
  console.error('[拒绝执行] 只能在临时 SQLite 库上运行');
  process.exit(2);
}
await db.migrate();
const { run, one, nowIso } = db;

await import('../src/routes/index.js');
const { dispatch } = await import('../src/http.js');
const T = await import('../src/trial.js');
const G = await import('../src/tenant-guard.js');

function mkReq(method, url, body, headers = {}) {
  const r = new Readable({ read() {} });
  r.url = url;
  r.method = method;
  const s = body !== undefined ? JSON.stringify(body) : '';
  r.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(s)), ...headers };
  if (s) r.push(s);
  r.push(null);
  return r;
}
function mkRes() {
  let body = '';
  return {
    headersSent: false, writableEnded: false, statusCode: 200,
    setHeader() { return this; }, getHeader() { return ''; },
    writeHead(s) { this.statusCode = s; return this; },
    write(d) { body += d; return true; },
    end(d) { if (d) body += d; this.writableEnded = true; return this; },
  };
}
async function call(method, url, { body, key = 'tenant-sync-check-key', ip = '127.0.0.1', cookie = null } = {}) {
  const headers = {};
  if (key !== null) headers['x-internal-key'] = key;
  if (cookie) headers.cookie = `crm_sid=${cookie}`;
  const res = mkRes();
  try {
    const out = await dispatch(mkReq(method, url, body, headers), res, { ip });
    return { status: res.statusCode, json: out ?? {} };
  } catch (e) {
    return { status: e.status || 500, json: { error: e.message, detail: e.detail ?? null } };
  }
}
const sync = (status, extra = {}) => call('POST', '/api/internal/tenant/sync-status', {
  body: { code: tenantCode, status, expiresAt: iso(Date.now() + 30 * 86400_000), ...extra },
});

/* ---------- 根组织 + 试用账号 ---------- */
await run("insert into org_units(name,type,path,level,created_at) values('测试集团','group','/',1,?)", nowIso());
const trial = await T.createTrialAccount({ email: 'buyer@test.local', name: '买家', company: '买家科技', days: 14 });

const act = await call('POST', '/api/internal/tenant/activate', {
  body: { email: 'buyer@test.local', plan: 'pro', periodMonths: 12, orderNo: 'ORD20261110SYNC01', company: '买家科技' },
});
const tenantCode = act.json.tenant?.code || '';
ok('前置：租户已创建', act.status === 200 && Boolean(tenantCode), JSON.stringify(act.json).slice(0, 140));

/* ==================== TC-G1 内部接口两道门 ==================== */
section('TC-G1 sync-status 鉴权');
const noKey = await call('POST', '/api/internal/tenant/sync-status', { key: null, body: { code: tenantCode, status: 'active' } });
ok('G1-1 缺少密钥被拒(401)', noKey.status === 401, String(noKey.status));
const wrongKey = await call('POST', '/api/internal/tenant/sync-status', { key: 'wrong', body: { code: tenantCode, status: 'active' } });
ok('G1-2 错误密钥被拒(401)', wrongKey.status === 401, String(wrongKey.status));
const badIp = await call('POST', '/api/internal/tenant/sync-status', {
  ip: '8.8.8.8', body: { code: tenantCode, status: 'active' },
});
ok('G1-3 非回环 IP 被拒(403)', badIp.status === 403, String(badIp.status));
const badStatus = await sync('unknown_status');
ok('G1-4 未知订阅状态被拒(400)', badStatus.status === 400, JSON.stringify(badStatus.json));
const noTenant = await call('POST', '/api/internal/tenant/sync-status', {
  body: { code: 'T-NOT-EXIST', status: 'active' },
});
ok('G1-5 租户不存在(404)', noTenant.status === 404, String(noTenant.status));

/* ==================== TC-G2 状态映射与幂等 ==================== */
section('TC-G2 状态映射 / 幂等 / 登录联动');
const sActive = await sync('active');
ok('G2-1 active → tenants.active', sActive.status === 200 && sActive.json.tenant?.status === 'active'
  && sActive.json.mappedStatus === 'active', JSON.stringify(sActive.json).slice(0, 160));
const idem = await call('POST', '/api/internal/tenant/sync-status', {
  body: { code: tenantCode, status: 'active', expiresAt: (await one('select expires_at from tenants where code=?', tenantCode)).expires_at },
});
ok('G2-2 同状态同到期日幂等(unchanged)', idem.status === 200 && idem.json.unchanged === true, JSON.stringify(idem.json).slice(0, 140));
const sExpiring = await sync('expiring');
ok('G2-3 expiring 仍映射 active', sExpiring.json.mappedStatus === 'active' && sExpiring.json.tenant?.status === 'active');
const sGrace = await sync('grace');
ok('G2-4 grace → tenants.grace', sGrace.json.tenant?.status === 'grace', JSON.stringify(sGrace.json).slice(0, 140));
const userGrace = await one('select status from users where id=?', trial.userId);
ok('G2-5 宽限期仍可登录(users.active)', userGrace.status === 'active', userGrace.status);
const sFrozen = await sync('frozen');
ok('G2-6 frozen → tenants.suspended', sFrozen.json.tenant?.status === 'suspended', JSON.stringify(sFrozen.json).slice(0, 140));
const userFrozen = await one('select status from users where id=?', trial.userId);
ok('G2-7 冻结联动停用登录', userFrozen.status === 'frozen', userFrozen.status);
const sExpired = await sync('expired');
ok('G2-8 expired → suspended', sExpired.json.mappedStatus === 'suspended');
const sCancelled = await sync('cancelled');
ok('G2-9 cancelled → suspended', sCancelled.json.mappedStatus === 'suspended');
const sBack = await sync('active');
ok('G2-10 恢复 active 时解冻登录', sBack.json.tenant?.status === 'active'
  && (await one('select status from users where id=?', trial.userId)).status === 'active',
  JSON.stringify(sBack.json).slice(0, 140));

/* ==================== TC-G3 闸门纯逻辑 ==================== */
section('TC-G3 只读闸门（豁免与判定）');
ok('G3-1 GET 不拦截', G.shouldGuard('/api/quotations', 'GET') === false);
ok('G3-2 POST 进入闸门', G.shouldGuard('/api/quotations', 'POST') === true);
ok('G3-3 内部接口豁免', G.shouldGuard('/api/internal/tenant/sync-status', 'POST') === false);
ok('G3-4 健康检查豁免', G.shouldGuard('/healthz', 'POST') === false);
ok('G3-5 登录链路豁免', G.shouldGuard('/api/auth/login', 'POST') === false);
await sync('grace');
const graceBlock = await G.tenantBlockReason({ orgId: trial.orgId }, '/api/quotations', 'POST');
ok('G3-6 grace 组织写操作被拦 TENANT_READONLY', graceBlock?.code === 'TENANT_READONLY', JSON.stringify(graceBlock));
const graceGet = await G.tenantBlockReason({ orgId: trial.orgId }, '/api/quotations', 'GET');
ok('G3-7 grace 组织读操作放行', graceGet === null);
const graceInternal = await G.tenantBlockReason({ orgId: trial.orgId }, '/api/internal/tenant/usage?code=x', 'POST');
ok('G3-8 内部接口不受闸门影响', graceInternal === null);
await sync('frozen');
const frozenBlock = await G.tenantBlockReason({ orgId: trial.orgId }, '/api/quotations', 'POST');
ok('G3-9 冻结组织返回 TENANT_FROZEN', frozenBlock?.code === 'TENANT_FROZEN', JSON.stringify(frozenBlock));
const otherOrg = await G.tenantBlockReason({ orgId: 99999 }, '/api/quotations', 'POST');
ok('G3-10 无租户台账的组织放行', otherOrg === null);
const noUser = await G.tenantBlockReason(null, '/api/quotations', 'POST');
ok('G3-11 未登录态放行', noUser === null);

/* ==================== TC-G4 dispatch 集成 ==================== */
section('TC-G4 统一入口拦截（dispatch 集成）');
// frozen 已把 users 置为 frozen，先恢复 active 才能拿到会话
await sync('active');
await sync('grace');
const sid = 'tenant-sync-check-sid';
await run('insert into sessions(token,user_id,created_at,expires_at,ip,ua) values(?,?,?,?,?,?)',
  sid, trial.userId, nowIso(), iso(Date.now() + 3600_000), '127.0.0.1', 'check');
const write = await call('POST', '/api/quotations', { cookie: sid, body: { title: '闸门测试' } });
ok('G4-1 grace 组织写操作被拒(403)', write.status === 403, String(write.status));
ok('G4-2 错误码 TENANT_READONLY', write.json.detail?.code === 'TENANT_READONLY', JSON.stringify(write.json));
const read = await call('GET', '/api/quotations', { cookie: sid });
ok('G4-3 grace 组织读操作放行', read.status === 200, String(read.status));
const internal = await call('POST', '/api/internal/tenant/sync-status', {
  body: { code: tenantCode, status: 'active', expiresAt: iso(Date.now() + 30 * 86400_000) },
});
ok('G4-4 内部同步接口不受闸门影响', internal.status === 200, JSON.stringify(internal.json).slice(0, 140));
const write2 = await call('POST', '/api/quotations', { cookie: sid, body: { title: '恢复后写入' } });
ok('G4-5 恢复 active 后不再被闸门拦截', write2.status !== 403, String(write2.status));

/* ---------- 收尾 ---------- */
console.log(`\n===== CRM 订阅同步与闸门验收：${pass} 通过 / ${fail} 失败 =====`);
if (bad.length) console.log('未通过：' + bad.join('、'));
try { await db.closeDb?.(); } catch { /* 忽略 */ }
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail === 0 ? 0 : 1);
