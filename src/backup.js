import { dumpTables, DB_ENGINE, DB_FILE, ROOT_DIR, SCHEMA, all } from './db.js';
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 逻辑备份：把每张表导出为 JSON 快照。
 * 支持两种后端——PostgreSQL（走 crm schema）与 SQLite（走主库），
 * 不需要数据库停机，适合定时任务或手动 `npm run backup`。
 */

/**
 * 备份表清单。
 * db.js 新增表后必须同步登记到这里；下面的表数一致性自检会在漏登记时中止备份，
 * 避免「备份成功、恢复后却少了几张表」这种静默数据丢失。
 */
const TABLES = [
  'org_units', 'users', 'user_roles', 'sessions', 'accounts', 'contacts', 'leads',
  'pool_events',
  'opportunities', 'activities', 'quotations', 'contracts', 'payment_plans', 'invoices',
  'payments', 'payment_allocations', 'approvals', 'approval_steps', 'targets', 'products',
  'quotation_items', 'attachments', 'settings', 'audit_logs', 'handovers',
  'contract_templates', 'quote_sends', 'api_clients', 'api_logs',
  'trial_accounts', 'tenants'
];

/** 读取库中实际存在的业务表（排除 SQLite 内部表 / PostgreSQL 系统表）。 */
async function listActualTables() {
  const rows = DB_ENGINE === 'postgres'
    ? await all(
      "select table_name as name from information_schema.tables where table_schema = ? and table_type = 'BASE TABLE'",
      SCHEMA
    )
    : await all("select name from sqlite_master where type='table' and name not like 'sqlite_%'");
  return rows.map((r) => String(r.name)).sort();
}

// 表数一致性自检：宁可备份失败，也不能静默漏掉新表的数据。
const actual = await listActualTables();
const missing = actual.filter((t) => !TABLES.includes(t));
const stale = TABLES.filter((t) => !actual.includes(t));
if (missing.length) {
  console.error(`[备份中止] 以下表尚未登记到备份清单，继续备份会丢数据：${missing.join(', ')}`);
  console.error('请在 src/backup.js 的 TABLES 中补齐后重试。');
  process.exit(1);
}
if (stale.length) {
  console.warn(`[警告] 清单中的表在当前库不存在（可能尚未执行迁移）：${stale.join(', ')}`);
}
console.log(`[自检] 清单 ${TABLES.length} 张表，库内实际 ${actual.length} 张业务表，无遗漏。`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = process.env.CRM_BACKUP_DIR || join(ROOT_DIR, 'data', 'backups');
mkdirSync(dir, { recursive: true });
const target = join(dir, `crm-${stamp}.json`);

console.log(`正在备份（${DB_ENGINE === 'postgres' ? 'PostgreSQL' : 'SQLite'}）...`);
const dump = await dumpTables(TABLES);

let total = 0;
for (const t of TABLES) {
  const v = dump.tables[t];
  if (Array.isArray(v)) {
    total += v.length;
    console.log(`  ${t}: ${v.length} 行`);
  } else {
    console.warn(`  ${t}: 读取失败 - ${v && v.__error}`);
  }
}
writeFileSync(target, JSON.stringify(dump));
const size = existsSync(target) ? (statSync(target).size / 1024).toFixed(0) : '?';
console.log(`备份完成：${target}（${size} KB，${total} 行，${TABLES.length} 张表）`);
process.exit(0);
