import { api } from '../api.js';
import { state, labels } from '../store.js';
import { icon } from '../icons.js';
import { esc, money, badge, statusTone } from '../ui.js';

export async function render(el, route) {
  const q = route.query.q || '';
  const d = q ? await api.get(`/api/search?q=${encodeURIComponent(q)}`) : { accounts: [], opportunities: [], leads: [], contracts: [] };
  const total = d.accounts.length + d.opportunities.length + d.leads.length + d.contracts.length;

  const group = (title, items, renderItem) => items.length ? `
    <div class="panel" style="margin-bottom:12px">
      <div class="panel-head"><h3>${title}</h3><span class="badge badge-gray">${items.length}</span></div>
      <div class="panel-body" style="padding:6px 14px 12px"><div class="rel-list">${items.map(renderItem).join('')}</div></div>
    </div>` : '';

  el.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1>搜索结果</h1>
        <div class="desc">${q ? `关键词「${esc(q)}」，共 ${total} 条结果` : '输入关键词搜索客户、商机、线索、合同'}</div>
      </div>
    </div>

    <div class="toolbar" style="margin-bottom:14px">
      <input class="input" id="sq" placeholder="搜索客户、商机、线索、合同" value="${esc(q)}" style="width:340px" />
      <button class="btn btn-primary" id="sgo">${icon('search', 13)} 搜索</button>
    </div>

    ${!q ? '<div class="panel"><div class="empty"><strong>输入关键词开始搜索</strong><span>支持客户名称、商机名称、线索联系人、合同号</span></div></div>' : ''}
    ${q && !total ? '<div class="panel"><div class="empty"><strong>没有找到匹配结果</strong><span>换个关键词，或确认数据范围</span></div></div>' : ''}

    ${group('客户', d.accounts, (a) => `<div class="rel" data-go="#/accounts/${a.id}">
      <div style="flex:1"><div class="nm">${esc(a.name)}</div><div class="mt">${esc(a.industry || '')}</div></div>
      ${badge(a.level + ' 类', 'blue')}</div>`)}

    ${group('商机', d.opportunities, (o) => `<div class="rel" data-go="#/opportunities/${o.id}">
      <div style="flex:1"><div class="nm">${esc(o.name)}</div><div class="mt">${esc(o.account_name)}</div></div>
      <div class="am">${money(o.amount)}</div>${badge(labels.oppStage[o.stage] || o.stage, statusTone(o.stage))}</div>`)}

    ${group('线索', d.leads, (l) => `<div class="rel" data-go="#/leads/${l.id}">
      <div style="flex:1"><div class="nm">${esc(l.name)}</div><div class="mt">${esc(l.contact_name || '')}</div></div>
      ${badge(labels.leadStatus[l.status] || l.status, statusTone(l.status))}</div>`)}

    ${group('合同', d.contracts, (c) => `<div class="rel" data-go="#/contracts/${c.id}">
      <div style="flex:1"><div class="nm">${esc(c.title)}</div><div class="mt mono">${esc(c.no)}</div></div>
      <div class="am">${money(c.amount)}</div>${badge(labels.contractStatus[c.status] || c.status, statusTone(c.status))}</div>`)}
  </div>`;

  const go = () => {
    const v = el.querySelector('#sq').value.trim();
    if (v) location.hash = `#/search?q=${encodeURIComponent(v)}`;
  };
  el.querySelector('#sgo').onclick = go;
  el.querySelector('#sq').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  el.querySelectorAll('[data-go]').forEach((n) => { n.onclick = () => (location.hash = n.dataset.go); });
  void state;
}
