import { api } from './api.js';
import { esc, toast, modal, badge } from './ui.js';
import { icon } from './icons.js';

/**
 * 提交审批的统一入口：先取审批链，明确「这一单会交给谁」，再提交。
 * - 免审批（如未折扣报价）：直接提交，不弹窗；
 * - 有审批：弹窗列出每一关的具体审批人，允许在候选人里改选；
 * - 找不到审批人：红字提示并禁止提交（不再静默跳过）。
 */
export async function openSubmitApproval({
  type, id, submitUrl, body = {}, intro, confirmText = '确认提交', onSubmitted,
}) {
  let preview;
  try {
    preview = await api.get(`/api/approvals/preview?type=${type}&id=${id}`);
  } catch (e) {
    return toast(e.message, 'err');
  }

  if (!preview.required) {
    try {
      const r = await api.post(submitUrl, body);
      toast(preview.reason || '已提交', 'ok');
      if (onSubmitted) onSubmitted(r, preview);
    } catch (e) {
      toast(e.message, 'err');
    }
    return undefined;
  }

  const missing = preview.missing || [];
  const rows = (preview.steps || []).map((s, i) => {
    const opts = (s.candidates || []).map((c) => `<option value="${c.id}" ${Number(c.id) === Number(s.approver_id) ? 'selected' : ''}>
      ${esc(c.name)}${c.title ? ` · ${esc(c.title)}` : ''}${c.org_name ? ` · ${esc(c.org_name)}` : ''}
    </option>`).join('');
    // 只有一个候选人时不必再放下拉框，避免与上方姓名重复
    const who = s.approver_id
      ? `<span class="ap-who">${esc(s.approver_name)}${s.approver_title ? ` · ${esc(s.approver_title)}` : ''}${s.approver_org ? ` · ${esc(s.approver_org)}` : ''}</span>`
      : `<span class="ap-who bad">未指定审批人</span>`;
    const multi = (s.candidates || []).length > 1;
    return `<div class="ap-step ${s.approver_id ? '' : 'bad'}">
      <div class="ap-idx">${i + 1}</div>
      <div class="ap-body">
        <div class="ap-head"><b>${esc(s.label)}</b>${badge(s.role, 'gray')}</div>
        ${multi ? '' : who}
        ${multi ? `<select class="select ap-pick" data-role-pick="${s.role}" style="margin-top:6px">${opts}</select>
          <div class="muted" style="font-size:11px;margin-top:4px">本组织该角色有 ${s.candidates.length} 位，可改派</div>` : ''}
      </div>
    </div>`;
  }).join('');

  modal({
    title: '提交审批 · 确认审批人',
    width: 520,
    body: `<div class="stack">
      ${intro ? `<div class="notice blue">${icon('info', 14)}<div>${intro}</div></div>` : ''}
      ${missing.length ? `<div class="notice red">${icon('warn', 14)}<div>
        审批链上缺少：<b>${missing.map((m) => esc(m.label)).join('、')}</b>。
        请先到「系统设置 → 用户与角色」给该角色指定在职负责人，否则单据会卡住。
      </div></div>` : ''}
      <div class="ap-list">${rows}</div>
      <div class="muted" style="font-size:12px">提交后按顺序审批，每一关通过才会流转到下一关；审批人可在上面下拉框调整为本组织的其他同角色同事。</div>
    </div>`,
    footer: `<button class="btn" data-c>取消</button>
      <button class="btn btn-primary" data-ok ${missing.length ? 'disabled' : ''}>${confirmText}</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      const ok = root.querySelector('[data-ok]');
      if (missing.length) { ok.onclick = () => toast('审批人未配齐，无法提交', 'err'); return; }
      ok.onclick = async () => {
        const assignees = {};
        root.querySelectorAll('[data-role-pick]').forEach((sel) => {
          assignees[sel.dataset.rolePick] = Number(sel.value);
        });
        ok.disabled = true;
        try {
          const r = await api.post(submitUrl, { ...body, assignees });
          const who = (r.steps || []).map((s) => `${s.label}：${s.approver_name || '—'}`).join('，');
          toast(who ? `已提交 → ${who}` : '已提交审批', 'ok');
          close();
          if (onSubmitted) onSubmitted(r, preview);
        } catch (e) {
          ok.disabled = false;
          toast(e.message, 'err');
        }
      };
    },
  });
  return undefined;
}
