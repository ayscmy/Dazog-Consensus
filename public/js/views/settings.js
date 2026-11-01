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
  // 授权信息只有超管能看；非超管拿不到就降级不显示这块，不要因为 403 整页报错
  const [d, lic] = await Promise.all([
    api.get('/api/settings'),
    api.get('/api/admin/license').catch(() => null),
  ]);
  const v = d.values;
  const edit = d.canEdit;
  const ent = lic && lic.entitlements;
  const licEnv = lic && lic.source === 'env';

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

    ${lic ? `<div class="card" style="margin-top:18px">
      <div class="card-head">
        <h3>商业授权</h3>
        <span class="muted" style="font-size:12px">授权决定用户数上限；无授权时按社区版规则（最多 ${esc(String(lic.quota.communityLimit || 10))} 个在职用户）</span>
      </div>
      <div style="padding:14px 16px">
        <div class="notice ${lic.active ? 'blue' : 'amber'}" style="margin-bottom:12px">${icon(lic.active ? 'check' : 'warn', 14)}
          <div>${lic.active
            ? `已激活<b>${esc(ent.edition)}</b>授权，用户上限 <b>${ent.usersLimit === 0 ? '不限' : ent.usersLimit + ' 个'}</b>，${ent.expire ? `有效期至 <b>${esc(ent.expire)}</b>` : '永久有效'}。`
            : `${esc(lic.reason || '尚未激活授权')}。当前按社区版规则运行：最多 ${esc(String(lic.quota.limit))} 个在职用户，已用 ${esc(String(lic.quota.current))} 个。`}</div>
        </div>

        <table class="grid">
          <tbody>
            ${lic.active ? `
            <tr style="cursor:default"><td style="width:120px" class="muted">被授权方</td><td><b>${esc(ent.customer || '—')}</b></td></tr>
            <tr style="cursor:default"><td class="muted">授权编号</td><td class="mono">${esc(ent.licenseId || '—')}</td></tr>
            <tr style="cursor:default"><td class="muted">用户上限</td><td>${ent.usersLimit === 0 ? '<b>不限</b>' : `<b>${ent.usersLimit}</b> 个在职用户`}</td></tr>
            <tr style="cursor:default"><td class="muted">有效期</td><td>${ent.expire ? esc(ent.expire) : '永久'}</td></tr>
            <tr style="cursor:default"><td class="muted">绑定机器</td><td class="mono">${esc(ent.machine || '不绑定')}</td></tr>
            <tr style="cursor:default"><td class="muted">签发日期</td><td>${esc(ent.issuedAt || '—')}</td></tr>
            <tr style="cursor:default"><td class="muted">授权来源</td><td>${lic.source === 'env' ? '环境变量 <span class="mono">CRM_LICENSE</span>' : '后台激活（存数据库）'}</td></tr>
            ` : ''}
            <tr style="cursor:default"><td class="muted">本机指纹</td><td>
              <span class="mono">${esc(lic.machine)}</span>
              <button class="btn btn-sm" data-copy-machine style="margin-left:8px">复制</button>
              <div class="cell-sub">需要绑定机器时把它给签发方；不绑则换服务器无需重签</div>
            </td></tr>
          </tbody>
        </table>

        ${edit && !licEnv ? `
        <div class="field" style="margin-top:14px">
          <label>${lic.active ? '更换授权码' : '粘贴授权码激活'}</label>
          <textarea class="textarea" name="license_code" style="font-family:var(--mono);font-size:11.5px;height:76px"
            placeholder="粘贴以 eyJ 开头的一整行授权码"></textarea>
          <div class="hint">授权码由 AIEMY 签发。也可以写进 <code>.env</code> 的 <code>CRM_LICENSE</code>（优先级更高，此时后台只读）。</div>
        </div>
        <div class="row" style="margin-top:6px">
          <button class="btn btn-primary" data-lic-save>${lic.active ? '更换授权' : '激活授权'}</button>
          ${lic.active && lic.source === 'console' ? '<button class="btn btn-danger" data-lic-clear>移除授权</button>' : ''}
        </div>` : (licEnv ? '<div class="hint" style="margin-top:12px">当前授权来自环境变量 <code>CRM_LICENSE</code>，请在 <code>.env</code> 中修改后重启服务。</div>' : '')}
      </div>
    </div>` : ''}
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

  /* ---------------- 商业授权 ---------------- */
  const copyMachine = el.querySelector('[data-copy-machine]');
  if (copyMachine) {
    copyMachine.onclick = async () => {
      try {
        await navigator.clipboard.writeText(lic.machine);
        toast('机器指纹已复制', 'ok');
      } catch { toast('复制失败，请手动选中', 'err'); }
    };
  }

  const licSave = el.querySelector('[data-lic-save]');
  if (licSave) {
    licSave.onclick = async () => {
      const code = String(el.querySelector('[name="license_code"]')?.value || '').trim();
      if (!code) return toast('请先粘贴授权码', 'err');
      licSave.disabled = true;
      try {
        await api.post('/api/admin/license', { code });
        toast('授权已生效', 'ok');
        ctx.refresh();
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        licSave.disabled = false;
      }
    };
  }

  const licClear = el.querySelector('[data-lic-clear]');
  if (licClear) {
    licClear.onclick = async () => {
      if (!confirm('移除后台激活的授权？移除后实例会回落到社区版规则（最多 10 个在职用户）。')) return;
      try {
        await api.del('/api/admin/license');
        toast('授权已移除', 'ok');
        ctx.refresh();
      } catch (e) { toast(e.message, 'err'); }
    };
  }

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
