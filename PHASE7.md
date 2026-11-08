# PHASE7 — 体验完善：壁纸 / 语言 / 搜索 / AI / 安全打磨 / 开场动画 / 发信容灾

> 愿景（用户 2026-11-08 定）：新项目要做成**世界最好的公共邮箱**，全自动化；
> 斯诺登的远景就是产品的愿景——**隐私、安全、自由**。主屏默认斯诺登主题
> 远景壁纸 + 开场动画 + 斯诺登名言，全部围绕这个愿景做。
> 本阶段只做本地开发与测试，**未部署线上**（无 `wrangler deploy` /
> `wrangler login`）；未碰老项目 mail.flame.edu.kg 的任何配置；
> 未写任何密钥/Token 进文件。部署由用户另行安排。
>
> 迁移号：v3_8DB（安全）→ v3_9DB（AI）→ v3_10DB（壁纸），依次调用、幂等，
> 不要合并或重排。分工见各节；隐私审计全文见 [PHASE7-PRIVACY-AUDIT.md](PHASE7-PRIVACY-AUDIT.md)，
> 安全打磨全文见 [PHASE7-SECURITY.md](PHASE7-SECURITY.md)，
> 补充需求备忘见 [PHASE7-NOTES.md](PHASE7-NOTES.md)。

## 1. 范围

| # | 内容 | 状态 |
|---|---|---|
| 1 | 壁纸系统：15 张原创壁纸 + 选择器 + 按喜好推荐 + 自定义上传（R2）+ 登录页/邮箱背景 | ✅ 完成 |
| 2 | 顶栏语言切换器（8 语种） | ✅ 完成 |
| 3 | 搜索强化：顶栏常驻全局 + 文件夹筛选（正文搜索审计通过，后端未动） | ✅ 完成 |
| 4 | AI 后端：Workers AI 开源权重模型，写信/回信/摘要，带开关与限流 | ✅ 完成 |
| 5 | AI 界面：写信/回信/摘要三处按钮 | ✅ 完成 |
| 6 | 开场动画：斯诺登远景 + 品牌字标 + 光效 + 三句名言轮换，轻量可跳过 | ✅ 完成 |
| 7 | 安全打磨：登录历史/设备可见性、每封邮件加密标识、闲置自动锁定 | ✅ 完成 |
| 8 | 隐私审计与升级：最小化日志、默认加密、数据主权、透明开源、减第三方依赖 | ✅ 完成（16 项中 9 项已做，5 项未做见 §13） |
| 9 | 发信容灾：CF 失败自动回落 Resend | ✅ 完成 |
| 10 | 邀请码 SNOWDEN 注册 | ⏳ 用户在后台直接建，注册模式由用户改成凭码注册，本阶段不管 |

## 2. 壁纸系统

### 壁纸清单（15 张，全部 AI 生成原创，未从网上扒图）

位置：`mail-vue/public/wallpapers/`（15 张 jpg + `wallpapers.json` 清单）。
全部 2048×1152（16:9，高于 1920×1080 目标），单张 ≤600KB
（6 张超的已用 PIL JPEG quality 85 重压，最大 599.4KB）。
清单每项含 `id / name / nameEn / category / categoryEn / file / desc`，
外加 `tags`（中文风格标签数组）与 `mood`（中文心情词），供按喜好推荐。

| # | 文件 | 中文名 | 分类 |
|---|---|---|---|
| 1 | snowden-vista.jpg | 斯诺登远景 ⭐默认（`isDefault: true`） | 主屏默认 |
| 2 | starry-sky.jpg | 璀璨星空 | 星空 |
| 3 | space-earth.jpg | 太空地球 | 太空 |
| 4 | ocean-coast.jpg | 清澈海岸 | 海洋 |
| 5 | forest-mist.jpg | 晨雾松林 | 森林 |
| 6 | city-night.jpg | 霓虹雨夜 | 城市夜景 |
| 7 | minimal-gradient.jpg | 柔和渐变 | 极简 |
| 8 | anime-countryside.jpg | 乡野天空 | 动漫 |
| 9 | sunset-portrait.jpg | 海边日落 | 写真·电影感 |
| 10 | portrait-fresh.jpg | 清新田野 | 写真·清新自然 |
| 11 | portrait-fashion.jpg | 时尚街头 | 写真·时尚 |
| 12 | portrait-natural-light.jpg | 窗边柔光 | 写真·自然光 |
| 13 | portrait-vintage.jpg | 复古花园 | 写真·优雅复古 |
| 14 | aurora.jpg | 极光之夜 | 极光 |
| 15 | desert-sunset.jpg | 沙漠落日 | 沙漠日落 |

- 写真类共 5 张，全部端庄唯美、不低俗；斯诺登远景只做风格化背影剪影
  （雨夜天台背影 + 笔记本 + 城市灯光 + 监控镜头），无人脸特写。
- 总协调已亲眼验过 snowden-vista 与 portrait-fashion 两张，符合要求。

### 选择器与推荐

- 设置页新增壁纸卡片（`section id="wallpaper"`，在 Workers AI 卡片后；
  顶栏图片图标按钮跳到这里，`scrollIntoView` 带 10 次 × 200ms 重试），
  内嵌新组件 `wallpaper-selector`：15 张按分类分组网格（缩略图 + 中文名，
  非中文界面显示英文名），默认选中 `snowden-vista`（空值即默认）。
