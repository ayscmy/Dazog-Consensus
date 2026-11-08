/**
 * 客户库双向同步 · CRM 侧验收脚本（accounts-api v1）
 *
 * 依据：docs/21 第 7 节 TC-A1~A4。
 *
 * 安全边界（与 crm-local pool-check.mjs 同源）：
 *   1. 只在临时 SQLite 库上跑，ENV_FILE 指向空文件，屏蔽项目 .env，绝不连生产 PostgreSQL。
 *   2. 引擎双道守卫：注入变量后 import db.js，复核 DB_ENGINE==='sqlite' 且库落在临时目录。
 *   3. 不占端口：用 http.js 的 dispatch() 直接驱动路由，模拟 API 密钥调用。
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'crm-acct-check-'));

const emptyEnv = join(tmp, 'empty.env');
writeFileSync(emptyEnv, '');
Object.assign(process.env, {
  ENV_FILE: emptyEnv,
  DB_TYPE: 'sqlite',
  CRM_DB: join(tmp, 'crm.db'),
  CRM_SECRET: 'acct-check-secret',
  PORT: '0',
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
  console.error('[拒绝执行] 只能在临时 SQLite 库上运行，当前：', db.DB_ENGINE, db.DB_FILE);
  process.exit(2);
}
console.log(`[环境] 临时库 ${db.CRM_DB || db.SITE_DB} · ${db.DB_LABEL}`);
await db.migrate();

await import('../src/routes/accounts-api.js'); // 副作用：注册 /api/v1/accounts
const http = await import('../src/http.js');
const { dispatch } = http;
const { run, one, all } = db;

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

/* ---------- 种子：组织 + API 接入方 ---------- */
await run("insert into org_units(name, type, path, level, created_at) values('组织A','company','1',1,?)", db.nowIso());
await run("insert into org_units(name, type, path, level, created_at) values('组织B','company','2',1,?)", db.nowIso());
const orgA = (await one("select id from org_units where name='组织A'")).id;
const orgB = (await one("select id from org_units where name='组织B'")).id;

function makeClient(orgId, scopes) {
  const key = `crm_${createHash('sha1').update(String(Math.random())).digest('hex')}`;
  const clientId = `ak_${createHash('sha1').update(key).digest('hex').slice(0, 10)}`;
  return { key, clientId, scopes, orgId };
}
const clientA = makeClient(orgA, JSON.stringify(['account:read', 'account:write']));
const clientB = makeClient(orgB, JSON.stringify(['account:read', 'account:write']));
for (const c of [clientA, clientB]) {
  await run(
    `insert into api_clients(name, client_id, key_prefix, key_hash, status, scopes, ip_whitelist, org_id, owner_id, created_at, rate_limit, daily_quota)
     values(?,?,?,?,?,?,?,?,?,?,?,?)`,
    '测试接入', c.clientId, 'crm_', sha256(c.key), 'active', c.scopes, '127.0.0.1', c.orgId, null, db.nowIso(), 60, 5000
  );
}

/* ---------- dispatch 驱动 ---------- */
function mkReq(method, url, body, headers = {}) {
  const r = new Readable({ read() {} });
  r.url = url;
  r.method = method;
  const bodyStr = body !== undefined ? JSON.stringify(body) : '';
  r.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(bodyStr)), ...headers };
  if (bodyStr) r.push(bodyStr);
  r.push(null);
  return r;
}
function mkRes() {
  let body = '';
  return {
    headersSent: false, writableEnded: false, statusCode: 200, _body: '',
    setHeader() { return this; },
    getHeader() { return ''; },
    writeHead(s) { this.statusCode = s; return this; },
    write(d) { body += d; return true; },
    end(d) { if (d) body += d; this.writableEnded = true; this._body = body; return this; },
    get body() { return this._body; },
  };
}
let ipSeq = 0;
async function call(method, url, opts = {}) {
  const ip = opts.ip || '127.0.0.1';
  const headers = { ...(opts.headers || {}) };
  if (opts.key) headers['authorization'] = `Bearer ${opts.key}`;
  const res = mkRes();
  // 与 server.js 一致：dispatch 的返回值即 JSON 体，状态码由 handler 经 ctx.res.statusCode 写入
  const out = await dispatch(mkReq(method, url, opts.body, headers), res, { ip });
  let json = {};
  try {
    json = typeof out === 'string' ? JSON.parse(out) : JSON.parse(JSON.stringify(out ?? { ok: true }));
  } catch { /* 忽略 */ }
  return { status: res.statusCode, json };
}

