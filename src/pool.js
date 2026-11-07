import { all, one, run, nowIso } from './db.js';
import { bad, denied, notFound } from './http.js';
import { getSetting, getSettingNum } from './settings.js';
import { canModule, canEditRecord } from './auth.js';

/**
 * 线索公海核心模块（一期，docs/20 第 3 节 / 第 10.1 节）
 *
 * 三条铁律：
 *   1. 池 = leads.owner_id IS NULL，不建 pool 主表；池状态与业务状态正交。
 *   2. 领取 / 分配 / 回收一律用「条件更新 + 受影响行数」判并发，先查后写不算数。
 *   3. 所有流转写 pool_events 留痕；无效 / 已转化线索永不回池。
 *
 * 与 scopeFilter 的关系：scopeFilter 对 self 角色返回 owner_id = 自己，
 * 会恒排除 owner_id IS NULL 的池线索，因此这里必须独立实现 poolWhere()。
 */

/** 计入「有效跟进」的活动类型：note 只算触达，不续跟进时钟 */
export const VALID_FOLLOWUPS = ['call', 'visit', 'email', 'meeting', 'wechat'];
const MANAGE_ROLES = ['admin', 'gm', 'director', 'manager'];
const TERMINAL_STATUS = ['converted', 'invalid'];

/* ============================ 可见范围与规则 ============================ */

/**
 * 公海可见范围（不能复用 scopeFilter）。
 * - all：全集团
 * - org / self：一律按 org_units.path 前缀看本组织子树
 * self 角色看得到本组织池，但看不到同组织他人私有线索（私有线索走 /api/leads 的 scopeFilter）。
 */
export function poolWhere(user, alias = 'l') {
  if (user.scope === 'all') return { sql: '1=1', params: [] };
  return {
    sql: `${alias}.org_id IN (SELECT id FROM org_units WHERE path LIKE ?)`,
    params: [`${String(user.orgPath || '')}%`]
  };
}

/** 读当前生效规则快照（全部来自 settings，改完不用重启） */
export async function getRules() {
  return {
    enabled: String(await getSetting('pool.enabled')) === '1',
    autoReclaim: String(await getSetting('pool.auto_reclaim')) === '1',
    firstTouchHours: await getSettingNum('pool.first_touch_hours'),
    firstTouchReclaimHours: await getSettingNum('pool.first_touch_reclaim_hours'),
    reclaimDays: await getSettingNum('pool.reclaim_days'),
    protectDays: await getSettingNum('pool.protect_days'),
    holdLimit: await getSettingNum('pool.hold_limit'),
    weeklyLimit: await getSettingNum('pool.claim_weekly_limit'),
    notifyBeforeDays: await getSettingNum('pool.notify_before_days')
  };
}

export function assertPoolEnabled(rules) {
  if (!rules.enabled) throw bad('线索公海已停用，请在「系统设置 → 公共池规则」里开启', { code: 'POOL_DISABLED' });
}

/** 分配 / 强制回收：仅经理及以上；trial 与 self 角色不可 */
export function assertPoolManager(user) {
  if (!canModule(user, 'lead') || !MANAGE_ROLES.includes(user.role)) {
    throw denied('只有经理及以上可以分配或强制回收线索');
  }
}

/** 启动横幅用的规则摘要 */
export async function poolBanner() {
  const r = await getRules();
  if (!r.enabled) return '线索公海：已停用';
  return `线索公海：已启用（首触 ${r.firstTouchReclaimHours}h 回池 / 无跟进 ${r.reclaimDays} 天回池 / 保护 ${r.protectDays} 天 / 在库 ${r.holdLimit} / 每周 ${r.weeklyLimit}）`;
}

/* ============================ 基础读写 ============================ */

export async function poolEvent({ leadId, orgId, actorId = null, action, reason = null, fromOwner = null, toOwner = null }) {
  await run(`insert into pool_events(lead_id,org_id,actor_id,action,reason,from_owner,to_owner,created_at)
     values(?,?,?,?,?,?,?,?)`, leadId, orgId, actorId, action, reason, fromOwner, toOwner, nowIso());
}

async function addNote(leadId, userId, content) {
  await run(`insert into activities(target_type,target_id,type,content,result,user_id,created_at)
     values('lead',?,'note',?,?,?,?)`, leadId, content, null, userId, nowIso());
}

