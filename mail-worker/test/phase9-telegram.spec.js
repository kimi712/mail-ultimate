// 用户自助绑定 Telegram 测试：vitest + @cloudflare/vitest-pool-workers。
// 覆盖：v3_13DB 迁移（user.tg_chat_id / tg_bind_code / tg_bind_expires、
// setting.tg_user_push）、POST /my/telegram/bind-code（无 token 拒绝、
// 有 token 出码+链接）、POST /telegram/webhook（有效码绑定、过期码拒绝、
// 错码拒绝、无码 /start 拒绝）、POST /my/telegram/unbind、
// 管理员 PUT /user/unbindTelegram、列表不泄露绑定码、
// Service 级 sendEmailToUser（fetch 桩断言 chat_id / View 按钮）。
// 注意：webhook 回复走真实 api.telegram.org，测试环境无外网，
// fetch 失败由 handleWebhookUpdate 内部 catch，绑定本身不受影响。
// 运行：mail-worker 下 npx vitest run test/phase9-telegram.spec.js。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import telegramService from '../src/service/telegram-service';
import loginService from '../src/service/login-service';

const IP_A = '203.0.113.41';

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
	tgBotToken: 'tg_bot_token',
	tgUserPush: 'tg_user_push',
	customDomain: 'custom_domain'
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

function fakeCtx() {
	return { env, get: () => undefined, set: () => {} };
}

async function userRow(email) {
	return env.db.prepare(`SELECT user_id, email, tg_chat_id, tg_bind_code, tg_bind_expires FROM user WHERE email = ?`).bind(email).first();
}

let tokenA = '';
let userIdA = 0;
let adminToken = '';

beforeAll(async () => {
	const res = await SELF.fetch(`http://example.com/api/init/${env.jwt_secret}`);
	expect(await res.text()).toBe('success');
	// 关 Turnstile 验证（register_verify=CLOSE），只测本路逻辑
	await setSetting({ registerVerify: 1 });

	const reg = await register('p9-tg-user@example.com', IP_A);
	expect(reg.json.code).toBe(200);
	const loginRes = await login('p9-tg-user@example.com', IP_A);
	expect(loginRes.json.code).toBe(200);
	tokenA = loginRes.json.data.token;
	const row = await userRow('p9-tg-user@example.com');
	userIdA = row.user_id;

	// 管理员账号（邮箱与 wrangler.jsonc 的 admin 一致即有 * 权限）
	const regAdmin = await register('admin@example.com', IP_A);
	expect(regAdmin.json.code).toBe(200);
	const loginAdmin = await login('admin@example.com', IP_A);
	expect(loginAdmin.json.code).toBe(200);
	adminToken = loginAdmin.json.data.token;
});

describe('v3_13DB 迁移', () => {
	it('user 表有 tg 三列，setting 表有 tg_user_push（默认 0=开启）', async () => {
		const userCols = await env.db.prepare(`SELECT name FROM pragma_table_info('user')`).all();
		const names = userCols.results.map(r => r.name);
		expect(names).toContain('tg_chat_id');
		expect(names).toContain('tg_bind_code');
		expect(names).toContain('tg_bind_expires');
		const settingCols = await env.db.prepare(`SELECT name FROM pragma_table_info('setting')`).all();
		expect(settingCols.results.map(r => r.name)).toContain('tg_user_push');
		const cached = await env.kv.get('setting:', { type: 'json' });
		expect(cached.tgUserPush).toBe(0);
	});
});

