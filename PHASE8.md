# 第八阶段：史诗级更新（Snowden 视角 + 未来视角）

> 状态：本地实现与测试全部完成，未部署、未 push。部署由父代理另行安排。
> 设计文档：`PHASE8-DESIGN.md`（§1–§15，含验收清单 §15 与“用户未明说、但按目标应补齐的项”§12）。
> 基线：Phase 7（`PHASE7.md`、`PHASE7-PRIVACY-AUDIT.md`、`PHASE7-SECURITY.md`）；线上版本 b6f52461，本地 HEAD b1974a8。

## 1. 这次改了什么（按验收六条对标）

| 验收项 | 交付内容 |
|---|---|
| 斯诺登 | 隐私审计未做的 5 项全补：TOTP 二维码、9 项安全评分、用户侧审计视图、登录限流、会话最后活跃时间；另加隐私仪表盘、账号恢复（恢复码/备用邮箱链接）、新设备/IP 提醒、密码强度计、联系人、邮件规则 |
| AI 助手 | 邮箱内助手真正内置：多轮对话、写信、回信、摘要、归类（triage）、翻译；只走 Workers AI 开源权重模型（Llama 3.1-8b 主、3-8b 备），不接闭源 API、不让用户填 key；每用户每天 50 次，成功才计数 |
| 翻译 | 读信翻译（原文/译文对照）、写信多语言（起草后按目标语言翻译整篇草稿）、翻译缓存（内容 SHA-256 + 语言对，不含用户身份）；长文分块 ≤3000 字符、最多 4 块，超 12000 字符截断并标注 |
| 上线标准 | 两个根因架构级根治（见 §2）；收发信稳：跟踪像素/远程图片默认拦截、SPF/DKIM/DMARC 徽章、撤回发送、定时发送、举报垃圾/钓鱼、一键退订 |
| 开场动画 | 16 秒全程有动感：远景运镜延至 16 秒（8 秒处无缝衔接）、名言升起+淡出、8 秒/13 秒光扫、8 秒起呼吸辉光、16 秒淡出；并修了 Phase 7 的名言居中 bug |
| 国际化使用习惯 | 浏览器语言默认 locale、时区偏好（26 个 IANA 时区）、Intl 日期/时间/相对时间/数字/文件大小、Gmail 风格快捷键、分文件夹空状态、文案语气审计、注册/登录流程复核；默认语言/时区/日期格式按浏览器/所在地走，不再默认中国习惯 |

## 2. 两个根因的架构级根治（不再靠手工补）

### ① `field_enc_key`（2026-11-08 发信故障根因）
- 当时：`deploy.sh` 从来没设过它，线上跑 `wrangler.jsonc` 里的 dummy 值，D1 里用真密钥加密的 Resend Token 解密失败，`refresh()` 静默把 KV 写成空，发信报“发信服务未配置”。父代理手工补设 secret + 重部署 + `/init` 才修好。
- 现在：`deploy.sh` 每次部署必从 `.deploy.env` 的 `FIELD_ENC_KEY` 执行 `wrangler secret put field_enc_key`（值只经 stdin，不打印、不写日志），并做 3 项部署时校验（secret ≥32 位且非 dummy、`wrangler secret list` 含它、生成的 toml 不得含明文），任一失败即停部署。新增 `mail-worker/src/kernel/secrets.js`（错误码 `field_enc_key_missing` / `too_short` / `dummy`）；Worker 启动时（每个 isolate 一次）只记日志校验一次，不阻断请求；`setting-service.refresh()` 解密/解析失败时保留 KV 里上一次的好值 + 写 `alert_log` + TG 告警，不再静默置空。
- 详见 `DEPLOY.md` §3.1。

### ② 默认角色限额（普通用户曾完全发不了信）
- 当时：默认角色（`role_id=1`）`send_type` 是 `ban`；2026-11-08 父代理临时改为每天 50 封。
- 现在正式产品决策：`send_type='day'`、`send_count=50`（每天 50 封站外信；站内信不受此限）；管理员不限。`init.js` 种子已改；迁移 `v3_11DB` 只修 `send_type='ban'` 的默认角色行（管理员 deliberate 改过的值一律不动）。详见 `DEPLOY.md` §3.2。

## 3. 架构（Phase 8 新分层，旧代码只作行为参考）

