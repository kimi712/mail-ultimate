// 新登录密钥机制的测试 helper（2026-11-12 uwu 第 1 步）。
// 与真实客户端同流程：注册时浏览器生成盐、派生登录密钥；登录时先取盐、
// 再派生、只发登录密钥。直接复用服务端的 crypto-utils（同款实现），
// 所以 helper 本身不证明“浏览器与服务端逐字节一致”——那由 phase20 的
// 固定向量交叉验证（独立手写派生）来证明。
// 用法：各 spec 把自己的 api() 传进来（各 spec 的 api 都是
// api(path, {method, body, token, ip})，返回 {status, json}）。
import cryptoUtils from '../src/utils/crypto-utils';

export const DEFAULT_TEST_PWD = 'password123';

export function saltForTest() {
	return cryptoUtils.generateSalt();
}

export function deriveForTest(password, saltB64) {
	return cryptoUtils.deriveAuthKeys(password, saltB64);
}

export function deriveLoginKeyForTest(password, saltB64) {
	return cryptoUtils.deriveLoginKeyOnly(password, saltB64);
}

// 与前端 authkeys.js 的 passwordStrengthScore 同口径（0–5 分），
// 测试 helper 如实上报，不写死分数——弱口令注册被拒的用例靠它。
export function pwdScoreForTest(password) {
	const pwd = String(password || '');
	let score = 0;
	if (pwd.length >= 8) score += 1;
	if (pwd.length >= 12) score += 1;
	if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) score += 1;
	if (/\d/.test(pwd)) score += 1;
	if (/[^A-Za-z0-9]/.test(pwd)) score += 1;
	return score;
}

// 新用户注册：发 {email, loginKey, salt, pwdScore}（旧版 password 字段
// 服务端已忽略，注册 helper 不再发它；extra 透传 token/code 等；
// ua 透传给 api()（发 User-Agent 头，供 UA 相关测试用）。
export async function registerNew(api, email, { ip, ua, password = DEFAULT_TEST_PWD, extra = {} } = {}) {
	// 防御：若调用方把口令放进了 extra（如 phase8-b 的 makeUser 传 { password }），
	// 抽出来当派生口令、不进请求体——口令字段服务端已忽略，直接铺进 body 会静默
	// 按默认口令建号（强度分也跟着错），极难发现。
	const { password: extraPwd, ...rest } = extra || {};
	const pwd = password !== DEFAULT_TEST_PWD ? password : (extraPwd || DEFAULT_TEST_PWD);
	const salt = cryptoUtils.generateSalt();
	const keys = await cryptoUtils.deriveAuthKeys(pwd, salt);
	return api('/register', {
		method: 'POST', ip, ua,
		body: { email, loginKey: keys.loginKey, salt, pwdScore: pwdScoreForTest(pwd), ...rest },
	});
}

// 登录：先 GET /login/salt 取盐与版本，再派生登录密钥；v1 旧账号本次
// 带一次明文密码走迁移桥（与新客户端一致）；胁迫已开通时另算 decoyLoginKey。
export async function loginNew(api, email, { ip, ua, password = DEFAULT_TEST_PWD, extra = {} } = {}) {
	const saltRes = await api(`/login/salt?email=${encodeURIComponent(email)}`, { ip, ua });
	const info = saltRes.json?.data || {};
	const keys = await cryptoUtils.deriveAuthKeys(password, info.salt || '');
	const body = { email, loginKey: keys.loginKey, ...extra };
	if (info.decoySalt) {
		body.decoyLoginKey = await cryptoUtils.deriveLoginKeyOnly(password, info.decoySalt);
	}
	if (info.version === 1) {
		body.password = password;
	}
	return api('/login', { method: 'POST', ip, ua, body });
}
