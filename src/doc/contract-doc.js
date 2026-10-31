import { one, all } from '../db.js';
import { companyProfile } from '../settings.js';
import { rmbUpper } from '../money-cn.js';
import { docShell, docHead, partyBlock, esc, num, ymd } from './base.js';

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

export function loadContractDoc(contractId) {
  const c = one(
    `select c.*, a.name as account_name, a.address as account_address, a.phone as account_phone,
            a.industry, op.name as opportunity_name, u.name as owner_name, u.phone as owner_phone,
            u.email as owner_email, o.name as org_name, q.no as quote_no
     from contracts c
     join accounts a on a.id = c.account_id
     left join opportunities op on op.id = c.opportunity_id
     left join users u on u.id = c.owner_id
     left join org_units o on o.id = c.org_id
     left join quotations q on q.id = c.quotation_id
     where c.id = ?`,
    contractId
  );
  if (!c) return null;

  let items = parseJson(c.items_json, null);
  if (!items && c.quotation_id) {
    items = all('select name, spec, unit, qty, unit_price as price from quotation_items where quotation_id = ? order by seq', c.quotation_id);
  }
  const contact =
    one('select * from contacts where account_id = ? and is_primary = 1 order by id limit 1', c.account_id) ||
    one('select * from contacts where account_id = ? order by id limit 1', c.account_id) ||
    {};

  return {
    c,
    items: items || [],
    clauses: parseJson(c.clauses_json, []),
    buyer: parseJson(c.buyer_json, {}),
    seller: parseJson(c.seller_json, {}),
    contact,
  };
}

