import { api } from './api.js';
import { state, setBootstrap, can } from './store.js';
import { icon } from './icons.js';
import { esc, initials, toast, modal, field, formData } from './ui.js';

const NAV = [
  {
    group: '工作',
    items: [
      { key: 'dashboard', label: '工作台', icon: 'dash' },
      { key: 'approvals', label: '审批中心', icon: 'approval', badge: 'pending', module: 'approval' },
    ],
  },
  {
    group: '客户与销售',
    items: [
      { key: 'leads', label: '线索', icon: 'lead', module: 'lead' },
      { key: 'accounts', label: '客户', icon: 'account', module: 'account' },
      { key: 'opportunities', label: '商机', icon: 'opp', module: 'opportunity' },
      { key: 'quotations', label: '报价', icon: 'quote', module: 'quotation' },
      { key: 'contracts', label: '合同', icon: 'contract', module: 'contract' },
      { key: 'products', label: '产品库', icon: 'product', module: 'product' },
    ],
  },
  { group: '财务', items: [{ key: 'finance', label: '财务与回款', icon: 'finance', module: 'finance' }] },
  { group: '分析', items: [{ key: 'reports', label: '经营报表', icon: 'report', module: 'report' }] },
  {
    group: '系统',
    items: [
      { key: 'settings', label: '系统设置', icon: 'gear', role: ['admin', 'gm'] },
      { key: 'admin', label: '用户与组织', icon: 'admin', module: 'admin' },
    ],
  },
];

const TITLES = {
  dashboard: '工作台', approvals: '审批中心', leads: '线索', accounts: '客户',
  opportunities: '商机', quotations: '报价', contracts: '合同', finance: '财务与回款',
  reports: '经营报表', products: '产品库', settings: '系统设置',
  admin: '用户与组织', search: '搜索结果',
};

function renderSidebar() {
  const u = state.user;
  const groups = NAV.map((g) => {
    const items = g.items.filter((i) => {
      if (i.role && !i.role.includes(u.role)) return false;
      return !i.module || can(i.module);
    });
    if (!items.length) return '';
    return `<div class="nav-group">
      <div class="nav-title">${g.group}</div>
      ${items.map((i) => {
        const badge = i.badge === 'pending' && state.pending ? `<span class="cnt">${state.pending}</span>` : '';
        return `<button class="nav-item" data-nav="${i.key}">
          ${icon(i.icon, 15)}<span class="lbl">${i.label}</span>${badge}</button>`;
      }).join('')}
    </div>`;
  }).join('');

  document.getElementById('sidebar').innerHTML = `
    <div class="sb-brand">
      <div class="logo-mark">M</div>
      <div class="t">MSERM CRM<small>集团销售作业平台</small></div>
    </div>
    <div class="sb-ws">
      <span class="dot"></span>
      <span class="nm">${esc(u.orgName)}</span>
      <span class="rl">${esc(u.roleLabel)}</span>
    </div>
    <nav class="sb-nav">${groups}</nav>
    <div class="sb-foot">
      <button class="user-chip" id="userChip">
        <div class="avatar">${esc(initials(u.name))}</div>
        <div style="flex:1;min-width:0">
          <div class="nm">${esc(u.name)}</div>
          <div class="rl">${esc(u.title || u.roleLabel)}</div>
        </div>
        ${icon('chev', 13)}
      </button>
    </div>`;

  document.querySelectorAll('[data-nav]').forEach((b) => {
    b.onclick = () => { location.hash = `#/${b.dataset.nav}`; };
  });
  document.getElementById('userChip').onclick = openUserMenu;
}

function renderTopbar(view) {
  const u = state.user;
  const time = new Date().getHours();
  const greet = time < 6 ? '夜深了' : time < 12 ? '早上好' : time < 18 ? '下午好' : '晚上好';
  document.getElementById('topbar').innerHTML = `
    <div class="crumb">
      <b>${esc(TITLES[view] || '工作台')}</b>
      <span style="color:var(--ink-4)">/</span>
      <span>${esc(u.orgName)}</span>
    </div>
    <div class="top-search">
      ${icon('search', 13)}
      <input id="globalSearch" placeholder="搜索客户、商机、线索…" autocomplete="off" />
    </div>
    <div class="top-actions">
      <button class="icon-btn" id="bellBtn" title="待办">
        ${icon('bell', 15)}${state.pending ? '<i class="dot-badge"></i>' : ''}
      </button>
      <button class="btn btn-sm" id="quickAdd">${icon('plus', 12)} 新建</button>
    </div>`;

  document.getElementById('bellBtn').onclick = () => { location.hash = '#/approvals'; };
  document.getElementById('quickAdd').onclick = openQuickAdd;

  const input = document.getElementById('globalSearch');
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      location.hash = `#/search?q=${encodeURIComponent(input.value.trim())}`;
    }
  };
  void greet;
}

