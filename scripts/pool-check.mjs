/**
 * 一期「线索公海」验收脚本（docs/20 第 12 节 TC-01~TC-12）
 *
 *   node scripts/pool-check.mjs
 *
 * 设计约束：
 *  - 全程用临时库，绝不碰 data/crm.db 或生产 PostgreSQL 的业务数据；
 *    PG 场景只跑幂等 migrate() 与结构检查，不写业务行。
 *  - db.js 在「模块求值期」就确定数据库引擎，因此三个场景各起一个子进程，
 *    由主入口通过环境变量注入，避免单例串库。
 *  - 场景：sqlite-new（新库 + TC-01~TC-10 + TC-12a~12h 含外部 API 入池）、
 *          sqlite-legacy（模拟老库补列）、trial-link（二期试用联动 TC-B2-01~13）、
 *          pg（TC-11 的 PG 分支）。
 *  - 二期场景要顺带检查官网 D1 邮件时，传 SITE_ROOT=<官网仓库根>；未设置则跳过该两项，
 *    保证 CRM 仓库单独跑 test:pool 时不依赖官网路径。
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');
const arg = process.argv.find((a) => a.startsWith('--scene='));
const SCENE = arg ? arg.slice('--scene='.length) : null;

let passed = 0;
let failed = 0;
function check(id, ok, msg) {
  if (ok) { passed++; console.log(`[PASS] ${id} ${msg}`); }
  else { failed++; console.log(`[FAIL] ${id} ${msg}`); }
}
function finish(label) {
  console.log(`\n[${label}] ${passed} PASS / ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
}
const iso = (ms) => new Date(ms).toISOString();
const H = 3600000;
const D = 86400000;
const NOW = Date.now();

/* ==================================================================== */
/* 主入口：依次跑三个场景，汇总结果                                        */
/* ==================================================================== */
if (!SCENE) {
  const tmp = mkdtempSync(join(tmpdir(), 'crm-pool-check-'));
  writeFileSync(join(tmp, 'empty.env'), ''); // 屏蔽项目 .env，SQLite 场景完全隔离
  const base = { ...process.env };
  ['ENV_FILE', 'DB_TYPE', 'CRM_DB', 'DB_FILE', 'PORT', 'DEMO_MODE', 'POOL_CHECK_TMP'].forEach((k) => delete base[k]);

  const scenes = [
    ['sqlite-new', { ...base, POOL_CHECK_TMP: tmp, ENV_FILE: join(tmp, 'empty.env'), DB_TYPE: 'sqlite', CRM_DB: join(tmp, 'new.db') }],
    ['sqlite-legacy', { ...base, POOL_CHECK_TMP: tmp, ENV_FILE: join(tmp, 'empty.env'), DB_TYPE: 'sqlite', CRM_DB: join(tmp, 'legacy.db') }],
    ['trial-link', { ...base, POOL_CHECK_TMP: tmp, ENV_FILE: join(tmp, 'empty.env'), DB_TYPE: 'sqlite', CRM_DB: join(tmp, 'trial.db'), SITE_ROOT: String(process.env.SITE_ROOT || '').trim() }],
    ['pg', { ...base, POOL_CHECK_TMP: tmp }], // 不设 ENV_FILE，让项目 .env 的 PostgreSQL 生效
  ];

  let badScenes = 0;
  let totalFail = 0;
  for (const [name, env] of scenes) {
    const r = spawnSync(process.execPath, [SELF, `--scene=${name}`], {
      cwd: ROOT, env, encoding: 'utf8', timeout: 180000,
    });
    console.log(`\n===== 场景 ${name}（exit ${r.status}${r.error ? ' / ' + r.error.message : ''}）=====`);
    process.stdout.write(r.stdout || '');
    if (r.stderr) process.stderr.write(r.stderr);
    const nFail = ((r.stdout || '').match(/\[FAIL\]/g) || []).length;
    totalFail += nFail;
    if (r.status !== 0) badScenes++;
  }
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n===== 汇总：${scenes.length - badScenes}/${scenes.length} 场景通过，${totalFail} 条用例失败 =====`);
  process.exit(badScenes || totalFail ? 1 : 0);
}

/* ==================================================================== */
/* 单场景直跑保护                                                          */
/*   官方入口是 npm run test:pool：主入口为每个场景注入 ENV_FILE / DB_TYPE  */
/*   / CRM_DB，全部指向临时库。若有人直接跑                                */
/*     node scripts/pool-check.mjs --scene=trial-link                      */
/*   而没带这些变量，db.js 会读项目 .env 连到生产 PostgreSQL，场景里的种子  */
/*   数据就会写进生产库。双道守卫：先查注入的环境变量（连 db.js 都不加载，  */
/*   不建生产连接池），变量齐了再以实际 DB_ENGINE 二次确认，不依赖调用方   */
/*   记得传参。pg 场景刻意放行——它本来就要连生产库做幂等迁移。            */
/* ==================================================================== */
if (SCENE && SCENE !== 'pg') {
  // 第一道：只看主入口注入的环境变量，未注入 SQLite 临时库就直接拒绝，
  // 连 db.js 都不 import——避免模块求值期按 .env 建起生产 PostgreSQL 连接池。
  const injected = String(process.env.DB_TYPE || '').toLowerCase() === 'sqlite'
    && Boolean(process.env.ENV_FILE)
    && Boolean(process.env.CRM_DB);
  if (!injected) {
    console.error(`[拒绝执行] 场景 ${SCENE} 只能跑在 SQLite 临时库上，且必须由主入口注入 ENV_FILE / DB_TYPE / CRM_DB。`);
    console.error('请用 npm run test:pool 走主入口，或显式设置 ENV_FILE=<空文件> DB_TYPE=sqlite CRM_DB=<临时文件>。');
    process.exit(2);
  }
  // 第二道：环境变量齐了也以实际引擎为准，防 env.js 忽略 DB_TYPE 的极端情况。
  const probe = await import('../src/db.js');
  if (probe.DB_ENGINE !== 'sqlite') {
    console.error(`[拒绝执行] 场景 ${SCENE} 只能用 SQLite 临时库，当前引擎是 ${probe.DB_ENGINE}。`);
    process.exit(2);
  }
}

/* ==================================================================== */
/* 场景一：SQLite 新库，跑业务用例 TC-01~TC-10 + TC-12                    */
/* ==================================================================== */
if (SCENE === 'sqlite-new') {
  const db = await import('../src/db.js');
  const P = await import('../src/pool.js');
  const { setSetting } = await import('../src/settings.js');
  const { scopeFilter } = await import('../src/auth.js');
  const { run, one, all, nowIso } = db;

  await db.migrate();

  /* ---- TC-11（SQLite 新库分支）：建表即含新列 / 新表 ---- */
  const leadCols = (await all('PRAGMA table_info(leads)')).map((r) => r.name);
  check('TC-11a', ['pool_at', 'pool_reason', 'pool_count'].every((c) => leadCols.includes(c)), '新库 leads 含 3 个池字段');
  const apiCols = (await all('PRAGMA table_info(api_clients)')).map((r) => r.name);
  check('TC-11b', apiCols.includes('pool_on_missing'), '新库 api_clients 含 pool_on_missing');
  const poolTbl = await one("select name from sqlite_master where type='table' and name='pool_events'");
  check('TC-11c', Boolean(poolTbl), '新库含 pool_events 审计表');

  /* ---- 种子：组织 / 用户 / 线索 ---- */
  const org = (id, parent, path, name) =>
    run('insert into org_units(id,parent_id,path,name,type,created_at) values(?,?,?,?,?,?)',
      id, parent, path, name, 'company', nowIso());
  const user = async (id, username, orgId, role) => {
    await run('insert into users(id,username,name,password,org_id,status,created_at) values(?,?,?,?,?,?,?)',
      id, username, username, 'x', orgId, 'active', nowIso());
    await run('insert into user_roles(user_id,role) values(?,?)', id, role);
  };
  await org(1, null, '/1/', '集团');
  await org(2, 1, '/1/2/', 'A 公司');
  await org(3, 1, '/1/3/', 'B 公司');
  for (const [id, uname, oid, role] of [
    [1, 'pooladmin', 1, 'admin'], [2, 'poolmgrA', 2, 'manager'],
    [3, 'poolsdrA', 2, 'sdr'], [4, 'pooltrial', 2, 'trial'],
    [5, 'poolmgrB', 3, 'manager'], [6, 'poollimit', 2, 'ae'],
    [7, 'poolsweep', 2, 'ae'],
  ]) await user(id, uname, oid, role);

  const U = {
    admin: { id: 1, role: 'admin', scope: 'all', orgPath: '/1/', org_id: 1, modules: ['*'] },
    mgrA: { id: 2, role: 'manager', scope: 'org', orgPath: '/1/2/', org_id: 2, modules: ['lead'] },
    sdrA: { id: 3, role: 'sdr', scope: 'self', orgPath: '/1/2/', org_id: 2, modules: ['lead'] },
    trialA: { id: 4, role: 'trial', scope: 'org', orgPath: '/1/2/', org_id: 2, modules: ['lead'] },
    mgrB: { id: 5, role: 'manager', scope: 'org', orgPath: '/1/3/', org_id: 3, modules: ['lead'] },
    limitU: { id: 6, role: 'ae', scope: 'self', orgPath: '/1/2/', org_id: 2, modules: ['lead'] },
    sweepU: { id: 7, role: 'ae', scope: 'self', orgPath: '/1/2/', org_id: 2, modules: ['lead'] },
  };

  const lead = (id, o) => run(
    `insert into leads(id,name,contact_name,contact_phone,source,industry,status,owner_id,org_id,
       claim_at,pool_at,pool_reason,pool_count,last_activity_at,created_at,updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, `线索-${id}`, '联系人', '13800000000', '官网', '装备制造',
    o.status || 'new', o.ownerId ?? null, o.orgId ?? 2,
    o.claimAt ?? null, o.poolAt ?? null, o.poolReason ?? null, o.poolCount ?? 0,
    o.lastActivityAt ?? null, nowIso(), nowIso()
  );

  // 池中线索（A 组织 2 条、B 组织 1 条、invalid 1 条、并发 / trial / 限额各 1 条）
  for (const id of [101, 102, 106, 107]) await lead(id, { poolAt: iso(NOW), poolReason: 'api', poolCount: 1 });
  await lead(103, { orgId: 3, poolAt: iso(NOW), poolReason: 'api', poolCount: 1 });
  await lead(104, { status: 'invalid', poolAt: iso(NOW), poolReason: 'release' });
  // 同组织他人私有线索（TC-03）、trial 可领（TC-04 已由 107 提供）
  await lead(105, { ownerId: 2, claimAt: iso(NOW) });
  // 在库 / 每周限额用（claim_at 为空，janitor 不扫）
  await lead(108, { ownerId: 6 });
  await lead(109, { ownerId: 6 });
  // 自动回池验证用：一条普通超时线索 + 一条 invalid 超时线索
  await lead(112, { ownerId: 7, claimAt: iso(NOW - 40 * D) });
  await lead(113, { ownerId: 7, claimAt: iso(NOW - 40 * D), status: 'invalid' });
  // note 不续时钟用
  await lead(114, { ownerId: 7, claimAt: iso(NOW - 40 * D), lastActivityAt: iso(NOW - D) });
  await run("insert into activities(target_type,target_id,type,content,user_id,created_at) values('lead',?,'note',?,?,?)",
    114, '只是内部备注', 2, iso(NOW - D));

  /* ---- TC-01 并发领取 ---- */
  const rs = await Promise.allSettled([P.claimLead(U.admin, 106), P.claimLead(U.mgrA, 106)]);
  const okCount = rs.filter((r) => r.status === 'fulfilled').length;
  const rejected = rs.find((r) => r.status === 'rejected');
  check('TC-01', okCount === 1 && rejected?.reason?.detail?.code === 'POOL_ALREADY_CLAIMED',
    `两个并发领取恰好 1 成功，另 1 个 ${rejected?.reason?.detail?.code || rejected?.reason?.message}`);

  /* ---- TC-02 组织隔离 ---- */
  const rowsA = await P.listPool(U.mgrA);
  const rowsB = await P.listPool(U.mgrB);
  check('TC-02', !rowsA.some((r) => r.org_id === 3) && !rowsB.some((r) => r.org_id === 2),
    'A 公司成员看不到 B 公司池线索，反之亦然');

  /* ---- TC-03 self 角色 ---- */
  const rowsSelf = await P.listPool(U.sdrA);
  check('TC-03a', rowsSelf.some((r) => r.id === 101) && !rowsSelf.some((r) => r.id === 103),
    'self 看得见本组织池、看不见外组织池');
  check('TC-03b', !rowsSelf.some((r) => r.id === 105), 'self 看不到同组织他人私有线索');
  check('TC-03c', scopeFilter(U.sdrA).sql.includes('owner_id = ?'),
    'scopeFilter 对 self 恒按 owner_id，故公海必须独立 poolWhere');

  /* ---- TC-04 trial 账号 ---- */
  try { await P.claimLead(U.trialA, 107); check('TC-04a', true, 'trial 可以领取'); }
  catch (e) { check('TC-04a', false, `trial 领取失败：${e.message}`); }
  try { await P.assignLead(U.trialA, 102, 2); check('TC-04b', false, 'trial 不应能分配'); }
  catch (e) { check('TC-04b', e.status === 403, `trial 分配被拒（status ${e.status}）`); }
  try { await P.reclaimLead(U.trialA, 105, 'x'); check('TC-04c', false, 'trial 不应能强制回收'); }
  catch (e) { check('TC-04c', e.status === 403, `trial 强制回收被拒（status ${e.status}）`); }

  /* ---- TC-05 ~ TC-08 双时钟 ---- */
  const rules = await P.getRules();
  const v5 = P.evaluateLead({ claim_at: iso(NOW - 2 * D), last_activity_at: null }, null, rules, NOW);
  check('TC-05', v5.action === 'none', '刚领取（保护期内）跑 janitor 不回收');
  const v6 = P.evaluateLead({ claim_at: iso(NOW - 73 * H), last_activity_at: null }, null, rules, NOW);
  check('TC-06', v6.action === 'reclaim' && v6.reason === 'first_touch_timeout',
    `73h 无首触回池（${v6.action}/${v6.reason}）`);
  const v7 = P.evaluateLead({ claim_at: iso(NOW - 40 * D), last_activity_at: iso(NOW - D) }, iso(NOW - 31 * D), rules, NOW);
  check('TC-07', v7.action === 'reclaim' && v7.reason === 'timeout',
    `31 天无有效跟进且过保护期回池（${v7.action}/${v7.reason}）`);
  const noteAt = await P.lastValidFollowAt(114);
  const v8 = P.evaluateLead({ claim_at: iso(NOW - 40 * D), last_activity_at: iso(NOW - D) }, noteAt, rules, NOW);
  check('TC-08', noteAt === null && v8.action === 'reclaim' && v8.reason === 'timeout',
    '只写 note 不续时钟，仍按 TC-07 回收');

  /* ---- TC-09 invalid 永不回池 ---- */
  check('TC-09a', !(await P.listPool(U.admin)).some((r) => r.id === 104), 'invalid 线索不出现在池中');
  const swept = await P.sweepPool();
  const r112 = await one('select owner_id from leads where id=?', 112);
  const r113 = await one('select owner_id from leads where id=?', 113);
  check('TC-09b', r112.owner_id === null, `超时未跟进线索被自动回池（扫描 ${swept.scanned} 条 / 回池 ${swept.reclaimed} 条）`);
  check('TC-09c', r113.owner_id === 7, 'invalid 线索永不回池');

  /* ---- TC-10 在库 / 每周限额 ---- */
  await setSetting('pool.hold_limit', '2');
  await setSetting('pool.claim_weekly_limit', '2');
  const r2 = await P.getRules();
  check('TC-10a', r2.holdLimit === 2 && r2.weeklyLimit === 2, '规则改完即时生效（走 settings，不重启）');
  try { await P.claimLead(U.limitU, 102); check('TC-10b', false, '在库触顶应被拒'); }
  catch (e) {
    check('TC-10b', e.detail?.code === 'POOL_HOLD_LIMIT' && /上限|2/.test(e.message),
      `在库触顶被拒：${e.message}`);
  }
  await setSetting('pool.hold_limit', '50');
  await P.poolEvent({ leadId: 108, orgId: 2, actorId: 6, action: 'claim', toOwner: 6 });
  await P.poolEvent({ leadId: 109, orgId: 2, actorId: 6, action: 'claim', toOwner: 6 });
  try { await P.claimLead(U.limitU, 102); check('TC-10c', false, '每周限额触顶应被拒'); }
  catch (e) {
    check('TC-10c', e.detail?.code === 'POOL_WEEKLY_LIMIT' && /上限|2/.test(e.message),
      `每周限额触顶被拒：${e.message}`);
  }

  /* ---- TC-11 重复 migrate 幂等 ---- */
  await db.migrate();
  const colsAgain = (await all('PRAGMA table_info(leads)')).map((r) => r.name);
  check('TC-11d', colsAgain.filter((c) => c === 'pool_at').length === 1, '重复 migrate 不重复加列');
  const idxRow = await one("select name from sqlite_master where type='index' and name='idx_lead_pool'");
  check('TC-11e', Boolean(idxRow), 'idx_lead_pool 在补列之后成功建立');

  /* ---- TC-12 路由顺序 + 真实 HTTP 冒烟 ---- */
  const idxSrc = readFileSync(join(ROOT, 'src/routes/index.js'), 'utf8');
  const mPool = idxSrc.match(/^\s*import '\.\/pool\.js';/m);
  const mLeads = idxSrc.match(/^\s*import '\.\/leads\.js';/m);
  check('TC-12a', Boolean(mPool && mLeads) && mPool.index < mLeads.index,
    'src/routes/index.js 中 pool.js 注册早于 leads.js');

  const port = 19000 + Math.floor(Math.random() * 800);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DEMO_MODE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += String(d); });
  child.stderr.on('data', (d) => { serverLog += String(d); });

  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { await fetch(`http://127.0.0.1:${port}/api/auth/me`); ready = true; break; } catch { /* 等启动 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  check('TC-12b', ready, `服务在 127.0.0.1:${port} 已就绪`);
  if (ready) {
    const token = randomBytes(32).toString('hex');
    await run('insert into sessions(token,user_id,created_at,expires_at,ip,ua) values(?,?,?,?,?,?)',
      token, 1, nowIso(), iso(NOW + 12 * H), '', 'pool-check');
    const res = await fetch(`http://127.0.0.1:${port}/api/leads/pool`, {
      headers: { cookie: `crm_sid=${token}` },
    });
    let data = {};
    try { data = await res.json(); } catch { /* 非 JSON */ }
    check('TC-12c', res.status === 200 && Array.isArray(data.rows) && data.stats && typeof data.stats.poolTotal === 'number',
      `GET /api/leads/pool 返回 {rows, stats}（status ${res.status}），未被 /api/leads/:id 吃掉`);

    /* ---- TC-12d~12h 外部线索 API 未指定负责人 → 入公海（真实 HTTP 全链路） ----
       编号挂在 TC-12（真实 HTTP 冒烟）组下：docs/20 第 12 节的 TC-13~TC-27
       已分配给官网侧二~四期，不能占用。 */
    // 复用上面已启动的 server.js：构造一条「不含默认负责人」的 API 接入方，
    // 用 API 密钥推一条不带 owner_id 的线索，验证入池字段与审计轨迹一次落库。
    const apiKey = `crm_${randomBytes(24).toString('hex')}`;
    const apiHash = createHash('sha256').update(apiKey).digest('hex');
    await run(`insert into api_clients(id,name,client_id,key_prefix,key_hash,status,scopes,
         ip_whitelist,domain_whitelist,pool_on_missing,rate_limit,daily_quota,org_id,owner_id,created_at)
       values(?,?,?,?,?,'active',?,?,?,?,?,?,?,?,?)`,
      1, '公海验收接入方', 'ak_poolcheck', 'crm_poo', apiHash,
      '["lead:read","lead:write"]', '127.0.0.1', '', 1, 0, 0, 2, null, nowIso());
    const apiHeaders = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      // server.js 优先取 x-forwarded-for，显式声明保证命中 127.0.0.1 白名单
      'x-forwarded-for': '127.0.0.1',
    };
    const postLead = (externalId) => fetch(`http://127.0.0.1:${port}/api/v1/leads`, {
      method: 'POST', headers: apiHeaders,
      body: JSON.stringify({ name: `API 线索 ${externalId}`, external_id: externalId, source: '官网' }),
    });

    const r13 = await postLead('POOLCHECK-001');
    let d13 = {};
    try { d13 = await r13.json(); } catch { /* 非 JSON */ }
    check('TC-12d', r13.status === 201 && d13.ok === true && d13.data?.owner_id === null && d13.data?.duplicated === false,
      `API 推送未指定负责人返回 201 且 owner_id=null（status ${r13.status}）`);

    const l13 = await one('select * from leads where external_id = ?', 'POOLCHECK-001');
    check('TC-12e', Boolean(l13) && l13.owner_id === null && Boolean(l13.pool_at)
      && l13.pool_reason === 'api' && Number(l13.pool_count) === 1 && l13.org_id === 2,
      '入池线索落库：pool_at / pool_reason=api / pool_count=1 / org_id 取接入方组织');
    const ev13 = await one("select count(*) c from pool_events where lead_id = ? and action = 'api_in'", l13?.id || 0);
    check('TC-12f', Number(ev13?.c || 0) === 1, 'pool_events 写入 1 条 action=api_in 审计');

    // 关闭开关：pool_on_missing=0 应恢复旧行为（直接 400 报错，且不建线索）
    await run('update api_clients set pool_on_missing = 0 where id = 1');
    const r13d = await postLead('POOLCHECK-002');
    let d13d = {};
    try { d13d = await r13d.json(); } catch { /* 非 JSON */ }
    const notCreated = await one('select count(*) c from leads where external_id = ?', 'POOLCHECK-002');
    check('TC-12g', r13d.status === 400 && Number(notCreated.c) === 0 && /默认线索负责人/.test(d13d.error || ''),
      `pool_on_missing=0 恢复旧报错行为且不留脏数据（status ${r13d.status}）`);
    await run('update api_clients set pool_on_missing = 1 where id = 1');

    // PATCH 带空 owner_id 不得静默放回池（allowPool:false），线索仍保持池中状态
    const r13e = await fetch(`http://127.0.0.1:${port}/api/v1/leads/${l13.id}`, {
      method: 'PATCH', headers: apiHeaders, body: JSON.stringify({ owner_id: 0 }),
    });
    const l13e = await one('select owner_id, pool_at from leads where id = ?', l13.id);
    check('TC-12h', r13e.status === 400 && l13e.owner_id === null && Boolean(l13e.pool_at),
      `PATCH 空 owner_id 被明确拒绝、线索未被改动（status ${r13e.status}）`);
  }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((r) => child.once('exit', r)),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  if (failed) console.log('\n--- server.js 输出 ---\n' + serverLog.slice(-2000));
  finish('sqlite-new');
}

