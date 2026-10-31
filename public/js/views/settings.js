import { api } from '../api.js';
import { icon } from '../icons.js';
import { esc, money, toast } from '../ui.js';

const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(2) + ' MB';
  return Math.round(v / 1024) + ' KB';
};

function inputFor(item, value, disabled) {
  const v = value ?? '';
  if (item.type === 'switch') {
    return `<label class="switch">
      <input type="checkbox" data-set="${item.key}" ${String(v) === '1' ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
      <span></span></label>`;
  }
  if (item.type === 'percent') {
    return `<div class="ipt-unit">
      <input class="input" type="number" step="0.5" min="0" max="100" data-set="${item.key}" value="${esc(v)}" ${disabled ? 'disabled' : ''} />
      <span>%</span></div>`;
  }
  if (item.type === 'money') {
    return `<div class="ipt-unit">
      <input class="input" type="number" step="10000" min="0" data-set="${item.key}" value="${esc(v)}" ${disabled ? 'disabled' : ''} />
      <span>元</span></div>`;
  }
  if (item.type === 'bytes') {
    return `<div class="ipt-unit">
      <input class="input" type="number" step="1024" min="1024" data-set="${item.key}" value="${esc(v)}" ${disabled ? 'disabled' : ''} />
      <span>字节（${fmtBytes(v)}）</span></div>`;
  }
  if (item.type === 'textarea') {
    return `<textarea class="textarea" rows="3" data-set="${item.key}" ${disabled ? 'disabled' : ''}>${esc(v)}</textarea>`;
  }
  if (item.type === 'password') {
    return `<input class="input" type="password" data-set="${item.key}" value="${esc(v)}" autocomplete="new-password" ${disabled ? 'disabled' : ''} />`;
  }
  return `<input class="input" type="${item.type === 'number' ? 'number' : 'text'}" data-set="${item.key}" value="${esc(v)}" ${disabled ? 'disabled' : ''} />`;
}