/* ==================== TC-A1 创建 + 幂等 ==================== */
section('TC-A1 POST /api/v1/accounts：创建 + external_id 幂等');
const a1 = await call('POST', '/api/v1/accounts', {
  key: clientA.key,
  body: { name: '华辰智造', external_id: 'dir:1', industry: '制造', contact_name: '王工', contact_phone: '13800000000' },
});
ok('创建返回 201', a1.status === 201, `status=${a1.status}`);
ok('返回 duplicated:false', a1.json.data?.duplicated === false, JSON.stringify(a1.json));
const accId = a1.json.data?.id;
ok('返回 account id', Number(accId) > 0, String(accId));
// 重复 external_id
const a1dup = await call('POST', '/api/v1/accounts', {
  key: clientA.key,
  body: { name: '华辰智造(重复)', external_id: 'dir:1' },
});
ok('重复返回 200 且 duplicated:true', a1dup.status === 200 && a1dup.json.data?.duplicated === true, JSON.stringify(a1dup.json));
ok('重复不新建（id 一致）', a1dup.json.data?.id === accId, `${a1dup.json.data?.id} vs ${accId}`);

/* ==================== TC-A2 作用域隔离 ==================== */
section('TC-A2 跨组织钥匙看不到对方账号（inScope 拦截）');
await call('POST', '/api/v1/accounts', { key: clientA.key, body: { name: 'A 私有客户', external_id: 'manual:a1' } });
const bView = await call('GET', '/api/v1/accounts', { key: clientB.key });
ok('B 组织的列表不含 A 的账号', !bView.json.data?.items?.some((x) => x.name === 'A 私有客户'), JSON.stringify(bView.json.data?.items));
const bSelf = await call('POST', '/api/v1/accounts', { key: clientB.key, body: { name: 'B 私有客户' } });
ok('B 自己能建账号', bSelf.status === 201, `status=${bSelf.status}`);
const aView = await call('GET', '/api/v1/accounts', { key: clientA.key });
ok('A 组织的列表不含 B 的账号', !aView.json.data?.items?.some((x) => x.name === 'B 私有客户'), '');

/* ==================== TC-A3 增量拉取 ==================== */
section('TC-A3 GET /api/v1/accounts?since= 增量');
const all1 = await call('GET', '/api/v1/accounts', { key: clientA.key });
ok('since 为空返回全部（含 A 私有客户）', all1.json.data?.items?.length >= 1, JSON.stringify(all1.json.data?.items?.length));
const future = new Date(Date.now() + 86400_000).toISOString();
const none = await call('GET', `/api/v1/accounts?since=${encodeURIComponent(future)}`, { key: clientA.key });
ok('未来 since 返回 0 条（增量过滤生效）', none.json.data?.items?.length === 0, JSON.stringify(none.json.data?.items?.length));
ok('返回 nextSince 字段', typeof all1.json.data?.nextSince === 'string', String(all1.json.data?.nextSince));

/* ==================== TC-A4 dir: 前缀防重复（联调侧） ==================== */
section('TC-A4 dir: 前缀账号二次推送幂等（官网回流不重复建）');
const again = await call('POST', '/api/v1/accounts', { key: clientA.key, body: { name: 'X', external_id: 'dir:1' } });
ok('dir:1 再次推送命中幂等', again.json.data?.duplicated === true && again.json.data?.id === accId, JSON.stringify(again.json));

/* ---------- 收尾 ---------- */
console.log(`\n===== CRM accounts 验收：${pass} 通过 / ${fail} 失败 =====`);
if (bad.length) console.log('未通过：' + bad.join('、'));
try { await db.closeDb?.(); } catch { /* 忽略 */ }
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail === 0 ? 0 : 1);
