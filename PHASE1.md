# 终极版邮箱 · 第一阶段（P0 防刷核心）交付记录

> 状态：**已完成，本地验证通过，未部署，未动线上**。
> 工作目录：`~/workspace/mail-ultimate/`（cloud-mail main HEAD `d115f4c` 的 fork，未提交）。
> 底子：cloud-mail main fork，不重写。老站 mail.flame.edu.kg、D1 cloud-mail、Worker cloud-mail 全程未碰。
> 协调方式：总协调先写契约与共享基础（`PHASE1-CONTRACT.md`），A/B/C 三路并行开发，总协调集成审查 + 补两个缺口 + 实跑测试。

## 1. 五项任务完成情况

### 1.1 注册入口限额 / 限流 / 熔断（A 路）
- `mail-worker/src/service/login-service.js`
  - `register(c, params)`（:33）：签名由三参改为二参，`oauth` 强制覆盖已删；外层 try/catch 写注册日志（成功 `result:0`，任何 throw 记 `result:1` + `failReason` 截断 200 字后 rethrow）。
  - `_register(c, params, ctx)`（:61）：门禁在 `register===CLOSE` 判断之后、格式校验之前，顺序固定：黑名单 scope=0 → `t('ipBlockedRegister')` 429（:81）→ 熔断已开 / 全站 1 分钟注册数 ≥ 阈值则置位 + 告警 → `t('regCircuitOpen')` 429（:86–92）→ 分钟限流 → `t('regTooFrequent')` 429（:99）→ 24h IP 限额 → `t('regIpLimit')` 429（:107）。
  - `_tripCircuit(c, ...)`（:242）：D1 原生 SQL 置 `setting.reg_circuit_open=1` + `settingService.refresh(c)` + `telegramService.sendAlert`，三步各自 try/catch，best-effort。
  - 验证条件（:190）：`registerVerify !== CLOSE` 即验证（OPEN 与 COUNT 都必验；COUNT 的 `verify_record` 计数逻辑原样保留）。
- `mail-worker/src/utils/req-utils.js`：`getIp`（:34）只信任 `CF-Connecting-IP`，删 `X-Forwarded-For` 回落；`getIpSegment(c, ip)`（:41）IPv4 原样、IPv6 取 /64（`expandIPv6` :4，小写、去前导 0、`::` 展开、去 `%zone`、IPv4 映射地址先转 hextet），非法输入回落原值、永不抛错。
- 限额/限流/熔断的计数源：`register_log` 表（`service/register-log-service.js`：`countSuccessBySegment` / `countAttemptsBySegment` / `countRecentAll`，窗口用 SQLite `datetime('now', ...)`，UTC）。

### 1.2 Turnstile fail-closed + 默认 OPEN + 堵 OAuth 旁路（B 路）
- `mail-worker/src/service/turnstile-service.js:verify()`（:7）：无 `secretKey` 时抛 `t('turnstileNotConfigured')` 400（且根本不调 siteverify）；`fetch` / `res.json()` 包 try/catch，任何异常一律抛 `t('botVerifyFail')`；`!result || !result.success` 抛错。token 为空先抛 `emptyBotToken` 的原有逻辑不动。
- `mail-worker/src/entity/setting.js`：`registerVerify` 默认值 `1` → `0`；`mail-worker/src/init/init.js` 种子行（intDB）：`SELECT 0,0,0,0,'Cloud Mail',0,1,1` → `...,0,0,1`。只改种子，无 UPDATE（已存在库的管理员选择不受影响）。
- `mail-worker/src/service/oauth-service.js:bindUser()`（:13–25）：`register(c, {...}, true)` → `register(c, { email, password, code, token })`，token 从 params 取；`api/oauth-api.js` 与前端 `request/ouath.js` 整包透传，无需改。
- 前端 `mail-vue/src/views/login/index.vue`：注册渲染条件（:654）改为 `registerVerify === 0 || registerVerify === 2`（COUNT 也必验）；绑定弹窗新增独立 Turnstile 容器（:144）+ `renderBindTurnstile()`（:271）/ `recoverBindTurnstile()`，与注册 widget 互斥、共用 token；打开绑定弹窗时清旧 token（:401）；`bind()` 无 token 且需验证时先渲染/提示、不提交（:470），提交表单带 `token: verifyToken`，成功/失败都清 token（失败还 reset widget 防重放）。

