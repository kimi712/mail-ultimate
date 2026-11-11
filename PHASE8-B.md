# Phase 8 子代理 B 汇报：隐私 5 项（TOTP 二维码 / 安全评分加深 / 用户侧审计视图 / 登录限流 / 会话最后活跃时间）

- 日期：2026-11-08
- 范围：本地构建与测试，**未部署、未 push**；未碰老项目 mail.flame.edu.kg；未碰 `.deploy.env` 与任何密钥。
- 工作目录：`~/workspace/mail-ultimate/`

## 1. 做了什么

### ① TOTP 二维码（零新增依赖）
- 新建 `mail-worker/src/utils/qrcode.js`：手写 QR 编码器（ISO/IEC 18004 公开规范，字节模式、纠错等级 M、版本 1–10 自动取最小、8 种掩码按罚分规则择优），vendored，文件头注明来源与许可证，零依赖。导出 `encodeQr(text)` → `{version, size, mask, modules}`（modules 为 `'0'`/`'1'` 字符串行，不含静区，渲染端加 4 模块静区）。
- `totp-service.js:setup()` 返回 `{secret, otpauthUrl, qr}`；编码失败（URL 超长，v10-M 上限 213 字节）时 `qr = null`，设置流程继续，前端回退到手动输入。
- 密钥只在设置当时返回一次；设置成功后前端 `setupData` 已清空（既有行为），`GET /my/security` 不含 secret（已测）。
- 换绑需先验旧码：已有 `enabled===1` 的行时，`setup()` 要求 `oldCode` 经 `verifyLoginCode` 验证通过，否则 `BizError(t('totpOldCodeRequired'), 400)`；前端已换绑时显示旧码输入框 +「重新绑定」按钮。
- 审计：`totp:setup`（`detail: {rebind, qr: 0|1}`）、`totp:enable`、`totp:disable` 走 `kernel/audit`，不含任何密钥值。
- 验证：编码器与 npm `qrcode@1.5.4` + `jsqr@1.4.0` 交叉验证（仅 `/tmp/qrcheck` 临时校验，未进项目依赖）；jsQR 可解全部 7 个用例（HELLO WORLD v1、139 字符 otpauth URL v8、177 字符 otpauth URL v9、网址 v2、中文+ASCII v3、100×'x' v6、200×'x' v10）；长度扫描 1–213 字节 22 个用例全解，214 字节正确抛错。修复过的 5 个真实 bug 见 §8。

### ② 安全评分加深（服务端算分，前端展示分项 + 建议）
- 新增 `GET /security/score`（`user-security-service.js:getScore()`），9 项分项，总分 100，旧公式（TOTP 30 + Passkey 30 + 登录提醒 20 + 30 天无新 IP 20）已作废。规则表见 §4。
- 前端安全中心改为渲染服务端分项（`分项名 + 得分/满分`）与改进建议列表；接口失败时回退到旧的本地 4 项计算。
- 密码强度：仅在密码登录成功时（唯一能拿到明文的时刻）评估，存 KV `pwd_strength:<userId>` = `{score, at}`（0–5 级，TTL 90 天，永不存密码）；密码年龄读 `user.pwd_changed_at`（新 DDL 列，迁移前 SQL 报错时回落到 `user.create_time`）；强度/年龄「未知」时取中性 5 分而非 0 分。
- 登录历史异常：查 `login_log` 最近 30 天全部记录（`is_new_ip=1` 计数，不再只看最近 20 条）。

