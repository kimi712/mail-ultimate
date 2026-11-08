# 终极版邮箱 · 第五、六阶段分工契约（总协调定稿，2026-11-08）

> 三路并行开发的唯一事实来源。文件归属互斥，任何人不得改别人的文件。
> 基线已验证通过：`mail-worker` 下 `npx vitest run test/phase1.spec.js test/phase2a.spec.js test/phase2c.spec.js` **62/62**（2026-11-08 13:28 总协调实跑）。
> 已定事项不可再改：fork 不重写；单 IP 24h 限 3（IPv6 /64）；熔断 20/分钟；主通道 CF Email Sending、Resend 备用；甲骨文巡检自动封；Turnstile 每次验证；域名 aevorynthtech.com；用户入口一律走 CF 边缘、不直连甲骨文 IP；CF 原生优先；零已知 bug 交付；8 种语言（zh-CN/en/ja/ko/vi/ru/es/fr）；SMTP 发信；斯诺登级安全 + 个性化安全中心；端到端加密只做可选，绝不夸大。
> 必读：`PHASE2-4.md`（§2 SMTP 设计、§3 安全设计、§5 回归清单、§8 验收标准）、`PHASE1.md`（§6 回归清单）、`PHASE1-CONTRACT.md`、学习报告 `~/workspace/research_notes/mailflare-analysis/cloud-mail-study.md`（§8 避坑）。

## 0. 文件归属（互斥）

| 路 | 任务 | 拥有文件 |
|---|---|---|
| A | 第五阶段 SMTP 发信实施 | `smtp-relay/**`（新建目录）、`SMTP-DEPLOY.md`（新建）。不碰 `mail-worker/`、`mail-vue/`、`DEPLOY.md`、`deploy.sh` |
| B | 第六阶段安全加固·后端 | `mail-worker/**`（含 `test/phase6.spec.js`、`wrangler.jsonc` 的测试 vars）、`.deploy.env.example`（只加 `FIELD_ENC_KEY` 一行 + 注释）。不碰 `mail-vue/`、`smtp-relay/`、`DEPLOY.md`、`deploy.sh` |
| C | 第六阶段安全加固·前端 | `mail-vue/**`（含 `mail-vue/test/e2ee.smoke.mjs`）。不碰 `mail-worker/`、`smtp-relay/`、`DEPLOY.md` |

`DEPLOY.md` / `deploy.sh` / `PHASE5-6.md` 由总协调在集成时统一改，不归任何一路。

## 1. 共享接口契约（跨路调用一字不差）

### 1.1 新表与新列（v3_7DB，B 路实施，`init()` 里 `v3_6DB` 之后调用；全部 `IF NOT EXISTS` / try-catch，沿用 v3_5DB/v3_6DB 风格）

```sql
CREATE TABLE IF NOT EXISTS user_totp (
  user_id INTEGER PRIMARY KEY,
  secret_encrypted TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  backup_codes_hash TEXT NOT NULL DEFAULT '[]',
  created_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS user_passkey (
  credential_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 0,
  public_key_jwk TEXT NOT NULL DEFAULT '',
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL DEFAULT '',
  created_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_user_passkey_user ON user_passkey(user_id);
CREATE TABLE IF NOT EXISTS user_security (
  user_id INTEGER PRIMARY KEY,
  login_alert INTEGER NOT NULL DEFAULT 1,
  e2ee_enabled INTEGER NOT NULL DEFAULT 0,
  retention_days INTEGER NOT NULL DEFAULT 0,
  e2ee_salt TEXT NOT NULL DEFAULT '',
  created_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- setting 新列
ALTER TABLE setting ADD COLUMN log_retention_days INTEGER NOT NULL DEFAULT 90;  -- 0 = 永久保留
ALTER TABLE setting ADD COLUMN log_ip_mask INTEGER NOT NULL DEFAULT 0;          -- 0 关 / 1 开
-- email 新列：端到端加密标记（只加列，B 路实施；C 路读它解密）
ALTER TABLE email ADD COLUMN e2ee INTEGER NOT NULL DEFAULT 0;
```

### 1.2 KV 新 key（B 路加进 `src/const/kv-const.js`）

