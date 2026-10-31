import { randomBytes } from 'node:crypto';
import { one, run, all, nowIso } from './db.js';
import { verifyPassword, hashPassword } from './password.js';
export const COOKIE = 'crm_sid';
const SESSION_HOURS = 12;

/**
 * 角色定义
 * scope: all = 全集团 | org = 所在组织子树 | self = 仅本人负责的数据
 * modules: 可访问的功能模块
 */
export const ROLES = {
  admin: {
    label: '系统管理员',
    scope: 'all',
    modules: ['*']
  },
  gm: {
    label: '总经理',
    scope: 'all',
    modules: ['dashboard', 'lead', 'account', 'opportunity', 'quotation', 'contract', 'finance', 'approval', 'report', 'product']
  },
  director: {
    label: '销售总监',
    scope: 'org',
    modules: ['dashboard', 'lead', 'account', 'opportunity', 'quotation', 'contract', 'approval', 'report', 'team', 'product', 'admin']
  },
  manager: {
    label: '销售经理',
    scope: 'org',
    modules: ['dashboard', 'lead', 'account', 'opportunity', 'quotation', 'contract', 'approval', 'report', 'team', 'product', 'admin']
  },
  ae: {
    label: '客户经理',
    scope: 'self',
    modules: ['dashboard', 'lead', 'account', 'opportunity', 'quotation', 'contract', 'approval', 'report', 'product']
  },
  sdr: {
    label: '线索专员',
    scope: 'self',
    modules: ['dashboard', 'lead', 'account', 'report']
  },
  finance: {
    label: '财务',
    scope: 'all',
    modules: ['dashboard', 'contract', 'finance', 'approval', 'report']
  },
  legal: {
    label: '法务',
    scope: 'all',
    modules: ['dashboard', 'contract', 'approval']
  }
};
export const ROLE_ORDER = ['admin', 'gm', 'director', 'manager', 'ae', 'sdr', 'finance', 'legal'];

/**
 * 分级管理：谁能管理哪些人
 * level 1（集团）→ 管理员 / 总经理：全集团
 * level 2（公司）→ 销售总监：本公司及下级，只能管销售经理、客户经理、线索专员
 * level 3（部门）→ 销售经理：本部门及下级，只能管客户经理、线索专员
 * 规则：不能管理自己；不能管理管理员与总经理（除非自己是管理员）；不能跨出自己所在组织子树
 */
export const MANAGE_RULES = {
  admin: {
    scope: 'all',
    roles: null
  },
  gm: {
    scope: 'all',
    roles: ['director', 'manager', 'ae', 'sdr', 'finance', 'legal']
  },
  director: {
    scope: 'org',
    roles: ['manager', 'ae', 'sdr']
  },
  manager: {
    scope: 'org',
    roles: ['ae', 'sdr']
  }
};
export function canManageUsers(user) {
  return !!MANAGE_RULES[user.role];
}
export function manageableRoles(user) {
  const rule = MANAGE_RULES[user.role];
  if (!rule) return [];
  return rule.roles || ROLE_ORDER;
}

/** 能否管理某个目标用户（target 需含 id / org_id / roles） */
export async function canManageUser(actor, target) {
  const rule = MANAGE_RULES[actor.role];
  if (!rule) return false;
  if (Number(actor.id) === Number(target.id)) return false;
  const targetRoles = target.roles || [];
  if (actor.role !== 'admin' && (targetRoles.includes('admin') || targetRoles.includes('gm'))) return false;
  if (rule.scope === 'org') {
    const o = await one('select path from org_units where id = ?', target.org_id);
    if (!o || !o.path.startsWith(actor.orgPath)) return false;
  }
  if (rule.roles && targetRoles.length && targetRoles.some(r => !rule.roles.includes(r))) return false;
  return true;
}

/** 发起人可授予的角色：不超过自己的管理上限，且不能凭空造管理员 */
export function assignableRoles(actor) {
  if (actor.role === 'admin') return ROLE_ORDER;
  const rule = MANAGE_RULES[actor.role];
  if (!rule) return [];
  return rule.roles || [];
}
export function primaryRole(roles) {
  for (const r of ROLE_ORDER) if (roles.includes(r)) return r;
  return 'ae';
}
function modulesOf(roles) {
  const set = new Set();
  for (const r of roles) {
    const def = ROLES[r];
    if (!def) continue;
    if (def.modules.includes('*')) return ['*'];
    def.modules.forEach(m => set.add(m));
  }
  return [...set];
}

