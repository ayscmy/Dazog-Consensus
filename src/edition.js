import { one } from './db.js';
import { HttpError } from './http.js';
import { entitlements } from './license.js';

/**
 * 版本与用户额度。
 *
 * 判定顺序：**有效授权 > 配置项 > 社区版默认**。
 *   - 有合法授权码 → 按授权里的 users（0 = 不限）与 edition 走；
 *   - 没授权 → 看 CRM_USER_LIMIT / CRM_EDITION（便于自建部署临时放开）；
 *   - 都没有 → 社区版 10 人。
 *
 * 两个容易踩的点：
 *   1. 只数「在职」用户。离职与停用不占位，否则客户每年换一批人，额度几下就被历史账号吃满。
 *   2. 不数试用账号（role='trial'）。它们由官网注册自动创建，不是管理员主动添加的成员；
 *      算进去会让「注册即开试用」在第 11 个访客时静默失败。
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

/** 无授权时的上限（0 = 不限） */
export const CONFIG_LIMIT = readLimit();
export const COMMUNITY_USER_LIMIT = COMMUNITY_LIMIT;

export const UPGRADE_URL =
  process.env.CRM_UPGRADE_URL || 'https://aioffice.aiemy.com/?from=crm#pricing';

/**
 * 当前生效的额度方案。异步：要读授权（可能来自数据库）。
 * @returns {Promise<{edition:string, limit:number, unlimited:boolean, licensed:boolean, license:object|null, source:'license'|'config'}>}
 */
export async function effectivePlan() {
  const ent = await entitlements();
  if (ent) {
    return {
      edition: ent.edition,
      limit: ent.usersLimit,
      unlimited: ent.usersLimit === 0,
      licensed: true,
      license: ent,
      source: 'license',
    };
  }
  return {
    edition: EDITION,
    limit: CONFIG_LIMIT,
    unlimited: CONFIG_LIMIT === 0,
    licensed: false,
    license: null,
    source: 'config',
  };
}

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
  const plan = await effectivePlan();
  const current = await activeUserCount();
  return {
    edition: plan.edition,
    licensed: plan.licensed,
    source: plan.source,
    license: plan.license,
    limit: plan.limit,
    unlimited: plan.unlimited,
    current,
    left: plan.unlimited ? null : Math.max(0, plan.limit - current),
    reached: !plan.unlimited && current >= plan.limit,
    upgradeUrl: UPGRADE_URL,
    communityLimit: COMMUNITY_LIMIT,
  };
}

/**
 * 占用一个用户名额前的检查。
 * 超限抛 403 并带 code=USER_LIMIT，前端据此弹收费说明而不是普通报错。
 */
export async function assertUserSlot() {
  const plan = await effectivePlan();
  if (plan.unlimited) return;

  const current = await activeUserCount();
  if (current < plan.limit) return;

  const who = plan.licensed ? '当前授权' : '社区版';
  const tail = plan.licensed
    ? '请联系 AIEMY 升级授权额度或续费。'
    : '继续添加成员需要升级到商业授权。';

  throw new HttpError(403, `${who}最多 ${plan.limit} 个在职用户，当前已有 ${current} 个。${tail}`, {
    code: 'USER_LIMIT',
    edition: plan.edition,
    licensed: plan.licensed,
    limit: plan.limit,
    current,
    upgradeUrl: UPGRADE_URL,
  });
}
