import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT_DIR = ROOT;
export const DB_FILE = process.env.CRM_DB || join(ROOT, 'data', 'crm.db');

mkdirSync(dirname(DB_FILE), { recursive: true });

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

const NULL = (v) => (v === undefined ? null : v);

export function all(sql, ...params) {
  return db.prepare(sql).all(...params.map(NULL));
}
export function one(sql, ...params) {
  return db.prepare(sql).get(...params.map(NULL)) || null;
}
export function run(sql, ...params) {
  return db.prepare(sql).run(...params.map(NULL));
}
export function idOf(result) {
  return Number(result.lastInsertRowid);
}

/** 同步事务：业务里所有写多表的操作都走这里 */
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

export const nowIso = () => new Date().toISOString();

/** 本地日期 YYYY-MM-DD */
export function today(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS org_units (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id  INTEGER REFERENCES org_units(id),
  path       TEXT NOT NULL DEFAULT '/',
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,              -- group | company | dept | team
  code       TEXT,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_parent ON org_units(parent_id);
CREATE INDEX IF NOT EXISTS idx_org_path   ON org_units(path);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password      TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  org_id        INTEGER NOT NULL REFERENCES org_units(id),
  title         TEXT,
  status        TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  created_at    TEXT NOT NULL,
  last_login_at TEXT
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
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  short_name   TEXT,
  industry     TEXT,
  scale        TEXT,
  region       TEXT,
  level        TEXT,                    -- A | B | C
  credit_level TEXT,                    -- AAA | AA | A | B
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
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  title      TEXT,
  dept       TEXT,
  phone      TEXT,
  email      TEXT,
  wechat     TEXT,
  role_type  TEXT,                      -- decision | influencer | user | gatekeeper
  is_primary INTEGER NOT NULL DEFAULT 0,
  remark     TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ct_account ON contacts(account_id);

CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
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
  status        TEXT NOT NULL DEFAULT 'new',  -- new | contacted | qualified | converted | invalid
  score         INTEGER NOT NULL DEFAULT 0,
  owner_id      INTEGER REFERENCES users(id),
  org_id        INTEGER NOT NULL REFERENCES org_units(id),
  claim_at      TEXT,
  invalid_reason TEXT,
  account_id    INTEGER REFERENCES accounts(id),
  contact_id    INTEGER REFERENCES contacts(id),
  opportunity_id INTEGER,
  last_activity_at TEXT,
  created_by    INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_lead_owner ON leads(owner_id);

CREATE TABLE IF NOT EXISTS opportunities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  lead_id       INTEGER REFERENCES leads(id),
  amount        REAL NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'CNY',
  stage         TEXT NOT NULL DEFAULT 'lead_in',  -- lead_in|needs|proposal|negotiation|won|lost
  probability   INTEGER NOT NULL DEFAULT 10,
  expected_date TEXT,
  owner_id      INTEGER REFERENCES users(id),
  org_id        INTEGER NOT NULL REFERENCES org_units(id),
  source        TEXT,
  product_line  TEXT,
  competitor    TEXT,
  evidence      TEXT NOT NULL DEFAULT '{}',       -- 阶段证据 JSON
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
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,            -- lead | opportunity | account | contract
  target_id   INTEGER NOT NULL,
  type        TEXT NOT NULL,            -- call | visit | email | meeting | note | stage
  content     TEXT,
  result      TEXT,
  next_action TEXT,
  next_date   TEXT,
  user_id     INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_act_target ON activities(target_type, target_id);

CREATE TABLE IF NOT EXISTS quotations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  no             TEXT NOT NULL UNIQUE,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id),
  account_id     INTEGER NOT NULL REFERENCES accounts(id),
  version        INTEGER NOT NULL DEFAULT 1,
  amount         REAL NOT NULL DEFAULT 0,      -- 报价总额（含税）
  list_amount    REAL NOT NULL DEFAULT 0,      -- 标准价
  discount_rate  REAL NOT NULL DEFAULT 0,      -- 0.08 = 折扣 8%
  cost           REAL NOT NULL DEFAULT 0,      -- 成本（敏感）
  valid_until    TEXT,
  status         TEXT NOT NULL DEFAULT 'draft', -- draft|pending|approved|rejected|converted|expired
  approval_id    INTEGER,
  remark         TEXT,
  created_by     INTEGER,
  org_id         INTEGER NOT NULL REFERENCES org_units(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  no             TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  opportunity_id INTEGER REFERENCES opportunities(id),
  account_id     INTEGER NOT NULL REFERENCES accounts(id),
  quotation_id   INTEGER REFERENCES quotations(id),
  amount         REAL NOT NULL DEFAULT 0,
  tax_rate       REAL NOT NULL DEFAULT 0.06,
  payment_terms  INTEGER NOT NULL DEFAULT 30,  -- 账期天数
  sign_date      TEXT,
  start_date     TEXT,
  end_date       TEXT,
  status         TEXT NOT NULL DEFAULT 'draft', -- draft|sales_review|finance_review|legal_review|active|rejected|terminated|completed
  approval_id    INTEGER,
  owner_id       INTEGER REFERENCES users(id),
  org_id         INTEGER NOT NULL REFERENCES org_units(id),
  created_by     INTEGER,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  activated_at   TEXT
);

CREATE TABLE IF NOT EXISTS payment_plans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  due_date    TEXT NOT NULL,
  amount      REAL NOT NULL,
  ratio       REAL,
  status      TEXT NOT NULL DEFAULT 'pending'  -- pending | received
);

