# 终极版邮箱 · 第三阶段后台（C 路）交付记录

> 状态：**已完成，本地验证通过（1 项已知失败见 §5），未部署，未动线上**。
> 工作目录：`~/workspace/mail-ultimate/`（cloud-mail main fork）。
> 契约：`PHASE2-4-CONTRACT.md` §0、§2–§3、§4 C 路、§5、§6。第一阶段测试保持 23/23 全过。
> 注意：仓库内另有 A 路 / 总协调并行改动的文件（`mail-vue/src/request/my.js`、`views/login|send|setting`、`mail-worker/src/{api/my-api,service/login-service,service/reg-key-service,…}`、`security.js`、`init.js`、`i18n/*` 等），**均不是 C 路改的，C 路未碰**。

## 1. 改动文件清单（行号级）

### 后端

- `mail-worker/src/service/user-service.js`
  - `:26–33` 新增模块级 `csvEscape()`（CSV 字段转义：含 `,`/`"`/换行时加双引号包裹，内部 `"` 翻倍）。
  - `:144` `list()` 解构新增 `createIp`、`createIpPrefix` 参数。
  - `:177–183` `list()` conditions 增加 IP 筛选：`createIp` 精确匹配（`eq`）优先，`createIpPrefix` 前缀 `COLLATE NOCASE LIKE`，二者只取其一。
  - `:274–283` 新增 `groupByIp(c, { min = 2 })`：契约 SQL 原样（`is_del = 0 AND create_ip != ''`，`HAVING total >= ?`，`ORDER BY total DESC LIMIT 100`）。
  - `:285–314` 新增 `exportCsv(c, params)`：复用 `list()` 筛选参数，分页（每页 50）循环拉全量；`total > 5000` 时抛 `BizError(t('exportTooManyRows'), 400)`；列固定 `userId,email,createIp,activeIp,status,type,createTime`。
- `mail-worker/src/api/user-api.js`
  - `:34–45` 新增 `GET /user/export`：`Content-Type: text/csv; charset=utf-8`，响应体首字符为 BOM（`'\uFEFF'` 显式转义），`Content-Disposition` 文件名 `users-YYYY-MM-DD.csv`。
  - `:47–51` 新增 `GET /user/groupByIp`：`{min}` 参数，调 `groupByIp`。
  - 权限由总协调已加好的 `security.js` 覆盖（`user:export` → `/user/export`，`user:query` → `/user/groupByIp`），本路未改 `security.js`。
- `mail-worker/src/service/analysis-service.js`
  - `:9–11` 新增 import：`settingService`、`quotaService`、`t`。
  - `:94–127` `queryEcharts()` 的 `Promise.all` 并入 6 个风控查询，各自包 `safe()`（失败记 `console.error` 后给默认值，不拖垮仪表盘）：
    - `registerTrend`：`register_log` result=0 近 15 天按日计数，复用 `filterEmptyDay(..., 'UTC')` 的日期序列（时间统一 UTC）。
    - `ipTop10`：`user` 表 `create_ip` Top 10（`is_del = 0`）。
    - `circuitEvents` 条数：近 7 天 `register_log` 的熔断拒绝数（见 §4 偏差说明）。
    - `regKeyRemaining`：未过期密钥 `SUM(count)`（`count > 0 AND datetime(expire_time) > datetime('now')`）。
    - `resendUsage`：调 `quotaService.getResendUsage(c)`。
    - 当前熔断值：`settingService.query(c)` 的 `regCircuitOpen`。
  - `:149–158` 返回值新增 `risk: { registerTrend, ipTop10, circuitEvents: { count, open }, regKeyRemaining, resendUsage }`，其余字段原样不动；KV 缓存路径自动带上（`echarts()` 不动）。

### 前端

- `mail-vue/src/views/user/index.vue`
  - `:22–33` 表头新增 `createIp` 搜索框 + 精确/前缀二选一 `el-select`（`ipFilterMode`）+ 导出 CSV 下载图标按钮。
  - `:78` 表格新增 `createIp` 列（`$t('registrationIp')`，复用已有 key；`v-if="createIpShow"`，宽度 > 900px 显示）。
  - `:407`、`:452–454` import `userExportCsv`、`dayjs`；新增 `createIpShow` / `ipFilterMode`（默认 `exact`）/ `exportLoading`。
  - `:493`、`：536` `params` 新增 `createIp`，localStorage 恢复时兼容旧存量（无则 `''`）。
  - `:1021` `refresh()` 清空 `createIp`；`:1038–1075` 新增 `exportUsers()`（调 `/user/export`，blob 下载，文件名 `users-YYYY-MM-DD.csv`）；`:1095–1099` `getUserList()` 前缀模式下把 `createIp` 改写为 `createIpPrefix`；`:1122` `adjustWidth()` 控制 `createIpShow`。
  - 批量删除/恢复复用现有 `delete`/`restore` 多选模式（未改）。
