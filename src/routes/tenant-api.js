import { timingSafeEqual, randomBytes } from 'node:crypto';
import { GET, POST, HttpError, bad, notFound } from '../http.js';
import { one, all, run, nowIso, idOf } from '../db.js';

/**
 * 内部接口：官网 → CRM，开通 / 续费 / 停用 正式租户。
 *
 * 与 trial-api.js 同源的两道门：
 *   1. X-Internal-Key 与 TRIAL_API_KEY 定长比较（防时序侧信道）
 *   2. 来源 IP 必须是本机回环（或 TRIAL_ALLOW_IPS 白名单）
 *
 * 业务约定：
 *   - 试用期在共享实例里跑（trial_accounts）；付费后这里把试用组织「转正」，
 *     并写入 tenants 台账。独立实例由编排器（P0-5）按 instance_state=pending 拉起。
 *   - 金额与收款在官网侧完成；CRM 只认「已支付」这一事实，不重复计费。
 */

const KEY = process.env.TRIAL_API_KEY || '';
const EXTRA_IPS = (process.env.TRIAL_ALLOW_IPS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const PLAN_LIMITS = {
  starter: { seats: 10, lead_quota: 2000, api_quota: 0 },
  pro: { seats: 30, lead_quota: 10000, api_quota: 1 },
  enterprise: { seats: 0, lead_quota: 0, api_quota: 1 },
};

function clientIp(ctx) {
  return String(ctx.ip || '').replace(/^::ffff:/, '');
}

function guard(ctx) {
  if (!KEY) throw new HttpError(503, '未配置 TRIAL_API_KEY，内部接口不可用');
  const given = String(ctx.req.headers['x-internal-key'] || '');
  const a = Buffer.from(given);
  const b = Buffer.from(KEY);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpError(401, '内部密钥不正确', { code: 'INTERNAL_KEY_INVALID' });
  }
  const ip = clientIp(ctx);
  const okIp = ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || EXTRA_IPS.includes(ip);
  if (!okIp) throw new HttpError(403, `来源 IP 不可信：${ip}`, { code: 'INTERNAL_KEY_INVALID' });
}

function addMonths(base, months) {
  const d = new Date(base);
  d.setMonth(d.getMonth() + months);
  return d;
}

async function genCode() {
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  for (let i = 0; i < 8; i++) {
    const code = `T-${ym}-${randomBytes(2).toString('hex').toUpperCase()}`;
    const dup = await one('select 1 from tenants where code = ?', code);
    if (!dup) return code;
  }
  throw new Error('租户编号生成失败，请重试');
}

function viewOf(t) {
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    plan: t.plan,
    status: t.status,
    ownerEmail: t.owner_email,
    orgId: t.org_id,
    userId: t.user_id,
    trialId: t.trial_id,
    subdomain: t.subdomain,
    port: t.port,
    dataDir: t.data_dir,
    instanceState: t.instance_state,
    expiresAt: t.expires_at,
    seats: t.seats,
    leadQuota: t.lead_quota,
    apiQuota: t.api_quota,
    orderNo: t.order_no,
    createdAt: t.created_at,
  };
}