### ③ 用户侧审计视图（新建 API 模块，不改现有 api 文件）
- 新建 `mail-worker/src/api/security-audit-api.js`：`GET /security/audit-log?num&size&type` 与 `GET /security/score`。
- 审计视图只查本人：`audit-log-service.js:listByUser()` 强制 `actor_user_id = userId`；`type` 经白名单映射为 `action LIKE 'prefix:%'`（login/security/totp/passkey/export/delete/session/setting/user，未知类型 = 不筛选，永不拼任意 LIKE）；保留期限读 `setting.logRetentionDays`（>0 则 `create_time >= datetime('now', '-N days')`，读不到配置则不过滤）；分页 size 上限 50。
- 展示：读时脱敏 IP（`log_ip_mask` 规则，与登录历史一致）、UA 截断 120 字符展示、`detail` JSON 解析后返回（构造上只含元数据）。
- 前端：安全中心登录历史下方新增审计记录区（类型下拉筛选 + 刷新 + 时间/操作/IP/设备表 + 上一页/下一页，每页 20 条）。

### ④ 登录限流（Layer 1 通用原语 + 登录双维度）
- 新建 `mail-worker/src/kernel/ratelimit.js`：`shaHex`（全局 WebCrypto `crypto.subtle`，无 `node:crypto` 导入）、`dimensionKey`（SHA-256 前 16 hex，KV key 永不含原始 IP/邮箱）、`backoffSeconds(base, level, cap=24h)` = base × 3^(level−1)、`consume`（固定窗口，满了不计数，返回 `{allowed, count, retryAfterSec}`）、`peek`、`clearWindow`、`getLock`、`setLock`（不传 level 则自动 +1）、`clearLock`。KV 前缀 `rl:win:` / `rl:lock:`（文件内定义，未动 `kv-const.js`）。全部 fail-open（KV 异常 → 放行，仅记日志）。
- `login-service.js`：15 分钟窗口、IP 与账号各 5 次失败；先查锁（密码与 OAuth 登录都查），锁定中抛 `BizError(t('loginRateLimited'), 429)` 通用错误，不透露账号是否存在；密码路径全部失败（未知用户、已删除、已封禁、密码错）都记一次失败（未知账号同样计数，避免用「锁没锁」反推账号是否存在）；失败记满窗口时建锁（IP 维度优先判定）并改抛通用限流错误；OAuth（`noVerifyPwd`）只查锁不计失败。
- 锁定时长：首锁 5 分钟，指数退避 ×3，上限 24 小时。
- 锁定时记 `audit_log`（`login:rate_limited`，`detail: {dimension, lockMinutes, level}`，targetId 为账号哈希前 12 字符）与 `alert_log`（阈值告警，复用现有 `alertLogService.record`，KV 标志 `rl:alert:login:<dimKey>` TTL 3600 节流，文本仅含脱敏 IP，不含邮箱）。
- 密码登录成功：写密码强度桶（见②）；`_issueSession()` 成功后只清账号维度失败窗口（IP 窗口不清，一次成功登录不能洗掉同 IP 下其他账号的失败）。
- 阈值可配：读 `setting`（camelCase/snake_case 双 fallback，缺失用默认）；新增字段见 §6 DDL 清单。

### ⑤ 会话最后活跃时间（重写 session-service.js）
- `SESSION_META` 条目改为 `{ua, ip, createdAt, lastActiveAt}`；`recordSession` 初始化 `lastActiveAt = createdAt`；新增 `touchSession()`（每会话 60 秒节流、best-effort、永不抛错、无条目时跳过）。
- `listSessions` 返回 `{digest, ua, device, browser, ip（按 log_ip_mask 脱敏）, createdAt, lastActiveAt（老条目回落 createdAt）, current}`；device/browser 由存储的 ua `"browser / os / device"` 拆分。
- 踢出：`revokeSession` / `revokeAllExceptCurrent` 行为不变（一键踢出指定会话已存在）；超期会话按现有 TTL 清理（未改）。
- 刷新钩子：`security.js` 中间件在 `c.set('user', ...)` 后 best-effort 调 `touchSession`（见 §7 最小共享文件触碰）。

