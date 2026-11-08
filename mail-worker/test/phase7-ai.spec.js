// Phase 7 测试：vitest + @cloudflare/vitest-pool-workers。
// 覆盖：v3_9DB 迁移（setting.ai_enabled 列 + 默认 1 + 幂等）、AI 开关、
// 未登录拒绝、输入校验、emailId 归属校验、每用户每天 50 次限流、
// AI 不可用时优雅降级（ai_unavailable，HTTP 恒 200）、
// 三个接口成功 + 主备模型降级（service 级，mock c.env.AI，不调真实 API）。
// 本地 miniflare 没有真实 Workers AI 绑定：HTTP 层成功路径无法走通，
// 成功/降级用 service 级 mock 覆盖；HTTP 层覆盖开关/限流/校验/未登录/
// 不可用。写法复用 test/phase6.spec.js 的 fakeCtx/api/setSetting。
// 运行：mail-worker 下 npx vitest run test/phase7-ai.spec.js。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import aiService from '../src/service/ai-service';
import orm from '../src/entity/orm';
import user from '../src/entity/user';
import { eq } from 'drizzle-orm';

const TEST_JWT_SECRET = 'phase1-local-test-only-not-a-real-secret';
let ipCounter = 200;

function nextIp() {
	ipCounter += 1;
	return `203.0.113.${ipCounter}`;
}

function todayStr() {
	return new Date().toISOString().slice(0, 10);
}

