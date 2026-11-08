# 终极版邮箱 · 第二阶段 A 路交付记录（密钥库存告警 + 第四阶段体验 + 视觉升级 + 8 语种 + 个性化）

> 状态：**已完成，本地验证通过，未部署，未动线上**。
> 工作目录：`~/workspace/mail-ultimate/`（cloud-mail main HEAD `d115f4c` 的 fork）。
> 依据：`PHASE2-4-CONTRACT.md` §0、§2、§4 A 路、§5、§6，及补充条文
> 「界面视觉升级 + 8 语种」（用户 2026-11-08 12:55 定）、体验目标（13:06 定）、
> 质量与个性化标准（13:07 定）、技术领先要求（13:07 定）。
> 老站 mail.flame.edu.kg、D1 cloud-mail、Worker cloud-mail 全程未碰。
> 第一阶段测试保持 23/23 全过（见 §9）。

## 0. 本次交付总览

| # | 功能 | 状态 |
|---|---|---|
| 1 | 密钥库存告警（余量 < 阈值 TG 告警，1 次/天） | ✅ 完成，测试覆盖 |
| 2 | 异地登录写登录日志 + 新 IP 站内提醒邮件 | ✅ 完成，测试覆盖（含 1 项已知局限，见 §11） |
| 3 | 注册/登录报错映射成人话 | ✅ 完成（前端映射表 + noMsg 单显） |
| 4 | 发信页“今日还剩 X 封” | ✅ 完成（发件页横幅；daySendLimit 映射函数已备，待接入见 §11） |
| 5 | 个人设置页“登录记录” | ✅ 完成 |
| 6 | 公开页视觉升级（渐变/玻璃拟态，纯 CSS + 内联 SVG） | ✅ 完成，零新增首屏请求 |
| 7 | 8 语种切换（zh/en 内置 + 6 种懒加载，缺失回落英文） | ✅ 完成，框架 + 公开页全量翻译 |
| 8 | 语言持久化（localStorage `mail-locale` + 后端 `user.locale`） | ✅ 完成，后端接口有测试；浏览器端恢复流程待人工核对（见 §10） |
| 9 | 个性化：主题三档 / 布局密度 / 通知开关 | ✅ 完成，smoke 测试覆盖纯函数逻辑 |
| 10 | 性能预算与回归清单 | ✅ 见 §7、§10（浏览器实测项如实标“未验证”，不冒充通过） |

## 1. 改动文件清单（行号级位置）

### 1.1 后端（mail-worker）

- `mail-worker/src/service/reg-key-service.js`
  - 新增 import：`settingService`、`telegramService`、`dayjs`、`KvConst`（:1–13）。
  - 新增 `maybeAlertLowStock(c)`（:129–153）：读 `setting.regKeyAlertThreshold`（默认 500）；
    原生 SQL 查未过期密钥剩余总量（`count > 0 AND datetime(expire_time) > datetime('now')`）；
    低于阈值时 `telegramService.sendAlert(c, '⚠️ 注册密钥库存告警\n剩余总量 X（阈值 Y），请及时补充密钥。', 'reg-key')`；
    每天最多 1 次（KV `REG_KEY_ALERT_DAY + YYYY-MM-DD` 去重，先置标记再发告警）；
    全程 try/catch 永不抛错。
- `mail-worker/src/service/login-log-service.js`（新建，约 50 行）
  - `record(c, {userId, email, ip, ua, isNewIp})`：永不抛错，ua 截断 500 字；
    `listByUser(c, userId, {num, size})`：`-> {list, total}`，num 1 起、size 默认 50 上限 50，按 `logId` 倒序。
- `mail-worker/src/service/login-service.js`
  - 新增 import：`loginLogService`（:26）、`emailService`、`accountService`。
  - `_register` 成功路径：`updateUserInfo` 之后（:233），`if (consumedCode) await regKeyService.maybeAlertLowStock(c)`（best-effort，try/catch 包裹）。
  - `login()`：`updateUserInfo` 之前取 `prevIp = userRow.activeIp`、`curIp = reqUtils.getIp(c)`、
    `isNewIp = prevIp && prevIp !== curIp && curIp !== 'Unknown' ? 1 : 0`（:381–383）；
    登录成功后（`return jwt` 之前）写登录日志，`isNewIp` 为 1 时发站内提醒邮件（:385–408）。
    UA 取 `reqUtils.getUserAgent(c)` 拼串（browser / os / device）。
  - 新增 `_sendNewIpAlert(c, userRow, curIp, uaText)`（:413–433）：取用户本人 account，
    走 `emailService.send(c, params, userId)`，收件人 = 用户本人邮箱（站内投递，不占 Resend 配额）；
    主题/正文用新 key `newIpLoginSubject` / `newIpLoginBody`（含新 IP、UTC 时间 `YYYY-MM-DD HH:mm:ss`、设备信息）；
    全程 try/catch，永不阻断登录。OAuth（`noVerifyPwd=true`）走同一代码路径。
  - **与契约原文的一处有意偏差**：契约写 `isNewIp: prevIp && prevIp !== curIp ? 1 : 0`；
    实测发现无 `CF-Connecting-IP` 时 `curIp` 为 `'Unknown'`，会把所有此类登录误判为新 IP
    并发提醒邮件，导致第一阶段配额测试失败（见 §9.1）。故补 `curIp !== 'Unknown'` 条件，
    未知 IP 时不标新、不发提醒，登录日志仍正常写（ip 记为 `Unknown`）。已在 `phase2a.spec.js` 加回归用例。
