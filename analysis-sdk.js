/**
 * analysis-sdk.js — 大纵观共识 · 分析能力可复用模块
 * ---------------------------------------------------------------------------
 * 用途：把 pc-dingpan 的期货/股票分析能力封装为跨环境模块，
 *       供兄弟站点（大纵观 dazog.com、即刻建站等）直接调用，无需重复实现分析逻辑。
 * 设计：分析逻辑仍保留在服务端（单一来源），本 SDK 是「调用客户端」，
 *       通过 HTTP 访问共识服务已暴露的 /api/* 分析接口，自动归一化返回。
 *
 * 环境：Node.js ≥ 18（内置 fetch）或现代浏览器（全局 fetch）均可。
 *
 * 用法（Node）：
 *   const { configure, getRecommend, getFuturesSpread, getNewsFeed } = require('./analysis-sdk');
 *   configure({ base: 'https://consensus.dazog.com' });
 *   const rec = await getRecommend();          // 早盘竞价 + 尾盘选股
 *   const fs  = await getFuturesSpread();       // 股指期货价差日报
 *   const news = await getNewsFeed();           // 国内/重要/国际资讯
 *
 * 用法（浏览器，直接使用全局对象）：
 *   ConsensusAnalysis.configure({ base: 'https://consensus.dazog.com' });
 *   const mtf = await ConsensusAnalysis.getMtf(['ag0','sh600519']);
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ConsensusAnalysis = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_BASE = (typeof location !== 'undefined' && location.origin) || 'https://consensus.dazog.com';
  let BASE = DEFAULT_BASE;

  /** 配置基础地址（默认 https://consensus.dazog.com） */
  function configure(opts) {
    if (opts && opts.base) BASE = opts.base.replace(/\/+$/, '');
    return { base: BASE };
  }

  async function req(path, params) {
    let url = BASE + path;
    if (params) {
      const qs = Object.keys(params)
        .filter(k => params[k] !== undefined && params[k] !== null)
        .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
        .join('&');
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('ConsensusAnalysis HTTP ' + r.status + ' @ ' + path);
    return r.json();
  }

  // ---------- 每日推荐 / 选股 ----------
  /** 早盘竞价 + 尾盘选股（多周期评分） */
  async function getRecommend() { return req('/api/recommend'); }

  /** 股指期货价差日报：期现 / 跨期 / 跨品种比值 + 历史分位 */
  async function getFuturesSpread() { return req('/api/futures-spread'); }

  /** 资讯流：{ domestic, important, intl, intlReach } */
  async function getNewsFeed() { return req('/api/news-feed'); }

  // ---------- 多周期 / 扫描 ----------
  /** 批量多周期方向+评分：list = ['ag0','sh600519'] */
  async function getMtf(list) {
    const codes = Array.isArray(list) ? list.join(',') : list;
    return req('/api/mtf', { list: codes });
  }

  /** 批量扫描（含形态/信号/买卖点） */
  async function getBatchScan(list) {
    const codes = Array.isArray(list) ? list.join(',') : list;
    return req('/api/batch-scan', { list: codes });
  }

  /** 实时报价 */
  async function getQuotes(list) {
    const codes = Array.isArray(list) ? list.join(',') : list;
    return req('/api/quotes', { list: codes });
  }

  // ---------- 深度分析 ----------
  /** 单标的深度分析（缠论/道氏/多周期共振） */
  async function getAnalyze(code) { return req('/api/analyze', { code }); }

  /** 支撑阻力扫描 */
  async function getSrScan(list) {
    const codes = Array.isArray(list) ? list.join(',') : list;
    return req('/api/sr-scan', { list: codes });
  }

  /** 策略回测：code + strategy(ma_cross|sr_bounce) + days */
  async function getBacktest(code, strategy, days) {
    return req('/api/backtest', { code, strategy: strategy || 'ma_cross', days: days || 120 });
  }

  // ---------- 市场 / 宏观 ----------
  /** 全市场快照（期货 + 股票） */
  async function getMarkets() { return req('/api/markets'); }

  /** 宏观/政策日历 */
  async function getMacro() { return req('/api/macro'); }

  /** 每日推荐方案（综合） */
  async function getDailyPlan() { return req('/api/daily-plan'); }

  /** 资金流 */
  async function getFundFlow(code) { return req('/api/fflow', { code }); }

  /** 基本面 */
  async function getFundamental(code) { return req('/api/fundamental', { code }); }

  return {
    configure,
    getRecommend,
    getFuturesSpread,
    getNewsFeed,
    getMtf,
    getBatchScan,
    getQuotes,
    getAnalyze,
    getSrScan,
    getBacktest,
    getMarkets,
    getMacro,
    getDailyPlan,
    getFundFlow,
    getFundamental
  };
}));