/** 本周（UTC 周一 00:00）起点，created_at 是 ISO 文本，可直接字符串比较 */
export function weekStartIso(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  return d.toISOString();
}

export async function weeklyClaimed(userId) {
  const r = await one(`select count(*) c from pool_events
     where actor_id = ? and action = 'claim' and created_at >= ?`, userId, weekStartIso());
  return Number(r?.c || 0);
}

/** 在库 = 自己名下且未转化、未判无效的线索 */
export async function heldCount(userId) {
  const r = await one(`select count(*) c from leads
     where owner_id = ? and status not in ('converted','invalid')`, userId);
  return Number(r?.c || 0);
}

/** 最近一次「有效跟进」时间；note 不计 */
export async function lastValidFollowAt(leadId) {
  const r = await one(`select max(created_at) t from activities
     where target_type = 'lead' and target_id = ? and type in ('call','visit','email','meeting','wechat')`, leadId);
  return r?.t || null;
}

async function assertClaimer(user) {
  if (!canModule(user, 'lead')) throw denied('无权访问线索');
  const u = await one('select status from users where id = ?', user.id);
  if (!u || u.status !== 'active') {
    throw bad('账号已冻结或停用，恢复后才能领取线索', { code: 'POOL_FROZEN' });
  }
}

/** 取一条「在池中且可见」的线索，组织隔离在这里兜死 */
async function loadPoolLead(user, id, { inPool = true } = {}) {
  const w = poolWhere(user, 'l');
  const ownerCond = inPool ? 'l.owner_id is null' : 'l.owner_id is not null';
  const l = await one(`select l.*, o.name as org_name from leads l
     left join org_units o on o.id = l.org_id
     where l.id = ? and ${ownerCond} and (${w.sql})`, Number(id) || 0, ...w.params);
  if (!l) throw bad('线索不在可见的公共池中', { code: 'POOL_NOT_VISIBLE' });
  return l;
}

/**
 * 回池统一出口：清 owner_id、写池字段、写审计、写一条站内留痕。
 * 用 owner_id is not null 做条件更新，避免并发下重复回池。
 */
async function returnToPool(l, actor, action, reason) {
  const now = nowIso();
  const r = await run(`update leads set owner_id = null, pool_at = ?, pool_reason = ?,
       pool_count = coalesce(pool_count, 0) + 1, updated_at = ?
     where id = ? and owner_id is not null`, now, reason || action, now, l.id);
  if (!r.changes) throw bad('线索状态已变化，请刷新后重试', { code: 'POOL_ALREADY_CLAIMED' });
  await poolEvent({
    leadId: l.id, orgId: l.org_id, actorId: actor?.id || null,
    action, reason: reason || action, fromOwner: l.owner_id, toOwner: null
  });
  await addNote(l.id, actor?.id || null, `【公海】线索已放回公共池（${reason || action}）`);
  return { ok: true, leadId: l.id };
}

/* ============================ 领取 / 放回 / 分配 / 回收 ============================ */

/** 领取：原子条件更新，两个并发请求恰好一个成功 */
export async function claimLead(user, id) {
  const rules = await getRules();
  assertPoolEnabled(rules);
  await assertClaimer(user);
  const l = await loadPoolLead(user, id, { inPool: true });
  if (TERMINAL_STATUS.includes(l.status)) {
    throw bad('该线索已终止流转，不能领取', { code: 'POOL_NOT_VISIBLE' });
  }
  const held = await heldCount(user.id);
  if (held >= rules.holdLimit) {
    throw bad(`在库线索已达上限 ${rules.holdLimit} 条，请先跟进或放回再领取`, { code: 'POOL_HOLD_LIMIT' });
  }
  const claimed = await weeklyClaimed(user.id);
  if (claimed >= rules.weeklyLimit) {
    throw bad(`本周已领取 ${claimed} 条，上限 ${rules.weeklyLimit} 条，下周再来`, { code: 'POOL_WEEKLY_LIMIT' });
  }
  const now = nowIso();
  const r = await run(`update leads set owner_id = ?, claim_at = ?, updated_at = ?
     where id = ? and owner_id is null`, user.id, now, now, l.id);
  if (!r.changes) throw bad('这条线索刚被别人领走了', { code: 'POOL_ALREADY_CLAIMED' });
  await poolEvent({
    leadId: l.id, orgId: l.org_id, actorId: user.id,
    action: 'claim', fromOwner: null, toOwner: user.id
  });
  return { ok: true, leadId: l.id, myHeld: held + 1, weeklyClaimed: claimed + 1 };
}

