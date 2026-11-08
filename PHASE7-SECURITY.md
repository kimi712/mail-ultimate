# 第七阶段 · 安全打磨（安全中心可见性 / 加密标识 / 自动锁定）

> 工作目录 `~/workspace/mail-ultimate/`（cloud-mail main HEAD `d115f4c` 的 fork）。
> 只做本地开发与测试，未部署线上（无 `wrangler deploy`）；未碰老项目
> mail.flame.edu.kg 的任何配置；未把任何密钥/Token 写进文件。
> 本文件只记录安全打磨部分。AI 后端见同事的 `PHASE7.md`；隐私审计全文见
> `PHASE7-PRIVACY-AUDIT.md`（最后由总协调合并进同一份 `PHASE7.md`）。

## 1. 审计：打磨清单（按“用户能感知的安全感”排序）

审计范围：第六阶段后端（`user_totp` / `user_passkey` / `user_security`、
`setting.log_retention_days` / `log_ip_mask`、`email.e2ee`、会话管理、
安全中心后端、E2EE 门、日志清理、IP 脱敏）与前端（安全中心页、E2EE
客户端加密、8 语种 key）。

| # | 短板 | 感知影响 | 本阶段处理 |
|---|---|---|---|
| 1 | 登录历史只有原始 UA 长串，无设备/浏览器人话解析，无地点列 | 高：用户看不懂自己从哪登的 | ✅ 已做：新接口解析 device/browser；地点恒空并明示不记录 |
| 2 | 邮件列表页 E2EE 邮件预览显示密文信封，且无任何加密标识 | 高：用户分不清哪封是加密的 | ✅ 已做：列表 + 详情双徽标（§3） |
| 3 | 无闲置自动锁定：登录态电脑离开即裸奔 | 高：共用电脑场景无保护 | ✅ 已做：0/5/15/30 分钟可配 + 密码解锁（§4） |
| 4 | 设备管理藏在安全中心中部，评分/TOTP/Passkey 之后 | 中：发现陌生设备不够快 | ✅ 已做：设备管理 + 登录历史挪到评分正下方 |
| 5 | 登录历史查询接口是通用 `/my/loginLog`，返回原始 UA，不做展示整形 | 中 | ✅ 已做：新增专用 `GET /security/login-history` |
| 6 | 日志 IP 脱敏默认关闭（`log_ip_mask=0`），且开关无前端入口 | 中：隐私默认值错 | ✅ 已做：`v3_8DB` 默认开启（隐私审计 §1.2） |
| 7 | KV `AUTH_INFO` 存完整 user 行（含密码 hash 与 salt） | 中：凭证材料多一份存储 | ✅ 已改：只存剔除后的 `safeUser`（隐私审计 §1.4） |
| 8 | `webhookSecret` 明文存库 | 中 | ✅ 已改：纳入字段加密（隐私审计 §2.2） |
| 9 | 无“导出我的数据” | 中：数据主权缺口 | ✅ 已做：`GET /my/export` + 前端入口（隐私审计 §3.2） |
| 10 | 物理删除不清理登录历史与安全行 | 低 | ✅ 已改（隐私审计 §3.3） |
| 11 | register/audit 日志 UA 未截断 | 低 | ✅ 已改：统一截断 500 |
| 12 | TOTP 无二维码（secret 手动输入） | 低 | ❌ 未做：引 QR 库会新增依赖，与第六阶段“零新增依赖”约定冲突；文案已写明手动输入 |
| 13 | 安全评分“30 天内无异地登录”只看最近 20 条登录历史 | 低 | ❌ 未做：口径可接受，改成分页全量统计收益小 |
| 14 | 审计日志（audit_log）只有管理员可见，普通用户看不到“谁动过我的账号” | 低 | ❌ 未做：需新增用户侧审计视图 + 接口，超出本次范围 |
| 15 | 密码强度策略（长度/复杂度）与登录失败限流 | 低 | ❌ 未做：登录接口本身无失败限流，改动面大，需另立项 |
| 16 | 会话无“最后活跃时间”（只有创建时间） | 低 | ❌ 未做：需每次请求写 KV，写放大；当前创建时间已够识别长期未用设备 |