/** 多个角色时取最大的数据范围 */
function scopeOf(roles) {
  const order = {
    all: 3,
    org: 2,
    self: 1
  };
  let best = 'self';
  for (const r of roles) {
    const s = ROLES[r]?.scope;
    if (s && order[s] > order[best]) best = s;
  }
  return best;
}
export async function loadUser(id) {
  const u = await one(`select u.*, o.name as org_name, o.path as org_path, o.type as org_type,
            p.name as parent_org_name
     from users u
     join org_units o on o.id = u.org_id
     left join org_units p on p.id = o.parent_id
     where u.id = ?`, id);
  if (!u || u.status !== 'active') return null;
  const roles = (await all('select role from user_roles where user_id = ?', id)).map(r => r.role);
  return shapeUser(u, roles);
}
function shapeUser(u, roles) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    email: u.email,
    phone: u.phone,
    title: u.title,
    orgId: u.org_id,
    orgName: u.org_name,
    orgPath: u.org_path,
    orgType: u.org_type,
    parentOrgName: u.parent_org_name,
    roles,
    role: primaryRole(roles),
    roleLabel: ROLES[primaryRole(roles)]?.label || '',
    scope: scopeOf(roles),
    modules: modulesOf(roles),
    lastLoginAt: u.last_login_at
  };
}

/** 数据范围 SQL 片段 */
export function scopeFilter(user, {
  owner = 'owner_id',
  org = 'org_id'
} = {}) {
  if (user.scope === 'all') return {
    sql: '1=1',
    params: []
  };
  if (user.scope === 'org') {
    return {
      sql: `${org} IN (SELECT id FROM org_units WHERE path LIKE ?)`,
      params: [`${user.orgPath}%`]
    };
  }
  return {
    sql: `${owner} = ?`,
    params: [user.id]
  };
}
export function canModule(user, module) {
  return user.modules.includes('*') || user.modules.includes(module);
}

/** 记录级写权限：本人 / 本组织子树 / 全集团 */
export async function canEditRecord(user, rec, {
  ownerField = 'owner_id',
  orgField = 'org_id'
} = {}) {
  if (user.scope === 'all') return true;
  if (user.scope === 'org') {
    const orgId = rec[orgField];
    if (!orgId) return false;
    const o = await one('select path from org_units where id = ?', orgId);
    return !!o && o.path.startsWith(user.orgPath);
  }
  return Number(rec[ownerField]) === Number(user.id);
}
export async function isManagerOf(user, otherUserId) {
  if (user.scope === 'all') return true;
  const other = await one('select org_id from users where id = ?', otherUserId);
  if (!other) return false;
  const o = await one('select path from org_units where id = ?', other.org_id);
  return user.scope === 'org' && !!o && o.path.startsWith(user.orgPath);
}

/* ---------------- 会话 ---------------- */

export async function createSession(user, ip, ua) {
  const token = randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
  await run('insert into sessions(token,user_id,created_at,expires_at,ip,ua) values(?,?,?,?,?,?)', token, user.id, nowIso(), exp, ip || '', String(ua || '').slice(0, 200));
  await run('update users set last_login_at = ? where id = ?', nowIso(), user.id);
  return token;
}
export async function getSession(token) {
  if (!token) return null;
  const s = await one('select * from sessions where token = ?', token);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    await run('delete from sessions where token = ?', token);
    return null;
  }
  return s;
}
export async function touchSession(token) {
  const exp = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
  await run('update sessions set expires_at = ? where token = ?', exp, token);
  return exp;
}
export async function destroySession(token) {
  await run('delete from sessions where token = ?', token);
}
export async function login(username, password, ip, ua) {
  const u = await one('select * from users where username = ?', String(username || '').trim());
  if (!u || !verifyPassword(password, u.password)) return {
    error: '账号或密码错误'
  };
  if (u.status === 'left') {
    return {
      error: `该账号已于 ${fmtLocal(u.left_at)} 离职，账号已停用，无法登录。`,
      code: 'left',
      leftAt: u.left_at
    };
  }
  if (u.status === 'leaving') {
    return {
      error: '该账号正在办理离职交接，暂时无法登录，请联系管理员',
      code: 'leaving'
    };
  }
  if (u.status !== 'active') return {
    error: '账号已停用，请联系系统管理员',
    code: 'disabled'
  };
  const roles = (await all('select role from user_roles where user_id = ?', u.id)).map(r => r.role);
  const user = shapeUser({
    ...u,
    org_name: (await one('select name from org_units where id=?', u.org_id))?.name,
    org_path: (await one('select path from org_units where id=?', u.org_id))?.path
  }, roles);
  const token = await createSession(user, ip, ua);
  return {
    token,
    user
  };
}

