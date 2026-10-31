import { api } from './api.js';
import { icon } from './icons.js';
import { esc, money, amount, toast, modal, field, formData } from './ui.js';

/* =========================================================
   创建合同：先选类型，再填单据
   - 订单合同：发票式单据（买卖双方 + 明细 + 含税/不含税 + 价税合计）
   - 条款合同：套用条款模板，自动填充甲乙方，条款可改可加
   价格来自已批准的报价，创建时不允许改价
   ========================================================= */

const fmt = (n) => Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function openContractCreate(quotation, ctx, { onDone } = {}) {
  let templates = [];
  let acct = null;
  try {
    const [t, a] = await Promise.all([
      api.get('/api/contracts/templates').catch(() => ({ rows: [] })),
      api.get(`/api/accounts/${quotation.account_id}`).catch(() => null),
    ]);
    templates = t.rows || [];
    acct = a;
  } catch { /* 模板拿不到时仍可创建订单合同 */ }

  const contact = (acct?.contacts || []).find((c) => c.is_primary) || (acct?.contacts || [])[0] || {};
  const buyer = {
    name: quotation.account_name,
    taxNo: '',
    address: acct?.address || '',
    phone: acct?.phone || '',
    bank: '',
    account: '',
    contact: contact.name || '',
    contactPhone: contact.phone || '',
  };

  const finish = (r) => {
    toast(`${r.kind === 'terms' ? '条款合同' : '订单合同'} ${r.no} 已创建`, 'ok');
    if (onDone) onDone(r);
    else {
      ctx.refresh();
      setTimeout(() => { location.hash = `#/contracts/${r.id}`; }, 150);
    }
  };

  chooseType({ quotation, templates, acct, buyer, finish, ctx });
}

