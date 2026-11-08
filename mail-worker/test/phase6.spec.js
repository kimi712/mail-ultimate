// Phase 6 测试：vitest + @cloudflare/vitest-pool-workers。
// 覆盖：v3_7DB 迁移（表/索引/setting 列/email.e2ee 列 + 幂等）、字段加密往返 +
// 老明文兼容 + 无 key 回落明文、TOTP 开通/启用/登录 needTotp/验证/备份码/5 次锁定、
// Passkey options/注册/登录验签/counter 防重放、会话列表/踢出、user_security 读写 +
// 异地提醒开关生效、E2EE 站外拒发 + 站内放行、日志清理（超期删、未超期留）、
// IP 脱敏开关、安全头出现在响应里。
// 写法复用 test/phase2a.spec.js 的 fakeCtx/api/setSetting。
// 运行：mail-worker 下 npx vitest run test/phase6.spec.js。
// 注意：跑在本地 miniflare（wrangler.jsonc 占位绑定），不连线上 D1/KV。
// 注册总数控制在熔断阈值（20/分钟）内，且每次注册用不同 IP，避免触发 IP 限额/分钟限流。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import totpService from '../src/service/totp-service';
import fieldCrypto from '../src/utils/field-crypto';
import reqUtils from '../src/utils/req-utils';
import logRetentionService from '../src/service/log-retention-service';
import passkeyService from '../src/service/passkey-service';

const TEST_JWT_SECRET = 'phase1-local-test-only-not-a-real-secret';
const ORIGIN = 'https://aevorynthtech.com';
let ipCounter = 100;

function nextIp() {
	ipCounter += 1;
	return `203.0.113.${ipCounter}`;
}

function fakeCtx(ip) {
	return {
		env,
		req: { header: (name) => (name === 'CF-Connecting-IP' ? ip : name === 'user-agent' ? 'phase6-test/1.0' : null) },
		get: () => undefined,
		set: () => {}
	};
}

async function api(path, { method = 'GET', body, token, ip } = {}) {
	const headers = { 'Content-Type': 'application/json' };
	if (token) headers['Authorization'] = token;
	if (ip) headers['CF-Connecting-IP'] = ip;
	const res = await SELF.fetch(`http://example.com/api${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	let json = null;
	try {
		json = await res.json();
	} catch (e) {
		// 非 JSON 响应忽略
	}
	return { status: res.status, json, headers: res.headers };
}

async function register(email, ip, extra = {}) {
	return api('/register', {
		method: 'POST',
		ip,
		body: { email, password: 'password123', ...extra }
	});
}

async function login(email, ip, password = 'password123') {
	return api('/login', { method: 'POST', ip, body: { email, password } });
}

async function makeUser(email) {
	const ip = nextIp();
	const reg = await register(email, ip);
	expect(reg.json.code).toBe(200);
	const loginRes = await login(email, ip);
	expect(loginRes.json.code).toBe(200);
	const row = await env.db.prepare('SELECT user_id FROM user WHERE email = ?').bind(email).first();
	return { token: loginRes.json.data.token, userId: row.user_id, ip };
}

// 默认角色改为可发信（day 100 封），供异地提醒 / E2EE 发信测试用。
async function allowSending() {
	await env.db.prepare(
		`UPDATE role SET send_type = 'day', send_count = 100, avail_domain = '' WHERE role_id = 1`
	).run();
}

async function accountIdOf(email) {
	const row = await env.db.prepare('SELECT account_id FROM account WHERE email = ?').bind(email).first();
	return row.account_id;
}

const SETTING_COLUMN_MAP = {
	registerVerify: 'register_verify',
	regKeyAlertThreshold: 'reg_key_alert_threshold',
	logRetentionDays: 'log_retention_days',
	logIpMask: 'log_ip_mask'
};

async function setSetting(fields) {
	const assignments = [];
	const binds = [];
	for (const [key, value] of Object.entries(fields)) {
		const column = SETTING_COLUMN_MAP[key];
		if (!column) continue;
		assignments.push(`${column} = ?`);
		binds.push(value);
	}
	if (assignments.length) {
		await env.db.prepare(`UPDATE setting SET ${assignments.join(', ')}`).bind(...binds).run();
	}
	const cached = (await env.kv.get('setting:', { type: 'json' })) || {};
	for (const [key, value] of Object.entries(fields)) {
		cached[key] = value;
	}
	await env.kv.put('setting:', JSON.stringify(cached));
}

// ---- base64url / CBOR（测试内虚拟 Passkey 认证器用） ----
function b64urlEncode(bytes) {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function concatBytes(...parts) {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

function cborUint(major, n) {
	if (n < 24) return new Uint8Array([(major << 5) | n]);
	if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
	if (n < 65536) return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
	throw new Error('cbor int too large for test encoder');
}

function cborInt(n) {
	return n >= 0 ? cborUint(0, n) : cborUint(1, -1 - n);
}

function cborBytes(b) {
	return concatBytes(cborUint(2, b.length), b);
}

function cborText(s) {
	const b = new TextEncoder().encode(s);
	return concatBytes(cborUint(3, b.length), b);
}

function cborMap(entries) {
	const parts = [cborUint(5, entries.length)];
	for (const [k, v] of entries) {
		parts.push(typeof k === 'number' ? cborInt(k) : cborText(k), v);
	}
	return concatBytes(...parts);
}

async function sha256(bytes) {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

// WebCrypto ECDSA 签名是 DER 格式，转回 R||S 原始格式（认证器回包格式）。
// 注意：workerd 下 crypto.subtle.sign 对 ECDSA 有时直接返回 R||S 原始格式
// （首字节非 0x30），此时 64 字节直接采用；真实认证器回包同样是原始格式。
function derToRawEcdsa(der) {
	if (der.length === 64 && der[0] !== 0x30) {
		return der;
	}
	let o = 0;
	if (der[o++] !== 0x30) throw new Error('bad DER');
	let len = der[o++];
	if (len & 0x80) {
		const n = len & 0x7f;
		len = 0;
		for (let i = 0; i < n; i++) len = (len << 8) | der[o++];
	}
	const readInt = () => {
		if (der[o++] !== 0x02) throw new Error('bad DER int');
		const l = der[o++];
		let v = der.slice(o, o + l);
		o += l;
		while (v.length > 1 && v[0] === 0) v = v.slice(1);
		const out = new Uint8Array(32);
		out.set(v, 32 - v.length);
		return out;
	};
	return concatBytes(readInt(), readInt());
}

let initText = '';
beforeAll(async () => {
	const res = await SELF.fetch(`http://example.com/api/init/${TEST_JWT_SECRET}`);
	initText = await res.text();
	// 关 Turnstile 验证（register_verify=CLOSE），只测本路逻辑
	await setSetting({ registerVerify: 1 });
	await allowSending();
}, 30000);

