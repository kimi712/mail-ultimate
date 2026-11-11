import app from './hono';
import '../security/security'

import '../api/email-api';
import '../api/user-api';
import '../api/login-api';
import '../api/setting-api';
import '../api/account-api';
import '../api/star-api';
import '../api/test-api';
import '../api/r2-api';
import '../api/resend-api';
import '../api/user-api';
import '../api/my-api';
import '../api/role-api'
import '../api/all-email-api'
import '../api/init-api'
import '../api/analysis-api'
import '../api/reg-key-api'
import '../api/ip-blocklist-api'
import '../api/public-api'
import '../api/telegram-api'
import '../api/oauth-api'
import '../api/register-log-api'
import '../api/audit-log-api'
import '../api/alert-log-api'
import '../api/quota-api'
import '../api/ai-api'
import '../api/wallpaper-api'
import '../api/security-api'
import '../api/security-login-history-api'
import '../api/security-audit-api'
import '../api/security-unlock-api'
import '../api/security-export-api'
// 斯诺登第二批（v3_15DB）：死亡开关（仅限本人配置）。
import '../api/deadman-api'
// Phase 8：AI 助手与翻译（C）、邮件信任与控制（E）、
// 隐私仪表盘 / 账号恢复 / 新 IP 提醒 / 联系人 / 邮件规则（F）。
import '../api/assistant-api'
import '../api/mail-trust-api'
import '../api/privacy-api'
import '../api/recovery-api'
import '../api/new-ip-alert-api'
import '../api/contact-api'
import '../api/mail-rule-api'
import '../api/alias-api'
// 斯诺登第三批（v3_16DB）：胁迫密码 / 可搜索加密（盲索引）/ 零知识身份。
import '../api/decoy-api'
import '../api/blind-api'
import '../api/zk-api'
// $1000 安全悬赏挑战：公开状态页（无需登录）。
import '../api/challenge-api'
// 斯诺登第四批（v3_17DB）：管理员审计可见化 / 登录异常告警 / 阅后即焚加固 / 自动过期别名。
import '../api/admin-audit-api'
import '../api/login-anomaly-api'
import '../api/burn-after-reading-api'
import '../api/alias-expiry-api'
export default app;
