import { randomBytes } from 'node:crypto';
import { getSession, loadUser, COOKIE, touchSession } from './auth.js';
import { run as dbRun } from './db.js';
import { authenticateApi, noteApiLog } from './api-auth.js';

export class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}
export const bad = (msg, detail) => new HttpError(400, msg, detail);
export const denied = (msg = '没有权限执行该操作') => new HttpError(403, msg);
export const notFound = (msg = '记录不存在') => new HttpError(404, msg);

const routes = [];

export function route(method, path, handler, opts = {}) {
  const segs = path.split('/').filter(Boolean);
  routes.push({ method, segs, handler, opts });
}

export const GET = (p, h, o) => route('GET', p, h, o);
export const POST = (p, h, o) => route('POST', p, h, o);
export const PATCH = (p, h, o) => route('PATCH', p, h, o);
export const DELETE = (p, h, o) => route('DELETE', p, h, o);

function match(segs, pathSegs) {
  if (segs.length !== pathSegs.length) return null;
  const params = {};
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].startsWith(':')) params[segs[i].slice(1)] = decodeURIComponent(pathSegs[i]);
    else if (segs[i] !== pathSegs[i]) return null;
  }
  return params;
}

export function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new HttpError(413, '请求内容过大（附件上限 1 MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export async function dispatch(req, res, ctxBase) {
  const started = Date.now();
  const url = new URL(req.url, 'http://localhost');
  const pathSegs = url.pathname.split('/').filter(Boolean);
  const query = Object.fromEntries(url.searchParams.entries());
  const isPublicApi = url.pathname.startsWith('/api/v1/');

  // 对外开放的线索 API：允许跨域调用（不带 Cookie，鉴权只认密钥），并放行预检
  if (isPublicApi) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-API-Key');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return undefined;
    }
  }

  let matched = null;
  let allowedMethods = [];
  for (const r of routes) {
    const params = match(r.segs, pathSegs);
    if (params) {
      if (r.method === req.method) { matched = { r, params }; break; }
      allowedMethods.push(r.method);
    }
  }

  if (!matched) {
    if (allowedMethods.length) throw new HttpError(405, '请求方法不允许');
    throw new HttpError(404, '接口不存在');
  }

  const { r, params } = matched;
  const ctx = { ...ctxBase, req, res, params, query, url, user: null, body: {}, startedAt: started };

  if (r.opts.auth === 'api') {
    // 对外接口：只认 API 密钥，不看登录态
    ctx.client = authenticateApi({ req, ip: ctxBase.ip });
  } else if (r.opts.auth !== false) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE];
    const session = getSession(token);
    if (!session) throw new HttpError(401, '未登录或会话已过期');
    const user = loadUser(session.user_id);
    if (!user) throw new HttpError(401, '账号不可用');
    ctx.user = user;
    ctx.session = session;
    ctx.token = token;
    // 剩余不足 6 小时则续期
    if (new Date(session.expires_at).getTime() - Date.now() < 6 * 3600 * 1000) {
      const exp = touchSession(token);
      res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(exp).toUTCString()}`);
    }
  }

  if (req.method !== 'GET' && req.method !== 'DELETE') {
    const len = Number(req.headers['content-length'] || 0);
    const ct = String(req.headers['content-type'] || '');
    if (len > 0) {
      if (!ct.includes('application/json')) throw new HttpError(415, '请使用 JSON 提交');
      ctx.body = await readBody(req);
    }
  }

  if (ctx.client) {
    res.setHeader('X-Api-Client', ctx.client.client_id);
    res.setHeader('Cache-Control', 'no-store');
  }

  let result;
  try {
    result = await r.handler(ctx);
  } catch (err) {
    if (ctx.client) noteApiLog(ctx, null, err);
    throw err;
  }
  if (ctx.client) noteApiLog(ctx, result, null);

  if (req.method !== 'GET' && ctx.user && !r.opts.noAudit) {
    const safe = { ...(ctx.body || {}) };
    for (const k of ['password', 'oldPassword', 'newPassword']) delete safe[k];
    const detail = JSON.stringify(safe).slice(0, 800);
    dbRun(
      `insert into audit_logs(user_id,user_name,action,target_type,target_id,detail,ip,created_at)
       values(?,?,?,?,?,?,?,?)`,
      ctx.user.id, ctx.user.name, `${req.method} ${url.pathname}`, null,
      ctx.params.id ? Number(ctx.params.id) : null, detail, ctxBase.ip || '', new Date().toISOString()
    );
  }

  return result;
}

export function audit(user, action, targetType, targetId, detail, ip) {
  return { user, action, targetType, targetId, detail: typeof detail === 'string' ? detail : JSON.stringify(detail || {}), ip };
}

export function newNo(prefix) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${randomBytes(2).toString('hex').toUpperCase()}`;
}
