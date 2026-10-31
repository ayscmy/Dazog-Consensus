import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 金额：1,234,567 元；大额在 KPI 用万/亿 */
export function amount(n) {
  const v = Number(n || 0);
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}
export function money(n) {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(v >= 1e6 ? 0 : 1)} 万`;
  return amount(v);
}
export function pct(n, digits = 0) {
  return `${(Number(n || 0) * 100).toFixed(digits)}%`;
}

export function date(s) {
  if (!s) return '—';
  return String(s).slice(0, 10);
}
export function dateTime(s) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s).slice(0, 16).replace('T', ' ');
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function relTime(s) {
  if (!s) return '';
  const d = new Date(s);
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const dd = Math.floor(h / 24);
  if (dd < 30) return `${dd} 天前`;
  return date(s);
}
export function daysFromNow(s) {
  if (!s) return null;
  const d = new Date(String(s).slice(0, 10));
  return Math.round((d.getTime() - new Date(new Date().toISOString().slice(0, 10)).getTime()) / 86400000);
}
export function dueText(s) {
  const d = daysFromNow(s);
  if (d === null) return '—';
  if (d < 0) return `逾期 ${-d} 天`;
  if (d === 0) return '今天到期';
  if (d <= 7) return `${d} 天后`;
  return date(s);
}

export function initials(name) {
  const s = String(name || '?');
  return s.length <= 2 ? s : s.slice(-2);
}

const TONES = { blue: 'badge-blue', green: 'badge-green', amber: 'badge-amber', red: 'badge-red', violet: 'badge-violet', gray: 'badge-gray' };
export function badge(text, tone = 'gray', dot = false) {
  return `<span class="badge ${TONES[tone] || 'badge-gray'}">${dot ? '<i class="dot"></i>' : ''}${esc(text)}</span>`;
}

/** 状态 → 颜色 */
export function statusTone(status) {
  return {
    new: 'gray', contacted: 'blue', qualified: 'amber', converted: 'green', invalid: 'red',
    lead_in: 'gray', needs: 'blue', proposal: 'violet', negotiation: 'amber', won: 'green', lost: 'red',
    draft: 'gray', pending: 'amber', approved: 'green', rejected: 'red', expired: 'gray',
    sales_review: 'blue', finance_review: 'violet', legal_review: 'amber',
    active: 'green', completed: 'gray', terminated: 'red',
    applied: 'amber', issued: 'green', void: 'gray',
    pending_plan: 'gray', received: 'green', overdue: 'red',
  }[status] || 'gray';
}

/* ---------------- Toast ---------------- */
export function toast(msg, type = '') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(-4px)';
    setTimeout(() => el.remove(), 220);
  }, type === 'err' ? 3800 : 2400);
}

/* ---------------- 模态（支持多层叠加，子弹窗不会顶掉父弹窗） ---------------- */
// 记录每一层弹窗的关闭函数，父弹窗关闭时好把上面的子弹窗一起收掉
const modalClosers = new WeakMap();

export function modal({ title, body, footer, width = 520, onMount }) {
  const host = document.getElementById('modal');
  const layer = document.createElement('div');
  layer.className = 'overlay';
  layer.innerHTML = `
      <div class="modal" style="width:${width}px">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button class="icon-btn" data-close>${icon('close', 14)}</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>`;
  host.appendChild(layer);

  let closed = false;
  // Esc 只关最上层，避免父弹窗跟着一起关掉
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    const layers = host.querySelectorAll('.overlay');
    if (layers[layers.length - 1] !== layer) return;
    e.stopPropagation();
    close();
  };
  const teardown = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    modalClosers.delete(layer);
    layer.remove();
  };
  const close = () => {
    const layers = [...host.querySelectorAll('.overlay')];
    const idx = layers.indexOf(layer);
    // 关掉自己，以及叠在自己上层的子弹窗，避免留下孤儿弹窗
    if (idx >= 0) {
      layers.slice(idx).forEach((n) => {
        const fn = modalClosers.get(n);
        if (fn) fn();
        else n.remove();
      });
    }
    teardown();
  };
  modalClosers.set(layer, teardown);
  document.addEventListener('keydown', onKey, true);

  layer.querySelector('[data-close]').onclick = close;
  layer.addEventListener('click', (e) => { if (e.target === layer) close(); });
  if (onMount) onMount(layer, close);
  return { root: layer, close };
}

export function confirmBox(title, message, danger = false) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      width: 420,
      body: `<div style="font-size:13px;line-height:1.65;color:var(--ink-2)">${esc(message)}</div>`,
      footer: `<button class="btn" data-c>取消</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>确定</button>`,
      onMount(root, close) {
        root.querySelector('[data-c]').onclick = () => { close(); resolve(false); };
        root.querySelector('[data-ok]').onclick = () => { close(); resolve(true); };
      },
    });
    void m;
  });
}

/** 缺项提示 */
export function blockList(title, items) {
  modal({
    title,
    width: 460,
    body: `<div class="notice red" style="margin-bottom:10px">${icon('warn', 14)}
      <div>以下条件未满足，暂时无法继续：</div></div>
      <ul style="margin:0;padding-left:18px;font-size:12.5px;line-height:1.9;color:var(--ink-2)">
        ${items.map((i) => `<li>${esc(i)}</li>`).join('')}
      </ul>`,
    footer: '<button class="btn" data-c>知道了</button>',
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
    },
  });
}

/* ---------------- 抽屉 ---------------- */
export function openDrawer(html, { onMount } = {}) {
  const box = document.getElementById('drawer');
  box.innerHTML = `<div class="drawer-wrap">
      <div class="drawer-mask" data-mask></div>
      <div class="drawer">${html}</div>
    </div>`;
  const close = () => { box.innerHTML = ''; document.body.style.overflow = ''; };
  box.querySelector('[data-mask]').onclick = close;
  const esc_ = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc_); } };
  document.addEventListener('keydown', esc_);
  if (onMount) onMount(box, close);
  return close;
}

/* ---------------- 审批链 ---------------- */
export function approvalTimeline(ap) {
  if (!ap) return '<div class="muted" style="font-size:12.5px">尚未提交审批</div>';
  return `<div class="timeline">
    <div class="tl-item">
      <div class="tl-dot ok"></div>
      <div class="tl-main">
        <div class="h">提交申请 <span class="muted" style="font-size:11px;font-weight:400">${relTime(ap.created_at)}</span></div>
        <div class="m">${esc(ap.applicant_name || '')} · ${esc(ap.org_name || '')}</div>
      </div>
    </div>
    ${(ap.steps || []).map((s) => {
      const cls = s.decision === 'approved' ? 'ok' : s.decision === 'rejected' ? 'rej' : (s.seq === ap.current_step && ap.status === 'pending' ? 'on' : '');
      const mark = s.decision === 'approved' ? '已通过' : s.decision === 'rejected' ? '已驳回' : s.decision === 'skipped' ? '自动跳过' : '待审批';
      return `<div class="tl-item">
        <div class="tl-dot ${cls}"></div>
        <div class="tl-main">
          <div class="h">${esc(s.label)} <span class="badge ${s.decision === 'approved' ? 'badge-green' : s.decision === 'rejected' ? 'badge-red' : 'badge-amber'}">${mark}</span>
            ${s.decided_at ? `<span class="muted" style="font-size:11px;font-weight:400">${relTime(s.decided_at)}</span>` : ''}</div>
          <div class="m">${esc(s.approver_name || '未指定')}${s.comment ? ` · ${esc(s.comment)}` : ''}</div>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

/* ---------------- 表单读取 ---------------- */
export function formData(root) {
  const out = {};
  root.querySelectorAll('[name]').forEach((el) => {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
    else out[el.name] = el.value;
  });
  return out;
}

export function field(label, name, { type = 'text', value = '', options = null, placeholder = '', full = false, required = false, min, step, hint = '' } = {}) {
  if (options) {
    return `<div class="field ${full ? 'full' : ''}">
      <label>${esc(label)}${required ? ' *' : ''}</label>
      <select class="select" name="${name}">
        ${options.map((o) => `<option value="${esc(o.value ?? o.key ?? o)}" ${String(o.value ?? o.key ?? o) === String(value) ? 'selected' : ''}>${esc(o.label ?? o)}</option>`).join('')}
      </select>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
    </div>`;
  }
  if (type === 'textarea') {
    return `<div class="field ${full ? 'full' : ''}">
      <label>${esc(label)}${required ? ' *' : ''}</label>
      <textarea class="textarea" name="${name}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>
      ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
    </div>`;
  }
  return `<div class="field ${full ? 'full' : ''}">
    <label>${esc(label)}${required ? ' *' : ''}</label>
    <input class="input" type="${type}" name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}"
      ${min !== undefined ? `min="${min}"` : ''} ${step ? `step="${step}"` : ''} />
    ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
  </div>`;
}
