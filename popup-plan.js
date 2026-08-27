// popup-plan.js — 纯函数：根据「交易时段 + 弹窗开关设置」计算每日自动弹窗应弹出的类型。
// 无 DOM / localStorage 依赖，可在 Node 中单元测试（node popup-plan.test.js），
// 浏览器中通过 window.PopupPlan.popupPlan(...) 调用。
//
// 规则（用户确认的口径）：
//  - 选了什么才弹什么；全关 = 真正静默（开关生效）。
//  - 未开市 / 收盘后：完全不自动弹。
//  - 早竞(morning_open)：推荐开 → 弹「股票简报」。
//  - 尾盘(tail)：推荐开 → 弹「股票简报」。
//  - 中间(middle)：自选开且有自选 → 弹「自选速览」。
//  - 形态 / 资讯 由各自独立流程（扫描触发 / 资讯定时器）按开关控制，不在此函数内。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PopupPlan = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function popupPlan(sess, sets, opts) {
    sets = sets || {};
    opts = opts || {};
    const done = opts.done || {};
    const addedLen = opts.addedLen || 0;
    const on = k => !!sets[k];
    const anyDaily = on('recommend') || on('pattern') || on('watch');
    const anyNews = on('important') || on('domestic') || on('intl');

    // 未开市 / 收盘后：完全不自动弹
    if (sess === 'pre' || sess === 'closed' || sess === 'after') return { pop: false, tabs: [] };
    // 全部关闭：真正静默（开关生效）
    if (!anyDaily && !anyNews) return { pop: false, tabs: [] };

    const tabs = [];
    if (sess === 'morning_open' && !done.morning && on('recommend')) tabs.push('stock');
    else if (sess === 'tail' && !done.tail && on('recommend')) tabs.push('stock');
    else if (sess === 'middle') {
      if (!done.middle && addedLen > 0 && on('watch')) tabs.push('watch');
    }
    return { pop: tabs.length > 0, tabs };
  }
  return { popupPlan };
});
