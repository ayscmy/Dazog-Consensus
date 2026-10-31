import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SITE_ROOT = ROOT;
export const SITE_DB = process.env.SITE_DB || join(ROOT, 'data', 'site.db');

mkdirSync(dirname(SITE_DB), { recursive: true });

export const db = new DatabaseSync(SITE_DB);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

const NULL = (v) => (v === undefined ? null : v);

export const all = (sql, ...p) => db.prepare(sql).all(...p.map(NULL));
export const one = (sql, ...p) => db.prepare(sql).get(...p.map(NULL)) || null;
export const run = (sql, ...p) => db.prepare(sql).run(...p.map(NULL));
export const idOf = (r) => Number(r.lastInsertRowid);
export const nowIso = () => new Date().toISOString();

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

export function migrate() {
  db.exec(`
CREATE TABLE IF NOT EXISTS members (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE,
  password       TEXT NOT NULL,
  name           TEXT NOT NULL,
  company        TEXT,
  phone          TEXT,
  role           TEXT NOT NULL DEFAULT 'member',   -- member | admin
  status         TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  last_login_at  TEXT,
  downloads      INTEGER NOT NULL DEFAULT 0,
  source         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_member_email ON members(email);

CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  ip         TEXT,
  ua         TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_member ON sessions(member_id);

CREATE TABLE IF NOT EXISTS email_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  purpose    TEXT NOT NULL DEFAULT 'signup',
  expires_at TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_code_email ON email_codes(email, purpose);

CREATE TABLE IF NOT EXISTS versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version     TEXT NOT NULL UNIQUE,
  title       TEXT,
  notes       TEXT,
  file_name   TEXT NOT NULL,
  file_size   INTEGER NOT NULL DEFAULT 0,
  sha256      TEXT,
  channel     TEXT NOT NULL DEFAULT 'stable',      -- stable | beta
  status      TEXT NOT NULL DEFAULT 'published',   -- published | draft
  released_at TEXT NOT NULL,
  downloads   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS downloads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  version_id INTEGER,
  version    TEXT,
  ip         TEXT,
  ua         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_download_member ON downloads(member_id, created_at);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_time ON events(created_at);
  `);
}

export function logEvent(kind, detail, ip = '') {
  try {
    run('insert into events(kind, detail, ip, created_at) values(?,?,?,?)', kind, detail, ip, nowIso());
  } catch { /* 审计失败不影响主流程 */ }
}