## 2. 三项优先任务完成情况

### 2.1 登录历史 / 设备管理可见性 ✅ 做完

- 新增 `GET /security/login-history`（`mail-worker/src/api/security-login-history-api.js`，
  独立路由模块，`webs.js` 只加一行注册）：
  登录态、只查本人（`userId` 取 `c.get('user').userId`）；分页 `num`/`size`
  （size 上限 50）；返回 `{list, total}`，每条 `{time, ip, device, browser,
  isNewIp, location}`。`device` / `browser` 由服务端 `UAParser` 解析；
  `ip` 按 `setting.log_ip_mask` 脱敏规则展示（写时已脱敏的不再二次脱敏，
  开关开启后、写时未脱敏的历史行在读时补脱敏）；`location` 恒为 `null`——
  本站不记录地理位置，也不做 IP 地理库查询（那会把用户 IP 发给第三方）。
- 前端安全中心：**设备管理与登录历史两个区已挪到安全评分正下方**（原先在
  TOTP/Passkey 之后）；登录历史改走新接口，列为时间 / IP / 设备（设备 ·
  浏览器）/ 地点（显示“未记录”）/ 是否新 IP，并加说明“出于隐私考虑，
  本站不记录登录地理位置”；设备管理区加提示“发现陌生设备请立即踢出并
  修改密码”。
- 注：旧接口 `GET /my/loginLog` 本来就存在且可用，本次未删除（其他页面
  仍可复用）；新接口是安全中心专用的展示口径，不是重复造轮子。

### 2.2 每封邮件的加密状态标识 ✅ 做完

- 决定：**E2EE 邮件显示锁形徽标 +“端到端加密”；普通邮件不显示任何
  徽标，只在详情页显示低调文字“传输加密（TLS）”**，绝不让用户误以为
  普通邮件也是端到端加密。
- 后端：`emailBriefColumns`（`mail-worker/src/lib/email-list-columns.js`）
  补上 `e2ee` 字段——列表接口默认走 brief 列，此前不含 `e2ee`，徽标在
  列表页拿不到数据；只传 0/1 标志，不含任何内容。
- 列表页：`mail-vue/src/components/email-scroll/index.vue`，主题前加绿
  色锁形图标（`mdi:lock`），悬停提示“端到端加密”；`e2ee !== 1` 时什么
  都不显示。
- 详情页：`mail-vue/src/views/content/index.vue`，日期下方加标识行——
  E2EE 显示绿色描边标签“🔒 端到端加密”，普通邮件显示灰色小字
  “传输加密（TLS）”。已有的 E2EE 解锁卡片（未解锁时输加密密码）不动。

### 2.3 自动锁定计时 ✅ 做完

- 后端：`user_security` 新列 `auto_lock_minutes`（`v3_8DB` 迁移，默认
  0=从不；实体 + `user-security-service.js` 的 get/set 同步支持，只接受
  0/5/15/30，非法值 400 `securityInvalidAutoLock`）；复用 `POST /my/security`
  读写，无新会话机制。
- 解锁接口：新增 `POST /security/unlock`（`mail-worker/src/api/security-unlock-api.js`，
  独立路由模块）：只校验登录密码是否正确，**不签发新会话、不轮换 token、
  不改 KV**（锁定只是前端界面态）。防猜：连续失败 5 次后锁 5 分钟
  （KV `UNLOCK_FAIL:<userId>` 计数，TTL 300 秒，与 TOTP 的 5 次锁定同一
  口径；成功后清零）。错误码复用 `IncorrectPwd`（401）与新 key
  `securityUnlockLocked`（403）。
- 前端：新增 `mail-vue/src/components/auto-lock/index.vue`，挂在登录后的
  `layout/index.vue` 内（登录页不在 layout 内，不受影响）：
  挂载时读 `GET /my/security` 的 `autoLockMinutes`；监听 mousemove /
  keydown / click / wheel / touchstart（5 秒节流重设计时）；满 N 分钟无
  操作后全屏锁定（毛玻璃遮罩 + 密码框），调 `POST /security/unlock`
  解锁；**锁定同时清除内存中的 E2EE 密钥**（`clearMemoryKey()`），别人
  拿到已登录的电脑也看不到加密邮件明文。安全中心改设置后派发
  `auto-lock-settings-changed` 事件即时同步时长；读不到设置时不锁定
  （安全组件故障绝不把用户锁在外面）。
