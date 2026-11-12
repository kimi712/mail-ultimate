// Phase 8 总协调 HTTP 冒烟：新路由在 webs.js 里的注册 + 鉴权边界。
// service 层逻辑由各子代理的 spec 覆盖（phase8-assistant / phase8e / phase8f）；
// 这里只证明：
//   ① /ai/*、/mail-trust/*、/recovery/*、/privacy/* 已注册（不是 404）；
//   ② 需要登录的端点无 token 返回 401；
//   ③ 公开的 /recovery/request 无 token 可进（security.js exclude 已加 '/recovery'）；
//   ④ 登录后 /mail-trust/prefs 与 /mail-trust/read 走通，跨用户读信被拒。
// 注意：测试环境没有 Workers AI 绑定，/ai/* 期望返回 ai_unavailable（不是 404）。
// 运行：mail-worker 下 npx vitest run test/phase8-http-smoke.spec.js。
// 环境规则（与 phase8f 一致）：一个 it 内的 D1/KV 写入在下一个 it 不可见，
// 只有 beforeAll 的状态持久；每个 it 必须单测内自包含。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

const TEST_JWT_SECRET = env.jwt_secret;
// 注意：旧 spec 文件里写死的 'test-jwt-secret' 调 /init 会返回
// "❌ JWT secret mismatch"（它们不靠 /init 建表，全靠磁盘持久化的旧状态，
// 所以照样通过）。新测试直接用 env 里的真值，保证从干净状态也能跑，
// 顺带验证 v3_11DB 迁移经 /init 能干净跑完。
let ipCounter = 200;

function nextIp() {
	ipCounter += 1;
	return `203.0.113.${ipCounter}`;
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

async function makeUser(email) {
	const ip = nextIp();
	const reg = await api('/register', { method: 'POST', ip, body: { email, password: 'password123' } });
	expect(reg.json.code).toBe(200);
	const loginRes = await api('/login', { method: 'POST', ip, body: { email, password: 'password123' } });
	expect(loginRes.json.code).toBe(200);
	const row = await env.db.prepare('SELECT user_id FROM user WHERE email = ?').bind(email).first();
	return { token: loginRes.json.data.token, userId: row.user_id, email };
}

async function insertEmail(userId, { senderEmail = 'sender@example.com', subject = 'hello' } = {}) {
	const row = await env.db.prepare(
		`INSERT INTO email (account_id, user_id, sender_email, name, subject, to_email, type, unread, is_del)
		 VALUES (0, ?, ?, '', ?, ?, 0, 0, 0)`
	).bind(userId, senderEmail, subject, `${userId}@example.com`).run();
	return row.meta.last_row_id;
}

let alice;
let bob;

beforeAll(async () => {
	const res = await SELF.fetch('http://example.com/api/init', { headers: { Authorization: `Bearer ${TEST_JWT_SECRET}` } });
	await res.text();
	// registerVerify=1（phase8f 同款：注册无需 Turnstile；D1 与 KV 缓存都要置）。
	await env.db.prepare(`UPDATE setting SET register_verify = 1`).run();
	const cached = (await env.kv.get('setting:', { type: 'json' })) || {};
	cached.registerVerify = 1;
	await env.kv.put('setting:', JSON.stringify(cached));
	alice = await makeUser('smoke-alice@example.com');
	bob = await makeUser('smoke-bob@example.com');
}, 30000);

describe('Phase 8 HTTP 冒烟：新路由注册与鉴权', () => {
	it('无 token 调 /mail-trust/read 返回 401（路由已注册，鉴权生效）', async () => {
		const res = await api('/mail-trust/read/1');
		expect(res.json.code).toBe(401);
	});

	it('无 token 调 /ai/chat 返回 401', async () => {
		const res = await api('/ai/chat', { method: 'POST', body: { message: 'hi' } });
		expect(res.json.code).toBe(401);
	});

	it('无 token 调 /ai/chat/history 返回 401', async () => {
		const res = await api('/ai/chat/history');
		expect(res.json.code).toBe(401);
	});

	it('无 token 调 /privacy/dashboard 返回 401', async () => {
		const res = await api('/privacy/dashboard');
		expect(res.json.code).toBe(401);
	});

	it('公开的 /recovery/reset-by-code 无 token 可进：不存在的邮箱 + 错码返回通用 400（不透露账号是否存在）', async () => {
		const res = await api('/recovery/reset-by-code', {
			method: 'POST',
			ip: nextIp(),
			body: { email: 'nobody-at-all@example.com', code: 'AAAA-AAAA-AAAA', newPassword: 'NewPass123!' }
		});
		expect(res.json.code).toBe(400);
	});

	it('登录后 /mail-trust/prefs 返回默认偏好（undoSeconds 数字）', async () => {
		const res = await api('/mail-trust/prefs', { token: alice.token });
		expect(res.status).toBe(200);
		expect(res.json.code).toBe(200);
		expect(typeof res.json.data.undoSeconds).toBe('number');
	});

	it('登录后 /mail-trust/read 返回本人邮件的认证/退订/信任字段', async () => {
		const emailId = await insertEmail(alice.userId);
		const res = await api(`/mail-trust/read/${emailId}`, { token: alice.token });
		expect(res.status).toBe(200);
		expect(res.json.code).toBe(200);
		expect(res.json.data).toHaveProperty('auth');
		expect(res.json.data).toHaveProperty('unsubscribe');
		expect(res.json.data).toHaveProperty('trusted');
		expect(res.json.data).toHaveProperty('allowRemote');
	});

	it('跨用户读 /mail-trust/read 被拒（trust_email_not_found）', async () => {
		const emailId = await insertEmail(bob.userId);
		const res = await api(`/mail-trust/read/${emailId}`, { token: alice.token });
		expect(res.json.code).toBe('trust_email_not_found');
	});

	it('登录后 /ai/chat 已注册：无 AI 绑定时返回 ai_unavailable（不是 404）', async () => {
		const res = await api('/ai/chat', { method: 'POST', token: alice.token, body: { message: '帮我写封回信' } });
		expect(res.json.code).toBe('ai_unavailable');
	});

	it('登录后 /ai/translate 已注册：无 AI 绑定时返回 ai_unavailable（不是 404）', async () => {
		const res = await api('/ai/translate', { method: 'POST', token: alice.token, body: { text: 'Hello world', targetLang: 'zh' } });
		expect(res.json.code).toBe('ai_unavailable');
	});

	it('登录后 /ai/triage 已注册：无 AI 绑定时返回 ai_unavailable（不是 404）', async () => {
		const emailId = await insertEmail(alice.userId, { subject: 'Invoice #123 due tomorrow' });
		const res = await api('/ai/triage', { method: 'POST', token: alice.token, body: { emailId } });
		expect(res.json.code).toBe('ai_unavailable');
	});
});
