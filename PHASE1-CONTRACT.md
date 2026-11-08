# Phase 1 契约（总协调定稿，2026-11-08）

> 三路并行分工的唯一事实来源。文件归属互斥，任何人不得改别人的文件。
> 已定 6 项（用户 2026-11-08 12:26 批准，不可再改）：
> 1. cloud-mail main（HEAD d115f4c）为底 fork，不重写。
> 2. 单 IP 注册限额：每 IP 每 24h 3 个，IPv6 按 /64 计。
> 3. 全局熔断：全站每分钟注册超 20 个自动关注册/强制验证。
> 4. Resend 撞线后自动切 CF Email Sending（见下文“渠道选择”说明）。
> 5. 甲骨文巡检自动封禁是第二阶段；本阶段只留写入口（ip_blocklist 表 + service + API），不接 WAF API。
> 6. Turnstile 每次验证（OPEN）。

## 0. 已由总协调写好的共享基础（直接用，不用重写）

- `mail-worker/src/entity/register-log.js`、`audit-log.js`、`ip-blocklist.js`
- `mail-worker/src/service/register-log-service.js`、`audit-log-service.js`、`quota-service.js`、`ip-blocklist-service.js`
- `mail-worker/src/const/kv-const.js`（新增 RESEND_DAY / RESEND_MONTH / RESEND_ALERT_DAY）
- `mail-worker/src/const/entity-const.js`（新增 `ipBlocklistConst.scope`、`registerLogConst.result`）
- `mail-worker/src/i18n/zh.js`、`en.js`（新增 7 个 key，见 §5）

## 1. 新 setting 列（entity/setting.js + init.js v3_5DB，二者缺一不可）

| 列 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `ip_reg_limit` | INTEGER NOT NULL | 3 | 每 IP 段每窗口期成功注册上限 |
| `ip_reg_window_hours` | INTEGER NOT NULL | 24 | 上限窗口（小时） |
| `reg_rate_limit_per_min` | INTEGER NOT NULL | 5 | 每 IP 段每分钟注册尝试上限（含失败） |
| `reg_circuit_threshold` | INTEGER NOT NULL | 20 | 全站每分钟注册数熔断阈值 |
| `reg_circuit_open` | INTEGER NOT NULL | 0 | 熔断状态：0 关 / 1 开（自动置 1，管理员手动置 0 恢复） |
| `resend_day_budget` | INTEGER NOT NULL | 100 | Resend 每日预算（封） |
| `resend_month_budget` | INTEGER NOT NULL | 3000 | Resend 每月预算（封） |

注意：`setting` 是单行表；`setting-service.set()` 是全量 `update(setting).set({...params})`，
新增列只要进了 entity 即可被后台设置页读写；**不要把熔断阈值、黑名单透传给公开的 `websiteConfig()`**（§8 坑 10）。

## 2. 新表 DDL（init.js `v3_5DB`，在 `init()` 里 `v3_4DB` 之后调用；全部 `IF NOT EXISTS`）

```sql
CREATE TABLE IF NOT EXISTS register_log (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL DEFAULT '',
  ip_segment TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  reg_key_code TEXT NOT NULL DEFAULT '',
  result INTEGER NOT NULL DEFAULT 0,
  fail_reason TEXT NOT NULL DEFAULT '',
  verify_mode INTEGER NOT NULL DEFAULT 0,
  ua TEXT NOT NULL DEFAULT '',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_register_log_segment_time ON register_log(ip_segment, create_time);
CREATE INDEX IF NOT EXISTS idx_register_log_create_time ON register_log(create_time);
CREATE INDEX IF NOT EXISTS idx_register_log_ip_time ON register_log(ip, create_time);

CREATE TABLE IF NOT EXISTS audit_log (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_log_create_time ON audit_log(create_time);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_time ON audit_log(actor_user_id, create_time);

CREATE TABLE IF NOT EXISTS ip_blocklist (
  block_id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL DEFAULT '',
  ip_segment TEXT NOT NULL DEFAULT '',
  scope INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  expire_time DATETIME,
  created_by TEXT NOT NULL DEFAULT '',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ip_blocklist_ip ON ip_blocklist(ip);
CREATE INDEX IF NOT EXISTS idx_ip_blocklist_segment ON ip_blocklist(ip_segment);

-- 风控聚合需要（study §3：user.create_ip 原先无索引）
CREATE INDEX IF NOT EXISTS idx_user_create_ip ON user(create_ip);
-- verify_record.ip 复合索引（配合 entity 类型修正，见 §6）
CREATE INDEX IF NOT EXISTS idx_verify_record_ip_type ON verify_record(ip, type);
```