- `mail-vue/src/views/analysis/index.vue`
  - `:117–178` 新增“风控”卡片区（`v-if="riskData"`，后端无 `risk` 时整个区不渲染）：注册趋势折线（`.risk-register-line`，复用 ECharts 折线样式）、IP Top 10 表格、熔断状态（开/关标签 + 近 7 天触发次数）、密钥剩余量、Resend 日/月用量进度条（`el-progress`，超预算封顶 100%）。
  - `:239–257` 新增 `riskData` / `riskLineData` / `resendDayPct` / `resendMonthPct`。
  - `:322–326` `onMounted` 取数后填充 `risk`；`:378` `initPicture()` 增加 `createRiskRegisterLine()`；`:631` 起新增 `createRiskRegisterLine()`；样式区新增 `.risk-register-line` / `.risk-table`。
- `mail-vue/src/views/ip-blocklist/index.vue`（新建，280 行）
  - 调 `/ipBlocklist/list|add|delete`（分页参数 `page/size`，与后端 `ip-blocklist-api.js` 一致）；列：IP / IP 段 / scope（禁注册/禁访问标签）/ 原因 / 到期时间（空为永久）/ 操作人；含添加表单（IP、IP 段可空自动算段、scope、原因、到期时间可空为永久）与解封确认。
- `mail-vue/src/views/alert-center/index.vue`（新建，175 行）
  - 调 `/alertLog/list`，type 筛选（`circuit | quota | reg-key | patrol | waf | system`，与 `alert-log-service.js` 约定一致）+ 分页。
- `mail-vue/src/views/register-log/index.vue`（新建，220 行）
  - 调 `/registerLog/list`，ip / 结果（成功/失败）/ 时间范围筛选 + 分页。
- `mail-vue/src/views/audit-log/index.vue`（新建，211 行）
  - 调 `/auditLog/list`，action / ip / 时间范围筛选 + 分页。
- `mail-vue/src/perm/perm.js`
  - `:123–161` `routers` 新增：`'ip-block:query'` → `/ip-blocklist`；`'alert:query'` → `/alert-center`；`'register-log:query'` → `/register-log`；`'audit-log:query'` → `/audit-log`（`meta.title` 先写英文 key 占位，见 §2）。
- `mail-vue/src/request/`（新建 4 个 + 改 1 个，仿照 `request/user.js`）
  - 新建 `ip-blocklist.js`（`ipBlocklistList/Add/Delete`）、`alert-center.js`（`alertLogList`）、`register-log.js`（`registerLogList`）、`audit-log.js`（`auditLogList`）。
  - `user.js`：`:13–33` 新增 `userExportCsv(params)`（见 §4 说明：绕过 axios 拦截器的原因）；`:34–36` 新增 `userGroupByIp(params)`；`:3` 引入 `axios` 与 `useSettingStore`（仅取语言）。

### 测试

- `mail-worker/test/phase2c.spec.js`（新建，314 行）
  - 覆盖：user list 按 IP 筛选（精确/前缀/精确优先）、groupByIp 聚合（min=2/min=1）、export 上限与 CSV 头（BOM + 表头 + 行数，超 5000 行返回 400）、queryEcharts 含 risk 字段（15 天序列、IP Top 10、熔断计数与开关、密钥剩余、Resend 用量、原有字段不动）、黑名单/日志 list API 权限（零权限角色调 6 个接口应 403，管理员调 5 个应 200）。

## 2. 新 key 清单（i18n 由总协调集成时统一补，前后端 i18n 文件本路一律未改）

### 后端（`mail-worker/src/i18n/zh.js`、`en.js`）

| key | 中文 | English |
|---|---|---|
| `exportTooManyRows` | 导出行数超过 5000，请缩小筛选范围后再导出 | Too many rows to export (over 5000), please narrow the filter and try again |