- `mail-worker/src/api/my-api.js`
  - `GET /my/loginLog`（:18–38）：userId 取 `c.get('user').userId`，仅限本人数据，分页同 register-log-api。
  - `GET /my/locale` 与 `POST /my/locale`（:44–61）：读/写当前用户 `user.locale` 列；
    POST 只接受 8 种对外存储值（`LOCALES` 常量 :42：`zh-CN/en/ja/ko/vi/ru/es/fr`），非法值抛 `BizError('Invalid locale', 400)`（:54）；
    用 `orm` + `user` 实体直接读写（`loginUserInfo` 只返回显式字段、不含 locale，故不复用它）。
    两接口均不在 `requirePerms` 内（任意登录用户可用），未登录请求由 security 中间件 401 拦截。
- `mail-worker/test/phase2a.spec.js`（新建，13 个用例，见 §9）

### 1.2 前端（mail-vue）

- `mail-vue/src/request/my.js`
  - `loginLog(params)`（:7–9）：`GET /my/loginLog`。
  - `getLocale()`（:12–14）：`GET /my/locale`（`noMsg`，同步失败不弹错）；
    `setLocale(locale)`（:16–18）：`POST /my/locale`（`noMsg`）。
- `mail-vue/src/views/login/index.vue`（视觉升级 + 报错映射 + 语言切换器 + 通知开关接入）
  - 报错映射：`authErrorMap`（:228–256，9 组 key，中/英文原文双覆盖，见 §2）+
    `friendlyAuthError()`（:258） / `showAuthError()`（:264，未命中原样返回，不吞未知报错）。
    关键点：axios 拦截器会对非 200 响应自动弹后端原文，故登录/注册/绑定三个请求改走 `noMsg`
    （`/login` :643、`/register` :804、`/oauth/bindUser` :590），
    由 catch 统一弹映射后的人话，避免一条报错弹两次。旧的 `request/login.js` 与 `request/ouath.js` 包装函数未改，
    本页改为直接调 `http`（同文件内调用点替换）。
  - Turnstile 降级提示：`turnstileFailed` ref（:329），`recoverTurnstile()` / `recoverBindTurnstile()` 的
    catch 里置 true、成功回调 `onTurnstileSuccess` 里清 false；注册区（:128）与绑定弹窗（:187）各补一条
    `el-alert`（`t('turnstileLoadFailed')`）。`renderBindTurnstile` / `recoverBindTurnstile` 的 JS 逻辑未动。
  - 视觉升级（只改样式，见 §3）：品牌徽章内联 SVG（:30–42）、背景光斑 div（:18–20）、
    语言切换器（:3–16）、`.container` 玻璃拟态、`.form-title` 渐变字（:43）、主按钮蓝紫渐变（:908）、
    `#login-box` 明亮渐变背景、`.orb` / `.locale-switcher` / `.brand-badge` 样式、
    输入框聚焦态、移动端 44px 触控高度（文末 media query）。
  - 语言切换器：`currentLocaleLabel`（:447）、`onSwitchLocale()`（:452）调 `applyLocale`；未登录时只写本地。
  - 登录成功同步语言：`saveToken()`（:650）内 `loginUserInfo()` 之后调 `syncLocaleWithServer()`。
  - 通知开关接入：`saveToken()` 末尾（:666）`if (loadPrefs().notice !== false) uiStore.showNotice()`。
- `mail-vue/src/views/send/index.vue`（发件页）
  - 顶部横幅（:2）：`sendRemain !== null` 时显示 `t('todaySendRemain', {count})`；
    `sendRemain`（:65–72）取 `userStore.user.sendCount` 与 `role.sendCount` 的差值，
    `role.sendCount` 为空（不限量/无权限/被禁发）时不显示。
  - `friendlySendError(message, t)`（:31–37）+ `sendErrorMap`（:26–29）：daySendLimit 中/英文原文 → `t('sendLimitToday')`。
    说明：发信失败的实际提示在 `layout/write/index.vue` 的 `sendEmail().catch()` 里弹（`emailSend` 用 `noMsg`），
    该文件不在 A 路归属内，故映射函数先放这里导出，总协调接入时在 write 页 import 调用一行即可（见 §11）。
- `mail-vue/src/views/setting/index.vue`（个人设置页）
  - “登录记录”区（:80–94）：`el-table`，列：时间 `createTime` / IP `ip` / 设备 `ua` / 是否新 IP 徽章
    （`isNewIp === 1` 为 warning 色“新 IP”，否则 info 色“常用”）；`fetchLoginLog()`（:141–149）
    调 `GET /my/loginLog` 取最近 20 条，`onMounted`（:150）加载。
  - 语言区：下拉选项由 2 个改为 8 个（`SUPPORTED_LOCALES` 循环，母语显示）；`changeLang()`（:211）
    改为即时切换（`applyLocale`，不刷新）+ 登录态下 `setLocale()` 同步后端（best-effort）；
    `pointerdown` 与 `change` 双触发时用“与当前语言相同则返回”去重；下拉宽度 110px → 150px（放得下 Tiếng Việt / Français）。
  - 新增“布局密度”区（:54–62）与“通知”区（:64–68）：`density` / `noticeOn` 两个 ref
    （:154–155）读写 `localStorage mail-prefs`，切换即时生效并持久化（见 §8）。