### ⑥ Layer 1 最小化日志统一入口
- 新建 `mail-worker/src/kernel/audit.js`：`kernelAudit.audit(c, {actorUserId, action, targetType, targetId, detail})`，只记元数据 actor/action/target/脱敏 IP/截断 UA（500），永不记正文与密钥值。detail 按 key 名清洗：匹配 `/pass(word)?|secret|token|passwd|pwd|salt|hash|credential|private|auth|otp|totp/i` 或 key 恰为 `code`/`key`/`apikey`/`api_key` 或以 `Code` 结尾的丢弃（注册密钥 `code` 值因此不再入日志，符合「永不记密钥值」）；`keys`（设置 key 名列表）与 `regKeyIds` 保留为合法元数据。IP 脱敏直接读 KV `setting:` 缓存（避免 setting-service ↔ audit-log-service 既有循环引用）；detail JSON 截断 2000；永不抛错。导出 `scrubDetail` 与 `isForbiddenDetailKey` 供测试。
- `audit-log-service.js:record()` 改为委托 `kernel/audit`；新的限流与审计视图路径走它。旧的各 service 内联 `record()` 调用本阶段**未**强行全迁（只迁了碰到的文件）。

## 2. 改动的文件

### 新建
| 文件 | 说明 |
|---|---|
| `mail-worker/src/utils/qrcode.js` | QR 编码器（vendored，零依赖），见 §1① |
| `mail-worker/src/kernel/audit.js` | Layer 1 最小化日志统一入口 |
| `mail-worker/src/kernel/ratelimit.js` | Layer 1 通用限流原语 |
| `mail-worker/src/api/security-audit-api.js` | `GET /security/audit-log`、`GET /security/score` |
| `mail-worker/test/phase8-b.spec.js` | 5 项测试，17 个用例 |

### 修改
| 文件 | 改动 |
|---|---|
| `mail-worker/src/service/totp-service.js` | `setup()` 返回 `qr`、换绑验旧码、`totp:setup/enable/disable` 审计 |
| `mail-worker/src/service/session-service.js` | 重写：`lastActiveAt`、`touchSession`、device/browser 拆分、IP 脱敏 |
| `mail-worker/src/service/user-security-service.js` | 新增 `getScore()`（9 项评分）+ `SCORE_RULES` 注释 |
| `mail-worker/src/service/login-service.js` | 登录限流（双维度查锁/计失败/建锁/告警）、登录成功写密码强度桶、成功清账号窗口 |
| `mail-worker/src/service/audit-log-service.js` | `record()` 委托 kernel/audit；新增 `listByUser()`（本人过滤/类型白名单/保留期限） |
| `mail-worker/src/security/security.js` | **最小触碰**：鉴权成功后调 `sessionService.touchSession`（见 §7） |
| `mail-worker/src/api/security-api.js` | **最小触碰**：`/my/totp/setup` 读 body 传 `oldCode`（见 §7） |
| `mail-vue/src/request/security.js` | `totpSetup(oldCode)` 传参；新增 `getSecurityScore()`、`myAuditLog(params)` |
| `mail-vue/src/views/security/index.vue` | 评分分项+建议、TOTP 二维码 canvas + 换绑旧码输入、会话表 `lastActiveAt` 列 + 设备/浏览器列、审计视图区、`.totp-qr` 样式 |

### 未碰（按分工）
- `mail-worker/src/hono/webs.js`（注册行见 §7）、`mail-vue/src/i18n/*.js` 与 `mail-worker/src/i18n/*.js`（文案清单见 §5）、`mail-worker/src/init/init.js`（DDL 清单见 §6）。

## 3. 测试结果

