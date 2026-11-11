# PHASE8-F · 账号与透明（子代理 F 汇报）

> 工作目录 `~/workspace/mail-ultimate/`。只做本地构建与测试，**未部署线上、未 push GitHub**；
> 未碰老项目 mail.flame.edu.kg；未碰 `.deploy.env` 与任何密钥。
> 分工遵守情况：只碰新建的服务/API/实体/组件/视图文件与测试；`login-log-service.js` 只读；
> 未碰 `webs.js`、`mail-vue/src/i18n/*`、`mail-worker/src/i18n/*`、`init.js`、`login-service.js`、
> `views/security/index.vue` 与他人分工文件。新增路由/i18n/DDL/挂载点全部以清单形式在本文件交总协调合并。

## 1. 做了什么（对照 §12 项 5–10）

| # | 项 | 实现 | 状态 |
|---|---|---|---|
| 5 | 隐私仪表盘 / 透明度中心 | 新视图 `mail-vue/src/views/privacy/index.vue` + 后端只读聚合 `privacy-service.js` + `GET /privacy/dashboard`：数据清单（收集了什么/没收集什么/每项保留多久/能不能关+为什么必需）、开关状态（复用现有 `/my/security`）、第三方清单、账号恢复状态、新 IP 待确认提醒（含确认按钮） | ✅ 完成 |
| 6 | 账号恢复（恢复码 + 备用邮箱） | `recovery-service.js` + `recovery-api.js`：注册时生成 10 个恢复码（`XXXX-XXXX-XXXX`，只显示一次；库里只存 SHA-256 哈希，明文不存库、不记日志；重新生成作废旧码；用过作废）；凭码重设密码；备用邮箱可选填；恢复链接 token（只存哈希、1 小时有效、一次性）；恢复成功清全部会话；错误一律通用口径（不透露账号是否存在）；限流见 §6 | ✅ 完成 |
| 7 | 新设备 / 新 IP 登录提醒 | `new-ip-alert-service.js` + `new-ip-alert-api.js`：基于现有 `login_log.is_new_ip`（只读，未改登录流程）；`GET /security/new-ip-alerts`（只查本人、近 30 天、未确认的）、`POST …/acknowledge`（点“是我本人”后记入 `known_ip`，此后不再提醒；确认他人 IP 拒绝）；可选 TG 提醒复用 `telegramService.sendAlert`，文本只含脱敏 IP；接线点见 §7 | ✅ 完成 |
| 8 | 本地密码强度计 | 前后端同一算法：`mail-worker/src/utils/password-strength.js` 与 `mail-vue/src/utils/password-strength.js`（镜像，纯函数、零依赖、不联网）；组件 `mail-vue/src/components/password-strength/index.vue`；分级 0–4（very_weak/weak/fair/good/strong），长度+字符种类+常见弱密码表（约 60 个）+连续序列/重复字符扣分；弱密码（score<2 或 <8 位或在弱表里）当场拦住；恢复接口服务端同样校验 | ✅ 完成 |
| 9 | 联系人 / 通讯录 | `contact-service.js` + `contact-api.js` + `contacts` 表（唯一约束 user_id+email）：手动添加、从往来邮件一键添加（收信取发件人/发信取收件人，已存在时幂等返回 `added:false`）、列表+搜索、删除；写信收件人自动补全 `GET /contacts/suggest`（只返回 name+email，最多 10 条）；全部只查本人 | ✅ 完成 |
| 10 | 邮件规则 / 过滤器 | `mail-rule-service.js` + `mail-rule-api.js` + `mail_rules` / `email_label` / `mail_rule_log` 表：条件（发件人/主题/收件人含匹配，全部 AND）、动作（打标签、归档、标记已读、删除、转发到指定邮箱）；按 `sort` 顺序执行；只对新收信件生效（`applyRules` 只接受刚落库的新邮件行；旧信不重跑；重复执行不重复打标；删信后后续规则只记日志、不再变更）；规则管理视图 `mail-vue/src/views/rules/index.vue`（新建/编辑/启用开关/上移下移/删除） | ✅ 完成 |

## 2. 新建 / 改动文件清单

### 后端实体（8 个，`mail-worker/src/entity/`）
- `contact.js`、`mail-rule.js`、`email-label.js`、`mail-rule-log.js`
- `user-recovery-code.js`、`user-recovery-email.js`、`password-reset-token.js`、`known-ip.js`

### 后端工具（1 个）
- `mail-worker/src/utils/password-strength.js`（强度计 Worker 版）

### 后端服务（5 个，`mail-worker/src/service/`）
- `privacy-service.js`（仪表盘只读聚合）
- `recovery-service.js`（恢复码 + 备用邮箱 + 重置 token + KV 限流）
- `new-ip-alert-service.js`（待确认提醒、确认已知、TG 提醒）
- `contact-service.js`（联系人）
- `mail-rule-service.js`（规则 CRUD + 匹配 + `applyRules`）

### 后端 API（5 个，`mail-worker/src/api/`）
- `privacy-api.js`：`GET /privacy/dashboard`
- `recovery-api.js`：`POST /my/recovery-codes/generate`、`GET /my/recovery-codes/status`、`GET/POST/DELETE /my/backup-email`、`POST /recovery/reset-by-code`、`POST /recovery/request-link`、`POST /recovery/reset-by-token`
- `new-ip-alert-api.js`：`GET /security/new-ip-alerts`、`POST /security/new-ip-alerts/acknowledge`、`GET /security/known-ips`
- `contact-api.js`：`POST /contacts/add`、`POST /contacts/add-from-email`、`GET /contacts/list`、`GET /contacts/suggest`、`DELETE /contacts/delete`
- `mail-rule-api.js`：`POST /mail-rules/create`、`GET /mail-rules/list`、`POST /mail-rules/update`、`DELETE /mail-rules/delete`、`POST /mail-rules/reorder`、`GET /mail-rules/labels`

### 前端（`mail-vue/src/`）
- `utils/password-strength.js`（强度计前端镜像，与 Worker 版同一算法，改一处必须同步另一处）
- `components/password-strength/index.vue`（强度计组件）
- `request/privacy.js`、`request/recovery.js`、`request/contacts.js`、`request/rules.js`
- `views/privacy/index.vue`（隐私仪表盘）
- `views/recovery/index.vue`（忘记密码页：恢复码 / 备用邮箱链接两种方式，带强度计）
- `views/contacts/index.vue`（通讯录：列表+搜索+添加+删除）
- `views/rules/index.vue`（规则管理：新建/编辑/开关/排序/删除）

### 测试（1 个）
- `mail-worker/test/phase8f.spec.js`（28 个用例，见 §3）

### 未碰的共享文件（由总协调按 §5–§7 合并）
- `mail-worker/src/hono/webs.js`、`mail-worker/src/security/security.js`
- `mail-vue/src/i18n/*.js`、`mail-worker/src/i18n/*.js`、`mail-worker/src/init/init.js`
- `mail-worker/src/service/login-service.js`（B）、`mail-vue/src/views/security/index.vue`（B）
- `mail-vue/src/router/index.js`、`mail-vue/src/views/login/index.vue`（G）

## 3. 测试结果

- 本文件：`mail-worker` 下 `npx vitest run test/phase8f.spec.js` → **28/28 通过**。
  覆盖：恢复码只显示一次且 hash 存库（明文 SHA-256 可验、库里无明文）、凭码重置成功且码作废/旧密码失效/新密码可登、错码与不存在账号同一通用错误、重新生成作废旧码、弱新密码被拦、注册时生成（无密码变体）、恢复流程限流（同邮箱+IP 错 5 次后第 6 次 429，换 IP 可继续）、备用邮箱未设置时请求链接不建 token、设置后建 1 个未用 token（hash 存库、1 小时有效、返回值不含 token）、凭 token 重置一次性/过期失效/错 token 通用错误、备用邮箱校验、新 IP 提醒只查本人/确认后记已知/确认他人 IP 拒绝、TG 提醒只含脱敏 IP（`203.0.113.0`，不含 `203.0.113.99`）、密码强度分级（弱表/短密码 0 分、`Tr0ub4dor&3` 3 分 good、长口令 4 分 strong、前后端镜像输出一致）、联系人唯一约束（大小写归一化后也算重复）与自动补全（只查本人）、从邮件一键添加幂等、规则按顺序执行（删信后后续规则不再变更、转发目标只收集未删信的、停用不执行、reorder 生效）、只对新信生效（旧信无规则日志、重复执行不重复打标）、隐私仪表盘（登录位置与正文日志明确不收集）、HTTP 层 4 组（仪表盘/联系人/新 IP/规则，登录态 + 未登录拒绝 + 跨用户隔离）。
