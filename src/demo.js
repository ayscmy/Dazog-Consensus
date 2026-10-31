import { one } from './db.js';

/**
 * 演示模式（官网「在线测试」用）。
 *
 * 单独起一个进程、指向一份专用的演示库，靠环境变量打开：
 *   DEMO_MODE=1 DEMO_USER=demo CRM_DB=data/demo.db PORT=8096 npm start
 *
 * 打开后：
 *   - GET /demo 直接签发会话并跳到 /app.html，访客不用记账号密码
 *   - 界面顶部显示「演示环境」标识，提示数据会重置
 *   - 其它行为与正式实例完全一致（读写都能做），重置靠外部脚本换库
 */
export const DEMO_MODE = String(process.env.DEMO_MODE ?? '0') === '1';
export const DEMO_USER = process.env.DEMO_USER || 'admin';
export const DEMO_RESET_HOURS = Number(process.env.DEMO_RESET_HOURS || 24);
export const DEMO_HOME = process.env.DEMO_HOME || '';

/** 演示账号是否存在且可用；空库或账号被停用时返回 null */
export async function demoAccount() {
  if (!DEMO_MODE) return null;
  const row = await one(`select id, username, name from users
      where username = ? and status = 'active' and left_at is null`, DEMO_USER);
  return row || null;
}

/** 演示模式的可用性说明，给前端和日志共用 */
export async function demoInfo() {
  if (!DEMO_MODE) return null;
  const acct = await demoAccount();
  return {
    ready: Boolean(acct),
    user: acct ? acct.username : DEMO_USER,
    resetHours: DEMO_RESET_HOURS,
    home: DEMO_HOME
  };
}