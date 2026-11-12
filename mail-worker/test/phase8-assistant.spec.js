// Phase 8 子代理 C 测试：AI 助手（chat 多轮 / triage）与翻译。
// vitest + @cloudflare/vitest-pool-workers，service 级 mock c.env.ai，
// 不调真实 Workers AI。HTTP 层新端点（/ai/chat|triage|translate|
// /ai/chat/clear）待总协调把 assistant-api 注册进 webs.js 后再补
// HTTP 冒烟——本文件只测 service 层（开关/限流/归属/计数/截断/缓存
// 的全部逻辑都在 service 层）。ai_chat 与 translate_cache 两表在
// beforeAll 里按汇报 DDL 手工建（v3_11DB 迁移由总协调并进 init.js）。
// 运行：mail-worker 下 npx vitest run test/phase8-assistant.spec.js。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import assistantService from '../src/service/assistant-service';
import translationService from '../src/service/translation-service';
import orm from '../src/entity/orm';
import user from '../src/entity/user';
import { eq } from 'drizzle-orm';
import { registerNew, loginNew } from './auth-helpers.js';

const TEST_JWT_SECRET = 'phase1-local-test-only-not-a-real-secret';
let ipCounter = 400;

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
	return { status: res.status, json };
}

async function register(email, ip, extra = {}) {
	return registerNew(api, email, { ip, extra });
}

