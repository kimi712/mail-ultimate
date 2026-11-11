// 端到端加密（第六阶段 C 路）：浏览器内 WebCrypto 实现。
// 密钥只放在本模块的内存变量里，绝不写入任何持久化存储；
// salt 本身不是密钥，可随 POST /my/security 存后端（GET /my/security 的 e2eeSalt）。
// 信封格式：`e2ee:v1:<base64(iv(12B) || ciphertext)>`，AES-GCM 256，
// 密钥由用户输入的加密密码经 PBKDF2-HMAC-SHA256（210000 次）派生。
// 附件本阶段不加密（见安全中心页文案）。

export const E2EE_ENVELOPE_PREFIX = 'e2ee:v1:';
export const PBKDF2_ITERATIONS = 210000;

let memoryKey = null;

export function hasMemoryKey() {
	return !!memoryKey;
}

export function getMemoryKey() {
	return memoryKey;
}

export function setMemoryKey(key) {
	memoryKey = key || null;
	return memoryKey;
}

export function clearMemoryKey() {
	memoryKey = null;
	memoryBlindKey = null;
}

function subtle() {
	const c = globalThis.crypto;
	if (!c || !c.subtle) {
		throw new Error('WebCrypto unavailable');
	}
	return c.subtle;
}

export function bufToB64(buf) {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	let binary = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

export function b64ToBuf(b64) {
	const binary = atob(String(b64));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export function generateSalt() {
	const salt = new Uint8Array(16);
	globalThis.crypto.getRandomValues(salt);
	return bufToB64(salt);
}

export async function deriveKey(password, saltB64) {
	if (!password) {
		throw new Error('empty password');
	}
	if (!saltB64) {
		throw new Error('empty salt');
	}
	const base = await subtle().importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveKey']
	);
	// extractable: true（斯诺登第三批 Shamir 分片需要导出 KEK 原始字节）。
	// 威胁模型不变：密钥本就放在本模块内存里、任意同源代码都能直接用它
	// 加解密；可导出只是让“导出 32 字节做分片”成为可能，不新增攻击面。
	return subtle().deriveKey(
		{
			name: 'PBKDF2',
			salt: b64ToBuf(saltB64),
			iterations: PBKDF2_ITERATIONS,
			hash: 'SHA-256'
		},
		base,
		{name: 'AES-GCM', length: 256},
		true,
		['encrypt', 'decrypt']
	);
}

// 导出当前内存 KEK 的原始 32 字节（供 Shamir 分片；未解锁时抛错）。
export async function exportKekRaw(key) {
	const k = key || memoryKey;
	if (!k) {
		throw new Error('no key');
	}
	const raw = await subtle().exportKey('raw', k);
	return new Uint8Array(raw);
}

// 用原始 32 字节恢复 KEK 并只放内存（Shamir 3 片恢复后调用）。
export async function importKekRaw(raw) {
	if (!raw || raw.length !== 32) {
		throw new Error('bad kek');
	}
	const key = await subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
	memoryKey = key;
	return key;
}

// 用加密密码派生密钥并只放内存；密码本身不保存、不发送给后端。
// 同时派生盲索引密钥（同口令、不同盐域），供可搜索加密用。
export async function unlockWithPassword(password, saltB64) {
	const key = await deriveKey(password, saltB64);
	memoryKey = key;
	try {
		memoryBlindKey = await deriveBlindKey(password, saltB64);
	} catch (e) {
		memoryBlindKey = null;
	}
	return key;
}

export function isE2eeEnvelope(value) {
	return typeof value === 'string' && value.startsWith(E2EE_ENVELOPE_PREFIX);
}

export async function encryptText(plaintext, key) {
	const k = key || memoryKey;
	if (!k) {
		throw new Error('no key');
	}
	const iv = new Uint8Array(12);
	globalThis.crypto.getRandomValues(iv);
	const data = await subtle().encrypt(
		{name: 'AES-GCM', iv},
		k,
		new TextEncoder().encode(plaintext ?? '')
	);
	const combined = new Uint8Array(12 + data.byteLength);
	combined.set(iv, 0);
	combined.set(new Uint8Array(data), 12);
	return E2EE_ENVELOPE_PREFIX + bufToB64(combined);
}

export async function decryptText(envelope, key) {
	const k = key || memoryKey;
	if (!k) {
		throw new Error('no key');
	}
	if (!isE2eeEnvelope(envelope)) {
		throw new Error('not an e2ee envelope');
	}
	const combined = b64ToBuf(envelope.slice(E2EE_ENVELOPE_PREFIX.length));
	if (combined.length < 13) {
		throw new Error('bad envelope');
	}
	const iv = combined.slice(0, 12);
	const data = combined.slice(12);
	const plain = await subtle().decrypt({name: 'AES-GCM', iv}, k, data);
	return new TextDecoder().decode(plain);
}

// 写信页：text / content 各自独立 IV 加密（附件不加密，原样随表单发）。
export async function encryptEmailParts({text, content}, key) {
	return {
		text: await encryptText(text || '', key),
		content: await encryptText(content || '', key)
	};
}

// 读信页：非信封值原样返回（兼容未加密字段），解密失败抛错由调用方处理。
export async function decryptEmailParts({text, content}, key) {
	return {
		text: isE2eeEnvelope(text) ? await decryptText(text, key) : (text || ''),
		content: isE2eeEnvelope(content) ? await decryptText(content, key) : (content || '')
	};
}

// 站内地址判定：域名须在站内域名表（settingStore.domainList）里；
// 域名表为空时一律判站外（宁可拦下，不可把加密邮件发给站外）。
export function isInternalEmail(address, domains) {
	if (!address || !Array.isArray(domains) || domains.length === 0) {
		return false;
	}
	const addr = String(address).trim().toLowerCase();
	const at = addr.lastIndexOf('@');
	if (at < 0) {
		return false;
	}
	const domain = addr.slice(at + 1);
	return domains.some((d) => String(d).toLowerCase() === domain);
}

// ---------------------------------------------------------------------------
// 斯诺登第二批（v3_15DB）：前向保密 + 发件人隐身（v2 信封）。
// 模型：每封 E2EE 站内信单独生成一把 256 位一次性内容密钥（CEK），正文用 CEK
// 加密（信封仍为 `e2ee:v1:` 格式，区别只在密钥是 CEK 而不是 KEK，由 email.e2eeVer
// =2 标明）；CEK 按收件人分别包裹——对方有 ML-KEM-768 公钥时用抗量子包裹
// （见 pqkem.js，信封 `pq:v1:`，cekAlg='mlkem768'），否则用发送方 KEK 对称包裹
// （信封 `e2ee:v1:`，cekAlg='sym'）。单把 CEK 泄露只影响一封信；口令泄露仍会
// 暴露全部（对称模型的固有限制，界面须如实说明）。
// 发件人隐身：发件人地址 + 名字用 CEK 加密成 `sealed:v1:` 信封存收件人行，
// 收件人行明文发件人置空；只有收件人解锁 E2EE、解出 CEK 后才能看到发件人。
// 服务端发信时仍知道发件人（认证/限额/黑名单需要），保证的是落盘记录不暴露发件人。
export const SEALED_SENDER_PREFIX = 'sealed:v1:';
export const CEK_BYTES = 32;

// 生成一次性内容密钥。返回 { key（CryptoKey）, raw（32 字节） }。
export async function generateCek() {
	const raw = new Uint8Array(CEK_BYTES);
	globalThis.crypto.getRandomValues(raw);
	const key = await subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
	return { key, raw };
}

export async function importCek(raw) {
	if (!raw || raw.length !== CEK_BYTES) {
		throw new Error('bad cek');
	}
	return subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// 原始字节加解密（供 CEK 包裹用；文本版走 encryptText/decryptText）。
export async function encryptBytes(bytes, key) {
	const k = key || memoryKey;
	if (!k) {
		throw new Error('no key');
	}
	const iv = new Uint8Array(12);
	globalThis.crypto.getRandomValues(iv);
	const data = await subtle().encrypt({name: 'AES-GCM', iv}, k, bytes);
	const combined = new Uint8Array(12 + data.byteLength);
	combined.set(iv, 0);
	combined.set(new Uint8Array(data), 12);
	return E2EE_ENVELOPE_PREFIX + bufToB64(combined);
}

export async function decryptBytes(envelope, key) {
	const k = key || memoryKey;
	if (!k) {
		throw new Error('no key');
	}
	if (!isE2eeEnvelope(envelope)) {
		throw new Error('not an e2ee envelope');
	}
	const combined = b64ToBuf(envelope.slice(E2EE_ENVELOPE_PREFIX.length));
	if (combined.length < 13) {
		throw new Error('bad envelope');
	}
	const iv = combined.slice(0, 12);
	const data = combined.slice(12);
	const plain = await subtle().decrypt({name: 'AES-GCM', iv}, k, data);
	return new Uint8Array(plain);
}

// CEK 对称包裹（cekAlg='sym'）：用发送方 KEK 加密 32 字节 CEK。
export async function wrapCekSym(cekRaw, kek) {
	return encryptBytes(cekRaw, kek);
}

export async function unwrapCekSym(wrapped, kek) {
	const raw = await decryptBytes(wrapped, kek);
	if (raw.length !== CEK_BYTES) {
		throw new Error('bad cek');
	}
	return raw;
}

// 正文用 CEK 加解密（v2 信封；格式与 v1 相同，密钥不同）。
export async function encryptTextWithCek(plaintext, cekKey) {
	return encryptText(plaintext, cekKey);
}

export async function decryptTextWithCek(envelope, cekKey) {
	return decryptText(envelope, cekKey);
}

export async function encryptEmailPartsV2({text, content}, cekKey) {
	return {
		text: await encryptText(text || '', cekKey),
		content: await encryptText(content || '', cekKey)
	};
}

export async function decryptEmailPartsV2({text, content}, cekKey) {
	return {
		text: isE2eeEnvelope(text) ? await decryptText(text, cekKey) : (text || ''),
		content: isE2eeEnvelope(content) ? await decryptText(content, cekKey) : (content || '')
	};
}

// ---------------------------------------------------------------------------
// 斯诺登第三批（v3_16DB）：可否认认证 + 可搜索加密（盲索引）。
//
// 可否认认证：站内 E2EE 信（v2，CEK 模型）改用“收发双方共用密钥做 MAC”——
// 发件人用 CEK 对密文算 HMAC-SHA256 标签（denyTag）存收件人行。收件人用
// 自己解出的 CEK 也能算出同一标签：任何一方都能伪造这样一封“对方发的”信，
// 第三方拿到标签也无法证明是谁发的。可否认的是“发件人身份”，不是“信存在过”
// （服务器仍有投递记录）。标签只证明“密文没被改过”，不证明发件人。
//   computeDeniableTag(cekRaw, ciphertextEnvelope) → hex(64)。
//
// 可搜索加密（盲索引）：关键词用一把独立的 HMAC 密钥（与 KEK 同口令、
// 不同盐域派生，unlock 时一并派生、只放内存）做 HMAC-SHA256 得到 token；
// 服务端只存 token → emailId 映射，匹配时不解密正文。服务端能看到“哪些信
// 共享同一个关键词”（访问模式），看不到关键词本身和正文。
//   computeBlindToken(keyword) → hex(64)；关键词归一化（去首尾空白 + 小写）。
// 诚实边界：这是可搜索加密，不是全同态加密。

let memoryBlindKey = null;

export function getMemoryBlindKey() {
	return memoryBlindKey;
}

export function setMemoryBlindKey(key) {
	memoryBlindKey = key || null;
	return memoryBlindKey;
}

// 盲索引密钥：与 KEK 同口令派生，盐域加 ':blind' 后缀区分；只放内存。
export async function deriveBlindKey(password, saltB64) {
	if (!password) {
		throw new Error('empty password');
	}
	if (!saltB64) {
		throw new Error('empty salt');
	}
	const base = await subtle().importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveKey']
	);
	return subtle().deriveKey(
		{
			name: 'PBKDF2',
			salt: new TextEncoder().encode(String(saltB64) + ':blind'),
			iterations: PBKDF2_ITERATIONS,
			hash: 'SHA-256'
		},
		base,
		{name: 'HMAC', hash: 'SHA-256'},
		false,
		['sign']
	);
}

// HMAC-SHA256 → hex（key 为 CryptoKey(HMAC, sign) 或 Uint8Array 原始字节）。
export async function hmacSha256Hex(key, data) {
	let k = key;
	if (key instanceof Uint8Array) {
		k = await subtle().importKey('raw', key, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
	}
	const sig = await subtle().sign('HMAC', k, new TextEncoder().encode(data));
	return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 可否认标签：用 CEK 原始字节对密文信封做 HMAC。收件人解出 CEK 后也能算出
// 同一标签——任何一方都能伪造，第三方无法证明是谁发的。
export async function computeDeniableTag(cekRaw, ciphertextEnvelope) {
	if (!cekRaw || cekRaw.length !== CEK_BYTES) {
		throw new Error('bad cek');
	}
	return hmacSha256Hex(cekRaw, String(ciphertextEnvelope || ''));
}

// 盲索引 token：关键词归一化（去首尾空白 + 小写）后用盲索引密钥做 HMAC。
export async function computeBlindToken(keyword, blindKey) {
	const k = blindKey || memoryBlindKey;
	if (!k) {
		throw new Error('no blind key');
	}
	const norm = String(keyword || '').trim().toLowerCase();
	if (!norm) {
		throw new Error('empty keyword');
	}
	return hmacSha256Hex(k, norm);
}

// 从一段文本里提关键词（供发信时建盲索引）：按空白/标点切分，去重，
// 长度 2–32，只保留字母数字与 CJK，数量上限由调用方控制。
export function extractKeywords(text, maxCount = 50) {
	const src = String(text || '');
	const words = src.split(/[\s,.;:!?，。；：！？、()（）\[\]{}<>《》"'“”‘’\/\\|@#\$%\^&\*~`+=_-]+/)
		.map(w => w.trim().toLowerCase())
		.filter(w => w.length >= 2 && w.length <= 32 && /[a-z0-9\u4e00-\u9fff]/.test(w));
	return [...new Set(words)].slice(0, maxCount);
}

// 判断是否为密封发件人信封（第二批功能；第三批编辑时误删过一次，勿再删）。
export function isSealedSender(value) {
	return typeof value === 'string' && value.startsWith(SEALED_SENDER_PREFIX);
}

// 密封发件人：{email, name} 的 JSON 用 CEK 加密。
export async function sealSender({email, name}, cekKey) {
	const payload = JSON.stringify({ email: email || '', name: name || '' });
	const iv = new Uint8Array(12);
	globalThis.crypto.getRandomValues(iv);
	const data = await subtle().encrypt(
		{name: 'AES-GCM', iv},
		cekKey,
		new TextEncoder().encode(payload)
	);
	const combined = new Uint8Array(12 + data.byteLength);
	combined.set(iv, 0);
	combined.set(new Uint8Array(data), 12);
	return SEALED_SENDER_PREFIX + bufToB64(combined);
}

export async function unsealSender(envelope, cekKey) {
	if (!isSealedSender(envelope)) {
		throw new Error('not a sealed sender envelope');
	}
	const combined = b64ToBuf(envelope.slice(SEALED_SENDER_PREFIX.length));
	if (combined.length < 13) {
		throw new Error('bad envelope');
	}
	const iv = combined.slice(0, 12);
	const data = combined.slice(12);
	const plain = await subtle().decrypt({name: 'AES-GCM', iv}, cekKey, data);
	const obj = JSON.parse(new TextDecoder().decode(plain));
	return { email: obj.email || '', name: obj.name || '' };
}