describe('v3_7DB 迁移', () => {
	it('init 成功', () => {
		expect(initText).toBe('success');
	});

	it('user_totp / user_passkey / user_security 三表已建', async () => {
		const { results } = await env.db.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('user_totp', 'user_passkey', 'user_security')`
		).all();
		expect(results.map((r) => r.name).sort()).toEqual(['user_passkey', 'user_security', 'user_totp']);
	});

	it('idx_user_passkey_user 索引已建', async () => {
		const { results } = await env.db.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_user_passkey_user'`
		).all();
		expect(results.length).toBe(1);
	});

	it('setting.log_retention_days / log_ip_mask 与 email.e2ee 列已建', async () => {
		const settingCols = await env.db.prepare(`SELECT name FROM pragma_table_info('setting')`).all();
		const names = settingCols.results.map((r) => r.name);
		expect(names).toContain('log_retention_days');
		expect(names).toContain('log_ip_mask');
		const emailCols = await env.db.prepare(`SELECT name FROM pragma_table_info('email')`).all();
		expect(emailCols.results.map((r) => r.name)).toContain('e2ee');
	});

	it('再跑一次 /init 幂等成功', async () => {
		const res = await SELF.fetch(`http://example.com/api/init/${TEST_JWT_SECRET}`);
		expect(await res.text()).toBe('success');
		const { results } = await env.db.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_totp'`
		).all();
		expect(results.length).toBe(1);
	});
});

describe('安全头', () => {
	it('公开接口响应带齐 5 组安全头', async () => {
		const res = await api('/setting/websiteConfig');
		expect(res.json.code).toBe(200);
		const hsts = res.headers.get('strict-transport-security') || '';
		expect(hsts).toContain('max-age=31536000');
		expect(hsts).toContain('includeSubDomains');
		expect(hsts).not.toContain('preload');
		const csp = res.headers.get('content-security-policy') || '';
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain('https://challenges.cloudflare.com');
		expect(csp).toContain("frame-ancestors 'none'");
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('x-frame-options')).toBe('DENY');
		expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
	});

	it('登录接口响应也带安全头', async () => {
		const user = await makeUser('p6-headers@example.com');
		expect(user.token).toBeTruthy();
		const res = await api('/my/loginUserInfo', { token: user.token });
		expect(res.json.code).toBe(200);
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('x-frame-options')).toBe('DENY');
	});
});

