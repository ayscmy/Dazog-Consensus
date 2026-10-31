import { GET, POST, PATCH, bad, notFound, denied } from '../http.js';
import { all, one, run, nowIso, idOf, today } from '../db.js';
import { scopeFilter, canEditRecord, canModule } from '../auth.js';
import { chainForContract, createApproval, approvalDetail, createPaymentPlans, resolveChain, applyAssignees } from '../approval.js';
import { loadContractDoc, renderContractHtml } from '../doc/contract-doc.js';
import { createContractRecord } from '../contracts-service.js';
const parseJson = (text, fallback) => {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};
async function loadContract(id) {
  return await one(`select c.*, a.name as account_name, op.name as opportunity_name, u.name as owner_name,
            o.name as org_name, q.no as quote_no
     from contracts c
     join accounts a on a.id=c.account_id
     left join opportunities op on op.id=c.opportunity_id
     left join users u on u.id=c.owner_id
     left join org_units o on o.id=c.org_id
     left join quotations q on q.id=c.quotation_id
     where c.id=?`, id);
}

/** 三单匹配：合同 / 开票 / 回款 */
export async function threeWay(contractId) {
  const c = await one('select amount from contracts where id=?', contractId);
  const invoiced = (await one("select coalesce(sum(amount),0) v from invoices where contract_id=? and status='issued'", contractId)).v;
  const applied = (await one("select coalesce(sum(amount),0) v from invoices where contract_id=? and status='applied'", contractId)).v;
  const received = (await one('select coalesce(sum(amount),0) v from payments where contract_id=?', contractId)).v;
  const contractAmount = c ? Number(c.amount) : 0;
  const receivable = contractAmount - received;
  const diff = contractAmount - invoiced - applied;
  return {
    contract: contractAmount,
    invoiced,
    applied,
    received,
    receivable,
    unInvoiced: Math.max(0, contractAmount - invoiced - applied),
    gap: diff,
    matched: Math.abs(diff) < 0.01 && Math.abs(contractAmount - received - receivable) < 0.01
  };
}
GET('/api/contracts', async ctx => {
  if (!canModule(ctx.user, 'contract')) throw denied('无权访问合同');
  const scope = scopeFilter(ctx.user, {
    owner: 'c.owner_id',
    org: 'c.org_id'
  });
  const where = [scope.sql];
  const params = [...scope.params];
  if (ctx.query.status) {
    where.push('c.status = ?');
    params.push(ctx.query.status);
  }
  if (ctx.query.q) {
    where.push('(c.no LIKE ? OR c.title LIKE ? OR a.name LIKE ?)');
    params.push(`%${ctx.query.q}%`, `%${ctx.query.q}%`, `%${ctx.query.q}%`);
  }
  if (ctx.query.mine === '1') {
    where.push('c.owner_id = ?');
    params.push(ctx.user.id);
  }
  const rows = await all(`select c.*, a.name as account_name, u.name as owner_name, o.name as org_name,
            (select coalesce(sum(amount),0) from invoices i where i.contract_id=c.id and i.status='issued') as invoiced,
            (select coalesce(sum(amount),0) from payments p where p.contract_id=c.id) as received
     from contracts c join accounts a on a.id=c.account_id
     left join users u on u.id=c.owner_id left join org_units o on o.id=c.org_id
     where ${where.join(' and ')} order by c.created_at desc limit 400`, ...params);
  return {
    rows,
    stats: {
      total: rows.length,
      active: rows.filter(r => r.status === 'active').length,
      pending: rows.filter(r => !['active', 'draft', 'rejected', 'completed', 'terminated'].includes(r.status)).length,
      amount: rows.filter(r => r.status === 'active').reduce((s, r) => s + Number(r.amount || 0), 0),
      received: rows.reduce((s, r) => s + Number(r.received || 0), 0)
    }
  };
});
GET('/api/contracts/pending', async ctx => {
  if (!canModule(ctx.user, 'contract')) throw denied('无权访问合同');
  const scope = scopeFilter(ctx.user, {
    owner: 'op.owner_id',
    org: 'q.org_id'
  });
  const rows = await all(`select q.id as quotation_id, q.no as quote_no, q.amount, q.list_amount, q.discount_rate,
            q.valid_until, q.status, q.created_at, q.has_custom,
            op.id as opportunity_id, op.name as opportunity_name,
            a.id as account_id, a.name as account_name,
            u.name as owner_name,
            (select count(*) from quotation_items qi where qi.quotation_id = q.id) as item_count
     from quotations q
     join opportunities op on op.id = q.opportunity_id
     join accounts a on a.id = q.account_id
     left join users u on u.id = op.owner_id
     left join contracts c on c.quotation_id = q.id
     where q.status = 'approved' and c.id is null and ${scope.sql}
     order by q.created_at desc limit 100`, ...scope.params);
  return {
    rows
  };
});
GET('/api/contracts/templates', async ctx => {
  if (!canModule(ctx.user, 'contract')) throw denied('无权访问合同模板');
  return {
    rows: (await all("select * from contract_templates where status='active' order by builtin desc, id")).map(t => ({
      ...t,
      clauses: parseJson(t.clauses, [])
    }))
  };
});
GET('/api/contracts/:id', async ctx => {
  const c = await loadContract(ctx.params.id);
  if (!c) throw notFound('合同不存在');
  if (!(await canEditRecord(ctx.user, c))) throw denied('无权查看该合同');
  c.approval = c.approval_id ? await approvalDetail(c.approval_id) : null;
  c.plans = await all('select * from payment_plans where contract_id=? order by seq', c.id);
  c.invoices = await all('select * from invoices where contract_id=? order by id', c.id);
  c.payments = await all(`select p.*, u.name as creator_name from payments p left join users u on u.id=p.created_by
     where p.contract_id=? order by p.received_at desc`, c.id);
  c.threeWay = await threeWay(c.id);
  c.buyer = parseJson(c.buyer_json, {});
  c.seller = parseJson(c.seller_json, {});
  c.items = parseJson(c.items_json, c.quotation_id ? await all('select name, spec, unit, qty, unit_price as price from quotation_items where quotation_id=? order by seq', c.quotation_id) : []);
  c.clauses = parseJson(c.clauses_json, []);
  c.template = c.template_id ? await one('select id, code, name from contract_templates where id=?', c.template_id) : null;
  c.sends = [];
  return c;
});

