// Phase 6：个性化安全中心后端（user_security 表）。
// 默认值：loginAlert=1（异地提醒开）、e2eeEnabled=0、retentionDays=0（永久保留）。
// retentionDays 只接受 0/30/90/365，其余值 400。读操作永不抛错，缺行返回默认值。
import orm from '../entity/orm';
import userSecurity from '../entity/user-security';
import userTotp from '../entity/user-totp';
import { account } from '../entity/account';
import { eq, sql } from 'drizzle-orm';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';
import userService from './user-service';
import passkeyService from './passkey-service';
import sessionService from './session-service';
import aliasService from './alias-service';
import userContext from '../security/user-context';

// 抗量子（v3_15DB）：ML-KEM-768 密钥尺寸（FIPS 203）。
// 封装公钥 1184 字节，解封私钥 2400 字节；前端以 base64 传公钥，
// 私钥经用户 KEK 加密后以 `e2ee:v1:<base64(iv||ct)>` 信封存放。
const MLKEM768_PUBLIC_KEY_BYTES = 1184;
const MLKEM768_PRIVATE_KEY_BYTES = 2400;
const MAX_MLKEM_PRIV_ENC_LEN = 8192;

const ALLOWED_RETENTION_DAYS = [0, 30, 90, 365];
const ALLOWED_AUTO_LOCK_MINUTES = [0, 5, 15, 30];
const DEFAULTS = { loginAlert: 1, e2eeEnabled: 0, retentionDays: 0, e2eeSalt: '', autoLockMinutes: 0 };

// Phase 8 B · 安全评分规则（总分 100，见 getScore；前端展示分项得分与改进建议）。
// 旧口径（TOTP 30 + Passkey 30 + 登录提醒 20 + 30 天无新 IP 20，只看最近 20 条
// 登录历史）已作废；新口径信号与分值如下，规则同时写进 PHASE8-B.md：
//   totp 20：开启得满分；
//   passkey 15：≥1 个得满分；
//   autoLock 10：闲置自动锁定 >0 分钟得满分；
//   e2ee 10：端到端加密开启得满分；
//   loginHistory 10：30 天内无新 IP 登录得满分（全量统计，不再只看最近 20 条）；
//   passwordStrength 10：登录时评估的密码强度桶（KV，0–5 级）：≥5→10，4→8，
//     3→6，2→3，≤1→0；从未评估过（Passkey 登录用户等）→ 5（未知取中值）；
//   passwordAge 10：密码年龄 <180 天→10，180–365 天→5，>365 天→0；年龄取
//     user.pwd_changed_at（v3_11DB 新增列，未迁移时回落为 user.create_time）；
//   sessions 5：会话 ≤3 个→5，4–5 个→3，>5 个→0；
//   auditAnomaly 10：30 天内无异常审计动作得满分；有则 0。异常动作：
//     login:rate_limited、login:locked、totp:failed、security:unlock_failed，
//     或 action 含 fail/lock/rate_limit。
// 评分只展示、不锁功能；读失败的信号按“未知取中值/0 分”兜底，永不抛错。
const SCORE_RULES = [
	{ key: 'totp', max: 20, suggestion: 'securityScoreTipTotp' },
	{ key: 'passkey', max: 15, suggestion: 'securityScoreTipPasskey' },
	{ key: 'autoLock', max: 10, suggestion: 'securityScoreTipAutoLock' },
	{ key: 'e2ee', max: 10, suggestion: 'securityScoreTipE2ee' },
	{ key: 'loginHistory', max: 10, suggestion: 'securityScoreTipLoginHistory' },
	{ key: 'passwordStrength', max: 10, suggestion: 'securityScoreTipPasswordStrength' },
	{ key: 'passwordAge', max: 10, suggestion: 'securityScoreTipPasswordAge' },
	{ key: 'sessions', max: 5, suggestion: 'securityScoreTipSessions' },
	{ key: 'auditAnomaly', max: 10, suggestion: 'securityScoreTipAuditAnomaly' }
];

