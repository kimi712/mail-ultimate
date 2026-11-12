// Phase 2 A 路测试：vitest + @cloudflare/vitest-pool-workers。
// 覆盖：密钥余量 < 阈值告警 1 次/天去重、余量充足不告警、
// 异地登录写 login_log + 同 IP 不标新、登录失败不写记录、
// GET /my/loginLog 仅返回本人数据。
// 写法复用 test/phase1.spec.js 的 fakeCtx/api/setSetting。
// 运行：mail-worker 下 npx vitest run test/phase2a.spec.js。
// 注意：跑在本地 miniflare（wrangler.jsonc 占位绑定），不连线上 D1/KV。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import regKeyService from '../src/service/reg-key-service';
import loginLogService from '../src/service/login-log-service';

const TEST_JWT_SECRET = 'phase1-local-test-only-not-a-real-secret';
const IP_A = '203.0.113.21';
const IP_B = '203.0.113.22';

function fakeCtx(ip) {
	return {
		env,
		req: { header: (name) => (name === 'CF-Connecting-IP' ? ip : name === 'user-agent' ? 'phase2a-test/1.0' : null) },
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
	return { status: res.status, json };
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

const SETTING_COLUMN_MAP = {
	registerVerify: 'register_verify',
	regKeyAlertThreshold: 'reg_key_alert_threshold',
	tgBotToken: 'tg_bot_token',
	tgChatId: 'tg_chat_id'
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

function todayStr() {
	return new Date().toISOString().slice(0, 10);
}

async function regKeyAlertCount() {
	const row = await env.db.prepare(
		`SELECT COUNT(*) AS n FROM alert_log WHERE type = 'reg-key'`
	).first();
	return row.n;
}

let initText = '';
beforeAll(async () => {
	const res = await SELF.fetch('http://example.com/api/init', { headers: { Authorization: `Bearer ${TEST_JWT_SECRET}` } });
	initText = await res.text();
	// 关 Turnstile 验证（register_verify=CLOSE），只测本路逻辑；TG 不配（只写 alert_log，不发 TG）
	await setSetting({ registerVerify: 1, tgBotToken: '', tgChatId: '' });
}, 30000);

describe('v3_6DB 迁移（总协调）', () => {
	it('init 成功', () => {
		expect(initText).toBe('success');
	});

	it('login_log / alert_log 表已建', async () => {
		const { results } = await env.db.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('login_log', 'alert_log')`
		).all();
		expect(results.map((r) => r.name).sort()).toEqual(['alert_log', 'login_log']);
	});

	it('setting.reg_key_alert_threshold 列已建', async () => {
		const { results } = await env.db.prepare(`SELECT name FROM pragma_table_info('setting')`).all();
		expect(results.map((r) => r.name)).toContain('reg_key_alert_threshold');
	});
});

describe('密钥库存告警（A 路）', () => {
	it('余量低于阈值告警 1 次/天去重', async () => {
		await env.db.prepare(`DELETE FROM reg_key`).run();
		await env.db.prepare(`DELETE FROM alert_log WHERE type = 'reg-key'`).run();
		await env.kv.delete(`reg_key_alert_day:${todayStr()}`);
		await setSetting({ regKeyAlertThreshold: 500 });
		// 未过期余量 10；count=0 与已过期行不计入总量
		await env.db.prepare(
			`INSERT INTO reg_key (code, role_id, count, user_id, expire_time) VALUES
			 ('P2A-LOW-1', 1, 10, 0, '2030-01-01 00:00:00'),
			 ('P2A-ZERO-1', 1, 0, 0, '2030-01-01 00:00:00'),
			 ('P2A-EXP-1', 1, 999, 0, '2020-01-01 00:00:00')`
		).run();

		await regKeyService.maybeAlertLowStock(fakeCtx(IP_A));
		expect(await regKeyAlertCount()).toBe(1);
		const row = await env.db.prepare(
			`SELECT text FROM alert_log WHERE type = 'reg-key' ORDER BY log_id DESC LIMIT 1`
		).first();
		expect(row.text).toContain('剩余总量 10');
		expect(row.text).toContain('阈值 500');

		// 同一天第二次调用不再告警
		await regKeyService.maybeAlertLowStock(fakeCtx(IP_A));
		expect(await regKeyAlertCount()).toBe(1);
	});

	it('余量充足不告警', async () => {
		await env.db.prepare(`DELETE FROM reg_key`).run();
		await env.db.prepare(`DELETE FROM alert_log WHERE type = 'reg-key'`).run();
		await env.kv.delete(`reg_key_alert_day:${todayStr()}`);
		await setSetting({ regKeyAlertThreshold: 500 });
		await env.db.prepare(
			`INSERT INTO reg_key (code, role_id, count, user_id, expire_time) VALUES ('P2A-OK-1', 1, 600, 0, '2030-01-01 00:00:00')`
		).run();

		await regKeyService.maybeAlertLowStock(fakeCtx(IP_A));
		expect(await regKeyAlertCount()).toBe(0);
		await env.db.prepare(`DELETE FROM reg_key WHERE code = 'P2A-OK-1'`).run();
	});

	it('maybeAlertLowStock 永不抛错', async () => {
		// 故意给一个没有 env.db/kv 的坏 ctx，也不得抛错
		await expect(regKeyService.maybeAlertLowStock({})).resolves.toBeUndefined();
		await expect(loginLogService.record({}, { userId: 1 })).resolves.toBeUndefined();
	});
});

describe('语言偏好（A 路补充）', () => {
	it('POST /my/locale 写后端 + GET /my/locale 读回', async () => {
		const reg = await register('p2a-locale@example.com', IP_A);
		expect(reg.json.code).toBe(200);
		const loginRes = await login('p2a-locale@example.com', IP_A);
		expect(loginRes.json.code).toBe(200);
		const token = loginRes.json.data.token;

		const before = await api('/my/locale', { token });
		expect(before.json.code).toBe(200);
		expect(before.json.data.locale).toBe('');

		const set = await api('/my/locale', { method: 'POST', token, body: { locale: 'ja' } });
		expect(set.json.code).toBe(200);
		const row = await env.db.prepare(
			`SELECT locale FROM user WHERE email = 'p2a-locale@example.com'`
		).first();
		expect(row.locale).toBe('ja');

		const after = await api('/my/locale', { token });
		expect(after.json.code).toBe(200);
		expect(after.json.data.locale).toBe('ja');
	});

	it('POST /my/locale 拒绝非法值', async () => {
		const reg = await register('p2a-locale-bad@example.com', IP_A);
		expect(reg.json.code).toBe(200);
		const loginRes = await login('p2a-locale-bad@example.com', IP_A);
		const token = loginRes.json.data.token;
		const res = await api('/my/locale', { method: 'POST', token, body: { locale: 'xx' } });
		expect(res.json.code).not.toBe(200);
		const row = await env.db.prepare(
			`SELECT locale FROM user WHERE email = 'p2a-locale-bad@example.com'`
		).first();
		expect(row.locale).toBe('');
	});

	it('GET /my/locale 只返回本人数据，未登录 401', async () => {
		const regA = await register('p2a-locale-a@example.com', IP_A);
		expect(regA.json.code).toBe(200);
		const loginA = await login('p2a-locale-a@example.com', IP_A);
		const tokenA = loginA.json.data.token;
		await api('/my/locale', { method: 'POST', token: tokenA, body: { locale: 'ru' } });

		const regB = await register('p2a-locale-b@example.com', IP_A);
		expect(regB.json.code).toBe(200);
		const loginB = await login('p2a-locale-b@example.com', IP_A);
		const resB = await api('/my/locale', { token: loginB.json.data.token });
		expect(resB.json.code).toBe(200);
		expect(resB.json.data.locale).not.toBe('ru');

		const anon = await api('/my/locale');
		expect(anon.json.code).toBe(401);
	});
});

describe('登录日志与异地提醒（A 路）', () => {
	it('异地登录写 login_log 且 is_new_ip=1，同 IP 登录不标新', async () => {
		const reg = await register('p2a-user@example.com', IP_A);
		expect(reg.json.code).toBe(200);
		const userRow = await env.db.prepare(
			`SELECT user_id FROM user WHERE email = 'p2a-user@example.com'`
		).first();
		const userId = userRow.user_id;

		// 第 1 次登录：与注册 IP 相同，不标新
		const login1 = await login('p2a-user@example.com', IP_A);
		expect(login1.json.code).toBe(200);
		let row = await env.db.prepare(
			`SELECT ip, is_new_ip, ua FROM login_log WHERE user_id = ? ORDER BY log_id DESC LIMIT 1`
		).bind(userId).first();
		// Phase 7：log_ip_mask 默认开启，login_log.ip 列存脱敏值（末段 → 0）。
		expect(row.ip).toBe('203.0.113.0');
		expect(row.is_new_ip).toBe(0);
		// getUserAgent() 拼串：测试 UA 无浏览器/OS 信息时 device 默认为 Desktop
		expect(row.ua).toBe('Desktop');

		// 第 2 次登录：换 IP，标新，并发一封站内提醒邮件给本人
		// 注意：默认角色 sendType='ban' 时 emailService.send() 会抛 bannedSend
		// （提醒走正常发信通道，故被禁发用户收不到提醒，见 PHASE2-A.md）；
		// 测试先把该用户角色改为可发信（复用 phase1 的做法）。
		await env.db.prepare(
			`UPDATE role SET send_type = 'day', send_count = 100, avail_domain = '' WHERE role_id = (SELECT type FROM user WHERE email = 'p2a-user@example.com')`
		).run();
		const sentBefore = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM email WHERE user_id = ? AND type = 1`
		).bind(userId).first();
		const login2 = await login('p2a-user@example.com', IP_B);
		expect(login2.json.code).toBe(200);
		row = await env.db.prepare(
			`SELECT ip, is_new_ip FROM login_log WHERE user_id = ? ORDER BY log_id DESC LIMIT 1`
		).bind(userId).first();
		expect(row.ip).toBe('203.0.113.0'); // Phase 7：脱敏后 IP_B 与 IP_A 同为 203.0.113.0
		expect(row.is_new_ip).toBe(1);
		const sentAfter = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM email WHERE user_id = ? AND type = 1`
		).bind(userId).first();
		expect(sentAfter.n).toBe(sentBefore.n + 1);
		const alertMail = await env.db.prepare(
			`SELECT subject, recipient FROM email WHERE user_id = ? AND type = 1 ORDER BY email_id DESC LIMIT 1`
		).bind(userId).first();
		expect(alertMail.recipient).toContain('p2a-user@example.com');

		// 第 3 次登录：仍是 IP_B，不再标新
		const login3 = await login('p2a-user@example.com', IP_B);
		expect(login3.json.code).toBe(200);
		row = await env.db.prepare(
			`SELECT ip, is_new_ip FROM login_log WHERE user_id = ? ORDER BY log_id DESC LIMIT 1`
		).bind(userId).first();
		expect(row.ip).toBe('203.0.113.0'); // Phase 7：脱敏后 IP_B 与 IP_A 同为 203.0.113.0
		expect(row.is_new_ip).toBe(0);
	});

	it('IP 未知（无 CF-Connecting-IP）时不标新、不发提醒', async () => {
		const reg = await register('p2a-unknown@example.com', IP_A);
		expect(reg.json.code).toBe(200);
		const userRow = await env.db.prepare(
			`SELECT user_id FROM user WHERE email = 'p2a-unknown@example.com'`
		).first();
		const sentBefore = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM email WHERE user_id = ? AND type = 1`
		).bind(userRow.user_id).first();
		// 不带 IP 请求头登录：curIp 为 'Unknown'
		const res = await api('/login', {
			method: 'POST',
			body: { email: 'p2a-unknown@example.com', password: 'password123' }
		});
		expect(res.json.code).toBe(200);
		const row = await env.db.prepare(
			`SELECT ip, is_new_ip FROM login_log WHERE user_id = ? ORDER BY log_id DESC LIMIT 1`
		).bind(userRow.user_id).first();
		expect(row.ip).toBe('Unknown');
		expect(row.is_new_ip).toBe(0);
		const sentAfter = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM email WHERE user_id = ? AND type = 1`
		).bind(userRow.user_id).first();
		expect(sentAfter.n).toBe(sentBefore.n);
	});

	it('登录失败不写记录', async () => {
		const reg = await register('p2a-fail@example.com', IP_A);
		expect(reg.json.code).toBe(200);
		const userRow = await env.db.prepare(
			`SELECT user_id FROM user WHERE email = 'p2a-fail@example.com'`
		).first();
		const before = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM login_log WHERE user_id = ?`
		).bind(userRow.user_id).first();
		const bad = await login('p2a-fail@example.com', IP_A, 'wrong-password');
		expect(bad.json.code).not.toBe(200);
		const after = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM login_log WHERE user_id = ?`
		).bind(userRow.user_id).first();
		expect(after.n).toBe(before.n);
	});

	it('GET /my/loginLog 只返回本人数据', async () => {
		const regA = await register('p2a-me@example.com', IP_A);
		expect(regA.json.code).toBe(200);
		const loginA = await login('p2a-me@example.com', IP_A);
		expect(loginA.json.code).toBe(200);
		const tokenA = loginA.json.data.token;
		// 再换 IP 登录一次，产生一条 is_new_ip=1 的记录
		await login('p2a-me@example.com', IP_B);

		const res = await api('/my/loginLog?num=1&size=50', { token: tokenA });
		expect(res.json.code).toBe(200);
		expect(res.json.data.total).toBeGreaterThanOrEqual(2);
		for (const item of res.json.data.list) {
			expect(item.email).toBe('p2a-me@example.com');
		}
		expect(res.json.data.list.some((item) => item.isNewIp === 1 || item.is_new_ip === 1)).toBe(true);

		// 另一用户查不到该用户的数据
		const regB = await register('p2a-other@example.com', IP_A);
		expect(regB.json.code).toBe(200);
		const loginB = await login('p2a-other@example.com', IP_A);
		const tokenB = loginB.json.data.token;
		const resB = await api('/my/loginLog?num=1&size=50', { token: tokenB });
		expect(resB.json.code).toBe(200);
		for (const item of resB.json.data.list) {
			expect(item.email).not.toBe('p2a-me@example.com');
		}
	});
});