/** 主动放回：本人，或经理及以上代本组织成员放回 */
export async function releaseLead(user, id, reason) {
  const rules = await getRules();
  assertPoolEnabled(rules);
  if (!canModule(user, 'lead')) throw denied('无权访问线索');
  const l = await one('select * from leads where id = ?', Number(id) || 0);
  if (!l) throw notFound('线索不存在');
  if (l.owner_id === null) throw bad('该线索已在公共池中', { code: 'POOL_NOT_IN_POOL' });
  const mine = Number(l.owner_id) === Number(user.id);
  const canManageOthers = MANAGE_ROLES.includes(user.role) && (await canEditRecord(user, l));
  if (!mine && !canManageOthers) {
    throw bad('只能放回自己负责的线索', { code: 'POOL_NOT_OWNER' });
  }
  if (TERMINAL_STATUS.includes(l.status)) {
    throw bad('已转化或已判无效的线索不能放回公海', { code: 'POOL_NOT_VISIBLE' });
  }
  return returnToPool(l, user, 'release', String(reason || '主动放回').slice(0, 200));
}

/** 分配：经理把池里一条线索直接挂给组织内某个在职成员 */
export async function assignLead(user, id, targetId) {
  const rules = await getRules();
  assertPoolEnabled(rules);
  assertPoolManager(user);
  const l = await loadPoolLead(user, id, { inPool: true });
  if (TERMINAL_STATUS.includes(l.status)) {
    throw bad('该线索已终止流转，不能分配', { code: 'POOL_NOT_VISIBLE' });
  }
  const target = await one(`select u.id, u.name, u.status, u.org_id, o.path
     from users u join org_units o on o.id = u.org_id where u.id = ?`, Number(targetId) || 0);
  if (!target || target.status !== 'active') {
    throw bad('目标负责人不存在或已停用', { code: 'POOL_TARGET_INVALID' });
  }
  if (user.scope !== 'all' && !String(target.path || '').startsWith(String(user.orgPath || ''))) {
    throw bad('目标负责人不在你的组织范围内', { code: 'POOL_TARGET_INVALID' });
  }
  const now = nowIso();
  const r = await run(`update leads set owner_id = ?, claim_at = ?, updated_at = ?
     where id = ? and owner_id is null`, target.id, now, now, l.id);
  if (!r.changes) throw bad('这条线索刚被别人领走了', { code: 'POOL_ALREADY_CLAIMED' });
  await poolEvent({
    leadId: l.id, orgId: l.org_id, actorId: user.id,
    action: 'assign', fromOwner: null, toOwner: target.id
  });
  return { ok: true, leadId: l.id, ownerId: target.id, ownerName: target.name };
}

/** 强制回收：经理把他人名下未终止的线索放回池 */
export async function reclaimLead(user, id, reason) {
  const rules = await getRules();
  assertPoolEnabled(rules);
  assertPoolManager(user);
  const l = await one('select * from leads where id = ?', Number(id) || 0);
  if (!l) throw notFound('线索不存在');
  if (l.owner_id === null) throw bad('该线索已在公共池中', { code: 'POOL_NOT_VISIBLE' });
  if (TERMINAL_STATUS.includes(l.status)) {
    throw bad('已转化或已判无效的线索不能回收', { code: 'POOL_NOT_VISIBLE' });
  }
  const w = poolWhere(user, 'l');
  const visible = await one(`select 1 from leads l where l.id = ? and (${w.sql})`, l.id, ...w.params);
  if (!visible) throw bad('看不到该线索，无法回收', { code: 'POOL_NOT_VISIBLE' });
  return returnToPool(l, user, 'reclaim', String(reason || '经理强制回收').slice(0, 200));
}

/* ============================ 列表 / 统计 / 审计 ============================ */

