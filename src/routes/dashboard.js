import { GET } from '../http.js';
import { all, one, today, dateLtToday } from '../db.js';
import { scopeFilter, canModule } from '../auth.js';
import { pendingFor } from '../approval.js';
import { OPP_STAGES, LEAD_STATUS } from '../dict.js';
import { poolWhere } from '../pool.js';
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

/**
 * 新手引导（仅试用账号）：数据驱动，零新增表/字段。
 * 5 项任务全部基于现有表、在试用组织范围内判定，不碰公共池逻辑、不碰正式用户。
 * 完成判定：
 *  - view_sample：组织内有 source='示例' 的客户（seed 必预置 → 新开通即自动完成）
 *  - edit_lead：有 source='示例' 且 updated_at > created_at 的线索（被改过 = 推进过）
 *  - claim_pool：pool_events 有 action='claim' 且属本组织（从公共池领过）
 *  - send_quote：报价单状态进入 sent/accepted/won，或已生成发送记录
 *  - add_real：自己名下有 source 非'示例'的线索（录入了真实客户）
 */
async function buildOnboarding(u) {
  if (u.role !== 'trial') return null;
  const orgId = u.orgId;
  const userId = u.id;
  const has = async (sql, ...params) => !!(await one(sql, ...params));
  const viewSample = await has(
    "select 1 from accounts where org_id = ? and source = '示例' limit 1",
    orgId
  );
  const editLead = await has(
    "select 1 from leads where org_id = ? and source = '示例' and updated_at > created_at limit 1",
    orgId
  );
  const claimPool = await has(
    "select 1 from pool_events where org_id = ? and action = 'claim' limit 1",
    orgId
  );
  const sendQuote =
    (await has(
      "select 1 from quotations where org_id = ? and status in ('sent','accepted','won') limit 1",
      orgId
    )) ||
    (await has(
      'select 1 from quote_sends qs join quotations q on q.id = qs.quotation_id where q.org_id = ? limit 1',
      orgId
    ));
  const addReal = await has(
    "select 1 from leads where org_id = ? and owner_id = ? and (source is null or source <> '示例') limit 1",
    orgId,
    userId
  );
  const tasks = [
    { key: 'view_sample', title: '浏览示例数据', hint: '左侧「客户」已预置 3 家示例客户，先看看这个系统长什么样', go: '#/accounts', done: viewSample },
    { key: 'edit_lead', title: '推进一条线索', hint: '在「线索」里把一条示例线索状态改为「已联系」或「已确认」', go: '#/leads', done: editLead },
    { key: 'claim_pool', title: '从公共池认领一条线索', hint: '进入「公共池」，领取一条待跟进线索——迈出"加个同事一起用"的第一步', go: '#/pool', done: claimPool },
    { key: 'send_quote', title: '发出第一份报价', hint: '打开示例商机，生成并发送一份报价单', go: '#/quotations', done: sendQuote },
    { key: 'add_real', title: '录入一条真实线索', hint: '在「线索」点「新建」，录入你自己的客户', go: '#/leads?new=1', done: addReal }
  ];
  const doneCount = tasks.filter((t) => t.done).length;
  return { enabled: true, doneCount, total: tasks.length, tasks };
}
GET('/api/dashboard', async ctx => {
  const u = ctx.user;
  const period = monthKey();
  const oppScope = scopeFilter(u, {
    owner: 'op.owner_id',
    org: 'op.org_id'
  });
  const leadScope = scopeFilter(u, {
    owner: 'l.owner_id',
    org: 'l.org_id'
  });
  const opps = await all(`select op.id, op.name, op.amount, op.stage, op.probability, op.expected_date, op.won_at, op.owner_id,
            a.name as account_name, un.name as owner_name
     from opportunities op join accounts a on a.id=op.account_id
     left join users un on un.id=op.owner_id
     where ${oppScope.sql}`, ...oppScope.params);
  const open = opps.filter(o => !['won', 'lost'].includes(o.stage));
  const wonThisMonth = opps.filter(o => o.stage === 'won' && String(o.won_at || '').slice(0, 7) === period);
  const wonAmount = wonThisMonth.reduce((s, o) => s + Number(o.amount), 0);
  const targetRow = await one(u.scope === 'self' ? 'select coalesce(sum(amount),0) v from targets where user_id=? and period=?' : `select coalesce(sum(t.amount),0) v from targets t join users tu on tu.id=t.user_id
         where t.period=? and tu.org_id in (select id from org_units where path like ?)`, ...(u.scope === 'self' ? [u.id, period] : [period, `${u.orgPath}%`]));
  const targetAmount = Number(targetRow?.v || 0);
  const leadRows = await all(`select l.id, l.name, l.contact_name, l.contact_phone, l.status, l.next_action, l.next_date, l.score,
            un.name as owner_name
     from leads l left join users un on un.id=l.owner_id
     where ${leadScope.sql} and l.status in ('new','contacted','qualified')
     order by case when l.next_date is null then 1 else 0 end, l.next_date asc limit 60`, ...leadScope.params);
  const leadStats = await one(`select count(*) total,
            sum(case when status='new' then 1 else 0 end) fresh,
            sum(case when status='qualified' then 1 else 0 end) qualified
     from leads l where ${leadScope.sql}`, ...leadScope.params);
  // 公共池待领数：scopeFilter 对 self 角色会排除 owner_id IS NULL，必须单独用 poolWhere
  const poolW = poolWhere(u, 'l');
  const poolTotal = Number((await one(`select count(*) c from leads l
     where l.owner_id is null and l.status not in ('converted','invalid') and (${poolW.sql})`, ...poolW.params))?.c || 0);
  const funnel = OPP_STAGES.filter(s => !['lost'].includes(s.key)).map(s => {
    const list = opps.filter(o => o.stage === s.key);
    return {
      stage: s.key,
      label: s.label,
      color: s.color,
      count: list.length,
      amount: list.reduce((sum, o) => sum + Number(o.amount), 0)
    };
  });

  // 近 6 个月赢单趋势
  const trend = [];
  const baseDate = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const list = opps.filter(o => o.stage === 'won' && String(o.won_at || '').slice(0, 7) === key);
    trend.push({
      month: key,
      amount: list.reduce((s, o) => s + Number(o.amount), 0),
      count: list.length
    });
  }

  // 业绩排名（按本年赢单）
  const year = new Date().getFullYear();
  const rankMap = new Map();
  for (const o of opps) {
    if (o.stage !== 'won' || !String(o.won_at || '').startsWith(String(year))) continue;
    const r = rankMap.get(o.owner_id) || {
      id: o.owner_id,
      name: o.owner_name,
      amount: 0,
      count: 0
    };
    r.amount += Number(o.amount);
    r.count += 1;
    rankMap.set(o.owner_id, r);
  }
  const ranking = [...rankMap.values()].sort((a, b) => b.amount - a.amount).slice(0, 8).map(r => ({
    ...r,
    isMe: r.id === u.id
  }));
  const approvals = (await pendingFor(u)).slice(0, 8);
  const kpi = [{
    key: 'pipeline',
    label: '在谈管道',
    value: open.reduce((s, o) => s + Number(o.amount), 0),
    format: 'money',
    sub: `${open.length} 个商机`
  }, {
    key: 'weighted',
    label: '加权预测',
    value: open.reduce((s, o) => s + Number(o.amount) * Number(o.probability) / 100, 0),
    format: 'money',
    sub: '按阶段概率折算'
  }, {
    key: 'won',
    label: '本月赢单',
    value: wonAmount,
    format: 'money',
    sub: targetAmount ? `目标 ${(targetAmount / 10000).toFixed(0)} 万 · 完成 ${(wonAmount / targetAmount * 100).toFixed(0)}%` : `${wonThisMonth.length} 单`,
    progress: targetAmount ? Math.min(1, wonAmount / targetAmount) : null
  }, {
    key: 'leads',
    label: canModule(u, 'lead') ? '今日待跟进' : '待我审批',
    value: canModule(u, 'lead') ? leadRows.filter(l => l.next_date && l.next_date <= today(1)).length : approvals.length,
    format: 'count',
    sub: canModule(u, 'lead') ? `共 ${leadStats.total} 条线索` : '需要我处理'
  }];
  let receivable = null;
  if (canModule(u, 'finance')) {
    const rec = await one(`select coalesce(sum(c.amount),0) signed from contracts c where c.status='active' and ${scopeFilter(u, {
      owner: 'c.owner_id',
      org: 'c.org_id'
    }).sql}`, ...scopeFilter(u, {
      owner: 'c.owner_id',
      org: 'c.org_id'
    }).params);
    const got = await one(`select coalesce(sum(p.amount),0) v from payments p join contracts c on c.id=p.contract_id
       where ${scopeFilter(u, {
      owner: 'c.owner_id',
      org: 'c.org_id'
    }).sql}`, ...scopeFilter(u, {
      owner: 'c.owner_id',
      org: 'c.org_id'
    }).params);
    const overdue = await one(`select coalesce(sum(pp.amount),0) v, count(*) n from payment_plans pp join contracts c on c.id=pp.contract_id
       where c.status='active' and pp.status='pending' and ${dateLtToday('pp.due_date')}
         and ${scopeFilter(u, {
      owner: 'c.owner_id',
      org: 'c.org_id'
    }).sql}`, ...scopeFilter(u, {
      owner: 'c.owner_id',
      org: 'c.org_id'
    }).params);
    receivable = {
      signed: rec.signed,
      received: got.v,
      outstanding: Number(rec.signed) - Number(got.v),
      overdue: overdue.v,
      overdueCount: overdue.n
    };
  }
  const recent = await all(`select ac.*, un.name as user_name from activities ac left join users un on un.id=ac.user_id
     where (ac.target_type='opportunity' and ac.target_id in (select id from opportunities op where ${oppScope.sql}))
        or (ac.target_type='lead' and ac.target_id in (select id from leads l where ${leadScope.sql}))
     order by ac.created_at desc limit 12`, ...oppScope.params, ...leadScope.params);
  const onboarding = await buildOnboarding(u);
  return {
    user: u,
    period,
    kpi,
    funnel,
    trend,
    ranking,
    approvals,
    leads: leadRows.slice(0, 8),
    poolTotal,
    onboarding,
    leadOverview: {
      total: leadStats.total || 0,
      fresh: leadStats.fresh || 0,
      qualified: leadStats.qualified || 0,
      stages: LEAD_STATUS.map(async s => ({
        ...s,
        count: (await all('select id from leads l where l.status=? and ' + leadScope.sql, s.key, ...leadScope.params)).length
      }))
    },
    receivable,
    recent
  };
});