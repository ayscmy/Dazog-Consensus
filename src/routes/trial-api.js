import { timingSafeEqual } from 'node:crypto';
import { GET, POST, HttpError, bad, notFound } from '../http.js';
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
    throw new HttpError(401, '内部密钥不正确');
  }
  const ip = clientIp(ctx);
  const okIp = ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || EXTRA_IPS.includes(ip);
  if (!okIp) throw new HttpError(403, `来源 IP 不可信：${ip}`);
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
