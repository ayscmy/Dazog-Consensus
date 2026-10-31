export const state = {
  user: null,
  orgs: [],
  users: [],
  dict: {},
  pending: 0,
  route: { view: 'dashboard', id: null, query: {} },
};

export function setBootstrap(data) {
  state.user = data.user;
  state.orgs = data.orgs || [];
  state.users = data.users || [];
  state.dict = data.dict || {};
  state.pending = data.pending || 0;
  buildLabels();
}

export const labels = {};

function buildLabels() {
  const d = state.dict;
  const maps = {
    oppStage: d.oppStages,
    leadStatus: d.leadStatus,
    quoteStatus: d.quoteStatus,
    contractStatus: d.contractStatus,
    invoiceStatus: d.invoiceStatus,
    contactRole: d.contactRoles,
    activityType: d.activityTypes,
    paymentMethod: d.paymentMethods,
  };
  for (const [k, list] of Object.entries(maps)) {
    labels[k] = Object.fromEntries((list || []).map((x) => [x.key, x.label]));
  }
}

export function orgName(id) {
  return (state.orgs.find((o) => o.id === id) || {}).name || '';
}

export function userName(id) {
  return (state.users.find((u) => u.id === id) || {}).name || '—';
}

export function can(module) {
  const m = state.user?.modules || [];
  return m.includes('*') || m.includes(module);
}

export function isManager() {
  return ['admin', 'gm', 'director', 'manager'].includes(state.user?.role);
}