- 按喜好推荐：标签 chips 取自清单 `tags`（去重保序，共 39 个）；点标签即记为
  喜好（高亮），网格按命中任一喜好标签过滤；“为你推荐”一行取命中数最高
  的前 3 张（同分保清单原序）；喜好标签存入用户偏好（本地 + 后端）。
  冒烟实测：`[隐私,电影感]` → snowden-vista（2 命中）、sunset-portrait；
  `[清新]` → forest-mist、portrait-fresh；无喜好时推荐行不显示。
  推荐函数 `recommendWallpapers(list, likedTags, 3)`。

### 自定义上传与持久化

- 上传：前端校验 jpeg/png/webp、≤2MB；后端新建 `POST /wallpaper/upload`
  （路由模块 `mail-worker/src/api/wallpaper-api.js`，`webs.js` 只加一行注册；
  登录态靠 `security.js` 中间件，任意登录用户可用，同 `/ai/*`）。
  入参 JSON base64 data URL（与 `setBackground` 同款，不走 multipart）；
  后端 `fileUtils.base64ToFile` 解析，校验 mime 与解码后 ≤2MB；
  存储 `r2Service.putObj`（绑 R2 时存 R2，未绑时按既有回落走 KV/S3）；
  路径 `wallpapers/{userId}/{时间戳}.{ext}`，返回 `{key, url: "/oss/" + key}`，
  由本站 `/oss/*` 代理读出。上传成功后出现在选择器“自定义”分组并自动设为当前壁纸。
- 持久化：本地 `localStorage`（`mail-wallpaper` / `mail-wallpaper-tags` /
  `mail-wallpaper-custom`）+ 后端，登录后双向同步。复用 `user.locale` 那套
  （`GET/POST /my/*` + `sync*WithServer` 登录同步），新增字段 + 迁移 **v3_10DB**：
  `user.wallpaper` TEXT（预置 id 或自定义上传 URL，空 = 默认）、
  `user.wallpaper_tags` TEXT（逗号分隔）；接口 `GET/POST /my/wallpaper`
  （与 locale 同文件 `my-api.js`），值校验：预置 id 正则或
  `/oss/wallpapers/{userId}/{时间戳}.{ext}`，拒绝路径穿越/空格/超长；
  标签最多 10 个、每项 ≤20 字、禁逗号。
- 注意：`/oss/*` 在鉴权白名单内，上传后的壁纸与附件、登录背景一样可公开访问
  （凭 key 猜到 URL 即可看），与现有附件同一口径，未另做鉴权。

### 背景应用

- 登录页与邮箱共用同一背景层（默认斯诺登远景）；浅色加淡白遮罩、深色加
  半透明黑遮罩额外压暗（跟随 `uiStore.dark` 实时重算）；邮箱主区/顶栏半透明 +
  毛玻璃（`backdrop-filter: blur(14px)`），登录表单卡片保持不透明保证可读。
- 优先级：登录页若管理员设过全局背景（`setting.background`），仍以管理员背景
  为准、壁纸层在其后。
- 实现：`mail-vue/src/utils/wallpaper.js`（解析/推荐/存储/背景应用/
  `syncWallpaperWithServer`）、`App.vue` 挂载应用 + 深色切换重算、
  `layout/index.vue`（`has-wallpaper` class）、`style.css`（全局背景层 +
  毛玻璃 + 登录页透底）。背景层用 `body::before` + `z-index: -1` 实现；
  `#background-wrap` 云朵动画在壁纸开启时隐藏。

### 壁纸改动文件

后端：`mail-worker/src/api/wallpaper-api.js`（新建）、`src/api/my-api.js`
（+`/my/wallpaper`）、`src/init/init.js`（+v3_10DB）、`src/entity/user.js`
（+2 列）、`src/hono/webs.js`（+1 行注册）、`test/phase7-wallpaper.spec.js`
（新建，12 用例）。前端：`components/wallpaper-selector/index.vue`（新建）、
`utils/wallpaper.js`（新建）、`request/wallpaper.js`（新建）、
`request/my.js`（+`getWallpaper/setWallpaper`）、`views/sys-setting/index.vue`
（+壁纸卡片）、`App.vue`、`layout/index.vue`、`style.css`、`init/init.js`、
`views/login/index.vue`、`i18n/{8 个文件}`（各追加一个 `wallpaper: {...}` 对象，
15 个 key）。

## 3. 顶栏语言切换器

- 顶栏 toolbar 新增地球图标 + 当前语言名 + 下拉（复用登录页同款内联 globe SVG），
  列出 8 语种原生名：简体中文、English、日本語、한국어、Tiếng Việt、Русский、
  Español、Français；当前语言高亮显示。
- 切换复用设置页同一机制：`applyLocale(i18n, settingStore, lang)`（懒加载文案 →
  即时生效 → 写 `localStorage mail-locale`）+ `setLocale(toStoredLocale(lang))`
  同步后端 `user.locale`（`@/request/my.js` 的现有 `POST /my/locale` 接口，
  失败静默、下次登录再同步）。旧的顶栏 `changeLang` 是死代码（只支持 zh/en、
  模板里没用），已替换。
- 下拉显示的是共享 `SUPPORTED_LOCALES` 的“简体中文”（登录页、设置页共用同一份数据，
  未改它）。dayjs 相对时间仍只切 zh-cn/en（与旧代码一致，`day.js` 只内置了这两种 locale）。
- 改动：`mail-vue/src/layout/header/index.vue`；i18n 各文件追加 `lang: {language, wallpaper}`。

## 4. 搜索强化

**审计结论：正文搜索本来就是通的，后端未动。**