### 前端（`mail-vue/src/i18n/zh.js`、`en.js`）

| key | 中文 | English |
|---|---|---|
| `searchByCreateIp` | 按注册 IP 搜索 | Search by registration IP |
| `ipExact` | 精确 | Exact |
| `ipPrefix` | 前缀 | Prefix |
| `ipFilterMode` | IP 匹配方式 | IP match mode |
| `exportCsv` | 导出 CSV | Export CSV |
| `exportSuccessMsg` | 导出成功 | Export successful |
| `exportFailedMsg` | 导出失败 | Export failed |
| `riskTitle` | 风控 | Risk control |
| `riskRegisterTrend` | 注册趋势 | Registration trend |
| `riskIpTop10` | 注册 IP Top 10 | Top 10 registration IPs |
| `registerCount` | 注册数 | Sign-ups |
| `circuitStatus` | 熔断状态 | Circuit breaker status |
| `circuitOpen` | 熔断已开启 | Circuit open |
| `circuitClosed` | 熔断已关闭 | Circuit closed |
| `circuitEvents7d` | 近 7 天熔断触发 | Circuit trips in last 7 days |
| `regKeyRemaining` | 密钥剩余量 | Remaining registration keys |
| `resendDayUsage` | Resend 今日用量 | Resend usage today |
| `resendMonthUsage` | Resend 本月用量 | Resend usage this month |
| `ip` | IP | IP |
| `ipSegment` | IP 段 | IP segment |
| `scope` | 范围 | Scope |
| `reason` | 原因 | Reason |
| `expireTime` | 到期时间 | Expiry time |
| `createdBy` | 操作人 | Created by |
| `permanent` | 永久 | Permanent |
| `unblock` | 解封 | Unblock |
| `blockRegister` | 禁注册 | Block registration |
| `blockAccess` | 禁访问 | Block access |
| `addBlock` | 添加封禁 | Add block |
| `ipSegmentPlaceholder` | IP 段（可空，自动计算） | IP segment (optional, auto-calculated) |
| `expireTimePlaceholder` | 到期时间 YYYY-MM-DD HH:mm:ss（空为永久） | Expiry time YYYY-MM-DD HH:mm:ss (empty = permanent) |
| `ipEmptyMsg` | IP 或 IP 段不能为空 | IP or IP segment is required |
| `unblockConfirm` | 确认解封 {msg} 吗？ | Confirm unblock {msg}? |
| `searchByIp` | 按 IP 搜索 | Search by IP |
| `startDate` | 开始日期 | Start date |
| `endDate` | 结束日期 | End date |
| `result` | 结果 | Result |
| `success` | 成功 | Success |
| `failed` | 失败 | Failed |
| `failReason` | 失败原因 | Failure reason |
| `type` | 类型 | Type |
| `alertText` | 告警内容 | Alert content |
| `source` | 来源 | Source |
| `searchByAction` | 按操作搜索 | Search by action |
| `actionName` | 操作 | Action |
| `actorUserId` | 操作人 ID | Actor user ID |
| `targetType` | 目标类型 | Target type |
| `targetId` | 目标 ID | Target ID |
| `detail` | 详情 | Details |
| `ipBlocklist`（菜单 title） | IP 黑名单 | IP blocklist |
| `alertCenter`（菜单 title） | 告警中心 | Alert center |
| `registerLog`（菜单 title） | 注册日志 | Registration log |
| `auditLog`（菜单 title） | 审计日志 | Audit log |

复用已有 key（未列入上表）：`registrationIp`、`tabEmailAddress`、`all`、`date`、`regKey`、`action`、`add`、`confirm`、`cancel`、`delSuccessMsg`、`addSuccessMsg`。

## 3. 验证结果（实跑）

- **新测试 `test/phase2c.spec.js`：21/22 通过**（`npx vitest run test/phase2c.spec.js`，本地 miniflare，不连线上）。
  - 通过：IP 精确/前缀/精确优先筛选、groupByIp（min=2/min=1）、export CSV（BOM `0xFEFF`、表头 `userId,email,createIp,activeIp,status,type,createTime`、2 行内容）、export 超 5000 行返回 400（单条 SQL 造 5001 个同 IP 用户触发）、risk 字段结构（15 天序列、IP Top 10、熔断计数 ≥1、开关 0→1 翻转、密钥剩余 ≥5、Resend 用量结构、原有字段不动）、5 个接口零权限时 403、管理员 200。
  - **未通过 1 项：`/registerLog/list` 零权限时返回 200 而非 403**——见 §5（第一阶段已存在的安全缺口，非本路引入，总协调修 `security.js` 后即过）。
