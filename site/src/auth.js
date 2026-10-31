import { one, run, nowIso } from './db.js';
import { randomToken, sha256 } from './password.js';
import { parseCookies } from './http.js';

export const COOKIE = 'site_sid';
export const SESSION_DAYS = Number(process.env.SITE_SESSION_DAYS || 30);
const SECURE = String(process.env.SITE_SECURE_COOKIE || '') === '1';

export function cookieHeader(token, maxAge = SESSION_DAYS * 86400) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE ? '; Secure' : ''}`;
}

export function createSession(memberId, ip, ua) {
  const token = randomToken(32);
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_DAYS * 86400000);
  run(
    'insert into sessions(token_hash, member_id, ip, ua, created_at, expires_at) values(?,?,?,?,?,?)',
    sha256(token), memberId, ip || '', String(ua || '').slice(0, 200), now.toISOString(), exp.toISOString()
  );
  return token;
}

export function currentMember(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = one(
    `select m.*, s.expires_at from sessions s join members m on m.id = s.member_id
     where s.token_hash = ?`,
    sha256(token)
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    run('delete from sessions where token_hash = ?', sha256(token));
    return null;
  }
  if (row.status !== 'active') return null;
  delete row.password;
  return row;
}

export function destroySession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) run('delete from sessions where token_hash = ?', sha256(token));
}

export function purgeExpired() {
  run('delete from sessions where expires_at < ?', nowIso());
}