/** 合同单据（订单合约为发票式，条款合约为条款版），打印/另存 PDF */
GET('/api/contracts/:id/document', async ctx => {
  const data = await loadContractDoc(ctx.params.id);
  if (!data) throw notFound('合同不存在');
  if (!(await canEditRecord(ctx.user, data.c))) throw denied('无权查看该合同');
  const html = await renderContractHtml(data);
  ctx.res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  ctx.res.end(html);
  return undefined;
});
POST('/api/contracts', async ctx => {
  if (!canModule(ctx.user, 'contract')) throw denied('无权创建合同');
  return await createContractRecord(ctx.user, ctx.body || {});
});
PATCH('/api/contracts/:id', async ctx => {
  const c = await loadContract(ctx.params.id);
  if (!c) throw notFound('合同不存在');
  if (!(await canEditRecord(ctx.user, c))) throw denied('无权修改该合同');
  if (!['draft', 'rejected'].includes(c.status)) throw bad('已提交审批的合同不能直接修改，请走变更流程');
  const b = ctx.body || {};
  const fields = ['title', 'amount', 'tax_rate', 'payment_terms', 'sign_date', 'start_date', 'end_date', 'tax_mode'];
  const sets = [];
  const params = [];
  for (const f of fields) if (b[f] !== undefined) {
    sets.push(`${f}=?`);
    params.push(b[f]);
  }
  // 条款合同：条款可增删改（草稿/驳回状态）
  if (Array.isArray(b.clauses)) {
    sets.push('clauses_json=?');
    params.push(JSON.stringify(b.clauses.map(x => ({
      title: String(x.title || '').trim(),
      body: String(x.body || '').trim()
    }))));
  }
  if (b.buyer && typeof b.buyer === 'object') {
    sets.push('buyer_json=?');
    params.push(JSON.stringify(b.buyer));
  }
  if (b.seller && typeof b.seller === 'object') {
    sets.push('seller_json=?');
    params.push(JSON.stringify(b.seller));
  }
  if (Array.isArray(b.items)) {
    sets.push('items_json=?');
    params.push(JSON.stringify(b.items.map(x => ({
      name: String(x.name || '').trim(),
      spec: x.spec || '',
      unit: x.unit || '项',
      qty: Number(x.qty || 1),
      price: Number(x.price ?? x.unit_price ?? 0)
    }))));
  }
  if (!sets.length) return {
    ok: true
  };
  sets.push("status='draft'", 'updated_at=?');
  params.push(nowIso(), c.id);
  await run(`update contracts set ${sets.join(',')} where id=?`, ...params);
  return {
    ok: true
  };
});

