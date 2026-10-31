import { api } from '../api.js';
import { state, labels, can } from '../store.js';
import { icon } from '../icons.js';
import { openSubmitApproval } from '../approval-flow.js';
import { openContractCreate } from '../contract-create.js';
import {
  esc, money, amount, date, relTime, badge, statusTone, toast, modal, field, formData,
  openDrawer, approvalTimeline, confirmBox,
} from '../ui.js';

const KIND_LABEL = { order: '订单合同', terms: '条款合同' };
const fmt = (n) => Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function render(el, route, ctx) {
  const q = route.query;
  const params = new URLSearchParams();
  if (q.q) params.set('q', q.q);
  if (q.status) params.set('status', q.status);
  const [data, pending] = await Promise.all([
    api.get(`/api/contracts?${params.toString()}`),
    api.get('/api/contracts/pending').catch(() => ({ rows: [] })),
  ]);

  el.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1>合同</h1>
        <div class="desc">报价通过后在此直接创建合同：订单合同（发票式单据）或条款合同（模板条款）；生成后走三关审批</div>
      </div>
      <div class="actions"><button class="btn" data-refresh>${icon('search', 13)} 刷新</button></div>
    </div>

    ${pending.rows.length ? `<div class="card" style="margin-bottom:16px;border-color:var(--accent-line)">
      <div class="card-head">
        <h3>${icon('info', 14)} 待创建合同（${pending.rows.length} 张已批准报价）</h3>
        <span class="muted" style="font-size:12px">价格已审批锁定，选择合同类型即可生成</span>
      </div>
      <div class="tablewrap">
        <table class="grid">
          <thead><tr>
            <th>报价号</th><th style="min-width:200px">商机 / 客户</th>
            <th class="num">成交金额</th><th class="num">折扣</th><th class="num">明细</th>
            <th>有效期至</th><th>负责人</th><th style="width:120px">操作</th>
          </tr></thead>
          <tbody>
            ${pending.rows.map((r) => `<tr>
              <td class="mono">${esc(r.quote_no)}</td>
              <td><div class="cell-main">${esc(r.opportunity_name)}</div><div class="cell-sub">${esc(r.account_name)}</div></td>
              <td class="num money">${amount(r.amount)}</td>
              <td class="num">${(Number(r.discount_rate) * 100).toFixed(2)}%</td>
              <td class="num">${r.item_count} 项</td>
              <td class="nowrap muted">${date(r.valid_until)}</td>
              <td class="nowrap">${esc(r.owner_name || '—')}</td>
              <td><button class="btn btn-sm btn-primary" data-create="${r.quotation_id}">创建合同</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}

    <div class="kpis">
      <div class="kpi"><div class="lb">合同总数</div><div class="vl">${data.stats.total}</div><div class="sb">全部状态</div></div>
      <div class="kpi"><div class="lb">审批中</div><div class="vl">${data.stats.pending}</div><div class="sb">销售 / 财务 / 法务</div></div>
      <div class="kpi"><div class="lb">生效合同额</div><div class="vl">${money(data.stats.amount)}</div><div class="sb">${data.stats.active} 份生效</div></div>
      <div class="kpi"><div class="lb">已回款</div><div class="vl">${money(data.stats.received)}</div><div class="sb">回款率 ${data.stats.amount ? ((data.stats.received / data.stats.amount) * 100).toFixed(0) : 0}%</div></div>
    </div>

    <div class="toolbar">
      <input class="input" id="q" placeholder="搜索合同号 / 标题 / 客户" value="${esc(q.q || '')}" style="width:240px" />
      <select class="select" id="fStatus">
        <option value="">全部状态</option>
        ${(state.dict.contractStatus || []).map((s) => `<option value="${s.key}" ${q.status === s.key ? 'selected' : ''}>${s.label}</option>`).join('')}
      </select>
      <div class="grow"></div>
      <span class="muted" style="font-size:12px">审批规则：&gt;50 万或账期&gt;30 天加总监，&gt;100 万或账期&gt;60 天加法务</span>
    </div>

    <div class="listwrap"><div class="tablewrap">
      <table class="grid">
        <thead><tr>
          <th>合同号</th><th style="min-width:220px">客户 / 标题</th><th>类型</th>
          <th class="num">合同额</th><th class="num">账期</th>
          <th class="num">已开票</th><th class="num">已回款</th>
          <th>状态</th><th>负责人</th>
        </tr></thead>
        <tbody>
          ${data.rows.length ? data.rows.map((c) => `<tr data-id="${c.id}">
            <td class="mono">${esc(c.no)}</td>
            <td><div class="cell-main">${esc(c.account_name)}</div><div class="cell-sub">${esc(c.title)}</div></td>
            <td>${badge(KIND_LABEL[c.kind || 'order'], c.kind === 'terms' ? 'violet' : 'blue')}</td>
            <td class="num">${amount(c.amount)}</td>
            <td class="num">${c.payment_terms} 天</td>
            <td class="num">${c.invoiced ? amount(c.invoiced) : '—'}</td>
            <td class="num" style="color:${c.received > 0 ? 'var(--green)' : 'var(--ink-3)'}">${c.received ? amount(c.received) : '—'}</td>
            <td>${badge(labels.contractStatus[c.status] || c.status, statusTone(c.status))}</td>
            <td class="nowrap">${esc(c.owner_name || '—')}</td>
          </tr>`).join('') : `<tr><td colspan="9"><div class="empty">
            <strong>暂无合同</strong><span>报价通过后，在上方「待创建合同」里直接生成</span></div></td></tr>`}
        </tbody>
      </table>
    </div></div>
  </div>`;

  const go = (patch) => {
    const next = { ...q, ...patch };
    const p = new URLSearchParams();
    Object.entries(next).forEach(([k, v]) => { if (v) p.set(k, v); });
    location.hash = `#/contracts${p.toString() ? '?' + p.toString() : ''}`;
  };
  el.querySelector('#q').onkeydown = (e) => { if (e.key === 'Enter') go({ q: e.target.value.trim() }); };
  el.querySelector('#fStatus').onchange = (e) => go({ status: e.target.value });
  el.querySelector('[data-refresh]').onclick = () => ctx.refresh();
  el.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.onclick = () => openContract(Number(tr.dataset.id), ctx);
  });
  el.querySelectorAll('[data-create]').forEach((b) => {
    b.onclick = async (ev) => {
      ev.stopPropagation();
      b.disabled = true;
      try {
        const quote = await api.get(`/api/quotations/${b.dataset.create}`);
        openContractCreate(quote, ctx);
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        b.disabled = false;
      }
    };
  });
  if (route.id) openContract(Number(route.id), ctx);
}

