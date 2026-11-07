import { api } from '../api.js';
import { state, can, labels } from '../store.js';
import { icon } from '../icons.js';
import { esc, money, amount, date, relTime, dueText, badge, statusTone, initials } from '../ui.js';

function kpiCard(k) {
  const val = k.format === 'money' ? money(k.value) : amount(k.value);
  return `<div class="kpi">
    <div class="lb">${esc(k.label)}</div>
    <div class="vl">${val}${k.format === 'money' ? '<small>元</small>' : ''}</div>
    <div class="sb">${esc(k.sub || '')}</div>
    ${k.progress !== null && k.progress !== undefined
      ? `<div class="kpi-progress"><i style="width:${Math.min(100, k.progress * 100)}%"></i></div>` : ''}
  </div>`;
}

export async function render(el) {
  const d = await api.get('/api/dashboard');
  const u = state.user;
  const maxFunnel = Math.max(1, ...d.funnel.map((f) => f.amount));
  const maxTrend = Math.max(1, ...d.trend.map((t) => t.amount));

  const todayList = d.leads.filter((l) => l.next_date && l.next_date <= new Date().toISOString().slice(0, 10));
  const greet = (() => {
    const h = new Date().getHours();
    return h < 6 ? '夜深了' : h < 12 ? '早上好' : h < 18 ? '下午好' : '晚上好';
  })();

  el.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1>${greet}，${esc(u.name)}</h1>
        <div class="desc">${esc(u.orgName)} · ${esc(u.roleLabel)} · 今天是 ${date(new Date().toISOString())}
          ${d.period ? `　本月进度 ${d.kpi.find((k) => k.key === 'won')?.sub || ''}` : ''}</div>
      </div>
      <div class="actions">
        ${can('lead') ? `<button class="btn" data-go="#/leads?new=1">${icon('plus', 12)} 线索</button>` : ''}
        ${can('opportunity') ? `<button class="btn btn-primary" data-go="#/opportunities?new=1">${icon('plus', 12)} 商机</button>` : ''}
      </div>
    </div>

    <div class="kpis" style="grid-template-columns:repeat(${d.kpi.length},minmax(0,1fr))">
      ${d.kpi.map(kpiCard).join('')}
    </div>

    ${can('lead') ? `<div class="panel" style="margin-bottom:12px">
      <div class="panel-head">
        <h3>公共池</h3>
        <span class="badge ${d.poolTotal ? 'badge-amber' : 'badge-gray'}">${d.poolTotal ? d.poolTotal + ' 条待领' : '暂无待领'}</span>
        <button class="more" data-go="#/pool">进入公共池 →</button>
      </div>
      <div class="panel-body" style="padding:10px 14px">
        <div class="muted" style="font-size:12.5px">未认领 / 超时未跟进的线索会回到公共池，组织内成员可领取；无效线索永不回池。</div>
      </div>
    </div>` : ''}

    ${d.receivable ? `<div class="panel" style="margin-bottom:12px">
      <div class="panel-head">
        <h3>财务概览</h3>
        <span class="badge badge-gray">合同额 / 回款 / 应收</span>
        <button class="more" data-go="#/finance">查看财务 →</button>
      </div>
      <div class="panel-body" style="padding:0">
        <div class="threeway" style="border:none;border-radius:0">
          <div class="tw-cell"><div class="k">生效合同额</div><div class="v">${money(d.receivable.signed)}</div><div class="s">${d.receivable.signed ? '含税' : '暂无'}</div></div>
          <div class="tw-cell"><div class="k">已回款</div><div class="v" style="color:var(--green)">${money(d.receivable.received)}</div><div class="s">回款率 ${d.receivable.signed ? ((d.receivable.received / d.receivable.signed) * 100).toFixed(0) : 0}%</div></div>
          <div class="tw-cell"><div class="k">应收未收</div><div class="v" style="color:${d.receivable.overdue > 0 ? 'var(--red)' : 'var(--ink)'}">${money(d.receivable.outstanding)}</div><div class="s">${d.receivable.overdue > 0 ? `逾期 ${money(d.receivable.overdue)}（${d.receivable.overdueCount} 笔）` : '无逾期'}</div></div>
        </div>
      </div>
    </div>` : ''}

    <div class="grid2">
      <div class="stack">
        ${can('opportunity') ? `<div class="panel">
          <div class="panel-head">
            <h3>销售漏斗</h3>
            <span class="badge badge-gray">${d.funnel.reduce((s, f) => s + f.count, 0)} 个商机</span>
            <button class="more" data-go="#/opportunities?view=board">看板 →</button>
          </div>
          <div class="panel-body">
            <div class="funnel">
              ${d.funnel.map((f) => `<div class="fn-row">
                <div class="nm">${esc(f.label)}</div>
                <div class="fn-bar"><i style="width:${Math.max(3, (f.amount / maxFunnel) * 100)}%;background:${f.color}"></i>
                  <span>${f.count} 个</span></div>
                <div class="amt">${money(f.amount)}</div>
              </div>`).join('')}
            </div>
          </div>
        </div>` : ''}

        ${can('lead') ? `<div class="panel">
          <div class="panel-head">
            <h3>待跟进线索</h3>
            <span class="badge ${todayList.length ? 'badge-amber' : 'badge-gray'}">${todayList.length ? todayList.length + ' 条今日到期' : '共 ' + d.leads.length + ' 条'}</span>
            <button class="more" data-go="#/leads">全部 →</button>
          </div>
          <div class="panel-body flush">
            <table class="grid">
              <thead><tr><th>线索</th><th>联系人</th><th>状态</th><th>下次跟进</th></tr></thead>
              <tbody>
                ${d.leads.length ? d.leads.map((l) => `<tr data-lead="${l.id}">
                  <td><div class="cell-main">${esc(l.name)}</div><div class="cell-sub">${esc(l.next_action || '')}</div></td>
                  <td>${esc(l.contact_name || '—')}<div class="cell-sub">${esc(l.contact_phone || '')}</div></td>
                  <td>${badge(labels.leadStatus[l.status] || l.status, statusTone(l.status))}</td>
                  <td class="${l.next_date && l.next_date < new Date().toISOString().slice(0, 10) ? 'nowrap' : 'nowrap'}"
                      style="${l.next_date && l.next_date < new Date().toISOString().slice(0, 10) ? 'color:var(--red)' : ''}">${dueText(l.next_date)}</td>
                </tr>`).join('') : `<tr><td colspan="4"><div class="empty" style="padding:34px">
                  <strong>没有待跟进线索</strong><span>线索专员录入后会出现在这里</span></div></td></tr>`}
              </tbody>
            </table>
          </div>
        </div>` : ''}
      </div>

      <div class="stack">
        <div class="panel">
          <div class="panel-head">
            <h3>我的待办</h3>
            ${d.approvals.length ? `<span class="badge badge-amber">${d.approvals.length}</span>` : ''}
            <button class="more" data-go="#/approvals">审批中心 →</button>
          </div>
          <div class="panel-body" style="padding:6px 14px 12px">
            ${d.approvals.length ? `<div class="rel-list">
              ${d.approvals.map((a) => `<div class="rel" data-appr="${a.id}">
                <div style="flex:1;min-width:0">
                  <div class="nm" style="font-weight:500">${esc(a.title)}</div>
                  <div class="mt">${esc(a.applicant_name || '')} · ${esc(a.step_label)} · ${money(a.amount)}</div>
                </div>
                <span class="badge badge-amber">待审</span>
              </div>`).join('')}
            </div>` : `<div class="empty" style="padding:26px">
              <strong>暂无待办</strong><span>需要你审批的单据会显示在这里</span></div>`}
          </div>
        </div>

        ${d.ranking.length ? `<div class="panel">
          <div class="panel-head"><h3>业绩排名</h3><span class="badge badge-gray">本年度赢单</span></div>
          <div class="panel-body" style="padding:6px 14px 12px">
            ${d.ranking.map((r, i) => `<div class="rank-row">
              <div class="rank-no ${i < 3 ? 'top' : ''}">${i + 1}</div>
              <div class="nm">${esc(r.name)}${r.isMe ? '<span class="me">我</span>' : ''}</div>
              <div class="am">${money(r.amount)}</div>
            </div>`).join('')}
          </div>
        </div>` : ''}

        ${can('opportunity') ? `<div class="panel">
          <div class="panel-head"><h3>近 6 个月赢单</h3></div>
          <div class="panel-body">
            <div class="bars">
              ${d.trend.map((t) => `<div class="bar-col">
                <div class="v">${t.amount ? money(t.amount) : ''}</div>
                <div class="b" style="height:${Math.max(3, (t.amount / maxTrend) * 100)}%"></div>
                <div class="l">${t.month.slice(5)}月</div>
              </div>`).join('')}
            </div>
          </div>
        </div>` : ''}
      </div>
    </div>

    <div class="panel" style="margin-top:12px">
      <div class="panel-head"><h3>最近动态</h3></div>
      <div class="panel-body" style="padding:8px 14px 14px">
        ${d.recent.length ? `<div class="timeline">
          ${d.recent.map((a) => `<div class="tl-item">
            <div class="tl-dot"></div>
            <div class="tl-main">
              <div class="h">${esc(a.user_name || '')}
                <span class="badge badge-gray">${esc(labels.activityType[a.type] || a.type)}</span>
                <span class="muted" style="font-size:11px;font-weight:400">${relTime(a.created_at)}</span>
              </div>
              <div class="m">${esc(a.content || '')}${a.result ? ` · ${esc(a.result)}` : ''}</div>
            </div>
          </div>`).join('')}
        </div>` : '<div class="empty" style="padding:28px">暂无动态</div>'}
      </div>
    </div>
  </div>`;

  el.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => (location.hash = b.dataset.go); });
  el.querySelectorAll('[data-lead]').forEach((r) => { r.onclick = () => (location.hash = `#/leads/${r.dataset.lead}`); });
  el.querySelectorAll('[data-appr]').forEach((r) => { r.onclick = () => (location.hash = `#/approvals/${r.dataset.appr}`); });
}

export const __x = { initials };
