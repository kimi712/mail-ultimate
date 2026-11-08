# Phase 2–4 契约（总协调定稿，2026-11-08）

> 四路并行分工的唯一事实来源。文件归属互斥，任何人不得改别人的文件。
> 已定事项（不可再改）：
> 1. 2026-11-08 12:26 批准的 6 项：fork 不重写；单 IP 24h 限 3 个、IPv6 按 /64；全站每分钟超 20 熔断；Resend 撞线处理；甲骨文巡检自动封；Turnstile 每次验证 OPEN。
> 2. **新站域名 aevorynthtech.com（2026-11-08 12:46 定）**：DEPLOY.md 与全部部署准备按此域名写，不用占位符；全套全新 Worker/D1/KV/R2/Email Routing/Turnstile，与老站 mail.flame.edu.kg 完全隔离；GitHub 集成只留接口，不索要凭证；仍不实际部署。
> 3. 用户决定：接着完善全部剩余阶段（第二、三、四阶段 + 密钥库存告警），弄完他自己上传 GitHub，再由助手一键部署。
> 4. 第一阶段已完成（PHASE1.md，vitest 23/23）：不要破坏它，改完重跑 `test/phase1.spec.js` 必须全过。

## 0. 总协调已写好的共享基础（直接用，不用重写）

- `mail-worker/src/entity/login-log.js`、`alert-log.js`
- `mail-worker/src/service/alert-log-service.js`：`record(c, {type, text, source})`（永不抛错）、`list(c, {type, num, size})`
- `mail-worker/src/api/alert-log-api.js`：`GET /alertLog/list`、`POST /alertLog/record`（后者供巡检调用）
- `mail-worker/src/api/quota-api.js`：`GET /quota/resend` → `quotaService.getResendUsage(c)`（`{day, month, dayBudget, monthBudget}`）
- `mail-worker/src/init/init.js` 的 `v3_6DB`（见 §1），`init()` 里 `v3_5DB` 之后调用
- `mail-worker/src/const/kv-const.js`：新增 `REG_KEY_ALERT_DAY: 'reg_key_alert_day:'`
- `mail-worker/src/entity/setting.js`：新增 `regKeyAlertThreshold`（见 §1）
- `mail-worker/src/entity/user.js`：新增 `locale` 列（Phase 2–4 第四阶段语言偏好，见 §1）
- `mail-worker/src/service/telegram-service.js`：`sendAlert(c, text, type = 'system')`，第三参数可选，成功/失败都 best-effort 写 `alert_log`（type 见 §2）
- `mail-worker/src/security/security.js`：已加 requirePerms（`/alertLog/list`、`/alertLog/record`、`/quota/resend`、`/user/export`、`/user/groupByIp`）与 premKey（`alert:query`、`user:export`，`analysis:query` 增加 `/quota/resend`，`user:query` 增加 `/user/groupByIp`）
- `mail-worker/src/hono/webs.js`：已挂载 `alert-log-api`、`quota-api`

## 1. v3_6DB 迁移内容（init.js，沿用 v3_5DB 风格：每组独立 try/catch + console.warn）

```sql
CREATE TABLE IF NOT EXISTS login_log (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 0,
  email TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  is_new_ip INTEGER NOT NULL DEFAULT 0,   -- 1 = 与上次 active_ip 不同
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP   -- UTC
);
CREATE TABLE IF NOT EXISTS alert_log (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'system',     -- circuit | quota | reg-key | patrol | waf | system
  text TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'worker',   -- worker | patrol
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- 索引：login_log(user_id, create_time)、login_log(create_time)、alert_log(create_time)、alert_log(type, create_time)
-- setting 新列：ALTER TABLE setting ADD COLUMN reg_key_alert_threshold INTEGER NOT NULL DEFAULT 500;
-- user 新列：ALTER TABLE user ADD COLUMN locale TEXT NOT NULL DEFAULT '';（语言偏好，空 = 跟随浏览器/默认中文）
-- perm 种子行（INSERT...SELECT...WHERE NOT EXISTS，幂等）：
-- (43,'告警中心', NULL, 0, 1, 5.4)、(44,'告警查看','alert:query',43,2,0)
-- (45,'用户导出','user:export',6,2,8)   -- pid 6 = '用户信息' 父权限
```

