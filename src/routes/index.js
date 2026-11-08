// 路由汇总：server.js 只引入本文件
import './setup.js';
import './auth.js';
import './dashboard.js';
// 公共池必须排在 leads.js 之前：GET /api/leads/pool 与 GET /api/leads/:id 都是 3 段，
// 晚注册会被 :id 吃掉（历史上 /api/internal/trial/ping 踩过同一个坑）。
import './pool.js';
import './leads.js';
import './accounts.js';
import './opportunities.js';
import './products.js';
import './quotations.js';
import './contracts.js';
import './finance.js';
import './approvals.js';
import './reports.js';
import './attachments.js';
import './admin.js';
// 对外线索 API（v1）与它的开通授权
import './leads-api.js';
import './accounts-api.js';
import './api-admin.js';
// 官网开通/回收试用账号的内部接口
import './trial-api.js';
// 商业授权的查看与激活（仅系统管理员）
import './license.js';
