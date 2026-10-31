import { db, DB_FILE } from './db.js';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = process.env.CRM_BACKUP_DIR || join(dirname(DB_FILE), 'backups');
mkdirSync(dir, { recursive: true });

const target = join(dir, `crm-${stamp}.db`);

// VACUUM INTO 生成一致性快照，不需要停服务
db.exec(`VACUUM INTO '${target.replace(/\\/g, '/').replace(/'/g, "''")}'`);

const size = existsSync(target) ? (statSync(target).size / 1024).toFixed(0) : '?';
console.log(`备份完成：${target}（${size} KB）`);