## 2. 服务 API 契约（签名一字不差）

```js
// alert-log-service.js（总协调已写好）
alertLogService.record(c, { type, text, source })  // type: circuit|quota|reg-key|patrol|waf|system；永不抛错
alertLogService.list(c, { type, num, size })       // -> { list, total }，size 默认 50 上限 50

// telegram-service.js（总协调已改好）
telegramService.sendAlert(c, text, type = 'system') // 第三参数为 alert_log 的 type；无 TG 配置时只写库不发 TG

// login-log-service.js（A 路新建）
loginLogService.record(c, { userId, email, ip, ua, isNewIp })  // 永不抛错
loginLogService.listByUser(c, userId, { num, size })            // -> { list, total }

// quota-service.js（不动；A/C 两路只读）
quotaService.getResendUsage(c)  // -> { day, month, dayBudget, monthBudget }
```

## 3. 路由与权限（security.js 已由总协调加好，各路只按表调用，不改 security.js）

| API | 路由 | premKey |
|---|---|---|
| 告警列表/记录 | `GET /alertLog/list`、`POST /alertLog/record` | `alert:query` |
| Resend 配额 | `GET /quota/resend` | `analysis:query` |
| 用户导出 / IP 分组 | `GET /user/export`、 `GET /user/groupByIp` | `user:export` / `user:query` |
| 本人登录记录 | `GET /my/loginLog` | 无（任意登录用户，仅限本人数据，userId 取 `c.get('user').userId`） |

巡检调 Worker API 的认证：用管理员账号调 `POST /login`（`{email, password}`，读 `mail-worker/src/const/constant.js` 的 `TOKEN_HEADER` 取请求头名与 `api/login-api.js` 的返回结构）拿 JWT；security.js 对 `authInfo.user.email === c.env.admin` 的请求放行全部 requirePerms 路由，管理员无需逐项授权。

## 4. 各路任务与文件归属（互斥；只做手术式编辑，不整文件重写）

### A 路 — 密钥库存告警 + 第四阶段体验

