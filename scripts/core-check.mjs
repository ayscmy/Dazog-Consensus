/**
 * 核心业务主线回归脚本（TC-C1 ~ TC-C5）
 *
 *   node scripts/core-check.mjs      （等价于 npm run test:core）
 *
 * 覆盖此前只有人工文档记录、没有脚本保障的主线：
 *   C1 登录态与数据范围、C2 报价创建/提交状态机、C3 报价转合同、
 *   C4 财务开票/回款/三单匹配、C5 系统设置读写与权限。
 *
 * 安全边界（与 pool-check.mjs / accounts-check.mjs 同源）：
 *   - 只在临时 SQLite 库上跑，ENV_FILE 指向空文件屏蔽项目 .env，绝不连生产 PostgreSQL。
 *   - 引擎双道守卫：注入变量后 import db.js，复核 DB_ENGINE==='sqlite' 且库落在临时目录。
 *   - 不占端口：用 http.js 的 dispatch() 直接驱动路由；会话通过 sessions 表注入，
 *     走完完整的 getSession / loadUser / scopeFilter 鉴权链路。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'crm-core-check-'));
const emptyEnv = join(tmp, 'empty.env');
writeFileSync(emptyEnv, '');
Object.assign(process.env, {
  ENV_FILE: emptyEnv,
  DB_TYPE: 'sqlite',
  CRM_DB: join(tmp, 'crm.db'),
  CRM_SECRET: 'core-check-secret',
  PORT: '0',
  CRM_LOG: '0',
  DEMO_MODE: '0',
  TRIAL_API_KEY: '',
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
console.log(`[环境] 临时库 ${db.DB_FILE} · ${db.DB_LABEL}`);
await db.migrate();
const { run, one, all, nowIso } = db;

await import('../src/routes/index.js');
const { dispatch } = await import('../src/http.js');

/* ---------- HTTP 驱动 ---------- */
function mkReq(method, url, body, headers = {}) {
  const r = new Readable({ read() {} });
  r.url = url;
  r.method = method;
  const bodyStr = body !== undefined ? JSON.stringify(body) : '';
  r.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(bodyStr)),
    ...headers
  };
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
async function call(method, url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.cookie) headers.cookie = `crm_sid=${opts.cookie}`;
  const res = mkRes();
  try {
    const out = await dispatch(mkReq(method, url, opts.body, headers), res, { ip: opts.ip || '127.0.0.1' });
    let json = {};
    try {
      json = typeof out === 'string' ? JSON.parse(out) : JSON.parse(JSON.stringify(out ?? { ok: true }));
    } catch { /* 忽略 */ }
    return { status: res.statusCode, json };
  } catch (e) {
    return { status: e.status || 500, json: { error: e.message, detail: e.detail ?? null } };
  }
}

/* ---------- 种子 ---------- */
await run("insert into org_units(id,parent_id,path,name,type,created_at) values(1,null,'/1/','集团','group',?)", nowIso());
await run("insert into org_units(id,parent_id,path,name,type,created_at) values(2,1,'/1/2/','A 公司','company',?)", nowIso());
async function mkUser(id, username, orgId, role) {
  await run('insert into users(id,username,name,password,org_id,status,created_at) values(?,?,?,?,?,?,?)',
    id, username, username, 'x', orgId, 'active', nowIso());
  await run('insert into user_roles(user_id,role) values(?,?)', id, role);
}
await mkUser(1, 'coreadmin', 1, 'admin');
await mkUser(2, 'coreae', 2, 'ae');
await mkUser(3, 'corefinance', 2, 'finance');
await mkUser(4, 'coreae2', 2, 'ae');

async function session(userId) {
  const token = randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
  await run('insert into sessions(token,user_id,created_at,expires_at,ip,ua) values(?,?,?,?,?,?)',
    token, userId, nowIso(), exp, '127.0.0.1', 'core-check');
  return token;
}
const adminSid = await session(1);
const aeSid = await session(2);
const finSid = await session(3);
const ae2Sid = await session(4);

await run(`insert into products(id,code,name,unit,list_price,cost,status,org_id,created_at,updated_at)
  values(1,'P-CORE-001','标准服务','套',1000,400,'active',2,?,?)`, nowIso(), nowIso());
await run(`insert into accounts(id,name,owner_id,org_id,status,created_by,created_at,updated_at)
  values(1,'核心回归客户',2,2,'active',1,?,?)`, nowIso(), nowIso());
await run(`insert into opportunities(id,name,account_id,amount,stage,owner_id,org_id,created_by,created_at,updated_at)
  values(1,'核心回归商机',1,100000,'qualifying',2,2,1,?,?)`, nowIso(), nowIso());

