const $ = (id) => document.getElementById(id);
const msg = $('msg');
const btn = $('submitBtn');
const codeRow = $('codeRow');

function show(text, kind = 'err') {
  msg.textContent = text;
  msg.className = `form-msg show ${kind}`;
}
function hide() { msg.className = 'form-msg'; }

let requireCode = false;

fetch('/api/meta')
  .then((r) => r.json())
  .then((m) => {
    requireCode = Boolean(m.requireCode);
    if (!requireCode) {
      codeRow.style.display = 'none';
      console.info('[site] 未配置 SMTP 或已关闭验证，注册免验证码');
    }
  })
  .catch(() => {});

/* 发送验证码 */
const sendBtn = $('sendCode');
sendBtn.onclick = async () => {
  const email = $('email').value.trim();
  if (!email) return show('请先填写邮箱');
  sendBtn.disabled = true;
  sendBtn.textContent = '发送中…';
  try {
    const res = await fetch('/api/auth/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '发送失败');
    if (data.devCode) {
      $('code').value = data.devCode;
      show(`本地环境未配置邮件服务，验证码 ${data.devCode} 已自动填入`, 'ok');
    } else {
      show('验证码已发送，请查收邮件（注意垃圾箱）', 'ok');
    }
    let left = 60;
    sendBtn.textContent = `${left}s 后重发`;
    const timer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        sendBtn.disabled = false;
        sendBtn.textContent = '重新发送';
      } else {
        sendBtn.textContent = `${left}s 后重发`;
      }
    }, 1000);
  } catch (err) {
    show(err.message);
    sendBtn.disabled = false;
    sendBtn.textContent = '获取验证码';
  }
};

/* 提交注册 */
$('f').onsubmit = async (e) => {
  e.preventDefault();
  hide();

  const payload = {
    email: $('email').value.trim(),
    code: $('code').value.trim(),
    name: $('name').value.trim(),
    company: $('company').value.trim(),
    phone: $('phone').value.trim(),
    password: $('password').value,
  };

  if (!payload.email) return show('请填写邮箱');
  if (requireCode && !payload.code) return show('请填写邮箱验证码');
  if (payload.name.length < 2) return show('请填写你的称呼');
  if (payload.company.length < 2) return show('请填写公司名称');
  if (payload.password.length < 8) return show('密码至少 8 位');
  if (!/[a-zA-Z]/.test(payload.password) || !/\d/.test(payload.password)) {
    return show('密码需同时包含字母和数字');
  }

  btn.disabled = true;
  btn.textContent = '正在创建账号…';
  try {
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '注册失败');
    location.href = '/account.html?welcome=1';
  } catch (err) {
    show(err.message);
    btn.disabled = false;
    btn.textContent = '注册并下载数据库';
  }
};