/** 提交合同审批：经理 → （总监）→ 财务 → （法务） */
POST('/api/contracts/:id/submit', async ctx => {
  const c = await loadContract(ctx.params.id);
  if (!c) throw notFound('合同不存在');
  if (!(await canEditRecord(ctx.user, c))) throw denied('无权提交该合同');
  if (!['draft', 'rejected'].includes(c.status)) throw bad('该合同已在审批中或已生效');
  if (!(Number(c.amount) > 0)) throw bad('合同金额必须大于 0');
  if (!(Number(c.payment_terms) >= 0)) throw bad('请填写账期');
  if (c.quotation_id) {
    const q = await one('select status from quotations where id=?', c.quotation_id);
    if (!q || !['approved', 'converted'].includes(q.status)) throw bad('关联报价尚未通过折扣审批，不能提交合同');
  }
  const chain = await chainForContract({
    amount: Number(c.amount),
    paymentTerms: Number(c.payment_terms),
    nonStandard: !!ctx.body?.non_standard
  });
  const resolved = applyAssignees(resolveChain(chain, c.org_id), ctx.body?.assignees);
  if (resolved.missing.length) {
    throw bad(`审批链缺少审批人：${resolved.missing.map(m => m.label).join('、')}。请先在「系统设置 → 用户与角色」里给该角色指定在职负责人，或在提交时手动选择`, resolved.missing.map(m => `${m.label}：本组织链上没有在职的该角色`));
  }
  const {
    approvalId
  } = await createApproval({
    type: 'contract',
    targetType: 'contract',
    targetId: c.id,
    title: `合同审批 · ${c.title}`,
    summary: `合同额 ${Number(c.amount).toLocaleString()} 元，账期 ${c.payment_terms} 天`,
    amount: c.amount,
    applicantId: ctx.user.id,
    orgId: c.org_id,
    steps: resolved.steps
  });
  await run(`update contracts set status=?, approval_id=?, updated_at=? where id=?`, chain[0].role === 'manager' ? 'sales_review' : chain[0].role === 'finance' ? 'finance_review' : 'legal_review', approvalId, nowIso(), c.id);
  return {
    ok: true,
    approvalId,
    steps: resolved.steps.map(s => ({
      role: s.role,
      label: s.label,
      approver_id: s.approver_id,
      approver_name: s.approver_name
    }))
  };
});
POST('/api/contracts/:id/terminate', async ctx => {
  const c = await loadContract(ctx.params.id);
  if (!c) throw notFound('合同不存在');
  if (!['admin', 'gm', 'director'].includes(ctx.user.role)) throw denied('只有总监及以上可以终止合同');
  if (c.status !== 'active') throw bad('只有生效中的合同可以终止');
  if (!ctx.body?.reason) throw bad('请填写终止原因');
  await run("update contracts set status='terminated', updated_at=? where id=?", nowIso(), c.id);
  await run(`insert into activities(target_type,target_id,type,content,result,user_id,created_at)
     values('contract',?,'note','合同终止',?,?,?)`, c.id, ctx.body.reason, ctx.user.id, nowIso());
  return {
    ok: true
  };
});