# 终极版邮箱 · 第五、六阶段交付记录

> 状态：**已完成，本地验证通过，未部署**（部署由父代理按 GitHub 计划走：先部署 1–4 阶段状态，5–6 阶段做完再更新部署；见 §7）。
> 工作目录：`~/workspace/mail-ultimate/`（cloud-mail main HEAD `d115f4c` 的 fork）。
> 分工契约：`PHASE5-6-CONTRACT.md`。第一阶段见 `PHASE1.md`（vitest 23/23），第二至四阶段见 `PHASE2-4.md`。
> 协调方式：总协调先写契约与共享接口，A/B/C 三路并行开发，总协调集成验证 + 写本文档。
> 备注：父代理已于 2026-11-08 13:47 把本仓库全部内容提交为本地 commit `444d6b3`（含 5–6 阶段代码），当时分支领先 `origin/main` 1 个提交；本文档与 `DEPLOY.md` 的更新是该提交之后的增量，由父代理随下次更新一并提交。

## 1. 完成情况总览

| 路 | 任务 | 状态 |
|---|---|---|
| A | 第五阶段 SMTP 发信实施 | ✅ 已完成（新目录 `smtp-relay/` + `SMTP-DEPLOY.md`） |
| B | 第六阶段安全加固·后端 | ✅ 已完成（v3_7DB、字段加密、TOTP、Passkey、会话、安全中心后端、E2EE 门、日志清理、IP 脱敏） |
| C | 第六阶段安全加固·前端 | ✅ 已完成（安全中心页、E2EE 客户端加密、8 语种 key） |

## 2. 第五阶段 — SMTP 发信实施（A 路）

方案见 `PHASE2-4.md` §2：甲骨文 SMTP 守护进程（协议适配器）+ Cloudflare Tunnel 暴露 `smtp.aevorynthtech.com`。

### 2.1 交付文件

- `smtp-relay/package.json`：Node ≥ 18，`type: module`，`mailparser@3.14.2` 为唯一运行时依赖；脚本 `start` / `test`。
- `smtp-relay/config.example.json`：只放占位符；`worker.baseUrl` 默认 `http://127.0.0.1:8787`（本地 wrangler dev），生产填 `https://aevorynthtech.com/api`。
- `smtp-relay/.gitignore`：忽略 `config.json` / `*.log` / `node_modules`。
- `smtp-relay/smtp-relay.service`（27 行）：systemd 单元，主服务 3 核 18G 机、热备 1 核 6G 机默认停用；TG 凭证走 `/etc/smtp-relay.env`（root 0600）。
- `smtp-relay/src/config.js`（161 行）：读配置 + 环境变量覆盖 + 校验 + 脱敏打印。校验卡死的点：`server.host` 必须 127.0.0.1、25 端口拒绝、`auth.jwtTtlSeconds` ≤ 3600、TLS 启用时证书路径必填。
- `smtp-relay/src/server.js`（656 行）：SMTP 协议实现。监听 127.0.0.1:2525（+ 可选 465 隐式 TLS）；支持 EHLO/HELO、STARTTLS、AUTH LOGIN/PLAIN、MAIL FROM、RCPT TO、DATA、RSET、NOOP、QUIT；VRFY/EXPN 回 502；STARTTLS 之前 AUTH 直接 530；FROM 必须等于登录邮箱（否则 553）；DATA 串行处理防流水线竞态。
- `smtp-relay/src/worker-api.js`（102 行）：只调三个现有接口 `POST /login`、`GET /account/list`、`POST /email/send`。绝不直调 Resend、不直写 D1、不直调 CF API 发信。密码现验现忘，只缓存短期 JWT（内存，默认 30 分钟）+ accountId。
- `smtp-relay/src/mail.js`（100 行）：MIME→send 映射。格式按 `email-service.js:336-353` 核对：`accountId / name / receiveEmail(To+Cc+Bcc) / subject / text / content(HTML，无 HTML 时由纯文本转) / attachments[{filename, content: base64, type, contentType, contentId?}]`，附件上限 10 个。
- `smtp-relay/src/rate-limit.js`（90 行）：内存态限流——每 IP 并发连接上限 10、每小时 AUTH 上限 30、AUTH 连续失败 5 次封 IP 15 分钟。
- `smtp-relay/src/telegram.js`（51 行）：最小 TG 发送函数（配置名复用巡检的 `tgBotToken`/`tgChatId`），失败永不抛错；`smtp-relay/src/logger.js`（36 行）：本地日志 UTC，只记 IP/邮箱/结果，绝不记密码/JWT。
- `smtp-relay/src/index.js`（82 行）：入口；配置缺失或证书读不到直接 exit 1；SIGINT/SIGTERM 优雅停服。
- `smtp-relay/test/smtp-relay.test.js`（561 行）：`node:test` + mock Worker。
- `SMTP-DEPLOY.md`（348 行）：systemd、cloudflared Tunnel（config.yml 片段 + `cloudflared tunnel route dns <tunnel> smtp.aevorynthtech.com`，不建 MX）、证书申请与续期、客户端配置向导（587+STARTTLS / 465+SSL/TLS）、排障、热备。

