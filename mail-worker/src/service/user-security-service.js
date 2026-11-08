// Phase 6：个性化安全中心后端（user_security 表）。
// 默认值：loginAlert=1（异地提醒开）、e2eeEnabled=0、retentionDays=0（永久保留）。
// retentionDays 只接受 0/30/90/365，其余值 400。读操作永不抛错，缺行返回默认值。
import orm from '../entity/orm';
import userSecurity from '../entity/user-security';
import userTotp from '../entity/user-totp';
import { eq } from 'drizzle-orm';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';

const ALLOWED_RETENTION_DAYS = [0, 30, 90, 365];
const ALLOWED_AUTO_LOCK_MINUTES = [0, 5, 15, 30];
const DEFAULTS = { loginAlert: 1, e2eeEnabled: 0, retentionDays: 0, e2eeSalt: '', autoLockMinutes: 0 };

const userSecurityService = {

	async get(c, userId) {
		try {
			const row = await orm(c).select().from(userSecurity).where(eq(userSecurity.userId, userId)).get();
			const base = row ? {
				loginAlert: row.loginAlert === 1 ? 1 : 0,
				e2eeEnabled: row.e2eeEnabled === 1 ? 1 : 0,
				retentionDays: row.retentionDays ?? 0,
				e2eeSalt: row.e2eeSalt || '',
				// 旧库无 auto_lock_minutes 列时（迁移未跑）读到 undefined，按 0 兜底。
				autoLockMinutes: ALLOWED_AUTO_LOCK_MINUTES.includes(row.autoLockMinutes) ? row.autoLockMinutes : 0
			} : { ...DEFAULTS };
			// C 路对齐项（契约 §1.3 之外）：安全评分的 TOTP +30 需要该状态，
			// 读 user_totp.enabled；读失败默认 false，不阻断返回。
			let totpEnabled = false;
			try {
				const totpRow = await orm(c).select().from(userTotp).where(eq(userTotp.userId, userId)).get();
				totpEnabled = !!totpRow && totpRow.enabled === 1;
			} catch (e) {
				totpEnabled = false;
			}
			return { ...base, totpEnabled };
		} catch (e) {
			return { ...DEFAULTS, totpEnabled: false };
		}
	},

	async set(c, userId, params) {
		const updates = {};
		if (params.loginAlert !== undefined) {
			updates.loginAlert = params.loginAlert ? 1 : 0;
		}
		if (params.e2eeEnabled !== undefined) {
			updates.e2eeEnabled = params.e2eeEnabled ? 1 : 0;
		}
		if (params.retentionDays !== undefined) {
			const days = Number(params.retentionDays);
			if (!ALLOWED_RETENTION_DAYS.includes(days)) {
				throw new BizError(t('securityInvalidRetention'), 400);
			}
			updates.retentionDays = days;
		}
		if (typeof params.e2eeSalt === 'string' && params.e2eeSalt !== '') {
			updates.e2eeSalt = params.e2eeSalt;
		}
		if (params.autoLockMinutes !== undefined) {
			const minutes = Number(params.autoLockMinutes);
			if (!ALLOWED_AUTO_LOCK_MINUTES.includes(minutes)) {
				throw new BizError(t('securityInvalidAutoLock'), 400);
			}
			updates.autoLockMinutes = minutes;
		}
		if (Object.keys(updates).length === 0) {
			return this.get(c, userId);
		}
		const row = await orm(c).select().from(userSecurity).where(eq(userSecurity.userId, userId)).get();
		if (row) {
			await orm(c).update(userSecurity).set(updates).where(eq(userSecurity.userId, userId)).run();
		} else {
			await orm(c).insert(userSecurity).values({ userId, ...DEFAULTS, ...updates }).run();
		}
		return this.get(c, userId);
	},

	// 异地提醒开关：关闭后登录历史照常记，只是不发提醒邮件。读失败默认开启（不丢提醒）。
	async isLoginAlertEnabled(c, userId) {
		const sec = await this.get(c, userId);
		return sec.loginAlert === 1;
	},

	async isE2eeEnabled(c, userId) {
		const sec = await this.get(c, userId);
		return sec.e2eeEnabled === 1;
	}
};

export default userSecurityService;
