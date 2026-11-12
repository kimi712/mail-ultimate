// 白帽反馈修复回归测试（2026-11-12 uwu 6 步之第 1+3+5 步）：
// 口令永不出浏览器——浏览器先跑 PBKDF2-600k，再用 HKDF 一分二
// （登录密钥 + 邮件密钥），只发登录密钥；SHA-256 验证器退役（zk 整体删除）；
// 老用户 v1 hash 登录时静默迁移（不逼改密码）；挑战暂停开关；
// E2EE 重包/暴露状态接口；胁迫密码新口径（含 v1 存量行重设提示）。
// 注意：本测试池每个 it 之间不保留 D1 写入（快照回滚），每个用例须自己做 setup。
// 运行：mail-worker 下 npx vitest run test/phase20-bounty-fix.spec.js。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { registerNew, loginNew, deriveLoginKeyForTest } from './auth-helpers.js';
import cryptoUtils from '../src/utils/crypto-utils';

const MAIN_PWD = 'password123';
const NEW_PWD = 'new-password-456';
const DURESS_PWD = 'duress-pass-1';
const IP_REG_A = '203.0.113.91';
const IP_REG_B = '203.0.113.92';

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
	} catch (e) { /* 非 JSON 响应忽略 */ }
	return { status: res.status, json };
}

async function setSetting(fields) {
	const cached = (await env.kv.get('setting:', { type: 'json' })) || {};
	for (const [key, value] of Object.entries(fields)) {
		cached[key] = value;
	}
	await env.kv.put('setting:', JSON.stringify(cached));
}

function b64(bytes) {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

function b64ToBytes(b64str) {
	const bin = atob(String(b64str || ''));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

async function sha256b64(str) {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
	return b64(new Uint8Array(buf));
}

function randomSaltB64() {
	const rand = new Uint8Array(16);
	crypto.getRandomValues(rand);
	return b64(rand);
}

// 独立派生（手写 WebCrypto，不 import 服务端 crypto-utils）：与前端
// mail-vue/src/utils/authkeys.js 同款常量——PBKDF2-HMAC-SHA256(口令, 盐,
// 600000) → 32B master；HKDF-SHA256(master, 盐, info) 各 32B。
async function independentDerive(password, saltB64) {
	const enc = new TextEncoder();
	const base = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
	const master = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt: b64ToBytes(saltB64), iterations: 600000, hash: 'SHA-256' }, base, 256);
	const key = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
	const login = await crypto.subtle.deriveBits(
		{ name: 'HKDF', salt: b64ToBytes(saltB64), info: enc.encode('sn-mail-v1:login'), hash: 'SHA-256' }, key, 256);
	const mail = await crypto.subtle.deriveBits(
		{ name: 'HKDF', salt: b64ToBytes(saltB64), info: enc.encode('sn-mail-v1:mail'), hash: 'SHA-256' }, key, 256);
	return { loginKey: b64(new Uint8Array(login)), mailKey: b64(new Uint8Array(mail)) };
}

// 固定向量（2026-11-12 由独立脚本算出，服务端 crypto-utils 逐字节一致）：
// 口令 'CrossCheck-Pass-2026!'、盐 16 字节 0x00..0x0F。
const VEC_PWD = 'CrossCheck-Pass-2026!';
const VEC_SALT = 'AAECAwQFBgcICQoLDA0ODw==';
const VEC_LOGIN_KEY = 'bNrHnobfxMX+mJ7wZcoxQ7cBH1ZXKsWInLgRpyaX8v0=';
const VEC_MAIL_KEY = 'wHf9wxy8SD7A1p6m2PrVHeNqIfdnho3Ng79ScxmhXoM=';

// 取盐 + 派生主登录密钥（供胁迫设/改/关用）。
async function mainLoginKeyFor(email, password = MAIN_PWD) {
	const res = await api(`/login/salt?email=${encodeURIComponent(email)}`, { ip: '203.0.113.99' });
	const info = res.json?.data || {};
	return deriveLoginKeyForTest(password, info.salt || '');
}

let tokenA, tokenB, userIdA, userIdB;

