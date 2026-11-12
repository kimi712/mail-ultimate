// 登录凭证派生（2026-11-12 白帽反馈 uwu 6 步之第 1+3 步）。
// 口令永远不出浏览器：先跑一次慢 KDF，再用 HKDF 一分二——
// 登录密钥（唯一发给服务器的东西）+ 邮件密钥（E2EE KEK，绝不离浏览器）。
// 常量必须与服务端 mail-worker/src/utils/crypto-utils.js 逐字节一致，
// 固定向量交叉验证见 mail-worker/test/phase20-bounty-fix.spec.js。
//   慢 KDF：PBKDF2-HMAC-SHA256(口令, 盐, 600000 次) → 32 字节 master
//   HKDF-SHA256(master, 盐=同一用户盐, info)，各 32 字节：
//     info 'sn-mail-v1:login' → 登录密钥；'sn-mail-v1:mail' → 邮件密钥。
//   盐：每用户 16 随机字节 base64；注册时浏览器生成，登录前经
//   GET /login/salt 取回；改密时浏览器生成新盐随新登录密钥一起发。
// 盐只存在本模块内存变量里（登录成功后留给会话内“输口令复核”类操作
// 用，如改密/关 TOTP/设胁迫密码；登出时清掉），不写 localStorage。
import { bufToB64, b64ToBuf, setMemoryKey, importKekRaw, clearMemoryKey } from '@/utils/e2ee.js';
import http from '@/axios/index.js';

export const AUTH_KDF_ITERATIONS = 600000;
export const HKDF_INFO_LOGIN = 'sn-mail-v1:login';
export const HKDF_INFO_MAIL = 'sn-mail-v1:mail';

let loginSalt = '';

export function setLoginSalt(salt) {
	loginSalt = String(salt || '');
}

export function getLoginSalt() {
	return loginSalt;
}

export function clearLoginSalt() {
	loginSalt = '';
}

// 取登录盐：{ salt, version, decoySalt? }。
// version 1 = 旧 SHA-256 凭证待迁移（本次登录须同时发口令）；
// version 2 = 新凭证（只发登录密钥）。decoySalt 仅在胁迫密码已开通时返回。
export async function fetchLoginSalt(email) {
	const data = await http.get('/login/salt?email=' + encodeURIComponent(String(email || '')), { noMsg: true });
	return data || {};
}

async function pbkdf2Bits(password, saltBytes, iterations) {
	const base = await crypto.subtle.importKey(
		'raw', new TextEncoder().encode(String(password || '')), 'PBKDF2', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
		base, 256);
	return new Uint8Array(bits);
}

async function hkdfBits(masterBytes, saltBytes, info) {
	const base = await crypto.subtle.importKey('raw', masterBytes, 'HKDF', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: new TextEncoder().encode(info) },
		base, 256);
	return new Uint8Array(bits);
}

// 派生一对密钥。返回 { loginKey, mailKey }，均为 base64(32 字节)。
export async function deriveAuthKeys(password, saltB64) {
	const salt = b64ToBuf(saltB64);
	const master = await pbkdf2Bits(password, salt, AUTH_KDF_ITERATIONS);
	const loginKey = await hkdfBits(master, salt, HKDF_INFO_LOGIN);
	const mailKey = await hkdfBits(master, salt, HKDF_INFO_MAIL);
	return { loginKey: bufToB64(loginKey), mailKey: bufToB64(mailKey) };
}

// 只派生登录密钥（不派生邮件密钥）：供胁迫登录、已登录页验密操作用，
// 避免多算一次 HKDF。返回 base64(32 字节)。
export async function deriveLoginKeyOnly(password, saltB64) {
	const salt = b64ToBuf(saltB64);
	const master = await pbkdf2Bits(password, salt, AUTH_KDF_ITERATIONS);
	const loginKey = await hkdfBits(master, salt, HKDF_INFO_LOGIN);
	return bufToB64(loginKey);
}

// 生成一对新盐（16 随机字节 base64，供注册/改密时用）。
export function generateLoginSalt() {
	const array = new Uint8Array(16);
	crypto.getRandomValues(array);
	return bufToB64(array);
}

// 会话建立：把邮件密钥设为 E2EE 内存密钥（KEK）。调用方须先探明该账号
// 的 E2EE 状态（见 @/utils/e2ee-migrate.js 的 probeE2eeState）：老模型
// 未迁移时不得调用——旧包裹不是这把密钥包的，设了也解不开。
export async function setSessionMailKey(mailKeyB64) {
	await setMemoryKey(await importKekRaw(b64ToBuf(mailKeyB64)));
}

export function clearSessionKeys() {
	clearMemoryKey();
	clearLoginSalt();
}

// 服务端 0–5 分口令强度（mail-worker/src/service/login-service.js
// passwordStrength 的原样移植，供登录/注册时把分数随登录密钥一起
// 上报、存进 pwd_strength 桶；展示用的强度计仍在
// @/utils/password-strength.js，口径不同，别混用）。
// 长度≥8（+1）、≥12（+1）、大小写混用（+1）、含数字（+1）、含符号（+1）。
export function passwordStrengthScore(password) {
	const pwd = String(password || '');
	let score = 0;
	if (pwd.length >= 8) score += 1;
	if (pwd.length >= 12) score += 1;
	if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) score += 1;
	if (/\d/.test(pwd)) score += 1;
	if (/[^A-Za-z0-9]/.test(pwd)) score += 1;
	return score;
}

// 给已登录页的验密操作（关 TOTP、生成恢复码、胁迫密码、自删、自动锁定解锁）
// 用：用内存里的盐派生主登录密钥；内存无盐时按邮箱取盐。返回 base64 登录密钥。
export async function deriveMainLoginKey(password, email) {
	let salt = getLoginSalt()
	if (!salt && email) {
		const info = await fetchLoginSalt(email)
		salt = info.salt
		setLoginSalt(salt)
	}
	if (!salt) throw new Error('no-login-salt')
	return deriveLoginKeyOnly(password, salt)
}
