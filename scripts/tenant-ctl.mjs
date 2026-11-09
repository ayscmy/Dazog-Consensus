/**
 * 租户实例启停与健康检查
 *
 *   node scripts/tenant-ctl.mjs start  --code=T-202611-847F
 *   node scripts/tenant-ctl.mjs stop   --code=T-202611-847F
 *   node scripts/tenant-ctl.mjs status --code=T-202611-847F
 *
 * 开发/小规模用它即可；生产建议用 systemd 模板（docs/26）。
 * 进程以 detached 方式启动，父进程退出后继续运行，pid 写入租户目录的 app.pid。
 */
import '../src/env.js';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const db = await import('../src/db.js');

const cmd = String(process.argv[2] || '').trim();
const codeArg = process.argv.find((a) => a.startsWith('--code='));
const code = codeArg ? codeArg.slice('--code='.length).trim() : '';

if (!cmd || !code) {
  console.error('用法：node scripts/tenant-ctl.mjs start|stop|status --code=T-YYYYMM-XXXX');
  process.exit(2);
}

const t = await db.one('select * from tenants where code = ?', code);
if (!t) {
  console.error(`租户不存在：${code}`);
  process.exit(2);
}
if (!t.data_dir || !t.port) {
  console.error('该租户尚未编排，请先运行 provision-tenant.mjs');
  process.exit(2);
}

const pidFile = join(t.data_dir, 'app.pid');
const envFile = join(t.data_dir, '.env');
const dbFile = join(t.data_dir, 'data', 'crm.db');

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPid() {
  if (!existsSync(pidFile)) return 0;
  const n = Number(readFileSync(pidFile, 'utf8'));
  return Number.isFinite(n) ? n : 0;
}

if (cmd === 'start') {
  const old = readPid();
  if (isAlive(old)) {
    console.log(JSON.stringify({ ok: true, already: true, pid: old, port: Number(t.port) }));
    process.exit(0);
  }
  const child = spawn(process.execPath, ['--no-warnings', join(db.ROOT_DIR, 'server.js')], {
    cwd: db.ROOT_DIR,
    env: {
      ...process.env,
      ENV_FILE: envFile,
      CRM_DB: dbFile,
      PORT: String(t.port),
      HOST: '127.0.0.1',
      CRM_LOG: '0',
      TRIAL_API_KEY: '',
    },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  await db.run("update tenants set instance_state='running', updated_at=? where id=?", db.nowIso(), t.id);
  console.log(JSON.stringify({ ok: true, pid: child.pid, port: Number(t.port) }));
  process.exit(0);
}

if (cmd === 'stop') {
  const pid = readPid();
  let killed = false;
  if (isAlive(pid)) {
    try { process.kill(pid); killed = true; } catch { /* 忽略 */ }
  }
  try { rmSync(pidFile, { force: true }); } catch { /* 忽略 */ }
  await db.run("update tenants set instance_state='stopped', updated_at=? where id=?", db.nowIso(), t.id);
  console.log(JSON.stringify({ ok: true, pid: pid || null, killed }));
  process.exit(0);
}

if (cmd === 'status') {
  const pid = readPid();
  const alive = isAlive(pid);
  let health = null;
  try {
    const res = await fetch(`http://127.0.0.1:${t.port}/healthz`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) health = await res.json();
  } catch { /* 未启动 */ }
  console.log(JSON.stringify({
    ok: true, code: t.code, port: Number(t.port), pid: pid || null, alive, health,
    instanceState: t.instance_state,
  }, null, 2));
  process.exit(0);
}

console.error(`未知命令：${cmd}`);
process.exit(2);
