// Phase 19 每邮箱每日发信上限测试（v3_19DB）：vitest + @cloudflare/vitest-pool-workers。
// 覆盖：v3_19DB 迁移、effectiveDayLimit 纯逻辑、真实发信路径 5/天
// （5 封成功、第 6 封 403「今日发信额度已用完，明日恢复」）、
// 按封计（2026-11-12 用户定：一封不管几个收件人只计 1 次；
// 一封发给 6 个人只计 1 次、连发 5 封多收件人仍通过、第 6 封 403）、
// loginUserInfo 返回的 role.sendCount 已钳到 5、
// 角色额度更低时仍以角色为准、daySendLimit=0 时不额外限制。
//
// 说明：只测新站逻辑；老站（flame.edu.kg）一行不改、不部署。
// 运行：mail-worker 下 TZ=UTC npx vitest run test/phase19-dailysend.spec.js。
// 注意：本文件跑在本地 miniflare（wrangler.jsonc 占位绑定），不连线上 D1/KV。
// 注意：各 it 之间 D1 写入不保留（快照回滚），只有 beforeAll 的东西跨用例，
// 所以“发满 5 封再发第 6 封”必须在同一个 it 内完成。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import roleService from '../src/service/role-service';

const TEST_JWT_SECRET = 'phase1-local-test-only-not-a-real-secret';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function api(path, { method = 'GET', body, token, ip, ua } = {}) {
	const headers = { 'Content-Type': 'application/json' };
	if (token) headers['Authorization'] = token;
	if (ip) headers['CF-Connecting-IP'] = ip;
	if (ua !== undefined) headers['User-Agent'] = ua;
	return SELF.fetch(`http://example.com/api${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body)
	}).then(async (res) => {
		let json = null;
		try { json = await res.json(); } catch (e) { /* 非 JSON 忽略 */ }
		return { status: res.status, json };
	});
}

async function register(email, ip) {
	return api('/register', {
		method: 'POST',
		ip,
		ua: CHROME_UA,
		body: { email, password: 'password123' }
	});
}

async function login(email) {
	const res = await api('/login', { method: 'POST', body: { email, password: 'password123' } });
	expect(res.json.code).toBe(200);
	return res.json.data.token;
}

// setting 字段（camelCase）同时写 D1 与 KV 缓存（复用 phase1.spec.js 的口径）。
const SETTING_COLUMN_MAP = {
	register: 'register',
	registerVerify: 'register_verify',
	regKey: 'reg_key',
	secretKey: 'secret_key',
	siteKey: 'site_key',
	ipRegLimit: 'ip_reg_limit',
	ipRegWindowHours: 'ip_reg_window_hours',
	regRateLimitPerMin: 'reg_rate_limit_per_min',
	regCircuitThreshold: 'reg_circuit_threshold',
	regCircuitOpen: 'reg_circuit_open',
	regSegmentLimit: 'reg_segment_limit',
	daySendLimit: 'day_send_limit'
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

// 发一封站内信（收件人已注册；全站内收件不需要外部发信服务）。
async function sendMail(token, accountId, to, subject) {
	return api('/email/send', {
		method: 'POST',
		token,
		body: {
			accountId,
			receiveEmail: Array.isArray(to) ? to : [to],
			subject,
			text: 'hi',
			content: '<p>hi</p>'
		}
	});
}

// 注册发件人 + 收件人，返回发件人的 token / accountId / userId。
async function setupPair(senderEmail, ip, extraRecipients = []) {
	await env.db.prepare(`UPDATE role SET send_type = 'day', send_count = 50, avail_domain = '' WHERE role_id = 1`).run();
	const reg = await register(senderEmail, ip);
	expect(reg.json.code).toBe(200);
	for (const r of extraRecipients) {
		const rr = await register(r.email, r.ip);
		expect(rr.json.code).toBe(200);
	}
	const token = await login(senderEmail);
	const row = await env.db.prepare(`SELECT account_id, user_id FROM account WHERE email = ?`).bind(senderEmail).first();
	return { token, accountId: row.account_id, userId: row.user_id };
}

let initText = '';
beforeAll(async () => {
	const res = await SELF.fetch(`http://example.com/api/init/${TEST_JWT_SECRET}`);
	initText = await res.text();
	// 关 Turnstile 验证（registerVerify=CLOSE），只测限额本身；熔断阈值抬高，避免多注册测试误触。
	await setSetting({ registerVerify: 1, regCircuitThreshold: 999999, daySendLimit: 5 });
}, 30000);

