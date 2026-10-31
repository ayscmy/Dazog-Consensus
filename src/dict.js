export const OPP_STAGES = [{
  key: 'lead_in',
  label: '线索接入',
  prob: 10,
  color: '#9aa0ad'
}, {
  key: 'needs',
  label: '需求确认',
  prob: 30,
  color: '#5b8def'
}, {
  key: 'proposal',
  label: '方案报价',
  prob: 50,
  color: '#3f6ee0'
}, {
  key: 'negotiation',
  label: '商务谈判',
  prob: 75,
  color: '#e0a53f'
}, {
  key: 'won',
  label: '赢单',
  prob: 100,
  color: '#2f9e6f'
}, {
  key: 'lost',
  label: '输单',
  prob: 0,
  color: '#c2554f'
}];
export const LEAD_STATUS = [{
  key: 'new',
  label: '待跟进',
  color: '#9aa0ad'
}, {
  key: 'contacted',
  label: '跟进中',
  color: '#5b8def'
}, {
  key: 'qualified',
  label: '已确认商机',
  color: '#e0a53f'
}, {
  key: 'converted',
  label: '已转商机',
  color: '#2f9e6f'
}, {
  key: 'invalid',
  label: '无效',
  color: '#c2554f'
}];
export const QUOTE_STATUS = [{
  key: 'draft',
  label: '草稿'
}, {
  key: 'pending',
  label: '审批中'
}, {
  key: 'approved',
  label: '已批准'
}, {
  key: 'rejected',
  label: '已驳回'
}, {
  key: 'converted',
  label: '已转合同'
}, {
  key: 'expired',
  label: '已过期'
}];
export const CONTRACT_STATUS = [{
  key: 'draft',
  label: '草稿'
}, {
  key: 'sales_review',
  label: '销售审批'
}, {
  key: 'finance_review',
  label: '财务审核'
}, {
  key: 'legal_review',
  label: '法务审核'
}, {
  key: 'active',
  label: '已生效'
}, {
  key: 'rejected',
  label: '已驳回'
}, {
  key: 'completed',
  label: '已完结'
}, {
  key: 'terminated',
  label: '已终止'
}];
export const INVOICE_STATUS = [{
  key: 'applied',
  label: '待开票'
}, {
  key: 'issued',
  label: '已开票'
}, {
  key: 'void',
  label: '已作废'
}];
export const DICT = {
  industries: ['装备制造', '电子制造', '物流运输', '互联网', '建筑工程', '医药制造', '新能源', '新材料', '纺织服装', '金属加工', '家电制造', '模具制造', '化工', '食品饮料', '医疗器械', '生物医药', '冷链物流', '重型机械', '电气制造', '家居制造', '船舶制造'],
  regions: ['华东', '华南', '华北', '华中', '西南', '西北', '东北'],
  sources: ['官网', '展会', '转介绍', '电话开发', '广告', '渠道', '老客户'],
  scales: ['20万以下', '20-50万', '50-100万', '100-200万', '200万以上'],
  accountScales: ['1-50人', '50-100人', '100-500人', '500-1000人', '1000人以上'],
  customerLevels: ['A', 'B', 'C'],
  creditLevels: ['AAA', 'AA', 'A', 'B'],
  contactRoles: [{
    key: 'decision',
    label: '决策人'
  }, {
    key: 'influencer',
    label: '影响者'
  }, {
    key: 'user',
    label: '使用者'
  }, {
    key: 'gatekeeper',
    label: '把关人'
  }],
  oppStages: OPP_STAGES,
  leadStatus: LEAD_STATUS,
  quoteStatus: QUOTE_STATUS,
  contractStatus: CONTRACT_STATUS,
  invoiceStatus: INVOICE_STATUS,
  activityTypes: [{
    key: 'call',
    label: '电话'
  }, {
    key: 'visit',
    label: '拜访'
  }, {
    key: 'email',
    label: '邮件'
  }, {
    key: 'meeting',
    label: '会议'
  }, {
    key: 'note',
    label: '备注'
  }],
  paymentMethods: [{
    key: 'transfer',
    label: '电汇'
  }, {
    key: 'check',
    label: '支票'
  }, {
    key: 'cash',
    label: '现金'
  }]
};
export const labelOf = (list, key) => (list.find(x => x.key === key) || {}).label || key || '';