> 补充需求（用户 2026-11-08 12:55 定，并入本路）：新站界面要炫一点、符合中国人用户习惯；华人用户也要有英语界面；语言可选 8 种。见本节末尾“补充：界面视觉升级 + 8 语种”。
- `service/reg-key-service.js`：新增 `maybeAlertLowStock(c)`：读 `setting.regKeyAlertThreshold`（默认 500）；`SELECT COALESCE(SUM(count),0) FROM reg_key WHERE count > 0 AND datetime(expire_time) > datetime('now')`；总量 < 阈值时发 TG 告警（`sendAlert(c, '⚠️ 注册密钥库存告警\n剩余总量 X（阈值 Y），请及时补充密钥。', 'reg-key')`），每天最多 1 次（KV `REG_KEY_ALERT_DAY + 日期` 去重）；全程 try/catch 永不抛错。需新增 import：settingService、telegramService、dayjs、KvConst（`sql/and/gt` 已有）。
- `service/login-service.js`：① `_register` 成功路径：`updateUserInfo` 之后、`return {regVerifyOpen}` 之前，`if (consumedCode) await regKeyService.maybeAlertLowStock(c)`（best-effort）。② `login()`：`updateUserInfo` 之前先取 `prevIp = userRow.activeIp`、`curIp = reqUtils.getIp(c)`；登录成功后（`return jwt` 之前）写 `loginLogService.record(c, {userId, email: userRow.email, ip: curIp, ua: reqUtils.getUserAgent(c) 拼串, isNewIp: prevIp && prevIp !== curIp ? 1 : 0})`；若 `isNewIp` 为 1，再发一封站内提醒邮件（走 `emailService.send(c, params, userId)`，收件人 = 用户本人邮箱，站内投递不占 Resend 配额；读 `email-service.js:335 send()` 的 params 结构再写；主题/正文含新 IP、UTC 时间、设备信息；全程 try/catch，永不阻断登录）。注意 `login()` 亦被 OAuth 以 `noVerifyPwd=true` 调用，同一代码路径覆盖。
- `service/login-log-service.js`（新建，见 §2 签名）。
- `api/my-api.js`（只加一个端点）：`GET /my/loginLog`，userId 取 `c.get('user').userId`，调 `loginLogService.listByUser`，分页同 register-log-api（num 1 起、size 默认 50 上限 50）。
- 前端 `mail-vue/src/views/login/index.vue`：注册/登录报错映射成人话。先读 `src/axios` 拦截器与本页 catch 处的报错呈现方式；后端抛的是 `t('key')` 解析后的中/英文串，映射表同时覆盖 zh 与 en 两种原文（读 `mail-worker/src/i18n/zh.js`、`en.js` 取准确原文）：`noRegKeyCount`（密钥余量不足）、`regKeyExpire`（密钥已过期）、`botVerifyFail` / `emptyBotToken`（验证失败请重试）、`regIpLimit`（该 IP 注册已达上限，请 24 小时后再试）、`regTooFrequent`（操作太频繁，请稍后再试）、`regCircuitOpen`（注册暂时关闭维护中）、`turnstileNotConfigured`（验证服务未配置，请联系管理员）、`ipBlockedRegister`（该 IP 已被封禁）。Turnstile 加载失败时在 `recoverTurnstile()` 旁补一句可见的降级提示。
- 前端 `mail-vue/src/views/send/index.vue`：写信页显示“今日还剩 X 封”——读 `store/user.js` 的 `loginUserInfo()`（已返回 `sendCount` 与角色 `sendCount`，见 `user-service.js:29` 附近）；`role.sendCount` 为空时不显示；发信失败 `daySendLimit` 时文案改成人话。
- 前端 `mail-vue/src/views/setting/index.vue`（个人设置页）：加“登录记录”区，调 `GET /my/loginLog`，表格列：时间 / IP / 设备 / 是否新 IP 徽章。
- 前端 `mail-vue/src/request/my.js`：加 `loginLog` 请求方法（有就复用）。
- 测试：`mail-worker/test/phase2a.spec.js`（新文件）：密钥余量 < 阈值告警 1 次/天去重、余量充足不告警、异地登录写 login_log + 同 IP 不标新、登录失败不写记录。先读 `test/phase1.spec.js` 的 fakeCtx/api 写法复用。

