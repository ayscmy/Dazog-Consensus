import { GET, POST, PATCH, DELETE, bad, notFound, denied } from '../http.js';
import { all, one, run, tx, nowIso, idOf, today, dateLtToday } from '../db.js';
import { scopeFilter, canEditRecord, canModule } from '../auth.js';
const EDITABLE = ['name', 'contact_name', 'contact_title', 'contact_phone', 'contact_email', 'source', 'industry', 'region', 'demand', 'budget', 'purchase_time', 'next_action', 'next_date', 'score', 'owner_id'];
function listWhere(user, q) {
  const scope = scopeFilter(user, {
    owner: 'l.owner_id',
    org: 'l.org_id'
  });
  // 自己负责的 + 已转成自己商机的（业务员需要看到线索来源）
  const where = [`(${scope.sql} or exists (select 1 from opportunities op where op.lead_id = l.id and op.owner_id = ?))`];
  const params = [...scope.params, user.id];
  if (q.status) {
    where.push('l.status = ?');
    params.push(q.status);
  }
  if (q.owner) {
    where.push('l.owner_id = ?');
    params.push(Number(q.owner));
  }
  if (q.org) {
    where.push('l.org_id IN (SELECT id FROM org_units WHERE path LIKE (SELECT path FROM org_units WHERE id=?) || \'%\')');
    params.push(Number(q.org));
  }
  if (q.source) {
    where.push('l.source = ?');
    params.push(q.source);
  }
  if (q.q) {
    where.push('(l.name LIKE ? OR l.contact_name LIKE ? OR l.contact_phone LIKE ?)');
    const like = `%${q.q}%`;
    params.push(like, like, like);
  }
  if (q.mine === '1') {
    where.push('l.owner_id = ?');
    params.push(user.id);
  }
  if (q.overdue === '1') {
    where.push(`${dateLtToday('l.next_date')} and l.status not in ('converted','invalid')`);
  }
  return {
    sql: where.join(' and '),
    params
  };
}
GET('/api/leads', async ctx => {
  if (!canModule(ctx.user, 'lead')) throw denied('无权访问线索');
  const {
    sql,
    params
  } = listWhere(ctx.user, ctx.query);
  const rows = await all(`select l.*, u.name as owner_name, o.name as org_name, a.name as account_name
     from leads l
     left join users u on u.id = l.owner_id
     left join org_units o on o.id = l.org_id
     left join accounts a on a.id = l.account_id
     where ${sql}
     order by case l.status when 'new' then 0 when 'contacted' then 1 when 'qualified' then 2 else 3 end,
              coalesce(l.next_date, l.updated_at) asc
     limit 500`, ...params);
  const stats = await one(`select count(*) total,
            coalesce(sum(case when status='new' then 1 else 0 end),0) unclaimed,
            coalesce(sum(case when status in ('new','contacted') then 1 else 0 end),0) active,
            coalesce(sum(case when status='converted' then 1 else 0 end),0) converted,
            coalesce(sum(case when status='invalid' then 1 else 0 end),0) invalid
     from leads l where ${sql}`, ...params);
  return {
    rows,
    stats
  };
});
GET('/api/leads/:id', async ctx => {
  const l = await one(`select l.*, u.name as owner_name, o.name as org_name, a.name as account_name
     from leads l left join users u on u.id=l.owner_id
     left join org_units o on o.id=l.org_id left join accounts a on a.id=l.account_id
     where l.id = ?`, ctx.params.id);
  if (!l) throw notFound('线索不存在');
  const mineOpp = l.opportunity_id ? await one('select owner_id from opportunities where id=?', l.opportunity_id) : null;
  if (!(await canEditRecord(ctx.user, l)) && !(mineOpp && Number(mineOpp.owner_id) === ctx.user.id)) {
    throw denied('无权查看该线索');
  }
  l.activities = await all(`select a.*, u.name as user_name from activities a left join users u on u.id=a.user_id
     where a.target_type='lead' and a.target_id=? order by a.created_at desc`, l.id);
  return l;
});
POST('/api/leads', async ctx => {
  if (!canModule(ctx.user, 'lead')) throw denied('无权创建线索');
  const b = ctx.body || {};
  if (!b.name) throw bad('请填写线索名称');
  const ownerId = Number(b.owner_id || ctx.user.id);
  const owner = await one('select id, org_id from users where id = ?', ownerId);
  if (!owner) throw bad('负责人不存在');
  if (ctx.user.scope === 'self' && ownerId !== ctx.user.id) throw denied('只能为自己创建线索');
  const r = await run(`insert into leads(name,contact_name,contact_title,contact_phone,contact_email,source,industry,region,demand,budget,purchase_time,next_action,next_date,status,score,owner_id,org_id,created_by,created_at,updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, b.name, b.contact_name, b.contact_title, b.contact_phone, b.contact_email, b.source, b.industry, b.region, b.demand, b.budget, b.purchase_time, b.next_action || '首次电话沟通', b.next_date || today(1), 'new', Number(b.score || 50), ownerId, owner.org_id, ctx.user.id, nowIso(), nowIso());
  return {
    id: idOf(r)
  };
});
PATCH('/api/leads/:id', async ctx => {
  const l = await one('select * from leads where id = ?', ctx.params.id);
  if (!l) throw notFound('线索不存在');
  if (!(await canEditRecord(ctx.user, l))) throw denied('只能修改自己负责的线索');
  const b = ctx.body || {};
  const sets = [];
  const params = [];
  for (const f of EDITABLE) {
    if (b[f] !== undefined) {
      sets.push(`${f} = ?`);
      params.push(b[f]);
    }
  }
  if (!sets.length) return {
    ok: true,
    changed: 0
  };
  sets.push('updated_at = ?');
  params.push(nowIso(), l.id);
  await run(`update leads set ${sets.join(', ')} where id = ?`, ...params);
  return {
    ok: true,
    changed: sets.length - 1
  };
});

/** 状态推进：跟进中 / 已确认商机 / 无效 */
POST('/api/leads/:id/status', async ctx => {
  const l = await one('select * from leads where id = ?', ctx.params.id);
  if (!l) throw notFound('线索不存在');
  if (!(await canEditRecord(ctx.user, l))) throw denied('只能操作自己负责的线索');
  const {
    status,
    reason
  } = ctx.body || {};
  const flow = {
    new: ['contacted', 'invalid'],
    contacted: ['qualified', 'invalid'],
    qualified: ['contacted', 'invalid']
  };
  if (!(flow[l.status] || []).includes(status)) throw bad(`不能从「${l.status}」变更为「${status}」`);
  if (status === 'invalid' && !reason) throw bad('标记无效必须填写原因');
  if (status === 'qualified') {
    const missing = [];
    if (!l.demand) missing.push('需求描述');
    if (!l.budget && !l.purchase_time) missing.push('预算或采购时间');
    if (!l.contact_phone) missing.push('联系电话');
    if (missing.length) throw bad(`确认为商机前需补齐：${missing.join('、')}`);
  }
  await run('update leads set status = ?, invalid_reason = ?, updated_at = ?, last_activity_at = ? where id = ?', status, status === 'invalid' ? reason : null, nowIso(), nowIso(), l.id);
  return {
    ok: true,
    status
  };
});

/** 线索转商机：四要素硬校验 */
POST('/api/leads/:id/convert', async ctx => {
  const l = await one('select * from leads where id = ?', ctx.params.id);
  if (!l) throw notFound('线索不存在');
  if (!(await canEditRecord(ctx.user, l))) throw denied('只能转化自己负责的线索');
  if (l.status === 'converted') throw bad('该线索已转化');
  if (l.status === 'invalid') throw bad('无效线索不能转化');
  const b = ctx.body || {};
  const missing = [];
  if (!l.contact_name) missing.push('关键联系人姓名');
  if (!l.contact_title) missing.push('联系人职位');
  if (!l.contact_phone) missing.push('联系人电话');
  if (!l.demand) missing.push('需求描述');
  if (!l.budget && !b.budget) missing.push('预算或采购时间');
  if (!l.next_action) missing.push('下一步动作');
  if (!l.next_date) missing.push('下一步日期');
  if (missing.length) {
    throw bad('转商机前置条件未满足', missing);
  }
  if (!b.amount || Number(b.amount) <= 0) throw bad('请填写商机预计金额');

  // 转出后交给谁：默认线索负责人，SDR 可指定本公司内的业务员
  const ownerId = Number(b.owner_id || l.owner_id);
  const owner = await one('select id, org_id from users where id = ?', ownerId);
  if (!owner) throw bad('商机负责人不存在');
  const companyPath = p => '/' + String(p).split('/').filter(Boolean).slice(0, 2).join('/') + '/';
  const ownerOrg = await one('select path from org_units where id = ?', owner.org_id);
  const leadOrg = await one('select path from org_units where id = ?', l.org_id);
  if (ctx.user.scope !== 'all' && ownerOrg && leadOrg && companyPath(ownerOrg.path) !== companyPath(leadOrg.path)) {
    throw denied('只能转给本公司内的成员');
  }
  const out = await tx(async () => {
    let accountId = l.account_id;
    let contactId = l.contact_id;
    if (!accountId) {
      const ar = await run(`insert into accounts(name,short_name,industry,region,owner_id,org_id,source,status,created_by,created_at,updated_at)
         values(?,?,?,?,?,?,?,'active',?,?,?)`, l.name, l.name, l.industry, l.region, ownerId, l.org_id, l.source, ctx.user.id, nowIso(), nowIso());
      accountId = idOf(ar);
      const cr = await run(`insert into contacts(account_id,name,title,phone,email,role_type,is_primary,created_by,created_at,updated_at)
         values(?,?,?,?,?,?,1,?,?,?)`, accountId, l.contact_name || '待补充', l.contact_title, l.contact_phone, l.contact_email, 'decision', ctx.user.id, nowIso(), nowIso());
      contactId = idOf(cr);
    }
    const name = b.name || `${l.name} ${l.demand ? l.demand.slice(0, 8) : '商机'}`;
    const or = await run(`insert into opportunities(name,account_id,lead_id,amount,currency,stage,probability,expected_date,owner_id,org_id,source,product_line,evidence,created_by,created_at,updated_at)
       values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, name, accountId, l.id, Number(b.amount), 'CNY', 'lead_in', 10, b.expected_date || today(60), ownerId, l.org_id, l.source, b.product_line || null, '{}', ctx.user.id, nowIso(), nowIso());
    await run(`update leads set status='converted', account_id=?, contact_id=?, opportunity_id=?, updated_at=? where id=?`, accountId, contactId, idOf(or), nowIso(), l.id);
    await run(`insert into activities(target_type,target_id,type,content,result,user_id,created_at)
       values('lead',?,'note',?,?,?,?)`, l.id, `已转为商机：${name}`, `金额 ${Number(b.amount).toLocaleString()} 元`, ctx.user.id, nowIso());
    return {
      opportunityId: idOf(or),
      accountId,
      contactId
    };
  });
  return out;
});
POST('/api/leads/:id/activity', async ctx => {
  const l = await one('select * from leads where id = ?', ctx.params.id);
  if (!l) throw notFound('线索不存在');
  if (!(await canEditRecord(ctx.user, l))) throw denied('只能记录自己负责的线索');
  const b = ctx.body || {};
  if (!b.content) throw bad('请填写跟进内容');
  await run(`insert into activities(target_type,target_id,type,content,result,next_action,next_date,user_id,created_at)
     values('lead',?,?,?,?,?,?,?,?)`, l.id, b.type || 'call', b.content, b.result, b.next_action, b.next_date, ctx.user.id, nowIso());
  await run('update leads set last_activity_at=?, next_action=coalesce(?,next_action), next_date=coalesce(?,next_date), status=case when status=? then ? else status end, updated_at=? where id=?', nowIso(), b.next_action, b.next_date, 'new', 'contacted', nowIso(), l.id);
  return {
    ok: true
  };
});
DELETE('/api/leads/:id', async ctx => {
  const l = await one('select * from leads where id = ?', ctx.params.id);
  if (!l) throw notFound('线索不存在');
  if (ctx.user.role !== 'admin' && !(ctx.user.scope !== 'self' && (await canEditRecord(ctx.user, l)))) {
    throw denied('只有经理及以上可以删除线索');
  }
  await run('delete from leads where id = ?', l.id);
  return {
    ok: true
  };
});