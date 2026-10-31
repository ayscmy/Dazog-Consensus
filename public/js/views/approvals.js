import { api } from '../api.js';
import { state } from '../store.js';
import { icon } from '../icons.js';
import {
  esc, money, date, relTime, badge, toast, modal, field, formData, openDrawer, approvalTimeline, blockList,
} from '../ui.js';

const TABS = [
  { key: 'todo', label: '待我审批' },
  { key: 'mine', label: '我发起的' },
  { key: 'done', label: '已处理' },
  { key: 'all', label: '全部', scopeAll: true },
];

export async function render(el, route, ctx) {
  const tab = route.query.tab || 'todo';
  const data = await api.get(`/api/approvals?scope=${tab === 'all' ? 'all' : tab}`);
  const rows = data.rows || [];

  el.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1>审批中心</h1>
        <div class="desc">折扣与合同审批按规则自动路由到对应层级，全程留痕</div>
      </div>
      <div class="actions"><button class="btn" data-refresh>${icon('search', 13)} 刷新</button></div>
    </div>

    <div class="toolbar" style="margin-bottom:12px">
      <div class="seg" id="tabs">
        ${TABS.filter((t) => !t.scopeAll || state.user.scope === 'all').map((t) => `<button class="${tab === t.key ? 'on' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}
      </div>
      <div class="grow"></div>
      <span class="muted" style="font-size:12px">共 ${rows.length} 条</span>
    </div>

    ${rows.length ? `<div class="stack">
      ${rows.map((a) => {
        const tone = a.status === 'approved' ? 'green' : a.status === 'rejected' ? 'red' : 'amber';
        const label = a.status === 'approved' ? '已通过' : a.status === 'rejected' ? '已驳回' : '待审批';
        return `<div class="panel" data-id="${a.id}" style="cursor:pointer">
          <div style="display:flex;align-items:center;gap:12px;padding:12px 14px">
            <div style="width:30px;height:30px;border-radius:7px;background:var(--bg-sunken);display:grid;place-items:center;color:var(--ink-2)">
              ${icon(a.type === 'contract' ? 'contract' : 'quote', 15)}
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:500;font-size:13px">${esc(a.title)}</div>
              <div class="muted" style="font-size:11.5px;margin-top:2px">
                ${esc(a.applicant_name || '')} · ${esc(a.org_name || '')} · ${relTime(a.created_at)}
                ${a.step_label ? ` · 当前节点：${esc(a.step_label)}` : ''}
              </div>
            </div>
            <div style="text-align:right">
              <div style="font-size:13px;font-weight:500;font-variant-numeric:tabular-nums">${money(a.amount)}</div>
              <div style="margin-top:3px">${badge(label, tone)}</div>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>` : `<div class="panel"><div class="empty">
      <strong>${tab === 'todo' ? '没有需要你审批的单据' : '暂无记录'}</strong>
      <span>${tab === 'todo' ? '新提交的折扣或合同会出现在这里' : ''}</span></div></div>`}
  </div>`;

  el.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => (location.hash = `#/approvals?tab=${b.dataset.tab}`);
  });
  el.querySelector('[data-refresh]').onclick = () => ctx.refresh();
  el.querySelectorAll('[data-id]').forEach((n) => {
    n.onclick = () => openApproval(Number(n.dataset.id), ctx);
  });
  if (route.id) openApproval(Number(route.id), ctx);
}

export async function openApproval(id, ctx) {
  const ap = await api.get(`/api/approvals/${id}`);
  const html = `
    <div class="drawer-head">
      <div style="flex:1;min-width:0">
        <h2>${esc(ap.title)}</h2>
        <div class="sub">${esc(ap.applicant_name || '')} · ${esc(ap.org_name || '')} · ${relTime(ap.created_at)}</div>
      </div>
      <button class="icon-btn close" data-close>${icon('close', 14)}</button>
    </div>
    <div class="drawer-body">
      <div class="section">
        <div class="fields">
          <div class="fld"><div class="k">审批类型</div><div class="v">${ap.type === 'contract' ? '合同审批' : '报价折扣审批'}</div></div>
          <div class="fld"><div class="k">金额</div><div class="v money">¥ ${Number(ap.amount || 0).toLocaleString()}</div></div>
          <div class="fld full"><div class="k">摘要</div><div class="v">${esc(ap.summary || '—')}</div></div>
        </div>
      </div>
      <div class="section">
        <div class="section-title">审批流转<span class="line"></span>
          ${badge(ap.status === 'approved' ? '已通过' : ap.status === 'rejected' ? '已驳回' : '进行中',
            ap.status === 'approved' ? 'green' : ap.status === 'rejected' ? 'red' : 'amber')}</div>
        ${approvalTimeline(ap)}
      </div>
      ${ap.canDecide ? `<div class="section">
        <div class="section-title">审批意见<span class="line"></span></div>
        <textarea class="textarea" id="comment" placeholder="驳回时必须填写意见，通过可选填"></textarea>
      </div>` : ''}
    </div>
    <div class="drawer-foot">
      ${ap.canDecide ? `
        <button class="btn btn-danger" data-reject>驳回</button>
        <div class="spacer"></div>
        <button class="btn btn-primary" data-approve>通过并提交下一关</button>
      ` : '<div class="spacer"></div><button class="btn" data-close2>关闭</button>'}
    </div>`;

  const close = openDrawer(html, {
    onMount(root, close) {
      root.querySelector('[data-close]').onclick = close;
      const c2 = root.querySelector('[data-close2]');
      if (c2) c2.onclick = close;

      const call = async (decision) => {
        const comment = root.querySelector('#comment')?.value || '';
        if (decision === 'rejected' && !comment.trim()) return toast('驳回必须填写意见', 'err');
        try {
          const r = await api.post(`/api/approvals/${id}/decide`, { decision, comment });
          if (r.status === 'approved') toast('审批已通过，流程结束', 'ok');
          else if (r.status === 'rejected') toast('已驳回', 'ok');
          else toast('已通过当前节点，流转到下一关', 'ok');
          close(); ctx.refresh();
        } catch (e) {
          if (e.detail?.length) blockList('无法提交', e.detail);
          else toast(e.message, 'err');
        }
      };
      const ok = root.querySelector('[data-approve]');
      if (ok) ok.onclick = () => call('approved');
      const rj = root.querySelector('[data-reject]');
      if (rj) rj.onclick = () => call('rejected');
    },
  });
}

export const __x = { date, modal, field, formData };
