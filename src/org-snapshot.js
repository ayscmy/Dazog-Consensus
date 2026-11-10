import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * 组织快照契约（纯逻辑，不碰数据库）
 *
 * 官网 / CRM / CLI 三处共用同一份格式定义。快照里只放「业务数据」，
 * 用户与组织不迁移：导入时统一挂到目标实例的根组织与管理员名下（见 org-transfer.js）。
 *
 * 契约要点：
 *   - checksum 覆盖 format / version / orgId / 全部表数据，按固定表序规范化，
 *     不受对象键顺序影响，可跨语言复算，能防传输或落盘篡改。
 *   - seal/unseal 用 AES-256-GCM 加密落盘（key = sha256(passphrase)），明文快照只存在于内存。
 *   - api_clients 是官网签发的名录对接凭据，与实例绑定，不随组织业务数据迁移；
 *     独立实例如需对接名录，由官网重新签发（避免出现两个实例共用同一 token）。
 */

export const SNAPSHOT_FORMAT = 'mserm-org-snapshot';
export const SNAPSHOT_VERSION = 1;

/** 直接按 org_id 过滤的业务表 */
export const ORG_TABLES = [
  'accounts', 'approvals', 'contracts', 'leads',
  'opportunities', 'pool_events', 'products', 'quotations', 'targets',
];

/**
 * 按父表导出行的 id 集合过滤。
 * 只走「主键路径」：早期版本用 contract_id OR account_id 会把别的组织挂在同一客户下的
 * 回款一起带出来，破坏租户隔离；现在统一以组织内主表为边界向内收敛。
 */
export const FK_RULES = {
  contacts: [['account_id', 'accounts']],
  quotation_items: [['quotation_id', 'quotations']],
  quote_sends: [['quotation_id', 'quotations']],
  payment_plans: [['contract_id', 'contracts']],
  invoices: [['contract_id', 'contracts']],
  payments: [['contract_id', 'contracts']],
  payment_allocations: [['payment_id', 'payments']],
  approval_steps: [['approval_id', 'approvals']],
};

/** 按源组织用户 id 集合过滤（用户本身不进快照） */
export const USER_RULES = {
  activities: ['user_id'],
  attachments: ['uploaded_by'],
  audit_logs: ['user_id'],
  handovers: ['user_id'],
};

/** 固定表序：checksum 规范化与导入顺序都以此为准 */
export const TABLE_ORDER = [
  'accounts', 'leads', 'opportunities', 'products', 'quotations',
  'quotation_items', 'quote_sends', 'contracts', 'payment_plans', 'invoices',
  'payments', 'payment_allocations', 'approvals', 'approval_steps', 'contacts',
  'pool_events', 'targets', 'activities', 'attachments', 'audit_logs', 'handovers',
];

/** 导入时需要重映射到目标管理员的用户引用列（导入时还会按外键元数据动态补集） */
export const USER_REF_COLS = new Set([
  'owner_id', 'created_by', 'user_id', 'applicant_id', 'apply_by', 'uploaded_by',
  'actor_id', 'from_owner', 'to_owner', 'approver_id', 'sent_by', 'to_user_id',
  'handover_to', 'left_to',
]);

/**
 * 导入时按「重映射后的键」去重，避免 UNIQUE 约束冲突。
 * targets 有 UNIQUE(user_id, period)：源组织多个用户在同一 period 各有目标，
 * 重映射后 user_id 会合并成同一个管理员，不去重会直接违反唯一约束。
 */
export const DEDUP_KEYS = {
  targets: ['user_id', 'period'],
};

/** 不进快照的表（平台层 / 会话 / 全局配置 / 集成凭据 / 日志） */
export const EXCLUDED_TABLES = [
  'org_units', 'users', 'user_roles', 'sessions', 'settings', 'tenants',
  'trial_accounts', 'api_logs', 'contract_templates', 'api_clients',
];

export function canonicalTables(tables) {
  return JSON.stringify(TABLE_ORDER.map((t) => [t, (tables && tables[t]) || []]));
}

export function checksumOf(snap) {
  const payload = JSON.stringify({
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    orgId: Number(snap?.source?.orgId || 0),
    data: canonicalTables(snap?.tables),
  });
  return createHash('sha256').update(payload).digest('hex');
}

/** 校验快照完整性与校验和，返回快照（不修改入参） */
export function assertSnapshot(snap) {
  if (!snap || typeof snap !== 'object') throw new Error('快照不是对象');
  if (snap.format !== SNAPSHOT_FORMAT) throw new Error(`快照格式不匹配：${snap.format}`);
  if (Number(snap.version) !== SNAPSHOT_VERSION) throw new Error(`快照版本不支持：${snap.version}`);
  if (!snap.tables || typeof snap.tables !== 'object') throw new Error('快照缺少 tables');
  for (const t of TABLE_ORDER) {
    if (!Array.isArray(snap.tables[t])) throw new Error(`快照缺少表数据：${t}`);
  }
  const expect = checksumOf(snap);
  if (String(snap.checksum || '') !== expect) throw new Error('快照校验和不匹配（可能被篡改或版本不一致）');
  return snap;
}

export function seal(snap, passphrase) {
  const key = createHash('sha256').update(String(passphrase || '')).digest();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(snap), 'utf8'), c.final()]);
  return {
    format: SNAPSHOT_FORMAT,
    enc: 1,
    iv: iv.toString('base64url'),
    tag: c.getAuthTag().toString('base64url'),
    data: enc.toString('base64url'),
  };
}

export function unseal(wrapped, passphrase) {
  if (!wrapped || wrapped.enc !== 1 || wrapped.format !== SNAPSHOT_FORMAT) {
    throw new Error('不是受支持的加密快照');
  }
  const key = createHash('sha256').update(String(passphrase || '')).digest();
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(wrapped.iv, 'base64url'));
  d.setAuthTag(Buffer.from(wrapped.tag, 'base64url'));
  const plain = Buffer.concat([d.update(Buffer.from(wrapped.data, 'base64url')), d.final()]).toString('utf8');
  return JSON.parse(plain);
}

/** 从文件读取（自动识别明文 / 加密），返回校验通过的快照 */
export function readSnapshotFile(obj, passphrase) {
  const snap = obj && obj.enc === 1 ? unseal(obj, passphrase) : obj;
  return assertSnapshot(snap);
}

export function countRows(snap) {
  return TABLE_ORDER.reduce((n, t) => n + ((snap.tables[t] || []).length), 0);
}