/** 本地时间 YYYY-MM-DD HH:mm，用于"何时离职"这类给人看的提示 */
export function fmtLocal(iso) {
  if (!iso) return '未知时间';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 可见组织：全集团 / 本组织子树 + 祖先（上级），不含兄弟部门 */
export async function visibleOrgs(user) {
  const rows = await all('select id, parent_id, name, type, code, path, level from org_units order by path, sort');
  if (user.scope === 'all') return rows;
  if (user.scope !== 'org') return rows.filter(o => Number(o.id) === Number(user.orgId));
  const segs = String(user.orgPath || '').split('/').filter(Boolean).map(Number);
  const up = segs.slice(0, -1);
  return rows.filter(o => String(o.path).startsWith(user.orgPath) || up.includes(Number(o.id)));
}

/**
 * 组织链范围：本组织子树 + 祖先组织（含直接上级）。
 * 与 peopleScope 的区别：不受 scope='self' 限制，业务员也能看到自己的经理——
 * 转让客户、指定交接人这类"要交给上级"的场景必须用它。
 */
export function orgChainScope(user, col = 'u.org_id') {
  if (user.scope === 'all') return {
    sql: '1=1',
    params: []
  };
  const segs = String(user.orgPath || '').split('/').filter(Boolean).map(Number);
  if (!segs.length) return {
    sql: `${col} = ?`,
    params: [user.id]
  };
  const up = segs.slice(0, -1);
  const base = `${user.orgPath}%`;
  if (!up.length) {
    return {
      sql: `${col} IN (SELECT id FROM org_units WHERE path LIKE ?)`,
      params: [base]
    };
  }
  return {
    sql: `(${col} IN (SELECT id FROM org_units WHERE path LIKE ?) OR ${col} IN (${up.map(() => '?').join(',')}))`,
    params: [base, ...up]
  };
}

/** 人员可见范围（通讯录 / 组织架构 / 交接候选人）：
 * 本人所在组织子树（下级全员）+ 祖先组织（直接上级链），不含兄弟部门。
 * 注意：业务数据仍然只向下看，走 scopeFilter。
 */
export function peopleScope(user, col = 'u.org_id', idCol = 'u.id') {
  if (user.scope === 'all') return {
    sql: '1=1',
    params: []
  };
  if (user.scope === 'org') {
    const segs = String(user.orgPath || '').split('/').filter(Boolean).map(Number);
    const up = segs.slice(0, -1);
    const base = `${user.orgPath}%`;
    if (!up.length) {
      return {
        sql: `${col} IN (SELECT id FROM org_units WHERE path LIKE ?)`,
        params: [base]
      };
    }
    return {
      sql: `(${col} IN (SELECT id FROM org_units WHERE path LIKE ?) OR ${col} IN (${up.map(() => '?').join(',')}))`,
      params: [base, ...up]
    };
  }
  return {
    sql: `${idCol} = ?`,
    params: [user.id]
  };
}
export async function changePassword(userId, oldPwd, newPwd) {
  const u = await one('select password from users where id = ?', userId);
  if (!u) return {
    error: '用户不存在'
  };
  if (!verifyPassword(oldPwd, u.password)) return {
    error: '原密码不正确'
  };
  if (!newPwd || String(newPwd).length < 8) return {
    error: '新密码至少 8 位'
  };
  await run('update users set password = ? where id = ?', hashPassword(newPwd), userId);
  await run('delete from sessions where user_id = ?', userId);
  return {
    ok: true
  };
}

/* ---------------- 登录限流 ---------------- */
const attempts = new Map();
export function checkThrottle(key) {
  const rec = attempts.get(key);
  if (rec && rec.until > Date.now()) return Math.ceil((rec.until - Date.now()) / 1000);
  return 0;
}
export function noteFailure(key) {
  const rec = attempts.get(key) || {
    count: 0,
    until: 0
  };
  rec.count += 1;
  if (rec.count >= 5) {
    rec.count = 0;
    rec.until = Date.now() + 5 * 60 * 1000;
  }
  attempts.set(key, rec);
}
export function clearFailure(key) {
  attempts.delete(key);
}