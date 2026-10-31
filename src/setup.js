import { one, run, tx, nowIso, idOf } from './db.js';
import { hashPassword } from './password.js';
import { setSetting } from './settings.js';
import { HttpError, bad } from './http.js';

/**
 * 首次安装引导
 *
 * 开源仓库不附带任何数据库文件：`npm start` 时只会建空表，
 * 由安装向导创建第一个集团与管理員账号。演示数据库需要到官网注册会员后下载。
 */

// count(*) 在 PG 里是 bigint（pg 驱动返回字符串），SQLite 里是整数，统一用 Number 收敛
export async function userCount() {
  try {
    const r = await one('select count(*) c from users');
    return r ? Number(r.c) : 0;
  } catch {
    // 表尚不存在（migrate 之前）
    return 0;
  }
}

/** 是否还需要安装（空库） */
export const setupNeeded = async () => (await userCount()) === 0;

/** 当前库是否是官网下载的演示库（含内置演示账号） */
export async function isDemoDb() {
  if (await setupNeeded()) return false;
  return !!(await one("select 1 from users where username = 'gm01'"));
}
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{2,23}$/;
function normalize(input) {
  const company = String(input.company || '').trim();
  const name = String(input.name || '').trim();
  const username = String(input.username || '').trim();
  const password = String(input.password || '');
  const email = String(input.email || '').trim();
  const phone = String(input.phone || '').trim();
  if (company.length < 2 || company.length > 40) throw bad('企业名称需 2–40 个字符');
  if (name.length < 2 || name.length > 20) throw bad('管理员姓名需 2–20 个字符');
  if (!USERNAME_RE.test(username)) throw bad('登录账号需以字母开头，3–24 位字母、数字、下划线或点');
  if (password.length < 8) throw bad('密码至少 8 位');
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) throw bad('密码需同时包含字母和数字');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('邮箱格式不正确');
  if (phone && !/^1[3-9]\d{9}$/.test(phone)) throw bad('手机号格式不正确');
  return {
    company,
    name,
    username,
    password,
    email,
    phone
  };
}

/**
 * 创建第一个组织（集团）与管理员账号。
 * 只在 users 表为空时可调用，避免被当成"再加一个管理员"的接口。
 */
export async function createWorkspace(input) {
  if (!(await setupNeeded())) throw new HttpError(403, '系统已完成初始化，请直接登录');
  const v = normalize(input);
  const now = nowIso();
  return await tx(async () => {
    const org = await run('insert into org_units(parent_id,path,name,type,code,sort,level,created_at) values(?,?,?,?,?,?,?,?)', null, '/', v.company, 'group', 'HQ', 0, 1, now);
    const orgId = idOf(org);
    await run('update org_units set path=? where id=?', `/${orgId}/`, orgId);
    const user = await run(`insert into users(username,name,password,email,phone,org_id,title,status,created_at)
       values(?,?,?,?,?,?,?,?,?)`, v.username, v.name, hashPassword(v.password), v.email || null, v.phone || null, orgId, '系统管理员', 'active', now);
    const userId = idOf(user);
    await run('insert into user_roles(user_id,role) values(?,?)', userId, 'admin');

    // 公司抬头默认用安装时填写的企业名称，后续可在「系统设置」里补全税号、地址、开户行
    await setSetting('company.name', v.company);
    await setSetting('company.short_name', v.company.slice(0, 8));
    await run(`insert into audit_logs(user_id, user_name, action, target_type, target_id, detail, ip, created_at)
       values(?,?,?,?,?,?,?,?)`, userId, v.name, 'setup', 'workspace', orgId, `完成初始化：${v.company}`, '', now);
    return {
      orgId,
      userId,
      username: v.username
    };
  });
}

/** 给前端/日志用的版本信息 */
export async function installInfo() {
  return {
    needed: await setupNeeded(),
    demo: await isDemoDb(),
    users: await userCount()
  };
}