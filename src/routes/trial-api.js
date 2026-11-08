import { timingSafeEqual } from 'node:crypto';
import { GET, POST, HttpError, bad, notFound } from '../http.js';
import { one, run, nowIso, idOf } from '../db.js';
import {
  createTrialAccount, freezeTrialAccount, purgeTrialAccount, findTrial,
  sweepExpired, TRIAL_DAYS, TRIAL_RETAIN_DAYS
} from '../trial.js';

/**
 * 内部接口：只给官网（同一台机器上的 8099）调用，用来开通与回收试用账号。
 *
 * 两道门：
 *   1. X-Internal-Key 与 .env 里的 TRIAL_API_KEY 对得上（定长比较，防时序侧信道）
 *   2. 来源 IP 必须是本机回环，外网直接 403
 *
 * 不挂登录态、也不走 api_clients —— 它只服务自家官网，不需要对外发密钥。
 */

const KEY = process.env.TRIAL_API_KEY || '';
const EXTRA_IPS = (process.env.TRIAL_ALLOW_IPS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

function clientIp(ctx) {
  return String(ctx.ip || '').replace(/^::ffff:/, '');
}

function guard(ctx) {
  if (!KEY) throw new HttpError(503, '未配置 TRIAL_API_KEY，内部接口不可用');
  const given = String(ctx.req.headers['x-internal-key'] || '');
  const a = Buffer.from(given);
  const b = Buffer.from(KEY);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    // 设计 docs/20 第 10 节契约只定义一个鉴权失败码，IP 不可信也归到此码
    throw new HttpError(401, '内部密钥不正确', { code: 'INTERNAL_KEY_INVALID' });
  }
  const ip = clientIp(ctx);
  const okIp = ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || EXTRA_IPS.includes(ip);
  if (!okIp) throw new HttpError(403, `来源 IP 不可信：${ip}`, { code: 'INTERNAL_KEY_INVALID' });
}

/** 开通 */
POST('/api/internal/trial', async (ctx) => {
  guard(ctx);
  const b = ctx.body || {};
  if (!b.email) throw bad('缺少 email');
  try {
    const out = await createTrialAccount({
      email: b.email,
      name: b.name,
      company: b.company,
      days: b.days,
      source: b.source
    });
    return { ok: true, trial: out };
  } catch (e) {
    throw new HttpError(400, e.message);
  }
}, { auth: false });

/** 立刻扫一遍过期账号（官网定时器也可以主动踢一脚） */
POST('/api/internal/trial/sweep', async (ctx) => {
  guard(ctx);
  const done = await sweepExpired(Number((ctx.body && ctx.body.limit) || 50));
  return { ok: true, count: done.length, items: done };
}, { auth: false });

/** 冻结（到期默认动作）：停登录、留数据。幂等 */
POST('/api/internal/trial/:id/freeze', async (ctx) => {
  guard(ctx);
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) throw bad('试用记录 ID 不正确');
  const acc = await findTrial(id);
  if (!acc) throw notFound('试用记录不存在');
  const out = await freezeTrialAccount(id, String((ctx.body && ctx.body.reason) || '试用到期'));
  return { ok: true, ...out, status: 'frozen', retainDays: TRIAL_RETAIN_DAYS };
}, { auth: false });

/** 回收（幂等：已回收的再调一次也返回 200） */
POST('/api/internal/trial/:id/purge', async (ctx) => {
  guard(ctx);
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) throw bad('试用记录 ID 不正确');
  const acc = await findTrial(id);
  if (!acc) throw notFound('试用记录不存在');
  const out = await purgeTrialAccount(id, String((ctx.body && ctx.body.reason) || '官网申请回收'));
  return { ok: true, ...out, status: 'purged' };
}, { auth: false });

