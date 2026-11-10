/**
 * 把组织快照导入当前 CRM_DB 指向的库（编排器 / 运维调用）。
 *
 *   CRM_DB=<目标独立实例库> ORG_SNAPSHOT_FILE=<快照文件> \
 *     ORG_SNAPSHOT_PASS=<口令> node --no-warnings scripts/org-import.mjs
 *
 * 目标库业务表必须为空（全新实例库）；同一次快照重复导入会幂等返回 already。
 * 输出一行 JSON 供父进程解析；失败时进程退出码为 1。
 */
import '../src/env.js';
import { readFileSync } from 'node:fs';

const { importOrg } = await import('../src/org-transfer.js');
const { readSnapshotFile } = await import('../src/org-snapshot.js');

const file = String(process.env.ORG_SNAPSHOT_FILE || '');
const pass = String(process.env.ORG_SNAPSHOT_PASS || '');
if (!file) {
  console.error('缺少 ORG_SNAPSHOT_FILE（快照文件路径）');
  process.exit(2);
}
if (!pass) {
  console.error('缺少 ORG_SNAPSHOT_PASS（快照落盘口令）');
  process.exit(2);
}

let obj;
try {
  obj = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: `快照文件读取失败：${e.message}` }));
  process.exit(2);
}

try {
  const snap = readSnapshotFile(obj, pass);
  const out = await importOrg(snap, {
    orgName: String(process.env.ORG_NAME || '').trim() || undefined,
  });
  console.log(JSON.stringify({ ok: true, ...out }));
  process.exit(0);
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: String(e.message || e), status: e.status || null }));
  process.exit(1);
}
