import { one } from './db.js';
import { HttpError } from './http.js';

/**
 * 版本与用户额度。
 *
 * 社区版（community）免费，但限制在职用户数量——这不是技术限制，是授权边界：
 * 本项目禁止商业使用（见 LICENSE），愿意付费的用户走商业授权解除。
 * 商业授权用 CRM_USER_LIMIT 覆盖，设 0 表示不限。
 *
 * 两个容易踩的点：
 *   1. 只数「在职」用户（status='active'）。离职与停用不占位，
 *      否则客户每年换一批人，额度几下就被历史账号吃满。
 *   2. 不数试用账号（role='trial'）。它们由官网注册自动创建，
 *      不是管理员主动添加的成员；算进去会让「注册即开试用」在第 11 个访客时静默失败。
 */

export const EDITION = String(process.env.CRM_EDITION || 'community').toLowerCase();

/** 社区版内置上限。改这里等于改产品策略，请同步 README 与官网文案。 */
const COMMUNITY_LIMIT = 10;

const UNLIMITED_EDITIONS = new Set(['pro', 'enterprise', 'unlimited', 'commercial']);

function readLimit() {
  const raw = process.env.CRM_USER_LIMIT ?? process.env.USER_LIMIT;
  if (raw === undefined || raw === '') {
    return UNLIMITED_EDITIONS.has(EDITION) ? 0 : COMMUNITY_LIMIT;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return COMMUNITY_LIMIT;
  return Math.floor(n);
}

/** 0 = 不限 */
export const USER_LIMIT = readLimit();
export const COMMUNITY_USER_LIMIT = COMMUNITY_LIMIT;

export const UPGRADE_URL =
  process.env.CRM_UPGRADE_URL || 'https://office.aiemy.com/?from=crm#pricing';

export const limitEnabled = () => USER_LIMIT > 0;

/** 占额度的用户：在职、且不是试用账号 */
export async function activeUserCount() {
  const r = await one(
    `select count(*) c from users u
      where u.status = 'active'
        and not exists (select 1 from user_roles r where r.user_id = u.id and r.role = 'trial')`
  );
  return Number((r && r.c) || 0);
}

/** 给前端展示的额度快照 */
export async function userQuota() {
  const current = await activeUserCount();
  const unlimited = !limitEnabled();
  return {
    edition: EDITION,
    limit: USER_LIMIT,
    unlimited,
    current,
    left: unlimited ? null : Math.max(0, USER_LIMIT - current),
    reached: !unlimited && current >= USER_LIMIT,
    upgradeUrl: UPGRADE_URL,
  };
}

/**
 * 占用一个用户名额前的检查。
 * 超限抛 403 并带 code=USER_LIMIT，前端据此弹收费说明而不是普通报错。
 */
export async function assertUserSlot() {
  if (!limitEnabled()) return;
  const current = await activeUserCount();
  if (current < USER_LIMIT) return;
  throw new HttpError(
    403,
    `社区版最多 ${USER_LIMIT} 个在职用户，当前已有 ${current} 个。继续添加成员需要升级到商业授权。`,
    {
      code: 'USER_LIMIT',
      edition: EDITION,
      limit: USER_LIMIT,
      current,
      upgradeUrl: UPGRADE_URL,
    }
  );
}
