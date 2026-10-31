/**
 * 单据统一外壳：A4 可打印页面。
 * 报价单、订单合同、条款合同共用一套排版规范，保证打印/另存 PDF 后可直接对外。
 */
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[c]);
export const num = (v, digits = 2) => Number(v || 0).toLocaleString('zh-CN', {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits
});
export const ymd = v => v ? String(v).slice(0, 10) : '—';
export function docShell({
  title,
  body,
  note = '',
  printHint = true
}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(title)}</title>
<style>
  :root { --ink:#1b1f27; --ink2:#3c4353; --muted:#6b7280; --line:#b7bfcd; --soft:#e6eaf1; --brand:#2b4a8b; }
  * { box-sizing: border-box; }
  body { margin:0; background:#eef1f6; color:var(--ink);
         font:13px/1.75 "Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif; -webkit-print-color-adjust: exact; }
  .bar { position:sticky; top:0; z-index:5; display:flex; align-items:center; gap:12px;
         padding:10px 20px; background:#fff; border-bottom:1px solid #dde3ec; }
  .bar .grow { flex:1; }
  .bar .hint { font-size:12px; color:var(--muted); }
  .bar button { height:32px; padding:0 14px; border:1px solid #ccd4e0; border-radius:6px; background:#fff; color:var(--ink2);
                font-size:12.5px; cursor:pointer; }
  .bar button.primary { background:var(--brand); border-color:var(--brand); color:#fff; }
  .doc { width:210mm; min-height:296mm; margin:18px auto 40px; padding:16mm 15mm 14mm; background:#fff;
         box-shadow:0 8px 30px rgba(17,24,39,.13); }
  h1 { margin:0; font-size:22px; letter-spacing:3px; font-weight:700; text-align:center; }
  .sub-title { text-align:center; font-size:12px; color:var(--muted); margin-top:2px; letter-spacing:.5px; }
  .head { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; padding-bottom:10px; border-bottom:2px solid var(--brand); }
  .brand-name { font-size:15px; font-weight:700; color:var(--brand); letter-spacing:.5px; }
  .brand-meta { font-size:11.5px; color:var(--muted); line-height:1.7; margin-top:3px; }
  .doc-no { text-align:right; font-size:12px; color:var(--ink2); line-height:1.9; white-space:nowrap; }
  .doc-no b { font-family:Consolas,Menlo,monospace; font-size:13px; color:var(--ink); }
  .parties { display:grid; grid-template-columns:1fr 1fr; gap:0; border:1px solid var(--line); margin-top:14px; }
  .party { padding:9px 12px; font-size:12px; line-height:1.95; }
  .party + .party { border-left:1px solid var(--line); }
  .party .tag { font-weight:700; color:var(--brand); margin-bottom:2px; }
  .party .row { display:flex; gap:6px; }
  .party .row span:first-child { color:var(--muted); flex:0 0 62px; }
  .party .row span:last-child { flex:1; min-width:0; word-break:break-all; }
  table.items { width:100%; border-collapse:collapse; margin-top:14px; font-size:12px; }
  table.items th, table.items td { border:1px solid var(--line); padding:6px 7px; }
  table.items th { background:#f4f6fa; font-weight:600; color:var(--ink2); text-align:center; }
  table.items td.c { text-align:center; }
  table.items td.r { text-align:right; font-variant-numeric:tabular-nums; }
  table.items tbody tr:nth-child(even) td { background:#fbfcfe; }
  .totals { margin-top:-1px; border:1px solid var(--line); border-top:0; padding:9px 12px; font-size:12.5px; }
  .totals .line { display:flex; justify-content:space-between; padding:2px 0; }
  .totals .line b { font-variant-numeric:tabular-nums; }
  .totals .grand { border-top:1px dashed var(--line); margin-top:5px; padding-top:6px; font-size:13.5px; }
  .totals .grand b { font-size:15px; color:#b23a2f; }
  .upper { margin-top:6px; font-size:12px; color:var(--ink2); }
  .upper b { font-weight:700; }
  h2.sec { font-size:13px; margin:18px 0 6px; padding-left:8px; border-left:3px solid var(--brand); line-height:1.2; }
  .text-block { font-size:12.5px; color:var(--ink2); line-height:1.95; white-space:pre-wrap; }
  .clause { margin-bottom:10px; font-size:12.5px; line-height:2; }
  .clause .t { font-weight:700; }
  .clause .b { color:var(--ink2); text-indent:2em; }
  .sign { display:grid; grid-template-columns:1fr 1fr; gap:40px; margin-top:34px; font-size:12.5px; }
  .sign .box { border-top:1px solid var(--line); padding-top:8px; line-height:2.2; }
  .sign .who { font-weight:700; }
  .foot { margin-top:22px; padding-top:8px; border-top:1px solid var(--soft); font-size:10.5px; color:var(--muted); text-align:center; }
  .badge-line { display:flex; gap:8px; align-items:center; justify-content:center; margin-top:6px; font-size:11px; color:var(--muted); }
  @media print {
    body { background:#fff; }
    .bar { display:none !important; }
    .doc { width:auto; min-height:auto; margin:0; padding:0; box-shadow:none; }
    @page { size:A4; margin:14mm 14mm 12mm; }
    table.items { page-break-inside:auto; }
    tr, .clause { page-break-inside:avoid; }
  }
</style>
</head>
<body>
<div class="bar">
  <span class="hint">${esc(note)}</span>
  <span class="grow"></span>
  ${printHint ? '<button class="primary" onclick="window.print()">打印 / 另存为 PDF</button>' : ''}
  <button onclick="window.close()">关闭</button>
</div>
<article class="doc">
${body}
</article>
</body>
</html>`;
}

/** 单据抬头：公司信息 + 编号信息 */
export function docHead({
  company,
  title,
  subtitle,
  meta
}) {
  return `<div class="head">
    <div>
      <div class="brand-name">${esc(company.name)}</div>
      <div class="brand-meta">
        ${company.address ? `地址：${esc(company.address)}<br/>` : ''}
        ${company.phone ? `电话：${esc(company.phone)}` : ''}${company.taxNo ? `　税号：${esc(company.taxNo)}` : ''}
      </div>
    </div>
    <div style="text-align:right">
      <h1 style="text-align:right;font-size:19px;letter-spacing:2px">${esc(title)}</h1>
      ${subtitle ? `<div style="font-size:11.5px;color:var(--muted)">${esc(subtitle)}</div>` : ''}
      <div class="doc-no">${meta}</div>
    </div>
  </div>`;
}

/** 甲乙方信息栏 */
export function partyBlock(left, right) {
  const rows = p => p.rows.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><span>${esc(v || '—')}</span></div>`).join('');
  return `<div class="parties">
    <div class="party"><div class="tag">${esc(left.tag)}</div>${rows(left)}</div>
    <div class="party"><div class="tag">${esc(right.tag)}</div>${rows(right)}</div>
  </div>`;
}