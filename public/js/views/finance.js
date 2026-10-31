import { api } from '../api.js';
import { state, labels } from '../store.js';
import { icon } from '../icons.js';
import {
  esc, money, amount, date, badge, statusTone, toast, modal, field, formData,
} from '../ui.js';

const TABS = [
  { key: 'overview', label: '财务概览' },
  { key: 'invoices', label: '发票' },
  { key: 'payments', label: '回款' },
  { key: 'receivables', label: '应收账龄' },
];

export async function render(el, route, ctx) {
  const tab = route.query.tab || 'overview';
  const [sum, inv, pay, rec] = await Promise.all([
    api.get('/api/finance/summary'),
    api.get('/api/finance/invoices'),
    api.get('/api/finance/payments'),
    tab === 'receivables' || tab === 'overview' ? api.get('/api/finance/receivables') : Promise.resolve({ rows: [] }),
  ]);

  const b = sum.buckets;
  const totalBucket = b.d0 + b.d30 + b.d60 + b.d90 + b.future || 1;
  const isFin = ['finance', 'admin', 'gm'].includes(state.user.role);

  el.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1>财务与回款</h1>
        <div class="desc">按合同生成回款计划，开票与回款双向核销，逾期自动分档</div>
      </div>
      <div class="actions">
        ${isFin ? `<button class="btn btn-primary" data-pay>${icon('plus', 12)} 登记回款</button>` : ''}
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="lb">生效合同额</div><div class="vl">${money(sum.signed)}</div><div class="sb">${sum.contractCount} 份合同</div></div>
      <div class="kpi"><div class="lb">已开票</div><div class="vl">${money(sum.invoiced)}</div><div class="sb">待开票 ${sum.pendingInvoiceCount} 张</div></div>
      <div class="kpi"><div class="lb">已回款</div><div class="vl" style="color:var(--green)">${money(sum.received)}</div><div class="sb">回款率 ${sum.signed ? ((sum.received / sum.signed) * 100).toFixed(0) : 0}%</div></div>
      <div class="kpi"><div class="lb">应收未收</div><div class="vl" style="color:${sum.overdueAmount > 0 ? 'var(--red)' : 'var(--ink)'}">${money(sum.receivable)}</div>
        <div class="sb">逾期 ${money(sum.overdueAmount)} · ${sum.overdueCount} 笔</div></div>
    </div>

    <div class="toolbar" style="margin-bottom:12px">
      <div class="seg" id="tabs">
        ${TABS.map((t) => `<button class="${tab === t.key ? 'on' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}
      </div>
      <div class="grow"></div>
      <span class="muted" style="font-size:12px">数据范围：${state.user.scope === 'all' ? '全集团' : state.user.scope === 'org' ? '本组织' : '本人'}</span>
    </div>

    ${tab === 'overview' ? renderOverview(sum, rec.rows, b, totalBucket) : ''}
    ${tab === 'invoices' ? renderInvoices(inv.rows, isFin) : ''}
    ${tab === 'payments' ? renderPayments(pay.rows) : ''}
    ${tab === 'receivables' ? renderReceivables(rec.rows) : ''}
  </div>`;

  el.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.onclick = () => (location.hash = `#/finance?tab=${btn.dataset.tab}`);
  });
  const pb = el.querySelector('[data-pay]');
  if (pb) pb.onclick = () => newPayment(ctx);

  el.querySelectorAll('[data-issue]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      try {
        const r = await api.post(`/api/finance/invoices/${btn.dataset.issue}/issue`);
        toast(`已开票：${r.no}`, 'ok');
        ctx.refresh();
      } catch (err) { toast(err.message, 'err'); }
    };
  });
}

function renderOverview(sum, plans, b, total) {
  const overdue = plans.filter((p) => p.status === 'pending' && p.overdue_days > 0);
  const rows = [
    { k: '未到期', v: b.future, c: 'var(--green)' },
    { k: '逾期 1-30 天', v: b.d0, c: 'var(--amber)' },
    { k: '逾期 31-60 天', v: b.d30, c: '#e08a2e' },
    { k: '逾期 61-90 天', v: b.d60, c: 'var(--red)' },
    { k: '逾期 90 天以上', v: b.d90, c: '#9c2f28' },
  ];
  return `<div class="grid2">
    <div class="panel">
      <div class="panel-head"><h3>应收账龄分布</h3><span class="badge badge-gray">按回款计划到期日</span></div>
      <div class="panel-body">
        <div class="funnel">
          ${rows.map((r) => `<div class="fn-row">
            <div class="nm">${r.k}</div>
            <div class="fn-bar"><i style="width:${Math.max(2, (r.v / total) * 100)}%;background:${r.c}"></i>
              <span>${((r.v / total) * 100).toFixed(0)}%</span></div>
            <div class="amt">${money(r.v)}</div>
          </div>`).join('')}
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>逾期明细</h3>
        <span class="badge ${overdue.length ? 'badge-red' : 'badge-gray'}">${overdue.length} 笔</span></div>
      <div class="panel-body flush">
        ${overdue.length ? `<table class="grid">
          <thead><tr><th>客户 / 合同</th><th class="num">金额</th><th>逾期</th></tr></thead>
          <tbody>${overdue.slice(0, 8).map((p) => `<tr style="cursor:default">
            <td><div class="cell-main">${esc(p.account_name)}</div><div class="cell-sub">${esc(p.contract_no)}</div></td>
            <td class="num">${amount(p.amount)}</td>
            <td style="color:var(--red)">${p.overdue_days} 天</td>
          </tr>`).join('')}</tbody>
        </table>` : '<div class="empty" style="padding:30px"><strong>没有逾期</strong><span>所有回款计划均在有效期内</span></div>'}
      </div>
    </div>
  </div>`;
}

