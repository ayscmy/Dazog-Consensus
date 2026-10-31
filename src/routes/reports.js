import { GET } from '../http.js';
import { all, one } from '../db.js';
import { scopeFilter, canModule } from '../auth.js';

GET('/api/reports', (ctx) => {
  const u = ctx.user;
  const oppScope = scopeFilter(u, { owner: 'op.owner_id', org: 'op.org_id' });
  const leadScope = scopeFilter(u, { owner: 'l.owner_id', org: 'l.org_id' });
  const ctScope = scopeFilter(u, { owner: 'c.owner_id', org: 'c.org_id' });
  const year = new Date().getFullYear();

  const byOrg = all(
    `select o.name, o.path, p.name as parent_name,
            coalesce(sum(case when op.stage='won' and op.won_at like ? then op.amount else 0 end),0) won,
            coalesce(sum(case when op.stage not in ('won','lost') then op.amount else 0 end),0) pipeline,
            count(op.id) cnt
     from org_units o
     left join org_units p on p.id = o.parent_id
     left join opportunities op on op.org_id = o.id and ${oppScope.sql}
     where o.type in ('company','dept') and o.path like ?
     group by o.id having cnt > 0 order by won desc`,
    `${year}%`, ...oppScope.params, `${u.scope === 'all' ? '/' : u.orgPath}%`
  );

  const byIndustry = all(
    `select a.industry,
            coalesce(sum(case when op.stage='won' then op.amount else 0 end),0) won,
            coalesce(sum(case when op.stage not in ('won','lost') then op.amount else 0 end),0) pipeline,
            count(op.id) cnt
     from opportunities op join accounts a on a.id=op.account_id
     where ${oppScope.sql} group by a.industry order by won desc`,
    ...oppScope.params
  );

  const bySource = all(
    `select l.source, count(*) total,
            coalesce(sum(case when l.status='converted' then 1 else 0 end),0) converted,
            coalesce(sum(case when l.status='invalid' then 1 else 0 end),0) invalid
     from leads l where ${leadScope.sql} group by l.source order by total desc`,
    ...leadScope.params
  );

  const monthly = [];
  const baseDate = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const r = one(
      `select coalesce(sum(amount),0) v, count(*) n from opportunities op
       where op.stage='won' and op.won_at like ? and ${oppScope.sql}`,
      `${key}%`, ...oppScope.params
    );
    const t = one(
      `select coalesce(sum(t.amount),0) v from targets t join users tu on tu.id=t.user_id
       where t.period=? and tu.org_id in (select id from org_units where path like ?)`,
      key, `${u.scope === 'all' ? '/' : u.orgPath}%`
    );
    monthly.push({ month: key, won: r.v, count: r.n, target: t.v });
  }

  const byOwner = all(
    `select un.name,
            coalesce(sum(case when op.stage='won' then op.amount else 0 end),0) won,
            coalesce(sum(case when op.stage not in ('won','lost') then op.amount else 0 end),0) pipeline,
            count(op.id) cnt
     from opportunities op join users un on un.id=op.owner_id
     where ${oppScope.sql} group by op.owner_id order by won desc limit 20`,
    ...oppScope.params
  );

  const contractStats = one(
    `select coalesce(sum(c.amount),0) signed,
            coalesce((select sum(p.amount) from payments p join contracts c2 on c2.id=p.contract_id where ${ctScope.sql.replace(/c\./g, 'c2.')}),0) received
     from contracts c where c.status='active' and ${ctScope.sql}`,
    ...ctScope.params, ...ctScope.params
  );

  const totalWon = byOwner.reduce((s, r) => s + Number(r.won), 0);
  const totalPipeline = byOwner.reduce((s, r) => s + Number(r.pipeline), 0);
  const wonCount = one(
    `select count(*) c from opportunities op where op.stage='won' and ${oppScope.sql}`,
    ...oppScope.params
  ).c;

  return {
    byOrg,
    byIndustry,
    bySource,
    monthly,
    byOwner,
    summary: {
      totalWon,
      totalPipeline,
      signed: contractStats.signed,
      received: contractStats.received,
      activeUsers: byOwner.filter((r) => Number(r.won) > 0).length,
      avgDeal: wonCount ? totalWon / wonCount : 0,
      wonCount,
    },
  };
});

GET('/api/search', (ctx) => {
  const q = String(ctx.query.q || '').trim();
  if (!q) return { accounts: [], opportunities: [], leads: [], contracts: [] };
  const like = `%${q}%`;
  const u = ctx.user;

  const accS = scopeFilter(u, { owner: 'a.owner_id', org: 'a.org_id' });
  const accounts = canModule(u, 'account')
    ? all(
        `select a.id, a.name, a.industry, a.level from accounts a
         where (${accS.sql}) and (a.name like ? or a.short_name like ?) limit 6`,
        ...accS.params, like, like
      )
    : [];

  const oppS = scopeFilter(u, { owner: 'op.owner_id', org: 'op.org_id' });
  const opportunities = canModule(u, 'opportunity')
    ? all(
        `select op.id, op.name, op.amount, op.stage, a.name as account_name from opportunities op
         join accounts a on a.id=op.account_id
         where (${oppS.sql}) and op.name like ? limit 6`,
        ...oppS.params, like
      )
    : [];

  const leadS = scopeFilter(u, { owner: 'l.owner_id', org: 'l.org_id' });
  const leads = canModule(u, 'lead')
    ? all(
        `select l.id, l.name, l.status, l.contact_name from leads l
         where (${leadS.sql}) and (l.name like ? or l.contact_name like ?) limit 6`,
        ...leadS.params, like, like
      )
    : [];

  const ctS = scopeFilter(u, { owner: 'c.owner_id', org: 'c.org_id' });
  const contracts = canModule(u, 'contract')
    ? all(
        `select c.id, c.no, c.title, c.amount, c.status from contracts c
         where (${ctS.sql}) and (c.no like ? or c.title like ?) limit 6`,
        ...ctS.params, like, like
      )
    : [];

  return { accounts, opportunities, leads, contracts };
});
