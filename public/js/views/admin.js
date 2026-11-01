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
  { key: 'api', label: 'API 接入', role: ['admin'] },
  { key: 'audit', label: '审计日志', role: ['admin', 'gm'] },
];

const LEVEL_TEXT = { 1: '1 级 · 集团', 2: '2 级 · 公司', 3: '3 级 · 部门', 4: '4 级 · 团队' };
const LEVEL_SHORT = { 1: '集团', 2: '公司', 3: '部门', 4: '团队' };
const ROLE_LABEL = {
  admin: '管理员', gm: '总经理', director: '销售总监', manager: '销售经理',
  ae: '客户经理', sdr: '线索专员', finance: '财务', legal: '法务',
};

export async function render(el, route, ctx) {
  const tab = route.query.tab || 'users';
  const role = state.user.role;
  const canWrite = ['admin', 'gm', 'director', 'manager'].includes(role);
  const tabs = TABS.filter((t) => !t.role || t.role.includes(role));
  el.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1>用户与组织</h1>
        <div class="desc">组织按 1/2/3 级分类；上级可管理下级，跨部门不可见也不可操作</div>
      </div>
      <div class="actions">
        ${tab === 'users' && canWrite ? `<button class="btn btn-primary" data-new-user>${icon('plus', 12)} 新增用户</button>` : ''}
        ${tab === 'orgs' && ['admin', 'gm'].includes(role) ? `<button class="btn btn-primary" data-new-org>${icon('plus', 12)} 新增组织</button>` : ''}
        ${tab === 'api' && role === 'admin' ? `<button class="btn" data-api-debug>${icon('terminal', 12)} 接口调试</button>
          <button class="btn btn-primary" data-new-client>${icon('plus', 12)} 开通 API 接入</button>` : ''}
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
  if (tab === 'api') return renderApi(panel, ctx, el);
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

/* ========================= API 接入 ========================= */

const SCOPE_LABEL = { 'lead:read': '读取', 'lead:write': '写入' };
const METHOD_TONE = { GET: 'blue', POST: 'green', PATCH: 'amber', DELETE: 'red' };

function clientStatus(c) {
  if (c.status === 'revoked') return badge('已撤销', 'red');
  if (c.status === 'disabled') return badge('已停用', 'gray');
  if (c.expire_at && c.expire_at < new Date().toISOString().slice(0, 10)) return badge('已过期', 'amber');
  return badge('启用中', 'green');
}

function copyText(text, msg = '已复制到剪贴板') {
  const done = () => toast(msg, 'ok');
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch { toast('复制失败，请手动选中', 'err'); }
    ta.remove();
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(fallback);
  else fallback();
}

function prettyJson(t) {
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return String(t ?? ''); }
}