```js
TOTP_PENDING: 'totp_pending:',        // value: {userId, attempts}，TTL 300 秒
PASSKEY_CHALLENGE: 'passkey_challenge:', // value: challenge 字符串，TTL 300 秒
SESSION_META: 'session_meta:',         // value: {digest: {ua, ip, createdAt}}，与 AUTH_INFO 同 TTL
```

### 1.3 后端 API 契约（B 路实施，C 路按此调用）

- `POST /login`：密码通过且用户开启 TOTP 时，返回 200 `{needTotp: true, totpToken}`（不是报错）；否则照常返回 `{token}`。OAuth 登录（`noVerifyPwd`）同样走 TOTP 检查。
- `POST /login/totp` `{totpToken, code}` → `{token}`；失败 5 次则该 totpToken 作废（须重新密码登录）。
- `POST /my/totp/setup` → `{secret, otpauthUrl}`；`POST /my/totp/enable` `{code}` → ok；`POST /my/totp/disable` `{password, code}` → ok。
- `POST /my/passkey/register-options` → SimpleWebAuthn options JSON；`POST /my/passkey/register` `{response}` → `{credentialId, name}`；`GET /my/passkey/list` → `[{credentialId, name, createdTime}]`；`DELETE /my/passkey/:credentialId` → ok；`POST /login/passkey-options` `{email}` → options JSON；`POST /login/passkey-verify` `{email, response}` → `{token}`。RP ID = `aevorynthtech.com`，origin = `https://aevorynthtech.com`。
- `GET /my/security` → `{loginAlert, e2eeEnabled, retentionDays, e2eeSalt}`；`POST /my/security` `{loginAlert?, e2eeEnabled?, retentionDays?}` → ok（仅本人数据；`retentionDays` 只接受 0/30/90/365）。
- `GET /my/sessions` → `[{digest, ua, ip, createdAt, current}]`（digest 为 token 前 8 位摘要标识，**完整 token 绝不返回**）；`POST /my/sessions/revoke` `{digest}` 或 `{allExceptCurrent: true}` → ok。
- `POST /email/send` 接受可选 `e2ee: 0/1`（C 路加密后传 1），存进 `email.e2ee` 列；用户 `e2ee_enabled=1` 且收件人含站外地址时，后端抛 400 `e2eeExternalBlocked`（见 §1.4）。

### 1.4 i18n key 前缀约定

- 后端（B 路，`mail-worker/src/i18n/zh.js` / `en.js`）：`totp*`、`passkey*`、`session*`、`security*`、`e2eeExternalBlocked`。
- 前端（C 路，`mail-vue/src/i18n/zh.js` / `en.js` 全量 + `ja/ko/vi/ru/es/fr.js` 翻译安全中心页 key）：`security*`、`totp*`、`passkey*`、`session*`、`e2ee*`。

### 1.5 字段加密约定（B 路）

- 新建 `mail-worker/src/utils/field-crypto.js`：WebCrypto AES-GCM；密钥来自 `c.env.field_enc_key`（wrangler secret，部署时生成；测试用 dummy 值放 `wrangler.jsonc` 的 vars：`"field_enc_key": "phase56-local-test-only-not-a-real-secret"`）；信封格式 `enc:v1:<base64>`；`decrypt` 遇到非信封值原样返回（兼容老站明文存量）；无 key 配置时存明文 + `console.warn` 一次（不阻断部署，不静默假装加密）。
- 加密字段：`secretKey`、`tgBotToken`、`s3SecretKey`、`s3AccessKey`、`githubClientSecret`、`googleClientSecret`、`linuxdoClientSecret`、`resendTokens`（整段 JSON 字符串加密）。加密点：`setting-service.set()` 写入前；解密点：`setting-service.refresh()` 读库后（KV 缓存里仍是解密后的值，与现行行为一致）。`get()` 的打码逻辑保留不动。

## 2. 各路任务

### A 路 — 第五阶段 SMTP 发信实施（`PHASE2-4.md` §2 方案）