| 类型 | 后端实现 | 结论 |
|---|---|---|
| 主题 subject | `subject LIKE` | 通 |
| 正文 content | `text OR content LIKE`（`text` 列收发信入库时均有值；列表 brief 列取 `text` 前 300 字、无 `text` 才回落 `content`） | 真走通 |
| 发件人 sender | `name LIKE` | 通 |
| 发件地址 senderAddress | `sendEmail LIKE` | 通 |
| 收件地址 recipientAddress | `toEmail LIKE` | 通 |
| 日期范围 | `createTime` 起止 | 通 |

高亮也不缺：`email-scroll` 已有 `renderHighlight`（`<mark class="search-hit">`，
覆盖发件人/主题/正文摘要/邮箱地址），inbox/send/all-mail 三页都已接 `highlight-text`。

真正缺的两处，已补上：

- **全局常驻**：顶栏搜索原来只在 inbox/sent 路由渲染（`v-if="showInboxSearch"`），
  设置页、星标页等都没有。现改为所有页面常驻一个搜索框。
- **文件夹筛选**：原来搜索锁死当前文件夹。搜索面板新增“搜索范围”分段选择
  （收件箱 / 已发送），切范围即换 store（`emailStore`/`sendStore`）并从新 store
  恢复该文件夹已存的搜索条件；切范围本身不跳页，点搜索/重置时才跳到对应列表；
  范围默认跟随当前路由。星标/全部邮件未纳入范围（它们走不同的视图与 store，
  不在本次文件归属内）。

改动：`mail-vue/src/layout/header/index.vue`（常驻全局搜索 + 范围切换逻辑）、
`mail-vue/src/components/email-search/index.vue`（`scopes`/`scope` props +
范围选择 UI + 切 store 时恢复已存条件）；i18n 各文件追加
`search: {scope, scopeInbox, scopeSent}`。

## 5. AI 后端（Workers AI 写信 / 回信 / 摘要）

### 定稿

- **模型（用户 2026-11-08 定，开源权重路线，不接闭源商业 API、不让用户填 key）**：
  主 `@cf/meta/llama-3.1-8b-instruct`，备用 `@cf/meta/llama-3-8b-instruct`。
  主模型失败（抛错或空回复）时自动降级到备用模型；两个都不可用时返回
  `ai_unavailable`，不抛 500、不破坏发信等主流程。
  （原任务初版写的主模型 Qwen 已按追加要求废弃，不再作为主/备。）
- **开关**：`setting.ai_enabled`，直白布尔语义：**1 = 开启（默认），0 = 关闭**。
  注意与站内多数 `0=OPEN / 1=CLOSE` 的反向开关不同，读写时不要套用旧约定
  （`settingConst.aiEnabled = { OPEN: 1, CLOSE: 0 }` 已在代码里显式标注）。
- **限流**：每用户每天最多 **50 次** AI 调用（KV 计数，`ai_day:<userId>:<YYYY-MM-DD>`，
  TTL 48 小时）；超了返回 `ai_quota_exceeded`；只在 AI 成功返回后计数，
  失败重试不消耗配额。计数复用 quota-service 的 read-modify-write 写法，
  高并发下可能少计几次（与 Resend 配额同一容忍口径）。
- **错误包**：遵循项目约定——Hono onError 恒返回 HTTP 200，真实错误码在
  `body.code`。AI 错误码为语言无关字符串，后端不把任何中文提示写死在返回里
  （`body.message` 与 `body.code` 相同，都是该错误码本身）；前端按
  `body.code` 查 `ai.*` 翻译 key 展示（key 清单见下表）。

### 接口

均需登录（`security.js` 中间件统一拦未登录 401）；无需额外权限点，
任意登录用户可用。成功返回 `result.ok(data)`，即 `{code: 200, data}`。

| 接口 | 入参 | 返回 `data` |
|---|---|---|
| `POST /ai/compose` | `{prompt, tone?}`（`prompt` 必填，≤2000 字符；`tone` 为 `formal` / `friendly` / `concise` / `neutral`，默认 `neutral`，非法值按 `neutral` 处理） | `{subject, body, remaining}` |
| `POST /ai/reply` | `{emailId}` 或 `{subject, body, sender}`（另可带 `tone?`） | `{subject, body, remaining}` |
| `POST /ai/summarize` | `{emailId}` 或 `{body, subject?}` | `{summary, remaining}` |

- `remaining`：调用成功后当日剩余次数。
- `compose` / `reply` 输出约定：第一行标题、空一行、正文（service 内
  `_parseSubjectBody` 解析；模型只回一行时整行当正文、标题留空；`reply`
  模型未给标题时按原标题补 `Re: `）。
- `summarize`：3–5 行摘要（超 5 行只取前 5 行，不足 3 行按模型实际返回，
  不编造凑数）。
- `emailId` 只读本人未删邮件；不存在或非本人一律返回 `ai_not_found`
  （不区分两种情况，避免探查他人邮件）。
- 提示词按用户语言（`user.locale`，默认 `zh-CN`）生成，覆盖 8 语种
  （zh-CN / en / ja / ko / vi / ru / es / fr），见 `ai-service.js` 顶部 `PROMPTS`。

错误码：`ai_disabled`（开关关闭）、`ai_quota_exceeded`（超 50 次/天）、
`ai_unavailable`（未绑定 AI 或主备模型都失败）、`ai_invalid_input`
（入参缺失/非法，如空 prompt、超长 prompt、无正文可摘要）、
`ai_not_found`（`emailId` 不存在或非本人）。
未登录仍走原有机制：`401`（`authExpired`，非 AI 错误码）。

