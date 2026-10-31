# 更新日志

版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)：`主版本.次版本.修订号`。
数据库结构变更一律通过 `src/db.js` 的 `migrate()` 增量执行，升级前请先备份 `data/crm.db`。

## 2.8.0

**双数据库：默认 SQLite，可切换 PostgreSQL（由部署者在配置里决定）**

- `src/db.js` 重写为双后端，对外 API 不变（`all/one/run/tx/idOf/migrate`），业务代码无需分支
  - **默认 SQLite**：仍用 Node 内置 `node:sqlite`，零外部依赖、单文件、开箱即用
  - **可选 PostgreSQL**：`DB_TYPE=postgres` 时动态加载 `pg`，未安装该依赖也不影响 SQLite 模式
  - 判定顺序：`DB_TYPE` 显式优先；未填但存在 `DATABASE_URL` 则按 PostgreSQL；否则 SQLite
- PostgreSQL 模式下 CRM 的表建在独立 `crm` schema，与同库中销售系统的 `public` 表互不干扰
- 查询层统一改为异步（两种后端一套调用方式），路由与服务的调用点同步补 `await`
- 方言差异收敛为四个片段，不再散落在业务代码里：
  - `dateCol()` / `dateLtToday()`：PostgreSQL 的 TEXT 与 DATE 比较需显式转换，SQLite 用 `date()`
  - `isToday()`：判断时间戳是否属当天
  - `overdueDays()`：逾期天数（两种库的日期算术不同）
- 建表语句单一来源：SQLite 的 DDL 由 PostgreSQL 版机械转换（`SERIAL PRIMARY KEY` → `INTEGER PRIMARY KEY AUTOINCREMENT`），避免两份结构各自漂移；仍全部用 `IF NOT EXISTS`，升级旧库是幂等的
- `src/backup.js` 支持双后端：两种库都用 `npm run backup` 导出全部 28 张表的 JSON 快照
- 新增脚本：`scripts/migrate-from-sqlite.mjs`（把 SQLite 数据按外键顺序迁到 PostgreSQL 并重置序列）、`scripts/run-migrate.mjs`、`scripts/verify.mjs`
- `package.json` 增加 `pg` 依赖（仅 PostgreSQL 模式需要）；移除已无用的 `@babel/standalone`
- 修复：全新空库首次启动时内置条款模板未写入（参数传递方式与 `run()` 的 rest 参数不匹配，旧演示库因模板已存在而掩盖了该问题）
- 修复：`node:sqlite` 对 `undefined`/布尔/`Date` 绑定极严格（`pg` 会静默转 `null`），统一在绑定层归一化，避免"可选字段不填就 500"

## 2.7.0

**仓库只放 CRM；销售官网独立；新增在线测试**

- 销售官网（原 `site/`）从本仓库移出，成为独立项目：自己的目录、自己的会员库、自己的部署与发版
  - 本仓库不再包含任何官网代码，`/site/` 已加入 `.gitignore`
  - 主线文档同步说明两者只有两条单向链接：`SITE_URL`、`SITE_DEMO_URL`
- 新增演示模式（`DEMO_MODE=1`）：主系统可直接作为官网的「在线测试」实例
  - `GET /demo` 免密签发出演示账号会话并跳到工作台，访客不用记账号密码
  - `/api/bootstrap` 下发演示信息，顶栏显示「演示环境 · 24h 重置」与「返回官网」
  - 未开启时 `/demo` 302 回登录页并提示「这个实例没有开启在线演示」
  - `DEMO_USER` / `DEMO_RESET_HOURS` / `DEMO_HOME` 可配；重置靠换库 + 重启
- 部署文档新增第 10 节：演示实例怎么起、怎么每日重置、官网怎么接

## 2.6.1

**双平台托管：Gitee 主仓库 + GitHub 镜像**

- 新增 `scripts/publish.sh`：一条命令建仓并推送到 Gitee 与 GitHub，可只推单边（`gitee` / `github`）
  - 令牌经临时 `GIT_ASKPASS` 传入，不写入 `.git/config`，不出现在 URL
  - 推送前拦截 `.db` / `release/` / `private/` / `.env` 被误提交
