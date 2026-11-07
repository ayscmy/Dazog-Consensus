import { api, qs } from '../api.js';
import { state, labels, userName, isManager } from '../store.js';
import { icon } from '../icons.js';
import {
  esc, dateTime, relTime, badge, statusTone, toast, modal, field, formData, confirmBox,
} from '../ui.js';

/**
 * 线索公海页面（一期，docs/20 第 3.4 / 11.2 节）
 *
 * 对应接口：
 *   GET  /api/leads/pool            池内线索 + 统计
 *   GET  /api/leads/pool/rules      当前生效规则（停用也返回，用于横幅）
 *   GET  /api/leads/pool/events     审计轨迹
 *   POST /api/leads/pool/:id/claim  领取
 *   POST /api/leads/pool/:id/assign 分配（经理）
 *   POST /api/leads/pool/:id/reclaim 强制回收（经理）
 *
 * 注意：/api/leads/pool 在「线索公海已停用」时抛 POOL_DISABLED，
 * 这里用 allSettled 单独兜住，避免整页加载失败、规则与轨迹仍可读。
 */

const MANAGER = () => isManager();

const ACTION_LABEL = {
  claim: '领取', assign: '分配', release: '主动放回', reclaim: '强制回收',
  auto_reclaim: '超时自动回池', api_in: 'API 入池',
};
const ACTION_TONE = {
  claim: 'green', assign: 'blue', release: 'amber', reclaim: 'red',
  auto_reclaim: 'amber', api_in: 'violet',
};
const REASON_LABEL = {
  api: '外部 API 入池', release: '主动放回', reclaim: '经理回收',
  first_touch_timeout: '首触超时', timeout: '跟进超时', auto_reclaim: '自动回收',
};

const num = (v) => (v === undefined || v === null ? '—' : v);

function reasonText(v) {
  if (!v) return '—';
  return REASON_LABEL[v] || v;
}

function pickSources() {
  return (state.dict.sources || []).map((s) => ({ value: s, label: s }));
}
function pickIndustries() {
  return (state.dict.industries || []).map((s) => ({ value: s, label: s }));
}
function pickOrgs() {
  return state.orgs.map((o) => ({ value: o.id, label: o.name }));
}
function pickUsers() {
  // 后端 assignLead 会再校验 status === 'active'，这里先过滤明显停用的成员
  return state.users
    .filter((u) => !['inactive', 'disabled', 'frozen'].includes(String(u.status || '').toLowerCase()))
    .map((u) => ({ value: u.id, label: `${u.name}${u.title ? '（' + u.title + '）' : ''}` }));
}

