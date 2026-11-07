import { GET, POST, denied } from '../http.js';
import { canModule } from '../auth.js';
import {
  getRules, assertPoolEnabled, listPool, poolStats, poolEvents,
  claimLead, releaseLead, assignLead, reclaimLead
} from '../pool.js';

/**
 * 线索公海接口（docs/20 第 3.4 / 11.2 节）
 *
 * 注册顺序有坑：GET /api/leads/pool 与 GET /api/leads/:id 都是 3 段，
 * 若本文件晚于 leads.js 注册，/api/leads/pool 会被 :id 吃掉。
 * 所以 src/routes/index.js 里 import './pool.js' 必须排在 import './leads.js' 之前。
 */

function guard(ctx) {
  if (!canModule(ctx.user, 'lead')) throw denied('无权访问线索公海');
}

/** 池中线索 + 统计 */
GET('/api/leads/pool', async ctx => {
  guard(ctx);
  assertPoolEnabled(await getRules());
  const [rows, stats] = await Promise.all([
    listPool(ctx.user, ctx.query),
    poolStats(ctx.user)
  ]);
  return { rows, stats };
});

/** 当前生效规则快照（前端展示用，只读） */
GET('/api/leads/pool/rules', async ctx => {
  guard(ctx);
  return { rules: await getRules() };
});

/** 审计轨迹（按组织隔离） */
GET('/api/leads/pool/events', async ctx => {
  guard(ctx);
  return { rows: await poolEvents(ctx.user, ctx.query) };
});

/** 领取：原子条件更新，并发只有一个成功 */
POST('/api/leads/pool/:id/claim', async ctx => {
  guard(ctx);
  return claimLead(ctx.user, ctx.params.id);
});

/** 分配：经理及以上 */
POST('/api/leads/pool/:id/assign', async ctx => {
  guard(ctx);
  return assignLead(ctx.user, ctx.params.id, (ctx.body || {}).owner_id);
});

/** 强制回收：经理及以上 */
POST('/api/leads/pool/:id/reclaim', async ctx => {
  guard(ctx);
  return reclaimLead(ctx.user, ctx.params.id, (ctx.body || {}).reason);
});

/** 主动放回：本人或经理 */
POST('/api/leads/:id/release', async ctx => {
  guard(ctx);
  return releaseLead(ctx.user, ctx.params.id, (ctx.body || {}).reason);
});