- 新测试 `mail-worker/test/phase8-b.spec.js`：**17/17 通过**（`npx vitest run test/phase8-b.spec.js`）。
  - ① 二维码：otpauth URL 格式、矩阵结构（尺寸=17+4·version、只含 0/1、左上定位图案）、编码确定性 + golden 回归（HELLO WORLD v1 三行、otpauth URL v8/size 49 首行）、换绑无旧码/错旧码 400、对旧码 200、secret 不进 `/my/security`。
  - ② 评分：9 项齐全且总分=分项和、新用户未满分且建议含 `securityScoreTipTotp`、开 TOTP/自动锁定/E2EE 后对应项满分、强密码登录后强度项满分、未登录 401。
  - ③ 审计视图：A 只看到自己的 2 行、B 的行不可见、`?type=totp|login` 筛选生效、IP 脱敏为 `203.0.113.0`、UA 截断 ≤120、2020 年旧行按保留期限排除、未登录 401。
  - ④ 限流：账号 5 次失败后第 6 次失败 429 通用错误（message 不含 `notExistUser`/`IncorrectPwd`）、锁定期内正确密码也被拒 429、`audit_log` 有 `login:rate_limited` 行、`alert_log` 有 `ratelimit` 行、清锁后恢复；IP 维度（同 IP 多账号失败后该 IP 下正确登录也被拒、只清 IP 锁后恢复）；成功清账号计数（4 失败+成功+4 失败仍不锁定）；退避单测（300/900/2700/86400）；kernel/audit 清洗单测。
  - ⑤ 会话：登录两次 → 2 会话且有 `lastActiveAt`、device/browser、脱敏 IP；人为写旧 `lastActiveAt` 后走一次鉴权接口，当前会话被刷新、另一会话保持旧值；踢出指定 digest 后列表只剩当前会话、被踢 token 调接口 401。
- 全套 vitest：**267/267 通过，14 个文件全绿**（`npx vitest run`，2026-11-08 第二次运行；含 phase1/2a/2c/6/7/7-ai/7-failover/7-harddelete/7-wallpaper/8-assistant/8-b/8a/8e-mail-trust/8f）。注：第一次全套运行为 263/277，14 个失败全部出在其他子代理的临时 `zz-*` 调试文件（`zz-probe`、`zz-debug-trust`、`zz-f-debug`）中，与本阶段改动无关；第二次运行时这些临时文件已被清理，全套即全绿。
- 前端构建：`mail-vue` `npm run build` **通过**（✓ built in 1m 33s；大于 500 kB chunk 的警告为既有）。

## 4. 评分规则表（总分 100，`user-security-service.js:SCORE_RULES`）

| 信号 | 满分 | 规则 | 建议 key |
|---|---|---|---|
| totp | 20 | TOTP 已开启 → 20，否则 0 | `securityScoreTipTotp` |
| passkey | 15 | ≥1 个 Passkey 凭证 → 15，否则 0 | `securityScoreTipPasskey` |
| autoLock | 10 | `autoLockMinutes > 0` → 10，否则 0 | `securityScoreTipAutoLock` |
| e2ee | 10 | E2EE 已开启 → 10，否则 0 | `securityScoreTipE2ee` |
| loginHistory | 10 | 最近 30 天 `login_log` 无 `is_new_ip=1` → 10，否则 0（全量计数，不只看最近 20 条） | `securityScoreTipLoginHistory` |
| passwordStrength | 10 | KV 强度桶 0–5 级：≥5→10，4→8，3→6，2→3，≤1→0；从未评估 → 5（未知=中性） | `securityScoreTipPasswordStrength` |
| passwordAge | 10 | 密码年龄 <180 天 → 10；180–365 天 → 5；>365 天 → 0；年龄取 `user.pwd_changed_at`（迁移前回落 `user.create_time`）；不可解析 → 5 | `securityScoreTipPasswordAge` |
| sessions | 5 | 会话 ≤3 → 5；4–5 → 3；>5 → 0 | `securityScoreTipSessions` |
| auditAnomaly | 10 | 最近 30 天无异常审计动作 → 10，否则 0；异常 = `login:rate_limited`、`login:locked`、`totp:failed`、`security:unlock_failed`，或 action 含 `fail`/`lock`/`rate_limit` | `securityScoreTipAuditAnomaly` |

- 每个信号读取失败时容错（未知 → 中性/0，永不抛错）；`getScore()` 返回 `{total, items: [{key, max, score, ok, suggestion|null}], suggestions: [i18n-key...]}`。
- 密码强度评分细则（登录时评估）：长度 ≥8 +1、≥12 +1、大小写混用 +1、含数字 +1、含符号 +1（0–5 级）。
- 前端回退：服务端评分接口失败时，本地按旧 4 项算（TOTP 30 + Passkey 30 + 登录提醒 20 + 30 天无新 IP 20）。