CREATE TABLE IF NOT EXISTS invoices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  no          TEXT,
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  amount      REAL NOT NULL,
  tax_rate    REAL NOT NULL DEFAULT 0.06,
  type        TEXT NOT NULL DEFAULT 'special', -- special | normal
  status      TEXT NOT NULL DEFAULT 'applied', -- applied | issued | void
  apply_by    INTEGER,
  applied_at  TEXT NOT NULL,
  issued_at   TEXT,
  remark      TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  invoice_id INTEGER REFERENCES invoices(id),
  amount     REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT NOT NULL,          -- quote_discount | contract | contract_change
  target_type  TEXT NOT NULL,
  target_id    INTEGER NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT,
  amount       REAL,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|cancelled
  current_step INTEGER NOT NULL DEFAULT 1,
  total_steps  INTEGER NOT NULL DEFAULT 1,
  applicant_id INTEGER NOT NULL REFERENCES users(id),
  org_id       INTEGER NOT NULL REFERENCES org_units(id),
  created_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_appr_status ON approvals(status);

CREATE TABLE IF NOT EXISTS approval_steps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id   INTEGER NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  role          TEXT NOT NULL,
  label         TEXT NOT NULL,
  approver_id   INTEGER REFERENCES users(id),
  decision      TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|skipped
  comment       TEXT,
  decided_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_step_appr ON approval_steps(approval_id);

CREATE TABLE IF NOT EXISTS targets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  org_id     INTEGER NOT NULL REFERENCES org_units(id),
  period     TEXT NOT NULL,             -- 2026-10
  amount     REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, period)
);

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT,                                -- 产品线：MES / WMS / 数据中台 ...
  spec        TEXT,                                -- 规格说明
  unit        TEXT NOT NULL DEFAULT '套',
  list_price  REAL NOT NULL DEFAULT 0,             -- 标准价（对外报价基准）
  cost        REAL NOT NULL DEFAULT 0,             -- 成本价（敏感，仅经理及以上可见）
  min_price   REAL,                                -- 底价，低于此价必须审批
  status      TEXT NOT NULL DEFAULT 'active',      -- active | inactive
  remark      TEXT,
  org_id      INTEGER REFERENCES org_units(id),
  created_by  INTEGER,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prod_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_prod_category ON products(category);