/* ==================== TC-C1 登录态与数据范围 ==================== */
section('TC-C1 登录态与数据范围');
const noAuth = await call('GET', '/api/quotations');
ok('C1-1 未登录访问报价列表被拒(401)', noAuth.status === 401, `status=${noAuth.status}`);
const adminView0 = await call('GET', '/api/quotations', { cookie: adminSid });
ok('C1-2 admin 会话可访问报价列表(200)', adminView0.status === 200, `status=${adminView0.status}`);
const aeView0 = await call('GET', '/api/quotations', { cookie: aeSid });
ok('C1-3 ae 会话可访问报价列表(200)', aeView0.status === 200, `status=${aeView0.status}`);
const aeAdmin = await call('GET', '/api/admin/users', { cookie: aeSid });
ok('C1-4 ae 访问用户管理被拒(403)', aeAdmin.status === 403, `status=${aeAdmin.status}`);
const badSid = await call('GET', '/api/quotations', { cookie: 'invalid-token' });
ok('C1-5 无效会话被拒(401)', badSid.status === 401, `status=${badSid.status}`);

/* ==================== TC-C2 报价创建与提交状态机 ==================== */
section('TC-C2 报价创建与提交状态机');
const q1 = await call('POST', '/api/quotations', {
  cookie: adminSid,
  body: { opportunity_id: 1, items: [{ product_id: 1, qty: 2, unit_price: 1000 }] },
});
ok('C2-1 创建报价成功', q1.status === 200 && Number(q1.json.id) > 0, JSON.stringify(q1));
const qid = q1.json.id;
ok('C2-2 金额 = 数量 × 单价(2000)', q1.json.amount === 2000, String(q1.json.amount));
ok('C2-3 零折扣 discount_rate=0', q1.json.discount_rate === 0, String(q1.json.discount_rate));
const qItems = qid ? await all('select * from quotation_items where quotation_id=?', qid) : [];
ok('C2-4 报价明细落库 1 条', qItems.length === 1, `rows=${qItems.length}`);
const sub = qid ? await call('POST', `/api/quotations/${qid}/submit`, { cookie: adminSid, body: {} }) : { status: 0, json: {} };
ok('C2-5 零折扣提交免价格审批', sub.status === 200 && sub.json.skipped === true && sub.json.status === 'approved', JSON.stringify(sub));
const sub2 = qid ? await call('POST', `/api/quotations/${qid}/submit`, { cookie: adminSid, body: {} }) : { status: 0 };
ok('C2-6 重复提交被状态机拒绝(400)', sub2.status === 400, `status=${sub2.status}`);
const patchQ = qid ? await call('PATCH', `/api/quotations/${qid}`, { cookie: adminSid, body: { remark: 'x' } }) : { status: 0 };
ok('C2-7 已批准报价不可直接改(400)', patchQ.status === 400, `status=${patchQ.status}`);
const ae2View = await call('GET', '/api/quotations', { cookie: ae2Sid });
ok('C2-8 非负责 ae 看不到该报价', !(ae2View.json.rows || []).some((r) => Number(r.id) === Number(qid)), `rows=${ae2View.json.rows?.length}`);
const aeView = await call('GET', '/api/quotations', { cookie: aeSid });
ok('C2-9 负责 ae 能看到该报价', (aeView.json.rows || []).some((r) => Number(r.id) === Number(qid)), `rows=${aeView.json.rows?.length}`);

/* ==================== TC-C3 报价转合同 ==================== */
section('TC-C3 报价转合同');
const c1 = qid ? await call('POST', '/api/contracts', {
  cookie: adminSid, body: { opportunity_id: 1, quotation_id: qid, title: '核心回归合同' },
}) : { status: 0, json: {} };
ok('C3-1 由已批准报价创建合同', c1.status === 200 && Number(c1.json.id) > 0, JSON.stringify(c1));
const cid = c1.json.id;
ok('C3-2 合同编号格式 DD-YYYY-0001', /^DD-\d{4}-0001$/.test(String(c1.json.no || '')), String(c1.json.no));
const cRow = cid ? await one('select * from contracts where id=?', cid) : null;
ok('C3-3 合同金额等于报价金额(2000)', cRow && Number(cRow.amount) === 2000, String(cRow?.amount));
const qStatus = qid ? (await one('select status from quotations where id=?', qid))?.status : null;
ok('C3-4 报价状态转 converted', qStatus === 'converted', String(qStatus));
const c2 = qid ? await call('POST', '/api/contracts', { cookie: adminSid, body: { opportunity_id: 1, quotation_id: qid } }) : { status: 0 };
ok('C3-5 同一报价重复建合同被拒(400)', c2.status === 400, `status=${c2.status}`);