### 前端 i18n key 清单（`ai.*`，21 个，8 个文件已全齐，总协调 node 直引核对过）

| key | 用途 / 出现位置 | 中文（参考） | English (reference) |
|---|---|---|---|
| `ai.disabled` | `body.code === 'ai_disabled'` 时的提示 | AI 助手已关闭，请联系管理员开启 | AI assistant is disabled. Contact the administrator to enable it. |
| `ai.quotaExceeded` | `body.code === 'ai_quota_exceeded'` 时的提示 | 今日 AI 调用次数已用完（每天 50 次），明天再试 | You've used up today's AI calls (50 per day). Try again tomorrow. |
| `ai.invalidInput` | `body.code === 'ai_invalid_input'` 时的提示 | 输入内容无效，请检查后重试 | Invalid input. Please check and try again. |
| `ai.notFound` | `body.code === 'ai_not_found'` 时的提示 | 找不到这封邮件，或无权访问 | Email not found, or you don't have access to it. |
| `ai.unavailable` | `body.code === 'ai_unavailable'` 时的提示 | AI 服务暂时不可用，请稍后再试 | AI service is temporarily unavailable. Please try again later. |
| `ai.compose` | 写信功能标题 / 按钮 | AI 写信 | Compose with AI |
| `ai.composePlaceholder` | 写信输入框占位 | 告诉 AI 你想写什么… | Tell AI what you want to write… |
| `ai.reply` | 回信功能标题 / 按钮 | AI 回信 | Reply with AI |
| `ai.summarize` | 摘要功能标题 / 按钮 | AI 摘要 | Summarize with AI |
| `ai.generating` | 生成中状态 | AI 生成中… | AI is generating… |
| `ai.subject` | 草稿标题栏 | 标题 | Subject |
| `ai.body` | 草稿正文栏 | 正文 | Body |
| `ai.summary` | 摘要结果栏 | 摘要 | Summary |
| `ai.remaining` | 今日剩余次数（`{count}` 为数字） | 今日还可使用 {count} 次 | {count} uses left today |
| `ai.tone` | 语气选择器 | 语气 | Tone |
| `ai.toneFormal` | 语气选项：正式 | 正式 | Formal |
| `ai.toneFriendly` | 语气选项：亲切 | 亲切 | Friendly |
| `ai.toneConcise` | 语气选项：简洁 | 简洁 | Concise |
| `ai.toneNeutral` | 语气选项：自然 | 自然 | Neutral |
| `ai.useDraft` | 把 AI 草稿填入编辑器按钮 | 使用草稿 | Use draft |
| `aiAssistant` | 设置页 Workers AI 卡片开关 | AI 助手 | AI assistant |

### AI 后端改动文件

| 文件 | 改动 |
|---|---|
| `mail-worker/src/service/ai-service.js` | 保留原有验证码提取（`extractCode` 不动）；新增 compose / reply / summarize、`_runChat`（主备降级）、`_assertEnabled`、`_checkQuota` / `_recordUsage` / `_getUsage`、`_getUserLocale`、`_selectOwnEmail`、`_parseSubjectBody`、8 语种 `PROMPTS` |
| `mail-worker/src/api/ai-api.js` | 新增：三个路由注册 |
| `mail-worker/src/hono/webs.js` | 新增 `import '../api/ai-api'` |
| `mail-worker/src/entity/setting.js` | 新增 `aiEnabled` 列（`ai_enabled`，默认 1） |
| `mail-worker/src/const/entity-const.js` | `settingConst` 新增 `aiEnabled: { OPEN: 1, CLOSE: 0 }`（附反向约定警告注释） |
| `mail-worker/src/const/kv-const.js` | 新增 `AI_DAY: 'ai_day:'` |
| `mail-worker/src/init/init.js` | 新增 **`v3_9DB`**（`setting.ai_enabled` 列，默认 1，幂等）并在 `init()` 里调用。注意：`v3_8DB` 已被并行同事占用，故本阶段用 `v3_9DB`，不要改名或合并 |
| `mail-worker/src/service/setting-service.js` | `websiteConfig()` 返回值新增 `aiEnabled`（`?? 1`，老库缺列时默认开），供前端未登录时判断是否展示 AI 入口；管理员 `PUT /setting/set {aiEnabled: 0/1}` 即生效 |
| `mail-vue/src/views/sys-setting/index.vue` | Workers AI 卡片新增 AI 助手开关（`changeField('aiEnabled', …)`，`active-value=1 / inactive-value=0`；注意与隔壁 `aiCode` 的 `0 开 / 1 关`相反） |
| `mail-worker/test/phase7-ai.spec.js` | 新增，30 个测试（见 §11） |
| `DEPLOY.md` | 新增 §2.3（AI 绑定/模型/开关/限流/接口说明）；§6 检查清单第 1 项加 `ai_enabled` 列、第 2 项加 AI 开关确认、新增第 9 项 AI 冒烟 |

**wrangler 配置说明**：`[ai] binding = "ai"` 在 `mail-worker/wrangler.toml`
与 `deploy.sh` 生成部署配置的模板里**本来就已经有了**（此前验证码提取
`ai_code` 功能留下的绑定），本次核对无误，**未改动**这两个文件；
`DEPLOY.md` §5.1 模板里同样已有 `[ai]` 一节，也未改动。本地测试配置
`wrangler.jsonc` **未加** AI 绑定（miniflare 本地没有真实 Workers AI），
HTTP 层成功路径因此走不通，改用 service 级 mock 覆盖。

