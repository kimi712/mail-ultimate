import orm from '../entity/orm';
import deadManSwitch from '../entity/dead-man-switch';
import user from '../entity/user';
import { account } from '../entity/account';
import { loginLog } from '../entity/login-log';
import { eq } from 'drizzle-orm';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';
import emailService from './email-service';
import userService from './user-service';
import userContext from '../security/user-context';
import auditLogService from './audit-log-service';

// 死亡开关（v3_15DB）：用户自选失联期限（30/60/90 天）与触发动作：
// 'delete' = 删除全部邮件与账号数据（走 userService.physicsDelete）；
// 'notify' = 把指定内容发给指定联系人。
// 防误触发三重保障（缺一不可）：
//  1. 提醒：失联满（期限 - 7 天）时发提醒邮件给用户本人，warned_at 留痕；
//  2. 执行：仅当已提醒（warned_at 非空）且提醒已发出满 7 天且仍失联满期限时才执行
//     —— 提醒发出后至少给满 7 天宽限期，错过提醒窗口也不误触；
//  3. 取消：任意一次登录/活动都会刷新 user.active_time，失联天数归零，自动取消
//     待执行；用户也可在设置页随时关闭。失联未满提醒线时 warned_at 会被清掉
//     （状态机归零），下次重新满提醒线时再发一次提醒，绝不凭旧提醒直接执行；
// 最后活跃取 user.active_time（security.js 在每次鉴权成功后调 updateUserInfo 更新，
// 即任意 API 活动都算活跃）；取不到时回落 login_log 最大 create_time，再回落 create_time。
const ALLOWED_DAYS = [30, 60, 90];
const ALLOWED_ACTIONS = ['delete', 'notify'];
const REMIND_BEFORE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_LEN = 2000;

