import { POST, GET, HttpError, bad } from '../http.js';
import * as A from '../auth.js';
import { DICT } from '../dict.js';
import { all, one } from '../db.js';
import { pendingCount } from '../approval.js';
import { DEMO_MODE, DEMO_RESET_HOURS, DEMO_HOME } from '../demo.js';
POST('/api/auth/login', async ctx => {
  const {
    username,
    password
  } = ctx.body || {};
  if (!username || !password) throw bad('请输入账号和密码');
  const key = `${ctx.ip}|${username}`;
  const wait = A.checkThrottle(key);
  if (wait > 0) throw new HttpError(429, `登录失败次数过多，请 ${wait} 秒后再试`);
  const r = await A.login(username, password, ctx.ip, ctx.req.headers['user-agent']);
  if (r.error) {
    A.noteFailure(key);
    // 离职/停用账号给出明确原因（仅在密码正确时才会走到这里）
    throw new HttpError(401, r.error, r.code ? {
      code: r.code,
      leftAt: r.leftAt
    } : undefined);
  }
  A.clearFailure(key);
  ctx.res.setHeader('Set-Cookie', `${A.COOKIE}=${r.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}`);
  return {
    user: r.user
  };
}, {
  auth: false
});
POST('/api/auth/logout', async ctx => {
  if (ctx.token) await A.destroySession(ctx.token);
  ctx.res.setHeader('Set-Cookie', `${A.COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return {
    ok: true
  };
});
GET('/api/auth/me', ctx => ({
  user: ctx.user
}));
POST('/api/auth/password', async ctx => {
  const {
    oldPassword,
    newPassword
  } = ctx.body || {};
  const r = await A.changePassword(ctx.user.id, oldPassword, newPassword);
  if (r.error) throw bad(r.error);
  ctx.res.setHeader('Set-Cookie', `${A.COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return {
    ok: true,
    relogin: true
  };
});

/** 前端启动时一次性拿到：当前用户、可见组织树、可见成员、字典、待办数 */
GET('/api/bootstrap', async ctx => {
  const u = ctx.user;
  const orgs = await A.visibleOrgs(u);
  const scope = A.peopleScope(u, 'u.org_id');
  const users = (await all(`select u.id, u.name, u.title, u.org_id, u.status, o.path as org_path,
            (select group_concat(role) from user_roles where user_id = u.id) as roles
     from users u join org_units o on o.id=u.org_id
     where u.status = 'active' and ${scope.sql} order by u.org_id, u.id`, ...scope.params)).map(x => ({
    id: x.id,
    name: x.name,
    title: x.title,
    orgId: x.org_id,
    roles: String(x.roles || '').split(',').filter(Boolean),
    relation: Number(x.org_id) === Number(u.orgId) ? 'same' : String(x.org_path || '').startsWith(u.orgPath) ? 'down' : 'up'
  }));
  return {
    user: u,
    orgs,
    users,
    dict: DICT,
    pending: await pendingCount(u),
    demo: DEMO_MODE ? {
      resetHours: DEMO_RESET_HOURS,
      home: DEMO_HOME
    } : null,
    serverTime: new Date().toISOString()
  };
});

/** 组织架构：三级分类 + 负责人 + 成员/客户数；只返回自己可见的组织 */
GET('/api/orgs', async ctx => {
  const orgs = await A.visibleOrgs(ctx.user);
  const counts = await all(`select o.id,
            (select count(*) from users u where u.org_id = o.id and u.status='active') as users,
            (select count(*) from accounts a where a.org_id = o.id) as accounts
     from org_units o`);
  const leads = await all(`select u.org_id, u.id, u.name, r.role
     from users u join user_roles r on r.user_id=u.id
     where u.status='active' and r.role in ('gm','director','manager')
     order by u.id`);
  const map = Object.fromEntries(counts.map(c => [c.id, c]));
  const leadMap = {};
  leads.forEach(l => {
    (leadMap[l.org_id] = leadMap[l.org_id] || []).push({
      id: l.id,
      name: l.name,
      role: l.role
    });
  });
  return orgs.map(o => ({
    ...o,
    users: map[o.id]?.users || 0,
    accounts: map[o.id]?.accounts || 0,
    leaders: leadMap[o.id] || []
  }));
});
GET('/api/users', async ctx => {
  const scope = A.peopleScope(ctx.user, 'u.org_id');
  return (await all(`select u.id, u.username, u.name, u.title, u.email, u.phone, u.org_id, u.status, u.last_login_at,
            u.left_at, o.path as org_path,
            (select group_concat(role) from user_roles where user_id = u.id) as roles
     from users u join org_units o on o.id=u.org_id
     where ${scope.sql} order by u.org_id, u.id`, ...scope.params)).map(x => ({
    ...x,
    roles: String(x.roles || '').split(',').filter(Boolean)
  }));
});

/** 转让 / 交接对象：本部门及上级链中的在职人员，需具备对应模块权限 */
GET('/api/transfer-targets', async ctx => {
  const module = String(ctx.query.module || 'account');
  const scope = A.orgChainScope(ctx.user, 'u.org_id');
  return (await all(`select u.id, u.name, u.title, o.name as org_name, o.level as org_level,
            (select group_concat(role) from user_roles where user_id=u.id) as roles
     from users u join org_units o on o.id=u.org_id
     where u.status='active' and ${scope.sql}
     order by (u.org_id = ?) desc, o.path, u.id`, ...scope.params, ctx.user.orgId)).map(x => ({
    ...x,
    roles: String(x.roles || '').split(',').filter(Boolean)
  })).filter(x => x.roles.some(r => {
    const mods = A.ROLES[r]?.modules || [];
    return mods.includes('*') || mods.includes(module);
  }) && !x.roles.includes('admin')).map(x => ({
    ...x,
    is_self: Number(x.id) === Number(ctx.user.id)
  }));
});

/** 负责人下拉：经理可看到下属，业务员看自己 */
GET('/api/users/pickable', async ctx => {
  const u = ctx.user;
  if (u.scope === 'all') {
    return await all(`select u.id, u.name, u.title, o.name as org_name,
              (select group_concat(role) from user_roles where user_id = u.id) as roles
       from users u join org_units o on o.id=u.org_id where u.status='active' order by u.org_id, u.id`);
  }
  if (u.scope === 'org') {
    return await all(`select u.id, u.name, u.title, o.name as org_name,
              (select group_concat(role) from user_roles where user_id = u.id) as roles
       from users u join org_units o on o.id=u.org_id
       where u.status='active' and u.org_id in (select id from org_units where path like ?)
       order by u.org_id, u.id`, `${u.orgPath}%`);
  }
  return [await one('select id,name,title from users where id = ?', u.id)];
});