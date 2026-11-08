# 终极版邮箱 · 第二至四阶段交付记录

> 状态：**已完成——A/B/C 三路全部交付，总协调集成验证通过，未部署**（部署等用户上传 GitHub 后按 `DEPLOY.md` 一键部署）。
> 工作目录：`~/workspace/mail-ultimate/`（cloud-mail main HEAD `d115f4c` 的 fork，未提交）。
> 分工契约：`PHASE2-4-CONTRACT.md`。第一阶段见 `PHASE1.md`（vitest 23/23）。
> 新站域名：**aevorynthtech.com**（2026-11-08 12:46 定）。老站 mail.flame.edu.kg 全程不动。

## 1. 架构原则与决策（用户 2026-11-08 12:57、13:00 定，不可再改）

### 1.1 充分利用 Cloudflare（CF 原生优先）

凡是 Cloudflare 原生能做的，优先用 Cloudflare，不自己另起炉灶、不引外部服务。
唯一例外是 SMTP 发信（见 §2）：Workers 跑不了原生 SMTP 服务（不监听 25/587 端口）。

组件对照（终极版最终形态）：

| 能力 | 选型 | 是否 CF 原生 |
|---|---|---|
| Web + API | Workers（Hono） | ✅ 原生 |
| 数据库 | D1 | ✅ 原生 |
| 设置缓存 / 会话 / 计数 | KV | ✅ 原生 |
| 附件存储 | R2 | ✅ 原生 |
| 收信 | Email Routing（Email Workers） | ✅ 原生 |
| 发信 | Email Sending（优先）+ Resend（备用通道） | ✅ 原生优先；Resend 仅为备用发信通道（用户 2026-11-08 13:21 定：主通道 CF Email Sending，Resend 免费版做备用，配额保护不变；CF Email Sending 发任意收件人需 Workers Paid——用户已在付 $5/月，不用多花钱，含 3000 封/月，超量 $0.35/1000 封；免费版只能发给自己验证过的地址；启用条件：Worker 须绑定名叫 `email` 的 `send_email` 绑定，只绑 `forward` 不算，见 `DEPLOY.md` §2.2） |
| 人机验证 | Turnstile | ✅ 原生 |
| 边缘封禁 | WAF 自定义规则 | ✅ 原生 |
| 边缘限流 | Workers Rate Limiting（见 §1.3 审计项） | ✅ 原生（待补） |
| 定时任务 | Workers Cron Triggers（每小时） | ✅ 原生 |
| 风控巡检 | 甲骨文服务器（用户决定，见 §1.3） | ⚠️ 例外：用户定为场外大脑 |
| 监控面板 | Uptime Kuma（甲骨文） | ⚠️ CF 无等价原生监控面板，沿用用户已有 infra |
| 备份 | 甲骨文备份同步（D1 导出 → 甲骨文） | ⚠️ 见 §1.3 未来可选项 |
| 发信（第三方客户端） | SMTP 中继（甲骨文 + CF Tunnel，见 §2） | ⚠️ 例外：Workers 跑不了原生 SMTP |
| IP 信誉数据 | AbuseIPDB API | ⚠️ CF 无等价信誉库 |
| 告警通知 | Telegram Bot API | ⚠️ CF 无通知服务 |

### 1.2 中国用户访问硬约束（用户 2026-11-08 13:00 定）

**任何用户直接访问的入口都不得指向甲骨文 IP，必须走 Cloudflare 边缘。**
甲骨文只做服务器之间的活（巡检读 D1、调 CF API、备份、监控），用户碰不到。

- 网站与收发信：全在 CF 上（Workers / D1 / Email Routing / Email Sending），与现网 mail.flame.edu.kg 的跑法一致，国内学生注册使用没问题，保持不变。
- SMTP 入口：服务可跑在甲骨文上，但对外必须经 Cloudflare Tunnel（cloudflared）暴露在 `smtp.aevorynthtech.com` 上——用户连 CF 边缘，再由隧道进甲骨文；绝不能让用户客户端直连海外 IP（国内可能慢或连不上）。
- 禁止事项：不在任何用户可见位置（页面、文档、邮件、配置向导）写甲骨文 IP（129.225.13.58 等）；DNS 不得有记录指向甲骨文；部署文档里的甲骨文地址只出现在服务器运维章节，并标注“仅服务器之间使用”。

### 1.3 已有方案的 CF 原生审计（按用户要求检查，有无能换成 CF 原生的地方）

| 检查点 | 现状 | 结论 |
|---|---|---|
| 注册接口限流 | 第一阶段用 `register_log` 表计数实现（DB 层） | 可加强：补 Workers Rate Limiting 绑定（`wrangler.toml` 的 `[[ratelimits]]`，`/register` + `/login` 每 IP 每分钟 5 次）作为边缘前置过滤，DB 层检查保留为权威执行。**第五阶段跟进，不动已通过的第一阶段代码。** |
| 风控巡检 | 甲骨文 Node 服务（第二阶段） | 存在 CF 原生替代（定时触发的 Worker + D1 绑定直读 + fetch 调 CF API），但**不换**：① 用户已定甲骨文巡检自动封（6 项决定第 5 条）；② 巡检负载不占在线 Worker；③ AbuseIPDB/TG 调用走甲骨文不耗 Worker 资源。属有意识的例外，不是遗漏。 |
| 收信两阶段收尾 | 每小时 cron 调 `completeReceiveAll()` 兜底（学习报告 §8 坑 12） | 未来可用 Queues（收信入队 → 消费确认）替代 cron 兜底，属优化项，不在本阶段做。 |
| 备份 | 甲骨文备份同步 | 未来可用定时触发的 Worker 把 D1 导出写进 R2（全 CF 原生），甲骨文只留副本。本阶段仍按甲骨文方案（用户已定两台甲骨文的分工）。 |
| 监控 | Uptime Kuma（甲骨文） | CF 无原生 uptime 监控面板，保留；巡检另支持 Kuma push 心跳（见 `oracle-patrol/README.md`）。 |
| 发信通道 | CF Email 优先、Resend 备用 | 已是 CF 原生优先；未来若 CF Email Sending 容量足够，可评估去掉 Resend（届时再定，现在不做）。 |

## 2. SMTP 发信设计（第五阶段实施，本阶段只定方案）

> 用户 2026-11-08 12:57 确认：新站支持 SMTP 发信，用户能在 Outlook、Thunderbird、手机自带邮箱 App 等第三方客户端里配 SMTP 发邮件。IMAP 收信用户没提，**先只做 SMTP 发信，不要扩到 IMAP**。

### 2.1 方案选定：A）甲骨文 SMTP 中继（经 CF Tunnel 暴露）