beforeAll(async () => {
	const res = await SELF.fetch('http://example.com/api/init', { headers: { Authorization: `Bearer ${env.jwt_secret}` } });
	expect(await res.text()).toBe('success');
	await setSetting({ registerVerify: 1 });

	const ra = await registerNew(api, 'p20-a@example.com', { ip: IP_REG_A });
	expect(ra.json.code).toBe(200);
	const rb = await registerNew(api, 'p20-b@example.com', { ip: IP_REG_B });
	expect(rb.json.code).toBe(200);

	const la = await loginNew(api, 'p20-a@example.com', { ip: '203.0.113.93' });
	tokenA = la.json?.data?.token;
	const lb = await loginNew(api, 'p20-b@example.com', { ip: '203.0.113.94' });
	tokenB = lb.json?.data?.token;
	expect(tokenA && tokenB).toBeTruthy();

	const ua = await env.db.prepare(`SELECT user_id FROM user WHERE email = 'p20-a@example.com'`).first();
	const ub = await env.db.prepare(`SELECT user_id FROM user WHERE email = 'p20-b@example.com'`).first();
	userIdA = ua.user_id;
	userIdB = ub.user_id;
});

describe('固定向量交叉验证（浏览器↔服务端逐字节一致）', () => {
	it('独立派生 == 服务端派生 == 硬编码期望值', async () => {
		const ind = await independentDerive(VEC_PWD, VEC_SALT);
		expect(ind.loginKey).toBe(VEC_LOGIN_KEY);
		expect(ind.mailKey).toBe(VEC_MAIL_KEY);
		const srv = await cryptoUtils.deriveAuthKeys(VEC_PWD, VEC_SALT);
		expect(srv.loginKey).toBe(VEC_LOGIN_KEY);
		expect(srv.mailKey).toBe(VEC_MAIL_KEY);
		expect(ind.loginKey).toBe(srv.loginKey);
		expect(ind.mailKey).toBe(srv.mailKey);
	});

	it('登录密钥与邮件密钥不同（HKDF 域分离）', async () => {
		const { loginKey, mailKey } = await independentDerive(VEC_PWD, VEC_SALT);
		expect(loginKey).not.toBe(mailKey);
	});

	it('换盐 / 换 info / 换口令都换输出（派生确实依赖这三个输入）', async () => {
		const base = await independentDerive(VEC_PWD, VEC_SALT);
		const otherSalt = await independentDerive(VEC_PWD, randomSaltB64());
		expect(otherSalt.loginKey).not.toBe(base.loginKey);
		expect(otherSalt.mailKey).not.toBe(base.mailKey);
		const otherPwd = await independentDerive('Another-Pass-2026!', VEC_SALT);
		expect(otherPwd.loginKey).not.toBe(base.loginKey);
		// info 不同则输出不同：用登录 info 派出的不是邮件密钥。
		const enc = new TextEncoder();
		const masterKey = await crypto.subtle.importKey('raw',
			await crypto.subtle.deriveBits(
				{ name: 'PBKDF2', salt: b64ToBytes(VEC_SALT), iterations: 600000, hash: 'SHA-256' },
				await crypto.subtle.importKey('raw', enc.encode(VEC_PWD), 'PBKDF2', false, ['deriveBits']), 256),
			'HKDF', false, ['deriveBits']);
		const wrongInfo = await crypto.subtle.deriveBits(
			{ name: 'HKDF', salt: b64ToBytes(VEC_SALT), info: enc.encode('sn-mail-v1:other'), hash: 'SHA-256' }, masterKey, 256);
		expect(b64(new Uint8Array(wrongInfo))).not.toBe(base.loginKey);
		expect(b64(new Uint8Array(wrongInfo))).not.toBe(base.mailKey);
	});

	it('服务端存的不是登录密钥本身，而是它的慢 hash（前缀 pbkdf2$210000$lk$）', async () => {
		const salt = randomSaltB64();
		const keys = await cryptoUtils.deriveAuthKeys(MAIN_PWD, salt);
		const hash = await cryptoUtils.hashLoginKey(keys.loginKey, salt);
		expect(hash.startsWith('pbkdf2$210000$lk$')).toBe(true);
		expect(hash).not.toContain(keys.loginKey);
		expect(await cryptoUtils.verifyLoginKey(keys.loginKey, salt, hash)).toBe(true);
		expect(await cryptoUtils.verifyLoginKey(keys.mailKey, salt, hash)).toBe(false);
	});
});

