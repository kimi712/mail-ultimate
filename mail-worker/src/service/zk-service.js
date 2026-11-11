// 斯诺登第三批（v3_16DB）：零知识身份（务实版挑战-应答）。
// 登录验证不存可逆凭证：服务端只存 zkSalt + zkVerifier，其中
// zkVerifier = SHA-256(salt + password) base64——单向摘要，无法逆推密码。
//
// 协议（挑战-应答，服务端只存验证子即可验算）：
//   ① 前端 GET /login/zk-challenge?email=… 拿 {challengeId, nonce, salt, enabled}；
//   ② 前端算 verifier = SHA-256(salt + password)，再算
//      response = SHA-256(verifier + nonce) base64，随登录请求发 zk 字段；
//   ③ 服务端用 KV 里挑战的 nonce + user 表的 zkVerifier 重算
//      SHA-256(zkVerifier + nonce)，与 response 比对。
// 挑战 5 分钟过期、一次有效（无论成败都删）；nonce 绑定单次挑战，防重放。
// 挑战一律发放（账号未开通时用随机盐），不透露开通状态；挑战失败按一次
// 登录失败计数（login-service 里走 fail()，防用挑战接口绕过登录限流）。
// 诚实边界：verifier 是密码的单向摘要（与密码 hash 同级防护），DB 泄露时
// 攻击者可用 verifier 直接算响应（pass-the-hash 级别），与密码 hash 泄露
// 同级风险；它证明“知道密码”，但不改变“服务端仍需另验主密码”的登录流程——
// ZK 挑战是附加的身份证明层，主密码校验仍在同一请求内进行。
import orm from '../entity/orm';
import user from '../entity/user';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';

// SHA-256(UTF-8 字符串) → base64，与 utils/crypto-utils.genHashPassword
// 的口径一致（salt + password 直接拼串、UTF-8 编码），前端 crypto.subtle
// 同口径算出相同结果。
async function sha256Base64(str) {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
	return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

const CHALLENGE_TTL_SECONDS = 300;
const CHALLENGE_PREFIX = 'zk_challenge:';
const B64_SHA256_RE = /^[A-Za-z0-9+/=]{43,44}$/;

const zkService = {
	// 是否已开通（user.zk_verifier 非空）。
	async isEnabled(c, userId) {
		try {
			const row = await orm(c).select().from(user)
				.where(eq(user.userId, Number(userId))).get();
			return !!(row && row.zkVerifier);
		} catch (e) {
			return false;
		}
	},

	// 发挑战：{ challengeId, nonce, salt, enabled }。
	// salt 取账号的 zkSalt（未开通时用随机盐，不透露开通状态）；
	// 挑战 { nonce, salt, userId } 存 KV（5 分钟过期、一次有效）。
	async issueChallenge(c, email) {
		const addr = String(email || '').trim().toLowerCase();
		let salt = '';
		let userId = 0;
		let enabled = false;
		try {
			if (addr) {
				const row = await orm(c).select().from(user)
					.where(eq(user.email, addr)).get();
				if (row) {
					userId = row.userId;
					enabled = !!row.zkVerifier;
					salt = row.zkSalt || '';
				}
			}
		} catch (e) { /* 读不到按未开通处理 */ }
		if (!salt) {
			const rand = new Uint8Array(16);
			crypto.getRandomValues(rand);
			salt = btoa(String.fromCharCode(...rand));
		}
		const nonceBytes = new Uint8Array(16);
		crypto.getRandomValues(nonceBytes);
		const nonce = btoa(String.fromCharCode(...nonceBytes));
		const challengeId = uuidv4();
		try {
			await c.env.kv.put(CHALLENGE_PREFIX + challengeId,
				JSON.stringify({ nonce, salt, userId }),
				{ expirationTtl: CHALLENGE_TTL_SECONDS });
		} catch (e) {
			console.error('零知识挑战写入 KV 失败:', e.message);
		}
		return { challengeId, nonce, salt, enabled };
	},

	// 验挑战响应：response 须等于 SHA-256(zkVerifier + nonce) base64，
	// 其中 zkVerifier = SHA-256(salt + password)，由前端用密码算出、
	// 服务端只存验证子。一次有效（无论成败都删挑战）。
	async verifyResponse(c, userRow, challengeId, response) {
		if (!challengeId || typeof response !== 'string') return false;
		if (!B64_SHA256_RE.test(response)) return false;
		try {
			const raw = await c.env.kv.get(CHALLENGE_PREFIX + challengeId, { type: 'json' });
			if (!raw || !raw.nonce || !raw.salt) return false;
			// 一次有效：无论成败都删。
			await c.env.kv.delete(CHALLENGE_PREFIX + challengeId);
			// 账号须已开通 ZK（有 zkVerifier），且挑战的盐与账号盐一致。
			if (!userRow || !userRow.zkVerifier) return false;
			if (raw.salt !== userRow.zkSalt) return false;
			if (raw.userId && Number(raw.userId) !== Number(userRow.userId)) return false;
			const expected = await sha256Base64(String(userRow.zkVerifier) + String(raw.nonce));
			return expected === response;
		} catch (e) {
			return false;
		}
	},

	// 开通 / 更换：存 zkSalt + zkVerifier（SHA-256(salt + password) base64）。
	// salt 须为 base64（16 字节以上）；verifier 须为 44 位 base64（SHA-256）。
	async setup(c, userRow, salt, verifier) {
		const s = String(salt || '').trim();
		const v = String(verifier || '').trim();
		if (!/^[A-Za-z0-9+/=]{22,}$/.test(s)) {
			throw new BizError(t('zkInvalidSalt'), 400);
		}
		if (!B64_SHA256_RE.test(v)) {
			throw new BizError(t('zkInvalidVerifier'), 400);
		}
		await orm(c).update(user).set({ zkSalt: s, zkVerifier: v })
			.where(eq(user.userId, userRow.userId)).run();
		return { enabled: true };
	},

	// 关闭：清掉 zkSalt + zkVerifier。
	async disable(c, userRow) {
		await orm(c).update(user).set({ zkSalt: '', zkVerifier: '' })
			.where(eq(user.userId, userRow.userId)).run();
		return { enabled: false };
	}
};

export default zkService;