- 安全中心新增“闲置自动锁定”区：下拉选 从不/5/15/30 分钟，即时保存、
  失败回滚（与保留期限同款写法）。

## 3. 其他清单项（小而安全的已做，见 §1 的 #6–#11）

- 日志 IP 脱敏默认开启、UA 截断统一 500、KV 不再存密码材料、
  `webhookSecret` 加密、导出我的数据、物理删除清理——均已做，细节见
  `PHASE7-PRIVACY-AUDIT.md` §1–§3。
- 未做的（§1 的 #12–#16）及原因见上表；其中 #14（用户侧审计视图）、
  #15（登录限流）建议另立项。

## 4. 新 UI 文案（`security.*` 前缀，8 语种全量）

24 个新 key（`securityE2eeBadge`、`securityTransportEncrypted`、
`securityDevicesHint`、`securityLoginHistoryNoGeo`、
`securityLoginHistoryLocation`、`securityLoginHistoryNoLocation`、
`securityAutoLock`、`securityAutoLockDesc`、`securityAutoLock0/5/15/30`、
`securityLockedTitle`、`securityLockedDesc`、`securityUnlockPassword`、
`securityUnlock`、`securityUnlockFailed`、`securityMyData`、
`securityExport`、`securityExportDesc`、`securityExportDone`、
`securityDeleteAccount`、`securityDeleteAccountDesc`、
`securityDeleteAccountConfirm`），以追加式小编辑写入
`mail-vue/src/i18n/{zh,en,ja,ko,vi,ru,es,fr}.js`（插在 `e2eeDisable`
行之后；ja/ko/vi/ru/es/fr 的 `e2eeDisable` 原为末尾 key，补了逗号），
node 直引 8 文件核对：24/24 齐全、无缺失。

## 5. 改动文件

| 文件 | 改动 |
|---|---|
| `mail-worker/src/init/init.js` | 新增 `v3_8DB`（`auto_lock_minutes` 列 + `log_ip_mask` 默认开启），`init()` 内调用 |
| `mail-worker/src/entity/user-security.js` | 加 `autoLockMinutes` 列 |
| `mail-worker/src/service/user-security-service.js` | get/set 支持 `autoLockMinutes`（只接受 0/5/15/30） |
| `mail-worker/src/api/security-login-history-api.js` | 新增：`GET /security/login-history` |
| `mail-worker/src/api/security-unlock-api.js` | 新增：`POST /security/unlock`（5 次锁定） |
| `mail-worker/src/api/security-export-api.js` | 新增：`GET /my/export` |
| `mail-worker/src/hono/webs.js` | 加 3 行路由注册 |
| `mail-worker/src/const/kv-const.js` | 加 `UNLOCK_FAIL` |
| `mail-worker/src/i18n/zh.js`、`en.js` | 加 `securityInvalidAutoLock`、`securityUnlockLocked` |
| `mail-worker/src/lib/email-list-columns.js` | `emailBriefColumns` 加 `e2ee` |
| `mail-worker/src/service/setting-service.js` | `webhookSecret` 纳入字段加密 |
| `mail-worker/src/service/login-service.js` | `AUTH_INFO` 存剔除密码 hash/salt 的 `safeUser`，每次登录覆盖 |
| `mail-worker/src/service/register-log-service.js`、`audit-log-service.js` | UA 截断 500 |
| `mail-worker/src/service/user-service.js` | `physicsDelete` 一并清登录历史与安全行 |
| `mail-worker/test/phase7.spec.js` | 新增：11 个用例 |
| `mail-worker/test/phase1.spec.js`、`phase2a.spec.js`、`phase6.spec.js` | 旧断言按新默认更新（§6） |
| `mail-vue/src/request/security.js` | 加 `loginHistory` / `unlock` / `exportData` |
| `mail-vue/src/components/auto-lock/index.vue` | 新增：闲置锁定遮罩组件 |
| `mail-vue/src/layout/index.vue` | 挂载 `AutoLock` |
| `mail-vue/src/views/security/index.vue` | 设备/登录历史前移、新接口、自动锁定区、我的数据区（导出/删除） |
| `mail-vue/src/components/email-scroll/index.vue` | 列表 E2EE 锁形图标 |
| `mail-vue/src/views/content/index.vue` | 详情加密标识行 + 样式 |
| `mail-vue/src/i18n/{zh,en,ja,ko,vi,ru,es,fr}.js` | 各加 24 个 `security.*` key |
| `PHASE7-PRIVACY-AUDIT.md` | 新增：隐私审计全文 |
| `PHASE7-SECURITY.md` | 新增：本文件 |