- 新目录 `smtp-relay/`：Node ≥ 18 守护进程，`package.json`（`mailparser` 为唯一运行时依赖，解析 MIME；其余手写，零多余依赖）+ `config.example.json`（只放占位符）+ `.gitignore`（忽略 `config.json` / `*.log` / `node_modules`）+ `smtp-relay.service`（systemd 单元）+ `src/` + `test/`（`node:test`，风格参照 `oracle-patrol/test/patrol.test.js`）。
- 协议：监听 127.0.0.1:2525（明文，Tunnel 侧）；支持 EHLO/HELO、STARTTLS、AUTH LOGIN/PLAIN、MAIL FROM、RCPT TO、DATA、RSET、NOOP、QUIT；拒绝 VRFY、拒绝 25 端口提交、拒绝明文 AUTH（STARTTLS 之前 AUTH 直接 530）。
- 流程（协议适配器，不自造发信链路）：AUTH 时调 Worker `POST /login`（用户名 = 完整邮箱地址，密码 = 站内密码）验用户，现验现忘，只缓存短期 JWT（内存，TTL ≤ 1 小时）；发信时把 `mailparser` 解析结果映射成 `POST /email/send` 参数（`accountId / receiveEmail / subject / text / content / attachments`，格式以 `email-service.js` 现有约定为准，实施时核对——**只读该文件，不改它**）；发件人 FROM 必须是用户自己的 `@aevorynthtech.com` 邮箱（Worker 的 `sendEmailNotCurUser` 校验会兜底）；**绝不直调 Resend、绝不直写 D1、绝不直调 CF API 发信**。
- 限流与防滥用（内存态）：每 IP 并发连接上限（默认 10）、每小时 AUTH 尝试上限（默认 30）、AUTH 连续失败 5 次临时封该 IP 15 分钟（内存黑名单 + 记日志）；所有 AUTH 尝试记本地日志，异常阈值走 TG 告警（自带最小 TG 发送函数，复用巡检的 `tgBotToken`/`tgChatId` 配置名）。
- TLS 说明（设计勘误，必须写进 `SMTP-DEPLOY.md`，不要重复设计稿的笼统说法）：CF Tunnel 只加密隧道传输本身，不替 SMTP 做边缘 TLS 终止；客户端 STARTTLS/465 面对的是守护进程自己的证书——生产证书用 Let's Encrypt DNS-01（经 CF DNS API）申请并自动续期，文档写清 certbot 命令与续期钩子；本地测试可用自签证书（测试专用，文档注明）。
- 部署文档 `SMTP-DEPLOY.md`：systemd 部署、cloudflared Tunnel 配置（`config.yml` 片段 + `cloudflared tunnel route dns <tunnel> smtp.aevorynthtech.com`，**不建 MX**）、证书申请与续期、客户端配置向导（Outlook/Thunderbird/手机邮箱：`smtp.aevorynthtech.com`、587 + STARTTLS 或 465 + SSL/TLS、用户名完整邮箱、密码站内密码）、排障、1 核 6G 热备（服务默认停用，故障时启用）。
- 测试（`node:test`，`smtp-relay` 下 `npm test`）：mock Worker HTTP 服务器（假 `/login` + 假 `/email/send`）做端到端协议测试（EHLO→AUTH→MAIL→RCPT→DATA→250 全程）、AUTH 失败 5 次封 IP、MIME→send 映射（含附件 base64）、配额错误透传（Worker 返回 400 `resendQuotaExhausted` 时守护进程回客户端 4xx、不重试）、STARTTLS 自签证书握手。本地实跑通过；跑不起来的写明原因 + 手动验证步骤。

### B 路 — 第六阶段安全加固·后端（`PHASE2-4.md` §3 设计）

