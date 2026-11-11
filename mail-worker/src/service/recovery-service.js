// Phase 8 F：账号恢复（恢复码 + 备用邮箱）。
// 恢复码：注册时生成一组（只显示一次）；明文只返回给本人一次，库里只存
// SHA-256 哈希，日志里永不出现明文。重新生成会作废旧码；用过即作废。
// 备用邮箱：可选填，用于收恢复链接；链接 token 同样只存哈希、1 小时有效、一次性。
// 限流：统一走 Layer 1 kernel/ratelimit.consume（固定窗口；维度 key 经 SHA-256
// 摘要，KV 里不存邮箱/IP 明文）。接口语义与 B 的设计文档一致。
// 注意：恢复接口的错误一律通用口径（不透露账号是否存在、恢复码是否有效），
// 恢复成功后清掉该用户全部会话（AUTH_INFO），旧登录态即刻失效。
import ratelimit from '../kernel/ratelimit';
import orm from '../entity/orm';
import userRecoveryCode from '../entity/user-recovery-code';
import userRecoveryEmail from '../entity/user-recovery-email';
import passwordResetToken from '../entity/password-reset-token';
import account from '../entity/account';
import userService from './user-service';
import emailService from './email-service';
import cryptoUtils from '../utils/crypto-utils';
import { evaluatePasswordStrength } from '../utils/password-strength';
import BizError from '../error/biz-error';
import KvConst from '../const/kv-const';
import { t } from '../i18n/i18n';
import { and, desc, eq } from 'drizzle-orm';

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_MAX_ATTEMPTS = 5;
export const RECOVERY_CODE_WINDOW_SECONDS = 900; // 15 分钟
export const RECOVERY_LINK_MAX_ATTEMPTS = 3;
export const RECOVERY_LINK_WINDOW_SECONDS = 3600; // 1 小时
export const RESET_TOKEN_TTL_MS = 3600 * 1000; // 1 小时

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 0/O/1/I/L
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const encoder = new TextEncoder();

// 恢复链接只能指回本站：Origin/Referer 须与本站同源（请求 Host 或本站
// 规范域名），否则不发 token、不发邮件（返回仍是通用 { requested: true }，
// 不透露失败原因）。曾直接用请求头拼链接，攻击者可把 token 骗到任意域名上。
// 无 Origin 时回落请求 Host（浏览器 POST 一定带 Origin；只剩这一种时才
// 用规范域名兜底，绝不信任调用方给的任意域名）。
const RESET_LINK_SITE_HOSTS = ['aevorynthtech.com'];

function resolveResetLinkBase(c, origin) {
	const rawOrigin = typeof origin === 'string' ? origin.trim() : '';
	let host = '';
	try {
		host = String(c?.req?.header?.('host') || '').split(':')[0].toLowerCase();
	} catch (e) { host = ''; }
	if (!rawOrigin) {
		if (host) return `https://${host}`;
		return `https://${RESET_LINK_SITE_HOSTS[0]}`;
	}
	let u;
	try {
		u = new URL(rawOrigin);
	} catch (e) {
		return '';
	}
	const hn = u.hostname.toLowerCase();
	const isLocal = hn === 'localhost' || hn === '127.0.0.1' || hn === '[::1]';
	if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocal)) {
		return '';
	}
	if (host && hn === host) {
		return u.origin;
	}
	if (RESET_LINK_SITE_HOSTS.includes(hn) || RESET_LINK_SITE_HOSTS.some(h => hn === `www.${h}`)) {
		return u.origin;
	}
	return '';
}

async function sha256Hex(value) {
	const buf = await crypto.subtle.digest('SHA-256', encoder.encode(value));
	return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomCode() {
	const bytes = new Uint8Array(12);
	crypto.getRandomValues(bytes);
	const chars = Array.from(bytes).map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]);
	return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
}

