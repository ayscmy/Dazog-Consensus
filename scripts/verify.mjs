import '../src/env.js';
import { pool, SCHEMA } from '../src/db.js';

const tables = [
  'org_units', 'users', 'user_roles', 'sessions', 'accounts', 'contacts', 'leads',
  'opportunities', 'activities', 'quotations', 'contracts', 'payment_plans', 'invoices',
  'payments', 'payment_allocations', 'approvals', 'approval_steps', 'targets', 'products',
  'quotation_items', 'attachments', 'settings', 'audit_logs', 'handovers', 'contract_templates',
  'quote_sends', 'api_clients', 'api_logs'
];
let total = 0;
for (const t of tables) {
  try {
    const { rows } = await pool.query(`SELECT count(*)::int c FROM "${SCHEMA}"."${t}"`);
    const n = rows[0].c;
    total += n;
    console.log(`  ${t.padEnd(20)} ${String(n).padStart(5)}`);
  } catch (e) {
    console.log(`  ${t.padEnd(20)} ERR ${e.message}`);
  }
}
console.log(`\n  crm schema 总行数：${total}`);
await pool.end();
process.exit(0);
