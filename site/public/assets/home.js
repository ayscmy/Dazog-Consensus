const fmtDate = (iso) => (iso ? String(iso).slice(0, 10) : '');
const fmtSize = (n) => {
  const v = Number(n || 0);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// 导航滚动阴影
const nav = document.getElementById('nav');
const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

document.getElementById('year').textContent = new Date().getFullYear();

let signedIn = false;

async function init() {
  let meta = null;
  try {
    const [r1, r2] = await Promise.all([
      fetch('/api/meta').then((r) => r.json()),
      fetch('/api/auth/me').then((r) => r.json()).catch(() => ({ member: null })),
    ]);
    meta = r1;
    signedIn = Boolean(r2?.member);
  } catch {
    document.getElementById('dlVer').textContent = '版本信息加载失败';
    return;
  }

  if (meta?.repo) {
    document.querySelectorAll('[data-repo-link]').forEach((a) => { a.href = meta.repo; });
  }

  const versions = meta.versions || [];
  const latest = versions[0];
  const verInline = document.getElementById('verInline');
  if (latest) verInline.textContent = latest.version;

  const ver = document.getElementById('dlVer');
  const metaBox = document.getElementById('dlMeta');
  const notes = document.getElementById('dlNotes');
  const btn = document.getElementById('dlBtn');

  if (!latest) {
    ver.textContent = '尚未发布';
    metaBox.innerHTML = '';
    notes.innerHTML = '<div class="dl-empty">管理员还没有发布安装包。可以先 clone 源码，用安装向导创建一个空库。</div>';
    btn.textContent = '查看源码';
    btn.href = meta.repo || 'https://gitee.com/mserm/mserm-crm';
    return;
  }

  ver.textContent = `v${latest.version}${latest.channel === 'beta' ? ' beta' : ''}`;
  metaBox.innerHTML = [
    `<span>${fmtSize(latest.size)}</span>`,
    `<span>${fmtDate(latest.releasedAt)}</span>`,
    latest.sha256 ? `<span>SHA256 ${esc(latest.sha256.slice(0, 10))}…</span>` : '',
    `<span>已下载 ${latest.downloads || 0} 次</span>`,
  ].filter(Boolean).join('');
  notes.textContent = latest.notes || '包含完整组织架构、产品库与一年期业务数据，导入后即可体验报价、合同与回款全流程。';

  if (signedIn) {
    btn.textContent = '下载演示数据库';
    btn.href = `/api/download/${latest.id}`;
    btn.removeAttribute('data-guest');
  } else {
    btn.textContent = '登录后下载';
    btn.href = '/login.html?next=/account.html';
  }

  // 历史版本提示
  if (versions.length > 1) {
    const more = document.createElement('div');
    more.className = 'dl-hint';
    more.innerHTML = `另有 ${versions.length - 1} 个历史版本，登录后可在会员中心下载`;
    btn.parentElement.appendChild(more);
  }
}

init();
