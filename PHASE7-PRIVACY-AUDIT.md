# 第七阶段 · 隐私审计与升级（斯诺登思路：隐私优先）

> 工作目录 `~/workspace/mail-ultimate/`（cloud-mail main HEAD `d115f4c` 的 fork）。
> 只做本地开发与测试，未部署线上（无 `wrangler deploy`）；未碰老项目
> mail.flame.edu.kg 的任何配置；未把任何密钥/Token 写进文件或本文档。
> 审计范围：`mail-worker/src/**`、`mail-vue/src/**`、`smtp-relay/src/**`、
> `oracle-patrol/src/**` 全量代码 + 全部 `package.json` 依赖。
> 结论先行：**未发现隐藏上报、埋点、广告 SDK 或闭源黑盒组件**；前端唯一外链
> 脚本是 Cloudflare Turnstile；审计出的 6 项可改项已全部改掉（§5），
> 其余为有意保留或改动成本大的缺口（§6）。

## 1. 最小化日志

### 1.1 逐表审计（改前状态）

| 表 / 存储 | 记了什么 | 判定 |
|---|---|---|
| `login_log` | user_id、email、**完整 IP**、完整 UA（截断 500）、is_new_ip、时间 | ⚠️ IP 应脱敏；UA 已截断 |
| `register_log` | **完整 IP**、ip_segment、email、注册码、结果、失败原因、verify_mode、**完整 UA（未截断）** | ⚠️ IP 应脱敏；UA 未截断 |
| `audit_log` | actor、action、target、**完整 IP**、**完整 UA（未截断）**、detail（JSON，最长 2000 字符） | ⚠️ IP 应脱敏；UA 未截断；detail 经查只含 key 名/状态码等元数据，不含密钥值（`setting-service.js` 的 `setting:update` 只记被改 key 列表） |
| `alert_log` | type、text、source | ✅ 文本为风控告警（熔断/配额/巡检），不含邮件内容 |
| `verify_record` | 类型 + 计数 | ✅ 只有计数，无身份信息 |
| `user` 表 | create_ip、active_ip（**完整 IP，永久保留**）、os/browser/device、send_count | ⚠️ 见 1.3 |
| KV `AUTH_INFO` | tokens + **完整 user 行（含 password hash 与 salt）** | ❌ 已改（§1.4） |
| KV `SESSION_META` | digest → {ua, ip, createdAt}，TTL 30 天 | ✅ 会话必需，随 token 过期 |
| KV 计数类 | `send_day_count`、`resend_day/month`、TOTP 待验证、Passkey challenge、解锁失败计数 | ✅ 只有计数/一次性令牌，无内容 |
| 邮件日志 | 无专门的邮件内容日志；`email` 表本身存正文（见 §2.3） | ✅ 无额外日志 |
| 前端本地 | token（localStorage）、语言/主题偏好（localStorage）、草稿与附件（IndexedDB Dexie，按邮箱分库） | ✅ 只存本机必需项；E2EE 密钥只放内存（`e2ee.js`，源码与运行期均无落盘） |

### 1.2 已改（3 项）

1. **日志 IP 脱敏默认开启**（`init.js` 新增 `v3_8DB`）：`UPDATE setting SET
   log_ip_mask = 1 WHERE log_ip_mask = 0`。此前默认值 0（opt-in 脱敏），且该
   开关无任何前端入口，实际上无人能主动打开。改后 `login_log` /
   `register_log` / `audit_log` 三表写入前 IP 均脱敏（IPv4 末段 → 0，IPv6 只
   留 /64）。`ip_segment` 列与限额/封禁检查不受影响（仍用完整段做风控）。
   副作用：管理员按完整 IP 筛注册/登录日志的能力变弱（只能按脱敏后的段筛），
   这是隐私优先的有意取舍；旧测试 4 处断言已按新默认更新（见 PHASE7-SECURITY.md §6）。
2. **UA 截断统一为 500 字符**：`register-log-service.js` 与
   `audit-log-service.js` 的 `record()` 各补 `.slice(0, 500)`，与 `login_log`
   已有的 500 截断对齐；超长指纹串不再完整存库。
3. **登录历史不记录地理位置**：新增 `GET /security/login-history` 时确认
   `login_log` 无地点列，且**不引入 IP 地理库查询**（那会把用户 IP 发给第
   三方地理服务）。接口 `location` 字段恒为 `null`，前端显示“未记录”，
   并在安全中心注明“出于隐私考虑，本站不记录登录地理位置”。

