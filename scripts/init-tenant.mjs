/**
 * 初始化一个租户实例的数据库（由 tenant-provision.js 以子进程调用）
 *
 *   CRM_DB=<租户库> TENANT_ORG_NAME=... TENANT_ADMIN_PASS=... \
 *     node scripts/init-tenant.mjs
 *
 * 为什么用子进程：db.js 在模块求值期就锁定数据库文件，同一进程无法为多个租户建库。
 * 输出一行 JSON 供父进程解析。
 */
import '../src/env.js';
import { hashPassword } from '../src/password.js';

const db = await import('../src/db.js');

const orgName = String(process.env.TENANT_ORG_NAME || '企业').slice(0, 80) || '企业';
const adminUser = String(process.env.TENANT_ADMIN_USER || 'admin').slice(0, 40) || 'admin';
const adminPass = String(process.env.TENANT_ADMIN_PASS || '');
const adminName = String(process.env.TENANT_ADMIN_NAME || '系统管理员').slice(0, 40);

if (!adminPass || adminPass.length < 8) {
  console.error('缺少 TENANT_ADMIN_PASS 或长度不足 8 位');
  process.exit(2);
}

await db.migrate();

const now = db.nowIso();
let root = await db.one('select * from org_units where parent_id is null order by id limit 1');
if (!root) {
  const r = await db.run(
    "insert into org_units(name,type,path,level,created_at) values(?,?,?,?,?)",
    orgName, 'group', '/', 1, now
  );
  const id = db.idOf(r);
  await db.run('update org_units set path=? where id=?', `/${id}/`, id);
  root = await db.one('select * from org_units where id=?', id);
}

const exists = await db.one('select id from users where username=?', adminUser);
let created = false;
if (!exists) {
  const r = await db.run(
    `insert into users(username,name,password,email,phone,org_id,title,status,created_at)
     values(?,?,?,?,?,?,?,?,?)`,
    adminUser, adminName, hashPassword(adminPass), null, null, root.id, '系统管理员', 'active', now
  );
  await db.run('insert into user_roles(user_id,role) values(?,?)', db.idOf(r), 'admin');
  created = true;
}

console.log(JSON.stringify({ ok: true, orgId: root.id, adminUser, created }));
process.exit(0);