#### 补充：界面视觉升级 + 8 语种（用户 2026-11-08 12:55 定，并入本路）
- 公开页视觉升级（登录/注册页，即 `mail-vue/src/views/login/index.vue`，以及“首页”若指登录落地页则同文件）：更炫更现代、符合中国人用户习惯（例如：明亮通透的渐变/玻璃拟态、清晰的主操作按钮、移动端优先的排版），但只用 CSS 与少量内联 SVG，**不引入外部字体、不加新图片资源、不加重量级动画库**，不影响加载速度与可用性；不得破坏第一阶段的 Turnstile 渲染逻辑（同一文件内已有 `renderBindTurnstile` / `recoverBindTurnstile`，改样式时不要动其 JS 逻辑）；可用性优先：表单对比度、焦点态、错误提示位置保持清晰。
- i18n 框架支持 8 种语言切换：先读 `mail-vue/src/i18n/index.js`（vue-i18n `createI18n`）与 `mail-vue/src/main.js` 的挂载方式。简体中文默认、英文必备；其余 6 种只搭框架，不全量翻译——做法：新建 6 个语言文件（见下），其中公开页（登录/注册）字符串 8 语种齐全，其余字符串缺失时回落英文（vue-i18n fallbackLocale: 'en'）。**不要改 `mail-vue/src/i18n/zh.js`、`en.js`（只归总协调集成时改）；新语言文件各自独立新建，不存在并行冲突。**
- 语言切换持久化：localStorage 为主（键名 `mail-locale`，未登录的公开页即可切换并立即生效）；登录后同步到后端 `user.locale` 列（总协调已在 v3_6DB 与 entity/user.js 加好）：`api/my-api.js` 里加 `POST /my/locale`（`{locale}`，写当前用户 `locale` 列）与 `GET /my/locale`（或复用 `loginUserInfo` 返回的 user 行——先读 `userService.loginUserInfo` 返回字段，若已含全行则直接用）；登录成功后以前端 localStorage 为准写一次后端；下次登录时以后端 `locale` 为准回写 localStorage（后端为空时跟随浏览器语言，`navigator.language` 以 `zh` 开头 → zh-CN，否则 en）。
- 语言切换器 UI：公开页（登录/注册）右上角 + 主界面设置区各放一个（下拉选择，8 种语言名用各自母语显示，如 English / 简体中文 / 日本語 …）；切换后全界面即时生效（注册页、登录页、主界面全覆盖）。
- 6 种语言提案（写进 PHASE2-A.md 的“待用户确认”节，总协调再写进 PHASE2-4.md，**不要自己拍板定死**）：总协调建议：English（必备）、日本語、한국어、Tiếng Việt（越南语，本站用户量最大的非中文群体）、Русский（俄语，.kg 域名所在地吉尔吉斯斯坦的官方语言之一）、Español（西班牙语）。备选：Français、Deutsch、Português。提案要写一句话理由，并注明“待用户确认后才全量翻译”。
- 翻译文件结构保留并扩展：`mail-vue/src/i18n/` 下 zh.js/en.js 结构不动（只归总协调集成时改）；新语言文件仿照 zh.js 的 key 结构建（同名 key、不缺公开页 key）；第一阶段新增的 7 个后端 i18n key（turnstileNotConfigured、regIpLimit、regTooFrequent、regCircuitOpen、ipBlockedRegister、ipBlockedAccess、resendQuotaExhausted）不受影响——它们在 `mail-worker/src/i18n/`，与本次前端改动无关。
- 验收：前端构建通过；切换 8 种语言公开页无缺 key 报错（缺失回落英文）；localStorage 持久化（刷新后保持）；登录后后端 `locale` 列有值且下次登录恢复；首屏不新增外部请求（构建产物对比：vendor chunk 不显著增大，非默认语言按需懒加载）。

