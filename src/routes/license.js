import { GET, POST, DELETE, bad, denied } from '../http.js';
import { activateLicense, clearLicense, licenseStatus, machineId } from '../license.js';
import { userQuota } from '../edition.js';

/**
 * 商业授权的查看与激活。
 *
 * 只对系统管理员开放：授权决定「能建多少个用户」，属于发行层面的东西，
 * 不该让销售总监这类角色看到或改动。
 */

const requireSuperAdmin = ctx => {
  if (ctx.user.role !== 'admin') throw denied('只有系统管理员可以查看或激活商业授权');
};

GET('/api/admin/license', async ctx => {
  requireSuperAdmin(ctx);
  const status = await licenseStatus();
  const quota = await userQuota();
  return {
    ...status,
    quota: {
      edition: quota.edition,
      limit: quota.limit,
      unlimited: quota.unlimited,
      current: quota.current,
      reached: quota.reached,
    },
    upgradeUrl: quota.upgradeUrl,
  };
});

POST('/api/admin/license', async ctx => {
  requireSuperAdmin(ctx);
  const code = String((ctx.body && ctx.body.code) || '').trim();
  if (!code) throw bad('请粘贴授权码');
  if (code.length > 4000) throw bad('授权码过长，请确认粘贴内容');

  const r = await activateLicense(code);
  if (!r.ok) {
    // 验签失败不是「参数错误」而是「这份授权不认」，返回 400 + 明确原因
    throw bad(r.error);
  }
  return {
    ok: true,
    message: '授权已生效',
    license: r.license,
    machine: machineId(),
  };
});

DELETE('/api/admin/license', async ctx => {
  requireSuperAdmin(ctx);
  if (String(process.env.CRM_LICENSE || '').trim()) {
    throw bad('当前授权来自环境变量 CRM_LICENSE，请修改 .env 后重启服务；后台不能覆盖它');
  }
  await clearLicense();
  return { ok: true, message: '已移除后台激活的授权，实例将回落到社区版规则' };
});