CREATE TABLE IF NOT EXISTS quotation_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL DEFAULT 1,
  product_id   INTEGER REFERENCES products(id),    -- 为空表示例外报价项
  name         TEXT NOT NULL,
  spec         TEXT,
  unit         TEXT,
  qty          REAL NOT NULL DEFAULT 1,
  list_price   REAL NOT NULL DEFAULT 0,
  unit_price   REAL NOT NULL DEFAULT 0,
  amount       REAL NOT NULL DEFAULT 0,
  cost         REAL NOT NULL DEFAULT 0,
  is_custom    INTEGER NOT NULL DEFAULT 0          -- 1 = 不在产品库中的例外项
);
CREATE INDEX IF NOT EXISTS idx_qitem_quote ON quotation_items(quotation_id);

CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,                       -- opportunity | lead | contract | quotation
  target_id   INTEGER NOT NULL,
  stage       TEXT,                                -- 关联的阶段（推进证据）
  name        TEXT NOT NULL,
  mime        TEXT,
  size        INTEGER NOT NULL,
  path        TEXT NOT NULL,                       -- 相对 data/uploads 的文件名
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
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
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

-- 离职交接记录：谁在什么时候把哪些资产交接给了谁
CREATE TABLE IF NOT EXISTS handovers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
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

-- 合同条款模板：条款合同创建时套用，自动填充甲乙方
CREATE TABLE IF NOT EXISTS contract_templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  category   TEXT,
  summary    TEXT,
  clauses    TEXT NOT NULL DEFAULT '[]',   -- JSON: [{title, body}]
  builtin    INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 报价单发送记录：邮件 / 短信，逐条留痕
