import { GET, POST, PATCH, bad, notFound, denied } from '../http.js';
import { all, one, run, tx, nowIso, idOf } from '../db.js';
import { hashPassword } from '../password.js';
import {
  ROLES, ROLE_ORDER, canManageUsers, canManageUser, assignableRoles, peopleScope, fmtLocal,
} from '../auth.js';
import { getSettings, setSetting, SETTING_LABELS, DEFAULTS } from '../settings.js';

/* =========================================================
   用户与角色：分级管理
   1 级 集团 → 系统管理员 / 总经理：全集团，可管任何角色
   2 级 公司 → 销售总监：本公司及下级，可管经理 / 客户经理 / 线索专员
   3 级 部门 → 销售经理：本部门及下级，可管客户经理 / 线索专员
   任何人都不能管理自己、不能管理管理员与总经理（管理员除外）
   ========================================================= */

const requireUserAdmin = (u) => {
  if (!canManageUsers(u)) throw denied('没有管理用户的权限');
};

function loadTarget(id) {
  const u = one(
    `select u.*, o.name as org_name, o.path as org_path, o.level as org_level,
            (select group_concat(role) from user_roles where user_id=u.id) as roles
     from users u join org_units o on o.id=u.org_id where u.id=?`,
    id
  );
  if (!u) throw notFound('用户不存在');
  return { ...u, roles: String(u.roles || '').split(',').filter(Boolean) };
}

function relationLabel(actor, target) {
  if (actor.scope === 'all') return '全集团';
  if (Number(target.org_id) === Number(actor.orgId)) return '同部门';
  return String(target.org_path || '').startsWith(actor.orgPath) ? '下级' : '上级';
}

/** 离职前要交接的资产盘点 */
function assetCounts(uid) {
  const c = (sql, ...p) => Number(one(sql, ...p).c || 0);
  return {
    accounts: c('select count(*) c from accounts where owner_id=?', uid),
    opportunities: c("select count(*) c from opportunities where owner_id=? and stage not in ('won','lost')", uid),
    wonOpportunities: c("select count(*) c from opportunities where owner_id=? and stage='won'", uid),
    leads: c("select count(*) c from leads where owner_id=? and status not in ('converted','invalid')", uid),
    contracts: c('select count(*) c from contracts where owner_id=?', uid),
    approvals: c(
      `select count(*) c from approval_steps s join approvals a on a.id=s.approval_id
       where s.approver_id=? and s.decision='pending' and a.status='pending'`, uid
    ),
  };
}

GET('/api/admin/users', (ctx) => {
  requireUserAdmin(ctx.user);
  const scope = peopleScope(ctx.user, 'u.org_id');
  const rows = all(
    `select u.id, u.username, u.name, u.title, u.email, u.phone, u.org_id, u.status,
            u.created_at, u.last_login_at, u.discount_limit,
            u.left_at, u.left_reason, u.handover_to, u.handover_at,
            o.name as org_name, o.path as org_path, o.level as org_level,
            h.name as handover_to_name,
            (select group_concat(role) from user_roles where user_id=u.id) as roles
     from users u
     join org_units o on o.id=u.org_id
     left join users h on h.id=u.handover_to
     where ${scope.sql}
     order by o.path, u.id`,
    ...scope.params
  ).map((x) => {
    const roles = String(x.roles || '').split(',').filter(Boolean);
    return {
      ...x,
      roles,
      relation: relationLabel(ctx.user, x),
      canManage: canManageUser(ctx.user, { ...x, roles }),
    };
  });
  return {
    rows,
    roles: ROLE_ORDER.map((k) => ({ key: k, label: ROLES[k].label, scope: ROLES[k].scope })),
    assignable: assignableRoles(ctx.user),
    actor: { id: ctx.user.id, name: ctx.user.name, role: ctx.user.role, scope: ctx.user.scope, orgPath: ctx.user.orgPath },
  };
});