describe('v3_19DB 迁移', () => {
	it('init 成功', () => {
		expect(initText).toBe('success');
	});

	it('setting 新列 day_send_limit 已建，默认 5', async () => {
		const { results } = await env.db.prepare(`SELECT name FROM pragma_table_info('setting')`).all();
		expect(results.map((r) => r.name)).toContain('day_send_limit');
		const row = await env.db.prepare(`SELECT day_send_limit FROM setting LIMIT 1`).first();
		expect(row.day_send_limit).toBe(5);
	});
});

describe('effectiveDayLimit 纯逻辑', () => {
	it('day 角色取 min(角色额度, 设置值)', () => {
		expect(roleService.effectiveDayLimit({ sendType: 'day', sendCount: 50 }, 5)).toBe(5);
		expect(roleService.effectiveDayLimit({ sendType: 'day', sendCount: 50 }, 100)).toBe(50);
	});

	it('设置 0/空时只用角色额度', () => {
		expect(roleService.effectiveDayLimit({ sendType: 'day', sendCount: 50 }, 0)).toBe(50);
		expect(roleService.effectiveDayLimit({ sendType: 'day', sendCount: 50 }, null)).toBe(50);
		expect(roleService.effectiveDayLimit({ sendType: 'day', sendCount: 50 }, undefined)).toBe(50);
	});

	it('角色额度更低时角色额度说了算', () => {
		expect(roleService.effectiveDayLimit({ sendType: 'day', sendCount: 3 }, 5)).toBe(3);
	});

	it('count 角色不走每日口径，仍按总量', () => {
		expect(roleService.effectiveDayLimit({ sendType: 'count', sendCount: 100 }, 5)).toBe(100);
	});
});

describe('发信上限 5/天（真实发信路径）', () => {
	let sender;
	beforeAll(async () => {
		await setSetting({ daySendLimit: 5 });
		sender = await setupPair('p19-a@example.com', '203.0.113.31', [
			{ email: 'p19-b@example.com', ip: '203.0.113.32' },
			{ email: 'p19-c@example.com', ip: '203.0.113.33' },
			{ email: 'p19-d@example.com', ip: '203.0.113.34' },
			{ email: 'p19-e@example.com', ip: '203.0.113.35' },
			{ email: 'p19-f@example.com', ip: '203.0.113.36' },
			{ email: 'p19-g@example.com', ip: '203.0.113.37' }
		]);
	});

	it('连续发 5 封都成功，第 6 封 403 并报「今日发信额度已用完，明日恢复」', async () => {
		for (let i = 1; i <= 5; i++) {
			const res = await sendMail(sender.token, sender.accountId, 'p19-b@example.com', `p19 第 ${i} 封`);
			expect(res.json.code).toBe(200);
		}
		const row = await env.db.prepare(`SELECT send_count FROM user WHERE user_id = ?`).bind(sender.userId).first();
		expect(Number(row.send_count)).toBe(5);
		const over = await sendMail(sender.token, sender.accountId, 'p19-b@example.com', 'p19 第 6 封');
		expect(over.json.code).toBe(403);
		expect(over.json.message).toContain('今日发信额度已用完，明日恢复');
		// 到限后不写发送记录、不再计数
		const after = await env.db.prepare(`SELECT send_count FROM user WHERE user_id = ?`).bind(sender.userId).first();
		expect(Number(after.send_count)).toBe(5);
		const sentCount = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM email WHERE user_id = ? AND type = 1 AND subject = 'p19 第 6 封'`
		).bind(sender.userId).first();
		expect(sentCount.n).toBe(0);
	});

	it('按封计：一封发给 6 个人只计 1 次；连发 5 封（第 5 封 6 收件人）仍通过，第 6 封 403', async () => {
		for (let i = 1; i <= 4; i++) {
			const res = await sendMail(sender.token, sender.accountId, 'p19-b@example.com', `p19 按封计前 ${i} 封`);
			expect(res.json.code).toBe(200);
		}
		const multi = await sendMail(sender.token, sender.accountId,
			['p19-b@example.com', 'p19-c@example.com', 'p19-d@example.com', 'p19-e@example.com', 'p19-f@example.com', 'p19-g@example.com'],
			'p19 六收件人');
		expect(multi.json.code).toBe(200);
		// 6 个收件人的一封只计 1 次：4 + 1 = 5（旧口径会是 4 + 6 = 10，当场 403）
		const row = await env.db.prepare(`SELECT send_count FROM user WHERE user_id = ?`).bind(sender.userId).first();
		expect(Number(row.send_count)).toBe(5);
		const over = await sendMail(sender.token, sender.accountId, 'p19-b@example.com', 'p19 按封计第 6 封');
		expect(over.json.code).toBe(403);
		expect(over.json.message).toContain('今日发信额度已用完，明日恢复');
		// 到限后不写发送记录、不再计数
		const after = await env.db.prepare(`SELECT send_count FROM user WHERE user_id = ?`).bind(sender.userId).first();
		expect(Number(after.send_count)).toBe(5);
		const sentCount = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM email WHERE user_id = ? AND type = 1 AND subject = 'p19 按封计第 6 封'`
		).bind(sender.userId).first();
		expect(sentCount.n).toBe(0);
	});

	it('loginUserInfo 返回的 role.sendCount 已钳到 5（发件页剩余额度显示正确）', async () => {
		const res = await api('/my/loginUserInfo', { method: 'GET', token: sender.token });
		expect(res.json.code).toBe(200);
		expect(res.json.data.role.sendCount).toBe(5);
		expect(Number(res.json.data.sendCount) || 0).toBe(0);
	});
});

