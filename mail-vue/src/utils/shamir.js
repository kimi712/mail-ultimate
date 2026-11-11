// 斯诺登第三批（v3_16DB）：Shamir 密钥分片（5 片取 3）。
// GF(256)（不可约多项式 x^8 + x^4 + x^3 + x + 1，即 0x11b），
// 每字节独立做多项式：y = secret + a1·x + a2·x²（阈值 3 → 二次多项式）。
// 分片格式：`shamir:v1:<base64(x || y…)>`（x 为 1 字节分片号，y 与密钥等长）。
// 密钥：32 字节 KEK 原始字节（或任意字节串）；任 3 片可恢复，2 片及以下
// 在信息论意义上得不到任何信息。分片本身不含密钥明文，单片泄露无害。
// 诚实边界：分片只解决“密钥丢失恢复”，不防“3 片同时泄露”（3 片即全部）。

export const SHAMIR_PREFIX = 'shamir:v1:';
export const SHAMIR_TOTAL = 5;
export const SHAMIR_THRESHOLD = 3;

// GF(256) 乘法（Russian peasant，模 0x11b）。
function gfMul(a, b) {
	let p = 0;
	let aa = a & 0xff;
	let bb = b & 0xff;
	for (let i = 0; i < 8; i++) {
		if (bb & 1) p ^= aa;
		const hi = aa & 0x80;
		aa = (aa << 1) & 0xff;
		if (hi) aa ^= 0x1b;
		bb >>= 1;
	}
	return p;
}

// GF(256) 逆元（a^(254)，费马小定理）。
function gfInv(a) {
	if (a === 0) throw new Error('zero has no inverse');
	let r = 1;
	let base = a;
	let exp = 254;
	while (exp > 0) {
		if (exp & 1) r = gfMul(r, base);
		base = gfMul(base, base);
		exp >>= 1;
	}
	return r;
}

function randomByte() {
	const b = new Uint8Array(1);
	globalThis.crypto.getRandomValues(b);
	return b[0];
}

// 分片：secretBytes（Uint8Array）→ 5 个 `shamir:v1:` 字符串。
// x 取 1..5（分片号即 x，恢复时用它做拉格朗日插值）。
export function splitSecret(secretBytes) {
	if (!secretBytes || secretBytes.length === 0) {
		throw new Error('empty secret');
	}
	const secret = secretBytes instanceof Uint8Array ? secretBytes : new Uint8Array(secretBytes);
	const n = secret.length;
	// 每个字节独立的二次多项式系数 a1、a2（随机）。
	const a1 = new Uint8Array(n);
	const a2 = new Uint8Array(n);
	globalThis.crypto.getRandomValues(a1);
	globalThis.crypto.getRandomValues(a2);
	const shares = [];
	for (let x = 1; x <= SHAMIR_TOTAL; x++) {
		const y = new Uint8Array(n);
		for (let i = 0; i < n; i++) {
			// y = s + a1·x + a2·x²
			y[i] = secret[i] ^ gfMul(a1[i], x) ^ gfMul(a2[i], gfMul(x, x));
		}
		const packed = new Uint8Array(1 + n);
		packed[0] = x;
		packed.set(y, 1);
		shares.push(SHAMIR_PREFIX + btoa(String.fromCharCode(...packed)));
	}
	return shares;
}

// 恢复：任意 ≥3 个分片 → 原始密钥字节。分片不足或分片号重复时抛错。
export function recoverSecret(shareStrings) {
	if (!Array.isArray(shareStrings) || shareStrings.length < SHAMIR_THRESHOLD) {
		throw new Error('need at least 3 shares');
	}
	const parsed = shareStrings.slice(0, SHAMIR_THRESHOLD).map((s) => {
		if (typeof s !== 'string' || !s.startsWith(SHAMIR_PREFIX)) {
			throw new Error('bad share');
		}
		const binary = atob(s.slice(SHAMIR_PREFIX.length));
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		if (bytes.length < 2) throw new Error('bad share');
		return { x: bytes[0], y: bytes.slice(1) };
	});
	const xs = parsed.map(p => p.x);
	if (new Set(xs).size !== parsed.length) {
		throw new Error('duplicate share');
	}
	const n = parsed[0].y.length;
	if (!parsed.every(p => p.y.length === n)) {
		throw new Error('share length mismatch');
	}
	// 拉格朗日插值求 x=0 处的值：s = Σ y_i · Π_{j≠i} (0 - x_j)/(x_i - x_j)。
	const secret = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		let s = 0;
		for (let a = 0; a < parsed.length; a++) {
			let num = 1;
			let den = 1;
			for (let b = 0; b < parsed.length; b++) {
				if (b === a) continue;
				num = gfMul(num, parsed[b].x); // (0 - x_b) = x_b（GF(256) 特征 2，减=加）
				den = gfMul(den, parsed[a].x ^ parsed[b].x); // (x_a - x_b) = x_a ^ x_b
			}
			const lagrange = gfMul(num, gfInv(den));
			s ^= gfMul(parsed[a].y[i], lagrange);
		}
		secret[i] = s;
	}
	return secret;
}

// 校验分片格式（不恢复）：前缀 + base64 可解 + 长度 ≥2 + x 在 1..5。
export function isValidShare(s) {
	try {
		if (typeof s !== 'string' || !s.startsWith(SHAMIR_PREFIX)) return false;
		const binary = atob(s.slice(SHAMIR_PREFIX.length));
		if (binary.length < 2) return false;
		const x = binary.charCodeAt(0);
		return x >= 1 && x <= SHAMIR_TOTAL;
	} catch (e) {
		return false;
	}
}
