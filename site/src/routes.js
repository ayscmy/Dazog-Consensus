import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join, basename, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  GET, POST, PUT, PATCH, HttpError, bad, denied, notFound, hit, throttle, readBody,
} from './http.js';
import { all, one, run, nowIso, logEvent, idOf } from './db.js';
import { hashPassword, verifyPassword, sha256, randomToken } from './password.js';
import { createSession, destroySession, cookieHeader } from './auth.js';
import { sendMail, mailReady, mailConfig } from './mail.js';
import {
  listVersions, publicView, getVersion, downloadPath, recordDownload,
  todayDownloads, memberDownloads, DAILY_LIMIT, scanReleaseDir,
  registerVersion, streamFile, RELEASE_DIR,
} from './versions.js';

const emailOk = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
const normEmail = (s) => String(s || '').trim().toLowerCase();
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export const SITE_NAME = process.env.SITE_NAME || 'MSERM';
export const SITE_TAGLINE = process.env.SITE_TAGLINE || '从线索到回款的集团 CRM';
export const APP_REPO = process.env.SITE_REPO || 'https://gitee.com/Emcloud_admin/mserm-crm';
export const SITE_URL = process.env.SITE_URL || `http://localhost:${process.env.PORT || 8099}`;

/* ==================== 站点信息 ==================== */

GET('/api/meta', () => ({
  name: SITE_NAME,
  tagline: SITE_TAGLINE,
  repo: APP_REPO,
  versions: listVersions().slice(0, 6),
  stats: {
    members: Number(one("select count(*) c from members where status='active'").c || 0),
    downloads: Number(one('select count(*) c from downloads').c || 0),
  },
  mailReady: mailReady(),
  requireCode: mailReady() && String(process.env.SITE_REQUIRE_CODE ?? '1') === '1',
}), { auth: false });

/* ==================== 邮箱验证码 ==================== */

// 未登录也返回 200 + member:null，避免首页控制台出现无意义的 401
GET('/api/auth/me', (ctx) => memberView(ctx.member), { auth: false });

function memberView(m) {
  if (!m) return { member: null };
  return {
    member: {
      id: m.id, email: m.email, name: m.name, company: m.company, phone: m.phone,
      role: m.role, emailVerified: !!m.email_verified, createdAt: m.created_at,
      downloads: m.downloads,
    },
    quota: { used: todayDownloads(m.id), limit: DAILY_LIMIT },
    versions: listVersions(),
    downloads: memberDownloads(m.id, 20),
  };
}

