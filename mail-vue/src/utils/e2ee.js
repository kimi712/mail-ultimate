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
	return subtle().deriveKey(
		{
			name: 'PBKDF2',
			salt: b64ToBuf(saltB64),
			iterations: PBKDF2_ITERATIONS,
			hash: 'SHA-256'
		},
		base,
		{name: 'AES-GCM', length: 256},
		false,
		['encrypt', 'decrypt']
	);
}

// 用加密密码派生密钥并只放内存；密码本身不保存、不发送给后端。
export async function unlockWithPassword(password, saltB64) {
	const key = await deriveKey(password, saltB64);
	memoryKey = key;
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
