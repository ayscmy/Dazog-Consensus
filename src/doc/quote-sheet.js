import { one, all } from '../db.js';
import { companyProfile, getSetting } from '../settings.js';
import { rmbUpper } from '../money-cn.js';
import { docShell, docHead, partyBlock, esc, num, ymd } from './base.js';

/** 报价单所需数据（不包含成本，客户可见） */
export async function loadQuoteSheet(quotationId) {
  const q = await one(`select q.*, op.name as opportunity_name, a.name as account_name, a.address as account_address,
            a.phone as account_phone, a.industry, u.name as owner_name, u.email as owner_email,
            u.phone as owner_phone, o.name as org_name
     from quotations q
     join opportunities op on op.id = q.opportunity_id
     join accounts a on a.id = q.account_id
     left join users u on u.id = op.owner_id
     left join org_units o on o.id = q.org_id
     where q.id = ?`, quotationId);
  if (!q) return null;
  const items = await all('select * from quotation_items where quotation_id = ? order by seq', q.id);
  const contact = (await one('select * from contacts where account_id = ? and is_primary = 1 order by id limit 1', q.account_id)) || (await one('select * from contacts where account_id = ? order by id limit 1', q.account_id)) || {};
  return {
    q,
    items,
    contact
  };
}
export async function findQuoteByToken(token) {
  const q = await one('select id from quotations where public_token = ?', String(token || ''));
  return q ? await loadQuoteSheet(q.id) : null;
}

/** 客户身份可见的报价单（打印 / 邮件链接 / PDF） */
export async function renderSheetHtml({
  q,
  items,
  contact
}, {
  autoPrint = false
} = {}) {
  const company = await companyProfile();
  const note = String((await getSetting('quote.sheet_note')) || '').replace(/\\n/g, '\n').split('\n').map(x => x.replace(/[；;]\s*$/, '')).join('\n');
  const listTotal = Number(q.list_amount || 0);
  const total = Number(q.amount || 0);
  const discount = Number(q.discount_rate || 0) * 100;
  const rows = items.length ? items : [{
    name: q.opportunity_name || '项目报价',
    spec: '',
    unit: '项',
    qty: 1,
    unit_price: total,
    amount: total
  }];
  const body = `
  ${docHead({
    company,
    title: '报 价 单',
    subtitle: 'QUOTATION',
    meta: `<div>报价单号：<b>${esc(q.no)}</b></div><div>报价日期：${ymd(q.created_at)}</div>
           <div>有效期至：<b>${ymd(q.valid_until)}</b></div><div>版本：v${esc(q.version || 1)}</div>`
  })}

  ${partyBlock({
    tag: '客户（甲方）',
    rows: [['公司名称', q.account_name], ['联系人', contact.name || '—'], ['联系电话', contact.phone || q.account_phone || '—'], ['电子邮箱', contact.email || '—'], ['地址', q.account_address || '—']]
  }, {
    tag: '供方（乙方）',
    rows: [['公司名称', company.name], ['项目负责人', q.owner_name || '—'], ['联系电话', q.owner_phone || company.phone], ['电子邮箱', q.owner_email || '—'], ['地址', company.address]]
  })}

  <h2 class="sec">一、报价明细</h2>
  <table class="items">
    <thead><tr>
      <th style="width:44px">序号</th>
      <th>产品 / 服务名称</th>
      <th style="width:150px">规格说明</th>
      <th style="width:48px">单位</th>
      <th style="width:52px">数量</th>
      <th style="width:92px">单价（元）</th>
      <th style="width:104px">金额（元）</th>
    </tr></thead>
    <tbody>
      ${rows.map((it, i) => `<tr>
        <td class="c">${i + 1}</td>
        <td>${esc(it.name)}</td>
        <td style="font-size:11px;color:#555">${esc(it.spec || '—')}</td>
        <td class="c">${esc(it.unit || '项')}</td>
        <td class="c">${num(it.qty, 0)}</td>
        <td class="r">${num(it.unit_price)}</td>
        <td class="r">${num(it.amount)}</td>
      </tr>`).join('')}
    </tbody>
  </table>

  <div class="totals">
    <div class="line"><span>标准价合计</span><b>¥ ${num(listTotal)}</b></div>
    <div class="line"><span>折扣率</span><b>${discount > 0.000001 ? `${discount.toFixed(2)}%` : '无折扣'}</b></div>
    ${discount > 0.000001 ? `<div class="line"><span>优惠金额</span><b>− ¥ ${num(listTotal - total)}</b></div>` : ''}
    <div class="line grand"><span>报价合计（含税）</span><b>¥ ${num(total)}</b></div>
    <div class="upper">价税合计（大写）：<b>${rmbUpper(total)}</b></div>
  </div>

  <h2 class="sec">二、报价说明</h2>
  <div class="text-block">${esc(note)}</div>

  <h2 class="sec">三、商务信息</h2>
  <table class="items" style="margin-top:4px">
    <tbody>
      <tr><td style="width:110px;background:#f7f9fc">付款方式</td><td>电汇 / 转账，账期以合同约定为准</td>
          <td style="width:110px;background:#f7f9fc">币种</td><td style="width:130px">人民币（CNY）</td></tr>
      <tr><td style="background:#f7f9fc">开户银行</td><td>${esc(company.bank || '—')}</td>
          <td style="background:#f7f9fc">银行账号</td><td>${esc(company.account || '—')}</td></tr>
      <tr><td style="background:#f7f9fc">关联商机</td><td>${esc(q.opportunity_name || '—')}</td>
          <td style="background:#f7f9fc">所属组织</td><td>${esc(q.org_name || '—')}</td></tr>
    </tbody>
  </table>

  <div class="sign">
    <div class="box">
      <div class="who">客户确认（甲方）</div>
      <div>授权代表签字：</div>
      <div>盖章：</div>
      <div>日期：　　　年　　月　　日</div>
    </div>
    <div class="box">
      <div class="who">供方（乙方）</div>
      <div>${esc(company.name)}</div>
      <div>经办人：${esc(q.owner_name || '')}</div>
      <div>日期：${ymd(q.created_at)}</div>
    </div>
  </div>

  <div class="foot">
    ${esc(company.name)}　${esc(company.address)}　电话：${esc(company.phone)}<br/>
    本报价单由 MSERM CRM 生成，编号 ${esc(q.no)}，客户可通过专属链接在线查看。
  </div>`;
  const html = docShell({
    title: `报价单 ${q.no}`,
    note: `报价单 ${q.no} · ${q.account_name} · 合计 ¥${num(total)}`,
    body
  });
  return autoPrint ? html.replace('</body>', '<script>window.addEventListener("load",()=>window.print())</script></body>') : html;
}