POST('/api/admin/users', (ctx) => {
  requireUserAdmin(ctx.user);
  const b = ctx.body || {};
  if (!b.username || !b.name) throw bad('请填写账号和姓名');
  if (!b.password || String(b.password).length < 8) throw bad('初始密码至少 8 位');
  if (one('select id from users where username=?', b.username)) throw bad('账号已存在');
  const org = one('select * from org_units where id=?', b.org_id);
  if (!org) throw bad('请选择所属组织');
  if (ctx.user.scope === 'org' && !org.path.startsWith(ctx.user.orgPath)) {
    throw denied('只能在自己管理的组织下新增成员');
  }
  const roles = Array.isArray(b.roles) && b.roles.length ? b.roles : ['ae'];
  if (roles.some((r) => !ROLES[r])) throw bad('包含非法角色');
  const allowed = assignableRoles(ctx.user);
  if (roles.some((r) => !allowed.includes(r))) {
    throw denied(`按你的管理级别，只能授予：${allowed.map((r) => ROLES[r].label).join('、')}`);
  }

  const id = (() => {
    const r = run(
      'insert into users(username,name,password,email,phone,org_id,title,status,created_at) values(?,?,?,?,?,?,?,?,?)',
      b.username, b.name, hashPassword(b.password), b.email, b.phone, b.org_id, b.title, 'active', nowIso()
    );
    return idOf(r);
  })();
  for (const r of roles) run('insert into user_roles(user_id,role) values(?,?)', id, r);
  return { id };
});

PATCH('/api/admin/users/:id', (ctx) => {
  requireUserAdmin(ctx.user);
  const u = loadTarget(ctx.params.id);
  if (!canManageUser(ctx.user, u)) {
    throw denied('无权管理该用户：跨组织、或超出你的管理级别（不能管理管理员 / 总经理 / 上级）');
  }
  const b = ctx.body || {};
  if (b.status === 'left') throw bad('离职请走「办理离职交接」流程，不能直接把状态改成离职');
  const sets = [];
  const params = [];
  for (const f of ['name', 'title', 'email', 'phone', 'org_id', 'status', 'discount_limit']) {
    if (b[f] === undefined) continue;
    if (f === 'org_id' && ctx.user.scope === 'org') {
      const o = one('select path from org_units where id=?', b.org_id);
      if (!o || !o.path.startsWith(ctx.user.orgPath)) throw denied('只能把人调到你自己管理的组织下');
    }
    sets.push(`${f}=?`); params.push(b[f]);
  }
  if (b.password) {
    if (String(b.password).length < 8) throw bad('密码至少 8 位');
    sets.push('password=?');
    params.push(hashPassword(b.password));
  }
  if (sets.length) {
    params.push(u.id);
    run(`update users set ${sets.join(',')} where id=?`, ...params);
  }
  if (Array.isArray(b.roles)) {
    if (!b.roles.length) throw bad('至少保留一个角色');
    const allowed = assignableRoles(ctx.user);
    if (b.roles.some((r) => !allowed.includes(r))) {
      throw denied(`按你的管理级别，只能授予：${allowed.map((r) => ROLES[r].label).join('、')}`);
    }
    run('delete from user_roles where user_id=?', u.id);
    for (const r of b.roles) if (ROLES[r]) run('insert into user_roles(user_id,role) values(?,?)', u.id, r);
    // 角色变更后强制重新登录，避免旧会话沿用旧权限
    run('delete from sessions where user_id=?', u.id);
  }
  if (b.status && b.status !== 'active') run('delete from sessions where user_id=?', u.id);
  return { ok: true };
});

/* ---------------- 离职交接 ---------------- */

GET('/api/admin/users/:id/handover', (ctx) => {
  requireUserAdmin(ctx.user);
  const target = loadTarget(ctx.params.id);
  if (!canManageUser(ctx.user, target)) throw denied('无权办理该用户的离职交接');
  const scope = peopleScope(ctx.user, 'u.org_id');
  const candidates = all(
    `select u.id, u.name, u.title, u.status, o.name as org_name, o.level as org_level,
            (select group_concat(role) from user_roles where user_id=u.id) as roles
     from users u join org_units o on o.id=u.org_id
     where u.status='active' and u.id<>? and ${scope.sql}
     order by (u.org_id = ?) desc, o.path, u.id`,
    target.id, ...scope.params, target.org_id
  ).map((x) => ({ ...x, roles: String(x.roles || '').split(',').filter(Boolean) }));
  return {
    user: {
      id: target.id, name: target.name, username: target.username, title: target.title,
      org_name: target.org_name, org_level: target.org_level, status: target.status,
      left_at: target.left_at, roles: target.roles,
      handover_to: target.handover_to, handover_at: target.handover_at,
    },
    assets: assetCounts(target.id),
    candidates,
  };
});