## 5. i18n JSON 清单（由总协调合并；前端 key 已在 `mail-vue/src/i18n/*.js` 之外，后端错误码在 `mail-worker/src/i18n/*.js` 之外）

### 5.1 前端新 key（28 个；语言顺序 zh / en / ja / ko / vi / ru / es / fr）

```json
{
  "securityScoreAutoLock": ["自动锁定", "Auto-lock", "自動ロック", "자동 잠금", "Khóa tự động", "Автоблокировка", "Bloqueo automático", "Verrouillage auto"],
  "securityScoreE2ee": ["端到端加密", "End-to-end encryption", "エンドツーエンド暗号化", "종단간 암호화", "Mã hóa đầu cuối", "Сквозное шифрование", "Cifrado de extremo a extremo", "Chiffrement de bout en bout"],
  "securityScoreLoginHistory": ["登录历史", "Login history", "ログイン履歴", "로그인 기록", "Lịch sử đăng nhập", "История входов", "Historial de inicio de sesión", "Historique de connexion"],
  "securityScorePasswordStrength": ["密码强度", "Password strength", "パスワード強度", "비밀번호 강도", "Độ mạnh mật khẩu", "Сложность пароля", "Fortaleza de la contraseña", "Force du mot de passe"],
  "securityScorePasswordAge": ["密码年龄", "Password age", "パスワードの経過期間", "비밀번호 사용 기간", "Tuổi mật khẩu", "Возраст пароля", "Antigüedad de la contraseña", "Âge du mot de passe"],
  "securityScoreSessions": ["会话数量", "Session count", "セッション数", "세션 수", "Số phiên", "Количество сессий", "Sesiones activas", "Nombre de sessions"],
  "securityScoreAuditAnomaly": ["审计异常", "Audit anomalies", "監査の異常", "감사 이상", "Bất thường kiểm tra", "Аномалии аудита", "Anomalías de auditoría", "Anomalies d'audit"],
  "securityScoreTipTotp": ["开启 TOTP 二次验证", "Enable TOTP two-factor authentication", "TOTP 二要素認証を有効にしてください", "TOTP 2단계 인증을 켜세요", "Bật xác thực hai yếu tố TOTP", "Включите двухфакторную аутентификацию TOTP", "Activa la autenticación TOTP", "Activez l'authentification TOTP"],
  "securityScoreTipPasskey": ["添加一个 Passkey", "Add a passkey", "パスキーを追加してください", "패스키를 추가하세요", "Thêm một passkey", "Добавьте passkey", "Añade una passkey", "Ajoutez une passkey"],
  "securityScoreTipAutoLock": ["开启自动锁定", "Enable auto-lock", "自動ロックを有効にしてください", "자동 잠금을 켜세요", "Bật khóa tự động", "Включите автоблокировку", "Activa el bloqueo automático", "Activez le verrouillage automatique"],
  "securityScoreTipE2ee": ["开启端到端加密", "Enable end-to-end encryption", "エンドツーエンド暗号化を有効にしてください", "종단간 암호화를 켜세요", "Bật mã hóa đầu cuối", "Включите сквозное шифрование", "Activa el cifrado de extremo a extremo", "Activez le chiffrement de bout en bout"],
  "securityScoreTipLoginHistory": ["检查未处理的新 IP 登录", "Review unhandled new-IP logins", "未処理の新規 IP ログインを確認してください", "처리되지 않은 새 IP 로그인을 확인하세요", "Kiểm tra các lần đăng nhập IP mới chưa xử lý", "Проверьте необработанные входы с новых IP", "Revisa los inicios de sesión desde IP nuevas", "Vérifiez les connexions depuis une nouvelle IP"],
  "securityScoreTipPasswordStrength": ["使用更强的密码（大小写字母、数字、符号）", "Use a stronger password (upper/lowercase letters, digits, symbols)", "より強いパスワード（大文字・小文字・数字・記号）を使ってください", "더 강력한 비밀번호(대소문자, 숫자, 기호)를 사용하세요", "Dùng mật khẩu mạnh hơn (chữ hoa/thường, số, ký tự đặc biệt)", "Используйте более сложный пароль (заглавные и строчные буквы, цифры, символы)", "Usa una contraseña más fuerte (mayúsculas, minúsculas, números y símbolos)", "Utilisez un mot de passe plus fort (majuscules, minuscules, chiffres, symboles)"],
  "securityScoreTipPasswordAge": ["密码已使用较久，建议更换", "Your password is old, consider changing it", "パスワードが古くなっています、変更をおすすめします", "비밀번호가 오래되었습니다. 변경하세요", "Mật khẩu đã cũ, nên đổi mới", "Ваш пароль устарел, рекомендуется сменить его", "Tu contraseña es antigua, considera cambiarla", "Votre mot de passe est ancien, pensez à le changer"],
  "securityScoreTipSessions": ["会话过多，踢出不用的设备", "Too many sessions, remove unused devices", "セッションが多すぎます、使っていないデバイスを削除してください", "세션이 너무 많습니다. 사용하지 않는 기기를 제거하세요", "Quá nhiều phiên, hãy đăng xuất thiết bị không dùng", "Слишком много сессий, завершите неиспользуемые устройства", "Demasiadas sesiones, cierra los dispositivos que no uses", "Trop de sessions, déconnectez les appareils inutilisés"],
  "securityScoreTipAuditAnomaly": ["最近有异常安全事件，请检查审计记录", "Recent security anomalies, please check the audit log", "最近セキュリティ異常がありました、監査記録を確認してください", "최근 보안 이상이 있습니다. 감사 기록을 확인하세요", "Gần đây có sự kiện bất thường, hãy kiểm tra nhật ký kiểm tra", "Недавно были аномалии безопасности, проверьте журнал аудита", "Hubo anomalías de seguridad recientes, revisa el registro de auditoría", "Des anomalies de sécurité récentes, consultez le journal d'audit"],
  "totpQrTip": ["用验证器 App 扫码添加", "Scan with your authenticator app to add", "認証アプリでスキャンして追加", "인증 앱으로 스캔하여 추가", "Quét bằng ứng dụng xác thực để thêm", "Отсканируйте приложением-аутентификатором", "Escanea con tu app de autenticación", "Scannez avec votre application d'authentification"],
  "totpQrUnavailable": ["二维码生成失败，请手动输入密钥", "QR code failed to generate, enter the secret manually", "QR コードの生成に失敗しました、シークレットを手動で入力してください", "QR 코드 생성에 실패했습니다. 비밀 키를 수동으로 입력하세요", "Không tạo được mã QR, hãy nhập khóa bí mật thủ công", "Не удалось создать QR-код, введите секрет вручную", "No se pudo generar el código QR, introduce el secreto manualmente", "Échec de génération du QR code, saisissez le secret manuellement"],
  "totpOldCodePlaceholder": ["输入当前验证器上的 6 位验证码", "Enter the 6-digit code from your current authenticator", "現在の認証アプリの 6 桁コードを入力", "현재 인증 앱의 6자리 코드를 입력", "Nhập mã 6 chữ số từ ứng dụng xác thực hiện tại", "Введите 6-значный код из текущего приложения-аутентификатора", "Introduce el código de 6 dígitos de tu autenticador actual", "Saisissez le code à 6 chiffres de votre authentificateur actuel"],
  "totpRebind": ["重新绑定", "Rebind", "再バインド", "다시 바인딩", "Liên kết lại", "Перепривязать", "Volver a vincular", "Réassocier"],
  "sessionLastActive": ["最后活跃", "Last active", "最終アクティブ", "마지막 활동", "Hoạt động gần nhất", "Последняя активность", "Última actividad", "Dernière activité"],
  "securityAuditTitle": ["审计记录", "Audit log", "監査記録", "감사 기록", "Nhật ký kiểm tra", "Журнал аудита", "Registro de auditoría", "Journal d'audit"],
  "securityAuditDesc": ["仅显示你本人的安全相关记录，IP 已脱敏。", "Only your own security records are shown; IPs are masked.", "自分自身のセキュリティ関連記録のみ表示され、IP はマスクされます。", "본인의 보안 관련 기록만 표시되며 IP는 마스킹됩니다.", "Chỉ hiển thị bản ghi bảo mật của bạn; IP đã được ẩn.", "Показаны только ваши записи безопасности; IP замаскированы.", "Solo se muestran tus propios registros de seguridad; las IP están enmascaradas.", "Seuls vos propres enregistrements de sécurité sont affichés ; les IP sont masquées."],
  "securityAuditAll": ["全部类型", "All types", "すべて", "전체 유형", "Tất cả loại", "Все типы", "Todos los tipos", "Tous les types"],
  "securityAuditAction": ["操作", "Action", "操作", "작업", "Hành động", "Действие", "Acción", "Action"],
  "securityAuditEmpty": ["暂无审计记录", "No audit records", "監査記録がありません", "감사 기록이 없습니다", "Chưa có bản ghi kiểm tra", "Нет записей аудита", "Sin registros de auditoría", "Aucun enregistrement d'audit"],
  "securityAuditPrev": ["上一页", "Previous", "前へ", "이전", "Trước", "Назад", "Anterior", "Précédent"],
  "securityAuditNext": ["下一页", "Next", "次へ", "다음", "Sau", "Далее", "Siguiente", "Suivant"]
}
```