### 2.2 验证结果（总协调实跑）

- `smtp-relay` 下 `npm test`：**12/12 通过**（总协调亲自重跑，约 1.7 秒）：端到端 EHLO→AUTH→MAIL→RCPT→DATA→250（断言 mock 收到的 `/login` 入参与 `/email/send` 的 accountId=7、收件人、主题、text/content、附件 base64）；AUTH PLAIN + JWT 缓存复用；AUTH 失败 5 次封 IP（第 6 次连接问候即 421 + TG 告警 1 条）；配额透传（Worker 返回 400 `resendQuotaExhausted` 时回 452、`/email/send` 只调 1 次不重试）；STARTTLS 自签证书握手；465 隐式 TLS；VRFY/EXPN 502、未认证 MAIL 530、FROM 冒充 553、TOTP 账号 535；Worker 403→550。
- 真实进程冒烟（A 路实跑）：临时 config + 本机 mock Worker（18787）跑真正的 `node src/index.js`，Python 客户端全程 EHLO→AUTH→DATA→250，mock 收到正确的 send body；冒烟后临时 `config.json` / `smtp-relay.log` 已删除。
- 既有基线无回归：A 路实跑 `mail-worker` 三套测试 62/62（A 路只读了 `email-service.js` 等文件，未改）。

### 2.3 测试中发现并已修的 3 个真实问题

1. `config.js` 的 `server.port` 校验不接受 0（测试用临时端口）——改为 0–65535（0 = 临时端口）。
2. 测试收尾挂起隐患：`startRelay` 抛错时 `finally` 引用未初始化的解构变量导致 mock server 永不关闭、进程挂起——测试改为 `relay` 外层变量 + `cleanup()` 保证 mock 一定关闭。
3. 冒烟发现服务端健壮性问题：客户端误发 `\r\r\n` 时行尾多一个 `\r`，单字命令 DATA/QUIT 被判未识别——`server.js` 的 `pump()` 现容错剥离行尾多余 `\r`。

### 2.4 实施时核实的两个接口细节（A 路写进代码注释）

- **accountId 的来源**：`/login` 只返回 `{token}`，不返回 accountId；守护进程用 JWT 调 `GET /account/list`（`Authorization` 头放裸 token，与前端 `mail-vue/src/request/user.js:18` 同款）按邮箱匹配到 `accountId` 再调 `/email/send`。
- **Worker 错误包的真实形状**：Hono 的 `onError`（`src/hono/hono.js:9`）用 `c.json()` 返回错误，**HTTP 状态恒为 200，真实错误码在 body.code**（BizError 默认 501）。所以配额判定按 message 文本识别（`resendQuotaExhausted` / `额度已用完` / `quota`），测试同时覆盖了契约写法的 HTTP 400 形状与真实的 HTTP 200 + body.code 501 + 中文译文形状，两者都回 452。契约“Worker 返回 400”与源码实际形状有出入，特此说明。

### 2.5 TLS 勘误（已写进 `SMTP-DEPLOY.md` §0.1）

CF Tunnel 只加密隧道传输本身，**不替 SMTP 做边缘 TLS 终止**；客户端 STARTTLS/465 面对的是守护进程自己的证书。生产证书用 Let's Encrypt DNS-01（经 CF DNS API）申请，文档写清了 certbot 命令、凭证文件权限（0600）、续期钩子与 `ubuntu` 用户读证书的 ACL 做法；本地测试用自签证书（测试专用）。

## 3. 第六阶段 — 安全加固·后端（B 路）

设计见 `PHASE2-4.md` §3。

### 3.1 改动清单（文件与行号级位置，B 路汇报）

