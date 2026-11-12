// Phase 8 B 测试：vitest + @cloudflare/vitest-pool-workers。
// 覆盖 5 项：① TOTP 二维码（otpauth URL 格式、矩阵结构/定位图案/确定性、
// golden 回归、换绑验旧码、密钥只显示一次）；② 安全评分（9 项分项齐全、
// 总分 = 分项和、TOTP/自动锁定/E2EE 开启后加分、密码强度映射）；③ 用户侧审计视图
// （只查本人、他人不可见、类型筛选、脱敏 IP、截断 UA、保留期限、未登录拒绝）；
// ④ 登录限流（账号锁定与解锁、IP 维度锁定、成功清失败计数、指数退避、
// 限流事件记 audit_log 与 alert_log、通用错误不透露账号是否存在）；
// ⑤ 会话 lastActiveAt（登录时初始化、鉴权后刷新、列表展示设备/浏览器、
// 一键踢出指定会话）；另加 kernel/audit 清洗与 kernel/ratelimit 退避单测。
// 注意：新路由 GET /security/audit-log 与 GET /security/score 由本文件
// import '../src/api/security-audit-api.js' 注册（webs.js 注册行待总协调加；
// 注册后重复 import 无害，同一 handler）。
// 运行：mail-worker 下 npx vitest run test/phase8-b.spec.js。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import '../src/api/security-audit-api.js';
import totpService from '../src/service/totp-service';
import { encodeQr } from '../src/utils/qrcode';
import ratelimit from '../src/kernel/ratelimit';
import kernelAudit from '../src/kernel/audit';
import { isAdminUser, adminDelaySeconds } from '../src/service/login-service';

const TEST_JWT_SECRET='phase1-local-test-only-not-a-real-secret';
const ORIGIN = 'https://aevorynthtech.com';
let ipCounter = 10;
let initText = '';

function nextIp() {
	ipCounter += 1;
	return `203.0.113.${ipCounter}`;
}