POST('/api/auth/code', async (ctx) => {
  const email = normEmail(ctx.body.email);
  if (!emailOk(email)) throw bad('邮箱格式不正确');

  // 同邮箱 60 秒一次，同 IP 每小时 10 次
  const rl = hit(`code:${ctx.ip}`, 10, 3600_000);
  if (!rl.ok) throw new HttpError(429, `请求过于频繁，请 ${rl.retryAfter} 秒后再试`);
  const last = one('select created_at from email_codes where email = ? order by id desc limit 1', email);
  if (last && Date.now() - new Date(last.created_at).getTime() < 60_000) {
    throw new HttpError(429, '验证码已发送，请 60 秒后再试');
  }
  if (one('select 1 from members where email = ?', email)) {
    throw new HttpError(409, '该邮箱已注册，请直接登录');
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  run(
    'insert into email_codes(email, code_hash, purpose, expires_at, used, created_at) values(?,?,?,?,0,?)',
    email, sha256(`${email}:${code}`), 'signup', expires, nowIso()
  );

  if (!mailReady()) {
    console.log(`[site] 邮箱验证码 ${email} = ${code}（未配置 SMTP，仅本地调试可见）`);
    return { ok: true, simulated: true, devCode: code, message: '未配置邮件服务，验证码已输出到服务端日志' };
  }

  const html = `
    <div style="font:15px/1.8 -apple-system,'Microsoft YaHei',sans-serif;color:#1f2937;max-width:520px">
      <h2 style="margin:0 0 12px;font-size:19px">验证你的邮箱</h2>
      <p style="color:#4b5563;margin:0 0 18px">你正在注册 ${escapeHtml(SITE_NAME)} 官网会员，验证码 10 分钟内有效：</p>
      <div style="font:700 30px/1.2 ui-monospace,Menlo,monospace;letter-spacing:8px;background:#f3f6ff;
                  border:1px solid #dbe4ff;border-radius:10px;padding:16px 20px;color:#2f6bff;text-align:center">${code}</div>
      <p style="color:#9ca3af;font-size:12.5px;margin-top:18px">如果这不是你本人的操作，请忽略这封邮件。</p>
    </div>`;
  const sent = await sendMail({ to: email, subject: `【${SITE_NAME}】注册验证码 ${code}`, html });
  if (!sent.ok) throw new HttpError(502, `验证码邮件发送失败：${sent.error}`);
  return { ok: true, message: '验证码已发送，请查收邮件' };
});

function verifyCode(email, code) {
  const row = one(
    "select * from email_codes where email = ? and purpose='signup' and used = 0 order by id desc limit 1",
    email
  );
  if (!row) throw bad('请先获取验证码');
  if (new Date(row.expires_at).getTime() < Date.now()) throw bad('验证码已过期，请重新获取');
  if (sha256(`${email}:${String(code || '').trim()}`) !== row.code_hash) throw bad('验证码不正确');
  run('update email_codes set used = 1 where id = ?', row.id);
}

/* ==================== 注册 / 登录 ==================== */

POST('/api/auth/signup', (ctx) => {
  const email = normEmail(ctx.body.email);
  const password = String(ctx.body.password || '');
  const name = str(ctx.body.name, 30);
  const company = str(ctx.body.company, 60);
  const phone = str(ctx.body.phone, 20);
  const code = ctx.body.code;

  if (!emailOk(email)) throw bad('请填写正确的邮箱');
  if (name.length < 2) throw bad('请填写称呼（至少 2 个字）');
  if (company.length < 2) throw bad('请填写公司名称');
  if (password.length < 8) throw bad('密码至少 8 位');
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) throw bad('密码需同时包含字母和数字');
  if (phone && !/^1[3-9]\d{9}$/.test(phone)) throw bad('手机号格式不正确');
  if (one('select 1 from members where email = ?', email)) {
    throw new HttpError(409, '该邮箱已注册，请直接登录');
  }

  const rl = hit(`signup:${ctx.ip}`, 8, 3600_000);
  if (!rl.ok) throw new HttpError(429, '注册过于频繁，请稍后再试');

  const needCode = mailReady() && String(process.env.SITE_REQUIRE_CODE ?? '1') === '1';
  if (needCode) verifyCode(email, code);

  const now = nowIso();
  const r = run(
    `insert into members(email, password, name, company, phone, role, status, email_verified, created_at, downloads, source)
     values(?,?,?,?,?, 'member', 'active', ?, ?, 0, ?)`,
    email, hashPassword(password), name, company, phone || null, needCode ? 1 : 0, now,
    str(ctx.body.source || 'website', 40)
  );
  const m = one('select * from members where id = ?', idOf(r));
  const token = createSession(m.id, ctx.ip, ctx.req.headers['user-agent']);
  ctx.res.setHeader('Set-Cookie', cookieHeader(token));
  logEvent('signup', `${email} ${name} ${company}`, ctx.ip);
  return memberView(m);
});

