import { createHash, randomBytes } from 'node:crypto';
import { one, run, nowIso, today } from './db.js';
import { HttpError } from './http.js';

/**
 * 线索 API 的接入鉴权。
 *
 * 四件事必须同时成立才放行：
 *   1. 密钥对得上（只存 sha256，明文只在开通/重置时给一次）
 *   2. 来源 IP 在授权名单内（支持单 IP、网段、通配）
 *   3. 来源域名在授权名单内（配了才校验，见下）
 *   4. 没超出速率与日配额，且没停用 / 没过期
 *
 * 任何一条不满足都直接拒绝，并把原因写清楚——对外接的人比我们更想知道
 * 是「密钥错了」还是「IP 没加白名单」，含糊的报错只会让两边来回扯皮。
 *
 * 注意 IP 与域名的「空名单」语义**故意相反**：
 *   - IP 空名单 = 全拒绝。IP 是服务器固有的，配不上就是没配好，宁可拦住。
 *   - 域名空名单 = 不校验。服务器对服务器调用通常不带 Origin / Referer，
 *     空名单若按「全拒绝」处理，会把所有既有的纯 IP 接入方一次性打死；
 *     一旦填了域名，就变成硬性校验，缺头或不在名单内都拒绝。
 */

export const SCOPES = [{
  key: 'lead:read',
  label: '读取线索',
  desc: '查询列表、详情、跟进记录'
}, {
  key: 'lead:write',
  label: '写入线索',
  desc: '新建、更新、写跟进、批量导入'
}];
const KEY_PREFIX = 'crm_';
export const sha256 = s => createHash('sha256').update(String(s)).digest('hex');

/** 生成一对「明文密钥 + 存储哈希」 */
export function issueKey() {
  const key = `${KEY_PREFIX}${randomBytes(24).toString('hex')}`;
  return {
    key,
    prefix: key.slice(0, KEY_PREFIX.length + 6),
    hash: sha256(key),
    clientId: `ak_${randomBytes(5).toString('hex')}`
  };
}

/* ---------------- IP 匹配 ---------------- */

/** 去掉端口、IPv4-mapped 前缀，把 ::1 归一成 127.0.0.1 */
export function normalizeIp(raw) {
  let ip = String(raw || '').trim();
  if (!ip) return '';
  const bracket = ip.match(/^\[(.+)\](?::\d+)?$/);
  if (bracket) ip = bracket[1];else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}
export function parseWhitelist(text) {
  return String(text || '').split(/[\s,;、]+/).map(s => s.trim()).filter(Boolean);
}
function v4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}
function matchCidr(ip, rule) {
  const [base, bitsRaw] = rule.split('/');
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const a = v4ToInt(ip);
  const b = v4ToInt(base);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : 0xffffffff << 32 - bits >>> 0;
  return (a & mask) >>> 0 === (b & mask) >>> 0;
}

/** 单条规则匹配：1.2.3.4 / 10.0.0.0/8 / 192.168.1.* / * */
export function matchRule(ip, rule) {
  const r = String(rule || '').trim();
  const v = String(ip || '').trim();
  if (!r || !v) return false;
  if (r === '*') return true;
  if (r.includes('/')) return matchCidr(v, r);
  if (r.includes('*')) {
    const re = new RegExp(`^${r.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '\\d{1,3}')}$`);
    return re.test(v);
  }
  return r === v;
}
export function ipAllowed(ip, whitelist) {
  const rules = parseWhitelist(whitelist);
  if (!rules.length) return false; // 没配白名单 = 谁都不放行，安全优先
  return rules.some(r => matchRule(normalizeIp(ip), r));
}

/* ---------------- 域名匹配 ---------------- */

/**
 * 归一化域名：去协议、去路径、去端口、去首尾点、转小写。
 * `https://API.Example.com:8443/x` → `api.example.com`
 */
export function normalizeDomain(raw) {
  let d = String(raw || '').trim().toLowerCase();
  if (!d || d === 'null') return '';
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  d = d.split('/')[0].split('?')[0].split('#')[0];
  d = d.replace(/:\d+$/, '');
  d = d.replace(/^\.+|\.+$/g, '');
  return d;
}
export function parseDomains(text) {
  return String(text || '').split(/[\s,;、]+/).map(s => normalizeDomain(s)).filter(Boolean);
}
/**
 * 单条域名规则匹配：
 *   `*`              放行任意域名
 *   `*.example.com`  匹配 example.com 及其任意层级子域
 *   `example.com`    只匹配自身（不含子域，要含子域请加 *.）
 */
