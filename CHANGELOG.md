# 更新日志

版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)：`主版本.次版本.修订号`。
数据库结构变更一律通过 `src/db.js` 的 `migrate()` 增量执行，升级前请先备份 `data/crm.db`。

## 2.11.0

**试用转化改造：从"给个账号"改成"一条被设计的路径"**

### 新增

- 试用组织预置示例业务：3 客户 / 5 线索 / 2 商机 / 1 草稿报价，
  统一 `source='示例'` 便于识别与清理。开通失败不阻断（示例只是降低门槛）
- 冻结机制：到期不再物理删除，转 `users.status='frozen'` 只读，数据原样保留；
  满 `TRIAL_RETAIN_DAYS`（默认 30 天）才真正回收
- 内部接口 `POST /api/internal/trial/:id/freeze`（幂等），`ping` 返回 `retainDays`
- 试用期邮件序列 D1/D3/D6/D12/D14（`src/trial-mails.js`）：
  只发"最新那封"避免停服后集中补发；未配 SMTP 不写发送记录，配好后可补
- 新表 `trial_mail_log` 记录发送，`trial_accounts` 增 `frozen_at` / `purge_after`
- 会员中心新增「已冻结」态：显示保留截止日与剩余天数，给「升级并恢复数据」入口

### 变更

- 试用期 **7 天 → 14 天**（`TRIAL_DAYS` / `SITE_TRIAL_DAYS`），
  到期后保留 **30 天**（`TRIAL_RETAIN_DAYS` / `SITE_TRIAL_RETAIN_DAYS`）
- 邮件与页面话术统一改为「到期转只读，数据保留 N 天」，不再说"自动删除"
- 登录闸门识别 `frozen`，返回可行动提示（数据还在、可恢复），而非笼统"账号已停用"
- 官网 `#pricing`、FAQ、结构化数据、`llms.txt`、注册页同步新口径

### 许可（v2.0）

- 由「个人学习许可（禁止任何商业用途）」改为「**社区版许可 v2.0**」：
  **10 个在职用户以内可免费自用，含企业内部经营**（客户/销售/合同/回款）
- 仍禁止：超过 10 人、对外提供服务、转售、交付客户项目、代运维、去除版权标识
- 保留完整历史说明：AGPL-3.0（2026-11-01 前）→ 个人学习许可 v1.0 → 社区版 v2.0，
  各阶段已获得的副本，其当时权利不受后续变更影响

### 验证

- CRM 端到端 25/25：14 天、示例数据 3/5/2/1、冻结后数据完好、
  冻结用户登录被拒且 `code=frozen`、刚冻结不误删、满 30 天回收、回收后清零、幂等
- 官网端到端 20/20：开通 14 天、密码可解密、冻结状态与回收日、
  CRM 侧同步 frozen、冻结期内不回收、满期回收、D3 邮件选中且未配 SMTP 不落库

## 2.10.1

**上线修整：登录入口、域名切换、技术栈文档**

### 修复

- `server.js` 里 `setupNeeded()` / `getSession()` / `demoAccount()` 未 `await`，
  拿到的是 Promise（恒为真）→ **所有页面都被 302 到 `/setup.html`**，
  已初始化实例也进不去登录页。补 `await` 后：`/` → `/login.html`、`/setup.html` → 回登录页
- `GET /api/admin/users`、`GET /api/admin/api-clients` 用 `map(async …)` 得到 Promise 数组，
  序列化成 `{}`，列表空白。改 `Promise.all`
- `POST /api/admin/users` 把 `(async () => …)()` 的 Promise 当参数插 `user_roles`，
  接口 500 但 users 行已插入，留下没有角色的孤儿账号

### 新增

- 登录页演示账号改为**点击即登录**（填入并自动提交），并新增「试用账号 · 需先注册会员」
  常显入口，注册链接跟随 `SITE_URL`
- `docs/18-开发语言与工具.md`：技术栈归类（语言 / 运行时 / 依赖 / 数据存储 / 前端 /
  部署运维 / 自检工具 / 协作 / 加密用法 / 版本矩阵 / 明确不用的技术及原因）；
  开头新增「0. 前端 vs 后端」速览——两侧语言、框架、依赖、构建、入口、通信方式逐项对照，
  并点明「无 TypeScript / 无前端框架 / 前端零依赖」三个易错点

### 变更

- 官网地址统一为 `aioffice.aiemy.com`（升级跳转、登录页兜底链接、`.env`）
- `package.json` 的 `license` 由 `AGPL-3.0-or-later` 改为 `SEE LICENSE IN LICENSE`，
  与自定义的「AIEMY 个人学习许可」对齐

## 2.10.0

**商业授权：离线可验的 Ed25519 授权码，解除社区版 10 人限制**