/** 开通（幂等：同订单号 / 同邮箱只建一个租户，重复调用视为续费） */
POST('/api/internal/tenant/activate', async (ctx) => {
  guard(ctx);
  const b = ctx.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  if (!email) throw bad('缺少 email');
  const plan = String(b.plan || 'starter');
  const months = Math.max(1, Number(b.periodMonths) || 12);
  const orderNo = String(b.orderNo || '') || null;
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.starter;

  // 1) 同一订单号已开通过：直接返回，不重复建租户
  if (orderNo) {
    const dup = await one('select * from tenants where order_no = ?', orderNo);
    if (dup) return { ok: true, tenant: viewOf(dup), duplicated: true };
  }

  const now = new Date();
  const expiresAt = addMonths(now, months).toISOString();
  const nowStr = now.toISOString();

  // 2) 同邮箱已有租户：按续费处理，延长到期日并恢复 active
  const exist = await one('select * from tenants where owner_email = ? order by id desc limit 1', email);
  if (exist) {
    const base = exist.expires_at && new Date(exist.expires_at).getTime() > Date.now()
      ? new Date(exist.expires_at)
      : now;
    const next = addMonths(base, months).toISOString();
    await run(
      "update tenants set status='active', plan=?, expires_at=?, seats=?, lead_quota=?, api_quota=?, order_no=coalesce(?, order_no), updated_at=? where id=?",
      plan, next, limits.seats, limits.lead_quota, limits.api_quota, orderNo, nowStr, exist.id
    );
    return { ok: true, tenant: viewOf(await one('select * from tenants where id = ?', exist.id)), renewed: true };
  }

  // 3) 找同邮箱试用账号：有就把它转正（解冻 + 角色升级 + 延长）
  const trial = await one(
    "select * from trial_accounts where email = ? and status in ('active','frozen') order by id desc limit 1",
    email
  );

  let orgId = null;
  let userId = null;
  let trialId = null;
  if (trial) {
    trialId = trial.id;
    orgId = trial.org_id || null;
    userId = trial.user_id || null;
    await run("update trial_accounts set status='converted', expires_at=? where id=?", expiresAt, trial.id);
    if (userId) {
      await run("update users set status='active' where id=? and status in ('frozen','active')", userId);
      // 试用角色转正为 ae；保留其它角色不动
      await run("update user_roles set role='ae' where user_id=? and role='trial'", userId);
    }
  }

  const code = await genCode();
  const name = String(b.company || b.name || trial?.company || email).slice(0, 80);
  const r = await run(
    `insert into tenants(code,name,plan,status,owner_email,org_id,user_id,trial_id,subdomain,
       instance_state,expires_at,seats,lead_quota,api_quota,order_no,created_at,updated_at)
     values(?,?,?,'active',?,?,?,?,?,'pending',?,?,?,?,?,?,?)`,
    code, name, plan, email, orgId, userId, trialId, code.toLowerCase(),
    expiresAt, limits.seats, limits.lead_quota, limits.api_quota, orderNo, nowStr, nowStr
  );

  if (userId) {
    await run(
      `insert into audit_logs(user_id,user_name,action,target_type,target_id,detail,ip,created_at)
       values(?,?,?,?,?,?,?,?)`,
      userId, trial?.name || name, 'tenant.activate', 'tenant', idOf(r),
      `开通正式租户 ${code}（${plan}，${months} 个月）`, '', nowStr
    );
  }

  return { ok: true, tenant: viewOf(await one('select * from tenants where id = ?', idOf(r))) };
}, { auth: false });

/** 续费：按 code 或 email 定位租户，延长到期日 */
POST('/api/internal/tenant/renew', async (ctx) => {
  guard(ctx);
  const b = ctx.body || {};
  const months = Math.max(1, Number(b.periodMonths) || 12);
  const t = b.code
    ? await one('select * from tenants where code = ?', String(b.code))
    : b.email
      ? await one('select * from tenants where owner_email = ? order by id desc limit 1', String(b.email).toLowerCase())
      : null;
  if (!t) throw notFound('租户不存在');
  const base = t.expires_at && new Date(t.expires_at).getTime() > Date.now()
    ? new Date(t.expires_at)
    : new Date();
  const next = addMonths(base, months).toISOString();
  await run("update tenants set status='active', expires_at=?, updated_at=? where id=?", next, nowIso(), t.id);
  return { ok: true, tenant: viewOf(await one('select * from tenants where id = ?', t.id)) };
}, { auth: false });

/** 停用：默认只改租户状态；freezeUser=true 时同时冻结登录 */
POST('/api/internal/tenant/suspend', async (ctx) => {
  guard(ctx);
  const b = ctx.body || {};
  const t = b.code
    ? await one('select * from tenants where code = ?', String(b.code))
    : b.email
      ? await one('select * from tenants where owner_email = ? order by id desc limit 1', String(b.email).toLowerCase())
      : null;
  if (!t) throw notFound('租户不存在');
  await run("update tenants set status='suspended', updated_at=? where id=?", nowIso(), t.id);
  if (b.freezeUser === true && t.user_id) {
    await run("update users set status='frozen' where id=?", t.user_id);
  }
  return { ok: true, tenant: viewOf(await one('select * from tenants where id = ?', t.id)) };
}, { auth: false });

/** 用量：给官网做计费与展示 */
GET('/api/internal/tenant/usage', async (ctx) => {
  guard(ctx);
  const code = String(ctx.query.code || '');
  if (!code) throw bad('缺少 code');
  const t = await one('select * from tenants where code = ?', code);
  if (!t) throw notFound('租户不存在');
  let seats = 0;
  let leads = 0;
  if (t.org_id) {
    seats = Number((await one("select count(*) c from users where org_id = ? and status = 'active'", t.org_id)).c);
    leads = Number((await one('select count(*) c from leads where org_id = ?', t.org_id)).c);
  }
  return {
    ok: true,
    usage: {
      code: t.code,
      seats,
      leads,
      seatsLimit: t.seats,
      leadLimit: t.lead_quota,
      apiQuota: t.api_quota,
      expiresAt: t.expires_at,
      status: t.status,
    },
  };
}, { auth: false });