- **Layer 0 平台**：Cloudflare 原生优先（Workers / D1 / KV / R2 / Workers AI / Email Sending）；入口一律走 CF 边缘，不直连甲骨文 IP（甲骨文只做巡检/备份/监控）。
- **Layer 1 内核**：`kernel/secrets.js`（密钥校验）、`kernel/ratelimit.js`（限流）、`kernel/audit.js`（最小化日志，密钥类字段脱敏）。
- **Layer 2 领域服务**：`assistant-service` / `translation-service` / `mail-trust-service` / `mail-rule-service` / `recovery-service` / `privacy-service` / `new-ip-alert-service` / `contact-service`。
- **Layer 3 API**：`assistant-api` / `mail-trust-api` / `privacy-api` / `recovery-api` / `new-ip-alert-api` / `contact-api` / `mail-rule-api` / `security-audit-api`（已注册进 `webs.js`）。
- **Layer 4 前端**：AI 助手面板、信任条（`mail-trust/MailTrustBar.vue`）、撤回条、定时发送对话框、隐私/联系人/规则/恢复/垃圾邮件视图、登录页居中 + 斯诺登元素、开场动画。
- **数据层**：迁移 `v3_11DB`（`init.js`，每条语句独立 try/catch + 幂等）：角色修正、B 的 4 个 setting 列 + `user.pwd_changed_at` + 审计索引、C 的 `ai_chat` + `translate_cache`、E 的 7 个 email 列 + `trusted_sender` / `mail_prefs` / `spam_feedback` / `pending_send` / `scheduled_email`、F 的 8 张表 + 4 个索引。只做加法迁移，不删库、不清数据。

## 4. 分工与集成（8 个子代理 + 总协调）

| 子代理 | 范围 | 测试 |
|---|---|---|
| A · 部署与角色 | deploy.sh 密钥设置+校验、secrets 内核、refresh 失败保留好值、默认角色 day/50、DEPLOY.md §3.1/§3.2 | `phase8a.spec.js` 12/12 |
| B · 隐私 5 项 | TOTP 二维码（零依赖手写 QR 编码器）、9 项安全评分、用户侧审计视图、登录限流、会话 lastActiveAt、最小化日志 | `phase8-b.spec.js` 17/17 |
| C · AI 助手+翻译 | 多轮对话、归类、读/写翻译、翻译缓存；Llama 3.1-8b 主、3-8b 备，50/天/人 | `phase8-assistant.spec.js` 19/19 |
| D · 开场动画 | 16 秒全程动感 + 修 Phase 7 名言居中 bug（截图验证） | 构建通过 |
| E · 邮件信任与控制 | 远程图片拦截、SPF/DKIM/DMARC 徽章、撤回/定时发送、举报垃圾/钓鱼、一键退订 | `phase8e-mail-trust.spec.js` 32/32（原 31 + 2026-11-08 补 `_pendingNowIso` 幂等回归测试 1 个） |
| F · 账号与透明 | 隐私仪表盘、恢复码/备用邮箱、New IP 提醒、密码强度计、联系人、邮件规则 | `phase8f.spec.js` 28/28 |
| G · 登录页 | 居中布局（432px 卡片）、隐私愿景行 + 斯诺登名言（截图验证：桌面 1440×900、手机 390×844） | 构建通过 |
| H · 国际化 | 浏览器语言默认、时区偏好、Intl 日期时间、Gmail 快捷键、分文件夹空状态、文案审计 | `phase8-i18n.smoke.mjs` 19/19 |
| 总协调集成 | i18n 8 语言合并（vue 187+15+49、worker 29 键）、DDL 并进 v3_11DB、webs.js 注册、安全白名单、登录/收发信/写信/读信/路由/侧栏全部挂接、HTTP 冒烟测试 | `phase8-http-smoke.spec.js` 11/11（新增，常驻） |

集成时修掉的子代理遗留项：登录页无“忘记密码”入口（已加，跳公开 `/recovery`）；登录错误曾泄露账号是否存在（已统一为通用错误 `authErrLoginFailed`）；`locale.js` 的浏览器语言检测曾只分 zh/en（已改为 8 语种归一化匹配）；恢复流程限流统一到 `kernel/ratelimit.js`；邮件规则接进收信管线（见 §5）；E 组件的实际路径是 `components/mail-trust/*.vue`（非 `*-bar/index.vue`，已按实际路径挂接）。

## 5. 集成要点（实现细节，备查）