**与验证码提取的关系**：原有 `extractCode` 继续用
`c.env.ai_model || '@cf/meta/llama-3.1-8b-instruct-fast'`，不动；
新功能固定用主/备 Llama 模型，不读 `ai_model` 变量。
`ai_code`（验证码识别开关）与 `ai_enabled`（AI 写信/回信/摘要总开关）
是两个独立开关，互不影响。

## 6. AI 界面

- **AI 写信**（`mail-vue/src/layout/write/index.vue`，+178 行）：标题栏新增
  「AI 写信」按钮（回信模式下隐藏）。点开对话框：提示词输入框
  （maxlength 2000、显示字数）+ 语气选择（正式/友好/简洁/自然，默认自然），
  调 `POST /ai/compose`。成功后先在对话框内预览标题+正文，点「使用草稿」
  才填入：标题进主题栏，正文经 `defValue` 进 TinyMCE（纯文本先转义再按行分段，
  可再编辑）。
- **AI 回信**：同一写信框在 `sendType === 'reply'` 时显示「AI 回信」按钮
  （不显示写信按钮），对话框只留语气选择，调 `POST /ai/reply {emailId, tone}`。
  点「使用草稿」后 AI 正文放在引用原文之上，引用块原样保留；标题以后端返回的
  （已带 `Re:` 前缀）为准。
- **AI 摘要**（`mail-vue/src/views/content/index.vue`，+117 行）：详情页头部新增
  「AI 摘要」按钮，调 `POST /ai/summarize {emailId}`，摘要面板直接展示在
  详情页标题下方（3–5 行，`pre-wrap` 原样显示），可关闭，切邮件时自动清空。
- **状态处理**：生成按钮 `:loading`（文案切为「AI 生成中…」）+ 摘要面板生成中
  显示同样文案；生成期间按钮禁用防重复提交。新建 `mail-vue/src/request/ai.js`，
  三个接口一律 `noMsg: true`（否则 axios 拦截器会把原始错误码
  `ai_quota_exceeded` 裸弹给用户），`catch` 里按 `body.code` 映射到 `ai.*`
  翻译，未知错误（含网络失败）一律按 `ai.unavailable` 展示；401 仍走原有逻辑
  （清 token、跳登录页）。成功后取 `data.remaining`，写信对话框与摘要面板内
  均显示 `ai.remaining`（`{count}` 占位）。`aiEnabled` 取自 `websiteConfig`
  （`settingStore.settings.aiEnabled`）；为 `0` 时三个 AI 按钮全部隐藏，
  未取到配置时按开启处理（与后端 `?? 1` 一致）。E2EE 加密邮件未解锁时摘要按钮
  禁用（服务端 D1 里只有密文）；已解锁则传解密后明文调摘要。
- i18n：21 个 `ai.*` key × 8 个文件已全齐（总协调 node 直引核对过，
  `remaining` 均含 `{count}` 占位）。
- 改动：`layout/write/index.vue`、`views/content/index.vue`、
  `request/ai.js`（新建）、8 个 `i18n/*.js`（只加 `ai.*`/`aiAssistant` key）。

## 7. 开场动画

新组件 `mail-vue/src/components/intro-animation/index.vue`（纯 CSS 动效，
零新增依赖、零视频、零重型库），全屏覆盖在登录页之上；登录表单在遮罩下
正常挂载，不阻塞加载。**这是产品自己的开场动画，不是广告位**，无任何
推广/外部内容。

| 时序 | 效果 |
|---|---|
| 0s | 遮罩淡入（0.6s）；默认壁纸 `snowden-vista.jpg` 开始 8 秒缓慢缩放+平移的电影感运镜（Ken Burns，`scale 1.02→1.12`，纯 CSS） |
| 0.7s | 信封徽章（沿用登录页同款渐变徽章）淡入上浮 |
| 0.9s | 品牌字标淡入上浮 |
| 1.4s | 底部名言区淡入 |
| 2.1s | 一道光效从左至右扫过品牌字标 |
| 8s | 自动淡出（0.5s）进入登录页 |

- **品牌字标**：沿用登录页同一来源 `settingStore.settings.title`（后端网站配置），
  未自创新名字；配置未加载完前先显示 `Mail` 占位，到达后自动更新。
- **名言轮换**：三句英文原文照 [PHASE7-NOTES.md](PHASE7-NOTES.md) 全文硬编码在组件
  常量里，主推第一句先显示；英文原文固定不变，底部小字翻译走 i18n
  `intro.quote1/2/3`，署名 `— Edward Snowden`。总协调已在源码里逐字验证三句
  原文无误，未新增任何“斯诺登名言”。
  1. "Arguing that you don't care about the right to privacy because you have nothing to hide is no different than saying you don't care about free speech because you have nothing to say."
  2. "Privacy isn't about something to hide. Privacy is about something to protect."
  3. "Under observation, we act less free, which means we effectively are less free."
- **可跳过**：右上角“跳过”按钮 + 右下角“不再显示”复选框 + Esc 键；
  勾选“不再显示”后写 `localStorage.mail-intro-dismissed = '1'`，下次直接不渲染；
  只点跳过则本次消失、下次还显示。另支持 `prefers-reduced-motion` 时停用全部动效。
- **一个冲突与折中（待用户定，见 §13）**：任务同时要求“每句停留约 5 秒”和
  “8 秒后自动消失”——三句 × 5 秒 = 15 秒，8 秒内放不下。**取 8 秒总时长为准，
  轮换约 2.6 秒/句**，保证三句在消失前都能出现一次。如需每句足 5 秒，总时长须
  延长至约 16 秒，代码里 `AUTO_DISMISS_MS` / `QUOTE_INTERVAL_MS` 两个常量
  一改即生效。