describe('绑定码生成', () => {
	it('未配 Bot Token 时拒绝', async () => {
		const res = await api('/my/telegram/bind-code', { method: 'POST', token: tokenA });
		expect(res.json.code).toBe(400);
	});

	it('配好 Token 后出码（getMe 在测试环境不可达，link 为空但码可用）', async () => {
		await setSetting({ tgBotToken: 'TESTTOKEN123' });
		const res = await api('/my/telegram/bind-code', { method: 'POST', token: tokenA });
		expect(res.json.code).toBe(200);
		const data = res.json.data;
		expect(typeof data.code).toBe('string');
		expect(data.code.length).toBe(16);
		expect(typeof data.expiresAt).toBe('string');
		const row = await userRow('p9-tg-user@example.com');
		expect(row.tg_bind_code).toBe(data.code);
		expect(row.tg_bind_expires).toBe(data.expiresAt);
	});
});

describe('webhook 绑定', () => {
	it('有效码绑定成功，码被清空', async () => {
		const code = 'VALIDCODE12345678';
		const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
		await env.db.prepare(`UPDATE user SET tg_bind_code = ?, tg_bind_expires = ? WHERE user_id = ?`)
			.bind(code, expires, userIdA).run();
		const res = await api('/telegram/webhook', {
			method: 'POST',
			body: { message: { chat: { id: 987654321 }, text: `/start ${code}` } }
		});
		expect(res.status).toBe(200);
		const row = await userRow('p9-tg-user@example.com');
		expect(row.tg_chat_id).toBe('987654321');
		expect(row.tg_bind_code).toBe('');
		expect(row.tg_bind_expires).toBe('');
	});

	it('过期码不绑定且被清理', async () => {
		const code = 'EXPIREDCODE123456';
		const expires = new Date(Date.now() - 60 * 1000).toISOString();
		await env.db.prepare(`UPDATE user SET tg_chat_id = '', tg_bind_code = ?, tg_bind_expires = ? WHERE user_id = ?`)
			.bind(code, expires, userIdA).run();
		const res = await api('/telegram/webhook', {
			method: 'POST',
			body: { message: { chat: { id: 111222333 }, text: `/start ${code}` } }
		});
		expect(res.status).toBe(200);
		const row = await userRow('p9-tg-user@example.com');
		expect(row.tg_chat_id).toBe('');
		expect(row.tg_bind_code).toBe('');
	});

	it('错码不绑定', async () => {
		const res = await api('/telegram/webhook', {
			method: 'POST',
			body: { message: { chat: { id: 111222333 }, text: '/start NOPECODE0000000' } }
		});
		expect(res.status).toBe(200);
		const row = await userRow('p9-tg-user@example.com');
		expect(row.tg_chat_id).toBe('');
	});

	it('无码 /start 不绑定', async () => {
		const res = await api('/telegram/webhook', {
			method: 'POST',
			body: { message: { chat: { id: 111222333 }, text: '/start' } }
		});
		expect(res.status).toBe(200);
		const row = await userRow('p9-tg-user@example.com');
		expect(row.tg_chat_id).toBe('');
	});

	it('非 /start 消息不绑定', async () => {
		const res = await api('/telegram/webhook', {
			method: 'POST',
			body: { message: { chat: { id: 111222333 }, text: 'hello' } }
		});
		expect(res.status).toBe(200);
		const row = await userRow('p9-tg-user@example.com');
		expect(row.tg_chat_id).toBe('');
	});
});

