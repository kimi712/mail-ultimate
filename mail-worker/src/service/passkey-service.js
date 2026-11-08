// Phase 6：Passkey / WebAuthn（手写最小验证，零新增依赖）。
//
// 为什么手写：契约点名的 @simplewebauthn/server 14.1.0 已实测——
// vitest pool-workers（workerd）下导入即失败：
//   SyntaxError: The requested module '../tslib.js' does not provide an export named 'default'
// 根因是其传递依赖 tsyringe 内嵌的 tslib ESM（modules/index.js 对 tslib.js
// 做 default import），与 Vite/workerd 的 ESM 互操作不兼容；CJS 入口
// script/index.js 又不在其 exports 映射内，无法被解析。生产 wrangler
// 打包（esbuild）未必复现该问题，但验收测试跑在 vitest pool-workers 下，
// 导入失败即无法测试，故改手写最小验证（CBOR 解码 + COSE 公钥解析 +
// WebCrypto 验签），只覆盖本项目实际需要的路径。
//
// 覆盖范围：attestation fmt 'none'（options 用 attestationType 'none' 生成，
// 真实设备默认即此格式）与 'packed' 自证明（无 x5c）；
// 密钥类型 ES256（P-256）、Ed25519、RS256；counter 防重放；
// challenge KV 一次性使用，5 分钟过期。服务端只存公钥 JWK，私钥永不触网。
// RP ID = aevorynthtech.com，origin = https://aevorynthtech.com；
// Passkey 与密码登录并存，不强制迁移。
import orm from '../entity/orm';
import userPasskey from '../entity/user-passkey';
import { eq } from 'drizzle-orm';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';
import KvConst from '../const/kv-const';
import userService from './user-service';

const RP_ID = 'aevorynthtech.com';
const RP_NAME = 'Aevorynth Mail';
const ORIGIN = 'https://aevorynthtech.com';