- 接入：`mail-vue/src/views/login/index.vue`（+2 行：import + `<IntroAnimation />`
  挂在登录页根节点内；App.vue 未动——挂登录页可避免已登录用户也被挡一次，
  且品牌 title 在登录页加载配置后才有值）。
- i18n：8 个文件各追加一个嵌套 `intro: {skip, doNotShowAgain, quote1, quote2, quote3}`
  块（每文件 7 行）。
- 构建：`npm run build` 通过（22.7s），无新增依赖；动画代码打进登录 chunk，
  `login-*.js` 22.9 kB、`login-*.css` 10 kB。

## 8. 安全打磨

全文见 [PHASE7-SECURITY.md](PHASE7-SECURITY.md)。三项优先任务全部做完：

1. **登录历史/设备管理可见性**：新增 `GET /security/login-history`（独立路由模块
   `security-login-history-api.js`，`webs.js` 只加一行注册）。登录态、只查本人；
   返回时间/IP/设备/浏览器/是否新 IP/地点——设备与浏览器由服务端 UA 解析成的人话，
   IP 按现有脱敏规则展示，地点恒为 `null`（本站不记录地理位置，也不做 IP 地理库查询）。
   安全中心里设备管理与登录历史已挪到安全评分正下方，登录历史改走新接口。
2. **每封邮件加密状态标识**：E2EE 邮件显示绿锁徽标+“端到端加密”（列表+详情双处）；
   普通邮件不显示任何徽标，只在详情页显示低调小字“传输加密（TLS）”，不误导。
   关键修复：`emailBriefColumns` 原先不含 `e2ee`，列表页拿不到标志，已补上。
3. **闲置自动锁定**：`user_security` 新列 `auto_lock_minutes`（0/5/15/30 分钟，
   `v3_8DB` 迁移），安全中心下拉可配；新增最小 `POST /security/unlock`，只校验
   登录密码、不产生新会话，连续错 5 次锁 5 分钟；前端新组件
   `components/auto-lock/index.vue` 挂在登录后 layout，全屏锁定，锁定同时清除
   内存中的 E2EE 密钥。

改动：后端 `init.js`（v3_8DB）、`entity/user-security.js`、
`service/user-security-service.js`、新增 `api/security-login-history-api.js` /
`security-unlock-api.js` / `security-export-api.js`、`hono/webs.js`（3 行注册）、
`const/kv-const.js`、`i18n/zh.js`、`en.js`、`lib/email-list-columns.js`、
`service/setting-service.js` / `login-service.js` / `register-log-service.js` /
`audit-log-service.js` / `user-service.js`、新增 `test/phase7.spec.js`、
旧断言更新 `test/phase1.spec.js` / `phase2a.spec.js` / `phase6.spec.js`。
前端：新增 `components/auto-lock/index.vue`、`request/security.js`、
`layout/index.vue`、`views/security/index.vue`、`components/email-scroll/index.vue`、
`views/content/index.vue`、8 个 `i18n/*.js` 各追加 24 个 `security.*` key。
新套件 `phase7.spec.js` 11/11 通过；8 语种 24 个新 `security.*` key
经 node 直引核对全量齐全。

## 9. 隐私审计与升级

审计清单全文与改动见 [PHASE7-PRIVACY-AUDIT.md](PHASE7-PRIVACY-AUDIT.md)。
审计出的打磨清单共 16 项（按用户可感知的的安全感排序），其中三项优先
（§8）+ 6 项小而安全的隐私项已做，未做的 5 项及原因见 §13。

已做的 6 项隐私升级：

- 日志 IP 脱敏默认开启（`log_ip_mask` 0→1，`v3_8DB` 在 `/init` 时更新）；
- UA 截断统一 500；
- KV `AUTH_INFO` 不再存密码 hash/salt；
- `webhookSecret` 纳入字段加密；
- 新增 `GET /my/export` 导出我的数据；
- 物理删除一并清登录历史与安全行。

四方面结论：**未发现隐藏上报、埋点、广告 SDK 或闭源黑盒**；前端唯一外链脚本
是 Turnstile；依赖与外部服务已逐个列表说明必需性与可替换性（Resend、
Cloudflare 全家桶、Turnstile、Telegram 可选、OAuth 可选、Workers AI 开源权重等）。
另有两个提醒管理员的数据外流点：Webhook 会 POST 完整邮件内容到管理员配置的 URL、
TG 推送默认不推正文。

## 10. 发信容灾：CF→Resend 自动回落

背景：此前只要配了 CF 的 `email` 绑定，站外发信就永远走 CF（`email-service.js` 的
`useCloudflareEmail` 分支），CF 一失败就直接报错，Resend 备用通道根本用不上。
线上实例：CF Email Sending 未开通时发站外信报 `destination address is not a verified address`，
本可以走 Resend 兜底。

### 回落逻辑

- 触发点：`sendCloudflare` 生成器里某组收件人调 `sendByCloudflareEmail` 抛错时，
  立即对**该组**调 `tryResendFallback`；CF 成功的组绝不重发。
- 切流条件（缺一不可）：已配该发件域名的 Resend Key（`context.resendToken` 非空），
  且 `quotaService.hasResendBudget(c)` 为真（日/月任一撞线即不切）。
  任一不满足时返回原始 CF 错误，不调 Resend、不写发送记录。
