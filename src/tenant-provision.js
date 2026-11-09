import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { one, all, run, nowIso, ROOT_DIR } from './db.js';

/**
 * 租户实例编排（最小闭环）
 *
 * 形态：共享一份代码 + 每租户独立数据目录/库/进程。
 * 本模块只负责「建实例」：分配端口、建目录、初始化库与管理员、写回 tenants 台账。
 * 启停与健康检查见 scripts/tenant-ctl.mjs；生产环境建议用 systemd 模板（见 docs/26）。
 */

export const TENANT_ROOT = process.env.TENANT_ROOT || join(ROOT_DIR, 'tenants');
export const PORT_BASE = Number(process.env.TENANT_PORT_BASE || 18200);
export const PUBLIC_BASE = String(process.env.TENANT_PUBLIC_BASE || 'crm.example.com').replace(/^\.+|\.+$/g, '');

const SECRET = String(process.env.CRM_SECRET || 'mserm-tenant-provision-secret');
const KEY = createHash('sha256').update(SECRET).digest();

function enc(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}

function dec(token) {
  try {
    const [v, iv, tag, body] = String(token || '').split('.');
    if (v !== 'v1') return '';
    const d = createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function genPassword(len = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  const buf = randomBytes(len);
  for (let i = 0; i < len; i++) s += chars[buf[i] % chars.length];
  return s;
}

async function allocatePort() {
  const row = await one('select max(port) m from tenants where port is not null');
  return Math.max(PORT_BASE, Number(row?.m || 0) + 1);
}

function slugOf(code) {
  return String(code).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/**
 * 建实例（幂等）：已 provisioned/running 的租户直接返回既有信息。
 * 返回的管理员密码只在这里出现一次，同时以 AES 密文存库，重试可还原。
 */
export async function provisionTenant(code) {
  const t = await one('select * from tenants where code = ?', code);
  if (!t) throw new Error(`租户不存在：${code}`);

  if (['provisioned', 'running'].includes(t.instance_state) && t.data_dir && t.port) {
    return {
      ok: true, already: true,
      code: t.code, port: Number(t.port), dir: t.data_dir,
      adminUser: 'admin', adminPassword: dec(t.admin_password),
      instanceState: t.instance_state,
    };
  }

  const slug = slugOf(t.code);
  const dir = join(TENANT_ROOT, slug);
  const dataDir = join(dir, 'data');
  const dbFile = join(dataDir, 'crm.db');
  mkdirSync(dataDir, { recursive: true });

  const port = t.port ? Number(t.port) : await allocatePort();
  const password = dec(t.admin_password) || genPassword(12);

  // 租户自己的 .env：独立库、独立端口、关闭对外试用接口
  const envText = [
    `# 租户 ${t.code} · 由编排器生成，请勿手改端口`,
    'HOST=127.0.0.1',
    `PORT=${port}`,
    'DB_TYPE=sqlite',
    `CRM_DB=${dbFile}`,
    'CRM_LOG=0',
    '',
  ].join('\n');
  writeFileSync(join(dir, '.env'), envText);

  const child = spawnSync(process.execPath, ['--no-warnings', join(ROOT_DIR, 'scripts', 'init-tenant.mjs')], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ENV_FILE: join(dir, '.env'),
      CRM_DB: dbFile,
      TENANT_ORG_NAME: t.name,
      TENANT_ADMIN_USER: 'admin',
      TENANT_ADMIN_PASS: password,
      TENANT_ADMIN_NAME: `${t.name} 管理员`,
    },
    encoding: 'utf8',
    timeout: 60000,
  });

  if (child.status !== 0) {
    await run("update tenants set instance_state='failed', updated_at=? where id=?", nowIso(), t.id);
    throw new Error(`初始化失败：${(child.stderr || child.stdout || '').trim().slice(0, 400)}`);
  }

  await run(
    `update tenants set port=?, data_dir=?, subdomain=?, instance_state='provisioned',
       admin_password=?, updated_at=? where id=?`,
    port, dir, `${slug}.${PUBLIC_BASE}`, enc(password), nowIso(), t.id
  );

  return {
    ok: true,
    code: t.code,
    port,
    dir,
    dataDir,
    dbFile,
    subdomain: `${slug}.${PUBLIC_BASE}`,
    adminUser: 'admin',
    adminPassword: password,
    instanceState: 'provisioned',
    url: `http://127.0.0.1:${port}`,
  };
}

/** 列出待编排租户 */
export async function listPending() {
  return await all(`select code from tenants where instance_state in ('pending','failed') order by id`);
}

/** 遍历待编排租户 */
export async function provisionAllPending() {
  const rows = await listPending();
  const out = [];
  for (const r of rows) {
    try {
      out.push(await provisionTenant(r.code));
    } catch (e) {
      out.push({ ok: false, code: r.code, error: String(e.message || e) });
    }
  }
  return out;
}