1. **v3_7DB 迁移** — `src/init/init.js:38`（`init()` 里 `v3_6DB` 之后调用）、`:208` 起 `v3_7DB()`：三表 `user_totp` / `user_passkey` / `user_security`（契约 §1.1 原样）、索引 `idx_user_passkey_user`、`setting` 加 `log_retention_days`（默认 90）、`log_ip_mask`（默认 0）、`email` 加 `e2ee`（默认 0）；每组独立 try/catch + `console.warn`。实体：新建 `src/entity/user-totp.js`、`user-passkey.js`、`user-security.js`；`src/entity/setting.js` 末尾加两列、`src/entity/email.js` 加 `e2ee` 列。
2. **安全头** — `src/security/security.js:111-121`（新中间件，注册在原鉴权中间件之前，`await next()` 之前 `c.header()` 设置，全站生效）：HSTS `max-age=31536000; includeSubDomains`（无 preload）；CSP 按契约逐字（含 `challenges.cloudflare.com` 的 script-src 与 frame-src、`frame-ancestors 'none'`）；`nosniff` / `DENY` / `strict-origin-when-cross-origin`。
3. **字段加密** — 新建 `src/utils/field-crypto.js`（WebCrypto AES-GCM，密钥 = SHA-256(`field_enc_key`)，IV 随机 12B，信封 `enc:v1:<base64>`；`decrypt` 遇非信封值原样返回；无 key 时存明文 + `console.warn` 一次；解密失败原样返回、永不抛错）。唯一集成点 `src/service/setting-service.js`：`:17` 加密字段表、`:25-38` `refresh()` 读库后解密（含 `resendTokens` 先解密再 `JSON.parse`，解析失败回落 `{}`）、`:154-161` `set()` 写入前加密（已是信封的不重复加密）。`get()` 打码逻辑未动。`wrangler.jsonc:12` vars 加测试 dummy key；`.deploy.env.example:15-16` 加 `FIELD_ENC_KEY=` 一行 + 注释。
4. **TOTP** — 新建 `src/service/totp-service.js`（手写 base32 + HMAC-SHA1，6 位/30 秒，验证窗口 ±1 步；备份码 10 个，SHA-256 存 hash，用一次作废）。`src/service/login-service.js:364` 密码通过后查开关，开启返回 `{needTotp: true, totpToken}`（KV `TOTP_PENDING`，TTL 300）；`:372` `verifyTotpLogin()`（失败 5 次作废 totpToken，成功删 pending 并签发会话）；`:417` `_issueSession()` 为密码/TOTP/Passkey 三路共用。API：`src/api/login-api.js`（`/login` 分流 needTotp、新增 `POST /login/totp`、`/login/passkey-options`、`/login/passkey-verify`）、新建 `src/api/security-api.js`（`/my/totp/setup|enable|disable`）。`src/const/kv-const.js` 加 `TOTP_PENDING` / `PASSKEY_CHALLENGE` / `SESSION_META`。OAuth 同样走 TOTP 检查：`src/service/oauth-service.js` 的 `bindUser` / `saveAndLogin` 在 `login()` 返回 needTotp 对象时透传 `{token: null, needTotp: true, totpToken}`，不把对象当成 token。
5. **Passkey** — 新建 `src/service/passkey-service.js`（手写，见 §3.3；RP ID `aevorynthtech.com`、origin `https://aevorynthtech.com`；challenge KV 5 分钟过期、一次性消费；counter 防重放：新 counter 须大于已存值，双方为 0 的无计数设备放行，已存 >0 而新值为 0 时拒绝）。API 在 `security-api.js`（`/my/passkey/register-options|register|list`、`DELETE /my/passkey/:credentialId`）与 `login-api.js`（`/login/passkey-options|verify`，验签通过后经 `login-service.js:399 loginWithPasskey()` 签发 JWT，与密码登录并存）。
6. **会话管理** — 新建 `src/service/session-service.js`：登录时写 `SESSION_META`（digest=token uuid 前 8 位 → `{ua, ip, createdAt}`，TTL 与 AUTH_INFO 同为 30 天）；`GET /my/sessions`、`POST /my/sessions/revoke`（`{digest}` 或 `{allExceptCurrent: true}`，完整 token 绝不返回）；`src/service/login-service.js` 的 `logout()` 增加 null 守卫并同步清本设备 meta。
7. **安全中心后端** — 新建 `src/service/user-security-service.js`（`user_security` 实体 + 服务；`retentionDays` 只接受 0/30/90/365，其余 400；读失败返回默认值、永不抛错）。`security-api.js` 的 `GET/POST /my/security`（返回含 `totpEnabled`，C 路对齐项）；`login-service.js` 的 `_issueSession()` 中 `isNewIp` 时先查 `login_alert` 开关，关闭后不发提醒、登录历史照常记。
8. **E2EE 后端门** — `src/service/email-service.js:372`：发件用户 `e2ee_enabled=1` 且收件人含站外地址 → 400 `e2eeExternalBlocked`；`:375` `e2eeFlag`、`saveParams` / `saveSentEmail()` 存 `email.e2ee` 列；服务端不解密、不校验密文内容（收件方站内副本同样带 `e2ee=1`，因 `HandleOnSiteEmail` 展开 `sendEmailData`）。
9. **日志留存清理** — 新建 `src/service/log-retention-service.js`（`cleanup(c)`：读 D1 `setting.log_retention_days`，默认 90，0=保留；三表按 `create_time < datetime('now','-N days')` 分批删，每批 ≤500；`user_security.retention_days > 0` 的用户超期邮件软删 `is_del=1`；全程 best-effort、永不抛错）。`src/index.js:47` 在 `scheduled()` 每小时分支（非 `*/30` 分支）调用，另包 try/catch。
10. **IP 脱敏** — `src/utils/req-utils.js:76` `maskIp(ip)`（IPv4 末段 → 0；IPv6 只留 /64，复用 `getIpSegment` 归一化；`Unknown`/非法原样返回、永不抛错）。`register-log-service.js:9,29`、`login-log-service.js:8,29`、`audit-log-service.js:8,45` 各加 `maybeMaskIp()`：`setting.log_ip_mask=1` 时写入前脱敏 `ip` 列，`ip_segment` 列不受影响，读配置失败时不脱敏、不阻断。
11. **i18n** — `src/i18n/zh.js` / `en.js` 在 `resendQuotaExhausted` 之后加 13 个 key：`totpInvalidCode`、`totpTokenInvalid`、`totpLocked`、`totpNotEnabled`、`passkeyInvalidResponse`、`passkeyNotFound`、`passkeyCounterReplay`、`passkeyUnsupportedAttestation`、`passkeyChallengeExpired`、`sessionNotFound`、`securityInvalidRetention`、`e2eeExternalBlocked`（另 `totp*` 等前缀均已覆盖）。
12. **测试** — 新建 `mail-worker/test/phase6.spec.js`（30 个用例）；路由挂载：`src/hono/webs.js` 加 `import '../api/security-api'`。