二选一的结果：**选 A**。B）第三方 SMTP 中继被否：引入外部服务违反 §1.1 的 CF 原生优先原则（多一个厂商、多一份费用与锁定）；甲骨文服务器用户已有，零新增成本。

Workers 不能跑原生 SMTP 的原因：Workers 不监听 TCP 25/587 端口，没有原生 socket 服务端；Cloudflare Email Routing 只管收信、Email Sending 只有 API 没有 SMTP 提交端点。

### 2.2 架构：SMTP 守护进程只是协议适配器，不自造发信链路

```
Outlook / Thunderbird / 手机邮箱 App
  │  smtp.aevorynthtech.com:587 (STARTTLS) / :465 (隐式 TLS)
  ▼
Cloudflare 边缘（TLS 终止）── Cloudflare Tunnel (cloudflared) ──▶ 甲骨文 SMTP 守护进程
  │                                                              （Node.js，协议适配器）
  │  ① SMTP AUTH：调 Worker POST /login 验用户邮箱+密码
  │  ② 解析 MIME → 调 Worker POST /email/send（用户本人 JWT）
  ▼
Worker（现有 email-service.send() 全套检查：角色发信次数、Resend 配额、渠道优先级）
  │  发信成功后 Resend 用量自动计数（send() 内已有 recordResendSent）
  ▼
CF Email Sending / Resend 发出
```

关键点：

- **不新增 Worker 发信端点。**守护进程以用户身份调现有接口：先 `POST /login`（用户邮箱 + 密码）拿用户 JWT，再 `POST /email/send`（把解析后的 MIME 映射成 `accountId / receiveEmail / subject / text / content / attachments`）。角色发信次数、Resend 配额、渠道优先级、黑名单检查全部沿用现有逻辑，**SMTP 发信与网页发信计入同一配额**（用户要求）。
- **认证**：SMTP AUTH LOGIN / PLAIN，用户名 = 完整邮箱地址，密码 = 站内密码；每次连接调 `/login` 验证（顺带校验 `isDel` / `BAN` 状态，被封/被删账号直接拒）。发件人（FROM）必须是该用户自己的 `@aevorynthtech.com` 邮箱（调 `/email/send` 时 `accountId` 归属校验已覆盖，冒充他人发件会被 `sendEmailNotCurUser` 拒绝）。
- **端口与加密**：对外只开 587（STARTTLS，强制加密后才允许 AUTH）与 465（隐式 TLS）；禁止 25 端口提交与明文 AUTH。TLS 由 CF 边缘终止，边缘 → 甲骨文走 Tunnel 加密通道；客户端永远连的是 CF 边缘，不是甲骨文 IP（§1.2）。
- **限流与防滥用（守护进程内，内存态即可）**：每 IP 并发连接上限、每小时 AUTH 尝试上限、AUTH 连续失败 5 次临时封该 IP（内存黑名单 + 记日志）；所有 AUTH 尝试记本地日志，异常阈值走 TG 告警（复用巡检的 TG 配置）。Worker 侧的角色次数与 Resend 配额是第二道防线，自动生效。
- **附件**：守护进程用 `mailparser` 解析 MIME（含附件 base64），映射进 `/email/send` 的 `attachments` 参数（格式以 `email-service.js` 的现有约定为准，实施时核对）。
- **部署**：主服务跑 3 核 18G 甲骨文（与巡检同机），`cloudflared` 同机跑 Tunnel；1 核 6G 机上备一份相同配置（服务默认停用，故障时启用）。systemd 单元与配置模板在第五阶段交付；DNS：`smtp.aevorynthtech.com` 由 `cloudflared tunnel route dns` 自动建记录（CNAME 到 Tunnel），**不建 MX**（只做提交，不收信；收信仍走 Email Routing）。
- **用户配置向导（部署后写进用户文档）**：服务器 `smtp.aevorynthtech.com`，端口 587 + STARTTLS（或 465 + SSL/TLS），用户名 = 完整邮箱地址，密码 = 站内密码。

### 2.3 不做的事

- IMAP 收信：用户没提，不做。
- 不在守护进程里直调 Resend / 直写 D1 / 直调 CF API 发信：所有发信必经 Worker `send()`，否则配额与风控会被绕过。
- 不在守护进程里存用户密码：AUTH 时现验现忘，只缓存短期 JWT（内存，TTL ≤ 1 小时）。

## 3. 安全加固（第六阶段，设计先行，实施另排期）

> 用户 2026-11-08 13:04 定：斯诺登级别的安全防护 + 个性化。本章只定设计与边界，不在本阶段实施；实施时另起 v3_7DB 迁移与回归清单。

### 3.1 传输与存储加密

