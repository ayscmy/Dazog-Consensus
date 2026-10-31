import { one, all, run, tx, nowIso, idOf } from './db.js';
import { getSetting, getSettingNum } from './settings.js';

/* =========================================================
   审批规则（阈值来自系统设置，可在「系统设置 → 审批规则」里改）
   价格（折扣）：只有发生让价才审批。折扣率 0 → 免审批，直接进合同流程
                 有折扣：≤ 经理阈值 → 经理；超过 → 加总监；再超过 → 加总经理
   合同：金额/账期超阈值 → 加总监；再超 → 加法务
   单个审批人可在用户管理里设置「可批折扣」上限，覆盖角色默认阈值
   ========================================================= */

/** 折扣率容差：仅吸收金额四舍五入带来的浮点误差（0.0001%），真实让价一律走审批 */
export const NO_DISCOUNT_EPS = 0.000001;

/** 是否属于「未让价」——折扣率为 0（含浮点误差） */
export function isNoDiscount(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r)) return true;
  return Math.abs(r) <= NO_DISCOUNT_EPS;
}

/**
 * 报价是否需要走价格审批。
 * 系统开关关闭时，任何报价都要审批；开启时（默认），未折扣报价直接放行。
 */
export function priceApprovalRequired(rate) {
  if (getSetting('quote.skip_approval_when_no_discount') !== '1') return true;
  return !isNoDiscount(rate);
}

export function chainForDiscount(rate, orgId) {
  const pct = Number(rate) * 100;
  const chain = [{ role: 'manager', label: '部门经理' }];

  const mgr = orgId ? resolveApprover(orgId, 'manager') : null;
  const mgrLimit = mgr && mgr.discount_limit !== null && mgr.discount_limit !== undefined
    ? Number(mgr.discount_limit)
    : getSettingNum('approve.discount.manager');

  if (pct > mgrLimit) {
    chain.push({ role: 'director', label: '销售总监' });
    const dir = orgId ? resolveApprover(orgId, 'director') : null;
    const dirLimit = dir && dir.discount_limit !== null && dir.discount_limit !== undefined
      ? Number(dir.discount_limit)
      : getSettingNum('approve.discount.director');
    if (pct > dirLimit) chain.push({ role: 'gm', label: '总经理' });
  }
  return chain;
}

export function chainForContract({ amount, paymentTerms, nonStandard }) {
  const amtDir = getSettingNum('approve.contract.amount_director');
  const termDir = getSettingNum('approve.contract.terms_director');
  const amtLegal = getSettingNum('approve.contract.amount_legal');
  const termLegal = getSettingNum('approve.contract.terms_legal');

  const chain = [{ role: 'manager', label: '部门经理' }];
  if (amount > amtDir || paymentTerms > termDir) chain.push({ role: 'director', label: '销售总监' });
  chain.push({ role: 'finance', label: '财务审核' });
  if (amount > amtLegal || paymentTerms > termLegal || nonStandard) chain.push({ role: 'legal', label: '法务审核' });
  return chain;
}

/** 沿组织树向上找对应角色的审批人（取最近的一个） */
export function resolveApprover(orgId, role) {
  const list = approverCandidates(orgId, role);
  return list.length ? list[0] : null;
}

/**
 * 某角色在当前组织树中的**候选审批人**，由近及远：
 * 本部门 → 上级部门 → … → 集团；职能角色（财务/法务）没有组织归属时全局兜底。
 * 返回按"离申请人最近"排序的列表，供提交时指定具体审批人。
 */
export function approverCandidates(orgId, role) {
  const out = [];
  const seen = new Set();
  const push = (rows) => rows.forEach((r) => {
    if (!seen.has(r.id)) { seen.add(r.id); out.push({ ...r }); }
  });

  const org = orgId ? one('select path from org_units where id = ?', orgId) : null;
  if (org) {
    const ids = org.path.split('/').filter(Boolean).map(Number).reverse();
    for (const id of ids) {
      push(all(
        `select u.id, u.name, u.title, u.discount_limit, o.name as org_name, o.id as org_id
         from users u
         join user_roles r on r.user_id = u.id
         join org_units o on o.id = u.org_id
         where u.org_id = ? and r.role = ? and u.status = 'active'
         order by u.id`,
        id, role
      ));
    }
  }
  // 职能部门（财务/法务/总经理）可能挂在集团层，兜底全局
  if (!out.length) {
    push(all(
      `select u.id, u.name, u.title, u.discount_limit, o.name as org_name, o.id as org_id
       from users u
       join user_roles r on r.user_id = u.id
       join org_units o on o.id = u.org_id
       where r.role = ? and u.status = 'active'
       order by o.path, u.id
       limit 20`,
      role
    ));
  }
  return out;
}