- 全套：`npx vitest run`（14 个文件，含 B、E 子代理的 spec）→ **267/267 通过**。
- 前端：`mail-vue` 下 `npm run build` → **构建通过**（`✓ built in 1m 33s`；唯一的 chunk > 500KB 警告是既有 analysis 包，与本次无关；新视图走路由懒加载）。
- 测试环境经验（C 的 assistant spec 已注明，本文件同样遵守）：**一个 it 内的 D1/KV 写入在下一个 it 不可见，只有 beforeAll 的状态持久**——因此本文件全部用例均为单测内自包含；跨 it 共享的只有 beforeAll 建的 alice/bob 与原始 token。本次调试中另发现一个测试 helper 写法教训：`INSERT INTO login_log (…, ua, is_new_ip)` 的绑定顺序一度写反，导致 `is_new_ip` 列被写成 UA 字符串，已修正。

## 4. 需要的 DDL 清单（并进 `init.js` 的 `v3_11DB`，幂等、可重跑）

```sql
CREATE TABLE IF NOT EXISTS contacts (
	contact_id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL,
	name TEXT NOT NULL DEFAULT '',
	email TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE (user_id, email)
);
CREATE TABLE IF NOT EXISTS mail_rules (
	rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL,
	name TEXT NOT NULL DEFAULT '',
	condition_json TEXT NOT NULL DEFAULT '{}',
	action_json TEXT NOT NULL DEFAULT '[]',
	enabled INTEGER NOT NULL DEFAULT 1,
	sort INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS email_label (
	label_id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL,
	email_id INTEGER NOT NULL,
	label TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE (user_id, email_id, label)
);
CREATE TABLE IF NOT EXISTS mail_rule_log (
	log_id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL,
	rule_id INTEGER NOT NULL,
	email_id INTEGER NOT NULL,
	actions_json TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS user_recovery_code (
	code_id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL,
	code_hash TEXT NOT NULL DEFAULT '',
	used INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	used_at TEXT
);
CREATE TABLE IF NOT EXISTS user_recovery_email (
	user_id INTEGER PRIMARY KEY,
	backup_email TEXT NOT NULL DEFAULT '',
	verified INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS password_reset_token (
	token_id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL,
	token_hash TEXT NOT NULL DEFAULT '',
	expires_at TEXT NOT NULL DEFAULT '',
	used INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	used_at TEXT
);
CREATE TABLE IF NOT EXISTS known_ip (
	known_id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL,
	ip TEXT NOT NULL DEFAULT '',
	first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE (user_id, ip)
);
CREATE INDEX IF NOT EXISTS idx_contacts_user_email ON contacts(user_id, email);
CREATE INDEX IF NOT EXISTS idx_mail_rules_user_sort ON mail_rules(user_id, sort);
CREATE INDEX IF NOT EXISTS idx_recovery_code_user ON user_recovery_code(user_id, used);
CREATE INDEX IF NOT EXISTS idx_reset_token_user ON password_reset_token(user_id, used);
```

## 5. 需要的 webs.js 注册行 + security.js 白名单

`mail-worker/src/hono/webs.js` 末尾追加（在 `security-export-api` 一行之后）：

```js
import '../api/privacy-api';
import '../api/recovery-api';
import '../api/new-ip-alert-api';
import '../api/contact-api';
import '../api/mail-rule-api';
```

`mail-worker/src/security/security.js` 的 `exclude` 数组追加一行（否则公开恢复接口会被鉴权拦住；
匹配规则是 `path === item || path.startsWith(item + '/')`，加 `'/recovery'` 即覆盖全部三个公开接口）：

```js
'/recovery',
```

## 6. i18n JSON 清单（由总协调合并进 8 语种文件）

说明：前端新 key 共 95 个（下表逐 key 给 8 语种）；后端新 key 共 26 个（只给中英，后端 i18n 只有 zh/en 资源）。
以下前端 key 复用既有 key，不用新增：`loginLogTime`、`loginLogIp`、`loginLogDevice`、
`securityLoginHistoryLocation`、`securityLoginHistoryNoLocation`、`securityLoginAlert`、
`securityRetention`、`securityRetention0/30/90/365`、`securityOn`、`securityOff`、`email`、
`password`、`cancel`、`confirm`、`copy`、`edit`、`delete`（总协调合并时请核对这 17 个确实存在，缺失的按同表补）。