describe('角色额度更低时仍以角色为准', () => {
	let sender;
	beforeAll(async () => {
		await setSetting({ daySendLimit: 5 });
		await env.db.prepare(`UPDATE role SET send_type = 'day', send_count = 3, avail_domain = '' WHERE role_id = 1`).run();
		const reg = await register('p19-low@example.com', '203.0.113.41');
		expect(reg.json.code).toBe(200);
		await register('p19-low-b@example.com', '203.0.113.42');
		const token = await login('p19-low@example.com');
		const row = await env.db.prepare(`SELECT account_id, user_id FROM account WHERE email = 'p19-low@example.com'`).first();
		sender = { token, accountId: row.account_id, userId: row.user_id };
	});

	it('角色 3/天：发 3 封成功，第 4 封 403', async () => {
		for (let i = 1; i <= 3; i++) {
			const res = await sendMail(sender.token, sender.accountId, 'p19-low-b@example.com', `p19 低额度第 ${i} 封`);
			expect(res.json.code).toBe(200);
		}
		const over = await sendMail(sender.token, sender.accountId, 'p19-low-b@example.com', 'p19 低额度第 4 封');
		expect(over.json.code).toBe(403);
		expect(over.json.message).toContain('今日发信额度已用完，明日恢复');
	});
});

describe('daySendLimit=0 时不额外限制', () => {
	let sender;
	beforeAll(async () => {
		await setSetting({ daySendLimit: 0 });
		sender = await setupPair('p19-zero@example.com', '203.0.113.51', [
			{ email: 'p19-zero-b@example.com', ip: '203.0.113.52' }
		]);
	});

	it('设置 0：发 6 封都成功（只认角色 50/天）', async () => {
		for (let i = 1; i <= 6; i++) {
			const res = await sendMail(sender.token, sender.accountId, 'p19-zero-b@example.com', `p19 不限第 ${i} 封`);
			expect(res.json.code).toBe(200);
		}
		const row = await env.db.prepare(`SELECT send_count FROM user WHERE user_id = ?`).bind(sender.userId).first();
		expect(Number(row.send_count)).toBe(6);
	});
});