另：`v3_5DB` 里用 `INSERT ... SELECT ... WHERE NOT EXISTS` 方式补 perm 种子行（id 见 §4），
**不要**改动 `intDB` 里已有的 perm 种子块。

## 3. 服务 API 契约（签名一字不差；实现已由总协调写好，调用方照此用）

```js
// register-log-service.js
registerLogService.record(c, { ip, ipSegment, email, regKeyCode, result, failReason, verifyMode, ua })
  // result: 0 成功 / 1 失败；永不抛错（内部 try/catch）
registerLogService.countSuccessBySegment(c, ipSegment, hours)   // -> Number
registerLogService.countAttemptsBySegment(c, ipSegment, minutes) // -> Number（含成功+失败）
registerLogService.countRecentAll(c, minutes)                    // -> Number（全站）

// audit-log-service.js
auditLogService.record(c, { action, targetType, targetId, detail })
  // actor/ip/ua 自动从 c.get('user') 与请求头取；永不抛错

// ip-blocklist-service.js
ipBlocklistService.isBlocked(c, ip, ipSegment, scope) // -> 行对象 | null（scope: 0=禁注册 / 1=禁访问；过期行视为未封）
ipBlocklistService.add(c, { ip, ipSegment, scope, reason, expireTime, createdBy }) // -> 行对象（写 audit_log）
ipBlocklistService.remove(c, blockId)  // 写 audit_log
ipBlocklistService.list(c, { scope, page, size }) // -> { list, total }

// quota-service.js
quotaService.getResendUsage(c)        // -> { day, month, dayBudget, monthBudget }
quotaService.hasResendBudget(c)       // -> Boolean（日月都未超）
quotaService.recordResendSent(c, n)   // KV 计数，永不抛错
quotaService.maybeAlertQuota(c)       // 用量 >=80% 时 TG 告警（每天每档最多 1 次），永不抛错

// telegram-service.js（C 路新增）
telegramService.sendAlert(c, text)    // 通用 TG 告警，复用 tgBotToken/tgChatId，永不抛错

// req-utils.js（A 路改）
reqUtils.getIp(c)        // 只信任 CF-Connecting-IP，无则 'Unknown'（删 X-Forwarded-For 回落，§8 / study §5.4）
reqUtils.getIpSegment(c) // IPv4 返回原 IP；IPv6 返回 /64（前 4 组 hextet，小写、展开 :: 归一化，去 zone id）
```

## 4. 路由与权限（新增 API 一律挂 requirePerms + premKey；管理员靠 c.env.admin 绕过）

| API | 路由 | premKey |
|---|---|---|
| ip-blocklist list/add/delete | `/ipBlocklist/list`、`/ipBlocklist/add`、`/ipBlocklist/delete` | `ip-block:query`（list）、`ip-block:set`（add/delete） |
| register-log list | `/registerLog/list` | `register-log:query` |
| audit-log list | `/auditLog/list` | `audit-log:query` |

perm 种子行（v3_5DB 里 `INSERT ... SELECT ... WHERE NOT EXISTS`，id 不与已有 1–36 冲突）：
- `(37,'IP黑名单', NULL, 0, 1, 5.2)`、`(38,'黑名单查看','ip-block:query',37,2,0)`、`(39,'黑名单管理','ip-block:set',37,2,1)`
- `(40,'风控日志', NULL, 0, 1, 5.3)`、`(41,'注册日志查看','register-log:query',40,2,0)`、`(42,'审计日志查看','audit-log:query',40,2,1)`

`security.js` 的 `requirePerms` 数组与 `premKey` 映射同步加上述路由。

## 5. 新增 i18n key（已由总协调写入 zh.js / en.js，直接用 `t('...')`）

`turnstileNotConfigured` / `regIpLimit` / `regTooFrequent` / `regCircuitOpen` /
`ipBlockedRegister` / `ipBlockedAccess` / `resendQuotaExhausted`

## 6. 各路任务与文件归属（互斥；只做手术式编辑，不整文件重写）