export async function listPool(user, q = {}) {
  const w = poolWhere(user, 'l');
  const where = ['l.owner_id is null', "l.status not in ('converted','invalid')", `(${w.sql})`];
  const params = [...w.params];
  if (q.source) { where.push('l.source = ?'); params.push(String(q.source)); }
  if (q.industry) { where.push('l.industry = ?'); params.push(String(q.industry)); }
  if (q.org) {
    where.push(`l.org_id IN (SELECT id FROM org_units WHERE path LIKE (SELECT path FROM org_units WHERE id = ?) || '%')`);
    params.push(Number(q.org));
  }
  if (q.q) {
    where.push('(l.name LIKE ? OR l.contact_name LIKE ? OR l.contact_phone LIKE ?)');
    const like = `%${String(q.q)}%`;
    params.push(like, like, like);
  }
  const rows = await all(`select l.*, o.name as org_name
     from leads l left join org_units o on o.id = l.org_id
     where ${where.join(' and ')}
     order by coalesce(l.pool_at, l.created_at) desc, l.id desc limit 500`, ...params);
  return rows;
}

/**
 * 双时钟判定（docs/20 第 3.2 节）。
 *
 * 两个时钟的基准刻意不同，用来同时满足「72h 无首触回池」和「note 不续时钟」：
 *  - 首触时钟看 last_activity_at（任何跟进都算触达，含 note）：72h 内完全没动 → first_touch_timeout
 *  - 跟进时钟看最近一次【有效跟进】（activities 里 call/visit/email/meeting/wechat），note 不续 → timeout
 *
 * 关于口径冲突：3.2 同时写了「72h 无首触回池」与「7 天保护期屏蔽上面两条回收」，
 * 若保护期屏蔽首触时钟，TC-06（73h 回池）永远不可能通过。因此本次执行按 TC 优先：
 * 首触时钟独立于保护期，保护期只屏蔽 30 天跟进时钟与提醒。执行期口径已在此注明，
 * 如需改回「保护期也屏蔽首触」，追加 v4 变更记录。
 */
export function evaluateLead(l, lastValid, rules, now = Date.now()) {
  const claimMs = l.claim_at ? Date.parse(l.claim_at) : NaN;
  if (!Number.isFinite(claimMs)) return { action: 'none' };
  const hoursSinceClaim = (now - claimMs) / 3600000;
  const touched = Boolean(l.last_activity_at);

  // 1) 首触时钟优先：完全没有任何跟进（含 note）且超过 72h → 快速回池
  if (!touched && hoursSinceClaim >= rules.firstTouchReclaimHours) {
    return { action: 'reclaim', reason: 'first_touch_timeout' };
  }
  // 2) 保护期：只屏蔽跟进时钟与提醒
  if (hoursSinceClaim < rules.protectDays * 24) return { action: 'none' };
  // 3) 24h 无跟进：只提醒，不回收
  if (!touched && hoursSinceClaim >= rules.firstTouchHours) {
    return { action: 'remind', reason: 'first_touch' };
  }
  // 4) 跟进时钟：note 不续，基准是最近一次有效跟进，没有则退回领取时间
  const baseMs = lastValid ? Date.parse(lastValid) : claimMs;
  const daysSince = (now - baseMs) / 86400000;
  if (daysSince >= rules.reclaimDays) return { action: 'reclaim', reason: 'timeout' };
  if (rules.reclaimDays - daysSince <= rules.notifyBeforeDays) {
    return { action: 'remind', reason: 'reclaim_soon' };
  }
  return { action: 'none' };
}

export async function poolStats(user) {
  const rules = await getRules();
  const w = poolWhere(user, 'l');
  const poolTotal = Number((await one(`select count(*) c from leads l
     where l.owner_id is null and l.status not in ('converted','invalid') and (${w.sql})`, ...w.params))?.c || 0);
  const myHeld = await heldCount(user.id);
  const weekly = await weeklyClaimed(user.id);
  const mine = await all(`select id, claim_at, last_activity_at from leads
     where owner_id = ? and status not in ('converted','invalid')`, user.id);
  let reclaimSoon = 0;
  for (const l of mine) {
    const verdict = evaluateLead(l, await lastValidFollowAt(l.id), rules);
    if (verdict.action !== 'none') reclaimSoon++;
  }
  return {
    poolTotal, myHeld, weeklyClaimed: weekly, reclaimSoon,
    holdLimit: rules.holdLimit, weeklyLimit: rules.weeklyLimit,
    enabled: rules.enabled, rules
  };
}