POST('/api/auth/login', (ctx) => {
  const email = normEmail(ctx.body.email);
  const password = String(ctx.body.password || '');
  if (!email || !password) throw bad('请输入邮箱和密码');

  const gate = throttle(`${ctx.ip}|${email}`, 6, 10 * 60_000);
  if (gate.locked) throw new HttpError(429, `登录失败次数过多，请 ${gate.wait} 秒后再试`);

  const m = one('select * from members where email = ?', email);
  if (!m || !verifyPassword(password, m.password)) {
    gate.fail();
    throw new HttpError(401, '邮箱或密码不正确');
  }
  if (m.status !== 'active') throw denied('账号已被停用，请联系官网客服');

  gate.reset();
  run('update members set last_login_at = ? where id = ?', nowIso(), m.id);
  logEvent('login', email, ctx.ip);
  const token = createSession(m.id, ctx.ip, ctx.req.headers['user-agent']);
  ctx.res.setHeader('Set-Cookie', cookieHeader(token));
  return memberView(m);
});

POST('/api/auth/logout', (ctx) => {
  destroySession(ctx.req);
  ctx.res.setHeader('Set-Cookie', cookieHeader('', 0));
  return { ok: true };
}, { auth: false });

/* ==================== 版本与下载 ==================== */

GET('/api/versions', () => ({ versions: listVersions() }), { auth: false });

GET('/api/download/:id', (ctx) => {
  const v = getVersion(Number(ctx.params.id));
  if (!v || v.status !== 'published') throw notFound('版本不存在或未发布');

  const used = todayDownloads(ctx.member.id);
  if (used >= DAILY_LIMIT) {
    throw new HttpError(429, `今日下载次数已达上限（${DAILY_LIMIT} 次），请明天再试`);
  }

  const file = downloadPath(v);
  if (!existsSync(file)) throw new HttpError(410, '安装包文件缺失，请联系管理员重新发布');

  recordDownload(ctx.member, v, ctx.ip, ctx.req.headers['user-agent']);
  logEvent('download', `${ctx.member.email} ← ${v.version} ${v.file_name}`, ctx.ip);
  streamFile(ctx.req, ctx.res, file, v.file_name);
}, { auth: true });

/* ==================== 会员中心 ==================== */

POST('/api/my/profile', (ctx) => {
  const name = str(ctx.body.name, 30);
  const company = str(ctx.body.company, 60);
  const phone = str(ctx.body.phone, 20);
  if (name.length < 2) throw bad('请填写称呼（至少 2 个字）');
  if (company.length < 2) throw bad('请填写公司名称');
  if (phone && !/^1[3-9]\d{9}$/.test(phone)) throw bad('手机号格式不正确');
  run('update members set name = ?, company = ?, phone = ? where id = ?', name, company, phone || null, ctx.member.id);
  return memberView(one('select * from members where id = ?', ctx.member.id));
}, { auth: true });

POST('/api/my/password', (ctx) => {
  const oldPwd = String(ctx.body.oldPassword || '');
  const newPwd = String(ctx.body.newPassword || '');
  if (!verifyPassword(oldPwd, ctx.member.password)) throw bad('原密码不正确');
  if (newPwd.length < 8 || !/[a-zA-Z]/.test(newPwd) || !/\d/.test(newPwd)) {
    throw bad('新密码至少 8 位，且包含字母和数字');
  }
  run('update members set password = ? where id = ?', hashPassword(newPwd), ctx.member.id);
  run('delete from sessions where member_id = ?', ctx.member.id);
  const token = createSession(ctx.member.id, ctx.ip, ctx.req.headers['user-agent']);
  ctx.res.setHeader('Set-Cookie', cookieHeader(token));
  logEvent('password', ctx.member.email, ctx.ip);
  return { ok: true };
}, { auth: true });

/* ==================== 管理后台 ==================== */

GET('/api/admin/overview', () => {
  const day7 = new Date(Date.now() - 7 * 86400000).toISOString();
  return {
    stats: {
      members: Number(one('select count(*) c from members').c || 0),
      active: Number(one("select count(*) c from members where status='active'").c || 0),
      new7: Number(one('select count(*) c from members where created_at >= ?', day7).c || 0),
      downloads: Number(one('select count(*) c from downloads').c || 0),
      down7: Number(one('select count(*) c from downloads where created_at >= ?', day7).c || 0),
      versions: Number(one("select count(*) c from versions where status='published'").c || 0),
    },
    members: all(
      `select id, email, name, company, phone, status, email_verified, created_at, last_login_at, downloads
       from members order by id desc limit 100`
    ),
    downloads: all(
      `select d.id, d.version, d.ip, d.created_at, m.email, m.company
       from downloads d join members m on m.id = d.member_id order by d.id desc limit 50`
    ),
    versions: listVersions({ includeDraft: true }),
    files: scanReleaseDir(),
    events: all('select * from events order by id desc limit 30'),
    releaseDir: RELEASE_DIR,
  };
}, { admin: true });