- `mail-vue/src/components/theme-selector/index.vue`（主题三档；本文件不在原 A 路清单内，
  但个性化“主题跟随系统”无它无法实现，且只归本页使用、无其他路并行改动，故一并改动，请总协调知悉）
  - `themeOptions` 由 2 档改为 3 档（:38–42）：浅色 / 深色 / 跟随系统（`systemTheme`）；
    选中态改为按 `themeMode`（:19，`loadPrefs().theme` 初始化）判定；
    `selectTheme()`（:46–55）写 `mail-prefs`、注册/取消系统主题监听（`syncSystemThemeListener`）、
    复用既有 `changeDark()` 的 View Transitions 动效；网格由 2 列改为 3 列（`max-width: 564px`）。
    跟随系统卡片的预览图暂用浅色预览（未做半深半浅预览，细节待打磨，见 §11）。
- `mail-vue/src/i18n/index.js`（重写，约 20 行）
  - 初始语言：`localStorage mail-locale` > 浏览器；`fallbackLocale: 'en'`；
    `messages` 仍只内置 `zh` / `en`（其余 6 种懒加载，见下）。
- `mail-vue/src/i18n/locale.js`（新建，134 行，纯函数模块，不 import i18n/store/request 以避免循环依赖）
  - `SUPPORTED_LOCALES`（8 种，母语 label）、`STORAGE_KEY = 'mail-locale'`、
    `normalizeLocale()`（存储值/短码/`en-US` 等带地区码均归一化；smoke 测试曾抓到 `en-US` 归一化缺失，已修复，见 §9.3）、
    `toStoredLocale()`（中文写 `zh-CN`）、`detectBrowserLocale()`（zh 开头 → `zh-CN`，否则 `en`）、
    `readStoredLocale()` / `writeStoredLocale()`、`loadLocaleMessages()`（显式 import 表，6 种语言各打独立 chunk）、
    `applyLocale(i18n, settingStore, short)`（懒加载 → 设 locale → 同步 `settingStore.lang` → 写 `mail-locale`）、
    `syncLocaleWithServer({i18n, settingStore, getLocale, setLocale})`
    （后端有值则以其为准回写本地，后端为空则把本地值写到后端；全程 best-effort）。
  - 内部短码（`zh/en/ja/…`）与既有代码的 `settingStore.lang`、`$t`、App.vue 等处的 `'zh'` 判断保持一致；
    对外存储值（`mail-locale`、后端 `user.locale`）用完整码，中文为 `zh-CN`，边界转换集中在本模块。
- `mail-vue/src/i18n/ja.js`、`ko.js`、`vi.js`、`ru.js`、`es.js`、`fr.js`（各新建，51 个 key）
  - 公开页（登录/注册）字符串 8 语种齐全 + 本阶段全部新 key；其余字符串缺失时回落英文。
  - 占位符沿用前端单花括号写法 `{msg}` / `{count}` / `{action}`。
- `mail-vue/src/init/init.js`
  - 语言初始化（:21–25）：`mail-locale` > 旧 `settingStore.lang`（pinia 持久化）> 浏览器；`applyLocale` 在挂载前执行。
  - 已登录时（:53）：`loginUserInfo()` 成功后调 `syncLocaleWithServer()` 与后端同步。
  - 个性化偏好（:31）：挂载前 `applyPrefs(loadPrefs(), useUiStore())`，避免主题与密度闪烁。
- `mail-vue/src/utils/preferences.js`（新建，128 行，顶层无副作用）
  - `PREFS_KEY = 'mail-prefs'`；`loadPrefs()` / `savePrefs()`（非法值回落默认）；
    `resolveDark()`（light/dark 直接取值，system 读 `prefers-color-scheme`）；
    `syncSystemThemeListener()`（system 模式注册系统主题变化监听，实时同步；切回手动档取消监听）；
    `applyThemeOnly()`（根元素 `dark` 类 + theme-color + `uiStore.dark`，与 ThemeSelector 行为一致）；
    `applyPrefs()`（主题 + `documentElement.dataset.density`）。
- `mail-vue/src/style.css`
  - 末尾追加紧凑密度规则（:225–242）：`html[data-density="compact"] .email-row` 行高 48px → 38px
    （`≤1366px` 时 83px → 64px；`.all-email` 65px → 52px / 132px → 100px）；舒适模式为默认样式，无额外规则。
- `mail-vue/test/preferences-locale.smoke.mjs`（新建，170 行，node 直接跑，见 §9.3）

### 1.3 未改动（硬约束遵守情况）

- 未改：`mail-worker/src/init/init.js`、`entity/setting.js`、`const/kv-const.js`、`hono/webs.js`、
  `security/security.js`、`service/telegram-service.js`、`mail-worker/src/i18n/zh.js`、`en.js`、
  `mail-vue/src/i18n/zh.js`、`en.js`（前后端 i18n 各两份均未改，新 key 见 §2）。
- 未动线上（不碰 mail.flame.edu.kg、D1 cloud-mail、Worker cloud-mail、任何线上凭证）；
  未动收发信主流程、JWT、RBAC、现有表结构；`package.json` / lockfile 未动
  （依赖用 `npm install --no-package-lock --no-save`，未用 pnpm）。
