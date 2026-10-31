import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 极简 .env 加载器（零依赖）。
 * - 不覆盖已经存在的环境变量，方便容器/PM2 注入
 * - 支持 # 注释、空行、KEY=VALUE、可选引号
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.env.ENV_FILE || join(root, '.env');

if (existsSync(file)) {
  const text = readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
