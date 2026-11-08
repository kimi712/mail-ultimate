// Phase 6：敏感字段应用层加密（WebCrypto AES-GCM，零新增依赖）。
// 密钥来自 c.env.field_enc_key（wrangler secret，部署时生成，与 jwt_secret
// 绝不复用；本地测试用 wrangler.jsonc vars 里的 dummy 值）。
// 信封格式：enc:v1:<base64(iv(12B) + ciphertext)>，其中密钥由
// SHA-256(field_enc_key) 派生为 256 位 AES 密钥。
// decrypt 遇非信封值原样返回（兼容老站明文存量）；无 key 时存明文 +
// console.warn 一次（不阻断部署，不静默假装加密）；解密失败同样原样返回，永不抛错。
const PREFIX = 'enc:v1:';
let warnedNoKey = false;

function getKeyMaterial(c) {
	const env = c?.env ?? c;
	return (env && typeof env.field_enc_key === 'string') ? env.field_enc_key : '';
}

function warnNoKeyOnce() {
	if (!warnedNoKey) {
		warnedNoKey = true;
		console.warn('field_enc_key 未配置：敏感字段将以明文存储，请在部署时配置 wrangler secret field_enc_key');
	}
}

function bytesToBase64(bytes) {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

function base64ToBytes(str) {
	const binary = atob(str);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

async function importAesKey(c) {
	const material = getKeyMaterial(c);
	if (!material) {
		return null;
	}
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
	return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const fieldCrypto = {

	isEncrypted(value) {
		return typeof value === 'string' && value.startsWith(PREFIX);
	},

	async encrypt(c, plaintext) {
		if (plaintext === null || plaintext === undefined || plaintext === '') {
			return plaintext;
		}
		const key = await importAesKey(c);
		if (!key) {
			warnNoKeyOnce();
			return plaintext;
		}
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const data = new TextEncoder().encode(String(plaintext));
		const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
		const combined = new Uint8Array(iv.length + ciphertext.length);
		combined.set(iv, 0);
		combined.set(ciphertext, iv.length);
		return PREFIX + bytesToBase64(combined);
	},

	async decrypt(c, value) {
		if (typeof value !== 'string' || !value.startsWith(PREFIX)) {
			return value;
		}
		const key = await importAesKey(c);
		if (!key) {
			warnNoKeyOnce();
			return value;
		}
		try {
			const combined = base64ToBytes(value.slice(PREFIX.length));
			if (combined.length <= 12) {
				return value;
			}
			const iv = combined.slice(0, 12);
			const ciphertext = combined.slice(12);
			const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
			return new TextDecoder().decode(plain);
		} catch (e) {
			console.error('字段解密失败，返回原值:', e.message);
			return value;
		}
	}
};

export default fieldCrypto;
