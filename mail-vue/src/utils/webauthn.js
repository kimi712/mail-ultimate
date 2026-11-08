// Passkey / WebAuthn 前后端 JSON 转换（第六阶段 C 路）。
// 后端按契约 §1.3 用 SimpleWebAuthn options JSON；浏览器 navigator.credentials.*
// 要求 ArrayBuffer 字段，故此处手写 base64url 互转，不引新依赖。
// 纯函数模块，无副作用，可在 node smoke 里直接测往返。

export function bufToB64url(buf) {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	let binary = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function b64urlToBuf(str) {
	const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
	const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function toArrayBuffer(value) {
	if (value instanceof ArrayBuffer) {
		return value;
	}
	if (value instanceof Uint8Array) {
		return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
	}
	return b64urlToBuf(value).buffer;
}

// POST /my/passkey/register-options 返回的 options → navigator.credentials.create() 参数
export function optionsToCreateArgs(options) {
	const opts = {...options};
	opts.challenge = toArrayBuffer(options.challenge);
	if (options.user && options.user.id) {
		opts.user = {...options.user, id: toArrayBuffer(options.user.id)};
	}
	if (Array.isArray(options.excludeCredentials)) {
		opts.excludeCredentials = options.excludeCredentials.map((c) => ({
			...c,
			id: toArrayBuffer(c.id)
		}));
	}
	return {publicKey: opts};
}

// navigator.credentials.create() 结果 → POST /my/passkey/register 的 {response}
export function credentialToJson(credential) {
	const response = credential.response;
	const json = {
		id: credential.id,
		rawId: bufToB64url(credential.rawId),
		type: credential.type,
		response: {
			attestationObject: bufToB64url(response.attestationObject),
			clientDataJSON: bufToB64url(response.clientDataJSON)
		}
	};
	if (typeof response.getTransports === 'function') {
		json.response.transports = response.getTransports();
	}
	return json;
}

// POST /login/passkey-options 返回的 options → navigator.credentials.get() 参数（登录页后续用）
export function optionsToGetArgs(options) {
	const opts = {...options};
	opts.challenge = toArrayBuffer(options.challenge);
	if (Array.isArray(options.allowCredentials)) {
		opts.allowCredentials = options.allowCredentials.map((c) => ({
			...c,
			id: toArrayBuffer(c.id)
		}));
	}
	return {publicKey: opts};
}

// navigator.credentials.get() 结果 → POST /login/passkey-verify 的 {response}（登录页后续用）
export function assertionToJson(assertion) {
	const response = assertion.response;
	const json = {
		id: assertion.id,
		rawId: bufToB64url(assertion.rawId),
		type: assertion.type,
		response: {
			authenticatorData: bufToB64url(response.authenticatorData),
			clientDataJSON: bufToB64url(response.clientDataJSON),
			signature: bufToB64url(response.signature)
		}
	};
	if (response.userHandle) {
		json.response.userHandle = bufToB64url(response.userHandle);
	}
	return json;
}