- **v3_7DB 迁移**（§1.1 全部 DDL + 索引；`init()` 里 `v3_6DB` 之后调用；每组独立 try/catch + `console.warn`，沿用现有风格；**不改任何现有列定义**；`rege_key_id` 拼写与 `user.send_count` 类型错配原样不动）。
- **安全头**（`security.js` 中间件，`await next()` 之前 `c.header()` 设置，全站生效）：`Strict-Transport-Security: max-age=31536000; includeSubDomains`（preload 不上）；`Content-Security-Policy`（`default-src 'self'`；`script-src 'self' https://challenges.cloudflare.com`；`style-src 'self' 'unsafe-inline'`；`img-src 'self' data: blob:`；`connect-src 'self'`；`frame-src https://challenges.cloudflare.com`；`frame-ancestors 'none'`）；`X-Content-Type-Options: nosniff`；`X-Frame-Options: DENY`；`Referrer-Policy: strict-origin-when-cross-origin`。Turnstile 渲染必须实测通过（CSP 放行其 script 与 frame）。
- **字段加密**（§1.5 约定；`setting-service.js` 的 `set`/`refresh` 是唯一集成点；`get()` 打码不动；`.deploy.env.example` 加 `FIELD_ENC_KEY` 一行 + 注释）。
- **TOTP**（RFC 6238，6 位、30 秒、SHA1）：新建 `src/service/totp-service.js`（WebCrypto HMAC-SHA1 手写 TOTP + base32 编解码，零新增依赖，验证窗口 ±1 步）；`user_totp` 实体 + 服务；备份码 10 个一次性码，SHA-256 存 hash（`backup_codes_hash` JSON 列），登录时可用备份码代替 TOTP 码（用一次作废一个）；`login-service.login()` 密码通过后查 TOTP 开关（§1.3 契约）；API 见 §1.3。
- **Passkey**：先评估 `@simplewebauthn/server` 14.1.0 在 vitest pool-workers（workerd）下的兼容性——能跑就用它（这是设计点名的库，加依赖需在报告里说明理由）；跑不通则手写最小验证（CBOR/COSE，工作量大，须在报告里先说明再动手）。RP ID / origin 见 §1.3；counter 防重放；challenge KV 5 分钟过期；Passkey 与密码登录并存，不强制迁移。
- **会话管理**：登录时写 `SESSION_META`（digest→{ua, ip, createdAt}）；`GET /my/sessions`、`POST /my/sessions/revoke`（§1.3）；登出时同步清 meta。
- **个性化安全中心后端**：`user_security` 实体 + 服务 + `GET/POST /my/security`（§1.3）；`login_alert` 关闭后异地登录不再发提醒（登录历史照常记）——`login-service._sendNewIpAlert` 调用前查开关。
- **E2EE 后端门**：`email-service.send()` 入口：发件用户 `e2ee_enabled=1` 且收件人含站外地址 → 抛 400 `e2eeExternalBlocked`；接受 `e2ee` 参数存 `email.e2ee` 列。服务端不解密、不校验密文内容。
- **日志留存清理**：`src/index.js` 的 `scheduled()` 每小时分支（不是 `*/30` 分支）加清理步骤：删 `create_time` 早于 `setting.log_retention_days` 天（默认 90，0 = 保留）的 `register_log` / `audit_log` / `login_log`，分批删（每批 ≤500 行）；用户 `retention_days > 0` 时软删该用户超期邮件（`email.is_del = 1`，先软删；物理删除本阶段不做，写进报告的未完成项）。全程 best-effort，永不阻断 cron。
- **IP 脱敏**：`req-utils.js` 加 `maskIp(ip)`（IPv4 末段 → 0；IPv6 只留 /64 段）；`setting.log_ip_mask=1` 时，`registerLogService.record` / `auditLogService.record` / `loginLogService.record` 写入前对 `ip` 列脱敏（`ip_segment` 列不受影响；限额与封禁仍用实时检查，不受影响）。
- **测试**：新建 `mail-worker/test/phase6.spec.js`（vitest pool-workers，复用 `phase2a.spec.js` 的 `fakeCtx`/`api` 写法）：v3_7DB 迁移（表/索引/setting 列/email.e2ee 列 + 幂等）、字段加密往返 + 老明文兼容 + 无 key 回落明文、TOTP 开通/启用/登录 needTotp/验证/备份码/5 次锁定、Passkey options/注册/登录验签/counter 防重放（或手写路径的等价用例）、会话列表/踢出、user_security 读写 + 异地提醒开关生效、E2EE 站外拒发 + 站内放行、日志清理（超期删、未超期留）、IP 脱敏开关、安全头出现在响应里。**收尾重跑四套测试全过**：`npx vitest run test/phase1.spec.js test/phase2a.spec.js test/phase2c.spec.js test/phase6.spec.js`。

