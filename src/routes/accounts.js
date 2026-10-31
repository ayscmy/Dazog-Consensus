import { GET, POST, PATCH, DELETE, bad, notFound, denied } from '../http.js';
import { all, one, run, tx, nowIso, idOf } from '../db.js';
import { scopeFilter, canEditRecord, canModule, orgChainScope, ROLES } from '../auth.js';
const FIELDS = ['name', 'short_name', 'industry', 'scale', 'region', 'level', 'credit_level', 'owner_id', 'phone', 'website', 'address', 'source', 'status', 'remark', 'parent_id'];
GET('/api/accounts', async ctx => {
  if (!canModule(ctx.user, 'account')) throw denied('无权访问客户');
  const scope = scopeFilter(ctx.user, {
    owner: 'a.owner_id',
    org: 'a.org_id'
  });
  const where = [scope.sql];
  const params = [...scope.params];
  if (ctx.query.q) {
    where.push('(a.name LIKE ? OR a.short_name LIKE ?)');
    params.push(`%${ctx.query.q}%`, `%${ctx.query.q}%`);
  }
  if (ctx.query.industry) {
    where.push('a.industry = ?');
    params.push(ctx.query.industry);
  }
  if (ctx.query.level) {
    where.push('a.level = ?');
    params.push(ctx.query.level);
  }
  if (ctx.query.owner) {
    where.push('a.owner_id = ?');
    params.push(Number(ctx.query.owner));
  }
  if (ctx.query.org) {
    where.push("a.org_id IN (SELECT id FROM org_units WHERE path LIKE (SELECT path FROM org_units WHERE id=?) || '%')");
    params.push(Number(ctx.query.org));
  }
  const sql = where.join(' and ');
  const rows = await all(`select a.*, u.name as owner_name, o.name as org_name,
            (select count(*) from contacts c where c.account_id=a.id) as contact_count,
            (select count(*) from opportunities op where op.account_id=a.id and op.stage not in ('won','lost')) as open_opps,
            (select coalesce(sum(op.amount),0) from opportunities op where op.account_id=a.id and op.stage='won') as won_amount
     from accounts a left join users u on u.id=a.owner_id left join org_units o on o.id=a.org_id
     where ${sql} order by a.level, a.updated_at desc limit 500`, ...params);
  const stats = (await one(`select count(*) total, sum(case when level='A' then 1 else 0 end) a_count
     from accounts a where ${sql}`, ...params)) || {
    total: 0,
    a_count: 0
  };
  stats.signed_amount = (await one(`select coalesce(sum(amount),0) v from contracts where status='active'
     and account_id in (select id from accounts a where ${scope.sql})`, ...scope.params)).v;
  return {
    rows,
    stats
  };
});
GET('/api/accounts/:id', async ctx => {
  const a = await one(`select a.*, u.name as owner_name, o.name as org_name from accounts a
     left join users u on u.id=a.owner_id left join org_units o on o.id=a.org_id where a.id=?`, ctx.params.id);
  if (!a) throw notFound('客户不存在');
  if (!(await canEditRecord(ctx.user, a))) throw denied('无权查看该客户');
  a.contacts = await all('select * from contacts where account_id=? order by is_primary desc, id', a.id);
  a.opportunities = await all(`select op.*, u.name as owner_name from opportunities op left join users u on u.id=op.owner_id
     where op.account_id=? order by op.stage, op.updated_at desc`, a.id);
  a.contracts = await all('select c.*, u.name as owner_name from contracts c left join users u on u.id=c.owner_id where c.account_id=? order by c.id desc', a.id);
  a.activities = await all(`select ac.*, u.name as user_name from activities ac left join users u on u.id=ac.user_id
     where (ac.target_type='account' and ac.target_id=?) or (ac.target_type='opportunity' and ac.target_id in (select id from opportunities where account_id=?))
     order by ac.created_at desc limit 20`, a.id, a.id);
  a.summary = await one(`select coalesce((select sum(amount) from contracts where account_id=? and status='active'),0) signed,
            coalesce((select sum(amount) from invoices where account_id=? and status='issued'),0) invoiced,
            coalesce((select sum(amount) from payments where account_id=?),0) received,
            coalesce((select sum(amount) from opportunities where account_id=? and stage not in ('won','lost')),0) pipeline`, a.id, a.id, a.id, a.id);
  return a;
});
POST('/api/accounts', async ctx => {
  if (!canModule(ctx.user, 'account')) throw denied('无权创建客户');
  const b = ctx.body || {};
  if (!b.name) throw bad('请填写客户名称');
  const ownerId = Number(b.owner_id || ctx.user.id);
  const owner = await one('select id, org_id from users where id=?', ownerId);
  if (!owner) throw bad('负责人不存在');
  if (ctx.user.scope === 'self' && ownerId !== ctx.user.id) throw denied('只能创建自己负责的客户');
  const r = await run(`insert into accounts(name,short_name,industry,scale,region,level,credit_level,owner_id,org_id,phone,website,address,source,status,remark,created_by,created_at,updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, b.name, b.short_name || b.name, b.industry, b.scale, b.region, b.level || 'B', b.credit_level || 'A', ownerId, owner.org_id, b.phone, b.website, b.address, b.source, 'active', b.remark, ctx.user.id, nowIso(), nowIso());
  return {
    id: idOf(r)
  };
});

/* ---------------- 客户转让（换负责人 / 离职交接） ---------------- */

async function checkTransferTarget(ctx, ownerId) {
  const owner = await one(`select u.id, u.name, u.org_id, u.status,
            (select group_concat(role) from user_roles where user_id=u.id) as roles
     from users u where u.id=?`, ownerId);
  if (!owner) throw bad('接收人不存在');
  if (owner.status === 'left') throw bad(`该账号已离职，不能接收客户`);
  if (owner.status !== 'active') throw bad('接收人必须是在职账号');
  const roles = String(owner.roles || '').split(',').filter(Boolean);
  const canOwn = roles.some(r => {
    const mods = ROLES[r]?.modules || [];
    return mods.includes('*') || mods.includes('account');
  });
  if (!canOwn) throw bad('该用户没有客户模块权限，不能接收客户');
  const scope = orgChainScope(ctx.user, 'u.org_id');
  const ok = await one(`select u.id from users u where u.id=? and ${scope.sql}`, owner.id, ...scope.params);
  if (!ok) throw denied('接收人不在你的组织范围内，不能跨部门转让');
  return owner;
}
async function transferAccounts(ctx, ids, ownerId, withOpps) {
  if (!ids.length) throw bad('请选择要转让的客户');
  const owner = await checkTransferTarget(ctx, ownerId);
  const operator = ctx.user;
  let accounts = 0;
  let opportunities = 0;
  const skipped = [];
  await tx(async () => {
    for (const id of ids) {
      const a = await one('select * from accounts where id=?', id);
      if (!a) {
        skipped.push({
          id,
          reason: '客户不存在'
        });
        continue;
      }
      if (!(await canEditRecord(operator, a))) {
        skipped.push({
          id,
          name: a.name,
          reason: '无权转让'
        });
        continue;
      }
      if (Number(a.owner_id) === Number(owner.id)) {
        skipped.push({
          id,
          name: a.name,
          reason: '负责人已是该用户'
        });
        continue;
      }
      await run('update accounts set owner_id=?, org_id=?, updated_at=? where id=?', owner.id, owner.org_id, nowIso(), a.id);
      accounts++;
      if (withOpps) {
        opportunities += Number((await run(`update opportunities set owner_id=?, updated_at=? where account_id=? and stage not in ('won','lost')`, owner.id, nowIso(), a.id)).changes || 0);
      }
      await run(`insert into activities(target_type,target_id,type,content,result,user_id,created_at)
         values('account', ?, 'note', ?, 'done', ?, ?)`, a.id, `客户负责人变更：${a.owner_id ? (await one('select name from users where id=?', a.owner_id))?.name || '—' : '—'} → ${owner.name}`, operator.id, nowIso());
    }
  });
  return {
    ok: true,
    transferred: {
      accounts,
      opportunities
    },
    skipped,
    owner: {
      id: owner.id,
      name: owner.name
    },
    message: `已转让 ${accounts} 个客户${withOpps ? `、${opportunities} 个进行中商机` : ''}给 ${owner.name}`
  };
}
POST('/api/accounts/bulk-transfer', async ctx => {
  if (!canModule(ctx.user, 'account')) throw denied('无权转让客户');
  const b = ctx.body || {};
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean);
  if (!b.owner_id) throw bad('请选择接收人');
  return await transferAccounts(ctx, ids, Number(b.owner_id), b.with_opportunities !== false);
});
POST('/api/accounts/:id/transfer', async ctx => {
  if (!canModule(ctx.user, 'account')) throw denied('无权转让客户');
  const b = ctx.body || {};
  if (!b.owner_id) throw bad('请选择接收人');
  return await transferAccounts(ctx, [Number(ctx.params.id)], Number(b.owner_id), b.with_opportunities !== false);
});
PATCH('/api/accounts/:id', async ctx => {
  const a = await one('select * from accounts where id=?', ctx.params.id);
  if (!a) throw notFound('客户不存在');
  if (!(await canEditRecord(ctx.user, a))) throw denied('只能修改自己负责的客户');
  const b = ctx.body || {};
  const sets = [];
  const params = [];
  for (const f of FIELDS) if (b[f] !== undefined) {
    sets.push(`${f}=?`);
    params.push(b[f]);
  }
  if (!sets.length) return {
    ok: true
  };
  sets.push('updated_at=?');
  params.push(nowIso(), a.id);
  await run(`update accounts set ${sets.join(',')} where id=?`, ...params);
  return {
    ok: true
  };
});
DELETE('/api/accounts/:id', async ctx => {
  const a = await one('select * from accounts where id=?', ctx.params.id);
  if (!a) throw notFound('客户不存在');
  if (ctx.user.role !== 'admin') throw denied('只有系统管理员可以删除客户');
  const refs = await one('select (select count(*) from opportunities where account_id=?) o, (select count(*) from contracts where account_id=?) c', a.id, a.id);
  if (refs.o > 0 || refs.c > 0) throw bad('该客户已有商机或合同，不能删除');
  await run('delete from accounts where id=?', a.id);
  return {
    ok: true
  };
});

/* ---------------- 联系人 ---------------- */

POST('/api/accounts/:id/contacts', async ctx => {
  const a = await one('select * from accounts where id=?', ctx.params.id);
  if (!a) throw notFound('客户不存在');
  if (!(await canEditRecord(ctx.user, a))) throw denied('无权为该客户添加联系人');
  const b = ctx.body || {};
  if (!b.name) throw bad('请填写联系人姓名');
  const r = await run(`insert into contacts(account_id,name,title,dept,phone,email,wechat,role_type,is_primary,remark,created_by,created_at,updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?)`, a.id, b.name, b.title, b.dept, b.phone, b.email, b.wechat, b.role_type || 'influencer', b.is_primary ? 1 : 0, b.remark, ctx.user.id, nowIso(), nowIso());
  return {
    id: idOf(r)
  };
});
PATCH('/api/contacts/:id', async ctx => {
  const c = await one('select * from contacts where id=?', ctx.params.id);
  if (!c) throw notFound('联系人不存在');
  const a = await one('select * from accounts where id=?', c.account_id);
  if (!(await canEditRecord(ctx.user, a))) throw denied('无权修改该联系人');
  const b = ctx.body || {};
  const fields = ['name', 'title', 'dept', 'phone', 'email', 'wechat', 'role_type', 'is_primary', 'remark'];
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
  params.push(nowIso(), c.id);
  await run(`update contacts set ${sets.join(',')} where id=?`, ...params);
  return {
    ok: true
  };
});
DELETE('/api/contacts/:id', async ctx => {
  const c = await one('select * from contacts where id=?', ctx.params.id);
  if (!c) throw notFound('联系人不存在');
  const a = await one('select * from accounts where id=?', c.account_id);
  if (!(await canEditRecord(ctx.user, a))) throw denied('无权删除该联系人');
  await run('delete from contacts where id=?', c.id);
  return {
    ok: true
  };
});