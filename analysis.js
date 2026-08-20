'use strict';
// 价格行为分析引擎：S/R 支撑压力、趋势结构、反转形态、共振预警
// 输入均为已规范化的 K 线 [{t,o,h,l,c,v}]，价格已是正确小数

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

function normalize(raw, source) {
  if (source === 'sina_fut') {
    return raw.filter(r => r && r.d).map(r => ({ t: r.d, o: num(r.o), h: num(r.h), l: num(r.l), c: num(r.c), v: num(r.v) }));
  }
  return raw.filter(r => r && r.day).map(r => ({ t: r.day, o: num(r.open), h: num(r.high), l: num(r.low), c: num(r.close), v: num(r.volume) }));
}

// 检测摆动高低点：bar i 的 high 必须严格大于左右各 `wing` 根；low 同理
function detectSwings(bars, wing) {
  wing = wing || 2;
  const highs = [], lows = [];
  for (let i = wing; i < bars.length - wing; i++) {
    const h = bars[i].h, l = bars[i].l;
    if (h == null || l == null) continue;
    let isHigh = true, isLow = true;
    for (let j = 1; j <= wing; j++) {
      if (bars[i - j].h >= h || bars[i + j].h >= h) isHigh = false;
      if (bars[i - j].l <= l || bars[i + j].l <= l) isLow = false;
    }
    if (isHigh) highs.push({ i, price: h, t: bars[i].t });
    if (isLow) lows.push({ i, price: l, t: bars[i].t });
  }
  return { highs, lows };
}

// 把若干点聚成价位区：相近（<= clusterPct）的归为一簇，取中位价为代表，touches=触碰次数
function clusterLevels(points, refPrice, clusterPct) {
  clusterPct = clusterPct || 0.006;
  if (!points.length) return [];
  const sorted = points.slice().sort((a, b) => a.price - b.price);
  const clusters = [];
  let cur = [sorted[0]];
  for (let k = 1; k < sorted.length; k++) {
    const thr = cur[0].price * (1 + clusterPct);
    if (sorted[k].price <= thr) cur.push(sorted[k]);
    else { clusters.push(cur); cur = [sorted[k]]; }
  }
  clusters.push(cur);
  return clusters.map(c => {
    const prices = c.map(p => p.price).sort((a, b) => a - b);
    const med = prices[Math.floor(prices.length / 2)];
    return { price: med, touches: c.length, lastT: c[c.length - 1].t };
  }).sort((a, b) => b.touches - a.touches);
}

// 由摆动点判定趋势：比较最近两组 高/低 点
function trendFromSwings(highs, lows) {
  const hh = highs.slice(-3).map(p => p.price);
  const ll = lows.slice(-3).map(p => p.price);
  const upH = hh.length >= 2 && hh[hh.length - 1] > hh[hh.length - 2];
  const downH = hh.length >= 2 && hh[hh.length - 1] < hh[hh.length - 2];
  const upL = ll.length >= 2 && ll[ll.length - 1] > ll[ll.length - 2];
  const downL = ll.length >= 2 && ll[ll.length - 1] < ll[ll.length - 2];
  let bias = 'range', note = '震荡';
  if (upH && upL) { bias = 'up'; note = '多头（更高的高/低）'; }
  else if (downH && downL) { bias = 'down'; note = '空头（更低的高/低）'; }
  else if (upH && downL) { bias = 'up'; note = '偏多（高点抬高）'; }
  else if (downH && upL) { bias = 'down'; note = '偏空（高点降低）'; }
  return { bias, note };
}

// 30m 段落 / 结构变化(CHoCH)：在趋势中，收盘跌破最近摆动低点=空头结构确认；突破最近摆动高点=多头结构确认
function structureShift(bars, swings, bias) {
  if (bars.length < 3) return { shift: null, note: '' };
  const lastClose = bars[bars.length - 1].c;
  const lastLow = swings.lows[swings.lows.length - 1];
  const lastHigh = swings.highs[swings.highs.length - 1];
  let shift = null, note = '';
  if (bias === 'up' && lastLow && lastClose < lastLow.price) {
    shift = 'bearish'; note = '结构转空：跌破最近摆动低点（CHoCH）';
  } else if (bias === 'down' && lastHigh && lastClose > lastHigh.price) {
    shift = 'bullish'; note = '结构转多：突破最近摆动高点（CHoCH）';
  } else if (lastLow && lastClose < lastLow.price * 0.998) {
    shift = 'bearish'; note = '跌破摆动低点，注意转空';
  } else if (lastHigh && lastClose > lastHigh.price * 1.002) {
    shift = 'bullish'; note = '突破摆动高点，注意转多';
  }
  return { shift, note };
}