const deadmanService = {

	async get(c, userId) {
		// 诱饵会话（v3_16DB）：恒返回未布防（不透露真实死亡开关状态）。
		if (userContext.isDecoy(c)) {
			return { enabled: 0, inactivityDays: 90, action: 'delete', contactEmail: '', message: '', status: 'off', warnedAt: '', executedAt: '', lastActiveAt: '', inactiveDays: 0 };
		}
		try {
			const row = await orm(c).select().from(deadManSwitch)
				.where(eq(deadManSwitch.userId, userId)).get();
			if (!row) {
				return { enabled: 0, inactivityDays: 90, action: 'delete', contactEmail: '', message: '', status: 'off', warnedAt: '', executedAt: '', lastActiveAt: '', inactiveDays: 0 };
			}
			const lastActiveAt = await this.getLastActiveAt(c, userId);
			const inactiveDays = lastActiveAt
				? Math.max(0, Math.floor((Date.now() - new Date(lastActiveAt).getTime()) / MS_PER_DAY))
				: 0;
			return {
				enabled: row.enabled === 1 ? 1 : 0,
				inactivityDays: row.inactivityDays,
				action: row.action,
				contactEmail: row.contactEmail,
				message: row.message,
				status: row.status,
				warnedAt: row.warnedAt || '',
				executedAt: row.executedAt || '',
				lastActiveAt: lastActiveAt || '',
				inactiveDays
			};
		} catch (e) {
			return { enabled: 0, inactivityDays: 90, action: 'delete', contactEmail: '', message: '', status: 'off', warnedAt: '', executedAt: '', lastActiveAt: '', inactiveDays: 0 };
		}
	},

	async set(c, userId, params) {
		// 诱饵会话（v3_16DB）：拒绝改死亡开关（不动真实配置）。
		if (userContext.isDecoy(c)) {
			throw new BizError(t('unauthorized'), 403);
		}
		const days = Number(params.inactivityDays);
		if (!ALLOWED_DAYS.includes(days)) {
			throw new BizError(t('deadmanInvalidDays'), 400);
		}
		const action = String(params.action || 'delete');
		if (!ALLOWED_ACTIONS.includes(action)) {
			throw new BizError(t('deadmanInvalidAction'), 400);
		}
		const contactEmail = String(params.contactEmail || '').trim();
		const message = String(params.message || '').trim();
		if (action === 'notify') {
			if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
				throw new BizError(t('deadmanInvalidContact'), 400);
			}
			if (!message) {
				throw new BizError(t('deadmanInvalidMessage'), 400);
			}
			if (message.length > MAX_MESSAGE_LEN) {
				throw new BizError(t('deadmanMessageTooLong'), 400);
			}
		}
		const enabled = params.enabled === false || params.enabled === 0 ? 0 : 1;
		const now = new Date().toISOString();
		const row = await orm(c).select().from(deadManSwitch)
			.where(eq(deadManSwitch.userId, userId)).get();
		const values = {
			enabled,
			inactivityDays: days,
			action,
			contactEmail: action === 'notify' ? contactEmail : '',
			message: action === 'notify' ? message : '',
			// 重新布防时清空旧的提醒/执行留痕（状态机归零，防旧 warned_at 误触）。
			warnedAt: '',
			executedAt: '',
			status: enabled ? 'armed' : 'off',
			updateTime: now
		};
		if (row) {
			await orm(c).update(deadManSwitch).set(values)
				.where(eq(deadManSwitch.userId, userId)).run();
		} else {
			await orm(c).insert(deadManSwitch).values({ userId, ...values, createTime: now }).run();
		}
		try {
			await auditLogService.record(c, {
				action: enabled ? 'security:deadman-armed' : 'security:deadman-disabled',
				targetType: 'user', targetId: userId,
				detail: { inactivityDays: days, action }
			});
		} catch (e) { /* 审计失败不阻断配置保存 */ }
		return this.get(c, userId);
	},

	async disable(c, userId) {
		// 诱饵会话（v3_16DB）：拒绝改死亡开关（不动真实配置）。
		if (userContext.isDecoy(c)) {
			throw new BizError(t('unauthorized'), 403);
		}
		const row = await orm(c).select().from(deadManSwitch)
			.where(eq(deadManSwitch.userId, userId)).get();
		if (row) {
			await orm(c).update(deadManSwitch).set({
				enabled: 0, status: 'off', warnedAt: '', executedAt: '',
				updateTime: new Date().toISOString()
			}).where(eq(deadManSwitch.userId, userId)).run();
		}
		try {
			await auditLogService.record(c, {
				action: 'security:deadman-disabled',
				targetType: 'user', targetId: userId, detail: {}
			});
		} catch (e) { /* 审计失败不阻断 */ }
		return this.get(c, userId);
	},

	// 最后活跃：user.active_time 优先；取不到回落 login_log 最大 create_time；
	// 再取不到回落 user.create_time。返回 ISO 字符串或 ''。
	async getLastActiveAt(c, userId) {
		try {
			const row = await orm(c).select().from(user).where(eq(user.userId, userId)).get();
			if (!row) return '';
			if (row.activeTime) return row.activeTime;
			const logs = await orm(c).select().from(loginLog)
				.where(eq(loginLog.userId, userId)).all();
			let max = '';
			for (const log of logs) {
				if (log.createTime && (!max || log.createTime > max)) max = log.createTime;
			}
			if (max) return max;
			return row.createTime || '';
		} catch (e) {
			// 读失败返回 ''（checkOne 会跳过本轮，不误触）；记日志，别静默吞掉，
			// 否则最后活跃读不到会让开关永远不触发还查不出原因。
			console.error(`[deadman] getLastActiveAt user ${userId} 失败:`, e?.message || e);
			return '';
		}
	},

	// 每小时 cron 调一次（见 index.js scheduled）：先提醒、再执行，全程幂等。
	// 提醒失败（发信异常）只记日志，不写 warned_at —— 下一小时重试，绝不丢提醒。
	async check(c) {
		const rows = await orm(c).select().from(deadManSwitch)
			.where(eq(deadManSwitch.enabled, 1)).all();
		let reminded = 0;
		let executed = 0;
		for (const row of rows) {
			try {
				const result = await this.checkOne(c, row);
				if (result === 'reminded') reminded++;
				if (result === 'executed') executed++;
			} catch (e) {
				console.error(`[deadman] user ${row.userId} 检查失败:`, e?.message || e);
			}
		}
		return { checked: rows.length, reminded, executed };
	},

	async checkOne(c, row) {
		const lastActiveAt = await this.getLastActiveAt(c, row.userId);
		if (!lastActiveAt) return 'skip';
		const inactiveDays = (Date.now() - new Date(lastActiveAt).getTime()) / MS_PER_DAY;
		const remindAtDays = row.inactivityDays - REMIND_BEFORE_DAYS;
		// 失联未满提醒线：状态机归零（之前提醒过但用户又活跃了，旧提醒作废，
		// warned_at 清掉，下次重新满提醒线时再发一次提醒，绝不凭旧提醒直接执行）。
		if (inactiveDays < remindAtDays) {
			if (row.warnedAt) {
				await orm(c).update(deadManSwitch).set({ warnedAt: '', status: 'armed', updateTime: new Date().toISOString() })
					.where(eq(deadManSwitch.userId, row.userId)).run();
			}
			return 'skip';
		}
		// 满提醒线、未提醒 → 发提醒邮件给用户本人。
		if (!row.warnedAt) {
			await this.sendReminder(c, row);
			return 'reminded';
		}
		// 已提醒：未满期限 → 等；满期限但提醒未满 7 天 → 等（给满 7 天宽限期）；
		// 满期限且提醒已满 7 天 → 执行。
		if (inactiveDays < row.inactivityDays) return 'wait';
		const warnedMs = Date.now() - new Date(row.warnedAt).getTime();
		if (warnedMs < REMIND_BEFORE_DAYS * MS_PER_DAY) return 'wait';
		await this.execute(c, row);
		return 'executed';
	},

	async sendReminder(c, row) {
		const userRow = await userService.selectById(c, row.userId);
		if (!userRow) return;
		// 发件账号取用户主账号（email 与登录邮箱一致的 account），取不到说明账号异常，
		// 不写 warned_at，下一小时重试，绝不丢提醒。
		const senderAccount = await this.getSenderAccount(c, row.userId);
		if (!senderAccount) {
			console.error(`[deadman] user ${row.userId} 无发件账号，提醒暂缓`);
			return;
		}
		const daysLeft = REMIND_BEFORE_DAYS;
		const subject = t('deadmanReminderSubject');
		const text = t('deadmanReminderText', { days: row.inactivityDays, daysLeft });
		// 以用户本人身份发给自己（走正常发信管线，站内投递；E2EE 不加密提醒信，
		// 提醒信不含敏感内容，只说“登录一次即可取消”）。
		await emailService.executeSend(c, {
			accountId: senderAccount.accountId,
			receiveEmail: [userRow.email],
			subject, text, content: text.replace(/\n/g, '<br>'),
			e2ee: 0
		}, row.userId, { systemSend: true });
		const now = new Date().toISOString();
		await orm(c).update(deadManSwitch).set({ warnedAt: now, status: 'warned', updateTime: now })
			.where(eq(deadManSwitch.userId, row.userId)).run();
		try {
			await auditLogService.record(c, {
				action: 'security:deadman-warned',
				targetType: 'user', targetId: row.userId,
				detail: { inactivityDays: row.inactivityDays }
			});
		} catch (e) { /* 审计失败不阻断 */ }
	},

	// 用户主账号：email 与登录邮箱一致的 account；没有则取该用户第一个账号。
	async getSenderAccount(c, userId) {
		try {
			const userRow = await userService.selectById(c, userId);
			if (!userRow) return null;
			const rows = await orm(c).select().from(account)
				.where(eq(account.userId, userId)).all();
			if (!rows.length) return null;
			return rows.find(a => String(a.email || '').toLowerCase() === String(userRow.email || '').toLowerCase())
				|| rows[0];
		} catch (e) {
			return null;
		}
	},

	async execute(c, row) {
		const now = new Date().toISOString();
		if (row.action === 'notify') {
			// 通知动作：以用户身份把指定内容发给指定联系人（明文，e2ee=0）。
			// 发信失败只记日志，不阻断 cron；开关仍标记 executed，避免反复重发。
			try {
				const senderAccount = await this.getSenderAccount(c, row.userId);
				if (!senderAccount) {
					console.error(`[deadman] user ${row.userId} 无发件账号，通知无法发出`);
				} else {
					await emailService.executeSend(c, {
						accountId: senderAccount.accountId,
						receiveEmail: [row.contactEmail],
						subject: t('deadmanNotifySubject'),
						text: row.message,
						content: String(row.message || '').replace(/\n/g, '<br>'),
						e2ee: 0
					}, row.userId, { systemSend: true });
				}
			} catch (e) {
				console.error(`[deadman] user ${row.userId} 通知发送失败:`, e?.message || e);
			}
		} else {
			// 删除动作：走现有 hard-delete 路径（physicsDelete：删账号、邮件、附件等），
			// 管理员账号也可启用开关，执行时不做身份豁免——用户在设置页看到明确提示。
			await userService.physicsDelete(c, { userIds: String(row.userId) });
		}
		// physicsDelete 不清 dead_man_switch 行（它在 physicsDelete 写成之前不存在）；
		// 行留下来无妨：下面立即把它标记 executed + 关闭，cron 只查 enabled=1 的行，
		// 不会重复执行。notify 动作同理。
		try {
			await orm(c).update(deadManSwitch).set({
				enabled: 0, status: 'executed', executedAt: now, updateTime: now
			}).where(eq(deadManSwitch.userId, row.userId)).run();
		} catch (e) { /* 行已被 physicsDelete 删掉时忽略 */ }
		try {
			await auditLogService.record(c, {
				action: 'security:deadman-executed',
				targetType: 'user', targetId: row.userId,
				detail: { inactivityDays: row.inactivityDays, action: row.action }
			});
		} catch (e) { /* 审计失败不阻断 */ }
	}
};

export default deadmanService