POST('/api/admin/users/:id/handover', (ctx) => {
  requireUserAdmin(ctx.user);
  const target = loadTarget(ctx.params.id);
  if (target.status === 'left') throw bad(`该用户已于 ${fmtLocal(target.left_at)} 离职，无需重复办理`);
  if (!canManageUser(ctx.user, target)) throw denied('无权办理该用户的离职交接');

  const b = ctx.body || {};
  if (!b.to_user_id) throw bad('请选择交接接收人');
  const to = one(
    `select u.*, o.path as org_path,
            (select group_concat(role) from user_roles where user_id=u.id) as roles
     from users u join org_units o on o.id=u.org_id where u.id=?`,
    b.to_user_id
  );
  if (!to || to.status !== 'active') throw bad('接收人必须是在职账号');
  if (Number(to.id) === Number(target.id)) throw bad('不能交接给本人');

  const scope = peopleScope(ctx.user, 'u.org_id');
  const inScope = one(`select u.id from users u where u.id=? and ${scope.sql}`, to.id, ...scope.params);
  if (!inScope) throw denied('接收人不在你的管理范围内');

  // 至少保留一位在用的系统管理员
  if (target.roles.includes('admin')) {
    const admins = Number(one(
      `select count(*) c from users u join user_roles r on r.user_id=u.id
       where r.role='admin' and u.status='active' and u.id<>?`, target.id
    ).c || 0);
    if (admins < 1) throw bad('系统至少要保留一位在用的系统管理员，不能把他交接离职');
  }

  const want = b.assets || {};
  const toRoles = String(to.roles || '').split(',').filter(Boolean);
  const now = nowIso();
  const moved = { accounts: 0, opportunities: 0, leads: 0, contracts: 0, approvals: 0 };
  let approvalLeft = 0;

  tx(() => {
    if (want.accounts) {
      moved.accounts = Number(run(
        'update accounts set owner_id=?, org_id=?, updated_at=? where owner_id=?',
        to.id, to.org_id, now, target.id
      ).changes || 0);
    }
    if (want.opportunities) {
      moved.opportunities = Number(run(
        'update opportunities set owner_id=?, updated_at=? where owner_id=?',
        to.id, now, target.id
      ).changes || 0);
    }
    if (want.leads) {
      moved.leads = Number(run(
        'update leads set owner_id=?, org_id=?, updated_at=? where owner_id=?',
        to.id, to.org_id, now, target.id
      ).changes || 0);
    }
    if (want.contracts) {
      moved.contracts = Number(run(
        'update contracts set owner_id=?, updated_at=? where owner_id=?',
        to.id, now, target.id
      ).changes || 0);
    }
    if (want.approvals) {
      const pending = all(
        `select s.id, s.role from approval_steps s join approvals a on a.id=s.approval_id
         where s.approver_id=? and s.decision='pending' and a.status='pending'`,
        target.id
      );
      for (const s of pending) {
        // 只有接收人具备该节点角色时才转，否则留在原单据上由管理员改派
        if (!toRoles.includes(s.role)) { approvalLeft++; continue; }
        run('update approval_steps set approver_id=? where id=?', to.id, s.id);
        moved.approvals++;
      }
    }

    run(
      `update users set status='left', left_at=?, left_reason=?, handover_to=?, handover_at=? where id=?`,
      now, b.reason || null, to.id, now, target.id
    );
    run('delete from sessions where user_id=?', target.id);
    run(
      `insert into handovers(user_id,to_user_id,accounts,opportunities,leads,contracts,approvals,left_at,note,created_by,created_at)
       values(?,?,?,?,?,?,?,?,?,?,?)`,
      target.id, to.id, moved.accounts, moved.opportunities, moved.leads, moved.contracts,
      moved.approvals, now, b.reason || null, ctx.user.id, now
    );
  });

  return {
    ok: true,
    leftAt: now,
    leftAtText: fmtLocal(now),
    to: { id: to.id, name: to.name },
    moved,
    approvalLeft,
    message: `${target.name} 已于 ${fmtLocal(now)} 离职，账号已停用；资产已交接给 ${to.name}`,
  };
});

/** 管理员恢复已离职账号（离职日期保留在备注里，避免误操作无痕） */
POST('/api/admin/users/:id/restore', (ctx) => {
  if (ctx.user.role !== 'admin') throw denied('只有系统管理员可以恢复离职账号');
  const u = loadTarget(ctx.params.id);
  if (u.status !== 'left') throw bad('该账号不在离职状态');
  run(
    `update users set status='active', left_at=null, left_reason=null, handover_to=null, handover_at=null where id=?`,
    u.id
  );
  return { ok: true };
});

/* ---------------- 组织架构 ---------------- */