describe('解绑', () => {
	it('用户自助解绑清掉 chat id', async () => {
		await env.db.prepare(`UPDATE user SET tg_chat_id = '555666777' WHERE user_id = ?`).bind(userIdA).run();
		const status = await api('/my/telegram', { token: tokenA });
		expect(status.json.data.bound).toBe(true);
		const res = await api('/my/telegram/unbind', { method: 'POST', token: tokenA });
		expect(res.json.code).toBe(200);
		const row = await userRow('p9-tg-user@example.com');
		expect(row.tg_chat_id).toBe('');
		const status2 = await api('/my/telegram', { token: tokenA });
		expect(status2.json.data.bound).toBe(false);
	});

	it('管理员解绑指定用户，且列表不泄露绑定码', async () => {
		await env.db.prepare(`UPDATE user SET tg_chat_id = '999888777', tg_bind_code = 'ADMINSEES0000001', tg_bind_expires = ? WHERE user_id = ?`)
			.bind(new Date(Date.now() + 600000).toISOString(), userIdA).run();
		const res = await api('/user/unbindTelegram', { method: 'PUT', token: adminToken, body: { userId: userIdA } });
		expect(res.json.code).toBe(200);
		const row = await userRow('p9-tg-user@example.com');
		expect(row.tg_chat_id).toBe('');
		expect(row.tg_bind_code).toBe('');

		// 列表返回里不能有 tgBindCode（活凭证）
		await env.db.prepare(`UPDATE user SET tg_bind_code = 'LEAKCHECK0000001' WHERE user_id = ?`).bind(userIdA).run();
		const list = await api('/user/list?num=1&size=50', { token: adminToken });
		expect(list.json.code).toBe(200);
		const mine = list.json.data.list.find(u => u.userId === userIdA);
		expect(mine).toBeTruthy();
		expect(mine.tgBindCode).toBeUndefined();
		expect(mine.tgBindExpires).toBeUndefined();
		expect(mine.tgChatId).toBe('');
		await env.db.prepare(`UPDATE user SET tg_bind_code = '' WHERE user_id = ?`).bind(userIdA).run();
	});

	it('普通用户调管理员解绑被 403', async () => {
		const res = await api('/user/unbindTelegram', { method: 'PUT', token: tokenA, body: { userId: userIdA } });
		expect(res.json.code).toBe(403);
	});
});