注：`securityScoreTotp` / `securityScorePasskey` / `securityScoreLoginAlert` 三个分项 label key 已存在于 `mail-vue/src/i18n/zh.js`，无需新增；其余 28 个为新增。`securityScore` / `securityScoreTip`（评分区标题/建议标题）为既有 key。

### 5.2 后端错误码（中英文，`mail-worker/src/i18n/zh.js` 与 `en.js`）

```json
{
  "loginRateLimited": { "zh": "登录失败次数过多，请稍后再试", "en": "Too many failed login attempts, please try again later" },
  "totpOldCodeRequired": { "zh": "换绑 TOTP 需先验证旧验证码", "en": "Rebinding TOTP requires verifying the old code first" }
}
```

未合并前，`t()` 返回 key 本身，不抛错（已核：i18next 缺 key 时返回 key 字符串）。

## 6. 需要的 DDL 清单（由总协调并进 v3_11DB 迁移；未改 init.js）

```sql
-- 登录限流阈值（管理员可调；login-service.js 以 camelCase/snake_case 双 fallback 读取，缺失用默认）
ALTER TABLE setting ADD COLUMN login_rate_limit_window_min INTEGER NOT NULL DEFAULT 15;
ALTER TABLE setting ADD COLUMN login_rate_limit_ip_max INTEGER NOT NULL DEFAULT 5;
ALTER TABLE setting ADD COLUMN login_rate_limit_acct_max INTEGER NOT NULL DEFAULT 5;
ALTER TABLE setting ADD COLUMN login_rate_limit_lock_base_min INTEGER NOT NULL DEFAULT 5;
-- 密码年龄（密码修改时间；密码修改路径由 user-service.js 负责写，见 §8）
ALTER TABLE user ADD COLUMN pwd_changed_at TEXT;
-- 用户侧审计视图按 actor + 时间查询
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_time ON audit_log(actor_user_id, create_time);
```

