/**
 * 人民币金额大写：合同、发票式单据的「价税合计（大写）」
 * 支持到万亿级，精确到分；不使用浮点字符串截断，先四舍五入到分。
 */
const DIGIT = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
const UNIT = ['', '拾', '佰', '仟'];
const BIG = ['', '万', '亿', '万亿'];
function group4(n) {
  const arr = [];
  let t = n;
  for (let i = 0; i < 4; i++) {
    arr.push(t % 10);
    t = Math.floor(t / 10);
  }
  let s = '';
  let zero = false;
  for (let i = 3; i >= 0; i--) {
    const d = arr[i];
    if (d === 0) {
      if (s) zero = true;
    } else {
      if (zero) {
        s += '零';
        zero = false;
      }
      s += DIGIT[d] + UNIT[i];
    }
  }
  return s;
}
export function rmbUpper(input) {
  const num = Number(input);
  if (!Number.isFinite(num)) return '';
  const neg = num < 0;
  let x = Math.abs(Math.round(num * 100) / 100);
  let intPart = Math.floor(x + 1e-9);
  let cents = Math.round((x - intPart) * 100);
  if (cents >= 100) {
    intPart += 1;
    cents -= 100;
  }
  const jiao = Math.floor(cents / 10);
  const fen = cents % 10;
  let intStr = '零';
  if (intPart > 0) {
    const groups = [];
    let t = intPart;
    while (t > 0) {
      groups.push(t % 10000);
      t = Math.floor(t / 10000);
    }
    intStr = '';
    let needZero = false;
    for (let g = groups.length - 1; g >= 0; g--) {
      const gv = groups[g];
      if (gv === 0) {
        if (intStr) needZero = true;
        continue;
      }
      if (intStr && (needZero || gv < 1000)) intStr += '零';
      intStr += group4(gv) + BIG[g];
      needZero = false;
    }
  }
  let out = `${neg ? '负' : ''}${intStr}元`;
  if (jiao === 0 && fen === 0) return `${out}整`;
  if (jiao === 0) return `${out}零${DIGIT[fen]}分`;
  out += `${DIGIT[jiao]}角`;
  if (fen > 0) out += `${DIGIT[fen]}分`;
  return out;
}