describe('取盐端点 /login/salt', () => {
	it('已知 v2 账号返回 version 2，盐与库里一致', async () => {
		const res = await api(`/login/salt?email=p20-a@example.com`, { ip: '203.0.113.95' });
		expect(res.json.code).toBe(200);
		expect(res.json.data.version).toBe(2);
		const row = await env.db.prepare(`SELECT salt FROM user WHERE user_id = ?`).bind(userIdA).first();
		expect(res.json.data.salt).toBe(row.salt);
		expect(res.json.data.decoySalt).toBeUndefined();
	});

	it('未知邮箱返回 version 2 + 随机盐（防枚举），两次返回不同', async () => {
		const r1 = await api(`/login/salt?email=ghost-nobody@example.com`, { ip: '203.0.113.96' });
		const r2 = await api(`/login/salt?email=ghost-nobody@example.com`, { ip: '203.0.113.97' });
		expect(r1.json.code).toBe(200);
		expect(r1.json.data.version).toBe(2);
		expect(r1.json.data.salt).toMatch(/^[A-Za-z0-9+/=]{24}$/);
		expect(r2.json.data.salt).not.toBe(r1.json.data.salt);
	});

	it('v1 旧账号返回 version 1', async () => {
		const row0 = await env.db.prepare(`SELECT salt FROM user WHERE user_id = ?`).bind(userIdB).first();
		await env.db.prepare(`UPDATE user SET password = ? WHERE user_id = ?`)
			.bind(await sha256b64(row0.salt + MAIN_PWD), userIdB).run();
		const res = await api(`/login/salt?email=p20-b@example.com`, { ip: '203.0.113.98' });
		expect(res.json.data.version).toBe(1);
		expect(res.json.data.salt).toBe(row0.salt);
	});
});

describe('新注册（登录密钥口径）', () => {
	it('注册只收 {loginKey, salt}：入库为 pbkdf2$210000$lk$ 验证器', async () => {
		const r = await registerNew(api, 'p20-c@example.com', { ip: '203.0.113.95' });
		expect(r.json.code).toBe(200);
		const row = await env.db.prepare(
			`SELECT password, salt FROM user WHERE email = 'p20-c@example.com'`).first();
		expect(String(row.password).startsWith('pbkdf2$210000$lk$')).toBe(true);
		expect(String(row.salt)).toMatch(/^[A-Za-z0-9+/=]{24}$/);
		const l = await loginNew(api, 'p20-c@example.com', { ip: '203.0.113.96' });
		expect(l.json.code).toBe(200);
		expect(l.json?.data?.token).toBeTruthy();
	});

	it('登录密钥格式非法 → 400（坏 base64 / 字节数不对）', async () => {
		const bad1 = await api('/register', {
			method: 'POST', ip: '203.0.113.95',
			body: { email: 'p20-bad1@example.com', loginKey: 'not-base64!', salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }
		});
		expect(bad1.json.code).toBe(400);
		const bad2 = await api('/register', {
			method: 'POST', ip: '203.0.113.95',
			body: { email: 'p20-bad2@example.com', loginKey: 'AAAAAAAAAAAAAAAAAAAAAA==', salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }
		});
		expect(bad2.json.code).toBe(400);
	});

	it('弱口令（强度 0 分）→ 400 pwdTooWeak；旧版只发 password 字段 → 400', async () => {
		const weak = await registerNew(api, 'p20-weak@example.com', { ip: '203.0.113.95', password: 'abcdef' });
		expect(weak.json.code).toBe(400);
		const oldOnly = await api('/register', {
			method: 'POST', ip: '203.0.113.95',
			body: { email: 'p20-old@example.com', password: MAIN_PWD }
		});
		expect(oldOnly.json.code).toBe(400);
	});
});