### A 路 — 注册门禁（login-service / req-utils / security / ip-blocklist API）
- `service/login-service.js` 的 `register()`：入口检查顺序（全部在 `register===CLOSE` 判断之后、格式校验之前）：
  1. 取 `ip = reqUtils.getIp(c)`、`ipSegment = reqUtils.getIpSegment(c)`；
  2. `ipBlocklistService.isBlocked(c, ip, ipSegment, 0)` → 命中抛 `t('ipBlockedRegister')`（429）；
  3. 熔断：`setting.regCircuitOpen===1` → 抛 `t('regCircuitOpen')`；否则 `registerLogService.countRecentAll(c,1)` ≥ `setting.regCircuitThreshold` → D1 置 `setting.reg_circuit_open=1` + `settingService.refresh(c)` + `telegramService.sendAlert(c, ...)`（best-effort，失败不阻断）+ 抛 `t('regCircuitOpen')`；
  4. 限流：`registerLogService.countAttemptsBySegment(c, ipSegment, 1)` ≥ `setting.regRateLimitPerMin` → 抛 `t('regTooFrequent')`（429）；
  5. IP 限额：`registerLogService.countSuccessBySegment(c, ipSegment, setting.ipRegWindowHours)` ≥ `setting.ipRegLimit` → 抛 `t('regIpLimit')`（429）。
  - 删除 `if (oauth)` 的两行强制覆盖（`registerVerify=CLOSE`、`register=OPEN`）；`register(c, params, oauth)` 的 `oauth` 参数随之删除，签名改为 `register(c, params)`（B 路同步改 `bindUser` 调用）。
  - `register()` 全程包 try/finally 写注册日志：成功在 `return {regVerifyOpen}` 前 `record(result:0, verifyMode: registerVerify, regKeyCode: code||'')`；任何 `throw` 前由 catch 统一 `record(result:1, failReason: err.message)` 后 rethrow。日志写入失败不得影响主流程（record 本身永不抛错）。
  - 注意 `COUNT` 模式的既有逻辑保留（`increaseRegCount` 等），但验证条件改为“`registerVerify !== CLOSE` 即验证”（见 B 路）。
- `utils/req-utils.js`：按 §3 改 `getIp`、新增 `getIpSegment`（IPv6 /64 归一化；`::` 展开、去 `%zone`、小写）。
- `security/security.js`：中间件最顶部（`exclude` 判断之前）加 scope=1 检查：`ipBlocklistService.isBlocked(c, ip, ipSegment, 1)` 命中 → 抛 `t('ipBlockedAccess')`（403）。管理员逃生口：请求头带有效 JWT 且其 email === `c.env.admin` 时跳过此检查。检查直接读 D1（§8 坑 2：关键开关不只依赖 KV 缓存）；索引已建，单次查询成本可接受。
- `api/ip-blocklist-api.js`（新建）+ `hono/webs.js`（只加 import 行挂载）+ `security.js` 的 requirePerms/premKey（§4）。
- 验证：`node --check` 语法；用 C 路的 `test/phase1.spec.js` 覆盖门禁逻辑（A 路提供用例清单给 C 路）。

### B 路 — Turnstile fail-closed + 默认 OPEN + 堵 OAuth 旁路
- `service/turnstile-service.js:verify()`：开头加 `if (!settingRow.secretKey) throw new BizError(t('turnstileNotConfigured'), 400)`；`fetch` 与 `res.json()` 包 try/catch，任何异常 → 抛 `t('botVerifyFail')`（fail-closed，绝不放行）；`result.success` 严格判断（不变）。
- `entity/setting.js`：`registerVerify` 默认值 `1` → `0`。
- `init.js` 种子行：`intDB` 里 `INSERT INTO setting (...) SELECT 0, 0, 0, 0, 'Cloud Mail', 0, 1, 1` 的第 7 个值（register_verify）`1` → `0`。**只改种子，不写 UPDATE**：已存在库的管理员选择不受影响（新站从零建库才生效）。
- `login-service.js` 不动（A 路的地盘）；但 `register()` 里的验证分支需与 A 路约定一致：`registerVerify === OPEN` 或 `COUNT` 时都验证（即 `!== CLOSE` 即验证），`COUNT` 的 `verify_record` 计数逻辑原样保留（add-email 的 ADD 类型不受影响）。
- `service/oauth-service.js:bindUser()`：`register(c, {...}, true)` → `register(c, { email, password: cryptoUtils.genRandomPwd(), code, token })`（token 从 `params` 取，见下）；`bindUser` 的 params 增加 `token` 字段；`oauth-api.js` 的 bindUser 路由确认把前端传来的 `token` 透传进 params。
- 前端：`mail-vue/src/views/login/index.vue:575` 渲染条件改为 `registerVerify === 0 || registerVerify === 2` 时渲染 Turnstile（COUNT 也必验；与后端一致）；找到 OAuth 绑定页（`mail-vue/src/request/ouath.js` 的 `bindUser` 调用方），在绑定表单上渲染 Turnstile 并把 token 随表单发给 `PUT /oauth/bindUser`。`mail-vue/src/request/ouath.js` 的 `bindUser(form)` 透传 token。
- 验证：前端 `npm run build`（或等价）通过；Turnstile 未配置 secret 时 `verify()` 抛 `turnstileNotConfigured`（可用 C 路测试覆盖）。

