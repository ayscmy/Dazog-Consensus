/**
 * 租户实例编排 CLI
 *
 *   node scripts/provision-tenant.mjs --code=T-202611-847F
 *   node scripts/provision-tenant.mjs --all-pending
 *
 * 只建实例（目录 + 库 + 管理员），不启动进程；启停用 scripts/tenant-ctl.mjs。
 */
import '../src/env.js';

const { provisionTenant, provisionAllPending } = await import('../src/tenant-provision.js');

const codeArg = process.argv.find((a) => a.startsWith('--code='));
const code = codeArg ? codeArg.slice('--code='.length).trim() : '';
const allPending = process.argv.includes('--all-pending');

if (!code && !allPending) {
  console.error('用法：node scripts/provision-tenant.mjs --code=T-YYYYMM-XXXX  或  --all-pending');
  process.exit(2);
}

if (allPending) {
  const list = await provisionAllPending();
  console.log(JSON.stringify(list, null, 2));
  process.exit(list.some((x) => !x.ok) ? 1 : 0);
}

try {
  const out = await provisionTenant(code);
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
