import { api } from '../api.js';
import { state } from '../store.js';
import { icon } from '../icons.js';
import { esc, money, amount, badge } from '../ui.js';

export async function render(el, route, ctx) {
  const d = await api.get('/api/reports');
  const maxMonth = Math.max(1, ...d.monthly.map((m) => Math.max(m.won, m.target)));
  const maxOrg = Math.max(1, ...d.byOrg.map((o) => o.won + o.pipeline));
  const maxInd = Math.max(1, ...d.byIndustry.map((o) => o.won + o.pipeline));

  el.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1>经营报表</h1>
        <div class="desc">按组织、行业、来源、人员四个维度看赢单与管道，数据随权限自动收口</div>
      </div>
      <div class="actions"><button class="btn" data-refresh>${icon('search', 13)} 刷新</button></div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="lb">本年度赢单</div><div class="vl">${money(d.summary.totalWon)}</div><div class="sb">已成交商机合计</div></div>
      <div class="kpi"><div class="lb">在谈管道</div><div class="vl">${money(d.summary.totalPipeline)}</div><div class="sb">未结束商机</div></div>
      <div class="kpi"><div class="lb">生效合同</div><div class="vl">${money(d.summary.signed)}</div><div class="sb">已回款 ${money(d.summary.received)}</div></div>
      <div class="kpi"><div class="lb">单均金额</div><div class="vl">${money(d.summary.avgDeal)}</div><div class="sb">${d.summary.wonCount} 个赢单 · ${d.summary.activeUsers} 人分单</div></div>
    </div>

    <div class="panel" style="margin-bottom:12px">
      <div class="panel-head"><h3>近 12 个月赢单与目标</h3>
        <span class="badge badge-gray">柱：赢单　线：目标</span></div>
      <div class="panel-body">
        <div class="bars" style="height:190px;gap:8px">
          ${d.monthly.map((m) => `<div class="bar-col">
            <div class="v">${m.won ? money(m.won) : ''}</div>
            <div class="b" style="height:${Math.max(2, (m.won / maxMonth) * 100)}%"></div>
            <div class="l">${m.month.slice(5)}月</div>
          </div>`).join('')}
        </div>
        <div class="muted" style="font-size:11.5px;margin-top:8px">
          指标口径：赢单金额按商机赢单时间归集；目标取该月销售目标合计。
        </div>
      </div>
    </div>

    <div class="grid2b">
      <div class="panel">
        <div class="panel-head"><h3>按组织</h3></div>
        <div class="panel-body flush">
          <table class="grid">
            <thead><tr><th>组织</th><th class="num">赢单</th><th class="num">管道</th><th>占比</th></tr></thead>
            <tbody>
              ${d.byOrg.length ? d.byOrg.map((o) => `<tr style="cursor:default">
                <td>${esc(o.parent_name ? o.parent_name + ' / ' : '')}${esc(o.name)}</td>
                <td class="num">${money(o.won)}</td>
                <td class="num muted">${money(o.pipeline)}</td>
                <td style="width:110px"><div class="kpi-progress"><i style="width:${(o.won / Math.max(1, d.summary.totalWon)) * 100}%"></i></div></td>
              </tr>`).join('') : '<tr><td colspan="4"><div class="empty" style="padding:26px">暂无数据</div></td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>按行业</h3></div>
        <div class="panel-body">
          <div class="funnel">
            ${d.byIndustry.slice(0, 8).map((i) => `<div class="fn-row">
              <div class="nm" style="width:76px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i.industry || '未分类')}</div>
              <div class="fn-bar"><i style="width:${Math.max(3, ((i.won + i.pipeline) / maxInd) * 100)}%;background:var(--accent)"></i>
                <span>${i.cnt} 个</span></div>
              <div class="amt">${money(i.won)}</div>
            </div>`).join('') || '<div class="muted">暂无数据</div>'}
          </div>
        </div>
      </div>
    </div>

    <div class="grid2b" style="margin-top:12px">
      <div class="panel">
        <div class="panel-head"><h3>线索来源转化</h3></div>
        <div class="panel-body flush">
          <table class="grid">
            <thead><tr><th>来源</th><th class="num">线索</th><th class="num">转商机</th><th class="num">转化率</th></tr></thead>
            <tbody>
              ${d.bySource.length ? d.bySource.map((s) => `<tr style="cursor:default">
                <td>${esc(s.source || '—')}</td>
                <td class="num">${s.total}</td>
                <td class="num">${s.converted}</td>
                <td class="num">${s.total ? ((s.converted / s.total) * 100).toFixed(0) : 0}%</td>
              </tr>`).join('') : '<tr><td colspan="4"><div class="empty" style="padding:26px">暂无数据</div></td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>人员产出</h3></div>
        <div class="panel-body flush">
          <table class="grid">
            <thead><tr><th>姓名</th><th class="num">赢单</th><th class="num">在谈</th><th class="num">单数</th></tr></thead>
            <tbody>
              ${d.byOwner.length ? d.byOwner.slice(0, 10).map((r) => `<tr style="cursor:default">
                <td>${esc(r.name)}</td>
                <td class="num">${money(r.won)}</td>
                <td class="num muted">${money(r.pipeline)}</td>
                <td class="num">${r.cnt}</td>
              </tr>`).join('') : '<tr><td colspan="4"><div class="empty" style="padding:26px">暂无数据</div></td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>`;

  el.querySelector('[data-refresh]').onclick = () => ctx.refresh();
  void amount; void badge;
}