function aiDayKey(userId) {
	return `ai_day:${userId}:${todayStr()}`;
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

async function accountIdOf(email) {
	const row = await env.db.prepare('SELECT account_id FROM account WHERE email = ?').bind(email).first();
	return row.account_id;
}

const SETTING_COLUMN_MAP = {
	registerVerify: 'register_verify',
	aiEnabled: 'ai_enabled'
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

// ---- mock AI（service 级注入 c.env.AI；不调真实 API） ----
function mockAI({ failPrimary = false, failAll = false, response = '测试标题\n\n测试正文内容' } = {}) {
	const calls = [];
	return {
		calls,
		binding: {
			run: async (model, opts) => {
				calls.push({ model, messages: opts.messages });
				if (failAll || (failPrimary && calls.length === 1)) {
					throw new Error('mock AI boom');
				}
				return { response };
			}
		}
	};
}

function serviceCtx(mock) {
	return {
		env: { db: env.db, kv: env.kv, domain: env.domain, AI: mock ? mock.binding : undefined },
		req: { header: () => null },
		get: () => undefined,
		set: () => {}
	};
}

async function resetAiQuota(userId) {
	await env.kv.delete(aiDayKey(userId));
}

async function aiUsage(userId) {
	return Number(await env.kv.get(aiDayKey(userId))) || 0;
}

async function insertEmail(userId, accountId, subject, text) {
	const row = await env.db.prepare(
		`INSERT INTO email (account_id, user_id, subject, text, content, type, is_del) VALUES (?, ?, ?, ?, ?, 0, 0)`
	).bind(accountId, userId, subject, text, `<p>${text}</p>`).run();
	return row.meta.last_row_id;
}

async function setLocale(userId, locale) {
	await orm({ env }).update(user).set({ locale }).where(eq(user.userId, userId)).run();
}

let initText = '';
let alice;
let bob;
let admin;
beforeAll(async () => {
	const res = await SELF.fetch(`http://example.com/api/init/${TEST_JWT_SECRET}`);
	initText = await res.text();
	// 关 Turnstile 验证（register_verify=CLOSE），只测本路逻辑
	await setSetting({ registerVerify: 1, aiEnabled: 1 });
	alice = await makeUser('p7-alice@example.com');
	bob = await makeUser('p7-bob@example.com');
	admin = await makeUser('admin@example.com');
}, 30000);

describe('v3_9DB 迁移', () => {
	it('init 成功', () => {
		expect(initText).toBe('success');
	});

	it('setting.ai_enabled 列已建且默认 1', async () => {
		const cols = await env.db.prepare(`SELECT name FROM pragma_table_info('setting')`).all();
		expect(cols.results.map((r) => r.name)).toContain('ai_enabled');
		const row = await env.db.prepare(`SELECT ai_enabled FROM setting LIMIT 1`).first();
		expect(row.ai_enabled).toBe(1);
	});

	it('再跑一次 /init 幂等成功', async () => {
		const res = await SELF.fetch(`http://example.com/api/init/${TEST_JWT_SECRET}`);
		expect(await res.text()).toBe('success');
		const row = await env.db.prepare(`SELECT ai_enabled FROM setting LIMIT 1`).first();
		expect(row.ai_enabled).toBe(1);
	});

	it('websiteConfig 返回 aiEnabled=1；关掉后返回 0', async () => {
		const on = await api('/setting/websiteConfig');
		expect(on.json.code).toBe(200);
		expect(on.json.data.aiEnabled).toBe(1);
		await setSetting({ aiEnabled: 0 });
		const off = await api('/setting/websiteConfig');
		expect(off.json.data.aiEnabled).toBe(0);
		await setSetting({ aiEnabled: 1 });
	});
});

describe('鉴权', () => {
	it('未登录调 /ai/compose 被拒 401', async () => {
		const res = await api('/ai/compose', { method: 'POST', body: { prompt: '写一封问候邮件' } });
		expect(res.status).toBe(200);
		expect(res.json.code).toBe(401);
	});

	it('未登录调 /ai/reply 被拒 401', async () => {
		const res = await api('/ai/reply', { method: 'POST', body: { subject: 'hi', body: 'hello' } });
		expect(res.json.code).toBe(401);
	});

	it('未登录调 /ai/summarize 被拒 401', async () => {
		const res = await api('/ai/summarize', { method: 'POST', body: { body: 'hello world' } });
		expect(res.json.code).toBe(401);
	});
});

describe('AI 开关（HTTP）', () => {
	it('开关关闭时三个接口返回 ai_disabled（HTTP 恒 200）', async () => {
		await setSetting({ aiEnabled: 0 });
		try {
			const c1 = await api('/ai/compose', { method: 'POST', token: alice.token, body: { prompt: '写一封问候邮件' } });
			expect(c1.status).toBe(200);
			expect(c1.json.code).toBe('ai_disabled');
			expect(c1.json.message).toBe('ai_disabled');
			const c2 = await api('/ai/reply', { method: 'POST', token: alice.token, body: { subject: 'hi', body: 'hello' } });
			expect(c2.json.code).toBe('ai_disabled');
			const c3 = await api('/ai/summarize', { method: 'POST', token: alice.token, body: { body: 'hello world' } });
			expect(c3.json.code).toBe('ai_disabled');
		} finally {
			await setSetting({ aiEnabled: 1 });
		}
	});

	it('开关关闭时不消耗配额', async () => {
		await resetAiQuota(alice.userId);
		await setSetting({ aiEnabled: 0 });
		try {
			await api('/ai/compose', { method: 'POST', token: alice.token, body: { prompt: '写一封问候邮件' } });
		} finally {
			await setSetting({ aiEnabled: 1 });
		}
		expect(await aiUsage(alice.userId)).toBe(0);
	});

	it('管理员 PUT /setting/set 改 aiEnabled 生效', async () => {
		const off = await api('/setting/set', { method: 'PUT', token: admin.token, body: { aiEnabled: 0 } });
		expect(off.json.code).toBe(200);
		const blocked = await api('/ai/compose', { method: 'POST', token: alice.token, body: { prompt: '写一封问候邮件' } });
		expect(blocked.json.code).toBe('ai_disabled');
		const on = await api('/setting/set', { method: 'PUT', token: admin.token, body: { aiEnabled: 1 } });
		expect(on.json.code).toBe(200);
		const unblocked = await api('/ai/compose', { method: 'POST', token: alice.token, body: { prompt: '写一封问候邮件' } });
		// 本地无真实 AI 绑定：开关已开，不再是 ai_disabled，而是 ai_unavailable
		expect(unblocked.json.code).toBe('ai_unavailable');
	});
});

describe('输入校验与归属（HTTP）', () => {
	it('compose 空 prompt / 超长 prompt 返回 ai_invalid_input', async () => {
		const empty = await api('/ai/compose', { method: 'POST', token: alice.token, body: { prompt: '   ' } });
		expect(empty.json.code).toBe('ai_invalid_input');
		const missing = await api('/ai/compose', { method: 'POST', token: alice.token, body: {} });
		expect(missing.json.code).toBe('ai_invalid_input');
		const tooLong = await api('/ai/compose', { method: 'POST', token: alice.token, body: { prompt: 'x'.repeat(2001) } });
		expect(tooLong.json.code).toBe('ai_invalid_input');
	});

	it('reply 空对象返回 ai_invalid_input；不存在的 emailId 返回 ai_not_found', async () => {
		const empty = await api('/ai/reply', { method: 'POST', token: alice.token, body: {} });
		expect(empty.json.code).toBe('ai_invalid_input');
		const gone = await api('/ai/reply', { method: 'POST', token: alice.token, body: { emailId: 999999 } });
		expect(gone.json.code).toBe('ai_not_found');
	});

	it('reply 别人的 emailId 返回 ai_not_found（不区分不存在与非本人）', async () => {
		const emailId = await insertEmail(bob.userId, await accountIdOf('p7-bob@example.com'), 'bob 的邮件', 'bob 的正文');
		const res = await api('/ai/reply', { method: 'POST', token: alice.token, body: { emailId } });
		expect(res.json.code).toBe('ai_not_found');
	});

	it('summarize 空 body / 不存在的 emailId', async () => {
		const empty = await api('/ai/summarize', { method: 'POST', token: alice.token, body: { body: '  ' } });
		expect(empty.json.code).toBe('ai_invalid_input');
		const gone = await api('/ai/summarize', { method: 'POST', token: alice.token, body: { emailId: 999999 } });
		expect(gone.json.code).toBe('ai_not_found');
	});
});

describe('限流（HTTP）', () => {
	it('当日已用 50 次时 compose 返回 ai_quota_exceeded', async () => {
		await env.kv.put(aiDayKey(alice.userId), '50');
		try {
			const res = await api('/ai/compose', { method: 'POST', token: alice.token, body: { prompt: '写一封问候邮件' } });
			expect(res.status).toBe(200);
			expect(res.json.code).toBe('ai_quota_exceeded');
			expect(res.json.message).toBe('ai_quota_exceeded');
		} finally {
			await resetAiQuota(alice.userId);
		}
	});

	it('当日已用 49 次时不限流（走到 ai_unavailable，说明配额检查通过）', async () => {
		await env.kv.put(aiDayKey(alice.userId), '49');
		try {
			const res = await api('/ai/compose', { method: 'POST', token: alice.token, body: { prompt: '写一封问候邮件' } });
			expect(res.json.code).toBe('ai_unavailable');
		} finally {
			await resetAiQuota(alice.userId);
		}
	});
});

describe('AI 不可用（HTTP）', () => {
	it('本地无 AI 绑定时 compose 返回 ai_unavailable，HTTP 200（不是 500）', async () => {
		await resetAiQuota(alice.userId);
		const res = await api('/ai/compose', { method: 'POST', token: alice.token, body: { prompt: '写一封问候邮件' } });
		expect(res.status).toBe(200);
		expect(res.json.code).toBe('ai_unavailable');
		expect(await aiUsage(alice.userId)).toBe(0);
	});
});

describe('写信 / 回信 / 摘要（service + mock AI）', () => {
	it('compose 成功：解析标题+正文，remaining 49，KV 计数 1', async () => {
		await resetAiQuota(alice.userId);
		const mock = mockAI();
		const ctx = serviceCtx(mock);
		const data = await aiService.compose(ctx, alice.userId, { prompt: '给客户写一封问候邮件' });
		expect(data.subject).toBe('测试标题');
		expect(data.body).toBe('测试正文内容');
		expect(data.remaining).toBe(49);
		expect(await aiUsage(alice.userId)).toBe(1);
		expect(mock.calls.length).toBe(1);
		expect(mock.calls[0].model).toBe(aiService.PRIMARY_MODEL);
	});

	it('compose 主模型失败时降级到备用模型并成功', async () => {
		await resetAiQuota(alice.userId);
		const mock = mockAI({ failPrimary: true });
		const data = await aiService.compose(serviceCtx(mock), alice.userId, { prompt: '写一封邮件' });
		expect(data.subject).toBe('测试标题');
		expect(mock.calls.length).toBe(2);
		expect(mock.calls[0].model).toBe('@cf/meta/llama-3.1-8b-instruct');
		expect(mock.calls[1].model).toBe('@cf/meta/llama-3-8b-instruct');
		expect(await aiUsage(alice.userId)).toBe(1);
	});

	it('compose 两模型都失败时抛 ai_unavailable，且不计配额', async () => {
		await resetAiQuota(alice.userId);
		const mock = mockAI({ failAll: true });
		let code = '';
		try {
			await aiService.compose(serviceCtx(mock), alice.userId, { prompt: '写一封邮件' });
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('ai_unavailable');
		expect(mock.calls.length).toBe(2);
		expect(await aiUsage(alice.userId)).toBe(0);
	});

	it('compose 无 AI 绑定时抛 ai_unavailable', async () => {
		await resetAiQuota(alice.userId);
		let code = '';
		try {
			await aiService.compose(serviceCtx(null), alice.userId, { prompt: '写一封邮件' });
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('ai_unavailable');
		expect(await aiUsage(alice.userId)).toBe(0);
	});

	it('compose 默认中文提示词；locale=en 时用英文提示词', async () => {
		await resetAiQuota(alice.userId);
		const mockZh = mockAI();
		await aiService.compose(serviceCtx(mockZh), alice.userId, { prompt: '写一封邮件', tone: 'formal' });
		expect(mockZh.calls[0].messages[0].content).toContain('用中文写邮件');
		expect(mockZh.calls[0].messages[0].content).toContain('正式、措辞得体');

		await setLocale(alice.userId, 'en');
		try {
			await resetAiQuota(alice.userId);
			const mockEn = mockAI();
			await aiService.compose(serviceCtx(mockEn), alice.userId, { prompt: 'write an email' });
			expect(mockEn.calls[0].messages[0].content).toContain('Write the email in English');
		} finally {
			await setLocale(alice.userId, '');
		}
	});

	it('reply（emailId）成功：读本人邮件原文作上下文', async () => {
		await resetAiQuota(alice.userId);
		const emailId = await insertEmail(alice.userId, await accountIdOf('p7-alice@example.com'), '合作邀请', '想约下周三开会');
		const mock = mockAI({ response: 'Re: 合作邀请\n\n感谢来信，下周三可以。' });
		const data = await aiService.reply(serviceCtx(mock), alice.userId, { emailId });
		expect(data.subject).toBe('Re: 合作邀请');
		expect(data.body).toContain('下周三');
		expect(data.remaining).toBe(49);
		expect(mock.calls[0].messages[1].content).toContain('合作邀请');
		expect(mock.calls[0].messages[1].content).toContain('想约下周三开会');
	});

	it('reply（直接传 subject/body/sender）成功；原标题无 Re 时补 Re:', async () => {
		await resetAiQuota(alice.userId);
		const mock = mockAI({ response: '只有正文一行' });
		const data = await aiService.reply(serviceCtx(mock), alice.userId, { subject: '报价单', body: '请查收附件报价', sender: 'a@b.com' });
		expect(data.subject).toBe('Re: 报价单');
		expect(data.body).toBe('只有正文一行');
	});

	it('reply 别人的 emailId 抛 ai_not_found，mock 未被调用', async () => {
		const emailId = await insertEmail(bob.userId, await accountIdOf('p7-bob@example.com'), 'bob 的邮件', 'bob 的正文');
		const mock = mockAI();
		let code = '';
		try {
			await aiService.reply(serviceCtx(mock), alice.userId, { emailId });
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('ai_not_found');
		expect(mock.calls.length).toBe(0);
	});

	it('summarize（emailId）成功：返回 3 行摘要', async () => {
		await resetAiQuota(alice.userId);
		const emailId = await insertEmail(alice.userId, await accountIdOf('p7-alice@example.com'), '周报', '本周完成了 A、B、C 三件事，下周计划做 D。');
		const mock = mockAI({ response: '完成了 A、B、C 三件事\n下周计划做 D\n无其他事项' });
		const data = await aiService.summarize(serviceCtx(mock), alice.userId, { emailId });
		expect(data.summary.split('\n').length).toBe(3);
		expect(data.summary).toContain('完成了 A、B、C');
		expect(data.remaining).toBe(49);
	});

	it('summarize（直接传 body）成功；超过 5 行只取前 5 行', async () => {
		await resetAiQuota(alice.userId);
		const mock = mockAI({ response: '第一行\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行' });
		const data = await aiService.summarize(serviceCtx(mock), alice.userId, { body: '一封很长的邮件正文' });
		expect(data.summary.split('\n').length).toBe(5);
		expect(data.summary).not.toContain('第六行');
	});

	it('summarize 无正文邮件抛 ai_invalid_input', async () => {
		const emailId = await insertEmail(alice.userId, await accountIdOf('p7-alice@example.com'), '空邮件', '');
		const mock = mockAI();
		let code = '';
		try {
			await aiService.summarize(serviceCtx(mock), alice.userId, { emailId });
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('ai_invalid_input');
		expect(mock.calls.length).toBe(0);
	});

	it('超限流时 service 层抛 ai_quota_exceeded，mock 未被调用', async () => {
		await env.kv.put(aiDayKey(alice.userId), '50');
		const mock = mockAI();
		let code = '';
		try {
			await aiService.compose(serviceCtx(mock), alice.userId, { prompt: '写一封邮件' });
		} catch (e) {
			code = e.code;
		} finally {
			await resetAiQuota(alice.userId);
		}
		expect(code).toBe('ai_quota_exceeded');
		expect(mock.calls.length).toBe(0);
	});

	it('开关关闭时 service 层抛 ai_disabled，mock 未被调用', async () => {
		await setSetting({ aiEnabled: 0 });
		const mock = mockAI();
		let code = '';
		try {
			await aiService.compose(serviceCtx(mock), alice.userId, { prompt: '写一封邮件' });
		} catch (e) {
			code = e.code;
		} finally {
			await setSetting({ aiEnabled: 1 });
		}
		expect(code).toBe('ai_disabled');
		expect(mock.calls.length).toBe(0);
	});
});