- 全站强制 HTTPS：CF 边缘 TLS（TLS 1.2+，TLS 1.3 优先）；Worker 中间件（`security.js`）统一加安全头：`Strict-Transport-Security`（`max-age=31536000; includeSubDomains`；preload 暂不上——进浏览器内置列表后撤回困难，待域名稳定后评估）、`Content-Security-Policy`（`default-src 'self'`；`script-src 'self'`；`style-src 'self' 'unsafe-inline'`——Element Plus 需要 inline style，实施时按实际调整；`img-src 'self' data: blob:`；`connect-src 'self'`；`frame-ancestors 'none'`）、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: strict-origin-when-cross-origin`。注意：Turnstile 脚本来自 `challenges.cloudflare.com`，CSP 里须放行其 `script-src` 与 `frame-src`，实施时实测。
- 静态加密：D1/KV/R2 由 CF 默认静态加密；敏感字段应用层加密：`setting` 表里的密钥类字段（`resend_tokens`、`tg_bot_token`、`secret_key`、GitHub/Google client secret）在写入时用 WebCrypto AES-GCM 加密，密钥放 wrangler secret（`field_enc_key`，部署时生成，与 `jwt_secret` 同样绝不复用老站）；读取时解密；`setting-service.get()` 的打码逻辑保留。TOTP secret 加密存储；Passkey 服务端只存公钥，不存私钥。
- 密码：现有 salt+hash（`saltHashUtils`）保留，不改动。

### 3.2 最小化日志

- 现状已是必要字段：`register_log`（ip、ip_segment、email、reg_key_code、result、fail_reason、verify_mode、ua）、`audit_log`（actor、action、target、ip、ua、detail）、`login_log`（user_id、email、ip、ua、is_new_ip）；不新增画像类字段。
- 定期清理：`setting` 新增 `log_retention_days`（默认 90，0 = 永久保留）；现有每小时 cron 里加清理步骤：删 `create_time` 早于 N 天的 `register_log` / `audit_log` / `login_log`，分批删（每批 ≤500 行，避免 D1 写超时，学习报告 §8 坑 1）。
- IP 脱敏选项：`setting` 新增 `log_ip_mask`（0/1，默认 0）；开启后新写入的日志 IP 做脱敏（IPv4 末段 → 0，如 `1.2.3.0`；IPv6 只存 /64 段）。注意：脱敏只影响日志 `ip` 列的展示与审计追溯；IP 限额与封禁仍用实时检查与 `ip_segment` 字段，不受影响。默认关闭，由管理员决定。

### 3.3 强认证

- TOTP 二次验证（RFC 6238，6 位、30 秒、SHA1）：新表 `user_totp`（user_id、secret_encrypted、enabled、created_time）+ 备份码（10 个一次性码，SHA-256 存 hash，可放 `user_totp` 的 `backup_codes_hash` JSON 列）。流程：密码通过后若用户开启了 TOTP，登录接口返回 `{needTotp: true, totpToken}`（一次性、KV 存、5 分钟过期），前端跳二次验证页，调 `POST /login/totp`（totpToken + code）换正式 JWT；验证失败 5 次锁定该 totpToken。管理端点：`POST /my/totp/setup`（生成 secret + `otpauth://` URL，前端画 QR）、`POST /my/totp/enable`（code 验证后启用）、`POST /my/totp/disable`（需密码 + code）。实现：WebCrypto HMAC-SHA1 手写 TOTP（零新增依赖，约 60 行），不用另引库。
- Passkey / WebAuthn：新表 `user_passkey`（credential_id、user_id、public_key_jwk、counter、transports、name、created_time）。流程：注册：`POST /my/passkey/register-options`（challenge 存 KV，5 分钟过期）→ 前端 `navigator.credentials.create()` → `POST /my/passkey/register`（验签）；登录：`POST /login/passkey-options`（按邮箱取 challenge）→ `navigator.credentials.get()` → `POST /login/passkey-verify`（验签 + counter 防重放，通过后发 JWT）。实现：用 `@simplewebauthn/server`（业界标准，实施时评估版本与 Workers 兼容性）；RP ID = `aevorynthtech.com`，origin = `https://aevorynthtech.com`。Passkey 与密码登录并存，不强制迁移；丢失设备时用密码 + TOTP 恢复。
- 登录历史与设备管理：`login_log`（第二阶段）即登录历史；设备管理：KV `AUTH_INFO` 存了 tokens 数组（每台设备一个 token）。新端点：`GET /my/sessions`（列出当前有效会话：token 摘要前 8 位标识 + 设备信息，token 完整值绝不返回）、`POST /my/sessions/revoke`（`{token: <摘要>}` 踢出指定设备，或 `{allExceptCurrent: true}` 踢出其他全部设备）。前端在安全中心里展示。

### 3.4 个性化安全中心（每用户自调，不是全局一刀切）

- 新表 `user_security`（user_id、login_alert、e2ee_enabled、retention_days；实施时定，倾向独立表，语义干净）。设置项：
  - `login_alert`（默认 1）：异地登录提醒开关。第四阶段先全量开启；第六阶段接入本开关，关闭后不再发提醒（登录历史照常记）。
  - `e2ee_enabled`（默认 0）：可选端到端加密（见 §3.5）。
  - `retention_days`（默认 0 = 永久保留）：用户自选自己数据的保留期限（30/90/365 天或永久）；cron 里按用户设置软删除超期邮件（仅删自己的邮件；先软删 `is_del=1`，保留 7 天缓冲再物理删除——实施时定）。
- 安全中心页：前端 `views/security/index.vue`（菜单挂 permKey，复用 `perm.js` 模式）：安全评分、TOTP 开关、Passkey 管理、登录历史、设备管理、提醒开关、保留期限、E2EE 开关（带诚实说明文案）。
- 安全评分（展示用，不做强制）：TOTP 开启 +30、Passkey 已注册 +30、登录提醒开启 +20、30 天内无异地登录 +20；满分 100。只展示，不锁功能。

### 3.5 诚实说明：端到端加密的边界（必须写进用户可见文案，绝不夸大）

- 真正的端到端加密（服务器看不到内容）与以下能力是冲突的：服务端全文搜索、Resend/CF 中继发信（中继要明文才能经 SMTP 发出）、服务端附件处理/预览、管理员协助找回。因此端到端只能做成**可选的、按用户（未来可按文件夹）开启**；开启后：内容在浏览器内用 WebCrypto AES-GCM 加密后再上传，密钥由用户密码派生（PBKDF2，服务端永不存明文密钥）；该用户加密文件夹的邮件不支持服务端搜索、不走 Resend/CF 中继（只能站内收发或提示切换）；**忘记密码 = 加密内容永久无法恢复**（注册/开启时必须明确告知，无后门、无找回）。
- 默认基线（所有用户默认享有，不用开任何开关）：强传输加密（TLS 1.2+ + HSTS）+ 静态加密（CF 默认 + 敏感字段应用层加密）+ 最小日志 + 强认证可用（TOTP/Passkey）+ 异地登录提醒 + 设备管理。营销口径只能说这个基线，**绝不把默认状态说成“端到端加密”**。
- 实施排期：第六阶段，另起 v3_7DB 迁移（`user_totp`、`user_passkey`、`user_security` 三表 + `setting` 的 `log_retention_days`、`log_ip_mask` 两列）与回归清单；本阶段不写代码。

## 4. 集成记录（A/B/C 三路 + 总协调）

### 4.1 阻塞级安全漏洞修复（总协调，2026-11-08）

- **漏洞**：`/registerLog/list` 无鉴权。第一阶段引入的接口；`mail-worker/src/security/security.js` 的 `exclude` 用 `path.startsWith('/register')` 前缀匹配，把 `/registerLog/list` 也当成公开注册接口放行。C 路实证：**无 token 直接调返回 200**（对照组 `/auditLog/list` 无 token 正确返回 401）。任意未登录用户可读全站注册日志（含 IP、邮箱、失败原因）。
- **修复**（只改 `security.js` 三处匹配，全部改为边界匹配 `path === item || path.startsWith(item + '/')`）：
  - `exclude` 判断：公开接口仍按原意放行（`/login`、`/register`、`/oauth` 及其子路径），`/registerLog/list` 不再命中。
  - `requirePerms` 判断与 `userPaths` 权限判断（两处 `findIndex`）：同款边界匹配，防止同类前缀越界（如未来出现 `/userXxx` 误命中 `/user` 权限）。
  - `/public` 前缀判断未动（`/public/*` 本来就是命名空间，有独立 token 校验）。
