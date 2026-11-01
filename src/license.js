import { createHash } from 'node:crypto';
import { getSetting, setSetting } from './settings.js';
import {
  PUBLIC_KEY_PEM,
  LICENSE_VERSION,
  machineId,
  verifyLicense,
  entitlementsOf,
} from './license-core.js';

/**
 * 商业授权：读取、激活、状态查询。
 *
 * 验签逻辑在 license-core.js（纯函数，命令行工具也用它），这里只管「码从哪来、存哪去」。
 *
 * 为什么用非对称签名而不是「一个密码」：
 *   产品要能离线验证，所以验证方必须有「能验不能签」的东西。公钥写在代码里，
 *   客户反编译只能拿到公钥——能验证，签不出新的授权码。
 *   若用对称 HMAC，密钥必须随产品分发，等于谁都能自己签发。
 *
 * 清醒一点：这是「防君子不防小人」。Node 源码部署下，客户理论上可以改
 * edition.js 把限制摘掉。现方案的目标是让「正常用户走正规流程」有据可依，
 * 而不是对抗逆向——那需要混淆或服务端校验，是另一个成本量级。
 */

export { PUBLIC_KEY_PEM, LICENSE_VERSION, machineId, verifyLicense, entitlementsOf };

/** 授权码存在 settings 表里的键名（后台激活走这条；.env 的 CRM_LICENSE 优先级更高） */
export const SETTING_KEY = 'license.code';

let cache = { raw: null, at: 0, result: null };
const CACHE_MS = 30_000;

/** 授权码来源优先级：环境变量 > 数据库（后台激活）> 无 */
export async function currentLicense({ force = false } = {}) {
  const envCode = String(process.env.CRM_LICENSE || '').trim();
  const dbCode = envCode ? '' : String((await getSetting(SETTING_KEY)) || '').trim();
  const raw = envCode || dbCode;

  if (!force && cache.raw === raw && Date.now() - cache.at < CACHE_MS) return cache.result;

  const source = envCode ? 'env' : dbCode ? 'console' : 'none';
  const result = raw
    ? { ...verifyLicense(raw), source, raw }
    : { valid: false, reason: '尚未激活商业授权', source: 'none', raw: '' };

  cache = { raw, at: Date.now(), result };
  return result;
}

/** 有效授权才有权益，否则返回 null（调用方据此回落社区版规则） */
export async function entitlements() {
  const lic = await currentLicense();
  return lic.valid ? entitlementsOf(lic.payload) : null;
}

/** 后台激活：验签通过才落库，避免把错码存进去导致每次都要重新解析 */
export async function activateLicense(code) {
  const r = verifyLicense(code);
  if (!r.valid) return { ok: false, error: r.reason };
  await setSetting(SETTING_KEY, String(code).trim());
  cache = { raw: null, at: 0, result: null };
  return { ok: true, license: entitlementsOf(r.payload) };
}

export async function clearLicense() {
  await setSetting(SETTING_KEY, '');
  cache = { raw: null, at: 0, result: null };
  return { ok: true };
}

/** 给前端展示的整体状态（不外泄完整授权码，只给指纹与权益） */
export async function licenseStatus() {
  const lic = await currentLicense();
  const ent = lic.valid ? entitlementsOf(lic.payload) : null;
  return {
    active: lic.valid,
    source: lic.source,
    reason: lic.valid ? null : lic.reason,
    fingerprint: lic.raw ? createHash('sha256').update(lic.raw).digest('hex').slice(0, 12) : null,
    machine: machineId(),
    entitlements: ent,
  };
}