async function sha256hex(s) {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
	return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
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

async function makeUser(email, password = 'password123') {
	const ip = nextIp();
	const reg = await register(email, ip, { password });
	expect(reg.json.code).toBe(200);
	// 注册即自动登录：直接用注册返回的 token，不再单独登录（注册已签发会话）。
	expect(reg.json.data.token).toBeTruthy();
	const row = await env.db.prepare('SELECT user_id FROM user WHERE email = ?').bind(email).first();
	return { token: reg.json.data.token, userId: row.user_id, ip, email, password };
}

async function enableTotp(user) {
	const setup = await api('/my/totp/setup', { method: 'POST', token: user.token, body: {} });
	expect(setup.json.code).toBe(200);
	const code = await totpService.generateCode(setup.json.data.secret);
	const ok = await api('/my/totp/enable', { method: 'POST', token: user.token, body: { code } });
	expect(ok.json.code).toBe(200);
	return setup.json.data;
}

// 限流 KV key（与 kernel/ratelimit + login-service 同一套推导）。
async function limitKeys(ip, email) {
	const ipDim = (await sha256hex(`login:ip:${ip}`)).slice(0, 16);
	const acctDim = (await sha256hex(`login:acct:${String(email).toLowerCase()}`)).slice(0, 16);
	return {
		ipWin: 'rl:win:login:ip:' + ipDim,
		ipLock: 'rl:lock:login:ip:' + ipDim,
		acctWin: 'rl:win:login:acct:' + acctDim,
		acctLock: 'rl:lock:login:acct:' + acctDim,
		// 管理员渐进延迟维度：测试用户在全新库里是 user_id 1 即管理员；
		// 管理员不再上锁（login:admin: 锁已删除），只计 admin-fail 窗口。
		adminWin: 'rl:win:login:admin-fail:' + acctDim,
		alertIp: 'rl:alert:login:' + ipDim,
		alertAcct: 'rl:alert:login:' + acctDim
	};
}

async function clearLimitKeys(ip, email) {
	const keys = await limitKeys(ip, email);
	for (const k of Object.values(keys)) {
		await env.kv.delete(k);
	}
}

const SETTING_COLUMN_MAP = {
	registerVerify: 'register_verify',
	logIpMask: 'log_ip_mask',
	syncDelete: 'sync_delete'
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

beforeAll(async () => {
	const res = await SELF.fetch('http://example.com/api/init', { headers: { Authorization: `Bearer ${TEST_JWT_SECRET}` } });
	initText = await res.text();
	await setSetting({ registerVerify: 1 });
}, 30000);

describe('init', () => {
	it('init 成功', () => {
		expect(initText).toBe('success');
	});
});

describe('① TOTP 二维码', () => {
	it('otpauth URL 格式正确', async () => {
		const user = await makeUser('p8b-qr-a@example.com');
		const setup = await api('/my/totp/setup', { method: 'POST', token: user.token, body: {} });
		expect(setup.json.code).toBe(200);
		const { secret, otpauthUrl } = setup.json.data;
		expect(typeof secret).toBe('string');
		expect(secret.length).toBeGreaterThanOrEqual(32);
		expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\/aevorynthtech\.com%3A/);
		expect(otpauthUrl).toContain(`secret=${secret}`);
		expect(otpauthUrl).toContain('issuer=aevorynthtech.com');
		expect(otpauthUrl).toContain('algorithm=SHA1');
		expect(otpauthUrl).toContain('digits=6');
		expect(otpauthUrl).toContain('period=30');
	});

	it('二维码矩阵结构正确：尺寸、只含 0/1、左上定位图案', async () => {
		const user = await makeUser('p8b-qr-b@example.com');
		const setup = await api('/my/totp/setup', { method: 'POST', token: user.token, body: {} });
		expect(setup.json.code).toBe(200);
		const qr = setup.json.data.qr;
		expect(qr).not.toBeNull();
		expect(qr.size).toBe(17 + 4 * qr.version);
		expect(qr.modules.length).toBe(qr.size);
		for (const row of qr.modules) {
			expect(row.length).toBe(qr.size);
			expect(row).toMatch(/^[01]+$/);
		}
		// 左上 7×7 定位图案。
		const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
		for (let y = 0; y < 7; y++) {
			expect(qr.modules[y].slice(0, 7)).toBe(finder[y]);
		}
	});

	it('编码确定、golden 回归（HELLO WORLD 与 otpauth URL）', () => {
		const a = encodeQr('HELLO WORLD');
		const b = encodeQr('HELLO WORLD');
		expect(a).toEqual(b);
		expect(a.version).toBe(1);
		expect(a.size).toBe(21);
		expect(a.modules[0]).toBe('111111100011101111111');
		expect(a.modules[10]).toBe('001010101000111001110');
		expect(a.modules[20]).toBe('111111101011100010110');
		const url = 'otpauth://totp/aevorynthtech.com:alice@aevorynthtech.com?secret=JBSWY3DPEHPK3PXP&issuer=aevorynthtech.com&algorithm=SHA1&digits=6&period=30';
		const q = encodeQr(url);
		expect(q.version).toBe(8);
		expect(q.size).toBe(49);
		expect(q.modules[0]).toBe('1111111000110010001101011111101000000100101111111');
		expect(() => encodeQr('x'.repeat(214))).toThrow();
	});

	it('换绑须先验旧码：无旧码/错旧码拒绝，对旧码通过；密钥只在设置时返回', async () => {
		const user = await makeUser('p8b-qr-c@example.com');
		const first = await enableTotp(user);
		// 无旧码拒绝。
		const noOld = await api('/my/totp/setup', { method: 'POST', token: user.token, body: {} });
		expect(noOld.json.code).toBe(400);
		// 错旧码拒绝。
		const wrongOld = await api('/my/totp/setup', { method: 'POST', token: user.token, body: { oldCode: '000000' } });
		expect(wrongOld.json.code).toBe(400);
		// 对旧码通过，返回新 secret（与旧的不同）与二维码。
		const goodOld = await totpService.generateCode(first.secret);
		const rebind = await api('/my/totp/setup', { method: 'POST', token: user.token, body: { oldCode: goodOld } });
		expect(rebind.json.code).toBe(200);
		expect(rebind.json.data.secret).not.toBe(first.secret);
		expect(rebind.json.data.qr).not.toBeNull();
		// 新 secret 验码启用成功；GET /my/security 不泄露 secret。
		const code = await totpService.generateCode(rebind.json.data.secret);
		const ok = await api('/my/totp/enable', { method: 'POST', token: user.token, body: { code } });
		expect(ok.json.code).toBe(200);
		const sec = await api('/my/security', { token: user.token });
		expect(JSON.stringify(sec.json)).not.toContain(rebind.json.data.secret);
	});
});

describe('② 安全评分加深', () => {
	it('9 项分项齐全，总分 = 分项和；新用户未满分且建议非空', async () => {
		const user = await makeUser('p8b-score-a@example.com');
		const res = await api('/security/score', { token: user.token });
		expect(res.json.code).toBe(200);
		const data = res.json.data;
		expect(data.items.length).toBe(9);
		expect(data.items.map(i => i.key).sort()).toEqual(
			['auditAnomaly', 'autoLock', 'e2ee', 'loginHistory', 'passkey', 'passwordAge', 'passwordStrength', 'sessions', 'totp'].sort());
		const sum = data.items.reduce((s, i) => s + i.score, 0);
		expect(data.total).toBe(sum);
		expect(data.total).toBeLessThan(100);
		expect(data.suggestions.length).toBeGreaterThan(0);
		expect(data.suggestions).toContain('securityScoreTipTotp');
		const byKey = Object.fromEntries(data.items.map(i => [i.key, i]));
		expect(byKey.totp).toMatchObject({ max: 20, score: 0, ok: false });
		expect(byKey.loginHistory).toMatchObject({ max: 10, score: 10, ok: true });
		expect(byKey.sessions).toMatchObject({ max: 5, score: 5, ok: true });
		expect(byKey.passwordAge).toMatchObject({ max: 10, score: 10, ok: true });
		// password123：长度≥8（+1）、含数字（+1）→ 强度 2 级 → 3 分。
		expect(byKey.passwordStrength).toMatchObject({ max: 10, score: 3 });
	});

	it('开启 TOTP / 自动锁定 / E2EE 后对应分项满分', async () => {
		const user = await makeUser('p8b-score-b@example.com');
		await enableTotp(user);
		const set = await api('/my/security', {
			method: 'POST', token: user.token,
			body: { autoLockMinutes: 5, e2eeEnabled: 1, e2eeSalt: 'p8b-test-salt' }
		});
		expect(set.json.code).toBe(200);
		const res = await api('/security/score', { token: user.token });
		const byKey = Object.fromEntries(res.json.data.items.map(i => [i.key, i]));
		expect(byKey.totp).toMatchObject({ score: 20, ok: true });
		expect(byKey.autoLock).toMatchObject({ score: 10, ok: true });
		expect(byKey.e2ee).toMatchObject({ score: 10, ok: true });
		expect(res.json.data.suggestions).not.toContain('securityScoreTipTotp');
	});

	it('强密码登录后密码强度项满分；未登录拒绝', async () => {
		const user = await makeUser('p8b-score-c@example.com', 'Str0ng!Passw0rd');
		const res = await api('/security/score', { token: user.token });
		const byKey = Object.fromEntries(res.json.data.items.map(i => [i.key, i]));
		expect(byKey.passwordStrength).toMatchObject({ score: 10, ok: true });
		const anon = await api('/security/score', {});
		expect(anon.json.code).toBe(401);
	});
});

describe('③ 用户侧审计视图', () => {
	it('只查本人：他人的记录不可见；类型筛选生效', async () => {
		const userA = await makeUser('p8b-audit-a@example.com');
		const userB = await makeUser('p8b-audit-b@example.com');
		// 直接插行（区分动作，便于断言隔离）。
		await env.db.prepare(
			`INSERT INTO audit_log (actor_user_id, action, target_type, target_id, ip, ua, detail) VALUES (?, ?, '', '', '203.0.113.99', 'TestUA/1.0', '{}')`
		).bind(userA.userId, 'login:rate_limited').run();
		await env.db.prepare(
			`INSERT INTO audit_log (actor_user_id, action, target_type, target_id, ip, ua, detail) VALUES (?, ?, '', '', '203.0.113.99', 'TestUA/1.0', '{}')`
		).bind(userA.userId, 'totp:enable').run();
		await env.db.prepare(
			`INSERT INTO audit_log (actor_user_id, action, target_type, target_id, ip, ua, detail) VALUES (?, ?, '', '', '203.0.113.99', 'TestUA/1.0', '{}')`
		).bind(userB.userId, 'totp:enable').run();
		const all = await api('/security/audit-log?num=1&size=50', { token: userA.token });
		expect(all.json.code).toBe(200);
		expect(all.json.data.list.length).toBe(2);
		expect(all.json.data.list.map(r => r.action).sort()).toEqual(['login:rate_limited', 'totp:enable']);
		const totpOnly = await api('/security/audit-log?num=1&size=50&type=totp', { token: userA.token });
		expect(totpOnly.json.data.list.length).toBe(1);
		expect(totpOnly.json.data.list[0].action).toBe('totp:enable');
		const loginOnly = await api('/security/audit-log?num=1&size=50&type=login', { token: userA.token });
		expect(loginOnly.json.data.list.length).toBe(1);
		expect(loginOnly.json.data.list[0].action).toBe('login:rate_limited');
		// B 的列表里没有 A 的行。
		const resB = await api('/security/audit-log?num=1&size=50', { token: userB.token });
		expect(resB.json.data.list.length).toBe(1);
		expect(resB.json.data.list[0].action).toBe('totp:enable');
	});

	it('展示脱敏 IP 与截断 UA；超保留期限的行不返回；未登录拒绝', async () => {
		const user = await makeUser('p8b-audit-c@example.com');
		const longUa = 'U'.repeat(200);
		await env.db.prepare(
			`INSERT INTO audit_log (actor_user_id, action, target_type, target_id, ip, ua, detail) VALUES (?, 'security:test', '', '', '203.0.113.99', ?, '{}')`
		).bind(user.userId, longUa).run();
		await env.db.prepare(
			`INSERT INTO audit_log (actor_user_id, action, target_type, target_id, ip, ua, detail, create_time) VALUES (?, 'security:old', '', '', '203.0.113.99', 'OldUA', '{}', '2020-01-01 00:00:00')`
		).bind(user.userId).run();
		const res = await api('/security/audit-log?num=1&size=50&type=security', { token: user.token });
		expect(res.json.code).toBe(200);
		expect(res.json.data.list.length).toBe(1);
		const row = res.json.data.list[0];
		expect(row.ip).toBe('203.0.113.0');
		expect(row.ua.length).toBeLessThanOrEqual(120);
		expect(row.action).toBe('security:test');
		const anon = await api('/security/audit-log?num=1&size=20', {});
		expect(anon.json.code).toBe(401);
	});
});

describe('④ 登录限流', () => {
	it('账号 5 次失败后锁定：通用 429 错误不透露账号是否存在；清锁后恢复', async () => {
		// 本 describe 内首个注册用户是 user_id 1（即管理员，见 isAdminUser）；
		// 管理员永不锁定（渐进延迟），测普通账号锁须先建一个占位用户拿走 user_id 1。
		await makeUser('p8b-lock-dummy@example.com');
		const user = await makeUser('p8b-lock-a@example.com');
		const ip = nextIp();
		for (let i = 0; i < 5; i++) {
			const r = await login(user.email, ip, 'wrong-password');
			// 既有行为：登录失败未带码，BizError 默认 501；消息为通用错误（Phase 8 H 统一化）。
			expect(r.json.code).toBe(501);
		}
		// 第 6 次失败触发锁定，返回通用错误。
		const sixth = await login(user.email, ip, 'wrong-password');
		expect(sixth.json.code).toBe(429);
		expect(String(sixth.json.message || '')).not.toContain('notExistUser');
		expect(String(sixth.json.message || '')).not.toContain('IncorrectPwd');
		// 锁定期内正确密码也被拒。
		const correctWhileLocked = await login(user.email, ip, 'password123');
		expect(correctWhileLocked.json.code).toBe(429);
		// 限流事件记 audit_log 与 alert_log。
		const auditRow = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login:rate_limited'`
		).first();
		expect(Number(auditRow.n)).toBeGreaterThanOrEqual(1);
		const alertRow = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM alert_log WHERE type = 'ratelimit'`
		).first();
		expect(Number(alertRow.n)).toBeGreaterThanOrEqual(1);
		// 清锁与窗口后恢复。
		await clearLimitKeys(ip, user.email);
		const ok = await login(user.email, ip, 'password123');
		expect(ok.json.code).toBe(200);
	});

	it('IP 维度锁定：同一 IP 多账号失败后该 IP 下正确登录也被拒', async () => {
		const sharedIp = nextIp();
		const userD1 = await makeUser('p8b-lock-d1@example.com');
		const userD2 = await makeUser('p8b-lock-d2@example.com');
		for (let i = 0; i < 5; i++) {
			await login(userD1.email, sharedIp, 'wrong-password');
		}
		// D2 在同一 IP 下 1 次失败即撞上 IP 窗口上限，触发 IP 锁定。
		const trigger = await login(userD2.email, sharedIp, 'wrong-password');
		expect(trigger.json.code).toBe(429);
		const correctWhileLocked = await login(userD2.email, sharedIp, 'password123');
		expect(correctWhileLocked.json.code).toBe(429);
		// 只清 IP 维度的锁与窗口后恢复（账号维度计数不受影响）。
		const keys = await limitKeys(sharedIp, userD2.email);
		await env.kv.delete(keys.ipWin);
		await env.kv.delete(keys.ipLock);
		const ok = await login(userD2.email, sharedIp, 'password123');
		expect(ok.json.code).toBe(200);
	});

	it('成功登录清账号失败计数：4 次失败 + 成功 + 4 次失败仍不锁定', async () => {
		const user = await makeUser('p8b-lock-e@example.com');
		for (let i = 0; i < 4; i++) {
			await login(user.email, nextIp(), 'wrong-password');
		}
		const ok1 = await login(user.email, nextIp(), 'password123');
		expect(ok1.json.code).toBe(200);
		for (let i = 0; i < 4; i++) {
			const r = await login(user.email, nextIp(), 'wrong-password');
			// 既有行为：同上，错密码返回默认 501。
			expect(r.json.code).toBe(501);
		}
		const ok2 = await login(user.email, nextIp(), 'password123');
		expect(ok2.json.code).toBe(200);
	});

	it('指数退避：首锁 5 分钟，逐级 ×3，上限 24 小时', () => {
		expect(ratelimit.backoffSeconds(300, 1)).toBe(300);
		expect(ratelimit.backoffSeconds(300, 2)).toBe(900);
		expect(ratelimit.backoffSeconds(300, 3)).toBe(2700);
		expect(ratelimit.backoffSeconds(300, 10)).toBe(86400);
	});

	it('kernel/audit 清洗：密码/密钥类 key 被丢弃，合法元数据保留', () => {
		const out = kernelAudit.scrubDetail({
			password: 'secret-pwd', secretKey: 'sk-1', code: 'REG-CODE',
			keys: ['register', 'login'], regKeyIds: [1, 2], level: 2, normal: 'ok'
		});
		expect(out.password).toBeUndefined();
		expect(out.secretKey).toBeUndefined();
		expect(out.code).toBeUndefined();
		expect(out.keys).toEqual(['register', 'login']);
		expect(out.regKeyIds).toEqual([1, 2]);
		expect(out.level).toBe(2);
		expect(out.normal).toBe('ok');
	});
});

describe('⑤ 会话最后活跃时间', () => {
	it('登录时初始化 lastActiveAt；鉴权后刷新；列表展示设备/浏览器与脱敏 IP', async () => {
		const user = await makeUser('p8b-sess-a@example.com');
		const ip2 = nextIp();
		const login2 = await login(user.email, ip2, 'password123');
		expect(login2.json.code).toBe(200);
		const listRes = await api('/my/sessions', { token: user.token });
		expect(listRes.json.code).toBe(200);
		expect(listRes.json.data.length).toBe(2);
		for (const s of listRes.json.data) {
			expect(typeof s.lastActiveAt).toBe('string');
			expect(s.lastActiveAt.length).toBeGreaterThan(0);
			expect(typeof s.device).toBe('string');
			expect(typeof s.browser).toBe('string');
			expect(s.ip).toMatch(/^203\.0\.113\.0$/);
			expect(s.createdAt.length).toBeGreaterThan(0);
		}
		// 把其中一个会话的 lastActiveAt 人为写旧，再走一次鉴权接口，应被刷新。
		const metaKey = 'session_meta:' + user.userId;
		const meta = await env.kv.get(metaKey, { type: 'json' });
		const digests = Object.keys(meta);
		expect(digests.length).toBe(2);
		for (const d of digests) {
			meta[d].lastActiveAt = '2020-01-01T00:00:00.000Z';
		}
		await env.kv.put(metaKey, JSON.stringify(meta), { expirationTtl: 2592000 });
		await api('/my/security', { token: user.token });
		const listRes2 = await api('/my/sessions', { token: user.token });
		const refreshed = listRes2.json.data.filter(s => s.lastActiveAt !== '2020-01-01T00:00:00.000Z');
		// 当前 token 对应的会话被刷新（另一会话未鉴权，保持旧值）。
		expect(refreshed.length).toBe(1);
		expect(refreshed[0].current).toBe(true);
	});

	it('一键踢出指定会话：被踢 token 失效，列表只剩当前会话', async () => {
		const user = await makeUser('p8b-sess-b@example.com');
		const ip2 = nextIp();
		const login2 = await login(user.email, ip2, 'password123');
		expect(login2.json.code).toBe(200);
		const token2 = login2.json.data.token;
		const listRes = await api('/my/sessions', { token: user.token });
		expect(listRes.json.data.length).toBe(2);
		const other = listRes.json.data.find(s => !s.current);
		expect(other).toBeTruthy();
		const revoke = await api('/my/sessions/revoke', {
			method: 'POST', token: user.token, body: { digest: other.digest }
		});
		expect(revoke.json.code).toBe(200);
		const listRes2 = await api('/my/sessions', { token: user.token });
		expect(listRes2.json.data.length).toBe(1);
		expect(listRes2.json.data[0].current).toBe(true);
		const kicked = await api('/my/security', { token: token2 });
		expect(kicked.json.code).toBe(401);
	});
});

// 管理员判定 isAdminUser：user_id 1（历史口径）或邮箱等于 env.admin。
// 老站 admin@flame.edu.kg 是 user_id 2，只认 user_id 1 会漏掉真管理员。
describe('⑥ 管理员判定', () => {
	it('user_id 1 即管理员（历史口径）', () => {
		expect(isAdminUser({ env: {} }, { userId: 1, email: 'anyone@example.com' })).toBe(true);
	});

	it('邮箱等于 env.admin 即管理员（老站 user_id 2 的 admin@flame.edu.kg）', () => {
		expect(isAdminUser({ env: { admin: 'admin@flame.edu.kg' } }, { userId: 2, email: 'admin@flame.edu.kg' })).toBe(true);
	});

	it('邮箱比较大小写不敏感', () => {
		expect(isAdminUser({ env: { admin: 'admin@flame.edu.kg' } }, { userId: 9, email: 'Admin@Flame.Edu.Kg' })).toBe(true);
	});

	it('普通用户不是管理员', () => {
		expect(isAdminUser({ env: { admin: 'admin@flame.edu.kg' } }, { userId: 9, email: 'user@example.com' })).toBe(false);
		expect(isAdminUser({ env: {} }, { userId: 9, email: 'user@example.com' })).toBe(false);
	});

	it('无 userRow 返回 false', () => {
		expect(isAdminUser({ env: { admin: 'admin@flame.edu.kg' } }, null)).toBe(false);
	});
});

// 管理员渐进延迟（替代 30 分钟硬锁，防 DoS）：硬锁会被知道管理员邮箱的人
// 利用来锁死管理员本人。改为失败 >= 5 次后每次登录尝试服务端强制延迟
// （5s → 10s → 20s → 40s → 60s 封顶），账号永不锁定；成功登录后计数清零。
describe('⑦ 管理员渐进延迟', () => {
	it('adminDelaySeconds 纯函数：<5 → 0；5 → 5；6 → 10；7 → 20；8 → 40；>=9 → 60 封顶', () => {
		expect(adminDelaySeconds(0)).toBe(0);
		expect(adminDelaySeconds(4)).toBe(0);
		expect(adminDelaySeconds(5)).toBe(5);
		expect(adminDelaySeconds(6)).toBe(10);
		expect(adminDelaySeconds(7)).toBe(20);
		expect(adminDelaySeconds(8)).toBe(40);
		expect(adminDelaySeconds(9)).toBe(60);
		expect(adminDelaySeconds(10)).toBe(60);
		expect(adminDelaySeconds(100)).toBe(60);
		expect(adminDelaySeconds(-1)).toBe(0);
		expect(adminDelaySeconds(NaN)).toBe(0);
	});

	it('管理员 5 次输错后不再锁死：第 6 次延迟约 5 秒、第 7 次延迟约 10 秒且正确密码能进；成功后计数清零', async () => {
		// 测试环境 admin 邮箱为 admin@example.com（wrangler-test.toml），注册即管理员。
		const admin = await makeUser('admin@example.com');
		// 5 次输错：每次换新 IP（不触发 IP 锁），均返回 501 且无延迟。
		for (let i = 0; i < 5; i++) {
			const r = await login(admin.email, nextIp(), 'wrong-password');
			expect(r.json.code).toBe(501);
		}
		// 第 6 次输错：延迟约 5 秒后返回 501，不再是 429 锁死。
		let t0 = Date.now();
		const sixth = await login(admin.email, nextIp(), 'wrong-password');
		const sixthMs = Date.now() - t0;
		expect(sixth.json.code).toBe(501);
		expect(sixthMs).toBeGreaterThanOrEqual(4500);
		// 第 7 次用正确密码：延迟约 10 秒（比第 6 次更长），登录成功。
		t0 = Date.now();
		const ok = await login(admin.email, nextIp(), 'password123');
		const seventhMs = Date.now() - t0;
		expect(ok.json.code).toBe(200);
		expect(seventhMs).toBeGreaterThanOrEqual(9000);
		expect(seventhMs).toBeGreaterThan(sixthMs);
		// 成功后计数清零：admin-fail 窗口已删（limitKeys 的 adminWin 只与邮箱有关，与 IP 无关）。
		const keys = await limitKeys(nextIp(), admin.email);
		const win = await env.kv.get(keys.adminWin, { type: 'json' });
		expect(win).toBeNull();
		// 计数已清零：再错 5 次，第 6 次直接正确密码——延迟回到约 5 秒且能进（永不锁死）。
		for (let i = 0; i < 5; i++) {
			const r = await login(admin.email, nextIp(), 'wrong-password');
			expect(r.json.code).toBe(501);
		}
		t0 = Date.now();
		const ok2 = await login(admin.email, nextIp(), 'password123');
		const ok2Ms = Date.now() - t0;
		expect(ok2.json.code).toBe(200);
		expect(ok2Ms).toBeGreaterThanOrEqual(4500);
		expect(ok2Ms).toBeLessThan(seventhMs);
	}, 90000);
});