### 1.3 未改：有意保留的 IP 字段

- `user.active_ip`（完整 IP）：新 IP 检测与异地提醒依赖它做精确比对；改
  脱敏会误判同一 /24 内的正常换 IP。保留，但它只在用户行内，不进日志表。
- `user.create_ip`：管理员用户列表支持按注册 IP 前缀筛查注册机；与
  `register_log.ip_segment` 同属风控必需。
- `register_log.email / reg_key_code / fail_reason`：注册风控必需（查注册
  机、查密钥滥用），且受 `log_retention_days`（默认 90 天）定期清理约束
  （`log-retention-service.js` 每小时清理三张日志表）。

### 1.4 已改：KV 不再存密码材料

`login-service.js` 的 `_issueSession()` 原来把整个 `userRow`（含 password
hash 与 salt）塞进 KV `AUTH_INFO`。鉴权中间件（`security.js`）实际只用
`userId` / `email`。现改为存剔除 `password` / `salt` 后的 `safeUser`，且
每次登录都用本次的 `safeUser` 覆盖旧条目——用户重登一次后，KV 里即不再有
任何密码材料。旧 KV 条目在 30 天 TTL 内自然过期。

## 2. 默认加密

### 2.1 覆盖面审计（改前状态）

| 敏感字段 | 存储方式 | 判定 |
|---|---|---|
| `setting.secretKey`（Turnstile 密钥） | `enc:v1:`（AES-GCM，`field-crypto.js`） | ✅ |
| `setting.tgBotToken` / `s3AccessKey` / `s3SecretKey` | `enc:v1:` | ✅ |
| `setting.githubClientSecret` / `googleClientSecret` / `linuxdoClientSecret` | `enc:v1:` | ✅ |
| `setting.resendTokens`（整段 JSON） | `enc:v1:` | ✅ |
| `setting.webhookSecret` | **明文** | ❌ 已改（§2.2） |
| `user_totp.secret_encrypted`（TOTP 密钥） | `enc:v1:` | ✅ |
| `user_passkey.public_key_jwk`（Passkey 公钥） | 明文 | ✅ 公钥本身不是秘密，无需加密 |
| `user_security.e2ee_salt` | 明文 | ✅ 盐不是秘密（防彩虹表，不防泄露后离线猜测——强度靠加密密码本身） |
| `user.password` | 加盐 hash（`crypto-utils.js`，salt 存 `user.salt`） | ✅ |
| `user.email` 等身份字段 | 明文 | ✅ 邮箱服务必需明文索引 |
| `email` 正文（subject/text/content） | **明文存 D1** | ⚠️ 见 §2.3 |
| 附件 | R2 明文 | ⚠️ 见 §2.3 |
| `FIELD_ENC_KEY` 本身 | 环境变量（wrangler vars / `.deploy.env`，不进仓库） | ⚠️ 单密钥、无轮换，见 §6 |

### 2.2 已改（1 项）

- **`webhookSecret` 纳入字段加密**：`setting-service.js` 的
  `ENCRYPTED_SETTING_FIELDS` 补上 `'webhookSecret'`。写入加密、读出解密，
  老明文存量由 `decrypt` 原样兼容；`get()` 打码逻辑不受影响。测试覆盖
  （`phase7.spec.js`：落库为 `enc:v1:` 信封、密文不含明文）。

### 2.3 未改：邮件正文与附件明文（设计边界，不是疏忽）

- 服务端明文是 webmail 的功能前提：服务端搜索、收件规则、TG/ webhook
  推送、新 IP 提醒、管理员全站检索都依赖它。**可选的端到端加密（E2EE）
  已是第六阶段的答案**：开启后正文在浏览器内加密再上传，服务端只见密文
  信封；代价是放弃服务端搜索、站外收发与附件加密，安全中心有诚实文案说明。
- 附件本阶段不加密（E2EE 文案已写明）。全量附件加密是下一阶段工作，
  需改写上传/下载/预览整条链路，见 §6。

## 3. 数据主权：用户数据用户掌控

### 3.1 已有功能（核实）

- **删除账号**：`DELETE /my/delete`（个人设置页已有入口）→
  `user-service.delete()`。但注意默认是**软删**（见 3.3）。
- **改密码 / 改语言 / 提醒开关 / 保留期限 / E2EE 开关**：均在个人设置页
  与安全中心，用户自助。

### 3.2 已补：导出我的数据（改动小，已做）

