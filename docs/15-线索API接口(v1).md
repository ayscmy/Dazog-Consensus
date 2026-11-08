# 15 · 线索 API 接口（v1）

> 让官网表单、企业微信、市场活动页或第三方系统，把线索**直接推送到 CRM**，无需人工录入。
> 接口走独立的 API 密钥鉴权（不看登录态、可跨域），由**系统管理员**在「用户与组织 → API 接入」里开通并授权。

---

## 1. 它解决什么

界面里录入线索是给人用的；当线索来自网站表单、广告落地页、呼叫中心坐席系统时，需要机器直接写库。

但「对外暴露写库能力」风险很高，所以这套接口设计了四道闸门，**四道同时过才放行**：

1. **密钥对得上** —— 库里只存密钥的 SHA-256，明文只在开通 / 重置时给一次；
2. **来源 IP 在白名单** —— 只认授权的服务器 IP（支持单 IP、网段、通配）；空名单 = 全部拒绝；
3. **来源域名在白名单** —— 校验 `Origin` / `Referer` 的域名（支持精确域名与 `*.example.com`）；
   **留空 = 不校验**，一旦填写就变成硬性校验；
4. **没超限** —— 每个接入方单独算「每分钟速率 + 每日配额」，超了返回 429。

> IP 与域名的「空名单」语义**故意相反**：
> IP 是服务器固有的，空名单说明没配好，宁可拦住；
> 域名则相反——服务器对服务器调用通常不带 `Origin` / `Referer`，
> 若空名单也全拒绝，会把所有纯 IP 接入方一次性打死。
> 只有在「浏览器端直连」或「对方愿意显式传 Origin」时才建议启用域名校验。

另外，接入方**看不到全集团数据**：它只能读写「所属组织子树」内的线索，密钥泄露也不会把别人的客户拖出来。

---

## 2. 管理员如何开通与授权

路径：**用户与组织 → API 接入**。

> **仅超级管理员（`admin`）可操作。** 销售总监、销售经理虽然能进「用户与组织」
> 管理人与组织，但看不到这个页签；即使直接调接口也会被 403 拦下
> （`只有系统管理员可以开通和授权 API 接入`）。原因是这条路等于给外部系统开写库权限，
> 不该随组织管理权限一起下放。演示环境只读禁用。

| 动作 | 说明 |
| --- | --- |
| 开通 API 接入 | 填接入方名称、默认线索负责人、接口权限、授权 IP、**授权域名**、限额，提交后**生成一对密钥**（明文只显示这一次） |
| 编辑 | 改授权 IP、授权域名、权限范围、限额、到期日、负责人 |
| 授权 IP | 每行一条：`10.0.1.20` / `10.0.0.0/16` / `192.168.1.*` / `*`。**空 = 全部拒绝** |
| 授权域名 | 每行一条：`api.partner.com`（只匹配自身）/ `*.partner.com`（含任意层级子域）/ `*`。**空 = 不校验** |
| 重置密钥 | 旧密钥立即失效，新密钥只显示一次 |
| 停用 / 启用 | 停用后该密钥立即 403，可随时恢复 |
| 撤销 | 密钥永久失效且不可恢复，只能重新开通 |
| 连通性自检 | 输入一个 IP（可选填来源域名），回答「现在能不能进」以及不通过的原因 |
| 接口调试台 | 在浏览器里直接发一次真实请求，走线上同一套鉴权，马上看到响应 |
| 调用日志 | 每次外部调用的 时间 / 接入方 / 请求 / 状态 / 耗时 / 来源 IP，失败可点开看请求体与报错 |

**转交线索负责人**：外部推来的线索默认挂在「默认负责人」名下，可见范围按该负责人的组织算；请求里带 `owner_id` 可指定到具体销售。

**未指定负责人时（线索公海一期新增）**：若请求没带 `owner_id`、且接入方未配置默认负责人，线索不再直接报错，而是**进入线索公海**——`leads.owner_id = NULL`，写 `pool_at` / `pool_reason='api'` / `pool_count=1`，并记 `pool_events(action='api_in')`，由组织内成员在「公共池」页领取。`org_id` 取接入方所属组织，未配置时退回根组织。接入方可在后台关闭该行为（`pool_on_missing=0`），关闭后保留旧版「请管理员先配置默认负责人」报错；`POST /api/v1/leads/batch` 同样适用。`PATCH /api/v1/leads/:id` 更新负责人不会把线索静默放回池。该入池链路已由 `scripts/pool-check.mjs` 的 TC-12d~12h 用真实 HTTP 请求端到端验证（见 `docs/20` 第 12 节）。

---