- 例外说明：`mail-vue/src/init/init.js` 与 `mail-vue/src/components/theme-selector/index.vue`
  不在原 A 路文件清单内，但本次追加的语言持久化（挂载前应用）与主题跟随系统无二者无法实现，
  且二者均不归其他路、不属于第一阶段代码；改动已在上文明确定位，请总协调复核。
  另：`mail-vue/src/style.css` 末尾追加密度规则（同理，紧凑密度无全局样式落点）。

## 2. 新 key 清单（总协调集成时统一补进 i18n）

> 约定：代码里直接用 `t('新key')`，此处列出中/英文；`mail-vue/src/i18n/zh.js`、`en.js`
> 与 `mail-worker/src/i18n/zh.js`、`en.js` 均未改，等总协调补。
> 注意：6 个新语言文件（ja/ko/vi/ru/es/fr）里这些 key 已翻好（§4），补 zh/en 时请勿覆盖它们。

### 2.1 后端新 key（mail-worker/src/i18n/，登录提醒邮件用）

| key | 中文 | English |
|---|---|---|
| `newIpLoginSubject` | 新设备登录提醒 | New sign-in alert |
| `newIpLoginBody` | 您的账号于 {{time}}（UTC）从新 IP {{ip}} 登录，设备：{{device}}。如果不是您本人操作，请立即修改密码。 | Your account was signed in from a new IP {{ip}} at {{time}} (UTC), device: {{device}}. If this wasn't you, please change your password immediately. |

### 2.2 前端新 key（mail-vue/src/i18n/，A 路原任务）

| key | 中文 | English |
|---|---|---|
| `authErrNoRegKeyCount` | 注册码次数已用完，请联系管理员领取新的注册码 | This invite code has no remaining uses. Please ask the administrator for a new one. |
| `authErrRegKeyExpire` | 注册码已过期，请联系管理员领取新的注册码 | This invite code has expired. Please ask the administrator for a new one. |
| `authErrBotVerifyFail` | 人机验证失败，请重新验证后再试 | Human verification failed. Please verify again and retry. |
| `authErrEmptyBotToken` | 请先完成人机验证再提交 | Please complete the human verification first. |
| `authErrRegIpLimit` | 这个网络今天注册的人太多了，请明天再试 | Too many sign-ups from this network today. Please try again tomorrow. |
| `authErrRegTooFrequent` | 操作太频繁了，稍等一会儿再试 | You're trying too often. Please wait a bit and try again. |
| `authErrRegCircuitOpen` | 注册功能正在维护中，请稍后再试 | Sign-up is temporarily under maintenance. Please try again later. |
| `authErrTurnstileNotConfigured` | 人机验证服务未配置，请联系管理员 | Human verification is not configured. Please contact the administrator. |
| `authErrIpBlockedRegister` | 这个网络已被限制注册，请联系管理员 | Sign-up from this network is blocked. Please contact the administrator. |
| `turnstileLoadFailed` | 人机验证加载失败，请刷新页面重试（若反复失败请联系管理员） | Human verification failed to load. Please refresh the page and retry, or contact the administrator if it keeps failing. |
| `todaySendRemain` | 今日还剩 {count} 封 | {count} sends left today |
| `sendLimitToday` | 今天的发信次数已用完，明天再试 | You've used up today's sending limit. Please try again tomorrow. |
| `loginLogTitle` | 登录记录 | Sign-in history |
| `loginLogTime` | 时间 | Time |
| `loginLogIp` | IP | IP |
| `loginLogDevice` | 设备 | Device |
| `loginLogNewIp` | 是否新 IP | New IP |
| `loginLogIsNew` | 新 IP | New |
| `loginLogNotNew` | 常用 | Usual |
| `loginLogEmpty` | 暂无登录记录 | No sign-in records yet |

### 2.3 前端新 key（个性化，追加任务）

| key | 中文 | English |
|---|---|---|
| `systemTheme` | 跟随系统 | Follow system |
| `densitySetting` | 布局密度 | Layout density |
| `densityComfortable` | 舒适 | Comfortable |
| `densityCompact` | 紧凑 | Compact |
| `noticeSetting` | 通知 | Notifications |
| `loginNotice` | 登录时显示系统公告 | Show announcement on sign-in |

## 3. 公开页视觉升级（登录/注册页）

- 明亮通透：页面背景由深蓝渐变改为浅色多段渐变（`#dbeafe → #e0f2fe → #ede9fe → #fce7f3`），
  另加 3 个纯 CSS 柔光圆（`.orb`，`blur(60px)`）与原有云朵共存。
- 玻璃拟态：右侧表单面板加 `backdrop-filter: blur(18px) saturate(1.3)` + 半透明白描边 + 大阴影；
  右上角语言切换器为玻璃小药丸（`blur(12px)`）。
- 品牌感：标题上方加内联 SVG 徽章（36px 圆角方块，蓝紫渐变 + 白色信封线条），标题文字改为蓝紫渐变字。
- 主操作按钮：蓝紫渐变（`#2563eb → #7c3aed`）、阴影、悬停上浮 1px、字重 600、字距 2px；
  输入框聚焦态加蓝色光环；移动端输入框与主按钮加高到 44px（触控优先）。
- 约束遵守：只用 CSS 与少量内联 SVG（1 个品牌徽章 + 1 个地球仪小图标），
  未引入外部字体、未加新图片资源、未加动画库；
  Turnstile 的 `renderBindTurnstile` / `recoverBindTurnstile` JS 逻辑未动（只在旁边加了降级提示 UI）。
