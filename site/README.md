# MSERM 官网 · 会员与安装包分发

零依赖 Node 服务（端口 8099），独立数据库 `data/site.db`，与主系统**不共享任何表**。
职责只有三件事：**注册会员**、**受控下载演示数据库**、**记录谁在什么时候下载了什么**。

## 启动

```bash
cp .env.example .env      # 改管理员邮箱与密码
npm start                 # 或根目录 npm run site
```

首次启动会创建管理员。若未设置 `SITE_ADMIN_PASSWORD`，随机密码会打印在控制台，请立即登录修改。

## 页面

| 路径 | 说明 |
|---|---|
| `/` | 落地页：产品介绍、开源自取与会员下载的差异、版本说明、FAQ |
| `/signup.html` | 注册：邮箱（验证码可选）、称呼、公司、手机、密码 |
| `/login.html` | 登录 |
| `/account.html` | 会员中心：下载最新/历史版本、下载记录、资料与改密 |
| `/admin.html` | 运营后台：上传安装包、登记与上下线版本、会员管理、日志 |

## 安装包从哪来

安装包放在 `SITE_RELEASE_DIR`（默认 `../release`），支持 `.db` `.zip` `.tar.gz` `.7z`。

两种发布方式：

1. 后台上传文件 → 填版本号与更新说明 → 发布
2. 把文件放进 `../release` 目录 → 后台下拉选择 → 发布

维护者可用根目录的 `npm run demo` 生成标准安装包（`.db` + 含 `INSTALL.md` 的 `.zip` + `manifest.json`）。

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/meta` | 否 | 站点信息、最新版本、会员数、是否强制验证码 |
| POST | `/api/auth/code` | 否 | 发送注册验证码（同邮箱 60s 一次，同 IP 每小时 10 次） |
| POST | `/api/auth/signup` | 否 | 注册并自动登录 |
| POST | `/api/auth/login` | 否 | 登录 |
| POST | `/api/auth/logout` | 否 | 退出 |
| GET | `/api/auth/me` | 可选 | 当前会员、配额、版本、下载记录（未登录返回 `member: null`） |
| GET | `/api/versions` | 否 | 已发布版本 |
| GET | `/api/download/:id` | 会员 | 下载安装包（限流、记录、支持 Range） |
| POST | `/api/my/profile` | 会员 | 改资料 |
| POST | `/api/my/password` | 会员 | 改密码 |
| GET | `/api/admin/overview` | 管理员 | 统计、会员、下载、版本、文件、日志 |
| PATCH | `/api/admin/members/:id` | 管理员 | 停用/启用会员 |
| POST | `/api/admin/versions` | 管理员 | 登记或上下线版本 |
| PUT | `/api/admin/upload?name=` | 管理员 | 上传安装包（请求体为二进制） |

## 安全设计

- 密码 scrypt（N=16384）+ 随机盐，`timingSafeEqual` 比较
- 会话 32 字节随机 Token，库里只存 `sha256(token)`，默认 30 天
- 登录失败 6 次锁 10 分钟；注册与验证码接口按 IP 限流
- 下载必须登录 + 每日限额，文件名不暴露在 URL 中，无法被外链盗刷
- 上传只接受白名单扩展名，路径经 `basename` 处理，防目录穿越
- HTTP 响应带 `X-Content-Type-Options`、`Referrer-Policy`

## 与主系统的关系

```
                    ┌────────────────────┐
  访客 ──注册──▶    │  官网 site/ (8099)  │
                    │  members / versions │
                    └─────────┬──────────┘
                              │ 下载 zip（crm.db）
                              ▼
                    ┌────────────────────┐
  员工 ──登录──▶    │  主系统 (8081)      │
                    │  data/crm.db        │
                    └────────────────────┘
```

官网不读取主系统的任何数据；主系统只在安装向导里放一个「前往官网获取演示数据库」的链接（`SITE_URL`）。
