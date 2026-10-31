import { api } from '../api.js';
import { state, labels, can } from '../store.js';
import { icon } from '../icons.js';
import {
  esc, money, date, dueText, relTime, badge, statusTone, toast, modal, field, formData,
  openDrawer, blockList, confirmBox, dateTime,
} from '../ui.js';

const EMPTY_FORM = {
  name: '', contact_name: '', contact_title: '', contact_phone: '', contact_email: '',
  source: '官网', industry: '装备制造', region: '华东', demand: '', budget: '50-100万',
  purchase_time: '', next_date: '', next_action: '首次电话沟通', owner_id: '',
};

function statusOptions() {
  return (state.dict.leadStatus || []).map((s) => ({ value: s.key, label: s.label }));
}
function srcOptions() {
  return (state.dict.sources || []).map((s) => ({ value: s, label: s }));
}
function pickUsers() {
  return state.users.map((u) => ({ value: u.id, label: `${u.name}（${u.title || ''}）` }));
}

export async function render(el, route, ctx) {
  const q = route.query;
  const params = new URLSearchParams();
  if (q.q) params.set('q', q.q);
  if (q.status) params.set('status', q.status);
  if (q.owner) params.set('owner', q.owner);
  const data = await api.get(`/api/leads?${params.toString()}`);
  const s = data.stats;
  const manager = ['admin', 'gm', 'director', 'manager'].includes(state.user.role);

  el.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1>线索</h1>
        <div class="desc">线索归属与商机归属分开计量，转化时强制校验四要素</div>
      </div>
      <div class="actions">
        <button class="btn" data-refresh>${icon('search', 13)} 刷新</button>
        <button class="btn btn-primary" data-new>${icon('plus', 12)} 新建线索</button>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="lb">线索总数</div><div class="vl">${s.total}</div><div class="sb">全部状态</div></div>
      <div class="kpi"><div class="lb">待跟进</div><div class="vl">${s.unclaimed}</div><div class="sb">尚未首次触达</div></div>
      <div class="kpi"><div class="lb">跟进中 / 已确认</div><div class="vl">${s.active}</div><div class="sb">含已确认商机</div></div>
      <div class="kpi"><div class="lb">已转商机</div><div class="vl">${s.converted}</div><div class="sb">转化率 ${s.total ? ((s.converted / s.total) * 100).toFixed(0) : 0}%</div></div>
    </div>

    <div class="toolbar">
      <input class="input" id="q" placeholder="搜索线索名称 / 联系人 / 电话" value="${esc(q.q || '')}" style="width:230px" />
      <select class="select" id="fStatus">
        <option value="">全部状态</option>
        ${statusOptions().map((o) => `<option value="${o.value}" ${q.status === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>
      ${manager ? `<select class="select" id="fOwner">
        <option value="">全部负责人</option>
        ${state.users.map((u) => `<option value="${u.id}" ${String(q.owner) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
      </select>` : ''}
      <div class="grow"></div>
      <span class="muted" style="font-size:12px">共 ${data.rows.length} 条</span>
    </div>

    <div class="listwrap">
      <div class="tablewrap">
        <table class="grid">
          <thead><tr>
            <th style="min-width:210px">线索 / 联系人</th>
            <th>来源</th>
            <th style="min-width:200px">需求</th>
            <th>预算</th>
            <th>状态</th>
            <th>负责人</th>
            <th>下次跟进</th>
          </tr></thead>
          <tbody>
            ${data.rows.length ? data.rows.map((l) => `<tr data-id="${l.id}">
              <td>
                <div class="cell-main">${esc(l.name)}</div>
                <div class="cell-sub">${esc(l.contact_name || '未填联系人')}${l.contact_title ? ' · ' + esc(l.contact_title) : ''}${l.contact_phone ? ' · ' + esc(l.contact_phone) : ''}</div>
              </td>
              <td><span class="badge badge-gray">${esc(l.source || '—')}</span></td>
              <td><div style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-2)">${esc(l.demand || '—')}</div></td>
              <td class="nowrap">${esc(l.budget || '—')}</td>
              <td>${badge(labels.leadStatus[l.status] || l.status, statusTone(l.status))}</td>
              <td class="nowrap">${esc(l.owner_name || '—')}</td>
              <td class="nowrap" style="${l.next_date && l.next_date < new Date().toISOString().slice(0,10) && !['converted','invalid'].includes(l.status) ? 'color:var(--red)' : ''}">${dueText(l.next_date)}</td>
            </tr>`).join('') : `<tr><td colspan="7"><div class="empty">
              <strong>没有符合条件的线索</strong><span>调整筛选条件，或新建一条线索</span></div></td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  </div>`;

  const go = (patch) => {
    const next = { ...q, ...patch };
    const p = new URLSearchParams();
    Object.entries(next).forEach(([k, v]) => { if (v) p.set(k, v); });
    location.hash = `#/leads${p.toString() ? '?' + p.toString() : ''}`;
  };

  el.querySelector('#q').onkeydown = (e) => { if (e.key === 'Enter') go({ q: e.target.value.trim() }); };
  const fs = el.querySelector('#fStatus');
  if (fs) fs.onchange = () => go({ status: fs.value });
  const fo = el.querySelector('#fOwner');
  if (fo) fo.onchange = () => go({ owner: fo.value });
  el.querySelector('[data-refresh]').onclick = () => ctx.refresh();
  el.querySelector('[data-new]').onclick = () => newLead(ctx);

  el.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.onclick = () => openLead(Number(tr.dataset.id), ctx);
  });

  if (q.new === '1') newLead(ctx);
  if (route.id) openLead(Number(route.id), ctx);
}

function newLead(ctx) {
  modal({
    title: '新建线索',
    width: 640,
    body: `<div class="formgrid">
      ${field('线索名称 / 客户公司', 'name', { required: true, placeholder: '例如：苏州联捷精密制造' })}
      ${field('来源', 'source', { options: srcOptions() })}
      ${field('联系人', 'contact_name', { required: true })}
      ${field('职位', 'contact_title', { placeholder: '影响转商机的关键项' })}
      ${field('联系电话', 'contact_phone', { required: true })}
      ${field('邮箱', 'contact_email', { type: 'email' })}
      ${field('行业', 'industry', { options: (state.dict.industries || []).map((x) => ({ value: x, label: x })) })}
      ${field('区域', 'region', { options: (state.dict.regions || []).map((x) => ({ value: x, label: x })) })}
      ${field('需求描述', 'demand', { type: 'textarea', full: true, placeholder: '客户痛点、业务范围、期望效果' })}
      ${field('预算', 'budget', { options: (state.dict.scales || []).map((x) => ({ value: x, label: x })) })}
      ${field('采购时间', 'purchase_time', { type: 'date' })}
      ${field('下次跟进', 'next_date', { type: 'date' })}
      ${field('负责人', 'owner_id', { options: pickUsers(), value: state.user.id })}
    </div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>创建</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      root.querySelector('[data-ok]').onclick = async () => {
        const d = formData(root);
        if (!d.name || !d.contact_name || !d.contact_phone) return toast('名称、联系人、电话为必填', 'err');
        try {
          const r = await api.post('/api/leads', d);
          toast('线索已创建', 'ok');
          close();
          ctx.refresh();
          setTimeout(() => openLead(r.id, ctx), 300);
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    },
  });
}

export async function openLead(id, ctx) {
  const l = await api.get(`/api/leads/${id}`);
  const mine = Number(l.owner_id) === Number(state.user.id);
  const editable = mine || ['admin', 'gm', 'director', 'manager'].includes(state.user.role);

  const kvs = [
    ['联系人', l.contact_name || '—'],
    ['职位', l.contact_title || '—'],
    ['电话', l.contact_phone || '—'],
    ['邮箱', l.contact_email || '—'],
    ['来源', l.source || '—'],
    ['行业', l.industry || '—'],
    ['预算', l.budget || '—'],
    ['采购时间', date(l.purchase_time)],
    ['负责人', l.owner_name || '—'],
    ['所属组织', l.org_name || '—'],
    ['下次跟进', `${date(l.next_date)}　${esc(l.next_action || '')}`],
    ['创建时间', date(l.created_at)],
  ];

  const html = `
    <div class="drawer-head">
      <div style="flex:1;min-width:0">
        <h2>${esc(l.name)}</h2>
        <div class="sub">
          ${badge(labels.leadStatus[l.status] || l.status, statusTone(l.status))}
          <span style="margin-left:6px">${esc(l.source || '')} · ${esc(l.org_name || '')}</span>
        </div>
      </div>
      <button class="icon-btn close" data-close>${icon('close', 14)}</button>
    </div>
    <div class="drawer-body">
      ${l.status === 'converted' && l.opportunity_id ? `<div class="notice blue" style="margin-bottom:14px">${icon('info', 14)}
        <div>该线索已转化为商机，可前往商机查看报价与合同。</div></div>` : ''}
      ${l.status === 'invalid' ? `<div class="notice red" style="margin-bottom:14px">${icon('warn', 14)}
        <div>标记无效：${esc(l.invalid_reason || '—')}</div></div>` : ''}

      ${!editable ? `<div class="notice" style="margin-bottom:14px">${icon('info', 14)}
        <div>该线索由 ${esc(l.owner_name || '他人')} 负责，你可以查看但不能修改或记录跟进。</div></div>` : ''}
      <div class="section">
        <div class="section-title">线索信息<span class="line"></span></div>
        <div class="fields">
          ${kvs.map(([k, v]) => `<div class="fld"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}
          <div class="fld full"><div class="k">需求描述</div><div class="v">${esc(l.demand || '—')}</div></div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">跟进记录<span class="line"></span>
          ${editable && !['converted', 'invalid'].includes(l.status) ? `<button class="btn btn-sm" data-add-act>记一笔</button>` : ''}</div>
        ${l.activities.length ? `<div class="timeline">
          ${l.activities.map((a) => `<div class="tl-item">
            <div class="tl-dot"></div>
            <div class="tl-main">
              <div class="h">${esc(a.user_name || '')}
                <span class="badge badge-gray">${esc(labels.activityType[a.type] || a.type)}</span>
                <span class="muted" style="font-size:11px;font-weight:400">${relTime(a.created_at)}</span>
              </div>
              <div class="m">${esc(a.content || '')}</div>
              ${a.result ? `<div class="b">结果：${esc(a.result)}</div>` : ''}
            </div>
          </div>`).join('')}
        </div>` : '<div class="muted" style="font-size:12.5px">暂无跟进记录</div>'}
      </div>
    </div>
    <div class="drawer-foot">
      ${!['converted', 'invalid'].includes(l.status) && editable ? `
        <button class="btn" data-to="contacted">标记跟进中</button>
        <button class="btn" data-to="qualified">确认商机</button>
        <button class="btn btn-danger" data-invalid>标记无效</button>
        <div class="spacer"></div>
        <button class="btn btn-primary" data-convert>转商机</button>
      ` : l.opportunity_id ? `<button class="btn btn-primary" data-open-opp>查看商机 →</button><div class="spacer"></div>` : '<div class="spacer"></div>'}
      <button class="btn" data-close2>关闭</button>
    </div>`;

  const close = openDrawer(html, {
    onMount(root, close) {
      root.querySelector('[data-close]').onclick = close;
      root.querySelector('[data-close2]').onclick = close;

      const act = root.querySelector('[data-add-act]');
      if (act) act.onclick = () => addActivity(l, close, ctx);

      root.querySelectorAll('[data-to]').forEach((b) => {
        b.onclick = async () => {
          try {
            await api.post(`/api/leads/${l.id}/status`, { status: b.dataset.to });
            toast('状态已更新', 'ok');
            close(); ctx.refresh();
          } catch (e) {
            if (e.detail?.length) blockList('暂时无法推进', e.detail);
            else toast(e.message, 'err');
          }
        };
      });

      const inv = root.querySelector('[data-invalid]');
      if (inv) inv.onclick = async () => {
        const m = modal({
          title: '标记为无效线索',
          width: 420,
          body: `${field('无效原因', 'reason', { type: 'textarea', required: true, placeholder: '例如：预算冻结、规模不匹配' })}`,
          footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>确认</button>`,
          onMount(r2, c2) {
            r2.querySelector('[data-c]').onclick = c2;
            r2.querySelector('[data-ok]').onclick = async () => {
              const d = formData(r2);
              if (!d.reason) return toast('请填写原因', 'err');
              try {
                await api.post(`/api/leads/${l.id}/status`, { status: 'invalid', reason: d.reason });
                toast('已标记无效', 'ok'); c2(); close(); ctx.refresh();
              } catch (e) { toast(e.message, 'err'); }
            };
          },
        });
        void m;
      };

      const cv = root.querySelector('[data-convert]');
      if (cv) cv.onclick = () => convertLead(l, close, ctx);

      const oo = root.querySelector('[data-open-opp]');
      if (oo) oo.onclick = () => { close(); location.hash = `#/opportunities/${l.opportunity_id}`; };
    },
  });
}

function addActivity(l, closeDrawer, ctx) {
  modal({
    title: '记录跟进',
    width: 480,
    body: `<div class="stack">
      ${field('方式', 'type', { options: state.dict.activityTypes })}
      ${field('沟通内容', 'content', { type: 'textarea', required: true })}
      ${field('结果 / 客户反馈', 'result')}
      <div class="formgrid">
        ${field('下一步', 'next_action')}
        ${field('下次跟进日期', 'next_date', { type: 'date' })}
      </div>
    </div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>保存</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      root.querySelector('[data-ok]').onclick = async () => {
        const d = formData(root);
        if (!d.content) return toast('请填写沟通内容', 'err');
        try {
          await api.post(`/api/leads/${l.id}/activity`, d);
          toast('已记录', 'ok'); close(); closeDrawer();
          setTimeout(() => openLead(l.id, ctx), 150);
          ctx.refresh();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

function convertLead(l, closeDrawer, ctx) {
  modal({
    title: '线索转商机',
    width: 500,
    body: `<div class="notice" style="margin-bottom:14px">${icon('info', 14)}
      <div>转商机需要：关键联系人（姓名/职位/电话）、需求描述、预算或采购时间、下一步动作与日期。缺失项会阻止转化。</div></div>
      <div class="stack">
        ${field('商机名称', 'name', { value: `${l.name} 项目`, required: true })}
        ${field('预计金额（元）', 'amount', { type: 'number', required: true, min: 0, step: 1000, placeholder: '例如 500000' })}
        <div class="formgrid">
          ${field('预计成交日期', 'expected_date', { type: 'date', value: new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10) })}
          ${field('产品线', 'product_line', { placeholder: '例如 MES / WMS' })}
        </div>
        ${!l.budget ? field('预算（线索未填，可在此补充）', 'budget', { options: (state.dict.scales || []).map((x) => ({ value: x, label: x })) }) : ''}
      </div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>确认转化</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      root.querySelector('[data-ok]').onclick = async () => {
        const d = formData(root);
        if (!d.amount) return toast('请填写预计金额', 'err');
        try {
          const r = await api.post(`/api/leads/${l.id}/convert`, d);
          toast('已转为商机', 'ok'); close(); closeDrawer();
          ctx.refresh();
          setTimeout(() => (location.hash = `#/opportunities/${r.opportunityId}`), 200);
        } catch (e) {
          if (e.detail?.length) blockList('转商机条件未满足', e.detail);
          else toast(e.message, 'err');
        }
      };
    },
  });
}

export const __meta = { statusTone, dateTime, money, confirmBox, can };
