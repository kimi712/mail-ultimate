# PHASE8 子代理 C 汇报：AI 助手与翻译

> 只做本地构建与测试，未部署线上、未 push GitHub；未碰老项目 mail.flame.edu.kg；
> 未碰 `.deploy.env` 与任何密钥；未改共享文件（webs.js / i18n / init.js / ai-service.js）。

## 1. 做了什么

- **助手服务**（新建 `mail-worker/src/service/assistant-service.js`）：多轮对话
  （历史存 `ai_chat`，默认只保留 30 天，用户一键清空；对话内容不用于训练、不出本站）、
  归类建议（模型只输出 JSON `{labels, folder, reason}`，标签/文件夹白名单过滤，
  非 JSON 时兜底展示不报错）。写信/回信/摘要不重复实现，助手 UI 直接调现有端点。
- **翻译服务**（新建 `mail-worker/src/service/translation-service.js`）：读信翻译
  （`emailId` 或 E2EE 解锁后传明文 `text`）与写信多语言（写信页起草后按目标语言翻译草稿）。
  长文按 ≤3000 字分段、最多 4 段、超 12000 字截断并返回 `truncated: true`；
  翻译结果可缓存（`translate_cache`，键只含内容 SHA-256 hash 与语种对，不含用户身份；
  缓存命中不调模型、不计配额；表未建时降级为不缓存）。
- **新 API**（新建 `mail-worker/src/api/assistant-api.js`）：`POST /ai/chat`、
  `POST /ai/triage`、`POST /ai/translate`、`POST /ai/chat/clear`，另加
  `GET /ai/chat/history`（面板打开时加载历史；任务清单外的补充端点，见 §6）。
- **新实体**（新建 `mail-worker/src/entity/ai-chat.js`）：`ai_chat` 表。
- **模型/限额/开关**：全部复用 `ai-service.js` 的主备降级
  （主 `@cf/meta/llama-3.1-8b-instruct`，备 `@cf/meta/llama-3-8b-instruct`，
  双不可用 `ai_unavailable`）、同一 KV 限额（每用户每天 50 次，只在成功返回后计数；
  对话每次模型调用计 1 次；一次 `/ai/translate` 无论分几段只计 1 次；缓存命中不计）、
  同一开关（`ai_enabled=0` 时全部新接口 `ai_disabled`）；只读本人未删邮件，
  跨用户/不存在一律 `ai_not_found`，不区分。提示词按 `user.locale` 生成，覆盖 8 语种，
  沿用 `ai-service.js` 的 `PROMPTS` 结构（chat/triage/translate 各一套）。
- **前端**：
  - 新建 `mail-vue/src/components/ai-assistant/index.vue`：助手面板（多轮对话、剩余次数、清空历史、隐私说明）。
  - `mail-vue/src/layout/header/index.vue`：顶栏常驻助手入口（`aiEnabled` 为 0 时隐藏），挂载助手面板。
  - `mail-vue/src/views/content/index.vue`（读信页）：翻译按钮 + 原文/译文对照面板
    （目标语言下拉，切换即重翻；截断明示）与归类建议按钮 + 建议面板
    （标签/建议文件夹/理由）；E2EE 未解锁时翻译禁用（与摘要一致），已解锁传解密明文。
  - `mail-vue/src/layout/write/index.vue`（写信页）：AI 对话框加目标语言下拉；
    与用户语言不同时，起草后自动调 `/ai/translate` 翻译正文再预览（翻译失败保留原草稿）。
  - `mail-vue/src/request/ai.js`：新增 `aiChat / aiChatHistory / aiClearChat / aiTriage / aiTranslate`，
    错误码映射复用既有 `aiErrorI18nKey`（无新增后端错误码）。
- **测试**（新建 `mail-worker/test/phase8-assistant.spec.js`）：19 个用例，全部通过（见 §2）。

## 2. 测试结果