- 成本实测（本次构建）：登录页 CSS `login-*.css` 1.9KB gzip；登录页 JS chunk 6.3KB gzip；
  视觉升级本身新增约 2KB 未压缩 CSS，首屏新增外部请求 0 个（见 §7）。

## 4. 8 语种 i18n

- 语言：简体中文（默认）、English（必备）、日本語、한국어、Tiếng Việt、Русский、Español、Français。
- 结构：`zh` / `en` 随首屏打包；`ja` / `ko` / `vi` / `ru` / `es` / `fr` 各打独立 chunk，
  首次切换时按需懒加载（`locale.js` 的显式 import 表）；`fallbackLocale: 'en'`。
- 翻译范围：6 个新文件各 51 个 key——公开页（登录/注册）字符串 8 语种齐全 +
  本阶段全部新 key（§2.2、§2.3）；其余字符串缺失时回落英文。
  已用 node 脚本核对：6 文件 45 个公开页 key（核对时）与后补的 6 个个性化 key 均无缺失、无空值。
- 切换器 UI：公开页右上角下拉（母语显示）+ 设置区“语言环境”下拉（8 项）；切换后全界面即时生效，无需刷新。
- 持久化：`localStorage` 键 `mail-locale` 为主（未登录的公开页即可切换）；
  登录成功后 `saveToken()` 与应用启动（`init.js`，有 token 时）各做一次与后端 `user.locale` 的同步：
  后端有值 → 以后端为准回写本地；后端为空 → 把本地值写到后端（`syncLocaleWithServer`，best-effort）。
  后端为空时跟随浏览器语言（`navigator.language` 以 `zh` 开头 → `zh-CN`，否则 `en`）。
- 第 8 种语言的暂定处理：提案的 6 种为 English（已有 `en.js`）+ 日本語/한국어/Tiếng Việt/Русский/Español；
  为凑满 8 语种，第 6 个新建文件暂取备选首位 Français（见 §5，待用户确认，可换 Deutsch/Português）。
- 双码制说明：内部短码（`zh/en/ja/…`）与既有代码一致；对外存储值中文为 `zh-CN`，
  转换集中在 `locale.js`（`normalizeLocale` / `toStoredLocale`）。

## 5. 6 种语言提案（待用户确认）

> 以下为提案，**待用户确认后才全量翻译**（目前 6 个新文件只翻了公开页 + 本阶段新 key，其余回落英文）。
> 总协调再写进 PHASE2-4.md 时请以此节为准，不要直接定死。

| 语言 | 一句话理由 |
|---|---|
| English（必备） | 华人用户也要有英语界面，且为全部缺失翻译的回落语言 |
| 日本語 | 日本华人/留学生与日语用户基数大，距中国近、时区接近 |
| 한국어 | 韩国华人/留学生群体大，中韩往来频繁 |
| Tiếng Việt | 本站用户量最大的非中文群体（越南用户多） |
| Русский | .kg 域名所在地吉尔吉斯斯坦的官方语言之一，覆盖中亚俄语用户 |
| Español | 全球使用人数最多的语言之一，覆盖拉美与西班牙用户 |

备选（第 8 种暂定 Français，若用户不选法语可换）：Français（欧洲与非洲法语区覆盖广）、Deutsch（欧洲最大经济体）、Português（巴西用户基数大）。
注：第 8 种目前暂用 Français 实现框架与公开页翻译；用户确认后如改 Deutsch/Português，只需替换 `fr.js` 为对应文件并改 `SUPPORTED_LOCALES` 一处。

## 6. 技术领先（实现支撑点，不写口号）

> 应 2026-11-08 13:07 补充要求加写；本节只罗列本路已实现的部分，不新增功能、不改架构。
> 主文档 PHASE2-4.md 的技术选型章节由总协调统一写。

- **边缘计算优先的 Workers 架构**：本阶段全部后端逻辑按 Cloudflare Workers 运行时编写——
  D1 原生 SQL（密钥余量聚合、登录日志读写）、KV 去重/计数（`REG_KEY_ALERT_DAY`、Resend 配额为第一阶段已有）、
  无自建服务器；本地用 miniflare（`wrangler.jsonc` 占位绑定）验证，不连线上。
- **现代标准**：vue-i18n（`fallbackLocale` + 按需懒加载）、ESM + Vite 代码分割（语言 chunk 独立）、
  PWA（既有）、主题切换的 View Transitions 动效（既有 ThemeSelector）、`prefers-color-scheme` 跟随系统（本阶段新增）。
- **8 语种 i18n**：8 种语言、公开页全量、缺失回落英文、非默认语言懒加载（§4）；语言偏好前后端同步。
- **性能预算**：实测数字见 §7（首屏 JS 126KB gzip、CSS 5.7KB gzip、HTML 1.7KB gzip；视觉升级 0 新增首屏请求）。
- **安全与可观测性打底**：本阶段新增登录日志（本人可查）与密钥库存告警；第一阶段已有 IP 黑名单/熔断/限流/Resend 配额/审计日志。
  端到端加密、TOTP、Passkey 等安全个性化属第六阶段（PHASE2-4.md §3 已定设计），本阶段不重复造（见 §8）。