```json
{
  "privacyDashboard": {"zh": "隐私仪表盘", "en": "Privacy Dashboard", "ja": "プライバシーダッシュボード", "ko": "개인정보 대시보드", "vi": "Bảng điều khiển riêng tư", "ru": "Панель конфиденциальности", "es": "Panel de privacidad", "fr": "Tableau de bord de confidentialité"},
  "privacyDashboardDesc": {"zh": "本站收集了什么、没收集什么、每项保留多久，一目了然。", "en": "See at a glance what we collect, what we never collect, and how long each item is kept.", "ja": "収集するもの、収集しないもの、保存期間を一目で確認できます。", "ko": "수집하는 항목, 수집하지 않는 항목, 보관 기간을 한눈에 확인하세요.", "vi": "Xem chúng tôi thu thập gì, không thu thập gì và lưu giữ mỗi mục trong bao lâu.", "ru": "Что мы собираем, чего не собираем и как долго храним — наглядно.", "es": "Ve qué recopilamos, qué nunca recopilamos y cuánto conservamos cada dato.", "fr": "Voyez ce que nous collectons, ce que nous ne collectons jamais et la durée de conservation."},
  "privacyDataInventory": {"zh": "数据清单", "en": "Data inventory", "ja": "データ一覧", "ko": "데이터 목록", "vi": "Danh mục dữ liệu", "ru": "Перечень данных", "es": "Inventario de datos", "fr": "Inventaire des données"},
  "privacyItem": {"zh": "数据项", "en": "Item", "ja": "項目", "ko": "항목", "vi": "Mục", "ru": "Элемент", "es": "Elemento", "fr": "Élément"},
  "privacyCollected": {"zh": "是否收集", "en": "Collected", "ja": "収集", "ko": "수집 여부", "vi": "Có thu thập", "ru": "Собирается", "es": "Recopilado", "fr": "Collecté"},
  "privacyYes": {"zh": "是", "en": "Yes", "ja": "はい", "ko": "예", "vi": "Có", "ru": "Да", "es": "Sí", "fr": "Oui"},
  "privacyNo": {"zh": "否", "en": "No", "ja": "いいえ", "ko": "아니요", "vi": "Không", "ru": "Нет", "es": "No", "fr": "Non"},
  "privacyRetention": {"zh": "保留多久", "en": "Retention", "ja": "保存期間", "ko": "보관 기간", "vi": "Thời gian lưu giữ", "ru": "Срок хранения", "es": "Retención", "fr": "Conservation"},
  "privacyNever": {"zh": "从不收集", "en": "Never collected", "ja": "収集しません", "ko": "수집하지 않음", "vi": "Không bao giờ thu thập", "ru": "Не собирается", "es": "Nunca se recopila", "fr": "Jamais collecté"},
  "privacyForever": {"zh": "永久保留", "en": "Kept forever", "ja": "無期限", "ko": "무기한 보관", "vi": "Lưu giữ vĩnh viễn", "ru": "Хранится бессрочно", "es": "Conservado indefinidamente", "fr": "Conservé indéfiniment"},
  "privacyCanDisable": {"zh": "能否关闭", "en": "Can be disabled", "ja": "無効化できるか", "ko": "비활성화 가능", "vi": "Có thể tắt không", "ru": "Можно ли отключить", "es": "Se puede desactivar", "fr": "Peut être désactivé"},
  "privacyCanDisableYes": {"zh": "可以关闭", "en": "Can be disabled", "ja": "無効化できます", "ko": "비활성화할 수 있음", "vi": "Có thể tắt", "ru": "Можно отключить", "es": "Se puede desactivar", "fr": "Peut être désactivé"},
  "privacyCanDisableNo": {"zh": "不可关闭", "en": "Cannot be disabled", "ja": "無効化できません", "ko": "비활성화할 수 없음", "vi": "Không thể tắt", "ru": "Нельзя отключить", "es": "No se puede desactivar", "fr": "Ne peut pas être désactivé"},
  "privacyControls": {"zh": "可控开关", "en": "Controls", "ja": "設定", "ko": "제어", "vi": "Tùy chọn điều khiển", "ru": "Настройки", "es": "Controles", "fr": "Contrôles"},
  "privacyE2ee": {"zh": "端到端加密", "en": "End-to-end encryption", "ja": "エンドツーエンド暗号化", "ko": "종단간 암호화", "vi": "Mã hóa đầu cuối", "ru": "Сквозное шифрование", "es": "Cifrado de extremo a extremo", "fr": "Chiffrement de bout en bout"},
  "privacyIpMask": {"zh": "日志 IP 脱敏", "en": "Log IP masking", "ja": "ログの IP マスキング", "ko": "로그 IP 마스킹", "vi": "Ẩn IP trong nhật ký", "ru": "Маскирование IP в журналах", "es": "Enmascaramiento de IP en registros", "fr": "Masquage des IP dans les journaux"},
  "privacyAi": {"zh": "AI 助手", "en": "AI assistant", "ja": "AI アシスタント", "ko": "AI 어시스턴트", "vi": "Trợ lý AI", "ru": "ИИ-ассистент", "es": "Asistente de IA", "fr": "Assistant IA"},
  "privacyThirdParties": {"zh": "第三方清单", "en": "Third parties", "ja": "第三者一覧", "ko": "타사 목록", "vi": "Danh sách bên thứ ba", "ru": "Третьи стороны", "es": "Terceros", "fr": "Tiers"},
  "privacyThirdParty": {"zh": "第三方", "en": "Third party", "ja": "第三者", "ko": "타사", "vi": "Bên thứ ba", "ru": "Третья сторона", "es": "Tercero", "fr": "Tiers"},
  "privacyPurpose": {"zh": "用途", "en": "Purpose", "ja": "用途", "ko": "용도", "vi": "Mục đích", "ru": "Назначение", "es": "Finalidad", "fr": "Finalité"},
  "privacyRequired": {"zh": "必需", "en": "Required", "ja": "必須", "ko": "필수", "vi": "Bắt buộc", "ru": "Обязательно", "es": "Obligatorio", "fr": "Obligatoire"},
  "privacyConfigured": {"zh": "已配置", "en": "Configured", "ja": "設定済み", "ko": "구성됨", "vi": "Đã cấu hình", "ru": "Настроено", "es": "Configurado", "fr": "Configuré"},
  "privacyAccountRecovery": {"zh": "账号恢复", "en": "Account recovery", "ja": "アカウント復旧", "ko": "계정 복구", "vi": "Khôi phục tài khoản", "ru": "Восстановление аккаунта", "es": "Recuperación de cuenta", "fr": "Récupération de compte"},
  "privacyNotSet": {"zh": "未设置", "en": "Not set", "ja": "未設定", "ko": "설정되지 않음", "vi": "Chưa đặt", "ru": "Не задано", "es": "No configurado", "fr": "Non défini"},
  "privacyItemLoginLog": {"zh": "登录日志", "en": "Login log", "ja": "ログイン履歴", "ko": "로그인 기록", "vi": "Nhật ký đăng nhập", "ru": "Журнал входов", "es": "Registro de inicios de sesión", "fr": "Journal de connexion"},
  "privacyItemLoginIpMasked": {"zh": "登录 IP（已脱敏）", "en": "Login IP (masked)", "ja": "ログイン IP（マスク済み）", "ko": "로그인 IP(마스킹됨)", "vi": "IP đăng nhập (đã ẩn)", "ru": "IP входа (замаскирован)", "es": "IP de inicio de sesión (enmascarada)", "fr": "IP de connexion (masquée)"},
  "privacyItemLoginUaTruncated": {"zh": "设备信息 UA（截断 500 字符）", "en": "Device info / UA (truncated to 500 chars)", "ja": "デバイス情報 UA（500文字に切詰）", "ko": "기기 정보 UA(500자로 자름)", "vi": "Thông tin thiết bị / UA (cắt ở 500 ký tự)", "ru": "Данные устройства / UA (обрезано до 500 символов)", "es": "Info del dispositivo / UA (truncado a 500 caracteres)", "fr": "Infos de l'appareil / UA (tronqué à 500 caractères)"},
  "privacyItemLoginLocation": {"zh": "登录地理位置", "en": "Login location", "ja": "ログイン位置", "ko": "로그인 위치", "vi": "Vị trí đăng nhập", "ru": "Место входа", "es": "Ubicación de inicio de sesión", "fr": "Lieu de connexion"},
  "privacyItemEmailContentLog": {"zh": "邮件正文日志", "en": "Email content logging", "ja": "メール本文の記録", "ko": "메일 본문 기록", "vi": "Ghi nhật ký nội dung thư", "ru": "Журналирование текста писем", "es": "Registro del contenido de correos", "fr": "Journalisation du contenu des e-mails"},
  "privacyItemEmailContentStorage": {"zh": "邮件正文存储", "en": "Email content storage", "ja": "メール本文の保存", "ko": "메일 본문 저장", "vi": "Lưu trữ nội dung thư", "ru": "Хранение текста писем", "es": "Almacenamiento del contenido de correos", "fr": "Stockage du contenu des e-mails"},
  "privacyItemE2ee": {"zh": "端到端加密状态", "en": "End-to-end encryption status", "ja": "エンドツーエンド暗号化の状態", "ko": "종단간 암호화 상태", "vi": "Trạng thái mã hóa đầu cuối", "ru": "Статус сквозного шифрования", "es": "Estado del cifrado de extremo a extremo", "fr": "État du chiffrement de bout en bout"},
  "privacyItemAuditLog": {"zh": "审计日志", "en": "Audit log", "ja": "監査ログ", "ko": "감사 로그", "vi": "Nhật ký kiểm tra", "ru": "Журнал аудита", "es": "Registro de auditoría", "fr": "Journal d'audit"},
  "privacyItemAiChatHistory": {"zh": "AI 对话历史", "en": "AI chat history", "ja": "AI チャット履歴", "ko": "AI 채팅 기록", "vi": "Lịch sử trò chuyện AI", "ru": "История чата с ИИ", "es": "Historial de chat de IA", "fr": "Historique des discussions IA"},
  "privacyItemE2eeEncrypted": {"zh": "已加密", "en": "Encrypted", "ja": "暗号化済み", "ko": "암호화됨", "vi": "Đã mã hóa", "ru": "Зашифровано", "es": "Cifrado", "fr": "Chiffré"},
  "privacyWhySecurityLoginHistory": {"zh": "登录历史是账号安全的必要记录", "en": "Login history is required for account security", "ja": "ログイン履歴はアカウントの安全に必要です", "ko": "로그인 기록은 계정 보안에 필요합니다", "vi": "Lịch sử đăng nhập cần thiết cho bảo mật tài khoản", "ru": "История входов нужна для безопасности аккаунта", "es": "El historial de inicio de sesión es necesario para la seguridad", "fr": "L'historique de connexion est requis pour la sécurité du compte"},
  "privacyWhySecurityNewIpDetection": {"zh": "新 IP 检测需要记录登录 IP", "en": "New-IP detection needs the login IP", "ja": "新規 IP 検出にはログイン IP が必要です", "ko": "새 IP 감지에는 로그인 IP가 필요합니다", "vi": "Phát hiện IP mới cần IP đăng nhập", "ru": "Для обнаружения новых IP нужен IP входа", "es": "La detección de IP nuevas necesita la IP de inicio de sesión", "fr": "La détection de nouvelle IP nécessite l'IP de connexion"},
  "privacyWhySecurityDeviceIdentification": {"zh": "识别登录设备需要 UA 信息", "en": "Device identification needs UA info", "ja": "デバイス識別には UA 情報が必要です", "ko": "기기 식별에는 UA 정보가 필요합니다", "vi": "Nhận diện thiết bị cần thông tin UA", "ru": "Для определения устройства нужны данные UA", "es": "La identificación del dispositivo necesita la UA", "fr": "L'identification de l'appareil nécessite l'UA"},
  "privacyWhyServiceCore": {"zh": "邮箱服务本身需要存储邮件", "en": "The mail service itself needs to store mail", "ja": "メールサービス自体に保存が必要です", "ko": "메일 서비스 자체에 메일 저장이 필요합니다", "vi": "Dịch vụ thư cần lưu trữ thư", "ru": "Почтовому сервису нужно хранить письма", "es": "El servicio de correo necesita almacenar los mensajes", "fr": "Le service de messagerie doit stocker les e-mails"},
  "privacyWhySecurityAuditTrail": {"zh": "审计留痕是账号安全的必要记录", "en": "Audit trail is required for account security", "ja": "監査証跡はアカウントの安全に必要です", "ko": "감사 기록은 계정 보안에 필요합니다", "vi": "Dấu vết kiểm tra cần thiết cho bảo mật", "ru": "Журнал аудита нужен для безопасности", "es": "El rastro de auditoría es necesario para la seguridad", "fr": "La piste d'audit est requise pour la sécurité"},
  "privacyThirdCloudflare": {"zh": "Cloudflare（平台底座）", "en": "Cloudflare (platform)", "ja": "Cloudflare（基盤）", "ko": "Cloudflare(플랫폼)", "vi": "Cloudflare (nền tảng)", "ru": "Cloudflare (платформа)", "es": "Cloudflare (plataforma)", "fr": "Cloudflare (plateforme)"},
  "privacyThirdTurnstile": {"zh": "Cloudflare Turnstile（人机验证）", "en": "Cloudflare Turnstile (bot check)", "ja": "Cloudflare Turnstile（ボット対策）", "ko": "Cloudflare Turnstile(봇 검사)", "vi": "Cloudflare Turnstile (chống bot)", "ru": "Cloudflare Turnstile (проверка на бота)", "es": "Cloudflare Turnstile (verificación antibots)", "fr": "Cloudflare Turnstile (vérification anti-bot)"},
  "privacyThirdCfEmailSending": {"zh": "Cloudflare Email Sending（主发信通道）", "en": "Cloudflare Email Sending (primary outbound)", "ja": "Cloudflare Email Sending（主送信）", "ko": "Cloudflare Email Sending(주 발신)", "vi": "Cloudflare Email Sending (kênh gửi chính)", "ru": "Cloudflare Email Sending (основной канал)", "es": "Cloudflare Email Sending (canal principal)", "fr": "Cloudflare Email Sending (canal principal)"},
  "privacyThirdResend": {"zh": "Resend（备用发信通道）", "en": "Resend (fallback outbound)", "ja": "Resend（予備送信）", "ko": "Resend(예비 발신)", "vi": "Resend (kênh gửi dự phòng)", "ru": "Resend (резервный канал)", "es": "Resend (canal de respaldo)", "fr": "Resend (canal de secours)"},
  "privacyThirdTelegram": {"zh": "Telegram Bot API（告警与推送，可选）", "en": "Telegram Bot API (alerts, optional)", "ja": "Telegram Bot API（通知・任意）", "ko": "Telegram Bot API(알림, 선택)", "vi": "Telegram Bot API (cảnh báo, tùy chọn)", "ru": "Telegram Bot API (оповещения, необязательно)", "es": "API de bots de Telegram (alertas, opcional)", "fr": "API Bot Telegram (alertes, facultatif)"},
  "privacyThirdWorkersAi": {"zh": "Workers AI（开源模型，可选）", "en": "Workers AI (open weights, optional)", "ja": "Workers AI（オープンウェイト・任意）", "ko": "Workers AI(오픈 가중치, 선택)", "vi": "Workers AI (mô hình mở, tùy chọn)", "ru": "Workers AI (открытые веса, необязательно)", "es": "Workers AI (modelos abiertos, opcional)", "fr": "Workers AI (poids ouverts, facultatif)"},
  "privacyPurposePlatform": {"zh": "整站运行底座", "en": "Runs the whole service", "ja": "サービス基盤", "ko": "서비스 기반", "vi": "Vận hành toàn bộ dịch vụ", "ru": "Запуск всего сервиса", "es": "Ejecuta todo el servicio", "fr": "Fait fonctionner tout le service"},
  "privacyPurposeBotCheck": {"zh": "注册/登录人机验证", "en": "Bot check for sign-up / sign-in", "ja": "登録・ログインのボット対策", "ko": "가입/로그인 봇 검사", "vi": "Chống bot khi đăng ký / đăng nhập", "ru": "Проверка на бота при регистрации и входе", "es": "Verificación antibots en registro e inicio de sesión", "fr": "Vérification anti-bot à l'inscription et à la connexion"},
  "privacyPurposeOutboundMailPrimary": {"zh": "站外邮件主通道", "en": "Primary channel for external mail", "ja": "外部メールの主送信", "ko": "외부 메일 주 발신 채널", "vi": "Kênh gửi chính cho thư ngoài", "ru": "Основной канал внешней почты", "es": "Canal principal para correo externo", "fr": "Canal principal pour les e-mails externes"},
  "privacyPurposeOutboundMailFallback": {"zh": "站外邮件备用通道", "en": "Fallback channel for external mail", "ja": "外部メールの予備送信", "ko": "외부 메일 예비 발신 채널", "vi": "Kênh gửi dự phòng cho thư ngoài", "ru": "Резервный канал внешней почты", "es": "Canal de respaldo para correo externo", "fr": "Canal de secours pour les e-mails externes"},
  "privacyPurposeAlertsOptional": {"zh": "风控告警与新邮件推送（可选）", "en": "Risk alerts and new-mail push (optional)", "ja": "リスク通知と新着プッシュ（任意）", "ko": "위험 알림 및 새 메일 푸시(선택)", "vi": "Cảnh báo rủi ro và đẩy thư mới (tùy chọn)", "ru": "Оповещения о рисках и push новых писем (необязательно)", "es": "Alertas de riesgo y avisos de correo nuevo (opcional)", "fr": "Alertes de risque et notifications de nouveaux e-mails (facultatif)"},
  "privacyPurposeAssistantOptional": {"zh": "AI 写信/回信/摘要（可选）", "en": "AI compose / reply / summary (optional)", "ja": "AI 作成・返信・要約（任意）", "ko": "AI 작성/답장/요약(선택)", "vi": "AI soạn / trả lời / tóm tắt (tùy chọn)", "ru": "ИИ: написание, ответы, резюме (необязательно)", "es": "IA para redactar, responder y resumir (opcional)", "fr": "IA pour rédiger, répondre et résumer (facultatif)"},
  "newIpAlertTitle": {"zh": "发现新设备 / 新 IP 登录", "en": "New device / new IP sign-in detected", "ja": "新しいデバイス / 新しい IP でのログインを検出", "ko": "새 기기 / 새 IP 로그인 감지", "vi": "Phát hiện đăng nhập từ thiết bị / IP mới", "ru": "Обнаружен вход с нового устройства / IP", "es": "Inicio de sesión desde un dispositivo o IP nuevos", "fr": "Connexion depuis un nouvel appareil / une nouvelle IP détectée"},
  "newIpAlertDesc": {"zh": "以下登录来自你从未用过的 IP。如果你本人操作过，请点“是我本人”；如果不是你，请立即改密码并检查会话。", "en": "These sign-ins came from IPs you have never used. If it was you, tap “This was me”. If not, change your password and check your sessions right away.", "ja": "次のログインは未使用の IP からです。本人であれば「自分です」を、そうでなければ直ちにパスワードを変更し、セッションを確認してください。", "ko": "다음 로그인은 사용한 적 없는 IP에서 왔습니다. 본인이면 “본인입니다”를, 아니면 즉시 비밀번호를 변경하고 세션을 확인하세요.", "vi": "Các lần đăng nhập này đến từ IP bạn chưa từng dùng. Nếu là bạn, hãy bấm “Là tôi”. Nếu không, hãy đổi mật khẩu và kiểm tra phiên ngay.", "ru": "Эти входы были с IP, которыми вы раньше не пользовались. Если это были вы, нажмите «Это был я». Если нет — срочно смените пароль и проверьте сессии.", "es": "Estos inicios de sesión llegaron desde IP que nunca usaste. Si fuiste tú, toca «Fui yo». Si no, cambia tu contraseña y revisa tus sesiones ahora mismo.", "fr": "Ces connexions proviennent d'IP que vous n'avez jamais utilisées. Si c'était vous, touchez « C'était moi ». Sinon, changez votre mot de passe et vérifiez vos sessions immédiatement."},
  "newIpAlertPending": {"zh": "待确认的新 IP 登录", "en": "Unconfirmed new-IP sign-ins", "ja": "未確認の新規 IP ログイン", "ko": "확인되지 않은 새 IP 로그인", "vi": "Đăng nhập IP mới chưa xác nhận", "ru": "Неподтверждённые входы с новых IP", "es": "Inicios de sesión con IP nueva sin confirmar", "fr": "Connexions IP nouvelles non confirmées"},
  "newIpAlertEmpty": {"zh": "暂无待确认的新 IP 登录", "en": "No unconfirmed new-IP sign-ins", "ja": "未確認の新規 IP ログインはありません", "ko": "확인되지 않은 새 IP 로그인이 없습니다", "vi": "Không có đăng nhập IP mới chưa xác nhận", "ru": "Нет неподтверждённых входов с новых IP", "es": "No hay inicios de sesión con IP nueva sin confirmar", "fr": "Aucune connexion IP nouvelle non confirmée"},
  "newIpAlertAcknowledge": {"zh": "是我本人", "en": "This was me", "ja": "自分です", "ko": "본인입니다", "vi": "Là tôi", "ru": "Это был я", "es": "Fui yo", "fr": "C'était moi"},
  "recoveryCodesRemaining": {"zh": "剩余可用恢复码", "en": "Recovery codes left", "ja": "残りの復旧コード", "ko": "남은 복구 코드", "vi": "Mã khôi phục còn lại", "ru": "Осталось кодов восстановления", "es": "Códigos de recuperación restantes", "fr": "Codes de récupération restants"},
  "recoveryBackupEmail": {"zh": "备用邮箱", "en": "Backup email", "ja": "予備メールアドレス", "ko": "예비 이메일", "vi": "Email dự phòng", "ru": "Резервная почта", "es": "Correo de respaldo", "fr": "E-mail de secours"},
  "recoveryGenerateCodes": {"zh": "生成恢复码", "en": "Generate recovery codes", "ja": "復旧コードを生成", "ko": "복구 코드 생성", "vi": "Tạo mã khôi phục", "ru": "Создать коды восстановления", "es": "Generar códigos de recuperación", "fr": "Générer des codes de récupération"},
  "recoveryBackupEmailSet": {"zh": "设置备用邮箱", "en": "Set backup email", "ja": "予備メールアドレスを設定", "ko": "예비 이메일 설정", "vi": "Đặt email dự phòng", "ru": "Задать резервную почту", "es": "Configurar correo de respaldo", "fr": "Définir l'e-mail de secours"},
  "recoveryGenerateHint": {"zh": "生成新的恢复码会作废之前未使用的恢复码。请先输入当前密码。", "en": "Generating new codes invalidates unused old ones. Enter your current password first.", "ja": "新しいコードを生成すると未使用の旧コードは無効になります。現在のパスワードを入力してください。", "ko": "새 코드를 생성하면 사용하지 않은 이전 코드는 무효화됩니다. 현재 비밀번호를 먼저 입력하세요.", "vi": "Tạo mã mới sẽ vô hiệu hóa các mã cũ chưa dùng. Hãy nhập mật khẩu hiện tại trước.", "ru": "Новые коды аннулируют неиспользованные старые. Сначала введите текущий пароль.", "es": "Generar códigos nuevos invalida los antiguos sin usar. Escribe primero tu contraseña actual.", "fr": "Générer de nouveaux codes invalide les anciens inutilisés. Entrez d'abord votre mot de passe actuel."},
  "recoveryShowOnce": {"zh": "恢复码只显示这一次！请立即保存到安全的地方，关闭后无法再次查看。", "en": "Recovery codes are shown only once! Save them somewhere safe now — they cannot be viewed again after closing.", "ja": "復旧コードは今回のみ表示されます！安全な場所に今すぐ保存してください。閉じた後は再表示できません。", "ko": "복구 코드는 이번 한 번만 표시됩니다! 안전한 곳에 지금 저장하세요. 닫으면 다시 볼 수 없습니다.", "vi": "Mã khôi phục chỉ hiển thị một lần! Hãy lưu ngay vào nơi an toàn — sau khi đóng sẽ không xem lại được.", "ru": "Коды показываются только один раз! Сохраните их сейчас в надёжном месте — после закрытия их нельзя будет увидеть снова.", "es": "¡Los códigos solo se muestran una vez! Guárdalos ahora en un lugar seguro: no podrás verlos de nuevo al cerrar.", "fr": "Les codes ne s'affichent qu'une seule fois ! Enregistrez-les maintenant en lieu sûr : impossible de les revoir après fermeture."},
  "recoveryBackupEmailPlaceholder": {"zh": "用于接收恢复链接的邮箱", "en": "Email to receive the reset link", "ja": "再設定リンク受信用メールアドレス", "ko": "재설정 링크를 받을 이메일", "vi": "Email nhận liên kết đặt lại", "ru": "Почта для ссылки сброса", "es": "Correo para recibir el enlace de restablecimiento", "fr": "E-mail pour recevoir le lien de réinitialisation"},
  "recoveryBackupEmailHint": {"zh": "备用邮箱不能与本账号邮箱相同。忘记密码时，恢复链接会发到这个邮箱（1 小时有效、一次性）。", "en": "The backup email must differ from this account's email. If you forget your password, the reset link goes here (valid 1 hour, one-time use).", "ja": "予備メールアドレスはこのアカウントと異なる必要があります。パスワードを忘れた場合、再設定リンクがここに届きます（1時間有効・1回限り）。", "ko": "예비 이메일은 이 계정 이메일과 달라야 합니다. 비밀번호를 잊은 경우 재설정 링크가 이곳으로 발송됩니다(1시간 유효, 1회용).", "vi": "Email dự phòng phải khác email của tài khoản này. Khi quên mật khẩu, liên kết đặt lại sẽ gửi đến đây (hiệu lực 1 giờ, dùng một lần).", "ru": "Резервная почта должна отличаться от почты аккаунта. Если забудете пароль, ссылка сброса придёт сюда (действует 1 час, одноразовая).", "es": "El correo de respaldo debe ser distinto al de esta cuenta. Si olvidas tu contraseña, el enlace llegará aquí (válido 1 hora, de un solo uso).", "fr": "L'e-mail de secours doit différer de celui de ce compte. En cas d'oubli du mot de passe, le lien arrivera ici (valide 1 heure, à usage unique)."},
  "recoveryTitle": {"zh": "找回账号", "en": "Recover your account", "ja": "アカウントを復旧", "ko": "계정 복구", "vi": "Khôi phục tài khoản", "ru": "Восстановление аккаунта", "es": "Recupera tu cuenta", "fr": "Récupérer votre compte"},
  "recoveryDesc": {"zh": "用恢复码或备用邮箱重设密码。恢复码在注册时生成、只显示一次；备用邮箱可在登录后于隐私仪表盘里设置。", "en": "Reset your password with a recovery code or your backup email. Codes are generated at sign-up and shown only once; the backup email can be set in the Privacy Dashboard after signing in.", "ja": "復旧コードまたは予備メールアドレスでパスワードを再設定できます。コードは登録時に生成され一度のみ表示されます。予備メールアドレスはログイン後にプライバシーダッシュボードで設定できます。", "ko": "복구 코드 또는 예비 이메일로 비밀번호를 재설정하세요. 코드는 가입 시 생성되며 한 번만 표시됩니다. 예비 이메일은 로그인 후 개인정보 대시보드에서 설정할 수 있습니다.", "vi": "Đặt lại mật khẩu bằng mã khôi phục hoặc email dự phòng. Mã được tạo khi đăng ký và chỉ hiển thị một lần; email dự phòng có thể đặt trong Bảng điều khiển riêng tư sau khi đăng nhập.", "ru": "Сбросьте пароль кодом восстановления или резервной почтой. Коды создаются при регистрации и показываются один раз; резервную почту можно задать на панели конфиденциальности после входа.", "es": "Restablece tu contraseña con un código de recuperación o tu correo de respaldo. Los códigos se generan al registrarte y solo se muestran una vez; el correo de respaldo se configura en el panel de privacidad tras iniciar sesión.", "fr": "Réinitialisez votre mot de passe avec un code de récupération ou votre e-mail de secours. Les codes sont générés à l'inscription et affichés une seule fois ; l'e-mail de secours se définit dans le tableau de bord de confidentialité après connexion."},
  "recoveryByCode": {"zh": "用恢复码", "en": "Use a recovery code", "ja": "復旧コードを使う", "ko": "복구 코드 사용", "vi": "Dùng mã khôi phục", "ru": "Код восстановления", "es": "Usar un código de recuperación", "fr": "Utiliser un code de récupération"},
  "recoveryByEmail": {"zh": "用备用邮箱", "en": "Use backup email", "ja": "予備メールアドレスを使う", "ko": "예비 이메일 사용", "vi": "Dùng email dự phòng", "ru": "Резервная почта", "es": "Usar correo de respaldo", "fr": "Utiliser l'e-mail de secours"},
  "recoveryCode": {"zh": "恢复码", "en": "Recovery code", "ja": "復旧コード", "ko": "복구 코드", "vi": "Mã khôi phục", "ru": "Код восстановления", "es": "Código de recuperación", "fr": "Code de récupération"},
  "newPassword": {"zh": "新密码", "en": "New password", "ja": "新しいパスワード", "ko": "새 비밀번호", "vi": "Mật khẩu mới", "ru": "Новый пароль", "es": "Contraseña nueva", "fr": "Nouveau mot de passe"},
  "confirmPassword": {"zh": "确认新密码", "en": "Confirm new password", "ja": "新しいパスワード（確認）", "ko": "새 비밀번호 확인", "vi": "Xác nhận mật khẩu mới", "ru": "Подтвердите новый пароль", "es": "Confirmar contraseña nueva", "fr": "Confirmer le nouveau mot de passe"},
  "recoveryResetPassword": {"zh": "重设密码", "en": "Reset password", "ja": "パスワードを再設定", "ko": "비밀번호 재설정", "vi": "Đặt lại mật khẩu", "ru": "Сбросить пароль", "es": "Restablecer contraseña", "fr": "Réinitialiser le mot de passe"},
  "recoverySendLink": {"zh": "发送恢复链接", "en": "Send reset link", "ja": "再設定リンクを送信", "ko": "재설정 링크 보내기", "vi": "Gửi liên kết đặt lại", "ru": "Отправить ссылку сброса", "es": "Enviar enlace de restablecimiento", "fr": "Envoyer le lien de réinitialisation"},
  "recoveryLinkSent": {"zh": "如果该账号设置了备用邮箱，恢复链接已经发出（1 小时内有效）。请检查备用邮箱（含垃圾邮件文件夹）。", "en": "If a backup email is set for this account, the reset link has been sent (valid for 1 hour). Check the backup inbox, including spam.", "ja": "予備メールアドレスが設定されていれば、再設定リンクを送信しました（1時間有効）。予備メールボックス（迷惑メール含む）を確認してください。", "ko": "이 계정에 예비 이메일이 설정되어 있으면 재설정 링크가 발송되었습니다(1시간 유효). 예비 받은편지함(스팸 포함)을 확인하세요.", "vi": "Nếu tài khoản đã đặt email dự phòng, liên kết đặt lại đã được gửi (hiệu lực 1 giờ). Hãy kiểm tra hộp thư dự phòng, kể cả thư rác.", "ru": "Если для аккаунта задана резервная почта, ссылка сброса отправлена (действует 1 час). Проверьте резервный ящик, включая спам.", "es": "Si esta cuenta tiene un correo de respaldo, el enlace ya se envió (válido 1 hora). Revisa esa bandeja, incluido el spam.", "fr": "Si un e-mail de secours est défini pour ce compte, le lien a été envoyé (valide 1 heure). Vérifiez cette boîte de réception, y compris les spams."},
  "recoveryHaveLink": {"zh": "已收到链接", "en": "Already have a link", "ja": "リンクを受け取った方", "ko": "링크를 이미 받음", "vi": "Đã nhận được liên kết", "ru": "Ссылка уже получена", "es": "Ya tengo un enlace", "fr": "J'ai déjà un lien"},
  "recoveryToken": {"zh": "链接中的 token", "en": "Token from the link", "ja": "リンクのトークン", "ko": "링크의 토큰", "vi": "Token trong liên kết", "ru": "Токен из ссылки", "es": "Token del enlace", "fr": "Jeton du lien"},
  "recoveryBackToLogin": {"zh": "返回登录", "en": "Back to sign-in", "ja": "ログインに戻る", "ko": "로그인으로 돌아가기", "vi": "Quay lại đăng nhập", "ru": "Назад ко входу", "es": "Volver a iniciar sesión", "fr": "Retour à la connexion"},
  "contactsTitle": {"zh": "联系人", "en": "Contacts", "ja": "連絡先", "ko": "연락처", "vi": "Danh bạ", "ru": "Контакты", "es": "Contactos", "fr": "Contacts"},
  "contactsSearch": {"zh": "搜索姓名或邮箱", "en": "Search name or email", "ja": "名前またはメールで検索", "ko": "이름 또는 이메일 검색", "vi": "Tìm tên hoặc email", "ru": "Поиск по имени или почте", "es": "Buscar por nombre o correo", "fr": "Rechercher un nom ou un e-mail"},
  "contactsAdd": {"zh": "添加联系人", "en": "Add contact", "ja": "連絡先を追加", "ko": "연락처 추가", "vi": "Thêm liên hệ", "ru": "Добавить контакт", "es": "Añadir contacto", "fr": "Ajouter un contact"},
  "contactsEmpty": {"zh": "暂无联系人", "en": "No contacts yet", "ja": "連絡先がありません", "ko": "연락처가 없습니다", "vi": "Chưa có liên hệ", "ru": "Контактов пока нет", "es": "Aún no hay contactos", "fr": "Aucun contact pour l'instant"},
  "contactsName": {"zh": "姓名", "en": "Name", "ja": "名前", "ko": "이름", "vi": "Tên", "ru": "Имя", "es": "Nombre", "fr": "Nom"},
  "contactsCreated": {"zh": "添加时间", "en": "Added on", "ja": "追加日時", "ko": "추가일", "vi": "Ngày thêm", "ru": "Добавлен", "es": "Añadido el", "fr": "Ajouté le"},
  "contactsDeleteConfirm": {"zh": "确定删除该联系人吗？", "en": "Delete this contact?", "ja": "この連絡先を削除しますか？", "ko": "이 연락처를 삭제하시겠습니까?", "vi": "Xóa liên hệ này?", "ru": "Удалить этот контакт?", "es": "¿Eliminar este contacto?", "fr": "Supprimer ce contact ?"},
  "mailRulesTitle": {"zh": "邮件规则", "en": "Mail rules", "ja": "メールルール", "ko": "메일 규칙", "vi": "Quy tắc thư", "ru": "Правила почты", "es": "Reglas de correo", "fr": "Règles de messagerie"},
  "mailRulesDesc": {"zh": "规则按顺序执行，只对新收到的邮件生效。", "en": "Rules run in order and apply only to newly received mail.", "ja": "ルールは順番に実行され、新着メールにのみ適用されます。", "ko": "규칙은 순서대로 실행되며 새로 받은 메일에만 적용됩니다.", "vi": "Quy tắc chạy theo thứ tự và chỉ áp dụng cho thư mới nhận.", "ru": "Правила выполняются по порядку и применяются только к новым письмам.", "es": "Las reglas se ejecutan en orden y solo se aplican al correo recién recibido.", "fr": "Les règles s'exécutent dans l'ordre et s'appliquent uniquement aux nouveaux e-mails."},
  "mailRulesAdd": {"zh": "新建规则", "en": "New rule", "ja": "ルールを新規作成", "ko": "새 규칙", "vi": "Quy tắc mới", "ru": "Новое правило", "es": "Nueva regla", "fr": "Nouvelle règle"},
  "mailRulesEmpty": {"zh": "暂无规则", "en": "No rules yet", "ja": "ルールがありません", "ko": "규칙이 없습니다", "vi": "Chưa có quy tắc", "ru": "Правил пока нет", "es": "Aún no hay reglas", "fr": "Aucune règle pour l'instant"},
  "mailRulesName": {"zh": "规则名称", "en": "Rule name", "ja": "ルール名", "ko": "규칙 이름", "vi": "Tên quy tắc", "ru": "Название правила", "es": "Nombre de la regla", "fr": "Nom de la règle"},
  "mailRulesCondition": {"zh": "条件", "en": "Conditions", "ja": "条件", "ko": "조건", "vi": "Điều kiện", "ru": "Условия", "es": "Condiciones", "fr": "Conditions"},
  "mailRulesActions": {"zh": "动作", "en": "Actions", "ja": "アクション", "ko": "동작", "vi": "Hành động", "ru": "Действия", "es": "Acciones", "fr": "Actions"},
  "mailRulesEnabled": {"zh": "启用", "en": "Enabled", "ja": "有効", "ko": "사용", "vi": "Bật", "ru": "Включено", "es": "Activada", "fr": "Activée"},
  "mailRulesConditionSender": {"zh": "发件人包含", "en": "Sender contains", "ja": "送信者が含む", "ko": "발신자 포함", "vi": "Người gửi chứa", "ru": "Отправитель содержит", "es": "El remitente contiene", "fr": "L'expéditeur contient"},
  "mailRulesConditionSubject": {"zh": "主题包含", "en": "Subject contains", "ja": "件名が含む", "ko": "제목 포함", "vi": "Tiêu đề chứa", "ru": "Тема содержит", "es": "El asunto contiene", "fr": "L'objet contient"},
  "mailRulesConditionRecipient": {"zh": "收件人包含", "en": "Recipient contains", "ja": "宛先が含む", "ko": "받는 사람 포함", "vi": "Người nhận chứa", "ru": "Получатель содержит", "es": "El destinatario contiene", "fr": "Le destinataire contient"},
  "mailRulesContainsHint": {"zh": "包含以下文字（不区分大小写）", "en": "Contains this text (case-insensitive)", "ja": "次の文字を含む（大文字小文字を区別しない）", "ko": "다음 텍스트 포함(대소문자 구분 없음)", "vi": "Chứa văn bản này (không phân biệt hoa thường)", "ru": "Содержит этот текст (без учёта регистра)", "es": "Contiene este texto (sin distinguir mayúsculas)", "fr": "Contient ce texte (insensible à la casse)"},
  "mailRuleActionTag": {"zh": "打标签", "en": "Add label", "ja": "ラベルを付ける", "ko": "라벨 추가", "vi": "Gắn nhãn", "ru": "Добавить ярлык", "es": "Añadir etiqueta", "fr": "Ajouter un libellé"},
  "mailRuleActionArchive": {"zh": "归档", "en": "Archive", "ja": "アーカイブ", "ko": "보관", "vi": "Lưu trữ", "ru": "В архив", "es": "Archivar", "fr": "Archiver"},
  "mailRuleActionMarkRead": {"zh": "标记已读", "en": "Mark as read", "ja": "既読にする", "ko": "읽음으로 표시", "vi": "Đánh dấu đã đọc", "ru": "Отметить прочитанным", "es": "Marcar como leído", "fr": "Marquer comme lu"},
  "mailRuleActionDelete": {"zh": "删除", "en": "Delete", "ja": "削除", "ko": "삭제", "vi": "Xóa", "ru": "Удалить", "es": "Eliminar", "fr": "Supprimer"},
  "mailRuleActionForward": {"zh": "转发", "en": "Forward", "ja": "転送", "ko": "전달", "vi": "Chuyển tiếp", "ru": "Переслать", "es": "Reenviar", "fr": "Transférer"},
  "mailRuleActionTagLabel": {"zh": "标签名", "en": "Label name", "ja": "ラベル名", "ko": "라벨 이름", "vi": "Tên nhãn", "ru": "Название ярлыка", "es": "Nombre de la etiqueta", "fr": "Nom du libellé"},
  "mailRuleActionForwardTo": {"zh": "转发到邮箱", "en": "Forward to email", "ja": "転送先メールアドレス", "ko": "전달할 이메일", "vi": "Chuyển tiếp đến email", "ru": "Переслать на почту", "es": "Reenviar a correo", "fr": "Transférer à l'e-mail"},
  "mailRulesEdit": {"zh": "编辑规则", "en": "Edit rule", "ja": "ルールを編集", "ko": "규칙 편집", "vi": "Sửa quy tắc", "ru": "Изменить правило", "es": "Editar regla", "fr": "Modifier la règle"},
  "mailRulesDeleteConfirm": {"zh": "确定删除这条规则吗？", "en": "Delete this rule?", "ja": "このルールを削除しますか？", "ko": "이 규칙을 삭제하시겠습니까?", "vi": "Xóa quy tắc này?", "ru": "Удалить это правило?", "es": "¿Eliminar esta regla?", "fr": "Supprimer cette règle ?"},
  "pwdStrengthVeryWeak": {"zh": "非常弱", "en": "Very weak", "ja": "非常に弱い", "ko": "매우 약함", "vi": "Rất yếu", "ru": "Очень слабый", "es": "Muy débil", "fr": "Très faible"},
  "pwdStrengthWeak": {"zh": "弱", "en": "Weak", "ja": "弱い", "ko": "약함", "vi": "Yếu", "ru": "Слабый", "es": "Débil", "fr": "Faible"},
  "pwdStrengthFair": {"zh": "一般", "en": "Fair", "ja": "普通", "ko": "보통", "vi": "Trung bình", "ru": "Средний", "es": "Aceptable", "fr": "Moyenne"},
  "pwdStrengthGood": {"zh": "良好", "en": "Good", "ja": "良好", "ko": "좋음", "vi": "Tốt", "ru": "Хороший", "es": "Buena", "fr": "Bonne"},
  "pwdStrengthStrong": {"zh": "强", "en": "Strong", "ja": "強い", "ko": "강함", "vi": "Mạnh", "ru": "Надёжный", "es": "Fuerte", "fr": "Forte"},
  "pwdStrengthReasonTooShort": {"zh": "密码至少 8 位", "en": "At least 8 characters", "ja": "8文字以上にしてください", "ko": "8자 이상이어야 합니다", "vi": "Ít nhất 8 ký tự", "ru": "Минимум 8 символов", "es": "Al menos 8 caracteres", "fr": "Au moins 8 caractères"},
  "pwdStrengthReasonCommonPassword": {"zh": "这是常见弱密码，换一个", "en": "This is a commonly used weak password — pick another", "ja": "よく使われる弱いパスワードです。別のものにしてください", "ko": "흔히 쓰이는 약한 비밀번호입니다. 다른 것으로 바꾸세요", "vi": "Đây là mật khẩu yếu phổ biến — hãy chọn mật khẩu khác", "ru": "Это распространённый слабый пароль — выберите другой", "es": "Es una contraseña débil muy común; elige otra", "fr": "C'est un mot de passe faible très courant — choisissez-en un autre"},
  "pwdStrengthReasonNeedLonger": {"zh": "更长会更安全（12 位以上更好）", "en": "Longer is safer (12+ characters is better)", "ja": "長いほど安全です（12文字以上がおすすめ）", "ko": "길수록 안전합니다(12자 이상 권장)", "vi": "Dài hơn sẽ an toàn hơn (từ 12 ký tự trở lên tốt hơn)", "ru": "Чем длиннее, тем надёжнее (лучше от 12 символов)", "es": "Más largo es más seguro (mejor con 12+ caracteres)", "fr": "Plus long, plus sûr (12 caractères ou plus, c'est mieux)"},
  "pwdStrengthReasonNeedMoreTypes": {"zh": "混用大小写字母、数字和符号", "en": "Mix upper/lowercase letters, digits and symbols", "ja": "大文字・小文字・数字・記号を混ぜてください", "ko": "대소문자, 숫자, 기호를 섞어 사용하세요", "vi": "Kết hợp chữ hoa/thường, số và ký tự đặc biệt", "ru": "Смешивайте прописные и строчные буквы, цифры и символы", "es": "Mezcla mayúsculas, minúsculas, números y símbolos", "fr": "Mélangez majuscules, minuscules, chiffres et symboles"},
  "pwdStrengthReasonOnlyOneType": {"zh": "只用了一种字符，太好猜", "en": "Only one character type — too easy to guess", "ja": "1種類の文字だけでは推測されやすいです", "ko": "한 종류의 문자만 사용하면 추측하기 쉽습니다", "vi": "Chỉ dùng một loại ký tự — quá dễ đoán", "ru": "Только один тип символов — слишком легко подобрать", "es": "Solo un tipo de carácter: demasiado fácil de adivinar", "fr": "Un seul type de caractères : trop facile à deviner"},
  "pwdStrengthReasonPredictablePattern": {"zh": "含有连续序列或重复字符", "en": "Contains a sequence or repeated characters", "ja": "連続した並びや繰り返し文字を含みます", "ko": "연속된 순서나 반복 문자가 포함되어 있습니다", "vi": "Chứa dãy liên tiếp hoặc ký tự lặp lại", "ru": "Содержит последовательность или повторяющиеся символы", "es": "Contiene una secuencia o caracteres repetidos", "fr": "Contient une séquence ou des caractères répétés"}
}
```