- `mail-worker/test/phase8-assistant.spec.js`：**19/19 通过**（mock AI，不调真实服务）。
  覆盖：chat 首轮/第二轮带历史/history 旧→新/clear 只清本人、chat 带 emailId 上下文、
  跨用户邮件 `ai_not_found`、空/超长输入 `ai_invalid_input`、主备降级与 `ai_unavailable`
  （失败不计配额、不留历史）、triage JSON 解析/白名单过滤/非 JSON 兜底、translate
  读信与写信多语言/短码归一化/缓存命中（不调模型、不计配额）/长文截断（分段 ≤4、
  仍只计 1 次）/`ai_disabled` / `ai_quota_exceeded` / 中英文提示词切换。
- `mail-vue` 构建：**通过**（`npm run build`，28.44s；仅有既有的 chunk 体积警告）。
- mail-worker 全套 vitest：**242/255 通过，13 失败**（14 个文件，12 过 2 失败）。
  失败的 13 个全部在其他子代理进行中的文件，与本任务无关：
  `test/phase8e-mail-trust.spec.js`（2 个）、`test/phase8f.spec.js`（11 个，
  恢复码/新 IP 提醒/联系人/邮件规则/隐私仪表盘及 HTTP 层）。
  本任务的 `test/phase8-assistant.spec.js` 在全套运行中通过；且本次改动未碰任何
  共享后端文件（新服务/API/实体均未被 `webs.js` 引用），不可能影响既有测试。

## 3. i18n JSON 清单（请总协调合并进 `mail-vue/src/i18n/*.js` 的 `ai` 对象）

