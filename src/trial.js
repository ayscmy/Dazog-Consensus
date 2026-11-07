import { randomInt } from 'node:crypto';
import { all, one, run, tx, nowIso, idOf } from './db.js';
import { hashPassword } from './password.js';

/**
 * 试用账号：官网注册会员后自动开通，14 天试用 → 到期冻结 → 再满 30 天才回收。
 *
 * 形态：每个试用会员独占一个公司级组织（挂在「试用中心」下），角色 trial
 * （scope=org，只能看自己这棵子树），互不可见、互不干扰。
 *
 * 为什么到期不直接删：试用期里用户录的是真实客户和单子，删掉等于告诉他
 * 「你花的时间白费了」——这会反过来抑制录入，而录入恰恰是付费的前提。
 * 所以到期先转 frozen（能登录看、不能改），数据原样保留，付费即时恢复；
 * 只有超过保留期仍无动作，才真正回收。
 *
 * 开通与回收由官网通过 /api/internal/trial* 调用；本文件另带一个每小时跑一次的
 * 兜底清理，即使官网挂了也不会留下永不过期的账号。
 */

export const TRIAL_DAYS = Math.max(1, Number(process.env.TRIAL_DAYS || 14));
/** 到期后数据保留天数（冻结期），期间付费可原样恢复 */
export const TRIAL_RETAIN_DAYS = Math.max(1, Number(process.env.TRIAL_RETAIN_DAYS || 30));
export const TRIAL_ROOT_NAME = process.env.TRIAL_ROOT_NAME || '试用中心';
export const TRIAL_URL = (process.env.TRIAL_URL || 'https://crm.aiemy.com').replace(/\/+$/, '');

const USER_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
const PASS_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PASS_LOWER = 'abcdefghijkmnpqrstuvwxyz';
const PASS_DIGIT = '23456789';
const PASS_ALL = PASS_UPPER + PASS_LOWER + PASS_DIGIT;

function pick(chars) {
  return chars[randomInt(0, chars.length)];
}

/** t 开头的 7 位账号，避开容易看错的字符 */
function genUsername() {
  let s = 't';
  for (let i = 0; i < 6; i++) s += pick(USER_CHARS);
  return s;
}

/** 12 位密码：保证同时含大写、小写与数字 */
function genPassword() {
  const core = [pick(PASS_UPPER), pick(PASS_LOWER), pick(PASS_DIGIT)];
  while (core.length < 12) core.push(pick(PASS_ALL));
  for (let i = core.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [core[i], core[j]] = [core[j], core[i]];
  }
  return core.join('');
}

/** 试用组织里预置的产品，让新账号能直接报价（否则产品库是空的） */
const TRIAL_PRODUCTS = [
  { code: 'MES', name: 'MES 制造执行系统', category: '软件', unit: '套', price: 680000, cost: 420000 },
  { code: 'WMS', name: 'WMS 仓储管理系统', category: '软件', unit: '套', price: 360000, cost: 220000 },
  { code: 'SRV', name: '实施与培训服务', category: '服务', unit: '人天', price: 2600, cost: 1800 },
  { code: 'IOT', name: '工业数据网关', category: '硬件', unit: '台', price: 8800, cost: 6200 }
];

/* ==================== 示例数据 ==================== */

/**
 * 试用组织预置的示例业务：3 个客户、5 条线索、2 个商机、1 份报价。
 *
 * 为什么必须预置：空组织等于让用户在 14 天里先花半天录入，才第一次看到
 * 这个系统"长什么样"。绝大多数人不会为一个还没看懂的东西做数据迁移。
 * 给了样例，他 3 分钟就能看懂「线索 → 商机 → 报价」这条主线。
 *
 * 标记方式：统一 source = '示例'，界面照常显示为「来源：示例」，
 * 用户想清空时按来源筛出来删即可，不需要额外的隐藏字段。
 */
