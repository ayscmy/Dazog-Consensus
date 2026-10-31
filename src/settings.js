import { all, one, run, nowIso } from './db.js';

/**
 * 系统设置
 * 这里集中放"业务规则开关"，让审批阈值、例外报价这类规则可配，而不是写死在代码里。
 */
export const DEFAULTS = {
  // 折扣审批阈值（百分比）：≤manager 只需经理；>manager 加总监；>director 加总经理
  'approve.discount.manager': '5',
  'approve.discount.director': '10',
  'approve.discount.gm': '100',
  // 零折扣免价格审批：未让价（折扣率 0）的报价不走价格审批，直接进入合同流程
  'quote.skip_approval_when_no_discount': '1',
  // 例外报价：不走产品库的报价项
  'quote.allow_custom': '1',
  'quote.custom_roles': 'admin,gm,director,manager',
  // 合同审批阈值
  'approve.contract.amount_director': '500000',
  'approve.contract.terms_director': '30',
  'approve.contract.amount_legal': '1000000',
  'approve.contract.terms_legal': '60',
  // 附件
  'attachment.max_size': '1048576',
  'attachment.allowed': 'pdf,doc,docx,xls,xlsx,ppt,pptx,txt,md,csv,png,jpg,jpeg,webp,gif',
  // 报价有效期默认天数
  'quote.valid_days': '30',
  // 报价单底部说明
  'quote.sheet_note': '1. 本报价单在有效期内有效，逾期需重新确认；\n2. 报价含 6% 增值税，特殊税点以正式合同为准；\n3. 付款方式、交付周期以双方签订的合同为准；\n4. 报价明细中的产品配置与技术方案详见附件。',
  // 公司抬头：合同甲乙方、报价单抬头、发票式单据的销售方
  'company.name': '上海铭世智能科技有限公司',
  'company.short_name': '铭世智能',
  'company.tax_no': '91310115MA1K4X8L2T',
  'company.address': '上海市浦东新区张江高科技园区科苑路 88 号 3 号楼 6 层',
  'company.phone': '021-5888 6600',
  'company.bank': '招商银行上海张江支行',
  'company.account': '1219 6688 9010 601',
  'company.legal_person': '陈立',
  // 对外访问地址（发邮件/短信里的报价单链接），留空则按当前请求域名拼
  'site.public_url': '',
  // 邮件发送（SMTP）
  'mail.enabled': '0',
  'mail.host': '',
  'mail.port': '465',
  'mail.secure': '1',
  'mail.user': '',
  'mail.pass': '',
  'mail.from': '',
  'mail.from_name': '铭世智能 销售部',
  // 短信发送（HTTP 网关，POST JSON：{phone, content, sign, token}）
  'sms.enabled': '0',
  'sms.gateway': '',
  'sms.token': '',
  'sms.sign': '【铭世智能】',
  'sms.template': '您好，{{company}} 已为您生成报价单 {{no}}，金额 {{amount}} 元，有效期至 {{valid_until}}。查看：{{link}}'
};
export const SETTING_LABELS = [{
  group: '折扣审批阈值',
  desc: '只对「让价」审批：折扣率为 0 的报价默认免价格审批，直接进入合同流程；有折扣才按下表生成审批链。',
  items: [{
    key: 'approve.discount.manager',
    label: '部门经理可批折扣',
    type: 'percent',
    hint: '≤ 该值只需经理审批'
  }, {
    key: 'approve.discount.director',
    label: '销售总监可批折扣',
    type: 'percent',
    hint: '≤ 该值需经理+总监，超过再加总经理'
  }, {
    key: 'quote.skip_approval_when_no_discount',
    label: '未折扣报价免价格审批',
    type: 'switch',
    hint: '开启后，折扣率为 0 的报价提交即通过，直接进入合同审批流程'
  }]
}, {
  group: '例外报价（产品库外）',
  desc: '默认所有报价必须从产品库选择。如需录入非标准方案，在这里开启并指定可用角色。',
  items: [{
    key: 'quote.allow_custom',
    label: '允许例外报价项',
    type: 'switch',
    hint: '关闭后，报价只能选择产品库中的产品'
  }, {
    key: 'quote.custom_roles',
    label: '可录入例外项的角色',
    type: 'roles',
    hint: '多选，逗号分隔'
  }]
}, {
  group: '合同审批阈值',
  desc: '合同金额或账期超过阈值时，自动增加对应审批节点。',
  items: [{
    key: 'approve.contract.amount_director',
    label: '加总监审批的合同金额',
    type: 'money',
    hint: '元，超过即需总监'
  }, {
    key: 'approve.contract.terms_director',
    label: '加总监审批的账期',
    type: 'number',
    hint: '天，超过即需总监'
  }, {
    key: 'approve.contract.amount_legal',
    label: '加法务审核的合同金额',
    type: 'money',
    hint: '元，超过即需法务'
  }, {
    key: 'approve.contract.terms_legal',
    label: '加法务审核的账期',
    type: 'number',
    hint: '天，超过即需法务'
  }]
}, {
  group: '附件与报价',
  desc: '上传限制与默认有效期。',
  items: [{
    key: 'attachment.max_size',
    label: '单个附件上限',
    type: 'bytes',
    hint: '字节，默认 1 MB'
  }, {
    key: 'attachment.allowed',
    label: '允许的文件类型',
    type: 'text',
    hint: '扩展名，逗号分隔'
  }, {
    key: 'quote.valid_days',
    label: '报价默认有效期',
    type: 'number',
    hint: '天'
  }, {
    key: 'quote.sheet_note',
    label: '报价单说明',
    type: 'textarea',
    hint: '打印版报价单底部的说明文字'
  }]
}, {
  group: '公司抬头（合同 / 报价单）',
  desc: '订单合同的销售方、条款合同的乙方、报价单抬头都取这里的资料，自动填充。',
  items: [{
    key: 'company.name',
    label: '公司全称',
    type: 'text'
  }, {
    key: 'company.short_name',
    label: '公司简称',
    type: 'text'
  }, {
    key: 'company.tax_no',
    label: '纳税人识别号',
    type: 'text'
  }, {
    key: 'company.address',
    label: '注册地址',
    type: 'text'
  }, {
    key: 'company.phone',
    label: '联系电话',
    type: 'text'
  }, {
    key: 'company.bank',
    label: '开户银行',
    type: 'text'
  }, {
    key: 'company.account',
    label: '银行账号',
    type: 'text'
  }, {
    key: 'company.legal_person',
    label: '法定代表人',
    type: 'text'
  }, {
    key: 'site.public_url',
    label: '对外访问地址',
    type: 'text',
    hint: '例如 https://crm.xxx.com，用于报价单链接；留空自动取当前域名'
  }]
}, {
  group: '邮件发送（SMTP）',
  desc: '配置后，报价单可以直接发到客户邮箱；未配置时系统会生成报价单链接并记录为「模拟发送」。',
  items: [{
    key: 'mail.enabled',
    label: '启用邮件发送',
    type: 'switch'
  }, {
    key: 'mail.host',
    label: 'SMTP 服务器',
    type: 'text',
    hint: '例如 smtp.exmail.qq.com'
  }, {
    key: 'mail.port',
    label: '端口',
    type: 'number',
    hint: 'SSL 一般 465，STARTTLS 一般 587'
  }, {
    key: 'mail.secure',
    label: '使用 SSL/TLS',
    type: 'switch',
    hint: '465 端口开启；587 端口关闭后走 STARTTLS'
  }, {
    key: 'mail.user',
    label: '发件账号',
    type: 'text'
  }, {
    key: 'mail.pass',
    label: '授权码 / 密码',
    type: 'password'
  }, {
    key: 'mail.from',
    label: '发件地址',
    type: 'text',
    hint: '留空则用发件账号'
  }, {
    key: 'mail.from_name',
    label: '发件人显示名',
    type: 'text'
  }]
}, {
  group: '短信发送（HTTP 网关）',
  desc: '对接企业短信网关：系统向网关 POST JSON（phone / content / sign / token），返回 2xx 视为成功。未配置时记录为「模拟发送」。',
  items: [{
    key: 'sms.enabled',
    label: '启用短信发送',
    type: 'switch'
  }, {
    key: 'sms.gateway',
    label: '网关地址',
    type: 'text',
    hint: '例如 https://sms.example.com/api/send'
  }, {
    key: 'sms.token',
    label: '网关鉴权 Token',
    type: 'password'
  }, {
    key: 'sms.sign',
    label: '短信签名',
    type: 'text'
  }, {
    key: 'sms.template',
    label: '短信模板',
    type: 'textarea',
    hint: '可用变量：{{company}} {{no}} {{amount}} {{valid_until}} {{link}}'
  }]
}];
export async function getSetting(key) {
  const row = await one('select value from settings where key = ?', key);
  if (row && row.value !== null) return row.value;
  return DEFAULTS[key] ?? null;
}
export async function getSettingNum(key) {
  const v = Number(await getSetting(key));
  return Number.isFinite(v) ? v : Number(DEFAULTS[key] || 0);
}
export async function setSetting(key, value) {
  await run(`insert into settings(key, value, updated_at) values(?,?,?)
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`, key, value === null || value === undefined ? null : String(value), nowIso());
}
export async function getSettings() {
  const rows = await all('select key, value from settings');
  const map = {
    ...DEFAULTS
  };
  rows.forEach(r => {
    if (r.value !== null) map[r.key] = r.value;
  });
  return map;
}

