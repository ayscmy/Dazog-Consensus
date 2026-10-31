# 贡献指南

感谢你愿意把时间花在这个项目上。为了让合并过程顺利，请先花两分钟读下面几条。

## 一、开发环境

```bash
git clone https://gitee.com/mserm/mserm-crm.git    # 或 https://github.com/mserm/mserm-crm.git
cd mserm-crm
npm start          # 主系统 http://localhost:8081
npm run site       # 官网     http://localhost:8099
```

- **Node.js ≥ 22.5**（依赖内置 `node:sqlite`）
- **没有 `npm install`**：项目零第三方依赖，请勿引入 npm 包
- 首次启动是空库，浏览器会跳到 `/setup.html` 创建管理员
- 需要演示数据时，从官网会员中心下载，放到 `data/crm.db`

## 二、提 Issue

请尽量包含：

1. 你的操作系统与 `node -v` 输出
2. 复现步骤（从哪个页面、点了什么）
3. 实际结果与期望结果
4. 服务端日志（`Ctrl+C` 前的最后 20 行）或浏览器控制台报错

**不要**在 Issue 里粘贴真实客户数据、密码、`data/crm.db` 文件。

项目同时托管在 Gitee（主）与 GitHub（镜像），Issue / PR 提在 Gitee 响应更快；GitHub 上提的也会看。

## 三、提 PR

- 一个 PR 只做一件事，标题写清楚「修什么 / 加什么」
- 从 `main` 切分支：`feat/xxx`、`fix/xxx`、`docs/xxx`
- 提交信息用中文或英文均可，建议 `类型: 说明`，例如 `fix: 报价折扣为 0 时不再生成空审批单`
- 改动涉及界面时，请附改动前后的截图
- 新增业务规则时，请同步更新 `docs/` 里对应文档

## 四、代码约定

**必须遵守**

1. **零依赖**：只用 Node 内置模块与原生浏览器 API。需要的能力自己写（参考 `src/mailer.js`、`site/src/mail.js`）。
2. **数据库改动走增量迁移**：在 `src/db.js` 的 `migrate()` 里 `addColumn()` / `create table if not exists`，**不要**修改已有的建表语句，也不要写 `drop`。
3. **权限校验在服务端**：任何列表/详情查询都要经过 `scopeFilter()` 或 `visibleOrgs()`；字段脱敏在服务端删字段。
4. **状态变更走状态机**：不要在前端直接改 `status`，所有状态推进都要有服务端校验与审计记录。
5. **错误要可读**：`HttpError(400, '具体原因')`，不要抛裸 `throw new Error('error')`。
6. **不要提交数据**：`data/`、`release/`、`site/data/`、`.env` 已被忽略，请勿强行 `git add -f`。

**风格**

- ESM，2 空格缩进，单引号，语句结尾分号
- 后端文件按业务域拆分，一个路由文件不超过 500 行
- 前端不引入框架，保持「hash 路由 + 动态 import + 局部重渲染」

## 五、自测

提交前至少跑一遍：

```bash
# 1. 空库安装（用临时库，别动自己的数据）
CRM_DB=./data/test.db PORT=8099 npm start
# 浏览器打开 http://localhost:8099/setup.html 走完向导

# 2. 关键链路手测
#    登录 → 建客户 → 建商机 → 建报价（带折扣）→ 提交审批 → 审批通过 → 创建合同 → 查看单据

# 3. 官网链路
npm run site
#    注册 → 登录 → 会员中心下载 → 后台发布版本
```

涉及权限的改动，请至少用两个不同角色的账号交叉验证（例如 `mgr01` 与 `ae01`）。

## 六、行为准则

- 对事不对人，技术分歧用数据和代码说话
- 不提交含真实客户信息的截图与日志
- 不讨论与项目无关的政治、宗教话题

## 七、许可证

你的贡献将以 [AGPL-3.0](LICENSE) 发布。提交 PR 即表示同意这一授权。