另需总协调同步：`mail-worker/src/entity/setting.js` 增加 4 个字段（camelCase：`loginRateLimitWindowMin` / `loginRateLimitIpMax` / `loginRateLimitAcctMax` / `loginRateLimitLockBaseMin`，与现有 `ipRegLimit` 等写法一致），以便 `settingService.refresh()` 把它们写进 KV 缓存；`user` 实体增加 `pwdChangedAt`（若后续密码修改路径要写它）。

## 7. 需要的 webs.js 注册行（由总协调加；与第 30–31 行写法一致）

```js
import '../api/security-audit-api'
```

加在 `mail-worker/src/hono/webs.js` 第 31 行（`security-login-history-api`）之后。测试文件 `test/phase8-b.spec.js` 顶部已 `import '../src/api/security-audit-api.js'` 自行注册路由，因此测试不依赖该行；正式注册后测试里的 import 为重复注册（同一 handler），无害。

### 两处最小共享文件触碰（需总协调确认/可搬移）
1. `mail-worker/src/security/security.js`：鉴权成功后（`c.set('user', ...)` 之后、`return await next()` 之前）best-effort 调 `sessionService.touchSession(c, authInfo.user.userId, token)`，try/catch 包裹。这是唯一正确的「每次鉴权成功后刷新 lastActiveAt」钩子；security.js 不在分工文件清单内，故单独列出。
2. `mail-worker/src/api/security-api.js`：`/my/totp/setup` 路由读 body 并把 `body.oldCode` 传给 `totpService.setup(...)`，另注释说明返回值新增 `qr`。换绑验旧码不经此路由无法接线；security-api.js 不在分工文件清单内（新建审计 API 文件未动现有 api 文件），故单独列出。