function b64urlEncode(bytes) {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(str) {
	let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
	while (s.length % 4) s += '=';
	const binary = atob(s);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function sha256(bytes) {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function bytesEqual(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

// ---- 最小 CBOR 解码器（只读 attestationObject / COSE 公钥；定长编码） ----
function cborDecode(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	function readLength(ai, offset) {
		if (ai < 24) return [ai, offset];
		if (ai === 24) return [view.getUint8(offset), offset + 1];
		if (ai === 25) return [view.getUint16(offset), offset + 2];
		if (ai === 26) return [view.getUint32(offset), offset + 4];
		if (ai === 27) {
			const hi = view.getUint32(offset);
			const lo = view.getUint32(offset + 4);
			return [hi * 0x100000000 + lo, offset + 8];
		}
		throw new Error('unsupported CBOR additional info ' + ai);
	}
	function decode(offset) {
		const initial = view.getUint8(offset);
		const major = initial >> 5;
		const ai = initial & 0x1f;
		offset += 1;
		if (major === 7) {
			if (ai === 20) return [false, offset];
			if (ai === 21) return [true, offset];
			if (ai === 22) return [null, offset];
			if (ai === 23) return [undefined, offset];
			if (ai === 25) return [view.getFloat32(offset), offset + 2]; // half-float 近似处理（本项目不依赖）
			if (ai === 26) return [view.getFloat32(offset), offset + 4];
			if (ai === 27) return [view.getFloat64(offset), offset + 8];
			throw new Error('unsupported CBOR simple value ' + ai);
		}
		if (major === 6) {
			const [, next] = readLength(ai, offset);
			return decode(next); // tag：跳过标签，直接解值
		}
		const [len, next] = readLength(ai, offset);
		offset = next;
		if (major === 0) return [len, offset];
		if (major === 1) return [-1 - len, offset];
		if (major === 2) return [bytes.slice(offset, offset + len), offset + len];
		if (major === 3) {
			return [new TextDecoder().decode(bytes.slice(offset, offset + len)), offset + len];
		}
		if (major === 4) {
			const arr = [];
			for (let i = 0; i < len; i++) {
				const [v, n] = decode(offset);
				arr.push(v);
				offset = n;
			}
			return [arr, offset];
		}
		if (major === 5) {
			const map = new Map();
			for (let i = 0; i < len; i++) {
				const [k, n1] = decode(offset);
				const [v, n2] = decode(n1);
				map.set(k, v);
				offset = n2;
			}
			return [map, offset];
		}
		throw new Error('unsupported CBOR major type ' + major);
	}
	const [value] = decode(0);
	return value;
}

function parseAuthData(authData) {
	if (authData.length < 37) {
		throw new BizError(t('passkeyInvalidResponse'), 400);
	}
	const rpIdHash = authData.slice(0, 32);
	const flags = authData[32];
	const counter = (authData[33] << 24) | (authData[34] << 16) | (authData[35] << 8) | authData[36];
	let offset = 37;
	let credentialId = null;
	let coseKey = null;
	if (flags & 0x40) {
		// attestedCredentialData：aaguid(16) + credIdLen(2) + credentialId + COSE 公钥
		if (authData.length < offset + 18) {
			throw new BizError(t('passkeyInvalidResponse'), 400);
		}
		const credIdLen = (authData[offset + 16] << 8) | authData[offset + 17];
		offset += 18;
		credentialId = authData.slice(offset, offset + credIdLen);
		offset += credIdLen;
		const [key, next] = cborDecodeWithOffset(authData, offset);
		coseKey = key;
		offset = next;
	}
	return { rpIdHash, flags, counter, credentialId, coseKey, raw: authData };
}

// cborDecode 的带偏移版本（供 parseAuthData 在 authData 中途解析 COSE 密钥）。
function cborDecodeWithOffset(bytes, startOffset) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	function readLength(ai, offset) {
		if (ai < 24) return [ai, offset];
		if (ai === 24) return [view.getUint8(offset), offset + 1];
		if (ai === 25) return [view.getUint16(offset), offset + 2];
		if (ai === 26) return [view.getUint32(offset), offset + 4];
		if (ai === 27) return [view.getUint32(offset) * 0x100000000 + view.getUint32(offset + 4), offset + 8];
		throw new Error('unsupported CBOR additional info ' + ai);
	}
	function decode(offset) {
		const initial = view.getUint8(offset);
		const major = initial >> 5;
		const ai = initial & 0x1f;
		offset += 1;
		if (major === 7) {
			if (ai === 20) return [false, offset];
			if (ai === 21) return [true, offset];
			if (ai === 22) return [null, offset];
			if (ai === 23) return [undefined, offset];
			if (ai === 26) return [view.getFloat32(offset), offset + 4];
			if (ai === 27) return [view.getFloat64(offset), offset + 8];
			throw new Error('unsupported CBOR simple value ' + ai);
		}
		if (major === 6) {
			const [, next] = readLength(ai, offset);
			return decode(next);
		}
		const [len, next] = readLength(ai, offset);
		offset = next;
		if (major === 0) return [len, offset];
		if (major === 1) return [-1 - len, offset];
		if (major === 2) return [bytes.slice(offset, offset + len), offset + len];
		if (major === 3) return [new TextDecoder().decode(bytes.slice(offset, offset + len)), offset + len];
		if (major === 4) {
			const arr = [];
			for (let i = 0; i < len; i++) { const [v, n] = decode(offset); arr.push(v); offset = n; }
			return [arr, offset];
		}
		if (major === 5) {
			const map = new Map();
			for (let i = 0; i < len; i++) { const [k, n1] = decode(offset); const [v, n2] = decode(n1); map.set(k, v); offset = n2; }
			return [map, offset];
		}
		throw new Error('unsupported CBOR major type ' + major);
	}
	return decode(startOffset);
}

// COSE 公钥 Map → JWK。kty: 2=EC2, 1=OKP, 3=RSA；alg: -7=ES256, -8=EdDSA, -257=RS256。
function coseKeyToJwk(coseKey) {
	if (!(coseKey instanceof Map)) {
		throw new BizError(t('passkeyInvalidResponse'), 400);
	}
	const kty = coseKey.get(1);
	const alg = coseKey.get(3);
	if (kty === 2) {
		const crv = coseKey.get(-1);
		if (crv !== 1 || alg !== -7) throw new BizError(t('passkeyInvalidResponse'), 400);
		return { kty: 'EC', crv: 'P-256', x: b64urlEncode(coseKey.get(-2)), y: b64urlEncode(coseKey.get(-3)) };
	}
	if (kty === 1) {
		const crv = coseKey.get(-1);
		if (crv !== 6 || alg !== -8) throw new BizError(t('passkeyInvalidResponse'), 400);
		return { kty: 'OKP', crv: 'Ed25519', x: b64urlEncode(coseKey.get(-2)) };
	}
	if (kty === 3) {
		if (alg !== -257) throw new BizError(t('passkeyInvalidResponse'), 400);
		return { kty: 'RSA', n: b64urlEncode(coseKey.get(-1)), e: b64urlEncode(coseKey.get(-2)) };
	}
	throw new BizError(t('passkeyInvalidResponse'), 400);
}

function jwkToAlg(jwk) {
	if (jwk.kty === 'EC') return -7;
	if (jwk.kty === 'OKP') return -8;
	if (jwk.kty === 'RSA') return -257;
	throw new BizError(t('passkeyInvalidResponse'), 400);
}

// ES256 签名是 R||S 原始格式（64B，WebAuthn 回包格式）。
// 注意：workerd 的 WebCrypto ECDSA sign/verify 用的就是原始格式（实测：
// sign 返回 64 字节 raw，verify(raw)=true、verify(DER)=false），
// 因此这里直接把原始签名交给 verify，绝不能转 DER（Node 的 DER 惯例在此不适用）。
async function verifySignature(jwk, alg, data, signature) {
	try {
		if (alg === -7) {
			const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
			return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, data);
		}
		if (alg === -8) {
			const key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify']);
			return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, data);
		}
		if (alg === -257) {
			const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
			return await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, data);
		}
	} catch (e) {
		console.error('Passkey 验签失败:', e.message);
		return false;
	}
	return false;
}