/** 订单合同：发票式单据（买卖双方 + 明细 + 税率 + 价税合计） */
function renderOrder({ c, items, buyer, seller, contact }) {
  const company = companyProfile();
  const sellerInfo = { ...company, ...seller };
  const rate = Number(c.tax_rate || 0);
  const included = c.tax_mode !== 'excluded';

  const rows = items.map((it) => {
    const price = Number(it.price ?? it.unit_price ?? 0);
    const qty = Number(it.qty || 0);
    const gross = r2(price * qty);
    const net = included ? r2(gross / (1 + rate)) : gross;
    const tax = r2(gross - net);
    return { ...it, price, qty, net, tax, gross: r2(net + tax) };
  });
  const netSum = r2(rows.reduce((s, r) => s + r.net, 0));
  const taxSum = r2(rows.reduce((s, r) => s + r.tax, 0));
  const grossSum = r2(netSum + taxSum);
  const payable = r2(Number(c.amount || grossSum));

  const body = `
  ${docHead({
    company: sellerInfo,
    title: '销 售 合 同',
    subtitle: 'SALES CONTRACT · ORDER',
    meta: `<div>合同编号：<b>${esc(c.no)}</b></div><div>签订日期：${ymd(c.sign_date || c.created_at)}</div>
           <div>签订地点：${esc(company.address || '—')}</div>
           ${c.quote_no ? `<div>关联报价：${esc(c.quote_no)}</div>` : ''}`,
  })}

  ${partyBlock(
    {
      tag: '购买方（甲方）',
      rows: [
        ['公司名称', buyer.name || c.account_name],
        ['纳税人识别号', buyer.taxNo || '—'],
        ['地址', buyer.address || c.account_address || '—'],
        ['电话', buyer.phone || c.account_phone || '—'],
        ['开户银行', buyer.bank || '—'],
        ['银行账号', buyer.account || '—'],
      ],
    },
    {
      tag: '销售方（乙方）',
      rows: [
        ['公司名称', sellerInfo.name],
        ['纳税人识别号', sellerInfo.taxNo || '—'],
        ['地址', sellerInfo.address || '—'],
        ['电话', sellerInfo.phone || '—'],
        ['开户银行', sellerInfo.bank || '—'],
        ['银行账号', sellerInfo.account || '—'],
      ],
    }
  )}

  <h2 class="sec">一、标的与价格（${included ? '含税价' : '不含税价'}）</h2>
  <table class="items">
    <thead><tr>
      <th style="width:44px">序号</th>
      <th>货物或应税劳务、服务名称</th>
      <th style="width:130px">规格型号</th>
      <th style="width:42px">单位</th>
      <th style="width:48px">数量</th>
      <th style="width:88px">单价</th>
      <th style="width:96px">金额</th>
      <th style="width:50px">税率</th>
      <th style="width:86px">税额</th>
    </tr></thead>
    <tbody>
      ${rows.length ? rows.map((it, i) => `<tr>
        <td class="c">${i + 1}</td>
        <td>${esc(it.name)}</td>
        <td style="font-size:11px">${esc(it.spec || '—')}</td>
        <td class="c">${esc(it.unit || '项')}</td>
        <td class="c">${num(it.qty, 0)}</td>
        <td class="r">${num(it.price)}</td>
        <td class="r">${num(it.net)}</td>
        <td class="c">${(rate * 100).toFixed(0)}%</td>
        <td class="r">${num(it.tax)}</td>
      </tr>`).join('') : `<tr><td colspan="9" class="c" style="padding:16px;color:#888">本合同无产品明细</td></tr>`}
      <tr>
        <td class="c" colspan="6" style="background:#f7f9fc;font-weight:600">合计</td>
        <td class="r" style="background:#f7f9fc;font-weight:600">${num(netSum)}</td>
        <td class="c" style="background:#f7f9fc">—</td>
        <td class="r" style="background:#f7f9fc;font-weight:600">${num(taxSum)}</td>
      </tr>
    </tbody>
  </table>

  <div class="totals">
    <div class="line"><span>金额（不含税）</span><b>¥ ${num(netSum)}</b></div>
    <div class="line"><span>税额（${(rate * 100).toFixed(0)}%）</span><b>¥ ${num(taxSum)}</b></div>
    ${Number(c.discount_rate) > 0.000001 ? `<div class="line"><span>已含折扣</span><b>${(Number(c.discount_rate) * 100).toFixed(2)}%（按产品库标准价折算）</b></div>` : ''}
    <div class="line grand"><span>价税合计</span><b>¥ ${num(payable)}</b></div>
    <div class="upper">价税合计（大写）：<b>${rmbUpper(payable)}</b></div>
  </div>

  <h2 class="sec">二、交付与验收</h2>
  <div class="text-block">1. 乙方于合同生效后按项目计划完成交付，交付地点为甲方指定地址：${esc(buyer.address || c.account_address || '甲方办公地')}。
2. 甲方应在收到交付成果后 15 个工作日内完成验收并书面确认；逾期未提出书面异议的，视为验收合格。
3. 交付成果的知识产权归属、使用范围以本合同第三条约定为准。</div>

  <h2 class="sec">三、付款方式</h2>
  <div class="text-block">1. 本合同价税合计人民币 ${num(payable)} 元（大写：${rmbUpper(payable)}）。
2. 账期：验收合格并收到乙方开具的增值税专用发票后 ${Number(c.payment_terms || 30)} 天内一次性付清。
3. 收款账户：${esc(sellerInfo.name)}　开户行：${esc(sellerInfo.bank || '—')}　账号：${esc(sellerInfo.account || '—')}。
4. 甲方逾期付款的，按未付金额每日万分之五向乙方支付违约金。</div>

  <h2 class="sec">四、质量保证与售后</h2>
  <div class="text-block">1. 乙方保证所提供的产品与服务符合合同约定的规格与功能要求。
2. 自验收合格之日起提供 12 个月免费质保，质保期内非人为损坏的故障由乙方免费修复。
3. 质保期满后，乙方按年度提供有偿运维服务，具体标准另行签订服务协议。</div>

  <h2 class="sec">五、争议解决</h2>
  <div class="text-block">本合同履行过程中发生争议，双方应友好协商解决；协商不成的，任何一方均可向乙方所在地有管辖权的人民法院提起诉讼。
本合同一式两份，甲乙双方各执一份，自双方签字盖章之日起生效。</div>

  <div class="sign">
    <div class="box">
      <div class="who">购买方（甲方）：${esc(buyer.name || c.account_name)}</div>
      <div>授权代表：${esc(buyer.contact || contact.name || '')}</div>
      <div>盖章：</div>
      <div>日期：　　　年　　月　　日</div>
    </div>
    <div class="box">
      <div class="who">销售方（乙方）：${esc(sellerInfo.name)}</div>
      <div>授权代表：${esc(sellerInfo.legalPerson || '')}</div>
      <div>盖章：</div>
      <div>日期：${ymd(c.sign_date || c.created_at)}</div>
    </div>
  </div>

  <div class="foot">
    合同编号 ${esc(c.no)} · 由 MSERM CRM 生成 · 打印件与原件具有同等效力<br/>
    ${esc(sellerInfo.name)}　${esc(sellerInfo.address)}　电话：${esc(sellerInfo.phone)}
  </div>`;

  return body;
}