## 8. 已知问题

1. **QR 矩阵与 npm `qrcode` 库存在细微差异**：同样强制掩码下模块仍略有不同（疑似 N4 罚分公式不同导致掩码平局取舍不同）；两者均可被 jsQR 正确解码，属外观差异而非缺陷。Golden 测试钉住本编码器的输出，罚分逻辑若改需同步更新 golden。
2. **TOTP 换绑脚枪（既有，未改）**：`setup()` 会覆盖 `secretEncrypted`，而 `enabled` 保持 1，旧验证器在新密钥验证前即失效。已用「换绑须先验旧码」缓解；存储语义未动。
3. **旧登录错误默认 501（既有，未改）**：`BizError` 无码默认 501，`IncorrectPwd` / `notExistUser` 等旧错误均未带码，因此错密码返回 `json.code 501`（HTTP 状态恒为 200）。测试按 501 钉住并注释。限流错误是新加的，明确带 429。
4. **HTTP 状态恒 200**：本项目 `onError` 一律 `c.json(result.fail(...))`，错误码在 `json.code`、文案在 `json.message`。测试断言均按此写；前端 `request` 层亦按 `code` 判断（既有行为）。
5. **Turnstile-on-lock 未实现**：PHASE8 §6.5 提到的「锁定后改走 Turnstile 验证」替代方案未做，本阶段选的是锁定（lockout）。攻击者可通过对受害者邮箱连错 5 次密码触发账号锁定——这是标准账号锁定权衡（只计已知账号会泄露账号是否存在）。
6. **密码强度只在登录时评估**：改密时评估未做（`pwd_changed_at` 列为将来改密路径预留，改密在 `user-service.js`，不在本子代理范围）；强度未知时评分取中性 5 分。
7. **测试 IP 段**：测试用 `203.0.113.x`（TEST-NET），计数器从 10 起；曾因计数器从 400 起导致 IP 段 >255、`maskIp` 合法地原样返回，测试失败——已修正为合法段。
8. **QR 编码器上限**：v10-M 最多 213 字节；otpauth URL 超长时 `qr=null`，前端回退手动输入（实测正常邮箱远未达上限）。
9. **`kernel/audit` 未全迁**：旧的各 service 内联 `record()` 调用本阶段未强行全迁，只迁了碰到的文件（`audit-log-service.js` 本身）；`reg-key:add` 的 `code` 值自此不再入日志（符合最小化日志要求）。
10. **临时校验脚本**：`/tmp/qrcheck/`（check/check2/debug/decode/sweep/golden/rs 等）为临时验证用，不属于交付物。
