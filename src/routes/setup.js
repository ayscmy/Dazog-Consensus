import { GET, POST } from '../http.js';
import { installInfo, createWorkspace } from '../setup.js';

/** 安装状态：登录页与安装向导都靠它决定跳哪里 */
GET(
  '/api/setup/status',
  () => {
    const info = installInfo();
    return {
      ...info,
      // 官网地址：开源版不内置数据库，需注册会员下载
      siteUrl: process.env.SITE_URL || 'http://localhost:8090',
      edition: process.env.CRM_EDITION || 'community',
    };
  },
  { auth: false }
);

/** 创建第一个集团与管理员；只在空库时可用 */
POST(
  '/api/setup',
  (ctx) => {
    const r = createWorkspace(ctx.body || {});
    return { ok: true, ...r };
  },
  { auth: false }
);