function renderInvoices(rows, isFin) {
  return `<div class="listwrap"><div class="tablewrap">
    <table class="grid">
      <thead><tr><th>发票号</th><th style="min-width:200px">合同 / 客户</th><th class="num">金额</th>
        <th>状态</th><th>申请人</th><th>申请时间</th><th></th></tr></thead>
      <tbody>
        ${rows.length ? rows.map((i) => `<tr style="cursor:default">
          <td class="mono">${esc(i.no || '—')}</td>
          <td><div class="cell-main">${esc(i.account_name)}</div><div class="cell-sub">${esc(i.contract_no)} · ${esc(i.title)}</div></td>
          <td class="num">${amount(i.amount)}</td>
          <td>${badge(labels.invoiceStatus[i.status] || i.status, statusTone(i.status))}</td>
          <td>${esc(i.applicant_name || '—')}</td>
          <td class="nowrap muted">${date(i.applied_at)}</td>
          <td class="right">${isFin && i.status === 'applied' ? `<button class="btn btn-sm" data-issue="${i.id}">开票</button>` : ''}</td>
        </tr>`).join('') : `<tr><td colspan="7"><div class="empty"><strong>暂无发票</strong><span>合同生效后可发起开票申请</span></div></td></tr>`}
      </tbody>
    </table>
  </div></div>`;
}

function renderPayments(rows) {
  return `<div class="listwrap"><div class="tablewrap">
    <table class="grid">
      <thead><tr><th>回款单号</th><th style="min-width:200px">合同 / 客户</th><th class="num">金额</th>
        <th class="num">已核销</th><th>收款日期</th><th>银行流水</th><th>登记人</th></tr></thead>
      <tbody>
        ${rows.length ? rows.map((p) => `<tr style="cursor:default">
          <td class="mono">${esc(p.no)}</td>
          <td><div class="cell-main">${esc(p.account_name)}</div><div class="cell-sub">${esc(p.contract_no)}</div></td>
          <td class="num" style="color:var(--green);font-weight:500">+${amount(p.amount)}</td>
          <td class="num">${p.allocated ? amount(p.allocated) : '—'}</td>
          <td class="nowrap">${date(p.received_at)}</td>
          <td class="muted">${esc(p.bank_ref || '—')}</td>
          <td>${esc(p.creator_name || '—')}</td>
        </tr>`).join('') : `<tr><td colspan="7"><div class="empty"><strong>暂无回款记录</strong><span>财务登记后会显示在这里</span></div></td></tr>`}
      </tbody>
    </table>
  </div></div>`;
}

function renderReceivables(rows) {
  return `<div class="listwrap"><div class="tablewrap">
    <table class="grid">
      <thead><tr><th>客户 / 合同</th><th>期次</th><th>到期日</th><th class="num">金额</th>
        <th>状态</th><th>负责人</th></tr></thead>
      <tbody>
        ${rows.length ? rows.map((p) => {
          const overdue = p.status === 'pending' && p.overdue_days > 0;
          return `<tr style="cursor:default">
            <td><div class="cell-main">${esc(p.account_name)}</div><div class="cell-sub">${esc(p.contract_no)}</div></td>
            <td>第 ${p.seq} 期</td>
            <td class="nowrap">${date(p.due_date)}</td>
            <td class="num">${amount(p.amount)}</td>
            <td>${p.status === 'received' ? badge('已回款', 'green') : overdue ? badge(`逾期 ${p.overdue_days} 天`, 'red') : badge('待回款', 'gray')}</td>
            <td>${esc(p.owner_name || '—')}</td>
          </tr>`;
        }).join('') : `<tr><td colspan="6"><div class="empty"><strong>暂无应收计划</strong><span>合同生效后自动生成</span></div></td></tr>`}
      </tbody>
    </table>
  </div></div>`;
}

function newPayment(ctx) {
  api.get('/api/contracts?status=active').then((d) => {
    if (!d.rows.length) return toast('没有可登记回款的生效合同', 'err');
    modal({
      title: '登记回款',
      width: 520,
      body: `<div class="stack">
        ${field('合同', 'contract_id', { required: true, options: d.rows.map((c) => ({ value: c.id, label: `${c.no} · ${c.account_name} · 应收 ${amount(c.amount - c.received)}` })) })}
        <div class="formgrid">
          ${field('回款金额（元）', 'amount', { type: 'number', required: true, min: 0, step: 100 })}
          ${field('收款日期', 'received_at', { type: 'date', value: new Date().toISOString().slice(0, 10) })}
          ${field('收款方式', 'method', { options: state.dict.paymentMethods })}
          ${field('银行流水号', 'bank_ref')}
        </div>
        ${field('备注', 'remark', { full: true })}
        <div class="notice blue">${icon('info', 14)}<div>系统会自动核销该合同下已开票未核销的发票，并更新回款计划状态。</div></div>
      </div>`,
      footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>确认登记</button>`,
      onMount(root, close) {
        root.querySelector('[data-c]').onclick = close;
        root.querySelector('[data-ok]').onclick = async () => {
          const f = formData(root);
          if (!f.amount) return toast('请填写金额', 'err');
          try {
            const r = await api.post('/api/finance/payments', f);
            toast(`回款已登记，自动核销${r.unallocated > 0 ? `，未核销 ${amount(r.unallocated)} 元` : ''}`, 'ok');
            close(); ctx.refresh();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  });
}

export const __x = { money };
