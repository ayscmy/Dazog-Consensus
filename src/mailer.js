import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { getSetting, isOn } from './settings.js';

/* =========================================================
   极简 SMTP 客户端（零依赖）
   支持 465 SSL、587 STARTTLS、AUTH LOGIN
   —— 只做「发一封带 HTML 正文的邮件」，够用且可控
   ========================================================= */

const CRLF = '\r\n';

class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buf = '';
    this.queue = [];
    this.waiters = [];
    this.error = null;
    this.onData = (d) => { this.buf += d.toString('utf8'); this.pump(); };
    this.onError = (e) => { this.error = e; this.wake(); };
    this.onClose = () => { if (!this.error) { this.error = new Error('SMTP 连接已关闭'); this.wake(); } };
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  detach() {
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('error', this.onError);
    this.socket.removeListener('close', this.onClose);
  }

  pump() {
    let i;
    while ((i = this.buf.indexOf(CRLF)) >= 0) {
      this.queue.push(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 2);
    }
    this.wake();
  }

  wake() { this.waiters.splice(0).forEach((fn) => fn()); }

  /** 读到一条完整响应（含多行 250-xxx） */
  async next() {
    const lines = [];
    for (;;) {
      while (this.queue.length) {
        const line = this.queue.shift();
        lines.push(line);
        const m = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!m) continue;                      // 多行响应中间的非标准行，忽略
        if (m[2] === ' ') return { code: Number(m[1]), text: lines.join('\n'), last: m[3] };
      }
      if (this.error) throw this.error;
      await new Promise((r) => this.waiters.push(r));
    }
  }
}

function connect({ host, port, secure, timeout = 15000 }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host }, () => resolve(socket))
      : net.connect({ host, port }, () => resolve(socket));
    socket.setTimeout(timeout, () => socket.destroy(new Error('SMTP 连接超时')));
    socket.once('error', reject);
  });
}

async function cmd(socket, session, line, okCodes = [250]) {
  socket.write(`${line}${CRLF}`);
  const res = await session.next();
  if (!okCodes.includes(res.code)) {
    throw new Error(`SMTP 拒绝「${line.split(' ')[0]}」：${res.code} ${res.last}`);
  }
  return res;
}

function upgrade(rawSocket, host) {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket: rawSocket, servername: host }, () => resolve(t));
    t.once('error', reject);
  });
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
const headerWord = (s) => `=?UTF-8?B?${Buffer.from(String(s), 'utf8').toString('base64')}?=`;

export function buildMime({ fromName, from, to, subject, html, text }) {
  const domain = String(from).split('@')[1] || 'localhost';
  const boundary = `_mserm_${randomBytes(8).toString('hex')}`;
  const plain = text || String(html || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n');
  const lines = [
    `From: ${fromName ? `${headerWord(fromName)} ` : ''}<${from}>`,
    `To: <${to}>`,
    `Subject: ${headerWord(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    'This is a multi-part message in MIME format.',
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(plain),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html || plain),
    `--${boundary}--`,
    '',
  ];
  return lines.join(CRLF);
}

async function smtpSend(cfg, { from, to, mime }) {
  const socket = await connect(cfg);
  let session = new SmtpSession(socket);
  try {
    const greet = await session.next();
    if (greet.code !== 220) throw new Error(`SMTP 服务未就绪：${greet.code} ${greet.last}`);

    let socketRef = socket;
    let ehlo = await cmd(socketRef, session, `EHLO ${cfg.helo || 'localhost'}`, [250]);

    if (!cfg.secure && /STARTTLS/i.test(ehlo.text)) {
      await cmd(socketRef, session, 'STARTTLS', [220]);
      session.detach();
      const secured = await upgrade(socketRef, cfg.host);
      socketRef = secured;
      session = new SmtpSession(secured);
      ehlo = await cmd(socketRef, session, `EHLO ${cfg.helo || 'localhost'}`, [250]);
    }

    if (cfg.user) {
      const ok = await cmd(socketRef, session, 'AUTH LOGIN', [334, 235, 503]);
      if (ok.code === 334) {
        await cmd(socketRef, session, Buffer.from(cfg.user, 'utf8').toString('base64'), [334]);
        await cmd(socketRef, session, Buffer.from(cfg.pass || '', 'utf8').toString('base64'), [235, 503]);
      }
    }

    await cmd(socketRef, session, `MAIL FROM:<${from}>`, [250]);
    await cmd(socketRef, session, `RCPT TO:<${to}>`, [250, 251]);
    await cmd(socketRef, session, 'DATA', [354]);
    const stuffed = mime.split(CRLF).map((l) => (l.startsWith('.') ? `.${l}` : l)).join(CRLF);
    socketRef.write(`${stuffed}${CRLF}.${CRLF}`);
    const done = await session.next();
    if (done.code !== 250) throw new Error(`邮件投递失败：${done.code} ${done.last}`);
    try { await cmd(socketRef, session, 'QUIT', [221]); } catch { /* 已投递成功，忽略退出异常 */ }
    socketRef.end();
    return true;
  } finally {
    try { socket.destroy(); } catch { /* ignore */ }
  }
}

/**
 * 发送邮件。未配置或失败都不抛异常，统一返回结构化结果，由调用方落库。
 * @returns {{ok:boolean, simulated?:boolean, provider:string, error?:string}}
 */
export async function sendMail({ to, subject, html, text }) {
  const host = String(getSetting('mail.host') || '').trim();
  const user = String(getSetting('mail.user') || '').trim();
  const from = String(getSetting('mail.from') || user || '').trim();
  const provider = host ? `smtp:${host}` : 'smtp:未配置';

  if (!isOn('mail.enabled')) {
    return { ok: false, simulated: true, provider, error: '未启用邮件发送（系统设置 → 邮件发送）' };
  }
  if (!host || !from) {
    return { ok: false, simulated: true, provider, error: 'SMTP 服务器或发件地址未配置完整' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to || ''))) {
    return { ok: false, provider, error: '收件邮箱格式不正确' };
  }

  const mime = buildMime({
    fromName: getSetting('mail.from_name') || '',
    from,
    to,
    subject,
    html,
    text,
  });
  const cfg = {
    host,
    port: Number(getSetting('mail.port') || 465),
    secure: String(getSetting('mail.secure') ?? '1') === '1',
    user,
    pass: getSetting('mail.pass') || '',
    helo: from.split('@')[1] || 'localhost',
  };
  try {
    await Promise.race([
      smtpSend(cfg, { from, to, mime }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('邮件发送超时（20 秒）')), 20000)),
    ]);
    return { ok: true, provider };
  } catch (err) {
    return { ok: false, provider, error: err.message || '发送失败' };
  }
}