export function matchDomainRule(host, rule) {
  const h = normalizeDomain(host);
  const r = normalizeDomain(rule);
  if (!h || !r) return false;
  if (r === '*') return true;
  if (r.startsWith('*.')) {
    const base = r.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  return h === r;
}
/** 空名单 = 不校验（见文件头说明） */
export function domainAllowed(host, whitelist) {
  const rules = parseDomains(whitelist);
  if (!rules.length) return true;
  return rules.some(r => matchDomainRule(host, r));
}
/**
 * 从请求头推断调用方来源域名。
 * 只认调用方**主动声明**的 Origin / Referer——Host 是「打到我们身上的域名」，
 * 不是调用方自己的域名，拿它凑数只会让人误判「明明配了却过不去」。
 */
export function requestDomain(req) {
  const origin = String(req.headers.origin || '').trim();
  if (origin && origin !== 'null') return normalizeDomain(origin);
  const referer = String(req.headers.referer || '').trim();
  if (referer) return normalizeDomain(referer);
  return '';
}

/* ---------------- 速率限制（进程内滑窗） ---------------- */

const buckets = new Map();
function hitRate(client) {
  const limit = Number(client.rate_limit || 0);
  if (!limit) return 0;
  const now = Date.now();
  const list = (buckets.get(client.id) || []).filter(t => now - t < 60000);
  if (list.length >= limit) {
    buckets.set(client.id, list);
    return Math.ceil((60000 - (now - list[0])) / 1000);
  }
  list.push(now);
  buckets.set(client.id, list);
  return 0;
}
async function usedToday(clientId) {
  return Number((await one("select count(*) c from api_logs where client_id = ? and substr(created_at,1,10) = ?", clientId, today())).c || 0);
}

/* ---------------- 鉴权入口 ---------------- */

function keyFromRequest(req) {
  const h = String(req.headers.authorization || '');
  if (/^bearer\s+/i.test(h)) return h.replace(/^bearer\s+/i, '').trim();
  return String(req.headers['x-api-key'] || '').trim();
}

/**
 * 校验一次外部调用，返回 client 记录；不通过直接抛 HttpError。
 * @param {{req: import('node:http').IncomingMessage, ip: string}} p
 */
export async function authenticateApi({
  req,
  ip
}) {
  const key = keyFromRequest(req);
  if (!key) {
    throw new HttpError(401, '缺少 API 密钥：请在请求头带上 Authorization: Bearer <密钥> 或 X-API-Key: <密钥>');
  }
  const row = await one('select * from api_clients where key_hash = ?', sha256(key));
  if (!row) throw new HttpError(401, 'API 密钥无效（可能已被重置，请向管理员索取新密钥）');
  const addr = normalizeIp(ip);
  if (row.status !== 'active' || row.revoked_at) {
    throw new HttpError(403, '该 API 密钥已停用', {
      client: row.client_id
    });
  }
  if (row.expire_at && String(row.expire_at).slice(0, 10) < today()) {
    throw new HttpError(403, `该 API 密钥已于 ${String(row.expire_at).slice(0, 10)} 到期`, {
      client: row.client_id
    });
  }
  const rules = parseWhitelist(row.ip_whitelist);
  if (!rules.length) {
    throw new HttpError(403, '该接入方尚未配置授权 IP，所有请求都会被拒绝，请联系管理员添加', {
      ip: addr,
      whitelist: []
    });
  }
  if (!rules.some(r => matchRule(addr, r))) {
    throw new HttpError(403, `来源 IP ${addr} 不在授权名单内`, {
      ip: addr,
      whitelist: rules,
      hint: '请让管理员在「用户与组织 → API 接入」里把该 IP 加入白名单'
    });
  }
  // 域名是「配了才校验」：没配就跳过，配了就必须命中
  const domainRules = parseDomains(row.domain_whitelist);
  let host = '';
  if (domainRules.length) {
    host = requestDomain(req);
    if (!host) {
      throw new HttpError(403, '该接入方已配置授权域名，但请求没有声明来源（缺少 Origin 或 Referer 头）', {
        domains: domainRules,
        hint: '浏览器调用会自动带 Origin；服务器调用请显式传 Origin: https://your-domain.com，或让管理员清空域名授权改用纯 IP 校验'
      });
    }
    if (!domainRules.some(r => matchDomainRule(host, r))) {
      throw new HttpError(403, `来源域名 ${host} 不在授权名单内`, {
        domain: host,
        domains: domainRules,
        hint: '请让管理员在「用户与组织 → API 接入」里把该域名加入白名单（子域需写成 *.example.com）'
      });
    }
  }
  const quota = Number(row.daily_quota || 0);
  const used = await usedToday(row.id);
  if (quota > 0 && used >= quota) {
    throw new HttpError(429, `已达今日调用配额（${quota} 次），次日 00:00 后恢复`, {
      quota,
      used,
      client: row.client_id
    });
  }
  const wait = hitRate(row);
  if (wait > 0) {
    throw new HttpError(429, `调用过于频繁（上限 ${row.rate_limit} 次/分钟），请 ${wait} 秒后重试`, {
      retry_after: wait,
      rate_limit: row.rate_limit
    });
  }
  await run('update api_clients set last_used_at = ?, last_ip = ? where id = ?', nowIso(), addr, row.id);
  return {
    ...row,
    ip: addr,
    domain: host,
    scopeList: parseScopes(row.scopes),
    ipList: rules,
    domainList: domainRules,
    usedToday: used
  };
}
export function parseScopes(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter(s => SCOPES.some(x => x.key === s)) : [];
  } catch {
    return [];
  }
}
export function requireScope(client, scope) {
  if (!client.scopeList.includes(scope)) {
    throw new HttpError(403, `该密钥没有「${scope}」权限，请让管理员在授权范围里勾选`, {
      scopes: client.scopeList,
      required: scope
    });
  }
}