describe('新登录（登录密钥口径）', () => {
	it('loginKey 登录成功；请求体不含 password 字段', async () => {
		const saltRes = await api(`/login/salt?email=p20-a@example.com`, { ip: '203.0.113.96' });
		const keys = await cryptoUtils.deriveAuthKeys(MAIN_PWD, saltRes.json.data.salt);
		const res = await api('/login', {
			method: 'POST', ip: '203.0.113.96',
			body: { email: 'p20-a@example.com', loginKey: keys.loginKey }
		});
		expect(res.json.code).toBe(200);
		expect(res.json?.data?.token).toBeTruthy();
	});

	it('错 loginKey → 501（通用错误，不透露原因）', async () => {
		const l = await loginNew(api, 'p20-a@example.com', { ip: '203.0.113.97', password: 'wrong-password' });
		expect(l.json.code).toBe(501);
		expect(l.json?.data?.token).toBeFalsy();
	});

	it('已迁移账号只发明文密码 → 400 client-outdated（不是 501，更不是登录成功）', async () => {
		const res = await api('/login', {
			method: 'POST', ip: '203.0.113.98',
			body: { email: 'p20-a@example.com', password: MAIN_PWD }
		});
		expect(res.json.code).toBe(400);
		expect(res.json?.data?.token).toBeFalsy();
	});
});

describe('老用户迁移 v1→v2（不逼改密码）', () => {
	it('v1 旧 hash：带 password+loginKey 登录成功，库里静默升级为新验证器', async () => {
		const row0 = await env.db.prepare(`SELECT salt FROM user WHERE user_id = ?`).bind(userIdB).first();
		await env.db.prepare(`UPDATE user SET password = ? WHERE user_id = ?`)
			.bind(await sha256b64(row0.salt + MAIN_PWD), userIdB).run();
		const l = await loginNew(api, 'p20-b@example.com', { ip: '203.0.113.97' });
		expect(l.json.code).toBe(200);
		expect(l.json?.data?.token).toBeTruthy();
		const row = await env.db.prepare(`SELECT password FROM user WHERE user_id = ?`).bind(userIdB).first();
		expect(String(row.password).startsWith('pbkdf2$210000$lk$')).toBe(true);
		// 升级后再次登录仍正常（这次不带 password）。
		const l2 = await loginNew(api, 'p20-b@example.com', { ip: '203.0.113.98' });
		expect(l2.json.code).toBe(200);
		// 升级后只发 password → 400。
		const l3 = await api('/login', {
			method: 'POST', ip: '203.0.113.99',
			body: { email: 'p20-b@example.com', password: MAIN_PWD }
		});
		expect(l3.json.code).toBe(400);
	});

	it('旧版缓存页面（只发 password）登录 v1 账号成功，服务端自算 loginKey 并迁移', async () => {
		const row0 = await env.db.prepare(`SELECT salt FROM user WHERE user_id = ?`).bind(userIdB).first();
		await env.db.prepare(`UPDATE user SET password = ? WHERE user_id = ?`)
			.bind(await sha256b64(row0.salt + MAIN_PWD), userIdB).run();
		const l = await api('/login', {
			method: 'POST', ip: '203.0.113.100',
			body: { email: 'p20-b@example.com', password: MAIN_PWD }
		});
		expect(l.json.code).toBe(200);
		expect(l.json?.data?.token).toBeTruthy();
		const row = await env.db.prepare(`SELECT password FROM user WHERE user_id = ?`).bind(userIdB).first();
		expect(String(row.password).startsWith('pbkdf2$210000$lk$')).toBe(true);
	});

	it('v1 账号错密码 → 501，且不迁移', async () => {
		const row0 = await env.db.prepare(`SELECT salt FROM user WHERE user_id = ?`).bind(userIdB).first();
		const v1 = await sha256b64(row0.salt + MAIN_PWD);
		await env.db.prepare(`UPDATE user SET password = ? WHERE user_id = ?`).bind(v1, userIdB).run();
		const l = await loginNew(api, 'p20-b@example.com', { ip: '203.0.113.101', password: 'wrong-password' });
		expect(l.json.code).toBe(501);
		const row = await env.db.prepare(`SELECT password FROM user WHERE user_id = ?`).bind(userIdB).first();
		expect(row.password).toBe(v1);
	});

	it('空格自愈：存量口令带尾空格，trim 版登录成功并按 trim 版迁移', async () => {
		const row0 = await env.db.prepare(`SELECT salt FROM user WHERE user_id = ?`).bind(userIdB).first();
		await env.db.prepare(`UPDATE user SET password = ? WHERE user_id = ?`)
			.bind(await sha256b64(row0.salt + MAIN_PWD + ' '), userIdB).run();
		const l = await loginNew(api, 'p20-b@example.com', { ip: '203.0.113.102' });
		expect(l.json.code).toBe(200);
		const row = await env.db.prepare(`SELECT password FROM user WHERE user_id = ?`).bind(userIdB).first();
		expect(String(row.password).startsWith('pbkdf2$210000$lk$')).toBe(true);
		// 迁移后口令归一化为 trim 版：trim 版能登，带空格版不能登。
		const lTrim = await loginNew(api, 'p20-b@example.com', { ip: '203.0.113.103' });
		expect(lTrim.json.code).toBe(200);
		const lSpace = await loginNew(api, 'p20-b@example.com', { ip: '203.0.113.104', password: MAIN_PWD + ' ' });
		expect(lSpace.json.code).toBe(501);
	});
});