/**
 * 官网商业线索池 · 通道 1 投递（docs/20 第 7 节通道 1 / 官网 docs/11 第 7 节）
 *
 * 官网领取成功后调用，把一条真实商业线索写成该试用组织的「私有线索」。
 * 与对外线索 API 的区别：
 *   - 走 X-Internal-Key + 回环 IP，不挂登录态、不走 api_clients
 *   - owner_id = 试用用户，source 固定 '官网公共池'
 *   - 不填 pool_at / pool_reason：这是私有线索，不进 CRM 公海
 *   - external_id 由服务端按 'pool:<claim_id>' 拼，不信任官网传值
 *
 * 本路由是 5 段，与 4 段的 GET /api/internal/trial/:id 互不干扰；
 * 与同段数的 :id/freeze、:id/purge 靠末段字面量区分，match() 逐段精确比较。
 */
POST('/api/internal/trial/:id/pool-lead', async (ctx) => {
  guard(ctx);
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) throw bad('试用记录 ID 不正确');

  const b = ctx.body || {};
  const claimId = Number(b.claim_id);
  if (!Number.isInteger(claimId) || claimId <= 0) throw bad('缺少或非法的 claim_id');

  const acc = await findTrial(id);
  if (!acc) throw new HttpError(404, '试用记录不存在', { code: 'TRIAL_NOT_FOUND' });
  if (acc.status !== 'active') {
    // frozen / revoked / purged 一律拒绝，官网据此提示「账号已冻结，恢复后继续」
    throw new HttpError(409, '试用账号已冻结或回收，恢复后可继续领取', { code: 'TRIAL_FROZEN' });
  }
  if (!acc.org_id || !acc.user_id) throw bad('试用账号尚未完成初始化');

  // 幂等键由服务端决定：官网 body 里的 external_id 一律忽略，避免污染命名空间
  const externalId = `pool:${claimId}`;
  const dup = await one('select id from leads where external_id = ?', externalId);
  if (dup) return { ok: true, leadId: dup.id, duplicated: true };

  const now = nowIso();
  // CRM leads 没有 company 列：公司名并入线索名称，不丢信息
  const name = [String(b.title || '').trim(), String(b.company || '').trim()]
    .filter(Boolean).join(' · ') || `官网线索 ${claimId}`;
  try {
    const r = await run(
      `insert into leads(name, external_id, contact_name, contact_phone, source,
          industry, region, demand, budget, status, score,
          owner_id, org_id, created_by, created_at, updated_at)
       values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      name, externalId,
      String(b.contact || '').trim() || null,
      String(b.contactPhone || '').trim() || null,
      '官网公共池',
      String(b.industry || '').trim() || null,
      String(b.region || '').trim() || null,
      String(b.demand || '').trim() || null,
      String(b.budget || '').trim() || null,
      'new', 50,
      acc.user_id, acc.org_id, acc.user_id, now, now
    );
    return { ok: true, leadId: idOf(r), duplicated: false };
  } catch (e) {
    // 并发重放：uq_lead_external 拦下第二个插入，回查一次仍按幂等成功返回
    if (/unique|duplicate|uq_lead_external/i.test(String(e?.message || ''))) {
      const again = await one('select id from leads where external_id = ?', externalId);
      if (again) return { ok: true, leadId: again.id, duplicated: true };
    }
    throw e;
  }
}, { auth: false });

/** 健康检查：官网启动时可用来确认链路通不通（必须排在 :id 之前，否则会被当成 id） */
GET('/api/internal/trial/ping', async (ctx) => {
  guard(ctx);
  return { ok: true, days: TRIAL_DAYS, retainDays: TRIAL_RETAIN_DAYS, at: new Date().toISOString() };
}, { auth: false });

/** 查询状态 */
GET('/api/internal/trial/:id', async (ctx) => {
  guard(ctx);
  const acc = await findTrial(Number(ctx.params.id));
  if (!acc) throw notFound('试用记录不存在');
  return {
    ok: true,
    trial: {
      id: acc.id,
      userId: acc.user_id,
      orgId: acc.org_id,
      username: acc.username,
      email: acc.email,
      status: acc.status,
      days: acc.days,
      expiresAt: acc.expires_at,
      createdAt: acc.created_at,
      frozenAt: acc.frozen_at || null,
      purgedAt: acc.purged_at
    }
  };
}, { auth: false });
