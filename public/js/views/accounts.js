import { api } from '../api.js';
import { state, labels } from '../store.js';
import { icon } from '../icons.js';
import {
  esc, money, amount, date, relTime, badge, statusTone, toast, modal, field, formData, openDrawer,
} from '../ui.js';

export async function render(el, route, ctx) {
  const q = route.query;
  const params = new URLSearchParams();
  if (q.q) params.set('q', q.q);
  if (q.level) params.set('level', q.level);
  if (q.owner) params.set('owner', q.owner);
  const data = await api.get(`/api/accounts?${params.toString()}`);
  const manager = ['admin', 'gm', 'director', 'manager'].includes(state.user.role);

  el.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1>客户</h1>
        <div class="desc">客户主数据与联系人关系，商机、合同、回款都挂在客户下</div>
      </div>
      <div class="actions">
        <button class="btn" data-refresh>${icon('search', 13)} 刷新</button>
        <button class="btn btn-primary" data-new>${icon('plus', 12)} 新建客户</button>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="lb">客户总数</div><div class="vl">${data.stats.total}</div><div class="sb">A 类 ${data.stats.a_count || 0} 家</div></div>
      <div class="kpi"><div class="lb">生效合同额</div><div class="vl">${money(data.stats.signed_amount)}</div><div class="sb">全部客户合计</div></div>
      <div class="kpi"><div class="lb">覆盖行业</div><div class="vl">${new Set(data.rows.map((r) => r.industry).filter(Boolean)).size}</div><div class="sb">按行业分类</div></div>
      <div class="kpi"><div class="lb">联系人</div><div class="vl">${data.rows.reduce((s, r) => s + Number(r.contact_count || 0), 0)}</div><div class="sb">平均每家 ${data.rows.length ? (data.rows.reduce((s, r) => s + Number(r.contact_count || 0), 0) / data.rows.length).toFixed(1) : 0} 人</div></div>
    </div>

    <div class="toolbar">
      <input class="input" id="q" placeholder="搜索客户名称" value="${esc(q.q || '')}" style="width:220px" />
      <select class="select" id="fLevel">
        <option value="">全部等级</option>
        ${(state.dict.customerLevels || []).map((l) => `<option value="${l}" ${q.level === l ? 'selected' : ''}>${l} 类客户</option>`).join('')}
      </select>
      ${manager ? `<select class="select" id="fOwner">
        <option value="">全部负责人</option>
        ${state.users.map((u) => `<option value="${u.id}" ${String(q.owner) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
      </select>` : ''}
      <div class="grow"></div>
      <button class="btn" data-transfer disabled>${icon('team', 13)} 转让 <span id="ckCount"></span></button>
      <span class="muted" style="font-size:12px">${data.rows.length} 家客户</span>
    </div>

    <div class="listwrap"><div class="tablewrap">
      <table class="grid">
        <thead><tr>
          <th style="width:32px"><input type="checkbox" id="ckAll" title="全选" /></th>
          <th style="min-width:230px">客户</th><th>行业</th><th>等级</th><th>负责人</th>
          <th class="num">联系人</th><th class="num">在谈商机</th><th class="num">累计赢单</th><th>最近更新</th>
        </tr></thead>
        <tbody>
          ${data.rows.length ? data.rows.map((a) => `<tr data-id="${a.id}">
            <td class="ck"><input type="checkbox" data-ck="${a.id}" /></td>
            <td><div class="cell-main">${esc(a.name)}</div><div class="cell-sub">${esc(a.region || '')} · ${esc(a.short_name || '')}</div></td>
            <td>${esc(a.industry || '—')}</td>
            <td>${badge(a.level + ' 类', a.level === 'A' ? 'blue' : a.level === 'B' ? 'gray' : 'gray')}</td>
            <td class="nowrap">${esc(a.owner_name || '—')}</td>
            <td class="num">${a.contact_count}</td>
            <td class="num">${a.open_opps}</td>
            <td class="num">${a.won_amount ? amount(a.won_amount) : '—'}</td>
            <td class="nowrap muted">${relTime(a.updated_at)}</td>
          </tr>`).join('') : `<tr><td colspan="9"><div class="empty">
            <strong>没有符合条件的客户</strong><span>新建客户，或从线索转化</span></div></td></tr>`}
        </tbody>
      </table>
    </div></div>
  </div>`;

  const go = (patch) => {
    const next = { ...q, ...patch };
    const p = new URLSearchParams();
    Object.entries(next).forEach(([k, v]) => { if (v) p.set(k, v); });
    location.hash = `#/accounts${p.toString() ? '?' + p.toString() : ''}`;
  };
  el.querySelector('#q').onkeydown = (e) => { if (e.key === 'Enter') go({ q: e.target.value.trim() }); };
  el.querySelector('#fLevel').onchange = (e) => go({ level: e.target.value });
  const fo = el.querySelector('#fOwner');
  if (fo) fo.onchange = () => go({ owner: fo.value });
  el.querySelector('[data-refresh]').onclick = () => ctx.refresh();
  el.querySelector('[data-new]').onclick = () => newAccount(ctx);
  el.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.closest('input,button')) return;
      openAccount(Number(tr.dataset.id), ctx);
    };
  });

  const transferBtn = el.querySelector('[data-transfer]');
  const ckAll = el.querySelector('#ckAll');
  const boxes = [...el.querySelectorAll('[data-ck]')];
  const syncCk = () => {
    const picked = boxes.filter((b) => b.checked).map((b) => Number(b.dataset.ck));
    transferBtn.disabled = !picked.length;
    transferBtn.querySelector('#ckCount').textContent = picked.length ? `(${picked.length})` : '';
    transferBtn.dataset.ids = picked.join(',');
  };
  boxes.forEach((b) => { b.onchange = syncCk; });
  if (ckAll) {
    ckAll.onchange = () => {
      boxes.forEach((b) => { b.checked = ckAll.checked; });
      syncCk();
    };
  }
  transferBtn.onclick = () => {
    const ids = (transferBtn.dataset.ids || '').split(',').filter(Boolean).map(Number);
    if (!ids.length) return undefined;
    return transferAccounts(ctx, ids);
  };
  if (q.new === '1') newAccount(ctx);
  if (route.id) openAccount(Number(route.id), ctx);
}