### 后端错误码（只给中英；`mail-worker/src/i18n/zh.js` 与 `en.js`）

```json
{
  "recoveryUserNotFound": {"zh": "账号不存在", "en": "Account not found"},
  "recoveryWrongPassword": {"zh": "当前密码不正确", "en": "Current password is incorrect"},
  "recoveryInvalid": {"zh": "恢复码或链接无效，请检查后重试", "en": "Invalid recovery code or link. Please check and try again."},
  "recoveryTooManyAttempts": {"zh": "尝试次数过多，请 15 分钟后再试", "en": "Too many attempts. Please try again in 15 minutes."},
  "recoveryWeakPassword": {"zh": "新密码强度不足", "en": "New password is too weak"},
  "recoveryBackupEmailInvalid": {"zh": "备用邮箱格式不正确", "en": "Backup email format is invalid"},
  "recoveryBackupEmailSameAsAccount": {"zh": "备用邮箱不能与本账号邮箱相同", "en": "Backup email must differ from this account's email"},
  "recoveryResetSubject": {"zh": "重设你的邮箱密码", "en": "Reset your mailbox password"},
  "recoveryResetText": {"zh": "你申请了重设邮箱密码，请点击下面的链接完成重设：", "en": "You requested a password reset. Click the link below to complete it:"},
  "recoveryResetExpiry": {"zh": "该链接 1 小时内有效，只能使用一次。如果你没有申请过，请忽略这封邮件。", "en": "This link is valid for 1 hour and can be used once. If you did not request it, please ignore this email."},
  "contactEmailInvalid": {"zh": "邮箱格式不正确", "en": "Email format is invalid"},
  "contactExists": {"zh": "该联系人已存在", "en": "This contact already exists"},
  "contactEmailNotFound": {"zh": "找不到这封邮件", "en": "Email not found"},
  "mailRuleConditionInvalid": {"zh": "规则条件无效：至少需要一个发件人/主题/收件人包含条件", "en": "Invalid rule condition: at least one sender/subject/recipient contains condition is required"},
  "mailRuleActionInvalid": {"zh": "规则动作无效", "en": "Invalid rule action"},
  "mailRuleNameRequired": {"zh": "请填写规则名称", "en": "Please enter a rule name"},
  "mailRuleNotFound": {"zh": "规则不存在", "en": "Rule not found"},
  "newIpAlertIpRequired": {"zh": "请提供 IP", "en": "IP is required"},
  "newIpAlertNotYours": {"zh": "该 IP 不在你的登录记录里", "en": "This IP is not in your login history"},
  "newIpAlertTgTitle": {"zh": "新设备登录提醒", "en": "New device sign-in alert"},
  "newIpAlertTgAccount": {"zh": "账号", "en": "Account"},
  "newIpAlertTgIp": {"zh": "IP（已脱敏）", "en": "IP (masked)"},
  "newIpAlertTgDevice": {"zh": "设备", "en": "Device"}
}
```