### 3.2 验证结果（总协调实跑）

- 开始前基线：三套 **62/62 通过**；全部改动写完后基线重跑仍 **62/62**。
- phase6 新套件：**30/30 通过**（v3_7DB 迁移+幂等、安全头 5 组、字段加密往返/老明文兼容/无 key 回落、setting 加密落库与打码读回、TOTP setup/enable/needTotp/换 JWT/备份码一次作废/5 次锁定/disable、Passkey 注册+登录验签+counter 重放拒绝+列表删除、会话列表/踢出/踢出其他全部/登出清 meta、安全中心读写+retention 非法值拒绝+异地提醒开关生效、E2EE 站外拒发+站内放行存 `e2ee=1`、日志清理超期删/未超期留/`log_retention_days=0` 保留、IP 脱敏开关）。
- **收尾四套总协调重跑：92/92 通过**（`Test Files 4 passed`，`npx vitest run test/phase1.spec.js test/phase2a.spec.js test/phase2c.spec.js test/phase6.spec.js`，61.75 秒）。
- 测试中修掉的 3 个测试侧问题（未放宽断言）：① 错误字段名 `msg`→`message`；② 会话踢出用例用 JWT 前 8 位冒充 digest——digest 是 JWT payload 内 uuid 的前 8 位，改为解 payload 匹配；③ workerd ECDSA 签名格式问题（见 §3.3，已修正服务端实现本身，不是只改测试）。

### 3.3 Passkey 评估结论（B 路动手前已实测，手写最小验证）

