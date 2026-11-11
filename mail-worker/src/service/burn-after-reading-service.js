// 斯诺登第四批 P1-3：阅后即焚邮件——加固层（新增服务，不改旧文件）。
// 现状核实（2026-11-11）：核心链路上一批（v3_14DB）已实现并在跑——
// email 表已有 expire_at / burn_after_read / expire_group 三列；
// email-service.resolveExpiry() 在发信时刻算过期时间；read(opened=true)
// 时按 expireGroup 一起删收件人 + 发件人已发送副本；sweepExpired()
// 由 cron 每 30 分钟兜底清过期信；列表对过期信只留墓碑（内容剥离）。
// 本批补两个缺口：
//   ① burn（阅后即焚）不限 E2EE 也能选：任务要求“发 E2EE 信时可选”——
//      明文信阅后即焚没有意义（服务端、备份、日志都可能留底），且会给
//      用户“已彻底销毁”的假安全感。本模块强制：burn 只允许 e2ee=1，
//      明文信选 burn 时自动降级为不过期并返回原因（不静默改写）。
//      定时自毁（1h/1d/7d/30d）沿用现有行为：不限 E2EE。
//   ② 焚毁无留痕：read() 按组物理删除后不留任何记录，管理员无法
//      事后确认“某封信确实被焚毁”。recordBurnReceipt() 只记元数据
//      （组标识、销毁份数、读者 userId、时间），不记主题与正文。
// 接线点（需改 email-service.js，审计员文件中，本批不碰，补丁见报告）：
//   发信入口 executeSend 调 resolveBurnPolicy() 取代直接调 resolveExpiry()
//   的 burn 分支；read() 的 burn 分支在 physicsDelete 后调
//   recordBurnReceipt()。

import orm from '../entity/orm';
import email from '../entity/email';
import adminAuditService from './admin-audit-service';
import { and, count, eq } from 'drizzle-orm';

export const BURN_EXPIRE_DURATIONS = {
	'1h': 3600 * 1000,
	'1d': 24 * 3600 * 1000,
	'7d': 7 * 24 * 3600 * 1000,
	'30d': 30 * 24 * 3600 * 1000,
};

function randomGroupId() {
	try {
		return `burn_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
	} catch (e) {
		return `burn_${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(16)}`;
	}
}

export function formatDbTime(ms) {
	return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// 阅后即焚策略判定（纯函数，可单测）：
// - expireOption=burn 且 e2ee≠1 → 降级为不过期，allowed=false，reason=burn_requires_e2ee。
// - expireOption=burn 且 e2ee=1 → 允许，burnAfterRead=1，不设 expireAt。
// - 定时选项 → 允许，expireAt 用服务端时钟算（调用方传 nowMs；默认 Date.now()）。
// - none / 非法值 → 不过期。
export function resolveBurnPolicy({ e2ee = 0, expireOption = 'none', nowMs = Date.now() } = {}) {
	const empty = { expireAt: '', burnAfterRead: 0, expireGroup: '', allowed: true, downgraded: false, reason: '' };
	if (!expireOption || expireOption === 'none') return empty;
	if (expireOption === 'burn') {
		if (Number(e2ee) !== 1) {
			return { ...empty, allowed: false, downgraded: true, reason: 'burn_requires_e2ee' };
		}
		return { expireAt: '', burnAfterRead: 1, expireGroup: randomGroupId(), allowed: true, downgraded: false, reason: '' };
	}
	const duration = BURN_EXPIRE_DURATIONS[expireOption];
	if (!duration) return empty;
	return {
		expireAt: formatDbTime(nowMs + duration),
		burnAfterRead: 0,
		expireGroup: randomGroupId(),
		allowed: true,
		downgraded: false,
		reason: '',
	};
}

const burnAfterReadingService = {

	resolveBurnPolicy,

	// 焚毁留痕：只记元数据，不记主题/正文/收件人邮箱。永不抛错。
	async recordBurnReceipt(c, { actorUserId = 0, expireGroup = '', burnedEmailIds = [], readerUserId = 0 } = {}) {
		try {
			await adminAuditService.recordAdminAction(c, {
				actorUserId,
				action: 'email:burned',
				targetId: String(expireGroup || ''),
				detail: {
					burnedCount: Array.isArray(burnedEmailIds) ? burnedEmailIds.length : 0,
					readerUserId: Number(readerUserId) || 0,
				},
			});
			return { ok: true };
		} catch (e) {
			console.error('焚毁留痕失败:', e.message);
			return { ok: false };
		}
	},

	// 核验某组是否已彻底焚毁（应为 0 行残留）。调用方须先确认该组属于本人
	// （至少一行 userId=调用者），否则返回 { ok:false, reason:'not_yours' }。
	async verifyGroupBurned(c, userId, expireGroup) {
		const group = String(expireGroup || '');
		if (!group) return { ok: false, reason: 'empty_group' };
		const totalRow = await orm(c).select({ n: count() }).from(email)
			.where(eq(email.expireGroup, group)).get();
		const remaining = totalRow ? totalRow.n : 0;
		if (remaining === 0) return { ok: true, expireGroup: group, remaining: 0, burned: true };
		// 还有残留：必须至少一行属于调用者，否则不透露他人邮件的存在性。
		const mineRow = await orm(c).select({ n: count() }).from(email)
			.where(and(eq(email.expireGroup, group), eq(email.userId, Number(userId)))).get();
		if (!mineRow || mineRow.n === 0) return { ok: false, reason: 'not_yours' };
		return { ok: true, expireGroup: group, remaining, burned: false };
	},
};

export default burnAfterReadingService;