/** 当前用户是否允许录入产品库之外的例外报价项 */
export async function canUseCustomItem(user) {
  if ((await getSetting('quote.allow_custom')) !== '1') return false;
  const roles = String((await getSetting('quote.custom_roles')) || '').split(',').map(s => s.trim()).filter(Boolean);
  if (roles.includes('*')) return true;
  return roles.includes(user.role);
}
export const MAX_ATTACHMENT = async () => (await getSettingNum('attachment.max_size')) || 1024 * 1024;
export async function attachmentAllowed(mime, name) {
  const list = String((await getSetting('attachment.allowed')) || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (list.includes(ext)) return true;
  // 图片按 mime 兜底放行
  return /^image\//.test(String(mime || ''));
}

/** 我方公司抬头：合同销售方 / 乙方，报价单抬头 */
export async function companyProfile() {
  return {
    name: (await getSetting('company.name')) || '',
    shortName: (await getSetting('company.short_name')) || '',
    taxNo: (await getSetting('company.tax_no')) || '',
    address: (await getSetting('company.address')) || '',
    phone: (await getSetting('company.phone')) || '',
    bank: (await getSetting('company.bank')) || '',
    account: (await getSetting('company.account')) || '',
    legalPerson: (await getSetting('company.legal_person')) || ''
  };
}

/** 开关型设置 */
export const isOn = async key => String((await getSetting(key)) ?? '') === '1';