### C 路 — 第六阶段安全加固·前端（`PHASE2-4.md` §3.4–3.5、§7）

- 新页 `mail-vue/src/views/security/index.vue` + `mail-vue/src/perm/perm.js` 路由（用户页，任意登录用户可见，照抄已有用户页的 meta 写法）+ 新建 `mail-vue/src/request/security.js`（`getSecurity` / `setSecurity` / `totpSetup` / `totpEnable` / `totpDisable` / `passkey*` / `sessions` / `revokeSession` / `loginLog` 复用 `request/my.js` 的 `loginLog`）。
- 安全中心内容：安全评分（TOTP +30、Passkey +30、登录提醒 +20、30 天内无异地登录 +20，满分 100，只展示不锁功能）；TOTP 开关（setup 显示 secret + otpauth URL + 复制按钮；无 QR 库可用时不引新依赖，secret 手动输入即够用，报告里说明；enable/disable 流程）；Passkey 管理（注册/列表/删除，`navigator.credentials.*`，不支持的浏览器给人话提示）；登录历史（`GET /my/loginLog` 最近 20 条）；设备管理（`GET /my/sessions` 列表 + 踢出单个 / 踢出其他全部）；提醒开关、保留期限下拉（0/30/90/365）、E2EE 开关（**带 §3.5 诚实说明文案**：忘记密码 = 加密内容永久无法恢复，无后门、无找回；加密邮件不支持服务端搜索、不走站外中继；附件本阶段不加密）。
- E2EE 客户端加密：新建 `mail-vue/src/utils/e2ee.js`（WebCrypto：PBKDF2 派生，AES-GCM 加密；密钥只放内存，**绝不进 localStorage**；salt 取 `GET /my/security` 的 `e2eeSalt`，开启时若为空则生成并随 `POST /my/security` 保存）。写信页：`e2eeEnabled` 时加密 `text`/`content` 后发信并传 `e2ee: 1`；读信页：`email.e2ee === 1` 时用内存密钥解密，密钥不在内存时提示输入密码解锁（不把密码发给后端）。附件本阶段不加密（文案写明）。
- i18n：`mail-vue/src/i18n/zh.js` / `en.js` 全量 + `ja/ko/vi/ru/es/fr.js` 翻译安全中心页 key（按 §1.4 前缀）；缺失回落英文的约定不变。
- 测试：新建 `mail-vue/test/e2ee.smoke.mjs`（node 直接跑，参照 `preferences-locale.smoke.mjs`）：PBKDF2 + AES-GCM 往返、错误密钥解密失败、内存密钥不落盘（代码级检查：`localStorage` 无 e2ee key 写入）；**收尾跑 `mail-vue` 前端构建通过**（`npm run build`，`--legacy-peer-deps` 仍需，见 PHASE1.md §4）。

## 3. 全局硬约束（重申，违反即返工）

- 绝不动线上：不碰 mail.flame.edu.kg、D1 cloud-mail、Worker cloud-mail、任何线上凭证；只改 `~/workspace/mail-ultimate/`（A 路的 `smtp-relay/` 也在其中）。
- 不动收发信主流程、JWT、RBAC、现有表结构（只做加法；`rege_key_id` 与 `user.send_count` 原样不动；`email` 表只加 `e2ee` 一列）。
- 时间统一 UTC；日志/告警/配额类函数永不抛错；不提交任何密钥；`package.json`/lockfile 尽量不动（Passkey 用 `@simplewebauthn/server` 是唯一预期的例外，需报告说明；`smtp-relay/package.json` 是新服务，正常写依赖）。
- 不许放宽断言：测试抖动只重跑、不改期望值；测试失败的功能不许写成“已完成”。
- 每个改动点在报告里留行号级位置；跑不起来的验证写明原因 + 手动验证步骤，不要谎报通过。
- 依赖安装：`npm install --no-package-lock --no-save`（不改 lockfile；`node_modules` 已在 `.gitignore`）。不要用 pnpm（VM 未装）。