- **验证**：`test/phase1.spec.js` 23/23 + `test/phase2c.spec.js` 26/26（C 路原 22 个 + 总协调新增 4 个“无 token 调 `/registerLog/list|/auditLog/list|/alertLog/list|/ipBlocklist/list` 应返回 401”回归用例，全过）。**部署前必须修——已修**，回归 20 见 §5。

### 4.2 甲骨文风控巡检（B 路，已完成）

- 交付目录：`oracle-patrol/`（全新目录，与主代码零交集；`git status` 核对仅该目录为新增未追踪内容）。
- 模块：`package.json`（Node ≥ 18、零运行时依赖）+ `.gitignore`（忽略 `config.json` / `state.json` / `*.env`）+ `config.example.json`（只放 `YOUR_xxx` 占位符）+ `patrol.service`（systemd 单元）+ `src/config.js`（读配置 + 环境变量覆盖 + 校验 + 脱敏打印）、`src/d1.js`（D1 REST 只读查询）、`src/worker-api.js`（登录拿 JWT + `/ipBlocklist/add`、`/alertLog/record`、`/quota/resend`，401 重登一次，网络/5xx 重试 3 次）、`src/waf.js`（Rulesets API：只改目标规则 `mail-ultimate-ip-blocklist`，表达式 `http.host eq "aevorynthtech.com" and ip.src in { ... }`，其余规则原样回写）、`src/abuseipdb.js`（`/api/v2/check`，24h 缓存）、`src/telegram.js`（直调 TG Bot API，失败永不抛错）、`src/state.js`（`state.json`：lastWafSync、告警去重、AbuseIPDB 缓存、连续失败次数、lastRun）、`src/patrol.js`（单次巡检 5 步）、`src/index.js`（循环 + `--once` + `--dry-run` + `--config`）。
- 巡检 5 步：① D1 查超限 IP（24h 内注册 > 3）→ 写 `ip_blocklist`（scope=0）+ 同步 WAF + TG 告警；② AbuseIPDB 批量核查近 1h 新注册 IP，有举报的进候选封禁清单（只封有举报的，按用户标准）；③ Resend 配额统计（日 80% 每天 1 次、月 100% 立即告警）；④ WAF 同步（仅 IP 集变化时 PUT）；⑤ 失联检测（连续 3 轮 D1 失败发一次“巡检失联”、恢复后发“巡检恢复”）+ Uptime Kuma push 心跳。
- 验证（实跑，全过）：`npm test`（`node --test`，Node v24.22.1）**10/10 通过**；`node --check` 9 个 `src/*.js` 全过；`--once --dry-run` mock 全流程 exit 0（拟封禁 `203.0.113.10`、日配额 85/100 告警、WAF 拟推送，mock 侧写请求 0 条）；缺配置 `--once --dry-run` 明确报错 exit 1；启动行打印的配置全部密钥均为 `********`。全程未连线上、无真实密钥。
- 未完成项（上线时做）：真实 `config.json` 填写、甲骨文两台部署、`--once --dry-run` + `--once` 实跑、systemd 启用、Kuma push 监控创建；真实 WAF 规则 `mail-ultimate-ip-blocklist` 是否存在、PUT 全量回写是否冲突，需上线时先 `--once --dry-run` 确认；热备手动切换（无自动故障转移）；dry-run 下 AbuseIPDB 查询被跳过（省额度）。
- 部署文档：`oracle-patrol/README.md`（systemd 部署、热备、排障全套）。

### 4.3 第三阶段后台（C 路，已完成；交付文档 `PHASE2-C.md`）

- 后端：`mail-worker/src/service/user-service.js`（`:26–33` 新增 `csvEscape()`；`:144` `list()` 解构新增 `createIp` / `createIpPrefix`；`:177–183` IP 筛选，精确优先；`:274–283` 新增 `groupByIp()`；`:285–314` 新增 `exportCsv()`，上限 5000 行超了 400）；`mail-worker/src/api/user-api.js`（`:34–45` 新增 `GET /user/export`，CSV + BOM，文件名 `users-YYYY-MM-DD.csv`；`:47–51` 新增 `GET /user/groupByIp`）；`mail-worker/src/service/analysis-service.js`（`:94–127` `queryEcharts()` 并入 6 个风控查询，各自 `safe()` 包裹不拖垮仪表盘；`:149–158` 返回值新增 `risk: { registerTrend, ipTop10, circuitEvents: { count, open }, regKeyRemaining, resendUsage }`）。
- 前端：`mail-vue/src/views/user/index.vue`（IP 搜索框 + 精确/前缀选择 + 导出按钮 + `createIp` 列）；`mail-vue/src/views/analysis/index.vue`（风控卡片区：注册趋势折线、IP Top 10、熔断状态、密钥剩余、Resend 日/月进度条）；新建 4 页 `views/ip-blocklist/`、`alert-center/`、`register-log/`、`audit-log/` + `perm.js` 路由（`:123–161`）+ 4 个新 request 文件（`ip-blocklist.js`、`alert-center.js`、`register-log.js`、`audit-log.js`，另 `request/user.js` 加 `userExportCsv` / `userGroupByIp`）。
- 验证（实跑）：`test/phase2c.spec.js` 原 22 个全过（总协调修漏洞 + 补 4 个 401 用例后为 26/26）；`test/phase1.spec.js` 23/23 无回归；前端构建通过（26.21s，仅既有 chunk > 500 kB 警告，与本次改动无关；产物含 4 个新页面 chunk）。
- 契约偏差（已处理，代码留注释）：① `circuitEvents` 不能按契约字面 `fail_reason LIKE '%regCircuitOpen%'`——`fail_reason` 存的是译文不是 key，改按译文 `instr()` 子串匹配（D1 的 LIKE 对长中文模式会抛 `LIKE or GLOB pattern too complex`）；② 导出 CSV 不能走 `http` axios 实例（拦截器按 JSON 解析，blob 会被误判），`userExportCsv` 直接用 `axios` + `responseType: 'blob'`，按 `Content-Type` 区分 CSV 与错误 JSON。
- 未手动验证：4 个新页面与仪表盘风控区的真实浏览器交互（无登录态可跑的本地联调环境；构建通过 + 后端 API 测试覆盖到同名接口）。部署后按 `DEPLOY.md` §6 第 4 项冒烟。

### 4.4 密钥库存告警 + 第四阶段体验（A 路，已完成；交付文档 `PHASE2-A.md`）

