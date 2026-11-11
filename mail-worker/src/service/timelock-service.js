// 时间锁加密（v3_16DB）：写信时可选解锁时间，服务端到时才放行密钥。
// 机制：发信时 CEK 包裹不写进 email.cek_wrapped，而是存在 timelock_key 表
// （email_id 1:1），email.timelock_until 记解锁时刻、cek_wrapped 留空——
// 解锁前任何人都解不开正文（连发件人自己的已发送副本也一样，行为一致）。
// 放行两条路（都幂等）：
//  1. 懒释放：读列表/最新邮件/单封时，先把本用户已到期的包裹写回 email 行；
//  2. cron 扫表：每小时把全站已到期的包裹写回（同时补跑该信的转发/规则，
//     见 email-service.processDeliveredMix——时间锁与混淆共用同一补跑入口，
//     避免到期信的转发/规则被漏掉）。
// 时间一律用服务端时钟、'YYYY-MM-DD HH:mm:ss' UTC 格式（与 email.createTime
// 同格式，字典序即时间序）；只接受未来的解锁时刻（已过去的按不锁处理）。
import orm from '../entity/orm';
import email from '../entity/email';
import timelockKey from '../entity/timelock-key';
import { eq, and, sql, lte } from 'drizzle-orm';

const MAX_TIMELOCK_DAYS = 365;

const timelockService = {

	// 'YYYY-MM-DD HH:mm:ss' UTC（与 email.createTime 同格式）。
	nowIso(date = new Date()) {
		return date.toISOString().slice(0, 19).replace('T', ' ');
	},

	// 校验并归一化解锁时刻：非法/过去/超过 365 天 → 返回 ''（按不锁处理）。
	resolveUnlockAt(unlockAt) {
		if (!unlockAt) return '';
		let d = null;
		if (typeof unlockAt === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(unlockAt)) {
			d = new Date(unlockAt.replace(' ', 'T') + 'Z');
		} else if (typeof unlockAt === 'number' || /^\d+$/.test(String(unlockAt || ''))) {
			d = new Date(Number(unlockAt));
		} else if (typeof unlockAt === 'string') {
			const parsed = Date.parse(unlockAt);
			if (!isNaN(parsed)) d = new Date(parsed);
		}
		if (!d || isNaN(d.getTime())) return '';
		const now = Date.now();
		if (d.getTime() <= now) return '';
		if (d.getTime() > now + MAX_TIMELOCK_DAYS * 86400000) return '';
		return this.nowIso(d);
	},

	// 发信时暂存 CEK 包裹（email 行建好后调用；行里 cek_wrapped 保持为空）。
	async holdKey(c, emailId, { cekWrapped, cekAlg, unlockAt }) {
		if (!emailId || !cekWrapped || !unlockAt) return;
		try {
			await orm(c).insert(timelockKey).values({
				emailId: Number(emailId),
				cekWrapped: String(cekWrapped).slice(0, 8192),
				cekAlg: String(cekAlg || 'sym').slice(0, 32),
				unlockAt,
				released: 0
			}).run();
		} catch (e) {
			console.error('时间锁暂存密钥失败:', e.message);
		}
	},

	// 释放一封信的密钥（幂等）：把包裹写回 email 行，清掉 timelock_key 行。
	async releaseOne(c, emailId) {
		try {
			const key = await orm(c).select().from(timelockKey)
				.where(eq(timelockKey.emailId, Number(emailId))).get();
			if (!key || key.released === 1) return false;
			if (!key.unlockAt || key.unlockAt > this.nowIso()) return false;
			await orm(c).update(email).set({
				cekWrapped: key.cekWrapped || '',
				cekAlg: key.cekAlg || ''
			}).where(eq(email.emailId, Number(emailId))).run();
			await orm(c).delete(timelockKey).where(eq(timelockKey.emailId, Number(emailId))).run();
			return true;
		} catch (e) {
			return false;
		}
	},

	// 懒释放：把某用户所有已到期的包裹写回（列表/最新邮件/读信前调用）。
	// 返回释放的 email_id 列表（供调用方补跑转发/规则）。
	async releaseDueForUser(c, userId) {
		const now = this.nowIso();
		try {
			const rows = await orm(c).select({ emailId: email.emailId })
				.from(email)
				.where(and(
					eq(email.userId, Number(userId)),
					sql`${email.timelockUntil} != ''`,
					lte(email.timelockUntil, now)
				)).all();
			const released = [];
			for (const r of rows) {
				if (await this.releaseOne(c, r.emailId)) released.push(r.emailId);
			}
			return released;
		} catch (e) {
			return [];
		}
	},

	// cron 扫表：全站已到期的包裹全部写回（每小时跑一次）。
	// 返回释放的 email_id 列表（调用方据此补跑转发/规则与通知）。
	async releaseDueAll(c) {
		const now = this.nowIso();
		try {
			const rows = await orm(c).select({ emailId: email.emailId })
				.from(email)
				.where(and(
					sql`${email.timelockUntil} != ''`,
					lte(email.timelockUntil, now)
				)).all();
			const released = [];
			for (const r of rows) {
				if (await this.releaseOne(c, r.emailId)) released.push(r.emailId);
			}
			return released;
		} catch (e) {
			return [];
		}
	}
};

export default timelockService;
