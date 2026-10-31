// 一次性建表脚本：加载 .env 后执行 db.migrate()，在 PostgreSQL 上创建 crm schema 与全部表 + 种子模板。
import '../src/env.js';
import { migrate, pool } from '../src/db.js';

await migrate();
console.log('[migrate] crm schema + 28 张表 + 种子模板已就绪');
await pool.end();
process.exit(0);