/** 条款合同：模板条款 + 甲乙方自动填充 */
function renderTerms({ c, clauses, buyer, seller, contact }) {
  const company = companyProfile();
  const sellerInfo = { ...company, ...seller };
  const amount = Number(c.amount || 0);

  const body = `
  ${docHead({
    company: sellerInfo,
    title: c.title,
    subtitle: 'CONTRACT',
    meta: `<div>合同编号：<b>${esc(c.no)}</b></div><div>签订日期：${ymd(c.sign_date || c.created_at)}</div>
           <div>合同金额：¥ ${num(amount)}</div>${c.quote_no ? `<div>关联报价：${esc(c.quote_no)}</div>` : ''}`,
  })}

  ${partyBlock(
    {
      tag: '甲方（委托方）',
      rows: [
        ['公司名称', buyer.name || c.account_name],
        ['法定代表人', buyer.legalPerson || '—'],
        ['联系人', buyer.contact || contact.name || '—'],
        ['联系电话', buyer.phone || contact.phone || c.account_phone || '—'],
        ['地址', buyer.address || c.account_address || '—'],
      ],
    },
    {
      tag: '乙方（服务方）',
      rows: [
        ['公司名称', sellerInfo.name],
        ['法定代表人', sellerInfo.legalPerson || '—'],
        ['联系人', c.owner_name || '—'],
        ['联系电话', c.owner_phone || sellerInfo.phone || '—'],
        ['地址', sellerInfo.address || '—'],
      ],
    }
  )}

  <h2 class="sec">鉴于</h2>
  <div class="text-block">甲方拟委托乙方提供 ${esc(c.opportunity_name || c.title)} 相关产品与服务，乙方具备相应的资质与能力。双方本着平等自愿、诚实信用的原则，经友好协商，就有关事项达成如下条款，共同遵守。</div>

  ${clauses.length ? clauses.map((cl, i) => `<div class="clause" style="margin-top:12px">
      <div class="t">${esc(cl.title || `第 ${i + 1} 条`)}</div>
      <div class="b">${esc(cl.body || '').replace(/\n/g, '<br/>')}</div>
    </div>`).join('') : '<div class="text-block" style="color:#888">该合同尚未套用条款模板</div>'}

  <h2 class="sec">签署</h2>
  <div class="text-block">本合同自双方授权代表签字并加盖公章之日起生效，一式两份，甲乙双方各执一份，具有同等法律效力。</div>

  <div class="sign">
    <div class="box">
      <div class="who">甲方（盖章）：${esc(buyer.name || c.account_name)}</div>
      <div>授权代表签字：</div>
      <div>日期：　　　年　　月　　日</div>
    </div>
    <div class="box">
      <div class="who">乙方（盖章）：${esc(sellerInfo.name)}</div>
      <div>授权代表签字：${esc(sellerInfo.legalPerson || '')}</div>
      <div>日期：${ymd(c.sign_date || c.created_at)}</div>
    </div>
  </div>

  <div class="foot">合同编号 ${esc(c.no)} · 由 MSERM CRM 依据合同模板生成 · 条款修改以最终签署版本为准</div>`;

  return body;
}

export function renderContractHtml(data) {
  const isTerms = data.c.kind === 'terms';
  const body = isTerms ? renderTerms(data) : renderOrder(data);
  return docShell({
    title: `${data.c.no} ${data.c.title}`,
    note: `${isTerms ? '条款合同' : '订单合同'} · ${data.c.no} · ${data.c.account_name}`,
    body,
  });
}

export { rmbUpper };