## 3. 鉴权方式

请求头二选一：

```http
Authorization: Bearer crm_xxxxxxxxxxxxxxxxxxxxxxxx
X-API-Key: crm_xxxxxxxxxxxxxxxxxxxxxxxx
```

- 支持跨域（CORS），预检 `OPTIONS` 直接放行；
- 不依赖登录 Cookie，适合服务器对服务器调用；
- 命中失败也写调用日志，排查时有据可查；
- **配置了授权域名时**，请求必须声明来源：

```http
Origin: https://crm.partner.com
```

  浏览器发起的跨域请求会自动带 `Origin`；服务器调用需要自己显式加上。
  只认 `Origin`，没有则退回 `Referer` 取域名。
  **不会**拿 `Host` 兜底——`Host` 是「打到 CRM 身上的域名」，不是调用方的域名，
  拿它凑数只会让人误以为「配了却过不去」。

返回统一信封：`{ "ok": true, "data": { ... } }`。

---

## 4. 接口清单

所有路径前缀 `/api/v1`。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/ping` | — | 连通性自检，返回当前授信信息、剩余配额 |
| GET | `/leads/meta` | `lead:read` | 状态枚举、可写字段、示例报文 |
| GET | `/leads` | `lead:read` | 分页查询（status / source / owner_id / external_id / since / q / limit / offset） |
| GET | `/leads/:id` | `lead:read` | 线索详情（含最近 50 条跟进记录） |
| POST | `/leads` | `lead:write` | 新建线索；带 `external_id` 时幂等 |
| PATCH | `/leads/:id` | `lead:write` | 局部更新，只传要改的字段 |
| POST | `/leads/:id/activities` | `lead:write` | 写一条跟进记录（call/visit/email/meeting/note/wechat） |
| POST | `/leads/batch` | `lead:write` | 批量导入，单次最多 200 条，逐条返回成败 |

---

## 5. 请求示例

### 5.1 先验证连通性

```bash
curl -X POST 'https://你的域名/api/v1/ping' \
  -H 'Authorization: Bearer crm_xxxxxxxxxxxxxxxxxxxxxxxx'
```

返回（通过鉴权时）：

```json
{
  "ok": true,
  "data": {
    "service": "MSERM CRM · 线索 API",
    "version": "v1",
    "client": { "client_id": "ak_xxxx", "name": "官网表单", "scopes": ["lead:read", "lead:write"] },
    "ip": "203.0.113.7",
    "rate_limit": 60,
    "quota": { "limit": 5000, "used": 12, "left": 4988 },
    "expire_at": null,
    "server_time": "2026-10-31T09:00:00.000Z"
  }
}
```

### 5.2 推送一条线索

```bash
curl -X POST 'https://你的域名/api/v1/leads' \
  -H 'Authorization: Bearer crm_xxxxxxxxxxxxxxxxxxxxxxxx' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "杭州云舟智能装备有限公司",
    "external_id": "WEB-2026-1031-001",
    "contact_name": "王海涛",
    "contact_title": "信息化总监",
    "contact_phone": "13800001234",
    "contact_email": "wang@example.com",
    "source": "官网表单",
    "industry": "装备制造",
    "region": "浙江杭州",
    "demand": "希望打通车间报工与 ERP，Q1 完成选型",
    "budget": "50-80 万",
    "purchase_time": "2027-Q1"
  }'
```

成功返回（201）：

```json
{ "ok": true, "data": { "id": 30, "duplicated": false, "name": "杭州云舟智能装备有限公司", "status": "new", "owner_id": 1, "owner_name": "系统管理员", "created_at": "..." } }
```

### 5.3 幂等（重复推送不建重）

带相同 `external_id` 再次 `POST /leads`：返回原记录且 `duplicated: true`（200），不会新建。外部系统可放心重试。

### 5.4 局部更新

```bash
curl -X PATCH 'https://你的域名/api/v1/leads/30' \
  -H 'Authorization: Bearer crm_xxxxxxxxxxxxxxxxxxxxxxxx' \
  -H 'Content-Type: application/json' \
  -d '{ "next_action": "安排现场演示", "next_date": "2026-11-10", "score": 88 }'
```

### 5.5 写跟进记录

```bash
curl -X POST 'https://你的域名/api/v1/leads/30/activities' \
  -H 'Authorization: Bearer crm_xxxxxxxxxxxxxxxxxxxxxxxx' \
  -H 'Content-Type: application/json' \
  -d '{ "type": "call", "content": "已电话沟通，确认预算与选型时间", "result": "有意向", "next_action": "发送方案", "next_date": "2026-11-11" }'