- **邮件规则接线**：站外收信走 `email-service.receive()`、站内走 `HandleOnSiteEmail()`，两处落库后各跑一次 `applyRules`（只对新信，`userId > 0` 才跑，全程 best-effort，失败只记日志不阻断收信）。转发动作走现有 `this.send()` 并带 `skipRules`，经 `send()` → `executeSend` → `sendInternal` → `HandleOnSiteEmail(c, …, {skipRules})` 透传，防止站内转发目标再次命中同一规则造成循环转发；站外转发走 CF/Resend，不会循环。
- **撤回/定时发送兜底**：`index.js` 的每小时 cron 在 `autoClean` 之后 best-effort 跑 `processDuePending` + `processDueScheduled`（用户关页面后最晚约 1 小时发出；亚秒级实时需要 Queues/Durable Objects，不在本阶段）。
- **登录**：4 种失败（不存在/已注销/已禁用/密码错）统一返回通用错误；登录成功时恢复码只在注册成功那一刻弹框显示一次；`register()` 成功后返回 `{regVerifyOpen, recoveryCodes}`。
- **i18n**：8 语言文件全部更新；`worker/zh.js` 与 `en.js` 嵌套 permissions 对象缺逗号的语法问题已修；`refresh`、`sendFailMsg`、`noMessagesFound` 等缺失键已补齐。ja/ko/vi/ru/es/fr 仍缺约 70 个旧键（Phase 8 之前就只存在于 zh/en），由 `fallbackLocale: 'en'` 兜底，不在本阶段范围。
- **路由**：新增 `/privacy`、`/contacts`、`/mail-rules`、`/spam`（layout 内）、`/recovery`（公开页）；无 token 可进 `/login` 与 `/recovery`，其余重定向登录。

## 6. 测试结果（全部通过，2026-11-08 本地实测）

| 套件 | 结果 |
|---|---|
| mail-worker vitest 全套 | **280/280（15 个文件）**，含新增 `phase8-http-smoke.spec.js` 11/11 与 `_pendingNowIso` 幂等回归测试 1 个 |
| smtp-relay（`npm test`） | **12/12** |
| mail-vue 构建（`npm run build`） | 通过（525 模块，27.65s） |
| e2ee smoke | **11/11** |
| preferences-locale smoke | **10/10** |
| phase8-i18n smoke | **19/19** |

HTTP 冒烟（`phase8-http-smoke.spec.js`，真实 `webs.js` + `SELF.fetch`）覆盖：新路由已注册（`/ai/*`、`/mail-trust/*`、`/recovery/*`、`/privacy/*`）；无 token 时 body `code` 为 401；公开的 `/recovery/reset-by-code` 无 token 可进，不存在的邮箱+错码返回通用 400（不透露账号是否存在）；登录后 `/mail-trust/prefs` 与 `/mail-trust/read` 走通；跨用户读信返回 `trust_email_not_found`。本项目约定：HTTP 状态恒 200，错误在 body `code` 里。

## 7. 已知问题与取舍（诚实记录，不粉饰）

1. **撤回发送依赖前端倒计时**：窗口内靠写信页倒计时条确认；用户关页面后由每小时 cron 兜底，最晚约 1 小时发出。不是实时撤回，文档与代码注释都如实写了，没伪装成实时。
   **2026-11-08 故障追查（已处理）**：父代理亲验全套时 `phase8e-mail-trust.spec.js` 的 “processDuePending 兜底” 用例失败（`swept.sent` 为 0），全套与单文件两次重跑都是同一个失败；但修复代理到场后 7 次连续运行全部通过（隔离复现、带日志的单文件、单文件 ×3、全套 280/280、全套 279/279、修后单文件 32/32、全套 280/280），故障不可复现。已排除的机制：时区重解析（workerd 内 `getTimezoneOffset()=0`，字符串往返恒等）、窗口时间余量（`nowIso - undoUntil` 恒 ≥1 秒，不可能翻转）、扫表漏行（隔离复现中行存在且被发出）、配额与角色（直接确认同一路径在同一运行内通过）。最可能的残因是总协调会话后磁盘持久化的测试共享状态干扰（§7-11 已记录本套测试依赖磁盘持久化 D1/KV 旧状态、且各文件并行跑时共用同一份 KV `setting:` 做 read-modify-write），但未能证实。**已落地的两处改动（均不放宽断言）**：① `processDuePending` / `processDueScheduled` 的单封失败 catch 里补 `console.error`（pendingId + 错误码/信息）——此前只 `failed++` 不记日志，兜底扫表静默失败是本次故障无法定位的直接原因，防丢信的最后一道网绝不能静默；② `_pendingNowIso` 对自身产出的 `'YYYY-MM-DD HH:mm:ss'` 字符串原样返回，不再走 `new Date()` 重解析（无时区标记的字符串按本地时区解析，非 UTC 运行时会把窗口平移一个时区偏移；workerd/CF 恒为 UTC，生产不受影响，此为防御性堵死），并补 1 个幂等回归测试。修好前不部署的要求已满足：全套 280/280 通过。