/* ==================================================================== */
/* 场景二：SQLite 老库补列（TC-11）                                        */
/* ==================================================================== */
if (SCENE === 'sqlite-legacy') {
  const db = await import('../src/db.js');
  const { run, all, one } = db;

  // 先建完整新库，再「回退」成升级前的老库结构：
  // 删掉本轮新增的 3 列、pool_events 表、pool_on_missing 列与依赖索引。
  await db.migrate();
  await run('DROP INDEX IF EXISTS idx_lead_pool');
  await run('ALTER TABLE leads DROP COLUMN pool_at');
  await run('ALTER TABLE leads DROP COLUMN pool_reason');
  await run('ALTER TABLE leads DROP COLUMN pool_count');
  await run('DROP TABLE IF EXISTS pool_events');
  await run('ALTER TABLE api_clients DROP COLUMN pool_on_missing');
  const before = (await all('PRAGMA table_info(leads)')).map((r) => r.name);
  check('TC-11f', !before.includes('pool_at'), '已模拟升级前的老库（leads 无 pool_at）');

  // 关键：老库再跑 migrate()，必须能补列 + 在补列之后重建索引，且整体不抛错
  let migrateOk = true;
  let migrateErr = '';
  try { await db.migrate(); }
  catch (e) { migrateOk = false; migrateErr = e.message; }
  check('TC-11g', migrateOk, `老库 migrate() 成功${migrateOk ? '' : '：' + migrateErr}`);

  const after = (await all('PRAGMA table_info(leads)')).map((r) => r.name);
  check('TC-11h', ['pool_at', 'pool_reason', 'pool_count'].every((c) => after.includes(c)), '老库补出 leads 的 3 个池字段');
  const apiAfter = (await all('PRAGMA table_info(api_clients)')).map((r) => r.name);
  check('TC-11i', apiAfter.includes('pool_on_missing'), '老库补出 api_clients.pool_on_missing');
  check('TC-11j', Boolean(await one("select name from sqlite_master where type='table' and name='pool_events'")), '老库补出 pool_events 表');
  check('TC-11k', Boolean(await one("select name from sqlite_master where type='index' and name='idx_lead_pool'")), '老库补列后成功重建 idx_lead_pool');

  // 幂等：再跑一次不重复加列、不报错
  let twiceOk = true;
  try { await db.migrate(); } catch { twiceOk = false; }
  const twice = (await all('PRAGMA table_info(leads)')).map((r) => r.name);
  check('TC-11l', twiceOk && twice.filter((c) => c === 'pool_at').length === 1, '老库重复 migrate 幂等');
  finish('sqlite-legacy');
}

