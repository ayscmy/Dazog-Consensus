const form = document.getElementById('setupForm');
const errBox = document.getElementById('setupErr');
const btn = document.getElementById('setupBtn');
const box = document.querySelector('.setup-box');

// 官网地址由服务端下发，避免把域名写死在页面上
fetch('/api/setup/status')
  .then((r) => r.json())
  .then((d) => {
    if (d.siteUrl) document.getElementById('siteLink').href = d.siteUrl;
    if (!d.needed) location.replace('/login.html');
  })
  .catch(() => {});

function fail(msg) {
  errBox.textContent = msg;
  errBox.classList.add('show');
}

form.onsubmit = async (e) => {
  e.preventDefault();
  errBox.classList.remove('show');

  const payload = {
    company: document.getElementById('company').value.trim(),
    name: document.getElementById('name').value.trim(),
    username: document.getElementById('username').value.trim(),
    password: document.getElementById('password').value,
    email: document.getElementById('email').value.trim(),
    phone: document.getElementById('phone').value.trim(),
  };
  const password2 = document.getElementById('password2').value;

  if (!payload.company) return fail('请填写企业名称');
  if (!payload.name) return fail('请填写管理员姓名');
  if (!payload.username) return fail('请填写登录账号');
  if (payload.password.length < 8) return fail('密码至少 8 位');
  if (payload.password !== password2) return fail('两次输入的密码不一致');

  btn.disabled = true;
  btn.textContent = '正在创建…';
  try {
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '初始化失败');

    box.innerHTML = `
      <div class="setup-done">
        <div class="ok-mark">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M4 10.5l4 4 8-9" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
        <h2>工作区已创建</h2>
        <p>数据库表结构与管理员账号已就绪。接下来可以登录补充组织架构、邀请同事，或到官网下载演示数据库直接体验完整流程。</p>
        <div class="cred"><span>登录账号</span><b>${escapeHtml(data.username)}</b></div>
        <div class="cred"><span>管理员</span><b>${escapeHtml(payload.name)}</b></div>
        <button class="login-btn" id="goLogin" style="margin-top:14px">进入登录页</button>
      </div>`;
    document.getElementById('goLogin').onclick = () => location.href = '/login.html';
  } catch (err) {
    fail(err.message);
    btn.disabled = false;
    btn.textContent = '创建并进入登录';
  }
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
