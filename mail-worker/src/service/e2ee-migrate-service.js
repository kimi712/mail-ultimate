// E2EE 密钥重包 + 暴露状态（2026-11-12 uwu 第 1+2 步）。
// 新模型：一个口令，邮件密钥 = HKDF(PBKDF2-600k(口令))，登录时浏览器已派生。
// 老模型（加密密码独立）的存量 sym 包裹由 PBKDF2-210k(加密密码, e2eeSalt)
// 包着；暴露（加密密码=登录密码）或改密后，浏览器用旧 KEK 解出 CEK、再用
// 新邮件密钥包回去，分批调 rewrap 提交。服务端只校验归属与信封格式，
// 不碰任何明文、CEK、KEK。
// 只处理 cek_alg='sym' 的包裹：ML-KEM 包裹不依赖 KEK，不用重包；旧版
// 无 CEK 的邮件（cek_alg=''，正文直接用 KEK 加密）不在此列（需整信重加密，
// 另案处理；当前两站 E2EE 邮件数为 0，本接口现阶段基本是空集操作）。
import orm from '../entity/orm';
import email from '../entity/email';
import timelockKey from '../entity/timelock-key';
import user from '../entity/user';
import { and, eq, ne } from 'drizzle-orm';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';
import userContext from '../security/user-context';

const MAX_BATCH = 50;
const MAX_LIMIT = 500;
const ENVELOPE_PREFIX = 'e2ee:v1:';

// e2ee:v1:<base64> 信封格式校验（只验形状，不碰内容）。
function isValidEnvelope(wrapped) {
	if (typeof wrapped !== 'string' || !wrapped.startsWith(ENVELOPE_PREFIX)) return false;
	const b64 = wrapped.slice(ENVELOPE_PREFIX.length);
	if (!b64 || b64.length > 20000) return false;
	return /^[A-Za-z0-9+/=]+$/.test(b64);
}

const e2eeMigrateService = {

	// 当前用户 cek_alg='sym' 的包裹：email 行（live）+ 未释放的时间锁行
	// （包裹只在 timelock_key 里）。分页 {limit, offset}，默认 200/0。
	// 两路各自取 limit+offset 再合并切片（直接对两路分别分页会漏/重）。
	async listWraps(c, userId, { limit = 200, offset = 0 } = {}) {
		if (userContext.isDecoy(c)) {
			return { items: [], total: 0 };
		}
		const n = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || 200));
		const off = Math.max(0, Number(offset) || 0);
		const fetch = n + off;
		const emailRows = await orm(c).select({ emailId: email.emailId, wrapped: email.cekWrapped })
			.from(email)
			.where(and(
				eq(email.userId, userId),
				eq(email.cekAlg, 'sym'),
				ne(email.cekWrapped, '')
			))
			.limit(fetch).all();
		const tlRows = await orm(c).select({ emailId: timelockKey.emailId, wrapped: timelockKey.cekWrapped })
			.from(timelockKey)
			.innerJoin(email, eq(email.emailId, timelockKey.emailId))
			.where(and(
				eq(email.userId, userId),
				eq(timelockKey.cekAlg, 'sym'),
				eq(timelockKey.released, 0),
				ne(timelockKey.cekWrapped, '')
			))
			.limit(fetch).all();
		const all = [
			...emailRows.map(r => ({ emailId: r.emailId, source: 'email', wrapped: r.wrapped })),
			...tlRows.map(r => ({ emailId: r.emailId, source: 'timelock', wrapped: r.wrapped })),
		];
		return { items: all.slice(off, off + n), total: all.length };
	},

	// 重包一批 sym 包裹：只验归属（行属当前用户）与信封格式，不碰明文。
	// 每批最多 50 个；返回实际更新数。
	async rewrap(c, userId, items) {
		if (userContext.isDecoy(c)) {
			throw new BizError(t('unauthorized'), 403);
		}
		if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BATCH) {
			throw new BizError(t('invalidParams'), 400);
		}
		let updated = 0;
		for (const item of items) {
			const emailId = Number(item?.emailId) || 0;
			const source = item?.source;
			const wrapped = item?.wrapped;
			if (!emailId || (source !== 'email' && source !== 'timelock') || !isValidEnvelope(wrapped)) {
				continue;
			}
			if (source === 'email') {
				const row = await orm(c).select().from(email).where(eq(email.emailId, emailId)).get();
				if (!row || Number(row.userId) !== Number(userId) || row.cekAlg !== 'sym') continue;
				await orm(c).update(email).set({ cekWrapped: wrapped })
					.where(eq(email.emailId, emailId)).run();
				updated += 1;
			} else {
				const tlRow = await orm(c).select().from(timelockKey).where(eq(timelockKey.emailId, emailId)).get();
				if (!tlRow || tlRow.cekAlg !== 'sym' || tlRow.released !== 0) continue;
				const mailRow = await orm(c).select().from(email).where(eq(email.emailId, emailId)).get();
				if (!mailRow || Number(mailRow.userId) !== Number(userId)) continue;
				await orm(c).update(timelockKey).set({ cekWrapped: wrapped })
					.where(eq(timelockKey.emailId, emailId)).run();
				updated += 1;
			}
		}
		return { updated };
	},

	// 写暴露状态：0=正常/已统一，1=已暴露，2=老模型未迁移。只写自己的行。
	async setExposure(c, userId, state) {
		if (userContext.isDecoy(c)) {
			throw new BizError(t('unauthorized'), 403);
		}
		const s = Number(state);
		if (![0, 1, 2].includes(s)) {
			throw new BizError(t('invalidParams'), 400);
		}
		await orm(c).update(user).set({ e2eeExposed: s }).where(eq(user.userId, userId)).run();
		return { exposed: s };
	},
};

export default e2eeMigrateService;