PATCH('/api/admin/members/:id', (ctx) => {
  const m = one('select * from members where id = ?', Number(ctx.params.id));
  if (!m) throw notFound('会员不存在');
  if (m.role === 'admin') throw denied('不能停用管理员账号');
  const status = ctx.body.status === 'active' ? 'active' : 'disabled';
  run('update members set status = ? where id = ?', status, m.id);
  if (status === 'disabled') run('delete from sessions where member_id = ?', m.id);
  logEvent('member.status', `${m.email} → ${status}`, ctx.ip);
  return { ok: true, status };
}, { admin: true });

POST('/api/admin/versions', (ctx) => {
  const version = str(ctx.body.version, 30);
  const fileName = str(ctx.body.fileName, 120);
  if (!/^\d+\.\d+\.\d+([\w.-]*)?$/.test(version)) throw bad('版本号格式应为 1.2.3');
  if (!fileName) throw bad('请选择安装包');
  try {
    const v = registerVersion({
      version,
      title: str(ctx.body.title, 80),
      notes: String(ctx.body.notes || '').slice(0, 4000),
      fileName,
      channel: ctx.body.channel === 'beta' ? 'beta' : 'stable',
      status: ctx.body.status === 'draft' ? 'draft' : 'published',
    });
    logEvent('version.publish', `${version} ${fileName}`, ctx.ip);
    return { ok: true, version: publicView(v) };
  } catch (err) {
    throw bad(err.message);
  }
}, { admin: true });

/** 上传安装包：请求体直接是二进制，文件名放查询参数，避免引入 multipart 依赖 */
PUT('/api/admin/upload', async (ctx) => {
  const fileName = basename(String(ctx.query.get('name') || ''));
  if (!/^[^\\/:*?"<>|]+\.(db|zip|tar|gz|7z)$/i.test(fileName)) {
    throw bad('文件名不合法，只支持 .db / .zip / .tar.gz / .7z');
  }
  const max = Number(process.env.SITE_MAX_UPLOAD_MB || 200) * 1024 * 1024;
  const len = Number(ctx.req.headers['content-length'] || 0);
  if (len > max) throw new HttpError(413, `安装包超过 ${max / 1024 / 1024} MB 上限`);

  mkdirSync(RELEASE_DIR, { recursive: true });
  const target = join(RELEASE_DIR, fileName);
  await pipeline(ctx.req, createWriteStream(target));
  const size = statSync(target).size;
  logEvent('version.upload', `${fileName} ${size} bytes`, ctx.ip);
  return { ok: true, fileName, size };
}, { admin: true, raw: true });

/* ==================== 管理员的会话 ==================== */

/** 首个管理员：环境变量指定，未指定则随机密码并打印到启动日志 */
export function ensureAdmin() {
  const existing = one("select * from members where role = 'admin' limit 1");
  if (existing) return { created: false, email: existing.email };

  const email = normEmail(process.env.SITE_ADMIN_EMAIL || 'admin@mserm.local');
  const password = process.env.SITE_ADMIN_PASSWORD || randomToken(6);
  const now = nowIso();
  run(
    `insert into members(email, password, name, company, phone, role, status, email_verified, created_at, downloads, source)
     values(?,?,?,?,?, 'admin', 'active', 1, ?, 0, 'system')`,
    email, hashPassword(password), '官网管理员', 'MSERM', null, now
  );
  return { created: true, email, password };
}