// 5m 蜡烛形态：在“已收盘”的最后一根（idx）上识别；返回 {type, dir}
function candlePattern(bars, idx) {
  if (idx < 1 || idx >= bars.length) return null;
  const a = bars[idx - 1], b = bars[idx];
  if ([a.o, a.h, a.l, a.c, b.o, b.h, b.l, b.c].some(x => x == null)) return null;
  const rngB = b.h - b.l;
  if (rngB <= 0) return null;
  const bodyB = Math.abs(b.c - b.o);
  const bodyA = Math.abs(a.c - a.o);
  const upperB = b.h - Math.max(b.o, b.c);
  const lowerB = Math.min(b.o, b.c) - b.l;

  // 内包线（中继/突破前兆）
  if (b.h < a.h && b.l > a.l) {
    return { type: 'inside', dir: 'neutral' };
  }
  // 吞没：实体反向且完全覆盖前一根实体
  const bullEng = b.c > b.o && a.c < a.o && b.o <= a.c && b.c >= a.o && bodyB > bodyA * 0.9;
  const bearEng = b.c < b.o && a.c > a.o && b.o >= a.c && b.c <= a.o && bodyB > bodyA * 0.9;
  if (bullEng) return { type: 'engulf', dir: 'bull' };
  if (bearEng) return { type: 'engulf', dir: 'bear' };
  // _pin 棒：影线 >= 2倍实体，且实体在另一端
  const isBullPin = lowerB >= bodyB * 2 && upperB <= bodyB * 1.2 && b.c >= b.o;
  const isBearPin = upperB >= bodyB * 2 && lowerB <= bodyB * 1.2 && b.c <= b.o;
  if (isBullPin) return { type: 'pin', dir: 'bull' };
  if (isBearPin) return { type: 'pin', dir: 'bear' };
  return null;
}

// 假突破 / SFP：本根最高/最低刺穿最近摆动点后收回
function fakeout(bars, swings, idx) {
  if (idx < 0 || idx >= bars.length) return null;
  const b = bars[idx];
  const lastHigh = swings.highs[swings.highs.length - 1];
  const lastLow = swings.lows[swings.lows.length - 1];
  const grab = 0.0015;
  if (lastHigh && b.h > lastHigh.price * (1 + grab) && b.c < lastHigh.price) {
    return { type: 'sfp', dir: 'bear', level: lastHigh.price };
  }
  if (lastLow && b.l < lastLow.price * (1 - grab) && b.c > lastLow.price) {
    return { type: 'sfp', dir: 'bull', level: lastLow.price };
  }
  return null;
}

// 距离某价位百分比
function distPct(price, level) { return Math.abs(price - level) / level; }