- **第一阶段回归 `test/phase1.spec.js`：23/23 通过**（改完重跑，无回归）。
- **前端构建：通过**。`mail-vue` 下 `npm install --legacy-peer-deps --no-package-lock --no-save` 后 `npm run build`，26.21s，仅既有 chunk > 500 kB 警告（与本次改动无关）；产物 `mail-worker/dist/assets/` 中含 `ip-blocklist-*`、`alert-center-*`、`register-log-*`、`audit-log-*` 四个新页面 chunk。
- **语法检查**：改动的 3 个后端文件与新测试 `node --check` 通过。
- **未手动验证**：前端 4 个新页面与仪表盘风控区的真实浏览器交互（无登录态可跑的本地 Worker + 前端联调环境；构建通过 + 后端 API 测试覆盖到同名接口）。

## 4. 契约偏差说明（实现时发现的两个坑，均已处理并在代码里留注释）

1. **`circuitEvents` 不能按契约字面 `fail_reason LIKE '%regCircuitOpen%'` 实现**：`fail_reason` 存的是 `t('regCircuitOpen')` 解析后的译文（中文“注册功能暂时关闭维护中，请稍后再试”），不是 key 本身，LIKE key 恒为 0。已改为按译文匹配（当前语言译文 + 中文兜底）。
2. **D1 的 LIKE 对长中文模式会抛错**：实测 `LIKE '%注册功能暂时关闭维护中，请稍后再试%'` 报 `D1_ERROR: LIKE or GLOB pattern too complex`，会被 `safe()` 吞掉导致计数恒为 0（调试用例已复现）。已改用 `instr(fail_reason, ?) > 0` 做子串匹配，短模式 `'%暂时关闭维护%'` 经实测可正常 LIKE，但为稳妥统一用 `instr()`。
3. **导出 CSV 不能走 `http` axios 实例**：`src/axios/index.js` 的响应拦截器按 JSON `{code, data}` 解析，blob 会被误判失败；且后端 BizError 以 HTTP 200 + JSON `{code:400}` 返回。`request/user.js` 的 `userExportCsv` 因此直接用 `axios` + `responseType: 'blob'`，按 `Content-Type` 区分 CSV 与错误 JSON（手动解析抛错）。

## 5. 未完成项与已知问题

- [ ] **（阻塞总协调，非 C 路权限）`/registerLog/list` 无鉴权漏洞**：第一阶段引入的接口。根因：`security.js` 的 `exclude` 用 `path.startsWith('/register')` 前缀匹配，把 `/registerLog/list` 也当成公开注册接口放行了。已实证：**无 token 直接调 `/registerLog/list` 返回 200**（对照组 `/auditLog/list` 无 token 正确返回 401）。即任意未登录用户可读全站注册日志（含 IP、邮箱、失败原因）。C 路按契约在 `phase2c.spec.js` 中保留了“零权限调 `/registerLog/list` 应 403”的断言（当前失败，21/22）；修复建议（总协调改 `security.js`，C 路无权改）：exclude 改为精确匹配或 `path === '/register' || path.startsWith('/register/')` 之类带边界的判断，改后重跑 `phase2c.spec.js` 应为 22/22。**部署前必须修**。
- [ ] 总协调集成时补 §2 的全部新 key（前后端 i18n 各两份），补完重跑前端构建；`exportTooManyRows` 补进后端 i18n 后，导出超限的报错文案才显示中文，否则目前显示 key 本身（i18next 缺 key 回退行为）。
- [ ] 前端 4 个新页面与仪表盘风控区的真实浏览器联调（需本地 Worker + 前端联调环境）。

## 6. 未改动项（按契约 §6）

未改：`init.js`、`entity/setting.js`、`const/kv-const.js`、`hono/webs.js`、`security/security.js`、`service/telegram-service.js`、前后端 `i18n/zh.js`、`en.js`；未动线上（mail.flame.edu.kg、D1 cloud-mail、Worker cloud-mail、任何线上凭证）；未动收发信主流程、JWT、RBAC、现有表结构；`package.json`/lockfile 未动（依赖用 `--no-package-lock --no-save` 安装）。
