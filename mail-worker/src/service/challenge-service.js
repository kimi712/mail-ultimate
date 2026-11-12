// $1000 安全悬赏挑战：公开状态页后端（无需登录）。
// 规则只加不改：奖金 $1000、截止 2026-11-18 23:59（北京时间）、
// 裁决规则与正式提交渠道以悬赏帖为准；这里的 submit 只是计数 + 回执，
// 不是裁决通道。暗号与加密密码只能由用户本人设定，本文件不创建挑战信、
// 不设定任何密码、不写任何暗号。
import BizError from '../error/biz-error';
import ratelimit from '../kernel/ratelimit';
import reqUtils from '../utils/req-utils';
import settingService from './setting-service';

// 暂停开关（2026-11-12 uwu 第 5 步）：setting.challenge_paused=1 时挑战暂停，
// status() 返回 paused: true、submit() 400 拒绝、/challenge 页只显示横幅。
// 读不到设置时默认不暂停（不把设置故障变成挑战不可用）。
async function isPaused(c) {
	try {
		const setting = await settingService.query(c);
		return Number(setting?.challengePaused || 0) === 1;
	} catch (e) {
		return false;
	}
}

// 截止日固定（北京时间），任何代码路径不得改动。
export const CHALLENGE_DEADLINE = '2026-11-18T23:59:00+08:00';
export const CHALLENGE_PRIZE_USD = 1000;
// 尝试提交限流：同一 IP 每小时最多 10 次（KV 固定窗口，防刷；
// 计数在 KV，不进 D1；KV 异常时 kernel/ratelimit fail-open 放行）。
const SUBMIT_LIMIT_PER_HOUR = 10;
const SUBMIT_WINDOW_SECONDS = 3600;
const MAX_INPUT_LENGTH = 2000;

async function sha256hex(str) {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
	return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 尝试统计：challenge_attempt 表未建（旧库未跑迁移）时降级返回空统计，
// 状态页照常显示“挑战信尚未发布”，不把 D1 错误抛给公开页。
async function attemptStats(c) {
	try {
		const row = await c.env.db.prepare(
			`SELECT COUNT(*) AS count, MAX(created_at) AS lastSubmittedAt FROM challenge_attempt`
		).first();
		return { count: row?.count || 0, lastSubmittedAt: row?.lastSubmittedAt || null };
	} catch (e) {
		console.warn('challenge_attempt 统计读取失败（表可能未建）:', e.message);
		return { count: 0, lastSubmittedAt: null };
	}
}

const challengeService = {

	// 存在证明：管理员账号（c.env.admin）最近一封 e2ee=1 的邮件
	// （不分收/发，取 email_id 最大的一封）。
	// 只返回主题、时间与密文信封（content 列）的 SHA-256 指纹，
	// 不返回任何邮件内容。信还没创建时 exists=false，其余字段为空。
	async status(c) {
		const stats = await attemptStats(c);
		const proof = { exists: false, subject: null, sentAt: null, ciphertextSha256: null };
		try {
			const admin = await c.env.db.prepare(
				`SELECT user_id FROM user WHERE email COLLATE NOCASE = ? AND is_del = 0 LIMIT 1`
			).bind(String(c.env.admin || '')).first();
			if (admin) {
				const row = await c.env.db.prepare(
					`SELECT subject, content, create_time FROM email
					 WHERE user_id = ? AND e2ee = 1 AND is_del = 0
					 ORDER BY email_id DESC LIMIT 1`
				).bind(admin.user_id).first();
				if (row) {
					proof.exists = true;
					proof.subject = row.subject || '';
					proof.sentAt = row.create_time || null;
					// 密文信封指纹：只证明“这封密文存在”，不泄露内容。
					proof.ciphertextSha256 = await sha256hex(String(row.content || ''));
				}
			}
		} catch (e) {
			console.warn('挑战信存在证明读取失败:', e.message);
		}
		return {
			deadline: CHALLENGE_DEADLINE,
			prizeUsd: CHALLENGE_PRIZE_USD,
			paused: await isPaused(c),
			...proof,
			attempts: stats
		};
	},

	// 尝试计数 + 回执：只存 sha256(phrase)、sha256(method)、回执 id、
	// 提交时间（created_at 由 D1 默认值写）。绝不存原文。
	// 正式裁决提交渠道以悬赏帖为准，这里不是交答案的地方。
	async submit(c, body) {
		if (await isPaused(c)) {
			throw new BizError('challenge paused', 400);
		}
		const phrase = typeof body?.phrase === 'string' ? body.phrase.trim() : '';
		const method = typeof body?.method === 'string' ? body.method.trim() : '';
		if (!phrase || !method) {
			throw new BizError('phrase and method are required', 400);
		}
		if (phrase.length > MAX_INPUT_LENGTH || method.length > MAX_INPUT_LENGTH) {
			throw new BizError('input too long', 400);
		}

		const ipKey = await ratelimit.dimensionKey(`challenge:ip:${reqUtils.getIp(c)}`);
		const res = await ratelimit.consume(c, 'challenge:ip:' + ipKey, SUBMIT_LIMIT_PER_HOUR, SUBMIT_WINDOW_SECONDS);
		if (!res.allowed) {
			throw new BizError('too many attempts, please try again later', 429);
		}

		const receiptId = crypto.randomUUID();
		const phraseHash = await sha256hex(phrase);
		const methodHash = await sha256hex(method);
		await c.env.db.prepare(
			`INSERT INTO challenge_attempt (phrase_hash, method_hash, receipt_id) VALUES (?, ?, ?)`
		).bind(phraseHash, methodHash, receiptId).run();
		const stats = await attemptStats(c);
		return { receiptId, count: stats.count };
	}
};

export default challengeService;