### C 路 — 日志、配额、迁移、测试
- `init.js`：新增 `v3_5DB(c)`（§2 全部 DDL + §4 perm 种子行），在 `init()` 里 `v3_4DB` 之后调用。迁移风格沿用现有：每组语句独立 try/catch + `console.warn`（但**在 PHASE1.md 里写明部署后必须核对 `pragma_table_info`**，不要静默以为成功）。不改任何现有列定义、不改 `rege_key_id` 拼写（§8 坑 6）。
- `entity/verify-record.js`：`ip: integer('ip')` → `text('ip')`（与 DDL 一致的 ORM 映射修正，不改 D1 列定义；study §8 坑 5）。
- `service/email-service.js:send()` 渠道选择处：现有优先级不变（站内 → CF → Resend），但在进 Resend 分支前加配额检查：
  - `quotaService.hasResendBudget(c)` 为 false → 抛 `t('resendQuotaExhausted')`（不调 Resend、不写发送记录）；
  - `sendResend()` 生成器里 Resend API 成功返回后调 `quotaService.recordResendSent(c, 收件人数)`（分开发送按实际成功封数计；失败不计）；
  - `send()` 入口（有站外收件人时）调 `quotaService.maybeAlertQuota(c)`（best-effort）。
  - 说明：CF 已配置时现有逻辑永远走 CF、Resend 根本不用，所以“撞线切 CF”在本实现里体现为——Resend 是无 CF 时的唯一外发通道，撞线即停发并告警；一旦配了 CF，`useCloudflareEmail` 分支天然优先。把这点写进 PHASE1.md，不要假装改了优先级。
- `service/telegram-service.js`：新增 `sendAlert(c, text)`（§3 契约；复用 `tgBotToken`/`tgChatId` 多人逗号分隔；`fetch` 失败只 `console.error`，永不抛错）。
- 审计写入点（调 `auditLogService.record`，action 命名 `setting:update` / `user:set-status` / `user:delete` / `user:restore` / `user:physics-delete` / `reg-key:add` / `reg-key:delete`）：
  - `service/setting-service.js:set()`（末尾，detail 含被改的 key 列表，不含密钥值）；
  - `service/user-service.js:setStatus()`、`delete()`、`restore()`、`physicsDelete()`；
  - `service/reg-key-service.js:add()`、`delete()`。
- `api/register-log-api.js`、`api/audit-log-api.js`（新建 list 接口：按 ip / 结果 / 时间范围筛选 + 分页，复用 `user-api.js` 的分页写法）+ `hono/webs.js`（只加 import 行）+ `security.js` requirePerms/premKey（§4）。
- 测试 `test/phase1.spec.js`（vitest + `@cloudflare/vitest-pool-workers`，已配依赖）：覆盖注册成功、IP 限额（第 4 个同段注册被拒）、分钟限流、熔断触发、Turnstile 未配置 secret 抛错、OAuth 绑定走正常注册流程（token 缺失时被拒）、Resend 配额耗尽不调 Resend。先跑通 `wrangler dev` 本地 D1/KV（`wrangler-dev.toml` 有本地配置就用，没有就现配，不动线上绑定）。`test/index.spec.js` 的 Hello World 占位用例与真实 Worker 不符，删掉或改掉（注明原因）。

## 7. 全局硬约束（重申，违反即返工）

- 绝不动线上：不碰 mail.flame.edu.kg、D1 cloud-mail、Worker cloud-mail、任何线上凭证；只改 `~/workspace/mail-ultimate/`。
- 不动收发信主流程、JWT、RBAC、现有表结构（只做加法；三个类型错配坑里只修 `verify_record.ip` 的 ORM 映射，`rege_key_id` 与 `user.send_count` 原样不动）。
- 时间统一 UTC：`create_time` 用 `CURRENT_TIMESTAMP`；窗口计算用 SQLite `datetime('now', '-N hours')` 或 dayjs UTC，不要混本地时区。
- 任何新服务函数凡是“记日志/发告警/计配额”类的，一律永不抛错（内部 try/catch + console.error），不得影响主流程。
- 不提交任何密钥；`jwt_secret` 重新生成是部署步骤，现在不做；不部署（新域名未定）。
- 依赖安装：`npm install --no-package-lock --no-save`（不改 package.json/lockfile；node_modules 已在 .gitignore）。不要用 pnpm（VM 未装）。
- 每个改动点在 PHASE1.md 里留行号级位置；跑不起来的验证写明原因 + 手动验证步骤，不要谎报通过。
