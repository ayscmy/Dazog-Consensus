#!/usr/bin/env node
// ============================================================
// Gitee → GitHub 自动同步接收端（方法二：Webhook + git push --mirror）
//
// 零依赖 Node.js 服务。部署在一台能访问公网、且已 clone 好仓库镜像的
// 服务器上。Gitee 仓库配置 WebHook 指向本服务，每次 push 时 Gitee 主动
// 回调，本服务做签名校验后执行：
//
//     git fetch -p origin        # 从 Gitee 拉取最新（含所有分支/标签）
//     git push --mirror github   # 以镜像方式推到 GitHub（含删除同步）
//
// 环境变量（全部可选，有默认值）：
//   PORT               监听端口，默认 8080
//   GITEE_SECRET       WebHook 签名密钥（Gitee 管理后台设置的那串）。
//                      务必设置，否则拒绝所有请求。
//   REPO_DIR           镜像仓库目录，默认当前工作目录。
//                      建议用 `git clone --mirror` 得到的裸镜像仓库。
//   GITHUB_REMOTE      GitHub 远程别名，默认 github。
//   GIT_BIN           git 可执行文件，默认 git（测试时可用 mock 替换）。
//   TIME_TOLERANCE_MS 时间戳容差，默认 3600000（1 小时，与 Gitee 一致）。
//   PUSH_EVENTS       视为推送的事件名，逗号分隔，
//                     默认 "Push Hook,Tag Push Hook"。
//   GITHUB_TOKEN / GITHUB_OWNER / REPO_NAME
//                     可选：当 GitHub 仓库尚不存在、首次 push 报
//                     "repository not found" 时，用这两个变量自动建仓后重试。
//                     留空则跳过自动建仓。
// ============================================================
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.GITEE_SECRET || '';
const REPO_DIR = process.env.REPO_DIR || process.cwd();
const GITHUB_REMOTE = process.env.GITHUB_REMOTE || 'github';
const GIT_BIN = process.env.GIT_BIN || 'git';
const TIME_TOLERANCE_MS = Number(process.env.TIME_TOLERANCE_MS || 3600000);
const PUSH_EVENTS = new Set(
  (process.env.PUSH_EVENTS || 'Push Hook,Tag Push Hook')
    .split(',').map((s) => s.trim()).filter(Boolean)
);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = process.env.GITHUB_OWNER || '';
const REPO_NAME = process.env.REPO_NAME || 'mserm-crm';

let syncing = false;
const log = (...a) => console.log(`[sync-receiver ${new Date().toISOString()}]`, ...a);

// Gitee WebHook 签名：base64( HMAC-SHA256( timestamp + "\n" + secret , secret ) )
// 注意：头部里的 X-Gitee-Token 就是 base64 串，无需再做 urlDecode 反解。
function computeToken(timestamp, secret) {
  return createHmac('sha256', secret)
    .update(`${timestamp}\n${secret}`)
    .digest('base64');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function verify(req) {
  if (!SECRET) return { ok: false, reason: 'receiver secret not configured' };
  const ts = req.headers['x-gitee-timestamp'];
  const token = req.headers['x-gitee-token'];
  if (!ts || !token) return { ok: false, reason: 'missing signature headers' };
  const now = Date.now();
  if (Number.isNaN(Number(ts)) || Math.abs(now - Number(ts)) > TIME_TOLERANCE_MS) {
    return { ok: false, reason: 'timestamp out of range' };
  }
  if (!safeEqual(computeToken(ts, SECRET), token)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5e6) req.destroy(); // 5MB 上限，防滥用
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: REPO_DIR });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

async function createGithubRepo() {
  try {
    const res = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'sync-receiver',
      },
      body: JSON.stringify({
        name: REPO_NAME,
        private: false,
        has_issues: true,
        has_wiki: false,
        auto_init: false,
      }),
    });
    const ok = res.status === 201 || res.status === 200;
    log('github create repo status', res.status, ok ? 'ok' : 'fail');
    return ok;
  } catch (e) {
    log('github create failed:', e.message);
    return false;
  }
}

async function sync() {
  if (syncing) return { skipped: true, reason: 'sync_in_progress' };
  syncing = true;
  try {
    log('fetch -p origin ...');
    let r = await run(GIT_BIN, ['fetch', '-p', 'origin']);
    if (r.code !== 0) {
      log('fetch failed:', r.err.trim());
      return { ok: false, stage: 'fetch', err: r.err.trim() };
    }
    log('push --mirror', GITHUB_REMOTE, '...');
    r = await run(GIT_BIN, ['push', '--mirror', GITHUB_REMOTE]);
    if (r.code !== 0) {
      const notFound = /repository not found|could not read|remote error: not found|fatal:.*not found/i.test(
        r.err
      );
      if (notFound && GITHUB_TOKEN && GITHUB_OWNER) {
        log('repo missing on GitHub, auto-creating ...');
        if (await createGithubRepo()) {
          r = await run(GIT_BIN, ['push', '--mirror', GITHUB_REMOTE]);
        }
      }
      if (r.code !== 0) {
        log('push failed:', r.err.trim());
        return { ok: false, stage: 'push', err: r.err.trim() };
      }
    }
    log('sync ok');
    return { ok: true };
  } finally {
    syncing = false;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/healthz')) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('sync-receiver ok' + (SECRET ? '' : ' (WARNING: SECRET not set)'));
    return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/webhook/gitee')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const v = verify(req);
  if (!v.ok) {
    log('rejected:', v.reason);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: v.reason }));
    return;
  }

  const event = req.headers['x-gitee-event'] || '';
  if (PUSH_EVENTS.size && event && !PUSH_EVENTS.has(event)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ignored', event }));
    return;
  }

  // 先回 200 再异步同步，避免 Gitee 等待超时（Gitee 只在非 2xx 时重试）
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'accepted' }));

  try {
    await readBody(req); // 消费请求体，释放连接
  } catch {
    /* 忽略读取错误，同步仍按计划执行 */
  }
  sync()
    .then((r) => log('sync result:', JSON.stringify(r)))
    .catch((e) => log('sync error:', e.message));
});

server.listen(PORT, () => {
  log(`listening on :${PORT}`);
  log(`REPO_DIR=${REPO_DIR}  GITHUB_REMOTE=${GITHUB_REMOTE}  SECRET=${SECRET ? 'set' : 'EMPTY!'}`);
});