/* ---------------- 调用日志 ---------------- */

let pruneTick = 0;

/** 一次外部调用结束后写日志；失败也写，排查时才有据可查 */
export async function noteApiLog(ctx, result, err) {
  const c = ctx.client;
  if (!c) return;
  const status = err ? err.status || 500 : ctx.res.statusCode || 200;
  const body = ctx.body && Object.keys(ctx.body).length ? JSON.stringify(ctx.body).slice(0, 1200) : null;
  const resp = err ? null : JSON.stringify(result ?? {}).slice(0, 1600);
  try {
    await run(`insert into api_logs(client_id,client_name,method,path,ip,status,ms,request,response,error,ua,created_at)
       values(?,?,?,?,?,?,?,?,?,?,?,?)`, c.id, c.name, ctx.req.method, ctx.url.pathname, c.ip || ctx.ip, status, Math.max(0, Date.now() - (ctx.startedAt || Date.now())), body, resp, err ? String(err.message || err) : null, String(ctx.req.headers['user-agent'] || '').slice(0, 120), nowIso());
    if (++pruneTick % 100 === 0) {
      await run('delete from api_logs where id < (select coalesce(max(id),0) - 8000 from api_logs)');
    }
  } catch (e) {
    console.error('[api-log]', e.message);
  }
}

/** API 的写操作也进审计日志，和界面操作同一条流水 */
export async function auditApi(ctx, action, targetType, targetId, detail) {
  try {
    await run(`insert into audit_logs(user_id,user_name,action,target_type,target_id,detail,ip,created_at)
       values(?,?,?,?,?,?,?,?)`, null, `API · ${ctx.client?.name || '未命名接入方'}`, action, targetType, targetId, JSON.stringify(detail || {}).slice(0, 800), ctx.ip || '', nowIso());
  } catch {/* 审计失败不影响业务 */}
}

/** 管理端的连通性自检：不校验密钥，只回答「这个 IP / 域名现在能不能进」 */
export async function selfCheck(client, ipRaw, domainRaw) {
  const ip = normalizeIp(ipRaw);
  const rules = parseWhitelist(client.ip_whitelist);
  const matched = rules.find(r => matchRule(ip, r)) || null;
  const domainRules = parseDomains(client.domain_whitelist);
  const host = normalizeDomain(domainRaw);
  const domainMatched = domainRules.length
    ? (host ? domainRules.find(r => matchDomainRule(host, r)) || null : null)
    : '*'; // 空名单 = 不校验
  const used = await usedToday(client.id);
  const quota = Number(client.daily_quota || 0);
  const expired = Boolean(client.expire_at && String(client.expire_at).slice(0, 10) < today());
  const reasons = [];
  if (client.status !== 'active' || client.revoked_at) reasons.push('密钥已停用或已撤销');
  if (expired) reasons.push(`授权已于 ${String(client.expire_at).slice(0, 10)} 到期`);
  if (!rules.length) reasons.push('未配置授权 IP（空名单 = 全部拒绝）');else if (!matched) reasons.push(`IP ${ip} 未命中任何一条白名单规则`);
  if (domainRules.length) {
    if (!host) reasons.push('已配置授权域名，但自检未填写来源域名');else if (!domainMatched) reasons.push(`域名 ${host} 未命中任何一条授权域名规则`);
  }
  if (quota > 0 && used >= quota) reasons.push(`今日调用已达配额 ${quota} 次`);
  return {
    ip,
    allowed: reasons.length === 0,
    matched,
    whitelist: rules,
    domain: host,
    domain_matched: domainMatched,
    domains: domainRules,
    domain_required: domainRules.length > 0,
    status: client.status,
    revoked: Boolean(client.revoked_at),
    expire_at: client.expire_at || null,
    expired,
    quota: {
      limit: quota,
      used,
      left: quota > 0 ? Math.max(0, quota - used) : null
    },
    rate_limit: Number(client.rate_limit || 0),
    scopes: parseScopes(client.scopes),
    reasons
  };
}