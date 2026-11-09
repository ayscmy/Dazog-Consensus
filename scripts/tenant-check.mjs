/**
 * 正式租户内部接口验收（P0-4）
 *
 *   node scripts/tenant-check.mjs      （npm run test:tenant）
 *
 * 覆盖：内部密钥/IP 两道门、开通（有试用→转正 / 无试用→pending）、
 *       订单号幂等、续费延长、停用、用量统计。
 *
 * 安全边界：临时 SQLite + ENV_FILE 空文件，绝不连生产库；不占端口。
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'crm-tenant-check-'));

const emptyEnv = join(tmp, 'empty.env');
writeFileSync(emptyEnv, '');
Object.assign(process.env, {
  ENV_FILE: emptyEnv,
  DB_TYPE: 'sqlite',
  CRM_DB: join(tmp, 'crm.db'),
  CRM_SECRET: 'tenant-check-secret',
  PORT: '0',
  TRIAL_API_KEY: 'tenant-check-key',
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

/* ---------- 根组织 + 一个试用账号 ---------- */
await run("insert into org_units(name,type,path,level,created_at) values('测试集团','group','/',1,?)", nowIso());
const trial = await T.createTrialAccount({ email: 'buyer@test.local', name: '买家', company: '买家科技', days: 14 });

/* ---------- HTTP 驱动 ---------- */
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
async function call(method, url, { body, key = 'tenant-check-key', ip = '127.0.0.1' } = {}) {
  const headers = {};
  if (key !== null) headers['x-internal-key'] = key;
  const res = mkRes();
  try {
    const out = await dispatch(mkReq(method, url, body, headers), res, { ip });
    return { status: res.statusCode, json: out ?? {} };
  } catch (e) {
    return { status: e.status || 500, json: { error: e.message, detail: e.detail ?? null } };
  }
}

/* ==================== TC-T1 内部鉴权 ==================== */
section('TC-T1 内部鉴权两道门');
const noKey = await call('POST', '/api/internal/tenant/activate', { key: null, body: { email: 'x@test.local' } });
ok('T1-1 缺少密钥被拒(401)', noKey.status === 401, `status=${noKey.status}`);
const wrongKey = await call('POST', '/api/internal/tenant/activate', { key: 'wrong', body: { email: 'x@test.local' } });
ok('T1-2 错误密钥被拒(401)', wrongKey.status === 401, `status=${wrongKey.status}`);
const badIp = await call('POST', '/api/internal/tenant/activate', {
  ip: '8.8.8.8', body: { email: 'x@test.local' },
});
ok('T1-3 非回环 IP 被拒(403)', badIp.status === 403, `status=${badIp.status}`);

/* ==================== TC-T2 开通（有试用→转正） ==================== */
section('TC-T2 开通：试用转正');
const act = await call('POST', '/api/internal/tenant/activate', {
  body: { email: 'buyer@test.local', plan: 'pro', periodMonths: 12, orderNo: 'ORD20261109AAAAAA', company: '买家科技' },
});
ok('T2-1 开通成功', act.status === 200 && act.json.tenant?.code, JSON.stringify(act.json).slice(0, 160));
const tenant = act.json.tenant || {};
ok('T2-2 租户编号格式 T-YYYYMM-XXXX', /^T-\d{6}-[0-9A-F]{4}$/.test(tenant.code || ''), tenant.code);
ok('T2-3 关联试用组织与用户', Number(tenant.orgId) === Number(trial.orgId) && Number(tenant.userId) === Number(trial.userId),
  `org=${tenant.orgId}/${trial.orgId} user=${tenant.userId}/${trial.userId}`);
ok('T2-4 套餐额度按 pro 落地', tenant.seats === 30 && tenant.leadQuota === 10000, JSON.stringify({ s: tenant.seats, l: tenant.leadQuota }));
ok('T2-5 实例待编排', tenant.instanceState === 'pending', tenant.instanceState);
const trialRow = await one('select * from trial_accounts where id=?', trial.accountId);
ok('T2-6 试用记录转 converted', trialRow.status === 'converted', trialRow.status);
const roleRow = await one('select * from user_roles where user_id=?', trial.userId);
ok('T2-7 试用角色转正为 ae', roleRow.role === 'ae', roleRow.role);

/* ==================== TC-T3 幂等与续费 ==================== */
section('TC-T3 幂等与续费');
const dup = await call('POST', '/api/internal/tenant/activate', {
  body: { email: 'other@test.local', plan: 'starter', periodMonths: 12, orderNo: 'ORD20261109AAAAAA' },
});
ok('T3-1 同订单号重复开通幂等', dup.status === 200 && dup.json.duplicated === true && dup.json.tenant?.code === tenant.code,
  JSON.stringify(dup.json).slice(0, 120));
const sameEmail = await call('POST', '/api/internal/tenant/activate', {
  body: { email: 'buyer@test.local', plan: 'pro', periodMonths: 12, orderNo: 'ORD20261109BBBBBB' },
});
ok('T3-2 同邮箱再次开通视为续费', sameEmail.status === 200 && sameEmail.json.renewed === true, JSON.stringify(sameEmail.json).slice(0, 120));
const before = new Date(tenant.expiresAt).getTime();
const after = new Date(sameEmail.json.tenant?.expiresAt || 0).getTime();
ok('T3-3 到期日已延长', after > before, `${sameEmail.json.tenant?.expiresAt}`);

/* ==================== TC-T4 停用与用量 ==================== */
section('TC-T4 停用与用量');
const usage = await call('GET', `/api/internal/tenant/usage?code=${tenant.code}`);
ok('T4-1 用量可读', usage.status === 200 && usage.json.usage?.code === tenant.code, JSON.stringify(usage.json).slice(0, 140));
ok('T4-2 在职账号数 >= 1', Number(usage.json.usage?.seats) >= 1, String(usage.json.usage?.seats));
ok('T4-3 返回额度上限', Number(usage.json.usage?.seatsLimit) === 30, String(usage.json.usage?.seatsLimit));
const sus = await call('POST', '/api/internal/tenant/suspend', { body: { code: tenant.code } });
ok('T4-4 停用成功', sus.status === 200 && sus.json.tenant?.status === 'suspended', JSON.stringify(sus.json).slice(0, 120));
const renew = await call('POST', '/api/internal/tenant/renew', { body: { code: tenant.code, periodMonths: 12 } });
ok('T4-5 续费恢复 active', renew.status === 200 && renew.json.tenant?.status === 'active', JSON.stringify(renew.json).slice(0, 120));

/* ==================== TC-T5 无试用的新客 ==================== */
section('TC-T5 无试用记录的新客开通');
const fresh = await call('POST', '/api/internal/tenant/activate', {
  body: { email: 'fresh@test.local', name: '新客户', plan: 'starter', periodMonths: 12, orderNo: 'ORD20261109CCCCCC' },
});
ok('T5-1 新客直接建租户', fresh.status === 200 && fresh.json.tenant?.code, JSON.stringify(fresh.json).slice(0, 140));
ok('T5-2 无关联组织（待编排建实例）', fresh.json.tenant?.orgId === null || fresh.json.tenant?.orgId === undefined,
  String(fresh.json.tenant?.orgId));
ok('T5-3 状态仍为待编排', fresh.json.tenant?.instanceState === 'pending', fresh.json.tenant?.instanceState);

/* ---------- 收尾 ---------- */
console.log(`\n===== CRM 租户接口验收：${pass} 通过 / ${fail} 失败 =====`);
if (bad.length) console.log('未通过：' + bad.join('、'));
try { await db.closeDb?.(); } catch { /* 忽略 */ }
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail === 0 ? 0 : 1);