**`@simplewebauthn/server` 14.1.0 在 vitest pool-workers（workerd）下跑不通，故未采用。** 实测：`npm install --no-package-lock --no-save @simplewebauthn/server@14.1.0` 安装成功；探针测试导入即失败：`SyntaxError: The requested module '../tslib.js' does not provide an export named 'default'`。根因是其传递依赖 `tsyringe` 内嵌的 tslib ESM（`modules/index.js` 对 `tslib.js` 做 default import）与 Vite/workerd 的 ESM 互操作不兼容；改走 CJS 入口 `script/index.js` 也失败——该子路径不在其 `exports` 映射内。生产 wrangler 打包（esbuild）未必复现，但验收测试跑在 vitest pool-workers 下，导入失败即无法测试，因此按契约允许的 fallback 手写最小验证（CBOR 解码 + COSE 公钥解析 + WebCrypto 验签，零新增依赖），只覆盖本项目实际路径：attestation fmt `none`（options 生成即 `attestation: 'none'`）与 `packed` 自证明（无 x5c）；密钥类型 ES256 / Ed25519 / RS256；counter 防重放；challenge KV 一次性使用、5 分钟过期。`package.json` / lockfile 未动（探针安装只用了 `--no-package-lock --no-save`，探针文件已删）。

**workerd 实测发现（已据此修正实现）：** workerd 的 WebCrypto ECDSA sign/verify 用的是**原始 R||S 格式（64 字节）**，不是 DER——探针证实 `sign` 返回 64 字节 raw，`verify(raw)=true`、`verify(DER)=false`。因此服务端验签直接把原始签名交给 `crypto.subtle.verify`，不转 DER（Node 的 DER 惯例在此不适用；真实认证器回包同样是原始格式，生产与测试一致）。

## 4. 第六阶段 — 安全加固·前端（C 路）

### 4.1 改动清单（C 路汇报）

**新建 5 个文件：**

- `mail-vue/src/views/security/index.vue`（680 行）：安全中心页。安全评分（TOTP +30、Passkey +30、登录提醒 +20、30 天内无异地登录 +20，满分 100，只展示不锁功能）；TOTP setup/enable/disable 全流程；Passkey 注册/列表/删除；登录历史（复用 `request/my.js` 的 `loginLog`，最近 20 条）；设备管理（踢出单个 / 踢出其他全部）；提醒开关与保留期限下拉（0/30/90/365，即时保存、失败回滚）；E2EE 开关 + 诚实说明文案（忘记密码 = 永久无法恢复、无后门；不支持服务端搜索；不走站外中继；附件本阶段不加密）。
- `mail-vue/src/request/security.js`（54 行）：`getSecurity` / `setSecurity` / `totpSetup` / `totpEnable` / `totpDisable` / `passkeyRegisterOptions` / `passkeyRegister` / `passkeyList` / `passkeyDelete` / `sessions` / `revokeSession` / `revokeOtherSessions`，路径与 payload 一字不差按契约 §1.3，全部 `noMsg`。
- `mail-vue/src/utils/e2ee.js`（167 行）：WebCrypto 实现。PBKDF2-HMAC-SHA256（210000 次）派生 + AES-GCM 256；信封 `e2ee:v1:<base64(iv||ciphertext)>`；密钥只放模块内存变量，源码中无 `localStorage` / `sessionStorage` / `document.cookie`；salt 取 `GET /my/security` 的 `e2eeSalt`，开启时若为空则生成并随 `POST /my/security` 保存；另含 `isInternalEmail`（域名表为空时一律判站外）。
- `mail-vue/src/utils/webauthn.js`（101 行）：手写 base64url 互转 + SimpleWebAuthn options/credential JSON 转换，不引新依赖。
- `mail-vue/test/e2ee.smoke.mjs`（155 行）：见 §4.2。

**修改文件：**

