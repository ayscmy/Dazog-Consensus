/**
 * 导出组织业务快照（编排器 / 运维调用）。只读源库，不写业务数据。
 *
 *   CRM_DB=<共享实例库> ORG_ID=<组织id> ORG_SNAPSHOT_FILE=<输出文件> \
 *     ORG_SNAPSHOT_PASS=<口令> node --no-warnings scripts/org-export.mjs
 *
 *   也可用 EMAIL=<会员邮箱> 代替 ORG_ID（按 tenants / trial_accounts 定位组织）。
 *
 * 快照以 AES-256-GCM 加密落盘，明文只存在于内存。输出一行 JSON 供父进程解析。
 */
import '../src/env.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const { exportOrg, locateOrgByEmail } = await import('../src/org-transfer.js');
const { seal, countRows } = await import('../src/org-snapshot.js');

const pass = String(process.env.ORG_SNAPSHOT_PASS || '');
const out = String(process.env.ORG_SNAPSHOT_FILE || '');
if (!pass) {
  console.error('缺少 ORG_SNAPSHOT_PASS（快照落盘口令）');
  process.exit(2);
}
if (!out) {
  console.error('缺少 ORG_SNAPSHOT_FILE（快照输出路径）');
  process.exit(2);
}

try {
  let orgId = Number(process.env.ORG_ID || 0);
  if (!orgId && process.env.EMAIL) orgId = await locateOrgByEmail(process.env.EMAIL);
  if (!orgId) {
    console.error('需要 ORG_ID 或 EMAIL 才能定位要导出的组织');
    process.exit(2);
  }

  const snap = await exportOrg(orgId);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(seal(snap, pass)), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    orgId: Number(snap.source.orgId),
    orgName: snap.source.orgName,
    checksum: snap.checksum,
    rows: countRows(snap),
    counts: snap.counts,
    file: out,
  }));
  process.exit(0);
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: String(e.message || e), status: e.status || null }));
  process.exit(1);
}