POST('/api/admin/orgs', (ctx) => {
  if (!['admin', 'gm'].includes(ctx.user.role)) throw denied('只有系统管理员或总经理可以维护组织');
  const b = ctx.body || {};
  if (!b.name) throw bad('请填写组织名称');
  const parent = b.parent_id ? one('select * from org_units where id=?', b.parent_id) : null;
  const parentPath = parent ? parent.path : '/';
  const level = (parent ? Number(parent.level || 0) : 0) + 1;
  if (level > 4) throw bad('组织层级最多 4 级（集团 / 公司 / 部门 / 团队）');
  const r = run(
    'insert into org_units(parent_id,path,name,type,code,sort,level,created_at) values(?,?,?,?,?,?,?,?)',
    parent ? parent.id : null, parentPath, b.name, b.type || 'dept', b.code, Number(b.sort || 0), level, nowIso()
  );
  const id = idOf(r);
  run('update org_units set path=? where id=?', `${parentPath}${id}/`, id);
  return { id, level };
});

GET('/api/admin/audit', (ctx) => {
  if (!['admin', 'gm'].includes(ctx.user.role)) throw denied('无权查看审计日志');
  const where = [];
  const params = [];
  if (ctx.query.action) { where.push('action LIKE ?'); params.push(`%${ctx.query.action}%`); }
  if (ctx.query.user) { where.push('user_id=?'); params.push(Number(ctx.query.user)); }
  return {
    rows: all(
      `select * from audit_logs ${where.length ? 'where ' + where.join(' and ') : ''}
       order by id desc limit 300`,
      ...params
    ),
  };
});

GET('/api/admin/targets', (ctx) => {
  if (!['admin', 'gm', 'director', 'manager'].includes(ctx.user.role)) throw denied('无权查看目标');
  const period = ctx.query.period || new Date().toISOString().slice(0, 7);
  const scope = peopleScope(ctx.user, 'u.org_id');
  return {
    period,
    rows: all(
      `select t.*, u.name as user_name, o.name as org_name from targets t
       join users u on u.id=t.user_id join org_units o on o.id=t.org_id
       where t.period=? and ${scope.sql} order by o.path, u.id`,
      period, ...scope.params
    ),
  };
});

POST('/api/admin/targets', (ctx) => {
  if (!['admin', 'gm', 'director', 'manager'].includes(ctx.user.role)) throw denied('无权设置目标');
  const b = ctx.body || {};
  if (!b.user_id || !b.period || !(Number(b.amount) >= 0)) throw bad('请填写完整的目标信息');
  const target = one('select * from users where id=?', b.user_id);
  if (!target) throw bad('用户不存在');
  if (ctx.user.scope === 'org') {
    const o = one('select path from org_units where id=?', target.org_id);
    if (!o || !o.path.startsWith(ctx.user.orgPath)) throw denied('只能为本部门设置目标');
  }
  const exists = one('select id from targets where user_id=? and period=?', b.user_id, b.period);
  if (exists) {
    run('update targets set amount=? where id=?', Number(b.amount), exists.id);
    return { id: exists.id, updated: true };
  }
  const r = run(
    'insert into targets(user_id,org_id,period,amount,created_at) values(?,?,?,?,?)',
    b.user_id, target.org_id, b.period, Number(b.amount), nowIso()
  );
  return { id: idOf(r) };
});

/* ---------------- 系统设置 ---------------- */

GET('/api/settings', (ctx) => {
  if (ctx.user.role !== 'admin' && ctx.user.role !== 'gm') throw denied('只有管理员或总经理可以查看系统设置');
  return {
    values: getSettings(),
    schema: SETTING_LABELS,
    canEdit: ctx.user.role === 'admin',
    roles: ROLE_ORDER.map((k) => ({ key: k, label: ROLES[k].label })),
    approvers: all(
      `select u.id, u.name, u.discount_limit, o.name as org_name,
              (select group_concat(role) from user_roles where user_id = u.id) as roles
       from users u join org_units o on o.id = u.org_id
       where u.status = 'active'
         and exists (select 1 from user_roles r where r.user_id = u.id and r.role in ('manager','director','gm'))
       order by o.path, u.id`
    ).map((x) => ({ ...x, roles: String(x.roles || '').split(',') })),
  };
});

PATCH('/api/settings', (ctx) => {
  if (ctx.user.role !== 'admin') throw denied('只有系统管理员可以修改系统设置');
  const b = ctx.body || {};
  const values = b.values || {};
  const keys = Object.keys(values);
  if (!keys.length) return { ok: true, changed: 0 };
  for (const k of keys) {
    if (!(k in DEFAULTS)) throw bad(`未知设置项：${k}`);
    setSetting(k, values[k]);
  }
  return { ok: true, changed: keys.length };
});
