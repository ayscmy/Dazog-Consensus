// popup-plan.test.js — 验证 popupPlan 的时段规则 + 开关权威性
const { popupPlan } = require('./popup-plan.js');

const ALL_ON  = { recommend:true, pattern:true, watch:true, important:true, domestic:true, intl:true };
const REC_OFF = { recommend:false, pattern:true, watch:true, important:true, domestic:true, intl:true };
const ALL_OFF = { recommend:false, pattern:false, watch:false, important:false, domestic:false, intl:false };
const ONLY_WATCH = { recommend:false, pattern:false, watch:true, important:false, domestic:false, intl:false };
const ONLY_NEWS = { recommend:false, pattern:false, watch:false, important:true, domestic:false, intl:false };

let pass = 0, fail = 0;
function eq(name, got, want){
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if(g === w){ pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, '→ got', g, 'want', w); }
}

console.log('popupPlan 单测：');
// 1. 未开市 / 收盘后：完全不弹（即便全开）
eq('未开市(pre) 全开 → 静默',        popupPlan('pre', ALL_ON, {}),                       { pop:false, tabs:[] });
eq('收盘后(after) 全开 → 静默',       popupPlan('after', ALL_ON, {}),                      { pop:false, tabs:[] });
eq('周末(closed) 全开 → 静默',        popupPlan('closed', ALL_ON, {}),                     { pop:false, tabs:[] });

// 2. 早竞：推荐开 → 弹股票简报；已弹过 → 静默
eq('早竞 推荐开 → 弹股票',            popupPlan('morning_open', ALL_ON, {done:{}}),         { pop:true, tabs:['stock'] });
eq('早竞 推荐开 已弹 → 静默',         popupPlan('morning_open', ALL_ON, {done:{morning:true}}), { pop:false, tabs:[] });

// 3. 尾盘：推荐开 → 弹股票简报；已弹过 → 静默
eq('尾盘 推荐开 → 弹股票',            popupPlan('tail', ALL_ON, {done:{}}),                 { pop:true, tabs:['stock'] });
eq('尾盘 推荐开 已弹 → 静默',         popupPlan('tail', ALL_ON, {done:{tail:true}}),        { pop:false, tabs:[] });

// 4. 中间：自选开 + 有自选 → 弹自选；无自选 → 静默
eq('中间 自选开 有自选 → 弹自选',     popupPlan('middle', ALL_ON, {done:{}, addedLen:3}),   { pop:true, tabs:['watch'] });
eq('中间 自选开 无自选 → 静默',       popupPlan('middle', ALL_ON, {done:{}, addedLen:0}),   { pop:false, tabs:[] });
eq('中间 自选开 已弹 → 静默',         popupPlan('middle', ALL_ON, {done:{middle:true}, addedLen:3}), { pop:false, tabs:[] });

// 5. 开关权威性：推荐关 → 即便其他开，早竞/尾盘也不弹股票（核心 bug 修复）
eq('早竞 推荐关(其余开) → 不弹股票',  popupPlan('morning_open', REC_OFF, {done:{}}),        { pop:false, tabs:[] });
eq('尾盘 推荐关(其余开) → 不弹股票',  popupPlan('tail', REC_OFF, {done:{}}),               { pop:false, tabs:[] });

// 6. 全关 = 真静默（开关生效，不再默认弹）
eq('全关 → 静默(早竞)',               popupPlan('morning_open', ALL_OFF, {}),               { pop:false, tabs:[] });
eq('全关 → 静默(中间 有自选)',        popupPlan('middle', ALL_OFF, {done:{}, addedLen:5}),  { pop:false, tabs:[] });

// 7. 仅自选开：早竞/尾盘不弹（自选只在中间触发），中间有自选才弹
eq('仅自选 早竞 → 静默',              popupPlan('morning_open', ONLY_WATCH, {}),            { pop:false, tabs:[] });
eq('仅自选 中间有自选 → 弹自选',      popupPlan('middle', ONLY_WATCH, {done:{}, addedLen:2}), { pop:true, tabs:['watch'] });

// 8. 仅资讯开：每日弹窗(股票/自选)不触发，由资讯流程单独处理
eq('仅资讯 早竞 → 每日弹窗静默',      popupPlan('morning_open', ONLY_NEWS, {}),             { pop:false, tabs:[] });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
