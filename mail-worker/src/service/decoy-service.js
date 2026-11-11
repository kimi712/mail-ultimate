// 胁迫密码 + 隐藏邮箱（v3_16DB）：第二密码机制。
// 同一套机制、两种叫法：
//  - 胁迫密码：被胁迫时交出第二密码，登录后进入诱饵视图，看不到真实邮件；
//  - 隐藏邮箱：主密码进真实邮箱，第二密码进诱饵邮箱（内容是播种的假邮件，
//    看起来真实，不是空壳）。
// 安全要点：
//  - 第二密码 hash/salt 与主密码同一算法（SHA-256(salt+password) base64），
//    但存在独立表、独立 salt；设置/关闭第二密码必须验证主密码（胁迫者只
//    有第二密码时改不了它）；第二密码不得与主密码相同（否则无法区分）；
//  - 诱饵会话由 JWT payload.decoy=1 标识（验签防篡改），security.js 中间件
//    置位 c.get('decoyMode')；诱饵会话不刷新 active_time（不取消死亡开关
//    待执行）、不写登录日志、不发新 IP 提醒、不进会话列表；只记一条审计
//    'security:duress-login' 供主人事后取证；
//  - 诱饵邮件只读 decoy_email 表，对外一律用负数 emailId（=-decoyId），与
//    真实 email_id 永不碰撞；诱饵会话下发信直接拒（返回通用错误，不暴露
//    诱饵身份）。
import orm from '../entity/orm';
import userDecoy from '../entity/user-decoy';
import decoyEmail from '../entity/decoy-email';
import { eq, desc, sql } from 'drizzle-orm';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';
import cryptoUtils from '../utils/crypto-utils';
import userService from './user-service';
import auditLogService from './audit-log-service';

const MIN_SECOND_PASSWORD_LEN = 8;
const MAX_SECOND_PASSWORD_LEN = 128;

// 诱饵种子邮件：看起来真实的普通邮件（欢迎信、账单、newsletter、物流、
// 订阅续费等），日期铺在过去 30 天里。内容全部虚构，不含真实邮件的任何信息。
// 首次设置第二密码时播种；之后不再重复播种。
const DECOY_SEED = [
	{
		sendEmail: 'welcome@mail.aevorynthtech.com', name: 'Aevorynth Mail',
		subject: 'Welcome to Aevorynth Mail — your private inbox is ready',
		text: 'Hi there,\n\nWelcome to Aevorynth Mail. Your inbox is ready — send your first email and enjoy private, encrypted mail.\n\n— The Aevorynth Team',
		daysAgo: 29
	},
	{
		sendEmail: 'newsletter@weeklydigest.example.com', name: 'Weekly Digest',
		subject: 'Your weekly digest: 5 stories worth your time',
		text: 'Hi,\n\nHere is your weekly digest. Top stories this week: markets, tech, and travel. Read the full stories on our site.\n\nUnsubscribe anytime.',
		daysAgo: 24
	},
	{
		sendEmail: 'orders@shop.example.com', name: 'Shop Orders',
		subject: 'Your order #48213 has shipped',
		text: 'Good news — your order #48213 is on its way. Tracking: TRK88412093. Estimated delivery in 3–5 business days.',
		daysAgo: 19
	},
	{
		sendEmail: 'noreply@bank.example.com', name: 'Example Bank',
		subject: 'Your monthly statement is ready',
		text: 'Your monthly statement for the period ending last month is now available. Sign in to your online banking to view or download it.',
		daysAgo: 15
	},
	{
		sendEmail: 'trips@airline.example.com', name: 'Example Airlines',
		subject: 'Reminder: your flight departs in 7 days',
		text: 'Just a reminder — your flight departs in 7 days. Check in online 24 hours before departure to pick your seat.',
		daysAgo: 11
	},
	{
		sendEmail: 'hello@notes.example.com', name: 'Notes App',
		subject: 'Your notes from last week',
		text: 'Here is a summary of the notes you wrote last week. Keep capturing ideas — they add up.',
		daysAgo: 8
	},
	{
		sendEmail: 'billing@stream.example.com', name: 'Stream Service',
		subject: 'Your subscription renews in 3 days',
		text: 'Your subscription renews in 3 days. No action is needed — your saved payment method will be charged automatically.',
		daysAgo: 4
	},
	{
		sendEmail: 'team@project.example.com', name: 'Project Team',
		subject: 'Meeting notes — Thursday sync',
		text: 'Hi team,\n\nHere are the notes from Thursday’s sync: milestones are on track, and the next review is scheduled for next week.\n\nThanks!',
		daysAgo: 1
	}
];