- 后端：`mail-worker/src/service/reg-key-service.js`（新增 `maybeAlertLowStock(c)`：读 `setting.regKeyAlertThreshold` 默认 500，未过期密钥剩余总量低于阈值时 TG 告警，每天最多 1 次，KV `REG_KEY_ALERT_DAY + YYYY-MM-DD` 去重，先置标记再发告警，全程 try/catch）；`mail-worker/src/service/login-log-service.js`（新建，`record` / `listByUser`）；`mail-worker/src/service/login-service.js`（`_register` 成功后调 `maybeAlertLowStock`；`login()` 取 `prevIp`/`curIp`，`isNewIp = prevIp && prevIp !== curIp && curIp !== 'Unknown' ? 1 : 0`，登录成功后写 `login_log`，新 IP 时发站内提醒邮件 `_sendNewIpAlert`，走 `emailService.send`，收件人本人，站内投递不占 Resend 配额；OAuth 同路径）；`mail-worker/src/api/my-api.js`（新增 `GET /my/loginLog` 仅本人、`GET/POST /my/locale`，POST 只接受 8 种对外存储值 `zh-CN/en/ja/ko/vi/ru/es/fr`，非法值 400）。
  - 与契约的一处有意偏差：`isNewIp` 判定补 `curIp !== 'Unknown'`——无 `CF-Connecting-IP` 时 `curIp` 为 `'Unknown'`，不补会把所有此类登录误判为新 IP 并发提醒，导致第一阶段配额测试失败；未知 IP 时不标新、不发提醒，登录日志仍正常写。
