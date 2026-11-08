// Phase 7：导出我的数据（数据主权）。
// GET /my/export：仅限本人。返回一份 JSON：账号资料、安全设置、Passkey
// 列表、当前会话/设备列表、最近 100 条登录历史、邮箱与账号数量统计。
// 刻意不含邮件正文/附件（那是完整邮箱导出，量级与实现都大一档，见
// PHASE7-PRIVACY-AUDIT.md §3 缺口）；也不含任何密钥材料（TOTP 密钥、
// Passkey 公钥原文、密码 hash 均不返回）。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import userService from '../service/user-service';
import userSecurityService from '../service/user-security-service';
import passkeyService from '../service/passkey-service';
import sessionService from '../service/session-service';
import loginLogService from '../service/login-log-service';
import orm from '../entity/orm';
import email from '../entity/email';
import account from '../entity/account';
import { count, eq } from 'drizzle-orm';

app.get('/my/export', async (c) => {
	const userId = userContext.getUserId(c);
	const currentToken = await userContext.getToken(c);
	const userRow = await userService.selectById(c, userId);
	const security = await userSecurityService.get(c, userId);
	const passkeys = await passkeyService.listCredentials(c, userId);
	const sessions = await sessionService.listSessions(c, userId, currentToken);
	const loginHistory = await loginLogService.listByUser(c, userId, { num: 1, size: 100 });
	const emailCount = await orm(c).select({ n: count() }).from(email)
		.where(eq(email.userId, userId)).get();
	const accountCount = await orm(c).select({ n: count() }).from(account)
		.where(eq(account.userId, userId)).get();
	return c.json(result.ok({
		exportedAt: new Date().toISOString(),
		user: {
			userId,
			email: userRow?.email || '',
			locale: userRow?.locale || '',
			createTime: userRow?.createTime || ''
		},
		security: {
			loginAlert: security.loginAlert,
			e2eeEnabled: security.e2eeEnabled,
			retentionDays: security.retentionDays,
			autoLockMinutes: security.autoLockMinutes,
			totpEnabled: security.totpEnabled
		},
		passkeys: (passkeys || []).map(row => ({
			credentialId: row.credentialId,
			name: row.name,
			createdTime: row.createdTime
		})),
		sessions,
		loginHistory: loginHistory.list.map(row => ({
			time: row.createTime,
			ip: row.ip,
			ua: row.ua,
			isNewIp: row.isNewIp
		})),
		counts: {
			emails: emailCount?.n || 0,
			accounts: accountCount?.n || 0,
			loginHistoryTotal: loginHistory.total
		}
	}));
});