### 1.3 注册日志独立表 + 审计日志补 IP 列（C 路 + 总协调共享基础）
- 新表见 §2。写入点：`login-service.register()` 全程（成功/失败都记）；审计写入点：`setting-service.set()`（`setting:update`，detail 只有 key 列表、不含密钥值）、`user-service.setStatus/delete/restore/physicsDelete`、`reg-key-service.add/delete`、`ip-blocklist-service.add/remove`。
- 新 API：`api/register-log-api.js`、`/api/audit-log-api.js`（按 ip/结果/action/actor/时间范围筛选 + 分页，默认 50、上限 50）。
- `entity/verify-record.js`：`ip: integer('ip')` → `text('ip')`（仅 ORM 映射修正，与 DDL 一致；D1 列定义未动）。

### 1.4 Resend 配额保护（C 路 + 总协调共享基础）
- `mail-worker/src/service/quota-service.js`（新建）：KV `resend_day:<YYYY-MM-DD>` / `resend_month:<YYYY-MM>` 计数；`hasResendBudget`（日月都未超才放行）；`recordResendSent`（成功后计数，永不抛错）；`maybeAlertQuota`（用量 ≥80% 时 TG 告警，每天每档最多 1 次，KV 标记去重）。
- `mail-worker/src/service/email-service.js`：`send()` 有站外收件人时 `maybeAlertQuota`（:477，best-effort）；进 Resend 分支前 `hasResendBudget` 为 false → 抛 `t('resendQuotaExhausted')`，不调 Resend、不写发送记录（:491）；`sendResend()` 成功后按**实际成功收件人数**计数（:598–605，总协调修复：原 C 路按 `emails.length` 计，普通发送一封多收件人会少计）。
- **如实说明**：渠道优先级未改（站内 → CF → Resend）。CF 已配时现有逻辑永远走 CF、Resend 根本不用；“撞线切 CF”在本实现里体现为——Resend 是无 CF 时的唯一外发通道，撞线即停发并告警；一旦配了 CF，`useCloudflareEmail` 分支天然优先。
- `mail-worker/src/service/telegram-service.js:sendAlert(c, text)`（:48）：通用 TG 告警，复用 `tgBotToken`/`tgChatId`（逗号分隔多人），无配置直接返回，fetch 失败只 `console.error`，永不抛错。

### 1.5 应用层 IP 黑名单表 + security.js 检查（A 路 + 总协调共享基础）
- `mail-worker/src/service/ip-blocklist-service.js`（新建）：`isBlocked(c, ip, ipSegment, scope)`（过期行视为未封；直接读 D1，不依赖 KV 缓存）、`add` / `remove`（写审计日志）、`list`（分页）。**第二阶段甲骨文巡检的写入口就是 `add`/`remove`；本阶段不接 WAF API。**
- `mail-worker/src/security/security.js`：中间件最顶部（`exclude` 判断之前，:111）加 scope=1 检查，命中 → `t('ipBlockedAccess')` 403，对所有路径生效（含 `/login`、`/register`、`/oauth`、`/setting/websiteConfig`）；管理员逃生口 `isAdminRequest`（:208）：有效 JWT + KV 会话用户邮箱 === `c.env.admin` 时跳过；检查本身失败只记日志、不阻断。
- 新 API：`api/ip-blocklist-api.js`（`GET /ipBlocklist/list`、`POST /ipBlocklist/add`、`DELETE /ipBlocklist/delete`；只给 ip 时自动算段；`createdBy` 取当前登录用户邮箱）。
- 权限：`requirePerms` + `premKey` 新增 `ip-block:query` / `ip-block:set` / `register-log:query` / `audit-log:query`；perm 种子行 37–42 见 §2。

## 2. 新增表结构（init.js `v3_5DB`，`init()` 里 `v3_4DB` 之后调用）

```sql
register_log (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL DEFAULT '', ip_segment TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '', reg_key_code TEXT NOT NULL DEFAULT '',
  result INTEGER NOT NULL DEFAULT 0,          -- 0 成功 / 1 失败
  fail_reason TEXT NOT NULL DEFAULT '',
  verify_mode INTEGER NOT NULL DEFAULT 0,     -- 当时 register_verify：0 OPEN / 1 CLOSE / 2 COUNT
  ua TEXT NOT NULL DEFAULT '',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP   -- UTC
);
-- 索引：(ip_segment, create_time)、(create_time)、(ip, create_time)

audit_log (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER NOT NULL DEFAULT 0,   -- 0 = 未登录请求
  action TEXT NOT NULL DEFAULT '',            -- 如 setting:update / user:set-status / ip-block:add
  target_type TEXT NOT NULL DEFAULT '', target_id TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '', ua TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',            -- JSON，截断 2000 字
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- 索引：(create_time)、(actor_user_id, create_time)

ip_blocklist (
  block_id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL DEFAULT '', ip_segment TEXT NOT NULL DEFAULT '',
  scope INTEGER NOT NULL DEFAULT 0,           -- 0 禁注册 / 1 禁访问
  reason TEXT NOT NULL DEFAULT '',
  expire_time DATETIME,                       -- NULL = 永久
  created_by TEXT NOT NULL DEFAULT '',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- 索引：(ip)、(ip_segment)
```