- `scripts/set-repo.sh` 支持一次替换两个平台的占位仓库地址（`<Gitee空间> [仓库名] [GitHub空间]`）
- 新增 `.github/` 模板（Bug / 功能建议 / PR），与 `.gitee/` 并存
- README 增加双仓库入口与克隆说明；官网页脚增加 GitHub 镜像链接
- 移除 `scripts/publish-gitee.sh`，由 `scripts/publish.sh` 统一承担
- 新增 `docs/screenshots/`：工作台、审批中心、报价、合同、单据、组织、官网等 10 张真实界面图，README 增加「界面一览」
- 新增 `docs/diagrams/`：分层架构、请求生命周期、数据模型、审批链 4 张图（SVG 源 + PNG）
- 新增 `docs/14-架构与开发逻辑.md`：分层职责、请求链路、数据模型、审批链，以及「加一个功能要动哪些文件」

## 2.6.0

**开源发布 + 官网会员体系**

- 新增 `src/setup.js` 与 `/setup.html` 安装向导：空库首次启动创建集团与管理员，不再自动写入演示数据
- 仓库不再包含演示数据库与生成脚本（`private/` 已被忽略），演示库改为官网会员下载
- 新增 `site/` 官网服务（独立端口 8099）：
  - 落地页、注册（邮箱验证码可选）、登录、会员中心
  - 受控下载：需登录、每日限额可配、支持 Range 断点续传、逐条记录 IP 与 UA
  - 运营后台：上传/登记安装包、上下线版本、会员停用、下载与操作日志
  - 零依赖 SMTP 客户端（465 SSL / 587 STARTTLS），未配置时验证码打印到日志
- 新增 `private/make-demo-db.mjs`：生成 `.db` + `.zip`（含 `INSTALL.md` 与 SHA256）+ `manifest.json`
- 新增 `.env` 加载器（零依赖），主系统与官网均支持 `.env`
- `.gitignore` 覆盖数据、安装包、记忆与历史版本目录，确保不把数据提交进仓库

## 2.5.0

- 报价支持**例外商品**：单独弹窗录入名称、规格、数量、单价，不受产品库限制
- 修复例外商品弹窗会销毁报价编辑器的问题：弹窗改为多层叠加，Esc 只关最上层
- 报价单与合同单据正确带出例外行（此前只显示合计）

## 2.4.0

- 报价单可发送给客户：邮件 + 短信双通道，逐条留痕（成功/模拟/失败）
- 新增报价单公开链接 `/q/<token>`：客户免登录查看，移动端自适应，服务端不返回成本
- 系统设置新增公司抬头、SMTP、短信网关、对外访问地址

## 2.3.0

- 报价通过后，合同页直接出现「创建合同」入口
- 合同分为**订单合同**（中国发票版式、含税/不含税、价税合计大写）与**条款合同**（套模板、自动填充甲乙方、自动编号）
- 合同编号 `DD-YYYY-0001` / `HT-YYYY-0001` 自增
- 内置三套条款模板：软件实施服务、产品采购、保密协议

## 2.2.0

- 提交审批必须指定到人：展示具体审批人姓名，支持改派，缺人时返回明确错误
- 组织分级管理：集团 / 公司 / 部门 / 团队，上下级可见、不可跨域
- 离职交接：先交接客户与商机，再停用账号；再次登录提示离职时间与接手人

## 2.1.0

- 未让价（折扣率 0）的报价免价格审批，直接进入合同流程
- 修复详情抽屉内「新建报价 / 写跟进 / 推进需求」按钮全部失效的问题

## 2.0.0

- 从单机版（JSON 文件）重写为网络版：`node:sqlite` + 会话登录 + 组织级数据隔离 + 通用审批引擎
- 角色 6 类：SDR / AE / 经理 / 总监 / 财务 / 管理员（后续新增法务）
- 数据范围按组织树 `path` 前缀收口，字段级脱敏在服务端完成

## 1.0.0

- 单机原型：原生 JS 单页 + JSON 文件存储，无登录，用于验证交互范式