const decoyService = {

	// 诱饵邮件行 → 前端邮件列表行（emailId 取负数，与真实 email_id 永不碰撞）。
	toListRow(row) {
		return {
			emailId: -Number(row.decoyId),
			sendEmail: row.sendEmail || '',
			name: row.name || '',
			subject: row.subject || '',
			text: row.text || '',
			content: row.content || row.text || '',
			recipient: '',
			toEmail: '',
			toName: '',
			type: 0,
			status: 0,
			unread: row.unread === 1 ? 1 : 0,
			createTime: row.createTime || '',
			isDel: 0,
			e2ee: 0,
			sealedSender: '',
			cekWrapped: '',
			cekAlg: '',
			e2eeVer: 1,
			expireAt: '',
			burnAfterRead: 0,
			mixDeliverAt: '',
			mixRelay: '',
			timelockUntil: '',
			deniable: 0,
			denyTag: ''
		};
	},

	async getStatus(c, userId) {
		try {
			const row = await orm(c).select().from(userDecoy).where(eq(userDecoy.userId, userId)).get();
			if (!row) return { enabled: 0, seeded: 0 };
			return { enabled: row.enabled === 1 ? 1 : 0, seeded: row.seeded === 1 ? 1 : 0 };
		} catch (e) {
			return { enabled: 0, seeded: 0 };
		}
	},

	// 设置/修改第二密码：必须验证主密码；第二密码不得与主密码相同。
	async setSecondPassword(c, userId, { password, currentPassword }) {
		const second = String(password || '').trim();
		const current = String(currentPassword || '').trim();
		if (second.length < MIN_SECOND_PASSWORD_LEN || second.length > MAX_SECOND_PASSWORD_LEN) {
			throw new BizError(t('decoyPasswordLength'), 400);
		}
		if (!current) {
			throw new BizError(t('decoyNeedMainPassword'), 400);
		}
		const userRow = await userService.selectById(c, userId);
		if (!userRow || !await cryptoUtils.verifyPassword(current, userRow.salt, userRow.password)) {
			throw new BizError(t('decoyMainPasswordWrong'), 400);
		}
		if (await cryptoUtils.verifyPassword(second, userRow.salt, userRow.password)) {
			throw new BizError(t('decoySameAsMain'), 400);
		}
		const { salt, hash } = await cryptoUtils.hashPassword(second);
		const row = await orm(c).select().from(userDecoy).where(eq(userDecoy.userId, userId)).get();
		const now = new Date().toISOString();
		if (row) {
			await orm(c).update(userDecoy).set({
				passwordHash: hash, salt, enabled: 1, updateTime: now
			}).where(eq(userDecoy.userId, userId)).run();
		} else {
			await orm(c).insert(userDecoy).values({
				userId, passwordHash: hash, salt, enabled: 1, seeded: 0, createTime: now, updateTime: now
			}).run();
		}
		await this.seedDecoyMail(c, userId);
		try {
			await auditLogService.record(c, {
				action: 'security:decoy-password-set', targetType: 'user', targetId: userId, detail: {}
			});
		} catch (e) { /* 审计失败不阻断 */ }
		return this.getStatus(c, userId);
	},

	// 关闭第二密码：必须验证主密码；关闭后第二密码立即失效。
	async disable(c, userId, { password }) {
		const current = String(password || '').trim();
		if (!current) {
			throw new BizError(t('decoyNeedMainPassword'), 400);
		}
		const userRow = await userService.selectById(c, userId);
		if (!userRow || !await cryptoUtils.verifyPassword(current, userRow.salt, userRow.password)) {
			throw new BizError(t('decoyMainPasswordWrong'), 400);
		}
		const row = await orm(c).select().from(userDecoy).where(eq(userDecoy.userId, userId)).get();
		if (row) {
			await orm(c).update(userDecoy).set({ enabled: 0, updateTime: new Date().toISOString() })
				.where(eq(userDecoy.userId, userId)).run();
		}
		try {
			await auditLogService.record(c, {
				action: 'security:decoy-password-disabled', targetType: 'user', targetId: userId, detail: {}
			});
		} catch (e) { /* 审计失败不阻断 */ }
		return this.getStatus(c, userId);
	},

	// 登录时校验第二密码（仅 enabled=1 时有效）。返回 true 表示这是诱饵登录。
	async verifySecondPassword(c, userId, password) {
		try {
			const row = await orm(c).select().from(userDecoy).where(eq(userDecoy.userId, userId)).get();
			if (!row || row.enabled !== 1 || !row.passwordHash || !row.salt) return false;
			return await cryptoUtils.verifyPassword(String(password || '').trim(), row.salt, row.passwordHash);
		} catch (e) {
			return false;
		}
	},

	// 诱饵登录取证：只记一条审计（不写登录日志、不发新 IP 提醒、不刷新活跃时间）。
	async recordDuressLogin(c, userId, ip) {
		try {
			await auditLogService.record(c, {
				action: 'security:duress-login', targetType: 'user', targetId: userId,
				detail: { ip: String(ip || '').split('.').slice(0, 2).join('.') + '.x.x' }
			});
		} catch (e) { /* best-effort */ }
	},

	// 播种诱饵邮件（幂等：已有则跳过）。
	async seedDecoyMail(c, userId) {
		try {
			const existing = await orm(c).select({ n: sql`COUNT(*)` }).from(decoyEmail)
				.where(eq(decoyEmail.userId, userId)).get();
			if (Number(existing?.n || 0) > 0) {
				await orm(c).update(userDecoy).set({ seeded: 1 }).where(eq(userDecoy.userId, userId)).run();
				return;
			}
			const now = Date.now();
			for (const item of DECOY_SEED) {
				const ts = new Date(now - item.daysAgo * 86400000);
				const createTime = ts.toISOString().slice(0, 19).replace('T', ' ');
				await orm(c).insert(decoyEmail).values({
					userId,
					sendEmail: item.sendEmail,
					name: item.name,
					subject: item.subject,
					text: item.text,
					content: item.text,
					unread: 1,
					createTime
				}).run();
			}
			await orm(c).update(userDecoy).set({ seeded: 1 }).where(eq(userDecoy.userId, userId)).run();
		} catch (e) {
			console.error('诱饵邮件播种失败:', e.message);
		}
	},

	// 诱饵收件箱列表（新→旧，size 上限 50）。
	async listDecoyMail(c, userId, { size = 20 } = {}) {
		const n = Math.min(50, Math.max(1, Number(size) || 20));
		try {
			const rows = await orm(c).select().from(decoyEmail)
				.where(eq(decoyEmail.userId, userId))
				.orderBy(desc(decoyEmail.decoyId)).limit(n).all();
			return rows.map(r => this.toListRow(r));
		} catch (e) {
			return [];
		}
	},

	// 诱饵单封（decoyId 为正数；对外 emailId 为负数时取绝对值）。
	async getDecoyMail(c, userId, decoyId) {
		const id = Math.abs(Number(decoyId) || 0);
		if (!id) return null;
		try {
			const row = await orm(c).select().from(decoyEmail)
				.where(eq(decoyEmail.decoyId, id)).get();
			if (!row || Number(row.userId) !== Number(userId)) return null;
			return this.toListRow(row);
		} catch (e) {
			return null;
		}
	},

	async markDecoyRead(c, userId, decoyIds) {
		const ids = (Array.isArray(decoyIds) ? decoyIds : [decoyIds])
			.map(v => Math.abs(Number(v) || 0)).filter(Boolean);
		if (!ids.length) return;
		try {
			for (const id of ids) {
				await orm(c).update(decoyEmail).set({ unread: 0 })
					.where(eq(decoyEmail.decoyId, id)).run();
			}
		} catch (e) { /* best-effort */ }
	},

	async deleteDecoyMail(c, userId, decoyIds) {
		const ids = (Array.isArray(decoyIds) ? decoyIds : [decoyIds])
			.map(v => Math.abs(Number(v) || 0)).filter(Boolean);
		if (!ids.length) return;
		try {
			for (const id of ids) {
				const row = await orm(c).select().from(decoyEmail)
					.where(eq(decoyEmail.decoyId, id)).get();
				if (row && Number(row.userId) === Number(userId)) {
					await orm(c).delete(decoyEmail).where(eq(decoyEmail.decoyId, id)).run();
				}
			}
		} catch (e) { /* best-effort */ }
	},

	// 账号硬删除时清理第二密码与诱饵邮件（userService.physicsDelete 调用）。
	async deleteByUserId(c, userId) {
		try {
			await orm(c).delete(decoyEmail).where(eq(decoyEmail.userId, userId)).run();
			await orm(c).delete(userDecoy).where(eq(userDecoy.userId, userId)).run();
		} catch (e) { /* best-effort */ }
	}
};

export default decoyService;