## 6. 测试与构建结果

- `mail-worker` 全套 vitest（6 个 spec 文件，含并行 AI 同事的
  `phase7-ai.spec.js`）：**133/133 通过**（phase1 23 + phase2a 13 +
  phase2c 26 + phase6 30 + phase7 11 + phase7-ai 30）。
  - 收尾修掉的旧断言（均为本次有意的行为变更，非放宽断言），共 4 个测试、
    6 处断言：phase1 ×2（`register_log.ip` 与按 IP 筛选改期望脱敏值
    `203.0.113.0`）、phase2a ×1 个测试内 3 处（第 1 次登录 IP_A、第 2 次
    IP_B、第 3 次 IP_B，均改期望 `203.0.113.0`）、phase6 ×1
    （`GET /my/security` 期望对象补 `autoLockMinutes: 0`）。
  - 新套件 `phase7.spec.js` **11/11 通过**：v3_8DB 迁移、登录历史
    （本人隔离/字段/地点恒空/未登录拒绝/脱敏）、自动锁定读写与非法值、
    解锁（对/错/5 次锁定/锁定期内正确密码也被拒）、导出（不含密码与
    密钥材料）、`emailBriefColumns` 含 `e2ee`、`webhookSecret` 落库加密、
    KV 无密码材料、物理删除清登录历史与安全行。
- 迁移幂等：临时测试连跑两次 `/init` 均 `success`；`v3_8DB` 与同事的
  `v3_9DB`（AI 开关 `ai_enabled`）无撞号，各列只建一次，
  `log_ip_mask` 仍为 1（临时测试已删除）。
- `mail-vue` 前端构建 `npm run build`：**通过**（仅既有 analysis chunk
  > 500 kB 警告，与本次改动无关）。
- `node mail-vue/test/e2ee.smoke.mjs`：**11/11 通过**；`node
  mail-vue/test/preferences-locale.smoke.mjs`：**10/10 通过**；无回归。
- 8 语种 i18n：node 直引核对，24 个新 key 全量齐全、无缺失、无空值。
- 未部署线上；老站 mail.flame.edu.kg 全程未碰。

## 7. 待总协调 / 部署前确认

- 回归 37：`/init` 后核对 `user_security` 含 `auto_lock_minutes`、
  `setting.log_ip_mask = 1`；再跑一次 `/init` 确认幂等。
- 回归 38：安全中心登录历史只显示本人、IP 为脱敏值、地点显示“未记录”；
  设备管理在评分下方；陌生设备踢出后 token 失效。
- 回归 39：列表页 E2EE 邮件有绿锁、普通邮件无徽标；详情页 E2EE 有
  “端到端加密”标签、普通邮件只有“传输加密（TLS）”小字；未解锁的
  E2EE 邮件仍显示解锁卡片、不泄露密文。
- 回归 40：自动锁定 5 分钟档实测（闲置→锁定→错密码 401→对密码解锁→
  E2EE 密钥已清需重输加密密码）；设为“从不”后不再锁定。
- 回归 41：导出 JSON 含本人数据、不含密码与密钥材料；删号后（同步删除
  开启时）登录历史与安全行已清。
- 待定产品决定：用户自助“彻底删除”选项（隐私审计 §3.3）、完整邮箱导出、
  附件端到端加密（隐私审计 §6）。