/**
 * 把「角色链」解析成「具体到人」的步骤。
 * missing 里是找不到审批人的节点——提交前必须补齐，否则单据会卡在半空。
 */
export function resolveChain(chain, orgId) {
  const steps = [];
  const missing = [];
  chain.forEach((c, i) => {
    const candidates = approverCandidates(orgId, c.role);
    const first = candidates[0] || null;
    if (!first) missing.push({ role: c.role, label: c.label });
    steps.push({
      seq: i + 1,
      role: c.role,
      label: c.label,
      approver_id: first ? first.id : null,
      approver_name: first ? first.name : null,
      approver_title: first ? first.title : null,
      approver_org: first ? first.org_name : null,
      candidates,
    });
  });
  return { steps, missing };
}

/** 提交时按用户指定的人覆盖默认审批人（必须是该节点的合法候选人） */
export function applyAssignees(resolved, assignees) {
  if (!assignees || typeof assignees !== 'object') return resolved;
  const steps = resolved.steps.map((s) => {
    const wanted = assignees[s.role];
    if (!wanted) return s;
    const hit = s.candidates.find((c) => Number(c.id) === Number(wanted));
    return hit
      ? { ...s, approver_id: hit.id, approver_name: hit.name, approver_title: hit.title, approver_org: hit.org_name }
      : s;
  });
  const missing = steps.filter((s) => !s.approver_id).map((s) => ({ role: s.role, label: s.label }));
  return { steps, missing };
}

/** 把解析结果落成 approval_steps 行（不再静默跳过：缺人由上层拦截） */
export function buildSteps(chain, orgId) {
  return resolveChain(chain, orgId).steps.map((s) => ({
    seq: s.seq,
    role: s.role,
    label: s.label,
    approver_id: s.approver_id,
    decision: s.approver_id ? 'pending' : 'skipped',
    comment: s.approver_id ? null : '未找到对应审批人，自动跳过',
    decided_at: s.approver_id ? null : nowIso(),
  }));
}

export function createApproval({ type, targetType, targetId, title, summary, amount, applicantId, orgId, chain, steps }) {
  const rows = steps
    ? steps.map((s, i) => ({
        seq: i + 1,
        role: s.role,
        label: s.label,
        approver_id: s.approver_id,
        decision: s.approver_id ? 'pending' : 'skipped',
        comment: s.approver_id ? (s.comment || null) : '未找到对应审批人，自动跳过',
        decided_at: s.approver_id ? null : nowIso(),
      }))
    : buildSteps(chain, orgId);
  const firstPending = rows.find((s) => s.decision === 'pending');
  const approvalId = tx(() => {
    const r = run(
      `insert into approvals(type,target_type,target_id,title,summary,amount,status,current_step,total_steps,applicant_id,org_id,created_at)
       values(?,?,?,?,?,?,?,?,?,?,?,?)`,
      type, targetType, targetId, title, summary, amount, 'pending',
      firstPending ? firstPending.seq : 1, rows.length, applicantId, orgId, nowIso()
    );
    const aid = idOf(r);
    for (const s of rows) {
      run(
        `insert into approval_steps(approval_id,seq,role,label,approver_id,decision,comment,decided_at)
         values(?,?,?,?,?,?,?,?)`,
        aid, s.seq, s.role, s.label, s.approver_id, s.decision, s.comment, s.decided_at
      );
    }
    return aid;
  });
  return { approvalId, steps: rows };
}

/** 审批决策：approved / rejected */
export function decide(approvalId, user, decision, comment) {
  return tx(() => {
    const ap = one('select * from approvals where id = ?', approvalId);
    if (!ap) return { error: '审批不存在' };
    if (ap.status !== 'pending') return { error: '该审批已结束' };

    const step = one(
      'select * from approval_steps where approval_id = ? and seq = ?',
      approvalId, ap.current_step
    );
    if (!step) return { error: '审批节点异常' };
    if (Number(step.approver_id) !== Number(user.id) && user.role !== 'admin') {
      return { error: '当前节点不由你审批' };
    }

    run(
      'update approval_steps set decision = ?, comment = ?, decided_at = ? where id = ?',
      decision, comment || null, nowIso(), step.id
    );

    if (decision === 'rejected') {
      run('update approvals set status = ?, finished_at = ? where id = ?', 'rejected', nowIso(), approvalId);
      applyBusiness(ap, 'rejected', comment);
      return { ok: true, status: 'rejected' };
    }

    // 找下一个待审批节点
    const next = one(
      `select * from approval_steps where approval_id = ? and seq > ? and decision = 'pending' order by seq limit 1`,
      approvalId, step.seq
    );
    if (!next) {
      run('update approvals set status = ?, finished_at = ? where id = ?', 'approved', nowIso(), approvalId);
      applyBusiness(ap, 'approved', comment);
      return { ok: true, status: 'approved' };
    }
    run('update approvals set current_step = ? where id = ?', next.seq, approvalId);
    return { ok: true, status: 'pending', nextStep: next.seq };
  });
}

