# Gitee → GitHub 自动同步（方法二：Webhook + git push --mirror）

> 本文档说明如何通过「Gitee WebHook + 接收端服务」实现：**只要往 Gitee 推送一次，GitHub 自动镜像**。
> 对应代码：`scripts/sync-receiver.mjs`（零依赖 Node.js 服务）。

## 1. 原理

```
开发者/CI ──push──▶ Gitee(mserm-crm)
                        │  WebHook(Push 事件)
                        ▼
                  接收端服务(独立服务器)
                        │  1. 校验 X-Gitee-Token 签名
                        │  2. git fetch -p origin
                        │  3. git push --mirror github
                        ▼
                    GitHub(mserm-crm)  ← 自动保持镜像
```

相比 Gitee 内置「推送镜像」（方法一），方法二把 **GitHub 令牌留在你自己的服务器上**，不交给 Gitee 后台，适合对令牌隔离有要求的场景。

## 2. 服务器准备

一台能访问公网、装了 `node`（≥18，本仓库要求 ≥22.5）与 `git` 的服务器。

### 2.1 以镜像方式克隆仓库

```bash
# 用令牌内嵌 URL 拉取（也可用 SSH key / credential helper 替代，见 §6）
git clone --mirror "https://<GITEE_TOKEN>@gitee.com/Emcloud_admin/mserm-crm.git" /srv/mserm-crm-mirror
cd /srv/mserm-crm-mirror

# origin 已指向 Gitee；再添加 GitHub 远程
git remote set-url origin "https://<GITEE_TOKEN>@gitee.com/Emcloud_admin/mserm-crm.git"
git remote add github "https://<GITHUB_TOKEN>@github.com/<GITHUB_OWNER>/mserm-crm.git"
```

`--mirror` 得到的是裸镜像仓库，`fetch -p origin` 后会更新所有分支与标签，`push --mirror github` 会把它们整体镜像到 GitHub（**含删除同步**）。

### 2.2 放置接收端脚本

把本仓库的 `scripts/sync-receiver.mjs` 放到服务器（随仓库镜像一起即可，因为它已提交进版本库，会被一起同步）。

## 3. 启动接收端

```bash
GITEE_SECRET="你在 Gitee 设置的 WebHook 密钥" \
PORT=8080 \
REPO_DIR=/srv/mserm-crm-mirror \
GITHUB_REMOTE=github \
node /srv/mserm-crm-mirror/scripts/sync-receiver.mjs
```

可选环境变量：

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `8080` | 监听端口 |
| `GITEE_SECRET` | 空 | **必填**，WebHook 签名密钥；留空会拒绝所有请求 |
| `REPO_DIR` | 当前目录 | 镜像仓库目录 |
| `GITHUB_REMOTE` | `github` | GitHub 远程别名 |
| `TIME_TOLERANCE_MS` | `3600000` | 时间戳容差（1 小时，与 Gitee 一致） |
| `PUSH_EVENTS` | `Push Hook,Tag Push Hook` | 视为推送的事件名，逗号分隔 |
| `GITHUB_TOKEN` / `GITHUB_OWNER` / `REPO_NAME` | 空 | 首次推送若 GitHub 仓库不存在，自动建仓所需；留空则跳过自动建仓 |

健康检查：`GET /` 或 `GET /healthz` 返回 `sync-receiver ok`。

### 3.1 用 systemd 常驻（推荐）

参考 `scripts/sync-receiver.service.example`，放到 `/etc/systemd/system/sync-receiver.service`，然后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sync-receiver
```

### 3.2 用 pm2 常驻

```bash
npm i -g pm2
GITEE_SECRET=... REPO_DIR=/srv/mserm-crm-mirror pm2 start scripts/sync-receiver.mjs --name sync-receiver
pm2 save
```

## 4. 在 Gitee 配置 WebHook

1. 打开 Gitee 仓库 → **管理 → WebHooks → 添加 WebHook**。
2. **URL**：`https://你的服务器域名或IP:端口/webhook/gitee`（建议走 HTTPS + 反向代理）。
3. **WebHook 密码/密钥**：填与 `GITEE_SECRET` 完全相同的字符串。
4. 勾选 **签名验证**（推荐，开启后 Gitee 会用 HMAC-SHA256 对每次请求签名，头部带 `X-Gitee-Token` + `X-Gitee-Timestamp`）。
5. **事件**：勾选 **Push**（推送）。
6. 保存后点 **测试**，接收端日志应出现 `sync ok`，GitHub 仓库应出现本次提交。

> 若服务器在内网、Gitee 无法访问公网地址，需要用内网穿透（frp / ngrok / 花生壳）把 `/webhook/gitee` 暴露出去，或改用主动轮询（不在本文档范围）。

## 5. 验证与排错

- 接收端日志关键字：`listening on :8080`、`fetch -p origin ...`、`push --mirror github ...`、`sync ok`。
- 401 `signature mismatch`：Gitee 密钥与 `GITEE_SECRET` 不一致，或服务器时间与 Gitee 相差超过 1 小时（检查 NTP）。
- `repository not found`：GitHub 远程 URL / 令牌错误；若已配置 `GITHUB_TOKEN`+`GITHUB_OWNER`，接收端会自动建仓后重试。
- GitHub 只收到部分分支：确认 `REPO_DIR` 是用 `git clone --mirror` 得到的镜像仓库，而非普通克隆（普通克隆 `push --mirror` 只推本地已有分支）。

## 6. 安全建议

- **HTTPS + 反向代理**：不要在公网裸奔 HTTP；前面套 Nginx/Caddy 做 TLS，并限制来源 IP（仅放行 Gitee 的 WebHook 出口段）或使用随机路径。
- **密钥强度**：`GITEE_SECRET` 用足够长的随机串；GitHub 令牌使用仅含 `repo` 范围的 fine-grained 或 classic PAT，定期轮换。
- **令牌存放**：示例用令牌内嵌远程 URL 最省事；更安全可用服务器本机 `git credential store` 或 SSH key，避免令牌明文出现在 remote URL。
- **最小暴露**：接收端只暴露 `/webhook/gitee` 一个 POST 端点，其它路径返回 404；签名校验失败即 401，不会触发任何 git 操作。
- **与代码同步**：接收端脚本随仓库进版本库，因此它本身也会随其它改动一起被镜像到 GitHub——同步工具自动同步自己，无需单独维护。

## 7. 三种方法速查

| 方法 | 做法 | 优点 | 缺点 |
|------|------|------|------|
| 一（内置推送镜像） | Gitee 后台填 GitHub 令牌做推送镜像 | 零服务器、零代码 | GitHub 令牌需交给 Gitee |
| **二（本文，WebHook+接收端）** | Gitee 回调自有服务执行 `git push --mirror` | 令牌留在本机、可控、可扩展 | 需一台常驻服务器 |
| 三（本地双远程） | 本地 `scripts/publish.sh both` 一次推两边 | 最简单、无需服务器 | 每次需手动/脚本触发，非自动 |

> 本仓库已内置 `scripts/publish.sh both`（方法三）可直接一次性推送两边；方法二在其之上实现了「推一次 Gitee 即自动到 GitHub」的持续同步。
