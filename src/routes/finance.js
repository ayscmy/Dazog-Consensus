import { GET, POST, bad, notFound, denied } from '../http.js';
import { all, one, run, tx, nowIso, idOf, today } from '../db.js';
import { canEditRecord, canModule, scopeFilter } from '../auth.js';
import { threeWay } from './contracts.js';

const isFinance = (u) => ['finance', 'admin', 'gm'].includes(u.role);

GET('/api/finance/summary', (ctx) => {
  if (!canModule(ctx.user, 'finance')) throw denied('无权访问财务数据');
  const scope = scopeFilter(ctx.user, { owner: 'c.owner_id', org: 'c.org_id' });
  const signed = one(
    `select coalesce(sum(c.amount),0) v, count(*) n from contracts c where c.status='active' and ${scope.sql}`,
    ...scope.params
  );
  const invoiced = one(
    `select coalesce(sum(i.amount),0) v from invoices i join contracts c on c.id=i.contract_id
     where i.status='issued' and ${scope.sql}`,
    ...scope.params
  );
  const received = one(
    `select coalesce(sum(p.amount),0) v from payments p join contracts c on c.id=p.contract_id
     where ${scope.sql}`,
    ...scope.params
  );
  const plans = all(
    `select pp.*, c.no as contract_no, c.title, a.name as account_name, c.owner_id,
            cast(julianday(date('now')) - julianday(pp.due_date) as integer) as overdue_days
     from payment_plans pp join contracts c on c.id=pp.contract_id join accounts a on a.id=c.account_id
     where c.status='active' and ${scope.sql} and pp.status='pending' order by pp.due_date`,
    ...scope.params
  );
  const buckets = { d0: 0, d30: 0, d60: 0, d90: 0, future: 0 };
  let overdueAmount = 0;
  for (const p of plans) {
    const d = p.overdue_days;
    if (d <= 0) buckets.future += p.amount;
    else if (d <= 30) { buckets.d0 += p.amount; overdueAmount += p.amount; }
    else if (d <= 60) { buckets.d30 += p.amount; overdueAmount += p.amount; }
    else if (d <= 90) { buckets.d60 += p.amount; overdueAmount += p.amount; }
    else { buckets.d90 += p.amount; overdueAmount += p.amount; }
  }
  return {
    signed: signed.v,
    contractCount: signed.n,
    invoiced: invoiced.v,
    received: received.v,
    receivable: signed.v - received.v,
    overdueAmount,
    overdueCount: plans.filter((p) => p.overdue_days > 0).length,
    buckets,
    pendingInvoice: one("select coalesce(sum(amount),0) v, count(*) n from invoices where status='applied'").v,
    pendingInvoiceCount: one("select count(*) n from invoices where status='applied'").n,
  };
});

/* ---------------- 发票 ---------------- */

GET('/api/finance/invoices', (ctx) => {
  if (!canModule(ctx.user, 'finance')) throw denied('无权访问发票');
  const scope = scopeFilter(ctx.user, { owner: 'c.owner_id', org: 'c.org_id' });
  const where = [scope.sql];
  const params = [...scope.params];
  if (ctx.query.status) { where.push('i.status=?'); params.push(ctx.query.status); }
  const rows = all(
    `select i.*, c.no as contract_no, c.title, a.name as account_name, u.name as applicant_name
     from invoices i join contracts c on c.id=i.contract_id join accounts a on a.id=c.account_id
     left join users u on u.id=i.apply_by
     where ${where.join(' and ')} order by i.applied_at desc limit 300`,
    ...params
  );
  return { rows, stats: { applied: rows.filter((r) => r.status === 'applied').length, issued: rows.filter((r) => r.status === 'issued').length } };
});

/** 业务员可发起开票申请 */
POST('/api/finance/invoices', (ctx) => {
  const b = ctx.body || {};
  const c = one('select * from contracts where id=?', b.contract_id);
  if (!c) throw bad('请选择合同');
  if (!canEditRecord(ctx.user, c)) throw denied('只能为自己负责的合同申请开票');
  if (c.status !== 'active') throw bad('只有已生效的合同才能开票');
  if (!(Number(b.amount) > 0)) throw bad('请填写开票金额');

  const tw = threeWay(c.id);
  const available = tw.contract - tw.invoiced - tw.applied;
  if (Number(b.amount) > available + 0.01) {
    throw bad(`开票金额超出可开票额度，剩余可开 ${available.toLocaleString()} 元`);
  }
  const r = run(
    `insert into invoices(contract_id,account_id,amount,tax_rate,type,status,apply_by,applied_at,remark)
     values(?,?,?,?,?,'applied',?,?,?)`,
    c.id, c.account_id, Number(b.amount), Number(b.tax_rate ?? c.tax_rate), b.type || 'special',
    ctx.user.id, nowIso(), b.remark
  );
  return { id: idOf(r) };
});

POST('/api/finance/invoices/:id/issue', (ctx) => {
  if (!isFinance(ctx.user)) throw denied('只有财务可以开票');
  const inv = one('select * from invoices where id=?', ctx.params.id);
  if (!inv) throw notFound('发票不存在');
  if (inv.status !== 'applied') throw bad('该发票不是待开票状态');
  const no = ctx.body?.no || `FP${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${String(inv.id).padStart(3, '0')}`;
  run("update invoices set status='issued', no=?, issued_at=? where id=?", no, nowIso(), inv.id);
  return { ok: true, no };
});

