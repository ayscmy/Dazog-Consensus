import { GET, POST, PATCH, DELETE, bad, notFound, denied } from '../http.js';
import { all, one, run, nowIso, idOf } from '../db.js';
import { canModule, canEditRecord } from '../auth.js';
import { getSettings, canUseCustomItem } from '../settings.js';
const CAN_EDIT = ['admin', 'gm'];
function shape(p, user) {
  const out = {
    ...p
  };
  if (!['admin', 'gm', 'director', 'manager', 'finance'].includes(user.role)) {
    delete out.cost;
    delete out.min_price;
    out.gross_margin = null;
  } else {
    out.gross_margin = p.list_price ? (p.list_price - p.cost) / p.list_price : 0;
  }
  return out;
}
GET('/api/products', async ctx => {
  if (!canModule(ctx.user, 'product') && !canModule(ctx.user, 'quotation')) throw denied('无权查看产品');
  const where = ['1=1'];
  const params = [];
  if (ctx.query.status) {
    where.push('status = ?');
    params.push(ctx.query.status);
  } else if (ctx.query.all !== '1') {
    where.push("status = 'active'");
  }
  if (ctx.query.category) {
    where.push('category = ?');
    params.push(ctx.query.category);
  }
  if (ctx.query.q) {
    where.push('(name LIKE ? OR code LIKE ? OR spec LIKE ?)');
    const like = `%${ctx.query.q}%`;
    params.push(like, like, like);
  }
  const rows = (await all(`select * from products where ${where.join(' and ')} order by category, code limit 500`, ...params)).map(p => shape(p, ctx.user));
  const categories = [...new Set((await all("select distinct category from products where category is not null and category != ''")).map(r => r.category))];
  return {
    rows,
    categories,
    stats: {
      total: rows.length,
      active: rows.filter(r => r.status === 'active').length,
      categories: categories.length,
      avgPrice: rows.length ? rows.reduce((s, r) => s + Number(r.list_price || 0), 0) / rows.length : 0
    },
    canEdit: CAN_EDIT.includes(ctx.user.role)
  };
});
GET('/api/products/:id', async ctx => {
  if (!canModule(ctx.user, 'product') && !canModule(ctx.user, 'quotation')) throw denied('无权查看产品');
  const p = await one('select * from products where id = ?', ctx.params.id);
  if (!p) throw notFound('产品不存在');
  return shape(p, ctx.user);
});
POST('/api/products', async ctx => {
  if (!CAN_EDIT.includes(ctx.user.role)) throw denied('只有管理员或总经理可以维护产品');
  const b = ctx.body || {};
  if (!b.name) throw bad('请填写产品名称');
  if (!(Number(b.list_price) > 0)) throw bad('请填写标准价');
  const dup = await one('select id from products where code = ?', b.code || '');
  if (b.code && dup) throw bad('产品编码已存在');
  const code = b.code || `P${String(Date.now()).slice(-8)}`;
  const r = await run(`insert into products(code,name,category,spec,unit,list_price,cost,min_price,status,remark,org_id,created_by,created_at,updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, code, b.name, b.category || null, b.spec || null, b.unit || '套', Number(b.list_price || 0), Number(b.cost || 0), b.min_price === undefined || b.min_price === null || b.min_price === '' ? null : Number(b.min_price), b.status || 'active', b.remark || null, ctx.user.org_id || null, ctx.user.id, nowIso(), nowIso());
  return {
    id: idOf(r),
    code
  };
});
PATCH('/api/products/:id', async ctx => {
  if (!CAN_EDIT.includes(ctx.user.role)) throw denied('只有管理员或总经理可以维护产品');
  const p = await one('select * from products where id = ?', ctx.params.id);
  if (!p) throw notFound('产品不存在');
  const b = ctx.body || {};
  if (b.code && b.code !== p.code) {
    const dup = await one('select id from products where code = ? and id != ?', b.code, p.id);
    if (dup) throw bad('产品编码已存在');
  }
  const fields = ['code', 'name', 'category', 'spec', 'unit', 'list_price', 'cost', 'min_price', 'status', 'remark'];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (b[f] !== undefined) {
      sets.push(`${f} = ?`);
      params.push(f === 'min_price' && (b[f] === '' || b[f] === null) ? null : b[f]);
    }
  }
  if (!sets.length) return {
    ok: true,
    changed: 0
  };
  sets.push('updated_at = ?');
  params.push(nowIso(), p.id);
  await run(`update products set ${sets.join(', ')} where id = ?`, ...params);
  return {
    ok: true
  };
});
DELETE('/api/products/:id', async ctx => {
  if (!CAN_EDIT.includes(ctx.user.role)) throw denied('只有管理员或总经理可以维护产品');
  const p = await one('select * from products where id = ?', ctx.params.id);
  if (!p) throw notFound('产品不存在');
  // 已被报价引用则只停用，保持历史报价可追溯
  const used = await one('select count(*) c from quotation_items where product_id = ?', p.id);
  if (used && used.c > 0) {
    await run("update products set status='inactive', updated_at=? where id=?", nowIso(), p.id);
    return {
      ok: true,
      deactivated: true,
      used: used.c
    };
  }
  await run('delete from products where id = ?', p.id);
  return {
    ok: true,
    deleted: true
  };
});

/** 报价弹窗需要的全部元信息：产品、开关、阈值 */
GET('/api/quote-options', async ctx => {
  if (!canModule(ctx.user, 'quotation')) throw denied('无权报价');
  const s = await getSettings();
  const products = (await all("select * from products where status = 'active' order by category, code")).map(p => shape(p, ctx.user));
  return {
    products,
    canCustom: await canUseCustomItem(ctx.user),
    role: ctx.user.role,
    allowCustomGlobal: s['quote.allow_custom'] === '1',
    thresholds: {
      manager: Number(s['approve.discount.manager'] || 5),
      director: Number(s['approve.discount.director'] || 10)
    },
    myDiscountLimit: ctx.user.discount_limit ?? null,
    skipNoDiscount: s['quote.skip_approval_when_no_discount'] === '1',
    validDays: Number(s['quote.valid_days'] || 30)
  };
});