const SAMPLE_ACCOUNTS = [
  { name: '苏州精工机械有限公司', short: '苏州精工', industry: '装备制造', scale: '500-1000人', region: '华东', level: 'A', phone: '0512-6688xxxx' },
  { name: '宁波华翔电子股份有限公司', short: '宁波华翔', industry: '电子制造', scale: '1000人以上', region: '华东', level: 'B', phone: '0574-8899xxxx' },
  { name: '合肥新能电气有限公司', short: '合肥新能', industry: '新能源', scale: '100-500人', region: '华中', level: 'B', phone: '0551-6677xxxx' }
];

const SAMPLE_LEADS = [
  { name: '无锡恒力传动数字化改造', contact: '王主任', title: '生产部', phone: '138****1024', status: 'new', demand: '想先看看 MES 能不能管到工序级报工', budget: '50-100万', next: '电话初访' },
  { name: '杭州锐驰汽配车间看板', contact: '李经理', title: '信息部', phone: '139****2048', status: 'contacted', demand: '已有 ERP，缺车间数据采集', budget: '30-50万', next: '约现场调研' },
  { name: '常州德胜精工 MES 选型', contact: '张总', title: '总经理', phone: '137****4096', status: 'qualified', demand: '今年预算已批，正在比 3 家', budget: '60-80万', next: '下周三方案汇报' },
  { name: '苏州精工机械 MES 一期', contact: '陈厂长', title: '厂长', phone: '136****8192', status: 'converted', demand: '已立项，先做装配车间', budget: '60-80万', next: '已转客户', accountIdx: 0 },
  { name: '嘉兴申菱环境仓储改造', contact: '周主管', title: '物流部', phone: '135****3072', status: 'new', demand: '成品库经常发错货', budget: '待确认', next: '加微信发资料' }
];