describe('改密（登录密钥口径）', () => {
	it('PUT /my/resetPassword 发 {loginKey, salt}：新口令能登、旧口令失效、盐换了', async () => {
		const newSalt = randomSaltB64();
		const keys = await cryptoUtils.deriveAuthKeys(NEW_PWD, newSalt);
		const r = await api('/my/resetPassword', {
			method: 'PUT', token: tokenA, body: { loginKey: keys.loginKey, salt: newSalt }
		});
		expect(r.json.code).toBe(200);
		const row = await env.db.prepare(`SELECT password, salt FROM user WHERE user_id = ?`).bind(userIdA).first();
		expect(String(row.password).startsWith('pbkdf2$210000$lk$')).toBe(true);
		expect(row.salt).toBe(newSalt);
		const lNew = await loginNew(api, 'p20-a@example.com', { ip: '203.0.113.105', password: NEW_PWD });
		expect(lNew.json.code).toBe(200);
		const lOld = await loginNew(api, 'p20-a@example.com', { ip: '203.0.113.106' });
		expect(lOld.json.code).toBe(501);
		// 改回原密码，免得影响后面的用例。
		const backSalt = randomSaltB64();
		const backKeys = await cryptoUtils.deriveAuthKeys(MAIN_PWD, backSalt);
		const back = await api('/my/resetPassword', {
			method: 'PUT', token: tokenA, body: { loginKey: backKeys.loginKey, salt: backSalt }
		});
		expect(back.json.code).toBe(200);
	});

	it('PUT /my/resetPassword 发 {password}（受信通道兜底）：服务端自算，同样生效', async () => {
		const r = await api('/my/resetPassword', {
			method: 'PUT', token: tokenA, body: { password: NEW_PWD }
		});
		expect(r.json.code).toBe(200);
		const row = await env.db.prepare(`SELECT password FROM user WHERE user_id = ?`).bind(userIdA).first();
		expect(String(row.password).startsWith('pbkdf2$210000$lk$')).toBe(true);
		const lNew = await loginNew(api, 'p20-a@example.com', { ip: '203.0.113.107', password: NEW_PWD });
		expect(lNew.json.code).toBe(200);
		const backSalt = randomSaltB64();
		const backKeys = await cryptoUtils.deriveAuthKeys(MAIN_PWD, backSalt);
		await api('/my/resetPassword', {
			method: 'PUT', token: tokenA, body: { loginKey: backKeys.loginKey, salt: backSalt }
		});
	});

	it('改密 loginKey 格式非法 → 400', async () => {
		const r = await api('/my/resetPassword', {
			method: 'PUT', token: tokenA, body: { loginKey: 'bad', salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }
		});
		expect(r.json.code).toBe(400);
	});
});

