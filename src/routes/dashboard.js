import { GET } from '../http.js';
import { all, one, today } from '../db.js';
import { scopeFilter, canModule } from '../auth.js';
import { pendingFor } from '../approval.js';
import { OPP_STAGES, LEAD_STATUS } from '../dict.js';

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

GET('/api/dashboard', (ctx) => {
  const u = ctx.user;
  const period = monthKey();
  const oppScope = scopeFilter(u, { owner: 'op.owner_id', org: 'op.org_id' });
  const leadScope = scopeFilter(u, { owner: 'l.owner_id', org: 'l.org_id' });

  const opps = all(
    `select op.id, op.name, op.amount, op.stage, op.probability, op.expected_date, op.won_at, op.owner_id,
            a.name as account_name, un.name as owner_name
     from opportunities op join accounts a on a.id=op.account_id
     left join users un on un.id=op.owner_id
     where ${oppScope.sql}`,
    ...oppScope.params
  );

  const open = opps.filter((o) => !['won', 'lost'].includes(o.stage));
  const wonThisMonth = opps.filter((o) => o.stage === 'won' && String(o.won_at || '').slice(0, 7) === period);
  const wonAmount = wonThisMonth.reduce((s, o) => s + Number(o.amount), 0);

  const targetRow = one(
    u.scope === 'self'
      ? 'select coalesce(sum(amount),0) v from targets where user_id=? and period=?'
      : `select coalesce(sum(t.amount),0) v from targets t join users tu on tu.id=t.user_id
         where t.period=? and tu.org_id in (select id from org_units where path like ?)`,
    ...(u.scope === 'self' ? [u.id, period] : [period, `${u.orgPath}%`])
  );
  const targetAmount = Number(targetRow?.v || 0);

  const leadRows = all(
    `select l.id, l.name, l.contact_name, l.contact_phone, l.status, l.next_action, l.next_date, l.score,
            un.name as owner_name
     from leads l left join users un on un.id=l.owner_id
     where ${leadScope.sql} and l.status in ('new','contacted','qualified')
     order by case when l.next_date is null then 1 else 0 end, l.next_date asc limit 60`,
    ...leadScope.params
  );
  const leadStats = one(
    `select count(*) total,
            sum(case when status='new' then 1 else 0 end) fresh,
            sum(case when status='qualified' then 1 else 0 end) qualified
     from leads l where ${leadScope.sql}`,
    ...leadScope.params
  );

  const funnel = OPP_STAGES.filter((s) => !['lost'].includes(s.key)).map((s) => {
    const list = opps.filter((o) => o.stage === s.key);
    return {
      stage: s.key,
      label: s.label,
      color: s.color,
      count: list.length,
      amount: list.reduce((sum, o) => sum + Number(o.amount), 0),
    };
  });

  // 近 6 个月赢单趋势
  const trend = [];
  const baseDate = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const list = opps.filter((o) => o.stage === 'won' && String(o.won_at || '').slice(0, 7) === key);
    trend.push({ month: key, amount: list.reduce((s, o) => s + Number(o.amount), 0), count: list.length });
  }

  // 业绩排名（按本年赢单）
  const year = new Date().getFullYear();
  const rankMap = new Map();
  for (const o of opps) {
    if (o.stage !== 'won' || !String(o.won_at || '').startsWith(String(year))) continue;
    const r = rankMap.get(o.owner_id) || { id: o.owner_id, name: o.owner_name, amount: 0, count: 0 };
    r.amount += Number(o.amount);
    r.count += 1;
    rankMap.set(o.owner_id, r);
  }
  const ranking = [...rankMap.values()]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8)
    .map((r) => ({ ...r, isMe: r.id === u.id }));

  const approvals = pendingFor(u).slice(0, 8);

  const kpi = [
    {
      key: 'pipeline',
      label: '在谈管道',
      value: open.reduce((s, o) => s + Number(o.amount), 0),
      format: 'money',
      sub: `${open.length} 个商机`,
    },
    {
      key: 'weighted',
      label: '加权预测',
      value: open.reduce((s, o) => s + (Number(o.amount) * Number(o.probability)) / 100, 0),
      format: 'money',
      sub: '按阶段概率折算',
    },
    {
      key: 'won',
      label: '本月赢单',
      value: wonAmount,
      format: 'money',
      sub: targetAmount ? `目标 ${(targetAmount / 10000).toFixed(0)} 万 · 完成 ${((wonAmount / targetAmount) * 100).toFixed(0)}%` : `${wonThisMonth.length} 单`,
      progress: targetAmount ? Math.min(1, wonAmount / targetAmount) : null,
    },
    {
      key: 'leads',
      label: canModule(u, 'lead') ? '今日待跟进' : '待我审批',
      value: canModule(u, 'lead') ? leadRows.filter((l) => l.next_date && l.next_date <= today(1)).length : approvals.length,
      format: 'count',
      sub: canModule(u, 'lead') ? `共 ${leadStats.total} 条线索` : '需要我处理',
    },
  ];

  let receivable = null;
  if (canModule(u, 'finance')) {
    const rec = one(
      `select coalesce(sum(c.amount),0) signed from contracts c where c.status='active' and ${scopeFilter(u, { owner: 'c.owner_id', org: 'c.org_id' }).sql}`,
      ...scopeFilter(u, { owner: 'c.owner_id', org: 'c.org_id' }).params
    );
    const got = one(
      `select coalesce(sum(p.amount),0) v from payments p join contracts c on c.id=p.contract_id
       where ${scopeFilter(u, { owner: 'c.owner_id', org: 'c.org_id' }).sql}`,
      ...scopeFilter(u, { owner: 'c.owner_id', org: 'c.org_id' }).params
    );
    const overdue = one(
      `select coalesce(sum(pp.amount),0) v, count(*) n from payment_plans pp join contracts c on c.id=pp.contract_id
       where c.status='active' and pp.status='pending' and pp.due_date < date('now')
         and ${scopeFilter(u, { owner: 'c.owner_id', org: 'c.org_id' }).sql}`,
      ...scopeFilter(u, { owner: 'c.owner_id', org: 'c.org_id' }).params
    );
    receivable = { signed: rec.signed, received: got.v, outstanding: Number(rec.signed) - Number(got.v), overdue: overdue.v, overdueCount: overdue.n };
  }

  const recent = all(
    `select ac.*, un.name as user_name from activities ac left join users un on un.id=ac.user_id
     where (ac.target_type='opportunity' and ac.target_id in (select id from opportunities op where ${oppScope.sql}))
        or (ac.target_type='lead' and ac.target_id in (select id from leads l where ${leadScope.sql}))
     order by ac.created_at desc limit 12`,
    ...oppScope.params, ...leadScope.params
  );

  return {
    user: u,
    period,
    kpi,
    funnel,
    trend,
    ranking,
    approvals,
    leads: leadRows.slice(0, 8),
    leadOverview: {
      total: leadStats.total || 0,
      fresh: leadStats.fresh || 0,
      qualified: leadStats.qualified || 0,
      stages: LEAD_STATUS.map((s) => ({
        ...s,
        count: all('select id from leads l where l.status=? and ' + leadScope.sql, s.key, ...leadScope.params).length,
      })),
    },
    receivable,
    recent,
  };
});