export async function render(el, route, ctx) {
  const q = route.query || {};
  const tab = q.tab === 'events' ? 'events' : 'list';
  const manager = MANAGER();

  const listQuery = {};
  ['q', 'source', 'industry', 'org'].forEach((k) => { if (q[k]) listQuery[k] = q[k]; });
  const eventQuery = { limit: 200 };
  if (q.eventLead) eventQuery.leadId = q.eventLead;

  const [pRes, rRes, eRes] = await Promise.allSettled([
    api.get(`/api/leads/pool${qs(listQuery)}`),
    api.get('/api/leads/pool/rules'),
    api.get(`/api/leads/pool/events${qs(eventQuery)}`),
  ]);

  const pool = pRes.status === 'fulfilled' ? pRes.value : null;
  const rows = pool?.rows || [];
  const s = pool?.stats || {};
  const rules = rRes.status === 'fulfilled' ? rRes.value.rules : null;
  const events = eRes.status === 'fulfilled' ? (eRes.value.rows || []) : [];
  const poolErr = pRes.status === 'rejected' ? pRes.reason : null;
  const disabled = poolErr?.detail?.code === 'POOL_DISABLED';
  const fatal = poolErr && !disabled ? poolErr.message : null;
  const usable = !disabled && !fatal;

  const ruleLine = rules ? [
    `首触 ${rules.firstTouchHours}h 提醒 / ${rules.firstTouchReclaimHours}h 回池`,
    `无有效跟进 ${rules.reclaimDays} 天回池`,
    `保护 ${rules.protectDays} 天`,
    `在库上限 ${rules.holdLimit} 条`,
    `每周领取 ${rules.weeklyLimit} 条`,
    `自动回收 ${rules.autoReclaim ? '开' : '关'}`,
  ].join('　·　') : '';

  el.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1>线索公海</h1>
        <div class="desc">未认领、主动放回或超时回收的线索在此重新分配；领取后归个人跟进，无效与已转化线索永不回池</div>
      </div>
      <div class="actions">
        <button class="btn" data-refresh>${icon('search', 13)} 刷新</button>
        ${manager && usable ? `<button class="btn" data-reclaim-tool>${icon('warn', 13)} 强制回收</button>` : ''}
      </div>
    </div>

    ${disabled ? `<div class="notice amber" style="margin-bottom:12px">${icon('info', 14)}
      <div><b>线索公海已停用。</b>请在「系统设置 → 公共池规则」中开启后使用；已有池内数据与审计记录会保留。</div></div>` : ''}
    ${fatal ? `<div class="notice red" style="margin-bottom:12px">${icon('warn', 14)}
      <div><b>公共池加载失败：</b>${esc(fatal)}</div></div>` : ''}

    ${rules ? `<div class="panel" style="margin-bottom:12px">
      <div class="panel-head"><h3>当前规则</h3>
        <span class="badge ${rules.enabled ? 'badge-green' : 'badge-gray'}">${rules.enabled ? '已启用' : '已停用'}</span>
      </div>
      <div class="panel-body" style="padding:10px 14px">
        <div class="muted" style="font-size:12.5px">${esc(ruleLine)}</div>
      </div>
    </div>` : ''}

    <div class="kpis">
      <div class="kpi"><div class="lb">池内待领</div><div class="vl">${num(s.poolTotal)}</div><div class="sb">组织内可见的公海线索</div></div>
      <div class="kpi"><div class="lb">我在库</div><div class="vl">${num(s.myHeld)}</div><div class="sb">上限 ${num(s.holdLimit)} 条</div></div>
      <div class="kpi"><div class="lb">本周已领</div><div class="vl">${num(s.weeklyClaimed)}</div><div class="sb">上限 ${num(s.weeklyLimit)} 条 / 周</div></div>
      <div class="kpi"><div class="lb">即将回池</div><div class="vl">${num(s.reclaimSoon)}</div><div class="sb">我名下需尽快跟进的线索</div></div>
    </div>

    <div class="toolbar">
      <input class="input" id="q" placeholder="搜索线索名称 / 联系人 / 电话" value="${esc(q.q || '')}" style="width:220px" />
      <select class="select" id="fSource">
        <option value="">全部来源</option>
        ${pickSources().map((o) => `<option value="${esc(o.value)}" ${q.source === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>
      <select class="select" id="fIndustry">
        <option value="">全部行业</option>
        ${pickIndustries().map((o) => `<option value="${esc(o.value)}" ${q.industry === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>
      ${manager ? `<select class="select" id="fOrg">
        <option value="">全部组织</option>
        ${pickOrgs().map((o) => `<option value="${esc(o.value)}" ${String(q.org) === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>` : ''}
      <div class="grow"></div>
      <span class="muted" style="font-size:12px">共 ${rows.length} 条</span>
      <button class="btn btn-sm ${tab === 'list' ? 'btn-primary' : ''}" data-tab="list">池中线索</button>
      <button class="btn btn-sm ${tab === 'events' ? 'btn-primary' : ''}" data-tab="events">操作记录</button>
    </div>

    <div data-pane="list" class="listwrap" ${tab === 'list' ? '' : 'style="display:none"'}>
      <div class="tablewrap">
        <table class="grid">
          <thead><tr>
            <th style="min-width:190px">线索 / 联系人</th>
            <th>来源 / 行业</th>
            <th style="min-width:170px">需求</th>
            <th>状态</th>
            <th>入池原因</th>
            <th>次数</th>
            <th>入池时间</th>
            <th>所属组织</th>
            <th style="min-width:190px">操作</th>
          </tr></thead>
          <tbody>
            ${rows.length ? rows.map((l) => `<tr data-id="${l.id}">
              <td>
                <div class="cell-main">${esc(l.name)}</div>
                <div class="cell-sub">${esc(l.contact_name || '未填联系人')}${l.contact_phone ? ' · ' + esc(l.contact_phone) : ''}</div>
              </td>
              <td><span class="badge badge-gray">${esc(l.source || '—')}</span><div class="cell-sub">${esc(l.industry || '—')}</div></td>
              <td><div style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-2)">${esc(l.demand || '—')}</div></td>
              <td>${badge(labels.leadStatus[l.status] || l.status, statusTone(l.status))}</td>
              <td class="nowrap">${esc(reasonText(l.pool_reason))}</td>
              <td class="nowrap">${num(l.pool_count || 1)}</td>
              <td class="nowrap" title="${esc(dateTime(l.pool_at || l.created_at))}">${relTime(l.pool_at || l.created_at)}</td>
              <td class="nowrap">${esc(l.org_name || '—')}</td>
              <td class="nowrap">
                ${usable ? `<button class="btn btn-sm btn-primary" data-claim="${l.id}">领取</button>` : ''}
                ${usable && manager ? `<button class="btn btn-sm" data-assign="${l.id}" data-name="${esc(l.name)}">分配</button>` : ''}
                <button class="btn btn-sm" data-events="${l.id}">轨迹</button>
              </td>
            </tr>`).join('') : `<tr><td colspan="9"><div class="empty">
              <strong>${disabled ? '线索公海已停用' : fatal ? '暂时无法加载' : '公共池里暂时没有线索'}</strong>
              <span>${disabled || fatal ? '按上方提示处理后刷新' : '外部 API 入池、成员主动放回或超时回收后，线索会出现在这里'}</span>
            </div></td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

    <div data-pane="events" class="listwrap" ${tab === 'events' ? '' : 'style="display:none"'}>
      <div class="toolbar" style="margin:0 0 10px;padding:8px 10px">
        <input class="input" id="eventLead" placeholder="按线索 ID 过滤（回车）" value="${esc(q.eventLead || '')}" style="width:220px" />
        ${q.eventLead ? `<button class="btn btn-sm" data-clear-event>清除过滤</button>` : ''}
        <div class="grow"></div>
        <span class="muted" style="font-size:12px">共 ${events.length} 条记录</span>
      </div>
      <div class="tablewrap">
        <table class="grid">
          <thead><tr>
            <th style="min-width:110px">时间</th>
            <th style="min-width:180px">线索</th>
            <th>动作</th>
            <th style="min-width:150px">原因</th>
            <th>从</th>
            <th>到</th>
            <th>操作人</th>
          </tr></thead>
          <tbody>
            ${events.length ? events.map((e) => `<tr>
              <td class="nowrap" title="${esc(dateTime(e.created_at))}">${relTime(e.created_at)}</td>
              <td><div class="cell-main">${esc(e.lead_name || ('#' + e.lead_id))}</div><div class="cell-sub mono">#${e.lead_id}</div></td>
              <td>${badge(ACTION_LABEL[e.action] || e.action, ACTION_TONE[e.action] || 'gray')}</td>
              <td>${esc(reasonText(e.reason))}</td>
              <td class="nowrap">${e.from_owner ? esc(userName(e.from_owner)) : '<span class="muted">公海</span>'}</td>
              <td class="nowrap">${e.to_owner ? esc(userName(e.to_owner)) : '<span class="muted">公海</span>'}</td>
              <td class="nowrap">${esc(e.actor_name || '系统')}</td>
            </tr>`).join('') : `<tr><td colspan="7"><div class="empty">
              <strong>暂无公海流转记录</strong><span>领取、分配、放回与回收都会在此留痕</span></div></td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  </div>`;

  const go = (patch) => {
    const next = { ...q, ...patch };
    const p = new URLSearchParams();
    Object.entries(next).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') p.set(k, v);
    });
    location.hash = `#/pool${p.toString() ? '?' + p.toString() : ''}`;
  };

  el.querySelector('[data-refresh]').onclick = () => ctx.refresh();
  el.querySelector('#q').onkeydown = (e) => { if (e.key === 'Enter') go({ q: e.target.value.trim() }); };
  el.querySelector('#fSource').onchange = (e) => go({ source: e.target.value });
  el.querySelector('#fIndustry').onchange = (e) => go({ industry: e.target.value });
  const fo = el.querySelector('#fOrg');
  if (fo) fo.onchange = (e) => go({ org: e.target.value });

  el.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => go({ tab: b.dataset.tab });
  });

  const evInput = el.querySelector('#eventLead');
  evInput.onkeydown = (e) => {
    if (e.key === 'Enter') go({ eventLead: e.target.value.trim(), tab: 'events' });
  };
  const clearEv = el.querySelector('[data-clear-event]');
  if (clearEv) clearEv.onclick = () => go({ eventLead: '', tab: 'events' });

  el.querySelectorAll('[data-claim]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); doClaim(b.dataset.claim, ctx); };
  });
  el.querySelectorAll('[data-assign]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); openAssign(b.dataset.assign, b.dataset.name, ctx); };
  });
  el.querySelectorAll('[data-events]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); go({ eventLead: b.dataset.events, tab: 'events' }); };
  });
  const rt = el.querySelector('[data-reclaim-tool]');
  if (rt) rt.onclick = () => openReclaimTool(ctx);
}

