const encoder = new TextEncoder();

// 登录凭证方案（2026-11-12 白帽反馈 uwu 6 步之第 1+3 步）：
//   口令永远不出浏览器。浏览器先跑一次慢 KDF，再用 HKDF 一分二——
//   登录密钥（唯一发给服务器的东西）+ 邮件密钥（E2EE KEK，绝不离浏览器）。
//   服务端只存“登录密钥的慢 hash”，DB 泄露时既不能直接拿去登录，
//   也推不出邮件密钥（HKDF 单向，域分离）。
//
// 常量（必须与前端 mail-vue/src/utils/authkeys.js 逐字节一致，
// 固定向量交叉验证见 mail-worker/test/phase20-bounty-fix.spec.js）：
//   慢 KDF：PBKDF2-HMAC-SHA256(口令, 盐, 600000 次) → 32 字节 master
//     （OWASP 推荐的 PBKDF2-HMAC-SHA256 最低 600k 次；Argon2id 需另引
//     WASM 实现且无现成依赖，uwu 明确允许二选一，故先用 PBKDF2 600k；
//     换 Argon2id 不改协议，只改派生实现。）
//   HKDF：HKDF-SHA256(master, 盐=同一用户盐, info)，各 32 字节：
//     info 'sn-mail-v1:login' → 登录密钥；'sn-mail-v1:mail' → 邮件密钥。
//   服务端验证器：password 列 = 'pbkdf2$210000$lk$' +
//     base64(PBKDF2-HMAC-SHA256(登录密钥字节, 盐, 210000))。
//     前缀即版本标记：'pbkdf2$210000$lk$' = 新口径（lk = login key）；
//     无前缀 = v1 旧口径 base64(SHA-256(盐+口令))，只作迁移桥判定。
//   盐：每用户 16 随机字节 base64，注册时浏览器生成、登录前经
//     GET /login/salt 取回；改密时浏览器生成新盐随新登录密钥一起发。
//   旧口令 hash（v1）已退役：verifyLegacyPassword 只在迁移桥里用，
//   除此之外任何新写入都不再产生 v1。
//   胁迫密码（第二密码）同款口径，但用独立的胁迫盐（user_decoy.salt，
//   主密码改密换盐不影响它），见 decoy-service.js。
const AUTH_KDF_ITERATIONS = 600000;
const VERIFIER_KDF_ITERATIONS = 210000;
const VERIFIER_PREFIX = 'pbkdf2$210000$lk$';
const HKDF_INFO_LOGIN = 'sn-mail-v1:login';
const HKDF_INFO_MAIL = 'sn-mail-v1:mail';

function b64ToBytes(b64) {
	const bin = atob(String(b64 || ''));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

function bytesToB64(bytes) {
	const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < arr.length; i += CHUNK) {
		binary += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

async function pbkdf2Bits(password, saltBytes, iterations) {
	const base = await crypto.subtle.importKey(
		'raw', encoder.encode(String(password || '')), 'PBKDF2', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
		base, 256);
	return new Uint8Array(bits);
}

async function hkdfBits(masterBytes, saltBytes, info) {
	const base = await crypto.subtle.importKey('raw', masterBytes, 'HKDF', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: encoder.encode(info) },
		base, 256);
	return new Uint8Array(bits);
}

const saltHashUtils = {

	generateSalt(length = 16) {
		const array = new Uint8Array(length);
		crypto.getRandomValues(array);
		return btoa(String.fromCharCode(...array));
	},

	// 浏览器同款派生（服务端仅在迁移桥与管理员建号/改密时用——
	// 那些路径上口令确实经受信通道交给了服务端；正常登录/注册
	// 浏览器已算好，只发登录密钥，服务端不调用本函数）。
	// 返回 { loginKey, mailKey }，均为 base64(32 字节)。
	async deriveAuthKeys(password, saltB64) {
		const salt = b64ToBytes(saltB64);
		const master = await pbkdf2Bits(password, salt, AUTH_KDF_ITERATIONS);
		const loginKey = await hkdfBits(master, salt, HKDF_INFO_LOGIN);
		const mailKey = await hkdfBits(master, salt, HKDF_INFO_MAIL);
		return { loginKey: bytesToB64(loginKey), mailKey: bytesToB64(mailKey) };
	},

	// 服务端验证器：登录密钥的慢 hash（PBKDF2 210000 次）。入参是
	// base64 登录密钥，不是口令。
	async hashLoginKey(loginKeyB64, saltB64) {
		const bits = await this.pbkdf2LoginKeyBits(loginKeyB64, saltB64);
		return VERIFIER_PREFIX + bytesToB64(bits);
	},

	async pbkdf2LoginKeyBits(loginKeyB64, saltB64) {
		const keyBytes = b64ToBytes(loginKeyB64);
		const base = await crypto.subtle.importKey('raw', keyBytes, 'PBKDF2', false, ['deriveBits']);
		const bits = await crypto.subtle.deriveBits(
			{ name: 'PBKDF2', salt: b64ToBytes(saltB64), iterations: VERIFIER_KDF_ITERATIONS, hash: 'SHA-256' },
			base, 256);
		return new Uint8Array(bits);
	},

	// 校验登录密钥：只有新口径（带前缀）的行能用本函数验；v1 旧行返回 false，
	// 须走迁移桥（先验旧口令再升级）。
	async verifyLoginKey(loginKeyB64, saltB64, storedHash) {
		const stored = String(storedHash || '');
		if (!stored.startsWith(VERIFIER_PREFIX)) return false;
		if (!loginKeyB64) return false;
		const hash = VERIFIER_PREFIX + bytesToB64(await this.pbkdf2LoginKeyBits(loginKeyB64, saltB64));
		return hash === stored;
	},

	// ---- v1 旧口径（已退役，只在迁移桥里验旧口令） ----
	async genHashPassword(password, salt) {
		const data = encoder.encode(salt + password);
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return btoa(String.fromCharCode(...hashArray));
	},

	async verifyLegacyPassword(inputPassword, salt, storedHash) {
		const hash = await this.genHashPassword(inputPassword, salt);
		return hash === String(storedHash || '');
	},

	// 该行是否还是 v1 旧口径（无新前缀）。新口径行一定带前缀。
	isLegacyHash(storedHash) {
		return !String(storedHash || '').startsWith(VERIFIER_PREFIX);
	},

	// 旧口径兼容：供迁移桥在“浏览器没发 loginKey、只有口令（旧版缓存页面）”
	// 时算一次登录密钥。正常路径浏览器已算好，不调用。
	async deriveLoginKeyOnly(password, saltB64) {
		const { loginKey } = await this.deriveAuthKeys(password, saltB64);
		return loginKey;
	},

	// base64 解码后是否恰好 n 字节（供注册/改密时校验浏览器发来的
	// loginKey 32B 与盐 16B）。非法 base64 返回 false，不抛错。
	isB64Bytes(v, n) {
		try {
			return b64ToBytes(v).length === n;
		} catch (e) {
			return false;
		}
	},

	genRandomPwd(length = 8) {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let result = '';
		for (let i = 0; i < length; i++) {
			result += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return result;
	}
};

export default saltHashUtils;