describe('E2EE 重包/暴露状态接口', () => {
	it('GET /my/e2ee/wraps：无 E2EE 包裹时返回空集', async () => {
		const res = await api('/my/e2ee/wraps', { token: tokenA });
		expect(res.json.code).toBe(200);
		expect(res.json.data.items).toEqual([]);
		expect(res.json.data.total).toBe(0);
	});

	it('POST /my/e2ee/rewrap：空列表与超 50 批 → 400；不存在的信 → 更新 0', async () => {
		const empty = await api('/my/e2ee/rewrap', {
			method: 'POST', token: tokenA, body: { items: [] }
		});
		expect(empty.json.code).toBe(400);
		const tooMany = await api('/my/e2ee/rewrap', {
			method: 'POST', token: tokenA,
			body: { items: Array.from({ length: 51 }, (_, i) => ({ emailId: i + 1, source: 'email', wrapped: 'e2ee:v1:AAAA' })) }
		});
		expect(tooMany.json.code).toBe(400);
		const ghost = await api('/my/e2ee/rewrap', {
			method: 'POST', token: tokenA,
			body: { items: [{ emailId: 999999001, source: 'email', wrapped: 'e2ee:v1:AAAA' }] }
		});
		expect(ghost.json.code).toBe(200);
		expect(ghost.json.data.updated).toBe(0);
	});

	it('POST /my/e2ee/rewrap：信封格式非法 → 跳过不更新', async () => {
		const res = await api('/my/e2ee/rewrap', {
			method: 'POST', token: tokenA,
			body: { items: [{ emailId: 999999002, source: 'email', wrapped: 'not-an-envelope' }] }
		});
		expect(res.json.code).toBe(200);
		expect(res.json.data.updated).toBe(0);
	});

	it('POST /my/e2ee/exposure：非法状态 → 400；合法状态落库', async () => {
		const bad = await api('/my/e2ee/exposure', {
			method: 'POST', token: tokenA, body: { state: 5 }
		});
		expect(bad.json.code).toBe(400);
		const ok = await api('/my/e2ee/exposure', {
			method: 'POST', token: tokenA, body: { state: 1 }
		});
		expect(ok.json.code).toBe(200);
		expect(ok.json.data.exposed).toBe(1);
		const row = await env.db.prepare(`SELECT e2ee_exposed FROM user WHERE user_id = ?`).bind(userIdA).first();
		expect(row.e2ee_exposed).toBe(1);
		const back = await api('/my/e2ee/exposure', {
			method: 'POST', token: tokenA, body: { state: 0 }
		});
		expect(back.json.code).toBe(200);
	});
});

