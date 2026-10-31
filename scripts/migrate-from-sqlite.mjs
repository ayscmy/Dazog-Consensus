/**
 * 把旧版 SQLite 数据迁移到 PostgreSQL（crm schema）。
 *
 * 用法：
 *   node scripts/migrate-from-sqlite.mjs [sqlite路径]
 *   （默认读 process.env.CRM_DB 或 ./data/crm.db）
 *
 * 说明：
 *   - 按外键依赖顺序逐表迁移，保证引用完整性。
 *   - 每条记录用 `ON CONFLICT DO NOTHING`，可反复运行、幂等，不会因重复主键/唯一键报错。
 *   - 迁移完成后重置各表 SERIAL 序列，避免后续自增主键撞上已存在的 id。
 *   - contract_templates 也会被迁移：内置模板（TPL-*）因 code 唯一会跳过，用户自建模板会被带入。
 *
 * 注意：本脚本在「停掉旧 SQLite 版 CRM 服务之后、启动新版 PG 版之前」于服务器上运行一次即可。
 */
import '../src/env.js';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, SCHEMA, ROOT_DIR } from '../src/db.js';

const sqlitePath =
  process.argv[2] || process.env.CRM_DB || join(ROOT_DIR, 'data', 'crm.db');

if (!existsSync(sqlitePath)) {
  console.error(`找不到 SQLite 文件：${sqlitePath}`);
  process.exit(1);
}

// 外键依赖顺序（父表在前）
const ORDER = [
  'org_units', 'users', 'user_roles', 'sessions', 'accounts', 'contacts', 'leads',
  'opportunities', 'products', 'quotations', 'quotation_items', 'contracts',
  'payment_plans', 'invoices', 'payments', 'payment_allocations', 'approvals',
  'approval_steps', 'activities', 'targets', 'attachments', 'settings', 'audit_logs',
  'handovers', 'contract_templates', 'quote_sends', 'api_clients', 'api_logs'
];

const sdb = new DatabaseSync(sqlitePath);
try {
  sdb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
} catch {}

let migrated = 0;
for (const t of ORDER) {
  let cols;
  try {
    cols = sdb.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
  } catch {
    console.warn(`  ! 跳过未知表 ${t}`);
    continue;
  }
  if (!cols.length) continue;
  const rows = sdb.prepare(`SELECT * FROM "${t}"`).all();
  if (!rows.length) {
    console.log(`  ${t}: SQLite 无数据，跳过`);
    continue;
  }

  const colList = cols.map((c) => `"${c}"`).join(', ');
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `INSERT INTO "${SCHEMA}"."${t}" (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      const vals = cols.map((c) => (row[c] === undefined ? null : row[c]));
      await client.query(sql, vals);
    }
    await client.query('COMMIT');
    const { rows: cnt } = await client.query(`SELECT count(*)::int c FROM "${SCHEMA}"."${t}"`);
    console.log(`  ${t}: 迁移 ${rows.length} 行（当前 PG 共 ${cnt[0].c} 行）`);
    migrated += rows.length;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`  ${t}: 迁移失败 - ${e.message}`);
    throw e;
  } finally {
    client.release();
  }
}

// 重置 SERIAL 序列，避免后续插入撞主键
let seqFixed = 0;
for (const t of ORDER) {
  try {
    await pool.query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM "${SCHEMA}"."${t}"), 1))
       WHERE EXISTS (SELECT 1 FROM "${SCHEMA}"."${t}")`,
      [`"${SCHEMA}"."${t}"`]
    );
    seqFixed++;
  } catch {
    // 非 SERIAL 主键的表（user_roles/sessions/settings 等）忽略
  }
}

console.log(`\n迁移完成：${migrated} 行，${seqFixed} 张表序列已对齐。`);
sdb.close();
await pool.end();
process.exit(0);