## 7. 挂载点 / 接线清单（总协调或对应子代理加，每条一行）

| # | 位置（文件） | 加什么 | 备注 |
|---|---|---|---|
| 1 | `mail-vue/src/router/index.js`（layout children） | `{ path: '/privacy', name: 'privacy', component: () => import('@/views/privacy/index.vue'), meta: { title: 'privacyDashboard', name: 'privacy', menu: true } }`、`{ path: '/contacts', name: 'contacts', … meta: { title: 'contactsTitle', name: 'contacts', menu: true } }`、`{ path: '/mail-rules', name: 'mail-rules', component: () => import('@/views/rules/index.vue'), meta: { title: 'mailRulesTitle', name: 'mail-rules', menu: true } }` | 侧栏菜单入口 |
| 2 | `mail-vue/src/router/index.js`（顶层，与 `/login` 并列） | `{ path: '/recovery', name: 'recovery', component: () => import('@/views/recovery/index.vue') }` | 公开页，不走 layout |
| 3 | `mail-vue/src/views/security/index.vue`（B 的文件） | “我的数据”区旁加按钮跳 `/privacy`（隐私仪表盘入口） | 总协调加，B 的文件我没碰 |
| 4 | `mail-vue/src/views/login/index.vue`（G 的文件） | “忘记密码”链接跳 `/recovery` | G 的文件，我没碰 |
| 5 | `mail-worker/src/service/login-service.js` 的 `register()` 成功后（B 的文件） | `await recoveryService.generateCodesForRegistration(c, userId)`，把返回的 `codes` 随注册响应一次返回给用户展示 | 无密码变体已实现（`recovery-service.js`），仅限服务端调用，不挂 HTTP 路由 |
| 6 | `mail-worker/src/service/login-service.js` 登录成功、`isNewIp=1` 时（B 的文件） | `await newIpAlertService.notifyNewIpLogin(c, userId, { email, ip, ua })`（best-effort，永不抛错；用户关了登录提醒开关时不发 TG） | 不改登录流程，只加一行调用 |
| 7 | `mail-worker/src/service/email-service.js` 的 `HandleOnSiteEmail` 落库后（E 的文件） | `const ruleResult = await mailRuleService.applyRules(c, accountRow.userId, emailRow)`；`ruleResult.forwardTo` 里的地址用现有转发通道投递 | 只对新收信件调一次；旧信不重跑 |
| 8 | 写信页收件人输入框 | 调 `request/contacts.js` 的 `suggestContacts(q)` 做自动补全 | 组件待总协调定 |
| 9 | 读信页（内容页） | “加为联系人”按钮调 `request/contacts.js` 的 `addContactFromEmail(emailId)` | 已存在时返回 `added:false`，不报错 |