// 主分析：输入 h1/m30/m5 的规范化 K 线 + 实时价；输出 MTF 结论 + 预警
function analyze({ h1, m30, m5, livePrice, srPct, wing }) {
  srPct = srPct || 0.004;     // S/R 命中阈值（距价位百分比）
  wing = wing || 2;

  // 1h 方向
  const sw1 = detectSwings(h1, wing);
  const dir = trendFromSwings(sw1.highs, sw1.lows);

  // 30m 段落 + 结构
  const sw30 = detectSwings(m30, wing);
  const dir30 = trendFromSwings(sw30.highs, sw30.lows);
  const struct = structureShift(m30, sw30, dir30.bias);

  // S/R 区：合并 1h 与 30m 摆动点后聚类（1h 权重更高，这里统一聚类，靠 touches 排序自然体现）
  const allPts = [...sw1.highs, ...sw1.lows, ...sw30.highs, ...sw30.lows];
  let levels = clusterLevels(allPts, livePrice, srPct * 1.5).slice(0, 8);

  // 标注每个 level 是支撑还是压力（相对实时价）
  const price = (livePrice != null) ? livePrice : (m5[m5.length - 1] && m5[m5.length - 1].c);
  levels = levels.map(L => {
    const d = price != null ? distPct(price, L.price) : null;
    const type = (price != null && L.price < price - 1e-9) ? 'support' : (price != null && L.price > price + 1e-9) ? 'resistance' : 'pivot';
    return { ...L, type, distPct: d, near: d != null && d <= srPct };
  }).sort((a, b) => (a.distPct == null ? 1 : a.distPct) - (b.distPct == null ? 1 : b.distPct));

  const nearest = levels.find(L => L.distPct != null) || null;
  const atSupport = levels.some(L => L.type === 'support' && L.near);
  const atResistance = levels.some(L => L.type === 'resistance' && L.near);

  // 5m 反转信号（在最后一根“已收盘”K 线上识别；最后一根视为正在形成，不作为信号根）
  const sigIdx = m5.length - 2;
  const sigBar = m5[sigIdx];
  const pat = candlePattern(m5, sigIdx);
  const fo = fakeout(m5, detectSwings(m5, 1), sigIdx);

  const signals = [];
  if (pat && pat.type !== 'inside') {
    signals.push({ tf: '5m', time: sigBar && sigBar.t, type: pat.type, dir: pat.dir });
  }
  if (fo) signals.push({ tf: '5m', time: sigBar && sigBar.t, type: fo.type, dir: fo.dir, level: fo.level });

  // 信号是否发生在 S/R 位（用信号根对应端触及判定）
  signals.forEach(s => {
    const sb = m5[sigIdx];
    let atLevel = null;
    for (const L of levels) {
      const extreme = s.dir === 'bull' ? sb.l : (s.dir === 'bear' ? sb.h : Math.max(sb.h, sb.l));
      if (distPct(extreme, L.price) <= srPct) { atLevel = L; break; }
    }
    s.atSR = atLevel;
    s.srType = atLevel ? atLevel.type : null;
  });

  // 共振判定
  const structDir = struct.shift; // 'bullish'|'bearish'|null
  let resonance = null;
  const supSig = signals.find(s => (s.dir === 'bull') && s.atSR && s.srType === 'support');
  const resSig = signals.find(s => (s.dir === 'bear') && s.atSR && s.srType === 'resistance');
  if (supSig && structDir === 'bullish') resonance = { level: 'high', dir: 'bull', msg: '共振：支撑位 + 结构转多 + 看涨反转信号' };
  else if (resSig && structDir === 'bearish') resonance = { level: 'high', dir: 'bear', msg: '共振：压力位 + 结构转空 + 看跌反转信号' };
  else if (supSig) resonance = { level: 'mid', dir: 'bull', msg: '支撑位出现看涨反转信号' };
  else if (resSig) resonance = { level: 'mid', dir: 'bear', msg: '压力位出现看跌反转信号' };

  return {
    dir1h: dir,
    dir30m: dir30,
    struct,
    levels,
    nearest,
    atSupport,
    atResistance,
    signals,
    resonance,
    livePrice: price
  };
}

// ---------- 4h 定阶段（P0-2）：最高级别方向过滤 ----------
// 输入 4h 规范化 K 线，输出大阶段 + 与 1h 方向的一致性提示
function phase4h(h4) {
  if (!h4 || h4.length < 10) return { bias: 'range', note: '数据不足', align: 'neutral', tip: '' };
  const sw = detectSwings(h4, 2);
  const trend = trendFromSwings(sw.highs, sw.lows);
  const lastClose = h4[h4.length - 1].c;
  const lastHigh = sw.highs[sw.highs.length - 1];
  const lastLow = sw.lows[sw.lows.length - 1];
  let note = trend.note;
  // 靠近关键摆动点：4h 反转敏感
  let prox = '';
  if (lastHigh && Math.abs(lastClose - lastHigh.price) / lastHigh.price < 0.004) prox = '，贴近4h摆动高点';
  if (lastLow && Math.abs(lastClose - lastLow.price) / lastLow.price < 0.004) prox = '，贴近4h摆动低点';
  return { bias: trend.bias, note: note + prox };
}