- `mail-vue/src/perm/perm.js`（:160–178）：新增 `'my:delete'` 路由 `/security`（name `security`，meta 照抄已有用户页写法，title `securityCenter`）。选 `my:delete` 的原因：默认普通用户角色持有该 perm（`mail-worker/src/init/init.js` role_perm 种子 106，父级为“个人设置”perm 4），管理员为 `*`；后端 `/my/*` 接口只鉴权不鉴 perm，与 `/my/loginLog`、`/my/locale` 一致。
- `mail-vue/src/layout/aside/index.vue`（:38–42）：补一个无 `v-perm` 的侧栏入口（与“个人设置”同款，任意登录用户可见）。说明：此项超出任务字面清单——侧栏是硬编码菜单，不加这一项页面只能靠直输 URL 到达；总协调判定保留，删这 5 行即可回退。
- `mail-vue/src/layout/write/index.vue`：import（:129–130）；E2EE 状态 refs 与 `loadE2eeStatus()`（:182–195，`open()`/:613 与 `openDraft()`/:624 打开时刷新）；标题栏 E2EE 徽标（:14）；发送前加密分支（:373–420，站外收件人预检→内存无密钥时弹密码框解锁→只加密副本 payload 传 `e2ee: 1`，不改 `form`，附件不加密；加密失败/取消不发信；该块特意放在进度提示创建之前，避免提前 return 卡住进度条）；失败提示映射 `e2eeExternalBlocked`（:478）。
- `mail-vue/src/views/content/index.vue`：E2EE 解锁卡片（:44–53）；`displayContent`/`displayText`（:138–150，加密邮件未解锁时不显示密文信封）；解密逻辑（:152–230，`watch` 带 `immediate: true`，解密结果只放本页局部 ref、绝不写回会持久化的 emailStore，解密后经 `sanitizeEmailHtml` 再渲染）；回复/转发引用解密后正文（`:e2eeSafeEmail`）；样式 `.e2ee-box`。
- `mail-vue/src/i18n/zh.js` / `en.js` / `ja.js` / `ko.js` / `vi.js` / `ru.js` / `es.js` / `fr.js`：各补 **75 个**新 key（`security*` 17、`totp*` 18、`passkey*` 9、`session*` 8、`e2ee*` 23，含后补的 `e2eeDisable`）。

**TOTP 无二维码的说明：** 按任务要求未引新依赖、未加 QR 库。setup 页显示 secret + otpauth URL + 复制按钮（`navigator.clipboard`，失败走 `copyFailMsg`），用户在验证器 App 里手动输入 secret 或粘贴链接即可；文案 `totpSetupTip` 已写明本页不提供二维码。

### 4.2 验证结果（总协调实跑）

- 新 smoke `node test/e2ee.smoke.mjs`：**11/11 通过**（总协调亲自重跑：PBKDF2+AES-GCM 往返、text/content 各自独立 IV、错密钥解密失败、篡改密文认证失败、非信封值处理、内存密钥 unlock/clear、源码+运行期零落盘、站内地址判定、salt 随机性、webauthn base64url 与 options 转换）。
- 旧 smoke `node test/preferences-locale.smoke.mjs`：**10/10 通过**，无回归。
- 前端构建 `npm run build`：**通过**（总协调亲自重跑；仅既有 `analysis` chunk > 500 kB 警告，与本次改动无关）。产物核对：`dist/assets/security-*.js` / `security-*.css` / `e2ee-*.js` 独立 chunk 存在，`securityCenter` 在主包内。
- i18n 核对（C 路 node 脚本实跑）：75 个新 key 在 8 个语言文件里全量齐全、无缺失、无空值；zh 无重复 key。
- 范围核对：`git status` 确认本次新增/修改文件全在 `mail-vue/**` 内；`package.json`/lockfile 未动。

### 4.3 自查修掉的两个问题（C 路）

- 读信页 watch 缺 `immediate`：已持久化的邮件进页时不会触发解密，已补。
- 安全中心关闭 E2EE 的按钮误用 `totpDisable` 文案（会显示“关闭 TOTP”），已新增 `e2eeDisable` key（8 语种）并替换。

### 4.4 已知局限（按契约实现方式的固有边界）

- 邮件列表页的 E2EE 邮件预览会显示密文信封（只在读信页解密，未扩到列表）。
- 回复/转发未解锁的 E2EE 邮件时，引用块仍为密文信封（已解锁则引用解密后正文）。
- 评分的“30 天内无异地登录”以登录历史最近 20 条为准。
- E2EE 密码与登录密码的关系：本实现用用户在安全中心输入的“加密密码”派生密钥（可与登录密码相同也可不同，文案已写明），改登录密码不影响已加密邮件；忘记加密密码则永久无法恢复。

## 5. 集成验证（总协调终跑，2026-11-08）

