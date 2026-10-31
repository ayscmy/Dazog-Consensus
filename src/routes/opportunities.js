import { GET, POST, PATCH, DELETE, bad, notFound, denied } from '../http.js';
import { all, one, run, tx, nowIso, idOf, today } from '../db.js';
import { scopeFilter, canEditRecord, canModule } from '../auth.js';
import { OPP_STAGES } from '../dict.js';
const STAGE_ORDER = OPP_STAGES.map(s => s.key);
const stageMeta = k => OPP_STAGES.find(s => s.key === k) || {};
async function loadOpp(id) {
  return await one(`select op.*, a.name as account_name, a.industry, a.level as account_level,
            u.name as owner_name, o.name as org_name, l.name as lead_name
     from opportunities op
     join accounts a on a.id = op.account_id
     left join users u on u.id = op.owner_id
     left join org_units o on o.id = op.org_id
     left join leads l on l.id = op.lead_id
     where op.id = ?`, id);
}
GET('/api/opportunities', async ctx => {
  if (!canModule(ctx.user, 'opportunity')) throw denied('无权访问商机');
  const scope = scopeFilter(ctx.user, {
    owner: 'op.owner_id',
    org: 'op.org_id'
  });
  const where = [scope.sql];
  const params = [...scope.params];
  if (ctx.query.stage) {
    where.push('op.stage = ?');
    params.push(ctx.query.stage);
  }
  if (ctx.query.owner) {
    where.push('op.owner_id = ?');
    params.push(Number(ctx.query.owner));
  }
  if (ctx.query.account) {
    where.push('op.account_id = ?');
    params.push(Number(ctx.query.account));
  }
  if (ctx.query.q) {
    where.push('(op.name LIKE ? OR a.name LIKE ?)');
    params.push(`%${ctx.query.q}%`, `%${ctx.query.q}%`);
  }
  if (ctx.query.org) {
    where.push("op.org_id IN (SELECT id FROM org_units WHERE path LIKE (SELECT path FROM org_units WHERE id=?) || '%')");
    params.push(Number(ctx.query.org));
  }
  if (ctx.query.mine === '1') {
    where.push('op.owner_id = ?');
    params.push(ctx.user.id);
  }
  const sql = where.join(' and ');
  const rows = await all(`select op.*, a.name as account_name, a.industry, u.name as owner_name, o.name as org_name,
            (select count(*) from quotations q where q.opportunity_id=op.id) as quote_count,
            (select count(*) from activities ac where ac.target_type='opportunity' and ac.target_id=op.id) as activity_count
     from opportunities op
     join accounts a on a.id=op.account_id
     left join users u on u.id=op.owner_id
     left join org_units o on o.id=op.org_id
     where ${sql} order by op.updated_at desc limit 600`, ...params);
  const byStage = OPP_STAGES.map(s => {
    const list = rows.filter(r => r.stage === s.key);
    return {
      ...s,
      count: list.length,
      amount: list.reduce((sum, r) => sum + Number(r.amount || 0), 0),
      weighted: list.reduce((sum, r) => sum + Number(r.amount || 0) * Number(r.probability || 0) / 100, 0)
    };
  });
  const open = rows.filter(r => !['won', 'lost'].includes(r.stage));
  return {
    rows,
    byStage,
    stats: {
      openCount: open.length,
      openAmount: open.reduce((s, r) => s + Number(r.amount || 0), 0),
      weighted: open.reduce((s, r) => s + Number(r.amount || 0) * Number(r.probability || 0) / 100, 0),
      wonAmount: rows.filter(r => r.stage === 'won').reduce((s, r) => s + Number(r.amount || 0), 0),
      wonCount: rows.filter(r => r.stage === 'won').length,
      lostCount: rows.filter(r => r.stage === 'lost').length
    }
  };
});
GET('/api/opportunities/:id', async ctx => {
  const op = await loadOpp(ctx.params.id);
  if (!op) throw notFound('商机不存在');
  if (!(await canEditRecord(ctx.user, op))) throw denied('无权查看该商机');
  op.quotations = (await all(`select q.*, u.name as creator_name from quotations q left join users u on u.id=q.created_by
     where q.opportunity_id=? order by q.version desc, q.id desc`, op.id)).map(q => {
    // 字段级：成本与毛利只对经理及以上/财务开放
    if (!['admin', 'gm', 'director', 'manager', 'finance'].includes(ctx.user.role)) {
      delete q.cost;
      q.gross_margin = null;
    } else {
      q.gross_margin = q.amount ? (q.amount - q.cost) / q.amount : 0;
    }
    return q;
  });
  op.contracts = await all('select * from contracts where opportunity_id=? order by id desc', op.id);
  op.contacts = await all('select * from contacts where account_id=? order by is_primary desc', op.account_id);
  op.activities = await all(`select ac.*, u.name as user_name from activities ac left join users u on u.id=ac.user_id
     where (ac.target_type='opportunity' and ac.target_id=?) or (ac.target_type='quotation' and ac.target_id in (select id from quotations where opportunity_id=?))
     order by ac.created_at desc limit 40`, op.id, op.id);
  op.evidence = JSON.parse(op.evidence || '{}');
  return op;
});
POST('/api/opportunities', async ctx => {
  if (!canModule(ctx.user, 'opportunity')) throw denied('无权创建商机');
  const b = ctx.body || {};
  if (!b.name) throw bad('请填写商机名称');
  if (!b.account_id) throw bad('请选择客户');
  if (!(Number(b.amount) > 0)) throw bad('请填写商机金额');
  const account = await one('select * from accounts where id=?', b.account_id);
  if (!account) throw bad('客户不存在');
  if (!(await canEditRecord(ctx.user, account, {
    ownerField: 'owner_id',
    orgField: 'org_id'
  }))) throw denied('无权在该客户下创建商机');
  const ownerId = Number(b.owner_id || ctx.user.id);
  const owner = await one('select id, org_id from users where id=?', ownerId);
  if (!owner) throw bad('负责人不存在');
  const r = await run(`insert into opportunities(name,account_id,lead_id,amount,currency,stage,probability,expected_date,owner_id,org_id,source,product_line,competitor,evidence,created_by,created_at,updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, b.name, account.id, b.lead_id || null, Number(b.amount), 'CNY', 'lead_in', 10, b.expected_date || today(60), ownerId, owner.org_id, b.source || account.source, b.product_line, b.competitor, '{}', ctx.user.id, nowIso(), nowIso());
  return {
    id: idOf(r)
  };
});
PATCH('/api/opportunities/:id', async ctx => {
  const op = await loadOpp(ctx.params.id);
  if (!op) throw notFound('商机不存在');
  if (!(await canEditRecord(ctx.user, op))) throw denied('只能修改自己负责的商机');
  const b = ctx.body || {};
  const fields = ['name', 'amount', 'expected_date', 'owner_id', 'product_line', 'competitor', 'source'];
  const sets = [];
  const params = [];
  for (const f of fields) if (b[f] !== undefined) {
    sets.push(`${f}=?`);
    params.push(b[f]);
  }
  if (!sets.length) return {
    ok: true
  };
  sets.push('updated_at=?');
  params.push(nowIso(), op.id);
  await run(`update opportunities set ${sets.join(',')} where id=?`, ...params);
  return {
    ok: true
  };
});

/** 阶段推进：每个阶段必须有证据，缺什么直接告知 */
POST('/api/opportunities/:id/stage', async ctx => {
  const op = await loadOpp(ctx.params.id);
  if (!op) throw notFound('商机不存在');
  if (!(await canEditRecord(ctx.user, op))) throw denied('只能推进自己负责的商机');
  const b = ctx.body || {};
  const target = b.stage;
  if (!STAGE_ORDER.includes(target)) throw bad('非法的阶段');
  if (target === op.stage) return {
    ok: true,
    stage: target
  };
  const ev = JSON.parse(op.evidence || '{}');
  const missing = [];
  if (target === 'needs') {
    if (!b.need && !ev.need) missing.push('客户需求确认（痛点与业务范围）');
    if (!b.budget && !ev.budget) missing.push('预算情况');
  }
  if (target === 'proposal') {
    const dm = (await one("select count(*) c from contacts where account_id=? and role_type='decision'", op.account_id)).c;
    if (!dm) missing.push('至少 1 位决策人联系人（角色=决策人）');
    if (!ev.need && !b.need) missing.push('需求确认');
    if (!ev.budget && !b.budget) missing.push('预算确认');
  }
  if (target === 'negotiation') {
    const approved = (await one("select count(*) c from quotations where opportunity_id=? and status='approved'", op.id)).c;
    if (!approved) missing.push('已批准的报价单（需先走折扣审批）');
  }
  if (target === 'won') {
    const active = (await one("select count(*) c from contracts where opportunity_id=? and status='active'", op.id)).c;
    if (!active) missing.push('已生效的合同（合同三关审批通过后自动赢单）');
    if (!b.won_reason && !op.won_reason) missing.push('赢单原因');
  }
  if (target === 'lost' && !b.lost_reason) {
    missing.push('输单原因');
  }

  // 不允许跳过阶段（lost 可随时结束）
  const from = STAGE_ORDER.indexOf(op.stage);
  const to = STAGE_ORDER.indexOf(target);
  if (target !== 'lost' && !['won'].includes(op.stage) && to > from + 1) {
    missing.push(`不能跳过阶段，需先进入「${stageMeta(STAGE_ORDER[from + 1]).label}」`);
  }
  if (missing.length) throw bad('阶段推进条件未满足', missing);
  const meta = stageMeta(target);
  const evidence = {
    ...ev
  };
  if (b.need) evidence.need = b.need;
  if (b.budget) evidence.budget = b.budget;
  if (b.note) evidence.note = b.note;
  await run(`update opportunities set stage=?, probability=?, evidence=?, won_reason=?, lost_reason=?,
            won_at=?, lost_at=?, updated_at=? where id=?`, target, meta.prob, JSON.stringify(evidence), target === 'won' ? b.won_reason || op.won_reason : op.won_reason, target === 'lost' ? b.lost_reason : op.lost_reason, target === 'won' ? nowIso() : op.won_at, target === 'lost' ? nowIso() : op.lost_at, nowIso(), op.id);
  await run(`insert into activities(target_type,target_id,type,content,result,user_id,created_at)
     values('opportunity',?,'stage',?,?,?,?)`, op.id, `阶段推进：${stageMeta(op.stage).label} → ${meta.label}`, b.note || b.won_reason || b.lost_reason || '', ctx.user.id, nowIso());
  return {
    ok: true,
    stage: target
  };
});
POST('/api/opportunities/:id/activity', async ctx => {
  const op = await loadOpp(ctx.params.id);
  if (!op) throw notFound('商机不存在');
  if (!(await canEditRecord(ctx.user, op))) throw denied('只能记录自己负责的商机');
  const b = ctx.body || {};
  if (!b.content) throw bad('请填写跟进内容');
  await run(`insert into activities(target_type,target_id,type,content,result,next_action,next_date,user_id,created_at)
     values('opportunity',?,?,?,?,?,?,?,?)`, op.id, b.type || 'call', b.content, b.result, b.next_action, b.next_date, ctx.user.id, nowIso());
  await run('update opportunities set updated_at=? where id=?', nowIso(), op.id);
  return {
    ok: true
  };
});
DELETE('/api/opportunities/:id', async ctx => {
  const op = await loadOpp(ctx.params.id);
  if (!op) throw notFound('商机不存在');
  if (!['admin', 'gm'].includes(ctx.user.role)) throw denied('只有管理员或总经理可以删除商机');
  const refs = await one('select (select count(*) from quotations where opportunity_id=?) q, (select count(*) from contracts where opportunity_id=?) c', op.id, op.id);
  if (refs.q || refs.c) throw bad('该商机已有报价或合同，不能删除');
  await run('delete from opportunities where id=?', op.id);
  return {
    ok: true
  };
});