CREATE TABLE IF NOT EXISTS quote_sends (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL,              -- email | sms
  target       TEXT NOT NULL,
  subject      TEXT,
  content      TEXT,
  status       TEXT NOT NULL,              -- sent | simulated | failed
  provider     TEXT,
  error        TEXT,
  link         TEXT,
  sent_by      INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qsend_quote ON quote_sends(quotation_id);

-- 外部系统接入：线索 API 客户端
-- 只存密钥哈希，明文密钥仅在「开通 / 重置」时返回一次
CREATE TABLE IF NOT EXISTS api_clients (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,                 -- 接入方名称，如「官网表单」「企业微信」
  client_id    TEXT NOT NULL UNIQUE,          -- 公开标识 ak_xxxx，日志里用来认人
  key_prefix   TEXT NOT NULL,                 -- crm_ab12cd，列表里给人看的前缀
  key_hash     TEXT NOT NULL,                 -- sha256(完整密钥)
  status       TEXT NOT NULL DEFAULT 'active',-- active | disabled
  scopes       TEXT NOT NULL DEFAULT '["lead:read","lead:write"]',
  ip_whitelist TEXT NOT NULL DEFAULT '',      -- 逗号/换行分隔，支持 1.2.3.4 / 10.0.0.0/8 / 192.168.*.*
  rate_limit   INTEGER NOT NULL DEFAULT 60,   -- 每分钟请求上限，0 = 不限
  daily_quota  INTEGER NOT NULL DEFAULT 5000, -- 每日调用上限，0 = 不限
  expire_at    TEXT,                          -- 授权到期日 YYYY-MM-DD
  org_id       INTEGER REFERENCES org_units(id),
  owner_id     INTEGER REFERENCES users(id),  -- 新线索的默认负责人
  remark       TEXT,
  created_by   INTEGER,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  last_ip      TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_apic_status ON api_clients(status);

-- 外部调用留痕：调试面板与审计共用，也是日配额的计数依据
CREATE TABLE IF NOT EXISTS api_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   INTEGER,                        -- api_clients.id
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
`;

/** 给已有库补列（SQLite 的 ADD COLUMN 很轻，重复执行安全） */
function addColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function migrate() {
  db.exec(SCHEMA);
  // 2.1：审批人可单独设置能批的折扣上限，覆盖角色默认值
  addColumn('users', 'discount_limit', 'REAL');
  // 2.1：报价单标记是否含产品库外的例外项，便于报表统计
  addColumn('quotations', 'has_custom', 'INTEGER NOT NULL DEFAULT 0');

  // 2.3：组织层级（1 集团 / 2 公司 / 3 部门 / 4 团队），由 path 深度回填
  addColumn('org_units', 'level', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`UPDATE org_units SET level = (length(path) - length(replace(path, '/', ''))) - 1
           WHERE level = 0 OR level IS NULL`);

  // 2.3：离职交接（status 扩展为 active | disabled | leaving | left）
  addColumn('users', 'left_at', 'TEXT');
  addColumn('users', 'left_reason', 'TEXT');
  addColumn('users', 'handover_to', 'INTEGER');
  addColumn('users', 'handover_at', 'TEXT');

  // 2.4：合同分两类——订单合同（发票式单据）/ 条款合同（模板条款）
  addColumn('contracts', 'kind', "TEXT NOT NULL DEFAULT 'order'");
  addColumn('contracts', 'tax_mode', "TEXT NOT NULL DEFAULT 'included'");   // included 含税 / excluded 不含税
  addColumn('contracts', 'buyer_json', 'TEXT');
  addColumn('contracts', 'seller_json', 'TEXT');
  addColumn('contracts', 'items_json', 'TEXT');
  addColumn('contracts', 'clauses_json', 'TEXT');
  addColumn('contracts', 'template_id', 'INTEGER');
  addColumn('contracts', 'discount_rate', 'REAL NOT NULL DEFAULT 0');

  // 2.4：报价单公开链接与发送统计
  addColumn('quotations', 'public_token', 'TEXT');
  addColumn('quotations', 'last_sent_at', 'TEXT');
  addColumn('quotations', 'send_count', 'INTEGER NOT NULL DEFAULT 0');

  // 2.8：外部系统通过 API 写入线索时的外部单号，用于幂等去重
  addColumn('leads', 'external_id', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_external ON leads(external_id) WHERE external_id IS NOT NULL');

  seedTemplates();
}

/** 内置条款模板：只在表为空时写入，不覆盖用户自建模板 */
function seedTemplates() {
  const n = db.prepare('select count(*) c from contract_templates').get().c;
  if (n > 0) return;
  const at = new Date().toISOString();
  const rows = [
    {
      code: 'TPL-SVC', name: '软件实施服务合同', category: '服务',
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
      code: 'TPL-PROD', name: '产品采购合同', category: '采购',
      summary: '标准软硬件产品买卖，含交付、质保与结算条款',
      clauses: [
        { title: '第一条 标的与规格', body: '甲方向乙方采购的产品名称、规格型号、数量及单价详见合同附件《产品清单》，附件与本合同具有同等法律效力。' },
        { title: '第二条 价格与结算', body: '本合同价税合计人民币 {{amount}} 元，甲方应于收货后 {{payment_terms}} 天内支付全部款项。' },
        { title: '第三条 交付', body: '乙方于合同生效后 10 个工作日内将货物送达甲方指定地点 {{buyer.address}}，运输费用由乙方承担。' },
        { title: '第四条 质保', body: '产品自验收合格之日起质保 12 个月，质保期内因产品质量问题导致的故障，乙方免费维修或更换。' },
        { title: '第五条 违约责任', body: '甲方逾期付款的，每日按逾期金额的万分之五支付违约金；乙方逾期交付的，每日按合同总额的万分之五支付违约金。' },
        { title: '第六条 争议解决', body: '双方因履行本合同发生争议，应协商解决；协商不成的，提交合同签订地人民法院诉讼解决。' },
      ],
    },
    {
      code: 'TPL-NDA', name: '保密协议（NDA）', category: '法务',
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
  const stmt = db.prepare(
    `insert into contract_templates(code,name,category,summary,clauses,builtin,status,created_at,updated_at)
     values(?,?,?,?,?,1,'active',?,?)`
  );
  for (const r of rows) stmt.run(r.code, r.name, r.category, r.summary, JSON.stringify(r.clauses), at, at);
}
