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

export function userCount() {
  const t = one("select name from sqlite_master where type='table' and name='users'");
  if (!t) return 0;
  return Number(one('select count(*) c from users').c || 0);
}

/** 是否还需要安装（空库） */
export const setupNeeded = () => userCount() === 0;

/** 当前库是否是官网下载的演示库（含内置演示账号） */
export function isDemoDb() {
  if (setupNeeded()) return false;
  return !!one("select 1 from users where username = 'gm01'");
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

  return { company, name, username, password, email, phone };
}

/**
 * 创建第一个组织（集团）与管理员账号。
 * 只在 users 表为空时可调用，避免被当成"再加一个管理员"的接口。
 */
export function createWorkspace(input) {
  if (!setupNeeded()) throw new HttpError(403, '系统已完成初始化，请直接登录');

  const v = normalize(input);
  const now = nowIso();

  return tx(() => {
    const org = run(
      'insert into org_units(parent_id,path,name,type,code,sort,level,created_at) values(?,?,?,?,?,?,?,?)',
      null, '/', v.company, 'group', 'HQ', 0, 1, now
    );
    const orgId = idOf(org);
    run('update org_units set path=? where id=?', `/${orgId}/`, orgId);

    const user = run(
      `insert into users(username,name,password,email,phone,org_id,title,status,created_at)
       values(?,?,?,?,?,?,?,?,?)`,
      v.username, v.name, hashPassword(v.password), v.email || null, v.phone || null,
      orgId, '系统管理员', 'active', now
    );
    const userId = idOf(user);
    run('insert into user_roles(user_id,role) values(?,?)', userId, 'admin');

    // 公司抬头默认用安装时填写的企业名称，后续可在「系统设置」里补全税号、地址、开户行
    setSetting('company.name', v.company);
    setSetting('company.short_name', v.company.slice(0, 8));

    run(
      `insert into audit_logs(user_id, user_name, action, target_type, target_id, detail, ip, created_at)
       values(?,?,?,?,?,?,?,?)`,
      userId, v.name, 'setup', 'workspace', orgId, `完成初始化：${v.company}`, '', now
    );

    return { orgId, userId, username: v.username };
  });
}

/** 给前端/日志用的版本信息 */
export function installInfo() {
  return {
    needed: setupNeeded(),
    demo: isDemoDb(),
    users: userCount(),
  };
}