2. **Triage JSON 稳定性与长翻译分块连贯性**：需上线后实测验证；失败时有回退（非 JSON 则原样展示、长文截断标注）。
3. **`translate_cache` 无过期清理**：建议 Phase 9 加 90 天清理。
4. **恢复链接发信**：用用户首个发信账号 best-effort 发出；系统发件人身份未定；备用邮箱的 `verified` 列已留但验证流程未接。
5. **新 IP 提醒**：TG 告警目前发往管理员频道（用户级 TG 需绑定 chat_id，未做）。
6. **归档只是标签**：`email_label` 的 'archive' 标签，无归档文件夹；H 的 `e` 快捷键无后端时回退为标记已读。
7. **登录限流的 trade-off**：攻击者用 5 次错密码可锁住他人账号（标准 lockout 取舍，已注明）。
8. **TOTP 重绑**：setup 会覆盖 secret 但 `enabled` 仍为 1，已用“重绑需旧码”缓解。
9. **开场动画**：Esc/跳过/“不再显示”未单独重测（相关代码 Phase 7 后未动）。
10. **E2EE 加密邮件的规则转发**：正文是密文时会原样转发密文（收件方需密钥才能读）；打标签/归档/标记已读/删除只动元数据，不受影响。
11. **测试环境 `/init` secret 之谜（open）**：旧 spec 文件都用写死的 `'test-jwt-secret'` 调 `/init`，但 `wrangler.jsonc`（vitest 用的配置）里的 `jwt_secret` 是 `phase1-local-test-only-not-a-real-secret`；实测：最小测试文件里前者返回 mismatch、后者返回 success，而 `phase8f.spec.js` 及其副本里前者却返回 success——测试侧 `env.jwt_secret` 本身随测试文件不同而不同（最小文件为 phase1 值，F 文件为 test-jwt-secret 值，3 次重复均稳定）。旧测试能通过全靠磁盘持久化的 D1/KV 旧状态。新测试（`phase8-http-smoke.spec.js`）改用 `env.jwt_secret` 调 `/init`，在两种上下文里都对。机制未查明，不影响产品与部署，但值得后续花 10 分钟定位（疑似 vitest-pool-workers 按测试文件解析 wrangler 配置的方式有差异）。

## 8. 上线前清单（部署方核对，DEPLOY.md §6 为准）

- [ ] `.deploy.env` 里 `FIELD_ENC_KEY` 为真实随机值（`openssl rand -hex 32`），与 `jwt_secret` 不复用；部署后 `wrangler secret list` 含 `field_enc_key`，生成的 toml 无明文。
- [ ] 部署后 `/init` 跑完，核对 `role_id=1` 为 `day` / `50`；KV 的 `setting:` 缓存里 `resendTokens` 含发件域名（只核对 key 名，不打印值）。
- [ ] **CF Email Sending 已在面板启用且发送域名 `aevorynthtech.com` 为 Verified**（2026-11-08 待核查）；`deploy.sh` 里的 `email` 绑定仍是临时注释状态（TEMP 2026-11-08），确认域名 Verified 后再恢复，恢复后管理后台发信服务一栏须显示 **Cloudflare Email Sending**（不是 Resend Token）。
- [ ] Email Routing 的 MX / Catch-All 未做，收信冒烟未做；甲骨文巡检 + WAF 未做；TG Bot Token 未配。
- [ ] 收发信冒烟：新注册测试账号能发站外信（默认角色 day/50 必查）→ 站内信 → 站外信 → 外部回信；AI 冒烟：`/api/ai/chat`、`/ai/translate`、`/ai/triage` 返回 200 或 `ai_unavailable`（后者说明 AI 绑定未生效）。
- [ ] 开场动画、登录页居中、隐私仪表盘、恢复流程、撤回/定时发送在上线后人工走一遍。
- [ ] **不要碰老项目**：`mail.flame.edu.kg` 的 Worker/D1/KV/R2/Resend 一律不动；不要动线上 D1 数据（管理员账号、SNOWDEN 邀请码、已注册用户只做迁移）。

## 9. 下一阶段候选（Phase 9，来自 §12 第 11–17 项与本次已知问题）

`translate_cache` 90 天清理；撤回发送的实时化（Queues/Durable Objects）；系统发件人身份；备用邮箱验证；用户级 TG 绑定；归档文件夹；测试环境 `/init` secret 之谜定位；`ja/ko/vi/ru/es/fr` 缺失的约 70 个旧键补齐；CF Email Sending 域名 Verified 核查与 `email` 绑定恢复；Email Routing MX/Catch-All + 收信冒烟；甲骨文巡检 + WAF。

## 10. 变更规模

- 54 个已跟踪文件改动（+4553 / −291 行），新增文件 58 个（含 8 个新 API、8 个新 service、2 个 kernel 模块、9 个新 entity、5 个新前端视图、4 个 mail-trust 组件、AI 助手面板、5 个新测试文件）。
- 本地 6 个提交领先于 `origin/main`（含 Phase 7 的 2 个提交），未 push；`git fetch` 在本机无 GitHub 凭证失败，部署方自行处理。
