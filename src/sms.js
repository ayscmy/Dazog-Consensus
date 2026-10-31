import { getSetting, isOn } from './settings.js';

/**
 * 短信发送：对接企业短信网关（HTTP POST JSON）。
 * 约定请求体：{ phone, content, sign, token }
 * 返回 2xx 视为成功；如需读取业务码，可在网关侧做映射。
 */
export async function sendSms({ phone, content }) {
  const gateway = String(getSetting('sms.gateway') || '').trim();
  const provider = gateway ? `sms:${new URL(gateway).host}` : 'sms:未配置';

  if (!isOn('sms.enabled')) {
    return { ok: false, simulated: true, provider, error: '未启用短信发送（系统设置 → 短信发送）' };
  }
  if (!gateway) return { ok: false, simulated: true, provider, error: '未配置短信网关地址' };
  if (!/^1[3-9]\d{9}$/.test(String(phone || ''))) {
    return { ok: false, provider, error: '手机号格式不正确' };
  }

  const token = String(getSetting('sms.token') || '');
  const sign = String(getSetting('sms.sign') || '');
  try {
    const res = await fetch(gateway, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ phone, content, sign, token }),
      signal: AbortSignal.timeout(10000),
    });
    const bodyText = await res.text().catch(() => '');
    if (!res.ok) {
      return { ok: false, provider, error: `网关返回 ${res.status}：${bodyText.slice(0, 160) || '无内容'}` };
    }
    return { ok: true, provider, raw: bodyText.slice(0, 200) };
  } catch (err) {
    return { ok: false, provider, error: err.message || '短信网关请求失败' };
  }
}