/* ==================== TC-C4 财务：开票 / 回款 / 三单匹配 ==================== */
section('TC-C4 财务：开票 / 回款 / 三单匹配');
const pv = cid ? await call('GET', `/api/approvals/preview?type=contract&id=${cid}`, { cookie: adminSid }) : { status: 0, json: {} };
ok('C4-0 合同审批链预览返回非空步骤', pv.status === 200 && Array.isArray(pv.json.steps) && pv.json.steps.length > 0, JSON.stringify(pv.json).slice(0, 200));
// 合同审批链涉及多角色审批人，这里直接置为 active 以聚焦财务规则（审批链解析已由 C4-0 覆盖）
if (cid) await run("update contracts set status='active', activated_at=? where id=?", nowIso(), cid);
const inv1 = cid ? await call('POST', '/api/finance/invoices', { cookie: adminSid, body: { contract_id: cid, amount: 2000 } }) : { status: 0, json: {} };
ok('C4-1 开票申请成功', inv1.status === 200 && Number(inv1.json.id) > 0, JSON.stringify(inv1));
const invId = inv1.json.id;
const invOver = cid ? await call('POST', '/api/finance/invoices', { cookie: adminSid, body: { contract_id: cid, amount: 9999 } }) : { status: 0 };
ok('C4-2 超额开票被拒(400)', invOver.status === 400, `status=${invOver.status}`);
const issueByAe = invId ? await call('POST', `/api/finance/invoices/${invId}/issue`, { cookie: aeSid, body: {} }) : { status: 0 };
ok('C4-3 非财务角色开票被拒(403)', issueByAe.status === 403, `status=${issueByAe.status}`);
const issue = invId ? await call('POST', `/api/finance/invoices/${invId}/issue`, { cookie: finSid, body: {} }) : { status: 0, json: {} };
ok('C4-4 财务开票成功', issue.status === 200 && Boolean(issue.json.no), JSON.stringify(issue));
const pay = cid ? await call('POST', '/api/finance/payments', { cookie: finSid, body: { contract_id: cid, amount: 2000 } }) : { status: 0, json: {} };
ok('C4-5 财务登记回款成功', pay.status === 200 && Number(pay.json.id) > 0, JSON.stringify(pay));
ok('C4-6 回款自动核销后无未分配余额', Number(pay.json.unallocated) === 0, String(pay.json.unallocated));
const payByAe = cid ? await call('POST', '/api/finance/payments', { cookie: aeSid, body: { contract_id: cid, amount: 100 } }) : { status: 0 };
ok('C4-7 非财务登记回款被拒(403)', payByAe.status === 403, `status=${payByAe.status}`);
const cDetail = cid ? await call('GET', `/api/contracts/${cid}`, { cookie: adminSid }) : { json: {} };
ok('C4-8 三单匹配通过(合同额=开票额=回款+应收)', cDetail.json.threeWay?.matched === true, JSON.stringify(cDetail.json.threeWay));

/* ==================== TC-C5 系统设置读写与权限 ==================== */
section('TC-C5 系统设置读写与权限');
const gs = await call('GET', '/api/settings', { cookie: adminSid });
ok('C5-1 admin 读取设置(200)', gs.status === 200 && gs.json.values && typeof gs.json.values === 'object', `status=${gs.status}`);
const gsAe = await call('GET', '/api/settings', { cookie: aeSid });
ok('C5-2 非管理员只读查看设置(200 且 canEdit=false)', gsAe.status === 200 && gsAe.json.canEdit === false, `status=${gsAe.status} canEdit=${gsAe.json.canEdit}`);
const patchAe = await call('PATCH', '/api/settings', { cookie: aeSid, body: { values: { 'quote.valid_days': '1' } } });
ok('C5-2b 非管理员修改设置仍被拒(403)', patchAe.status === 403, `status=${patchAe.status}`);
const patch = await call('PATCH', '/api/settings', { cookie: adminSid, body: { values: { 'quote.valid_days': '45' } } });
ok('C5-3 修改报价有效期生效', patch.status === 200 && patch.json.changed === 1, JSON.stringify(patch));
const { getSettingNum } = await import('../src/settings.js');
const validDays = await getSettingNum('quote.valid_days');
ok('C5-4 设置值已持久化(45)', validDays === 45, String(validDays));

/* ---------- 收尾 ---------- */
console.log(`\n===== CRM 核心主线回归：${pass} 通过 / ${fail} 失败 =====`);
if (bad.length) console.log('未通过：' + bad.join('、'));
try { await db.closeDb?.(); } catch { /* 忽略 */ }
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail === 0 ? 0 : 1);
