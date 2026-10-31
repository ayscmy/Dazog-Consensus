import net from 'node:net';
import tls from 'node:tls';

/**
 * 官网会员邮件：只用来发注册验证码 / 找回密码。
 * 零依赖 SMTP 客户端，支持 465 SSL 与 587 STARTTLS + AUTH LOGIN。
 * 未配置 SMTP_HOST 时进入「模拟发送」，验证码会写进服务端日志，方便本地调试。
 */

const CRLF = '\r\n';

export const mailConfig = () => ({
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE ?? '1') === '1',
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@localhost',
  fromName: process.env.SMTP_FROM_NAME || 'MSERM 官网',
});

export const mailReady = () => Boolean(mailConfig().host);

class Reader {
  constructor(sock) {
    this.sock = sock;
    this.buf = '';
    this.lines = [];
    this.waiters = [];
    this.err = null;
    sock.on('data', (d) => { this.buf += d.toString('utf8'); this.pump(); });
    sock.on('error', (e) => { this.err = e; this.wake(); });
    sock.on('close', () => { this.err = this.err || new Error('SMTP 连接已关闭'); this.wake(); });
  }
  pump() {
    let i;
    while ((i = this.buf.indexOf(CRLF)) >= 0) {
      this.lines.push(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 2);
    }
    this.wake();
  }
  wake() { this.waiters.splice(0).forEach((f) => f()); }
  async read() {
    const got = [];
    for (;;) {
      while (this.lines.length) {
        const line = this.lines.shift();
        got.push(line);
        const m = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!m) continue;
        if (m[2] === ' ') return { code: Number(m[1]), text: got.join('\n'), last: m[3] };
      }
      if (this.err) throw this.err;
      await new Promise((r) => this.waiters.push(r));
    }
  }
}

async function cmd(sock, reader, line, expect = 250) {
  if (line != null) sock.write(line + CRLF);
  const r = await reader.read();
  if (r.code !== expect && !(expect === 250 && r.code === 251)) {
    throw new Error(`SMTP ${line ? line.split(' ')[0] : 'greeting'} 失败：${r.code} ${r.last}`);
  }
  return r;
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const wrap76 = (s) => (s.match(/.{1,76}/g) || []).join(CRLF);

export function buildMime({ from, fromName, to, subject, html, text }) {
  const body = text && !html
    ? { type: 'text/plain; charset=utf-8', data: wrap76(b64(text)) }
    : { type: 'text/html; charset=utf-8', data: wrap76(b64(html || '')) };
  return [
    `From: =?UTF-8?B?${b64(fromName)}?= <${from}>`,
    `To: <${to}>`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: ${body.type}`,
    'Content-Transfer-Encoding: base64',
    '',
    body.data,
  ].join(CRLF);
}

export async function sendMail({ to, subject, html, text }) {
  const cfg = mailConfig();
  if (!cfg.host) {
    console.log(`[mail:simulated] to=${to} subject=${subject}`);
    return { ok: false, simulated: true, error: '未配置 SMTP_HOST，邮件未真实发送' };
  }

  let sock = cfg.secure
    ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
    : net.connect({ host: cfg.host, port: cfg.port });

  await new Promise((res, rej) => {
    sock.once(cfg.secure ? 'secureConnect' : 'connect', res);
    sock.once('error', rej);
  });
  sock.setTimeout(20000, () => sock.destroy(new Error('SMTP 超时')));
  let reader = new Reader(sock);

  try {
    await cmd(sock, reader, null, 220);
    const ehlo = await cmd(sock, reader, 'EHLO mserm.local', 250);

    if (!cfg.secure) {
      await cmd(sock, reader, 'STARTTLS', 220);
      sock = tls.connect({ socket: sock, servername: cfg.host });
      await new Promise((res, rej) => {
        sock.once('secureConnect', res);
        sock.once('error', rej);
      });
      reader = new Reader(sock);
      await cmd(sock, reader, 'EHLO mserm.local', 250);
    }

    if (cfg.user) {
      await cmd(sock, reader, 'AUTH LOGIN', 334);
      await cmd(sock, reader, b64(cfg.user), 334);
      await cmd(sock, reader, b64(cfg.pass), 235);
    }

    await cmd(sock, reader, `MAIL FROM:<${cfg.from}>`, 250);
    await cmd(sock, reader, `RCPT TO:<${to}>`, 250);
    await cmd(sock, reader, 'DATA', 354);
    const mime = buildMime({
      from: cfg.from, fromName: cfg.fromName, to, subject, html, text,
    }).replace(/\r?\n\./g, CRLF + '..');
    sock.write(mime + CRLF + '.' + CRLF);
    const done = await reader.read();
    if (done.code !== 250) throw new Error(`发送被拒绝：${done.code} ${done.last}`);
    sock.write('QUIT' + CRLF);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    sock.destroy();
  }
}
