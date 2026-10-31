import { GET, POST, PATCH, bad, notFound, denied } from '../http.js';
import { all, one, run, tx, nowIso, idOf, today } from '../db.js';
import { randomBytes } from 'node:crypto';
import { scopeFilter, canEditRecord, canModule } from '../auth.js';
import { chainForDiscount, createApproval, approvalDetail, priceApprovalRequired, resolveChain, applyAssignees } from '../approval.js';
import { canUseCustomItem, getSettingNum, getSetting, companyProfile, isOn } from '../settings.js';
import { loadQuoteSheet, renderSheetHtml } from '../doc/quote-sheet.js';
import { createContractRecord } from '../contracts-service.js';
import { sendMail } from '../mailer.js';
import { sendSms } from '../sms.js';

const SENSITIVE = ['admin', 'gm', 'director', 'manager', 'finance'];

function shapeQuote(q, user) {
  const out = { ...q };
  if (!SENSITIVE.includes(user.role)) {
    delete out.cost;
    out.gross_margin = null;
    if (out.items) out.items = out.items.map((it) => { const c = { ...it }; delete c.cost; return c; });
  } else {
    out.gross_margin = out.amount ? (out.amount - out.cost) / out.amount : 0;
  }
  return out;
}

function itemsOf(quotationId, user) {
  const rows = all('select * from quotation_items where quotation_id = ? order by seq', quotationId);
  if (!SENSITIVE.includes(user.role)) rows.forEach((r) => { delete r.cost; });
  return rows;
}

/**
 * 把前端提交的明细行规整为可信数据：
 * - 有 product_id 的，标准价与成本一律以产品库为准（不信任前端传值）
 * - 无 product_id 的视为例外项，需要系统开关放行
 */
function normalizeItems(rawItems, user) {
  if (!Array.isArray(rawItems) || !rawItems.length) return null;
  const out = [];
  let customCount = 0;

  rawItems.forEach((raw, i) => {
    const rowNo = i + 1;
    const qty = Number(raw.qty ?? 1);
    if (!(qty > 0)) throw bad(`第 ${rowNo} 行：数量必须大于 0`);

    let productId = null;
    let name = String(raw.name || '').trim();
    let spec = raw.spec || null;
    let unit = raw.unit || '套';
    let listPrice = Number(raw.list_price || 0);
    let cost = Number(raw.cost || 0);
    let isCustom = 0;

    if (raw.product_id) {
      const p = one('select * from products where id = ? and status = ?', raw.product_id, 'active');
      if (!p) throw bad(`第 ${rowNo} 行：产品不存在或已停售`);
      productId = p.id;
      name = p.name;
      spec = raw.spec || p.spec;
      unit = raw.unit || p.unit;
      listPrice = Number(p.list_price);
      cost = Number(p.cost);
    } else {
      if (!canUseCustomItem(user)) {
        throw bad(`第 ${rowNo} 行：不在产品库中的项目属于例外报价，当前未开启或你的角色无权录入`);
      }
      if (!name) throw bad(`第 ${rowNo} 行：请填写项目名称`);
      if (!(listPrice > 0)) throw bad(`第 ${rowNo} 行：请填写标准价`);
      isCustom = 1;
      customCount++;
    }

    const unitPrice = Number(raw.unit_price ?? listPrice);
    if (unitPrice < 0) throw bad(`第 ${rowNo} 行：单价不能为负`);
    if (unitPrice > listPrice) throw bad(`第 ${rowNo} 行：成交单价不能高于标准价`);

    out.push({
      product_id: productId,
      name,
      spec,
      unit,
      qty,
      list_price: listPrice,
      unit_price: unitPrice,
      amount: Math.round(unitPrice * qty * 100) / 100,
      cost: Math.round(cost * qty * 100) / 100,
      is_custom: isCustom,
    });
  });

  const listTotal = out.reduce((s, r) => s + r.list_price * r.qty, 0);
  const total = out.reduce((s, r) => s + r.amount, 0);
  const costTotal = out.reduce((s, r) => s + r.cost, 0);
  const rate = listTotal > 0 ? (listTotal - total) / listTotal : 0;
  return { items: out, listTotal, total, costTotal, rate, hasCustom: customCount > 0 ? 1 : 0 };
}