```json
{
  "ai.assistantTitle": {
    "zh": "AI 助手", "en": "AI Assistant", "ja": "AI アシスタント", "ko": "AI 어시스턴트",
    "vi": "Trợ lý AI", "ru": "AI-ассистент", "es": "Asistente de IA", "fr": "Assistant IA"
  },
  "ai.assistantPrivacy": {
    "zh": "对话只保存在本站，不用于训练",
    "en": "Chats stay on this site and are never used for training",
    "ja": "会話は本サイト内にのみ保存され、学習には使用されません",
    "ko": "대화는 이 사이트에만 저장되며 학습에 사용되지 않습니다",
    "vi": "Đoạn chat chỉ lưu trên trang này, không dùng để huấn luyện",
    "ru": "Чаты хранятся только на этом сайте и не используются для обучения",
    "es": "Los chats se guardan solo en este sitio y nunca se usan para entrenar",
    "fr": "Les discussions restent sur ce site et ne servent jamais à l’entraînement"
  },
  "ai.assistantClear": {
    "zh": "清空历史", "en": "Clear history", "ja": "履歴を消去", "ko": "기록 지우기",
    "vi": "Xóa lịch sử", "ru": "Очистить историю", "es": "Borrar historial", "fr": "Effacer l’historique"
  },
  "ai.assistantEmpty": {
    "zh": "你好，我是你的邮箱助手。可以问我邮件相关的问题，也可以让我帮你归类、翻译。",
    "en": "Hi, I'm your mailbox assistant. Ask me about your emails, or let me help you triage and translate.",
    "ja": "こんにちは、メールボックスアシスタントです。メールのことなら何でも聞いてください。分類や翻訳もお手伝いします。",
    "ko": "안녕하세요, 메일함 어시스턴트입니다. 이메일에 대해 물어보거나 분류와 번역을 도와드릴 수 있습니다.",
    "vi": "Xin chào, tôi là trợ lý hộp thư của bạn. Hãy hỏi về email, hoặc để tôi giúp phân loại và dịch.",
    "ru": "Привет, я ваш почтовый ассистент. Спрашивайте о письмах — помогу с сортировкой и переводом.",
    "es": "Hola, soy tu asistente de buzón. Pregúntame sobre tus correos o déjame ayudarte a clasificarlos y traducirlos.",
    "fr": "Bonjour, je suis votre assistant de boîte mail. Posez-moi des questions sur vos e-mails, ou laissez-moi vous aider à les trier et à les traduire."
  },
  "ai.assistantYou": {
    "zh": "我", "en": "You", "ja": "あなた", "ko": "나",
    "vi": "Bạn", "ru": "Вы", "es": "Tú", "fr": "Vous"
  },
  "ai.assistantPlaceholder": {
    "zh": "输入你的问题…", "en": "Type your question…", "ja": "質問を入力…", "ko": "질문을 입력하세요…",
    "vi": "Nhập câu hỏi của bạn…", "ru": "Введите вопрос…", "es": "Escribe tu pregunta…", "fr": "Tapez votre question…"
  },
  "ai.assistantSend": {
    "zh": "发送", "en": "Send", "ja": "送信", "ko": "보내기",
    "vi": "Gửi", "ru": "Отправить", "es": "Enviar", "fr": "Envoyer"
  },
  "ai.translate": {
    "zh": "AI 翻译", "en": "Translate with AI", "ja": "AI 翻訳", "ko": "AI 번역",
    "vi": "Dịch bằng AI", "ru": "Перевести с AI", "es": "Traducir con IA", "fr": "Traduire avec l’IA"
  },
  "ai.translation": {
    "zh": "译文", "en": "Translation", "ja": "訳文", "ko": "번역문",
    "vi": "Bản dịch", "ru": "Перевод", "es": "Traducción", "fr": "Traduction"
  },
  "ai.translateTruncated": {
    "zh": "原文过长，仅翻译了前 12000 字，超出部分已截断。",
    "en": "The original text is too long; only the first 12,000 characters were translated and the rest was truncated.",
    "ja": "原文が長すぎるため、先頭の 12000 文字のみ翻訳し、残りは省略しました。",
    "ko": "원문이 너무 길어 앞 12000자만 번역하고 나머지는 잘랐습니다.",
    "vi": "Văn bản gốc quá dài; chỉ 12.000 ký tự đầu được dịch, phần còn lại đã bị cắt.",
    "ru": "Исходный текст слишком длинный: переведены только первые 12 000 символов, остальное усечено.",
    "es": "El texto original es demasiado largo; solo se tradujeron los primeros 12.000 caracteres y el resto se truncó.",
    "fr": "Le texte d’origine est trop long ; seuls les 12 000 premiers caractères ont été traduits, le reste a été tronqué."
  },
  "ai.triage": {
    "zh": "AI 归类", "en": "Triage with AI", "ja": "AI 分類", "ko": "AI 분류",
    "vi": "Phân loại bằng AI", "ru": "Сортировать с AI", "es": "Clasificar con IA", "fr": "Trier avec l’IA"
  },
  "ai.triageResult": {
    "zh": "归类建议", "en": "Triage suggestion", "ja": "分類の提案", "ko": "분류 제안",
    "vi": "Gợi ý phân loại", "ru": "Предложение сортировки", "es": "Sugerencia de clasificación", "fr": "Suggestion de tri"
  },
  "ai.triageFolder": {
    "zh": "建议文件夹", "en": "Suggested folder", "ja": "推奨フォルダ", "ko": "추천 폴더",
    "vi": "Thư mục gợi ý", "ru": "Предлагаемая папка", "es": "Carpeta sugerida", "fr": "Dossier suggéré"
  },
  "ai.triageNoLabel": {
    "zh": "暂无标签建议", "en": "No label suggestion", "ja": "ラベルの提案なし", "ko": "레이블 제안 없음",
    "vi": "Chưa có gợi ý nhãn", "ru": "Нет предложений меток", "es": "Sin sugerencia de etiqueta", "fr": "Aucune étiquette suggérée"
  },
  "ai.targetLang": {
    "zh": "目标语言", "en": "Target language", "ja": "目標言語", "ko": "대상 언어",
    "vi": "Ngôn ngữ đích", "ru": "Язык перевода", "es": "Idioma de destino", "fr": "Langue cible"
  }
}
```