- 只重发失败的收件人：回落按组单发 `sendByResend`（不用 `sendResend` 的批量接口——
  批量接口不支持附件，且回落只针对失败的这一组）。普通发送整组即全部收件人；
  分开发送（`manyType=divide`）每组 1 人，CF 失败的那人走 Resend、其余人仍走 CF，
  回落成功后继续下一人（CF 仍优先）。
- 回落本身失败（抛错或 Resend 返回 `{error}`）时返回原始 CF 错误，不被回落错误掩盖，
  不写发送记录。
- 状态与渠道：回落成功时 `saveSentEmail` 传 `useCloudflareEmail: false`，
  状态记 `SENT`（1，Resend 渠道），`resend_email_id` 记 Resend id；
  CF 成功的仍记 `DELIVERED`（2）+ CF messageId。email 表无独立渠道列，
  状态 + provider id 即渠道依据；后续 Resend webhook（delivered/bounced 等）
  仍按 `resend_email_id` 回写状态，与原有 Resend 路径一致。
- 配额：回落成功后 `quotaService.recordResendSent(c, 本组收件人数)`；
  CF 成功时不碰 Resend、不计配额。
- 日志/告警：每次实际回落尝试（成功/失败）都调 `telegramService.sendAlert(c, 文本, 'failover')`，
  复用现有机制：先写 `alert_log`（`type='failover'`），再按已配 TG 发告警；
  无 TG 配置时只记库不发 TG，`sendAlert` 永不抛错。文本只含发件人/收件人/CF 错误摘要/
  回落结果，不含正文。无 Key 或配额不够而不回落时不记（未发生回落）。

### 不动的行为

- 纯站内收件人仍走 `sendInternal` 本地投递；CF 成功时绝不碰 Resend；
- 发信接口入参与正常返回形状不变（分开发送的 `failedRecipients` 仍由入口按已保存记录汇总）；
- 无 CF 时仍走原 `sendResend` 分支与撞线停发逻辑。

### 改动文件

- `mail-worker/src/service/email-service.js`：`send()` 注释更新（CF 优先、失败回落）；
  `sendCloudflare` 接 `resendToken` 并在 CF 抛错时调回落；新增 `tryResendFallback`、
  `logSendFailover` 两个方法。
- `mail-worker/test/phase7-failover.spec.js`（新增）：8 个测试。
- `DEPLOY.md` 未改：回落复用已有的 Resend Key 配置与配额配置，无新增配置项。

### 测试

- 新增 `mail-worker/test/phase7-failover.spec.js`，**8 个测试，全部通过**
  （Service 级：mock `c.env.email.send`、mock Resend，不调真实服务）：
  CF 成功不回落；CF 抛错→Resend 成功（SENT + Resend id + 计配额）；
  CF 抛错→无 Resend Key→返回原始错误；CF 抛错→配额不够→不切 Resend；
  分开发送部分失败→只重发失败的 1 人；回落本身抛错→返回原始 CF 错误；
  Resend 返回 error 对象→返回原始 CF 错误；回落触发 `alert_log`（`type=failover`）记录。

### 本地无法验证的部分（需上线后验证）

- 真实 CF 故障形态是 mock 模拟的（固定抛 `destination address is not a verified address`）：
  真实 CF 报错文案、超时、部分收件人拒收等形态未验证；回落只在 `sendByCloudflareEmail`
  抛错时触发，若 CF 返回成功但实际未投递，回落不会触发。
- 真实 Resend 通道未调：mock 返回固定 id，不能证明线上 Resend Key 与域名配置正确；
  上线后按 `DEPLOY.md` §6 冒烟：先确认 CF 未开通时站外信走 Resend 发出（状态 SENT），
  再观察 `alert_log` 里 `type='failover'` 的记录。

## 11. 测试与验证（总协调最终复核，2026-11-08）

- mail-worker 全套 vitest：**8 个文件共 153 个测试，全部通过**
  （phase1 23 + phase2a 13 + phase2c 26 + phase6 30 + phase7-ai 30 +
  phase7 安全 11 + phase7-failover 8 + phase7-wallpaper 12 = 153；
  中途一度因安全路的 v3_8DB 改动出现 4 个旧断言失败，已由安全路修好，
  最终全绿）。
- smtp-relay 测试：**12/12 通过**。
- mail-vue 前端构建：**通过**（`npm run build`，仅既有的 chunk > 500kB 警告）。
- 前端 smoke：`e2ee.smoke.mjs` **11/11**、`preferences-locale.smoke.mjs` **10/10**。
- i18n 全量核对（总协调 node 直引 8 个语言文件）：
  `ai.*` 21 个 key × 8 文件全齐（含 `{count}` 占位）；
  `security.*` 24 个 key × 8 文件全齐；
  `wallpaper.*` 15 个 key × 8 文件全齐；
  `lang.*` / `search.*`（language、wallpaper、scope、scopeInbox、scopeSent）× 8 文件全齐；
  `intro.*`（skip、doNotShowAgain、quote1、quote2、quote3）× 8 文件全齐。
- 壁纸：总协调亲眼验过 snowden-vista 与 portrait-fashion 两张；15 张文件与清单
  已校验（2048×1152、单张 ≤600KB、仅 snowden-vista 的 `isDefault: true`）。
- 开场动画三句名言：总协调在源码里逐字验证原文无误。

## 12. 本地无法验证的部分（需上线后验证）