// ---------- 决策卡（P0-1）：入场 / 止损 / 止盈 / 盈亏比 / 风险 ----------
// 输入 analyze 结果 a + 4h 阶段 phase + 账户参数 {account, riskPct}
// 输出可执行决策（方向倾向、入场区间、止损、目标、仓位风险）
function buildDecision(a, phase, acct) {
  acct = acct || { account: 100000, riskPct: 0.02 };
  const price = a.livePrice;
  if (price == null) return { action: 'wait', reason: '无实时价', entry: null, stop: null, targets: [], rr: null, riskAmt: 0 };

  // 确定信号方向：5m 反转信号 atSR / 共振 → 决策倾向
  let dir = null, sig = null, why = '';
  const reso = a.resonance;
  if (reso && (reso.dir === 'bull' || reso.dir === 'bear')) { dir = reso.dir; why = reso.msg; }
  else {
    const s = a.signals.find(x => x.dir === 'bull' || x.dir === 'bear');
    if (s && s.atSR) { dir = s.dir; why = patName(s) + (s.atSR.type === 'support' ? ' 触及支撑' : ' 触及压力'); }
    else if (s) { dir = s.dir; why = patName(s) + '（未达S/R，仅观望级）'; }
  }

  const phaseBias = phase && phase.bias;
  if (!dir) {
    const align = (a.dir1h && a.dir1h.bias === phaseBias) ? '4h与1h同向' : (phaseBias && a.dir1h && a.dir1h.bias !== 'range' && phaseBias !== 'range' ? '4h与1h背离' : '');
    return { action: 'wait', bias: '观望', reason: '暂无收盘反转信号' + (align ? ' · ' + align : ''), entry: null, stop: null, targets: [], rr: null, riskAmt: 0 };
  }

  // 入场区间：信号根收盘价附近，结合最近 S/R
  const levels = a.levels || [];
  const nearSup = levels.find(L => L.type === 'support');
  const nearRes = levels.find(L => L.type === 'resistance');
  const sigBar = a._sigBar; // 由服务端注入信号根
  const ref = (sigBar && sigBar.c) || price;

  let entryLo, entryHi, stop, reason;
  if (dir === 'bull') {
    // 做多：入场区间 [max(支撑, 信号收盘×0.998), 信号收盘]，止损=信号根低点 或 支撑下方
    const sup = nearSup ? Math.max(nearSup.price, ref * 0.998) : ref * 0.998;
    entryLo = +(Math.max(sup, ref * 0.995)).toFixed(4);
    entryHi = +(Math.min(ref, price)).toFixed(4);
    stop = +(Math.min((sigBar && sigBar.l) || ref * 0.99, sup * 0.995)).toFixed(4);
    reason = `看涨：${why}；入场参考 ${entryLo}~${entryHi}，止损 ${stop}`;
  } else {
    const res = nearRes ? Math.min(nearRes.price, ref * 1.002) : ref * 1.002;
    entryLo = +(Math.max(ref, price) - 0).toFixed(4);
    entryHi = +(Math.min(res, ref * 1.005)).toFixed(4);
    stop = +(Math.max((sigBar && sigBar.h) || ref * 1.01, res * 1.005)).toFixed(4);
    reason = `看跌：${why}；入场参考 ${entryLo}~${entryHi}，止损 ${stop}`;
  }

  // 止盈：1:2 盈亏比 + 反向 S/R 参考
  const risk = Math.abs(entryHi - stop) || Math.abs(entryLo - stop) || (price * 0.005);
  const targets = [];
  if (dir === 'bull') {
    targets.push({ rr: 1, price: +(entryHi + risk).toFixed(4) });
    targets.push({ rr: 2, price: +(entryHi + risk * 2).toFixed(4) });
    if (nearRes) targets.push({ rr: 3, price: +nearRes.price.toFixed(4), tag: '上方压力' });
  } else {
    targets.push({ rr: 1, price: +(entryLo - risk).toFixed(4) });
    targets.push({ rr: 2, price: +(entryLo - risk * 2).toFixed(4) });
    if (nearSup) targets.push({ rr: 3, price: +nearSup.price.toFixed(4), tag: '下方支撑' });
  }
  const rr = +(risk > 0 ? 2 : 0).toFixed(1);
  const riskAmt = Math.round(acct.account * acct.riskPct);

  return {
    action: dir === 'bull' ? 'buy' : 'sell',
    bias: dir === 'bull' ? '偏多' : '偏空',
    reason,
    entry: { lo: entryLo, hi: entryHi },
    stop,
    targets: targets.filter(t => t.price > 0),
    rr,
    riskAmt,
    account: acct.account,
    riskPct: acct.riskPct
  };
}

