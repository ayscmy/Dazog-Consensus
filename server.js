// PC 盯盘看板 —— 零依赖本地代理服务
// 功能：服务端代拉新浪财经行情（带 Referer，绕过 403），解析为干净 JSON 供前端使用。
// 运行：node server.js   （或双击 start.bat）
// 访问：http://localhost:8080

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const SINA_HOST = 'https://hq.sinajs.cn/list=';

// ---------- 新浪行情解析 ----------
function classify(code) {
  if (code.startsWith('fx_')) return 'forex';
  if (code.startsWith('nf_')) {
    const sym = code.slice(3).toUpperCase();
    if (/^(IF|IC|IH|IM|T|TF|TS|TL)/.test(sym)) return 'indexFut';
    return 'commFut';
  }
  return 'stock'; // sh/sz 股票与指数共用股票格式
}

function parseLine(code, raw) {
  if (!raw || raw.trim() === '') return null;
  const p = raw.split(',');
  const type = classify(code);
  let open, high, low, price, prev, volume, oi;

  if (type === 'stock') {
    open = p[1]; high = p[4]; low = p[5]; price = p[3]; prev = p[2];
    volume = p[8]; oi = '';
  } else if (type === 'commFut') {
    open = p[2]; high = p[3]; low = p[4]; price = p[6]; prev = p[10];
    volume = p[13]; oi = p[14];
  } else if (type === 'forex') {
    // 外汇：p[0]=时间, p[1]=最新价, 其余为买卖/波动，仅取价
    open = ''; high = ''; low = ''; price = p[1]; prev = ''; volume = ''; oi = '';
  } else { // indexFut
    open = p[0]; high = p[1]; low = p[2]; price = p[3]; prev = p[16];
    volume = p[4]; oi = p[6];
  }

  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  const priceN = num(price);
  const prevN = num(prev);
  let change = null, pct = null;
  if (priceN !== null && prevN !== null && prevN !== 0) {
    change = +(priceN - prevN).toFixed(priceN < 10 ? 3 : 2);
    pct = +((change / prevN) * 100).toFixed(2);
  }

  // 时间字段：商品期货时间在第[1]列(HHMMSS)，股票/股指期货为 "日期,HH:MM:SS"
  const dateM = raw.match(/(\d{4}-\d{2}-\d{2})/);
  const date = dateM ? dateM[1] : '';
  let time = '';
  if (type === 'commFut') {
    if (/^\d{6}$/.test(p[1] || '')) time = p[1].slice(0, 2) + ':' + p[1].slice(2, 4) + ':' + p[1].slice(4, 6);
  } else {
    const tm = raw.match(/\d{4}-\d{2}-\d{2},(\d{2}:\d{2}:\d{2})/);
    if (tm) time = tm[1];
  }

  // A股成交量单位为"股"，转成"手"更直观
  const volN = num(volume);
  const finalVol = (type === 'stock' && volN !== null) ? volN / 100 : volN;

  return {
    code,
    type,
    price: priceN,
    change,
    pct,
    open: num(open),
    high: num(high),
    low: num(low),
    prev: prevN,
    volume: finalVol,
    oi: num(oi),
    date,
    time
  };
}

// ---------- 股票基本面（腾讯 gtimg）：返回 PE/PB/总市值等，失败返回 null ----------
async function fetchFundamentalBasic(code) {
  if (!code || code.startsWith('nf_') || code.startsWith('fx_')) return null;
  try {
    const url = `https://qt.gtimg.cn/q=${code}`;
    const r = await fetch(url, { headers: { 'Referer': 'https://gu.qq.com/', 'User-Agent': 'Mozilla/5.0' } });
    const buf = Buffer.from(await r.arrayBuffer());
    const text = buf.toString('latin1');
    const m = text.match(/="([^"]*)"/);
    const p = m ? m[1].split('~') : [];
    if (p.length <= 45) return null;
    return {
      name: p[1], code: p[2], price: parseFloat(p[3]) || null, prev: parseFloat(p[4]) || null,
      open: parseFloat(p[5]) || null, high: parseFloat(p[33]) || null, low: parseFloat(p[34]) || null,
      volume: parseFloat(p[36]) || null, amount: parseFloat(p[37]) || null,
      pe: parseFloat(p[39]) || null, amplitude: parseFloat(p[43]) || null,
      mktcap: parseFloat(p[45]) || null, turnover: parseFloat(p[38]) || null,
      pb: parseFloat(p[46]) || null, highs52: parseFloat(p[47]) || null, lows52: parseFloat(p[48]) || null
    };
  } catch (e) { return null; }
}

// 基本面评分（0-100）：PE/PB/市值 综合，纯数据驱动
function fundScoreFromBasic(b) {
  if (!b) return null;
  let s = 50;
  const pe = b.pe, pb = b.pb, cap = b.mktcap;
  if (pe != null) {
    if (pe > 0 && pe <= 15) s += 22; else if (pe <= 30) s += 15; else if (pe <= 50) s += 6;
    else if (pe > 50) s -= 6; else s -= 12; // 亏损
  }
  if (pb != null) {
    if (pb > 0 && pb < 1) s += 14; else if (pb <= 3) s += 9; else if (pb <= 6) s += 3; else s -= 6;
  }
  if (cap != null) { if (cap >= 1000) s += 5; else if (cap >= 100) s += 2; }
  return Math.max(0, Math.min(100, Math.round(s)));
}

// 多周期技术评分（0-100）：4h/1d/30m 方向 + 经典形态偏置
function techScoreFromBias(dir4h, dir1d, dir30m, patBias) {
  return Math.max(0, Math.min(100, Math.round(50
    + (dir4h === 'up' ? 15 : dir4h === 'down' ? -15 : 0)
    + (dir1d === 'up' ? 15 : dir1d === 'down' ? -15 : 0)
    + (dir30m === 'up' ? 10 : dir30m === 'down' ? -10 : 0)
    + (patBias > 0 ? 10 : patBias < 0 ? -10 : 0))));
}

// 分批并发拉取，单批不超过 50 个 code（避免 URL 超长），返回顺序与入参一致，
// 取不到的 code 也返回占位对象（price=null），保证前端列表稳定。
async function fetchQuotes(codes) {
  const all = [...new Set(codes.filter(Boolean))];
  if (!all.length) return [];
  const CHUNK = 50;
  const map = new Map();
  const chunks = [];
  for (let i = 0; i < all.length; i += CHUNK) chunks.push(all.slice(i, i + CHUNK));
  await Promise.all(chunks.map(async (c) => {
    const list = c.join(',');
    try {
      const res = await fetchTimeout(SINA_HOST + list, {
        headers: { 'Referer': 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' }
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const text = buf.toString('latin1');
      const re = /var hq_str_([^=]+)="([^"]*)"/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const code = m[1].trim();
        const item = parseLine(code, m[2]);
        if (item) map.set(code, item);
      }
    } catch (e) { /* 单批失败不影响其他批 */ }
  }));
  return all.map(code => map.get(code) || { code, type: classify(code), price: null, change: null, pct: null, open: null, high: null, low: null, prev: null, volume: null, oi: null, date: '', time: '', error: 'no data' });
}

// ---------- K 线 / 多周期分析 ----------
const A = require('./analysis.js');
const KLINE_CACHE = new Map(); // 60s TTL，避免重复拉取
let DAILY_CACHE = null;        // 每日方案 5 分钟缓存

// 并发受限的 map（避免一次性打满新浪）
async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const r = await Promise.all(batch.map(fn));
    out.push(...r);
  }
  return out;
}

// ---------- 数据源健壮性：超时 + 重试 + 统一头（防限流/防封） ----------
async function fetchTimeout(url, opts = {}, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, headers = {}, timeout = 8000, retries = 2) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetchTimeout(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://data.eastmoney.com/', ...headers }
      }, timeout);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise(res => setTimeout(res, 300 * (i + 1)));
    }
  }
  throw lastErr || new Error('fetchJson failed');
}

// 东财数据中心查询封装：reportName + filter → data 数组
async function emData(reportName, filter, { columns = 'ALL', pageSize = 5, sortColumns = '', sortTypes = '-1' } = {}) {
  const q = new URLSearchParams({
    reportName, columns, pageNumber: '1', pageSize: String(pageSize)
  });
  if (sortColumns) { q.set('sortColumns', sortColumns); q.set('sortTypes', sortTypes); }
  if (filter) q.set('filter', filter);
  const j = await fetchJson('https://datacenter-web.eastmoney.com/api/data/v1/get?' + q.toString());
  return (j && j.result && j.result.data) || [];
}

// 每日推荐方案扫描池（流动性较好的龙头 + 主要期货主连）
const DEFAULT_PLAN_POOL = [
  'sh000001', 'sz399001', 'sz399006', 'sh000300', 'sh000905',
  'sh600519', 'sz000858', 'sz300750', 'sh601318', 'sh600036',
  'sz000333', 'sh600276', 'sz002594', 'sh601012', 'sh600887',
  'sz000651', 'sh600030', 'sz300059', 'sh601899', 'sz002415',
  'sh600900', 'sh600309', 'sz002714', 'sh603259', 'sh688981',
  'nf_AG0', 'nf_AU0', 'nf_RB0', 'nf_CU0', 'nf_I0',
  'nf_M0', 'nf_SC0', 'nf_CF0', 'nf_TA0', 'nf_SA0',
  'nf_HC0', 'nf_IF0', 'nf_IC0', 'nf_OI0', 'nf_FU0'
];

// 实时代码 -> K 线目标（商品期货小写、股指期货大写）
function klineTarget(code) {
  if (code.startsWith('nf_')) {
    let s = code.slice(3);
    if (/^I[CFHM]0?$/i.test(s)) s = s.toUpperCase();
    else s = s.toLowerCase();
    return { sym: s, source: 'fut' };
  }
  return { sym: code, source: 'stock' };
}

// ---------- 全时间帧 K 线 ----------
// frame: 1m/5m/15m/30m/1h/4h/day/week/month
// 股票：1m 走 quotes.sina.cn；5/15/30/60m 走 money 接口；day 用 scale=240（返回日线）；4h 由 60m 聚合；week/month 由日线聚合
// 期货：1/5/15/30/60/240m 走 getFewMinLine；day 走 getDailyKLine；week/month 由日线聚合
const FRAME_MAP = {
  '1m': { lab: '1分钟', futType: 1, agg: null },
  '5m': { lab: '5分钟', futType: 5, agg: null },
  '15m': { lab: '15分钟', futType: 15, agg: null },
  '30m': { lab: '30分钟', futType: 30, agg: null },
  '1h': { lab: '1小时', futType: 60, agg: null },
  '4h': { lab: '4小时', futType: 240, agg: '4h' },
  'day': { lab: '日线', futType: null, agg: null },
  'week': { lab: '周线', futType: null, agg: 'week' },
  'month': { lab: '月线', futType: null, agg: 'month' }
};
const FRAME_ORDER = ['1m', '5m', '15m', '30m', '1h', '4h', 'day', 'week', 'month'];

