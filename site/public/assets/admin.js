const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const fmtSize = (n) => {
  const v = Number(n || 0);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
};
const p2 = (n) => String(n).padStart(2, '0');
const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
const fmtDay = (iso) => (iso ? fmtTime(iso).slice(0, 10) : '—');

let data = null;

async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      location.replace('/login.html?next=/admin.html');
      throw new Error('未登录');
    }
    if (res.status === 403) {
      throw new Error(body.error || '需要管理员权限');
    }
    throw new Error(body.error || `请求失败（${res.status}）`);
  }
  return body;
}

async function load() {
  try {
    const me = await api('/api/auth/me');
    $('who').textContent = me.member?.name || me.member?.email || '';
    $('avatar').textContent = (me.member?.name || 'A').slice(0, 1).toUpperCase();
    data = await api('/api/admin/overview');
    render();
  } catch (err) {
    $('stats').innerHTML = `<div class="empty" style="grid-column:1/-1"><b>无法加载后台数据</b>${esc(err.message)}</div>`;
  }
}

function render() {
  const s = data.stats || {};
  $('stats').innerHTML = [
    ['会员总数', s.members ?? 0],
    ['正常账号', s.active ?? 0],
    ['近 7 日新增', s.new7 ?? 0],
    ['累计下载', s.downloads ?? 0],
    ['近 7 日下载', s.down7 ?? 0],
    ['已发布版本', s.versions ?? 0],
  ].map(([label, val]) => `<div class="stat"><b>${val}</b><span>${label}</span></div>`).join('');

  renderVersions();
  renderMembers();
  renderDownloads();
  renderEvents();
  renderFiles();
}

function renderVersions() {
  const rows = data.versions || [];
  $('verRows').innerHTML = rows.length
    ? rows.map((v) => `
      <tr>
        <td class="mono strong">${esc(v.version)} ${v.channel === 'beta' ? '<span class="badge warn">beta</span>' : ''}</td>
        <td class="mono">${esc(v.fileName || '—')}</td>
        <td>${fmtSize(v.size)}</td>
        <td>${fmtDay(v.releasedAt)}</td>
        <td>${v.downloads || 0}</td>
        <td>${v.status === 'published' ? '<span class="badge ok">已发布</span>' : '<span class="badge">草稿</span>'}</td>
        <td style="text-align:right">
          <button class="btn btn-outline" style="height:28px;font-size:12px;padding:0 10px"
            data-toggle="${esc(v.version)}" data-status="${v.status === 'published' ? 'draft' : 'published'}">
            ${v.status === 'published' ? '下线' : '发布'}
          </button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="empty">还没有登记版本，先上传一个安装包</td></tr>';

  $('verRows').onclick = async (e) => {
    const btn = e.target.closest('[data-toggle]');
    if (!btn) return;
    const v = (data.versions || []).find((x) => x.version === btn.dataset.toggle);
    if (!v) return;
    btn.disabled = true;
    try {
      await api('/api/admin/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: v.version, fileName: v.fileName, title: v.title,
          notes: v.notes, channel: v.channel, status: btn.dataset.status,
        }),
      });
      await load();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  };
}

function renderMembers() {
  const q = ($('memberSearch').value || '').trim().toLowerCase();
  const rows = (data.members || []).filter((m) =>
    !q || String(m.email).toLowerCase().includes(q) || String(m.company || '').toLowerCase().includes(q)
    || String(m.name || '').toLowerCase().includes(q));

  $('memberRows').innerHTML = rows.length
    ? rows.map((m) => `
      <tr>
        <td class="strong">${esc(m.email)}${m.email_verified ? '' : ' <span class="badge warn">未验证</span>'}</td>
        <td>${esc(m.name)}</td>
        <td>${esc(m.company || '—')}</td>
        <td>${fmtDay(m.created_at)}</td>
        <td>${m.downloads || 0}</td>
        <td>${m.last_login_at ? fmtTime(m.last_login_at) : '—'}</td>
        <td>${m.status === 'active' ? '<span class="badge ok">正常</span>' : '<span class="badge bad">已停用</span>'}</td>
        <td style="text-align:right">
          ${m.role === 'admin' ? '<span class="badge brand">管理员</span>' : `
          <button class="btn btn-outline" style="height:28px;font-size:12px;padding:0 10px"
            data-member="${m.id}" data-status="${m.status === 'active' ? 'disabled' : 'active'}">
            ${m.status === 'active' ? '停用' : '启用'}
          </button>`}
        </td>
      </tr>`).join('')
    : '<tr><td colspan="8" class="empty">没有匹配的会员</td></tr>';
}

$('memberSearch').oninput = () => renderMembers();

$('memberRows').onclick = async (e) => {
  const btn = e.target.closest('[data-member]');
  if (!btn) return;
  const label = btn.textContent.trim();
  if (label === '停用' && !confirm('停用后该会员会立即退出登录并失去下载权限，确定吗？')) return;
  btn.disabled = true;
  try {
    await api(`/api/admin/members/${btn.dataset.member}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: btn.dataset.status }),
    });
    await load();
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
  }
};