```

写跟进会把线索状态从 `new` 推进到 `contacted`，并刷新 `last_activity_at`。

### 5.6 批量导入

```bash
curl -X POST 'https://你的域名/api/v1/leads/batch' \
  -H 'Authorization: Bearer crm_xxxxxxxxxxxxxxxxxxxxxxxx' \
  -H 'Content-Type: application/json' \
  -d '{ "leads": [ {"name":"客户A","external_id":"B-001"}, {"name":"客户B","external_id":"B-002"} ] }'
```

返回（部分失败用 207）：

```json
{ "ok": true, "data": { "total": 3, "created": 2, "duplicated": 0, "failed": 1, "errors": [{ "index": 2, "message": "name（线索名称）不能为空" }], "ids": [{"index":0,"id":31},{"index":1,"id":32}] } }
```

### 5.7 查询

```bash
curl 'https://你的域名/api/v1/leads?status=new&since=2026-10-30T00:00:00Z&limit=20' \
  -H 'Authorization: Bearer crm_xxxxxxxxxxxxxxxxxxxxxxxx'
```

返回 `{ "ok":true, "data": { "total": 30, "count": 20, "limit": 20, "offset": 0, "rows": [ ... ] } }`。
`since` 用于增量同步（只取该时间后有变动的线索）。

---

## 6. 错误码

| 状态码 | 含义 | 排查方向 |
| --- | --- | --- |
| 400 | 参数错误（缺 name / JSON 非法 / 字段格式错） | 看返回里的 `error` 字段 |
| 401 | 缺密钥 / 密钥无效（可能已被重置） | 核对密钥；被重置就重新开通 |
| 403 | IP 不在白名单 / 域名不在白名单 / 权限不足 / 已停用或到期 | 看 `detail.whitelist` / `detail.domains` 与 `detail.hint`；或到「API 接入」加白名单 |
| 404 | 线索不存在或不在该接入方组织范围内 | 确认 `id` 与数据范围 |
| 415 | 非 JSON 提交 | 加 `Content-Type: application/json` |
| 429 | 超速率 / 超日配额 | 降速，次日 00:00 配额重置；`detail.retry_after` 是建议等待秒数 |
| 500 | 服务器内部错误 | 查服务日志 |

所有 4xx/5xx 都为 `{ "error": "可读中文原因", "detail": { ... } }` 结构，对接方凭 `error` 即可定位，无需来回扯皮。

---

## 7. 字段与枚举

`GET /leads/meta` 会返回完整字段定义、状态枚举与示例报文，外部系统**应以此为准**（版本升级时以接口返回的 meta 为准，不要硬编码）。

状态枚举：`new` 待跟进 / `contacted` 跟进中 / `qualified` 已确认 / `converted` 已转商机 / `invalid` 无效。

写入字段：`name`(必填)、`contact_name`、`contact_title`、`contact_phone`、`contact_email`、`source`、`industry`、`region`、`demand`、`budget`、`purchase_time`、`next_action`、`next_date`(YYYY-MM-DD)、`score`(0–100)、`owner_id`、`external_id`。

---

## 8. 安全与运维要点

- **密钥明文只出现一次**：开通 / 重置时显示在弹窗，关闭后只能重置，重置会让旧密钥立刻失效。
- **IP 白名单是安全底线**：空名单 = 全部拒绝；建议填入对方服务器的固定公网 IP，避免用 `*`。
- **域名白名单是补充而非替代**：它防的是「同一台机器上多个站点，其中一个被攻陷后
  拿着密钥从其它域名发起调用」这类场景，**不能**替代 IP 校验。
  纯服务器调用往往不带 `Origin`，此时配了域名反而会 403——按需启用。
- **数据范围隔离**：接入方只能读写自己组织子树内的线索，不会因为密钥泄露看到全集团。
- **授权管理只对超级管理员开放**：销售总监/经理虽有组织管理权限，但看不到也调不通这些接口。
- **审计可追溯**：每一次外部写操作都进审计日志（标记为 `API · 接入方名`），与界面操作同一条流水；每次调用都记调用日志，失败也能复盘。
- **配额自恢复**：日配额按自然日（服务器本地时区）重置，速率限制为进程内滑窗（多实例部署时各算各的，上线前注意）。

---

## 9. 在代码里的位置

| 文件 | 职责 |
| --- | --- |
| `src/api-auth.js` | 密钥哈希校验、IP 匹配、速率 / 配额、调用日志、自检 |
| `src/routes/leads-api.js` | 对外线索 v1 接口（ping / 列表 / 详情 / 新建 / 更新 / 跟进 / 批量） |
| `src/routes/api-admin.js` | 管理端：开通、编辑、重置、撤销、自检、调用日志 |
| `src/http.js` | 对外接口路由分支（`auth: 'api'`）、CORS、调用日志落库 |
| `src/db.js` | `api_clients`、`api_logs` 表结构 |
| `public/js/views/admin.js` | 「API 接入」页：列表、开通表单、密钥弹窗、自检、调试台、日志 |

---

## 10. 官网商业线索池 · 推送出站（四期）

> 来源：官网仓库 `docs/11-公共池与转化承接.md` 第 7 节「通道 3」，CRM 侧总设计见 `docs/20-公共池设计方案.md` 第 4.5 节。
> **本节只描述出站方怎么调本接口，CRM 侧不需要改任何代码**：推送复用的就是第 5.2 节的 `POST /api/v1/leads`。

### 10.1 三条承接通道里，哪条会打到这里

| 通道 | 方向 | 是否调用本接口 |
| --- | --- | --- |
| 1 · 在线试用 | 官网 → CRM 内部接口 `/api/internal/trial/:id/pool-lead` | 否，走 `X-Internal-Key` |
| 2 · 下载版 API 拉取（默认） | 本地 CRM 主动调官网 `GET /api/v1/pool/claims` | 否，官网返回数据，本地 CRM 自己写库 |
| 3 · 下载版 API 推送（可选） | **官网 → 本地 CRM `POST /api/v1/leads`** | **是，本节** |

本地部署多在**内网**、没有公网入站，因此默认推荐通道 2；只有会员登记了自己 CRM 的公网 `base_url` 并配置好白名单，才启用通道 3。

### 10.2 请求形态

官网在会员领取线索成功时同步出站一次：

```bash
curl -X POST 'https://会员CRM域名/api/v1/leads' \
  -H 'Authorization: Bearer crm_xxxxxxxxxxxxxxxxxxxxxxxx' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "集团 CRM 选型 · 华辰智造科技有限公司",
    "external_id": "pool:123",
    "contact_name": "张三",
    "contact_phone": "13800000000",
    "source": "官网公共池",
    "industry": "制造业",
    "region": "华东",
    "demand": "需要一套集团级 CRM 管理 60 人销售团队",
    "budget": "20-30 万"
  }'
