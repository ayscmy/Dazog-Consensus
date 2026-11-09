#!/usr/bin/env node
// 方法二（Webhook + git push --mirror）离线集成自测
// 用两个本地裸仓库分别模拟 Gitee(origin) 与 GitHub(github)，
// 真实调用 git，验证：签名校验 / fetch -p origin / push --mirror github。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import http from 'node:http';

const ROOT = process.cwd();
const RECEIVER = join(ROOT, 'scripts', 'sync-receiver.mjs');
const SECRET = 'unit-test-secret-123';
const PORT = 8731;

function run(cmd, args, cwd) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => res({ code, out, err }));
  });
}
const git = (args, cwd) => run('git', args, cwd);
const sign = (ts) => createHmac('sha256', SECRET).update(`${ts}\n${SECRET}`).digest('base64');

function postWithTs(token, ts, event) {
  return new Promise((res) => {
    const data = JSON.stringify({ foo: 'bar' });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/webhook/gitee',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'X-Gitee-Token': token,
          'X-Gitee-Timestamp': String(ts),
          'X-Gitee-Event': event,
        },
      },
      (r) => {
        let b = '';
        r.on('data', (d) => (b += d));
        r.on('end', () => res({ status: r.statusCode, body: b }));
      }
    );
    req.on('error', (e) => res({ status: 0, body: String(e) }));
    req.write(data);
    req.end();
  });
}

async function waitForGithubHas(hash, dir, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const r = await git(['ls-remote', dir], ROOT);
    if (r.out.includes(hash)) return true;
    await new Promise((s) => setTimeout(s, 200));
  }
  return false;
}

// 用同一个时间戳生成签名与请求头，避免毫秒级误差导致校验失败
function signedPost(event) {
  const ts = Date.now();
  return postWithTs(sign(ts), ts, event);
}

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
}

let child;
(async () => {
  const base = mkdtempSync(join(tmpdir(), 'sync-test-'));
  const origin = join(base, 'origin.git');
  const github = join(base, 'github.git');
  const work = join(base, 'work');

  try {
    await git(['init', '--bare', origin], base);
    await git(['init', '--bare', github], base);
    await git(['init', '--initial-branch=main', work], base);
    await git(['config', 'user.email', 't@t.t'], work);
    await git(['config', 'user.name', 't'], work);
    writeFileSync(join(work, 'README.md'), '# test\n');
    await git(['add', '-A'], work);
    await git(['commit', '-m', 'init'], work);
    await git(['remote', 'add', 'origin', origin], work);
    await git(['remote', 'add', 'github', github], work);
    await git(['push', '-u', 'origin', 'main'], work);

    const firstHash = (await git(['rev-parse', 'main'], work)).out.trim();

    // 启动接收端
    child = spawn('node', [RECEIVER], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        GITEE_SECRET: SECRET,
        REPO_DIR: work,
        GITHUB_REMOTE: 'github',
      },
    });
    child.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
    await new Promise((s) => setTimeout(s, 600)); // 等服务起来

    // T1 错误签名 → 401
    const r1 = await postWithTs('wrong-token', String(Date.now()), 'Push Hook');
    check('T1 错误签名被拒(401)', r1.status === 401, `status=${r1.status}`);
    check('T1 GitHub 未变更（仍为空）', !(await git(['ls-remote', github], ROOT)).out.includes(firstHash));

    // T2 非 push 事件 → 200 ignored
    const r2 = await signedPost('Note Hook');
    check('T2 非推送事件被忽略(200)', r2.status === 200, `status=${r2.status}`);
    check('T2 GitHub 未变更', !(await git(['ls-remote', github], ROOT)).out.includes(firstHash));

    // T3 正确签名 + Push Hook → 镜像到 GitHub
    const r3 = await signedPost('Push Hook');
    check('T3 正确签名被接受(200)', r3.status === 200, `status=${r3.status}`);
    const t3ok = await waitForGithubHas(firstHash, github);
    check('T3 首次提交已镜像到 GitHub', t3ok);

    // T4 增量提交 + 再次推送 → 持续同步
    writeFileSync(join(work, 'v2.txt'), 'v2\n');
    await git(['add', '-A'], work);
    await git(['commit', '-m', 'v2'], work);
    await git(['push', 'origin', 'main'], work);
    const secondHash = (await git(['rev-parse', 'main'], work)).out.trim();
    const r4 = await signedPost('Push Hook');
    check('T4 二次推送被接受(200)', r4.status === 200, `status=${r4.status}`);
    const t4ok = await waitForGithubHas(secondHash, github);
    check('T4 增量提交已同步到 GitHub', t4ok);

    const failed = results.filter((r) => !r.ok);
    console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`);
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    if (child) child.kill();
    rmSync(base, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error('测试异常：', e);
  if (child) child.kill();
  process.exit(1);
});