function randomTokenHex() {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 最简 KV 固定窗口限流（待 B 的 kernel/ratelimit.js 交付后统一替换）。
// 返回 { allowed, remaining }；KV 读写失败时放行（不限流，不阻断恢复流程）。
// 限流：Layer 1 kernel/ratelimit.consume（固定窗口；维度经 SHA-256 摘要）。
async function checkRateLimit(c, key, max, windowSeconds) {
	const dimKey = await ratelimit.dimensionKey(key);
	const res = await ratelimit.consume(c, 'recovery:' + dimKey, max, windowSeconds);
	return { allowed: res.allowed, remaining: Math.max(0, max - res.count) };
}

async function invalidateSessions(c, userId) {
	try {
		await c.env.kv.delete(KvConst.AUTH_INFO + userId);
	} catch (e) {
		console.error('恢复后清会话失败:', e.message);
	}
}

function assertNewPasswordOk(newPassword) {
	if (typeof newPassword !== 'string' || newPassword.length < 6) {
		throw new BizError(t('pwdMinLength'), 400);
	}
	const strength = evaluatePasswordStrength(newPassword);
	if (!strength.passed) {
		throw new BizError(`${t('recoveryWeakPassword')}: ${strength.reasons.join(', ')}`, 400);
	}
}

const recoveryService = {

	// 生成一组新恢复码（需先验当前密码；旧码全部作废）。
	// 返回明文码（仅此一次）；调用方必须当场展示、不得存日志、不得再次返回。
	async generateCodes(c, userId, password) {
		const userRow = await userService.selectById(c, userId);
		if (!userRow) {
			throw new BizError(t('recoveryUserNotFound'), 404);
		}
		if (!password || !await cryptoUtils.verifyPassword(password, userRow.salt, userRow.password)) {
			throw new BizError(t('recoveryWrongPassword'), 400);
		}
		return this._issueCodes(c, userId);
	},

	// 注册时生成恢复码（无密码可验，仅限注册流程在服务端直接调用；
	// 不挂任何 HTTP 路由，绝不对外暴露。返回明文码仅此一次，由注册
	// 接口当场返回给用户展示。接线点见汇报，由总协调在 login-service.js
	// 的 register() 成功后加一行调用）。
	async generateCodesForRegistration(c, userId) {
		const userRow = await userService.selectById(c, userId);
		if (!userRow) {
			throw new BizError(t('recoveryUserNotFound'), 404);
		}
		return this._issueCodes(c, userId);
	},

	// 发码公共实现：旧码全部作废，写 10 个新码的 SHA-256 哈希。
	async _issueCodes(c, userId) {
		const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomCode());
		await orm(c).delete(userRecoveryCode).where(eq(userRecoveryCode.userId, userId)).run();
		for (const code of codes) {
			await orm(c).insert(userRecoveryCode).values({
				userId,
				codeHash: await sha256Hex(code),
				used: 0
			}).run();
		}
		return { codes, count: codes.length };
	},

	// 剩余可用恢复码数（不返回任何码本身）。
	async remainingCodes(c, userId) {
		const rows = await orm(c).select().from(userRecoveryCode)
			.where(and(eq(userRecoveryCode.userId, userId), eq(userRecoveryCode.used, 0))).all();
		return rows.length;
	},

	// 凭恢复码重设密码（公开接口）。错误一律通用口径，不透露账号/码是否存在。
	async resetByCode(c, { email, code, newPassword, ip = '' } = {}) {
		const normEmail = String(email || '').trim().toLowerCase();
		const limit = await checkRateLimit(c, `recovery_code:${normEmail}:${ip}`, RECOVERY_CODE_MAX_ATTEMPTS, RECOVERY_CODE_WINDOW_SECONDS);
		if (!limit.allowed) {
			throw new BizError(t('recoveryTooManyAttempts'), 429);
		}
		const userRow = normEmail ? await userService.selectByEmail(c, normEmail) : null;
		// 查无此人也走同样的通用错误（不透露账号是否存在），且不做密码强度校验。
		if (!userRow) {
			throw new BizError(t('recoveryInvalid'), 400);
		}
		assertNewPasswordOk(newPassword);
		const hash = await sha256Hex(String(code || '').trim().toUpperCase());
		const rows = await orm(c).select().from(userRecoveryCode)
			.where(and(eq(userRecoveryCode.userId, userRow.userId), eq(userRecoveryCode.used, 0))).all();
		const matched = rows.find(r => r.codeHash === hash);
		if (!matched) {
			throw new BizError(t('recoveryInvalid'), 400);
		}
		await orm(c).update(userRecoveryCode).set({ used: 1, usedAt: new Date().toISOString() })
			.where(eq(userRecoveryCode.codeId, matched.codeId)).run();
		await userService.resetPassword(c, { password: newPassword }, userRow.userId);
		await invalidateSessions(c, userRow.userId);
		return { ok: true };
	},

	// ---- 备用邮箱 ----
	async setBackupEmail(c, userId, backupEmail) {
		const value = String(backupEmail || '').trim().toLowerCase();
		if (!EMAIL_RE.test(value)) {
			throw new BizError(t('recoveryBackupEmailInvalid'), 400);
		}
		const userRow = await userService.selectById(c, userId);
		if (userRow && userRow.email.toLowerCase() === value) {
			throw new BizError(t('recoveryBackupEmailSameAsAccount'), 400);
		}
		const existing = await orm(c).select().from(userRecoveryEmail)
			.where(eq(userRecoveryEmail.userId, userId)).get();
		if (existing) {
			await orm(c).update(userRecoveryEmail).set({ backupEmail: value, verified: 0 })
				.where(eq(userRecoveryEmail.userId, userId)).run();
		} else {
			await orm(c).insert(userRecoveryEmail).values({ userId, backupEmail: value, verified: 0 }).run();
		}
		return { backupEmail: value, verified: 0 };
	},

	async getBackupEmail(c, userId) {
		const row = await orm(c).select().from(userRecoveryEmail)
			.where(eq(userRecoveryEmail.userId, userId)).get();
		return row ? { backupEmail: row.backupEmail, verified: row.verified } : null;
	},

	async deleteBackupEmail(c, userId) {
		await orm(c).delete(userRecoveryEmail).where(eq(userRecoveryEmail.userId, userId)).run();
		return { ok: true };
	},

	// ---- 备用邮箱恢复链接 ----
	// 请求恢复链接（公开接口）。无论账号/备用邮箱是否存在，一律返回
	// { requested: true }（不透露账号是否存在）；token 明文只出现在邮件
	// 链接里，不进返回值、不进日志。投递走用户首个发信账号（emailService.send，
	// best-effort：账号不存在或发信被限时只记日志，token 仍有效，恢复码可作后备）。
	async requestResetLink(c, { email, ip = '', origin = '' } = {}) {
		const normEmail = String(email || '').trim().toLowerCase();
		const limit = await checkRateLimit(c, `recovery_link:${normEmail}:${ip}`, RECOVERY_LINK_MAX_ATTEMPTS, RECOVERY_LINK_WINDOW_SECONDS);
		if (!limit.allowed) {
			throw new BizError(t('recoveryTooManyAttempts'), 429);
		}
		const userRow = normEmail ? await userService.selectByEmail(c, normEmail) : null;
		if (!userRow) {
			return { requested: true };
		}
		const backup = await this.getBackupEmail(c, userRow.userId);
		if (!backup || !backup.backupEmail) {
			return { requested: true };
		}
		// 链接域名校验（见文件顶部 resolveResetLinkBase）：Origin 不可信时
		// 不发 token——token 只应出现在指回本站的链接里。
		const base = resolveResetLinkBase(c, origin);
		if (!base) {
			return { requested: true };
		}
		const token = randomTokenHex();
		const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
		await orm(c).insert(passwordResetToken).values({
			userId: userRow.userId,
			tokenHash: await sha256Hex(token),
			expiresAt,
			used: 0
		}).run();
		// 投递（best-effort，永不抛错、不阻断返回）。
		try {
			const accountRow = await orm(c).select().from(account)
				.where(and(eq(account.userId, userRow.userId), eq(account.isDel, 0))).limit(1).get();
			if (accountRow) {
				const link = `${base}/recovery?email=${encodeURIComponent(normEmail)}&token=${token}`;
				await emailService.send(c, {
					accountId: accountRow.accountId,
					receiveEmail: [backup.backupEmail],
					subject: t('recoveryResetSubject'),
					text: `${t('recoveryResetText')}\n${link}\n${t('recoveryResetExpiry')}`,
					content: `<p>${t('recoveryResetText')}</p><p><a href="${link}">${link}</a></p><p>${t('recoveryResetExpiry')}</p>`
				}, userRow.userId);
			} else {
				console.error('恢复链接未投递：用户无发信账号，token 仍有效，恢复码可作后备');
			}
		} catch (e) {
			console.error('恢复链接投递失败（token 仍有效）:', e.message);
		}
		return { requested: true };
	},

	// 凭恢复链接 token 重设密码（公开接口）。错误一律通用口径。
	async resetByToken(c, { email, token, newPassword, ip = '' } = {}) {
		const normEmail = String(email || '').trim().toLowerCase();
		const limit = await checkRateLimit(c, `recovery_token:${normEmail}:${ip}`, RECOVERY_CODE_MAX_ATTEMPTS, RECOVERY_CODE_WINDOW_SECONDS);
		if (!limit.allowed) {
			throw new BizError(t('recoveryTooManyAttempts'), 429);
		}
		const userRow = normEmail ? await userService.selectByEmail(c, normEmail) : null;
		if (!userRow) {
			throw new BizError(t('recoveryInvalid'), 400);
		}
		assertNewPasswordOk(newPassword);
		const hash = await sha256Hex(String(token || '').trim());
		const rows = await orm(c).select().from(passwordResetToken)
			.where(and(eq(passwordResetToken.userId, userRow.userId), eq(passwordResetToken.used, 0)))
			.orderBy(desc(passwordResetToken.tokenId)).all();
		const now = new Date().toISOString();
		const matched = rows.find(r => r.tokenHash === hash && r.expiresAt > now);
		if (!matched) {
			throw new BizError(t('recoveryInvalid'), 400);
		}
		await orm(c).update(passwordResetToken).set({ used: 1, usedAt: now })
			.where(eq(passwordResetToken.tokenId, matched.tokenId)).run();
		await userService.resetPassword(c, { password: newPassword }, userRow.userId);
		await invalidateSessions(c, userRow.userId);
		return { ok: true };
	}
};

export default recoveryService;