- 新增 `GET /my/export`（`security-export-api.js`，登录态、只查本人）：
  返回账号资料（email、注册时间、语言）、安全设置、Passkey 列表、当前
  会话/设备列表、最近 100 条登录历史、邮箱与账号数量统计。
- 刻意不含：邮件正文/附件、任何密钥材料（密码 hash、salt、TOTP 密钥、
  Passkey 公钥原文均不返回）。
- 前端：安全中心新增“我的数据”区，“导出我的数据”按钮下载
  `mail-export-YYYYMMDD.json`。
- 缺口：完整邮箱导出（含正文/附件的 mbox/zip）未做——需分页拉全量邮件
  + 打包 + R2 附件汇聚，量级大一档，见 §6。

### 3.3 缺口：删除默认只是软删（未改，需用户/总协调定）

- `setting.sync_delete` 默认 `1 = CLOSE`：用户自删账号时只把 `user.is_del`
  置 1，邮件、账号、OAuth 绑定、登录历史**全部保留**，管理员可恢复。
  只有管理员把 `sync_delete` 设为 `0 = OPEN` 后，自删才走物理删除。
- 本次在物理删除路径上补了清理（`user-service.physicsDelete()`）：除原
  有的邮件/账号/OAuth/收藏外，**一并删除该用户的 `login_log` 行、
  `user_totp` / `user_passkey` / `user_security` 行与 `SESSION_META`
  KV**，删号后不再留孤儿安全数据。测试覆盖。
- 有意保留：`audit_log` / `register_log` 的行不随删号清除——前者是管理
  员操作留痕（删号本身也要留痕），后者是风控计数；两者都受
  `log_retention_days`（默认 90 天）定期清理约束。
- 待定项：是否给用户一个“彻底删除（不可恢复）”的自助选项（即把
  `sync_delete` 的选择权从管理员下放到用户本人）。这是一句话的产品决
  定，代码改动约半天（自删接口加 `hard=true` 参数 + 二次确认文案），
  本次未擅自改默认行为。

## 4. 透明开源：第三方依赖与外部服务清单

核查方法：全部 `package.json` + 全仓 `fetch(` / 外链脚本 grep。
结论：**无埋点、无广告 SDK、无数据上报组件；代码全部在仓库内。**

### 4.1 运行时依赖（npm，均开源）

| 包 | 用途 | 必需？能否替换 |
|---|---|---|
| `@cloudflare/vite-plugin`（Worker） | 本地开发构建插件 | 开发期必需；不进线上包 |
| `hono`（Worker） | HTTP 框架 | 必需；可换为原生 `fetch` 手写路由，但无收益 |
| `drizzle-orm` | D1 查询 | 必需；可换 `env.db.prepare` 裸 SQL（已有部分这样用） |
| `resend` | Resend 发信 SDK | 备用通道必需；可换裸 `fetch` 调 Resend REST API |
| `@aws-sdk/client-s3` | S3 兼容存储（附件） | 仅附件走 S3 时必需；R2 绑定可不经它 |
| `postal-mime` | 收信 MIME 解析 | 必需；替代品同类解析库，无自研必要 |
| `linkedom` | 服务端 HTML 清洗/解析 | 必需；与 DOMPurify（前端）分工 |
| `ua-parser-js` | UA 解析 | 必需；本阶段新增登录历史设备解析复用它 |
| `dayjs`、`uuid`、`i18next` | 日期/ID/后端 i18n | 必需；均为小体积工具库 |
| `vue`、`vue-router`、`pinia`、`element-plus`、`axios`（前端） | 应用框架/UI/请求 | 必需；换框架等于重写 |
| `dexie`（前端） | IndexedDB 草稿/附件 | 必需；可换裸 IndexedDB API |
| `dompurify`（前端） | 邮件 HTML 消毒 | 必需（防 XSS）；不可省 |
| `echarts`（前端） | 统计图表 | 仅统计页用；可删但会丢图表 |
| `mailparser`（smtp-relay） | SMTP 附件 MIME 解析 | 必需；与 `postal-mime` 同类 |
| `oracle-patrol` | **零运行时依赖** | — |
| `@cf/meta/llama-3.1-8b-instruct` 等（Workers AI，本阶段 AI 同事新增） | 开源权重模型 | 开源路线；不接闭源商业 API |

开发依赖：`vitest`、`@cloudflare/vitest-pool-workers`、`wrangler`、
`vite` 等——只影响本地开发与测试，不进线上包。

