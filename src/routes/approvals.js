import { GET, POST, bad, notFound, denied } from '../http.js';
import { all, one, run, nowIso } from '../db.js';
import { pendingFor, approvalDetail, decide, chainForDiscount, chainForContract, resolveChain, applyAssignees, priceApprovalRequired } from '../approval.js';
import { canModule, canEditRecord } from '../auth.js';

/**
 * 审批链预览（提交前调用）
 * 目的：提交前就告诉用户「这一单会交给谁」，避免批到不知道谁手上。
 * 返回每个节点的具体审批人 + 可改选的候选人；missing 非空时前端禁止提交。
 */
GET('/api/approvals/preview', async ctx => {
  const type = String(ctx.query.type || '');
  const id = Number(ctx.query.id);
  if (!['quote', 'contract'].includes(type) || !id) throw bad('请指定单据类型与编号');
  if (type === 'quote') {
    const q = await one('select * from quotations where id=?', id);
    if (!q) throw notFound('报价单不存在');
    const op = await one('select * from opportunities where id=?', q.opportunity_id);
    if (!op) throw notFound('商机不存在');
    if (!(await canEditRecord(ctx.user, op))) throw denied('无权查看该报价的审批链');
    if (!(await priceApprovalRequired(q.discount_rate))) {
      return {
        type,
        id,
        required: false,
        title: q.no,
        reason: '未折扣报价按规则免价格审批，提交后直接进入合同流程',
        steps: [],
        missing: []
      };
    }
    const chain = await chainForDiscount(q.discount_rate, op.org_id);
    const resolved = resolveChain(chain, op.org_id);
    return {
      type,
      id,
      required: true,
      title: q.no,
      discount_rate: q.discount_rate,
      amount: q.amount,
      steps: resolved.steps,
      missing: resolved.missing
    };
  }
  const c = await one('select * from contracts where id=?', id);
  if (!c) throw notFound('合同不存在');
  if (!(await canEditRecord(ctx.user, c))) throw denied('无权查看该合同的审批链');
  const chain = await chainForContract({
    amount: Number(c.amount),
    paymentTerms: Number(c.payment_terms),
    nonStandard: ctx.query.non_standard === '1'
  });
  const resolved = resolveChain(chain, c.org_id);
  return {
    type,
    id,
    required: true,
    title: c.title,
    amount: c.amount,
    steps: resolved.steps,
    missing: resolved.missing
  };
});
GET('/api/approvals', async ctx => {
  if (!canModule(ctx.user, 'approval')) throw denied('无权访问审批中心');
  const scope = ctx.query.scope || 'todo';
  if (scope === 'todo') return {
    rows: await pendingFor(ctx.user)
  };
  if (scope === 'mine') {
    return {
      rows: await all(`select a.*, o.name as org_name from approvals a left join org_units o on o.id=a.org_id
         where a.applicant_id=? order by a.created_at desc limit 200`, ctx.user.id)
    };
  }
  if (scope === 'done') {
    return {
      rows: await all(`select distinct a.*, s.decision as my_decision, s.comment as my_comment, s.decided_at as my_decided_at
         from approvals a join approval_steps s on s.approval_id=a.id
         where s.approver_id=? and s.decision != 'pending' order by s.decided_at desc limit 200`, ctx.user.id)
    };
  }
  if (ctx.user.scope !== 'all') throw denied('只有集团层可以查看全部审批');
  return {
    rows: await all(`select a.*, u.name as applicant_name, o.name as org_name
       from approvals a left join users u on u.id=a.applicant_id
       left join org_units o on o.id=a.org_id order by a.created_at desc limit 300`)
  };
});
GET('/api/approvals/count', async ctx => ({
  count: (await pendingFor(ctx.user)).length
}));
GET('/api/approvals/:id', async ctx => {
  const ap = await approvalDetail(ctx.params.id);
  if (!ap) throw notFound('审批不存在');
  const isApprover = ap.steps.some(s => Number(s.approver_id) === ctx.user.id);
  if (!isApprover && ap.applicant_id !== ctx.user.id && ctx.user.role !== 'admin') {
    throw denied('无权查看该审批');
  }
  ap.canDecide = ap.status === 'pending' && (ctx.user.role === 'admin' || Number(ap.steps.find(s => s.seq === ap.current_step)?.approver_id) === Number(ctx.user.id));
  return ap;
});
POST('/api/approvals/:id/decide', async ctx => {
  const {
    decision,
    comment
  } = ctx.body || {};
  if (!['approved', 'rejected'].includes(decision)) throw bad('审批结论只能是通过或驳回');
  if (decision === 'rejected' && !comment) throw bad('驳回必须填写意见');
  const r = await decide(Number(ctx.params.id), ctx.user, decision, comment);
  if (r.error) throw bad(r.error);
  return r;
});