/* ==================================================================== */
/* 场景三：二期 · 试用联动（TC-B2-01~13）                                  */
/*   真实调 createTrialAccount() 建一个试用组织，验证 3 私有 + 2 入池、      */
/*   frozen 拦截、前端分配引导与第 11 人额度链路，以及官网 D1 邮件总数。     */
/* ==================================================================== */
if (SCENE === 'trial-link') {
  const db = await import('../src/db.js');
  const { run, one, all, nowIso } = db;
  const T = await import('../src/trial.js');
  const P = await import('../src/pool.js');

  await db.migrate();
  // ensureTrialRoot() 要挂在根组织下；临时库先给一条根
  await run("insert into org_units(id,parent_id,path,name,type,created_at) values(1,null,'/1/','集团','company',?)", nowIso());

  const t = await T.createTrialAccount({ email: 'pool2@example.com', name: '二期验收', company: '二期验收公司' });
  check('TC-B2-01', Boolean(t.userId && t.orgId && t.sample && t.sample.leads === 5),
    `开通试用并预置 5 条示例线索（sample=${JSON.stringify(t.sample)}）`);

  const rows = await all("select * from leads where org_id = ? and source = '示例' order by id", t.orgId);
  check('TC-B2-02', rows.length === 5, `示例线索共 5 条（实际 ${rows.length}）`);
  const priv = rows.filter((r) => r.owner_id === t.userId);
  const pooled = rows.filter((r) => r.owner_id === null);
  check('TC-B2-03', priv.length === 3 && pooled.length === 2,
    `3 条私有 + 2 条入池（${priv.length}/${pooled.length}）`);
  check('TC-B2-04', pooled.length === 2 && pooled.every((r) => r.pool_at && r.pool_reason === 'sample'
      && Number(r.pool_count) === 1 && r.status === 'new' && !r.claim_at && !r.last_activity_at),
    '入池线索：pool_at / pool_reason=sample / pool_count=1 / status=new / 无 claim_at');
  check('TC-B2-05', priv.length === 3 && priv.every((r) => !r.pool_at && Number(r.pool_count) === 0),
    '私有线索不带池轨迹');

  // converted 那条关联了商机与报价，必须保持私有，示例主线不能被破坏
  const conv = rows.find((r) => r.status === 'converted');
  check('TC-B2-06', Boolean(conv) && conv.owner_id === t.userId && Boolean(conv.account_id),
    '已转化示例线索保持私有并关联客户（商机 / 报价主线不变）');

  // 试用成员（scope=org）视角能在公共池看到这 2 条
  const org = await one('select path from org_units where id = ?', t.orgId);
  const trialUser = { id: t.userId, role: 'trial', scope: 'org', orgPath: org.path, org_id: t.orgId, modules: ['lead'] };
  const visible = await P.listPool(trialUser);
  check('TC-B2-07', visible.length === 2 && pooled.every((r) => visible.some((v) => v.id === r.id)),
    `试用成员在「公共池」看得到 2 条待领示例线索（实际 ${visible.length}）`);

  // frozen 账号禁止领取（docs/20 第 3.8 节第 4 条）
  await run("update users set status = 'frozen' where id = ?", t.userId);
  let frozenCode = '';
  try { await P.claimLead(trialUser, pooled[0]?.id || 0); }
  catch (e) { frozenCode = e.detail?.code || e.message; }
  check('TC-B2-08', frozenCode === 'POOL_FROZEN', `frozen 账号领取被拒（${frozenCode}）`);
  await run("update users set status = 'active' where id = ?", t.userId);

  /* ---- 前端：分配引导 + 第 11 人额度提示链路（源码静态检查） ---- */
  const poolSrc = readFileSync(join(ROOT, 'public/js/views/pool.js'), 'utf8');
  check('TC-B2-09', /showAddTeammateHint/.test(poolSrc) && /others\.length/.test(poolSrc)
      && /10 个在职用户以内免费/.test(poolSrc) && /#\/admin/.test(poolSrc),
    '分配引导：组织内仅 1 人时弹「添加同事一起用」并跳用户管理');
  const adminSrc = readFileSync(join(ROOT, 'public/js/views/admin.js'), 'utf8');
  const editionSrc = readFileSync(join(ROOT, 'src/edition.js'), 'utf8');
  check('TC-B2-10', /USER_LIMIT/.test(adminSrc) && /showUpgrade/.test(adminSrc)
      && /upgradeUrl/.test(adminSrc) && /社区版许可 v2\.0/.test(adminSrc)
      && !/仅限个人学习与非营利研究/.test(adminSrc),
    '第 11 人链路：USER_LIMIT → 升级弹窗 → UPGRADE_URL，话术已对齐 v2.0');
  check('TC-B2-11', /code: 'USER_LIMIT'/.test(editionSrc) && /assertUserSlot/.test(editionSrc)
      && /UPGRADE_URL/.test(editionSrc),
    '后端 assertUserSlot 抛 USER_LIMIT 且带 UPGRADE_URL');

  /* ---- 官网 D1 邮件：仍 5 封 + 含公共池一句（跨仓库，需 SITE_ROOT） ---- */
  const siteRoot = String(process.env.SITE_ROOT || '').trim();
  if (siteRoot) {
    const mailSrc = readFileSync(join(siteRoot, 'src/trial-mails.js'), 'utf8');
    const keys = mailSrc.match(/key: 'd\d+'/g) || [];
    check('TC-B2-12', keys.length === 5, `官网 MAIL_STEPS 仍为 5 封（实际 ${keys.length}）`);
    check('TC-B2-13', /2 条线索放在「公共池」/.test(mailSrc),
      'D1 正文含「公共池里有 2 条待领取的示例线索」对应文案');
  } else {
    console.log('[SKIP] 未设置 SITE_ROOT，跳过官网 D1 邮件检查（TC-B2-12/13）');
  }
  finish('trial-link');
}