function openUserMenu() {
  const u = state.user;
  const m = modal({
    title: '账号',
    width: 380,
    body: `
      <div style="display:flex;gap:11px;align-items:center;padding:4px 0 14px;border-bottom:1px solid var(--line-soft)">
        <div class="avatar" style="width:38px;height:38px;flex:0 0 38px;font-size:13px">${esc(initials(u.name))}</div>
        <div>
          <div style="font-weight:600;font-size:14px">${esc(u.name)}</div>
          <div class="muted" style="font-size:12px">${esc(u.title || '')} · ${esc(u.roleLabel)} · ${esc(u.orgName)}</div>
        </div>
      </div>
      <div class="fields" style="margin-top:14px">
        <div class="fld"><div class="k">账号</div><div class="v mono">${esc(u.username)}</div></div>
        <div class="fld"><div class="k">数据范围</div><div class="v">${u.scope === 'all' ? '全集团' : u.scope === 'org' ? '本组织及下级' : '仅本人'}</div></div>
        <div class="fld"><div class="k">部门</div><div class="v">${esc(u.orgName)}</div></div>
        <div class="fld"><div class="k">上级组织</div><div class="v">${esc(u.parentOrgName || '—')}</div></div>
      </div>`,
    footer: `<button class="btn" data-pwd>修改密码</button><button class="btn btn-danger" data-logout>退出登录</button>`,
    onMount(root, close) {
      root.querySelector('[data-logout]').onclick = async () => {
        await api.post('/api/auth/logout');
        location.href = '/login.html';
      };
      root.querySelector('[data-pwd]').onclick = () => { close(); changePassword(); };
    },
  });
  void m;
}

function changePassword() {
  modal({
    title: '修改密码',
    width: 420,
    body: `<div class="stack">
      ${field('原密码', 'oldPassword', { type: 'password', required: true })}
      ${field('新密码', 'newPassword', { type: 'password', required: true, hint: '至少 8 位，修改后需重新登录' })}
    </div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>保存</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      root.querySelector('[data-ok]').onclick = async () => {
        const d = formData(root);
        try {
          await api.post('/api/auth/password', d);
          toast('密码已修改，请重新登录', 'ok');
          setTimeout(() => (location.href = '/login.html'), 800);
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    },
  });
}

function openQuickAdd() {
  const opts = [
    can('lead') && ['leads', '新建线索'],
    can('account') && ['accounts', '新建客户'],
    can('opportunity') && ['opportunities', '新建商机'],
  ].filter(Boolean);
  modal({
    title: '新建',
    width: 340,
    body: `<div class="stack">${opts.map(([k, l]) =>
      `<button class="btn" style="justify-content:flex-start;height:36px" data-go="${k}">${l}</button>`).join('')}</div>`,
    onMount(root, close) {
      root.querySelectorAll('[data-go]').forEach((b) => {
        b.onclick = () => { close(); location.hash = `#/${b.dataset.go}?new=1`; };
      });
    },
  });
}

function highlightNav(view) {
  document.querySelectorAll('[data-nav]').forEach((b) => {
    b.classList.toggle('on', b.dataset.nav === view);
  });
}

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = h.split('?');
  const segs = pathPart.split('/').filter(Boolean);
  return {
    view: segs[0] || 'dashboard',
    id: segs[1] || null,
    sub: segs[2] || null,
    query: Object.fromEntries(new URLSearchParams(queryPart || '')),
  };
}

let renderToken = 0;

export async function route() {
  const r = parseHash();
  state.route = r;
  highlightNav(r.view);
  renderTopbar(r.view);

  const token = ++renderToken;
  const el = document.getElementById('view');
  el.innerHTML = '<div class="page"><div class="empty">加载中…</div></div>';

  let mod = null;
  try {
    mod = await import(`./views/${r.view}.js`);
  } catch (err) {
    console.warn('view not found', r.view, err);
  }
  if (token !== renderToken) return;

  if (!mod || !mod.render) {
    el.innerHTML = `<div class="page"><div class="empty">
      <strong>页面不存在</strong><span>该模块可能尚未开放或已下线</span>
      <button class="btn" onclick="location.hash='#/dashboard'">返回工作台</button></div></div>`;
    return;
  }
  try {
    await mod.render(el, r, { refresh: () => route(), reloadShell: renderShell });
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="page"><div class="notice red">${icon('warn', 14)}
      <div><b>加载失败：</b>${esc(err.message)}</div></div></div>`;
  }
}

function renderShell() {
  renderSidebar();
  renderTopbar(state.route.view || 'dashboard');
}

async function boot() {
  try {
    const data = await api.get('/api/bootstrap');
    setBootstrap(data);
  } catch {
    return;
  }
  renderShell();
  if (!location.hash) location.hash = '#/dashboard';
  await route();
  window.addEventListener('hashchange', route);

  // 每 60 秒刷新待办计数
  setInterval(async () => {
    try {
      const { count } = await api.get('/api/approvals/count');
      if (count !== state.pending) {
        state.pending = count;
        renderSidebar();
        highlightNav(state.route.view);
      }
    } catch { /* 忽略 */ }
  }, 60000);
}

window.addEventListener('error', (e) => console.error(e.error));
boot();
