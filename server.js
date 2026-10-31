import './src/env.js';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { createReadStream } from 'node:fs';
import { migrate, DB_FILE } from './src/db.js';
import { setupNeeded } from './src/setup.js';
import { dispatch, HttpError, parseCookies } from './src/http.js';
import { getSession, COOKIE } from './src/auth.js';
import { findQuoteByToken, renderSheetHtml } from './src/doc/quote-sheet.js';
import './src/routes/index.js';

const PORT = Number(process.env.PORT || 8081);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = join(process.cwd(), 'public');

migrate();
if (setupNeeded()) {
  console.log('[init] 检测到空数据库，请打开安装向导完成初始化：/setup.html');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res, pathname) {
  if (pathname === '/') {
    if (setupNeeded()) {
      res.writeHead(302, { Location: '/setup.html' });
      return res.end();
    }
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const session = getSession(token);
    res.writeHead(302, { Location: session ? '/app.html' : '/login.html' });
    return res.end();
  }
  // 还没初始化时，登录页直接引导到安装向导
  if (pathname === '/login.html' && setupNeeded()) {
    res.writeHead(302, { Location: '/setup.html' });
    return res.end();
  }
  // 已初始化后，安装向导不再可用
  if (pathname === '/setup.html' && !setupNeeded()) {
    res.writeHead(302, { Location: '/login.html' });
    return res.end();
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  const full = normalize(join(PUBLIC, decodeURIComponent(pathname)));
  if (!full.startsWith(PUBLIC)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const st = await stat(full);
    if (!st.isFile()) throw new Error('not a file');
    // 协商缓存：文件一变就失效，避免改动后浏览器仍跑旧脚本
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(full)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      ETag: etag,
      'Last-Modified': st.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
    });
    createReadStream(full).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 页面不存在');
  }
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    '';
  const url = new URL(req.url, 'http://localhost');
  try {
    // 客户免登录查看报价单：/q/<token>
    if (url.pathname.startsWith('/q/')) {
      const token = url.pathname.slice(3).replace(/\/+$/, '');
      const data = /^[a-f0-9]{16,64}$/.test(token) ? findQuoteByToken(token) : null;
      if (!data || !['approved', 'converted'].includes(data.q.status)) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`<!doctype html><meta charset="utf-8"><title>报价单不存在</title>
          <div style="font:14px/1.8 'Microsoft YaHei',sans-serif;color:#444;text-align:center;margin-top:120px">
            <div style="font-size:18px;font-weight:600;margin-bottom:8px">报价单不存在或已失效</div>
            <div style="color:#888">链接可能已过期，请联系您的销售顾问重新获取。</div></div>`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(renderSheetHtml(data, { autoPrint: url.searchParams.get('print') === '1' }));
      return;
    }

    if (req.url.startsWith('/api/')) {
      const out = await dispatch(req, res, { ip });
      if (!res.writableEnded && !res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(out ?? { ok: true }));
      }
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    if (err instanceof HttpError) {
      if (!res.writableEnded) {
        res.writeHead(err.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message, detail: err.detail }));
      }
    } else {
      console.error('[500]', req.method, req.url, err);
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '服务器内部错误' }));
      }
    }
  } finally {
    if (process.env.CRM_LOG !== '0' && req.url.startsWith('/api/')) {
      console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[启动失败] 端口 ${PORT} 已被占用。`);
    console.error('请修改 .env 里的 PORT（例如 8082），或先停掉占用该端口的进程。\n');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  MSERM CRM 网络版已启动');
  console.log(`  本机访问   http://localhost:${PORT}`);
  console.log(`  局域网访问 http://<本机IP>:${PORT}`);
  console.log(`  数据库     ${DB_FILE}`);
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在关闭服务...');
    server.close(() => process.exit(0));
  });
}