describe('字段加密', () => {
	it('AES-GCM 往返 + 信封格式', async () => {
		const ctx = fakeCtx(nextIp());
		const enc = await fieldCrypto.encrypt(ctx, 'sk-test-secret-value');
		expect(enc.startsWith('enc:v1:')).toBe(true);
		expect(enc).not.toContain('sk-test-secret-value');
		expect(await fieldCrypto.decrypt(ctx, enc)).toBe('sk-test-secret-value');
		// 两次加密 IV 不同，密文不同
		const enc2 = await fieldCrypto.encrypt(ctx, 'sk-test-secret-value');
		expect(enc2).not.toBe(enc);
		expect(await fieldCrypto.decrypt(ctx, enc2)).toBe('sk-test-secret-value');
	});

	it('decrypt 遇老明文原样返回；无 key 时存明文', async () => {
		const ctx = fakeCtx(nextIp());
		expect(await fieldCrypto.decrypt(ctx, 'plain-old-value')).toBe('plain-old-value');
		expect(await fieldCrypto.decrypt(ctx, '')).toBe('');
		const noKeyCtx = { env: {} };
		expect(await fieldCrypto.encrypt(noKeyCtx, 'still-plain')).toBe('still-plain');
		expect(await fieldCrypto.decrypt(noKeyCtx, 'enc:v1:AAAA')).toBe('enc:v1:AAAA');
	});

	it('setting.set() 写入加密、get() 读回打码解密值', async () => {
		const reg = await register('admin@example.com', nextIp());
		expect(reg.json.code).toBe(200);
		const loginRes = await login('admin@example.com', nextIp());
		expect(loginRes.json.code).toBe(200);
		const adminToken = loginRes.json.data.token;
		const setRes = await api('/setting/set', {
			method: 'PUT',
			token: adminToken,
			body: { secretKey: 'sk-p6-secret-abcdef', tgBotToken: 'tg-p6-token-1234567890', resendTokens: { 'example.com': 're-p6-token-xyz' } }
		});
		expect(setRes.json.code).toBe(200);
		const dbRow = await env.db.prepare(
			`SELECT secret_key, tg_bot_token, resend_tokens FROM setting LIMIT 1`
		).first();
		expect(dbRow.secret_key.startsWith('enc:v1:')).toBe(true);
		expect(dbRow.tg_bot_token.startsWith('enc:v1:')).toBe(true);
		expect(dbRow.resend_tokens.startsWith('enc:v1:')).toBe(true);
		const getRes = await api('/setting/query', { token: adminToken });
		expect(getRes.json.code).toBe(200);
		// get() 打码逻辑不动：解密后的值按原规则打码
		expect(getRes.json.data.secretKey).toBe('sk-p6-******');
		expect(getRes.json.data.tgBotToken.startsWith('tg-p6-token-12345678')).toBe(true);
		expect(getRes.json.data.resendTokens['example.com']).toBe('re-p6-token-******');
	});
});

describe('TOTP', () => {
	it('setup 返回 secret + otpauthUrl；secret 加密存储', async () => {
		const user = await makeUser('p6-totp@example.com');
		const setup = await api('/my/totp/setup', { method: 'POST', token: user.token, body: {} });
		expect(setup.json.code).toBe(200);
		expect(setup.json.data.secret).toMatch(/^[A-Z2-7]+=*$/);
		expect(setup.json.data.otpauthUrl).toContain('otpauth://totp/');
		expect(setup.json.data.otpauthUrl).toContain(setup.json.data.secret);
		const row = await env.db.prepare('SELECT secret_encrypted, enabled FROM user_totp WHERE user_id = ?').bind(user.userId).first();
		expect(row.secret_encrypted.startsWith('enc:v1:')).toBe(true);
		expect(row.enabled).toBe(0);
	});

	it('enable 错码拒绝、对码通过并返回 10 个备份码', async () => {
		const user = await makeUser('p6-totp-enable@example.com');
		const setup = await api('/my/totp/setup', { method: 'POST', token: user.token, body: {} });
		const secret = setup.json.data.secret;
		const bad = await api('/my/totp/enable', { method: 'POST', token: user.token, body: { code: '000000' } });
		expect(bad.json.code).not.toBe(200);
		const goodCode = await totpService.generateCode(secret);
		const ok = await api('/my/totp/enable', { method: 'POST', token: user.token, body: { code: goodCode } });
		expect(ok.json.code).toBe(200);
		expect(ok.json.data.backupCodes.length).toBe(10);
		const row = await env.db.prepare('SELECT enabled, backup_codes_hash FROM user_totp WHERE user_id = ?').bind(user.userId).first();
		expect(row.enabled).toBe(1);
		expect(JSON.parse(row.backup_codes_hash).length).toBe(10);
	});

	it('开启后登录返回 needTotp；/login/totp 验码换正式 JWT', async () => {
		const user = await makeUser('p6-totp-login@example.com');
		const setup = await api('/my/totp/setup', { method: 'POST', token: user.token, body: {} });
		const code = await totpService.generateCode(setup.json.data.secret);
		await api('/my/totp/enable', { method: 'POST', token: user.token, body: { code } });
		// 密码登录不再直接给 token
		const loginRes = await login('p6-totp-login@example.com', user.ip);
		expect(loginRes.json.code).toBe(200);
		expect(loginRes.json.data.needTotp).toBe(true);
		expect(loginRes.json.data.totpToken).toBeTruthy();
		expect(loginRes.json.data.token).toBeUndefined();
		const totpToken = loginRes.json.data.totpToken;
		// 错码拒绝
		const bad = await api('/login/totp', { method: 'POST', body: { totpToken, code: '123456' } });
		expect(bad.json.code).not.toBe(200);
		// 对码换 JWT，且 JWT 可用
		const goodCode = await totpService.generateCode(setup.json.data.secret);
		const ok = await api('/login/totp', { method: 'POST', body: { totpToken, code: goodCode } });
		expect(ok.json.code).toBe(200);
		expect(ok.json.data.token).toBeTruthy();
		const me = await api('/my/loginUserInfo', { token: ok.json.data.token });
		expect(me.json.code).toBe(200);
		// totpToken 一次性：再用已作废
		const reuse = await api('/login/totp', { method: 'POST', body: { totpToken, code: goodCode } });
		expect(reuse.json.code).not.toBe(200);
	});

	it('备份码可代替 TOTP 码登录，用一次作废', async () => {
		const user = await makeUser('p6-totp-backup@example.com');
		const setup = await api('/my/totp/setup', { method: 'POST', token: user.token, body: {} });
		const code = await totpService.generateCode(setup.json.data.secret);
		const enabled = await api('/my/totp/enable', { method: 'POST', token: user.token, body: { code } });
		const backupCode = enabled.json.data.backupCodes[0];
		const loginRes = await login('p6-totp-backup@example.com', user.ip);
		const ok = await api('/login/totp', { method: 'POST', body: { totpToken: loginRes.json.data.totpToken, code: backupCode } });
		expect(ok.json.code).toBe(200);
		// 同一备份码再用一次：须重新密码登录拿新 totpToken，再验同一码应失败
		const loginRes2 = await login('p6-totp-backup@example.com', user.ip);
		const reuse = await api('/login/totp', { method: 'POST', body: { totpToken: loginRes2.json.data.totpToken, code: backupCode } });
		expect(reuse.json.code).not.toBe(200);
	});

	it('失败 5 次作废 totpToken', async () => {
		const user = await makeUser('p6-totp-lock@example.com');
		const setup = await api('/my/totp/setup', { method: 'POST', token: user.token, body: {} });
		const code = await totpService.generateCode(setup.json.data.secret);
		await api('/my/totp/enable', { method: 'POST', token: user.token, body: { code } });
		const loginRes = await login('p6-totp-lock@example.com', user.ip);
		const totpToken = loginRes.json.data.totpToken;
		for (let i = 0; i < 4; i++) {
			const r = await api('/login/totp', { method: 'POST', body: { totpToken, code: '999999' } });
			expect(r.json.code).toBe(400);
		}
		const fifth = await api('/login/totp', { method: 'POST', body: { totpToken, code: '999999' } });
		expect(fifth.json.code).toBe(403);
		// 第 5 次已作废：对码也换不到 JWT
		const goodCode = await totpService.generateCode(setup.json.data.secret);
		const after = await api('/login/totp', { method: 'POST', body: { totpToken, code: goodCode } });
		expect(after.json.code).not.toBe(200);
	});

	it('disable 需密码 + 码；关闭后登录直接给 token', async () => {
		const user = await makeUser('p6-totp-disable@example.com');
		const setup = await api('/my/totp/setup', { method: 'POST', token: user.token, body: {} });
		const code = await totpService.generateCode(setup.json.data.secret);
		await api('/my/totp/enable', { method: 'POST', token: user.token, body: { code } });
		const badPwd = await api('/my/totp/disable', { method: 'POST', token: user.token, body: { password: 'wrong-password', code } });
		expect(badPwd.json.code).not.toBe(200);
		const code2 = await totpService.generateCode(setup.json.data.secret);
		const ok = await api('/my/totp/disable', { method: 'POST', token: user.token, body: { password: 'password123', code: code2 } });
		expect(ok.json.code).toBe(200);
		const loginRes = await login('p6-totp-disable@example.com', user.ip);
		expect(loginRes.json.code).toBe(200);
		expect(loginRes.json.data.token).toBeTruthy();
		expect(loginRes.json.data.needTotp).toBeUndefined();
	});
});