async function login(email, ip, password = 'password123') {
	return loginNew(api, email, { ip, password });
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

// ---- mock AI（service 级注入 c.env.ai；不调真实 API） ----
// response 可以是字符串（每次调用都返回它）或函数（按调用次数返回）。
function mockAI({ failPrimary = false, failAll = false, response = '助手回复内容' } = {}) {
	const calls = [];
	return {
		calls,
		binding: {
			run: async (model, opts) => {
				calls.push({ model, messages: opts.messages });
				if (failAll || (failPrimary && calls.length === 1)) {
					throw new Error('mock AI boom');
				}
				const text = typeof response === 'function' ? response(calls.length) : response;
				// stream: true 时模拟 Workers AI 的 SSE 流：逐字发
				// data: {"response": "字"}，最后发 data: [DONE]。
				if (opts && opts.stream) {
					const encoder = new TextEncoder();
					return new ReadableStream({
						start(controller) {
							for (const ch of text) {
								controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: ch })}\n\n`));
							}
							controller.enqueue(encoder.encode('data: [DONE]\n\n'));
							controller.close();
						}
					});
				}
				return { response: text };
			}
		}
	};
}

// 解析 SSE 响应全文，返回按顺序的帧对象数组（delta / done / error）。
async function readSse(res) {
	const text = await res.text();
	const frames = [];
	for (const part of text.split('\n\n')) {
		const line = part.trim();
		if (!line.startsWith('data:')) continue;
		const payload = line.slice(5).trim();
		if (!payload || payload === '[DONE]') continue;
		frames.push(JSON.parse(payload));
	}
	return frames;
}

function serviceCtx(mock) {
	return {
		env: { db: env.db, kv: env.kv, domain: env.domain, ai: mock ? mock.binding : undefined },
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

async function chatRowCount(userId) {
	const row = await env.db.prepare('SELECT COUNT(*) AS n FROM ai_chat WHERE user_id = ?').bind(userId).first();
	return row.n;
}

async function setLocale(userId, locale) {
	await orm({ env }).update(user).set({ locale }).where(eq(user.userId, userId)).run();
}

let initText = '';
let alice;
let bob;
let carol;
beforeAll(async () => {
	const res = await SELF.fetch('http://example.com/api/init', { headers: { Authorization: `Bearer ${TEST_JWT_SECRET}` } });
	initText = await res.text();
	await setSetting({ registerVerify: 1, aiEnabled: 1 });
	// v3_11DB 未并进 init.js 前，测试自建两张新表（与汇报 DDL 同文）。
	await env.db.prepare(`CREATE TABLE IF NOT EXISTS ai_chat (
		chat_id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL,
		role TEXT NOT NULL,
		content TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`).run();
	await env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_ai_chat_user_time ON ai_chat(user_id, created_at)`).run();
	await env.db.prepare(`CREATE TABLE IF NOT EXISTS translate_cache (
		source_hash TEXT PRIMARY KEY,
		source_lang TEXT NOT NULL DEFAULT '',
		target_lang TEXT NOT NULL DEFAULT '',
		result TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`).run();
	alice = await makeUser('p8-alice@example.com');
	bob = await makeUser('p8-bob@example.com');
	carol = await makeUser('p8-carol@example.com');
}, 30000);

describe('新表', () => {
	it('init 成功', () => {
		expect(initText).toBe('success');
	});

	it('ai_chat 与 translate_cache 表已建', async () => {
		const tables = await env.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
		const names = tables.results.map((r) => r.name);
		expect(names).toContain('ai_chat');
		expect(names).toContain('translate_cache');
	});
});

describe('chat 多轮对话', () => {
	// 注意：本仓库 vitest 环境下，一个 it 内的 D1 写入在下一个 it 不可见
	// （只有 beforeAll 的状态持久；phase7 用例同样全是单测内自包含）。
	// 多轮序列（首轮→第二轮→history→clear）必须放在同一个 it 里验证。
	it('多轮序列：首轮存 2 条 → 第二轮带历史 → history 旧→新 → clear 只清本人', async () => {
		await resetAiQuota(carol.userId);
		await assistantService.clearHistory(serviceCtx(null), carol.userId);

		// 首轮成功：返回 reply，remaining 49，KV 计数 1，历史存 2 条
		const mock1 = mockAI({ response: '你好，我是邮箱助手。' });
		const d1 = await assistantService.chat(serviceCtx(mock1), carol.userId, { message: '你好' });
		expect(d1.reply).toBe('你好，我是邮箱助手。');
		expect(d1.remaining).toBe(49);
		expect(await aiUsage(carol.userId)).toBe(1);
		expect(mock1.calls.length).toBe(1);
		// 主模型（2026-11-09 提速调整）：llama-3.1-8b-instruct-fp8（旧口径 qwen 已作废）。
		expect(mock1.calls[0].model).toBe('@cf/meta/llama-3.1-8b-instruct-fp8');
		expect(await chatRowCount(carol.userId)).toBe(2);

		// 第二轮带上首轮历史：模型收到的 messages 含上一轮问答
		const mock2 = mockAI({ response: '第二轮回复' });
		const d2 = await assistantService.chat(serviceCtx(mock2), carol.userId, { message: '继续说' });
		expect(d2.reply).toBe('第二轮回复');
		const msgs = mock2.calls[0].messages;
		expect(msgs[0].role).toBe('system');
		const contents = msgs.map(m => m.content);
		expect(contents).toContain('你好');
		expect(contents).toContain('你好，我是邮箱助手。');
		expect(contents[contents.length - 1]).toBe('继续说');
		expect(await chatRowCount(carol.userId)).toBe(4);

		// history() 返回旧→新排序的本人历史
		const hist = await assistantService.history(serviceCtx(null), carol.userId);
		expect(hist.messages.length).toBe(4);
		expect(hist.messages[0]).toMatchObject({ role: 'user', content: '你好' });
		expect(hist.messages[3]).toMatchObject({ role: 'assistant', content: '第二轮回复' });

		// clearHistory() 清空本人历史，bob 的历史不受影响
		await assistantService.chat(serviceCtx(mockAI()), bob.userId, { message: 'bob 的问题' });
		expect(await chatRowCount(bob.userId)).toBe(2);
		const cleared = await assistantService.clearHistory(serviceCtx(null), carol.userId);
		expect(cleared.cleared).toBe(4);
		expect(await chatRowCount(carol.userId)).toBe(0);
		expect(await chatRowCount(bob.userId)).toBe(2);
		await assistantService.clearHistory(serviceCtx(null), bob.userId);
	});

	it('chat 带 emailId：读本人邮件作上下文；别人的 emailId 报 ai_not_found', async () => {
		await resetAiQuota(alice.userId);
		const emailId = await insertEmail(alice.userId, await accountIdOf('p8-alice@example.com'), '发票', '本月发票金额 100 元');
		const mock = mockAI({ response: '这封是发票邮件。' });
		const data = await assistantService.chat(serviceCtx(mock), alice.userId, { message: '这封邮件讲了什么？', emailId });
		expect(data.reply).toContain('发票');
		expect(mock.calls[0].messages[1].content).toContain('本月发票金额 100 元');
		await assistantService.clearHistory(serviceCtx(null), alice.userId);

		const bobMail = await insertEmail(bob.userId, await accountIdOf('p8-bob@example.com'), 'bob 的邮件', 'bob 的正文');
		const mock2 = mockAI();
		let code = '';
		try {
			await assistantService.chat(serviceCtx(mock2), alice.userId, { message: '读这封', emailId: bobMail });
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('ai_not_found');
		expect(mock2.calls.length).toBe(0);
	});

	it('chat 空消息 / 超长消息报 ai_invalid_input，mock 未调用', async () => {
		const mock = mockAI();
		let code = '';
		try {
			await assistantService.chat(serviceCtx(mock), alice.userId, { message: '   ' });
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('ai_invalid_input');
		try {
			await assistantService.chat(serviceCtx(mock), alice.userId, { message: 'x'.repeat(2001) });
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('ai_invalid_input');
		expect(mock.calls.length).toBe(0);
	});

	it('chat 主模型失败降级备用；双失败报 ai_unavailable 且不计配额、不留历史', async () => {
		await resetAiQuota(alice.userId);
		await assistantService.clearHistory(serviceCtx(null), alice.userId);
		const mock = mockAI({ failPrimary: true, response: '降级回复' });
		const data = await assistantService.chat(serviceCtx(mock), alice.userId, { message: 'hi' });
		expect(data.reply).toBe('降级回复');
		expect(mock.calls.length).toBe(2);
		expect(await aiUsage(alice.userId)).toBe(1);
		await assistantService.clearHistory(serviceCtx(null), alice.userId);

		await resetAiQuota(alice.userId);
		const mockAll = mockAI({ failAll: true });
		let code = '';
		try {
			await assistantService.chat(serviceCtx(mockAll), alice.userId, { message: 'hi' });
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('ai_unavailable');
		expect(await aiUsage(alice.userId)).toBe(0);
		expect(await chatRowCount(alice.userId)).toBe(0);
	});
});

describe('triage 归类建议', () => {
	it('模型返回合法 JSON：解析出 labels/folder/reason，remaining 49', async () => {
		await resetAiQuota(alice.userId);
		const emailId = await insertEmail(alice.userId, await accountIdOf('p8-alice@example.com'), '电费账单', '本月电费 120 元，请于 25 日前缴纳');
		const mock = mockAI({ response: '{"labels":["账单","财务"],"folder":"inbox","reason":"这是一封电费账单，需要按时缴纳。"}' });
		const data = await assistantService.triage(serviceCtx(mock), alice.userId, { emailId });
		expect(data.labels).toEqual(['账单', '财务']);
		expect(data.folder).toBe('inbox');
		expect(data.reason).toContain('电费账单');
		expect(data.remaining).toBe(49);
		expect(await aiUsage(alice.userId)).toBe(1);
	});

	it('模型返回非法标签/文件夹时被过滤为安全默认值', async () => {
		await resetAiQuota(alice.userId);
		const emailId = await insertEmail(alice.userId, await accountIdOf('p8-alice@example.com'), '测试', '正文');
		const mock = mockAI({ response: '{"labels":["不存在的标签","工作"],"folder":"nonsense","reason":"x"}' });
		const data = await assistantService.triage(serviceCtx(mock), alice.userId, { emailId });
		expect(data.labels).toEqual(['工作']);
		expect(data.folder).toBe('inbox');
	});

	it('模型返回非 JSON 时不报错：兜底 labels 为空、reason 为原文截断', async () => {
		await resetAiQuota(alice.userId);
		const emailId = await insertEmail(alice.userId, await accountIdOf('p8-alice@example.com'), '测试', '正文');
		const mock = mockAI({ response: '这封邮件看起来很重要' });
		const data = await assistantService.triage(serviceCtx(mock), alice.userId, { emailId });
		expect(data.labels).toEqual([]);
		expect(data.folder).toBe('inbox');
		expect(data.reason).toBe('这封邮件看起来很重要');
		expect(data.remaining).toBe(49);
	});

	it('triage 无 emailId 报 ai_invalid_input；别人的邮件报 ai_not_found', async () => {
		const mock = mockAI();
		let code = '';
		try {
			await assistantService.triage(serviceCtx(mock), alice.userId, {});
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('ai_invalid_input');
		const bobMail = await insertEmail(bob.userId, await accountIdOf('p8-bob@example.com'), 'bob 的邮件', 'bob 的正文');
		try {
			await assistantService.triage(serviceCtx(mock), alice.userId, { emailId: bobMail });
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('ai_not_found');
		expect(mock.calls.length).toBe(0);
	});
});

describe('translate 翻译', () => {
	it('读信翻译成功：emailId 翻成用户语言，remaining 49，计 1 次', async () => {
		await resetAiQuota(alice.userId);
		const emailId = await insertEmail(alice.userId, await accountIdOf('p8-alice@example.com'), 'Hello', 'Hello world, this is a test email.');
		const mock = mockAI({ response: '你好世界，这是一封测试邮件。' });
		const data = await translationService.translate(serviceCtx(mock), alice.userId, { emailId, targetLang: 'zh-CN' });
		expect(data.translatedText).toContain('测试邮件');
		expect(data.targetLang).toBe('zh-CN');
		expect(data.truncated).toBe(false);
		expect(data.cached).toBe(false);
		expect(data.remaining).toBe(49);
		expect(await aiUsage(alice.userId)).toBe(1);
	});

	it('写信多语言：直接传 text 翻译；短码 zh 归一化为 zh-CN', async () => {
		await resetAiQuota(alice.userId);
		const mock = mockAI({ response: 'Bonjour le monde' });
		const data = await translationService.translate(serviceCtx(mock), alice.userId, { text: 'Hello world', targetLang: 'fr' });
		expect(data.translatedText).toBe('Bonjour le monde');
		expect(data.targetLang).toBe('fr');
		expect(mock.calls[0].messages[0].content).toContain('français');
	});

	it('同一内容第二次翻译命中缓存：不调模型、不计配额', async () => {
		await resetAiQuota(alice.userId);
		const mock1 = mockAI({ response: '缓存译文' });
		const first = await translationService.translate(serviceCtx(mock1), alice.userId, { text: 'cache me please', targetLang: 'zh-CN' });
		expect(first.cached).toBe(false);
		expect(mock1.calls.length).toBe(1);
		expect(await aiUsage(alice.userId)).toBe(1);
		const mock2 = mockAI({ response: '不应被调用' });
		const second = await translationService.translate(serviceCtx(mock2), alice.userId, { text: 'cache me please', targetLang: 'zh-CN' });
		expect(second.cached).toBe(true);
		expect(second.translatedText).toBe('缓存译文');
		expect(mock2.calls.length).toBe(0);
		expect(await aiUsage(alice.userId)).toBe(1);
	});

	it('translateStream 成功：SSE 逐字返回，结束帧带译文，计 1 次并写缓存', async () => {
		await resetAiQuota(alice.userId);
		const mock = mockAI({ response: 'Bonjour le monde' });
		const res = await translationService.translateStream(serviceCtx(mock), alice.userId, { text: 'Hello world', targetLang: 'fr' });
		expect(res.headers.get('content-type')).toContain('text/event-stream');
		const frames = await readSse(res);
		const deltas = frames.filter(f => typeof f.delta === 'string');
		expect(deltas.map(f => f.delta).join('')).toBe('Bonjour le monde');
		const done = frames.find(f => f.done);
		expect(done).toBeTruthy();
		expect(done.translatedText).toBe('Bonjour le monde');
		expect(done.targetLang).toBe('fr');
		expect(done.cached).toBe(false);
		expect(done.remaining).toBe(49);
		expect(await aiUsage(alice.userId)).toBe(1);
		// 流式翻译写了缓存：随后一次性翻译同一内容直接命中，不调模型。
		const mock2 = mockAI({ response: '不应被调用' });
		const second = await translationService.translate(serviceCtx(mock2), alice.userId, { text: 'Hello world', targetLang: 'fr' });
		expect(second.cached).toBe(true);
		expect(second.translatedText).toBe('Bonjour le monde');
		expect(mock2.calls.length).toBe(0);
	});

	it('translateStream 长文分段并行：两段都调模型，结束帧译文按顺序拼好', async () => {
		await resetAiQuota(alice.userId);
		// 3100 字无断句长文：按 3000 字切成 2 段（3000 + 100）。
		const longText = 'A'.repeat(3100);
		const mock = mockAI({ response: (n) => (n === 1 ? '译文一段' : '译文二段') });
		const res = await translationService.translateStream(serviceCtx(mock), alice.userId, { text: longText, targetLang: 'zh-CN' });
		const frames = await readSse(res);
		const done = frames.find(f => f.done);
		expect(done).toBeTruthy();
		expect(done.translatedText).toBe('译文一段\n译文二段');
		expect(mock.calls.length).toBe(2);
		expect(await aiUsage(alice.userId)).toBe(1);
	});

	it('长文截断：超 12000 字截断并明示 truncated，分段调用不超过 4 次', async () => {
		await resetAiQuota(alice.userId);
		const longText = '长文内容。'.repeat(4000); // 约 20000 字
		const mock = mockAI({ response: (n) => `译文段${n}` });
		const data = await translationService.translate(serviceCtx(mock), alice.userId, { text: longText, targetLang: 'en' });
		expect(data.truncated).toBe(true);
		expect(mock.calls.length).toBeLessThanOrEqual(4);
		expect(mock.calls.length).toBeGreaterThan(1);
		expect(data.translatedText).toContain('译文段1');
		// 多段仍只计 1 次配额
		expect(await aiUsage(alice.userId)).toBe(1);
		expect(data.remaining).toBe(49);
	});

	it('translate 空内容报 ai_invalid_input；别人的 emailId 报 ai_not_found', async () => {
		const mock = mockAI();
		let code = '';
		try {
			await translationService.translate(serviceCtx(mock), alice.userId, { text: '   ' });
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('ai_invalid_input');
		const bobMail = await insertEmail(bob.userId, await accountIdOf('p8-bob@example.com'), 'bob 的邮件', 'bob 的正文');
		try {
			await translationService.translate(serviceCtx(mock), alice.userId, { emailId: bobMail });
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('ai_not_found');
		expect(mock.calls.length).toBe(0);
	});

	it('translate 双模型失败报 ai_unavailable 且不计配额', async () => {
		await resetAiQuota(alice.userId);
		const mock = mockAI({ failAll: true });
		let code = '';
		try {
			await translationService.translate(serviceCtx(mock), alice.userId, { text: 'unique-fail-case-xyz', targetLang: 'en' });
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('ai_unavailable');
		expect(await aiUsage(alice.userId)).toBe(0);
	});
});

describe('开关与限流（新服务共用 ai-service 约定）', () => {
	it('ai_enabled=0 时 chat/triage/translate 均报 ai_disabled，mock 未调用、不计配额', async () => {
		await resetAiQuota(alice.userId);
		await setSetting({ aiEnabled: 0 });
		try {
			const mock = mockAI();
			for (const fn of [
				() => assistantService.chat(serviceCtx(mock), alice.userId, { message: 'hi' }),
				() => assistantService.triage(serviceCtx(mock), alice.userId, { emailId: 1 }),
				() => translationService.translate(serviceCtx(mock), alice.userId, { text: 'hi' })
			]) {
				let code = '';
				try {
					await fn();
				} catch (e) {
					code = e.code;
				}
				expect(code).toBe('ai_disabled');
			}
			expect(mock.calls.length).toBe(0);
			expect(await aiUsage(alice.userId)).toBe(0);
		} finally {
			await setSetting({ aiEnabled: 1 });
		}
	});

	it('当日已用 50 次时 chat 与 translate 报 ai_quota_exceeded，mock 未调用', async () => {
		await env.kv.put(aiDayKey(alice.userId), '50');
		try {
			const mock = mockAI();
			let code = '';
			try {
				await assistantService.chat(serviceCtx(mock), alice.userId, { message: 'hi' });
			} catch (e) {
				code = e.code;
			}
			expect(code).toBe('ai_quota_exceeded');
			try {
				await translationService.translate(serviceCtx(mock), alice.userId, { text: 'hi' });
			} catch (e) {
				code = e.code;
			}
			expect(code).toBe('ai_quota_exceeded');
			expect(mock.calls.length).toBe(0);
		} finally {
			await resetAiQuota(alice.userId);
		}
	});

	it('chat 用中文 locale 时系统提示词为中文；locale=en 时为英文', async () => {
		await resetAiQuota(alice.userId);
		const mockZh = mockAI();
		await assistantService.chat(serviceCtx(mockZh), alice.userId, { message: '你好' });
		expect(mockZh.calls[0].messages[0].content).toContain('邮箱内置助手');
		await assistantService.clearHistory(serviceCtx(null), alice.userId);

		await setLocale(alice.userId, 'en');
		try {
			await resetAiQuota(alice.userId);
			const mockEn = mockAI();
			await assistantService.chat(serviceCtx(mockEn), alice.userId, { message: 'hello' });
			expect(mockEn.calls[0].messages[0].content).toContain('in-mailbox assistant');
		} finally {
			await setLocale(alice.userId, '');
			await assistantService.clearHistory(serviceCtx(null), alice.userId);
		}
	});
});

describe('E2EE 邮件不进 AI（2026-11-11 审计修复，归类/翻译同走 _emailBodyText）', () => {
	async function insertE2eeEmail(userId, accountId) {
		const row = await env.db.prepare(
			`INSERT INTO email (account_id, user_id, subject, text, content, type, is_del, e2ee) VALUES (?, ?, ?, ?, ?, 0, 0, 1)`
		).bind(accountId, userId, '加密信', 'e2ee:v1:AAAAAAAAAAAAAAAA', 'e2ee:v1:AAAAAAAAAAAAAAAA').run();
		return row.meta.last_row_id;
	}

	it('triage E2EE 邮件被拒，模型一次也不调', async () => {
		await resetAiQuota(alice.userId);
		const emailId = await insertE2eeEmail(alice.userId, await accountIdOf('p8-alice@example.com'));
		const mock = mockAI();
		let code = '';
		try {
			await assistantService.triage(serviceCtx(mock), alice.userId, { emailId });
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('ai_e2ee_unsupported');
		expect(mock.calls.length).toBe(0);
	});

	it('翻译 E2EE 邮件被拒，模型一次也不调', async () => {
		await resetAiQuota(alice.userId);
		const emailId = await insertE2eeEmail(alice.userId, await accountIdOf('p8-alice@example.com'));
		const mock = mockAI();
		let code = '';
		try {
			await translationService.translate(serviceCtx(mock), alice.userId, { emailId, targetLang: 'zh-CN' });
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('ai_e2ee_unsupported');
		expect(mock.calls.length).toBe(0);
	});
});