后端错误码：无新增（复用 `ai_disabled / ai_quota_exceeded / ai_unavailable / ai_invalid_input / ai_not_found`，
前端 `ai.*` key 已在 PHASE7 建好）。

## 4. 需要的 DDL 清单（请总协调并进 `init.js` 的 v3_11DB 迁移，逐条独立 try/catch + 幂等）

```sql
CREATE TABLE IF NOT EXISTS ai_chat (
  chat_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ai_chat_user_time ON ai_chat(user_id, created_at);

CREATE TABLE IF NOT EXISTS translate_cache (
  source_hash TEXT PRIMARY KEY,
  source_lang TEXT NOT NULL DEFAULT '',
  target_lang TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_translate_cache_time ON translate_cache(created_at);
```

说明：`translate_cache.source_hash` 为 `SHA-256(source_lang + '|' + target_lang + '|' + 原文)`，
不含用户身份；`ai_chat` 保留 30 天由 `assistant-service._pruneExpired` 随对话调用清理，
建议日志清理任务顺手兜底（`DELETE FROM ai_chat WHERE created_at < datetime('now','-30 days')`）。

## 5. 需要的 webs.js 注册行（请总协调加进 `mail-worker/src/hono/webs.js`）

```js
import '../api/assistant-api'
```

（放在 `import '../api/ai-api'` 之后即可；路由：`POST /ai/chat`、`GET /ai/chat/history`、
`POST /ai/chat/clear`、`POST /ai/triage`、`POST /ai/translate`。）

## 6. 已知问题 / 待验证

1. **真实模型输出格式上线后才可验证**：triage 要求模型只输出 JSON，但 Llama-3.1-8b-instruct
   实际输出是否稳定为合法 JSON（尤其非英文 locale 下标签是否落在白名单内）只能上线后看；
   已做防护——解析失败兜底展示原文、非法标签/文件夹过滤为安全默认值，不会因此报错。
   chat/translate 的提示词格式与 PHASE7 的 compose/reply/summarize 同构（已验证可用），
   但长文分段翻译的段间衔接质量、超长邮件截断点的断句效果也需上线后实测。
2. **HTTP 层新端点未做 SELF 测试**：`assistant-api.js` 未注册进 `webs.js`（按分工由总协调加），
   本阶段测试为 service 级（mock AI）；注册后请总协调补跑 HTTP 冒烟：
   未登录 401、开关关闭 `ai_disabled`、超限 `ai_quota_exceeded`、跨用户 `ai_not_found`。
3. **新增 i18n key 尚未合并**：前端已引用 §3 的 15 个新 key，合并前对应位置会回退显示 key 名；
   请总协调按 §3 清单合并进 8 个语言文件。
4. **测试环境发现（与生产代码无关，已规避）**：本仓库 vitest 环境下，一个 `it` 内的 D1 写入
   在下一个 `it` 不可见（只有 `beforeAll` 的状态持久；phase7 用例同样全是单测内自包含）。
   本文件多轮序列测试已按此规则合并进同一个 `it`；调试中还确认 `drizzle .all()` 在 D1
   侧不可用，`_loadHistory` 已改成直接 await 查询构造器。生产代码本身在隔离复现中验证正确。
5. **翻译缓存无过期清理**：`translate_cache` 只增不减（命中省模型调用）；建议后续阶段加
   定期清理（如 90 天）或容量上限，本阶段未做（不阻塞上线）。
6. **写信页翻译只翻正文**：目标语言与用户语言不同时，翻译的是 AI 草稿正文，标题保持原样
   （标题常含人名/品牌，机器翻译易失真；用户可在编辑器里自行改标题）。
7. `GET /ai/chat/history` 为任务清单外的补充端点（面板打开需加载历史），已实现并写进 §5 注册范围；
   如总协调认为应收进清单，请确认。