function chooseType({ quotation, templates, buyer, finish, ctx }) {
  const m = modal({
    title: '创建合同 · 选择合同类型',
    width: 720,
    body: `
      <div class="ct-types">
        <button class="ct-type" data-kind="order">
          <div class="ct-icon">${icon('contract', 20)}</div>
          <div class="ct-title">订单合同</div>
          <div class="ct-sub">发票式单据，买卖双方 + 明细 + 税价</div>
          <ul class="ct-list">
            <li>购买方 / 销售方抬头与税号、开户行</li>
            <li>产品明细、单价、金额、税率、税额</li>
            <li>含税 / 不含税切换，价税合计自动大写</li>
            <li>含折扣与账期，可直接打印或另存 PDF</li>
          </ul>
          <span class="ct-go">用订单合同 ${icon('arrow', 12)}</span>
        </button>
        <button class="ct-type" data-kind="terms">
          <div class="ct-icon">${icon('file', 20)}</div>
          <div class="ct-title">条款合同</div>
          <div class="ct-sub">套用合同模板，甲乙方自动填充</div>
          <ul class="ct-list">
            <li>选择合同模板（服务 / 采购 / 保密协议）</li>
            <li>自动填入甲方乙方、金额、账期、项目名</li>
            <li>条款可逐条修改、删除、追加</li>
            <li>自动生成合同编码（HT-年份-序号）</li>
          </ul>
          <span class="ct-go">用条款合同 ${icon('arrow', 12)}</span>
        </button>
      </div>
      <div class="notice blue" style="margin-top:14px">${icon('info', 14)}
        <div>来源报价 <b>${esc(quotation.no)}</b>：成交 ¥${fmt(quotation.amount)}（折扣 ${(Number(quotation.discount_rate || 0) * 100).toFixed(2)}%）。
        价格已通过审批并锁定，合同环节不再改价，只走合同审批。</div></div>`,
    footer: `<button class="btn" data-c>取消</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      root.querySelectorAll('[data-kind]').forEach((b) => {
        b.onclick = () => {
          const kind = b.dataset.kind;
          close();
          if (kind === 'order') orderForm({ quotation, buyer, finish, ctx });
          else termsForm({ quotation, buyer, finish, ctx });
        };
      });
    },
  });
  void m;
}

function buyerFields(buyer) {
  return `<div class="section-title" style="margin-top:2px">买方信息（客户）<span class="line"></span>
      <span class="muted" style="font-size:11.5px">合同甲方抬头，可按客户要求补全</span></div>
    <div class="formgrid">
      ${field('公司名称', 'buyer_name', { value: buyer.name, required: true })}
      ${field('纳税人识别号', 'buyer_tax_no', { value: buyer.taxNo, placeholder: '91310000XXXXXXXXXX' })}
      ${field('注册地址', 'buyer_address', { value: buyer.address })}
      ${field('联系电话', 'buyer_phone', { value: buyer.phone })}
      ${field('开户银行', 'buyer_bank', { value: buyer.bank })}
      ${field('银行账号', 'buyer_account', { value: buyer.account })}
      ${field('联系人', 'buyer_contact', { value: buyer.contact })}
      ${field('联系人电话', 'buyer_contact_phone', { value: buyer.contactPhone })}
    </div>`;
}

function readBuyer(root) {
  const d = formData(root);
  return {
    name: d.buyer_name,
    taxNo: d.buyer_tax_no,
    address: d.buyer_address,
    phone: d.buyer_phone,
    bank: d.buyer_bank,
    account: d.buyer_account,
    contact: d.buyer_contact,
    contactPhone: d.buyer_contact_phone,
  };
}

/* ---------------- 订单合同 ---------------- */
function orderForm({ quotation, buyer, finish, ctx }) {
  const items = quotation.items || [];
  const sum = items.reduce((s, it) => s + Number(it.amount || 0), 0);

  modal({
    title: '创建订单合同',
    width: 760,
    body: `<div class="stack">
      <div class="notice blue">${icon('info', 14)}
        <div>合同编号自动生成（DD-年份-序号）；价格与明细来自报价 ${esc(quotation.no)}，不可修改。</div></div>
      <div class="formgrid">
        ${field('合同标题', 'title', { value: `${quotation.opportunity_name} 销售合同`, required: true })}
        ${field('合同编号', 'no_preview', { value: '系统自动生成', hint: 'DD-' + new Date().getFullYear() + '-序号' })}
        ${field('结算方式', 'tax_mode', {
          value: 'included',
          options: [{ value: 'included', label: '含税价（价税合计 = 明细金额）' }, { value: 'excluded', label: '不含税价（另加税额）' }],
        })}
        ${field('税率', 'tax_rate', {
          value: '0.06',
          options: [{ value: '0.06', label: '6% 增值税' }, { value: '0.13', label: '13% 增值税' }, { value: '0.09', label: '9% 增值税' }, { value: '0.03', label: '3% 征收率' }, { value: '0', label: '不征税' }],
        })}
        ${field('账期（天）', 'payment_terms', { type: 'number', value: 30, min: 0, hint: '>30 天需总监，>60 天加法务' })}
        ${field('签订日期', 'sign_date', { type: 'date', value: new Date().toISOString().slice(0, 10) })}
      </div>

      ${buyerFields(buyer)}

      <div class="section-title" style="margin-top:2px">合同明细<span class="line"></span>
        <span class="muted" style="font-size:11.5px">共 ${items.length} 项 · 合计 ¥${fmt(quotation.amount)}</span></div>
      <div class="q-tablewrap"><table class="q-table mini">
        <thead><tr><th>产品 / 服务</th><th class="num">数量</th><th class="num">单价</th><th class="num">金额</th></tr></thead>
        <tbody>${items.map((it) => `<tr>
          <td><div class="qn">${esc(it.name)}</div><div class="qs2">${esc(it.spec || '')}</div></td>
          <td class="num">${it.qty} ${esc(it.unit || '')}</td>
          <td class="num">${fmt(it.unit_price)}</td>
          <td class="num">${fmt(it.amount)}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="muted">报价无明细，合同将不展示明细表</td></tr>'}</tbody>
        <tfoot><tr><td>价税合计</td><td class="num">—</td><td class="num">—</td><td class="num">¥${fmt(sum || quotation.amount)}</td></tr></tfoot>
      </table></div>
      <div class="muted" style="font-size:11.5px">销售方信息取自「系统设置 → 公司抬头」，可在设置里修改。</div>
    </div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>生成订单合同</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      root.querySelector('[data-ok]').onclick = async () => {
        const d = formData(root);
        const btn = root.querySelector('[data-ok]');
        btn.disabled = true;
        try {
          const r = await api.post('/api/contracts', {
            kind: 'order',
            opportunity_id: quotation.opportunity_id,
            quotation_id: quotation.id,
            title: d.title,
            tax_mode: d.tax_mode,
            tax_rate: Number(d.tax_rate),
            payment_terms: d.payment_terms,
            sign_date: d.sign_date,
            buyer: readBuyer(root),
          });
          close();
          finish(r);
        } catch (e) {
          btn.disabled = false;
          toast(e.message, 'err');
        }
      };
    },
  });
}

/* ---------------- 条款合同 ---------------- */
function fillVars(text, vars) {
  return String(text || '').replace(/\{\{([\w.]+)\}\}/g, (all, k) => (vars[k] === undefined || vars[k] === null ? all : String(vars[k])));
}

function termsForm({ quotation, buyer, finish, ctx }) {
  let templates = [];
  let activeTpl = null;

  const open = () => {
    modal({
      title: '创建条款合同',
      width: 820,
      body: `<div class="stack">
        <div class="notice blue">${icon('info', 14)}
          <div>合同编码自动生成（HT-年份-序号）。套用模板后，甲方乙方、金额、账期会自动填入条款，可逐条修改。</div></div>
        <div class="formgrid">
          ${field('合同模板', 'template_id', { options: [{ value: '', label: '暂不套用模板（空白条款）' }] })}
          ${field('合同标题', 'title', { value: `${quotation.opportunity_name} 服务合同`, required: true })}
          ${field('合同金额（元）', 'amount_preview', { value: fmt(quotation.amount), hint: '来自已批准报价，不可修改' })}
          ${field('账期（天）', 'payment_terms', { type: 'number', value: 30, min: 0 })}
          ${field('签订日期', 'sign_date', { type: 'date', value: new Date().toISOString().slice(0, 10) })}
          ${field('合同编号', 'no_preview', { value: '系统自动生成', hint: 'HT-' + new Date().getFullYear() + '-序号' })}
        </div>

        ${buyerFields(buyer)}

        <div class="section-title" style="margin-top:2px">合同条款<span class="line"></span>
          <button class="btn btn-sm" data-add-clause>${icon('plus', 11)} 添加条款</button></div>
        <div class="clause-list" data-clauses>
          <div class="muted" style="font-size:12.5px;padding:6px 2px">选择上方的合同模板，条款会自动带入并可编辑。</div>
        </div>
      </div>`,
      footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>生成条款合同</button>`,
      onMount(root, close) {
        root.querySelector('[data-c]').onclick = close;
        const sel = root.querySelector('[name="template_id"]');
        const list = root.querySelector('[data-clauses]');

        const vars = () => {
          const d = formData(root);
          const b = readBuyer(root);
          return {
            'buyer.name': b.name, 'buyer.address': b.address, 'buyer.contact': b.contact,
            'buyer.phone': b.phone || b.contactPhone, 'buyer.tax_no': b.taxNo,
            'seller.name': '（我方公司）', 'seller.bank': '', 'seller.account': '',
            amount: fmt(quotation.amount),
            sign_date: d.sign_date || '',
            payment_terms: d.payment_terms ?? 30,
            project: quotation.opportunity_name || '',
            contract_no: '（系统生成）',
          };
        };

        const rowHtml = (c, i) => `<div class="clause-row" data-clause>
          <div class="clause-head">
            <input class="input clause-title" value="${esc(c.title || '')}" placeholder="条款标题" />
            <button class="icon-btn" data-del title="删除该条">${icon('trash', 13)}</button>
          </div>
          <textarea class="textarea clause-body" rows="2" placeholder="条款内容">${esc(c.body || '')}</textarea>
        </div>`;

        const render = (clauses) => {
          if (!clauses.length) {
            list.innerHTML = '<div class="muted" style="font-size:12.5px;padding:6px 2px">暂无条款，可点「添加条款」手动补充。</div>';
            return;
          }
          list.innerHTML = clauses.map(rowHtml).join('');
          list.querySelectorAll('[data-del]').forEach((b) => {
            b.onclick = () => { b.closest('[data-clause]').remove(); };
          });
        };

        // 载入模板
        api.get('/api/contracts/templates').then((d) => {
          templates = d.rows || [];
          sel.innerHTML = `<option value="">暂不套用模板（空白条款）</option>` +
            templates.map((t) => `<option value="${t.id}">${esc(t.name)} · ${t.clauses.length} 条</option>`).join('');
          if (templates.length) {
            sel.value = String(templates[0].id);
            applyTemplate(templates[0]);
          }
        }).catch(() => {});

        const applyTemplate = (tpl) => {
          activeTpl = tpl;
          render((tpl.clauses || []).map((c) => ({
            title: fillVars(c.title, vars()),
            body: fillVars(c.body, vars()),
          })));
        };

        sel.onchange = () => {
          const t = templates.find((x) => String(x.id) === String(sel.value));
          if (t) applyTemplate(t);
        };

        root.querySelector('[data-add-clause]').onclick = () => {
          const holder = list.querySelector('.muted');
          if (holder) list.innerHTML = '';
          list.insertAdjacentHTML('beforeend', rowHtml({ title: `第 ${list.querySelectorAll('[data-clause]').length + 1} 条 补充条款`, body: '' }, 0));
          list.querySelectorAll('[data-del]').forEach((b) => {
            b.onclick = () => { b.closest('[data-clause]').remove(); };
          });
        };

        root.querySelector('[data-ok]').onclick = async () => {
          const d = formData(root);
          const clauses = [...root.querySelectorAll('[data-clause]')].map((row) => ({
            title: row.querySelector('.clause-title').value.trim(),
            body: row.querySelector('.clause-body').value.trim(),
          })).filter((c) => c.title || c.body);
          if (!clauses.length) return toast('请至少保留一条合同条款', 'err');
          const btn = root.querySelector('[data-ok]');
          btn.disabled = true;
          try {
            const r = await api.post('/api/contracts', {
              kind: 'terms',
              opportunity_id: quotation.opportunity_id,
              quotation_id: quotation.id,
              template_id: d.template_id ? Number(d.template_id) : null,
              title: d.title,
              amount: quotation.amount,
              payment_terms: d.payment_terms,
              sign_date: d.sign_date,
              buyer: readBuyer(root),
              clauses,
            });
            close();
            finish(r);
          } catch (e) {
            btn.disabled = false;
            toast(e.message, 'err');
          }
          return undefined;
        };
      },
    });
  };

  open();
}

export const __x = { money, amount };
