const msg = document.getElementById('msg');
const btn = document.getElementById('submitBtn');

function show(text, kind = 'err') {
  msg.textContent = text;
  msg.className = `form-msg show ${kind}`;
}

// 已登录直接进会员中心
fetch('/api/auth/me')
  .then((r) => r.json())
  .then((d) => { if (d.member) location.replace('/account.html'); })
  .catch(() => {});

document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  msg.className = 'form-msg';

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  if (!email || !password) {
    show('请输入邮箱和密码');
    return;
  }

  btn.disabled = true;
  btn.textContent = '登录中…';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '登录失败');
    const next = new URLSearchParams(location.search).get('next');
    location.href = next && next.startsWith('/') ? next : '/account.html';
  } catch (err) {
    show(err.message);
    btn.disabled = false;
    btn.textContent = '登录';
  }
};
