import './src/env.js';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, SITE_DB, logEvent } from './src/db.js';
import { dispatch, HttpError, makeStatic } from './src/http.js';
import { currentMember, purgeExpired } from './src/auth.js';
import { ensureAdmin, SITE_NAME, SITE_URL } from './src/routes.js';
import { RELEASE_DIR, listVersions } from './src/versions.js';
import { mailReady } from './src/mail.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';

migrate();
purgeExpired();

const admin = ensureAdmin();
if (admin.created) {
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │  已创建官网管理员账号（请立即登录并修改密码）');
  console.log(`  │  邮箱：${admin.email}`);
  console.log(`  │  密码：${admin.password}`);
  console.log('  └──────────────────────────────────────────────┘');
}

const serveStatic = makeStatic(join(ROOT, 'public'));

const server = createServer(async (req, res) => {  const started = Date.now();
  const ip =
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    '';
  const url = new URL(req.url, 'http://localhost');

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  try {
    if (url.pathname.startsWith('/api/')) {
      const ctx = { ip, member: currentMember(req) };
      const out = await dispatch(req, res, ctx);
      if (!res.writableEnded && !res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(out ?? { ok: true }));
      }
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    if (err instanceof HttpError) {
      if (!res.writableEnded && !res.headersSent) {
        res.writeHead(err.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: err.message, detail: err.detail }));
      }
    } else {
      console.error('[500]', req.method, req.url, err);
      if (!res.writableEnded && !res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '服务器内部错误' }));
      }
    }
  } finally {
    if (process.env.SITE_LOG !== '0' && req.url.startsWith('/api/')) {
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

server.listen(PORT, HOST, () => {
  const versions = listVersions();
  console.log('');
  console.log(`  ${SITE_NAME} 官网已启动`);
  console.log(`  访问地址   ${SITE_URL}`);
  console.log(`  会员数据库 ${SITE_DB}`);
  console.log(`  安装包目录 ${RELEASE_DIR}`);
  console.log(`  邮件服务   ${mailReady() ? '已配置 SMTP' : '未配置（验证码输出到日志）'}`);
  console.log(`  已发布版本 ${versions.length ? versions.map((v) => v.version).join(', ') : '暂无（请登录后台发布）'}`);
  console.log('');
  logEvent('boot', `port=${PORT}`, '');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在关闭官网服务...');
    server.close(() => process.exit(0));
  });
}