export async function openContract(id, ctx) {
  const c = await api.get(`/api/contracts/${id}`);
  const tw = c.threeWay;
  const canSubmit = ['draft', 'rejected'].includes(c.status);
  const canInvoice = c.status === 'active' && can('contract');
  const isTerms = c.kind === 'terms';
  const canEditDoc = canSubmit && can('contract');

  const rate = Number(c.tax_rate || 0);
  const included = c.tax_mode !== 'excluded';
  const rows = (c.items || []).map((it) => {
    const price = Number(it.price ?? it.unit_price ?? 0);
    const qty = Number(it.qty || 0);
    const gross = price * qty;
    const net = included ? gross / (1 + rate) : gross;
    return { ...it, price, qty, net, tax: gross - net, gross };
  });
  const netSum = rows.reduce((s, r) => s + r.net, 0);
  const taxSum = rows.reduce((s, r) => s + r.tax, 0);

  const html = `
    <div class="drawer-head">
      <div style="flex:1;min-width:0">
        <h2>${esc(c.title)}</h2>
        <div class="sub">${badge(labels.contractStatus[c.status] || c.status, statusTone(c.status))}
          ${badge(KIND_LABEL[c.kind || 'order'], isTerms ? 'violet' : 'blue')}
          <span style="margin-left:6px">${esc(c.no)} · ${esc(c.account_name)}</span></div>
      </div>
      <button class="icon-btn close" data-close>${icon('close', 14)}</button>
    </div>
    <div class="drawer-body">
      <div class="section">
        <div class="section-title">三单匹配<span class="line"></span>
          ${tw.matched ? badge('已对齐', 'green') : (tw.received === 0 && tw.invoiced === 0 ? badge('待开票', 'gray') : badge('存在差异', 'amber'))}</div>
        <div class="threeway">
          <div class="tw-cell"><div class="k">合同额</div><div class="v">${money(tw.contract)}</div><div class="s">含税</div></div>
          <div class="tw-cell"><div class="k">已开票</div><div class="v">${money(tw.invoiced)}</div><div class="s">待开 ${money(tw.applied)}</div></div>
          <div class="tw-cell"><div class="k">已回款</div><div class="v" style="color:var(--green)">${money(tw.received)}</div><div class="s">应收 ${money(tw.receivable)}</div></div>
        </div>
        ${tw.unInvoiced > 0 ? `<div class="notice" style="margin-top:9px">${icon('info', 14)}
          <div>尚有 ${money(tw.unInvoiced)} 未开票，可在下方发起开票申请。</div></div>` : ''}
      </div>

      <div class="section">
        <div class="section-title">合同信息<span class="line"></span></div>
        <div class="fields">
          <div class="fld"><div class="k">合同金额</div><div class="v money">¥ ${fmt(c.amount)}</div></div>
          <div class="fld"><div class="k">结算方式</div><div class="v">${included ? '含税价' : '不含税价'} · ${(rate * 100).toFixed(0)}%</div></div>
          <div class="fld"><div class="k">账期</div><div class="v">${c.payment_terms} 天</div></div>
          <div class="fld"><div class="k">签订日期</div><div class="v">${date(c.sign_date)}</div></div>
          <div class="fld"><div class="k">生效日期</div><div class="v">${date(c.activated_at || c.start_date)}</div></div>
          <div class="fld"><div class="k">到期日期</div><div class="v">${date(c.end_date)}</div></div>
          <div class="fld"><div class="k">关联商机</div><div class="v">${esc(c.opportunity_name || '—')}</div></div>
          <div class="fld"><div class="k">关联报价</div><div class="v mono">${esc(c.quote_no || '—')}</div></div>
          ${isTerms ? `<div class="fld"><div class="k">条款模板</div><div class="v">${esc(c.template?.name || '自定义条款')}</div></div>
          <div class="fld"><div class="k">条款数</div><div class="v">${(c.clauses || []).length} 条</div></div>` : ''}
        </div>
      </div>

      ${isTerms ? `<div class="section">
        <div class="section-title">合同条款<span class="line"></span>
          ${canEditDoc ? `<button class="btn btn-sm" data-edit-clauses>${icon('drag', 12)} 编辑条款</button>` : ''}</div>
        <div class="stack" style="gap:8px">
          ${(c.clauses || []).length ? c.clauses.map((cl, i) => `<div style="border:1px solid var(--line-soft);border-radius:8px;padding:9px 11px;background:var(--bg-sub)">
            <div style="font-size:12.5px;font-weight:600;margin-bottom:3px">${esc(cl.title || `第 ${i + 1} 条`)}</div>
            <div style="font-size:12px;color:var(--ink-2);line-height:1.8">${esc(cl.body)}</div>
          </div>`).join('') : '<div class="muted" style="font-size:12.5px">暂无条款</div>'}
        </div>
      </div>` : `<div class="section">
        <div class="section-title">合同明细<span class="line"></span>
          <span class="muted" style="font-size:11.5px">${included ? '单价为含税价' : '单价为不含税价'}</span></div>
        <div class="q-tablewrap"><table class="q-table mini">
          <thead><tr><th>产品 / 服务</th><th class="num">数量</th><th class="num">单价</th>
            <th class="num">金额</th><th class="num">税额</th></tr></thead>
          <tbody>${rows.length ? rows.map((r) => `<tr>
            <td><div class="qn">${esc(r.name)}</div><div class="qs2">${esc(r.spec || '')}</div></td>
            <td class="num">${r.qty} ${esc(r.unit || '')}</td>
            <td class="num">${fmt(r.price)}</td>
            <td class="num">${fmt(r.net)}</td>
            <td class="num muted">${fmt(r.tax)}</td>
          </tr>`).join('') : '<tr><td colspan="5" class="muted">无产品明细</td></tr>'}</tbody>
          <tfoot><tr><td>合计</td><td class="num">—</td><td class="num">—</td>
            <td class="num">${fmt(netSum)}</td><td class="num">${fmt(taxSum)}</td></tr></tfoot>
        </table></div>
        <div class="fields" style="margin-top:10px">
          <div class="fld"><div class="k">购买方</div><div class="v">${esc(c.buyer?.name || c.account_name)}</div></div>
          <div class="fld"><div class="k">纳税人识别号</div><div class="v mono">${esc(c.buyer?.taxNo || '—')}</div></div>
          <div class="fld"><div class="k">销售方</div><div class="v">${esc(c.seller?.name || '—')}</div></div>
          <div class="fld"><div class="k">销售方税号</div><div class="v mono">${esc(c.seller?.taxNo || '—')}</div></div>
        </div>
      </div>`}

      <div class="section">
        <div class="section-title">合同单据<span class="line"></span></div>
        <div class="notice blue">${icon('file', 14)}
          <div>${isTerms ? '条款合同' : '订单合同（发票式）'}单据已生成，可打印或另存为 PDF 后寄送客户签署。</div></div>
        <div style="display:flex;gap:8px;margin-top:9px">
          <button class="btn" data-doc>${icon('file', 13)} 查看 / 打印单据</button>
          ${c.quote_no ? `<button class="btn" data-quote-doc>${icon('quote', 13)} 查看报价单</button>` : ''}
        </div>
      </div>

      <div class="section">
        <div class="section-title">审批流转<span class="line"></span></div>
        ${approvalTimeline(c.approval)}
      </div>

      <div class="section">
        <div class="section-title">回款计划<span class="line"></span></div>
        ${c.plans.length ? `<table class="grid" style="border:1px solid var(--line-soft);border-radius:6px;overflow:hidden">
          <thead><tr><th>期次</th><th>到期日</th><th class="num">金额</th><th>状态</th></tr></thead>
          <tbody>${c.plans.map((p) => {
            const overdue = p.status === 'pending' && p.due_date < new Date().toISOString().slice(0, 10);
            return `<tr style="cursor:default">
              <td>第 ${p.seq} 期</td>
              <td style="${overdue ? 'color:var(--red)' : ''}">${date(p.due_date)}${overdue ? ' · 逾期' : ''}</td>
              <td class="num">${amount(p.amount)}</td>
              <td>${badge(p.status === 'received' ? '已回款' : overdue ? '逾期' : '待回款', p.status === 'received' ? 'green' : overdue ? 'red' : 'gray')}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>` : '<div class="muted" style="font-size:12.5px">合同生效后自动生成回款计划</div>'}
      </div>

      <div class="section">
        <div class="section-title">发票<span class="line"></span></div>
        ${c.invoices.length ? `<div class="rel-list">
          ${c.invoices.map((i) => `<div class="rel" style="cursor:default">
            <div style="flex:1;min-width:0"><div class="nm mono">${esc(i.no || '待开票')}</div>
              <div class="mt">${i.type === 'special' ? '专用发票' : '普通发票'} · 申请于 ${date(i.applied_at)}</div></div>
            <div class="am">${money(i.amount)}</div>
            ${badge(labels.invoiceStatus[i.status] || i.status, statusTone(i.status))}
          </div>`).join('')}
        </div>` : '<div class="muted" style="font-size:12.5px">暂未开票</div>'}
      </div>

      <div class="section">
        <div class="section-title">回款记录<span class="line"></span></div>
        ${c.payments.length ? `<div class="rel-list">
          ${c.payments.map((p) => `<div class="rel" style="cursor:default">
            <div style="flex:1;min-width:0"><div class="nm mono">${esc(p.no)}</div>
              <div class="mt">${date(p.received_at)} · ${esc(p.bank_ref || '')}</div></div>
            <div class="am" style="color:var(--green)">+${money(p.amount)}</div>
          </div>`).join('')}
        </div>` : '<div class="muted" style="font-size:12.5px">暂无回款</div>'}
      </div>
    </div>
    <div class="drawer-foot">
      ${canSubmit ? `<button class="btn btn-primary" data-submit>提交合同审批</button>` : ''}
      ${canInvoice ? `<button class="btn" data-invoice>申请开票</button>` : ''}
      <div class="spacer"></div>
      <button class="btn" data-close2>关闭</button>
    </div>`;

  const close = openDrawer(html, {
    onMount(root, close) {
      root.querySelector('[data-close]').onclick = close;
      root.querySelector('[data-close2]').onclick = close;
      const sb = root.querySelector('[data-submit]');
      if (sb) sb.onclick = () => openSubmitApproval({
        type: 'contract',
        id: c.id,
        submitUrl: `/api/contracts/${c.id}/submit`,
        intro: `合同 ${esc(c.no)} · 合同额 ¥${amount(c.amount)} · 账期 ${c.payment_terms} 天。提交后按下列顺序审批。`,
        confirmText: '提交合同审批',
        onSubmitted: () => { close(); ctx.refresh(); },
      });
      const iv = root.querySelector('[data-invoice]');
      if (iv) iv.onclick = () => applyInvoice(c, close, ctx);
      const doc = root.querySelector('[data-doc]');
      if (doc) doc.onclick = () => window.open(`/api/contracts/${c.id}/document`, '_blank');
      const ec = root.querySelector('[data-edit-clauses]');
      if (ec) ec.onclick = () => editClauses(c, close, ctx);
      const qd = root.querySelector('[data-quote-doc]');
      if (qd) qd.onclick = async () => {
        try {
          const s = await api.get(`/api/quotations/${c.quotation_id}/sheet`);
          window.open(s.url, '_blank');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

/** 条款编辑：增删改后直接保存到合同 */
function editClauses(c, closeDrawer, ctx) {
  const rows = c.clauses && c.clauses.length ? c.clauses : [{ title: '', body: '' }];
  modal({
    title: '编辑合同条款',
    width: 760,
    body: `<div class="stack">
      <div class="notice blue">${icon('info', 14)}<div>条款修改只影响本合同；合同已提交审批后不能再改，需要走变更流程。</div></div>
      <div class="clause-list" data-clauses>
        ${rows.map((cl) => `<div class="clause-row" data-clause>
          <div class="clause-head">
            <input class="input clause-title" value="${esc(cl.title || '')}" placeholder="条款标题" />
            <button class="icon-btn" data-del title="删除该条">${icon('trash', 13)}</button>
          </div>
          <textarea class="textarea clause-body" rows="2" placeholder="条款内容">${esc(cl.body || '')}</textarea>
        </div>`).join('')}
      </div>
      <div><button class="btn btn-sm" data-add>${icon('plus', 11)} 添加条款</button></div>
    </div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>保存条款</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      const bind = () => root.querySelectorAll('[data-del]').forEach((b) => {
        b.onclick = () => b.closest('[data-clause]').remove();
      });
      bind();
      root.querySelector('[data-add]').onclick = () => {
        root.querySelector('[data-clauses]').insertAdjacentHTML('beforeend', `<div class="clause-row" data-clause>
          <div class="clause-head">
            <input class="input clause-title" value="" placeholder="条款标题" />
            <button class="icon-btn" data-del title="删除该条">${icon('trash', 13)}</button>
          </div>
          <textarea class="textarea clause-body" rows="2" placeholder="条款内容"></textarea>
        </div>`);
        bind();
      };
      root.querySelector('[data-ok]').onclick = async () => {
        const clauses = [...root.querySelectorAll('[data-clause]')].map((row) => ({
          title: row.querySelector('.clause-title').value.trim(),
          body: row.querySelector('.clause-body').value.trim(),
        })).filter((x) => x.title || x.body);
        try {
          await api.patch(`/api/contracts/${c.id}`, { clauses });
          toast('条款已保存', 'ok');
          close();
          closeDrawer();
          ctx.refresh();
          setTimeout(() => openContract(c.id, ctx), 150);
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

function applyInvoice(c, closeDrawer, ctx) {
  const remain = c.threeWay.contract - c.threeWay.invoiced - c.threeWay.applied;
  modal({
    title: '申请开票',
    width: 440,
    body: `<div class="stack">
      <div class="notice blue">${icon('info', 14)}<div>本合同剩余可开票额度：<b>${money(remain)}</b></div></div>
      ${field('开票金额（元）', 'amount', { type: 'number', value: Math.max(0, remain), required: true, min: 0, step: 100 })}
      ${field('发票类型', 'type', { options: [{ value: 'special', label: '增值税专用发票' }, { value: 'normal', label: '增值税普通发票' }] })}
      ${field('备注', 'remark')}
    </div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>提交申请</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      root.querySelector('[data-ok]').onclick = async () => {
        const d = formData(root);
        try {
          await api.post('/api/finance/invoices', { contract_id: c.id, ...d });
          toast('开票申请已提交', 'ok'); close(); closeDrawer(); ctx.refresh();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

export const __x = { confirmBox, relTime };