- **工程质量**：vitest 36 项全过 + node smoke 10 项全过 + 前端构建通过；回归清单见 §10；已知问题如实列在 §11。

## 7. 性能预算（目标数字 + 实测）

> 预算目标为本阶段定值；浏览器实测项（TTI、交互耗时）因本机无可用的 live browser 而未实测，
> 如实标“未验证”，验收时按 §10 手动步骤逐项核对，不许只写“已优化”。

| 指标 | 预算目标 | 实测 / 状态 |
|---|---|---|
| 首屏初始 JS（gzip） | ≤ 150KB | **126KB** ✅（本次构建，`dist/index.html` 的 modulepreload 9 个 chunk 之和 128,927 字节，含新增 `preferences` chunk 715 字节） |
| 首屏初始 CSS（gzip） | ≤ 10KB | **5.7KB** ✅（3 个首屏样式 5,878 字节） |
| 首屏 HTML（gzip） | ≤ 2KB | **1.7KB** ✅（`dist/index.html` 1,715 字节） |
| 首屏新增外部请求 | 0 个 | **0 个** ✅（本次新增：0 字体 / 0 图片 / 0 脚本；Turnstile `challenges.cloudflare.com` 脚本与 favicon/PWA 图标为既有、异步，不计入新增） |
| 视觉升级增量 | CSS ≤ 3KB，0 新增请求 | **约 2KB 未压缩 CSS** ✅（登录页 CSS 现 1.9KB gzip；登录页 JS chunk 6.3KB gzip） |
| 非默认语言 | 按需懒加载，不进首屏 | **6 个独立 chunk** ✅（`ja/ko/vi/ru/es/fr-*.js`，`index.html` 无静态引用） |
| 首屏可交互 TTI | ≤ 2.5s（4G）/ ≤ 1.5s（WiFi） | ⚠️ **未验证**（需浏览器实测，步骤见 §10） |
| 列表切换响应 | ≤ 150ms | ⚠️ **未验证**（需浏览器实测） |
| 发信提交首反馈 | ≤ 300ms | ⚠️ **未验证**（需浏览器实测） |
| 搜索输入到结果 | ≤ 300ms | ⚠️ **未验证**（需浏览器实测） |
| 语言切换生效 | ≤ 500ms（含懒加载 chunk，WiFi） | ⚠️ **未验证**（需浏览器实测） |

## 8. 个性化（主题 / 布局 / 密度 / 语言 / 通知 / 安全）

| 维度 | 本阶段实现 | 存储 | UI 入口 | 持久化 |
|---|---|---|---|---|
| 语言 | 8 语种切换（§4） | `mail-locale` + 后端 `user.locale` | 登录页右上角 + 设置区 | ✅ 刷新保持；登录后后端同步 |
| 主题 | 浅色 / 深色 / **跟随系统**（新增第三档；跟随系统时监听 `prefers-color-scheme` 实时同步） | `mail-prefs.theme` + 既有 `ui.dark`（pinia） | 设置区主题卡片（三选一） | ✅ 刷新保持；挂载前应用防闪烁 |
| 布局/密度 | 舒适 / 紧凑（紧凑压缩邮件列表行高，见 `style.css`） | `mail-prefs.density` | 设置区“布局密度” | ✅ 刷新保持（`html[data-density]`） |
| 通知 | 登录时是否显示系统公告（开关，默认开） | `mail-prefs.notice` | 设置区“通知” | ✅ 刷新保持；关掉后登录不再自动弹公告（手动“查看”不受影响） |
| 安全设置 | **不在本阶段做** | — | — | 安全设置个性化（TOTP、Passkey、登录历史与设备管理等）见第六阶段（PHASE2-4.md §3 已定设计），本阶段不重复造，不写 TOTP/Passkey 代码 |

实现位置：`mail-vue/src/utils/preferences.js`（偏好读写/解析/应用）；
`mail-vue/src/components/theme-selector/index.vue`（主题三档）；
`mail-vue/src/views/setting/index.vue`（密度、通知开关）；
`mail-vue/src/init/init.js:31`（启动时应用偏好）；`mail-vue/src/views/login/index.vue:666`（通知开关接入点）。

## 9. 验证结果

### 9.1 后端 vitest（mail-worker，本地 miniflare，不连线上）

```
npx vitest run test/phase2a.spec.js test/phase1.spec.js
Test Files  2 passed (2)
Tests       36 passed (36)   # phase1 23/23（保持全过）+ phase2a 13/13
```

`phase2a.spec.js` 13 个用例：v3_6DB 迁移 3 项（`login_log` / `alert_log` 表、`reg_key_alert_threshold` 列）；
密钥告警 3 项（余量 < 阈值告警 1 次/天去重且文案含“剩余总量 10 / 阈值 500”、余量充足不告警、`maybeAlertLowStock` / `record` 坏 ctx 永不抛错）；
登录日志 4 项（异地登录写 `login_log` 且 `is_new_ip=1` + 同 IP 不标新 + 站内提醒邮件发给本人、
IP 未知时不标新不发提醒、登录失败不写记录、GET `/my/loginLog` 只返回本人数据）；
语言偏好 3 项（POST/GET `/my/locale` 读写回读、非法值拒绝且不写库、本人隔离 + 未登录 401）。

