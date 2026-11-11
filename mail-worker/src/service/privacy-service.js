// Phase 8 F：隐私仪表盘 / 透明度中心（后端聚合，只读）。
// 一目了然：本站收集了什么、没收集什么、每项保留多久、每项能不能关。
// 数据来源：setting（日志脱敏/保留期限/AI 开关）、user_security（登录提醒/
// E2EE/保留期限/自动锁定）、login_log 计数、contacts / mail_rules /
// 恢复码 / known_ip 计数、会话列表。开关本身复用现有 /my/security 接口，
// 本接口不直接改任何设置（仪表盘只展示 + 跳转，不做写操作）。
import settingService from './setting-service';
import userSecurityService from './user-security-service';
import loginLogService from './login-log-service';
import sessionService from './session-service';
import newIpAlertService from './new-ip-alert-service';
import recoveryService from './recovery-service';
import orm from '../entity/orm';
import contact from '../entity/contact';
import mailRule from '../entity/mail-rule';
import { count, eq } from 'drizzle-orm';

function maskEmail(email) {
	const value = String(email || '');
	const at = value.indexOf('@');
	if (at <= 0) return value ? '***' : '';
	const local = value.slice(0, at);
	const domain = value.slice(at + 1);
	const shown = local.length <= 2 ? `${local.charAt(0)}***` : `${local.slice(0, 2)}***`;
	return `${shown}@${domain}`;
}

const privacyService = {

	async getDashboard(c, userId) {
		const setting = await settingService.query(c).catch(() => ({}));
		const security = await userSecurityService.get(c, userId);
		const loginHistory = await loginLogService.listByUser(c, userId, { num: 1, size: 1 });
		const sessions = await sessionService.listSessions(c, userId, null).catch(() => []);
		const pendingAlerts = await newIpAlertService.listPendingAlerts(c, userId).catch(() => []);
		const codesRemaining = await recoveryService.remainingCodes(c, userId).catch(() => 0);
		const backup = await recoveryService.getBackupEmail(c, userId).catch(() => null);
		const contactCount = await orm(c).select({ n: count() }).from(contact)
			.where(eq(contact.userId, userId)).get().catch(() => ({ n: 0 }));
		const ruleCount = await orm(c).select({ n: count() }).from(mailRule)
			.where(eq(mailRule.userId, userId)).get().catch(() => ({ n: 0 }));

		const logRetentionDays = Number(setting.logRetentionDays ?? 90) || 0;
		const aiEnabled = Number(setting.aiEnabled ?? 1) === 1;
		const tgConfigured = !!(setting.tgBotToken && setting.tgChatId);
		const resendConfigured = !!(setting.resendTokens && Object.keys(setting.resendTokens).length > 0);

		return {
			// 数据清单：每项 = 收集与否 + 保留多久 + 能不能关 + 为什么必需/不能关。
			// 前端按 id 取 i18n 文案（key 清单见汇报）。
			dataInventory: [
				{ id: 'login_log', collected: true, retentionDays: logRetentionDays, retentionText: logRetentionDays === 0 ? 'forever' : `${logRetentionDays}d`, canDisable: false, whyRequired: 'security_login_history' },
				{ id: 'login_ip_masked', collected: true, retentionDays: logRetentionDays, retentionText: logRetentionDays === 0 ? 'forever' : `${logRetentionDays}d`, canDisable: false, whyRequired: 'security_new_ip_detection' },
				{ id: 'login_ua_truncated', collected: true, retentionDays: logRetentionDays, retentionText: logRetentionDays === 0 ? 'forever' : `${logRetentionDays}d`, canDisable: false, whyRequired: 'security_device_identification' },
				{ id: 'login_location', collected: false, retentionDays: null, retentionText: 'never', canDisable: true, whyRequired: null },
				{ id: 'email_content_log', collected: false, retentionDays: null, retentionText: 'never', canDisable: true, whyRequired: null },
				{ id: 'email_content_storage', collected: true, retentionDays: security.retentionDays, retentionText: security.retentionDays === 0 ? 'forever' : `${security.retentionDays}d`, canDisable: false, whyRequired: 'service_core' },
				{ id: 'e2ee', collected: security.e2eeEnabled === 1 ? 'encrypted' : 'plaintext', retentionDays: security.retentionDays, retentionText: security.retentionDays === 0 ? 'forever' : `${security.retentionDays}d`, canDisable: true, whyRequired: null },
				{ id: 'audit_log', collected: true, retentionDays: logRetentionDays, retentionText: logRetentionDays === 0 ? 'forever' : `${logRetentionDays}d`, canDisable: false, whyRequired: 'security_audit_trail' },
				{ id: 'ai_chat_history', collected: aiEnabled, retentionDays: 30, retentionText: '30d', canDisable: true, whyRequired: null }
			],
			// 当前开关状态（开关操作走现有 /my/security 与设置页接口）。
			controls: {
				loginAlert: security.loginAlert === 1,
				e2eeEnabled: security.e2eeEnabled === 1,
				retentionDays: security.retentionDays,
				autoLockMinutes: security.autoLockMinutes,
				totpEnabled: !!security.totpEnabled,
				logIpMask: Number(setting.logIpMask ?? 1) === 1,
				aiEnabled
			},
			// 第三方清单：谁、用来干什么、必需还是可选、配了没有。
			thirdParties: [
				{ id: 'cloudflare', required: true, configured: true, purpose: 'platform' },
				{ id: 'turnstile', required: true, configured: true, purpose: 'bot_check' },
				{ id: 'cf_email_sending', required: false, configured: true, purpose: 'outbound_mail_primary' },
				{ id: 'resend', required: false, configured: resendConfigured, purpose: 'outbound_mail_fallback' },
				{ id: 'telegram', required: false, configured: tgConfigured, purpose: 'alerts_optional' },
				{ id: 'workers_ai', required: false, configured: aiEnabled, purpose: 'assistant_optional' }
			],
			// 账号恢复与提醒状态。
			account: {
				recoveryCodesRemaining: codesRemaining,
				backupEmailSet: !!backup,
				backupEmailMasked: backup ? maskEmail(backup.backupEmail) : '',
				backupEmailVerified: backup ? backup.verified === 1 : false,
				pendingNewIpAlerts: pendingAlerts.length,
				sessionsCount: Array.isArray(sessions) ? sessions.length : 0
			},
			counts: {
				loginHistoryTotal: loginHistory.total || 0,
				contacts: contactCount?.n || 0,
				rules: ruleCount?.n || 0
			}
		};
	}
};

export default privacyService;
