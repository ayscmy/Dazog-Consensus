import { api } from '../api.js';
import { state } from '../store.js';
import { icon } from '../icons.js';
import {
  esc, money, amount, date, badge, toast, modal, field, formData, confirmBox,
} from '../ui.js';

const pct = (v) => (v === null || v === undefined ? '—' : (v * 100).toFixed(1) + '%');

export async function render(el, route, ctx) {
  const q = route.query;
  const params = new URLSearchParams();
  if (q.q) params.set('q', q.q);
  if (q.category) params.set('category', q.category);
  if (q.all === '1') params.set('all', '1');
  const data = await api.get(`/api/products?${params.toString()}`);
  const sensitive = ['admin', 'gm', 'director', 'manager', 'finance'].includes(state.user.role);
  const canEdit = data.canEdit;

  el.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1>产品库</h1>
        <div class="desc">报价只能从产品库选品，标准价与成本在这里统一维护；例外报价由管理员在设置里开启</div>
      </div>
      <div class="actions">
        <button class="btn" data-refresh>${icon('search', 13)} 刷新</button>
        ${canEdit ? `<button class="btn btn-primary" data-new>${icon('plus', 12)} 新建产品</button>` : ''}
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="lb">产品总数</div><div class="vl">${data.stats.total}</div><div class="sb">含停售</div></div>
      <div class="kpi"><div class="lb">在售</div><div class="vl">${data.stats.active}</div><div class="sb">可用于报价</div></div>
      <div class="kpi"><div class="lb">产品线</div><div class="vl">${data.stats.categories}</div><div class="sb">已归类</div></div>
      <div class="kpi"><div class="lb">平均标准价</div><div class="vl">${money(data.stats.avgPrice)}</div><div class="sb">全部产品</div></div>
    </div>

    <div class="toolbar">
      <input class="input" id="q" placeholder="搜索产品名称 / 编码 / 规格" value="${esc(q.q || '')}" style="width:260px" />
      <select class="select" id="fCat">
        <option value="">全部产品线</option>
        ${data.categories.map((c) => `<option value="${esc(c)}" ${q.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
      <label class="chk"><input type="checkbox" id="fAll" ${q.all === '1' ? 'checked' : ''} /> 显示停售</label>
      <div class="grow"></div>
      <span class="muted" style="font-size:12px">${canEdit ? '标准价与成本可维护' : '标准价由总部维护，如需调整请联系管理员'}</span>
    </div>

    <div class="listwrap"><div class="tablewrap">
      <table class="grid">
        <thead><tr>
          <th style="min-width:150px">编码</th><th style="min-width:220px">产品名称</th>
          <th>产品线</th><th style="min-width:180px">规格</th><th>单位</th>
          <th class="num">标准价</th>${sensitive ? '<th class="num">成本</th><th class="num">毛利率</th>' : ''}
          <th>状态</th>${canEdit ? '<th class="right">操作</th>' : ''}
        </tr></thead>
        <tbody>
          ${data.rows.length ? data.rows.map((p) => `<tr data-id="${p.id}">
            <td class="mono">${esc(p.code)}</td>
            <td><div class="cell-main">${esc(p.name)}</div>${p.remark ? `<div class="cell-sub">${esc(p.remark)}</div>` : ''}</td>
            <td>${badge(p.category || '未分类', 'gray')}</td>
            <td class="muted">${esc(p.spec || '—')}</td>
            <td>${esc(p.unit || '—')}</td>
            <td class="num money">${amount(p.list_price)}</td>
            ${sensitive ? `<td class="num money">${amount(p.cost)}</td>
            <td class="num" style="${p.gross_margin > 0.4 ? 'color:var(--green)' : p.gross_margin > 0.15 ? '' : 'color:var(--amber)'}">${pct(p.gross_margin)}</td>` : ''}
            <td>${p.status === 'active' ? badge('在售', 'green') : badge('已停售', 'gray')}</td>
            ${canEdit ? `<td class="right">
              <button class="btn btn-sm" data-edit="${p.id}">编辑</button>
            </td>` : ''}
          </tr>`).join('') : `<tr><td colspan="9"><div class="empty">
            <strong>没有匹配的产品</strong><span>调整筛选条件，或先新建一个产品</span></div></td></tr>`}
        </tbody>
      </table>
    </div></div>
  </div>`;

  const go = (patch) => {
    const next = { ...q, ...patch };
    const p = new URLSearchParams();
    Object.entries(next).forEach(([k, v]) => { if (v) p.set(k, v); });
    location.hash = `#/products${p.toString() ? '?' + p.toString() : ''}`;
  };
  el.querySelector('#q').onkeydown = (e) => { if (e.key === 'Enter') go({ q: e.target.value.trim() }); };
  el.querySelector('#fCat').onchange = (e) => go({ category: e.target.value });
  el.querySelector('#fAll').onchange = (e) => go({ all: e.target.checked ? '1' : '' });
  el.querySelector('[data-refresh]').onclick = () => ctx.refresh();

  const nb = el.querySelector('[data-new]');
  if (nb) nb.onclick = () => editProduct(null, data.categories, ctx);

  el.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const p = data.rows.find((x) => String(x.id) === b.dataset.edit);
      editProduct(p, data.categories, ctx);
    };
  });
}