function renderDownloads() {
  const rows = data.downloads || [];
  $('dlRows').innerHTML = rows.length
    ? rows.map((r) => `<tr>
        <td>${fmtTime(r.created_at)}</td>
        <td class="strong">${esc(r.email)}</td>
        <td>${esc(r.company || '—')}</td>
        <td class="mono">${esc(r.version)}</td>
        <td class="mono">${esc(r.ip || '—')}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty">还没有下载记录</td></tr>';
}

const EVENT_LABEL = {
  signup: '注册', login: '登录', download: '下载', password: '改密',
  'version.publish': '发布版本', 'version.upload': '上传安装包',
  'member.status': '会员状态', boot: '服务启动',
};

function renderEvents() {
  const rows = data.events || [];
  $('eventRows').innerHTML = rows.length
    ? rows.map((r) => `<tr>
        <td>${fmtTime(r.created_at)}</td>
        <td><span class="badge">${esc(EVENT_LABEL[r.kind] || r.kind)}</span></td>
        <td>${esc(r.detail || '')}</td>
        <td class="mono">${esc(r.ip || '—')}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="empty">暂无日志</td></tr>';
}

function renderFiles() {
  const files = data.files || [];
  const sel = $('vExisting');
  sel.innerHTML = '<option value="">— release 目录 —</option>' + files.map((f) =>
    `<option value="${esc(f.fileName)}">${esc(f.fileName)} · ${esc(f.sizeText)}${f.registered ? '（已登记）' : ''}</option>`
  ).join('');
}

/* 上传 + 登记 */
$('pubForm').onsubmit = async (e) => {
  e.preventDefault();
  const box = $('pubMsg');
  box.className = 'form-msg';
  const btn = $('pubBtn');

  const version = $('vVersion').value.trim();
  const title = $('vTitle').value.trim();
  const notes = $('vNotes').value;
  const channel = $('vChannel').value;
  const status = $('vStatus').value;
  const fileInput = $('vFile');
  const picked = fileInput.files?.[0];

  if (!/^\d+\.\d+\.\d+([\w.-]*)?$/.test(version)) {
    box.textContent = '版本号格式应为 1.2.3';
    box.className = 'form-msg show err';
    return;
  }

  const fileName = picked ? picked.name : $('vExisting').value;
  if (!fileName) {
    box.textContent = '请选择要上传的文件，或从 release 目录中选择一个';
    box.className = 'form-msg show err';
    return;
  }

  btn.disabled = true;
  try {
    if (picked) {
      btn.textContent = '上传中…';
      await api(`/api/admin/upload?name=${encodeURIComponent(picked.name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: picked,
      });
    }
    btn.textContent = '登记版本…';
    await api('/api/admin/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, title, notes, fileName, channel, status }),
    });
    box.textContent = `v${version} 已${status === 'published' ? '发布' : '存为草稿'}`;
    box.className = 'form-msg show ok';
    fileInput.value = '';
    $('vVersion').value = '';
    $('vTitle').value = '';
    $('vNotes').value = '';
    await load();
  } catch (err) {
    box.textContent = err.message;
    box.className = 'form-msg show err';
  } finally {
    btn.disabled = false;
    btn.textContent = '发布版本';
  }
};

/* 标签页 */
$('tabs').onclick = (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('on', p.id === `pane-${b.dataset.tab}`));
};

$('refresh').onclick = () => load();
$('logout').onclick = async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/';
};

load();
