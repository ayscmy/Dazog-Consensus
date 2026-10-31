import { api } from '../api.js';
import { state, labels, can } from '../store.js';
import { icon } from '../icons.js';
import { openQuoteEditor } from '../quote-editor.js';
import { openSubmitApproval } from '../approval-flow.js';
import { openContractCreate } from '../contract-create.js';
import {
  esc, money, amount, date, relTime, badge, statusTone, toast, modal, field, formData,
  openDrawer, approvalTimeline, blockList,
} from '../ui.js';

const fmt = (n) => Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function render(el, route, ctx) {
  const q = route.query;
  const params = new URLSearchParams();
  if (q.q) params.set('q', q.q);
  if (q.status) params.set('status', q.status);
  const data = await api.get(`/api/quotations?${params.toString()}`);
  const sensitive = ['admin', 'gm', 'director', 'manager', 'finance'].includes(state.user.role);

  el.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1>报价</h1>
        <div class="desc">未折扣（折扣率 0）的报价免价格审批，提交即通过并直接进入合同流程；有折扣才按档位走价格审批</div>
      </div>
      <div class="actions">
        <button class="btn" data-refresh>${icon('search', 13)} 刷新</button>
        ${can('quotation') ? `<button class="btn btn-primary" data-new>${icon('plus', 12)} 新建报价</button>` : ''}
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="lb">报价总数</div><div class="vl">${data.stats.total}</div><div class="sb">全部版本</div></div>
      <div class="kpi"><div class="lb">审批中</div><div class="vl">${data.stats.pending}</div><div class="sb">等待价格审批</div></div>
      <div class="kpi"><div class="lb">已批准</div><div class="vl">${data.stats.approved}</div><div class="sb">含零折扣免审批</div></div>
      <div class="kpi"><div class="lb">已批准金额</div><div class="vl">${money(data.stats.amount)}</div><div class="sb">含税合计</div></div>
    </div>

    <div class="toolbar">
      <input class="input" id="q" placeholder="搜索报价号 / 商机 / 客户" value="${esc(q.q || '')}" style="width:240px" />
      <select class="select" id="fStatus">
        <option value="">全部状态</option>
        ${(state.dict.quoteStatus || []).map((s) => `<option value="${s.key}" ${q.status === s.key ? 'selected' : ''}>${s.label}</option>`).join('')}
      </select>
      <div class="grow"></div>
      <span class="muted" style="font-size:12px">价格审批档位：0% 免审批 / ≤5% 经理 / 5~10% 加总监 / &gt;10% 加总经理</span>
    </div>

    <div class="listwrap"><div class="tablewrap">
      <table class="grid">
        <thead><tr>
          <th>报价号</th><th style="min-width:220px">商机 / 客户</th>
          <th class="num">报价金额</th><th class="num">折扣</th>
          ${sensitive ? '<th class="num">毛利</th>' : ''}
          <th>状态</th><th>创建人</th><th>有效期</th>
        </tr></thead>
        <tbody>
          ${data.rows.length ? data.rows.map((r) => `<tr data-id="${r.id}">
            <td class="mono">${esc(r.no)}<div class="cell-sub">v${r.version}</div></td>
            <td><div class="cell-main">${esc(r.opportunity_name)}</div><div class="cell-sub">${esc(r.account_name)}</div></td>
            <td class="num">${amount(r.amount)}</td>
            <td class="num" style="${r.discount_rate > 0.1 ? 'color:var(--red)' : r.discount_rate > 0.05 ? 'color:var(--amber)' : ''}">${(r.discount_rate * 100).toFixed(2)}%</td>
            ${sensitive ? `<td class="num">${r.gross_margin !== null && r.gross_margin !== undefined ? (r.gross_margin * 100).toFixed(1) + '%' : '—'}</td>` : ''}
            <td>${badge(labels.quoteStatus[r.status] || r.status, statusTone(r.status))}</td>
            <td class="nowrap">${esc(r.creator_name || '—')}</td>
            <td class="nowrap muted">${date(r.valid_until)}</td>
          </tr>`).join('') : `<tr><td colspan="8"><div class="empty">
            <strong>暂无报价单</strong><span>在商机详情里创建报价</span></div></td></tr>`}
        </tbody>
      </table>
    </div></div>
  </div>`;

  const go = (patch) => {
    const next = { ...q, ...patch };
    const p = new URLSearchParams();
    Object.entries(next).forEach(([k, v]) => { if (v) p.set(k, v); });
    location.hash = `#/quotations${p.toString() ? '?' + p.toString() : ''}`;
  };
  el.querySelector('#q').onkeydown = (e) => { if (e.key === 'Enter') go({ q: e.target.value.trim() }); };
  el.querySelector('#fStatus').onchange = (e) => go({ status: e.target.value });
  el.querySelector('[data-refresh]').onclick = () => ctx.refresh();
  const nb = el.querySelector('[data-new]');
  if (nb) nb.onclick = () => newQuoteFromList(ctx);
  el.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.onclick = () => openQuote(Number(tr.dataset.id), ctx);
  });
  if (route.id) openQuote(Number(route.id), ctx);
}

