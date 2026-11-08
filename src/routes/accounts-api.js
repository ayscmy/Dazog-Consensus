import { GET, POST, PATCH, bad, notFound } from '../http.js';
import { all, one, run, nowIso, idOf } from '../db.js';
import { requireScope, auditApi } from '../api-auth.js';
import { apiInOrg } from '../pool.js';

/**
 * 对外开放的客户档案接口（v1），供官网客户数据库双向同步。
 * 范式完全镜像 leads-api.js：API 密钥 + IP 白名单鉴权、组织作用域、external_id 幂等。
 *
 * 防回环：官网推来的 external_id='dir:<directory_id>' 命中即 duplicated，绝不重复建；
 * 官网拉取回流时据此判断只更新不新建（见官网 docs/12 §3/§8.2）。
 */

const TEXT_MAX = 500;
const ok = (ctx, data, status) => {
  if (status) ctx.res.statusCode = status;
  return { ok: true, data };
};

const apiGet = (path, handler) => GET(path, handler, { auth: 'api' });
const apiPost = (path, handler) => POST(path, handler, { auth: 'api' });
const apiPatch = (path, handler) => PATCH(path, handler, { auth: 'api' });

function str(v, max = TEXT_MAX) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

/** 接入方能看到 / 写入的组织范围 */
function scopeSql(client, alias = 'a') {
  if (!client.org_id) return { sql: '1=1', params: [] };
  return {
    sql: `${alias}.org_id IN (SELECT id FROM org_units WHERE path LIKE (SELECT path FROM org_units WHERE id = ?) || '%')`,
    params: [client.org_id],
  };
}
async function inScope(client, account) {
  if (!account) return false;
  if (!client.org_id) return true;
  const org = await one('select path from org_units where id = ?', account.org_id);
  const base = await one('select path from org_units where id = ?', client.org_id);
  return Boolean(org && base && org.path.startsWith(base.path));
}

const SELECT_ACCOUNT = `select a.*, o.name as org_name
  from accounts a
  left join org_units o on o.id = a.org_id`;

function accountView(a) {
  return {
    id: a.id,
    external_id: a.external_id || null,
    name: a.name,
    short_name: a.short_name || null,
    industry: a.industry || null,
    scale: a.scale || null,
    region: a.region || null,
    level: a.level || null,
    credit_level: a.credit_level || null,
    phone: a.phone || null,
    website: a.website || null,
    address: a.address || null,
    source: a.source || null,
    status: a.status,
    remark: a.remark || null,
    org_id: a.org_id,
    org_name: a.org_name || null,
    owner_id: a.owner_id || null,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}

async function loadAccount(client, id) {
  const a = await one(`${SELECT_ACCOUNT} where a.id = ?`, Number(id) || 0);
  if (!a || !(await inScope(client, a))) throw notFound('客户不存在');
  return a;
}

/* ============================ 查询 ============================ */

apiGet('/api/v1/accounts', async ctx => {
  requireScope(ctx.client, 'account:read');
  const q = ctx.query;
  const since = q.since ? String(q.since).slice(0, 60) : '';
  const limit = Math.min(Number(q.limit) || 200, 500);
  const sc = scopeSql(ctx.client, 'a');
  const rows = await all(
    `select a.*, o.name as org_name
       from accounts a left join org_units o on o.id = a.org_id
      where ${sc.sql} and (a.updated_at > ? or ? = '')
      order by a.updated_at asc limit ?`,
    ...sc.params, since, since, limit
  );
  const items = rows.map(accountView);
  const nextSince = items.length ? items[items.length - 1].updated_at : (since || nowIso());
  return ok(ctx, { items, nextSince, count: items.length });
});

apiGet('/api/v1/accounts/:id', async ctx => {
  requireScope(ctx.client, 'account:read');
  const a = await loadAccount(ctx.client, ctx.params.id);
  return ok(ctx, accountView(a));
});

/* ============================ 写入 ============================ */

apiPost('/api/v1/accounts', async ctx => {
  requireScope(ctx.client, 'account:write');
  const b = ctx.body || {};
  const externalId = str(b.external_id, 64);
  if (externalId) {
    const exist = await one('select * from accounts where external_id = ?', externalId);
    if (exist && (await inScope(ctx.client, exist))) {
      const same = await one(`${SELECT_ACCOUNT} where a.id = ?`, exist.id);
      return ok(ctx, { ...accountView(same), duplicated: true }, 200);
    }
  }
  const name = str(b.name, 200);
  if (!name) throw bad('name（客户名称）不能为空');

  const orgId = ctx.client.org_id || (await apiInOrg(ctx.client));
  const now = nowIso();
  const r = await run(
    `insert into accounts(name, short_name, industry, scale, region, level, phone, website, address, source, remark, external_id, org_id, created_by, created_at, updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    name,
    str(b.short_name), str(b.industry), str(b.scale), str(b.region), str(b.level),
    str(b.phone), str(b.website), str(b.address),
    str(b.source || '官网客户库'), str(b.description || b.remark),
    externalId || null, orgId, ctx.client.owner_id || null, now, now
  );
  const id = idOf(r);
  if (b.contact_name) {
    await run(
      `insert into contacts(account_id, name, title, phone, email, is_primary, created_by, created_at, updated_at)
       values(?,?,?,?,?,1,?,?,?)`,
      id, str(b.contact_name), str(b.contact_title), str(b.contact_phone), str(b.contact_email),
      ctx.client.owner_id || null, now, now
    );
  }
  await auditApi(ctx, 'POST /api/v1/accounts', 'account', id, { name, external_id: externalId });
  const saved = await one(`${SELECT_ACCOUNT} where a.id = ?`, id);
  return ok(ctx, { ...accountView(saved), duplicated: false }, 201);
});

apiPatch('/api/v1/accounts/:id', async ctx => {
  requireScope(ctx.client, 'account:write');
  const a = await loadAccount(ctx.client, ctx.params.id);
  const b = ctx.body || {};
  const fields = {};
  for (const f of ['name', 'short_name', 'industry', 'scale', 'region', 'level', 'phone', 'website', 'address', 'source', 'remark']) {
    if (b[f] !== undefined) fields[f] = str(b[f]);
  }
  if (b.description !== undefined) fields.remark = str(b.description);
  if (!Object.keys(fields).length) return ok(ctx, accountView(a));
  const cols = Object.keys(fields);
  await run(
    `update accounts set ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? where id = ?`,
    ...Object.values(fields), nowIso(), a.id
  );
  await auditApi(ctx, 'PATCH /api/v1/accounts', 'account', a.id, fields);
  const saved = await one(`${SELECT_ACCOUNT} where a.id = ?`, a.id);
  return ok(ctx, accountView(saved));
});