/* ==================================================================== */
/* 场景四：PostgreSQL（TC-11 的 PG 分支，只做幂等迁移 + 结构检查）          */
/* ==================================================================== */
if (SCENE === 'pg') {
  const db = await import('../src/db.js');
  try {
    await db.migrate();
    const cols = await db.all(
      'select column_name from information_schema.columns where table_schema = ? and table_name = ?',
      db.SCHEMA, 'leads'
    );
    const names = cols.map((r) => r.column_name);
    check('TC-11m', db.DB_ENGINE === 'postgres', `当前引擎为 PostgreSQL（schema ${db.SCHEMA}）`);
    check('TC-11n', ['pool_at', 'pool_reason', 'pool_count'].every((c) => names.includes(c)),
      'PG leads 含 3 个池字段（老库由 ensureColumns 补出）');
    const apiCols = await db.all(
      'select column_name from information_schema.columns where table_schema = ? and table_name = ?',
      db.SCHEMA, 'api_clients'
    );
    check('TC-11o', apiCols.map((r) => r.column_name).includes('pool_on_missing'), 'PG api_clients 含 pool_on_missing');
    const evt = await db.one(
      "select to_regclass(?) is not null as ok", `${db.SCHEMA}.pool_events`
    );
    check('TC-11p', Boolean(evt?.ok), 'PG 含 pool_events 表');
    const idx = await db.one('select 1 as ok from pg_indexes where schemaname = ? and indexname = ?', db.SCHEMA, 'idx_lead_pool');
    check('TC-11q', Boolean(idx), 'PG 含 idx_lead_pool 索引');
    // 再跑一次，验证幂等
    let twiceOk = true;
    try { await db.migrate(); } catch (e) { twiceOk = false; console.log('  migrate 二次执行异常：' + e.message); }
    check('TC-11r', twiceOk, 'PG 重复 migrate 幂等');
    await db.pool.end();
  } catch (e) {
    check('TC-11m', false, `PostgreSQL 不可用：${String(e.message).slice(0, 180)}`);
    try { await db.pool?.end(); } catch { /* 忽略 */ }
  }
  finish('pg');
}

if (!['sqlite-new', 'sqlite-legacy', 'trial-link', 'pg'].includes(SCENE)) {
  console.error(`未知场景：${SCENE}`);
  process.exit(2);
}
