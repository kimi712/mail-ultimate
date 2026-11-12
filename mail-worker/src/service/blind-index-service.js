// 可搜索加密（v3_16DB）：盲索引。
// 关键词在前端用用户自己的 KEK 做 HMAC-SHA256（归一化：小写、去标点、
// 长度 ≥2、去重、上限 50 个）生成 token，服务端只存 (email_id, user_id,
// token)，按 token 匹配——服务端永远看不到关键词明文与正文。
// 收发双方各用自己的 KEK 建索引（行按 user_id 区分），互不干扰；
// 发信时前端随信附带发送方的 token（存发送方名下）；收信方读信解密后，
// 前端再把用自己 KEK 算的 token 补上来（存收信方名下），之后收信方
// 才能搜到这封信。删信/删号时索引行随之清理。
// 诚实说明：这是可搜索加密（盲索引），不是全同态加密——服务端能看到
// “哪些信共享同一个关键词 token”（访问模式），看不到关键词本身与正文。
import orm from '../entity/orm';
import emailBlindIndex from '../entity/email-blind-index';
import { eq, and, sql } from 'drizzle-orm';

// 单封信 token 上限：真实关键词上限 50 + 假 token 填充 16（2026-11-12 白帽反馈修复），
// 服务端不区分真假、只按上限截断；假 token 由客户端生成，搜索只查真实 token。
const MAX_TOKENS_PER_MAIL = 70;
const MAX_TOKEN_LEN = 128;

const blindIndexService = {

	// 存一批 token（email_id + user_id 维度；重复 token 忽略）。
	async storeTokens(c, emailId, userId, tokens) {
		const list = (Array.isArray(tokens) ? tokens : [])
			.filter(t => typeof t === 'string' && t.length > 0 && t.length <= MAX_TOKEN_LEN)
			.slice(0, MAX_TOKENS_PER_MAIL);
		if (!emailId || !userId || !list.length) return 0;
		let n = 0;
		for (const token of [...new Set(list)]) {
			try {
				await orm(c).insert(emailBlindIndex).values({
					emailId: Number(emailId), userId: Number(userId), token
				}).run();
				n++;
			} catch (e) {
				// 主键冲突（重复 token）直接跳过
			}
		}
		return n;
	},

	// 按 token 查某用户命中的 email_id（去重，按 id 倒序，上限 50）。
	async searchIds(c, userId, token) {
		if (!userId || typeof token !== 'string' || !token || token.length > MAX_TOKEN_LEN) {
			return [];
		}
		try {
			const rows = await orm(c).select({ emailId: emailBlindIndex.emailId })
				.from(emailBlindIndex)
				.where(and(
					eq(emailBlindIndex.userId, Number(userId)),
					eq(emailBlindIndex.token, token)
				))
				.orderBy(sql`${emailBlindIndex.emailId} DESC`).limit(50).all();
			return [...new Set(rows.map(r => Number(r.emailId)))];
		} catch (e) {
			return [];
		}
	},

	// 删信时清理该信的索引行（physicsDelete 调用）。
	async deleteByEmailIds(c, emailIds) {
		const ids = (Array.isArray(emailIds) ? emailIds : [emailIds])
			.map(Number).filter(Boolean);
		if (!ids.length) return;
		try {
			for (const id of ids) {
				await orm(c).delete(emailBlindIndex)
					.where(eq(emailBlindIndex.emailId, id)).run();
			}
		} catch (e) { /* best-effort */ }
	},

	// 删号时清理该用户全部索引行（userService.physicsDelete 调用）。
	async deleteByUserId(c, userId) {
		try {
			await orm(c).delete(emailBlindIndex)
				.where(eq(emailBlindIndex.userId, Number(userId))).run();
		} catch (e) { /* best-effort */ }
	}
};

export default blindIndexService;