export async function poolEvents(user, { leadId, actorId, limit = 200 } = {}) {
  const w = poolWhere(user, 'e');
  const where = [`(${w.sql})`];
  const params = [...w.params];
  if (leadId) { where.push('e.lead_id = ?'); params.push(Number(leadId)); }
  if (actorId) { where.push('e.actor_id = ?'); params.push(Number(actorId)); }
  const rows = await all(`select e.*, l.name as lead_name, u.name as actor_name
     from pool_events e
     left join leads l on l.id = e.lead_id
     left join users u on u.id = e.actor_id
     where ${where.join(' and ')} order by e.created_at desc, e.id desc limit ?`, ...params, Math.min(500, Math.max(1, Number(limit) || 200)));
  return rows;
}

/* ============================ 定时回收 ============================ */

/** 提醒幂等：同一条线索 20 小时内不重复写站内提醒 */
async function alreadyReminded(leadId, now) {
  const r = await one(`select max(created_at) t from activities
     where target_type = 'lead' and target_id = ? and type = 'note' and content like '【公海提醒】%'`, leadId);
  if (!r?.t) return false;
  return now - Date.parse(r.t) < 20 * 3600000;
}

export async function sweepPool() {
  const out = { scanned: 0, reclaimed: 0, reminded: 0, errors: [] };
  const rules = await getRules();
  if (!rules.enabled || !rules.autoReclaim) return out;
  // 只扫「经过领取/分配」的线索（claim_at 有值）。历史线索没有 claim_at，
  // 若不排除会在第一次启动时被判成「从未首触」而整批误回池。
  const rows = await all(`select id, name, org_id, owner_id, status, claim_at, last_activity_at
     from leads where owner_id is not null and claim_at is not null
       and status not in ('converted','invalid')`);
  const now = Date.now();
  for (const l of rows) {
    out.scanned++;
    try {
      const verdict = evaluateLead(l, await lastValidFollowAt(l.id), rules, now);
      if (verdict.action === 'reclaim') {
        await returnToPool(l, null, 'auto_reclaim', verdict.reason);
        out.reclaimed++;
      } else if (verdict.action === 'remind' && !(await alreadyReminded(l.id, now))) {
        const text = verdict.reason === 'first_touch'
          ? '【公海提醒】领取后尚未首次触达，超时将自动放回公共池，请及时跟进。'
          : '【公海提醒】长期没有有效跟进，即将自动放回公共池，请及时跟进。';
        await addNote(l.id, l.owner_id, text);
        out.reminded++;
      }
    } catch (e) {
      out.errors.push({ leadId: l.id, message: String(e.message || e).slice(0, 120) });
    }
  }
  return out;
}

/** 每小时一次；启动 20 秒后先跑一遍（与 startTrialJanitor 并列注册） */
export function startPoolJanitor(intervalMs = 3600_000) {
  const tick = async () => {
    try {
      const r = await sweepPool();
      if (r.reclaimed || r.reminded) {
        console.log(`[pool] 扫描 ${r.scanned} 条，回池 ${r.reclaimed} 条，提醒 ${r.reminded} 条`);
      }
      if (r.errors.length) console.warn(`[pool] ${r.errors.length} 条处理失败：`, r.errors[0]);
    } catch (e) {
      console.error('[pool] 回收失败：', e.message);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 20_000).unref?.();
  return timer;
}

/* ============================ 外部线索 API 入池 ============================ */

/**
 * 外部 API 未指定负责人且未配默认负责人时的落点。
 * org_id 取接入方所属组织；没配 org_id 的接入方退回根组织，保证 leads.org_id NOT NULL。
 */
export async function apiInOrg(client) {
  let orgId = Number(client?.org_id || 0);
  if (!orgId) {
    const root = await one('select id from org_units where parent_id is null order by id limit 1');
    orgId = root ? Number(root.id) : 0;
  }
  if (!orgId) throw bad('系统尚未初始化，外部线索无法入池', { code: 'POOL_NOT_VISIBLE' });
  return orgId;
}

export async function recordApiIn(leadId, orgId, client) {
  await poolEvent({
    leadId, orgId, actorId: null, action: 'api_in', reason: 'api',
    fromOwner: null, toOwner: null
  });
  void client;
}
