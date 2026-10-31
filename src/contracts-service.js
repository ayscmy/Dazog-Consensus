import { one, all, run, nowIso, idOf, today } from './db.js';
import { companyProfile } from './settings.js';
import { bad, denied } from './http.js';
import { canEditRecord } from './auth.js';

/* =========================================================
   合同创建（订单合同 / 条款合同）
   价格与明细来自已批准报价；合同编码自动生成
   ========================================================= */

const parseJson = (text, fallback) => {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
};

export function nextContractNo(kind) {
  const y = new Date().getFullYear();
  const prefix = kind === 'terms' ? `HT-${y}-` : `DD-${y}-`;
  const row = one('select no from contracts where no like ? order by no desc limit 1', `${prefix}%`);
  const seq = row ? (Number(String(row.no).slice(prefix.length)) || 0) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

function buyerFromAccount(accountId, contact) {
  const a = one('select * from accounts where id=?', accountId) || {};
  const ct = contact || one('select * from contacts where account_id=? and is_primary=1 order by id limit 1', accountId) || {};
  return {
    name: a.name || '',
    taxNo: '',
    address: a.address || '',
    phone: a.phone || '',
    bank: '',
    account: '',
    contact: ct.name || '',
    contactPhone: ct.phone || '',
    email: ct.email || '',
    legalPerson: '',
  };
}

/** 模板占位符替换：{{buyer.name}} / {{amount}} / {{contract_no}} ... */
export function fillClauses(clauses, vars) {
  const fill = (s) => String(s || '').replace(/\{\{([\w.]+)\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
  return (clauses || []).map((c) => ({ title: fill(c.title || ''), body: fill(c.body || '') }));
}

export function createContractRecord(user, body) {
  const mods = user.modules || [];
  if (!mods.includes('*') && !mods.includes('contract')) throw denied('无权创建合同');
  const b = body || {};
  const kind = b.kind === 'terms' ? 'terms' : 'order';

  const op = one('select * from opportunities where id=?', b.opportunity_id);
  if (!op) throw bad('请选择关联商机');
  if (!canEditRecord(user, op)) throw denied('只能为自己负责的商机创建合同');

  const quote = b.quotation_id ? one('select * from quotations where id=?', b.quotation_id) : null;
  if (b.quotation_id && !quote) throw bad('关联报价不存在');
  if (quote) {
    if (quote.status !== 'approved') throw bad('只有已批准的报价才能创建合同');
    if (one('select id from contracts where quotation_id=?', quote.id)) throw bad('该报价已生成合同');
    if (Number(quote.opportunity_id) !== Number(op.id)) throw bad('报价与商机不匹配');
  }

  const amount = quote ? Number(quote.amount) : Number(b.amount || 0);
  if (!(amount > 0)) throw bad('请填写合同金额');
  const paymentTerms = Number(b.payment_terms ?? 30);
  if (!(paymentTerms >= 0)) throw bad('账期不能为负');

  const taxMode = b.tax_mode === 'excluded' ? 'excluded' : 'included';
  const buyer = { ...buyerFromAccount(op.account_id), ...(b.buyer || {}) };
  const seller = { ...companyProfile(), ...(b.seller || {}) };

  let items = [];
  if (quote) {
    items = all(
      'select name, spec, unit, qty, unit_price as price from quotation_items where quotation_id=? order by seq',
      quote.id
    ).map((x) => ({ ...x, price: Number(x.price) }));
  } else if (Array.isArray(b.items) && b.items.length) {
    items = b.items.map((x) => ({
      name: String(x.name || '').trim(),
      spec: x.spec || '',
      unit: x.unit || '项',
      qty: Number(x.qty || 1),
      price: Number(x.price || x.unit_price || 0),
    })).filter((x) => x.name && x.qty > 0);
  }

  const no = String(b.no || '').trim() || nextContractNo(kind);

  let clauses = [];
  if (kind === 'terms') {
    const vars = {
      'buyer.name': buyer.name, 'buyer.address': buyer.address, 'buyer.contact': buyer.contact,
      'buyer.phone': buyer.phone || buyer.contactPhone, 'buyer.tax_no': buyer.taxNo,
      'seller.name': seller.name, 'seller.bank': seller.bank, 'seller.account': seller.account,
      amount: Number(amount).toLocaleString('zh-CN', { minimumFractionDigits: 2 }),
      contract_no: no,
      sign_date: b.sign_date || today(),
      payment_terms: paymentTerms,
      project: op.name,
    };
    if (Array.isArray(b.clauses) && b.clauses.length) {
      clauses = fillClauses(b.clauses, vars);
    } else if (b.template_id) {
      const tpl = one("select * from contract_templates where id=? and status='active'", b.template_id);
      if (!tpl) throw bad('合同模板不存在或已停用');
      clauses = fillClauses(parseJson(tpl.clauses, []), vars);
    }
  }

  const r = run(
    `insert into contracts(no,title,kind,opportunity_id,account_id,quotation_id,amount,tax_rate,tax_mode,
                           payment_terms,sign_date,start_date,end_date,status,owner_id,org_id,created_by,
                           created_at,updated_at,discount_rate,buyer_json,seller_json,items_json,clauses_json,template_id)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?)`,
    no,
    String(b.title || '').trim() || `${op.name} ${kind === 'terms' ? '服务合同' : '销售合同'}`,
    kind, op.id, op.account_id, quote ? quote.id : null,
    amount, Number(b.tax_rate ?? 0.06), taxMode,
    paymentTerms, b.sign_date || today(), b.start_date || today(7), b.end_date || today(372),
    op.owner_id, op.org_id, user.id, nowIso(), nowIso(),
    quote ? Number(quote.discount_rate || 0) : 0,
    JSON.stringify(buyer), JSON.stringify(seller), JSON.stringify(items), JSON.stringify(clauses),
    kind === 'terms' ? (b.template_id || null) : null
  );
  const id = idOf(r);

  if (quote) run("update quotations set status='converted', updated_at=? where id=?", nowIso(), quote.id);
  run(
    `insert into activities(target_type,target_id,type,content,result,user_id,created_at)
     values('contract',?,'note',?,?,?,?)`,
    id,
    `创建${kind === 'terms' ? '条款合同' : '订单合同'} ${no}${quote ? `（来源报价 ${quote.no}）` : ''}`,
    'draft', user.id, nowIso()
  );

  return { id, no, kind };
}