/* ---------------- 领取 ---------------- */
async function doClaim(id, ctx) {
  const ok = await confirmBox('领取线索', '领取后该线索归你负责并重新开始计算跟进时钟；超时未跟进会自动放回公海。确认领取？');
  if (!ok) return;
  try {
    await api.post(`/api/leads/pool/${id}/claim`);
    toast('已领取，去「线索」里跟进吧', 'ok');
    ctx.refresh();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---------------- 分配（经理） ---------------- */
function openAssign(id, name, ctx) {
  const users = pickUsers();
  if (!users.length) return toast('没有可分配的在职成员', 'err');
  modal({
    title: `分配线索：${name || '#' + id}`,
    width: 440,
    body: `<div class="stack">
      <div class="notice" style="margin-bottom:4px">${icon('info', 14)}
        <div>分配后线索直接挂到该成员名下并重置跟进时钟，不计入你自己的每周领取额度。</div>
      </div>
      ${field('目标负责人', 'owner_id', { options: users, required: true })}
    </div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>确认分配</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      root.querySelector('[data-ok]').onclick = async () => {
        const d = formData(root);
        if (!d.owner_id) return toast('请选择目标负责人', 'err');
        const ok = await confirmBox('确认分配', `确认把线索「${name || '#' + id}」分配给所选成员？`);
        if (!ok) return;
        try {
          const r = await api.post(`/api/leads/pool/${id}/assign`, { owner_id: Number(d.owner_id) });
          toast(`已分配给 ${r.ownerName || '该成员'}`, 'ok');
          close();
          ctx.refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    },
  });
}

/* ---------------- 强制回收（经理，二次确认） ---------------- */
function openReclaimTool(ctx) {
  modal({
    title: '强制回收线索',
    width: 470,
    body: `<div class="stack">
      <div class="notice red" style="margin-bottom:4px">${icon('warn', 14)}
        <div>把<strong>他人名下</strong>未转化、未判无效的线索收回公海，原负责人将失去该线索。操作会写入审计轨迹，请谨慎使用。</div>
      </div>
      ${field('线索 ID', 'lead_id', { type: 'number', required: true, placeholder: '可在线索列表 / 详情 URL 中找到' })}
      ${field('回收原因', 'reason', { type: 'textarea', required: true, placeholder: '例如：长期未跟进、离职交接、重复认领' })}
    </div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn btn-danger" data-ok>下一步</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      root.querySelector('[data-ok]').onclick = async () => {
        const d = formData(root);
        if (!d.lead_id) return toast('请填写线索 ID', 'err');
        if (!d.reason) return toast('请填写回收原因', 'err');
        const ok = await confirmBox(
          '确认强制回收',
          `将把线索 #${d.lead_id} 收回公共池，原负责人立即失去该线索，且此操作不可撤销（只能由成员重新领取）。确认继续？`,
          true,
        );
        if (!ok) return;
        try {
          await api.post(`/api/leads/pool/${d.lead_id}/reclaim`, { reason: d.reason });
          toast('已回收到公共池', 'ok');
          close();
          ctx.refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    },
  });
}
