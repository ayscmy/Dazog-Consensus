import { GET, POST, PATCH, bad, notFound } from '../http.js';
import { all, one, run, nowIso, idOf, today } from '../db.js';
import { requireScope, auditApi } from '../api-auth.js';

/**
 * 对外开放的线索接口（v1）。
 *
 * 和界面用的 /api/leads 是两套东西，差别在于：
 *   - 鉴权：API 密钥 + IP 白名单，不看登录态，可以跨域
 *   - 数据范围：只看得到「接入方所属组织」子树内的线索，不会因为密钥泄露看到全集团
 *   - 返回：统一 { ok, data } 信封，字段名和写入字段一一对应，GET 到的能直接 PATCH 回去
 *
 * 幂等：外部系统带 external_id 重复推送时返回原记录（duplicated=true），不会重复建线索。
 */

const TEXT_MAX = 500;
const ACTIVITY_TYPES = ['call', 'visit', 'email', 'meeting', 'note', 'wechat'];
const WRITE_FIELDS = ['name', 'contact_name', 'contact_title', 'contact_phone', 'contact_email', 'source', 'industry', 'region', 'demand', 'budget', 'purchase_time', 'next_action', 'next_date', 'score'];
const ok = (ctx, data, status) => {
  if (status) ctx.res.statusCode = status;
  return {
    ok: true,
    data
  };
};

// 对外接口统一走 API 密钥鉴权（{ auth: 'api' }），不认登录 Cookie
const apiGet = (path, handler) => GET(path, handler, {
  auth: 'api'
});
const apiPost = (path, handler) => POST(path, handler, {
  auth: 'api'
});
const apiPatch = (path, handler) => PATCH(path, handler, {
  auth: 'api'
});
function str(v, max = TEXT_MAX) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function checkDate(v, field) {
  const s = str(v, 10);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(`${field} 需要是 YYYY-MM-DD 格式`);
  return s;
}

/** 接入方能看到 / 写入的组织范围 */
function scopeSql(client, alias = 'l') {
  if (!client.org_id) return {
    sql: '1=1',
    params: []
  };
  return {
    sql: `${alias}.org_id IN (SELECT id FROM org_units WHERE path LIKE (SELECT path FROM org_units WHERE id = ?) || '%')`,
    params: [client.org_id]
  };
}
async function inScope(client, lead) {
  if (!lead) return false;
  if (!client.org_id) return true;
  const org = await one('select path from org_units where id = ?', lead.org_id);
  const base = await one('select path from org_units where id = ?', client.org_id);
  return Boolean(org && base && org.path.startsWith(base.path));
}

/** 新线索的负责人：优先请求里指定，其次接入方默认负责人 */
async function resolveOwner(client, wanted) {
  const id = Number(wanted || 0) || Number(client.owner_id || 0);
  if (!id) {
    throw bad('该接入方没有配置默认线索负责人，请管理员在「API 接入」里设置后再写入');
  }
  const u = await one('select id, name, org_id, status from users where id = ?', id);
  if (!u || u.status !== 'active') throw bad('线索负责人不存在或已停用');
  if (client.org_id) {
    const org = await one('select path from org_units where id = ?', u.org_id);
    const base = await one('select path from org_units where id = ?', client.org_id);
    if (!org || !base || !org.path.startsWith(base.path)) {
      throw bad('线索负责人不在该接入方授权的组织范围内');
    }
  }
  return u;
}
const SELECT_LEAD = `select l.*, u.name as owner_name, o.name as org_name, a.name as account_name
  from leads l
  left join users u on u.id = l.owner_id
  left join org_units o on o.id = l.org_id
  left join accounts a on a.id = l.account_id`;
function leadView(l) {
  return {
    id: l.id,
    external_id: l.external_id || null,
    name: l.name,
    contact_name: l.contact_name || null,
    contact_title: l.contact_title || null,
    contact_phone: l.contact_phone || null,
    contact_email: l.contact_email || null,
    source: l.source || null,
    industry: l.industry || null,
    region: l.region || null,
    demand: l.demand || null,
    budget: l.budget || null,
    purchase_time: l.purchase_time || null,
    status: l.status,
    score: l.score,
    owner_id: l.owner_id,
    owner_name: l.owner_name || null,
    org_id: l.org_id,
    org_name: l.org_name || null,
    account_id: l.account_id || null,
    account_name: l.account_name || null,
    opportunity_id: l.opportunity_id || null,
    next_action: l.next_action || null,
    next_date: l.next_date || null,
    last_activity_at: l.last_activity_at || null,
    created_at: l.created_at,
    updated_at: l.updated_at
  };
}
async function loadLead(client, id) {
  const l = await one(`${SELECT_LEAD} where l.id = ?`, Number(id) || 0);
  if (!l || !(await inScope(client, l))) throw notFound('线索不存在');
  return l;
}