**中途发现并修复的两个真实问题（未放宽断言）：**
1. 首跑 phase2a 8/9、phase1 22/23：新 IP 提醒邮件导致 phase1 配额测试的已发邮件计数由 0 变 1。
   根因：测试登录不带 `CF-Connecting-IP`，`curIp` 为 `'Unknown'`，与注册 IP 不同被误判为新 IP。
   修复：`isNewIp` 判定补 `curIp !== 'Unknown'`（login-service.js:383），并在 phase2a 加“IP 未知不标新”回归用例。
   修复后两套测试 36/36 全过。
2. smoke 测试首跑抓到 `normalizeLocale('en-US')` 返回 null（带地区码的语言码未归一化）。
   修复：`locale.js` 的 `normalizeLocale()` 补主语言部分匹配（`en-US` → `en` 等），见 §9.3。

### 9.2 前端 smoke（mail-vue，node 直接跑）

```
node test/preferences-locale.smoke.mjs
SMOKE PASS: 10 项全部通过
```

覆盖：`normalizeLocale` / `toStoredLocale` / `detectBrowserLocale` / `mail-locale` 读写 /
`SUPPORTED_LOCALES` 8 种 / `loadPrefs` 默认与非法值回落 / `savePrefs` 往返 /
`resolveDark` / `applyPrefs`（`data-density`、`dark` 类、`uiStore.dark` 同步）/
`system` 模式监听注册与实时同步、切回手动档取消监听。

### 9.3 前端构建

```
mail-vue 下 npm install --legacy-peer-deps --no-package-lock --no-save（既有 peer 冲突，与本次改动无关）
npm run build → ✓ built in 27.50s（仅既有 chunk > 500 kB 警告）
```

产物核对：6 个语言 chunk 独立存在（`ja/ko/vi/ru/es/fr-*.js`），`index.html` 无静态引用；
`mail-locale` 只出现在 1 个初始 chunk 内；首屏 JS/CSS/HTML 实测见 §7。

### 9.4 vue-i18n 回落验证（node 实跑）

用 `vue-i18n` 的 `createI18n` 加载 `ja` 文案实测：`loginTitle` 正常显示日文；
缺失 key（如 `inbox`）回落英文 `Inbox`（仅控制台出现 intlify 的缺 key 提示，非报错）；
`{action}` / `{count}` 插值正常。

### 9.5 语言文件 key 覆盖（node 脚本实跑）

6 个新文件各 51 个 key（公开页 45 个 + 个性化 6 个），逐文件核对：无缺失、无空值。
`zh.js` / `en.js` 尚未含本阶段新 key（等总协调补，见 §2）——新语言文件先行翻好，补 zh/en 时请勿覆盖它们。

## 10. 回归清单（逐项打勾）

> ✅ = 已验证通过；⚠️ = 未验证（需按手动步骤核对，不冒充通过）；❌ = 未通过（无）。

### 10.1 第一阶段回归（vitest）

| # | 项 | 结果 |
|---|---|---|
| R1 | `test/phase1.spec.js` 23/23 全过 | ✅ |
| R2 | `test/phase2a.spec.js` 13/13 全过 | ✅ |
| R3 | 前端构建通过（27.50s，仅既有 chunk 体积警告） | ✅ |

### 10.2 本阶段功能回归

| # | 项 | 结果 |
|---|---|---|
| R4 | 密钥余量 < 阈值告警 1 次/天，余量充足不告警（vitest） | ✅ |
| R5 | 异地登录写 `login_log`、同 IP 不标新、登录失败不写记录（vitest） | ✅ |
| R6 | 新 IP 站内提醒邮件发给本人（vitest：发件记录 +1，收件人为本人） | ✅ |
| R7 | GET `/my/loginLog` 只返回本人数据（vitest） | ✅ |
| R8 | POST/GET `/my/locale` 读写、非法值拒绝、本人隔离、未登录 401（vitest） | ✅ |
| R9 | 注册/登录报错映射表覆盖 9 组中/英文原文（代码 + 构建通过；界面弹词待人工核对） | ✅ 代码 / ⚠️ 界面人工核对 |
| R10 | Turnstile 加载失败降级提示可见（代码 + 构建通过；需断网/拦截 Turnstile 域名人工核对） | ✅ 代码 / ⚠️ 人工核对 |
| R11 | 发件页“今日还剩 X 封”横幅（代码 + 构建通过；需登录后人工核对） | ✅ 代码 / ⚠️ 人工核对 |
| R12 | 设置页登录记录表格（代码 + 构建通过；需登录后人工核对） | ✅ 代码 / ⚠️ 人工核对 |
| R13 | 登录页视觉升级样式（构建通过；视觉效果需人工看屏核对） | ✅ 代码 / ⚠️ 人工核对 |
| R14 | 8 种语言切换、缺失回落英文（node 实测回落 + key 覆盖脚本 + 构建通过；全界面切换需人工核对） | ✅ 逻辑 / ⚠️ 人工核对 |
| R15 | 语言持久化：刷新后保持（代码逻辑 + smoke；需浏览器刷新人工核对） | ✅ 逻辑 / ⚠️ 人工核对 |
| R16 | 语言后端同步：登录后 `user.locale` 有值、下次登录恢复（后端接口 vitest 通过；端到端恢复流程需浏览器人工核对） | ✅ 接口 / ⚠️ 人工核对 |
| R17 | 主题三档 / 密度 / 通知开关（smoke 10 项 + 构建通过；界面操作需人工核对） | ✅ 逻辑 / ⚠️ 人工核对 |
| R18 | 性能预算实测项（§7 标 ✅ 的行：首屏 JS/CSS/HTML、零新增请求、懒加载 chunk） | ✅ |
| R19 | 性能预算浏览器项（TTI、列表/发信/搜索/语言切换耗时） | ⚠️ **未验证**（无 live browser，需按 §10.3 步骤实测） |

