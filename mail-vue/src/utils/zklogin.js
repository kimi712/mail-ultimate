// 斯诺登第三批（v3_16DB）：零知识身份（务实版挑战-应答）前端。
// 协议：① GET /login/zk-challenge?email=… 拿 {challengeId, nonce, salt, enabled}；
// ② verifier = SHA-256(salt + password) base64；
// ③ response = SHA-256(verifier + nonce) base64，随登录请求发 zk 字段；
// ④ 服务端用 KV 挑战的 nonce + user 表的 zkVerifier 重算比对。
// 服务端只存 zkSalt/zkVerifier（验证子），不存可逆凭证；密码本身不出浏览器。
// 诚实边界：verifier 是密码的单向摘要（与密码 hash 同级防护）；
// ZK 挑战是附加的身份证明层，主密码校验仍在同一登录请求内进行。

import http from '@/axios/index.js';

export const ZK_CHALLENGE_TTL_HINT = '挑战 5 分钟内有效，一次有效';

async function sha256Base64(str) {
	const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
	const bytes = new Uint8Array(buf);
	let binary = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

// 取挑战（公开接口）。返回 { challengeId, nonce, salt, enabled }。
export async function fetchZkChallenge(email) {
	const res = await http.get('/login/zk-challenge', { params: { email }, noMsg: true });
	return res.data;
}

// 算登录用的 zk 字段：{ challengeId, response }。
// 须先 fetchZkChallenge 拿到 salt/nonce；password 只在浏览器内用。
export async function buildZkLoginField(challenge, password) {
	if (!challenge || !challenge.challengeId || !challenge.nonce || !challenge.salt) {
		throw new Error('bad challenge');
	}
	const verifier = await sha256Base64(String(challenge.salt) + String(password));
	const response = await sha256Base64(verifier + String(challenge.nonce));
	return { challengeId: challenge.challengeId, response };
}

// 开通/更换 ZK：算 verifier = SHA-256(salt + password)，连同随机 salt 发后端。
// salt 前端随机生成（16 字节 base64），后端只存 salt + verifier。
export async function buildZkSetupField(password) {
	const saltBytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(saltBytes);
	const salt = btoa(String.fromCharCode(...saltBytes));
	const verifier = await sha256Base64(salt + String(password));
	return { salt, verifier };
}