- 前端：`mail-vue/src/views/login/index.vue`（报错映射 `authErrorMap` 9 组中/英文双覆盖 + `friendlyAuthError` / `showAuthError`，登录/注册/绑定三个请求改走 `noMsg` 防一条报错弹两次；Turnstile 降级提示 `turnstileFailed` + 两处 `el-alert`；视觉升级：浅色多段渐变背景 + 3 个纯 CSS 柔光圆 + 玻璃拟态表单面板 + 内联 SVG 品牌徽章 + 蓝紫渐变主按钮 + 移动端 44px 触控高度；语言切换器右上角；`saveToken()` 内同步语言与通知开关接入）；`mail-vue/src/views/send/index.vue`（发件页顶部“今日还剩 X 封”横幅，取 `userStore.user.sendCount` 与 `role.sendCount` 差值）；`mail-vue/src/views/setting/index.vue`（登录记录区最近 20 条；语言下拉 8 项即时切换；布局密度舒适/紧凑；通知开关“登录时显示系统公告”默认开）；`mail-vue/src/components/theme-selector/index.vue`（主题三档：浅色/深色/**跟随系统**，跟随系统时监听 `prefers-color-scheme` 实时同步；复用既有 View Transitions 动效）；`mail-vue/src/i18n/index.js`（重写：`localStorage mail-locale` > 浏览器，`fallbackLocale: 'en'`，zh/en 内置、其余 6 种懒加载）；`mail-vue/src/i18n/locale.js`（新建 134 行：`SUPPORTED_LOCALES`、`normalizeLocale`、`toStoredLocale`、`detectBrowserLocale`、`loadLocaleMessages`、`applyLocale`、`syncLocaleWithServer`）；`mail-vue/src/i18n/{ja,ko,vi,ru,es,fr}.js`（各新建 51 个 key：公开页 45 个 + 个性化 6 个）；`mail-vue/src/init/init.js`（挂载前应用语言与偏好防闪烁；已登录时与后端同步语言）；`mail-vue/src/utils/preferences.js`（新建 128 行：`mail-prefs` 读写/解析/应用，`resolveDark`、`syncSystemThemeListener`、`applyPrefs`）；`mail-vue/src/style.css`（末尾紧凑密度规则，行高 48px → 38px）；`mail-vue/test/preferences-locale.smoke.mjs`（新建，node 直接跑）。
- 例外说明（A 路报备，总协调复核通过）：`theme-selector/index.vue`、`init/init.js`、`style.css` 不在原 A 路清单内，但主题跟随系统、挂载前应用偏好、紧凑密度无三者无法实现，且三者均不归其他路、不属于第一阶段代码；改动已在 `PHASE2-A.md` §1.3 标注。
- 验证（实跑）：`test/phase2a.spec.js` 13/13 + `test/phase1.spec.js` 23/23（36/36）；smoke `node test/preferences-locale.smoke.mjs` 10/10；前端构建通过（27.50s，仅既有 chunk 警告）；vue-i18n 回落实测（`ja` 缺失 key 回落英文）；6 个语言文件各 51 个 key，逐文件核对无缺失、无空值。
- 中途发现并修复的两个真实问题（未放宽断言）：① 新 IP 提醒邮件导致 phase1 配额测试计数由 0 变 1（`curIp='Unknown'` 误判，补条件 + 加回归用例）；② smoke 抓到 `normalizeLocale('en-US')` 返回 null（补主语言部分匹配）。
- 6 种语言提案（A 路，待用户确认）：English（必备）+ 日本語 / 한국어 / Tiếng Việt / Русский / Español；第 8 种暂定 Français（备选 Deutsch / Português）。提案理由见 `PHASE2-A.md` §5；与 §7.3 总协调提案一致（日/韩/越/俄/西/法），最终以用户确认为准——若改提案，只换语言文件与 `SUPPORTED_LOCALES` 一处，不动框架。

### 4.5 i18n 集成（总协调，已完成 2026-11-08）

- 已补进前后端 i18n 文件（共 82 个新 key）：
  - 后端 3 个（`mail-worker/src/i18n/zh.js` / `en.js`，插在 `resendQuotaExhausted` 之后）：`exportTooManyRows`（C 路）、`newIpLoginSubject` / `newIpLoginBody`（A 路，占位符 `{{time}}` / `{{ip}}` / `{{device}}`，与 i18next 默认插值一致，`login-service.js:419` 的 `t('newIpLoginBody', {ip, time, device})` 已核对）。
  - 前端 79 个（`mail-vue/src/i18n/zh.js` / `en.js`，附在 `notOwner` 之后，分 A 路 26 个 + C 路 53 个两组注释）：A 路 §2.2 20 个 + §2.3 6 个；C 路 53 个（清单见 `PHASE2-C.md` §2；其中 `exportTooManyRows` 属后端，不重复进前端）。
  - 6 个新语言文件（`ja/ko/vi/ru/es/fr.js`，A 路已翻好，各 51 个 key：公开页 45 个 + 个性化 6 个）**未动**：C 路 key 属后台管理页，按契约只要求公开页 key 齐全、其余回落英文，6 语种下后台页显示英文是符合约定的；如用户要求后台页也全量翻译，再补 53×6 个翻译。
- 补之前已核对：79 + 3 个 key 在 zh/en 里原先都不存在，无重复；补完重跑前端构建通过（24.71s），构建产物核对：`authErrNoRegKeyCount` 在 `login-*.js` 与 `index-*.js` chunk 内，`regKeyRemaining` 在 `analysis-*.js` 与 `index-*.js` 内。
- 总协调另接 A 路遗留项：`daySendLimit` 人话映射已接入写信页——新建 `mail-vue/src/utils/send-error.js`（`sendErrorMap` + `friendlySendError`，未命中原样返回），`mail-vue/src/views/send/index.vue` 的普通 `<script>` 块改为从该模块重导出（原定义移走），`mail-vue/src/layout/write/index.vue` 在 `sendEmail().catch()` 里用 `friendlySendError(e.message, t)` 替代裸 `e.message`（`t` 在该文件 `:135` 已有）。构建通过。

### 4.6 部署准备（已完成）

- `DEPLOY.md`（一键部署指南，域名 aevorynthtech.com，全套全新资源）+ `deploy.sh`（校验配置 → 前端构建 → 生成 `wrangler.deploy.toml` → `wrangler deploy`，不自动跑 `/init`）+ `.deploy.env.example`；`.gitignore` 已加 `.deploy.env` 与 `mail-worker/wrangler.deploy.toml`。`deploy.sh` 已过 `bash -n` 语法检查；**未实际部署**（等全部阶段完成 + 回归清单全勾后才部署）。

### 4.7 集成验证（终跑，已完成 2026-11-08）

- [x] `npx vitest run test/phase1.spec.js test/phase2a.spec.js test/phase2c.spec.js` 全过：**62/62**（phase1 23/23、phase2a 13/13、phase2c 26/26，含总协调补的 4 个无 token 401 回归用例）。
- [x] 前端构建通过（`mail-vue` 下 `npm run build`，24.71s，仅既有 chunk > 500 kB 警告；6 个语言 chunk 独立存在，`index.html` 无静态引用）。
- [x] i18n 一次性补齐后重跑上述两项（构建与测试均为补完后终跑）。
- [x] `oracle-patrol`：`npm test` **10/10**（集成未改动，重跑确认）。
- [x] 前端 smoke：`node mail-vue/test/preferences-locale.smoke.mjs` **10/10**。
- [x] `security.js` 复核：A 路报告提到的 mtime 05:08 UTC（13:08 CST）正是总协调修漏洞的写操作（§4.1 三处边界匹配，`:129–133`、`:171`、`:181`），内容与 A 路预期一致，无冲突。
- [ ] 浏览器手动验证（`PHASE2-A.md` §10.3 的 10 项 + §7 的 5 项耗时目标）：需 live browser，本机无可用环境，**未验证，不冒充通过**；部署后由父代理在浏览器任务里逐项核对。

## 5. 回归清单（部署前必跑，在 PHASE1.md §6 基础上追加）

- [ ] 回归 12：`/init` 后 `pragma_table_info(user)` 含 `locale` 列、`pragma_table_info(setting)` 含 `reg_key_alert_threshold` 列；`login_log` / `alert_log` 两表与 4 个索引存在；perm 43–45 存在；再跑一次 `/init` 确认幂等。
- [ ] 回归 13：注册密钥剩余总量低于阈值（默认 500）时 TG 告警 1 次/天；余量充足不告警。
- [ ] 回归 14：异地登录写 `login_log`（`is_new_ip=1`）并收到站内提醒邮件；同 IP 登录不标新。
- [ ] 回归 15：用户列表按 IP 筛选、IP 分组、导出 CSV（上限 5000 行）正常；无 `user:export` 权限调导出接口 403。
- [ ] 回归 16：仪表盘 `risk` 字段齐全（注册趋势、IP Top 10、熔断事件、密钥余量、Resend 用量）；任一 risk 查询失败不拖垮整个仪表盘。
- [ ] 回归 17：封禁管理页增删查、告警中心列表、注册/审计日志列表正常；新页面按 permKey 正确挂菜单。
- [ ] 回归 18：公开页 8 种语言切换无缺 key 报错（缺失回落英文）；localStorage 持久化；登录后后端 `locale` 列有值且下次登录恢复。
- [ ] 回归 19：甲骨文巡检 `--dry-run` 不发真实请求；mock 测试全过；WAF 同步仅在 IP 集变化时推送。
- [ ] 回归 20：无 token 调 `/registerLog/list`、`/auditLog/list`、`/alertLog/list`、`/ipBlocklist/list` 一律 401（§4.1 边界匹配修复的回归用例，`phase2c.spec.js` 新增 4 个，全过）。
- [ ] 回归 21：部署检查清单（`DEPLOY.md` §0/§6）逐项通过：`/init` 成功且幂等、perm 37–45 齐全、Turnstile OPEN、收发信冒烟、风控冒烟、巡检 `--once --dry-run` 无误。
- [ ] 回归 22：性能预算（§7）逐项实测达标，实测值已填表；不达标项有明确优化动作，不带超标交付。
- [ ] 回归 23：个性化清单（§8.3）逐项核对：主题/布局/密度/语言/通知开关可调且持久化；安全设置个性化按第六阶段设计验收（本阶段只核对开关入口不缺失、不越界实现）。
- [ ] 回归 24：技术领先点（§6）逐项核对实现支撑，不把设计说成已交付（Passkey/TOTP/SMTP 标注阶段）。
- [ ] 已知抖动：`test/phase1.spec.js` 的 Resend 配额耗尽用例在 2026-11-08 04:56/04:57 连续两次出现 `email` 计数为 1（期望 0），随后在无任何代码改动的情况下两次全过（05:02、05:03，23/23），独立复现也通过（0 条记录）。判定为 miniflare 隔离存储分层的偶发抖动，非代码问题；若再现，重跑即可，不要为此放宽断言。

## 6. 技术领先点（用户 2026-11-08 13:07 定：技术层面领先于市面上所有邮箱）

> 诚实口径：下表每一点都标注状态——**已实现**（本阶段代码 + 测试支撑）、**设计已定**（方案在本文档，实施排在第五/六阶段，绝不说成已交付）、**上游既有**（cloud-mail 原有能力，我们保留未改）。验收时逐项核对支撑，不只看口号。

| # | 领先点 | 实现支撑 | 状态 |
|---|---|---|---|
| 1 | 边缘计算优先的全球架构 | Workers + D1 + KV + R2 + Email Routing/Email Sending 全跑 CF 边缘；前端由 Worker `assets` 绑定托管（`run_worker_first = true`，`/api/*` 先走 Worker）；用户请求就近接入边缘节点，无中心机房单点 | 已实现（部署形态，见 `DEPLOY.md`） |
| 2 | 注册风控体系（市面邮箱普遍没有内置） | 单 IP 24h 限 3（IPv6 按 /64）、分钟限流、全站熔断（超 20/分钟自动关注册 + TG 告警）、应用层 IP 黑名单（注册/访问双 scope）、注册日志 + 审计日志、甲骨文巡检（AbuseIPDB 核查 + WAF 自动同步 + 配额统计），见 §4.2–4.3 | 已实现（第一 + 二 + 三阶段，测试 62 + 10 个） |
| 3 | 双通道发信 + 配额保护 | CF Email Sending 优先、Resend 备用；Resend 日/月配额硬拦截（撞线停发 + 告警），按实际成功收件人数计数；角色级发信次数限制保留 | 已实现（第一阶段） |
| 4 | 8 种语言 + 持久化 | 前端 i18n 框架支持 8 种语言切换（简体中文默认、英文必备；其余 6 种提案见 §7，待用户确认），公开页 key 8 语种齐全、其余回落英文；切换持久化 localStorage `mail-locale` + 后端 `user.locale` | 已实现（A 路；集成补 key 后终验） |
| 5 | SMTP 发信（第三方客户端） | 甲骨文 SMTP 守护进程（协议适配器，只调现有 Worker 接口）+ CF Tunnel 暴露 `smtp.aevorynthtech.com`；SMTP 发信与网页发信计同一配额；端口 587/465、强制 TLS | 设计已定（§2，第五阶段实施） |
| 6 | 个性化安全中心 | 每用户自调：加密开关、登录提醒、数据保留期限、TOTP、Passkey、设备管理、安全评分；端到端加密只做可选（诚实边界见 §3.5） | 设计已定（§3，第六阶段实施） |
| 7 | 现代认证标准 | TOTP（RFC 6238，手写 WebCrypto HMAC-SHA1，零新增依赖）+ Passkey/WebAuthn（RP ID = aevorynthtech.com）+ 登录历史与设备管理（可踢出其他设备）；密码 salt+hash 保留 | 设计已定（§3.3，第六阶段实施） |
| 8 | 最小化日志 + 加密基线 | 全站 HTTPS/HSTS + 安全头（CSP 须放行 Turnstile 域名）；敏感字段应用层加密（AES-GCM，密钥放 wrangler secret）；日志只记必要字段、支持定期清理（默认 90 天）与 IP 脱敏选项 | 设计已定（§3.1–3.2，第六阶段实施） |
| 9 | 可观测性内置 | 风控仪表盘（注册趋势、IP Top 10、熔断事件、密钥余量、Resend 用量）、告警中心（TG 告警历史落 `alert_log`）、注册/审计/登录三类日志、巡检失联告警 + Kuma 心跳 | 已实现（第二 + 三阶段） |
| 10 | 零外部锁定 | 除 AbuseIPDB（信誉数据，CF 无等价）与 Telegram（通知，CF 无等价）外，全部能力走 CF 原生；无第三方 SMTP 中继、无外部数据库 | 已实现（§1.1/§1.3 审计结论） |

对比口径（验收时用，不写进用户文案）：传统邮箱（Gmail/Outlook/ProtonMail）强在规模与生态；我们的领先不在规模，而在**自托管可控 + 内置风控 + 个性化深度**这三条——注册防刷、巡检自动封禁、8 语种、每用户安全中心是开箱即带的能力，不是插件。

## 7. 性能预算与体验标准（用户 2026-11-08 13:06 定：让用户感觉是这个世界上最好的邮箱）

对标 Gmail/ProtonMail 级打磨：首屏加载快、交互响应快、动效顺滑、空状态与新手引导精心做、细节到位（文案、间距、反馈一个都不能糙）。预算即验收线：**实测值在部署后填表，不达标不交付**，不许只写“已优化”。

### 7.1 性能预算（目标值；测量方法见右列）

| 指标 | 目标 | 测量方法 | 实测值（A 路本次构建实测，见 `PHASE2-A.md` §7） |
|---|---|---|---|
| 登录页 LCP | ≤ 2.5s（宽带）/ ≤ 4s（4G 慢网） | Lighthouse（`https://aevorynthtech.com`，移动端 4G 节流） | ⚠️ 未验证（需部署后浏览器实测） |
| 登录页 FCP | ≤ 1.5s | 同上 | ⚠️ 未验证（需部署后浏览器实测） |
| CLS | ≤ 0.1 | 同上 | ⚠️ 未验证（需部署后浏览器实测） |
| INP（关键交互） | ≤ 200ms | Lighthouse + 真机点按 | ⚠️ 未验证（需部署后浏览器实测） |
| 首屏传输 JS（gzip） | ≤ 300KB | 构建产物统计（`mail-worker/dist/assets`，gzip 后） | ✅ **126KB**（A 路预算目标 ≤150KB，实测 126KB；`dist/index.html` 的 modulepreload 9 个 chunk 之和 128,927 字节，含新增 `preferences` chunk 715 字节） |
| 总 JS（gzip） | ≤ 800KB | 同上 | ✅ 首屏 126KB；总量待部署后 Lighthouse 复核 |
| 语言包 | 按需懒加载，非当前语言不下载 | 网络面板核对（切换语言时才加载对应 chunk） | ✅ 6 个独立 chunk（`ja/ko/vi/ru/es/fr-*.js`），`index.html` 无静态引用 |
| 列表切换 / 发信提交反馈 | ≤ 100ms 内出 loading/反馈态 | 真机点按计时 | ⚠️ 未验证（A 路目标：列表 ≤150ms、发信首反馈 ≤300ms、搜索 ≤300ms、语言切换 ≤500ms，均需浏览器实测） |
| API P95（边缘） | ≤ 500ms（登录/列表/发信） | Worker 日志 / 巡检侧采样 | ⚠️ 未验证（需部署后采样） |

> 补充实测（A 路）：首屏 CSS **5.7KB gzip**（目标 ≤10KB ✅）、首屏 HTML **1.7KB gzip**（目标 ≤2KB ✅）、首屏新增外部请求 **0 个** ✅、视觉升级增量约 2KB 未压缩 CSS（登录页 CSS 现 1.9KB gzip、登录页 JS chunk 6.3KB gzip）。现状提示：C 路构建时已有 chunk > 500 kB 警告（上游既有，与本次改动无关）；若首屏 JS 超预算，优先做 Element Plus 按需引入与路由懒加载，不加新动画库。视觉升级约束不变：只用 CSS 与少量内联 SVG，不引外部字体/图片/重动画库。

### 7.2 体验清单（逐项核对）

- [ ] 空状态精心做：收件箱空、搜索无结果、草稿空、封禁列表空、告警空，各有插画/文案/引导操作（不是空白页）。
- [ ] 新手引导：首次登录有简短引导（核心操作 3 步以内讲清）；注册页人话报错（`regIpLimit` 等 8 类错误见契约 §4 A 路，不显示 key、不显示英文堆栈）。
- [ ] 反馈即时：每个按钮点按都有 loading/成功/失败态；发信、删信、导出等耗时操作有进度或明确提示。
- [ ] 动效克制顺滑：过渡 150–300ms，不抖、不闪；金句/闭幕类文字不抖的原则同样适用（无震屏效果）。
- [ ] 移动端优先：登录/注册页在手机上单手可操作；表格在窄屏下关键列优先、其余收起（C 路 `createIp` 列宽度 > 900px 才显示即此原则）。

### 7.3 8 种语言（用户 2026-11-08 12:55 定；其余 6 种待用户确认，不拍板）

- 已定：简体中文（默认）、English（必备）。
- 提案（总协调建议，待用户确认）：日本語、한국어、Tiếng Việt、Русский、Español、Français。备选：Deutsch、Português。
- 选择理由：覆盖华人用户最常见的第二语言与邮箱服务的海外用户群（日韩越为东亚/东南亚华人圈高频；俄西法为欧洲/拉美大语种）；A 路已建 `es.js` / `fr.js` / `ja.js` / `ko.js` / `ru.js` / `vi.js` 六个文件，与本提案一致（es=Español、fr=Français、ja=日本語、ko=한국어、ru=Русский、vi=Tiếng Việt），最终以用户确认为准——**若用户改提案，只换文件与 key 内容，不动框架**。
- 落地规则：公开页（登录/注册）字符串 8 语种齐全；其余页面缺失 key 回落英文（`fallbackLocale: 'en'`）；切换器放公开页右上角 + 主界面设置区；持久化 localStorage `mail-locale` 为主、登录后同步后端 `user.locale`。

## 8. 验收标准（用户 2026-11-08 13:07 定：零已知 bug、每个点都完美）

### 8.1 测试覆盖要求

- 每个新功能都要有测试覆盖：后端用 vitest（`test/phase1.spec.js` 23 个、`test/phase2a.spec.js` 13 个、`test/phase2c.spec.js` 26 个，共 62 个）、巡检用 `node:test`（`oracle-patrol/test/patrol.test.js` 10 个）；前端用构建通过 + 关键流程手动清单（§8.2 回归清单）覆盖。
- 覆盖表（功能 → 测试位置，缺一不算完）：

| 功能 | 测试 |
|---|---|
| 注册限额/限流/熔断/Turnstile fail-closed/OAuth 堵旁路 | `phase1.spec.js` |
| 密钥库存告警、异地登录提醒、语言偏好 | `phase2a.spec.js` |
| IP 筛选/分组/导出、仪表盘 risk、日志接口权限 | `phase2c.spec.js` |
| 巡检封禁/AbuseIPDB/配额/WAF/dry-run/失联 | `oracle-patrol/test/patrol.test.js` |
| 无 token 读日志接口 401（§4.1 回归） | `phase2c.spec.js` 新增 4 个 |
| 前端 4 个新页面、仪表盘风控区、视觉升级、8 语种切换 | 构建通过 + 部署后冒烟（`DEPLOY.md` §6 第 4 项） |
| 部署流程本身 | `deploy.sh` 语法检查 + `DEPLOY.md` §0/§6 清单逐项 |

- 不许放宽断言：测试抖动只重跑、不改期望值（见 §5 已知抖动）；测试失败的功能不许写成“已完成”。

### 8.2 零已知 bug 规则

- 交付时已知问题清单必须为空。每个发现的问题要么已修（附测试用例）、要么由用户明确决定延期（写进本文档的“已知问题”并标注决定人/日期），不许带着“已知但没写”的问题交付。
- 已修的问题：§4.1 的 `/registerLog/list` 无鉴权漏洞（已修 + 4 个回归用例）；A 路中途发现的两个真实问题（新 IP 提醒误判、`normalizeLocale('en-US')` 返回 null，均已修 + 回归用例）；C 路的 i18n 缺 key（§4.5 已补）；A 路遗留的 `daySendLimit` 映射未接入（§4.5 已接入写信页）。
- 已知局限（非 bug，按契约实现方式的固有边界，待用户定是否改，不阻塞交付）：
  1. 角色 `sendType='ban'` 的用户收不到新 IP 提醒：提醒走正常发信通道 `emailService.send()`，被禁发角色抛 `bannedSend`，已 try/catch（不阻断登录，只记日志）；登录日志本身不受影响。如需覆盖被禁发用户，需改走内部投递——**待用户定通道策略**。
  2. 新 IP 提醒邮件计 1 次发信量：普通角色的提醒走正常发信通道，按角色规则计 1 次；若用户当日额度已满，提醒发不出（已 try/catch，不阻断登录）。与第 1 项同源，**待用户定通道策略**。
  3. 跟随系统主题卡片的预览图暂用浅色（未做半深半浅预览）；选中态与文案正确，不影响功能，细节待打磨。
  4. 浏览器手动验证未做（`PHASE2-A.md` §10.3 的 10 项 + §7 的 5 项耗时目标）：需 live browser，部署后逐项核对，不冒充通过。
  5. 6 个新语言文件只翻了公开页 + 本阶段新 key（各 51 个），后台管理页在 6 语种下回落英文（符合契约）；如用户要求后台页也全量翻译，再补 53×6 个翻译。

### 8.3 全方位个性化清单（主题、布局、密度、语言、通知、安全设置都要能让用户自己调）

| 个性化项 | 本阶段状态 | 说明 |
|---|---|---|
| 语言（8 种） | ✅ 本阶段 | §7.3；切换器公开页右上角 + 设置区；持久化 localStorage + 后端 |
| 主题（浅色/深色/跟随系统） | ✅ 本阶段（A 路） | 设置项落前端偏好存储，有 UI 入口、可持久化；视觉升级须同时满足两种主题不断裂 |
| 布局 / 密度（舒适/紧凑） | ✅ 本阶段（A 路） | 同上；列表密度切换即时生效 |
| 通知开关 | ✅ 本阶段（A 路） | 登录提醒开关、配额告警开关（管理员侧阈值可调，默认 500）；开关关闭后不再打扰，日志照常记 |
| 安全设置（TOTP/Passkey/保留期限/加密开关） | ⏳ 第六阶段 | 设计见 §3.4–3.5；本阶段只核对“安全中心入口不缺失、不越界实现”，不写 TOTP/Passkey 代码 |

- 验收：上表每一项逐项点开验证（切一次、刷新一次、重新登录一次，三次状态一致才算持久化通过）。
