import { createHash, createPublicKey, verify as cryptoVerify, sign as cryptoSign } from 'node:crypto';
import { hostname, platform, arch } from 'node:os';

/**
 * 授权码的纯函数核心：验签、发签、机器指纹。
 *
 * 刻意不 import 数据库——签发脚本要在没有库、甚至没有 .env 的机器上跑，
 * 一旦这里牵进 db.js，CLI 就得先连库才能签一张纸。
 */

/** 签发端公钥（私钥在 AIEMY 手里，绝不分发；换密钥等于作废所有已发授权） */
export const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAIDk0vOLgGkvThzSZX0Pq9TDCLer4qEctABUDeOfJDEA=
-----END PUBLIC KEY-----`;

export const LICENSE_VERSION = 1;

const pubKey = createPublicKey(PUBLIC_KEY_PEM);

/**
 * 机器指纹：主机名 + 平台 + 架构 的短哈希。
 * 故意不含 MAC / 磁盘序列号——那些取不到时会抛错或随硬件变动，
 * 客户换块硬盘就得重新授权。够区分「这台机器」即可。
 */
export function machineId() {
  return createHash('sha256')
    .update(`${hostname()}|${platform()}|${arch()}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
}

/** expire 为 YYYY-MM-DD，按当天 23:59:59 算，避免客户在到期日当天就被拦 */
function expireAt(expire) {
  const t = new Date(`${expire}T23:59:59`).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * 解析并验签。纯函数：不查库、不抛异常，签发脚本与产品端共用同一套判断。
 */
export function verifyLicense(code, { machine = machineId(), now = Date.now() } = {}) {
  const raw = String(code || '').trim();
  if (!raw) return { valid: false, reason: '未提供授权码' };

  const parts = raw.split('.');
  if (parts.length !== 2) {
    return { valid: false, reason: '授权码格式不正确（应为「载荷.签名」两段）' };
  }

  let payloadBuf;
  let sigBuf;
  try {
    payloadBuf = Buffer.from(parts[0], 'base64url');
    sigBuf = Buffer.from(parts[1], 'base64url');
  } catch {
    return { valid: false, reason: '授权码不是合法的 base64url 编码' };
  }
  if (!payloadBuf.length || !sigBuf.length) {
    return { valid: false, reason: '授权码内容为空' };
  }

  let signed = false;
  try {
    signed = cryptoVerify(null, payloadBuf, pubKey, sigBuf);
  } catch {
    signed = false;
  }
  if (!signed) {
    return { valid: false, reason: '签名校验失败：授权码被修改过，或不是本产品签发的' };
  }

  let p;
  try {
    p = JSON.parse(payloadBuf.toString('utf8'));
  } catch {
    return { valid: false, reason: '授权载荷不是合法 JSON' };
  }
  if (Number(p.v) !== LICENSE_VERSION) {
    return { valid: false, reason: `授权版本不支持（v${p.v}，当前支持 v${LICENSE_VERSION}）`, payload: p };
  }

  // machine 可选：填了就绑机器，留空则不限机器（客户换服务器不用重签）
  if (p.machine && String(p.machine).toUpperCase() !== String(machine).toUpperCase()) {
    return {
      valid: false,
      reason: `该授权绑定的是另一台机器（${p.machine}），当前机器指纹为 ${machine}`,
      machineMismatch: true,
      payload: p,
    };
  }

  if (p.expire) {
    const end = expireAt(p.expire);
    if (end === null) return { valid: false, reason: `到期日格式不正确：${p.expire}`, payload: p };
    if (end < now) {
      return { valid: false, reason: `授权已于 ${p.expire} 到期`, expired: true, payload: p };
    }
  }

  return { valid: true, payload: p };
}

/** 把授权载荷翻译成业务可直接用的权益 */
export function entitlementsOf(payload = {}) {
  const rawUsers = payload.users === undefined || payload.users === null ? 0 : Number(payload.users);
  const users = Number.isFinite(rawUsers) && rawUsers > 0 ? Math.floor(rawUsers) : 0; // 0 / 缺省 = 不限
  return {
    edition: String(payload.edition || 'commercial'),
    usersLimit: users,
    features: Array.isArray(payload.features) ? payload.features.map(String) : [],
    customer: String(payload.to || ''),
    licenseId: String(payload.id || ''),
    expire: payload.expire || null,
    issuedAt: payload.issued || null,
    machine: payload.machine || null,
  };
}

/**
 * 签发：把 payload 序列化后用私钥签名。
 * 只在 AIEMY 侧调用；产品端没有这段的调用入口，只有公钥。
 */
export function issueLicense(payload, privateKeyPem) {
  const body = { ...payload, v: LICENSE_VERSION };
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  const sig = cryptoSign(null, buf, privateKeyPem);
  return `${buf.toString('base64url')}.${sig.toString('base64url')}`;
}
