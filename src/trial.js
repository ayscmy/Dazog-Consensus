import { randomInt } from 'node:crypto';
import { all, one, run, tx, nowIso, idOf } from './db.js';
import { hashPassword } from './password.js';

/**
 * 试用账号：官网注册会员后自动开通，7 天到期自动回收。
 *
 * 形态：每个试用会员独占一个公司级组织（挂在「试用中心」下），角色 trial
 * （scope=org，只能看自己这棵子树），互不可见、互不干扰。
 *
 * 开通与回收由官网通过 /api/internal/trial* 调用；本文件另带一个每小时跑一次的
 * 兜底清理，即使官网挂了也不会留下永不过期的账号。
 */

export const TRIAL_DAYS = Math.max(1, Number(process.env.TRIAL_DAYS || 7));
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

    // 4. 开通记录
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
      url: TRIAL_URL,
      loginUrl: `${TRIAL_URL}/login.html`
    };
  });
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

/** 回收所有已过期的试用账号（官网挂了也能靠这里兜底） */
export async function sweepExpired(limit = 50) {
  const rows = await all(
    "select * from trial_accounts where status = 'active' and expires_at < ? order by expires_at limit " + Number(limit),
    nowIso()
  );
  const done = [];
  for (const r of rows) {
    try {
      const out = await purgeTrialAccount(r.id, '试用到期（定时清理）');
      done.push({ id: r.id, username: r.username, ...out });
    } catch (e) {
      done.push({ id: r.id, username: r.username, error: e.message });
    }
  }
  return done;
}

/** 每小时扫一次；启动 20 秒后先跑一遍 */
export function startTrialJanitor(intervalMs = 3600_000) {
  const tick = async () => {
    try {
      const done = await sweepExpired();
      if (done.length) {
        console.log(`[trial] 已回收 ${done.length} 个过期试用账号：${done.map((d) => d.username || d.id).join(', ')}`);
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