function randomChallenge() {
	return b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

async function consumeChallenge(c, suffix) {
	const key = KvConst.PASSKEY_CHALLENGE + suffix;
	const challenge = await c.env.kv.get(key);
	if (!challenge) {
		throw new BizError(t('passkeyChallengeExpired'), 400);
	}
	await c.env.kv.delete(key);
	return challenge;
}

function parseClientData(response, expectedType, expectedChallenge) {
	if (!response || !response.clientDataJSON) {
		throw new BizError(t('passkeyInvalidResponse'), 400);
	}
	let clientData;
	try {
		clientData = JSON.parse(new TextDecoder().decode(b64urlDecode(response.clientDataJSON)));
	} catch (e) {
		throw new BizError(t('passkeyInvalidResponse'), 400);
	}
	if (clientData.type !== expectedType || clientData.challenge !== expectedChallenge || clientData.origin !== ORIGIN) {
		throw new BizError(t('passkeyInvalidResponse'), 400);
	}
	return { clientData, clientDataBytes: b64urlDecode(response.clientDataJSON) };
}

const passkeyService = {

	RP_ID,
	ORIGIN,
	b64urlEncode,
	b64urlDecode,
	cborDecode,

	async generateRegistrationOptions(c, userId, email) {
		const challenge = randomChallenge();
		await c.env.kv.put(KvConst.PASSKEY_CHALLENGE + 'reg:' + userId, challenge, { expirationTtl: 300 });
		const existing = await this.listCredentials(c, userId);
		return {
			challenge,
			rp: { name: RP_NAME, id: RP_ID },
			user: { id: b64urlEncode(new TextEncoder().encode(String(userId))), name: email, displayName: email },
			pubKeyCredParams: [
				{ type: 'public-key', alg: -7 },
				{ type: 'public-key', alg: -8 },
				{ type: 'public-key', alg: -257 }
			],
			timeout: 60000,
			attestation: 'none',
			authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
			excludeCredentials: existing.map(row => ({
				id: row.credentialId, type: 'public-key',
				transports: (() => { try { return JSON.parse(row.transports || '[]'); } catch (e) { return []; } })()
			}))
		};
	},

	// 注册第二步：验签通过后入库。返回 {credentialId, name}。
	async verifyAndStoreRegistration(c, userId, email, body) {
		const response = body?.response;
		if (!response || response.type !== 'public-key') {
			throw new BizError(t('passkeyInvalidResponse'), 400);
		}
		const expectedChallenge = await consumeChallenge(c, 'reg:' + userId);
		const { clientDataBytes } = parseClientData(response.response, 'webauthn.create', expectedChallenge);
		if (!response.response.attestationObject) {
			throw new BizError(t('passkeyInvalidResponse'), 400);
		}
		const attObj = cborDecode(b64urlDecode(response.response.attestationObject));
		if (!(attObj instanceof Map)) {
			throw new BizError(t('passkeyInvalidResponse'), 400);
		}
		const fmt = attObj.get('fmt');
		const attStmt = attObj.get('attStmt');
		const authData = attObj.get('authData');
		if (!authData || !(authData instanceof Uint8Array)) {
			throw new BizError(t('passkeyInvalidResponse'), 400);
		}
		const parsed = parseAuthData(authData);
		const expectedRpHash = await sha256(new TextEncoder().encode(RP_ID));
		if (!bytesEqual(parsed.rpIdHash, expectedRpHash)) {
			throw new BizError(t('passkeyInvalidResponse'), 400);
		}
		if (!(parsed.flags & 0x01) || !(parsed.flags & 0x40) || !parsed.credentialId || !parsed.coseKey) {
			throw new BizError(t('passkeyInvalidResponse'), 400);
		}
		const jwk = coseKeyToJwk(parsed.coseKey);
		const alg = jwkToAlg(jwk);
		// attStmt.alg（若有）须与 COSE 公钥 alg 一致。
		if (attStmt instanceof Map && attStmt.get('alg') !== undefined && attStmt.get('alg') !== alg) {
			throw new BizError(t('passkeyInvalidResponse'), 400);
		}
		if (fmt === 'none') {
			if (!(attStmt instanceof Map) || attStmt.size !== 0) {
				throw new BizError(t('passkeyInvalidResponse'), 400);
			}
		} else if (fmt === 'packed') {
			// 只接受自证明（无 x5c）：用凭证公钥验 attStmt.sig。
			if (!(attStmt instanceof Map) || !attStmt.get('sig') || attStmt.get('x5c')) {
				throw new BizError(t('passkeyUnsupportedAttestation'), 400);
			}
			const clientDataHash = await sha256(clientDataBytes);
			const signed = new Uint8Array(authData.length + clientDataHash.length);
			signed.set(authData, 0);
			signed.set(clientDataHash, authData.length);
			if (!await verifySignature(jwk, alg, signed, attStmt.get('sig'))) {
				throw new BizError(t('passkeyInvalidResponse'), 400);
			}
		} else {
			throw new BizError(t('passkeyUnsupportedAttestation'), 400);
		}
		const credentialId = b64urlEncode(parsed.credentialId);
		// credentialId 全局唯一：已被他人注册时拒绝。
		const dup = await orm(c).select().from(userPasskey).where(eq(userPasskey.credentialId, credentialId)).get();
		if (dup && dup.userId !== userId) {
			throw new BizError(t('passkeyInvalidResponse'), 400);
		}
		const transports = response.transports || response.response.transports || [];
		const name = (body.name || '').trim() || 'Passkey';
		const row = {
			credentialId,
			userId,
			publicKeyJwk: JSON.stringify(jwk),
			counter: parsed.counter || 0,
			transports: JSON.stringify(Array.isArray(transports) ? transports : []),
			name
		};
		if (dup) {
			await orm(c).update(userPasskey).set(row).where(eq(userPasskey.credentialId, credentialId)).run();
		} else {
			await orm(c).insert(userPasskey).values(row).run();
		}
		return { credentialId, name };
	},

	async listCredentials(c, userId) {
		return orm(c).select().from(userPasskey).where(eq(userPasskey.userId, userId)).all();
	},

	async deleteCredential(c, userId, credentialId) {
		const row = await orm(c).select().from(userPasskey).where(eq(userPasskey.credentialId, credentialId)).get();
		if (!row || row.userId !== userId) {
			throw new BizError(t('passkeyNotFound'), 404);
		}
		await orm(c).delete(userPasskey).where(eq(userPasskey.credentialId, credentialId)).run();
	},

	async generateAuthenticationOptions(c, email) {
		const userRow = await userService.selectByEmail(c, email);
		if (!userRow) {
			throw new BizError(t('notExistUser'), 400);
		}
		const challenge = randomChallenge();
		await c.env.kv.put(KvConst.PASSKEY_CHALLENGE + 'login:' + String(email).toLowerCase(), challenge, { expirationTtl: 300 });
		const creds = await this.listCredentials(c, userRow.userId);
		return {
			challenge,
			rpId: RP_ID,
			timeout: 60000,
			allowCredentials: creds.map(row => ({
				id: row.credentialId, type: 'public-key',
				transports: (() => { try { return JSON.parse(row.transports || '[]'); } catch (e) { return []; } })()
			})),
			userVerification: 'preferred'
		};
	},

	// 登录验签：通过返回 userId；counter 防重放（新 counter 须大于已存值；
	// 双方均为 0 的无计数设备放行；已存 >0 而新值为 0 时拒绝）。
	async verifyAuthentication(c, email, response) {
		if (!response || response.type !== 'public-key' || !response.id) {
			throw new BizError(t('passkeyInvalidResponse'), 400);
		}
		const expectedChallenge = await consumeChallenge(c, 'login:' + String(email).toLowerCase());
		const userRow = await userService.selectByEmail(c, email);
		if (!userRow) {
			throw new BizError(t('notExistUser'), 400);
		}
		const row = await orm(c).select().from(userPasskey).where(eq(userPasskey.credentialId, response.id)).get();
		if (!row || row.userId !== userRow.userId) {
			throw new BizError(t('passkeyInvalidResponse'), 400);
		}
		const { clientDataBytes } = parseClientData(response.response, 'webauthn.get', expectedChallenge);
		const authData = b64urlDecode(response.response.authenticatorData);
		const parsed = parseAuthData(authData);
		const expectedRpHash = await sha256(new TextEncoder().encode(RP_ID));
		if (!bytesEqual(parsed.rpIdHash, expectedRpHash) || !(parsed.flags & 0x01)) {
			throw new BizError(t('passkeyInvalidResponse'), 400);
		}
		// userHandle（若返回）须与注册时的 user.id 一致。
		if (response.response.userHandle) {
			const handle = b64urlDecode(response.response.userHandle);
			if (!bytesEqual(handle, new TextEncoder().encode(String(userRow.userId)))) {
				throw new BizError(t('passkeyInvalidResponse'), 400);
			}
		}
		if (parsed.counter > 0 && parsed.counter <= row.counter) {
			throw new BizError(t('passkeyCounterReplay'), 400);
		}
		if (parsed.counter === 0 && row.counter > 0) {
			throw new BizError(t('passkeyCounterReplay'), 400);
		}
		const signature = b64urlDecode(response.response.signature);
		const clientDataHash = await sha256(clientDataBytes);
		const signed = new Uint8Array(authData.length + clientDataHash.length);
		signed.set(authData, 0);
		signed.set(clientDataHash, authData.length);
		let jwk;
		try {
			jwk = JSON.parse(row.publicKeyJwk);
		} catch (e) {
			throw new BizError(t('passkeyInvalidResponse'), 400);
		}
		if (!await verifySignature(jwk, jwkToAlg(jwk), signed, signature)) {
			throw new BizError(t('passkeyInvalidResponse'), 400);
		}
		await orm(c).update(userPasskey).set({ counter: parsed.counter }).where(eq(userPasskey.credentialId, row.credentialId)).run();
		return userRow.userId;
	}
};

export default passkeyService;