| 验证项 | 结果 |
|---|---|
| `mail-worker` 四套测试（phase1 23 + phase2a 13 + phase2c 26 + phase6 30） | ✅ **92/92 通过**（总协调重跑，61.75 秒） |
| `smtp-relay` 下 `npm test` | ✅ **12/12 通过**（总协调重跑，约 1.7 秒） |
| `mail-vue` 前端构建 | ✅ 通过（总协调重跑；仅既有 chunk 警告） |
| `node mail-vue/test/e2ee.smoke.mjs` | ✅ **11/11 通过**（总协调重跑） |
| `node mail-vue/test/preferences-locale.smoke.mjs` | ✅ **10/10 通过**（总协调重跑，无回归） |
| 范围核对（`git status`） | ✅ A 路仅 `smtp-relay/` + `SMTP-DEPLOY.md`；B 路仅 `mail-worker/**` + `.deploy.env.example`；C 路仅 `mail-vue/**`；三路无交叉改动 |
| 前后端接口联调 | ⚠️ 未做（B 路接口与 C 路前端并行开发；契约 §1.3 已对齐，部署后按 `DEPLOY.md` §6 冒烟核对） |

## 6. 部署阻塞项与新发现（必须由父代理定）

### 6.1 SMTP 公网 587/465 入口待确认（部署阻塞，A 路已写进 `SMTP-DEPLOY.md` §0.2）

`cloudflared tunnel route dns` 建出的 `smtp.aevorynthtech.com` 默认只接 HTTP(S)；Outlook/Thunderbird/手机邮箱直连 587/465 的原始 TCP，在没有 Cloudflare Spectrum 的情况下到不了 Tunnel 入口（Tunnel 的 TCP 公网入口要走客户端 `cloudflared access tcp`，邮件客户端跑不了）。方案 B（客户端装 cloudflared）不可行、方案 C（直连甲骨文 IP）违反 §1.2 硬约束，均已排除。**部署前先确认 Spectrum 方案（方案 A），确认前不要向用户公布 `smtp.aevorynthtech.com`。** 守护进程本身不受影响（只监听 127.0.0.1:2525）。

### 6.2 新发现：Cloudflare Email Service 自带 SMTP 提交端点（总协调核实）

Cloudflare 官方文档（`developers.cloudflare.com/email-service/api/send-emails/smtp/`，2026-10-30 更新）确认：Email Service 暴露认证 SMTP 提交端点 **`smtp.mx.cloudflare.net:465`**（仅隐式 TLS；AUTH PLAIN/LOGIN；用户名为字面量 `api_token`；密码为带 Email Sending: Edit 权限的 Cloudflare API token；只支持 465，不支持 587 STARTTLS 与 25 端口）。经该端点提交的邮件走与 REST API / Workers 绑定相同的投递管道（含 DKIM/ARC 签名与限额）。

**但它不能替代守护进程**：该端点用的是账号级共享 API token 做认证，没有按用户区分、没有本站的角色发信次数与 Resend 配额概念——直接公布给用户等于绕过全部风控。因此：用户侧 SMTP 仍走守护进程方案（§2）；CF 自带 SMTP 端点只作为管理员自用/排障的备选，不写进用户配置向导。`DEPLOY.md` §2.2 已补此说明。

### 6.3 Workers Rate Limiting 绑定（`PHASE2-4.md` §1.3 的第五阶段跟进项）——评估后延期

决定：**本阶段不做，留档说明**。理由：① 绑定需要账号级唯一的 `namespace_id`，只能部署时在 Cloudflare 侧生成，现阶段无法定值、无法在本地测试里验证；② miniflare 对 ratelimit 绑定的测试支持未经证实，强行接入可能拖垮已通过的 92 个测试；③ DB 层限流（注册分钟限流 5 次/段、IP 限额、熔断）已实现并测试覆盖，边缘前置过滤只是加强、不是缺口。部署时如需补，在 `wrangler.deploy.toml` 模板加 `[[ratelimits]]` + `security.js` 前置调用，届时另起回归用例。

## 7. 未完成项与回归清单（部署前必跑，在 `PHASE1.md` §6 与 `PHASE2-4.md` §5 基础上追加）