describe('胁迫密码新口径', () => {
	it('设胁迫发 {mainLoginKey, duressPassword} → 200；胁迫口令登录进诱饵会话', async () => {
		const set = await api('/my/duress/set', {
			method: 'POST', token: tokenA,
			body: { mainLoginKey: await mainLoginKeyFor('p20-a@example.com'), duressPassword: DURESS_PWD }
		});
		expect(set.json.code).toBe(200);
		expect(set.json.data.enabled).toBe(true);
		const res = await loginNew(api, 'p20-a@example.com', { ip: '203.0.113.108', password: DURESS_PWD });
		expect(res.json.code).toBe(200);
		const decoyToken = res.json?.data?.token;
		expect(decoyToken).toBeTruthy();
		// 诱饵会话里状态恒假（不透露真实设置）。
		const st = await api('/my/duress/status', { token: decoyToken });
		expect(st.json.data.enabled).toBe(false);
	});

	it('设胁迫时主登录密钥错误 → 400', async () => {
		const res = await api('/my/duress/set', {
			method: 'POST', token: tokenA,
			body: { mainLoginKey: await mainLoginKeyFor('p20-a@example.com', 'wrong-main-password'), duressPassword: DURESS_PWD }
		});
		expect(res.json.code).toBe(400);
	});

	it('关胁迫发 {mainLoginKey} → 200；关闭后胁迫口令登录 → 501', async () => {
		await api('/my/duress/set', {
			method: 'POST', token: tokenA,
			body: { mainLoginKey: await mainLoginKeyFor('p20-a@example.com'), duressPassword: DURESS_PWD }
		});
		const ok = await api('/my/duress/disable', {
			method: 'POST', token: tokenA, body: { mainLoginKey: await mainLoginKeyFor('p20-a@example.com') }
		});
		expect(ok.json.code).toBe(200);
		expect(ok.json.data.enabled).toBe(false);
		const res = await loginNew(api, 'p20-a@example.com', { ip: '203.0.113.109', password: DURESS_PWD });
		expect(res.json.code).toBe(501);
	});

	it('v1 存量胁迫行：status 报 legacy=true，新客户端胁迫登录 → 501（须重设）', async () => {
		// 人工造一条 v1 脊迫行：SHA-256(胁迫盐 + 胁迫口令)。
		const decoySalt = randomSaltB64();
		const legacyHash = await sha256b64(decoySalt + DURESS_PWD);
		await env.db.prepare(
			`INSERT INTO user_decoy (user_id, password_hash, salt, enabled, seeded, create_time, update_time)
			 VALUES (?, ?, ?, 1, 1, datetime('now'), datetime('now'))`
		).bind(userIdA, legacyHash, decoySalt).run();
		const st = await api('/my/duress/status', { token: tokenA });
		expect(st.json.code).toBe(200);
		expect(st.json.data.enabled).toBe(true);
		expect(st.json.data.legacy).toBe(true);
		const res = await loginNew(api, 'p20-a@example.com', { ip: '203.0.113.110', password: DURESS_PWD });
		expect(res.json.code).toBe(501);
	});

	it('v1 主账号 + v1 胁迫行：旧版只发胁迫口令登录成功，胁迫验证器顺带迁移', async () => {
		// 主账号降级回 v1。
		const row0 = await env.db.prepare(`SELECT salt FROM user WHERE user_id = ?`).bind(userIdB).first();
		await env.db.prepare(`UPDATE user SET password = ? WHERE user_id = ?`)
			.bind(await sha256b64(row0.salt + MAIN_PWD), userIdB).run();
		// v1 脊迫行。
		const decoySalt = randomSaltB64();
		await env.db.prepare(
			`INSERT INTO user_decoy (user_id, password_hash, salt, enabled, seeded, create_time, update_time)
			 VALUES (?, ?, ?, 1, 1, datetime('now'), datetime('now'))`
		).bind(userIdB, await sha256b64(decoySalt + DURESS_PWD), decoySalt).run();
		// 旧版缓存页面：只发胁迫口令（无 loginKey）。
		const res = await api('/login', {
			method: 'POST', ip: '203.0.113.111',
			body: { email: 'p20-b@example.com', password: DURESS_PWD }
		});
		expect(res.json.code).toBe(200);
		expect(res.json?.data?.token).toBeTruthy();
		// 脊迫行已迁到新口径（不再是旧 hash）。
		const row = await env.db.prepare(`SELECT password_hash FROM user_decoy WHERE user_id = ?`).bind(userIdB).first();
		expect(String(row.password_hash).startsWith('pbkdf2$210000$lk$')).toBe(true);
		// 之后新客户端用胁迫口令也能登录（主账号同时已被迁移）。
		const res2 = await loginNew(api, 'p20-b@example.com', { ip: '203.0.113.112', password: DURESS_PWD });
		expect(res2.json.code).toBe(200);
	});
});

describe('挑战暂停开关', () => {
	it('默认未暂停：status 返回 paused=false，空提交报“缺少短语”（不是 paused）', async () => {
		const st = await api('/challenge/status');
		expect(st.json.code).toBe(200);
		expect(st.json.data.paused).toBe(false);
		expect(st.json.data.deadline).toBe('2026-11-18T23:59:00+08:00');
		expect(st.json.data.prizeUsd).toBe(1000);
		const sub = await api('/challenge/submit', {
			method: 'POST', ip: '203.0.113.113', body: {}
		});
		expect(sub.json.code).toBe(400);
		expect(String(sub.json.message || '')).not.toContain('paused');
	});

	it('challenge_paused=1：status 返回 paused=true，提交 → 400 paused', async () => {
		await setSetting({ challengePaused: 1 });
		try {
			const st = await api('/challenge/status');
			expect(st.json.data.paused).toBe(true);
			const sub = await api('/challenge/submit', {
				method: 'POST', ip: '203.0.113.114',
				body: { phrase: 'test phrase', method: 'test method' }
			});
			expect(sub.json.code).toBe(400);
			expect(String(sub.json.message || '')).toContain('paused');
		} finally {
			await setSetting({ challengePaused: 0 });
		}
		const st2 = await api('/challenge/status');
		expect(st2.json.data.paused).toBe(false);
	});
});