async function seedSampleData(orgId, userId, nowStr) {
  const day = (n) => new Date(Date.now() + n * 86400_000).toISOString();
  const date = (n) => day(n).slice(0, 10);

  // 1. 客户
  const accountIds = [];
  for (const a of SAMPLE_ACCOUNTS) {
    const r = await run(
      `insert into accounts(name,short_name,industry,scale,region,level,owner_id,org_id,phone,source,status,remark,created_by,created_at,updated_at)
       values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      a.name, a.short, a.industry, a.scale, a.region, a.level, userId, orgId, a.phone,
      '示例', 'active', '这是一条示例数据，可随时删除', userId, nowStr, nowStr
    );
    accountIds.push(idOf(r));
  }

  // 2. 线索（已转化的那条挂到对应客户上）
  const leadIds = [];
  for (let i = 0; i < SAMPLE_LEADS.length; i++) {
    const l = SAMPLE_LEADS[i];
    const r = await run(
      `insert into leads(name,contact_name,contact_title,contact_phone,source,industry,region,demand,budget,
         next_action,next_date,status,score,owner_id,org_id,account_id,created_at,updated_at)
       values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      l.name, l.contact, l.title, l.phone, '示例', null, null, l.demand, l.budget,
      l.next, date(1 + i), l.status, l.status === 'qualified' ? 80 : l.status === 'contacted' ? 50 : 20,
      userId, orgId, l.accountIdx != null ? accountIds[l.accountIdx] : null, nowStr, nowStr
    );
    leadIds.push(idOf(r));
  }

  // 3. 商机（一条已到方案阶段，直接能看到报价入口）
  const oppA = await run(
    `insert into opportunities(name,account_id,lead_id,amount,stage,probability,expected_date,owner_id,org_id,source,created_by,created_at,updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    '苏州精工机械 MES 一期', accountIds[0], leadIds[3], 680000, 'proposal', 60, date(30),
    userId, orgId, '示例', userId, nowStr, nowStr
  );
  const oppAId = idOf(oppA);

  await run(
    `insert into opportunities(name,account_id,amount,stage,probability,expected_date,owner_id,org_id,source,created_by,created_at,updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?)`,
    '宁波华翔 WMS 仓储升级', accountIds[1], 360000, 'needs', 30, date(75),
    userId, orgId, '示例', userId, nowStr, nowStr
  );

  // 4. 一份草稿报价（no 全局唯一，带 orgId 前缀）
  const quoteNo = `SAMPLE-${orgId}-001`;
  const qRow = await run(
    `insert into quotations(no,opportunity_id,account_id,version,amount,list_amount,discount_rate,cost,
       valid_until,status,remark,created_by,org_id,created_at,updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    quoteNo, oppAId, accountIds[0], 1, 680000, 680000, 0, 420000,
    date(15), 'draft', '示例报价：MES 一期 + 实施服务', userId, orgId, nowStr, nowStr
  );
  const quoteId = idOf(qRow);

  await run(
    `insert into quotation_items(quotation_id,seq,product_id,name,spec,unit,qty,list_price,unit_price,amount,cost,is_custom)
     values(?,?,?,?,?,?,?,?,?,?,?,?)`,
    quoteId, 1, null, 'MES 制造执行系统', '标准版', '套', 1, 680000, 680000, 680000, 420000, 0
  );

  return { accounts: accountIds.length, leads: leadIds.length, opportunities: 2, quotations: 1 };
}

/* ==================== 组织 ==================== */

/** 「试用中心」挂在根组织下，全局只有一个；不存在则建 */
export async function ensureTrialRoot() {
  const exist = await one(
    'select * from org_units where name = ? and parent_id is not null order by id limit 1',
    TRIAL_ROOT_NAME
  );
  if (exist) return exist;

  const root = await one('select * from org_units where parent_id is null order by id limit 1');
  if (!root) throw new Error('系统尚未初始化，无法开通试用账号');

  const now = nowIso();
  const r = await run(
    'insert into org_units(parent_id,path,name,type,code,sort,level,created_at) values(?,?,?,?,?,?,?,?)',
    root.id, '/', TRIAL_ROOT_NAME, 'company', 'TRIAL', 999, Number(root.level || 1) + 1, now
  );
  const id = idOf(r);
  await run('update org_units set path=? where id=?', `${root.path}${id}/`, id);
  return await one('select * from org_units where id = ?', id);
}

/* ==================== 开通 ==================== */

function normalize(input) {
  const email = String(input.email || '').trim().toLowerCase();
  const name = String(input.name || '试用用户').trim().slice(0, 20) || '试用用户';
  const company = String(input.company || '试用企业').trim().slice(0, 40) || '试用企业';
  const days = Math.min(90, Math.max(1, Number(input.days || TRIAL_DAYS)));
  const source = String(input.source || 'website').slice(0, 40);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error('邮箱格式不正确');
  return { email, name, company, days, source };
}

/**
 * 开通一个试用账号。
 * @returns {Promise<{accountId:number,userId:number,orgId:number,username:string,password:string,expiresAt:string,url:string,loginUrl:string}>}
 */
export async function createTrialAccount(input) {
  const v = normalize(input);
  const parent = await ensureTrialRoot();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + v.days * 86400_000).toISOString();
  const nowStr = now.toISOString();
  const password = genPassword();

  return await tx(async () => {
    // 1. 独立公司组织
    const orgRow = await run(
      'insert into org_units(parent_id,path,name,type,code,sort,level,created_at) values(?,?,?,?,?,?,?,?)',
      parent.id, '/', v.company, 'company', `TRIAL-${Date.now().toString(36).toUpperCase()}`, 0,
      Number(parent.level || 1) + 1, nowStr
    );
    const orgId = idOf(orgRow);
    await run('update org_units set path=? where id=?', `${parent.path}${orgId}/`, orgId);

    // 2. 账号（用户名冲突就重试）
    let username = '';
    let userId = 0;
    for (let attempt = 0; attempt < 6 && !userId; attempt++) {
      const candidate = genUsername();
      const dup = await one('select 1 from users where username = ?', candidate);
      if (dup) continue;
      const uRow = await run(
        `insert into users(username,name,password,email,phone,org_id,title,status,created_at)
         values(?,?,?,?,?,?,?,?,?)`,
        candidate, v.name, hashPassword(password), v.email, null, orgId, '试用账号', 'active', nowStr
      );
      userId = idOf(uRow);
      username = candidate;
    }
    if (!userId) throw new Error('账号生成失败，请重试');

    await run('insert into user_roles(user_id,role) values(?,?)', userId, 'trial');

    // 3. 预置产品（code 全局唯一，加组织后缀）
    for (const p of TRIAL_PRODUCTS) {
      await run(
        `insert into products(code,name,category,spec,unit,list_price,cost,min_price,status,remark,org_id,created_by,created_at,updated_at)
         values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        `${p.code}-${orgId}`, p.name, p.category, null, p.unit, p.price, p.cost, null, 'active', '试用账号预置', orgId, userId, nowStr, nowStr
      );
    }

    // 4. 示例业务数据（客户/线索/商机/报价），让登录第一眼就有内容
    let seeded = null;
    if (input.sample !== false) {
      try {
        seeded = await seedSampleData(orgId, userId, nowStr);
      } catch (e) {
        // 示例数据只是降低上手成本，失败不该挡住开通
        seeded = { error: e.message.slice(0, 120) };
      }
    }

    // 5. 开通记录
    const accRow = await run(
      `insert into trial_accounts(user_id,org_id,username,email,name,company,source,days,expires_at,status,created_at)
       values(?,?,?,?,?,?,?,?,?,?,?)`,
      userId, orgId, username, v.email, v.name, v.company, v.source, v.days, expiresAt, 'active', nowStr
    );

    await run(
      `insert into audit_logs(user_id,user_name,action,target_type,target_id,detail,ip,created_at)
       values(?,?,?,?,?,?,?,?)`,
      userId, v.name, 'trial.create', 'user', userId,
      `开通试用账号 ${username}（${v.company}，${v.days} 天）`, '', nowStr
    );

    return {
      accountId: idOf(accRow),
      userId,
      orgId,
      username,
      password,
      expiresAt,
      days: v.days,
      sample: seeded,
      url: TRIAL_URL,
      loginUrl: `${TRIAL_URL}/login.html`
    };
  });
}

/* ==================== 冻结 ==================== */

/**
 * 冻结一个到期的试用账号：人是登不上了，但组织、客户、报价、合同全都留着。
 *
 * 只改两处：users.status = 'frozen'（登录闸门认这个值）、trial_accounts.status = 'frozen'。
 * 不动任何业务数据——这正是它和 purge 的根本区别。
 *
 * 为什么不删会话也够：frozen 用户下次带旧 Cookie 进来时，dispatch 会先查用户状态，
 * 非 active 直接拒绝。这里顺手删掉更干净，省得留一堆无效 token。
 */
export async function freezeTrialAccount(accountId, reason = '试用到期') {
  const acc = await one('select * from trial_accounts where id = ?', accountId);
  if (!acc) throw new Error('试用记录不存在');
  if (acc.status === 'frozen') return { accountId, already: true, frozen: true, note: '已冻结' };
  if (acc.status === 'purged') return { accountId, already: true, frozen: false, note: '已回收' };

  const now = nowIso();
  const userId = Number(acc.user_id || 0);

  if (userId) {
    await run("update users set status = 'frozen' where id = ?", userId);
    await run('delete from sessions where user_id = ?', userId);
  }
  await run(
    "update trial_accounts set status = 'frozen', frozen_at = ? where id = ?",
    now, accountId
  );

  try {
    await run(
      `insert into audit_logs(user_id,user_name,action,target_type,target_id,detail,ip,created_at)
       values(?,?,?,?,?,?,?,?)`,
      null, '系统', 'trial.freeze', 'user', userId,
      `冻结试用账号 ${acc.username || userId}：${reason}，数据保留 ${TRIAL_RETAIN_DAYS} 天`,
      '', now
    );
  } catch { /* 审计失败不影响冻结 */ }

  return { accountId, frozen: true, retainDays: TRIAL_RETAIN_DAYS };
}

/** 冻结满保留期、可以真删的账号 */
export async function listPurgeable(limit = 50) {
  const cut = new Date(Date.now() - TRIAL_RETAIN_DAYS * 86400_000).toISOString();
  return await all(
    "select * from trial_accounts where status = 'frozen' and frozen_at is not null and frozen_at < ? order by frozen_at limit " + Number(limit),
    cut
  );
}

/* ==================== 回收 ==================== */

/**
 * 清空一个试用组织下的业务数据。逐表容错：某张表结构变了也不至于整单失败，
 * 失败项会记进 note，最后由"删不掉就禁用"兜底。
 */
async function clearOrgData(orgId, userId, note) {
  const q = async (sql, ...params) => {
    try {
      await run(sql, ...params);
    } catch (e) {
      note.push(e.message.slice(0, 120));
    }
  };

  await q('delete from payment_allocations where payment_id in (select id from payments where contract_id in (select id from contracts where org_id = ?))', orgId);
  await q('delete from payments where contract_id in (select id from contracts where org_id = ?)', orgId);
  await q('delete from invoices where contract_id in (select id from contracts where org_id = ?)', orgId);
  await q('delete from payment_plans where contract_id in (select id from contracts where org_id = ?)', orgId);

  await q('delete from approval_steps where approval_id in (select id from approvals where applicant_id = ?)', userId);
  await q('delete from approvals where applicant_id = ?', userId);

  await q('delete from quotation_items where quotation_id in (select id from quotations where org_id = ?)', orgId);
  await q('delete from quote_sends where quotation_id in (select id from quotations where org_id = ?)', orgId);
  await q('delete from attachments where uploaded_by = ?', userId);

  await q('delete from contracts where org_id = ?', orgId);
  await q('delete from quotations where org_id = ?', orgId);

  await q(
    `delete from activities where user_id = ?
       or (target_type = 'lead' and target_id in (select id from leads where org_id = ?))
       or (target_type = 'account' and target_id in (select id from accounts where org_id = ?))
       or (target_type = 'opportunity' and target_id in (select id from opportunities where org_id = ?))`,
    userId, orgId, orgId, orgId
  );

  await q('delete from opportunities where org_id = ?', orgId);
  await q('delete from leads where org_id = ?', orgId);
  await q('delete from contacts where account_id in (select id from accounts where org_id = ?)', orgId);
  await q('delete from accounts where org_id = ?', orgId);

  await q('delete from targets where org_id = ? or user_id = ?', orgId, userId);
  await q('delete from handovers where user_id = ? or to_user_id = ?', userId, userId);
  await q('delete from products where org_id = ?', orgId);
}

/** 删用户前把可空引用摘干净（只处理确实存在的列，不存在的列会被 q 忽略） */
async function detachRefs(userId, note) {
  const cols = [
    ['accounts', 'owner_id'],
    ['leads', 'owner_id'],
    ['opportunities', 'owner_id'],
    ['contracts', 'owner_id'],
    ['activities', 'user_id'],
    ['approval_steps', 'approver_id'],
    ['attachments', 'uploaded_by'],
    ['quote_sends', 'sent_by'],
    ['products', 'created_by'],
    ['api_clients', 'owner_id'],
    ['api_clients', 'created_by']
  ];
  for (const [t, c] of cols) {
    try {
      await run(`update ${t} set ${c} = null where ${c} = ?`, userId);
    } catch (e) {
      note.push(`${t}.${c}: ${e.message.slice(0, 60)}`);
    }
  }
}

/**
 * 回收一个试用账号：
 *   1. 清空该组织的业务数据
 *   2. 尝试物理删除用户（成功即"真的没了"）
 *   3. 外键挡着就降级为"禁用 + 匿名化"，效果同样是无法登录
 */
export async function purgeTrialAccount(accountId, reason = '试用到期') {
  const acc = await one('select * from trial_accounts where id = ?', accountId);
  if (!acc) throw new Error('试用记录不存在');
  if (acc.status === 'purged') {
    return { accountId, already: true, deleted: false, disabled: false, note: '已回收' };
  }

  const note = [];
  const userId = Number(acc.user_id || 0);
  const orgId = Number(acc.org_id || 0);
  const now = nowIso();
  let deleted = false;
  let disabled = false;

  if (orgId) await clearOrgData(orgId, userId, note);
  if (userId) {
    await detachRefs(userId, note);
    try {
      await run('delete from user_roles where user_id = ?', userId);
      await run('delete from sessions where user_id = ?', userId);
      await run('delete from users where id = ?', userId);
      deleted = true;
    } catch (e) {
      note.push(`delete user: ${e.message.slice(0, 120)}`);
      try {
        await run(
          `update users set status = 'disabled', username = ?, email = null, name = '已过期试用账号',
             left_at = ?, left_reason = ? where id = ?`,
          `expired_${userId}_${Date.now().toString(36)}`, now, reason, userId
        );
        await run('delete from sessions where user_id = ?', userId);
        disabled = true;
      } catch (e2) {
        note.push(`disable user: ${e2.message.slice(0, 120)}`);
      }
    }
  }

  if (orgId && deleted) {
    try {
      const child = await one('select count(*) c from org_units where parent_id = ?', orgId);
      if (Number((child && child.c) || 0) === 0) {
        await run('delete from org_units where id = ?', orgId);
      }
    } catch (e) {
      note.push(`org: ${e.message.slice(0, 80)}`);
    }
  }

  await run(
    "update trial_accounts set status = 'purged', purged_at = ?, purge_note = ? where id = ?",
    now, note.join(' | ').slice(0, 500) || (deleted ? '已物理删除' : '已禁用'), accountId
  );

  try {
    await run(
      `insert into audit_logs(user_id,user_name,action,target_type,target_id,detail,ip,created_at)
       values(?,?,?,?,?,?,?,?)`,
      null, '系统', 'trial.purge', 'user', userId,
      `回收试用账号 ${acc.username || userId}：${reason}${deleted ? '（已删除）' : disabled ? '（已禁用）' : ''}`,
      '', now
    );
  } catch { /* 审计失败不影响回收 */ }

  return { accountId, deleted, disabled, note: note.join(' | ').slice(0, 300) };
}

/* ==================== 查询与兜底清理 ==================== */

export async function getTrialByUser(userId) {
  return await one('select * from trial_accounts where user_id = ? order by id desc limit 1', userId);
}

export async function findTrial(accountId) {
  return await one('select * from trial_accounts where id = ?', accountId);
}

/**
 * 兜底推进（官网挂了也能靠这里跑）：两步，顺序不能反。
 *   1. active 且已过期 → 冻结（只停登录，数据留着）
 *   2. frozen 且超过保留期 → 才真正回收
 */
export async function sweepExpired(limit = 50) {
  const done = [];

  const expiring = await all(
    "select * from trial_accounts where status = 'active' and expires_at < ? order by expires_at limit " + Number(limit),
    nowIso()
  );
  for (const r of expiring) {
    try {
      const out = await freezeTrialAccount(r.id, '试用到期（定时冻结）');
      done.push({ id: r.id, username: r.username, action: 'freeze', ...out });
    } catch (e) {
      done.push({ id: r.id, username: r.username, action: 'freeze', error: e.message });
    }
  }

  const stale = await listPurgeable(limit);
  for (const r of stale) {
    try {
      const out = await purgeTrialAccount(r.id, `冻结满 ${TRIAL_RETAIN_DAYS} 天（定时回收）`);
      done.push({ id: r.id, username: r.username, action: 'purge', ...out });
    } catch (e) {
      done.push({ id: r.id, username: r.username, action: 'purge', error: e.message });
    }
  }

  return done;
}

/** 每小时扫一次；启动 20 秒后先跑一遍 */
export function startTrialJanitor(intervalMs = 3600_000) {
  const tick = async () => {
    try {
      const done = await sweepExpired();
      const f = done.filter((d) => d.action === 'freeze' && !d.error).length;
      const p = done.filter((d) => d.action === 'purge' && !d.error).length;
      if (f || p) {
        console.log(`[trial] 冻结 ${f} 个到期账号，回收 ${p} 个超保留期账号`);
      }
    } catch (e) {
      console.error('[trial] 清理失败：', e.message);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 20_000).unref?.();
  return timer;
}