## 8. 已知问题与待确认（未假装已解决）

1. **恢复接口限流是临时实现**：B 的 `kernel/ratelimit.js` 尚未交付，本文件恢复接口的限流用最简单的 KV 固定窗口计数（`recovery-service.js` 的 `checkRateLimit`：恢复码/ token 5 次/15 分钟/邮箱+IP，恢复链接 3 次/1 小时/邮箱+IP）。待 B 交付后由总协调统一替换为 ratelimit 原语，接口语义（key/上限/窗口秒）已按设计文档对齐。
2. **恢复链接的投递身份待确认**：`requestResetLink` 建 token 后，投递走用户首个发信账号调 `emailService.send`（best-effort，失败只记日志、token 仍有效，恢复码可作后备）。若用户无发信账号、或发信被角色限额/E2EE 门拦住，链接发不出去——需总协调确认是否改用专用系统发信身份。目前行为：token 照常生成、响应一律 `{ requested: true }`（不透露账号是否存在）。
3. **TG 提醒走的是管理员告警通道**：`notifyNewIpLogin` 复用 `telegramService.sendAlert`（发往管理员绑定的 TG），文本只含脱敏 IP + 账号 + 设备。用户级“发到用户自己 TG”需要用户绑定 chat_id，不在本阶段做。
4. **归档以标签实现**：本站暂无独立归档文件夹/标签表，规则 `archive` 动作以 `email_label` 的 `archive` 标签落地；列表页按标签筛即为归档视图。后续文件夹重写时再迁移。
5. **规则 `forward` 动作不直接发信**：`applyRules` 只收集 `forwardTo` 并记 `mail_rule_log`，实际投递由接线方（§7 第 7 条）用现有转发通道执行。
6. **备用邮箱未做验证**：`user_recovery_email.verified` 列已预留，验证邮件待总协调确认系统发信身份后接（同第 2 条）。
7. **密码强度计前后端双份**：`mail-worker/src/utils/password-strength.js` 与 `mail-vue/src/utils/password-strength.js` 是同一算法的镜像（前端不能直接 import Worker 代码），改一处必须同步另一处；测试已断言两者对同一批密码输出一致。
8. **隐私仪表盘开关复用现有接口**：仪表盘本身只读；登录提醒/E2EE/保留期限三个开关调既有 `request/security.js` 的 `setSecurity`（`/my/security`），未新增写接口。
9. **前端 i18n key 尚未合并**：本文件 95 个前端 key + 26 个后端 key 均未写进语言文件（共享文件不碰），合并前界面会显示 key 名；后端 `t()` 未命中时同样回落 key 名。测试不受影响（断言用的是 code 与数据结构）。
10. **公开恢复接口需白名单**：`POST /recovery/*` 在总协调把 `'/recovery'` 加进 `security.js` 的 `exclude` 之前，走 HTTP 会返回 401；本文件因此只测了其 service 层，HTTP 冒烟待白名单加上后由总协调补。