POST('/api/finance/invoices/:id/void', (ctx) => {
  if (!isFinance(ctx.user)) throw denied('只有财务可以作废发票');
  const inv = one('select * from invoices where id=?', ctx.params.id);
  if (!inv) throw notFound('发票不存在');
  const alloc = one('select coalesce(sum(amount),0) v from payment_allocations where invoice_id=?', inv.id).v;
  if (alloc > 0) throw bad('该发票已有回款核销，不能作废');
  run("update invoices set status='void' where id=?", inv.id);
  return { ok: true };
});

/* ---------------- 回款 ---------------- */

GET('/api/finance/payments', (ctx) => {
  if (!canModule(ctx.user, 'finance')) throw denied('无权访问回款');
  const scope = scopeFilter(ctx.user, { owner: 'c.owner_id', org: 'c.org_id' });
  const where = [scope.sql];
  const params = [...scope.params];
  if (ctx.query.contract) { where.push('p.contract_id=?'); params.push(Number(ctx.query.contract)); }
  const rows = all(
    `select p.*, c.no as contract_no, c.title, a.name as account_name, u.name as creator_name,
            (select coalesce(sum(amount),0) from payment_allocations pa where pa.payment_id=p.id) as allocated
     from payments p join contracts c on c.id=p.contract_id join accounts a on a.id=c.account_id
     left join users u on u.id=p.created_by
     where ${where.join(' and ')} order by p.received_at desc limit 300`,
    ...params
  );
  return { rows };
});

POST('/api/finance/payments', (ctx) => {
  if (!isFinance(ctx.user)) throw denied('只有财务可以登记回款');
  const b = ctx.body || {};
  const c = one('select * from contracts where id=?', b.contract_id);
  if (!c) throw bad('请选择合同');
  if (c.status !== 'active') throw bad('只有已生效的合同可以登记回款');
  if (!(Number(b.amount) > 0)) throw bad('请填写回款金额');

  const out = tx(() => {
    const no = `SK${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${String(Date.now()).slice(-4)}`;
    const r = run(
      `insert into payments(no,contract_id,account_id,amount,method,received_at,bank_ref,remark,created_by,created_at)
       values(?,?,?,?,?,?,?,?,?,?)`,
      no, c.id, c.account_id, Number(b.amount), b.method || 'transfer',
      b.received_at || today(), b.bank_ref, b.remark, ctx.user.id, nowIso()
    );
    const paymentId = idOf(r);

    // 自动核销：优先核销已开票未核销的发票
    let remaining = Number(b.amount);
    const invoices = all(
      `select i.*, coalesce((select sum(amount) from payment_allocations pa where pa.invoice_id=i.id),0) as allocated
       from invoices i where i.contract_id=? and i.status='issued' order by i.issued_at`,
      c.id
    );
    for (const inv of invoices) {
      if (remaining <= 0) break;
      const open = Number(inv.amount) - Number(inv.allocated);
      if (open <= 0) continue;
      const use = Math.min(open, remaining);
      run(
        'insert into payment_allocations(payment_id,invoice_id,amount,created_at) values(?,?,?,?)',
        paymentId, inv.id, use, nowIso()
      );
      remaining -= use;
    }

    // 更新回款计划状态
    const plans = all("select * from payment_plans where contract_id=? and status='pending' order by seq", c.id);
    let toMark = Number(b.amount);
    for (const p of plans) {
      if (toMark >= Number(p.amount) - 0.01) {
        run("update payment_plans set status='received' where id=?", p.id);
        toMark -= Number(p.amount);
      } else break;
    }
    return { id: paymentId, no, unallocated: remaining };
  });
  return out;
});

POST('/api/finance/payments/:id/allocate', (ctx) => {
  if (!isFinance(ctx.user)) throw denied('只有财务可以核销');
  const p = one('select * from payments where id=?', ctx.params.id);
  if (!p) throw notFound('回款不存在');
  const { invoice_id, amount } = ctx.body || {};
  const inv = one('select * from invoices where id=?', invoice_id);
  if (!inv || inv.contract_id !== p.contract_id) throw bad('发票与回款不属于同一合同');
  const used = one('select coalesce(sum(amount),0) v from payment_allocations where payment_id=?', p.id).v;
  const left = Number(p.amount) - Number(used);
  if (!(Number(amount) > 0) || Number(amount) > left + 0.01) throw bad(`可核销余额为 ${left.toLocaleString()} 元`);
  const invAlloc = one('select coalesce(sum(amount),0) v from payment_allocations where invoice_id=?', inv.id).v;
  if (Number(invAlloc) + Number(amount) > Number(inv.amount) + 0.01) throw bad('核销金额超出该发票金额');
  run('insert into payment_allocations(payment_id,invoice_id,amount,created_at) values(?,?,?,?)', p.id, inv.id, Number(amount), nowIso());
  return { ok: true };
});

/** 应收账龄明细 */
GET('/api/finance/receivables', (ctx) => {
  if (!canModule(ctx.user, 'finance')) throw denied('无权访问应收');
  const scope = scopeFilter(ctx.user, { owner: 'c.owner_id', org: 'c.org_id' });
  const rows = all(
    `select pp.*, c.no as contract_no, c.title, c.payment_terms, a.name as account_name, u.name as owner_name,
            cast(julianday(date('now')) - julianday(pp.due_date) as integer) as overdue_days
     from payment_plans pp join contracts c on c.id=pp.contract_id
     join accounts a on a.id=c.account_id left join users u on u.id=c.owner_id
     where c.status='active' and ${scope.sql} order by pp.status, pp.due_date`,
    ...scope.params
  );
  return { rows };
});