### B 路 — 甲骨文风控巡检 oracle-patrol/（全新目录，与 mail-ultimate 主代码零交集）
- 目录：`~/workspace/mail-ultimate/oracle-patrol/`。Node ≥ 18，**零运行时依赖**（只用内置 fetch/http），`package.json`（type: module）+ `src/` + `test/` + `README.md` + `config.example.json` + `patrol.service`（systemd 单元）。
- 配置（`config.json`，`.gitignore` 必须忽略；另支持环境变量覆盖；**绝不提交真实配置，绝不在日志里打印任何密钥**）：`cloudflare {apiToken, accountId, zoneId, d1DatabaseId, wafRuleName}`、`worker {baseUrl}`（示例 `https://aevorynthtech.com/api`）、`admin {email, password}`（密码优先读环境变量 `MAIL_PATROL_ADMIN_PASSWORD`）、`abuseipdb {apiKey, maxAgeInDays: 90, minReports: 1}`、`telegram {botToken, chatId}`、`patrol {intervalMinutes: 5, regWindowHours: 24, regLimit: 3, wafSyncEnabled: true, dryRun: false}`、`kumaPushUrl`（可选，Uptime Kuma push 心跳）。
- 模块：`src/config.js`（读配置 + 校验必填 + 脱敏打印）、`src/d1.js`（CF D1 REST API：`POST /client/v4/accounts/{account_id}/d1/database/{database_id}/query`，只读查询）、`src/worker-api.js`（登录拿 JWT + 调 `/ipBlocklist/add`、`/alertLog/record`、`/quota/resend`，401 时重登一次）、`src/waf.js`（Rulesets API：按 `wafRuleName` 找 `http_request_firewall_custom` 规则，表达式 `http.host eq "aevorynthtech.com" and ip.src in { ... }`；**先用 browser.search 查 Cloudflare Rulesets API 文档核实接口形状**；只改目标规则，失败只记日志 + TG 告警，绝不删规则）、`src/abuseipdb.js`（`/api/v2/check`，结果缓存 24h 写 state.json，省免费额度 1000/天）、`src/telegram.js`（直调 TG Bot API）、`src/state.js`（`state.json`：lastWafSync、告警去重、abuse 缓存、连续失败次数、lastRun）、`src/patrol.js`（单次巡检）、`src/index.js`（循环 + `--once` + `--dry-run`）。
- 每轮巡检（UTC 时间）：① D1 查 24h 内 `user` 表 `create_ip` 分组计数（`is_del=0` 且 `create_ip != ''`，`HAVING n >= regLimit`），未在 `ip_blocklist`（D1 直读该表，有效行）里的超限 IP → Worker API `/ipBlocklist/add`（scope 0，reason 写明“巡检：24h 内注册 N 次”）+ WAF 同步 + TG 告警 + `/alertLog/record`（type `patrol`）。② AbuseIPDB：D1 查近 1h 新注册的不同 IP（上限 200 个），逐个查（缓存 24h），`totalReports > 0` 的按用户标准自动封（scope 0，reason 写明 AbuseIPDB 举报数与最近举报类别）+ 同 ① 的告警链；无举报的不封，只记日志。③ Resend 配额：`GET /quota/resend`，≥80% 告警（每天每档 1 次，state 去重），≥100% 立即告警。④ WAF 同步：WAF 规则 IP 集 = D1 `ip_blocklist` 全部有效行（scope 0 与 1 都进 WAF，沿用现网做法）；仅当集合变化时才推；推送失败记日志 + TG 告警，不影响 D1 封禁结果。⑤ 失联检测：连续 3 轮失败（D1/API 全挂）发一次 TG“巡检失联”告警，恢复后发“巡检恢复”。
- 原则重申：CF 是唯一在线写 D1 的入口；巡检只读 D1 + 调 CF API + 发告警；**巡检挂了主站不受影响**；批量写分批 + 重试（§8 坑 1）；配置里不写死任何线上 id/密钥（示例文件只放占位）。
- 测试：`oracle-patrol/test/*.test.js`（`node:test` + 内置 http 起 mock 服务器模拟 CF D1/WAF/TG/Worker 四方，断言封禁判定、去重、WAF 表达式生成、dry-run 不发真实请求）；`node --test test/` 全过。另写 README：安装、配置、试运行（`node src/index.js --once --dry-run`）、systemd 部署（3 核 18G 129.225.13.58 主服务 + 1 核 6G 热备 + Uptime Kuma push 心跳）。
- **不连线上**：开发与测试全程只调 mock 或 `--dry-run`；真实配置与首次上线写进 README 与 DEPLOY.md，不在本机执行。