另：`idx_user_create_ip ON user(create_ip)`、`idx_verify_record_ip_type ON verify_record(ip, type)`；
perm 种子行：37 `IP黑名单`（父）、38 `黑名单查看 ip-block:query`、39 `黑名单管理 ip-block:set`、
40 `风控日志`（父）、41 `注册日志查看 register-log:query`、42 `审计日志查看 audit-log:query`（均 `INSERT...SELECT...WHERE NOT EXISTS`，幂等）。

## 3. 配置项含义（setting 表新列，默认值 = 括号内）

| 列 | 默认 | 含义 |
|---|---|---|
| `ip_reg_limit` | 3 | 每 IP 段每窗口期成功注册上限 |
| `ip_reg_window_hours` | 24 | 上限窗口（小时） |
| `reg_rate_limit_per_min` | 5 | 每 IP 段每分钟注册尝试上限（含失败） |
| `reg_circuit_threshold` | 20 | 全站每分钟注册数熔断阈值 |
| `reg_circuit_open` | 0 | 熔断状态：0 关 / 1 开（超阈值自动置 1；管理员手动置 0 恢复） |
| `resend_day_budget` | 100 | Resend 每日预算（封） |
| `resend_month_budget` | 3000 | Resend 每月预算（封） |

另：`register_verify` 默认值改为 0（OPEN，每次验证）。**不要把熔断阈值、黑名单透传给公开的 `websiteConfig()`。**

## 4. 本地验证结果（真实结果）

- **vitest（总协调实跑）**：`mail-worker` 下 `npx vitest run test/phase1.spec.js` —— **23/23 通过**（`Test Files 1 passed, Tests 23 passed`）。覆盖：v3_5DB 迁移（表/索引/setting 列/perm 种子 + 幂等）、注册成功、IP 限额（同段第 4 个被拒）、IPv6 /64 归一化、分钟限流（第 6 次被拒）、熔断触发（D1 `reg_circuit_open` 置 1）、Turnstile 未配 secret 抛错、OAuth 绑定无 token 被拒、Resend 配额耗尽不调 Resend 且不写发送记录、审计写入、两个 list API 筛选、`verify_record.ip` 文本映射、`sendAlert` 永不抛错。跑在本地 miniflare（`wrangler.jsonc` 占位绑定），不连线上 D1/KV。
- **前端构建（B 路实跑）**：`mail-vue` 需 `npm install --legacy-peer-deps --no-package-lock --no-save`（`vite@7.1.5` 与 `@vitejs/plugin-vue@5.2.4` 的 peer 冲突是上游既有问题，与本次改动无关），随后 `npm run build` 通过（30.67s，仅既有 chunk > 500 kB 警告）。
- **wrangler dev 本地冒烟（C 路实跑）**：`wrangler dev --local --config wrangler.jsonc`，`/init` 返回 `success`；无 token 注册返回 400“需要进行人机验证”（种子已是 OPEN，属正确 fail-closed）；`wrangler d1 execute --local` 核对：失败注册已写入 `register_log`（result=1），perm 37–42 齐全，7 个 setting 新列与日志索引齐全。
- **语法检查**：全部改动文件 `node --check` 通过；`getIpSegment` 真实代码单测 13 项全过（A 路）。
- **未跑通的验证**：无。A 路起初未跑 wrangler dev（`wrangler-dev.toml` 绑远端 D1/KV id，跑会连线上资源，故未尝试），后由 C 路用本地 `wrangler.jsonc` 补上。

## 5. 总协调集成时补的两个缺口

1. **`entity/setting.js` 缺 7 个新列**（C 路发现、B 路未补）：已补齐（`ipRegLimit` 等 7 列，默认值与契约 §1 一致）。缺失时 Drizzle 全列 SELECT 读不到新列，A 路的 `??` 兜底会恒生效、后台改预算/限额不生效。补后 23/23 测试仍全过。
2. **Resend 计数少计**（C 路原实现按 `emails.length`）：普通发送一封多收件人只有 1 条记录，会少计 N-1。已改为按实际成功收件人数计（`email-service.js:598–605`，解析各记录的 `recipient` JSON 求和）。该改动为代码级验证（语法检查通过），未单列测试用例——回归清单里已补一项。