function patName(s) {
  if (!s) return '信号';
  return (s.dir === 'bull' ? '看涨' : '看跌') + (s.type === 'engulf' ? '吞没' : s.type === 'pin' ? 'Pin棒' : s.type === 'sfp' ? '假突破' : s.type === 'inside' ? '内包' : '反转');
}

// ================= 决策链指标（P0-1）：4H MACD → 1H 动量 → 30m KD → 5m MA =================
// 用户铁律：30m J 值超买(>80)时 5m 严禁开仓，等待 J<50 或边界突破确认
function emaArr(vals, n) {
  const k = 2 / (n + 1);
  const out = [];
  let prev = null;
  for (const v of vals) {
    if (v == null) { out.push(null); continue; }
    prev = (prev == null) ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

// MACD(12/26/9)：返回最新 DIF/DEA/柱 与 上一根柱（判断柱体放大/缩小、金叉死叉）
function macdLast(closes) {
  const e12 = emaArr(closes, 12), e26 = emaArr(closes, 26);
  const dif = [], dea = [], hist = [];
  for (let i = 0; i < closes.length; i++) {
    if (e12[i] == null || e26[i] == null) { dif.push(null); dea.push(null); hist.push(null); continue; }
    const d = e12[i] - e26[i];
    dif.push(d);
    const k = 2 / 10; // DEA=EMA9 of DIF
    if (i === 0 || dea[i - 1] == null) dea.push(d); else dea.push(d * k + dea[i - 1] * (1 - k));
    hist.push((dif[i] - dea[i]) * 2);
  }
  const last = hist.length - 1;
  return {
    dif: dif[last], dea: dea[last], hist: hist[last],
    histPrev: hist[last - 1] != null ? hist[last - 1] : null,
    goldenCross: dif[last] != null && dif[last - 1] != null && dif[last - 1] <= dea[last - 1] && dif[last] > dea[last],
    deathCross: dif[last] != null && dif[last - 1] != null && dif[last - 1] >= dea[last - 1] && dif[last] < dea[last]
  };
}

// KD(9,3,3)：返回最新 K/D/J 与 超买超卖状态
function kdjLast(closes, n, k1, d1) {
  n = n || 9; k1 = k1 || 3; d1 = d1 || 3;
  let K = 50, D = 50;
  const ll = [], hh = [];
  for (let i = 0; i < closes.length; i++) {
    if (i >= n - 1) {
      let lo = Infinity, hi = -Infinity;
      for (let j = i - n + 1; j <= i; j++) { if (closes[j] < lo) lo = closes[j]; if (closes[j] > hi) hi = closes[j]; }
      ll.push(lo); hh.push(hi);
    } else { ll.push(closes[i]); hh.push(closes[i]); }
  }
  let rsv = 50, Kprev, Dprev;
  for (let i = 0; i < closes.length; i++) {
    const r = (hh[i] === ll[i]) ? 50 : (closes[i] - ll[i]) / (hh[i] - ll[i]) * 100;
    rsv = r;
    Kprev = K; Dprev = D;
    K = Kprev * (k1 - 1) / k1 + rsv / k1;
    D = Dprev * (d1 - 1) / d1 + K / d1;
  }
  const J = 3 * K - 2 * D;
  return {
    k: +K.toFixed(1), d: +D.toFixed(1), j: +J.toFixed(1),
    over: J > 80, under: J < 20,
    j50ok: J < 50, // 铁律：等待 J<50
    crossUp: Kprev != null && Dprev != null && Kprev <= Dprev && K > D,
    crossDown: Kprev != null && Dprev != null && Kprev >= Dprev && K < D
  };
}

// MA(n) 最新值 与 排列（5m 入场确认：价在 MA5 上方 + MA5>MA20 = 多头排列）
function maInfo(closes) {
  const ma5 = closes.slice(-5).filter(x => x != null);
  const ma20 = closes.slice(-20).filter(x => x != null);
  const m5 = ma5.length === 5 ? ma5.reduce((s, v) => s + v, 0) / 5 : null;
  const m20 = ma20.length === 20 ? ma20.reduce((s, v) => s + v, 0) / 20 : null;
  const price = closes[closes.length - 1];
  return {
    ma5: m5 != null ? +m5.toFixed(4) : null,
    ma20: m20 != null ? +m20.toFixed(4) : null,
    priceAboveMa5: price != null && m5 != null ? price > m5 : null,
    bullAlign: m5 != null && m20 != null ? m5 > m20 : null, // 多头排列
    bearAlign: m5 != null && m20 != null ? m5 < m20 : null
  };
}

// 决策链指标总入口：输出 4h/1h MACD、30m KD、5m MA 的解读
function indicators({ h4, h1, m30, m5 }) {
  const c4 = (h4 || []).map(b => b.c).filter(x => x != null);
  const c1 = (h1 || []).map(b => b.c).filter(x => x != null);
  const c30 = (m30 || []).map(b => b.c).filter(x => x != null);
  const c5 = (m5 || []).map(b => b.c).filter(x => x != null);

  const mac4 = c4.length > 30 ? macdLast(c4) : null;
  const mac1 = c1.length > 30 ? macdLast(c1) : null;
  const kd30 = c30.length > 10 ? kdjLast(c30) : null;
  const ma5 = c5.length >= 20 ? maInfo(c5) : null;

  // 解读文本
  const macTxt = (m) => {
    if (!m || m.dif == null) return '—';
    if (m.goldenCross) return 'MACD金叉';
    if (m.deathCross) return 'MACD死叉';
    return m.hist > 0 ? '多头（柱+）' : '空头（柱-）';
  };
  const kdTxt = (kd) => {
    if (!kd) return '—';
    let s = `KD ${kd.k}/${kd.d} J=${kd.j}`;
    if (kd.over) s += ' ⚠️超买';
    else if (kd.under) s += ' ⚠️超卖';
    return s;
  };

  // 铁律判定：30m J 超买 → 禁止看多开仓；J 超卖 → 禁止看空开仓
  let rule = null;
  if (kd30) {
    if (kd30.over) rule = { block: 'bull', msg: `铁律：30m J值超买(${kd30.j})，5m 严禁开多仓，等待 J<50 或边界突破确认` };
    else if (kd30.under) rule = { block: 'bear', msg: `铁律：30m J值超卖(${kd30.j})，5m 严禁开空仓，等待 J>50 或边界突破确认` };
  }

  return {
    macd4h: mac4 ? { ...mac4, txt: macTxt(mac4) } : null,
    macd1h: mac1 ? { ...mac1, txt: macTxt(mac1) } : null,
    kd30: kd30 ? { ...kd30, txt: kdTxt(kd30) } : null,
    ma5: ma5,
    rule
  };
}

// ================= 斐波那契 + 趋势线（P2 体验层，自动绘制） =================
// 最近一段明显摆动（低→高 或 高→低），返回斐波那契回撤位；以及摆动高低点的趋势线
function fibLevels(bars) {
  if (!bars || bars.length < 30) return null;
  const sw = detectSwings(bars, 2);
  const H = sw.highs.map(p => p.price), L = sw.lows.map(p => p.price);
  if (H.length < 2 || L.length < 2) return null;
  const lastH = H[H.length - 1], lastL = L[L.length - 1];
  const hT = sw.highs[sw.highs.length - 1].t, lT = sw.lows[sw.lows.length - 1].t;
  // 最近段方向：以最后出现的高/低点为准（时间上更晚的作为当前段终点）
  const upSwing = (lT > hT) ? false : true; // 高点更晚=上涨段；低点更晚=下跌段
  const lo = Math.min(lastH, lastL), hi = Math.max(lastH, lastL);
  const range = hi - lo;
  if (range <= 0) return null;
  const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  return {
    dir: upSwing ? 'up' : 'down',
    lo, hi,
    levels: ratios.map(r => ({ r, price: hi - range * r }))
  };
}

// 趋势线：连接最近两个摆动高点（压力线）与最近两个摆动低点（支撑线）
function trendlines(bars) {
  if (!bars || bars.length < 30) return null;
  const sw = detectSwings(bars, 2);
  const hs = sw.highs.slice(-2).map(p => ({ price: p.price, t: p.t }));
  const ls = sw.lows.slice(-2).map(p => ({ price: p.price, t: p.t }));
  const out = { up: null, down: null };
  if (ls.length === 2 && ls[1].price > ls[0].price) out.up = { a: ls[0], b: ls[1], label: '上升趋势线' };
  if (ls.length === 2 && ls[1].price < ls[0].price) out.down = { a: ls[0], b: ls[1], label: '下降趋势线' };
  if (hs.length === 2 && hs[1].price > hs[0].price) out.up = out.up || { a: hs[0], b: hs[1], label: '上升趋势线' };
  if (hs.length === 2 && hs[1].price < hs[0].price) out.down = out.down || { a: hs[0], b: hs[1], label: '下降趋势线' };
  return out;
}

module.exports = { normalize, detectSwings, clusterLevels, trendFromSwings, structureShift, candlePattern, fakeout, analyze, phase4h, buildDecision, indicators, chan, detectClassicPatterns, fibLevels, trendlines };

// ================= 缠论基础版（P1-1）：分型 → 笔 → 中枢 → 一类买卖点 =================
// 简化实用实现：分型=摆动高低点；笔=相邻分型连线；中枢=最近笔的重叠区间；一类买卖点=对中枢的假突破/离开
function chanFenxing(bars, wing) {
  wing = wing || 2;
  const fx = [];
  for (let i = wing; i < bars.length - wing; i++) {
    const h = bars[i].h, l = bars[i].l;
    let isTop = true, isBot = true;
    for (let j = 1; j <= wing; j++) {
      if (bars[i - j].h >= h || bars[i + j].h >= h) isTop = false;
      if (bars[i - j].l <= l || bars[i + j].l <= l) isBot = false;
    }
    if (isTop) fx.push({ i, t: bars[i].t, type: 'top', price: h });
    if (isBot) fx.push({ i, t: bars[i].t, type: 'bottom', price: l });
  }
  return fx;
}

// 笔：相邻且类型交替的分型连线（过滤同向/间隔过近）
function chanBi(fx) {
  const bi = [];
  for (let k = 1; k < fx.length; k++) {
    const a = fx[k - 1], b = fx[k];
    if (a.type === b.type) continue;
    const range = Math.abs(b.price - a.price);
    if (range <= 0) continue;
    bi.push({
      start: a, end: b, dir: a.type === 'bottom' ? 'up' : 'down',
      range, tStart: a.t, tEnd: b.t
    });
  }
  return bi;
}

// 中枢：最近 N 笔的重叠区间（取重叠且足够宽的区段）
function chanZhongshu(bi, n) {
  n = n || 3;
  if (bi.length < n) return null;
  const seg = bi.slice(-n);
  let lo = -Infinity, hi = Infinity;
  for (const b of seg) {
    const bl = Math.min(b.start.price, b.end.price);
    const bh = Math.max(b.start.price, b.end.price);
    lo = Math.max(lo, bl);
    hi = Math.min(hi, bh);
  }
  if (lo >= hi || hi - lo <= 0) return null;
  return { lo, hi, mid: (lo + hi) / 2, from: seg[0].tStart, to: seg[seg.length - 1].tEnd };
}

// 缠论总入口（对任一周期 bars）：输出分型/笔/中枢/买卖点提示
function chan(bars) {
  if (!bars || bars.length < 10) return { fx: [], bi: [], zhongshu: null, bsm: null };
  const fx = chanFenxing(bars, 2);
  const bi = chanBi(fx);
  const zs = chanZhongshu(bi, 3);
  const lastC = bars[bars.length - 1].c;
  let bsm = null;
  if (zs) {
    // 一类买卖点：有效离开中枢后的回抽确认（简化：收盘突破中枢后回踩不破）
    const touchLo = bars.some(b => b.l <= zs.lo * 1.0002);
    const touchHi = bars.some(b => b.h >= zs.hi * 0.9998);
    if (touchLo && lastC > zs.lo && lastC < zs.lo + (zs.hi - zs.lo) * 0.6) {
      bsm = { type: 'buy1', msg: '一类买点：中枢下方获支撑回升' };
    } else if (touchHi && lastC < zs.hi && lastC > zs.hi - (zs.hi - zs.lo) * 0.6) {
      bsm = { type: 'sell1', msg: '一类卖点：中枢上方受压回落' };
    }
  }
  return { fx: fx.slice(-12), bi: bi.slice(-10), zhongshu: zs, bsm };
}

// ================= 经典形态识别（P1-2）：双底/双顶/头肩/三角/旗形 =================
function detectClassicPatterns(bars) {
  if (!bars || bars.length < 30) return [];
  const sw = detectSwings(bars, 2);
  const H = sw.highs.map(p => p.price), L = sw.lows.map(p => p.price);
  const out = [];
  // 双底（W）：最近两个低点接近，且中间有反弹
  if (L.length >= 3) {
    const l1 = L[L.length - 3], l2 = L[L.length - 1];
    const diff = Math.abs(l2 - l1) / Math.max(l1, l2);
    if (diff < 0.008 && l2 > l1 * 0.99) out.push({ type: '双底(W)', dir: 'bull', note: `两个低点 ${l1.toFixed(2)}/${l2.toFixed(2)} 接近，颈线突破看多` });
  }
  // 双顶（M）
  if (H.length >= 3) {
    const h1 = H[H.length - 3], h2 = H[H.length - 1];
    const diff = Math.abs(h2 - h1) / Math.max(h1, h2);
    if (diff < 0.008 && h2 < h1 * 1.01) out.push({ type: '双顶(M)', dir: 'bear', note: `两个高点 ${h1.toFixed(2)}/${h2.toFixed(2)} 接近，颈线跌破看空` });
  }
  // 头肩底：三个低点，中间最低
  if (L.length >= 5) {
    const a = L[L.length - 5], b = L[L.length - 3], c = L[L.length - 1];
    if (b < a && b < c && Math.abs(a - c) / Math.max(a, c) < 0.02 && c > b) out.push({ type: '头肩底', dir: 'bull', note: '左肩/头/右肩，右肩抬高看多' });
  }
  // 头肩顶
  if (H.length >= 5) {
    const a = H[H.length - 5], b = H[H.length - 3], c = H[H.length - 1];
    if (b > a && b > c && Math.abs(a - c) / Math.max(a, c) < 0.02 && c < b) out.push({ type: '头肩顶', dir: 'bear', note: '左肩/头/右肩，右肩降低看空' });
  }
  // 上升/下降楔形：连续摆动收敛
  if (H.length >= 3 && L.length >= 3) {
    const hUp = H[H.length - 1] > H[H.length - 2] && H[H.length - 2] > H[H.length - 3];
    const hDn = H[H.length - 1] < H[H.length - 2] && H[H.length - 2] < H[H.length - 3];
    const lUp = L[L.length - 1] > L[L.length - 2] && L[L.length - 2] > L[L.length - 3];
    const lDn = L[L.length - 1] < L[L.length - 2] && L[L.length - 2] < L[L.length - 3];
    if (hUp && lUp) out.push({ type: '上升楔形', dir: 'bear', note: '高/低点同向抬高但斜率收敛，警惕转跌' });
    if (hDn && lDn) out.push({ type: '下降楔形', dir: 'bull', note: '高/低点同向降低但斜率收敛，警惕转涨' });
    if (hDn && lUp) out.push({ type: '对称三角', dir: 'range', note: '高点降低点升，收敛后选择方向' });
  }
  return out.slice(0, 3);
}