export async function render(el, route, ctx) {
  const d = await api.get('/api/settings');
  const v = d.values;
  const edit = d.canEdit;

  const roleSet = new Set(String(v['quote.custom_roles'] || '').split(',').map((s) => s.trim()).filter(Boolean));

  el.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1>系统设置</h1>
        <div class="desc">审批阈值、报价规则、公司抬头（合同/报价单）、邮件与短信发送都在这里配置，改完立即生效</div>
      </div>
      <div class="actions">
        ${edit ? `<button class="btn btn-primary" data-save>保存设置</button>` : '<span class="badge badge-gray">只读（仅管理员可改）</span>'}
      </div>
    </div>

    <div class="notice blue" style="margin-bottom:16px">${icon('info', 14)}
      <div>审批链规则：折扣 ≤ 经理阈值只需经理；超过经理阈值加总监；超过总监阈值再加总经理。
      若某位审批人单独设置了「可批折扣」，以个人设置为准。</div></div>

    <div class="setgrid">
      ${d.schema.map((group) => `<div class="setcard">
        <div class="setcard-head">
          <h3>${esc(group.group)}</h3>
          <p>${esc(group.desc)}</p>
        </div>
        <div class="setcard-body">
          ${group.items.map((item) => {
            if (item.type === 'roles') {
              return `<div class="setrow">
                <div class="k"><label>${esc(item.label)}</label><div class="hint">${esc(item.hint || '')}</div></div>
                <div class="v rolegrid">
                  ${d.roles.map((r) => `<label class="chk"><input type="checkbox" data-role="${r.key}" ${roleSet.has(r.key) ? 'checked' : ''} ${edit ? '' : 'disabled'} /> ${esc(r.label)}</label>`).join('')}
                </div>
              </div>`;
            }
            return `<div class="setrow">
              <div class="k"><label>${esc(item.label)}</label><div class="hint">${esc(item.hint || '')}</div></div>
              <div class="v">${inputFor(item, v[item.key], !edit)}</div>
            </div>`;
          }).join('')}
        </div>
      </div>`).join('')}
    </div>

    <div class="card" style="margin-top:18px">
      <div class="card-head">
        <h3>审批人折扣限额</h3>
        <span class="muted" style="font-size:12px">留空则用上面的角色阈值；填了就以此人为准</span>
      </div>
      <div class="tablewrap">
        <table class="grid">
          <thead><tr>
            <th>审批人</th><th>所属组织</th><th>角色</th>
            <th class="num" style="width:200px">可批折扣上限</th>
            <th>当前实际生效</th>
          </tr></thead>
          <tbody>
            ${d.approvers.map((u) => {
              const roleLimit = u.roles.includes('director') ? v['approve.discount.director']
                : u.roles.includes('manager') ? v['approve.discount.manager']
                : v['approve.discount.gm'];
              const hasOwn = u.discount_limit !== null && u.discount_limit !== undefined;
              const effective = hasOwn ? u.discount_limit : (roleLimit ?? '—');
              return `<tr>
                <td><div class="cell-main">${esc(u.name)}</div></td>
                <td class="muted">${esc(u.org_name)}</td>
                <td>${u.roles.filter((r) => ['manager', 'director', 'gm'].includes(r)).map((r) => `<span class="badge badge-gray">${esc((d.roles.find((x) => x.key === r) || {}).label || r)}</span>`).join(' ')}</td>
                <td class="num">
                  <div class="ipt-unit" style="justify-content:flex-end">
                    <input class="input" type="number" step="0.5" min="0" max="100" style="width:110px;text-align:right"
                      data-limit="${u.id}" value="${hasOwn ? u.discount_limit : ''}" placeholder="${roleLimit ?? ''}" ${edit ? '' : 'disabled'} />
                    <span>%</span>
                  </div>
                </td>
                <td><b>${effective}${effective === '—' ? '' : '%'}</b>${hasOwn ? ' <span class="badge badge-amber">个人设置</span>' : ' <span class="muted" style="font-size:11.5px">继承角色</span>'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-top:18px">
      <div class="card-head"><h3>当前生效的审批链</h3><span class="muted" style="font-size:12px">按折扣率试算</span></div>
      <div class="chain-preview" id="chainPreview"></div>
    </div>
  </div>`;

  const m = Number(v['approve.discount.manager'] || 5);
  const dr = Number(v['approve.discount.director'] || 10);
  const skipNoDisc = v['quote.skip_approval_when_no_discount'] !== '0';
  el.querySelector('#chainPreview').innerHTML = `
    ${skipNoDisc ? `<div class="chain-row"><span class="pct">0%</span><div class="chain">
      <span class="node">免价格审批</span><i class="arrow">→</i><span class="node">创建合同</span></div><span class="muted">未让价，直接进合同流程</span></div>` : ''}
    <div class="chain-row"><span class="pct">≤ ${m}%</span><div class="chain">
      <span class="node">部门经理</span></div><span class="muted">常规折扣</span></div>
    <div class="chain-row"><span class="pct">${m}% ~ ${dr}%</span><div class="chain">
      <span class="node">部门经理</span><i class="arrow">→</i><span class="node">销售总监</span></div><span class="muted">中等折扣</span></div>
    <div class="chain-row"><span class="pct">&gt; ${dr}%</span><div class="chain">
      <span class="node">部门经理</span><i class="arrow">→</i><span class="node">销售总监</span><i class="arrow">→</i><span class="node">总经理</span></div><span class="muted">大额让价</span></div>`;

  const save = el.querySelector('[data-save]');
  if (!save) return;

  save.onclick = async () => {
    const values = {};
    el.querySelectorAll('[data-set]').forEach((inp) => {
      const key = inp.dataset.set;
      values[key] = inp.type === 'checkbox' ? (inp.checked ? '1' : '0') : inp.value;
    });
    const roles = [...el.querySelectorAll('[data-role]')].filter((c) => c.checked).map((c) => c.dataset.role);
    if (!roles.length && values['quote.allow_custom'] === '1') {
      return toast('开启例外报价时至少要选择一个可用角色', 'err');
    }
    values['quote.custom_roles'] = roles.join(',');

    const limits = [...el.querySelectorAll('[data-limit]')].map((inp) => ({
      id: inp.dataset.limit,
      value: inp.value === '' ? null : Number(inp.value),
    }));

    try {
      await api.patch('/api/settings', { values });
      for (const l of limits) {
        await api.patch(`/api/admin/users/${l.id}`, { discount_limit: l.value });
      }
      toast('设置已保存，立即生效', 'ok');
      ctx.refresh();
    } catch (e) {
      toast(e.message, 'err');
    }
    return undefined;
  };
}