async function renderApi(panel, ctx, el) {
  const [d, logs] = await Promise.all([
    api.get('/api/admin/api-clients'),
    api.get('/api/admin/api-logs?limit=40').catch(() => ({ rows: [], stats: {} })),
  ]);
  const st = d.stats || {};
  const rows = d.rows || [];
  const demo = d.meta.demo;

  const ipCell = (c) => {
    if (!c.ip_list.length) return `<span class="badge badge-red">未配置</span>`;
    if (c.ip_list.includes('*')) return `<span class="badge badge-amber">不限（*）</span>`;
    const first = esc(c.ip_list[0]);
    const more = c.ip_list.length > 1 ? `<div class="cell-sub" title="${esc(c.ip_list.join('\n'))}">等 ${c.ip_list.length} 条规则</div>` : '';
    return `<span class="mono">${first}</span>${more}`;
  };

  // 域名是「配了才校验」：空 = 不限制（服务器对服务器调用通常没有 Origin）
  const domainCell = (c) => {
    const list = c.domain_list || [];
    if (!list.length) return `<span class="badge">不校验</span>`;
    if (list.includes('*')) return `<span class="badge badge-amber">不限（*）</span>`;
    const first = esc(list[0]);
    const more = list.length > 1 ? `<div class="cell-sub" title="${esc(list.join('\n'))}">等 ${list.length} 条规则</div>` : '';
    return `<span class="mono">${first}</span>${more}`;
  };

  panel.innerHTML = `
    ${demo ? `<div class="notice red" style="margin-bottom:12px">${icon('warn', 14)}
      <div><b>演示环境只读：</b>开通与修改 API 接入已禁用，请在正式部署的实例里操作。</div></div>` : ''}

    <div class="kpis" style="margin-bottom:14px">
      <div class="kpi"><div class="lb">接入方</div><div class="vl">${st.clients || 0}</div><div class="sb">已开通的外部系统</div></div>
      <div class="kpi"><div class="lb">启用中</div><div class="vl">${st.active || 0}</div><div class="sb">密钥可用</div></div>
      <div class="kpi"><div class="lb">今日调用</div><div class="vl">${st.todayTotal || 0}</div><div class="sb">含失败请求</div></div>
      <div class="kpi"><div class="lb">今日失败</div><div class="vl" style="${st.todayFail ? 'color:var(--red)' : ''}">${st.todayFail || 0}</div><div class="sb">4xx / 5xx</div></div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <h3>接入方与授权</h3>
        <span class="muted" style="font-size:12px">密钥只在开通 / 重置时显示一次，库里只存哈希</span>
      </div>
      <div class="panel-body flush">
        <div class="tablewrap">
          <table class="grid">
            <thead><tr>
              <th style="min-width:150px">接入方</th><th>状态</th><th style="min-width:140px">授权 IP</th>
              <th style="min-width:130px">授权域名</th>
              <th>权限</th><th>限额</th><th class="num">今日</th><th style="min-width:120px">最近调用</th><th></th>
            </tr></thead>
            <tbody>
              ${rows.map((c) => `<tr style="cursor:default">
                <td>
                  <div class="cell-main">${esc(c.name)}</div>
                  <div class="cell-sub mono">${esc(c.client_id)} · ${esc(c.key_prefix)}…</div>
                </td>
                <td>${clientStatus(c)}</td>
                <td>${ipCell(c)}</td>
                <td>${domainCell(c)}</td>
                <td>${(c.scopes || []).map((s) => badge(SCOPE_LABEL[s] || s, 'violet')).join(' ') || '<span class="muted">—</span>'}</td>
                <td class="muted" style="font-size:11.5px">
                  ${c.rate_limit ? `${c.rate_limit}/分钟` : '不限速'}<br>
                  ${c.daily_quota ? `日 ${c.daily_quota}` : '日不限'}
                </td>
                <td class="num ${c.last_status && c.last_status >= 400 ? '' : ''}" style="${c.last_status >= 400 ? 'color:var(--red)' : ''}">
                  ${c.today_calls}${c.last_status ? `<div class="cell-sub">最近 ${c.last_status}</div>` : ''}
                </td>
                <td class="muted" style="font-size:11.5px">
                  ${c.last_used_at ? `${relTime(c.last_used_at)}<div class="cell-sub mono">${esc(c.last_ip || '')}</div>` : '从未调用'}
                </td>
                <td class="right nowrap">
                  <button class="btn btn-sm" data-edit="${c.id}">编辑</button>
                  <button class="btn btn-sm" data-check="${c.id}">自检</button>
                  ${c.status === 'revoked' ? '' : `<button class="btn btn-sm" data-rotate="${c.id}">重置密钥</button>`}
                  ${c.status === 'active'
                    ? `<button class="btn btn-sm" data-toggle="${c.id}">停用</button>`
                    : (c.status === 'disabled' ? `<button class="btn btn-sm" data-toggle="${c.id}">启用</button>` : '')}
                  ${c.status === 'revoked' ? '' : `<button class="btn btn-sm btn-danger" data-revoke="${c.id}">撤销</button>`}
                </td>
              </tr>`).join('') || `<tr><td colspan="9"><div class="empty" style="padding:34px">
                还没有接入方。点右上角「开通 API 接入」，给官网表单、企业微信或第三方系统发一把钥匙。
              </div></td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="panel" style="margin-top:14px">
      <div class="panel-head"><h3>接入方式</h3><span class="muted" style="font-size:12px">四件事同时满足才放行：密钥对得上 · IP 在白名单 · 域名对得上（配了才校验）· 没超限</span></div>
      <div class="panel-body">
        <div class="api-heads">
          <div class="api-head-card">
            <div class="t">1 · 鉴权</div>
            <div class="m">请求头带 <code>Authorization: Bearer &lt;密钥&gt;</code>，或用 <code>X-API-Key</code>。不看登录态，可跨域调用。</div>
          </div>
          <div class="api-head-card">
            <div class="t">2 · IP 授权</div>
            <div class="m">只有名单内的来源 IP 能进。支持单 IP、网段 <code>10.0.0.0/16</code>、通配 <code>192.168.1.*</code>；名单为空视为全部拒绝。</div>
          </div>
          <div class="api-head-card">
            <div class="t">3 · 域名授权</div>
            <div class="m">校验请求头 <code>Origin</code> / <code>Referer</code> 的域名。支持 <code>api.example.com</code>、<code>*.example.com</code>；<b>留空 = 不校验</b>（服务器调用一般不带这两个头）。</div>
          </div>
          <div class="api-head-card">
            <div class="t">4 · 限额</div>
            <div class="m">按接入方单独计：每分钟速率 + 每日配额，超了返回 <code>429</code>，第二天自动恢复。</div>
          </div>
        </div>

        <pre class="code-block" style="margin-top:12px">curl -X POST '${esc(d.meta.baseUrl)}/api/v1/leads' \\
  -H 'Authorization: Bearer &lt;你的密钥&gt;' \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"杭州云舟智能装备有限公司","external_id":"WEB-001","contact_name":"王海涛","contact_phone":"13800001234","demand":"车间报工与 ERP 打通"}'</pre>

        <table class="grid" style="margin-top:12px">
          <thead><tr><th style="width:70px">方法</th><th style="min-width:220px">路径</th><th style="width:90px">权限</th><th>说明</th><th></th></tr></thead>
          <tbody>
            ${(d.meta.endpoints || []).map((e, i) => `<tr style="cursor:default">
              <td>${badge(e.method, METHOD_TONE[e.method] || 'gray')}</td>
              <td class="mono">${esc(e.path)}</td>
              <td class="muted" style="font-size:11.5px">${esc(e.scope)}</td>
              <td class="muted" style="font-size:11.5px">${esc(e.title)} · ${esc(e.desc)}</td>
              <td class="right"><button class="btn btn-sm" data-try="${i}">试一下</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="panel" style="margin-top:14px">
      <div class="panel-head">
        <h3>调用日志</h3>
        <div class="row" style="margin-left:auto;gap:6px">
          <div class="seg" id="logFilter">
            <button class="on" data-f="all">全部</button>
            <button data-f="fail">只看失败</button>
          </div>
          <button class="btn btn-sm" data-refresh-log>刷新</button>
        </div>
      </div>
      <div class="panel-body flush">
        <div class="tablewrap" style="max-height:420px">
          <table class="grid" id="logTable">
            <thead><tr><th style="width:110px">时间</th><th>接入方</th><th>请求</th><th style="width:70px">状态</th><th style="width:70px" class="num">耗时</th><th style="width:120px">来源 IP</th></tr></thead>
            <tbody>
              ${(logs.rows || []).map((l, i) => `<tr data-log="${i}" data-fail="${l.status >= 400 ? 1 : 0}">
                <td class="mono muted nowrap">${dateTime(l.created_at)}</td>
                <td>${esc(l.client_name || '—')}</td>
                <td class="mono" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                  <b style="color:var(--ink-2)">${esc(l.method)}</b> ${esc(l.path)}
                  ${l.error ? `<div class="cell-sub" style="color:var(--red)">${esc(l.error)}</div>` : ''}
                </td>
                <td>${badge(l.status, l.status >= 400 ? 'red' : 'green')}</td>
                <td class="num muted">${l.ms} ms</td>
                <td class="mono muted">${esc(l.ip || '')}</td>
              </tr>`).join('') || '<tr><td colspan="6"><div class="empty" style="padding:28px">还没有调用记录</div></td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  // 顶部动作
  const nb = el.querySelector('[data-new-client]');
  if (nb) nb.onclick = () => openClientForm(null, d, ctx);
  const dbg = el.querySelector('[data-api-debug]');
  if (dbg) dbg.onclick = () => openDebug(d, {}, ctx);

  const find = (id) => rows.find((r) => String(r.id) === String(id));
  panel.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => openClientForm(find(b.dataset.edit), d, ctx); });
  panel.querySelectorAll('[data-check]').forEach((b) => { b.onclick = () => selfCheckClient(find(b.dataset.check), ctx); });
  panel.querySelectorAll('[data-rotate]').forEach((b) => { b.onclick = () => rotateKey(find(b.dataset.rotate), ctx); });
  panel.querySelectorAll('[data-revoke]').forEach((b) => { b.onclick = () => revokeClient(find(b.dataset.revoke), ctx); });
  panel.querySelectorAll('[data-toggle]').forEach((b) => {
    b.onclick = async () => {
      const c = find(b.dataset.toggle);
      const next = c.status === 'active' ? 'disabled' : 'active';
      try {
        await api.patch(`/api/admin/api-clients/${c.id}`, { status: next });
        toast(next === 'active' ? '已启用' : '已停用，该密钥立即失效', 'ok');
        ctx.refresh();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
  panel.querySelectorAll('[data-try]').forEach((b) => {
    b.onclick = () => openDebug(d, { index: Number(b.dataset.try) }, ctx);
  });

  // 日志筛选与详情
  panel.querySelectorAll('#logFilter button').forEach((b) => {
    b.onclick = () => {
      panel.querySelectorAll('#logFilter button').forEach((x) => x.classList.toggle('on', x === b));
      const onlyFail = b.dataset.f === 'fail';
      panel.querySelectorAll('#logTable tbody tr[data-log]').forEach((tr) => {
        tr.style.display = onlyFail && tr.dataset.fail !== '1' ? 'none' : '';
      });
    };
  });
  panel.querySelectorAll('#logTable tbody tr[data-log]').forEach((tr) => {
    tr.onclick = () => showLog((logs.rows || [])[Number(tr.dataset.log)]);
  });
  const rl = panel.querySelector('[data-refresh-log]');
  if (rl) rl.onclick = () => ctx.refresh();
}

/* ---------------- 开通 / 编辑 ---------------- */

function openClientForm(c, d, ctx) {
  const isNew = !c;
  const scopes = c?.scopes || ['lead:read', 'lead:write'];
  const users = d.users || [];
  if (!users.length) return toast('还没有在职成员，无法指定线索负责人', 'err');

  const m = modal({
    title: isNew ? '开通 API 接入' : `接入设置 · ${c.name}`,
    width: 660,
    body: `<div class="formgrid">
        ${field('接入方名称', 'name', { required: true, value: c?.name || '', placeholder: '官网表单 / 企业微信 / 市场部活动页' })}
        ${field('线索默认负责人', 'owner_id', {
          required: true,
          options: users.map((u) => ({ value: u.id, label: `${u.name}${u.title ? ' · ' + u.title : ''} · ${u.org_name}` })),
          value: c?.owner_id,
          hint: '外部推来的线索挂在他名下，可见范围按他的组织算',
        })}
      </div>

      <div class="field" style="margin-top:12px">
        <label>接口权限</label>
        <div class="api-scopes">
          ${(d.meta.scopes || []).map((s) => `<label class="api-scope">
            <input type="checkbox" value="${s.key}" ${scopes.includes(s.key) ? 'checked' : ''} data-scope />
            <span><b>${esc(s.label)}</b><em>${esc(s.desc)}</em></span>
          </label>`).join('')}
        </div>
      </div>

      <div class="field" style="margin-top:12px">
        <label>授权 IP 白名单 *</label>
        <textarea class="textarea" name="ip_whitelist" style="font-family:var(--mono);font-size:12px;height:88px"
          placeholder="10.0.1.20&#10;10.0.0.0/16">${esc(c?.ip_whitelist || '')}</textarea>
        <div class="hint">每行一条：单 IP <code>10.0.1.20</code>、网段 <code>10.0.0.0/16</code>、通配 <code>192.168.1.*</code>。留空 = 全部拒绝；<code>*</code> = 不限来源（不建议）。</div>
        <div class="row" style="margin-top:2px">
          <button class="btn btn-sm" data-fill-ip>填入当前 IP（${esc(d.meta.ip)}）</button>
          <span class="muted" style="font-size:11.5px">这是你现在的出口 IP；对方服务器要填它自己的公网 IP</span>
        </div>
      </div>

      <div class="field" style="margin-top:12px">
        <label>授权域名白名单</label>
        <textarea class="textarea" name="domain_whitelist" style="font-family:var(--mono);font-size:12px;height:76px"
          placeholder="api.partner.com&#10;*.partner.com">${esc(c?.domain_whitelist || '')}</textarea>
        <div class="hint">每行一条：精确域名 <code>api.partner.com</code>、含子域 <code>*.partner.com</code>、
          <code>*</code> = 不限。<b>留空 = 不校验域名</b>（服务器对服务器调用通常不带 <code>Origin</code> / <code>Referer</code>）；
          一旦填写，请求缺这两个头或域名不匹配都会被拒绝。</div>
        <div class="row" style="margin-top:2px">
          <button class="btn btn-sm" data-fill-domain>填入当前域名（${esc(location.hostname)}）</button>
          <span class="muted" style="font-size:11.5px">浏览器端调用可直接用它；服务器端调用请填对方实际声明的域名</span>
        </div>
      </div>

      <div class="formgrid" style="margin-top:12px">
        ${field('每分钟上限', 'rate_limit', { type: 'number', value: c?.rate_limit ?? 60, hint: '0 = 不限速' })}
        ${field('每日配额', 'daily_quota', { type: 'number', value: c?.daily_quota ?? 5000, hint: '0 = 不限量' })}
        ${field('授权到期日', 'expire_at', { type: 'date', value: c?.expire_at || '', hint: '留空 = 长期有效' })}
        ${field('备注', 'remark', { value: c?.remark || '', placeholder: '用途、对接人、合同编号' })}
      </div>`,
    footer: `<button class="btn" data-c>取消</button>
             <button class="btn btn-primary" data-ok>${isNew ? '开通并生成密钥' : '保存'}</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      root.querySelector('[data-fill-ip]').onclick = () => {
        const ta = root.querySelector('[name="ip_whitelist"]');
        const cur = ta.value.trim();
        ta.value = cur ? `${cur}\n${d.meta.ip}` : d.meta.ip;
      };
      const fillDomain = root.querySelector('[data-fill-domain]');
      if (fillDomain) fillDomain.onclick = () => {
        const ta = root.querySelector('[name="domain_whitelist"]');
        const cur = ta.value.trim();
        ta.value = cur ? `${cur}\n${location.hostname}` : location.hostname;
      };
      root.querySelector('[data-ok]').onclick = async () => {
        const fd = formData(root);
        const picked = [...root.querySelectorAll('[data-scope]:checked')].map((x) => x.value);
        if (!picked.length) return toast('请至少勾选一项接口权限', 'err');
        if (!String(fd.ip_whitelist || '').trim()) return toast('请填写授权 IP 白名单', 'err');
        const body = {
          name: fd.name,
          owner_id: Number(fd.owner_id),
          scopes: picked,
          ip_whitelist: fd.ip_whitelist,
          domain_whitelist: fd.domain_whitelist || '',
          rate_limit: fd.rate_limit === null ? 0 : Number(fd.rate_limit),
          daily_quota: fd.daily_quota === null ? 0 : Number(fd.daily_quota),
          expire_at: fd.expire_at || null,
          remark: fd.remark || '',
        };
        try {
          if (isNew) {
            const r = await api.post('/api/admin/api-clients', body);
            close();
            showKey(r, ctx);
          } else {
            await api.patch(`/api/admin/api-clients/${c.id}`, body);
            close();
            toast('已保存', 'ok');
            ctx.refresh();
          }
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
  void m;
}

/* ---------------- 密钥展示 ---------------- */

function showKey(r, ctx) {
  const curl = `curl '${r.base_url}/api/v1/ping' \\\n  -H 'Authorization: Bearer ${r.key}'`;
  modal({
    title: '密钥已生成',
    width: 640,
    body: `<div class="notice red">${icon('warn', 14)}
        <div><b>这段密钥只显示这一次。</b>关闭后就查不到了，只能回来重置；重置会让旧密钥立刻失效。</div>
      </div>
      <div class="field" style="margin-top:12px">
        <label>API 密钥</label>
        <div class="api-key"><code id="keyText">${esc(r.key)}</code>
          <button class="btn btn-sm" data-copy>复制</button></div>
        <div class="hint">接入方 ${esc(r.name)} · Client ID <span class="mono">${esc(r.client_id)}</span> ·
          授权 IP ${esc((r.ip_list || []).join(' , '))} ·
          授权域名 ${esc((r.domain_list || []).join(' , ') || '不校验')}</div>
      </div>
      <div class="field" style="margin-top:12px">
        <label>先用这条命令验证连通性</label>
        <pre class="code-block" id="curlText">${esc(curl)}</pre>
      </div>
      <div class="hint">返回 <code>{"ok":true,"data":{...}}</code> 就说明密钥、IP 授权和配额都通过了。</div>`,
    footer: `<button class="btn" data-copy-curl>复制 curl</button>
             <button class="btn btn-primary" data-debug>立即调试</button>`,
    onMount(root, close) {
      root.querySelector('[data-copy]').onclick = () => copyText(r.key, '密钥已复制');
      root.querySelector('[data-copy-curl]').onclick = () => copyText(curl, 'curl 已复制');
      root.querySelector('[data-debug]').onclick = () => {
        close();
        // 用当前页面的 meta 打开调试台
        api.get('/api/admin/api-clients').then((d) => openDebug(d, { key: r.key, index: 0 }, ctx)).catch(() => {});
      };
    },
  });
}

/* ---------------- 重置 / 撤销 / 自检 ---------------- */

function rotateKey(c, ctx) {
  if (!confirm(`重置「${c.name}」的密钥？旧密钥会立即失效，对方系统需要马上换新。`)) return;
  api.post(`/api/admin/api-clients/${c.id}/rotate`, {}).then((r) => {
    showKey(r, ctx);
    ctx.refresh();
  }).catch((e) => toast(e.message, 'err'));
}

function revokeClient(c, ctx) {
  if (!confirm(`撤销「${c.name}」的接入？密钥立即失效，且不能恢复，只能重新开通。`)) return;
  api.del(`/api/admin/api-clients/${c.id}`).then((r) => {
    toast(r.message || '已撤销', 'ok');
    ctx.refresh();
  }).catch((e) => toast(e.message, 'err'));
}

async function selfCheckClient(c, ctx, domain) {
  let r;
  try {
    r = await api.post(`/api/admin/api-clients/${c.id}/selfcheck`, domain ? { domain } : {});
  } catch (e) { return toast(e.message, 'err'); }
  const d = r.result;
  const q = d.quota;
  // 配了域名却没指定，只是「没测到」，不是真的拒绝——给个一键重测
  const needDomain = d.domain_required && !d.domain;
  modal({
    title: `连通性自检 · ${c.name}`,
    width: 560,
    body: `<div class="notice ${d.allowed ? 'blue' : 'red'}">${icon(d.allowed ? 'check' : 'warn', 14)}
        <div>${d.allowed
          ? `来源 IP <b>${esc(d.ip)}</b> 命中规则 <b>${esc(d.matched || '')}</b>${d.domain_required ? `，域名 <b>${esc(d.domain)}</b> 也在名单内` : ''}，可以通过授权校验。`
          : needDomain
            ? `来源 IP <b>${esc(d.ip)}</b> 的判断已完成；该接入方还配了授权域名，需要指定域名才能给出完整结论。`
            : `来源 IP <b>${esc(d.ip)}</b> 会被拒绝——但这里只校验来源与状态，密钥本身仍以实际请求为准。`}</div>
      </div>
      <div class="fields" style="margin-top:12px">
        <div class="fld"><div class="k">来源 IP</div><div class="v mono">${esc(d.ip)}</div></div>
        <div class="fld"><div class="k">IP 白名单</div><div class="v mono">${esc(d.whitelist.join(' , ') || '—')}</div></div>
        <div class="fld"><div class="k">来源域名</div><div class="v mono">${esc(d.domain || '未指定')}</div></div>
        <div class="fld"><div class="k">域名白名单</div><div class="v mono">${esc((d.domains || []).join(' , ') || '不校验')}</div></div>
        <div class="fld"><div class="k">状态</div><div class="v">${d.status === 'active' && !d.revoked ? '启用中' : '已停用 / 已撤销'}</div></div>
        <div class="fld"><div class="k">今日配额</div><div class="v">${q.limit ? `${q.used} / ${q.limit}` : '不限'}</div></div>
        <div class="fld"><div class="k">速率上限</div><div class="v">${d.rate_limit ? `${d.rate_limit} 次/分钟` : '不限'}</div></div>
        <div class="fld"><div class="k">权限</div><div class="v">${esc((d.scopes || []).map((s) => SCOPE_LABEL[s] || s).join(' / '))}</div></div>
      </div>
      ${d.reasons.length ? `<div class="notice red" style="margin-top:10px">${icon('warn', 14)}<div>
        <b>不通过原因</b><ul style="margin:6px 0 0;padding-left:18px;line-height:1.8">
          ${d.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div>` : ''}
      <div class="muted" style="font-size:11.5px;margin-top:10px">
        建议让对方从<b>它自己的服务器</b>跑一次 <code>/api/v1/ping</code>，那才是真实的出口 IP 与来源域名。
      </div>`,
    footer: `<button class="btn btn-primary" data-c>知道了</button>
      ${needDomain ? `<button class="btn" data-retest>以当前域名（${esc(location.hostname)}）重测</button>` : ''}`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      const b = root.querySelector('[data-retest]');
      if (b) b.onclick = () => { close(); selfCheckClient(c, ctx, location.hostname); };
    },
  });
}

/* ---------------- 调试台 ---------------- */

function openDebug(d, { key = '', index = 0 } = {}, ctx) {
  const eps = d.meta.endpoints || [];
  if (!eps.length) return toast('没有可调试的接口', 'err');
  const start = Math.min(Math.max(0, index), eps.length - 1);

  const m = modal({
    title: '接口调试台',
    width: 800,
    body: `<div class="notice blue" style="margin-bottom:12px">${icon('info', 14)}
        <div>这里直接从浏览器发一次真实请求，走的是线上同一套鉴权（密钥 + IP + 限额），所以浏览器所在 IP 也要在白名单里。</div>
      </div>
      <div class="formgrid">
        ${field('接口', 'ep', { full: true, options: eps.map((e, i) => ({ value: i, label: `${e.method} ${e.path} · ${e.title}` })), value: start })}
        ${field('密钥（Bearer）', 'key', { full: true, value: key, placeholder: 'crm_...' })}
        ${field('路径', 'path', { full: true, value: eps[start].path })}
      </div>
      <div class="field" style="margin-top:10px">
        <label>请求体（GET 可留空）</label>
        <textarea class="textarea" name="body" style="font-family:var(--mono);font-size:11.5px;height:110px"></textarea>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn btn-primary" data-send>${icon('arrow', 12)} 发送请求</button>
        <span class="muted mono" id="dbgMeta" style="font-size:11.5px">尚未发送</span>
      </div>
      <pre class="code-block" id="dbgOut" style="margin-top:10px;max-height:280px">响应会显示在这里</pre>`,
    footer: `<button class="btn" data-c>关闭</button>`,
    onMount(root, close) {
      const sel = root.querySelector('[name="ep"]');
      const path = root.querySelector('[name="path"]');
      const body = root.querySelector('[name="body"]');
      const out = root.querySelector('#dbgOut');
      const meta = root.querySelector('#dbgMeta');

      const sync = () => {
        const e = eps[Number(sel.value)];
        path.value = e.path;
        body.value = e.body ? JSON.stringify(e.body, null, 2) : '';
      };
      sync();
      sel.onchange = sync;
      root.querySelector('[data-c]').onclick = close;

      root.querySelector('[data-send]').onclick = async () => {
        const e = eps[Number(sel.value)];
        const k = root.querySelector('[name="key"]').value.trim();
        if (!k) return toast('请填写密钥', 'err');
        const p = path.value.trim() || e.path;
        const method = e.method;
        const raw = body.value.trim();
        let payload;
        if (raw && method !== 'GET') {
          try { payload = JSON.parse(raw); } catch { return toast('请求体不是合法 JSON', 'err'); }
        }
        const t0 = performance.now();
        meta.textContent = '请求中…';
        out.textContent = '';
        try {
          const res = await fetch(p, {
            method,
            headers: { Authorization: `Bearer ${k}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
            body: payload ? JSON.stringify(payload) : undefined,
            credentials: 'omit',
          });
          const text = await res.text();
          const ms = Math.round(performance.now() - t0);
          meta.innerHTML = `${method} ${esc(p)} → <b class="api-status ${res.ok ? 'ok' : 'err'}">${res.status}</b> · ${ms} ms`;
          out.textContent = `${res.status} ${res.statusText}\n\n${prettyJson(text)}`;
          out.classList.toggle('err-text', !res.ok);
        } catch (err) {
          meta.innerHTML = `<b class="api-status err">请求失败</b>`;
          out.textContent = String(err.message || err);
        }
      };
    },
  });
  void m;
}

/* ---------------- 日志详情 ---------------- */

function showLog(l) {
  if (!l) return;
  modal({
    title: '调用详情',
    width: 660,
    body: `<div class="fields">
        <div class="fld"><div class="k">时间</div><div class="v mono">${dateTime(l.created_at)}</div></div>
        <div class="fld"><div class="k">接入方</div><div class="v">${esc(l.client_name || '—')}</div></div>
        <div class="fld"><div class="k">请求</div><div class="v mono">${esc(l.method)} ${esc(l.path)}</div></div>
        <div class="fld"><div class="k">结果</div><div class="v">${badge(l.status, l.status >= 400 ? 'red' : 'green')} · ${l.ms} ms</div></div>
        <div class="fld"><div class="k">来源 IP</div><div class="v mono">${esc(l.ip || '')}</div></div>
      </div>
      ${l.error ? `<div class="notice red" style="margin-top:10px">${icon('warn', 14)}<div>${esc(l.error)}</div></div>` : ''}
      <div class="field" style="margin-top:12px"><label>请求体</label>
        <pre class="code-block" style="max-height:150px">${esc(l.request ? prettyJson(l.request) : '（无）')}</pre></div>
      <div class="field" style="margin-top:10px"><label>响应</label>
        <pre class="code-block" style="max-height:200px">${esc(l.response ? prettyJson(l.response) : '（无）')}</pre></div>`,
    footer: `<button class="btn" data-c>关闭</button>`,
    onMount(root, close) { root.querySelector('[data-c]').onclick = close; },
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
