import { dumpTables, DB_ENGINE, DB_FILE, ROOT_DIR } from './db.js';
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 逻辑备份：把每张表导出为 JSON 快照。
 * 支持两种后端——PostgreSQL（走 crm schema）与 SQLite（走主库），
 * 不需要数据库停机，适合定时任务或手动 `npm run backup`。
 */
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = process.env.CRM_BACKUP_DIR || join(ROOT_DIR, 'data', 'backups');
mkdirSync(dir, { recursive: true });
const target = join(dir, `crm-${stamp}.json`);

const TABLES = [
  'org_units', 'users', 'user_roles', 'sessions', 'accounts', 'contacts', 'leads',
  'opportunities', 'activities', 'quotations', 'contracts', 'payment_plans', 'invoices',
  'payments', 'payment_allocations', 'approvals', 'approval_steps', 'targets', 'products',
  'quotation_items', 'attachments', 'settings', 'audit_logs', 'handovers',
  'contract_templates', 'quote_sends', 'api_clients', 'api_logs'
];

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