function editProduct(p, _categories, ctx) {
  const isNew = !p;
  modal({
    title: isNew ? '新建产品' : `编辑产品 · ${p.name}`,
    width: 640,
    body: `<div class="formgrid">
      ${field('产品编码', 'code', { value: p?.code || '', placeholder: '留空自动生成' })}
      ${field('产品名称', 'name', { value: p?.name || '', required: true })}
      ${field('产品线', 'category', { value: p?.category || '', placeholder: 'MES / WMS / 服务…' })}
      ${field('规格说明', 'spec', { value: p?.spec || '' })}
      ${field('单位', 'unit', { value: p?.unit || '套' })}
      ${field('状态', 'status', {
        options: [{ value: 'active', label: '在售' }, { value: 'inactive', label: '停售' }],
        value: p?.status || 'active',
      })}
      ${field('标准价（元）', 'list_price', { type: 'number', value: p?.list_price ?? '', required: true, min: 0, step: 100 })}
      ${field('成本（元）', 'cost', { type: 'number', value: p?.cost ?? '', min: 0, step: 100, hint: '仅经理及以上可见' })}
      ${field('底价（元）', 'min_price', { type: 'number', value: p?.min_price ?? '', min: 0, step: 100, hint: '低于此价必须审批，可留空' })}
      ${field('备注', 'remark', { value: p?.remark || '' })}
    </div>
    <div class="notice blue" style="margin-top:12px">${icon('info', 14)}
      <div>标准价是报价的基准，成交价低于标准价即产生折扣，系统按折扣自动生成审批链。</div></div>`,
    footer: `<button class="btn" data-c>取消</button>
      ${isNew ? '' : '<button class="btn btn-danger" data-del>停用</button>'}
      <button class="btn btn-primary" data-ok>保存</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      const del = root.querySelector('[data-del]');
      if (del) del.onclick = async () => {
        close();
        const ok = await confirmBox('停用产品', `确定停用「${p.name}」吗？已报价的历史单据不受影响，但不能再用它报新价。`, true);
        if (!ok) return;
        try {
          const r = await api.del(`/api/products/${p.id}`);
          toast(r.deleted ? '产品已删除' : '产品已停用', 'ok');
          ctx.refresh();
        } catch (e) { toast(e.message, 'err'); }
      };
      root.querySelector('[data-ok]').onclick = async () => {
        const d = formData(root);
        if (!d.name) return toast('请填写产品名称', 'err');
        if (!(Number(d.list_price) > 0)) return toast('请填写标准价', 'err');
        try {
          if (isNew) await api.post('/api/products', d);
          else await api.patch(`/api/products/${p.id}`, d);
          toast(isNew ? '产品已创建' : '产品已更新', 'ok');
          close();
          ctx.refresh();
        } catch (e) { toast(e.message, 'err'); }
        return undefined;
      };
    },
  });
}