- [ ] 回归 25：新库从零跑 `/init`，核对 `pragma_table_info(user_totp|user_passkey|user_security)` 三表、`setting` 含 `log_retention_days`/`log_ip_mask`、`email` 含 `e2ee`；再跑一次 `/init` 确认幂等。
- [ ] 回归 26：TOTP 开通→启用→密码登录返回 needTotp→`/login/totp` 换 JWT；备份码用一次作废；失败 5 次锁定；关闭需密码 + code。
- [ ] 回归 27：Passkey 注册→列表→登录验签→删除；counter 重放拒绝；challenge 5 分钟过期。
- [ ] 回归 28：会话列表与踢出（单个 / 踢出其他全部）；登出后 meta 清理；完整 token 永不出现在响应里。
- [ ] 回归 29：安全中心读写（提醒开关、保留期限非法值拒绝、E2EE 开关）；异地提醒开关关闭后不再发提醒、登录历史照常记。
- [ ] 回归 30：E2EE 站外发信被拒（`e2eeExternalBlocked` 人话提示）、站内发信存 `e2ee=1`、读信解密；附件不加密（文案一致）。
- [ ] 回归 31：字段加密——后台改密钥类字段后落库为 `enc:v1:` 信封、读回打码正常、发信/告警功能不受影响；无 `FIELD_ENC_KEY` 时存明文 + 告警（部署时必须填，见 `DEPLOY.md` §3）。
- [ ] 回归 32：安全头出现在全部响应里（HSTS、CSP 含 Turnstile 域名、nosniff、DENY、Referrer-Policy）；Turnstile 真实渲染通过。
- [ ] 回归 33：日志清理——超期行被删、未超期留、`log_retention_days=0` 保留；用户保留期限超期邮件软删 `is_del=1`。
- [ ] 回归 34：IP 脱敏开关开时新日志 `ip` 列脱敏、`ip_segment` 不变、限额与封禁不受影响。
- [ ] 回归 35：SMTP 守护进程部署后——真实 `node src/index.js` + 真实 Worker 联调（EHLO→AUTH→DATA→250 全程）、587/465 入口确认后客户端实测（Outlook/Thunderbird/手机邮箱各一）、配额透传、TOTP 账号回 535。
- [ ] 回归 36：部署检查清单（`DEPLOY.md` §0/§6）逐项通过；`FIELD_ENC_KEY` 已生成并填入（不与 `jwt_secret` 复用）。
- [ ] 已知未做：超期邮件**物理删除**未做（本阶段只软删，待后续阶段）；Passkey Ed25519/RS256 与 `packed` 自证明路径代码已实现但测试只覆盖 ES256 + `fmt 'none'`（真实设备端到端待部署后浏览器实测）；TOTP 无二维码（secret 手动输入）；E2EE 列表页预览显示密文信封（只在读信页解密）。
- [ ] 已知抖动：无新增。`PHASE2-4.md` §5 的 phase1 配额抖动（miniflare 隔离存储偶发）未再现。

## 8. 改动文件总览

- 新增：`PHASE5-6-CONTRACT.md`、`PHASE5-6.md`（本文件）；`smtp-relay/` 全目录（`package.json`、`config.example.json`、`.gitignore`、`smtp-relay.service`、`src/*.js` 8 个、`test/smtp-relay.test.js`）；`SMTP-DEPLOY.md`；`mail-worker/src/{entity/user-totp,user-passkey,user-security}.js`；`mail-worker/src/service/{totp-service,passkey-service,session-service,user-security-service,log-retention-service}.js`；`mail-worker/src/utils/field-crypto.js`；`mail-worker/src/api/security-api.js`；`mail-worker/test/phase6.spec.js`；`mail-vue/src/views/security/index.vue`；`mail-vue/src/request/security.js`；`mail-vue/src/utils/{e2ee,webauthn}.js`；`mail-vue/test/e2ee.smoke.mjs`。
- 修改：`mail-worker/src/{init/init,security/security,hono/webs,index}.js`；`mail-worker/src/{service/login-service,setting-service,email-service,oauth-service}.js`；`mail-worker/src/{service/register-log-service,login-log-service,audit-log-service}.js`；`mail-worker/src/{utils/req-utils,const/kv-const,entity/setting,entity/email,i18n/zh,i18n/en}.js`；`mail-worker/wrangler.jsonc`（测试 dummy `field_enc_key`）；`.deploy.env.example`（`FIELD_ENC_KEY` 一行）；`mail-vue/src/{perm/perm,layout/aside/index,layout/write/index,views/content/index}.vue`；`mail-vue/src/i18n/{zh,en,ja,ko,vi,ru,es,fr}.js`；`DEPLOY.md`（§0/§2.2/§3/§6/§8，本次集成更新）。
- 未改动：`package.json` / lockfile（`@simplewebauthn/server` 探针安装未留痕；`smtp-relay/package.json` 是新服务，正常写依赖）；`rege_key_id` 拼写与 `user.send_count` 类型错配原样未动；收发信主流程、JWT、RBAC 未动；老站 mail.flame.edu.kg 全程未碰。