### 10.3 手动验证步骤（浏览器实测用，逐项核对后打勾）

1. **语言切换**：打开登录页 → 右上角切换 8 种语言 → 登录/注册页文案全部切换、无缺 key 报错（控制台除 intlify 缺 key 提示外无红字）→ 进主界面再切一次，全界面生效。
2. **持久化**：切到日本語 → 刷新页面 → 仍为日语；`localStorage` 的 `mail-locale` 值为 `ja`。
3. **后端同步**：登录 → 查 D1 `user.locale` 有值（如 `ja`）→ 退出、清 `localStorage` 后重新登录 → 界面自动恢复日语。
4. **视觉**：登录页在桌面与手机宽度下查看——渐变/玻璃拟态/品牌徽章/渐变按钮正常，表单对比度与焦点态清晰，无溢出。
5. **Turnstile 降级**：拦截 `challenges.cloudflare.com` 后打开注册页 → 应出现黄色降级提示条，注册流程不卡死。
6. **报错映射**：用已用完的注册码注册 → 应看到人话提示（非后端原文），且只弹一次。
7. **发件余量**：登录有日限额的账号进发件页 → 顶部应显示“今日还剩 X 封”。
8. **登录记录**：设置页“登录记录”区应列出最近登录（时间/IP/设备/新 IP 徽章）。
9. **个性化**：设置区切主题三档（含跟随系统后改系统主题实时跟随）、切紧凑密度（列表行高变矮）、关“登录时显示系统公告”后重新登录不再自动弹公告 → 刷新后三项均保持。
10. **性能**：Chrome DevTools（4G 节流）测 TTI ≤ 2.5s；Performance 面板核对列表切换 ≤ 150ms、发信首反馈 ≤ 300ms、搜索 ≤ 300ms、语言切换 ≤ 500ms；Network 面板核对首屏无本次新增的外部请求。

## 11. 已知问题与未完成项（不许带已知问题交付——以下逐项说明状态）

1. **角色 `sendType='ban'` 的用户收不到新 IP 提醒**：提醒走正常发信通道 `emailService.send()`，
   被禁发角色会抛 `bannedSend`，已 try/catch（不阻断登录，只记日志）。登录日志本身不受影响。
   如需覆盖被禁发用户，需总协调定是否改走内部投递——本阶段按契约原文（走 `emailService.send`）实现，不擅自改通道。
2. **`daySendLimit` 人话映射待接入**：映射函数 `friendlySendError()` 已写在 `send/index.vue` 并导出，
   但发信失败的实际提示在 `layout/write/index.vue` 的 `sendEmail().catch()` 里弹，该文件不在 A 路归属内，
   故未接入。总协调接入时只需在 write 页 import 并调用 `friendlySendError(e.message, t)` 一行。
   （后端原文“发送次数已到达每日限制”本身已是人话，映射版为“今天的发信次数已用完，明天再试”。）
3. **新 key 待总协调补进 zh/en**：§2 的 28 个新 key（后端 2 个 + 前端 26 个）在 `zh.js` / `en.js` 里尚无，
   集成前界面会显示 key 本身；总协调补完后需重跑前端构建。6 个新语言文件已先行翻好。
4. **跟随系统卡片预览图暂用浅色**：ThemeSelector 第三张卡片的预览图为浅色样式，未做半深半浅预览；
   选中态与文案正确，不影响功能，细节待打磨。
5. **提醒邮件计 1 次发信量**：普通角色的新 IP 提醒邮件走正常发信通道，会按角色规则计 1 次发信量；
   若用户当日额度已满，提醒发不出（已 try/catch，不阻断登录）。与第 1 项同源，待总协调定通道策略。
6. **浏览器实测项未验证**：§10.3 的 10 项手动步骤与 §7 的 5 项耗时目标需在有 live browser 的环境下逐项核对；
   本报告不把它们写成通过。

## 附：改动文件总览

- 新增：`PHASE2-A.md`（本文件）；`mail-worker/src/service/login-log-service.js`；
  `mail-worker/test/phase2a.spec.js`；`mail-vue/src/i18n/locale.js`；
  `mail-vue/src/i18n/{ja,ko,vi,ru,es,fr}.js`；`mail-vue/src/utils/preferences.js`；
  `mail-vue/test/preferences-locale.smoke.mjs`。
- 修改：`mail-worker/src/service/{reg-key-service,login-service}.js`；
  `mail-worker/src/api/my-api.js`；
  `mail-vue/src/views/{login,send,setting}/index.vue`；
  `mail-vue/src/components/theme-selector/index.vue`；
  `mail-vue/src/i18n/index.js`；`mail-vue/src/init/init.js`；
  `mail-vue/src/request/my.js`；`mail-vue/src/style.css`。
- 未改动：§1.3 所列禁改文件；`package.json` / lockfile；第一阶段已通过的代码（除登录成功路径上
  按契约新增的日志/提醒 best-effort 调用外，注册门禁、熔断、Turnstile、配额逻辑一行未动）。