### C 路 — 第三阶段后台
- `service/user-service.js`：`list()` 的 conditions 里加 `createIp` 筛选（精确匹配；`createIpPrefix` 前缀 LIKE，二者只取其一，复用 `email` 的 `COLLATE NOCASE LIKE` 写法）；新增 `groupByIp(c, {min = 2})`：`SELECT create_ip, COUNT(*) AS total FROM user WHERE is_del = 0 AND create_ip != '' GROUP BY create_ip HAVING total >= ? ORDER BY total DESC LIMIT 100`（`idx_user_create_ip` 第一阶段已建）。
- `api/user-api.js`（只加两个端点，复用 `list()` 的筛选参数）：`GET /user/export`（CSV：`Content-Type: text/csv; charset=utf-8`，加 BOM 供 Excel 认中文；列：userId, email, createIp, activeIp, status, type, createTime；分页循环拉全量，上限 5000 行，超了返回 400 并提示缩小筛选）；`GET /user/groupByIp`（`{min}` 参数，调 `groupByIp`）。
- `service/analysis-service.js`：`queryEcharts()` 返回值加 `risk` 对象（其余字段原样不动；KV 缓存路径自动带上）：`registerTrend`（`register_log` result=0 近 15 天按日计数，复用 `filterEmptyDay` 的日期序列）、`ipTop10`（`user` 表 `create_ip` Top 10，`is_del=0`）、`circuitEvents`（近 7 天 `register_log` 里 `fail_reason` 含 `regCircuitOpen` 的条数 + 当前 `setting.reg_circuit_open` 值）、`regKeyRemaining`（未过期密钥 `SUM(count)`）、`resendUsage`（调 `quotaService.getResendUsage(c)`）。注意：`queryEcharts` 里已有 `Promise.all`，新查询并进去；任一查询失败不得拖垮整个仪表盘（try/catch 后给默认值）。
- 前端 `mail-vue/src/views/user/index.vue`：加 `createIp` 列 + 筛选框（精确/IP 前缀二选一）+ 批量操作复用现有 `delete`/`restore` 多选模式 + “导出 CSV”按钮（调 `/user/export`，blob 下载，文件名带日期）。
- 前端 `mail-vue/src/views/analysis/index.vue`：加“风控”卡片区，复用现有 ECharts 组件：注册趋势折线（`risk.registerTrend`）、IP Top 10 表格、熔断状态（开/关 + 近 7 天触发次数）、密钥剩余量、Resend 日/月用量进度条（`risk.resendUsage`）。
- 前端新页（各建 `index.vue`，复用现有列表页写法与 `request/` 模式）：`views/ip-blocklist/index.vue`（调 `/ipBlocklist/list|add|delete`，列：IP/段/scope/原因/到期时间/操作人，含添加/解封表单）、`views/alert-center/index.vue`（调 `/alertLog/list`，type 筛选 + 分页）、`views/register-log/index.vue`（调 `/registerLog/list`，ip/结果/时间筛选）、`views/audit-log/index.vue`（调 `/auditLog/list`）。
- 前端 `mail-vue/src/perm/perm.js` 的 `routers` 里加：`'ip-block:query': [{path: '/ip-blocklist', name: 'ip-blocklist', component: () => import('@/views/ip-blocklist/index.vue'), meta: {title: 'ipBlocklist', name: 'ip-blocklist', menu: true}}]`；`'alert:query'` → `/alert-center`（`alertCenter`）；`'register-log:query'` → `/register-log`（`registerLog`）；`'audit-log:query'` → `/audit-log`（`auditLog`）。title 键在 i18n 里由总协调集成时补（先写英文 key 占位，见 §5）。
- 前端 `mail-vue/src/request/`：新建 `ip-blocklist.js`、`alert-center.js`、`register-log.js`、`audit-log.js`（仿照 `request/user.js` 的写法）；导出 CSV 走 `request/user.js` 加方法。
- 测试：`mail-worker/test/phase2c.spec.js`（新文件）：user list 按 IP 筛选、groupByIp 聚合、export 上限与 CSV 头、queryEcharts 含 risk 字段、黑名单/日志 list API 权限（无权限 403）。先读 `test/phase1.spec.js` 复用 fakeCtx/api。

### D 路 — 部署准备（总协调亲自做，各路完成后）
- `DEPLOY.md` + `deploy.sh`：域名 **aevorynthtech.com**，全套全新资源；见 §8。

## 5. i18n 规则（避免并行改同一文件丢改动）