describe('Service 级推送', () => {
	it('sendEmailToUser 按用户 chat id 发，带 View 按钮与验证码按钮', async () => {
		const calls = [];
		const stubFetch = vi.fn(async (url, init) => {
			calls.push({ url, body: JSON.parse(init.body) });
			return { ok: true, json: async () => ({ ok: true }) };
		});
		vi.stubGlobal('fetch', stubFetch);
		try {
			await setSetting({ tgBotToken: 'TESTTOKEN123', customDomain: 'mail.example.com' });
			const emailRow = {
				emailId: 12345,
				subject: '验证码测试',
				name: 'GitHub',
				sendEmail: 'noreply@github.com',
				toEmail: 'p9-tg-user@example.com',
				text: '你的验证码是 123456',
				content: '',
				code: '123456'
			};
			await telegramService.sendEmailToUser(fakeCtx(), emailRow, '42424242');
			expect(calls.length).toBe(1);
			expect(calls[0].url).toContain('TESTTOKEN123');
			expect(calls[0].body.chat_id).toBe('42424242');
			expect(calls[0].body.text).toContain('验证码测试');
			const keyboard = calls[0].body.reply_markup.inline_keyboard;
			expect(keyboard[0][0].text).toBe('View');
			expect(keyboard[0][0].web_app.url).toContain('/api/telegram/getEmail/');
			expect(keyboard[1][0].text).toBe('123456');
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('getBotUsername 无 token 时返回 null', async () => {
		await setSetting({ tgBotToken: '' });
		const name = await telegramService.getBotUsername(fakeCtx());
		expect(name).toBeNull();
	});
});

// 管理员登录提醒（Telegram 版）：sendMessageToChat + login-service._sendAdminLoginAlert。
// 收件人只认管理员本人绑定的 user.tg_chat_id；未绑定或未配机器人时不发、不抛错、不走邮件。
describe('管理员登录 TG 提醒', () => {
	function fakeLoginCtx(host) {
		return {
			env,
			req: { header: (name) => (name === 'host' ? host : undefined) },
			get: () => undefined,
			set: () => {}
		};
	}

	it('sendMessageToChat 按绑定 chat id 发纯文本', async () => {
		const calls = [];
		const stubFetch = vi.fn(async (url, init) => {
			calls.push({ url, body: JSON.parse(init.body) });
			return { ok: true, json: async () => ({ ok: true }) };
		});
		vi.stubGlobal('fetch', stubFetch);
		try {
			await setSetting({ tgBotToken: 'TESTTOKEN123' });
			const ok = await telegramService.sendMessageToChat(fakeCtx(), '42424242', 'hello');
			expect(ok).toBe(true);
			expect(calls.length).toBe(1);
			expect(calls[0].url).toContain('TESTTOKEN123');
			expect(calls[0].url).toContain('/sendMessage');
			expect(calls[0].body.chat_id).toBe('42424242');
			expect(calls[0].body.text).toBe('hello');
			expect(calls[0].body.reply_markup).toBeUndefined();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('sendMessageToChat 无 token 时返回 false 且不发请求', async () => {
		const stubFetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
		vi.stubGlobal('fetch', stubFetch);
		try {
			await setSetting({ tgBotToken: '' });
			const ok = await telegramService.sendMessageToChat(fakeCtx(), '42424242', 'hello');
			expect(ok).toBe(false);
			expect(stubFetch).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('sendMessageToChat TG 返回失败时返回 false 且不抛错', async () => {
		const stubFetch = vi.fn(async () => ({ ok: false, status: 403, text: async () => 'Forbidden' }));
		vi.stubGlobal('fetch', stubFetch);
		try {
			await setSetting({ tgBotToken: 'TESTTOKEN123' });
			const ok = await telegramService.sendMessageToChat(fakeCtx(), '42424242', 'hello');
			expect(ok).toBe(false);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('_sendAdminLoginAlert 已绑定时发 TG，内容含站点/时间/IP/设备', async () => {
		const calls = [];
		const stubFetch = vi.fn(async (url, init) => {
			calls.push({ url, body: JSON.parse(init.body) });
			return { ok: true, json: async () => ({ ok: true }) };
		});
		vi.stubGlobal('fetch', stubFetch);
		try {
			await setSetting({ tgBotToken: 'TESTTOKEN123' });
			const userRow = { userId: 1, email: 'admin@aevorynthtech.com', tgChatId: '42424242' };
			await loginService._sendAdminLoginAlert(fakeLoginCtx('aevorynthtech.com'), userRow, '203.0.113.7', 'Chrome / Windows');
			expect(calls.length).toBe(1);
			expect(calls[0].body.chat_id).toBe('42424242');
			const text = calls[0].body.text;
			expect(text).toContain('管理员账号');
			expect(text).toContain('新站 (aevorynthtech.com)');
			expect(text).toContain('203.0.113.7');
			expect(text).toContain('Chrome / Windows');
			expect(text).toContain('北京时间');
			expect(text).not.toContain('password');
			expect(text).not.toContain('token');
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('_sendAdminLoginAlert 未绑定 TG 时不发请求、不抛错', async () => {
		const stubFetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
		vi.stubGlobal('fetch', stubFetch);
		try {
			await setSetting({ tgBotToken: 'TESTTOKEN123' });
			const userRow = { userId: 1, email: 'admin@aevorynthtech.com', tgChatId: '' };
			await loginService._sendAdminLoginAlert(fakeLoginCtx('aevorynthtech.com'), userRow, '203.0.113.7', 'Chrome / Windows');
			expect(stubFetch).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('_sendAdminLoginAlert TG 返回失败时不抛错（登录不受影响）', async () => {
		const stubFetch = vi.fn(async () => ({ ok: false, status: 403, text: async () => 'Forbidden' }));
		vi.stubGlobal('fetch', stubFetch);
		try {
			await setSetting({ tgBotToken: 'TESTTOKEN123' });
			const userRow = { userId: 1, email: 'admin@aevorynthtech.com', tgChatId: '42424242' };
			await expect(loginService._sendAdminLoginAlert(fakeLoginCtx('aevorynthtech.com'), userRow, '203.0.113.7', 'Chrome / Windows')).resolves.toBeUndefined();
			expect(stubFetch).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
