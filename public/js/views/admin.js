import { api } from '../api.js';
import { state, labels } from '../store.js';
import { icon } from '../icons.js';
import {
  esc, money, date, dateTime, relTime, badge, toast, modal, field, formData,
} from '../ui.js';

const TABS = [
  { key: 'users', label: '用户与角色' },
  { key: 'orgs', label: '组织架构' },
  { key: 'targets', label: '销售目标' },
  { key: 'audit', label: '审计日志' },
];

const LEVEL_TEXT = { 1: '1 级 · 集团', 2: '2 级 · 公司', 3: '3 级 · 部门', 4: '4 级 · 团队' };
const LEVEL_SHORT = { 1: '集团', 2: '公司', 3: '部门', 4: '团队' };
const ROLE_LABEL = {
  admin: '管理员', gm: '总经理', director: '销售总监', manager: '销售经理',
  ae: '客户经理', sdr: '线索专员', finance: '财务', legal: '法务',
};

export async function render(el, route, ctx) {
  const tab = route.query.tab || 'users';
  const canWrite = ['admin', 'gm', 'director', 'manager'].includes(state.user.role);
  const tabs = TABS.filter((t) => t.key !== 'audit' || ['admin', 'gm'].includes(state.user.role));
  el.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1>用户与组织</h1>
        <div class="desc">组织按 1/2/3 级分类；上级可管理下级，跨部门不可见也不可操作</div>
      </div>
      <div class="actions">
        ${tab === 'users' && canWrite ? `<button class="btn btn-primary" data-new-user>${icon('plus', 12)} 新增用户</button>` : ''}
        ${tab === 'orgs' && ['admin', 'gm'].includes(state.user.role) ? `<button class="btn btn-primary" data-new-org>${icon('plus', 12)} 新增组织</button>` : ''}
      </div>
    </div>
    <div class="toolbar" style="margin-bottom:14px">
      <div class="seg" id="tabs">
        ${tabs.map((t) => `<button class="${tab === t.key ? 'on' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}
      </div>
    </div>
    <div id="panel"><div class="empty">加载中…</div></div>
  </div>`;

  el.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => (location.hash = `#/admin?tab=${b.dataset.tab}`);
  });
  const panel = el.querySelector('#panel');
  const nu = el.querySelector('[data-new-user]');
  if (nu) nu.onclick = () => editUser(null, ctx);
  const no = el.querySelector('[data-new-org]');
  if (no) no.onclick = () => newOrg(ctx);

  if (tab === 'users') return renderUsers(panel, ctx);
  if (tab === 'orgs') return renderOrgs(panel, ctx);
  if (tab === 'targets') return renderTargets(panel, ctx);
  return renderAudit(panel);
}

/* ========================= 用户 ========================= */

function statusCell(u) {
  if (u.status === 'left') {
    return `${badge('已离职', 'red')}
      <div class="cell-sub">${date(u.left_at)} 离职${u.handover_to_name ? ` · 交接给 ${esc(u.handover_to_name)}` : ''}</div>`;
  }
  if (u.status === 'disabled') return badge('停用', 'gray');
  if (u.status === 'leaving') return badge('交接中', 'amber');
  return badge('在职', 'green');
}

