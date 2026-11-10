import { one } from './db.js';

/**
 * 订阅只读 / 冻结闸门（CRM 侧）
 *
 * 官网是订阅状态权威，通过 /api/internal/tenant/sync-status 把状态写到 tenants 表。
 * 这里在统一入口对「写操作」做二次拦截：
 *   - grace（宽限期）：可登录、可读，所有写操作拒绝 → 只读
 *   - frozen / expired / cancelled / suspended：直接拒绝写入
 *
 * 豁免：GET/HEAD/OPTIONS、内部接口、健康检查、登录/登出/短信登录。
 * 独立部署实例同样适用：只要 tenants 台账里有该组织的状态记录即可。
 */

const WRITABLE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BLOCKED_STATUS = new Set(['grace', 'frozen', 'suspended', 'expired', 'cancelled']);
const READONLY_STATUS = new Set(['grace']);

export function shouldGuard(path, method) {
  const p = String(path || '');
  if (!WRITABLE_METHODS.has(String(method || '').toUpperCase())) return false;
  if (p.startsWith('/api/internal/')) return false;
  if (p === '/healthz' || p === '/api/health') return false;
  if (/^\/api\/auth\/(login|logout|sms\/)/.test(p)) return false;
  return true;
}

/** 查该组织当前是否处于受限状态（只取最新一条租户台账） */
export async function tenantRestriction(orgId) {
  if (!orgId) return null;
  const t = await one(
    `select code, status, expires_at from tenants
     where org_id = ? and status in ('grace','frozen','suspended','expired','cancelled')
     order by id desc limit 1`,
    Number(orgId)
  );
  if (!t || !BLOCKED_STATUS.has(t.status)) return null;
  return {
    code: READONLY_STATUS.has(t.status) ? 'TENANT_READONLY' : 'TENANT_FROZEN',
    message: READONLY_STATUS.has(t.status)
      ? `订阅已到期，当前为只读宽限期（租户 ${t.code}），续费后恢复`
      : `订阅已冻结或终止（租户 ${t.code}），请联系服务商续费`,
    status: t.status,
    tenantCode: t.code,
  };
}

/** 返回拦截原因（由 http.js 统一抛 HttpError，避免模块循环依赖） */
export async function tenantBlockReason(user, path, method) {
  if (!user || !shouldGuard(path, method)) return null;
  const orgId = user.org_id ?? user.orgId;
  return tenantRestriction(orgId);
}