### 4.2 外部服务（逐个说明）

| 服务 | 用途 | 必需？能否替换 |
|---|---|---|
| Cloudflare Workers / D1 / KV / R2 / Email Routing / Email Sending | 整站运行底座 | 必需（项目架构即 Cloudflare 原生优先）；替换等于换平台 |
| Cloudflare Turnstile | 注册/登录人机验证 | 必需；前端唯一外链脚本（`challenges.cloudflare.com`）；可换 hCaptcha，但同为第三方验证 |
| Resend | 备用发信通道 | 备用必需；主通道是 CF Email Sending；可换任意 SMTP 服务 |
| Telegram Bot API | 风控告警 + 新邮件推送（均可选） | 可选；不配 token 时只写库不发 TG。推送内容受 `tg_msg_*` 控制，`tgMsgText` 默认 `hide`（不推正文） |
| S3 兼容存储 | 附件存储（可选） | 可选；默认走 R2 绑定 |
| GitHub / Google / Linuxdo OAuth | 第三方登录（可选） | 可选；关闭后只剩密码登录 |
| Cloudflare Tunnel | SMTP 入口（`smtp-relay` 用） | SMTP 功能必需；直连甲骨文 IP 已明令禁止 |
| Workers AI（Llama 开源权重） | AI 写信/回信/摘要（本阶段新增，可开关） | 可选（`setting.ai_enabled` 默认开，可关）；开源权重，不接闭源 API |
| Oracle（甲骨文）两台机器 | 巡检、备份、监控、SMTP 守护进程（服务器之间） | 运维侧；用户直连入口一律走 CF 边缘，不直连甲骨文 IP |

### 4.3 需提醒管理员的两个数据外流点（设计如此，非 bug）

1. **Webhook**：管理员配了 `webhookUrl` 后，每封新邮件的**完整内容**
   （subject/text/content/code）都会 POST 到该 URL。这是功能本身
   （`webhook-service.js`），只建议指向自己掌控的端点；无用户侧开关。
   本次已把 `webhookSecret`（用作 `Authorization` 头）纳入字段加密。
2. **Telegram 新邮件推送**：管理员开启后，邮件摘要发往 TG 聊天；正文
   默认不推（`tgMsgText=hide`），且“查看全文”走带 JWT 的 WebApp 链接，
   不直接把正文贴进 TG 消息。

## 5. 本次改动汇总

| # | 改动 | 文件 |
|---|---|---|
| 1 | 日志 IP 脱敏默认开启（`log_ip_mask` 0→1） | `mail-worker/src/init/init.js`（`v3_8DB`） |
| 2 | UA 截断统一 500 字符 | `mail-worker/src/service/register-log-service.js`、`audit-log-service.js` |
| 3 | 登录历史不记地点（`location: null`） | `mail-worker/src/api/security-login-history-api.js`（新增） |
| 4 | KV `AUTH_INFO` 不再存密码 hash/salt | `mail-worker/src/service/login-service.js` |
| 5 | `webhookSecret` 纳入字段加密 | `mail-worker/src/service/setting-service.js` |
| 6 | 新增导出我的数据 `GET /my/export` + 前端入口 | `mail-worker/src/api/security-export-api.js`（新增）、`mail-vue/src/request/security.js`、`mail-vue/src/views/security/index.vue` |
| 7 | 物理删除一并清登录历史与安全行 | `mail-worker/src/service/user-service.js` |
| 8 | 测试覆盖上述改动 | `mail-worker/test/phase7.spec.js`（新增，11 个用例） |

## 6. 未做与缺口（按优先级）

1. **完整邮箱导出**（含正文/附件的 mbox 或 zip）：量级大，需分页 + 打包 + R2 汇聚；本次只做了元数据级导出。
2. **附件端到端加密**：需改写上传/下载/预览整条链路；E2EE 文案已诚实说明附件不加密。
3. **自助彻底删除选项**：产品决定待定（§3.3）；代码约半天。
4. **`FIELD_ENC_KEY` 单密钥、无轮换**：换 key 后老信封无法解密（`decrypt` 遇失败原样返回，不会丢数据但会读回密文）；轮换需双 key 过渡期，未做。
5. **邮件正文服务端明文**：功能前提，E2EE 为可选答案（§2.3）；不打算也不应“假装”全站端到端。
6. **`user.active_ip / create_ip` 完整 IP 永久保留**：新 IP 检测与注册机风控必需（§1.3），保留但收敛在用户行内，不进日志表。