## 6. 未完成项与回归测试清单（部署前必跑）

- [ ] 回归 1：新库从零跑 `GET /init/<jwt_secret>`，核对 `pragma_table_info(setting)` 含 7 个新列、`register_log` / `audit_log` / `ip_blocklist` 三表与 9 个索引存在、perm 37–42 存在；再跑一次 `/init` 确认幂等（不报错、不重复插 perm）。
- [ ] 回归 2：注册成功 3 次同 IP，第 4 次 429 `regIpLimit`；`register_log` 应有 4 条（3 成功 1 失败）。
- [ ] 回归 3：IPv6 同 /64 段内两个地址计入同一限额，不同 /64 不受影响。
- [ ] 回归 4：同段 1 分钟 6 次尝试，第 6 次 429 `regTooFrequent`。
- [ ] 回归 5：全站 1 分钟 21 次注册触发熔断，`setting.reg_circuit_open`=1，后续直接拒，TG 收到告警；手动置 0 恢复。
- [ ] 回归 6：`ip_blocklist` scope=0 封 IP 后注册 429；scope=1 封后任意路径 403，管理员 JWT 请求放行；过期行不拦截。
- [ ] 回归 7：Turnstile 未配 secret 时注册 400 `turnstileNotConfigured` 且不调 siteverify；siteverify 失败/异常时 400 `botVerifyFail`。
- [ ] 回归 8：OAuth 绑定无 token 时被拒；有 token 且同段超限额时被拒。
- [ ] 回归 9：Resend 配额耗尽时外发 400 `resendQuotaExhausted`，不调 Resend、不写发送记录；用量 ≥80% 时 TG 告警 1 次/天；**多收件人普通发送按收件人数计配额**（新增，见 §5 第 2 条）。
- [ ] 回归 10：收信、发信（三通道）、登录、后台（用户/密钥/设置）主流程不受影响；`register_verify=1`（CLOSE）时无 token 可注册。
- [ ] 回归 11：前端构建通过；注册页与绑定页 Turnstile 正常渲染。
- [ ] 已知局限：`verifyRecordService.isOpenRegVerify` 现无调用方（COUNT 改必验所致），函数保留未删；`onTurnstileError` 在 `turnstileId` 为空时 fallback 渲染注册容器，绑定 widget 出错时主路径走 `recoverBindTurnstile()` 重渲绑定容器，极端时序下可能渲染到隐藏的注册容器，不影响提交（提交只认 `verifyToken`）。
- [ ] 部署注意：**先跑 `/init` 再启用新 Worker**（否则 `settingService.query()` 的 Drizzle 全列 SELECT 会报新列缺失）；`jwt_secret` 重新生成（绝不能复用老站）；新域名待定；老站数据不迁移。

## 7. 改动文件总览

- 新增：`PHASE1-CONTRACT.md`、`PHASE1.md`（本文件）；`mail-worker/src/entity/{register-log,audit-log,ip-blocklist}.js`；`mail-worker/src/service/{register-log-service,audit-log-service,quota-service,ip-blocklist-service}.js`；`mail-worker/src/api/{ip-blocklist-api,register-log-api,audit-log-api}.js`；`mail-worker/test/phase1.spec.js`；`mail-worker/wrangler.jsonc`（本地测试专用，占位绑定 + dummy jwt_secret，明确标注测试专用）。
- 修改：`mail-worker/src/service/{login-service,turnstile-service,oauth-service,email-service,telegram-service,setting-service,user-service,reg-key-service}.js`；`mail-worker/src/{security/security,hono/webs,init/init}.js`；`mail-worker/src/{utils/req-utils,entity/setting,entity/verify-record,const/entity-const,const/kv-const,i18n/zh,i18n/en}.js`；`mail-vue/src/views/login/index.vue`。
- 删除：`mail-worker/test/index.spec.js`（Hello World 占位用例断言真实 Worker 返回 "Hello World!"，与本 Worker 不符，由 `phase1.spec.js` 取代）。
- 未改动：`package.json` / lockfile（依赖用 `--no-package-lock --no-save` 安装）；`rege_key_id` 拼写与 `user.send_count` 类型错配原样未动；收发信主流程、JWT、RBAC 未动。
