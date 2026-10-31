import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

export class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}
export const bad = (msg, detail) => new HttpError(400, msg, detail);
export const denied = (msg = '没有权限') => new HttpError(403, msg);
export const notFound = (msg = '资源不存在') => new HttpError(404, msg);

const routes = [];

export function route(method, path, handler, opts = {}) {
  routes.push({ method, segs: path.split('/').filter(Boolean), handler, opts });
}
export const GET = (p, h, o) => route('GET', p, h, o);
export const POST = (p, h, o) => route('POST', p, h, o);
export const PUT = (p, h, o) => route('PUT', p, h, o);
export const PATCH = (p, h, o) => route('PATCH', p, h, o);

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

export function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((res, rej) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        rej(new HttpError(413, '请求内容过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => res(Buffer.concat(chunks)));
    req.on('error', rej);
  });
}

export async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw bad('请求体不是合法的 JSON');
  }
}

export async function dispatch(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  const pathSegs = url.pathname.split('/').filter(Boolean);
  let pathMatched = false;
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const params = match(r.segs, pathSegs);
    if (!params) continue;
    pathMatched = true;
    if (r.opts.auth && !ctx.member) throw new HttpError(401, '请先登录');
    if (r.opts.admin && ctx.member?.role !== 'admin') throw denied('需要管理员权限');
    if ((req.method === 'POST' || req.method === 'PATCH') && !r.opts.raw) ctx.body = await readJson(req);
    return r.handler({ ...ctx, req, res, params, url, query: url.searchParams });
  }
  if (pathMatched) throw new HttpError(405, '请求方法不被支持');
  throw notFound('接口不存在');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** 静态文件；目录用 index.html；.html 可省略后缀 */
export function makeStatic(root) {
  const ROOT = resolve(root);
  return async function serveStatic(req, res, pathname) {
    if (pathname === '/') pathname = '/index.html';
    let full = resolve(join(ROOT, decodeURIComponent(pathname)));
    if (!full.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const st = await stat(full);
      if (st.isDirectory()) full = join(full, 'index.html');
    } catch { /* 交给下面的读取抛错 */ }

    let finalPath = full;
    if (!extname(finalPath)) finalPath = `${finalPath}.html`;

    try {
      const st = await stat(finalPath);
      if (!st.isFile()) throw new Error('not a file');
      const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[extname(finalPath)] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
        ETag: etag,
        'Last-Modified': st.mtime.toUTCString(),
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      });
      createReadStream(finalPath).pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>404</title>
        <div style="font:15px/1.9 -apple-system,'Microsoft YaHei',sans-serif;text-align:center;margin-top:120px;color:#4b5563">
          <div style="font-size:22px;font-weight:600;color:#111827;margin-bottom:8px">页面不存在</div>
          <a href="/" style="color:#2f6bff">返回首页</a>
        </div>`);
    }
  };
}

/* ---------- 内存限流：单机够用，多实例请换 Redis ---------- */
const buckets = new Map();

export function hit(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, left: limit - 1, retryAfter: 0 };
  }
  b.count++;
  if (b.count > limit) {
    return { ok: false, left: 0, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  }
  return { ok: true, left: limit - b.count, retryAfter: 0 };
}

export function throttle(key, maxFails = 6, lockMs = 10 * 60 * 1000) {
  const state = buckets.get(`lock:${key}`) || { fails: 0, until: 0 };
  return {
    locked: state.until > Date.now(),
    wait: Math.max(0, Math.ceil((state.until - Date.now()) / 1000)),
    fail() {
      state.fails += 1;
      if (state.fails >= maxFails) {
        state.until = Date.now() + lockMs;
        state.fails = 0;
      }
      buckets.set(`lock:${key}`, state);
    },
    reset() { buckets.delete(`lock:${key}`); },
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if ((b.resetAt || b.until || 0) < now) buckets.delete(k);
  }
}, 60_000).unref();