- **真实 Workers AI 调用**：本地 miniflare 没有真实 AI 绑定，三个接口在本地
  一律返回 `ai_unavailable`（设计的降级行为，测试已覆盖）。真实模型输出质量、
  响应格式（标题/正文分行约定是否稳定）、延迟与 `max_tokens` 是否够用，
  只能上线后按 `DEPLOY.md` §6 第 9 项冒烟验证。Service 级 mock 测试已覆盖
  成功解析与主备降级逻辑，但 mock 返回的是固定文本，不能证明真实 Llama
  模型一定按约定格式输出；若上线后模型经常不按格式回，再收紧提示词或改解析。
- **真实配额行为**：AI 的 KV 计数与 Resend 配额逻辑本地已验证，但线上高并发下的
  少计（read-modify-write 竞态）与 Workers AI 自身的速率限制未验证。
- **真实 R2 绑定**：本地测试走 KV 回落存储，上传→`/oss/` 读回已验证；线上 R2 桶
  绑定后的写入/读取路径未验证（代码与 `setBackground` 同款 `putObj`，风险低）。
- **真实浏览器渲染与交互**：无 live browser。壁纸背景（可见度、深色压暗程度、
  毛玻璃观感）、开场动画视觉与交互（8 秒消失、轮换时序、跳过/“不再显示”持久化、
  与 Turnstile 联动）、AI 界面细节（按钮位置、对话框宽度 520px、摘要面板样式）、
  语言切换即时生效、搜索跨文件夹跳转、移动端排版——均只在构建与代码层面验证，
  需上线后真机验收。
- **真实 CF/Resend 故障回落**：见 §10，mock 模拟，未调真实通道。
- **跨设备自定义壁纸列表**：自定义上传记录只存本地 `mail-wallpaper-custom`，
  换设备后选择器里不显示历史上传项，但当前选中值（`/oss/...` URL）会随账号同步，
  背景本身仍生效。

## 13. 已知问题与未做项

### 待用户定的点

1. **开场动画名言时序**：任务同时要求“每句停留约 5 秒”和“8 秒后自动消失”，
   三句 × 5 秒 = 15 秒，8 秒内放不下。当前取 8 秒总时长、轮换约 2.6 秒/句。
   如需每句足 5 秒，总时长须延至约 16 秒，改 `AUTO_DISMISS_MS` /
   `QUOTE_INTERVAL_MS` 两个常量即生效。
2. **用户自助“彻底删除”**：目前自删默认只是软删（`sync_delete=1`），彻底删除
   需管理员先开同步删除——是否把选择权下放给用户，需产品决定。

### 隐私审计未做的 5 项及原因（见 PHASE7-PRIVACY-AUDIT.md §6）

- TOTP 无二维码（只有手动输入 secret）；
- 安全评分只看最近 20 条记录；
- 用户侧审计视图缺失；
- 登录限流缺失；
- 会话无最后活跃时间。
（原文如此，细节与原因见审计文档。）

### 其他已知局限

- 完整邮箱导出（含正文/附件）未做（只有 `GET /my/export` 基础导出）；
- 附件端到端加密未做；
- `FIELD_ENC_KEY` 单密钥，无轮换；
- `/oss/*` 在鉴权白名单内，上传壁纸与附件一样可凭 URL 猜到后公开访问；
- dayjs 相对时间只支持 zh-cn/en 两种 locale；
- 登录页若管理员设过全局背景（`setting.background`），仍以管理员背景为准。

## 14. 部署前还缺什么

按 `DEPLOY.md` §6 顺序，除已有项外，第七阶段新增的部署前检查：

1. 跑 `/init` 后核对新列：`setting.ai_enabled`、`user.wallpaper`、
   `user.wallpaper_tags`、`user_security.auto_lock_minutes` 存在；
   `setting.log_ip_mask` 默认应为 1。
2. 管理后台确认 AI 助手开关 = 开启（默认开启）。
3. AI 冒烟（`DEPLOY.md` §6 第 9 项）：三个接口返回 HTTP 200 且 `body.code` 为 200；
   开关关闭时 `ai_disabled`；超 50 次/天时 `ai_quota_exceeded`。
4. 壁纸冒烟：设置页壁纸区 15 张预置图能加载、切换生效、推荐行按标签出结果、
   上传一张自定义壁纸（R2 写入与 `/oss/` 读回）、换设备登录后选中值同步。
5. 开场动画冒烟：首屏出现远景 + 字标 + 名言轮换，8 秒消失；点“不再显示”后
   下次不再出现；跳过按钮与 Esc 生效。
6. 发信容灾冒烟：CF 未开通时站外信走 Resend 发出（状态 SENT），`alert_log`
   里出现 `type='failover'` 的记录。
7. 其余既有待办（第七阶段之前就有的，见 `DEPLOY.md` §6）：
   CF Email Sending 开通（线上发信报错的根因；回落已能兜底，但主通道仍需开通）、
   Email Routing MX/Catch-All、TG Bot Token、建注册密钥、甲骨文巡检上线 + WAF、
   SMTP 真实联调；邀请码 SNOWDEN 由用户在后台直接建，注册模式由用户改成凭码注册。
8. 本阶段 65 个文件改动未提交（`git status` 约 65 项，含 15 张壁纸与清单），
   部署前由用户安排提交/推送（仓库 https://github.com/kimi712/mail-ultimate）。
9. 自助彻底删除已完成（PHASE7-HARDDELETE.md）：安全中心加“彻底删除我的账号与数据”入口（密码 + 输入 DELETE 双重确认），不看 syncDelete、直接物理删除；测试 161 个全过；随下次部署上线。
