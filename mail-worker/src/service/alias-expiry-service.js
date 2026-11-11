// 斯诺登第四批 P2-5：自动过期别名（新增服务，不改旧文件）。
// 现状：email_alias 只有 status 手动停用（0=启用 / 1=停用），无有效期。
// 本服务：别名可设有效期（1/7/30/90/365 天，0=不限期），到期由
// sweepExpiredAliases() 自动停用（status=1）并写 alias:expired 审计。
// 收信入口判定 isAliasReceivingBlocked() 供 email-service.receive 接线。
// 接线点（需改 email-service.js / email.js 收信分支，审计员文件中，
// 本批不碰，补丁见报告）：收信时查别名 status 之前先调本服务——
// 已过期未扫到的别名也拒收（不依赖 cron 是否准时跑）。

import orm from '../entity/orm';
import emailAlias from '../entity/email-alias';
import aliasExpiry from '../entity/alias-expiry';
import adminAuditService from './admin-audit-service';
import { and, eq } from 'drizzle-orm';
import BizError from '../error/biz-error';

export const ALIAS_EXPIRY_DAYS = [0, 1, 7, 30, 90, 365];

export function formatDbTime(ms) {
	return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// 有效期换算（纯函数）：days=0 → 不限期（''）；其余按现在算。
export function resolveAliasExpiry(days, nowMs = Date.now()) {
	const d = Number(days);
	if (!d || !ALIAS_EXPIRY_DAYS.includes(d)) return '';
	return formatDbTime(nowMs + d * 24 * 3600 * 1000);
}

export function isExpiredAt(expiresAt, nowMs = Date.now()) {
	if (!expiresAt) return false;
	return String(expiresAt) <= formatDbTime(nowMs);
}

const aliasExpiryService = {

	resolveAliasExpiry,
	isExpiredAt,

	// 附表懒创建：部署无需额外迁移；旧库首次调用即建表。
	async ensureTable(c) {
		await c.env.db.prepare(
			`CREATE TABLE IF NOT EXISTS alias_expiry (
				alias_id INTEGER PRIMARY KEY,
				user_id INTEGER NOT NULL,
				expires_at TEXT NOT NULL DEFAULT '',
				notified INTEGER NOT NULL DEFAULT 0,
				create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`
		).run();
	},

	// 校验别名归属：必须是本人的、未删除的别名。
	async _ownAlias(c, userId, aliasId) {
		const row = await orm(c).select().from(emailAlias)
			.where(and(eq(emailAlias.aliasId, Number(aliasId)), eq(emailAlias.userId, Number(userId)))).get();
		if (!row || row.isDel === 1) {
			throw new BizError('别名不存在', 404);
		}
		return row;
	},

	// 设有效期：days ∈ {0,1,7,30,90,365}，0=清除有效期（不限期）。
	async setExpiry(c, userId, aliasId, days) {
		const d = Number(days);
		if (!ALIAS_EXPIRY_DAYS.includes(d)) {
			throw new BizError('有效期只能是 0/1/7/30/90/365 天', 400);
		}
		const alias = await this._ownAlias(c, userId, aliasId);
		await this.ensureTable(c);
		const expiresAt = resolveAliasExpiry(d);
		await orm(c).delete(aliasExpiry).where(eq(aliasExpiry.aliasId, alias.aliasId)).run();
		if (d !== 0) {
			await orm(c).insert(aliasExpiry).values({
				aliasId: alias.aliasId,
				userId: Number(userId),
				expiresAt,
				notified: 0,
			}).run();
		}
		return { ok: true, aliasId: alias.aliasId, address: alias.address, expiresAt };
	},

	async getExpiry(c, userId, aliasId) {
		const alias = await this._ownAlias(c, userId, aliasId);
		await this.ensureTable(c);
		const row = await orm(c).select().from(aliasExpiry)
			.where(eq(aliasExpiry.aliasId, alias.aliasId)).get();
		return {
			aliasId: alias.aliasId,
			address: alias.address,
			status: alias.status,
			expiresAt: row ? row.expiresAt : '',
			expired: row ? isExpiredAt(row.expiresAt) : false,
		};
	},

	// 别名还能收信吗（供收信入口调）：状态停用或已过有效期 → 拒收。
	// address 全局唯一，按地址查。
	async isAliasReceivingBlocked(c, address) {
		const addr = String(address || '').toLowerCase();
		if (!addr) return { blocked: false };
		const alias = await orm(c).select().from(emailAlias)
			.where(eq(emailAlias.address, addr)).get();
		if (!alias || alias.isDel === 1) return { blocked: false, reason: 'not_alias' };
		if (alias.status === 1) return { blocked: true, reason: 'disabled' };
		await this.ensureTable(c);
		const row = await orm(c).select().from(aliasExpiry)
			.where(eq(aliasExpiry.aliasId, alias.aliasId)).get();
		if (row && isExpiredAt(row.expiresAt)) {
			return { blocked: true, reason: 'expired', expiresAt: row.expiresAt };
		}
		return { blocked: false };
	},

	// 到期清扫（cron 调，best-effort 永不抛错）：把已过有效期且仍启用的
	// 别名批量停用（status=1），并逐条写 alias:expired 审计。
	async sweepExpiredAliases(c) {
		try {
			await this.ensureTable(c);
			const nowStr = formatDbTime(Date.now());
			const rows = await c.env.db.prepare(
				`SELECT alias_id AS aliasId FROM alias_expiry WHERE expires_at != '' AND expires_at <= ? LIMIT 200`
			).bind(nowStr).all();
			const ids = (rows.results || []).map(r => r.aliasId).filter(Boolean);
			if (!ids.length) return { swept: 0, aliasIds: [] };
			const swept = [];
			for (const aliasId of ids) {
				const alias = await orm(c).select().from(emailAlias)
					.where(eq(emailAlias.aliasId, aliasId)).get();
				if (alias && alias.status === 0 && alias.isDel !== 1) {
					await orm(c).update(emailAlias).set({ status: 1 })
						.where(eq(emailAlias.aliasId, aliasId)).run();
					swept.push(aliasId);
					try {
						await adminAuditService.recordAdminAction(c, {
							actorUserId: 0,
							action: 'alias:expired',
							targetId: String(aliasId),
							detail: { address: alias.address },
						});
					} catch (e) { /* 审计失败不阻断清扫 */ }
				}
				await orm(c).delete(aliasExpiry).where(eq(aliasExpiry.aliasId, aliasId)).run();
			}
			return { swept: swept.length, aliasIds: swept };
		} catch (e) {
			console.error('别名到期清扫失败:', e.message);
			return { swept: 0, aliasIds: [], error: e.message };
		}
	},
};

export default aliasExpiryService;