describe('Passkey', () => {
	// 虚拟认证器：ES256 密钥对 + 手工构造 registration / assertion 回包。
	async function makeAuthenticator() {
		const keyPair = await crypto.subtle.generateKey(
			{ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
		);
		const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
		const credentialId = crypto.getRandomValues(new Uint8Array(16));
		return { keyPair, jwk, credentialId };
	}

	function cosePublicKey(jwk) {
		const x = passkeyService.b64urlDecode(jwk.x);
		const y = passkeyService.b64urlDecode(jwk.y);
		return cborMap([
			[1, cborInt(2)],
			[3, cborInt(-7)],
			[-1, cborInt(1)],
			[-2, cborBytes(x)],
			[-3, cborBytes(y)]
		]);
	}

	async function buildRegistrationResponse(auth, challenge, origin = ORIGIN) {
		const clientData = { type: 'webauthn.create', challenge, origin };
		const clientDataBytes = new TextEncoder().encode(JSON.stringify(clientData));
		const rpIdHash = await sha256(new TextEncoder().encode('aevorynthtech.com'));
		const authData = concatBytes(
			rpIdHash,
			new Uint8Array([0x41]),
			new Uint8Array([0, 0, 0, 0]),
			new Uint8Array(16),
			new Uint8Array([0, auth.credentialId.length]),
			auth.credentialId,
			cosePublicKey(auth.jwk)
		);
		const attestationObject = cborMap([
			['fmt', cborText('none')],
			['attStmt', cborMap([])],
			['authData', cborBytes(authData)]
		]);
		return {
			id: b64urlEncode(auth.credentialId),
			rawId: b64urlEncode(auth.credentialId),
			type: 'public-key',
			response: {
				attestationObject: b64urlEncode(attestationObject),
				clientDataJSON: b64urlEncode(clientDataBytes)
			}
		};
	}

	async function buildAssertionResponse(auth, userId, challenge, counter, origin = ORIGIN) {
		const clientData = { type: 'webauthn.get', challenge, origin };
		const clientDataBytes = new TextEncoder().encode(JSON.stringify(clientData));
		const rpIdHash = await sha256(new TextEncoder().encode('aevorynthtech.com'));
		const authData = concatBytes(
			rpIdHash,
			new Uint8Array([0x01]),
			new Uint8Array([(counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff])
		);
		const signed = concatBytes(authData, await sha256(clientDataBytes));
		const derSig = new Uint8Array(await crypto.subtle.sign(
			{ name: 'ECDSA', hash: 'SHA-256' }, auth.keyPair.privateKey, signed
		));
		return {
			id: b64urlEncode(auth.credentialId),
			rawId: b64urlEncode(auth.credentialId),
			type: 'public-key',
			response: {
				authenticatorData: b64urlEncode(authData),
				clientDataJSON: b64urlEncode(clientDataBytes),
				signature: b64urlEncode(derToRawEcdsa(derSig)),
				userHandle: b64urlEncode(new TextEncoder().encode(String(userId)))
			}
		};
	}

	it('register-options 返回 RP 与 challenge；注册验签通过并入库', async () => {
		const user = await makeUser('p6-passkey@example.com');
		const options = await api('/my/passkey/register-options', { method: 'POST', token: user.token, body: {} });
		expect(options.json.code).toBe(200);
		expect(options.json.data.rp.id).toBe('aevorynthtech.com');
		expect(options.json.data.challenge).toBeTruthy();
		expect(options.json.data.pubKeyCredParams.some((p) => p.alg === -7)).toBe(true);
		const auth = await makeAuthenticator();
		const response = await buildRegistrationResponse(auth, options.json.data.challenge);
		const reg = await api('/my/passkey/register', { method: 'POST', token: user.token, body: { response, name: '我的密钥' } });
		expect(reg.json.code).toBe(200);
		expect(reg.json.data.credentialId).toBe(b64urlEncode(auth.credentialId));
		expect(reg.json.data.name).toBe('我的密钥');
		const row = await env.db.prepare('SELECT user_id, public_key_jwk, counter FROM user_passkey WHERE credential_id = ?')
			.bind(reg.json.data.credentialId).first();
		expect(row.user_id).toBe(user.userId);
		expect(JSON.parse(row.public_key_jwk).kty).toBe('EC');
		expect(row.counter).toBe(0);
	});

	it('注册时 origin 不符被拒；challenge 一次性使用', async () => {
		const user = await makeUser('p6-passkey-bad@example.com');
		const options = await api('/my/passkey/register-options', { method: 'POST', token: user.token, body: {} });
		const auth = await makeAuthenticator();
		const badOrigin = await buildRegistrationResponse(auth, options.json.data.challenge, 'https://evil.example.com');
		const bad = await api('/my/passkey/register', { method: 'POST', token: user.token, body: { response: badOrigin } });
		expect(bad.json.code).not.toBe(200);
		// challenge 已消费：同一 challenge 的正确回包也应失败（须重新取 options）
		const replay = await buildRegistrationResponse(auth, options.json.data.challenge);
		const replayRes = await api('/my/passkey/register', { method: 'POST', token: user.token, body: { response: replay } });
		expect(replayRes.json.code).not.toBe(200);
	});

	it('Passkey 登录验签通过发 JWT；counter 防重放；列表与删除', async () => {
		const user = await makeUser('p6-passkey-login@example.com');
		const options = await api('/my/passkey/register-options', { method: 'POST', token: user.token, body: {} });
		const auth = await makeAuthenticator();
		const regRes = await api('/my/passkey/register', {
			method: 'POST', token: user.token,
			body: { response: await buildRegistrationResponse(auth, options.json.data.challenge) }
		});
		expect(regRes.json.code).toBe(200);

		// 登录 options + 验签（counter=1）
		const loginOpts = await api('/login/passkey-options', { method: 'POST', body: { email: 'p6-passkey-login@example.com' } });
		expect(loginOpts.json.code).toBe(200);
		expect(loginOpts.json.data.rpId).toBe('aevorynthtech.com');
		const assertion = await buildAssertionResponse(auth, user.userId, loginOpts.json.data.challenge, 1);
		const verify = await api('/login/passkey-verify', { method: 'POST', body: { email: 'p6-passkey-login@example.com', response: assertion } });
		expect(verify.json.code).toBe(200);
		expect(verify.json.data.token).toBeTruthy();
		const me = await api('/my/loginUserInfo', { token: verify.json.data.token });
		expect(me.json.code).toBe(200);
		let row = await env.db.prepare('SELECT counter FROM user_passkey WHERE credential_id = ?').bind(regRes.json.data.credentialId).first();
		expect(row.counter).toBe(1);

		// 重放：同一 counter=1 再验一次应被拒
		const loginOpts2 = await api('/login/passkey-options', { method: 'POST', body: { email: 'p6-passkey-login@example.com' } });
		const replay = await buildAssertionResponse(auth, user.userId, loginOpts2.json.data.challenge, 1);
		const replayRes = await api('/login/passkey-verify', { method: 'POST', body: { email: 'p6-passkey-login@example.com', response: replay } });
		expect(replayRes.json.code).not.toBe(200);

		// counter=2 正常通过
		const loginOpts3 = await api('/login/passkey-options', { method: 'POST', body: { email: 'p6-passkey-login@example.com' } });
		const assertion2 = await buildAssertionResponse(auth, user.userId, loginOpts3.json.data.challenge, 2);
		const verify2 = await api('/login/passkey-verify', { method: 'POST', body: { email: 'p6-passkey-login@example.com', response: assertion2 } });
		expect(verify2.json.code).toBe(200);
		row = await env.db.prepare('SELECT counter FROM user_passkey WHERE credential_id = ?').bind(regRes.json.data.credentialId).first();
		expect(row.counter).toBe(2);

		// 列表与删除
		const list = await api('/my/passkey/list', { token: user.token });
		expect(list.json.code).toBe(200);
		expect(list.json.data.some((item) => item.credentialId === regRes.json.data.credentialId)).toBe(true);
		const del = await api(`/my/passkey/${regRes.json.data.credentialId}`, { method: 'DELETE', token: user.token });
		expect(del.json.code).toBe(200);
		const list2 = await api('/my/passkey/list', { token: user.token });
		expect(list2.json.data.some((item) => item.credentialId === regRes.json.data.credentialId)).toBe(false);
	});
});

describe('会话管理', () => {
	it('登录写 SESSION_META；列表含 digest/current，绝不返回完整 token', async () => {
		const user = await makeUser('p6-session@example.com');
		const ip2 = nextIp();
		const login2 = await login('p6-session@example.com', ip2);
		expect(login2.json.code).toBe(200);
		const list = await api('/my/sessions', { token: login2.json.data.token });
		expect(list.json.code).toBe(200);
		expect(list.json.data.length).toBe(2);
		for (const item of list.json.data) {
			expect(item.digest.length).toBe(8);
			expect(typeof item.ua).toBe('string');
			expect(typeof item.ip).toBe('string');
			expect(typeof item.createdAt).toBe('string');
			expect(typeof item.current).toBe('boolean');
		}
		expect(list.json.data.filter((item) => item.current).length).toBe(1);
		expect(JSON.stringify(list.json.data)).not.toContain(login2.json.data.token);
		expect(JSON.stringify(list.json.data)).not.toContain(user.token);
		const meta = await env.kv.get(`session_meta:${user.userId}`, { type: 'json' });
		expect(meta).toBeTruthy();
		expect(Object.keys(meta).length).toBe(2);
	});

	it('踢出指定会话后该 token 失效；踢出其他全部后当前会话仍可用', async () => {
		const user = await makeUser('p6-session-revoke@example.com');
		const login2 = await login('p6-session-revoke@example.com', nextIp());
		const login3 = await login('p6-session-revoke@example.com', nextIp());
		const list = await api('/my/sessions', { token: login3.json.data.token });
		expect(list.json.data.length).toBe(3);
		const other = list.json.data.find((item) => !item.current);
		const revoke = await api('/my/sessions/revoke', { method: 'POST', token: login3.json.data.token, body: { digest: other.digest } });
		expect(revoke.json.code).toBe(200);
		// digest 是 token uuid 前 8 位：从 JWT payload 里取 uuid 再匹配被踢的 token。
		const tokenUuid = (jwt) => {
			const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
			return JSON.parse(atob(part)).token;
		};
		const deadToken = [user.token, login2.json.data.token].find(
			(t) => tokenUuid(t).slice(0, 8) === other.digest
		);
		expect(deadToken).toBeTruthy();
		const dead = await api('/my/loginUserInfo', { token: deadToken });
		expect(dead.json.code).toBe(401);
		const alive = await api('/my/loginUserInfo', { token: login3.json.data.token });
		expect(alive.json.code).toBe(200);

		const all = await api('/my/sessions/revoke', { method: 'POST', token: login3.json.data.token, body: { allExceptCurrent: true } });
		expect(all.json.code).toBe(200);
		const list2 = await api('/my/sessions', { token: login3.json.data.token });
		expect(list2.json.data.length).toBe(1);
		expect(list2.json.data[0].current).toBe(true);
	});

	it('登出时同步清本设备会话 meta', async () => {
		const user = await makeUser('p6-session-logout@example.com');
		const metaBefore = await env.kv.get(`session_meta:${user.userId}`, { type: 'json' });
		expect(Object.keys(metaBefore).length).toBe(1);
		const digest = Object.keys(metaBefore)[0];
		const out = await api('/logout', { method: 'DELETE', token: user.token });
		expect(out.json.code).toBe(200);
		const metaAfter = await env.kv.get(`session_meta:${user.userId}`, { type: 'json' });
		expect(metaAfter[digest]).toBeUndefined();
		const dead = await api('/my/loginUserInfo', { token: user.token });
		expect(dead.json.code).toBe(401);
	});
});

describe('个性化安全中心', () => {
	it('GET 默认值；POST 读写；retentionDays 只接受 0/30/90/365', async () => {
		const user = await makeUser('p6-security@example.com');
		const before = await api('/my/security', { token: user.token });
		expect(before.json.code).toBe(200);
		expect(before.json.data).toEqual({ loginAlert: 1, e2eeEnabled: 0, retentionDays: 0, e2eeSalt: '', totpEnabled: false, autoLockMinutes: 0 });
		const set = await api('/my/security', { method: 'POST', token: user.token, body: { loginAlert: 0, retentionDays: 90, e2eeSalt: 'testsalt123' } });
		expect(set.json.code).toBe(200);
		const after = await api('/my/security', { token: user.token });
		expect(after.json.data.loginAlert).toBe(0);
		expect(after.json.data.retentionDays).toBe(90);
		expect(after.json.data.e2eeSalt).toBe('testsalt123');
		const bad = await api('/my/security', { method: 'POST', token: user.token, body: { retentionDays: 45 } });
		expect(bad.json.code).not.toBe(200);
		const still = await api('/my/security', { token: user.token });
		expect(still.json.data.retentionDays).toBe(90);
	});

	it('开启 TOTP 后 GET /my/security 返回 totpEnabled=true（C 路对齐项）', async () => {
		const user = await makeUser('p6-security-totp@example.com');
		const before = await api('/my/security', { token: user.token });
		expect(before.json.data.totpEnabled).toBe(false);
		const setup = await api('/my/totp/setup', { method: 'POST', token: user.token, body: {} });
		const code = await totpService.generateCode(setup.json.data.secret);
		const enabled = await api('/my/totp/enable', { method: 'POST', token: user.token, body: { code } });
		expect(enabled.json.code).toBe(200);
		const after = await api('/my/security', { token: user.token });
		expect(after.json.code).toBe(200);
		expect(after.json.data.totpEnabled).toBe(true);
	});

	it('login_alert 关闭后异地登录不再发提醒，但登录历史照常记', async () => {
		const user = await makeUser('p6-security-alert@example.com');
		const ipB = nextIp();
		const sentBefore = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM email WHERE user_id = ? AND type = 1`
		).bind(user.userId).first();
		const loginB = await login('p6-security-alert@example.com', ipB);
		expect(loginB.json.code).toBe(200);
		let row = await env.db.prepare(
			`SELECT is_new_ip FROM login_log WHERE user_id = ? ORDER BY log_id DESC LIMIT 1`
		).bind(user.userId).first();
		expect(row.is_new_ip).toBe(1);
		const sentAfterOn = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM email WHERE user_id = ? AND type = 1`
		).bind(user.userId).first();
		expect(sentAfterOn.n).toBe(sentBefore.n + 1);

		// 关提醒后再换 IP 登录：日志仍标新，提醒邮件不再增加
		await api('/my/security', { method: 'POST', token: loginB.json.data.token, body: { loginAlert: 0 } });
		const ipC = nextIp();
		const loginC = await login('p6-security-alert@example.com', ipC);
		expect(loginC.json.code).toBe(200);
		row = await env.db.prepare(
			`SELECT is_new_ip FROM login_log WHERE user_id = ? ORDER BY log_id DESC LIMIT 1`
		).bind(user.userId).first();
		expect(row.is_new_ip).toBe(1);
		const sentAfterOff = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM email WHERE user_id = ? AND type = 1`
		).bind(user.userId).first();
		expect(sentAfterOff.n).toBe(sentAfterOn.n);
	});
});

describe('E2EE 后端门', () => {
	it('e2ee_enabled=1 时站外拒发、站内放行并存 e2ee=1；未开启时 e2ee=0', async () => {
		const sender = await makeUser('p6-e2ee-send@example.com');
		const recipient = await makeUser('p6-e2ee-recv@example.com');
		await api('/my/security', { method: 'POST', token: sender.token, body: { e2eeEnabled: 1 } });
		const blocked = await api('/email/send', {
			method: 'POST', token: sender.token,
			body: {
				accountId: await accountIdOf('p6-e2ee-send@example.com'),
				receiveEmail: ['someone@gmail.com'],
				subject: 'external', text: 'ciphertext', content: '<p>ciphertext</p>'
			}
		});
		expect(blocked.json.code).toBe(400);
		expect(blocked.json.message).toContain('端到端加密');

		const internal = await api('/email/send', {
			method: 'POST', token: sender.token,
			body: {
				accountId: await accountIdOf('p6-e2ee-send@example.com'),
				receiveEmail: ['p6-e2ee-recv@example.com'],
				subject: 'internal-e2ee', text: 'ciphertext', content: '<p>ciphertext</p>', e2ee: 1
			}
		});
		expect(internal.json.code).toBe(200);
		const sentRow = await env.db.prepare(
			`SELECT e2ee FROM email WHERE user_id = ? AND type = 1 ORDER BY email_id DESC LIMIT 1`
		).bind(sender.userId).first();
		expect(sentRow.e2ee).toBe(1);

		// 关闭 E2EE 后站内发送 e2ee=0
		await api('/my/security', { method: 'POST', token: sender.token, body: { e2eeEnabled: 0 } });
		const plain = await api('/email/send', {
			method: 'POST', token: sender.token,
			body: {
				accountId: await accountIdOf('p6-e2ee-send@example.com'),
				receiveEmail: ['p6-e2ee-recv@example.com'],
				subject: 'internal-plain', text: 'hello', content: '<p>hello</p>'
			}
		});
		expect(plain.json.code).toBe(200);
		const plainRow = await env.db.prepare(
			`SELECT e2ee FROM email WHERE user_id = ? AND type = 1 ORDER BY email_id DESC LIMIT 1`
		).bind(sender.userId).first();
		expect(plainRow.e2ee).toBe(0);
	});
});

describe('日志留存清理', () => {
	it('超期日志删除、未超期保留；用户超期邮件软删', async () => {
		const ctx = fakeCtx(nextIp());
		await env.db.prepare(
			`INSERT INTO register_log (ip, ip_segment, email, result, create_time) VALUES
			 ('203.0.113.201', '203.0.113.201', 'old@example.com', 0, '2020-01-01 00:00:00'),
			 ('203.0.113.202', '203.0.113.202', 'new@example.com', 0, datetime('now'))`
		).run();
		await env.db.prepare(
			`INSERT INTO audit_log (actor_user_id, action, create_time) VALUES
			 (0, 'test-old', '2020-01-01 00:00:00'),
			 (0, 'test-new', datetime('now'))`
		).run();
		await env.db.prepare(
			`INSERT INTO login_log (user_id, email, ip, create_time) VALUES
			 (0, 'old@example.com', '203.0.113.201', '2020-01-01 00:00:00'),
			 (0, 'new@example.com', '203.0.113.202', datetime('now'))`
		).run();
		// 用户保留 30 天：超期邮件软删，未超期保留
		const user = await makeUser('p6-retention@example.com');
		await env.db.prepare('INSERT INTO user_security (user_id, retention_days) VALUES (?, 30)').bind(user.userId).run();
		const accountId = await accountIdOf('p6-retention@example.com');
		await env.db.prepare(
			`INSERT INTO email (account_id, user_id, subject, type, is_del, create_time) VALUES
			 (?, ?, 'old-mail', 0, 0, '2020-01-01 00:00:00'),
			 (?, ?, 'new-mail', 0, 0, datetime('now'))`
		).bind(accountId, user.userId, accountId, user.userId).run();

		const result = await logRetentionService.cleanup(ctx);
		expect(result.logsDeleted).toBeGreaterThanOrEqual(3);

		const oldReg = await env.db.prepare(`SELECT COUNT(*) AS n FROM register_log WHERE email = 'old@example.com'`).first();
		expect(oldReg.n).toBe(0);
		const newReg = await env.db.prepare(`SELECT COUNT(*) AS n FROM register_log WHERE email = 'new@example.com'`).first();
		expect(newReg.n).toBe(1);
		const oldAudit = await env.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'test-old'`).first();
		expect(oldAudit.n).toBe(0);
		const newAudit = await env.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'test-new'`).first();
		expect(newAudit.n).toBe(1);
		const oldLogin = await env.db.prepare(`SELECT COUNT(*) AS n FROM login_log WHERE email = 'old@example.com'`).first();
		expect(oldLogin.n).toBe(0);
		const oldMail = await env.db.prepare(`SELECT is_del FROM email WHERE user_id = ? AND subject = 'old-mail'`).bind(user.userId).first();
		expect(oldMail.is_del).toBe(1);
		const newMail = await env.db.prepare(`SELECT is_del FROM email WHERE user_id = ? AND subject = 'new-mail'`).bind(user.userId).first();
		expect(newMail.is_del).toBe(0);
	});

	it('log_retention_days=0 时日志永久保留', async () => {
		const ctx = fakeCtx(nextIp());
		await env.db.prepare(
			`INSERT INTO register_log (ip, ip_segment, email, result, create_time) VALUES
			 ('203.0.113.203', '203.0.113.203', 'keep@example.com', 0, '2020-01-01 00:00:00')`
		).run();
		await env.db.prepare(`UPDATE setting SET log_retention_days = 0`).run();
		await logRetentionService.cleanup(ctx);
		const kept = await env.db.prepare(`SELECT COUNT(*) AS n FROM register_log WHERE email = 'keep@example.com'`).first();
		expect(kept.n).toBe(1);
		// 恢复默认 90 天，避免影响其他测试
		await env.db.prepare(`UPDATE setting SET log_retention_days = 90`).run();
	});
});

describe('IP 脱敏', () => {
	it('maskIp：IPv4 末段归零、IPv6 只留 /64、Unknown 原样', () => {
		expect(reqUtils.maskIp('1.2.3.4')).toBe('1.2.3.0');
		expect(reqUtils.maskIp('203.0.113.99')).toBe('203.0.113.0');
		expect(reqUtils.maskIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3:8d3');
		expect(reqUtils.maskIp('Unknown')).toBe('Unknown');
		expect(reqUtils.maskIp('')).toBe('');
	});

	it('log_ip_mask=1 时注册/登录日志 ip 脱敏、ip_segment 不受影响；关后恢复', async () => {
		await setSetting({ logIpMask: 1 });
		const maskedIp = '203.0.113.150';
		const reg = await register('p6-mask@example.com', maskedIp);
		expect(reg.json.code).toBe(200);
		let row = await env.db.prepare(
			`SELECT ip, ip_segment FROM register_log WHERE email = 'p6-mask@example.com' ORDER BY log_id DESC LIMIT 1`
		).first();
		expect(row.ip).toBe('203.0.113.0');
		expect(row.ip_segment).toBe(maskedIp);
		const loginRes = await login('p6-mask@example.com', maskedIp);
		expect(loginRes.json.code).toBe(200);
		const userRow = await env.db.prepare(`SELECT user_id FROM user WHERE email = 'p6-mask@example.com'`).first();
		row = await env.db.prepare(
			`SELECT ip FROM login_log WHERE user_id = ? ORDER BY log_id DESC LIMIT 1`
		).bind(userRow.user_id).first();
		expect(row.ip).toBe('203.0.113.0');

		await setSetting({ logIpMask: 0 });
		const plainIp = '203.0.113.151';
		const reg2 = await register('p6-mask-off@example.com', plainIp);
		expect(reg2.json.code).toBe(200);
		row = await env.db.prepare(
			`SELECT ip FROM register_log WHERE email = 'p6-mask-off@example.com' ORDER BY log_id DESC LIMIT 1`
		).first();
		expect(row.ip).toBe(plainIp);
	});
});