// 密码强度桶（登录成功时由 login-service 写入 KV `pwd_strength:<userId>`，
// 值 {score: 0–5}，TTL 90 天；只存强度等级，不存密码本身）。
const PWD_STRENGTH_KV_PREFIX = 'pwd_strength:';
const ANOMALY_ACTIONS = ['login:rate_limited', 'login:locked', 'totp:failed', 'security:unlock_failed'];

const userSecurityService = {

	async get(c, userId) {
		// 诱饵会话（v3_16DB）：恒返回“什么都没开通”的默认状态（不透露真实的
		// E2EE / TOTP / 抗量子 / 自动锁定配置）。
		if (userContext.isDecoy(c)) {
			return { ...DEFAULTS, totpEnabled: false, mlkemEnabled: 0 };
		}
		try {
			const row = await orm(c).select().from(userSecurity).where(eq(userSecurity.userId, userId)).get();
			const base = row ? {
				loginAlert: row.loginAlert === 1 ? 1 : 0,
				e2eeEnabled: row.e2eeEnabled === 1 ? 1 : 0,
				retentionDays: row.retentionDays ?? 0,
				e2eeSalt: row.e2eeSalt || '',
				// 旧库无 auto_lock_minutes 列时（迁移未跑）读到 undefined，按 0 兜底。
				autoLockMinutes: ALLOWED_AUTO_LOCK_MINUTES.includes(row.autoLockMinutes) ? row.autoLockMinutes : 0,
				// 抗量子（v3_15DB）：只返回是否已生成 ML-KEM-768 密钥，不返回密钥本身
				// （公钥由专用接口按地址取，加密私钥只返回给本人）。
				mlkemEnabled: row.mlkemPublicKey ? 1 : 0
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
			return { ...base, totpEnabled, mlkemEnabled: base.mlkemEnabled ?? 0 };
		} catch (e) {
			return { ...DEFAULTS, totpEnabled: false, mlkemEnabled: 0 };
		}
	},

	async set(c, userId, params) {
		// 诱饵会话（v3_16DB）：拒绝改安全设置（不动真实配置）。
		if (userContext.isDecoy(c)) {
			throw new BizError(t('unauthorized'), 403);
		}
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

	// 抗量子（v3_15DB）：ML-KEM-768 密钥对存取。
	// 公钥可公开（供发件方包裹一次性密钥 CEK）；私钥经用户 KEK 加密后存放
	// （信封 `e2ee:v1:`），服务端无法解密，getMlkemPrivEnc 只返回给本人
	// （调用方 API 层只认登录用户自己的 userId）。
	// 重新生成会覆盖旧密钥对：旧 PQ 包裹的信将不可读，与现有“忘口令即丢数据”
	// 的语义一致，前端在重新生成前必须明确提示用户。
	async getMlkemPublicKey(c, userId) {
		try {
			const row = await orm(c).select().from(userSecurity).where(eq(userSecurity.userId, userId)).get();
			return row?.mlkemPublicKey || '';
		} catch (e) {
			return '';
		}
	},

	async getMlkemPrivEnc(c, userId) {
		// 诱饵会话（v3_16DB）：不返回加密私钥（即使它是 KEK 加密的密文）。
		if (userContext.isDecoy(c)) {
			return '';
		}
		try {
			const row = await orm(c).select().from(userSecurity).where(eq(userSecurity.userId, userId)).get();
			return row?.mlkemPrivEnc || '';
		} catch (e) {
			return '';
		}
	},

	async setMlkemKeys(c, userId, { publicKey, privEnc }) {
		// 诱饵会话（v3_16DB）：拒绝改抗量子密钥（不动真实密钥）。
		if (userContext.isDecoy(c)) {
			throw new BizError(t('unauthorized'), 403);
		}
		// 公钥必须是 1184 字节的 ML-KEM-768 封装密钥（base64）；
		// 私钥必须是 e2ee:v1: 信封（2400 字节解封密钥经 KEK 加密，base64 后约 3.2k 字符）。
		if (typeof publicKey !== 'string' || !publicKey) {
			throw new BizError(t('mlkemInvalidPublicKey'), 400);
		}
		let pubBytes;
		try {
			pubBytes = Uint8Array.from(atob(publicKey), ch => ch.charCodeAt(0));
		} catch (e) {
			throw new BizError(t('mlkemInvalidPublicKey'), 400);
		}
		if (pubBytes.length !== MLKEM768_PUBLIC_KEY_BYTES) {
			throw new BizError(t('mlkemInvalidPublicKey'), 400);
		}
		if (typeof privEnc !== 'string' || !privEnc.startsWith('e2ee:v1:')
			|| privEnc.length > MAX_MLKEM_PRIV_ENC_LEN) {
			throw new BizError(t('mlkemInvalidPrivateKey'), 400);
		}
		const row = await orm(c).select().from(userSecurity).where(eq(userSecurity.userId, userId)).get();
		if (row) {
			await orm(c).update(userSecurity).set({ mlkemPublicKey: publicKey, mlkemPrivEnc: privEnc })
				.where(eq(userSecurity.userId, userId)).run();
		} else {
			await orm(c).insert(userSecurity).values({
				userId, ...DEFAULTS, mlkemPublicKey: publicKey, mlkemPrivEnc: privEnc
			}).run();
		}
		return this.get(c, userId);
	},

	// 发件方按收件地址取收件人的 ML-KEM-768 公钥（供包裹 CEK）。
	// 先按账号精确匹配；匹配不到时按一次性别名解析到主人账号。
	// 返回 '' 表示对方未生成抗量子密钥（发件方回落对称包裹，前向保密仍然生效）。
	async getMlkemPublicKeyByEmail(c, email) {
		try {
			const addr = String(email || '').trim();
			if (!addr) return '';
			let rows = await orm(c).select().from(account)
				.where(sql`${account.email} COLLATE NOCASE = ${addr}`).all();
			let ownerId = rows[0]?.userId;
			if (!ownerId) {
				try {
					const hit = await aliasService.resolveAlias(c, addr);
					ownerId = hit?.account?.userId;
				} catch (e) {
					ownerId = undefined;
				}
			}
			if (!ownerId) return '';
			return this.getMlkemPublicKey(c, ownerId);
		} catch (e) {
			return '';
		}
	},

	// 异地提醒开关：关闭后登录历史照常记，只是不发提醒邮件。读失败默认开启（不丢提醒）。
	async isLoginAlertEnabled(c, userId) {
		const sec = await this.get(c, userId);
		return sec.loginAlert === 1;
	},

	async isE2eeEnabled(c, userId) {
		const sec = await this.get(c, userId);
		return sec.e2eeEnabled === 1;
	},

	// 密码强度桶读数（0–5），读不到返回 null（未知）。
	async _readPasswordStrength(c, userId) {
		try {
			const raw = await c.env.kv.get(PWD_STRENGTH_KV_PREFIX + userId, { type: 'json' });
			const score = raw && Number(raw.score);
			if (Number.isFinite(score) && score >= 0 && score <= 5) {
				return score;
			}
		} catch (e) {
			// 读失败视为未知
		}
		return null;
	},

	// 密码年龄（天）：优先 user.pwd_changed_at（v3_11DB 列，未迁移时 SQL 报错，
	// 回落为 user.create_time）；都读不到返回 null（未知）。
	async _readPasswordAgeDays(c, userId) {
		try {
			const userRow = await userService.selectById(c, userId);
			if (!userRow) {
				return null;
			}
			let changedAt = null;
			try {
				const row = await c.env.db.prepare('SELECT pwd_changed_at AS v FROM user WHERE user_id = ?')
					.bind(Number(userId)).first();
				changedAt = row && row.v ? row.v : null;
			} catch (e) {
				changedAt = null;
			}
			const base = changedAt || userRow.createTime;
			if (!base) {
				return null;
			}
			// D1 的 CURRENT_TIMESTAMP 是 UTC 无时区后缀，按 UTC 解析。
			let s = String(base).replace(' ', 'T');
			if (!/[Zz]$/.test(s) && !/[+-]\d{2}:?\d{2}$/.test(s)) {
				s += 'Z';
			}
			const ts = Date.parse(s);
			if (isNaN(ts)) {
				return null;
			}
			return Math.max(0, Math.floor((Date.now() - ts) / 86400000));
		} catch (e) {
			return null;
		}
	},

	// 安全评分（总分 100 + 分项 + 改进建议 key 列表）。只展示、不锁功能；永不抛错。
	async getScore(c, userId) {
		const scores = {};
		try {
			const sec = await this.get(c, userId);
			scores.totp = sec.totpEnabled ? 20 : 0;
			scores.autoLock = sec.autoLockMinutes > 0 ? 10 : 0;
			scores.e2ee = sec.e2eeEnabled ? 10 : 0;
		} catch (e) {
			scores.totp = 0;
			scores.autoLock = 0;
			scores.e2ee = 0;
		}
		try {
			const passkeys = await passkeyService.listCredentials(c, userId);
			scores.passkey = passkeys && passkeys.length > 0 ? 15 : 0;
		} catch (e) {
			scores.passkey = 0;
		}
		try {
			const row = await c.env.db.prepare(
				"SELECT COUNT(*) AS n FROM login_log WHERE user_id = ? AND is_new_ip = 1 AND create_time >= datetime('now', '-30 days')"
			).bind(Number(userId)).first();
			scores.loginHistory = Number(row?.n || 0) === 0 ? 10 : 0;
		} catch (e) {
			scores.loginHistory = 0;
		}
		const strength = await this._readPasswordStrength(c, userId);
		if (strength === null) {
			scores.passwordStrength = 5;
		} else if (strength >= 5) {
			scores.passwordStrength = 10;
		} else if (strength === 4) {
			scores.passwordStrength = 8;
		} else if (strength === 3) {
			scores.passwordStrength = 6;
		} else if (strength === 2) {
			scores.passwordStrength = 3;
		} else {
			scores.passwordStrength = 0;
		}
		const ageDays = await this._readPasswordAgeDays(c, userId);
		if (ageDays === null) {
			scores.passwordAge = 5;
		} else if (ageDays < 180) {
			scores.passwordAge = 10;
		} else if (ageDays <= 365) {
			scores.passwordAge = 5;
		} else {
			scores.passwordAge = 0;
		}
		try {
			const sessions = await sessionService.listSessions(c, userId, null);
			const n = Array.isArray(sessions) ? sessions.length : 0;
			scores.sessions = n <= 3 ? 5 : (n <= 5 ? 3 : 0);
		} catch (e) {
			scores.sessions = 5;
		}
		try {
			const placeholders = ANOMALY_ACTIONS.map(() => '?').join(',');
			const row = await c.env.db.prepare(
				`SELECT COUNT(*) AS n FROM audit_log WHERE actor_user_id = ? AND create_time >= datetime('now', '-30 days') ` +
				`AND (action IN (${placeholders}) OR action LIKE '%fail%' OR action LIKE '%lock%' OR action LIKE '%rate_limit%')`
			).bind(Number(userId), ...ANOMALY_ACTIONS).first();
			scores.auditAnomaly = Number(row?.n || 0) === 0 ? 10 : 0;
		} catch (e) {
			scores.auditAnomaly = 10;
		}
		const items = SCORE_RULES.map(rule => {
			const score = scores[rule.key] ?? 0;
			return {
				key: rule.key,
				max: rule.max,
				score,
				ok: score >= rule.max,
				suggestion: score >= rule.max ? null : rule.suggestion
			};
		});
		const total = items.reduce((sum, item) => sum + item.score, 0);
		return {
			total,
			items,
			suggestions: items.filter(item => item.suggestion).map(item => item.suggestion)
		};
	}
};

export default userSecurityService;