// 把低周期 bars 聚合成高周期（O=首根o, H=max, L=min, C=末根c, V=sum）
// target: '4h'（由 60m 聚合）/ 'week' / 'month'（由日线聚合）
function aggregateBars(bars, target) {
  const groups = new Map();
  const keyOf = (t) => {
    if (target === '4h') {
      const dt = new Date(t.replace(' ', 'T'));
      return Math.floor(dt.getTime() / (4 * 3600 * 1000));
    }
    const d = String(t).slice(0, 10);
    if (target === 'week') {
      const dt = new Date(d + 'T00:00:00');
      const day = (dt.getDay() + 6) % 7; // 周一=0
      const mon = new Date(dt); mon.setDate(dt.getDate() - day);
      return mon.toISOString().slice(0, 10);
    }
    return d.slice(0, 7); // month: YYYY-MM
  };
  for (const b of bars) {
    const k = keyOf(b.t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }
  const out = [];
  for (const [k, list] of groups) {
    out.push({
      t: target === '4h' ? list[0].t : k,
      o: list[0].o,
      h: Math.max(...list.map(b => b.h)),
      l: Math.min(...list.map(b => b.l)),
      c: list[list.length - 1].c,
      v: list.reduce((s, b) => s + (b.v || 0), 0)
    });
  }
  return out.sort((a, b) => a.t < b.t ? -1 : 1);
}

async function fetchRawKline(sym, frame, source) {
  const key = `${sym}_${frame}_${source}`;
  const cached = KLINE_CACHE.get(key);
  if (cached && Date.now() - cached.t < 60000) return cached.data;

  let data;
  if (source === 'fut') {
    if (frame === 'day' || frame === 'week' || frame === 'month') {
      // 日线走 getDailyKLine；周/月由日线聚合
      const url = `https://stock2.finance.sina.com.cn/futures/api/json.php/InnerFuturesNewService.getDailyKLine?symbol=${sym}`;
      const r = await fetch(url, { headers: { 'Referer': 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' } });
      data = await r.json();
      if (frame === 'week' || frame === 'month') {
        data = { __aggregate: true, frame, bars: aggregateBars(A.normalize(data, 'sina_fut'), frame) };
      }
    } else {
      const type = FRAME_MAP[frame].futType;
      const url = `https://stock2.finance.sina.com.cn/futures/api/json.php/InnerFuturesNewService.getFewMinLine?symbol=${sym}&type=${type}`;
      const r = await fetch(url, { headers: { 'Referer': 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' } });
      data = await r.json();
      if (frame === '4h' && type === 240) {
        // getFewMinLine type=240 已是4小时线，直接可用
      }
    }
  } else {
    // 股票
    if (frame === '1m') {
      const url = `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_t=/CN_MarketDataService.getKLineData?symbol=${sym}&scale=1&ma=no&datalen=480`;
      const r = await fetch(url, { headers: { 'Referer': 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' } });
      const txt = await r.text();
      const m = txt.match(/\((\[.*\])\)\s*;?\s*$/s) || txt.match(/=\s*(\[.*\])\s*;?\s*$/s);
      data = m ? JSON.parse(m[1]) : [];
    } else if (frame === 'day' || frame === 'week' || frame === 'month') {
      // 股票日线：新浪优先，被反爬/限流则降级东财（前复权）；周/月由日线聚合
      data = null;
      try {
        const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=600`;
        const r = await fetchTimeout(url, { headers: { 'Referer': 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' } });
        const t = await r.text();
        if (t && t.trim().startsWith('[')) data = JSON.parse(t);
      } catch (e) { data = null; }
      if (!data) {
        // 降级：腾讯前复权日线（qfqday）
        const tu = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,,,600,qfq`;
        const j = await fetchJson(tu, { 'Referer': 'https://gu.qq.com/' });
        const tk = j && j.data && j.data[sym];
        data = ((tk && (tk.qfqday || tk.day)) || []).map(p => ({ day: p[0], open: p[1], close: p[2], high: p[3], low: p[4], volume: p[5] }));
      }
      if (frame === 'week' || frame === 'month') {
        data = { __aggregate: true, frame, bars: aggregateBars(A.normalize(data, 'sina_stock'), frame) };
      }
    } else {
      // 股票 5/15/30/60m；4h 由 60m 聚合（scale=60）。新浪优先，反爬则降级东财
      const scale = (frame === '4h') ? 60 : (FRAME_MAP[frame].futType || 60);
      data = null;
      try {
        const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=${scale}&ma=no&datalen=500`;
        const r = await fetchTimeout(url, { headers: { 'Referer': 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' } });
        const t = await r.text();
        if (t && t.trim().startsWith('[')) data = JSON.parse(t);
      } catch (e) { data = null; }
      if (!data) {
        // 降级：腾讯分钟线（mkline，字段 [时间,开,收,高,低,量]）
        const tu = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${sym},m${scale},,320`;
        const j = await fetchJson(tu, { 'Referer': 'https://gu.qq.com/' });
        const tk = j && j.data && j.data[sym];
        const fmtTq = s => (/^\d{12}$/.test(s) ? s.replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1-$2-$3 $4:$5') : s);
        data = ((tk && tk['m' + scale]) || []).map(p => ({ day: fmtTq(p[0]), open: p[1], close: p[2], high: p[3], low: p[4], volume: p[5] }));
      }
      if (frame === '4h') {
        // 股票 4h 由 60m 聚合
        data = { __aggregate: true, frame, bars: aggregateBars(A.normalize(data, 'sina_stock'), '4h') };
      }
    }
  }

  KLINE_CACHE.set(key, { t: Date.now(), data });
  return data;
}

async function fetchKline(sym, tf, source) {
  // 兼容旧调用：数字 tf 映射为 frame；否则原样
  const frame = (typeof tf === 'number') ? ({ 1: '1m', 5: '5m', 15: '15m', 30: '30m', 60: '1h', 240: '4h' }[tf] || String(tf)) : tf;
  const raw = await fetchRawKline(sym, frame, source);
  if (raw && raw.__aggregate) return raw.bars; // 已聚合好的 [{t,o,h,l,c,v}]
  return raw;
}

function normBars(raw, source) {
  // 已聚合好的 [{t,o,h,l,c,v}] 直接返回；否则按原始 JSON 规范化
  if (Array.isArray(raw) && raw.length && raw[0] && typeof raw[0] === 'object' && 't' in raw[0]) return raw;
  return A.normalize(raw, source === 'fut' ? 'sina_fut' : 'sina_stock');
}

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/quotes') {
    const list = (url.searchParams.get('list') || '').split(',').map(s => s.trim()).filter(Boolean);
    try {
      const data = await fetchQuotes(list);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, ts: Date.now(), data }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 全量品种清单（期货展开为主连+主力两条；股票/ETF/指数）
  if (url.pathname === '/api/markets') {
    try {
      const futuresRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'futures.json'), 'utf-8'));
      const stocks = JSON.parse(fs.readFileSync(path.join(__dirname, 'stocks.json'), 'utf-8'));
      const futures = [];
      for (const f of futuresRaw) {
        futures.push({ code: f.main.code, name: f.main.name, kind: 'future', sub: '主连', exch: f.exch, sector: f.kind, underlying: f.underlying });
        if (f.dominant) futures.push({ code: f.dominant.code, name: f.dominant.name, kind: 'future', sub: '主力', exch: f.exch, sector: f.kind, underlying: f.underlying });
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, futures, stocks }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // K 线原始数据（前端绘图用）；tf 支持 1m/5m/15m/30m/1h/4h/day/week/month 或数字(兼容旧)
  if (url.pathname === '/api/kline') {
    const code = (url.searchParams.get('code') || '').trim();
    let tf = (url.searchParams.get('tf') || '5').trim();
    if (/^\d+$/.test(tf)) tf = ({ 1: '1m', 5: '5m', 15: '15m', 30: '30m', 60: '1h', 240: '4h' }[tf] || '5m');
    if (!code) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'code required' })); return; }
    try {
      const { sym, source } = klineTarget(code);
      const raw = await fetchKline(sym, tf, source);
      const bars = normBars(raw, source).slice(-300);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, code, symbol: sym, tf, bars }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 全部时间周期 K 线（焦点显示所有周期用）
  if (url.pathname === '/api/alltf') {
    const code = (url.searchParams.get('code') || '').trim();
    if (!code) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'code required' })); return; }
    try {
      const { sym, source } = klineTarget(code);
      const frames = {};
      await Promise.all(FRAME_ORDER.map(async (fr) => {
        try {
          const raw = await fetchKline(sym, fr, source);
          const bars = normBars(raw, source).slice(-200);
          frames[fr] = bars;
        } catch (e) { frames[fr] = []; }
      }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, code, symbol: sym, frames }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 每周/每日关注板块（基于真实行情聚合：股票按 sector、期货按 kind 平均涨跌幅）
  if (url.pathname === '/api/focus-sectors') {
    try {
      const futuresRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'futures.json'), 'utf-8'));
      const stocks = JSON.parse(fs.readFileSync(path.join(__dirname, 'stocks.json'), 'utf-8'));
      // 板块清单：股票 sector + 期货 kind（主连代表）
      const sectorOf = new Map(); // code -> {name, group}
      stocks.forEach(s => { if (s.sector) sectorOf.set(s.code, { name: s.sector, group: '股票' }); });
      futuresRaw.forEach(f => { sectorOf.set(f.main.code, { name: f.kind, group: '期货' }); });

      // 每日关注：当日全市场涨跌幅按板块聚合
      const allCodes = [...sectorOf.keys()];
      const q = await fetchQuotes(allCodes);
      const dailyMap = new Map();
      q.forEach(x => {
        const sec = sectorOf.get(x.code);
        if (!sec || x.pct == null || Math.abs(x.pct) > 30) return; // 过滤解析异常的价位
        if (!dailyMap.has(sec.name)) dailyMap.set(sec.name, { name: sec.name, group: sec.group, sum: 0, n: 0, codes: [] });
        const d = dailyMap.get(sec.name);
        d.sum += x.pct; d.n++; d.codes.push(x.code);
      });
      const daily = [...dailyMap.values()].map(d => ({
        name: d.name, group: d.group,
        avg: +(d.sum / d.n).toFixed(2), n: d.n,
        rep: d.codes[0]
      })).sort((a, b) => b.avg - a.avg);

      // 每周关注：各板块代表标的近 5 个交易日累计涨跌（日线聚合）
      const weeklyMap = new Map();
      await mapLimit([...dailyMap.values()], 8, async (d) => {
        try {
          const rep = d.codes[0];
          const { sym, source } = klineTarget(rep);
          const raw = await fetchKline(sym, 'day', source);
          const bars = normBars(raw, source).slice(-6);
          if (bars.length >= 5) {
            const first = bars[0].c, last = bars[bars.length - 1].c;
            weeklyMap.set(d.name, { name: d.name, group: d.group, chg: +((last / first - 1) * 100).toFixed(2), rep });
          }
        } catch (e) {}
      });
      const weekly = [...weeklyMap.values()].sort((a, b) => b.chg - a.chg);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, ts: Date.now(), daily: daily.slice(0, 12), weekly: weekly.slice(0, 12) }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 多周期价格行为分析（4h定阶段 / 1h方向 / 30m段落 / 5m信号 / S/R / 共振 / 决策卡）
  if (url.pathname === '/api/analyze') {
    const code = (url.searchParams.get('code') || '').trim();
    const srPct = parseFloat(url.searchParams.get('srPct')) || 0.004;
    const account = parseFloat(url.searchParams.get('account')) || 100000;
    const riskPct = parseFloat(url.searchParams.get('riskPct')) || 0.02;
    if (!code) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'code required' })); return; }
    try {
      const { sym, source } = klineTarget(code);
      const [h4raw, h1raw, m30raw, m5raw, q] = await Promise.all([
        fetchKline(sym, '4h', source),
        fetchKline(sym, 60, source),
        fetchKline(sym, 30, source),
        fetchKline(sym, 5, source),
        fetchQuotes([code])
      ]);
      const h4 = normBars(h4raw, source).slice(-120);
      const h1 = normBars(h1raw, source).slice(-200);
      const m30 = normBars(m30raw, source).slice(-200);
      const m5 = normBars(m5raw, source).slice(-240);
      const live = (q[0] && q[0].price != null) ? q[0].price : (m5[m5.length - 1] && m5[m5.length - 1].c);
      const result = A.analyze({ h1, m30, m5, livePrice: live, srPct });
      // 注入信号根（决策卡用）
      result._sigBar = m5[m5.length - 2] || null;
      // 4h 定阶段
      result.dir4h = A.phase4h(h4);
      // 4h vs 1h 一致性
      const ph = result.dir4h.bias, d1 = result.dir1h.bias;
      if (ph !== 'range' && d1 !== 'range') {
        result.align4h1h = (ph === d1) ? 'same' : 'opposite';
        result.align4h1hTip = (ph === d1) ? '4h与1h同向，顺势' : '4h与1h背离：1h信号需谨慎（逆势反弹/回调段）';
      } else {
        result.align4h1h = 'neutral';
        result.align4h1hTip = '4h或1h处于震荡，无明确方向共振';
      }
      // 决策卡
      result.decision = A.buildDecision(result, result.dir4h, { account, riskPct });
      // 决策链指标（4h/1h MACD、30m KD、5m MA）+ 铁律
      result.ind = A.indicators({ h4, h1, m30, m5 });
      // 缠论基础版（1h 级别：分型/笔/中枢/一类买卖点）
      result.chan = A.chan(h1);
      // 经典形态识别（1h/4h 级别）
      result.patterns = A.detectClassicPatterns(h1);
      const pat4 = A.detectClassicPatterns(h4);
      if (pat4.length) result.patterns = result.patterns.concat(pat4.map(p => ({ ...p, tf: '4h' })));
      if (result.patterns.length) result.patterns = result.patterns.map(p => ({ ...p, tf: p.tf || '1h' }));
      // 技术面评分（多周期方向 + 形态偏置），基本面评分由 /api/mtf 注入后合成综合分
      const patBiasAll = (result.patterns || []).reduce((s, p) => s + (p.dir === 'bull' ? 1 : p.dir === 'bear' ? -1 : 0), 0);
      result.techScore = techScoreFromBias(result.dir4h.bias, result.dir1h.bias, result.dir30m.bias, patBiasAll);
      result.score = result.techScore;
      // 斐波那契 + 趋势线（4h 图自动叠加）
      result.fib = A.fibLevels(h4);
      result.trend = A.trendlines(h4);
      // 铁律叠加进决策卡：J 超买禁多 / 超卖禁空
      const indRule = result.ind && result.ind.rule;
      if (indRule && result.decision) {
        const blocked = result.decision.action === 'buy' && indRule.block === 'bull';
        const blockedShort = result.decision.action === 'sell' && indRule.block === 'bear';
        if (blocked || blockedShort) {
          result.decision.blocked = true;
          result.decision.blockReason = indRule.msg;
          result.decision.action = 'wait';
          result.decision.bias = '观望';
          result.decision.entry = null; result.decision.stop = null; result.decision.targets = [];
        }
        if (result.decision && !result.decision.blocked) result.decision.ruleNote = indRule.msg;
      }
      result.code = code;
      result.symbol = sym;
      result.bars = { h4, h1, m30, m5 };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, ts: Date.now(), data: result }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 批量 S/R 临近扫描（看板列表小徽标用；结果缓存 15s，前端轮询直接命中）
  if (url.pathname === '/api/sr-scan') {
    const list = (url.searchParams.get('list') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 60);
    const srPct = parseFloat(url.searchParams.get('srPct')) || 0.004;
    const cacheKey = 'srscan_' + list.join(',') + '_' + srPct;
    const cached = KLINE_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.t < 15000) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(cached.v));
      return;
    }
    const out = [];
    await Promise.all(list.map(async (code) => {
      try {
        const { sym, source } = klineTarget(code);
        const [h1raw, m30raw, q] = await Promise.all([fetchKline(sym, 60, source), fetchKline(sym, 30, source), fetchQuotes([code])]);
        const h1 = normBars(h1raw, source).slice(-200);
        const m30 = normBars(m30raw, source).slice(-200);
        const live = (q[0] && q[0].price != null) ? q[0].price : (m30[m30.length - 1] && m30[m30.length - 1].c);
        const r = A.analyze({ h1, m30, m5: h1, livePrice: live, srPct });
        out.push({
          code,
          dir: r.dir1h.bias,
          near: r.atSupport ? 'support' : r.atResistance ? 'resistance' : null,
          nearest: r.nearest ? { price: +r.nearest.price.toFixed(2), type: r.nearest.type, distPct: +(r.nearest.distPct * 100).toFixed(2) } : null
        });
      } catch (e) { out.push({ code, error: String(e) }); }
    }));
    const v = { ok: true, ts: Date.now(), data: out };
    KLINE_CACHE.set(cacheKey, { t: Date.now(), v });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(v));
    return;
  }

  // 多周期方向 + 经典形态 + 日/周开盘价 + 技术/基本面综合评分（列表批量用，30s 缓存）
  if (url.pathname === '/api/mtf') {
    const list = (url.searchParams.get('list') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 160);
    const withFund = url.searchParams.get('fund') !== '0';
    const cacheKey = 'mtf_' + list.join(',') + (withFund ? '_f' : '');
    const cached = KLINE_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.t < 30000) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(cached.v));
      return;
    }
    const out = [];
    await mapLimit(list, 8, async (code) => {
      try {
        const { sym, source } = klineTarget(code);
        const [dayRaw, h4Raw, m30Raw, weekRaw] = await Promise.all([
          fetchKline(sym, 'day', source), fetchKline(sym, '4h', source),
          fetchKline(sym, '30m', source), fetchKline(sym, 'week', source)
        ]);
        const day = normBars(dayRaw, source).slice(-120);
        const h4 = normBars(h4Raw, source).slice(-120);
        const m30 = normBars(m30Raw, source).slice(-200);
        const week = normBars(weekRaw, source).slice(-60);
        const daySw = A.detectSwings(day);
        const dir1d = A.trendFromSwings(daySw.highs, daySw.lows).bias;
        const dir4h = A.phase4h(h4).bias;
        const m30Sw = A.detectSwings(m30);
        const dir30m = A.trendFromSwings(m30Sw.highs, m30Sw.lows).bias;
        const weekOpen = week.length ? week[week.length - 1].o : null;
        const dayOpen = day.length ? day[day.length - 1].o : null;
        const patterns = [].concat(
          A.detectClassicPatterns(day).map(p => ({ ...p, tf: 'day' })),
          A.detectClassicPatterns(h4).map(p => ({ ...p, tf: '4h' })),
          A.detectClassicPatterns(m30).map(p => ({ ...p, tf: '30m' }))
        );
        const patBias = patterns.reduce((s, p) => s + (p.dir === 'bull' ? 1 : p.dir === 'bear' ? -1 : 0), 0);
        const techScore = techScoreFromBias(dir4h, dir1d, dir30m, patBias);
        let fundScore = null;
        if (withFund && !code.startsWith('nf_') && !code.startsWith('fx_')) {
          try { const fb = await fetchFundamentalBasic(code); if (fb) fundScore = fundScoreFromBasic(fb); } catch (e) {}
        }
        const score = (fundScore != null) ? Math.max(0, Math.min(100, Math.round(techScore * 0.6 + fundScore * 0.4))) : techScore;
        out.push({ code, dir1d, dir4h, dir30m, weekOpen, dayOpen, patterns, techScore, fundScore, score });
      } catch (e) { out.push({ code, error: String(e) }); }
    });
    const v = { ok: true, ts: Date.now(), data: out };
    KLINE_CACHE.set(cacheKey, { t: Date.now(), v });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(v));
    return;
  }

  // 关联品种（标的 + 关联商品，点击进入实时 K 线）
  if (url.pathname === '/api/related') {
    const code = (url.searchParams.get('code') || '').trim();
    try {
      const futuresRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'futures.json'), 'utf-8'));
      const stocks = JSON.parse(fs.readFileSync(path.join(__dirname, 'stocks.json'), 'utf-8'));
      const fAll = [];
      futuresRaw.forEach(f => {
        fAll.push({ code: f.main.code, name: f.main.name, kind: f.kind });
        if (f.dominant) fAll.push({ code: f.dominant.code, name: f.dominant.name, kind: f.kind });
      });
      const selfF = fAll.find(x => x.code === code);
      const selfS = stocks.find(x => x.code === code);
      let related = [];
      if (selfF) {
        related = fAll.filter(x => x.kind === selfF.kind && x.code !== code).slice(0, 10)
          .map(x => ({ code: x.code, name: x.name, reason: x.kind + '·同板块' }));
      } else if (selfS && selfS.sector) {
        related = stocks.filter(x => x.sector === selfS.sector && x.code !== code).slice(0, 10)
          .map(x => ({ code: x.code, name: x.name, reason: selfS.sector }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, code, related }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 宏观 / 商品实时（真实可得源：人民币、沪金、原油、沪铜、螺纹、铁矿、豆粕、指数）
  // 返回 data(实时10项) + daily(每日宏观速览) + weekly(每周宏观：日线近5日聚合)
  if (url.pathname === '/api/macro') {
    try {
      // 北向资金（沪深港通成交 + 领涨股；实时净买入已于 2024-08 起停止披露）
      let north = null;
      try {
        const nb = await emData('RPT_MUTUAL_DEAL_HISTORY', '', { pageSize: 2, sortColumns: 'TRADE_DATE', sortTypes: '-1' });
        north = nb.map(x => ({ date: (x.TRADE_DATE || '').slice(0, 10), type: x.MUTUAL_TYPE, dealAmt: x.DEAL_AMT, leadStock: x.LEAD_STOCKS_NAME, leadCode: x.LEAD_STOCKS_CODE, indexClose: x.INDEX_CLOSE_PRICE, indexChg: x.INDEX_CHANGE_RATE }));
      } catch (e) {}
      const codes = ['fx_susdcny', 'fx_susdcnh', 'nf_AU0', 'nf_SC0', 'nf_CU0', 'nf_RB0', 'nf_I0', 'nf_M0', 'sh000001', 'sz399006'];
      const q = await fetchQuotes(codes);
      const m = {}; q.forEach(x => { m[x.code] = x; });
      const pick = (c, k) => ({ key: k, code: c, price: m[c] ? m[c].price : null, pct: m[c] ? m[c].pct : null });
      const data = [
        pick('fx_susdcny', '在岸人民币'), pick('fx_susdcnh', '离岸人民币'),
        pick('nf_AU0', '沪金主连'), pick('nf_SC0', '原油主连'), pick('nf_CU0', '沪铜主连'),
        pick('nf_RB0', '螺纹主连'), pick('nf_I0', '铁矿主连'), pick('nf_M0', '豆粕主连'),
        pick('sh000001', '上证指数'), pick('sz399006', '创业板指')
      ];
      // 每日宏观速览（真实当日）
      const sh = m['sh000001'], cyb = m['sz399006'], gold = m['nf_AU0'], oil = m['nf_SC0'], cu = m['nf_CU0'], rb = m['nf_RB0'], i = m['nf_I0'], m5 = m['nf_M0'], rmb = m['fx_susdcny'];
      const comUp = [gold, oil, cu, rb, i, m5].filter(x => x && x.pct != null && x.pct > 0).length;
      const comDown = [gold, oil, cu, rb, i, m5].filter(x => x && x.pct != null && x.pct < 0).length;
      const daily = {
        points: [
          `大盘 上证 ${fmtPct(sh)} / 创业 ${fmtPct(cyb)}`,
          `商品 沪金 ${fmtPct(gold)} · 原油 ${fmtPct(oil)} · 沪铜 ${fmtPct(cu)} · 螺纹 ${fmtPct(rb)} · 铁矿 ${fmtPct(i)} · 豆粕 ${fmtPct(m5)}`,
          `汇率 在岸 ${rmb && rmb.price != null ? rmb.price : '—'}`
        ],
        text: (function(){
          let s = `今日大盘上证${fmtPct(sh)}、创业板${fmtPct(cyb)}；商品${comUp}涨${comDown}跌（沪金${fmtPct(gold)}/原油${fmtPct(oil)}/沪铜${fmtPct(cu)}/螺纹${fmtPct(rb)}/铁矿${fmtPct(i)}/豆粕${fmtPct(m5)}）；人民币在岸${rmb ? rmb.price : '—'}。`;
          const bullN = (sh && sh.pct > 0 ? 1 : 0) + (cyb && cyb.pct > 0 ? 1 : 0) + comUp;
          if (north && north.length) {
            const totalAmt = north.reduce((s, x) => s + (x.dealAmt || 0), 0);
            if (totalAmt > 0) s += `北向成交 ${(totalAmt / 1e4).toFixed(0)} 亿，领涨股 ${north[0].leadStock || '—'}。`;
          }
          s += (bullN >= 4) ? '综合宏观偏多（股商共振向上）。' : (bullN <= 1) ? '综合宏观偏空（风险偏好收缩）。' : '宏观中性震荡。';
          return s;
        })()
      };
      // 每周宏观速览：代表标的日线近5个交易日累计涨跌
      const weeklyCodes = [
        { code: 'sh000001', label: '上证指数' }, { code: 'sz399006', label: '创业板指' },
        { code: 'nf_AU0', label: '沪金' }, { code: 'nf_SC0', label: '原油' }, { code: 'nf_CU0', label: '沪铜' },
        { code: 'nf_RB0', label: '螺纹' }, { code: 'nf_I0', label: '铁矿' }, { code: 'nf_M0', label: '豆粕' }
      ];
      const weekly = { points: [], text: '' };
      const wkItems = await mapLimit(weeklyCodes, 4, async (w) => {
        try {
          const { sym, source } = klineTarget(w.code);
          const raw = await fetchKline(sym, 'day', source);
          const bars = normBars(raw, source).slice(-6);
          if (bars.length >= 5) {
            const chg = (bars[bars.length - 1].c / bars[0].c - 1) * 100;
            return { label: w.label, chg: +chg.toFixed(2) };
          }
          return null;
        } catch (e) { return null; }
      });
      const wk = wkItems.filter(Boolean);
      weekly.points = wk.map(x => `${x.label} ${x.chg > 0 ? '+' : ''}${x.chg}%`);
      const wUp = wk.filter(x => x.chg > 0).length, wDown = wk.filter(x => x.chg < 0).length;
      weekly.text = `本周累计：${weekly.points.join('、') || '—'}。${wUp >= wDown ? '周线偏多（多数资产收涨）。' : '周线偏空（多数资产收跌）。'}`;

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, ts: Date.now(), data, daily, weekly, north, guide: macroGuide(data, m) }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 教材《证券宏观分析与投资策略》结构化数据 → 前端「宏观策略手册」
  // 返回：五维度(附带当前真实代理数据方向) + 会议日历(下一会议/当月高亮) + 业绩季(当前阶段)
  function macroGuide(data, m) {
    let guide = null;
    try { guide = JSON.parse(fs.readFileSync(path.join(__dirname, 'macro_guide.json'), 'utf-8')); } catch (e) { return null; }
    const now = new Date();
    const curMonth = now.getMonth() + 1;
    // 五维度：附加当前代理数据方向
    const proxied = {};
    (data || []).forEach(x => { if (x.price != null) proxied[x.code] = x; });
    const dims = (guide.dimensions || []).map(d => {
      const p = (d.proxies || []).map(c => {
        const q = m[c];
        return q ? { code: c, price: q.price, pct: q.pct } : { code: c, price: null, pct: null };
      });
      return { ...d, live: p };
    });
    // 会议日历：标注当前月、计算下一场（按 月+日，跨年取下一场）
    const cal = (guide.calendar || []).map(ev => {
      const day = ev.day || 15;
      let dt = new Date(now.getFullYear(), ev.month - 1, Math.min(day, 28));
      return { ...ev, currentMonth: ev.month === curMonth, dt: dt.getTime() };
    });
    const future = cal.filter(ev => ev.dt >= now.getTime()).sort((a, b) => a.dt - b.dt);
    const nextCal = future.length ? future[0] : cal.slice().sort((a, b) => a.dt - b.dt)[0];
    // 业绩季：当前处于哪个披露期
    const mo = now.getMonth() + 1;
    const earningsNow = mo === 4 ? '一季报披露期(4月)' : (mo >= 7 && mo <= 8) ? '半年报披露期(7-8月)' : mo === 10 ? '三季报披露期(10月)' : (mo >= 1 && mo <= 4) ? '年报披露期(1-4月)' : '非密集披露期';
    return {
      ...guide, // 保留教材全量结构化内容（含 industryCycle/twoSessions/hedge/allocation 等）
      dims, calendar: cal, nextCal: nextCal ? { event: nextCal.event, level: nextCal.level, month: nextCal.month, focus: nextCal.focus } : null,
      earningsNow
    };
  }

  function fmtPct(x){ if(!x || x.pct == null) return '—'; return (x.pct > 0 ? '+' : '') + x.pct + '%'; }

  // 股指期货价差日报：期现价差 + 跨期价差 + 跨品种比值
  // 数据来自新浪实时行情 + 本地日线 K 线；历史分位数按近 120 个交易日样本估算
  if (url.pathname === '/api/futures-spread') {
    try {
      const idxMap = [
        { key: 'IF', name: '沪深300股指', futMain: 'nf_IF0', futDom: 'nf_IF2609', spot: 'sh000300', spotName: '沪深300' },
        { key: 'IH', name: '上证50股指', futMain: 'nf_IH0', futDom: 'nf_IH2609', spot: 'sh000016', spotName: '上证50' },
        { key: 'IC', name: '中证500股指', futMain: 'nf_IC0', futDom: 'nf_IC2609', spot: 'sz399905', spotName: '中证500' },
        { key: 'IM', name: '中证1000股指', futMain: 'nf_IM0', futDom: 'nf_IM2609', spot: 'sh000852', spotName: '中证1000' }
      ];
      const allCodes = idxMap.flatMap(x => [x.futMain, x.futDom, x.spot]);
      const quotes = await fetchQuotes(allCodes);
      const qm = {}; quotes.forEach(x => { qm[x.code] = x; });

      function pctRank(arr, v) {
        if (!arr || !arr.length || v == null) return null;
        const sorted = arr.slice().sort((a, b) => a - b);
        const n = sorted.length;
        let lo = 0; while (lo < n && sorted[lo] < v) lo++;
        let le = 0; while (le < n && sorted[le] <= v) le++;
        return Math.round(((lo + le) / 2 / n) * 100);
      }

      const basis = [], cross = [], ratio = [];
      const series = [];

      for (const x of idxMap) {
        const fm = qm[x.futMain], fd = qm[x.futDom], sp = qm[x.spot];
        // 1) 期现价差
        if (fm && fm.price != null && sp && sp.price != null) {
          const val = fm.price - sp.price;
          const pct = val / sp.price * 100;
          // 历史分位：用日线收盘价估算基差历史（期货主连与指数日线）
          let histPct = null, histMed = null, histSamples = [];
          try {
            const [fr, sr] = await Promise.all([
              fetchKline(klineTarget(x.futMain).sym, 'day', 'fut'),
              fetchKline(klineTarget(x.spot).sym, 'day', 'stock')
            ]);
            const fb = normBars(fr, 'fut').slice(-120);
            const sb = normBars(sr, 'stock').slice(-120);
            const len = Math.min(fb.length, sb.length);
            histSamples = [];
            for (let i = 0; i < len; i++) {
              if (fb[i].c != null && sb[i].c != null) histSamples.push((fb[i].c - sb[i].c) / sb[i].c * 100);
            }
            if (histSamples.length) {
              histMed = histSamples.slice().sort((a, b) => a - b)[Math.floor(histSamples.length / 2)];
              histPct = pctRank(histSamples, pct);
            }
          } catch (e) {}
          basis.push({
            key: x.key, name: x.name, fut: x.futMain, spot: x.spot, spotName: x.spotName,
            futPrice: fm.price, spotPrice: sp.price, value: +val.toFixed(2), pct: +pct.toFixed(2),
            change: fm.pct != null ? fm.pct : null, histMed: histMed != null ? +histMed.toFixed(2) : null, histPct
          });
        }
        // 2) 跨期价差（主力-当月）
        if (fm && fm.price != null && fd && fd.price != null) {
          const val = fm.price - fd.price;
          const pct = fd.price ? val / fd.price * 100 : null;
          let histPct = null, histMed = null, histSamples = [];
          try {
            const [fr, dr] = await Promise.all([
              fetchKline(klineTarget(x.futMain).sym, 'day', 'fut'),
              fetchKline(klineTarget(x.futDom).sym, 'day', 'fut')
            ]);
            const fb = normBars(fr, 'fut').slice(-120);
            const db = normBars(dr, 'fut').slice(-120);
            const len = Math.min(fb.length, db.length);
            histSamples = [];
            for (let i = 0; i < len; i++) {
              if (fb[i].c != null && db[i].c != null) histSamples.push((fb[i].c - db[i].c) / db[i].c * 100);
            }
            if (histSamples.length) {
              histMed = histSamples.slice().sort((a, b) => a - b)[Math.floor(histSamples.length / 2)];
              histPct = pctRank(histSamples, pct);
            }
          } catch (e) {}
          cross.push({
            key: x.key, name: x.name, near: '当月', far: '主力',
            nearPrice: fd.price, farPrice: fm.price, value: +val.toFixed(2), pct: pct != null ? +pct.toFixed(2) : null,
            histMed: histMed != null ? +histMed.toFixed(2) : null, histPct
          });
        }
      }

      // 3) 跨品种比值：IF/IH、IC/IH、IM/IC、IF/IC
      const ratioPairs = [
        { name: 'IF/IH', a: 'nf_IF0', b: 'nf_IH0', aName: '沪深300', bName: '上证50' },
        { name: 'IC/IH', a: 'nf_IC0', b: 'nf_IH0', aName: '中证500', bName: '上证50' },
        { name: 'IM/IC', a: 'nf_IM0', b: 'nf_IC0', aName: '中证1000', bName: '中证500' },
        { name: 'IF/IC', a: 'nf_IF0', b: 'nf_IC0', aName: '沪深300', bName: '中证500' }
      ];
      for (const rp of ratioPairs) {
        const qa = qm[rp.a], qb = qm[rp.b];
        if (qa && qa.price != null && qb && qb.price != null && qb.price !== 0) {
          const val = qa.price / qb.price;
          const chg = ((qa.price / qb.price) - (qa.prev && qb.prev ? qa.prev / qb.prev : val)) / val * 100;
          let histPct = null, histMed = null, histSamples = [];
          try {
            const [ar, br] = await Promise.all([
              fetchKline(klineTarget(rp.a).sym, 'day', 'fut'),
              fetchKline(klineTarget(rp.b).sym, 'day', 'fut')
            ]);
            const ab = normBars(ar, 'fut').slice(-120);
            const bb = normBars(br, 'fut').slice(-120);
            const len = Math.min(ab.length, bb.length);
            histSamples = [];
            for (let i = 0; i < len; i++) {
              if (ab[i].c != null && bb[i].c != null) histSamples.push(ab[i].c / bb[i].c);
            }
            if (histSamples.length) {
              histMed = histSamples.slice().sort((a, b) => a - b)[Math.floor(histSamples.length / 2)];
              histPct = pctRank(histSamples, val);
            }
          } catch (e) {}
          ratio.push({
            name: rp.name, a: rp.a, b: rp.b, aName: rp.aName, bName: rp.bName,
            value: +val.toFixed(4), change: chg != null && isFinite(chg) ? +chg.toFixed(2) : null,
            histMed: histMed != null ? +histMed.toFixed(4) : null, histPct
          });
        }
      }

      // 取近 60 个交易日序列用于前端折线图（以 IF 期现价差为例，其余同理）
      try {
        const [fr, sr] = await Promise.all([
          fetchKline(klineTarget('nf_IF0').sym, 'day', 'fut'),
          fetchKline(klineTarget('sh000300').sym, 'day', 'stock')
        ]);
        const fb = normBars(fr, 'fut').slice(-60);
        const sb = normBars(sr, 'stock').slice(-60);
        const len = Math.min(fb.length, sb.length);
        const sIF = [];
        for (let i = 0; i < len; i++) {
          if (fb[i].c != null && sb[i].c != null) sIF.push({ t: fb[i].t, basis: +(fb[i].c - sb[i].c).toFixed(2), fut: fb[i].c, spot: sb[i].c });
        }
        series.push({ name: 'IF期现价差', data: sIF });
      } catch (e) {}

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, ts: Date.now(), generated: new Date().toLocaleString('zh-CN', { hour12: false }), basis, cross, ratio, series }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 极简本地回测：基于日线做 MA 金叉/死叉 或 支撑反弹/压力回落
  // 仅用于验证策略思路，不替代实盘；手续费与滑点未计入
  if (url.pathname === '/api/backtest') {
    try {
      const code = (url.searchParams.get('code') || '').trim();
      const strategy = url.searchParams.get('strategy') || 'ma_cross';
      const days = parseInt(url.searchParams.get('days') || '120', 10);
      const initial = parseFloat(url.searchParams.get('initial') || '100000');
      if (!code) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'code required' })); return; }
      const { sym, source } = klineTarget(code);
      const raw = await fetchKline(sym, 'day', source);
      const bars = normBars(raw, source).slice(-Math.max(days, 30));
      if (bars.length < 30) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true, error: '历史 K 线不足，无法回测' })); return; }

      function ma(n, endIdx) {
        let s = 0, c = 0;
        for (let i = Math.max(0, endIdx - n + 1); i <= endIdx; i++) { s += bars[i].c; c++; }
        return c ? s / c : null;
      }

      const equity = [{ t: bars[0].t, value: initial }];
      const trades = [];
      let position = 0, cash = initial, entry = null, entryBar = null;
      let win = 0, loss = 0, maxEq = initial, maxDD = 0;

      for (let i = 25; i < bars.length; i++) {
        const b = bars[i];
        const prev = bars[i - 1];
        const signal = (() => {
          if (strategy === 'ma_cross') {
            const fast = ma(5, i - 1), slow = ma(20, i - 1);
            const fast2 = ma(5, i - 2), slow2 = ma(20, i - 2);
            if (fast2 && slow2 && fast && slow) {
              if (fast2 <= slow2 && fast > slow) return 'buy';
              if (fast2 >= slow2 && fast < slow) return 'sell';
            }
          } else if (strategy === 'sr_bounce') {
            // 价格低于前20日低点 + 当日收涨 = 反弹买入；价格高于前20日高点 + 当日收跌 = 回落开空
            const lo20 = Math.min(...bars.slice(i - 20, i).map(x => x.l));
            const hi20 = Math.max(...bars.slice(i - 20, i).map(x => x.h));
            if (prev.l <= lo20 && b.c > prev.c) return 'buy';
            if (prev.h >= hi20 && b.c < prev.c) return 'sell';
          }
          return null;
        })();

        // 平仓逻辑
        if (position !== 0 && entry != null) {
          const target = entry * (position > 0 ? 1.05 : 0.95);
          const stop = entry * (position > 0 ? 0.97 : 1.03);
          const exitBySignal = (position > 0 && signal === 'sell') || (position < 0 && signal === 'buy');
          const exitByTP = position > 0 ? b.h >= target : b.l <= target;
          const exitBySL = position > 0 ? b.l <= stop : b.h >= stop;
          if (exitBySignal || exitByTP || exitBySL) {
            const exitPrice = exitBySL ? stop : (exitByTP ? target : b.o);
            const pnl = (exitPrice - entry) * position;
            trades.push({ entry: entryBar, exit: b.t, side: position > 0 ? '多' : '空', entryPrice: +entry.toFixed(2), exitPrice: +exitPrice.toFixed(2), pnl: +pnl.toFixed(2) });
            if (pnl >= 0) win++; else loss++;
            cash += pnl;
            position = 0; entry = null; entryBar = null;
          }
        }

        // 开仓逻辑
        if (position === 0 && signal) {
          position = signal === 'buy' ? 1 : -1;
          entry = b.o;
          entryBar = b.t;
        }

        const eq = cash + (position ? (b.c - entry) * position : 0);
        equity.push({ t: b.t, value: +eq.toFixed(2) });
        maxEq = Math.max(maxEq, eq);
        maxDD = Math.max(maxDD, (maxEq - eq) / maxEq);
      }

      // 强平最后持仓
      if (position !== 0 && entry != null) {
        const last = bars[bars.length - 1];
        const pnl = (last.c - entry) * position;
        trades.push({ entry: entryBar, exit: last.t, side: position > 0 ? '多' : '空', entryPrice: +entry.toFixed(2), exitPrice: last.c, pnl: +pnl.toFixed(2) });
        if (pnl >= 0) win++; else loss++;
        cash += pnl; position = 0;
      }

      const final = equity[equity.length - 1].value;
      const totalRet = +((final / initial - 1) * 100).toFixed(2);
      const totalTrades = trades.length;
      const winRate = totalTrades ? Math.round(win / totalTrades * 100) : 0;
      const profitFactor = trades.length ? (() => {
        const gains = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
        const losses = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
        return losses ? +(gains / losses).toFixed(2) : null;
      })() : null;

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ok: true, code, strategy, days: bars.length, initial,
        final, totalRet, totalTrades, winRate, profitFactor, maxDD: +(maxDD * 100).toFixed(2),
        trades, equity
      }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 每日推荐方案（规则引擎扫描推荐池，生成排序关注列表）
  if (url.pathname === '/api/daily-plan') {
    try {
      if (DAILY_CACHE && Date.now() - DAILY_CACHE.t < 300000) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(DAILY_CACHE.v));
        return;
      }
      const futuresRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'futures.json'), 'utf-8'));
      const stocks = JSON.parse(fs.readFileSync(path.join(__dirname, 'stocks.json'), 'utf-8'));
      const NAMES = {};
      futuresRaw.forEach(f => { NAMES[f.main.code] = f.main.name; if (f.dominant) NAMES[f.dominant.code] = f.dominant.name; });
      stocks.forEach(s => { NAMES[s.code] = s.name; });
      const pool = DEFAULT_PLAN_POOL;
      const items = await mapLimit(pool, 6, async (code) => {
        try {
          const { sym, source } = klineTarget(code);
          const [h1r, m30r, m5r, q] = await Promise.all([
            fetchKline(sym, 60, source), fetchKline(sym, 30, source), fetchKline(sym, 5, source), fetchQuotes([code])
          ]);
          const h1 = normBars(h1r, source).slice(-200);
          const m30 = normBars(m30r, source).slice(-200);
          const m5 = normBars(m5r, source).slice(-240);
          const live = (q[0] && q[0].price != null) ? q[0].price : (m5[m5.length - 1] && m5[m5.length - 1].c);
          const r = A.analyze({ h1, m30, m5, livePrice: live, srPct: 0.004 });
          let score = 0;
          if (r.dir1h.bias === 'up') score += 2; else if (r.dir1h.bias === 'down') score -= 2;
          if (r.dir30m.bias === 'up') score += 1; else if (r.dir30m.bias === 'down') score -= 1;
          if (r.struct.shift === 'bullish') score += 2; else if (r.struct.shift === 'bearish') score -= 2;
          if (r.atSupport) score += 1.5; if (r.atResistance) score -= 1.5;
          if (r.resonance) score += (r.resonance.level === 'high' ? 4 : 2);
          if (r.signals.length) score += (r.signals.some(s => s.atSR) ? 2 : 1);
          return {
            code, name: NAMES[code] || code, price: live,
            dir1h: r.dir1h.bias, dir30m: r.dir30m.bias, struct: r.struct.shift,
            atSupport: r.atSupport, atResistance: r.atResistance,
            signals: r.signals.map(s => s.type + '/' + s.dir),
            resonance: r.resonance ? r.resonance.msg : null,
            nearest: r.nearest ? { price: +r.nearest.price.toFixed(2), type: r.nearest.type, dist: +((r.nearest.distPct * 100).toFixed(2)) } : null,
            score: +score.toFixed(1)
          };
        } catch (e) { return null; }
      });
      const top = items.filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 14);
      const v = { ok: true, ts: Date.now(), generated: new Date().toLocaleString('zh-CN', { hour12: false }), count: pool.length, data: top };
      DAILY_CACHE = { t: Date.now(), v };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(v));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 每日推荐（三分组：竞价股票 / 尾盘股票 / 期货分析，每组带操作理由=宏观+技术）
  let RECOMMEND_CACHE = null;
  if (url.pathname === '/api/recommend') {
    try {
      if (RECOMMEND_CACHE && Date.now() - RECOMMEND_CACHE.t < 300000) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(RECOMMEND_CACHE.v));
        return;
      }
      const futuresRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'futures.json'), 'utf-8'));
      const stocks = JSON.parse(fs.readFileSync(path.join(__dirname, 'stocks.json'), 'utf-8'));
      const NAMES = {};
      futuresRaw.forEach(f => { NAMES[f.main.code] = f.main.name; if (f.dominant) NAMES[f.dominant.code] = f.dominant.name; });
      stocks.forEach(s => { NAMES[s.code] = s.name; });
      const futCodes = DEFAULT_PLAN_POOL.filter(c => c.startsWith('nf_') && c.endsWith('0'));
      const stockCodes = DEFAULT_PLAN_POOL.filter(c => !c.startsWith('nf_'));

      // 宏观参考（真实）：上证/创业板/沪金/原油/人民币 当日方向
      const macroQ = await fetchQuotes(['sh000001', 'sz399006', 'nf_AU0', 'nf_SC0', 'fx_susdcny']);
      const mk = {}; macroQ.forEach(x => mk[x.code] = x);
      const mac = {
        sh: mk['sh000001'] && mk['sh000001'].pct, cyb: mk['sz399006'] && mk['sz399006'].pct,
        gold: mk['nf_AU0'] && mk['nf_AU0'].pct, oil: mk['nf_SC0'] && mk['nf_SC0'].pct,
        rmb: mk['fx_susdcny'] && mk['fx_susdcny'].price
      };
      const macroBias = (mac.sh > 0 ? 1 : 0) + (mac.cyb > 0 ? 1 : 0) + (mac.gold > 0 ? 1 : 0) - (mac.sh < 0 ? 1 : 0) - (mac.cyb < 0 ? 1 : 0) - (mac.gold < 0 ? 1 : 0);
      const macroTxt = `宏观：上证${mac.sh!=null?(mac.sh>0?'+':'')+mac.sh+'%':'—'}、创业板${mac.cyb!=null?(mac.cyb>0?'+':'')+mac.cyb+'%':'—'}、沪金${mac.gold!=null?(mac.gold>0?'+':'')+mac.gold+'%':'—'}、人民币${mac.rmb!=null?mac.rmb:'—'}，综合${macroBias>0?'偏多':macroBias<0?'偏空':'中性'}。`;

      // ① 竞价股票：今开 vs 昨收 跳空 + 强度（真实数据，无需K线）
      const qStocks = await fetchQuotes(stockCodes);
      const auction = qStocks.filter(x => x.open != null && x.prev != null && x.prev !== 0)
        .map(x => {
          const gap = (x.open - x.prev) / x.prev * 100;
          const bias = gap > 0.15 ? '偏多' : gap < -0.15 ? '偏空' : '中性';
          const strength = Math.abs(gap) < 0.15 ? '中性' : gap > 1 ? '强做多' : gap > 0 ? '偏多' : gap < -1 ? '强做空' : '偏空';
          return {
            code: x.code, name: NAMES[x.code] || x.code, gap: +gap.toFixed(2), strength, bias,
            price: x.open, reason: `竞价${gap > 0 ? '高开' : '低开'} ${Math.abs(gap).toFixed(2)}%(${strength})；${gap > 0 ? '开盘主动买入占优' : '开盘主动卖出占优'}。${macroTxt}技术：待盘中确认量价。`
          };
        }).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 10);

      // ② 尾盘股票 + ③ 期货：多周期分析打分
      const stockItems = await mapLimit(stockCodes, 6, async (code) => {
        try {
          const { sym, source } = klineTarget(code);
          const [h1r, m30r, m5r, q] = await Promise.all([
            fetchKline(sym, 60, source), fetchKline(sym, 30, source), fetchKline(sym, 5, source), fetchQuotes([code])
          ]);
          const h1 = normBars(h1r, source).slice(-200);
          const m30 = normBars(m30r, source).slice(-200);
          const m5 = normBars(m5r, source).slice(-240);
          const live = (q[0] && q[0].price != null) ? q[0].price : (m5[m5.length - 1] && m5[m5.length - 1].c);
          const r = A.analyze({ h1, m30, m5, livePrice: live, srPct: 0.004 });
          let score = 0;
          if (r.dir1h.bias === 'up') score += 2; else if (r.dir1h.bias === 'down') score -= 2;
          if (r.dir30m.bias === 'up') score += 1; else if (r.dir30m.bias === 'down') score -= 1;
          if (r.struct.shift === 'bullish') score += 2; else if (r.struct.shift === 'bearish') score -= 2;
          if (r.atSupport) score += 1.5; if (r.atResistance) score -= 1.5;
          if (r.resonance) score += (r.resonance.level === 'high' ? 4 : 2);
          const q0 = q[0] || {};
          const pct = q0.pct != null ? q0.pct : 0;
          score += pct * 0.8;
          const bias = (r.dir1h.bias === 'up' && (r.dir30m.bias === 'up' || r.struct.shift === 'bullish')) ? '偏多' :
                       (r.dir1h.bias === 'down' && (r.dir30m.bias === 'down' || r.struct.shift === 'bearish')) ? '偏空' : '中性';
          const tech = `技术：1h${r.dir1h.bias === 'up' ? '多头' : r.dir1h.bias === 'down' ? '空头' : '震荡'}/30m${r.struct.shift ? (r.struct.shift === 'bullish' ? '结构转多' : '结构转空') : r.dir30m.bias === 'up' ? '多头段' : r.dir30m.bias === 'down' ? '空头段' : '震荡段'}${r.signals.length ? '，5m出现' + (r.signals[0].dir === 'bull' ? '看涨' : '看跌') + r.signals[0].type : ''}${r.nearest ? '，距' + (r.nearest.type === 'support' ? '支撑' : '压力') + ((r.nearest.distPct * 100).toFixed(2)) + '%' : ''}${r.resonance ? '，⚡共振' : ''}。`;
          return { code, name: NAMES[code] || code, price: live, pct: +pct.toFixed(2), bias, score: +score.toFixed(1), tech, reso: !!r.resonance, near: r.nearest ? r.nearest.type : null };
        } catch (e) { return null; }
      });
      const tail = stockItems.filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 10).map(x => ({
        code: x.code, name: x.name, price: x.price, pct: x.pct, bias: x.bias, score: x.score,
        reason: `${x.tech}当日${x.pct > 0 ? '+' : ''}${x.pct}%。${macroTxt}`
      }));

      const futItems = await mapLimit(futCodes, 6, async (code) => {
        try {
          const { sym, source } = klineTarget(code);
          const [h4r, h1r, m30r, m5r, q] = await Promise.all([
            fetchKline(sym, '4h', source), fetchKline(sym, 60, source), fetchKline(sym, 30, source), fetchKline(sym, 5, source), fetchQuotes([code])
          ]);
          const h4 = normBars(h4r, source).slice(-120);
          const h1 = normBars(h1r, source).slice(-200);
          const m30 = normBars(m30r, source).slice(-200);
          const m5 = normBars(m5r, source).slice(-240);
          const live = (q[0] && q[0].price != null) ? q[0].price : (m5[m5.length - 1] && m5[m5.length - 1].c);
          const r = A.analyze({ h1, m30, m5, livePrice: live, srPct: 0.004 });
          const ph = A.phase4h(h4);
          let score = 0;
          if (ph.bias === 'up') score += 3; else if (ph.bias === 'down') score -= 3;
          if (r.dir1h.bias === 'up') score += 2; else if (r.dir1h.bias === 'down') score -= 2;
          if (r.struct.shift === 'bullish') score += 2; else if (r.struct.shift === 'bearish') score -= 2;
          if (r.atSupport) score += 1.5; if (r.atResistance) score -= 1.5;
          if (r.resonance) score += (r.resonance.level === 'high' ? 4 : 2);
          const bias = (ph.bias === 'up' && (r.dir1h.bias === 'up' || r.struct.shift === 'bullish')) ? '偏多' :
                       (ph.bias === 'down' && (r.dir1h.bias === 'down' || r.struct.shift === 'bearish')) ? '偏空' : '中性';
          const tech = `技术：4h${ph.bias === 'up' ? '多头' : ph.bias === 'down' ? '空头' : '震荡'}、1h${r.dir1h.bias === 'up' ? '多头' : r.dir1h.bias === 'down' ? '空头' : '震荡'}${r.struct.shift ? (r.struct.shift === 'bullish' ? '、30m结构转多' : '、30m结构转空') : ''}${r.signals.length ? '、5m出现' + (r.signals[0].dir === 'bull' ? '看涨' : '看跌') + r.signals[0].type : ''}${r.nearest ? '、距' + (r.nearest.type === 'support' ? '支撑' : '压力') + ((r.nearest.distPct * 100).toFixed(2)) + '%' : ''}${r.resonance ? '、⚡共振' : ''}。`;
          return { code, name: NAMES[code] || code, price: live, bias, score: +score.toFixed(1), tech, reso: !!r.resonance, near: r.nearest ? r.nearest.type : null };
        } catch (e) { return null; }
      });
      const futures = futItems.filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 10).map(x => ({
        code: x.code, name: x.name, price: x.price, bias: x.bias, score: x.score,
        reason: `${x.tech}${macroTxt}`
      }));

      const v = { ok: true, ts: Date.now(), generated: new Date().toLocaleString('zh-CN', { hour12: false }), macroTxt, auction, tail, futures };
      RECOMMEND_CACHE = { t: Date.now(), v };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(v));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 每日涨停复盘（东财真实数据）
  if (url.pathname === '/api/daily-limit-up') {
    try {
      const dateParam = (url.searchParams.get('date') || '').trim();
      const cacheKey = 'limitup_' + (dateParam || 'latest');
      const cached = KLINE_CACHE.get(cacheKey);
      if (cached && Date.now() - cached.t < 300000) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(cached.v));
        return;
      }
      const now = new Date();
      const today = now.toISOString().slice(0, 10).replace(/-/g, '');
      const yest = new Date(now.getTime() - 86400000).toISOString().slice(0, 10).replace(/-/g, '');
      const dates = dateParam ? [dateParam] : [today, yest];
      let raw = null;
      for (const d of dates) {
        try {
          const luUrl = `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt:asc&date=${d}`;
          const r = await fetch(luUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' } });
          const j = await r.json();
          const data = (j && j.data) || {};
          if ((data.tc || 0) > 0 || (data.pool || []).length > 0) { raw = j; break; }
        } catch (e) {}
      }
      if (!raw || !raw.data) throw new Error('未能获取涨停数据');
      const data = raw.data;
      const pool = (data.pool || []).map(x => {
        const prefix = x.m === 1 ? 'sh' : (x.m === 0 ? 'sz' : (/^[48]/.test(x.c) ? 'bj' : 'sz'));
        const code = prefix + x.c;
        const price = x.p ? x.p / 100 : null;
        const fund = x.fund || 0;
        const amount = x.amount || 0;
        const ltsz = x.ltsz || 0;
        return {
          code, name: x.n, price, pct: x.zdp != null ? +x.zdp.toFixed(2) : null,
          board: x.lbc || 1,
          firstTime: fmtLimitTime(x.fbt), lastTime: fmtLimitTime(x.lbt),
          fund, amount: amount > 1e8 ? +(amount / 1e8).toFixed(2) + '亿' : +(amount / 1e4).toFixed(0) + '万',
          turnover: x.hs != null ? +(x.hs * 100).toFixed(2) : null,
          marketCap: ltsz ? +(ltsz / 1e8).toFixed(2) : null,
          sector: x.hybk || '其他', zbc: x.zbc || 0,
          days: x.zttj ? x.zttj.days : (x.lbc || 1)
        };
      });
      const total = data.tc || pool.length;
      const byBoard = {}; const bySector = {};
      pool.forEach(x => {
        const b = x.board + '板';
        if (!byBoard[b]) byBoard[b] = [];
        byBoard[b].push(x);
        if (!bySector[x.sector]) bySector[x.sector] = [];
        bySector[x.sector].push(x);
      });
      const leadOf = arr => arr.slice().sort((a, b) => (b.board - a.board) || ((b.fund || 0) - (a.fund || 0)))[0];
      const boards = Object.entries(byBoard).sort((a, b) => parseInt(b[0]) - parseInt(a[0]));
      const sectors = Object.entries(bySector).sort((a, b) => b[1].length - a[1].length);
      // 主线题材归因：按「家数 + 最高连板」排序，标注龙头股
      const themes = sectors.slice(0, 12).map(([sec, arr]) => {
        const lead = leadOf(arr);
        return { name: sec, count: arr.length, maxBoard: lead.board, lead: lead.name, leadCode: lead.code, leadFirstTime: lead.firstTime, items: arr };
      });
      const maxBoard = pool.length ? Math.max(...pool.map(x => x.board)) : 0;
      const avgFund = pool.length ? pool.reduce((s, x) => s + (x.fund || 0), 0) / pool.length : 0;
      const summary = {
        total, maxBoard,
        firstBoard: (byBoard['1板'] || []).length,
        multiBoard: total - (byBoard['1板'] || []).length,
        avgFund: avgFund >= 1e8 ? +(avgFund / 1e8).toFixed(2) + '亿' : avgFund >= 1e4 ? +(avgFund / 1e4).toFixed(0) + '万' : Math.round(avgFund) + '元',
        earlyCount: pool.filter(x => x.firstTime && x.firstTime <= '10:00:00').length,
        bomb: pool.filter(x => x.zbc > 0).length
      };
      const v = { ok: true, ts: Date.now(), qdate: data.qdate, summary, boards, sectors, themes, pool };
      KLINE_CACHE.set(cacheKey, { t: Date.now(), v });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(v));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 当日分时（股票=东财 trends2；期货=新浪 getMinLine，含均价线）
  if (url.pathname === '/api/minute') {
    const code = (url.searchParams.get('code') || '').trim();
    if (!code) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'code required' })); return; }
    const cacheKey = 'min_' + code;
    const cached = KLINE_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.t < 30000) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(cached.v)); return; }
    try {
      let points = [], prev = null, name = '';
      if (code.startsWith('nf_')) {
        // 新浪期货分时：[[时间,最新,均价,量,持仓,昨结,日期],...]
        const { sym } = klineTarget(code);
        const url = `https://stock2.finance.sina.com.cn/futures/api/json.php/InnerFuturesNewService.getMinLine?symbol=${sym}`;
        const r = await fetch(url, { headers: { 'Referer': 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' } });
        const raw = await r.json();
        if (Array.isArray(raw)) {
          points = raw.filter(x => x && x[1]).map(x => ({ t: (x[6] || '') + ' ' + x[0], price: parseFloat(x[1]), avg: parseFloat(x[2]), vol: parseFloat(x[3]) || 0 }));
          prev = points.length ? points[0].price : null;
        }
      } else {
        // 东财股票分时
        const market = code.startsWith('sh') ? 1 : 0;
        const secid = market + '.' + code.slice(2);
        const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1`;
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' } });
        const j = await r.json();
        const d = j && j.data;
        if (d && Array.isArray(d.trends)) {
          name = d.name || '';
          prev = d.prePrice || null;
          points = d.trends.map(line => {
            const p = line.split(',');
            return { t: p[0], price: parseFloat(p[1]), avg: parseFloat(p[2]), vol: parseFloat(p[5]) || 0 };
          });
        }
      }
      const v = { ok: true, code, name, prev, points };
      KLINE_CACHE.set(cacheKey, { t: Date.now(), v });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(v));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 全列表批量信号扫描（跨股扫描增强）：对一批代码返回 方向/信号/共振/缠论买卖点/形态
  if (url.pathname === '/api/batch-scan') {
    const list = (url.searchParams.get('list') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 120);
    const srPct = parseFloat(url.searchParams.get('srPct')) || 0.004;
    const out = [];
    await mapLimit(list, 6, async (code) => {
      try {
        const { sym, source } = klineTarget(code);
        const [h4r, h1r, m30r, m5r, q] = await Promise.all([
          fetchKline(sym, '4h', source), fetchKline(sym, 60, source), fetchKline(sym, 30, source), fetchKline(sym, 5, source), fetchQuotes([code])
        ]);
        const h4 = normBars(h4r, source).slice(-120);
        const h1 = normBars(h1r, source).slice(-200);
        const m30 = normBars(m30r, source).slice(-200);
        const m5 = normBars(m5r, source).slice(-240);
        const live = (q[0] && q[0].price != null) ? q[0].price : (m5[m5.length - 1] && m5[m5.length - 1].c);
        const r = A.analyze({ h1, m30, m5, livePrice: live, srPct });
        const ph = A.phase4h(h4);
        const ind = A.indicators({ h4, h1, m30, m5 });
        const ch = A.chan(h1);
        const pats = A.detectClassicPatterns(h1);
        let score = 0;
        if (ph.bias === 'up') score += 3; else if (ph.bias === 'down') score -= 3;
        if (r.dir1h.bias === 'up') score += 2; else if (r.dir1h.bias === 'down') score -= 2;
        if (r.resonance) score += (r.resonance.level === 'high' ? 4 : 2);
        if (r.signals.some(s => s.atSR)) score += 2;
        if (ind && ind.rule) score -= (ind.rule.block === 'bull' ? 2 : 1);
        const flags = [];
        if (r.resonance) flags.push('⚡共振');
        if (ch && ch.bsm) flags.push(ch.bsm.type === 'buy1' ? '缠论买点' : '缠论卖点');
        pats.slice(0, 1).forEach(p => flags.push(p.type));
        out.push({ code, score: +score.toFixed(1), dir: ph.bias !== 'range' ? ph.bias : r.dir1h.bias, near: r.atSupport ? 'support' : r.atResistance ? 'resistance' : null, signals: r.signals.length, flags: flags.slice(0, 3), live });
      } catch (e) { out.push({ code, error: String(e) }); }
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, ts: Date.now(), data: out.sort((a, b) => (b.score || -99) - (a.score || -99)) }));
    return;
  }

  // 股票基本面（腾讯 qt.gtimg.cn）：PE/总市值/PB/换手 + 当日vs历史均值对比
  if (url.pathname === '/api/fundamental') {
    const code = (url.searchParams.get('code') || '').trim();
    if (!code || code.startsWith('nf_') || code.startsWith('fx_')) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true, code, basic: null, compare: null })); return; }
    try {
      const url = `https://qt.gtimg.cn/q=${code}`;
      const r = await fetch(url, { headers: { 'Referer': 'https://gu.qq.com/', 'User-Agent': 'Mozilla/5.0' } });
      const buf = Buffer.from(await r.arrayBuffer());
      const text = buf.toString('latin1');
      const m = text.match(/="([^"]*)"/);
      const p = m ? m[1].split('~') : [];
      let basic = null;
      if (p.length > 45) {
        basic = {
          name: p[1], code: p[2], price: parseFloat(p[3]) || null, prev: parseFloat(p[4]) || null,
          open: parseFloat(p[5]) || null, high: parseFloat(p[33]) || null, low: parseFloat(p[34]) || null,
          volume: parseFloat(p[36]) || null, amount: parseFloat(p[37]) || null,
          pe: parseFloat(p[39]) || null,          // 市盈率
          amplitude: parseFloat(p[43]) || null,   // 振幅
          mktcap: parseFloat(p[45]) || null,      // 总市值(亿)
          turnover: parseFloat(p[38]) || null,    // 换手率
          pb: parseFloat(p[46]) || null,          // 市净率
          highs52: parseFloat(p[47]) || null, lows52: parseFloat(p[48]) || null
        };
      }
      // 当日 vs 历史均值对比（用日线近 60 根；新浪反爬时降级为 null，不阻塞基本面）
      let compare = null;
      try {
        const { sym, source } = klineTarget(code);
        const raw = await fetchKline(sym, 'day', source);
        const bars = normBars(raw, source).slice(-60);
        const closes = bars.map(b => b.c).filter(x => x != null);
        const last = closes[closes.length - 1];
        const avg = (n) => { const a = closes.slice(-n); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; };
        compare = last != null ? {
          price: last, vs5: avg(5) ? +((last / avg(5) - 1) * 100).toFixed(2) : null,
          vs20: avg(20) ? +((last / avg(20) - 1) * 100).toFixed(2) : null,
          vs60: avg(60) ? +((last / avg(60) - 1) * 100).toFixed(2) : null,
          hi60: bars.length ? Math.max(...bars.map(b => b.h)) : null,
          lo60: bars.length ? Math.min(...bars.map(b => b.l)) : null
        } : null;
      } catch (e) { compare = null; }
      // 深度数据：财报核心指标 + 股东户数 + 融资融券（东财数据中心，各自失败降级为 null）
      const sec = code.slice(2);
      const ext = { report: null, holder: null, margin: null };
      try {
        const rep = await emData('RPT_LICO_FN_CPD', `(SECURITY_CODE="${sec}")`, { pageSize: 4, sortColumns: 'REPORTDATE', sortTypes: '-1' });
        ext.report = rep.map(r => ({
          date: (r.REPORTDATE || '').slice(0, 10), type: r.DATATYPE || '',
          eps: r.BASIC_EPS, roe: r.WEIGHTAVG_ROE, bps: r.BPS,
          revenue: r.TOTAL_OPERATE_INCOME, profit: r.PARENT_NETPROFIT,
          revYoY: r.YSTZ, profitYoY: r.SJLTZ, grossMargin: r.XSMLL, ocfPerShare: r.MGJYXJJE,
          dividend: r.ASSIGNDSCRPT || null, industry: r.PUBLISHNAME || null
        }));
      } catch (e) {}
      try {
        const h = await emData('RPT_HOLDERNUMLATEST', `(SECURITY_CODE="${sec}")`, { pageSize: 3, sortColumns: 'END_DATE', sortTypes: '-1' });
        ext.holder = h.map(x => ({
          date: (x.END_DATE || '').slice(0, 10), num: x.HOLDER_NUM,
          change: x.HOLDER_NUM_CHANGE, ratio: x.HOLDER_NUM_RATIO, closePrice: x.CLOSE_PRICE
        }));
      } catch (e) {}
      try {
        const mz = await emData('RPTA_WEB_RZRQ_GGMX', `(SCODE="${sec}")`, { pageSize: 3, sortColumns: 'DATE', sortTypes: '-1' });
        ext.margin = mz.map(x => ({
          date: (x.DATE || '').slice(0, 10), balance: x.RZYE, netBuy: x.RZJME, buy: x.RZMRE, repay: x.RZCHE, price: x.SPJ
        }));
      } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, code, basic, compare, ext }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 资金流（东财）：股票=主力/超大/大/中/小单净流入日线历史；期货=持仓量变化
  if (url.pathname === '/api/fflow') {
    const code = (url.searchParams.get('code') || '').trim();
    if (!code) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'code required' })); return; }
    try {
      let out = [];
      if (code.startsWith('nf_')) {
        // 期货无资金流 → 用持仓量(OI)日线变化近似资金进出
        const { sym, source } = klineTarget(code);
        const raw = await fetchKline(sym, 'day', source);
        const bars = normBars(raw, source).slice(-15);
        out = bars.map((b, i) => ({
          date: b.t.slice(0, 10),
          oi: b.v || 0,
          oiChg: i > 0 ? (b.v || 0) - (bars[i - 1].v || 0) : 0,
          close: b.c
        })).filter(x => x.date);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, code, type: 'oi', data: out }));
        return;
      }
      const market = code.startsWith('sh') ? 1 : 0;
      const secid = market + '.' + code.slice(2);
      // fflow 偶发限流：重试 3 次
      let k = [];
      for (let attempt = 0; attempt < 3 && !k.length; attempt++) {
        try {
          const url = `https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?secid=${secid}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56&klt=101&lmt=15`;
          const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' } });
          const j = await r.json();
          k = (j && j.data && j.data.klines) || [];
        } catch (e) { if (attempt === 2) throw e; }
      }
      out = k.map(line => {
        const p = line.split(',');
        return { date: p[0], main: parseFloat(p[1]), small: parseFloat(p[2]), mid: parseFloat(p[3]), big: parseFloat(p[4]), super: parseFloat(p[5]) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, code, type: 'fflow', data: out }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, code, type: code.startsWith('nf_') ? 'oi' : 'fflow', data: [], error: String(e) }));
    }
    return;
  }

  // 资讯（东财搜索，按品种名）
  if (url.pathname === '/api/news') {
    const kw = (url.searchParams.get('kw') || '').trim();
    if (!kw) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'kw required' })); return; }
    try {
      const enc = encodeURIComponent(kw);
      const param = `%7B%22uid%22%3A%22%22%2C%22keyword%22%3A%22${enc}%22%2C%22type%22%3A%5B%22cmsArticleWebOld%22%5D%2C%22client%22%3A%22web%22%2C%22clientVersion%22%3A%22curr%22%2C%22param%22%3A%7B%22cmsArticleWebOld%22%3A%7B%22searchScope%22%3A%22default%22%2C%22sort%22%3A%22default%22%2C%22pageIndex%22%3A1%2C%22pageSize%22%3A8%7D%7D%7D`;
      const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=x&param=${param}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://so.eastmoney.com/' } });
      const txt = await r.text();
      const m = txt.match(/^x\((.*)\)\s*;?\s*$/s);
      const j = m ? JSON.parse(m[1]) : null;
      const arts = (j && j.result && j.result.cmsArticleWebOld) || [];
      const data = arts.map(a => ({
        title: (a.title || '').replace(/<[^>]+>/g, '').replace(/<em>/g, '').replace(/<\/em>/g, ''),
        date: a.date, url: a.url || '', media: a.mediaName || ''
      }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, kw, data }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 现货记录系统：读取/写入 spot_history.json，自动抓伦敦金银，自动对比
  if (url.pathname === '/api/spot') {
    const SPOT_FILE = path.join(__dirname, 'spot_history.json');
    const spotDB = () => { try { return JSON.parse(fs.readFileSync(SPOT_FILE, 'utf-8')); } catch (e) { return {}; } };
    const saveDB = (db) => fs.writeFileSync(SPOT_FILE, JSON.stringify(db, null, 2), 'utf-8');
    const code = (url.searchParams.get('code') || '').trim();
    if (!code) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'code required' })); return; }
    try {
      const db = spotDB();
      // 名称映射（主连 → 现货关键字）
      const nameMap = { 'nf_AG0': ['现货白银', 'hf_XAG'], 'nf_AU0': ['现货黄金', 'hf_XAU'], 'nf_CU0': ['现货铜', null], 'nf_RB0': ['现货螺纹钢', null], 'nf_I0': ['铁矿石现货', null], 'nf_M0': ['豆粕现货', null], 'nf_SC0': ['原油现货', null], 'nf_SA0': ['纯碱现货', null], 'nf_FG0': ['玻璃现货', null], 'nf_MA0': ['甲醇现货', null] };
      const cfg = nameMap[code] || [null, null];
      // 自动抓外盘现货（伦敦金银）
      let auto = null;
      if (cfg[1]) {
        try {
          const r = await fetch(SINA_HOST + cfg[1], { headers: { 'Referer': 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' } });
          const buf = Buffer.from(await r.arrayBuffer());
          const t = buf.toString('latin1');
          const mm = t.match(/"([^"]*)"/);
          const pp = mm ? mm[1].split(',') : [];
          if (pp.length > 8) auto = { key: cfg[0], price: parseFloat(pp[1]), time: (pp[12]||'') + ' ' + (pp[6]||'') };
        } catch (e) {}
      }
      // 读取历史（优先按 code 存，兼容现货名 key）
      const histKey = (db[code] && db[code].length) ? code : (cfg[0] || code);
      const hist = (db[histKey] || []).slice(-30);
      const last = hist.length ? hist[hist.length - 1] : null;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, code, key: histKey, auto, hist, last, note: '现货为记录式数据：可自动抓伦敦金银；其他品种可在详情页录入，历史保存于本地 spot_history.json，自动与上次对比。' }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 现货录入（POST）：/api/spot-record?code=&price=&note=&source=&date=
  if (url.pathname === '/api/spot-record') {
    const SPOT_FILE = path.join(__dirname, 'spot_history.json');
    const code = (url.searchParams.get('code') || '').trim();
    const price = parseFloat(url.searchParams.get('price'));
    const note = (url.searchParams.get('note') || '').trim();
    const source = (url.searchParams.get('source') || '').trim();
    const date = (url.searchParams.get('date') || '').trim();
    if (!code || !price) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'code+price required' })); return; }
    try {
      let db = {}; try { db = JSON.parse(fs.readFileSync(SPOT_FILE, 'utf-8')); } catch (e) {}
      const now = new Date();
      const ts = date || now.toISOString().slice(0, 10); // 录入日期（默认今天）
      const rec = { ts, price, source: source || '手动', note: note || '手动录入' };
      if (!db[code]) db[code] = [];
      db[code].push(rec);
      if (db[code].length > 200) db[code] = db[code].slice(-200);
      fs.writeFileSync(SPOT_FILE, JSON.stringify(db, null, 2), 'utf-8');
      const hist = db[code].slice(-30);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, code, rec, hist }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 全市场股票清单（5547只，供"全部股票"默认加载100只 + 指定代码必加载）
  if (url.pathname === '/api/stock-list') {
    try {
      let all = JSON.parse(fs.readFileSync(path.join(__dirname, 'all_stocks.json'), 'utf-8'));
      // 全量一次性返回（246KB，浏览器端本地搜索最快）
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, total: all.length, data: all }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 股票搜索（按名称/代码模糊，指定股票必须能加载）
  if (url.pathname === '/api/stock-search') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    try {
      let all = JSON.parse(fs.readFileSync(path.join(__dirname, 'all_stocks.json'), 'utf-8'));
      let hits;
      if (!q) hits = all.slice(0, 100); // 空关键词默认前100只
      else {
        hits = all.filter(s => s.name.toLowerCase().includes(q) || s.code.includes(q)).slice(0, 200);
        // 指定代码：即使不在清单也尝试（如新增/退市股）
        if (!hits.length && /^\d{6}$/.test(q)) {
          const guess = (parseInt(q) < 600000 ? 'sz' : 'sh') + q;
          hits = [{ code: guess, name: q }];
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, q, data: hits }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 批量报价（指定股票/自选/搜索结果的精确加载，支持任意代码）
  if (url.pathname === '/api/batch-quote') {
    const list = (url.searchParams.get('list') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 200);
    try {
      const q = await fetchQuotes(list);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, data: q }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // ---------- 微信推送（WxPusher）：二维码订阅 + 自动推送 ----------
  // 替代原飞书 bot：无需公众号认证，用户微信扫码关注应用即可接收每日复盘/盯盘简报
  const WXPUSHER_TOKEN = process.env.WXPUSHER_APP_TOKEN || '';
  const WXPUSHER_UIDS_FILE = path.join(__dirname, 'wechat_uids.json');
  function loadWxUids() {
    const envUids = (process.env.WXPUSHER_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
    let fileUids = [];
    try { const f = JSON.parse(fs.readFileSync(WXPUSHER_UIDS_FILE, 'utf-8')); if (Array.isArray(f)) fileUids = f.map(String); } catch (e) {}
    return [...new Set([...envUids, ...fileUids])];
  }

  // 订阅二维码：服务端调 WxPusher 创建带参数二维码，返回 data.url（图片地址）供前端 img 展示
  if (url.pathname === '/api/wechat/qrcode') {
    try {
      if (!WXPUSHER_TOKEN) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, configured: false, error: '未配置 WXPUSHER_APP_TOKEN：请在环境变量中设置 WxPusher 应用 Token 后重启服务' }));
        return;
      }
      const r = await fetch('https://wxpusher.zjiecode.com/api/fun/create/qrcode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appToken: WXPUSHER_TOKEN, extra: 'pc-dingpan', validTime: 1800 })
      });
      const j = await r.json();
      const imgUrl = j && j.data && (j.data.url || j.data.shortUrl || j.data.shorturl);
      if (j.code !== 1000 || !imgUrl) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, configured: true, error: '创建二维码失败：' + ((j && j.msg) || JSON.stringify(j)) }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, configured: true, qrUrl: imgUrl, uids: loadWxUids() }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 推送：POST {title, content} → 经 WxPusher 下发到已绑定 UID（收盘/夜盘前自动推送用）
  if (url.pathname === '/api/wechat/push') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        if (!WXPUSHER_TOKEN) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '未配置 WXPUSHER_APP_TOKEN' })); return; }
        const uids = loadWxUids();
        if (!uids.length) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '尚无接收 UID：请让用户扫码订阅，并在 WXPUSHER_UIDS 环境变量 或 wechat_uids.json 填入其 UID' })); return; }
        const p = JSON.parse(body || '{}');
        const title = String(p.title || '大纵观共识 · 盯盘提醒').slice(0, 30);
        const content = String(p.content || '');
        const r = await fetch('https://wxpusher.zjiecode.com/api/send/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appToken: WXPUSHER_TOKEN, content: `**${title}**\n\n${content}`, summary: title, contentType: 3, uids, verifyPay: false })
        });
        const j = await r.json();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, data: j, sentTo: uids.length }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // 静态页面
  if (url.pathname === '/sitemap.xml') {
    const host = req.headers.host || 'localhost:8080';
    const proto = req.socket.encrypted ? 'https' : 'http';
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${proto}://${host}/</loc><changefreq>always</changefreq><priority>1.0</priority></url>
</urlset>`);
    return;
  }
  if (url.pathname === '/robots.txt') {
    const host = req.headers.host || 'localhost:8080';
    const proto = req.socket.encrypted ? 'https' : 'http';
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`User-agent: *
Allow: /
Sitemap: ${proto}://${host}/sitemap.xml`);
    return;
  }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(__dirname, path.normalize(file));
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(buf);
  });
});

function fmtLimitTime(t) {
  if (!t && t !== 0) return '';
  const s = String(t).padStart(6, '0');
  return s.slice(0, 2) + ':' + s.slice(2, 4) + ':' + s.slice(4, 6);
}

server.listen(PORT, () => {
  console.log(`PC 盯盘看板已启动: http://localhost:${PORT}`);
  // Windows 下尝试自动打开浏览器（无 GUI 环境忽略错误）
  if (process.platform === 'win32') {
    try { require('child_process').exec(`start http://localhost:${PORT}`); } catch (e) {}
  }
});