- **`mail-vue/src/i18n/zh.js`、`en.js` 各路一律不改。** 各路在代码里直接用 `t('新key')` / `$t('新key')`，并在自己的交付小结里列出“新 key 清单：key = 中文 / English”，总协调集成时一次性补进两个文件再重跑前端构建。
- 后端 `mail-worker/src/i18n/zh.js`、`en.js` 同理：各路只管用 `t('新key')`，清单给总协调。

## 6. 全局硬约束（重申，违反即返工）

- 绝不动线上：不碰 mail.flame.edu.kg、D1 cloud-mail、Worker cloud-mail、任何线上凭证；只改 `~/workspace/mail-ultimate/` 下的本地代码（巡检在 `oracle-patrol/` 子目录）。
- 不动收发信主流程、JWT、RBAC、现有表结构（只做加法；`rege_key_id` 与 `user.send_count` 原样不动）；时间统一 UTC（`create_time` 用 `CURRENT_TIMESTAMP`，窗口计算用 SQLite `datetime('now', ...)` 或 dayjs UTC）。
- 任何新服务函数凡是“记日志/发告警/计配额”类的，一律永不抛错（内部 try/catch + console.error），不得影响主流程。
- 不提交任何密钥；`jwt_secret` 重新生成是部署步骤，现在不做；不部署（新域名未定到部署时才用）。
- 依赖安装：`npm install --no-package-lock --no-save`（不改 package.json/lockfile；node_modules 已在 .gitignore）。不要用 pnpm（VM 未装）。
- 每个改动点在各自的交付小结里留行号级位置；跑不起来的验证写明原因 + 手动验证步骤，不要谎报通过。
- **禁止并行改同一文件**：文件归属见 §4 与本节——`init.js`、`entity/setting.js`、`const/kv-const.js`、`hono/webs.js`、`security/security.js`、`service/telegram-service.js` 只归总协调（已改好）；`i18n/zh.js`、`en.js`（前后端各两份）只归总协调集成时改；其余文件按 §4 归属，A/B/C 三路互不重叠。

## 7. 各路交付物与验收

- A 路：改动文件清单 + 新 key 清单 + `test/phase2a.spec.js` 全过 + 前端构建通过（`npm run build`，`--legacy-peer-deps` 既有问题见 PHASE1.md §4）。交付小结写进 `~/workspace/mail-ultimate/PHASE2-A.md`。
- B 路：`oracle-patrol/` 完整目录 + README + `node --test test/` 全过 + `--dry-run` 试运行记录。交付小结写进 `oracle-patrol/README.md` 末尾“交付记录”节。
- C 路：改动文件清单 + 新 key 清单 + `test/phase2c.spec.js` 全过 + 前端构建通过。交付小结写进 `~/workspace/mail-ultimate/PHASE2-C.md`。
- 总协调集成：重跑 `test/phase1.spec.js`（23 个）+ `phase2a` + `phase2c` 全过，前端构建通过，补 i18n，写 `PHASE2-4.md` + `DEPLOY.md` + `deploy.sh`。

## 8. 部署准备（D 路，总协调做；各路不用碰）

- `~/workspace/mail-ultimate/DEPLOY.md`：一键部署指南，域名 **aevorynthtech.com**：新建 Cloudflare 资源（D1 新库、KV、R2、Worker 新名字、Email Routing MX/SPF/DKIM、Turnstile 新站点、Resend 新域名 token 或复用 CF Email）、`wrangler.toml` 模板（域名/admin/jwt_secret 填新值，`jwt_secret` 重新生成）、`deploy.sh`（一条命令完成前端构建 + `wrangler deploy` + 部署后检查清单，含先跑 `/init` 再启用、核对 `pragma_table_info`、回归清单引用 PHASE1.md §6 + PHASE2-4.md 回归清单）。
- GitHub 集成只留接口：`deploy.sh` 里留 `GH_REPO` 变量与 `git remote add origin` 占位步骤（用户自己上传后再填，不索要凭证）；README 里写清“先 git push 到你自己的仓库，再跑部署”。
- 不实际部署、不连线上、不创任何线上资源。