- 授权码格式：`base64url(载荷).base64url(Ed25519 签名)`，一行文本，贴 `.env` 或后台即可
- 采用非对称签名而非对称口令：产品只内置**公钥**，客户反编译也签不出新授权
- 载荷：`id / to / edition / users / expire / issued / machine / features / v`
  - `users = 0` 表示不限人数
  - `machine` 可选绑机器（不填则换服务器无需重签）
  - `expire` 可选，按到期日 23:59:59 判定，留空为永久
- 判定顺序：`CRM_LICENSE`（env）> 后台激活（数据库）> `CRM_USER_LIMIT` > 社区版 10 人
  - 验签失败 / 过期 / 绑错机器一律当「无授权」回落下一级，不让实例起不来
  - 授权结果缓存 30 秒
- 新增接口（仅系统管理员）：`GET / POST / DELETE /api/admin/license`
  - 环境变量提供的授权在后台只读，避免「后台删了但重启又回来」
- 后台「系统设置 → 商业授权」：状态、被授权方、编号、人数上限、有效期、绑定机器、来源、
  本机指纹（可复制）、粘贴激活 / 更换 / 移除
- 新增签发工具 `scripts/license.mjs`：`keygen` / `issue` / `verify` / `machine`
  - 签发后自动用产品端同一套 `verifyLicense` 自检，自检不过不输出
- 授权验签逻辑拆到 `src/license-core.js`（纯函数、不连数据库），命令行工具可直接复用

> 清醒说明：Node 源码部署下，客户可以改代码绕过限制。这套方案防的是「手改配置」，
> 不是对抗逆向 —— 详见 `docs/17-授权方案.md` 第 1 节。

验证：授权与额度 25/25（含篡改码、过期码、绑错机器、env 优先级、后台移除、非超管 401）。

## 2.9.0

**线索 API 授权管理：新增授权域名，权限收敛到超级管理员；许可证变更为个人学习许可**

### 授权域名（新）

- `api_clients` 新增 `domain_whitelist` 字段；老库由新增的 `ensureColumns()` 自动补列
  （SQLite 走 `PRAGMA table_info` 探测，PostgreSQL 走 `information_schema`），无需手工迁移
- 鉴权从三道闸门变四道：密钥 → 来源 IP → **来源域名** → 限额
- 域名匹配规则：
  - `api.partner.com` 只匹配自身；`*.partner.com` 匹配 base 与任意层级子域；`*` 不限
  - 来源取自 `Origin`，缺失时退回 `Referer` 取域名
  - **不用 `Host` 兜底**：`Host` 是「打到 CRM 身上的域名」，不是调用方的域名
- 空名单语义与 IP **故意相反**：IP 空 = 全拒绝；域名空 = **不校验**。
  原因是服务器对服务器调用通常不带 `Origin`，若空也拒绝会把所有既有纯 IP 接入方一次性打死
- 开放域名后，请求缺 `Origin`/`Referer` 会被明确拒绝并提示如何补齐，而不是笼统 403
- 管理端连通性自检支持传入来源域名，返回 IP 与域名两段结论

### 权限

- 授权管理（开通 / 编辑 / 重置 / 撤销 / 自检 / 日志）**仅超级管理员**可操作：
  后端 `requireAdmin` 拦截，销售总监与销售经理虽然有 `admin` 模块（能管人与组织），
  但看不到该页签，直接调接口也会 403

### 社区版用户额度

- 社区版（`CRM_EDITION=community`）最多 **10 个在职用户**，超限时新增 / 恢复账号返回
  `403 { code: "USER_LIMIT", limit, current, upgradeUrl }`
- 判定只看在职账号：离职与停用不占名额；**官网自动开通的 `trial` 账号不占名额**，
  否则第 11 个访客注册时试用会静默失败
- 额度可用 `CRM_USER_LIMIT` 覆盖（`0` = 不限），商业授权默认不限
- 后台「用户与组织」显示 `当前/上限`，用满时顶部告警条 + 新增按钮直接弹升级说明
- 升级弹窗含社区版/商业授权对比表与「前往官网了解授权」，跳转地址由 `CRM_UPGRADE_URL` 配置
  （默认 `https://aioffice.aiemy.com/?from=crm#pricing`）

### 修复

- `GET /api/admin/api-clients` 用 `map(async …)` 得到 Promise 数组，序列化后每行都是 `{}`，
  导致接入方列表空白、启用数恒为 0。改为 `Promise.all` 收齐
- `GET /api/admin/users` 同一问题：用户列表每行都是 `{}`
- `POST /api/admin/users` 里 `const id = (async () => …)()` 得到的是 Promise，直接当参数插
  `user_roles` 会被 `node:sqlite` 拒绝 → 接口 500，但 users 行已插入，留下没有角色的孤儿账号。
  改为 `await` 后取 `idOf()`

### 许可

- `LICENSE` 由 AGPL-3.0 变更为 **AIEMY 个人学习许可**：版权归 AIEMY 所有，
  仅限个人学习、研究与非营利性教学等非商业用途，禁止任何商业使用
- 同步更新 `README` / `CONTRIBUTING` / `docs/13` 的授权表述
- 登录页、安装向导、应用外壳增加版权脚注

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