async function renderUsers(panel, ctx) {
  const d = await api.get('/api/admin/users');
  const isAdmin = state.user.role === 'admin';
  const active = d.rows.filter((u) => u.status === 'active');
  const left = d.rows.filter((u) => u.status === 'left');

  panel.innerHTML = `<div class="listwrap"><div class="tablewrap">
    <table class="grid">
      <thead><tr>
        <th style="min-width:160px">姓名</th><th>账号</th><th style="min-width:170px">组织</th>
        <th>角色</th><th>关系</th><th style="min-width:130px">状态</th><th>最近登录</th><th></th>
      </tr></thead>
      <tbody>
        ${d.rows.map((u) => `<tr class="${u.status === 'left' ? 'user-left' : ''}" style="cursor:default">
          <td><div class="cell-main">${esc(u.name)}</div><div class="cell-sub">${esc(u.title || '')}</div></td>
          <td class="mono">${esc(u.username)}</td>
          <td>
            <div class="org-lv l${u.org_level || 1}"><span class="bar"></span>${esc(u.org_name)}</div>
            <div class="cell-sub">${LEVEL_TEXT[u.org_level] || `${u.org_level || 1} 级`}</div>
          </td>
          <td>${u.roles.map((r) => badge((d.roles.find((x) => x.key === r) || {}).label || r, 'blue')).join(' ')}</td>
          <td class="muted">${esc(u.relation || '—')}</td>
          <td>${statusCell(u)}</td>
          <td class="nowrap muted">${u.last_login_at ? relTime(u.last_login_at) : '从未登录'}</td>
          <td class="right nowrap">
            ${u.canManage && u.status !== 'left' ? `<button class="btn btn-sm" data-edit="${u.id}">编辑</button>` : ''}
            ${u.canManage && u.status === 'active' ? `<button class="btn btn-sm btn-danger" data-leave="${u.id}" style="margin-left:4px">办理离职</button>` : ''}
            ${isAdmin && u.status === 'left' ? `<button class="btn btn-sm" data-restore="${u.id}">恢复</button>` : ''}
          </td>
        </tr>`).join('') || '<tr><td colspan="8"><div class="empty" style="padding:30px">没有可见成员</div></td></tr>'}
      </tbody>
    </table>
  </div></div>

  <div class="kpis" style="margin-top:14px">
    <div class="kpi"><div class="lb">在职成员</div><div class="vl">${active.length}</div><div class="sb">你可见范围内</div></div>
    <div class="kpi"><div class="lb">已离职</div><div class="vl">${left.length}</div><div class="sb">账号已停用，不可登录</div></div>
    <div class="kpi"><div class="lb">你的可管范围</div><div class="vl" style="font-size:14px">${state.user.scope === 'all' ? '全集团' : '本组织及下级'}</div><div class="sb">不能跨部门</div></div>
    <div class="kpi"><div class="lb">可授予角色</div><div class="vl" style="font-size:13px">${(d.assignable || []).map((r) => (d.roles.find((x) => x.key === r) || {}).label || r).join(' / ') || '—'}</div><div class="sb">按级别上限</div></div>
  </div>

  <div class="panel" style="margin-top:14px">
    <div class="panel-head"><h3>分级管理规则</h3><span class="muted" style="font-size:12px">上下级可见，跨域不可见</span></div>
    <div class="panel-body" style="padding:0">
      <table class="grid">
        <thead><tr><th>层级</th><th>角色</th><th>数据可见</th><th>可管理的角色</th></tr></thead>
        <tbody>
          <tr style="cursor:default"><td>1 级 · 集团</td><td>系统管理员 / 总经理</td><td>全集团</td><td>管理员：全部；总经理：除管理员外全部</td></tr>
          <tr style="cursor:default"><td>2 级 · 公司</td><td>销售总监</td><td>本公司及下级 + 上级</td><td>销售经理 / 客户经理 / 线索专员</td></tr>
          <tr style="cursor:default"><td>3 级 · 部门</td><td>销售经理</td><td>本部门及下级 + 上级</td><td>客户经理 / 线索专员</td></tr>
          <tr style="cursor:default"><td>4 级 · 团队</td><td>客户经理 / 线索专员</td><td>仅本人负责的数据</td><td>不可管理他人</td></tr>
        </tbody>
      </table>
    </div>
  </div>`;

  panel.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => editUser(d.rows.find((u) => String(u.id) === b.dataset.edit), ctx, d);
  });
  panel.querySelectorAll('[data-leave]').forEach((b) => {
    b.onclick = () => leaveUser(d.rows.find((u) => String(u.id) === b.dataset.leave), ctx);
  });
  panel.querySelectorAll('[data-restore]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('确认恢复该账号？恢复后可以重新登录。')) return;
      try {
        await api.post(`/api/admin/users/${b.dataset.restore}/restore`);
        toast('账号已恢复', 'ok');
        ctx.refresh();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

function editUser(user, ctx, data) {
  const isNew = !user;
  const allRoles = (data?.roles) || [
    { key: 'admin', label: '系统管理员' }, { key: 'gm', label: '总经理' },
    { key: 'director', label: '销售总监' }, { key: 'manager', label: '销售经理' },
    { key: 'ae', label: '客户经理' }, { key: 'sdr', label: '线索专员' },
    { key: 'finance', label: '财务' }, { key: 'legal', label: '法务' },
  ];
  const assignable = data?.assignable || null;
  const shown = assignable ? allRoles.filter((r) => assignable.includes(r.key)) : allRoles;
  const orgs = flatOrgs();

  modal({
    title: isNew ? '新增用户' : `编辑用户 · ${esc(user.name)}`,
    width: 560,
    body: `<div class="formgrid">
      ${field('姓名', 'name', { required: true, value: user?.name || '' })}
      ${field('账号', 'username', { required: isNew, value: user?.username || '', hint: isNew ? '登录用，创建后不可改' : '不可修改' })}
      ${field('职称', 'title', { value: user?.title || '' })}
      ${field('手机', 'phone', { value: user?.phone || '' })}
      ${field('所属组织', 'org_id', { full: true, required: true, options: orgs.map((o) => ({ value: o.id, label: o.label })), value: user?.org_id })}
      ${isNew ? field('初始密码', 'password', { type: 'password', required: true, hint: '至少 8 位' }) : ''}
      ${!isNew ? field('重置密码（留空不改）', 'password', { type: 'password' }) : ''}
      ${!isNew ? field('状态', 'status', { options: [{ value: 'active', label: '启用' }, { value: 'disabled', label: '停用' }], value: user.status === 'left' ? 'disabled' : user.status, hint: user.status === 'left' ? '已离职账号需走「恢复」' : '' }) : ''}
    </div>
    <div class="field" style="margin-top:12px">
      <label>角色（可多选，取最大数据范围）</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px">
        ${shown.map((r) => `<label style="display:flex;align-items:center;gap:7px;font-size:12.5px;padding:5px 7px;border:1px solid var(--line);border-radius:6px;cursor:pointer">
          <input type="checkbox" value="${r.key}" ${user?.roles?.includes(r.key) ? 'checked' : ''} data-role />
          ${esc(r.label)}
        </label>`).join('')}
      </div>
      ${assignable ? `<div class="muted" style="font-size:11.5px;margin-top:6px">按你当前的管理级别，只能授予以上角色</div>` : ''}
    </div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>保存</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      root.querySelector('[data-ok]').onclick = async () => {
        const dd = formData(root);
        const rolesSel = [...root.querySelectorAll('[data-role]:checked')].map((x) => x.value);
        if (!rolesSel.length) return toast('至少选择一个角色', 'err');
        try {
          if (isNew) {
            await api.post('/api/admin/users', { ...dd, roles: rolesSel });
          } else {
            const body = { name: dd.name, title: dd.title, phone: dd.phone, org_id: dd.org_id, roles: rolesSel };
            if (dd.status) body.status = dd.status;
            if (dd.password) body.password = dd.password;
            await api.patch(`/api/admin/users/${user.id}`, body);
          }
          toast('已保存', 'ok'); close(); ctx.refresh();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

/* ---------------- 离职交接 ---------------- */

async function leaveUser(u, ctx) {
  let p;
  try {
    p = await api.get(`/api/admin/users/${u.id}/handover`);
  } catch (e) {
    return toast(e.message, 'err');
  }
  if (!p.candidates.length) {
    return toast('没有可接收的在职同事，请先新增成员或调整组织后再办理', 'err');
  }
  const a = p.assets;
  const box = (key, label, count, hint) => `<label style="display:flex;align-items:flex-start;gap:8px;font-size:12.5px;padding:8px 10px;border:1px solid var(--line);border-radius:7px;${count ? 'cursor:pointer' : 'opacity:.5'}">
    <input type="checkbox" data-asset="${key}" ${count ? 'checked' : 'disabled'} style="margin-top:2px" />
    <span><b>${label}</b> <span class="muted">${count} 项</span><div class="muted" style="font-size:11px">${hint}</div></span>
  </label>`;

  modal({
    title: `办理离职交接 · ${u.name}`,
    width: 580,
    body: `<div class="notice red">${icon('warn', 14)}<div>
        办理后该账号<b>立即停用并强制下线</b>，无法再登录；再次登录会提示「已于某时间离职」。资产交接不可撤销，请核对接收人。
      </div></div>
      <div class="stack" style="margin-top:12px">
        ${field('交接给（在职同事）', 'to_user_id', {
          required: true,
          options: p.candidates.map((c) => ({
            value: c.id,
            label: `${c.name}${c.title ? ' · ' + c.title : ''} · ${c.org_name}`,
          })),
          hint: '可选本部门同事、上级经理或总监',
        })}
        <div class="field">
          <label>需要交接的资产</label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px">
            ${box('accounts', '客户', a.accounts, '改负责人与所属组织')}
            ${box('opportunities', '进行中商机', a.opportunities, '未赢单/未丢单的商机')}
            ${box('leads', '未转化线索', a.leads, '线索负责人一并转移')}
            ${box('contracts', '合同', a.contracts, '合同负责人转移')}
            ${box('approvals', '待我审批的单据', a.approvals, '转给具备同角色的接收人')}
          </div>
        </div>
        ${field('离职说明', 'reason', { placeholder: '例：个人原因，2026-10-31 为最后工作日' })}
      </div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn btn-danger" data-ok>确认交接并办理离职</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      root.querySelector('[data-ok]').onclick = async () => {
        const to = Number(root.querySelector('[name="to_user_id"]').value);
        if (!to) return toast('请选择接收人', 'err');
        const assets = {};
        root.querySelectorAll('[data-asset]').forEach((c) => { assets[c.dataset.asset] = c.checked; });
        if (!Object.values(assets).some(Boolean) && !confirm('没有勾选任何资产，确认只停用账号、不交接数据？')) return;
        const reason = root.querySelector('[name="reason"]').value;
        try {
          const r = await api.post(`/api/admin/users/${u.id}/handover`, { to_user_id: to, assets, reason });
          close();
          showLeftResult(r, u);
          ctx.refresh();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

function showLeftResult(r, u) {
  modal({
    title: '已办理离职',
    width: 480,
    body: `<div class="notice blue">${icon('check', 14)}<div>${esc(r.message)}</div></div>
      <div class="fields" style="margin-top:14px">
        <div class="fld"><div class="k">离职人</div><div class="v">${esc(u.name)}</div></div>
        <div class="fld"><div class="k">离职时间</div><div class="v">${esc(r.leftAtText)}</div></div>
        <div class="fld"><div class="k">交接给</div><div class="v">${esc(r.to.name)}</div></div>
        <div class="fld"><div class="k">客户</div><div class="v">${r.moved.accounts} 个</div></div>
        <div class="fld"><div class="k">商机</div><div class="v">${r.moved.opportunities} 个</div></div>
        <div class="fld"><div class="k">线索</div><div class="v">${r.moved.leads} 条</div></div>
        <div class="fld"><div class="k">合同</div><div class="v">${r.moved.contracts} 份</div></div>
        <div class="fld"><div class="k">审批单</div><div class="v">${r.moved.approvals} 条</div></div>
      </div>
      ${r.approvalLeft ? `<div class="notice red" style="margin-top:10px">${icon('warn', 14)}<div>
        还有 ${r.approvalLeft} 条待审批单据，接收人没有对应审批角色，未自动转派，请到审批中心改派。
      </div></div>` : ''}
      <div class="muted" style="font-size:12px;margin-top:12px">
        该账号已强制下线，无法再次登录；登录时会提示「已于 ${esc(r.leftAtText)} 离职」。
      </div>`,
    footer: `<button class="btn btn-primary" data-c>知道了</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
    },
  });
}

/* ========================= 组织 ========================= */

async function renderOrgs(panel, ctx) {
  const [orgs, users] = await Promise.all([api.get('/api/orgs'), api.get('/api/admin/users').catch(() => ({ rows: [] }))]);
  const byParent = {};
  orgs.forEach((o) => { (byParent[o.parent_id || 0] = byParent[o.parent_id || 0] || []).push(o); });

  const sortBy = { 1: 0, 2: 1, 3: 2, 4: 3 };
  const rows = [];
  const walk = (pid, depth) => {
    (byParent[pid] || [])
      .sort((a, b) => (sortBy[a.level] - sortBy[b.level]) || a.id - b.id)
      .forEach((o) => {
        const people = (users.rows || []).filter((u) => Number(u.org_id) === Number(o.id));
        rows.push(`<tr style="cursor:default">
          <td style="padding-left:${12 + depth * 22}px">
            ${depth ? '<span class="muted">└ </span>' : ''}<b>${esc(o.name)}</b>
            <span class="badge badge-${o.level === 1 ? 'violet' : o.level === 2 ? 'blue' : 'gray'}" style="margin-left:6px">${LEVEL_SHORT[o.level] || o.level + ' 级'}</span>
          </td>
          <td class="mono muted">${esc(o.code || '')}</td>
          <td>${o.leaders.length ? o.leaders.map((l) => `${esc(l.name)}<span class="muted" style="font-size:11px">（${esc(ROLE_LABEL[l.role] || l.role)}）</span>`).join('、') : '<span class="muted">未指定</span>'}</td>
          <td class="num">${o.users}</td>
          <td class="num">${o.accounts}</td>
          <td class="muted">${people.filter((u) => u.status === 'active').map((u) => esc(u.name)).join('、') || '<span class="muted">—</span>'}</td>
        </tr>`);
        walk(o.id, depth + 1);
      });
  };
  walk(0, 0);

  panel.innerHTML = `<div class="panel">
    <div class="panel-head"><h3>组织架构</h3><span class="badge badge-gray">${orgs.length} 个节点 / 最多 4 级</span></div>
    <div class="panel-body flush"><table class="grid">
      <thead><tr><th style="min-width:210px">组织（层级）</th><th>编码</th><th>负责人</th><th class="num">成员</th><th class="num">客户</th><th style="min-width:220px">当前可见成员</th></tr></thead>
      <tbody>${rows.join('') || '<tr><td colspan="6"><div class="empty" style="padding:30px">暂无组织</div></td></tr>'}</tbody>
    </table></div>
  </div>
  <div class="notice blue" style="margin-top:12px">${icon('info', 14)}
    <div><b>层级规则：</b>1 级集团 → 2 级公司 → 3 级部门 → 4 级团队。数据可见按组织路径判定：<b>上级能看下级，下级能看到上级，同级部门互相不可见</b>（不跨域）。组织调整请由管理员在「新增组织」里维护。</div>
  </div>`;
}

function newOrg(ctx) {
  const orgs = flatOrgs();
  modal({
    title: '新增组织',
    width: 460,
    body: `<div class="stack">
      ${field('上级组织', 'parent_id', { options: orgs.map((o) => ({ value: o.id, label: o.label })), hint: '留空则为 1 级集团' })}
      ${field('组织名称', 'name', { required: true })}
      ${field('类型', 'type', {
        options: [
          { value: 'group', label: '集团（1 级）' },
          { value: 'company', label: '公司（2 级）' },
          { value: 'dept', label: '部门（3 级）' },
          { value: 'team', label: '团队（4 级）' },
        ],
      })}
      ${field('编码', 'code', { placeholder: '例：EAST-01' })}
    </div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>创建</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      root.querySelector('[data-ok]').onclick = async () => {
        const d = formData(root);
        try {
          await api.post('/api/admin/orgs', d);
          toast('组织已创建', 'ok'); close(); ctx.refresh();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

function flatOrgs() {
  const byParent = {};
  (state.orgs || []).forEach((o) => {
    (byParent[o.parent_id || 0] = byParent[o.parent_id || 0] || []).push(o);
  });
  const out = [];
  const walk = (pid, depth) => {
    (byParent[pid] || []).forEach((o) => {
      out.push({ id: o.id, label: `${'　'.repeat(depth)}${depth ? '└ ' : ''}${o.name}${o.level ? `（${LEVEL_SHORT[o.level] || o.level}）` : ''}` });
      walk(o.id, depth + 1);
    });
  };
  walk(0, 0);
  return out;
}

/* ========================= 目标 / 审计 ========================= */

async function renderTargets(panel, ctx) {
  const period = new Date().toISOString().slice(0, 7);
  const d = await api.get(`/api/admin/targets?period=${period}`);
  panel.innerHTML = `<div class="panel">
    <div class="panel-head"><h3>${period} 销售目标</h3><span class="badge badge-gray">${d.rows.length} 条</span></div>
    <div class="panel-body flush">
      <table class="grid">
        <thead><tr><th>姓名</th><th>组织</th><th class="num">月度目标</th><th></th></tr></thead>
        <tbody>
          ${d.rows.map((t) => `<tr style="cursor:default">
            <td>${esc(t.user_name)}</td>
            <td>${esc(t.org_name)}</td>
            <td class="num">${money(t.amount)}</td>
            <td class="right"><button class="btn btn-sm" data-edit-target="${t.user_id}" data-amount="${t.amount}">调整</button></td>
          </tr>`).join('') || '<tr><td colspan="4"><div class="empty" style="padding:26px">本月暂无目标</div></td></tr>'}
        </tbody>
      </table>
    </div>
  </div>`;

  panel.querySelectorAll('[data-edit-target]').forEach((b) => {
    b.onclick = () => {
      modal({
        title: '调整月度目标',
        width: 400,
        body: field('目标金额（元）', 'amount', { type: 'number', value: b.dataset.amount, required: true, min: 0, step: 10000 }),
        footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>保存</button>`,
        onMount(root, close) {
          root.querySelector('[data-c]').onclick = close;
          root.querySelector('[data-ok]').onclick = async () => {
            const f = formData(root);
            try {
              await api.post('/api/admin/targets', { user_id: Number(b.dataset.editTarget), period, amount: f.amount });
              toast('已更新', 'ok'); close(); ctx.refresh();
            } catch (e) { toast(e.message, 'err'); }
          };
        },
      });
    };
  });
}

async function renderAudit(panel) {
  const d = await api.get('/api/admin/audit');
  panel.innerHTML = `<div class="panel">
    <div class="panel-head"><h3>审计日志</h3><span class="badge badge-gray">最近 ${d.rows.length} 条</span></div>
    <div class="panel-body flush"><div class="tablewrap" style="max-height:calc(100vh - 260px)">
      <table class="grid">
        <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>目标</th><th>内容</th><th>IP</th></tr></thead>
        <tbody>
          ${d.rows.map((a) => `<tr style="cursor:default">
            <td class="nowrap mono">${dateTime(a.created_at)}</td>
            <td>${esc(a.user_name || '—')}</td>
            <td class="mono">${esc(a.action)}</td>
            <td class="muted">${a.target_type ? esc(a.target_type) + '#' + a.target_id : '—'}</td>
            <td class="muted" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.detail || '')}</td>
            <td class="mono muted">${esc(a.ip || '')}</td>
          </tr>`).join('') || '<tr><td colspan="6"><div class="empty" style="padding:26px">暂无日志</div></td></tr>'}
        </tbody>
      </table>
    </div></div>
  </div>`;
  void date;
}