```

字段映射（官网 `pool_items` → 本接口 `WRITE_FIELDS`）：

| 官网字段 | 本接口字段 | 说明 |
| --- | --- | --- |
| `title` + `company` | `name` | 用 ` · ` 拼接；CRM `leads` 无 `company` 列，不丢信息 |
| `pool:<claim_id>` | `external_id` | **幂等键，服务端拼装，不信任官网传值** |
| `contact` | `contact_name` | |
| `contact_phone` | `contact_phone` | |
| 固定值 | `source` | `官网公共池` |
| `industry` / `region` / `demand` / `budget` | 同名 | |

### 10.3 幂等与重试（TC-23）

`external_id` 命中 `leads.uq_lead_external` 唯一索引：

- 首次推送 → `201`，`duplicated: false`，新建一条线索；
- 同一 `claim_id` 重放 → `200`，`duplicated: true`，返回原记录，**不新建**；
- 官网侧把 `duplicated` 记进 `delivery`，并写 `pool_api_sync` 审计流水。

官网交付失败（CRM 不可达 / 返回非 2xx）时回滚 `claim_count` 与当日额度，`pool_claims.status='failed'` 保留供重试，重试复用同一个 `claim_id`——因此重试天然安全，不会建重。

### 10.4 白名单配置（部署方必做）

1. 在 CRM 后台「API 接入」生成密钥，把**官网服务器出口 IP**填入该接入方的授权 IP 白名单（第 8 节：空名单 = 全部拒绝）。
2. 域名白名单按需启用：纯服务端出站通常不带 `Origin`，官网会补 `X-Pool-Domain`；若 CRM 侧配了域名规则，请确认规则与之一致，否则按第 8 节会 403。
3. 密钥在官网侧用 AES-256-GCM 加密存 `pool_api_clients.push_secret_enc`，不落明文；CRM 侧看到的仍是一次性显示的那个 Bearer Key。

### 10.5 相关验收

- `TC-22`：官网拉接口只返回该会员自己领过的线索，白名单外 IP 返回 `POOL_API_IP_DENIED`。
- `TC-23`：同一 `claim_id` 重放两次，CRM 只多 1 条，第二次 `duplicated=true`。
- `TC-24`：`since` 增量拉两次，第二次不重复返回。

以上用例在官网仓库 `scripts/pool-check.mjs` 用临时 SQLite + mock 出站跑，不连生产库、不触达真实 CRM。
