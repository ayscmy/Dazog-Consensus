import './env.js'; // 必须在读取 process.env 之前加载 .env（引擎在模块求值期就确定）
import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT_DIR = ROOT;

// ============================================================
//  双后端数据库层
//  - 默认 SQLite（零依赖、单文件，开箱即用）
//  - 当 DB_TYPE=postgres 或（未显式指定且配置了 DATABASE_URL）时切换为 PostgreSQL
//  由部署者通过环境变量选择，最终用户无需关心。
// ============================================================

const DB_TYPE_RAW = (process.env.DB_TYPE || '').toLowerCase();
export const DB_ENGINE =
  DB_TYPE_RAW === 'postgres' ||
  (DB_TYPE_RAW !== 'sqlite' && !!process.env.DATABASE_URL)
    ? 'postgres'
    : 'sqlite';

// SQLite 单文件位置（可用 CRM_DB / DB_FILE 覆盖）
export const DB_FILE =
  process.env.CRM_DB || process.env.DB_FILE || join(ROOT, 'data', 'crm.db');

// PostgreSQL 独立 schema，与销售系统（public）隔离，避免撞表
export const SCHEMA = DB_ENGINE === 'postgres' ? process.env.PG_SCHEMA || 'crm' : 'main';

export const DB_LABEL =
  DB_ENGINE === 'postgres'
    ? `PostgreSQL（schema: ${SCHEMA}）`
    : `SQLite（文件: ${DB_FILE}）`;

export const DB_INFO = {
  engine: DB_ENGINE,
  schema: SCHEMA,
  file: DB_ENGINE === 'sqlite' ? DB_FILE : undefined,
  connectionString: undefined,
};

// ---- 按需加载对应驱动（SQLite 走内置 node:sqlite；PG 仅 PG 模式才加载 pg 依赖） ----
let pg = null;
let PG_CONNECTION_STRING = null;
export let pool = null; // PG 模式为 Pool；SQLite 模式为 null（供脚本/备份兼容）

