import { api } from '../api.js';
import { state, labels, can } from '../store.js';
import { icon } from '../icons.js';
import { openQuoteEditor } from '../quote-editor.js';
import {
  esc, money, amount, date, dueText, relTime, badge, statusTone, toast, modal, field,
  formData, openDrawer, blockList,
} from '../ui.js';

const STAGES = () => state.dict.oppStages || [];
const NEXT = { lead_in: 'needs', needs: 'proposal', proposal: 'negotiation', negotiation: 'won' };

export async function render(el, route, ctx) {
  const q = route.query;
  const view = q.view || 'table';
  const params = new URLSearchParams();
  if (q.q) params.set('q', q.q);
  if (q.owner) params.set('owner', q.owner);
  if (q.org) params.set('org', q.org);
  const data = await api.get(`/api/opportunities?${params.toString()}`);
  const st = data.stats;

  el.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1>商机</h1>
        <div class="desc">七阶段推进，每阶段必须带证据；赢单以合同生效为准</div>
      </div>
      <div class="actions">
        <div class="seg" id="viewSeg">
          <button class="${view === 'table' ? 'on' : ''}" data-v="table">表格</button>
          <button class="${view === 'board' ? 'on' : ''}" data-v="board">看板</button>
        </div>
        <button class="btn" data-refresh>${icon('search', 13)} 刷新</button>
        <button class="btn btn-primary" data-new>${icon('plus', 12)} 新建商机</button>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="lb">在谈商机</div><div class="vl">${st.openCount}<small>个</small></div><div class="sb">合计 ${money(st.openAmount)}</div></div>
      <div class="kpi"><div class="lb">加权预测</div><div class="vl">${money(st.weighted)}</div><div class="sb">按阶段概率折算</div></div>
      <div class="kpi"><div class="lb">已赢单</div><div class="vl">${money(st.wonAmount)}</div><div class="sb">${st.wonCount} 个商机</div></div>
      <div class="kpi"><div class="lb">赢单率</div><div class="vl">${st.wonCount + st.lostCount ? ((st.wonCount / (st.wonCount + st.lostCount)) * 100).toFixed(0) : 0}<small>%</small></div><div class="sb">输单 ${st.lostCount} 个</div></div>
    </div>

    <div class="toolbar">
      <input class="input" id="q" placeholder="搜索商机 / 客户" value="${esc(q.q || '')}" style="width:220px" />
      ${['admin', 'gm', 'director', 'manager'].includes(state.user.role) ? `<select class="select" id="fOwner">
        <option value="">全部负责人</option>
        ${state.users.map((u) => `<option value="${u.id}" ${String(q.owner) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
      </select>` : ''}
      <div class="grow"></div>
      <span class="muted" style="font-size:12px">${data.rows.length} 个商机</span>
    </div>

    ${view === 'table' ? renderTable(data.rows) : renderBoard(data.byStage)}
  </div>`;

  const go = (patch) => {
    const next = { ...q, ...patch };
    const p = new URLSearchParams();
    Object.entries(next).forEach(([k, v]) => { if (v) p.set(k, v); });
    location.hash = `#/opportunities${p.toString() ? '?' + p.toString() : ''}`;
  };

  el.querySelectorAll('[data-v]').forEach((b) => { b.onclick = () => go({ view: b.dataset.v }); });
  el.querySelector('#q').onkeydown = (e) => { if (e.key === 'Enter') go({ q: e.target.value.trim() }); };
  const fo = el.querySelector('#fOwner');
  if (fo) fo.onchange = () => go({ owner: fo.value });
  el.querySelector('[data-refresh]').onclick = () => ctx.refresh();
  el.querySelector('[data-new]').onclick = () => newOpp(ctx);

  el.querySelectorAll('[data-opp]').forEach((n) => {
    n.onclick = (e) => {
      if (e.target.closest('.ocard')?.dataset.dragging) return;
      openOpp(Number(n.dataset.opp), ctx);
    };
  });

  if (view === 'board') bindDrag(el, ctx, data.rows);

  if (q.new === '1') newOpp(ctx);
  if (route.id) openOpp(Number(route.id), ctx);
}

function renderTable(rows) {
  return `<div class="listwrap"><div class="tablewrap">
    <table class="grid">
      <thead><tr>
        <th style="min-width:230px">商机 / 客户</th>
        <th>阶段</th>
        <th class="num">金额</th>
        <th class="num">概率</th>
        <th>预计成交</th>
        <th>负责人</th>
        <th class="num">报价</th>
      </tr></thead>
      <tbody>
        ${rows.length ? rows.map((o) => `<tr data-opp="${o.id}">
          <td><div class="cell-main">${esc(o.name)}</div><div class="cell-sub">${esc(o.account_name)}</div></td>
          <td>${badge(labels.oppStage[o.stage] || o.stage, statusTone(o.stage), true)}</td>
          <td class="num">${amount(o.amount)}</td>
          <td class="num">${o.probability}%</td>
          <td class="nowrap" style="${o.stage !== 'won' && o.stage !== 'lost' && o.expected_date < new Date().toISOString().slice(0,10) ? 'color:var(--red)' : ''}">${date(o.expected_date)}</td>
          <td class="nowrap">${esc(o.owner_name || '—')}</td>
          <td class="num">${o.quote_count || '—'}</td>
        </tr>`).join('') : `<tr><td colspan="7"><div class="empty">
          <strong>暂无商机</strong><span>从线索转化，或直接新建商机</span></div></td></tr>`}
      </tbody>
    </table>
  </div></div>`;
}

function renderBoard(byStage) {
  return `<div class="board">
    ${byStage.map((col) => `<div class="bcol" data-stage="${col.key}">
      <div class="bcol-head">
        <div class="t"><i class="dot" style="background:${col.color}"></i>${esc(col.label)}
          <span class="n">${col.count}</span></div>
        <div class="amt">${money(col.amount)}　加权 ${money(col.weighted)}</div>
      </div>
      <div class="bcol-body" data-drop="${col.key}"></div>
    </div>`).join('')}
  </div>`;
}

function bindDrag(el, ctx, rows) {
  rows.forEach((o) => {
    const body = el.querySelector(`[data-drop="${o.stage}"]`);
    if (!body) return;
    const card = document.createElement('div');
    card.className = 'ocard';
    card.dataset.opp = o.id;
    card.draggable = true;
    card.innerHTML = `
      <div class="nm">${esc(o.name)}</div>
      <div class="ac">${esc(o.account_name)}</div>
      <div class="ft"><span class="money">${money(o.amount)}</span>
      <span class="dt">${dueText(o.expected_date)}</span></div>`;
    card.onclick = () => openOpp(o.id, ctx);
    card.ondragstart = (e) => {
      e.dataTransfer.setData('text/plain', String(o.id));
      card.dataset.dragging = '1';
      setTimeout(() => (card.dataset.dragging = ''), 200);
    };
    body.appendChild(card);
  });

  el.querySelectorAll('[data-drop]').forEach((col) => {
    col.ondragover = (e) => { e.preventDefault(); col.closest('.bcol').classList.add('drag-over'); };
    col.ondragleave = () => col.closest('.bcol').classList.remove('drag-over');
    col.ondrop = async (e) => {
      e.preventDefault();
      col.closest('.bcol').classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      const stage = col.dataset.drop;
      try {
        await api.post(`/api/opportunities/${id}/stage`, { stage });
        toast('阶段已更新', 'ok');
        ctx.refresh();
      } catch (err) {
        if (err.detail?.length) blockList('无法推进到该阶段', err.detail);
        else toast(err.message, 'err');
        ctx.refresh();
      }
    };
  });
}

function newOpp(ctx) {
  const accounts = [];
  api.get('/api/accounts').then((d) => {
    accounts.push(...d.rows);
    modal({
      title: '新建商机',
      width: 560,
      body: `<div class="formgrid">
        ${field('商机名称', 'name', { required: true, full: true, placeholder: '例如：远洋物流 WMS 升级项目' })}
        ${field('客户', 'account_id', { required: true, full: true, options: accounts.map((a) => ({ value: a.id, label: a.name })) })}
        ${field('金额（元）', 'amount', { type: 'number', required: true, min: 0, step: 1000 })}
        ${field('预计成交', 'expected_date', { type: 'date', value: new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10) })}
        ${field('产品线', 'product_line', { placeholder: '例如 MES / WMS / 数据中台' })}
        ${field('来源', 'source', { options: (state.dict.sources || []).map((x) => ({ value: x, label: x })) })}
        ${field('负责人', 'owner_id', { options: state.users.map((u) => ({ value: u.id, label: `${u.name}（${u.title || ''}）` })), value: state.user.id, full: true })}
      </div>`,
      footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>创建</button>`,
      onMount(root, close) {
        root.querySelector('[data-c]').onclick = close;
        root.querySelector('[data-ok]').onclick = async () => {
          const d = formData(root);
          if (!d.name || !d.amount) return toast('请填写名称与金额', 'err');
          try {
            const r = await api.post('/api/opportunities', d);
            toast('商机已创建', 'ok'); close(); ctx.refresh();
            setTimeout(() => openOpp(r.id, ctx), 200);
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  });
}

export async function openOpp(id, ctx) {
  const o = await api.get(`/api/opportunities/${id}`);
  let files = [];
  try {
    const fd = await api.get(`/api/attachments?target_type=opportunity&target_id=${id}`);
    files = fd.rows || [];
  } catch { files = []; }
  const fmtSize = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(2) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const stage = labels.oppStage[o.stage] || o.stage;
  const nextStage = NEXT[o.stage];
  const manager = ['admin', 'gm', 'director', 'manager'].includes(state.user.role);
  const editable = manager || Number(o.owner_id) === Number(state.user.id);

  const html = `
    <div class="drawer-head">
      <div style="flex:1;min-width:0">
        <h2>${esc(o.name)}</h2>
        <div class="sub">${badge(stage, statusTone(o.stage), true)}
          <span style="margin-left:6px">${esc(o.account_name)} · ${esc(o.owner_name || '')}</span></div>
      </div>
      <button class="icon-btn close" data-close>${icon('close', 14)}</button>
    </div>
    <div class="drawer-body">
      <div class="section">
        <div class="section-title">商机信息<span class="line"></span></div>
        <div class="fields">
          <div class="fld"><div class="k">金额</div><div class="v money">¥ ${amount(o.amount)}</div></div>
          <div class="fld"><div class="k">赢单概率</div><div class="v">${o.probability}%</div></div>
          <div class="fld"><div class="k">预计成交</div><div class="v">${date(o.expected_date)}</div></div>
          <div class="fld"><div class="k">产品线</div><div class="v">${esc(o.product_line || '—')}</div></div>
          <div class="fld"><div class="k">竞争对手</div><div class="v">${esc(o.competitor || '—')}</div></div>
          <div class="fld"><div class="k">来源</div><div class="v">${esc(o.source || '—')}</div></div>
          <div class="fld"><div class="k">所属组织</div><div class="v">${esc(o.org_name || '—')}</div></div>
          <div class="fld"><div class="k">创建时间</div><div class="v">${date(o.created_at)}</div></div>
          ${o.won_reason ? `<div class="fld full"><div class="k">赢单原因</div><div class="v">${esc(o.won_reason)}</div></div>` : ''}
          ${o.lost_reason ? `<div class="fld full"><div class="k">输单原因</div><div class="v">${esc(o.lost_reason)}</div></div>` : ''}
        </div>
      </div>

      ${o.evidence && Object.keys(o.evidence).length ? `<div class="section">
        <div class="section-title">阶段证据<span class="line"></span></div>
        <div class="notice blue" style="flex-direction:column;gap:6px">
          ${Object.entries(o.evidence).map(([k, v]) => `<div><b>${esc({ need: '需求', budget: '预算', proposal: '方案', quote: '报价', competitor: '竞品', contract: '合同', note: '备注' }[k] || k)}：</b>${esc(v)}</div>`).join('')}
        </div>
      </div>` : ''}

      <div class="section">
        <div class="section-title">报价单<span class="line"></span>
          ${can('quotation') && !['won', 'lost'].includes(o.stage) ? `<button class="btn btn-sm" data-new-quote>新建报价</button>` : ''}</div>
        ${o.quotations.length ? `<div class="rel-list">
          ${o.quotations.map((x) => `<div class="rel" data-quote="${x.id}">
            <div style="flex:1;min-width:0">
              <div class="nm">${esc(x.no)} <span class="muted" style="font-weight:400">v${x.version}</span></div>
              <div class="mt">折扣 ${(x.discount_rate * 100).toFixed(2)}% · 有效期至 ${date(x.valid_until)}
                ${x.gross_margin !== null && x.gross_margin !== undefined ? ` · 毛利 ${(x.gross_margin * 100).toFixed(1)}%` : ''}</div>
            </div>
            <div class="am">${money(x.amount)}</div>
            ${badge(labels.quoteStatus[x.status] || x.status, statusTone(x.status))}
          </div>`).join('')}
        </div>` : '<div class="muted" style="font-size:12.5px">暂无报价单</div>'}
      </div>

      <div class="section">
        <div class="section-title">合同<span class="line"></span></div>
        ${o.contracts.length ? `<div class="rel-list">
          ${o.contracts.map((c) => `<div class="rel" data-contract="${c.id}">
            <div style="flex:1;min-width:0">
              <div class="nm">${esc(c.no)}</div>
              <div class="mt">${esc(c.title)} · 账期 ${c.payment_terms} 天</div>
            </div>
            <div class="am">${money(c.amount)}</div>
            ${badge(labels.contractStatus[c.status] || c.status, statusTone(c.status))}
          </div>`).join('')}
        </div>` : '<div class="muted" style="font-size:12.5px">暂无合同，报价通过后可生成</div>'}
      </div>

      <div class="section">
        <div class="section-title">材料与附件<span class="line"></span>
          ${files.length ? `<span class="muted" style="font-size:11.5px">${files.length} 个</span>` : ''}</div>
        ${files.length ? `<div class="attgrid">
          ${files.map((f) => (f.is_image
            ? `<a class="att-img" href="${f.url}" target="_blank" rel="noopener" title="${esc(f.name)}">
                 <img src="${f.url}" alt="${esc(f.name)}" loading="lazy" />
                 <span>${esc(f.name)}</span></a>`
            : `<a class="att-file" href="${f.url}" target="_blank" rel="noopener" title="${esc(f.name)}">
                 <span class="ic">${icon('file', 15)}</span>
                 <span class="nm">${esc(f.name)}</span>
                 <em>${fmtSize(f.size)}</em></a>`
          )).join('')}
        </div>` : `<div class="muted" style="font-size:12.5px">暂无附件。推进阶段时可上传方案、纪要、报价截图等材料（单个 ≤ 1 MB）。</div>`}
      </div>

      <div class="section">
        <div class="section-title">跟进记录<span class="line"></span>
          ${editable ? `<button class="btn btn-sm" data-add-act>记一笔</button>` : ''}</div>
        ${o.activities.length ? `<div class="timeline">
          ${o.activities.map((a) => `<div class="tl-item">
            <div class="tl-dot ${a.type === 'stage' ? 'on' : ''}"></div>
            <div class="tl-main">
              <div class="h">${esc(a.user_name || '')}
                <span class="badge badge-gray">${esc(labels.activityType[a.type] || a.type)}</span>
                <span class="muted" style="font-size:11px;font-weight:400">${relTime(a.created_at)}</span></div>
              <div class="m">${esc(a.content || '')}</div>
              ${a.result ? `<div class="b">${esc(a.result)}</div>` : ''}
            </div>
          </div>`).join('')}
        </div>` : '<div class="muted" style="font-size:12.5px">暂无跟进记录</div>'}
      </div>
    </div>
    <div class="drawer-foot">
      ${editable && nextStage ? `<button class="btn btn-primary" data-advance="${nextStage}">推进到「${labels.oppStage[nextStage]}」</button>` : ''}
      ${editable && !['won', 'lost'].includes(o.stage) ? `<button class="btn btn-danger" data-advance="lost">标记输单</button>` : ''}
      <div class="spacer"></div>
      <button class="btn" data-close2>关闭</button>
    </div>`;

  const close = openDrawer(html, {
    onMount(root, close) {
      root.querySelector('[data-close]').onclick = close;
      root.querySelector('[data-close2]').onclick = close;
      root.querySelectorAll('[data-advance]').forEach((b) => {
        b.onclick = () => advance(o, b.dataset.advance, close, ctx);
      });
      root.querySelectorAll('[data-contract]').forEach((n) => {
        n.onclick = () => { close(); location.hash = `#/contracts/${n.dataset.contract}`; };
      });
      root.querySelectorAll('[data-quote]').forEach((n) => {
        n.onclick = () => { close(); location.hash = `#/quotations/${n.dataset.quote}`; };
      });
      const nq = root.querySelector('[data-new-quote]');
      if (nq) nq.onclick = () => newQuote(o, close, ctx);
      const aa = root.querySelector('[data-add-act]');
      if (aa) aa.onclick = () => addOppActivity(o, close, ctx);
    },
  });
}

function advance(o, target, closeDrawer, ctx) {
  const need = {
    needs: [field('需求确认（痛点与业务范围）', 'need', { type: 'textarea', required: true, placeholder: '客户确认的核心痛点、需要覆盖的业务范围' }),
            field('预算情况', 'budget', { placeholder: '例如：已列入年度 IT 预算，区间 100-200 万' })],
    proposal: [field('补充说明', 'note', { type: 'textarea', placeholder: '方案交付情况、客户反馈' })],
    negotiation: [field('补充说明', 'note', { type: 'textarea', placeholder: '商务谈判要点、竞品情况' })],
    won: [field('赢单原因', 'won_reason', { type: 'textarea', required: true, placeholder: '为什么是我们赢（价格/方案/交付/关系）' })],
    lost: [field('输单原因', 'lost_reason', { type: 'textarea', required: true, placeholder: '例如：预算冻结、竞品价格更低' })],
  }[target] || [];

  const hints = {
    proposal: '进入方案报价前，系统会校验：客户下至少 1 位决策人联系人、需求与预算已确认。',
    negotiation: '进入商务谈判前，系统会校验：已存在通过折扣审批的报价单。',
    won: '赢单以「合同已生效」为准，若无生效合同请先去合同模块走三关审批。',
  };

  // 待上传的附件（选中后暂存，推进成功才真正上传）
  const pending = [];
  const MAX = 1024 * 1024;

  modal({
    title: `推进到「${labels.oppStage[target] || target}」`,
    width: 560,
    body: `${hints[target] ? `<div class="notice" style="margin-bottom:14px">${icon('info', 14)}<div>${hints[target]}</div></div>` : ''}
      <div class="stack">${need.join('')}</div>

      <div class="section-title" style="margin:16px 0 8px">补充材料<span class="line"></span></div>
      <div class="uploader" id="dropper">
        <input type="file" id="fileInput" multiple
          accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.png,.jpg,.jpeg,.webp,.gif" />
        <div class="up-hint">${icon('upload', 15)}
          <div><b>点击选择或把文件拖到这里</b>
            <span>单个文件不超过 1 MB，支持图片（png/jpg/webp/gif）与常见文档，最多 5 个</span></div>
        </div>
      </div>
      <div class="uplist" id="uplist"></div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>确认推进</button>`,
    onMount(root, close) {
      const input = root.querySelector('#fileInput');
      const dropper = root.querySelector('#dropper');
      const listEl = root.querySelector('#uplist');

      const fmtSize = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(2) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

      const renderList = () => {
        if (!pending.length) { listEl.innerHTML = ''; return; }
        listEl.innerHTML = pending.map((f, i) => `<div class="upitem">
          ${f.isImage
            ? `<img class="thumb" src="${f.data}" alt="" />`
            : `<div class="thumb file">${icon('file', 15)}</div>`}
          <div class="meta">
            <div class="nm">${esc(f.name)}</div>
            <div class="sz">${fmtSize(f.size)}${f.isImage ? ' · 图片' : ''}</div>
          </div>
          <button class="icon-btn" data-rm="${i}" title="移除">${icon('close', 12)}</button>
        </div>`).join('');
        listEl.querySelectorAll('[data-rm]').forEach((b) => {
          b.onclick = () => { pending.splice(Number(b.dataset.rm), 1); renderList(); };
        });
      };

      const addFiles = (files) => {
        for (const f of files) {
          if (pending.length >= 5) { toast('最多上传 5 个附件', 'err'); break; }
          if (f.size > MAX) {
            toast(`「${f.name}」${fmtSize(f.size)}，超过 1 MB 上限`, 'err');
            continue;
          }
          if (pending.some((x) => x.name === f.name && x.size === f.size)) continue;
          const reader = new FileReader();
          reader.onload = () => {
            pending.push({
              name: f.name,
              size: f.size,
              mime: f.type || 'application/octet-stream',
              data: reader.result,
              isImage: /^image\//.test(f.type || ''),
            });
            renderList();
          };
          reader.onerror = () => toast(`「${f.name}」读取失败`, 'err');
          reader.readAsDataURL(f);
        }
      };

      input.onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
      dropper.onclick = (e) => { if (e.target !== input) input.click(); };
      ['dragenter', 'dragover'].forEach((ev) => dropper.addEventListener(ev, (e) => {
        e.preventDefault(); dropper.classList.add('over');
      }));
      ['dragleave', 'drop'].forEach((ev) => dropper.addEventListener(ev, (e) => {
        e.preventDefault(); dropper.classList.remove('over');
      }));
      dropper.addEventListener('drop', (e) => {
        if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
      });

      root.querySelector('[data-c]').onclick = close;
      root.querySelector('[data-ok]').onclick = async () => {
        const d = formData(root);
        const btn = root.querySelector('[data-ok]');
        btn.disabled = true;
        btn.textContent = pending.length ? '推进并上传…' : '处理中…';
        try {
          await api.post(`/api/opportunities/${o.id}/stage`, { stage: target, ...d });

          let uploaded = 0;
          for (const f of pending) {
            try {
              await api.post('/api/attachments', {
                target_type: 'opportunity',
                target_id: o.id,
                stage: target,
                name: f.name,
                mime: f.mime,
                data: f.data,
              });
              uploaded++;
            } catch (err) {
              toast(`「${f.name}」上传失败：${err.message}`, 'err');
            }
          }
          toast(
            pending.length
              ? `阶段已推进，上传 ${uploaded} 个附件`
              : '阶段已推进',
            'ok'
          );
          close();
          closeDrawer();
          ctx.refresh();
        } catch (e) {
          btn.disabled = false;
          btn.textContent = '确认推进';
          if (e.detail?.length) blockList('阶段推进条件未满足', e.detail);
          else toast(e.message, 'err');
        }
      };
    },
  });
}

function addOppActivity(o, closeDrawer, ctx) {
  modal({
    title: '记录跟进',
    width: 480,
    body: `<div class="stack">
      ${field('方式', 'type', { options: state.dict.activityTypes })}
      ${field('沟通内容', 'content', { type: 'textarea', required: true })}
      ${field('结果 / 客户反馈', 'result')}
    </div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn btn-primary" data-ok>保存</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').onclick = close;
      root.querySelector('[data-ok]').onclick = async () => {
        const d = formData(root);
        if (!d.content) return toast('请填写内容', 'err');
        try {
          await api.post(`/api/opportunities/${o.id}/activity`, d);
          toast('已记录', 'ok'); close(); closeDrawer();
          setTimeout(() => openOpp(o.id, ctx), 150);
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

function newQuote(o, closeDrawer, ctx) {
  openQuoteEditor({ opp: o, closeDrawer, ctx });
}
