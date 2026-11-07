import { GET, POST, PATCH, DELETE, bad, notFound, denied } from '../http.js';
import { all, one, run, nowIso, idOf, isToday } from '../db.js';
import { DEMO_MODE } from '../demo.js';
import { SCOPES, issueKey, parseWhitelist, parseDomains, normalizeDomain, selfCheck, normalizeIp } from '../api-auth.js';

/**
 * 线索 API 的开通与授权（只对系统管理员开放）。
 *
 * 「开通」= 建一个接入方，拿到一对密钥；
 * 「授权」= 指定它能读能写、能调多少、从哪些 IP / 域名来、什么时候到期。
 * 密钥明文只在开通和重置时返回一次，库里只有 sha256，管理员自己也没法再翻出来。
 *
 * 只有超级管理员（role = admin）能进：销售总监、销售经理虽然有 admin 模块，
 * 但那是管人和组织的，不是管对外接口的——这条路一旦放开，等于让他们能给外部系统开写库权限。
 */

function requireAdmin(ctx) {
  if (ctx.user.role !== 'admin') throw denied('只有系统管理员可以开通和授权 API 接入');
}
function guardDemo() {
  if (DEMO_MODE) throw denied('演示环境不支持开通或修改 API 接入，请在正式部署的实例里操作');
}
const intOr = (v, def, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
};
function isV4(ip) {
  const p = String(ip).split('.');
  return p.length === 4 && p.every(x => /^\d{1,3}$/.test(x) && Number(x) <= 255);
}
function validateRules(text) {
  const list = parseWhitelist(text);
  if (!list.length) throw bad('请至少填写一个授权 IP（支持 10.0.1.20 / 10.0.0.0/16 / 192.168.1.* / *）');
  for (const r of list) {
    if (r === '*') continue;
    if (r.includes('/')) {
      const [base, bits] = r.split('/');
      if (!isV4(base) || !/^\d{1,2}$/.test(bits) || Number(bits) > 32) throw bad(`IP 段格式不正确：${r}`);
      continue;
    }
    if (r.includes('*')) {
      if (!/^\d{1,3}(\.(\d{1,3}|\*)){1,3}$/.test(r)) throw bad(`通配格式不正确：${r}`);
      continue;
    }
    if (isV4(r)) continue;
    if (r.includes(':') && /^[0-9a-fA-F:]+$/.test(r)) continue; // IPv6 单地址
    throw bad(`IP 格式不正确：${r}`);
  }
  return list;
}
function parseScopesInput(v) {
  const list = Array.isArray(v) ? v : [];
  const valid = list.filter(s => SCOPES.some(x => x.key === s));
  if (!valid.length) throw bad('请至少勾选一项接口权限');
  return valid;
}
/**
 * 校验授权域名。
 * 允许的写法：`example.com` / `*.example.com` / `*`。
 * 不允许裸后缀（`com`）和中间通配（`api.*.com`）——那两类规则要么过宽、要么没人看得懂。
 */