/* ============================ 连通性 / 元数据 ============================ */

apiGet('/api/v1/ping', ctx => {
  const c = ctx.client;
  const quota = Number(c.daily_quota || 0);
  return ok(ctx, {
    service: 'MSERM CRM · 线索 API',
    version: 'v1',
    client: {
      client_id: c.client_id,
      name: c.name,
      scopes: c.scopeList
    },
    ip: c.ip,
    rate_limit: c.rate_limit,
    quota: {
      limit: quota,
      used: c.usedToday,
      left: quota > 0 ? Math.max(0, quota - c.usedToday) : null
    },
    expire_at: c.expire_at || null,
    server_time: nowIso()
  });
});
apiGet('/api/v1/leads/meta', ctx => {
  requireScope(ctx.client, 'lead:read');
  return ok(ctx, {
    status: [{
      key: 'new',
      label: '待跟进'
    }, {
      key: 'contacted',
      label: '跟进中'
    }, {
      key: 'qualified',
      label: '已确认'
    }, {
      key: 'converted',
      label: '已转商机'
    }, {
      key: 'invalid',
      label: '无效'
    }],
    fields: [{
      key: 'name',
      required: true,
      type: 'string',
      desc: '线索名称，通常写客户公司名'
    }, {
      key: 'external_id',
      type: 'string',
      desc: '外部系统单号，用于幂等去重'
    }, {
      key: 'contact_name',
      type: 'string',
      desc: '关键联系人'
    }, {
      key: 'contact_title',
      type: 'string',
      desc: '联系人职位'
    }, {
      key: 'contact_phone',
      type: 'string',
      desc: '联系电话（转商机时必填）'
    }, {
      key: 'contact_email',
      type: 'string',
      desc: '联系邮箱'
    }, {
      key: 'source',
      type: 'string',
      desc: '来源，如 官网表单 / 展会 / 电话'
    }, {
      key: 'industry',
      type: 'string',
      desc: '行业'
    }, {
      key: 'region',
      type: 'string',
      desc: '地区'
    }, {
      key: 'demand',
      type: 'text',
      desc: '需求描述（转商机时必填）'
    }, {
      key: 'budget',
      type: 'string',
      desc: '预算区间'
    }, {
      key: 'purchase_time',
      type: 'string',
      desc: '计划采购时间'
    }, {
      key: 'next_action',
      type: 'string',
      desc: '下一步动作'
    }, {
      key: 'next_date',
      type: 'string',
      desc: '下一步日期 YYYY-MM-DD'
    }, {
      key: 'score',
      type: 'number',
      desc: '线索评分 0-100，默认 50'
    }, {
      key: 'owner_id',
      type: 'number',
      desc: '负责人用户 ID，缺省用接入方默认负责人'
    }],
    example: {
      name: '杭州云舟智能装备有限公司',
      external_id: 'WEB-2026-1031-001',
      contact_name: '王海涛',
      contact_title: '信息化总监',
      contact_phone: '13800001234',
      contact_email: 'wang@example.com',
      source: '官网表单',
      industry: '装备制造',
      region: '浙江杭州',
      demand: '希望打通车间报工与 ERP，Q1 完成选型',
      budget: '50-80 万',
      purchase_time: '2027-Q1'
    }
  });
});

/* ============================ 查询 ============================ */