export async function openQuote(id, ctx) {
  const q = await api.get(`/api/quotations/${id}`);
  const sensitive = ['admin', 'gm', 'director', 'manager', 'finance'].includes(state.user.role);

  const html = `
    <div class="drawer-head">
      <div style="flex:1;min-width:0">
        <h2>${esc(q.no)}</h2>
        <div class="sub">${badge(labels.quoteStatus[q.status] || q.status, statusTone(q.status))}
          <span style="margin-left:6px">${esc(q.opportunity_name)} · ${esc(q.account_name)}</span></div>
      </div>
      <button class="icon-btn close" data-close>${icon('close', 14)}</button>
    </div>
    <div class="drawer-body">
      <div class="section">
        <div class="section-title">报价明细<span class="line"></span>
          ${q.has_custom ? '<span class="badge badge-amber">含例外项</span>' : ''}</div>
        ${q.items && q.items.length ? `<div class="qitems">
          <table class="q-table mini">
            <thead><tr>
              <th>产品 / 项目</th><th class="num">数量</th><th class="num">标准价</th>
              <th class="num">成交单价</th><th class="num">金额</th>
              ${sensitive ? '<th class="num">成本</th>' : ''}
            </tr></thead>
            <tbody>
              ${q.items.map((it) => `<tr>
                <td><div class="qn">${esc(it.name)}${it.is_custom ? ' <span class="badge badge-amber">例外</span>' : ''}</div>
                  <div class="qs2">${esc(it.spec || '')}</div></td>
                <td class="num">${it.qty} ${esc(it.unit || '')}</td>
                <td class="num muted">${amount(it.list_price)}</td>
                <td class="num">${amount(it.unit_price)}</td>
                <td class="num money">${amount(it.amount)}</td>
                ${sensitive ? `<td class="num muted">${amount(it.cost)}</td>` : ''}
              </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<div class="muted" style="font-size:12.5px;margin-bottom:10px">该报价为旧版单据，无产品明细</div>'}
        <div class="fields" style="margin-top:12px">
          <div class="fld"><div class="k">标准价合计</div><div class="v money">¥ ${amount(q.list_amount)}</div></div>
          <div class="fld"><div class="k">成交合计</div><div class="v money">¥ ${amount(q.amount)}</div></div>
          <div class="fld"><div class="k">折扣率</div><div class="v">${(q.discount_rate * 100).toFixed(2)}%</div></div>
          <div class="fld"><div class="k">有效期至</div><div class="v">${date(q.valid_until)}</div></div>
          ${sensitive ? `<div class="fld"><div class="k">成本</div><div class="v money">¥ ${amount(q.cost)}</div></div>
          <div class="fld"><div class="k">毛利率</div><div class="v">${q.gross_margin !== null ? (q.gross_margin * 100).toFixed(1) + '%' : '—'}</div></div>` : ''}
          <div class="fld full"><div class="k">备注</div><div class="v">${esc(q.remark || '—')}</div></div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">价格审批<span class="line"></span></div>
        ${q.approval
          ? approvalTimeline(q.approval)
          : q.status === 'approved'
            ? `<div class="notice blue">${icon('check', 14)}
                <div>价格免审批（未折扣报价提交即通过）。可直接「创建合同」（订单合同 / 条款合同），价格不再重复审批，只走合同审批流程。</div></div>`
            : `<div class="notice blue">${icon('info', 14)}
                <div>${q.discount_rate > 0.000001
                  ? `本单折扣 ${(q.discount_rate * 100).toFixed(2)}%，提交后按档位进入价格审批（≤5% 经理 / 5~10% 加总监 / &gt;10% 加总经理）。`
                  : '只有发生让价才需价格审批。本单折扣率为 0，提交即通过并直接进入合同流程。'}</div></div>`}
      </div>

      <div class="section">
        <div class="section-title">报价单<span class="line"></span>
          ${['approved', 'converted'].includes(q.status)
            ? '<span class="badge badge-green">可发送给客户</span>'
            : '<span class="badge badge-gray">审批通过后可发送</span>'}</div>
        ${['approved', 'converted'].includes(q.status) ? `
        <div class="send-link">
          <input class="input" readonly data-sheet-url placeholder="正在生成客户链接…" />
          <button class="btn btn-sm" data-copy>复制</button>
          <button class="btn btn-sm" data-open-sheet>预览</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:9px;align-items:center">
          <button class="btn btn-primary btn-sm" data-send>${icon('bell', 12)} 发送给客户</button>
          <span class="muted" style="font-size:11.5px" data-send-stat></span>
        </div>
        <div class="send-log" data-sends style="margin-top:10px"></div>`
        : `<div class="notice blue">${icon('info', 14)}
            <div>报价通过价格审批后自动生成客户专属报价单与免登录链接，可直接发送邮件 / 短信给客户。</div></div>`}
      </div>

      ${q.remark ? '' : ''}
    </div>
    <div class="drawer-foot">
      ${q.status === 'draft' ? `<button class="btn btn-primary" data-submit>${q.discount_rate > 0.000001 ? '提交价格审批' : '确认提交（免审批）'}</button>` : ''}
      ${q.status === 'approved' ? `<button class="btn btn-primary" data-to-contract>${icon('contract', 13)} 创建合同</button>` : ''}
      ${q.contract ? `<button class="btn" data-open-contract>${icon('contract', 13)} 合同 ${esc(q.contract.no)}</button>` : ''}
      <div class="spacer"></div>
      <button class="btn" data-close2>关闭</button>
    </div>`;

  const close = openDrawer(html, {
    onMount(root, close) {
      root.querySelector('[data-close]').onclick = close;
      root.querySelector('[data-close2]').onclick = close;
      const createContract = (quote) => openContractCreate(quote, ctx, {
        onDone: (r) => {
          close();
          ctx.refresh();
          setTimeout(() => { location.hash = `#/contracts/${r.id}`; }, 120);
        },
      });
      const sb = root.querySelector('[data-submit]');
      if (sb) sb.onclick = () => openSubmitApproval({
        type: 'quote',
        id: q.id,
        submitUrl: `/api/quotations/${q.id}/submit`,
        intro: `报价 ${esc(q.no)}：折扣 ${(q.discount_rate * 100).toFixed(2)}%，成交 ¥${amount(q.amount)}。提交后按下列顺序审批。`,
        confirmText: '提交价格审批',
        onSubmitted: async (r) => {
          if (r && r.skipped) {
            // 免审批：直接进入创建合同（先选订单合同 / 条款合同）
            const fresh = await api.get(`/api/quotations/${q.id}`);
            close();
            ctx.refresh();
            setTimeout(() => createContract(fresh), 220);
          } else {
            close();
            ctx.refresh();
          }
        },
      });
      const tc = root.querySelector('[data-to-contract]');
      if (tc) tc.onclick = () => createContract(q);

      const oc = root.querySelector('[data-open-contract]');
      if (oc) oc.onclick = () => {
        close();
        location.hash = `#/contracts/${q.contract.id}`;
      };

      initSheetSection(root, q, close, ctx);
    },
  });
}

/** 报价单区块：客户链接、预览、发送记录 */
async function initSheetSection(root, q, closeDrawer, ctx) {
  const urlInput = root.querySelector('[data-sheet-url]');
  const sendBtn = root.querySelector('[data-send]');
  const stat = root.querySelector('[data-send-stat]');
  const sendsBox = root.querySelector('[data-sends]');
  if (!urlInput) return;

  let sheet = null;
  const paint = (s) => {
    sheet = s;
    urlInput.value = s.url;
    if (stat) stat.textContent = s.sends?.length ? `最近发送 ${relTime(s.sends[0].created_at)}` : '尚未发送';
    if (sendsBox) {
      sendsBox.innerHTML = (s.sends || []).slice(0, 5).map((x) => `<div class="send-item">
        ${badge(x.channel === 'email' ? '邮件' : '短信', x.channel === 'email' ? 'blue' : 'violet')}
        <span class="tgt">${esc(x.target)}</span>
        ${badge(x.status === 'sent' ? '已发送' : x.status === 'simulated' ? '模拟发送' : '失败', x.status === 'sent' ? 'green' : x.status === 'simulated' ? 'amber' : 'red')}
        <span class="muted" style="font-size:11px">${relTime(x.created_at)}</span>
        ${x.error ? `<span class="muted" style="font-size:11px;flex:1;text-align:right" title="${esc(x.error)}">${esc(x.error.slice(0, 26))}</span>` : ''}
      </div>`).join('');
    }
  };

  try { paint(await api.get(`/api/quotations/${q.id}/sheet`)); } catch (e) {
    urlInput.placeholder = '生成失败：' + e.message;
  }

  root.querySelector('[data-copy]').onclick = async () => {
    if (!urlInput.value) return;
    try {
      await navigator.clipboard.writeText(urlInput.value);
      toast('客户链接已复制', 'ok');
    } catch {
      urlInput.select();
      document.execCommand('copy');
      toast('客户链接已复制', 'ok');
    }
  };
  root.querySelector('[data-open-sheet]').onclick = () => {
    if (urlInput.value) window.open(urlInput.value, '_blank');
  };
  if (sendBtn) {
    sendBtn.onclick = () => {
      if (!sheet) return toast('报价单还没生成好，请稍候', 'err');
      openSendQuote({ q, sheet, closeDrawer, ctx, after: async () => {
        try { paint(await api.get(`/api/quotations/${q.id}/sheet`)); } catch { /* ignore */ }
      } });
      return undefined;
    };
  }
}

/** 发送报价单：邮件 + 短信 */
function openSendQuote({ q, sheet, closeDrawer, ctx, after }) {
  const ready = sheet.ready || {};
  const contact = sheet.contact || {};
  const notReady = [];
  if (!ready.email) notReady.push('邮件服务器未配置（记录为模拟发送，可复制链接自行发送）');
  if (!ready.sms) notReady.push('短信网关未配置（记录为模拟发送，可复制链接自行发送）');

  modal({
    title: '发送报价单',
    width: 560,
    body: `<div class="stack">
      <div class="notice blue">${icon('info', 14)}
        <div>报价单 <b>${esc(q.no)}</b> · 客户 <b>${esc(q.account_name)}</b> · 合计 ¥${fmt(q.amount)}。
        客户通过专属链接在线查看，无需登录。</div></div>

      <div class="send-ch">
        <label><input type="checkbox" data-ch="email" ${contact.email ? 'checked' : 'checked'} /> ${icon('file', 13)} 发送邮件</label>
        <label><input type="checkbox" data-ch="sms" ${contact.phone ? 'checked' : ''} /> ${icon('bell', 13)} 发送短信</label>
      </div>

      <div class="formgrid">
        ${field('收件邮箱', 'email', { value: contact.email || '', placeholder: 'buyer@example.com' })}
        ${field('接收手机号', 'phone', { value: contact.phone || '', placeholder: '13800138000' })}
      </div>
      ${field('附言（可选）', 'message', { type: 'textarea', value: `您好，这是根据前期沟通整理的报价单，请查收。如有疑问随时联系。`, hint: '会出现在邮件正文与短信之后' })}

      ${notReady.length ? `<div class="notice" style="background:var(--amber-soft,#fff8e6);border-color:#f0dfae;color:#8a6416">
        ${icon('warn', 14)}<div>${notReady.map(esc).join('<br/>')}</div></div>` : ''}
    </div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>立即发送</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      root.querySelector('[data-ok]').onclick = async () => {
        const d = formData(root);
        const channels = [...root.querySelectorAll('[data-ch]')].filter((x) => x.checked).map((x) => x.dataset.ch);
        if (!channels.length) return toast('请至少选择一种发送方式', 'err');
        if (channels.includes('email') && !d.email) return toast('请填写收件邮箱', 'err');
        if (channels.includes('sms') && !d.phone) return toast('请填写手机号', 'err');
        const btn = root.querySelector('[data-ok]');
        btn.disabled = true;
        try {
          const r = await api.post(`/api/quotations/${q.id}/send`, {
            channels, email: d.email, phone: d.phone, message: d.message,
          });
          close();
          showSendResult(r, q);
          if (after) await after();
          ctx.refresh();
        } catch (e) {
          btn.disabled = false;
          toast(e.message, 'err');
        }
        return undefined;
      };
    },
  });
}

function showSendResult(r, q) {
  const rows = (r.results || []).map((x) => `<div class="send-item">
    ${badge(x.channel === 'email' ? '邮件' : '短信', x.channel === 'email' ? 'blue' : 'violet')}
    <span class="tgt">${esc(x.target)}</span>
    ${badge(x.status === 'sent' ? '已发送' : x.status === 'simulated' ? '模拟发送' : '失败', x.status === 'sent' ? 'green' : x.status === 'simulated' ? 'amber' : 'red')}
    ${x.error ? `<span class="muted" style="font-size:11px;flex:1;text-align:right">${esc(x.error)}</span>` : ''}
  </div>`).join('');

  modal({
    title: '发送结果',
    width: 520,
    body: `<div class="stack">
      <div class="send-log">${rows}</div>
      <div class="notice blue">${icon('info', 14)}
        <div>客户可通过下方链接在线查看报价单（免登录）：</div></div>
      <div class="send-link">
        <input class="input" readonly value="${esc(r.url || '')}" data-res-url />
        <button class="btn btn-sm" data-copy2>复制</button>
        <button class="btn btn-sm" data-open2>打开</button>
      </div>
      ${(r.results || []).some((x) => x.status === 'simulated')
        ? `<div class="muted" style="font-size:11.5px">「模拟发送」表示尚未配置邮件服务器 / 短信网关，系统已生成链接并留痕，可复制链接通过微信、邮件客户端发给客户；管理员可在「系统设置」里配置 SMTP 与短信网关后自动真发。</div>`
        : ''}
    </div>`,
    footer: `<button class="btn" data-c>关闭</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      const inp = root.querySelector('[data-res-url]');
      root.querySelector('[data-copy2]').onclick = async () => {
        inp.select();
        try { await navigator.clipboard.writeText(inp.value); } catch { document.execCommand('copy'); }
        toast('链接已复制', 'ok');
      };
      root.querySelector('[data-open2]').onclick = () => window.open(inp.value, '_blank');
    },
  });
  void q;
}

/** 从报价列表直接新建：先选商机，自动带出金额 */
async function newQuoteFromList(ctx) {
  let rows = [];
  try {
    const d = await api.get('/api/opportunities');
    rows = (d.rows || []).filter((o) => !['won', 'lost'].includes(o.stage));
  } catch (e) {
    return toast(e.message, 'err');
  }
  if (!rows.length) return toast('没有可报价的商机，请先创建商机', 'err');

  modal({
    title: '新建报价',
    width: 560,
    body: `<div class="notice blue" style="margin-bottom:14px">${icon('info', 14)}
      <div>报价金额由产品明细自动汇总，标准价取自产品库；如需特殊方案请联系管理员开启例外报价。</div></div>
      <div class="stack">
        ${field('选择关联商机', 'opportunity_id', {
          required: true,
          options: rows.map((o) => ({ value: o.id, label: `${o.name} · ${o.account_name} · ${amount(o.amount)}` })),
        })}
      </div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>下一步：选择产品</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      root.querySelector('[data-ok]').onclick = () => {
        const sel = root.querySelector('[name="opportunity_id"]');
        const opp = rows.find((x) => String(x.id) === String(sel.value));
        if (!opp) return toast('请选择商机', 'err');
        close();
        openQuoteEditor({ opp, ctx });
        return undefined;
      };
    },
  });
}