const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
function validateDomains(text) {
  const list = parseDomains(text);
  for (const r of list) {
    if (r === '*') continue;
    if (!DOMAIN_RE.test(r)) {
      throw bad(`域名格式不正确：${r}（示例：api.example.com / *.example.com / *）`);
    }
    if (r.startsWith('*.') && r.slice(2).split('.').length < 2) {
      throw bad(`通配域名至少要有两段：${r}`);
    }
  }
  return list;
}
function baseUrlOf(ctx) {
  const host = ctx.req.headers['x-forwarded-host'] || ctx.req.headers.host || `localhost:${process.env.PORT || 8081}`;
  const proto = String(ctx.req.headers['x-forwarded-proto'] || '').split(',')[0] || (String(host).startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}
const ENDPOINTS = [{
  method: 'GET',
  path: '/api/v1/ping',
  scope: '—',
  title: '连通性测试',
  desc: '验证密钥、IP 白名单与配额，返回当前授信信息'
}, {
  method: 'GET',
  path: '/api/v1/leads',
  scope: 'lead:read',
  title: '线索列表',
  desc: '分页查询：status / source / since / q / owner_id / external_id / limit / offset'
}, {
  method: 'GET',
  path: '/api/v1/leads/meta',
  scope: 'lead:read',
  title: '字段与枚举',
  desc: '可写字段、状态枚举、示例报文'
}, {
  method: 'GET',
  path: '/api/v1/leads/:id',
  scope: 'lead:read',
  title: '线索详情',
  desc: '含最近 50 条跟进记录'
}, {
  method: 'POST',
  path: '/api/v1/leads',
  scope: 'lead:write',
  title: '新建线索',
  desc: '带 external_id 时幂等；重复推送返回原记录',
  body: {
    name: '杭州云舟智能装备有限公司',
    external_id: 'WEB-2026-1031-001',
    contact_name: '王海涛',
    contact_phone: '13800001234',
    source: '官网表单',
    demand: '车间报工与 ERP 打通'
  }
}, {
  method: 'PATCH',
  path: '/api/v1/leads/:id',
  scope: 'lead:write',
  title: '更新线索',
  desc: '只传要改的字段',
  body: {
    contact_phone: '13900002345',
    next_action: '安排现场演示',
    next_date: '2026-11-05'
  }
}, {
  method: 'POST',
  path: '/api/v1/leads/:id/activities',
  scope: 'lead:write',
  title: '写跟进记录',
  desc: 'type：call / visit / email / meeting / note / wechat',
  body: {
    type: 'call',
    content: '已电话沟通，确认预算与选型时间',
    result: '有意向',
    next_action: '发送方案',
    next_date: '2026-11-06'
  }
}, {
  method: 'POST',
  path: '/api/v1/leads/batch',
  scope: 'lead:write',
  title: '批量导入',
  desc: '单次最多 200 条，逐条返回成功/失败原因',
  body: {
    leads: [{
      name: '示例客户 A',
      external_id: 'BATCH-001'
    }, {
      name: '示例客户 B',
      external_id: 'BATCH-002'
    }]
  }
}];
function clientRow(c) {
  return {
    id: c.id,
    name: c.name,
    client_id: c.client_id,
    key_prefix: c.key_prefix,
    status: c.revoked_at ? 'revoked' : c.status,
    scopes: (() => {
      try {
        return JSON.parse(c.scopes || '[]');
      } catch {
        return [];
      }
    })(),
    ip_whitelist: c.ip_whitelist || '',
    ip_list: parseWhitelist(c.ip_whitelist),
    domain_whitelist: c.domain_whitelist || '',
    domain_list: parseDomains(c.domain_whitelist),
    pool_on_missing: Number(c.pool_on_missing ?? 1),
    rate_limit: c.rate_limit,
    daily_quota: c.daily_quota,
    expire_at: c.expire_at,
    org_id: c.org_id,
    org_name: c.org_name || null,
    owner_id: c.owner_id,
    owner_name: c.owner_name || null,
    remark: c.remark,
    created_at: c.created_at,
    last_used_at: c.last_used_at,
    last_ip: c.last_ip,
    revoked_at: c.revoked_at
  };
}
const SELECT_CLIENT = `select c.*, o.name as org_name, u.name as owner_name from api_clients c
  left join org_units o on o.id = c.org_id
  left join users u on u.id = c.owner_id`;
async function loadClient(id) {
  const c = await one(`${SELECT_CLIENT} where c.id = ?`, Number(id) || 0);
  if (!c) throw notFound('接入方不存在');
  return c;
}

/* ============================ 列表 / 开通 ============================ */

GET('/api/admin/api-clients', async ctx => {
  requireAdmin(ctx);
  // 注意：每行要额外查 3 个统计，必须 Promise.all 收齐；
  // 直接 map(async …) 得到的是 Promise 数组，序列化成 JSON 会变成一堆 {}
  const list = await all(`${SELECT_CLIENT} order by c.id desc`);
  const rows = await Promise.all(list.map(async c => ({
    ...clientRow(c),
    today_calls: Number((await one(`select count(*) n from api_logs where client_id = ? and ${isToday('created_at')}`, c.id)).n || 0),
    total_calls: Number((await one('select count(*) n from api_logs where client_id = ?', c.id)).n || 0),
    last_status: (await one('select status from api_logs where client_id = ? order by id desc limit 1', c.id))?.status || null
  })));
  const todayTotal = Number((await one(`select count(*) n from api_logs where ${isToday('created_at')}`)).n || 0);
  const todayFail = Number((await one(`select count(*) n from api_logs where ${isToday('created_at')} and status >= 400`)).n || 0);
  return {
    rows,
    stats: {
      clients: rows.length,
      active: rows.filter(r => r.status === 'active').length,
      todayTotal,
      todayFail
    },
    meta: {
      ip: normalizeIp(ctx.ip),
      demo: DEMO_MODE,
      baseUrl: baseUrlOf(ctx),
      scopes: SCOPES,
      endpoints: ENDPOINTS
    },
    users: await all(`select u.id, u.name, u.title, u.status, o.name as org_name, o.path as org_path
       from users u join org_units o on o.id = u.org_id
       where u.status = 'active' order by o.path, u.id`),
    orgs: await all('select id, name, path, level from org_units order by path')
  };
});
POST('/api/admin/api-clients', async ctx => {
  requireAdmin(ctx);
  guardDemo();
  const b = ctx.body || {};
  const name = String(b.name || '').trim();
  if (!name) throw bad('请填写接入方名称，例如「官网表单」');
  if (name.length > 40) throw bad('接入方名称请控制在 40 字以内');
  const ownerId = Number(b.owner_id || 0) || Number(ctx.user.id);
  const owner = await one("select id, org_id, status from users where id = ? and status = 'active'", ownerId);
  if (!owner) throw bad('默认线索负责人不存在或已停用');
  const scopes = parseScopesInput(b.scopes);
  const ipList = validateRules(b.ip_whitelist);
  const domainList = validateDomains(b.domain_whitelist);
  const rateLimit = intOr(b.rate_limit, 60, 0, 6000);
  const dailyQuota = intOr(b.daily_quota, 5000, 0, 1000000);
  const poolOnMissing = Number(b.pool_on_missing) === 0 ? 0 : 1;
  const expireAt = b.expire_at ? String(b.expire_at).slice(0, 10) : null;
  if (expireAt && !/^\d{4}-\d{2}-\d{2}$/.test(expireAt)) throw bad('到期日需要是 YYYY-MM-DD');
  const k = issueKey();
  const r = await run(`insert into api_clients(name,client_id,key_prefix,key_hash,status,scopes,ip_whitelist,domain_whitelist,pool_on_missing,
       rate_limit,daily_quota,expire_at,org_id,owner_id,remark,created_by,created_at)
     values(?,?,?,?,'active',?,?,?,?,?,?,?,?,?,?,?,?)`, name, k.clientId, k.prefix, k.hash, JSON.stringify(scopes), ipList.join('\n'), domainList.join('\n'), poolOnMissing, rateLimit, dailyQuota, expireAt, owner.org_id, owner.id, String(b.remark || '').slice(0, 300) || null, ctx.user.id, nowIso());
  return {
    ok: true,
    id: idOf(r),
    name,
    client_id: k.clientId,
    key: k.key,
    key_prefix: k.prefix,
    scopes,
    ip_list: ipList,
    domain_list: domainList,
    base_url: baseUrlOf(ctx),
    message: '密钥只显示这一次，请立即复制保存'
  };
});

/* ============================ 修改 / 重置 / 撤销 ============================ */

PATCH('/api/admin/api-clients/:id', async ctx => {
  requireAdmin(ctx);
  guardDemo();
  const c = await loadClient(ctx.params.id);
  const b = ctx.body || {};
  const sets = [];
  const params = [];
  if (b.name !== undefined) {
    const name = String(b.name || '').trim();
    if (!name) throw bad('接入方名称不能为空');
    sets.push('name = ?');
    params.push(name.slice(0, 40));
  }
  if (b.owner_id !== undefined) {
    const owner = await one("select id, org_id from users where id = ? and status = 'active'", Number(b.owner_id) || 0);
    if (!owner) throw bad('默认线索负责人不存在或已停用');
    sets.push('owner_id = ?', 'org_id = ?');
    params.push(owner.id, owner.org_id);
  }
  if (b.scopes !== undefined) {
    sets.push('scopes = ?');
    params.push(JSON.stringify(parseScopesInput(b.scopes)));
  }
  if (b.ip_whitelist !== undefined) {
    sets.push('ip_whitelist = ?');
    params.push(validateRules(b.ip_whitelist).join('\n'));
  }
  if (b.domain_whitelist !== undefined) {
    sets.push('domain_whitelist = ?');
    params.push(validateDomains(b.domain_whitelist).join('\n'));
  }
  if (b.pool_on_missing !== undefined) {
    sets.push('pool_on_missing = ?');
    params.push(Number(b.pool_on_missing) === 0 ? 0 : 1);
  }
  if (b.rate_limit !== undefined) {
    sets.push('rate_limit = ?');
    params.push(intOr(b.rate_limit, 60, 0, 6000));
  }
  if (b.daily_quota !== undefined) {
    sets.push('daily_quota = ?');
    params.push(intOr(b.daily_quota, 5000, 0, 1000000));
  }
  if (b.expire_at !== undefined) {
    const d = b.expire_at ? String(b.expire_at).slice(0, 10) : null;
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw bad('到期日需要是 YYYY-MM-DD');
    sets.push('expire_at = ?');
    params.push(d);
  }
  if (b.remark !== undefined) {
    sets.push('remark = ?');
    params.push(String(b.remark || '').slice(0, 300) || null);
  }
  if (b.status !== undefined) {
    const status = b.status === 'active' ? 'active' : 'disabled';
    sets.push('status = ?');
    params.push(status);
    if (status === 'active') {
      sets.push('revoked_at = null');
    }
  }
  if (!sets.length) return {
    ok: true,
    changed: 0
  };
  params.push(c.id);
  await run(`update api_clients set ${sets.join(', ')} where id = ?`, ...params);
  return {
    ok: true,
    changed: sets.filter(s => s.includes('=')).length
  };
});
POST('/api/admin/api-clients/:id/rotate', async ctx => {
  requireAdmin(ctx);
  guardDemo();
  const c = await loadClient(ctx.params.id);
  if (c.revoked_at) throw bad('该接入方已撤销，请重新开通');
  const k = issueKey();
  await run("update api_clients set key_hash = ?, key_prefix = ?, status = 'active', revoked_at = null where id = ?", k.hash, k.prefix, c.id);
  return {
    ok: true,
    id: c.id,
    name: c.name,
    client_id: c.client_id,
    key: k.key,
    key_prefix: k.prefix,
    base_url: baseUrlOf(ctx),
    message: '旧密钥已立即失效，新密钥只显示这一次'
  };
});
DELETE('/api/admin/api-clients/:id', async ctx => {
  requireAdmin(ctx);
  guardDemo();
  const c = await loadClient(ctx.params.id);
  await run("update api_clients set status = 'disabled', revoked_at = coalesce(revoked_at, ?) where id = ?", nowIso(), c.id);
  return {
    ok: true,
    message: `${c.name} 的密钥已撤销，立即失效`
  };
});

/* ============================ 自检 / 日志 ============================ */

POST('/api/admin/api-clients/:id/selfcheck', async ctx => {
  requireAdmin(ctx);
  const c = await loadClient(ctx.params.id);
  const ip = normalizeIp(ctx.body && ctx.body.ip || ctx.ip);
  // 域名只认显式传入：自检的是「对方」能不能进，用管理员自己浏览器的 Origin 冒充只会误导
  const domain = normalizeDomain(ctx.body && ctx.body.domain || '');
  return {
    ok: true,
    client: {
      id: c.id,
      name: c.name,
      client_id: c.client_id
    },
    result: await selfCheck(c, ip, domain)
  };
});
GET('/api/admin/api-logs', async ctx => {
  requireAdmin(ctx);
  const limit = Math.min(300, Math.max(1, Number(ctx.query.limit) || 60));
  const where = [];
  const params = [];
  if (ctx.query.client_id) {
    where.push('client_id = ?');
    params.push(Number(ctx.query.client_id));
  }
  if (ctx.query.status === 'fail') where.push('status >= 400');
  if (ctx.query.status === 'ok') where.push('status < 400');
  if (ctx.query.path) {
    where.push('path LIKE ?');
    params.push(`%${ctx.query.path}%`);
  }
  const rows = await all(`select id, client_id, client_name, method, path, ip, status, ms, request, response, error, created_at
     from api_logs ${where.length ? 'where ' + where.join(' and ') : ''}
     order by id desc limit ?`, ...params, limit);
  return {
    rows,
    stats: {
      todayTotal: Number((await one(`select count(*) n from api_logs where ${isToday('created_at')}`)).n || 0),
      todayFail: Number((await one(`select count(*) n from api_logs where ${isToday('created_at')} and status >= 400`)).n || 0)
    }
  };
});