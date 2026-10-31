import { api } from './api.js';
import { state } from './store.js';
import { icon } from './icons.js';
import { esc, money, amount, toast, field, modal, formData } from './ui.js';

const SENSITIVE = ['admin', 'gm', 'director', 'manager', 'finance'];

/**
 * 报价编辑器
 * 价格只能来自产品库；产品库外的「例外项」需要在系统设置里开启，且当前角色被授权。
 */
export async function openQuoteEditor({ opp, onDone, closeDrawer, ctx }) {
  let opt;
  try {
    opt = await api.get('/api/quote-options');
  } catch (e) {
    return toast(e.message, 'err');
  }
  const products = opt.products;
  const sensitive = SENSITIVE.includes(state.user.role);
  const rows = [];

  const cats = [...new Set(products.map((p) => p.category || '其他'))];

  const html = `
    <div class="qeditor">
      <div class="q-opp">
        <div class="nm">${esc(opp.name)}</div>
        <div class="mt">${esc(opp.account_name || '')} · 商机金额 ${money(opp.amount)}</div>
      </div>

      <div class="q-picker">
        <select class="select" id="pickProduct">
          <option value="">选择产品添加到报价…</option>
          ${cats.map((c) => `<optgroup label="${esc(c)}">
            ${products.filter((p) => (p.category || '其他') === c).map((p) =>
              `<option value="${p.id}">${esc(p.name)} · ${esc(p.spec || '')} · ${amount(p.list_price)}/${esc(p.unit || '套')}</option>`
            ).join('')}
          </optgroup>`).join('')}
        </select>
        ${opt.canCustom ? `<button class="btn" id="addCustom">${icon('plus', 12)} 例外项</button>` : ''}
      </div>

      <div class="q-tablewrap">
        <table class="q-table">
          <thead><tr>
            <th style="min-width:180px">产品 / 项目</th>
            <th style="width:70px">数量</th>
            <th style="width:64px">单位</th>
            <th style="width:110px" class="num">标准价</th>
            <th style="width:110px" class="num">成交单价</th>
            <th style="width:110px" class="num">金额</th>
            ${sensitive ? '<th style="width:100px" class="num">成本</th>' : ''}
            <th style="width:40px"></th>
          </tr></thead>
          <tbody id="qrows"></tbody>
        </table>
      </div>

      <div class="q-sum" id="qsum"></div>

      <div class="q-meta">
        <div class="formgrid">
          ${field('有效期至', 'valid_until', { type: 'date', value: new Date(Date.now() + (opt.validDays || 30) * 86400000).toISOString().slice(0, 10) })}
          ${field('备注', 'remark', { placeholder: '例：含 1 年实施与 3 年维保' })}
        </div>
      </div>

      ${opt.canCustom ? `<div class="notice" style="margin-top:10px">${icon('info', 14)}
        <div>「例外项」用于产品库未覆盖的特殊方案，需管理员在「审批与报价设置」里开启。含例外项的报价会单独标记。</div></div>`
        : `<div class="notice" style="margin-top:10px">${icon('info', 14)}
        <div>报价只能从产品库选择。确有特殊方案需要录入时，请联系管理员开启例外报价。</div></div>`}
    </div>`;

  const m = modal({
    title: '新建报价单',
    width: 920,
    body: html,
    footer: `<span class="muted" style="font-size:12px;margin-right:auto" id="chainHint"></span>
      <button class="btn" data-c>取消</button>
      <button class="btn" data-draft>保存草稿</button>
      <button class="btn btn-primary" data-ok>创建并提交审批</button>`,
    onMount(root, close) {
      const tbody = root.querySelector('#qrows');
      const sumEl = root.querySelector('#qsum');
      const hintEl = root.querySelector('#chainHint');

      const recalc = () => {
        let listTotal = 0;
        let total = 0;
        let costTotal = 0;
        rows.forEach((r) => {
          r.amount = Math.round(r.unit_price * r.qty * 100) / 100;
          listTotal += r.list_price * r.qty;
          total += r.amount;
          costTotal += (r.cost || 0) * r.qty;
        });
        const rate = listTotal > 0 ? (listTotal - total) / listTotal : 0;
        const pct = rate * 100;
        const th = opt.thresholds;
        const myLimit = opt.myDiscountLimit;
        // 未让价（折扣率 ≈ 0）：免价格审批，提交后直接进合同流程
        const noDisc = opt.skipNoDiscount !== false && Math.abs(pct) <= 0.0001;

        let chain = ['经理'];
        if (pct > th.manager) chain.push('总监');
        if (pct > th.director) chain.push('总经理');

        sumEl.innerHTML = `
          <div class="qs"><span>标准价合计</span><b>${money(listTotal)}</b></div>
          <div class="qs"><span>成交合计</span><b>${money(total)}</b></div>
          <div class="qs"><span>折扣</span><b class="${pct > th.director ? 'red' : pct > th.manager ? 'amber' : ''}">${pct.toFixed(2)}%</b></div>
          ${sensitive ? `<div class="qs"><span>成本合计</span><b>${money(costTotal)}</b></div>
          <div class="qs"><span>毛利</span><b>${total ? (((total - costTotal) / total) * 100).toFixed(1) + '%' : '—'}</b></div>` : ''}`;

        const okBtn = root.querySelector('[data-ok]');
        if (okBtn) okBtn.textContent = noDisc ? '创建并提交（免审批）' : '创建并提交审批';
        hintEl.textContent = rows.length
          ? noDisc
            ? '未折扣：免价格审批，提交后直接进入合同流程'
            : `价格审批链：${chain.join(' → ')}${myLimit !== null && myLimit !== undefined ? `（你的折扣限额 ${myLimit}%）` : ''}`
          : '';
        return rate;
      };

      const renderRows = () => {
        if (!rows.length) {
          tbody.innerHTML = `<tr class="q-empty"><td colspan="${sensitive ? 8 : 7}">
            <div class="empty"><strong>还没有明细</strong><span>从上方选择产品加入报价</span></div></td></tr>`;
          recalc();
          return;
        }
        // 先按当前数量与单价算出每行金额，避免新加行显示 0
        rows.forEach((r) => {
          r.amount = Math.round(r.unit_price * r.qty * 100) / 100;
        });
        tbody.innerHTML = rows.map((r, i) => `<tr data-row="${i}">
          <td>
            <div class="qn${r.is_custom ? ' qn-edit' : ''}"${r.is_custom ? ` data-edit="${i}" title="点击修改这条例外项"` : ''}>${esc(r.name)}${r.is_custom ? ' <span class="badge badge-amber">例外</span>' : ''}</div>
            <div class="qs2">${esc(r.spec || '')}</div>
          </td>
          <td><input class="qin" type="number" min="0.01" step="1" data-f="qty" value="${r.qty}" /></td>
          <td class="muted">${esc(r.unit || '')}</td>
          <td class="num muted">${amount(r.list_price)}</td>
          <td><input class="qin" type="number" min="0" step="100" data-f="unit_price" value="${r.unit_price}" /></td>
          <td class="num money" data-amt>${amount(r.amount)}</td>
          ${sensitive ? `<td class="num"><input class="qin" type="number" min="0" step="100" data-f="cost" value="${r.cost || 0}" placeholder="0" /></td>` : ''}
          <td class="right"><button class="icon-btn" data-del title="移除">${icon('trash', 13)}</button></td>
        </tr>`).join('');
        recalc();
      };

      const addProduct = (p) => {
        const exist = rows.find((r) => r.product_id === p.id && !r.is_custom);
        if (exist) {
          exist.qty += 1;
          renderRows();
          return;
        }
        rows.push({
          product_id: p.id,
          name: p.name,
          spec: p.spec,
          unit: p.unit,
          qty: 1,
          list_price: p.list_price,
          unit_price: p.list_price,
          cost: p.cost || 0,
          is_custom: 0,
        });
        renderRows();
      };

      root.querySelector('#pickProduct').onchange = (e) => {
        const p = products.find((x) => String(x.id) === e.target.value);
        if (p) addProduct(p);
        e.target.value = '';
      };

      const customDialog = (existing, onSave) => {
        modal({
          title: existing ? '修改例外项' : '添加例外项（不在产品库中）',
          width: 560,
          body: `<div class="formgrid">
              ${field('项目名称', 'name', { required: true, full: true, value: existing?.name || '', placeholder: '例：第三方系统接口改造' })}
              ${field('规格说明', 'spec', { full: true, value: existing?.spec || '', placeholder: '例：含接口开发、联调与 1 年维护' })}
              ${field('数量', 'qty', { type: 'number', value: existing?.qty ?? 1, min: 0.01, step: 1 })}
              ${field('单位', 'unit', { value: existing?.unit || '项' })}
              ${field('标准价（元）', 'list_price', { type: 'number', required: true, min: 0, step: 100, value: existing?.list_price ?? '' })}
              ${field('成交单价（元）', 'unit_price', { type: 'number', required: true, min: 0, step: 100, value: existing?.unit_price ?? '' })}
              ${sensitive ? field('成本（元）', 'cost', { type: 'number', min: 0, step: 100, value: existing?.cost ?? '' }) : ''}
            </div>
            <div class="notice" style="margin-top:10px">${icon('info', 14)}
              <div>例外项不进入产品库，只写进这张报价单；项目名称与规格会原样打印在报价单「产品 / 服务名称」「规格说明」两列。</div></div>`,
          footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>${existing ? '保存' : '添加到明细'}</button>`,
          onMount(r2, c2) {
            r2.querySelector('[data-c]').onclick = c2;
            r2.querySelector('[data-ok]').onclick = () => {
              const d = formData(r2);
              const name = String(d.name || '').trim();
              if (!name) return toast('请填写项目名称', 'err');
              if (!(Number(d.list_price) > 0)) return toast('请填写标准价', 'err');
              const unitPrice = d.unit_price === null || d.unit_price === undefined || d.unit_price === ''
                ? Number(d.list_price) : Number(d.unit_price);
              if (!(unitPrice >= 0)) return toast('请填写成交单价', 'err');
              if (unitPrice > Number(d.list_price)) return toast('成交单价不能高于标准价', 'err');
              onSave({
                product_id: null,
                name,
                spec: String(d.spec || '').trim(),
                unit: String(d.unit || '').trim() || '项',
                qty: Number(d.qty || 1),
                list_price: Number(d.list_price),
                unit_price: unitPrice,
                cost: Number(d.cost || 0),
                is_custom: 1,
              });
              c2();
              return undefined;
            };
          },
        });
      };

      // 例外项：弹窗独立一层，不覆盖报价编辑器
      const customBtn = root.querySelector('#addCustom');
      if (customBtn) {
        customBtn.onclick = () => customDialog(null, (row) => {
          rows.push(row);
          renderRows();
          toast(`已加入明细：${row.name}`, 'ok');
        });
      }

      // 数量 / 单价 / 成本 改动
      tbody.addEventListener('input', (e) => {
        const tr = e.target.closest('tr[data-row]');
        if (!tr) return;
        const i = Number(tr.dataset.row);
        const f = e.target.dataset.f;
        if (!f || !rows[i]) return;
        const v = Number(e.target.value);
        if (Number.isNaN(v)) return;

        if (f === 'unit_price' && v > rows[i].list_price * 1.0001) {
          e.target.classList.add('bad');
        } else {
          e.target.classList.remove('bad');
        }
        if (f === 'qty') rows[i].qty = v > 0 ? v : 0;
        else if (f === 'unit_price') rows[i].unit_price = Math.max(0, v);
        else if (f === 'cost') rows[i].cost = Math.max(0, v);

        const rate = recalc();
        const amtCell = tr.querySelector('[data-amt]');
        if (amtCell) amtCell.textContent = amount(rows[i].amount || 0);

        // 单价高于标准价时给出即时提示
        if (f === 'unit_price' && rows[i].unit_price > rows[i].list_price) {
          hintEl.textContent = `第 ${i + 1} 行成交单价高于标准价，无法提交`;
          hintEl.classList.add('bad-hint');
        } else {
          hintEl.classList.remove('bad-hint');
        }
        void rate;
      });

      tbody.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-del]');
        if (btn) {
          const tr = btn.closest('tr[data-row]');
          rows.splice(Number(tr.dataset.row), 1);
          renderRows();
          return;
        }
        const ed = e.target.closest('[data-edit]');
        if (ed) {
          const i = Number(ed.dataset.edit);
          if (!rows[i]) return;
          customDialog(rows[i], (next) => {
            rows[i] = next;
            renderRows();
            toast('例外项已更新', 'ok');
          });
        }
      });

      const collect = () => ({
        items: rows.map((r) => ({
          product_id: r.product_id,
          name: r.name,
          spec: r.spec,
          unit: r.unit,
          qty: r.qty,
          list_price: r.list_price,
          unit_price: r.unit_price,
          cost: r.cost,
          is_custom: r.is_custom,
        })),
        valid_until: root.querySelector('[name="valid_until"]').value,
        remark: root.querySelector('[name="remark"]').value,
      });

      const submit = async (alsoSubmit) => {
        if (!rows.length) return toast('请至少添加一个产品', 'err');
        const over = rows.find((r) => r.unit_price > r.list_price + 0.001);
        if (over) return toast(`「${over.name}」的成交单价高于标准价`, 'err');
        const bad = rows.find((r) => !(r.qty > 0));
        if (bad) return toast(`「${bad.name}」的数量必须大于 0`, 'err');

        try {
          const body = collect();
          const r = await api.post('/api/quotations', { opportunity_id: opp.id, ...body });
          if (alsoSubmit) {
            const s = await api.post(`/api/quotations/${r.id}/submit`);
            if (s && s.skipped) toast('报价已创建：未折扣，免价格审批，可直接创建合同', 'ok');
            else toast(`报价已提交价格审批：${(r.discount_rate * 100).toFixed(2)}% 折扣`, 'ok');
          } else {
            toast('已保存为草稿', 'ok');
          }
          close();
          if (closeDrawer) closeDrawer();
          if (onDone) onDone(r);
          if (ctx) ctx.refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
        return undefined;
      };

      root.querySelector('[data-c]').onclick = close;
      root.querySelector('[data-draft]').onclick = () => submit(false);
      root.querySelector('[data-ok]').onclick = () => submit(true);

      renderRows();
    },
  });
  return m;
}