function writeItems(quotationId, items) {
  run('delete from quotation_items where quotation_id = ?', quotationId);
  items.forEach((it, i) => {
    run(
      `insert into quotation_items(quotation_id,seq,product_id,name,spec,unit,qty,list_price,unit_price,amount,cost,is_custom)
       values(?,?,?,?,?,?,?,?,?,?,?,?)`,
      quotationId, i + 1, it.product_id, it.name, it.spec, it.unit, it.qty,
      it.list_price, it.unit_price, it.amount, it.cost, it.is_custom
    );
  });
}

/** 报价单对外 token：客户凭链接直接查看，不需要账号 */
function ensureToken(q) {
  if (q.public_token) return q.public_token;
  const token = randomBytes(12).toString('hex');
  run('update quotations set public_token=? where id=?', token, q.id);
  return token;
}

/** 对外地址：优先取系统设置，否则按当前请求域名拼 */
export function publicBase(req) {
  const configured = String(getSetting('site.public_url') || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const host = req?.headers?.host || 'localhost:8081';
  const proto = String(req?.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${host}`;
}

GET('/api/quotations', (ctx) => {
  if (!canModule(ctx.user, 'quotation')) throw denied('无权访问报价');
  const scope = scopeFilter(ctx.user, { owner: 'op.owner_id', org: 'q.org_id' });
  const where = [scope.sql];
  const params = [...scope.params];
  if (ctx.query.status) { where.push('q.status = ?'); params.push(ctx.query.status); }
  if (ctx.query.q) {
    where.push('(q.no LIKE ? OR op.name LIKE ? OR a.name LIKE ?)');
    params.push(`%${ctx.query.q}%`, `%${ctx.query.q}%`, `%${ctx.query.q}%`);
  }
  if (ctx.query.mine === '1') { where.push('q.created_by = ?'); params.push(ctx.user.id); }
  const rows = all(
    `select q.*, op.name as opportunity_name, op.stage as opp_stage, a.name as account_name,
            u.name as creator_name, o.name as org_name,
            (select count(*) from quotation_items qi where qi.quotation_id = q.id) as item_count
     from quotations q
     join opportunities op on op.id=q.opportunity_id
     join accounts a on a.id=q.account_id
     left join users u on u.id=q.created_by
     left join org_units o on o.id=q.org_id
     where ${where.join(' and ')} order by q.created_at desc limit 400`,
    ...params
  ).map((q) => shapeQuote(q, ctx.user));
  return {
    rows,
    stats: {
      total: rows.length,
      pending: rows.filter((r) => r.status === 'pending').length,
      approved: rows.filter((r) => r.status === 'approved').length,
      amount: rows.filter((r) => r.status === 'approved').reduce((s, r) => s + Number(r.amount || 0), 0),
    },
  };
});

GET('/api/quotations/:id', (ctx) => {
  const q = one(
    `select q.*, op.name as opportunity_name, a.name as account_name, u.name as creator_name
     from quotations q join opportunities op on op.id=q.opportunity_id
     join accounts a on a.id=q.account_id left join users u on u.id=q.created_by where q.id=?`,
    ctx.params.id
  );
  if (!q) throw notFound('报价单不存在');
  const op = one('select * from opportunities where id=?', q.opportunity_id);
  if (!canEditRecord(ctx.user, op)) throw denied('无权查看该报价');
  q.approval = q.approval_id ? approvalDetail(q.approval_id) : null;
  q.items = itemsOf(q.id, ctx.user);
  q.contract = one('select id, no, status from contracts where quotation_id=? order by id desc limit 1', q.id);
  return shapeQuote(q, ctx.user);
});

POST('/api/quotations', (ctx) => {
  if (!canModule(ctx.user, 'quotation')) throw denied('无权创建报价');
  const b = ctx.body || {};
  const op = one('select * from opportunities where id=?', b.opportunity_id);
  if (!op) throw bad('请选择商机');
  if (!canEditRecord(ctx.user, op)) throw denied('只能为自己负责的商机报价');
  if (['won', 'lost'].includes(op.stage)) throw bad('已结束的商机不能再报价');

  const normalized = normalizeItems(b.items, ctx.user);
  if (!normalized) throw bad('请至少添加一条报价明细（从产品库选择）');
  if (!(normalized.total > 0)) throw bad('报价总额必须大于 0');

  const validDays = getSettingNum('quote.valid_days') || 30;
  const no = `BJ${new Date().getFullYear()}${String(Date.now()).slice(-6)}`;

  const out = tx(() => {
    const r = run(
      `insert into quotations(no,opportunity_id,account_id,version,amount,list_amount,discount_rate,cost,valid_until,status,remark,has_custom,created_by,org_id,created_at,updated_at)
       values(?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?)`,
      no, op.id, op.account_id, Number(b.version || 1),
      normalized.total, normalized.listTotal, normalized.rate, normalized.costTotal,
      b.valid_until || today(validDays), b.remark || null, normalized.hasCustom,
      ctx.user.id, op.org_id, nowIso(), nowIso()
    );
    const qid = idOf(r);
    writeItems(qid, normalized.items);
    return qid;
  });

  return {
    id: out, no,
    discount_rate: normalized.rate,
    amount: normalized.total,
    list_amount: normalized.listTotal,
    has_custom: normalized.hasCustom,
  };
});

PATCH('/api/quotations/:id', (ctx) => {
  const q = one('select * from quotations where id=?', ctx.params.id);
  if (!q) throw notFound('报价单不存在');
  const op = one('select * from opportunities where id=?', q.opportunity_id);
  if (!canEditRecord(ctx.user, op)) throw denied('无权修改该报价');
  if (!['draft', 'rejected'].includes(q.status)) throw bad('只有草稿或已驳回的报价可以修改');
  const b = ctx.body || {};

  if (Array.isArray(b.items) && b.items.length) {
    const normalized = normalizeItems(b.items, ctx.user);
    if (!(normalized.total > 0)) throw bad('报价总额必须大于 0');
    tx(() => {
      writeItems(q.id, normalized.items);
      run(
        `update quotations set list_amount=?, amount=?, discount_rate=?, cost=?, valid_until=?, remark=?, has_custom=?, status='draft', updated_at=? where id=?`,
        normalized.listTotal, normalized.total, normalized.rate, normalized.costTotal,
        b.valid_until || q.valid_until, b.remark ?? q.remark, normalized.hasCustom, nowIso(), q.id
      );
    });
    return { ok: true, discount_rate: normalized.rate };
  }

  const listAmount = Number(b.list_amount ?? q.list_amount);
  const amount = Number(b.amount ?? q.amount);
  if (amount > listAmount) throw bad('成交金额不能高于标准价');
  const rate = listAmount ? (listAmount - amount) / listAmount : 0;
  run(
    `update quotations set list_amount=?, amount=?, discount_rate=?, cost=?, valid_until=?, remark=?, status='draft', updated_at=? where id=?`,
    listAmount, amount, rate, Number(b.cost ?? q.cost), b.valid_until || q.valid_until,
    b.remark ?? q.remark, nowIso(), q.id
  );
  return { ok: true, discount_rate: rate };
});

/** 提交报价：未折扣 → 免价格审批直接放行；有折扣 → 走折扣审批链 */
POST('/api/quotations/:id/submit', (ctx) => {
  const q = one('select * from quotations where id=?', ctx.params.id);
  if (!q) throw notFound('报价单不存在');
  const op = one('select * from opportunities where id=?', q.opportunity_id);
  if (!canEditRecord(ctx.user, op)) throw denied('无权提交该报价');
  if (q.status !== 'draft') throw bad('只有草稿状态的报价可以提交审批');
  const itemCount = one('select count(*) c from quotation_items where quotation_id=?', q.id).c;
  if (!itemCount) throw bad('报价明细为空，请重新选择产品');

  // 未让价（折扣率为 0）：价格无需审批，直接置为已批准，下一步即创建合同
  if (!priceApprovalRequired(q.discount_rate)) {
    tx(() => {
      run("update quotations set status='approved', approval_id=null, updated_at=? where id=?", nowIso(), q.id);
      run(
        `insert into activities(target_type,target_id,type,content,result,user_id,created_at)
         values('quotation', ?, 'note', ?, ?, ?, ?)`,
        q.id, '未折扣报价，按规则免价格审批，提交即通过（下一步：创建合同）',
        'approved', ctx.user.id, nowIso()
      );
    });
    return {
      ok: true,
      skipped: true,
      status: 'approved',
      discount_rate: q.discount_rate,
      next: 'contract',
      message: '未折扣，已免价格审批，可直接创建合同',
    };
  }

  if (!(q.cost > 0) && !q.has_custom) {
    throw bad('提交前请补充成本信息（用于计算毛利，仅经理及以上可见）');
  }

  const chain = chainForDiscount(q.discount_rate, op.org_id);
  const b = ctx.body || {};
  const resolved = applyAssignees(resolveChain(chain, op.org_id), b.assignees);
  if (resolved.missing.length) {
    throw bad(
      `审批链缺少审批人：${resolved.missing.map((m) => m.label).join('、')}。请先在「系统设置 → 用户与角色」里给该角色指定在职负责人，或在提交时手动选择`,
      resolved.missing.map((m) => `${m.label}：本组织链上没有在职的该角色`)
    );
  }
  const { approvalId } = createApproval({
    type: 'quote_discount',
    targetType: 'quotation',
    targetId: q.id,
    title: `报价折扣审批 · ${op.name}`,
    summary: [
      `${itemCount} 项明细，报价 ${Number(q.amount).toLocaleString()} 元`,
      `折扣 ${(q.discount_rate * 100).toFixed(2)}%`,
      q.has_custom ? '含产品库外例外项' : '',
    ].filter(Boolean).join('，'),
    amount: q.amount,
    applicantId: ctx.user.id,
    orgId: op.org_id,
    steps: resolved.steps,
  });
  run("update quotations set status='pending', approval_id=?, updated_at=? where id=?", approvalId, nowIso(), q.id);
  return { ok: true, approvalId, steps: resolved.steps.map((s) => ({ role: s.role, label: s.label, approver_id: s.approver_id, approver_name: s.approver_name })) };
});

/** 报价转合同（旧路径，等价于订单合同；前端已改走 /api/contracts） */
POST('/api/quotations/:id/to-contract', (ctx) => {
  const q = one('select * from quotations where id=?', ctx.params.id);
  if (!q) throw notFound('报价单不存在');
  if (q.status !== 'approved') throw bad('只有已批准的报价才能生成合同');
  const op = one('select * from opportunities where id=?', q.opportunity_id);
  if (!canEditRecord(ctx.user, op)) throw denied('无权操作该报价');
  const b = ctx.body || {};
  return createContractRecord(ctx.user, {
    kind: 'order',
    opportunity_id: q.opportunity_id,
    quotation_id: q.id,
    title: b.title,
    tax_rate: b.tax_rate,
    payment_terms: b.payment_terms,
    sign_date: b.sign_date,
    start_date: b.start_date,
  });
});

/* =========================================================
   报价单：生成对外链接 / 邮件 / 短信
   只有已批准（含零折扣免审批）的报价才能发给客户
   ========================================================= */

/** 取报价单 + 校验可见与状态 */
function sheetContext(ctx) {
  const data = loadQuoteSheet(ctx.params.id);
  if (!data) throw notFound('报价单不存在');
  const op = one('select * from opportunities where id=?', data.q.opportunity_id);
  if (!canEditRecord(ctx.user, op)) throw denied('无权查看该报价');
  return data;
}

GET('/api/quotations/:id/sheet', (ctx) => {
  const data = sheetContext(ctx);
  const token = ensureToken(data.q);
  const url = `${publicBase(ctx.req)}/q/${token}`;
  return {
    token,
    url,
    canSend: ['approved', 'converted'].includes(data.q.status),
    html: renderSheetHtml(data),
    contact: {
      name: data.contact.name || '',
      email: data.contact.email || '',
      phone: data.contact.phone || '',
    },
    ready: { email: isOn('mail.enabled'), sms: isOn('sms.enabled') },
    sends: all('select * from quote_sends where quotation_id=? order by id desc limit 20', data.q.id),
  };
});

GET('/api/quotations/:id/sends', (ctx) => {
  const data = sheetContext(ctx);
  return { rows: all('select * from quote_sends where quotation_id=? order by id desc limit 50', data.q.id) };
});

function mailHtml({ data, company, link, message, sender }) {
  const { q, items } = data;
  const total = Number(q.amount || 0);
  const rows = items.slice(0, 8).map((it) => `<tr>
    <td style="padding:7px 10px;border-bottom:1px solid #eceff5;font-size:13px;color:#1b1f27">${it.name}</td>
    <td style="padding:7px 10px;border-bottom:1px solid #eceff5;font-size:13px;color:#4b5563;text-align:center">${it.qty}${it.unit ? ` ${it.unit}` : ''}</td>
    <td style="padding:7px 10px;border-bottom:1px solid #eceff5;font-size:13px;color:#1b1f27;text-align:right">¥${Number(it.amount).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</td>
  </tr>`).join('');

  return `<div style="background:#f4f6fa;padding:24px 12px;font-family:'Microsoft YaHei',Arial,sans-serif">
  <div style="max-width:620px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e3e8f0">
    <div style="background:#2b4a8b;color:#fff;padding:18px 24px">
      <div style="font-size:15px;font-weight:700;letter-spacing:.5px">${company.name}</div>
      <div style="font-size:12px;opacity:.85;margin-top:3px">报价单 · ${q.no}</div>
    </div>
    <div style="padding:22px 24px">
      <div style="font-size:14px;color:#1b1f27">${data.contact.name || q.account_name}，您好：</div>
      <div style="font-size:13px;color:#4b5563;line-height:1.9;margin-top:8px">
        感谢贵司的信任。我们已根据前期沟通为您准备报价单 <b>${q.no}</b>，合计金额
        <b style="color:#b23a2f">¥${total.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</b>（含税），
        有效期至 <b>${String(q.valid_until || '').slice(0, 10)}</b>。
        ${Number(q.discount_rate) > 0.000001 ? `本单已含 ${(Number(q.discount_rate) * 100).toFixed(2)}% 优惠。` : ''}
      </div>
      <table style="width:100%;border-collapse:collapse;margin-top:14px">
        <thead><tr>
          <th style="text-align:left;padding:7px 10px;background:#f7f9fc;font-size:12px;color:#6b7280;font-weight:600">产品 / 服务</th>
          <th style="text-align:center;padding:7px 10px;background:#f7f9fc;font-size:12px;color:#6b7280;font-weight:600">数量</th>
          <th style="text-align:right;padding:7px 10px;background:#f7f9fc;font-size:12px;color:#6b7280;font-weight:600">金额</th>
        </tr></thead>
        <tbody>${rows}${items.length > 8 ? `<tr><td colspan="3" style="padding:7px 10px;font-size:12px;color:#6b7280">… 共 ${items.length} 项，完整明细请查看在线报价单</td></tr>` : ''}</tbody>
      </table>
      ${message ? `<div style="margin-top:14px;padding:11px 13px;background:#f7f9fc;border-left:3px solid #2b4a8b;font-size:12.5px;color:#374151;line-height:1.8;white-space:pre-wrap">${message}</div>` : ''}
      <div style="margin-top:18px;text-align:center">
        <a href="${link}" style="display:inline-block;padding:11px 26px;background:#2b4a8b;color:#fff;text-decoration:none;border-radius:6px;font-size:13.5px">查看完整报价单</a>
      </div>
      <div style="margin-top:14px;font-size:11.5px;color:#9aa1ad;line-height:1.8;text-align:center">
        若按钮无法点击，请复制链接在浏览器打开：<br/><span style="color:#2b4a8b">${link}</span>
      </div>
    </div>
    <div style="padding:14px 24px;background:#f7f9fc;font-size:11.5px;color:#8a93a3;line-height:1.8;border-top:1px solid #eceff5">
      ${sender ? `${sender}　` : ''}${company.name}<br/>
      ${company.address}<br/>电话：${company.phone}　税号：${company.taxNo}
    </div>
  </div>
</div>`;
}

POST('/api/quotations/:id/send', async (ctx) => {
  const data = sheetContext(ctx);
  const { q } = data;
  if (!['approved', 'converted'].includes(q.status)) {
    throw bad('报价需先通过审批（零折扣报价提交即通过）才能发送给客户');
  }
  const body = ctx.body || {};
  const channels = Array.isArray(body.channels) ? body.channels.filter((c) => ['email', 'sms'].includes(c)) : [];
  if (!channels.length) throw bad('请至少选择一种发送方式（邮件 / 短信）');

  const company = companyProfile();
  const token = ensureToken(q);
  const link = `${publicBase(ctx.req)}/q/${token}`;
  const message = String(body.message || '').trim().slice(0, 500);
  const email = String(body.email || data.contact.email || '').trim();
  const phone = String(body.phone || data.contact.phone || '').trim();

  if (channels.includes('email') && !email) throw bad('请填写收件邮箱（客户联系人未维护邮箱）');
  if (channels.includes('sms') && !phone) throw bad('请填写接收短信的手机号（客户联系人未维护手机号）');

  const results = [];

  if (channels.includes('email')) {
    const subject = `【报价单】${q.no} · ${company.shortName || company.name} → ${q.account_name}`;
    const html = mailHtml({ data, company, link, message, sender: data.q.owner_name });
    const r = await sendMail({ to: email, subject, html, text: `报价单 ${q.no}，合计 ¥${Number(q.amount).toLocaleString()}，查看：${link}` });
    const status = r.ok ? 'sent' : r.simulated ? 'simulated' : 'failed';
    run(
      `insert into quote_sends(quotation_id,channel,target,subject,content,status,provider,error,link,sent_by,created_at)
       values(?,?,?,?,?,?,?,?,?,?,?)`,
      q.id, 'email', email, subject, html, status, r.provider || '', r.error || null, link, ctx.user.id, nowIso()
    );
    results.push({ channel: 'email', target: email, status, error: r.error || null, provider: r.provider });
  }

  if (channels.includes('sms')) {
    const tpl = String(getSetting('sms.template') || '').replace(/\{\{(\w+)\}\}/g, (_, k) => ({
      company: company.shortName || company.name,
      no: q.no,
      amount: Number(q.amount).toLocaleString('zh-CN'),
      valid_until: String(q.valid_until || '').slice(0, 10),
      link,
      account: q.account_name,
    }[k] ?? ''));
    const content = `${getSetting('sms.sign') || ''}${tpl}`.slice(0, 480);
    const r = await sendSms({ phone, content });
    const status = r.ok ? 'sent' : r.simulated ? 'simulated' : 'failed';
    run(
      `insert into quote_sends(quotation_id,channel,target,subject,content,status,provider,error,link,sent_by,created_at)
       values(?,?,?,?,?,?,?,?,?,?,?)`,
      q.id, 'sms', phone, null, content, status, r.provider || '', r.error || null, link, ctx.user.id, nowIso()
    );
    results.push({ channel: 'sms', target: phone, status, error: r.error || null, provider: r.provider, content });
  }

  run(
    'update quotations set last_sent_at=?, send_count=coalesce(send_count,0)+1, updated_at=? where id=?',
    nowIso(), nowIso(), q.id
  );
  run(
    `insert into activities(target_type,target_id,type,content,result,user_id,created_at)
     values('quotation',?,'email',?,?,?,?)`,
    q.id,
    `发送报价单：${results.map((x) => `${x.channel === 'email' ? '邮件' : '短信'}→${x.target}（${x.status === 'sent' ? '成功' : x.status === 'simulated' ? '模拟' : '失败'}）`).join('，')}`,
    results.some((x) => x.status === 'failed') ? 'failed' : 'done',
    ctx.user.id, nowIso()
  );

  return { ok: true, url: link, results, token };
});
