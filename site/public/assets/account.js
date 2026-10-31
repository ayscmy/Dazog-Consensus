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
const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

let state = null;

function msg(id, text, kind = 'err') {
  const el = $(id);
  el.textContent = text;
  el.className = `form-msg show ${kind}`;
}
function clearMsg(id) { $(id).className = 'form-msg'; }

async function load() {
  const res = await fetch('/api/auth/me');
  if (res.status === 401) {
    location.replace('/login.html?next=/account.html');
    return null;
  }
  const d = await res.json();
  if (!d.member) {
    location.replace('/login.html?next=/account.html');
    return null;
  }
  state = d;
  render(d);
  return d;
}

function render(d) {
  const m = d.member;
  $('avatar').textContent = (m.name || m.email || '?').slice(0, 1).toUpperCase();
  $('who').textContent = m.name;
  $('hello').textContent = `你好，${m.name}`;
  $('pName').value = m.name || '';
  $('pCompany').value = m.company || '';
  $('pPhone').value = m.phone || '';
  $('pEmail').value = m.email;
  if (m.role === 'admin') $('adminLink').style.display = '';

  const versions = d.versions || [];
  const latest = versions[0];

  if (latest) {
    $('lv').textContent = `最新版本 v${latest.version}${latest.channel === 'beta' ? ' · beta' : ''}`;
    $('lvTitle').textContent = latest.title || `MSERM CRM ${latest.version}`;
    $('lvDesc').textContent = latest.notes
      ? latest.notes.split('\n')[0]
      : '完整演示数据：组织架构、产品库、客户、商机、报价、合同、发票与回款。';
    $('lvMeta').innerHTML = [
      `<span>${fmtSize(latest.size)}</span>`,
      `<span>发布于 ${fmtTime(latest.releasedAt).slice(0, 10)}</span>`,
      latest.sha256 ? `<span>SHA256 ${esc(latest.sha256.slice(0, 12))}…</span>` : '',
      `<span>累计下载 ${latest.downloads || 0}</span>`,
    ].filter(Boolean).join('');
    const btn = $('dlBtn');
    btn.href = `/api/download/${latest.id}`;
    btn.textContent = '下载安装包';
    btn.onclick = () => setTimeout(refresh, 2200);
  } else {
    $('lv').textContent = '暂无版本';
    $('lvTitle').textContent = '管理员还没有发布安装包';
    $('lvDesc').textContent = '可以先从 Gitee 获取源码，用安装向导创建空库。';
    $('lvMeta').innerHTML = '';
    $('dlBtn').style.display = 'none';
  }

  // 版本列表（含最新，标注"当前最新"）
  $('versions').innerHTML = versions.length
    ? versions.map((v, i) => `
      <div class="ver-item">
        <div class="v-left">
          <b>v${esc(v.version)} ${v.channel === 'beta' ? '<span class="badge warn">beta</span>' : ''}</b>
          <span>${fmtTime(v.releasedAt).slice(0, 10)} · ${fmtSize(v.size)} · ${esc(v.title || '')}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          ${i === 0 ? '<span class="badge brand">最新</span>' : ''}
          <a class="btn btn-outline" href="/api/download/${v.id}">下载</a>
        </div>
      </div>`).join('')
    : '<div class="empty"><b>暂无可用版本</b>管理员发布后这里会出现下载入口</div>';

  // 下载记录
  const rows = d.downloads || [];
  $('dlRows').innerHTML = rows.length
    ? rows.map((r) => `<tr>
        <td class="mono">${esc(r.version)}</td>
        <td>${fmtTime(r.created_at)}</td>
        <td class="mono">${esc(r.ip || '—')}</td>
      </tr>`).join('')
    : '<tr><td colspan="3" class="empty">还没有下载记录</td></tr>';

  const q = d.quota || { used: 0, limit: 20 };
  const left = Math.max(0, q.limit - q.used);
  $('quota').textContent = `今日已下载 ${q.used} / ${q.limit} 次${left === 0 ? '，明日恢复' : ''}`;
  $('quota').style.color = left === 0 ? '#b42318' : '';
}

async function refresh() {
  const res = await fetch('/api/auth/me');
  if (!res.ok) return;
  const d = await res.json();
  if (d.member) { state = d; render(d); }
}

/* 资料 */
$('profileForm').onsubmit = async (e) => {
  e.preventDefault();
  clearMsg('profileMsg');
  const body = {
    name: $('pName').value.trim(),
    company: $('pCompany').value.trim(),
    phone: $('pPhone').value.trim(),
  };
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const res = await fetch('/api/my/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || '保存失败');
    msg('profileMsg', '资料已保存', 'ok');
    render(d);
  } catch (err) {
    msg('profileMsg', err.message);
  } finally {
    btn.disabled = false;
  }
};

/* 密码 */
$('pwdForm').onsubmit = async (e) => {
  e.preventDefault();
  clearMsg('pwdMsg');
  const oldPassword = $('oldPwd').value;
  const newPassword = $('newPwd').value;
  if (!oldPassword || !newPassword) return msg('pwdMsg', '请填写当前密码和新密码');
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const res = await fetch('/api/my/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword, newPassword }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || '修改失败');
    $('oldPwd').value = '';
    $('newPwd').value = '';
    msg('pwdMsg', '密码已更新，其他设备已退出', 'ok');
  } catch (err) {
    msg('pwdMsg', err.message);
  } finally {
    btn.disabled = false;
  }
};

$('logout').onclick = async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/';
};

// 仓库链接 + 欢迎提示
fetch('/api/meta').then((r) => r.json()).then((m) => {
  if (m.repo) $('repoLink').href = m.repo;
}).catch(() => {});

if (new URLSearchParams(location.search).get('welcome')) {
  const box = $('welcome');
  box.textContent = '注册成功，账号已激活。滚动到下方即可下载演示数据库。';
  box.className = 'form-msg show ok';
  history.replaceState(null, '', '/account.html');
}

load();