apiGet('/api/v1/leads', async ctx => {
  requireScope(ctx.client, 'lead:read');
  const q = ctx.query;
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
  const offset = Math.max(0, Number(q.offset) || 0);
  const scope = scopeSql(ctx.client);
  const where = [`(${scope.sql})`];
  const params = [...scope.params];
  if (q.status) {
    const list = String(q.status).split(',').map(s => s.trim()).filter(Boolean);
    where.push(`l.status in (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (q.source) {
    where.push('l.source = ?');
    params.push(String(q.source));
  }
  if (q.owner_id) {
    where.push('l.owner_id = ?');
    params.push(Number(q.owner_id));
  }
  if (q.external_id) {
    where.push('l.external_id = ?');
    params.push(String(q.external_id));
  }
  if (q.since) {
    // 增量同步：只要这个时间之后有变动的
    where.push('l.updated_at >= ?');
    params.push(String(q.since));
  }
  if (q.q) {
    where.push('(l.name LIKE ? OR l.contact_name LIKE ? OR l.contact_phone LIKE ?)');
    const like = `%${String(q.q)}%`;
    params.push(like, like, like);
  }
  const sqlWhere = where.join(' and ');
  const total = Number((await one(`select count(*) c from leads l where ${sqlWhere}`, ...params)).c || 0);
  const rows = (await all(`${SELECT_LEAD} where ${sqlWhere} order by l.updated_at desc, l.id desc limit ? offset ?`, ...params, limit, offset)).map(leadView);
  return ok(ctx, {
    total,
    count: rows.length,
    limit,
    offset,
    rows
  });
});
apiGet('/api/v1/leads/:id', async ctx => {
  requireScope(ctx.client, 'lead:read');
  const l = await loadLead(ctx.client, ctx.params.id);
  const activities = await all(`select a.id, a.type, a.content, a.result, a.next_action, a.next_date, a.created_at, u.name as user_name
     from activities a left join users u on u.id = a.user_id
     where a.target_type = 'lead' and a.target_id = ? order by a.created_at desc limit 50`, l.id);
  return ok(ctx, {
    ...leadView(l),
    activities
  });
});

/* ============================ 写入 ============================ */

function readWriteBody(b) {
  const out = {};
  if (b.name !== undefined) {
    const name = str(b.name, 200);
    if (!name) throw bad('name（线索名称）不能为空');
    out.name = name;
  }
  for (const f of ['contact_name', 'contact_title', 'contact_phone', 'contact_email', 'source', 'industry', 'region', 'demand', 'budget', 'purchase_time', 'next_action']) {
    if (b[f] !== undefined) out[f] = str(b[f]);
  }
  if (b.next_date !== undefined) out.next_date = checkDate(b.next_date, 'next_date');
  if (b.score !== undefined) {
    const s = num(b.score);
    if (s === null) throw bad('score 需要是数字');
    out.score = Math.max(0, Math.min(100, Math.round(s)));
  }
  if (out.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.contact_email)) {
    throw bad('contact_email 格式不正确');
  }
  return out;
}
apiPost('/api/v1/leads', async ctx => {
  requireScope(ctx.client, 'lead:write');
  const b = ctx.body || {};
  const data = readWriteBody(b);
  const externalId = str(b.external_id, 64);
  if (externalId) {
    const exist = await one('select * from leads where external_id = ?', externalId);
    if (exist && (await inScope(ctx.client, exist))) {
      const same = await one(`${SELECT_LEAD} where l.id = ?`, exist.id);
      return ok(ctx, {
        ...leadView(same),
        duplicated: true
      }, 200);
    }
  }
  const owner = await resolveOwner(ctx.client, b.owner_id);
  const now = nowIso();
  const r = await run(`insert into leads(name,external_id,contact_name,contact_title,contact_phone,contact_email,
       source,industry,region,demand,budget,purchase_time,next_action,next_date,
       status,score,owner_id,org_id,created_by,created_at,updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, data.name, externalId, data.contact_name ?? null, data.contact_title ?? null, data.contact_phone ?? null, data.contact_email ?? null, data.source ?? null, data.industry ?? null, data.region ?? null, data.demand ?? null, data.budget ?? null, data.purchase_time ?? null, data.next_action ?? '首次电话沟通', data.next_date ?? today(1), 'new', data.score ?? 50, owner.id, owner.org_id, ctx.client.owner_id || null, now, now);
  const id = idOf(r);
  await auditApi(ctx, 'POST /api/v1/leads', 'lead', id, {
    name: data.name,
    external_id: externalId,
    source: data.source
  });
  const saved = await one(`${SELECT_LEAD} where l.id = ?`, id);
  return ok(ctx, {
    ...leadView(saved),
    duplicated: false
  }, 201);
});
apiPatch('/api/v1/leads/:id', async ctx => {
  requireScope(ctx.client, 'lead:write');
  const l = await loadLead(ctx.client, ctx.params.id);
  const b = ctx.body || {};
  const data = readWriteBody(b);
  const sets = [];
  const params = [];
  for (const f of WRITE_FIELDS) {
    if (data[f] === undefined) continue;
    sets.push(`${f} = ?`);
    params.push(data[f]);
  }
  if (b.owner_id !== undefined) {
    const owner = await resolveOwner(ctx.client, b.owner_id);
    sets.push('owner_id = ?', 'org_id = ?');
    params.push(owner.id, owner.org_id);
  }
  if (b.external_id !== undefined) {
    const ext = str(b.external_id, 64);
    if (ext) {
      const clash = await one('select id from leads where external_id = ? and id <> ?', ext, l.id);
      if (clash) throw bad('external_id 已被其它线索占用');
    }
    sets.push('external_id = ?');
    params.push(ext);
  }
  if (!sets.length) return ok(ctx, {
    id: l.id,
    changed: 0
  });
  sets.push('updated_at = ?');
  params.push(nowIso(), l.id);
  await run(`update leads set ${sets.join(', ')} where id = ?`, ...params);
  await auditApi(ctx, 'PATCH /api/v1/leads', 'lead', l.id, {
    fields: [...Object.keys(data), ...(b.owner_id !== undefined ? ['owner_id'] : [])]
  });
  const saved = await one(`${SELECT_LEAD} where l.id = ?`, l.id);
  return ok(ctx, {
    ...leadView(saved),
    changed: Math.max(0, sets.length - 1)
  });
});
apiPost('/api/v1/leads/:id/activities', async ctx => {
  requireScope(ctx.client, 'lead:write');
  const l = await loadLead(ctx.client, ctx.params.id);
  const b = ctx.body || {};
  const content = str(b.content, 2000);
  if (!content) throw bad('content（跟进内容）为必填');
  const type = String(b.type || 'note').toLowerCase();
  if (!ACTIVITY_TYPES.includes(type)) {
    throw bad(`type 只能是：${ACTIVITY_TYPES.join(' / ')}`);
  }
  const nextDate = checkDate(b.next_date, 'next_date');
  await run(`insert into activities(target_type,target_id,type,content,result,next_action,next_date,user_id,created_at)
     values('lead',?,?,?,?,?,?,?,?)`, l.id, type, content, str(b.result), str(b.next_action), nextDate, null, nowIso());
  await run(`update leads set last_activity_at = ?, next_action = coalesce(?, next_action),
       next_date = coalesce(?, next_date),
       status = case when status = 'new' then 'contacted' else status end,
       updated_at = ?
     where id = ?`, nowIso(), str(b.next_action), nextDate, nowIso(), l.id);
  await auditApi(ctx, 'POST /api/v1/leads/activities', 'lead', l.id, {
    type,
    content: content.slice(0, 120)
  });
  const saved = await one(`${SELECT_LEAD} where l.id = ?`, l.id);
  return ok(ctx, {
    lead_id: l.id,
    status: saved.status,
    last_activity_at: saved.last_activity_at
  }, 201);
});

/** 批量导入：逐条处理，一条失败不影响其它条 */
apiPost('/api/v1/leads/batch', async ctx => {
  requireScope(ctx.client, 'lead:write');
  const list = Array.isArray(ctx.body?.leads) ? ctx.body.leads : null;
  if (!list) throw bad('请求体需要形如 { "leads": [ {...}, {...} ] }');
  if (list.length > 200) throw bad('单次最多 200 条，请分批提交');
  const result = {
    total: list.length,
    created: 0,
    duplicated: 0,
    failed: 0,
    errors: [],
    ids: []
  };
  list.forEach(async (item, index) => {
    try {
      const b = item || {};
      const data = readWriteBody(b);
      const externalId = str(b.external_id, 64);
      if (externalId) {
        const exist = await one('select id from leads where external_id = ?', externalId);
        if (exist) {
          result.duplicated++;
          result.ids.push({
            index,
            id: exist.id,
            duplicated: true
          });
          return;
        }
      }
      const owner = await resolveOwner(ctx.client, b.owner_id);
      const now = nowIso();
      const r = await run(`insert into leads(name,external_id,contact_name,contact_title,contact_phone,contact_email,
           source,industry,region,demand,budget,purchase_time,next_action,next_date,
           status,score,owner_id,org_id,created_by,created_at,updated_at)
         values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, data.name, externalId, data.contact_name ?? null, data.contact_title ?? null, data.contact_phone ?? null, data.contact_email ?? null, data.source ?? null, data.industry ?? null, data.region ?? null, data.demand ?? null, data.budget ?? null, data.purchase_time ?? null, data.next_action ?? '首次电话沟通', data.next_date ?? today(1), 'new', data.score ?? 50, owner.id, owner.org_id, ctx.client.owner_id || null, now, now);
      result.created++;
      result.ids.push({
        index,
        id: idOf(r)
      });
    } catch (e) {
      result.failed++;
      result.errors.push({
        index,
        message: e.message || '写入失败'
      });
    }
  });
  await auditApi(ctx, 'POST /api/v1/leads/batch', 'lead', null, {
    total: result.total,
    created: result.created,
    duplicated: result.duplicated,
    failed: result.failed
  });
  return ok(ctx, result, result.failed ? 207 : 201);
});