if (DB_ENGINE === 'postgres') {
  pg = (await import('pg')).default;
  PG_CONNECTION_STRING =
    process.env.DATABASE_URL ||
    `postgres://${encodeURIComponent(process.env.PG_USER || 'mscrm')}:${encodeURIComponent(
      process.env.PG_PASSWORD || ''
    )}@${process.env.PG_HOST || '127.0.0.1'}:${process.env.PG_PORT || 5432}/${
      process.env.PG_DATABASE || 'mscrm'
    }${process.env.PG_SSLMODE ? `?sslmode=${process.env.PG_SSLMODE}` : ''}`;
  DB_INFO.connectionString = PG_CONNECTION_STRING.replace(/\/\/[^@]+@/, '//***:***@');
  pool = new pg.Pool({
    connectionString: PG_CONNECTION_STRING,
    // 每次新建连接即固定 search_path，避免 pool.on('connect') 竞态导致找不到 crm 表
    options: `-c search_path=${SCHEMA},public`,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

let sqliteDb = null;
if (DB_ENGINE === 'sqlite') {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (e) {
    console.error(
      '[db] 当前 Node 版本不支持 node:sqlite（需 Node >= 22.5，部分版本需用 --experimental-sqlite 启动）。\n' +
        '若需使用 SQLite 模式，请升级 Node 或改用 PostgreSQL（设置 DB_TYPE=postgres + DATABASE_URL）。'
    );
    throw e;
  }
  mkdirSync(dirname(DB_FILE), { recursive: true });
  sqliteDb = new DatabaseSync(DB_FILE);
}

// ---- `?` -> `$1,$2,...` 占位符转换（仅 PostgreSQL 需要；引号内不替换） ----
function bindSql(sql) {
  if (DB_ENGINE !== 'postgres') return sql; // SQLite 原生支持 ? 占位符
  let out = '';
  let n = 0;
  let inStr = false;
  let prev = '';
  for (let k = 0; k < sql.length; k++) {
    const c = sql[k];
    const p = sql[k - 1];
    if (inStr) {
      out += c;
      if (c === "'") {
        if (p === "'") prev = '';
        else inStr = false;
      } else prev = c;
      continue;
    }
    if (c === "'") {
      inStr = true;
      out += c;
      prev = c;
      continue;
    }
    if (c === '?') {
      out += '$' + ++n;
      continue;
    }
    out += c;
  }
  return out;
}

// 事务内通过 AsyncLocalStorage 绑定同一连接（PG）；SQLite 单连接，恒返回同一句柄
const txStore = new AsyncLocalStorage();

function clientFor() {
  if (DB_ENGINE === 'postgres') return txStore.getStore() || pool;
  return sqliteDb;
}

// 兼容两种传参习惯：run(sql, a, b) 与 run(sql, [a, b])。
// SQL 绑定值都是标量，不会被误判，能兜住历史代码里遗留的数组包一层调用。
function normParams(params) {
  return params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
}

// node:sqlite 的绑定很严格：只接受 null/number/bigint/string/Uint8Array，
// 遇到 undefined、布尔、Date 会直接抛错（pg 则会把 undefined 当 null、布尔当 bool）。
// 这里统一归一化，让两种库的写入行为一致，也兜住历史代码里大量“字段可空”的写法。
function toSqliteValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return v;
}
function sqliteArgs(args) {
  return args.map(toSqliteValue);
}

export async function all(sql, ...params) {
  const args = normParams(params);
  if (DB_ENGINE === 'postgres') {
    const res = await clientFor().query(bindSql(sql), args);
    return res.rows;
  }
  return sqliteDb.prepare(sql).all(...sqliteArgs(args));
}

export async function one(sql, ...params) {
  const rows = await all(sql, ...params);
  return rows[0] || null;
}

// 这些表没有名为 id 的自增主键（sessions 用 token、user_roles 复合主键、settings 用 key），
// 不能自动补 RETURNING id，否则会报“column id does not exist”
const NO_ID_TABLES = new Set(['sessions', 'user_roles', 'settings']);

export async function run(sql, ...params) {
  const args = normParams(params);
  if (DB_ENGINE === 'postgres') {
    let s = bindSql(sql);
    // INSERT 自动补 RETURNING id，兼容原 idOf(result) 用法；但无 id 列的表例外
    const m = /^\s*insert\s+into\s+(?:"?[\w]+"?\.)?"?([\w]+)"?/i.exec(s);
    const tbl = m ? m[1].toLowerCase() : '';
    if (/^\s*insert\s+into\b/i.test(s) && !/\breturning\b/i.test(s) && !NO_ID_TABLES.has(tbl)) {
      s += ' RETURNING id';
    }
    const res = await clientFor().query(s, args);
    const lastInsertRowid = res.rows && res.rows[0] ? res.rows[0].id : undefined;
    return {
      rowCount: res.rowCount ?? 0,
      changes: res.rowCount ?? 0,
      lastInsertRowid,
      rows: res.rows,
    };
  }
  // SQLite：DatabaseSync 的 run 直接返回 { changes, lastInsertRowid }
  const res = sqliteDb.prepare(sql).run(...sqliteArgs(args));
  return {
    rowCount: res.changes,
    changes: res.changes,
    lastInsertRowid: res.lastInsertRowid,
    rows: [],
  };
}

export function idOf(result) {
  return Number(result && result.lastInsertRowid);
}

export async function tx(fn) {
  if (DB_ENGINE === 'postgres') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await txStore.run(client, fn);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  // SQLite 单连接、同步执行，无需 AsyncLocalStorage
  sqliteDb.exec('BEGIN');
  try {
    const out = await fn();
    sqliteDb.exec('COMMIT');
    return out;
  } catch (e) {
    sqliteDb.exec('ROLLBACK');
    throw e;
  }
}

export const nowIso = () => new Date().toISOString();

/** 本地日期 YYYY-MM-DD */
export function today(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---- 方言相关的 SQL 片段（让业务代码在两种库下都能跑） ----
/** 把日期列规范化成“可与 current_date 比较”的形式：PG 要显式 ::date，SQLite 用 date() */
export function dateCol(col) {
  return DB_ENGINE === 'postgres' ? `${col}::date` : `date(${col})`;
}

/** 「日期列 < 今天」：PG 里 due_date 是 TEXT，不能直接和 date 比较，必须转换 */
export function dateLtToday(col) {
  return `${dateCol(col)} < current_date`;
}

/** 判断某个时间戳/日期列是否属于“今天”：created_at 在两种库里都是文本 YYYY-MM-DD[THH:MM:SSZ] */
export function isToday(col) {
  return DB_ENGINE === 'postgres'
    ? `${dateCol(col)} = current_date`
    : `substr(${col},1,10) = current_date`;
}

/** 距今天数（正数表示已逾期）：(current_date - due_date) 的天数差 */
export function overdueDays(col) {
  return DB_ENGINE === 'postgres'
    ? `(current_date - ${col}::date)`
    : `cast(julianday(current_date) - julianday(${col}) as int)`;
}

// ============================================================
//  建表 DDL（PostgreSQL 版，SERIAL 自增；已把历史迁移列并入基表）
//  SQLite 版由本常量逐表转换得到，列定义完全一致。
// ============================================================
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS org_units (
  id         SERIAL PRIMARY KEY,
  parent_id  INTEGER REFERENCES org_units(id),
  path       TEXT NOT NULL DEFAULT '/',
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  code       TEXT,
  sort       INTEGER NOT NULL DEFAULT 0,
  level      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_parent ON org_units(parent_id);
CREATE INDEX IF NOT EXISTS idx_org_path   ON org_units(path);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password      TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  org_id        INTEGER NOT NULL REFERENCES org_units(id),
  title         TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  last_login_at TEXT,
  discount_limit REAL,
  left_at       TEXT,
  left_reason   TEXT,
  handover_to   INTEGER,
  handover_at   TEXT
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip         TEXT,
  ua         TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  short_name   TEXT,
  industry     TEXT,
  scale        TEXT,
  region       TEXT,
  level        TEXT,
  credit_level TEXT,
  owner_id     INTEGER REFERENCES users(id),
  org_id       INTEGER NOT NULL REFERENCES org_units(id),
  parent_id    INTEGER REFERENCES accounts(id),
  phone        TEXT,
  website      TEXT,
  address      TEXT,
  source       TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  remark       TEXT,
  created_by   INTEGER,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acc_org ON accounts(org_id);
CREATE INDEX IF NOT EXISTS idx_acc_owner ON accounts(owner_id);

CREATE TABLE IF NOT EXISTS contacts (
  id         SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  title      TEXT,
  dept       TEXT,
  phone      TEXT,
  email      TEXT,
  wechat     TEXT,
  role_type  TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  remark     TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ct_account ON contacts(account_id);

CREATE TABLE IF NOT EXISTS leads (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  contact_name  TEXT,
  contact_title TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  source        TEXT,
  industry      TEXT,
  region        TEXT,
  demand        TEXT,
  budget        TEXT,
  purchase_time TEXT,
  next_action   TEXT,
  next_date     TEXT,
  status        TEXT NOT NULL DEFAULT 'new',
  score         INTEGER NOT NULL DEFAULT 0,
  owner_id      INTEGER REFERENCES users(id),
  org_id        INTEGER NOT NULL REFERENCES org_units(id),
  claim_at      TEXT,
  invalid_reason TEXT,
  account_id    INTEGER REFERENCES accounts(id),
  contact_id    INTEGER REFERENCES contacts(id),
  opportunity_id INTEGER,
  last_activity_at TEXT,
  external_id   TEXT,
  created_by    INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_lead_owner ON leads(owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_external ON leads(external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS opportunities (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  lead_id       INTEGER REFERENCES leads(id),
  amount        REAL NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'CNY',
  stage         TEXT NOT NULL DEFAULT 'lead_in',
  probability   INTEGER NOT NULL DEFAULT 10,
  expected_date TEXT,
  owner_id      INTEGER REFERENCES users(id),
  org_id        INTEGER NOT NULL REFERENCES org_units(id),
  source        TEXT,
  product_line  TEXT,
  competitor    TEXT,
  evidence      TEXT NOT NULL DEFAULT '{}',
  won_reason    TEXT,
  lost_reason   TEXT,
  contract_id   INTEGER,
  won_at        TEXT,
  lost_at       TEXT,
  created_by    INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opp_stage ON opportunities(stage);
CREATE INDEX IF NOT EXISTS idx_opp_owner ON opportunities(owner_id);

CREATE TABLE IF NOT EXISTS activities (
  id          SERIAL PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id   INTEGER NOT NULL,
  type        TEXT NOT NULL,
  content     TEXT,
  result      TEXT,
  next_action TEXT,
  next_date   TEXT,
  user_id     INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_act_target ON activities(target_type, target_id);

CREATE TABLE IF NOT EXISTS quotations (
  id             SERIAL PRIMARY KEY,
  no             TEXT NOT NULL UNIQUE,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id),
  account_id     INTEGER NOT NULL REFERENCES accounts(id),
  version        INTEGER NOT NULL DEFAULT 1,
  amount         REAL NOT NULL DEFAULT 0,
  list_amount    REAL NOT NULL DEFAULT 0,
  discount_rate  REAL NOT NULL DEFAULT 0,
  cost           REAL NOT NULL DEFAULT 0,
  valid_until    TEXT,
  status         TEXT NOT NULL DEFAULT 'draft',
  approval_id    INTEGER,
  remark         TEXT,
  created_by     INTEGER,
  org_id         INTEGER NOT NULL REFERENCES org_units(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  has_custom     INTEGER NOT NULL DEFAULT 0,
  public_token   TEXT,
  last_sent_at   TEXT,
  send_count     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contracts (
  id             SERIAL PRIMARY KEY,
  no             TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  opportunity_id INTEGER REFERENCES opportunities(id),
  account_id     INTEGER NOT NULL REFERENCES accounts(id),
  quotation_id   INTEGER REFERENCES quotations(id),
  amount         REAL NOT NULL DEFAULT 0,
  tax_rate       REAL NOT NULL DEFAULT 0.06,
  payment_terms  INTEGER NOT NULL DEFAULT 30,
  sign_date      TEXT,
  start_date     TEXT,
  end_date       TEXT,
  status         TEXT NOT NULL DEFAULT 'draft',
  approval_id    INTEGER,
  owner_id       INTEGER REFERENCES users(id),
  org_id         INTEGER NOT NULL REFERENCES org_units(id),
  created_by     INTEGER,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  activated_at   TEXT,
  kind           TEXT NOT NULL DEFAULT 'order',
  tax_mode       TEXT NOT NULL DEFAULT 'included',
  buyer_json     TEXT,
  seller_json    TEXT,
  items_json     TEXT,
  clauses_json   TEXT,
  template_id    INTEGER,
  discount_rate  REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payment_plans (
  id          SERIAL PRIMARY KEY,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  due_date    TEXT NOT NULL,
  amount      REAL NOT NULL,
  ratio       REAL,
  status      TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS invoices (
  id          SERIAL PRIMARY KEY,
  no          TEXT,
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  amount      REAL NOT NULL,
  tax_rate    REAL NOT NULL DEFAULT 0.06,
  type        TEXT NOT NULL DEFAULT 'special',
  status      TEXT NOT NULL DEFAULT 'applied',
  apply_by    INTEGER,
  applied_at  TEXT NOT NULL,
  issued_at   TEXT,
  remark      TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id          SERIAL PRIMARY KEY,
  no          TEXT NOT NULL UNIQUE,
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  amount      REAL NOT NULL,
  method      TEXT NOT NULL DEFAULT 'transfer',
  received_at TEXT NOT NULL,
  bank_ref    TEXT,
  remark      TEXT,
  created_by  INTEGER,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id         SERIAL PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  invoice_id INTEGER REFERENCES invoices(id),
  amount     REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id           SERIAL PRIMARY KEY,
  type         TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    INTEGER NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT,
  amount       REAL,
  status       TEXT NOT NULL DEFAULT 'pending',
  current_step INTEGER NOT NULL DEFAULT 1,
  total_steps  INTEGER NOT NULL DEFAULT 1,
  applicant_id INTEGER NOT NULL REFERENCES users(id),
  org_id       INTEGER NOT NULL REFERENCES org_units(id),
  created_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_appr_status ON approvals(status);

CREATE TABLE IF NOT EXISTS approval_steps (
  id            SERIAL PRIMARY KEY,
  approval_id   INTEGER NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  role          TEXT NOT NULL,
  label         TEXT NOT NULL,
  approver_id   INTEGER REFERENCES users(id),
  decision      TEXT NOT NULL DEFAULT 'pending',
  comment       TEXT,
  decided_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_step_appr ON approval_steps(approval_id);

CREATE TABLE IF NOT EXISTS targets (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  org_id     INTEGER NOT NULL REFERENCES org_units(id),
  period     TEXT NOT NULL,
  amount     REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, period)
);

CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT,
  spec        TEXT,
  unit        TEXT NOT NULL DEFAULT '套',
  list_price  REAL NOT NULL DEFAULT 0,
  cost        REAL NOT NULL DEFAULT 0,
  min_price   REAL,
  status      TEXT NOT NULL DEFAULT 'active',
  remark      TEXT,
  org_id      INTEGER REFERENCES org_units(id),
  created_by  INTEGER,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prod_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_prod_category ON products(category);

CREATE TABLE IF NOT EXISTS quotation_items (
  id           SERIAL PRIMARY KEY,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL DEFAULT 1,
  product_id   INTEGER REFERENCES products(id),
  name         TEXT NOT NULL,
  spec         TEXT,
  unit         TEXT,
  qty          REAL NOT NULL DEFAULT 1,
  list_price   REAL NOT NULL DEFAULT 0,
  unit_price   REAL NOT NULL DEFAULT 0,
  amount       REAL NOT NULL DEFAULT 0,
  cost         REAL NOT NULL DEFAULT 0,
  is_custom    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_qitem_quote ON quotation_items(quotation_id);

CREATE TABLE IF NOT EXISTS attachments (
  id          SERIAL PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id   INTEGER NOT NULL,
  stage       TEXT,
  name        TEXT NOT NULL,
  mime        TEXT,
  size        INTEGER NOT NULL,
  path        TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_att_target ON attachments(target_type, target_id);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER,
  user_name   TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   INTEGER,
  detail      TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS handovers (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  to_user_id    INTEGER NOT NULL REFERENCES users(id),
  accounts      INTEGER NOT NULL DEFAULT 0,
  opportunities INTEGER NOT NULL DEFAULT 0,
  leads         INTEGER NOT NULL DEFAULT 0,
  contracts     INTEGER NOT NULL DEFAULT 0,
  approvals     INTEGER NOT NULL DEFAULT 0,
  left_at       TEXT,
  note          TEXT,
  created_by    INTEGER,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handover_user ON handovers(user_id);

CREATE TABLE IF NOT EXISTS contract_templates (
  id         SERIAL PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  category   TEXT,
  summary    TEXT,
  clauses    TEXT NOT NULL DEFAULT '[]',
  builtin    INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quote_sends (
  id           SERIAL PRIMARY KEY,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL,
  target       TEXT NOT NULL,
  subject      TEXT,
  content      TEXT,
  status       TEXT NOT NULL,
  provider     TEXT,
  error        TEXT,
  link         TEXT,
  sent_by      INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qsend_quote ON quote_sends(quotation_id);

CREATE TABLE IF NOT EXISTS api_clients (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  client_id    TEXT NOT NULL UNIQUE,
  key_prefix   TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  scopes       TEXT NOT NULL DEFAULT '["lead:read","lead:write"]',
  ip_whitelist TEXT NOT NULL DEFAULT '',
  -- 授权域名：与 IP 白名单互补。留空 = 不校验来源域名（服务器对服务器调用通常没有 Origin/Referer）
  domain_whitelist TEXT NOT NULL DEFAULT '',
  rate_limit   INTEGER NOT NULL DEFAULT 60,
  daily_quota  INTEGER NOT NULL DEFAULT 5000,
  expire_at    TEXT,
  org_id       INTEGER REFERENCES org_units(id),
  owner_id     INTEGER REFERENCES users(id),
  remark       TEXT,
  created_by   INTEGER,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  last_ip      TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_apic_status ON api_clients(status);

CREATE TABLE IF NOT EXISTS api_logs (
  id          SERIAL PRIMARY KEY,
  client_id   INTEGER,
  client_name TEXT,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  ip          TEXT,
  status      INTEGER NOT NULL DEFAULT 0,
  ms          INTEGER NOT NULL DEFAULT 0,
  request     TEXT,
  response    TEXT,
  error       TEXT,
  ua          TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apilog_client ON api_logs(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_apilog_time ON api_logs(created_at);

-- 官网注册自动开通的试用账号：到期由官网调用内部接口 / 本机定时任务回收
-- user_id / org_id 故意不加外键：账号被物理删除后仍要保留这条开通记录，便于对账
CREATE TABLE IF NOT EXISTS trial_accounts (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER,
  org_id      INTEGER,
  username    TEXT,
  email       TEXT NOT NULL,
  name        TEXT,
  company     TEXT,
  source      TEXT NOT NULL DEFAULT 'website',
  days        INTEGER NOT NULL DEFAULT 7,
  expires_at  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL,
  purged_at   TEXT,
  purge_note  TEXT
);
CREATE INDEX IF NOT EXISTS idx_trial_status ON trial_accounts(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_trial_email ON trial_accounts(email);
`;

// SQLite 建表 DDL：列定义与 PG 完全一致，仅主键自增写法不同
const SQLITE_DDL = SCHEMA_DDL.replace(/SERIAL PRIMARY KEY/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT');

export async function migrate() {
  if (DB_ENGINE === 'postgres') await migratePg();
  else await migrateSqlite();
  await ensureColumns();
}

/**
 * 轻量列迁移。
 *
 * DDL 只有 CREATE TABLE IF NOT EXISTS，对已经存在的老库来说，新增列不会自动出现，
 * 而 `select *` 拿不到列会让鉴权静默退化成「没有这条规则」——所以老库必须补列。
 * 这里只做「加列」；改类型、删列涉及数据搬迁，一律人工评估，不放进自动迁移。
 */
const COLUMN_PATCHES = [
  ['api_clients', 'domain_whitelist', "TEXT NOT NULL DEFAULT ''"],
];

async function ensureColumns() {
  for (const [table, column, ddl] of COLUMN_PATCHES) {
    const exists = DB_ENGINE === 'postgres'
      ? Boolean(await one(
          'select 1 from information_schema.columns where table_schema = ? and table_name = ? and column_name = ?',
          SCHEMA, table, column
        ))
      : (await all(`PRAGMA table_info(${table})`)).some((r) => r.name === column);
    if (exists) continue;
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    console.log(`[db] 已为老库补充列 ${table}.${column}`);
  }
}

async function migratePg() {
  // 用独立连接先建 schema（避免 pool 的 search_path 在 schema 不存在时报错）
  const boot = new pg.Client({ connectionString: PG_CONNECTION_STRING });
  await boot.connect();
  await boot.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  await boot.query(`SET search_path TO "${SCHEMA}", public`);
  for (const stmt of SCHEMA_DDL.split(';')) {
    const s = stmt.trim();
    if (s) await boot.query(s);
  }
  await boot.end();

  // 之后 pool 新建连接都默认走 crm schema
  pool.on('connect', (cl) => cl.query(`SET search_path TO "${SCHEMA}", public`));

  // 组织层级回填 + 种子模板（走统一查询接口，自动带 search_path）
  await run(
    `UPDATE org_units SET level = (length(path) - length(replace(path, '/', ''))) - 1 WHERE level = 0 OR level IS NULL`
  );
  await seedTemplates();
}

async function migrateSqlite() {
  // 这三条 PRAGMA 只是性能/完整性调优，任何一条在当前文件系统上不被支持
  // 都不该让服务起不来，故逐条容错。
  for (const pragma of ['PRAGMA journal_mode=WAL', 'PRAGMA busy_timeout=5000', 'PRAGMA foreign_keys=ON']) {
    try { sqliteDb.exec(pragma); } catch { /* 忽略：退化为默认行为 */ }
  }
  sqliteDb.exec(SQLITE_DDL);
  await run(
    `UPDATE org_units SET level = (length(path) - length(replace(path, '/', ''))) - 1 WHERE level = 0 OR level IS NULL`
  );
  await seedTemplates();
}

/** 内置条款模板：只在表为空时写入，不覆盖用户自建模板 */
async function seedTemplates() {
  const r = await one('select count(*) c from contract_templates');
  if (r && Number(r.c) > 0) return;
  const at = new Date().toISOString();
  const rowsData = [
    {
      code: 'TPL-SVC',
      name: '软件实施服务合同',
      category: '服务',
      summary: '适用于 MES / WMS 等系统的实施、开发与运维服务',
      clauses: [
        { title: '第一条 项目内容', body: '乙方向甲方提供 {{project}} 的软件开发、实施与上线服务，具体功能范围以双方确认的《需求规格说明书》为准。' },
        { title: '第二条 合同金额', body: '本合同总金额为人民币 {{amount}} 元（含税），付款方式为验收后 {{payment_terms}} 天内结清。' },
        { title: '第三条 交付与验收', body: '乙方应于合同生效后按项目计划完成交付，甲方应在收到交付成果后 15 个工作日内完成验收，逾期未提出异议视为验收通过。' },
        { title: '第四条 知识产权', body: '乙方为履行本合同所形成的定制化开发成果，其著作权归甲方所有；乙方保留其既有产品、工具及通用组件的全部权利。' },
        { title: '第五条 保密义务', body: '双方对在合作过程中知悉的对方商业秘密、技术资料承担保密义务，保密期限自本合同签署之日起五年。' },
        { title: '第六条 违约责任', body: '任何一方违约，应赔偿对方因此遭受的直接经济损失；逾期付款的，按未付金额每日万分之五支付违约金。' },
        { title: '第七条 争议解决', body: '因本合同引起的争议，双方应友好协商解决；协商不成的，提交乙方所在地有管辖权的人民法院诉讼解决。' },
      ],
    },
    {
      code: 'TPL-PROD',
      name: '产品采购合同',
      category: '采购',
      summary: '标准软硬件产品买卖，含交付、质保与结算条款',
      clauses: [
        { title: '第一条 标的与规格', body: '甲方向乙方采购的产品名称、规格型号、数量及单价详见合同附件《产品清单》，附件与本合同具有同等法律效力。' },
        { title: '第二条 价格与结算', body: '本合同价税合计人民币 {{amount}} 元，甲方应于收货后 {{payment_terms}} 天内支付全部款项。' },
        { title: '第三条 交付', body: '乙方于合同生效后 10 个工作日内将货物送达甲方指定地点，运输费用由乙方承担。' },
        { title: '第四条 质保', body: '产品自验收合格之日起质保 12 个月，质保期内因产品质量问题导致的故障，乙方免费维修或更换。' },
        { title: '第五条 违约责任', body: '甲方逾期付款的，每日按逾期金额的万分之五支付违约金；乙方逾期交付的，每日按合同总额的万分之五支付违约金。' },
        { title: '第六条 争议解决', body: '双方因履行本合同发生争议，应协商解决；协商不成的，提交合同签订地人民法院诉讼解决。' },
      ],
    },
    {
      code: 'TPL-NDA',
      name: '保密协议（NDA）',
      category: '法务',
      summary: '售前技术交流、POC 阶段先行签署',
      clauses: [
        { title: '第一条 保密信息', body: '本协议所称保密信息，指一方以书面、口头、电子等形式向另一方披露的、标注或应合理认定为保密的技术与商业信息。' },
        { title: '第二条 保密义务', body: '接收方应对保密信息严格保密，仅可为评估双方合作之目的使用，不得向任何第三方披露。' },
        { title: '第三条 例外情形', body: '接收方能够证明属于以下情形的信息不属于保密信息：已公开的信息、接收方独立开发的信息、依法律或监管要求必须披露的信息。' },
        { title: '第四条 期限', body: '本协议自双方签署之日起生效，保密义务持续至保密信息公开或自披露之日起满三年。' },
        { title: '第五条 违约与争议', body: '违反本协议造成损失的，违约方应承担赔偿责任；争议由 {{seller.name}} 所在地人民法院管辖。' },
      ],
    },
  ];
  for (const tpl of rowsData) {
    // 注意：run() 用 rest 参数展开，这里要逐个传值，不能包成一个数组
    await run(
      `INSERT INTO contract_templates(code,name,category,summary,clauses,builtin,status,created_at,updated_at)
       VALUES(?,?,?,?,?,1,'active',?,?)`,
      tpl.code, tpl.name, tpl.category, tpl.summary, JSON.stringify(tpl.clauses), at, at
    );
  }
}

/**
 * 逻辑备份：把每张表导出为 JSON 快照（PG 走 search_path，SQLite 走主库）。
 * 供 backup.js 使用。
 */
export async function dumpTables(tableNames) {
  const tables = {};
  for (const t of tableNames) {
    try {
      tables[t] = await all(`select * from ${t}`);
    } catch (e) {
      tables[t] = { __error: String((e && e.message) || e) };
    }
  }
  return {
    engine: DB_ENGINE,
    schema: SCHEMA,
    createdAt: new Date().toISOString(),
    file: DB_ENGINE === 'sqlite' ? DB_FILE : undefined,
    tables,
  };
}