function newAccount(ctx) {
  modal({
    title: '新建客户',
    width: 580,
    body: `<div class="formgrid">
      ${field('客户全称', 'name', { required: true, full: true })}
      ${field('简称', 'short_name')}
      ${field('行业', 'industry', { options: (state.dict.industries || []).map((x) => ({ value: x, label: x })) })}
      ${field('规模', 'scale', { options: (state.dict.accountScales || []).map((x) => ({ value: x, label: x })) })}
      ${field('区域', 'region', { options: (state.dict.regions || []).map((x) => ({ value: x, label: x })) })}
      ${field('客户等级', 'level', { options: ['A', 'B', 'C'].map((x) => ({ value: x, label: `${x} 类` })), value: 'B' })}
      ${field('信用等级', 'credit_level', { options: (state.dict.creditLevels || []).map((x) => ({ value: x, label: x })), value: 'A' })}
      ${field('来源', 'source', { options: (state.dict.sources || []).map((x) => ({ value: x, label: x })) })}
      ${field('负责人', 'owner_id', { options: state.users.map((u) => ({ value: u.id, label: `${u.name}（${u.title || ''}）` })), value: state.user.id })}
      ${field('电话', 'phone')}
      ${field('地址', 'address')}
    </div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>创建</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      root.querySelector('[data-ok]').onclick = async () => {
        const d = formData(root);
        if (!d.name) return toast('请填写客户名称', 'err');
        try {
          const r = await api.post('/api/accounts', d);
          toast('客户已创建', 'ok'); close(); ctx.refresh();
          setTimeout(() => openAccount(r.id, ctx), 200);
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

async function transferAccounts(ctx, ids, closeDrawer) {
  let targets = [];
  try {
    targets = await api.get('/api/transfer-targets?module=account');
  } catch (e) {
    return toast(e.message, 'err');
  }
  const others = (targets || []).filter((t) => !t.is_self);
  if (!others.length) {
    return toast('没有可接收的同事：接收人需在本部门或你的上级链上，且具备客户权限', 'err');
  }

  modal({
    title: ids.length > 1 ? `批量转让 ${ids.length} 个客户` : '转让客户',
    width: 520,
    body: `<div class="stack">
      <div class="notice blue">${icon('info', 14)}<div>
        转让后客户的负责人与所属组织改为接收人；进行中的商机可一并转移，合同、开票与回款记录保持不变。
      </div></div>
      ${field('转让给', 'owner_id', {
        required: true,
        options: others.map((t) => ({
          value: t.id,
          label: `${t.name}${t.title ? ' · ' + t.title : ''} · ${t.org_name}`,
        })),
        hint: '可选本部门同事，或上级经理 / 总监',
      })}
      <label style="display:flex;align-items:center;gap:8px;font-size:12.5px">
        <input type="checkbox" name="with_opps" checked /> 同时转移该客户下进行中的商机
      </label>
      ${ids.length > 1 ? `<div class="muted" style="font-size:12px">已选 ${ids.length} 个客户</div>` : ''}
    </div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>确认转让</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      root.querySelector('[data-ok]').onclick = async () => {
        const owner = Number(root.querySelector('[name="owner_id"]').value);
        const withOpps = root.querySelector('[name="with_opps"]').checked;
        if (!owner) return toast('请选择接收人', 'err');
        try {
          const r = await api.post('/api/accounts/bulk-transfer', {
            ids, owner_id: owner, with_opportunities: withOpps,
          });
          toast(r.message, 'ok');
          if (r.skipped?.length) {
            toast(`${r.skipped.length} 个客户未转让：${r.skipped.map((s) => s.reason).join('、')}`, 'err');
          }
          close();
          if (closeDrawer) closeDrawer();
          ctx.refresh();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
  return undefined;
}

export async function openAccount(id, ctx) {
  const a = await api.get(`/api/accounts/${id}`);
  const s = a.summary;

  const html = `
    <div class="drawer-head">
      <div style="flex:1;min-width:0">
        <h2>${esc(a.name)}</h2>
        <div class="sub">${badge(a.level + ' 类客户', 'blue')}
          <span style="margin-left:6px">${esc(a.industry || '')} · ${esc(a.region || '')} · ${esc(a.owner_name || '')}</span></div>
      </div>
      <button class="icon-btn close" data-close>${icon('close', 14)}</button>
    </div>
    <div class="drawer-body">
      <div class="section">
        <div class="section-title">客户概览<span class="line"></span></div>
        <div class="threeway">
          <div class="tw-cell"><div class="k">生效合同</div><div class="v">${money(s.signed)}</div><div class="s">已签</div></div>
          <div class="tw-cell"><div class="k">已开票</div><div class="v">${money(s.invoiced)}</div><div class="s">含税</div></div>
          <div class="tw-cell"><div class="k">已回款</div><div class="v" style="color:var(--green)">${money(s.received)}</div><div class="s">实收</div></div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">基本信息<span class="line"></span></div>
        <div class="fields">
          <div class="fld"><div class="k">简称</div><div class="v">${esc(a.short_name || '—')}</div></div>
          <div class="fld"><div class="k">规模</div><div class="v">${esc(a.scale || '—')}</div></div>
          <div class="fld"><div class="k">信用等级</div><div class="v">${esc(a.credit_level || '—')}</div></div>
          <div class="fld"><div class="k">来源</div><div class="v">${esc(a.source || '—')}</div></div>
          <div class="fld full"><div class="k">地址</div><div class="v">${esc(a.address || '—')}</div></div>
          <div class="fld"><div class="k">电话</div><div class="v">${esc(a.phone || '—')}</div></div>
          <div class="fld"><div class="k">网站</div><div class="v">${esc(a.website || '—')}</div></div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">联系人<span class="line"></span>
          <button class="btn btn-sm" data-add-contact>添加联系人</button></div>
        ${a.contacts.length ? `<div class="rel-list">
          ${a.contacts.map((c) => `<div class="rel">
            <div class="avatar" style="width:24px;height:24px;flex:0 0 24px;font-size:10px">${esc((c.name || '?').slice(-2))}</div>
            <div style="flex:1;min-width:0">
              <div class="nm">${esc(c.name)}
                ${c.is_primary ? badge('主联系人', 'blue') : ''}
                ${badge(labels.contactRole[c.role_type] || c.role_type || '—', c.role_type === 'decision' ? 'violet' : 'gray')}
              </div>
              <div class="mt">${esc(c.title || '')} ${c.phone ? '· ' + esc(c.phone) : ''}</div>
            </div>
          </div>`).join('')}
        </div>` : '<div class="muted" style="font-size:12.5px">暂无联系人，转商机前至少需要 1 位决策人</div>'}
      </div>

      <div class="section">
        <div class="section-title">商机<span class="line"></span></div>
        ${a.opportunities.length ? `<div class="rel-list">
          ${a.opportunities.map((o) => `<div class="rel" data-opp="${o.id}">
            <div style="flex:1;min-width:0"><div class="nm">${esc(o.name)}</div>
              <div class="mt">${esc(o.owner_name || '')} · 预计 ${date(o.expected_date)}</div></div>
            <div class="am">${money(o.amount)}</div>
            ${badge(labels.oppStage[o.stage] || o.stage, statusTone(o.stage))}
          </div>`).join('')}
        </div>` : '<div class="muted" style="font-size:12.5px">暂无商机</div>'}
      </div>

      <div class="section">
        <div class="section-title">合同<span class="line"></span></div>
        ${a.contracts.length ? `<div class="rel-list">
          ${a.contracts.map((c) => `<div class="rel" data-contract="${c.id}">
            <div style="flex:1;min-width:0"><div class="nm">${esc(c.no)}</div>
              <div class="mt">${esc(c.title)}</div></div>
            <div class="am">${money(c.amount)}</div>
            ${badge(labels.contractStatus[c.status] || c.status, statusTone(c.status))}
          </div>`).join('')}
        </div>` : '<div class="muted" style="font-size:12.5px">暂无合同</div>'}
      </div>
    </div>
    <div class="drawer-foot">
      <button class="btn" data-transfer-one>${icon('team', 13)} 转让客户</button>
      <div class="spacer"></div>
      <button class="btn" data-close2>关闭</button>
    </div>`;

  const close = openDrawer(html, {
    onMount(root, close) {
      root.querySelector('[data-close]').onclick = close;
      root.querySelector('[data-close2]').onclick = close;
      root.querySelector('[data-transfer-one]').onclick = () => transferAccounts(ctx, [a.id], close);
      root.querySelectorAll('[data-opp]').forEach((n) => {
        n.onclick = () => { close(); location.hash = `#/opportunities/${n.dataset.opp}`; };
      });
      root.querySelectorAll('[data-contract]').forEach((n) => {
        n.onclick = () => { close(); location.hash = `#/contracts/${n.dataset.contract}`; };
      });
      root.querySelector('[data-add-contact]').onclick = () => {
        modal({
          title: '添加联系人',
          width: 500,
          body: `<div class="formgrid">
            ${field('姓名', 'name', { required: true })}
            ${field('职位', 'title')}
            ${field('部门', 'dept')}
            ${field('电话', 'phone')}
            ${field('邮箱', 'email', { type: 'email' })}
            ${field('角色', 'role_type', { options: state.dict.contactRoles, value: 'decision' })}
            ${field('备注', 'remark', { full: true })}
          </div>`,
          footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>保存</button>`,
          onMount(r2, c2) {
            r2.querySelector('[data-c]').onclick = c2;
            r2.querySelector('[data-ok]').onclick = async () => {
              const d = formData(r2);
              if (!d.name) return toast('请填写姓名', 'err');
              try {
                await api.post(`/api/accounts/${a.id}/contacts`, d);
                toast('联系人已添加', 'ok'); c2(); close();
                setTimeout(() => openAccount(a.id, ctx), 150);
              } catch (e) { toast(e.message, 'err'); }
            };
          },
        });
      };
    },
  });
}