function applyBusiness(ap, result, comment) {
  if (ap.type === 'quote_discount') {
    run(
      'update quotations set status = ?, updated_at = ? where id = ?',
      result === 'approved' ? 'approved' : 'rejected', nowIso(), ap.target_id
    );
    run(
      `insert into activities(target_type,target_id,type,content,result,user_id,created_at)
       values('quotation', ?, 'note', ?, ?, ?, ?)`,
      ap.target_id,
      result === 'approved' ? '报价折扣审批通过' : '报价折扣审批驳回',
      comment || '', ap.applicant_id, nowIso()
    );
  }

  if (ap.type === 'contract') {
    if (result === 'approved') {
      const c = one('select * from contracts where id = ?', ap.target_id);
      run(
        "update contracts set status = 'active', activated_at = ?, sign_date = coalesce(sign_date, ?), updated_at = ? where id = ?",
        nowIso(), new Date().toISOString().slice(0, 10), nowIso(), ap.target_id
      );
      createPaymentPlans(c);
      if (c.opportunity_id) {
        run(
          "update opportunities set stage = 'won', probability = 100, won_at = ?, contract_id = ?, updated_at = ? where id = ? and stage != 'won'",
          nowIso(), c.id, nowIso(), c.opportunity_id
        );
      }
    } else {
      run("update contracts set status = 'rejected', updated_at = ? where id = ?", nowIso(), ap.target_id);
    }
  }
}

/** 合同生效时按账期生成回款计划 */
export function createPaymentPlans(contract) {
  const exists = one('select count(*) c from payment_plans where contract_id = ?', contract.id).c;
  if (exists) return;
  const base = new Date(contract.sign_date || Date.now());
  const amounts =
    contract.amount > 500000
      ? [0.4, 0.4, 0.2]
      : contract.amount > 200000
      ? [0.5, 0.5]
      : [1];
  amounts.forEach((ratio, i) => {
    const due = new Date(base.getTime() + ((i + 1) * contract.payment_terms * 86400000) / amounts.length);
    run(
      'insert into payment_plans(contract_id,seq,due_date,amount,ratio,status) values(?,?,?,?,?,?)',
      contract.id, i + 1, due.toISOString().slice(0, 10), Math.round(contract.amount * ratio), ratio, 'pending'
    );
  });
}

/* ---------------- 待办查询 ---------------- */

export function pendingFor(user) {
  const base = `
    select a.*, s.seq, s.label as step_label, s.role as step_role,
           u.name as applicant_name, o.name as org_name
    from approvals a
    join approval_steps s on s.approval_id = a.id and s.seq = a.current_step
    left join users u on u.id = a.applicant_id
    left join org_units o on o.id = a.org_id
    where a.status = 'pending' and s.decision = 'pending'
      and (s.approver_id = ? or ? = 1)
    order by a.created_at desc`;
  return all(base, user.id, user.role === 'admin' ? 1 : 0);
}

export function pendingCount(user) {
  const r = one(
    `select count(*) c from approvals a
     join approval_steps s on s.approval_id = a.id and s.seq = a.current_step
     where a.status = 'pending' and s.decision = 'pending' and (s.approver_id = ? or ? = 1)`,
    user.id, user.role === 'admin' ? 1 : 0
  );
  return r ? r.c : 0;
}

export function approvalDetail(id) {
  const ap = one(
    `select a.*, u.name as applicant_name, o.name as org_name
     from approvals a left join users u on u.id = a.applicant_id
     left join org_units o on o.id = a.org_id where a.id = ?`,
    id
  );
  if (!ap) return null;
  ap.steps = all(
    `select s.*, u.name as approver_name from approval_steps s
     left join users u on u.id = s.approver_id where s.approval_id = ? order by s.seq`,
    id
  );
  return ap;
}
