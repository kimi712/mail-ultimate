// 自助彻底删除测试：vitest + @cloudflare/vitest-pool-workers。
// 覆盖：POST /my/hard-delete（未登录 401、错密码拒绝、确认文字错误拒绝、
// 正确密码 + DELETE 物理删除全部数据且不看 syncDelete、他人数据不受影响、
// 自定义壁纸文件被删、管理员账号拒绝、删后旧 token 失效且无法再登录、
// 审计日志只记 user:physics-delete 且不含邮件内容）。
// 写法复用 test/phase7.spec.js 的 api/register/login/makeUser/setSetting。
// 运行：mail-worker 下 npx vitest run test/phase7-harddelete.spec.js。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

const TEST_JWT_SECRET = 'phase1-local-test-only-not-a-real-secret';
let ipCounter = 400;
let initText = '';
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=';

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

const SETTING_COLUMN_MAP = {
	registerVerify: 'register_verify',
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
	// syncDelete 默认 CLOSE(1)：自删只是软删；彻底删除不看它，始终物理删除。
	await setSetting({ registerVerify: 1, syncDelete: 1 });
}, 30000);

async function countWhere(table, where, userId) {
	const row = await env.db.prepare(
		`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`
	).bind(userId).first();
	return row.n;
}

async function seedUserData(user) {
	const account = await env.db.prepare(
		'SELECT account_id FROM account WHERE user_id = ?'
	).bind(user.userId).first();
	expect(account).toBeTruthy();
	await env.db.prepare(
		`INSERT INTO email (account_id, user_id, subject, text) VALUES (?, ?, ?, ?)`
	).bind(account.account_id, user.userId, 'seed subject', 'seed body').run();
	await env.db.prepare(
		`INSERT INTO user_totp (user_id, secret_encrypted, enabled) VALUES (?, ?, ?)`
	).bind(user.userId, 'enc:test', 1).run();
	await env.db.prepare(
		`INSERT INTO user_passkey (credential_id, user_id, public_key_jwk) VALUES (?, ?, ?)`
	).bind(`cred-${user.userId}`, user.userId, '{}').run();
	await env.db.prepare(
		`INSERT INTO user_security (user_id) VALUES (?)`
	).bind(user.userId).run();
	return account.account_id;
}

describe('自助彻底删除 POST /my/hard-delete', () => {
	it('init 成功', () => {
		expect(initText).toBe('success');
	});

	it('未登录拒绝 401', async () => {
		const res = await api('/my/hard-delete', {
			method: 'POST', body: { password: 'password123', confirmText: 'DELETE' }
		});
		expect(res.status === 401 || res.json?.code === 401).toBe(true);
	});

	it('密码错误拒绝，账号仍在', async () => {
		const user = await makeUser('hd-wrongpwd@example.com');
		const res = await api('/my/hard-delete', {
			method: 'POST', token: user.token,
			body: { password: 'wrong-password', confirmText: 'DELETE' }
		});
		expect(res.json.code).not.toBe(200);
		const still = await env.db.prepare(
			'SELECT COUNT(*) AS n FROM user WHERE user_id = ?'
		).bind(user.userId).first();
		expect(still.n).toBe(1);
		const again = await login('hd-wrongpwd@example.com', nextIp());
		expect(again.json.code).toBe(200);
	});

	it('确认文字错误拒绝，账号仍在', async () => {
		const user = await makeUser('hd-wrongtext@example.com');
		const res = await api('/my/hard-delete', {
			method: 'POST', token: user.token,
			body: { password: 'password123', confirmText: 'delete' }
		});
		expect(res.json.code).not.toBe(200);
		const still = await env.db.prepare(
			'SELECT COUNT(*) AS n FROM user WHERE user_id = ?'
		).bind(user.userId).first();
		expect(still.n).toBe(1);
	});

	it('正确密码 + DELETE：全部数据物理删除，旧 token 失效，无法再登录', async () => {
		const user = await makeUser('hd-ok@example.com');
		await seedUserData(user);
		expect(await countWhere('login_log', 'user_id = ?', user.userId)).toBeGreaterThan(0);
		const res = await api('/my/hard-delete', {
			method: 'POST', token: user.token,
			body: { password: 'password123', confirmText: 'DELETE' }
		});
		expect(res.json.code).toBe(200);
		for (const [table, where] of [
			['user', 'user_id = ?'],
			['account', 'user_id = ?'],
			['email', 'user_id = ?'],
			['login_log', 'user_id = ?'],
			['user_totp', 'user_id = ?'],
			['user_passkey', 'user_id = ?'],
			['user_security', 'user_id = ?']
		]) {
			expect(await countWhere(table, where, user.userId)).toBe(0);
		}
		// KV 会话全部清除
		expect(await env.kv.get(`auth-uid:${user.userId}`)).toBeNull();
		expect(await env.kv.get(`session_meta:${user.userId}`)).toBeNull();
		// 审计日志只记 user:physics-delete，不含邮件内容
		const audit = await env.db.prepare(
			`SELECT detail FROM audit_log WHERE action = 'user:physics-delete' ORDER BY log_id DESC LIMIT 1`
		).first();
		expect(audit).toBeTruthy();
		expect(audit.detail).not.toContain('seed subject');
		expect(audit.detail).not.toContain('seed body');
		// 旧 token 再调接口 → 401；再登录 → 失败
		const stale = await api('/my/loginUserInfo', { token: user.token });
		expect(stale.status === 401 || stale.json?.code === 401).toBe(true);
		const relogin = await login('hd-ok@example.com', nextIp());
		expect(relogin.json.code).not.toBe(200);
	});

	it('他人数据不受影响', async () => {
		const victim = await makeUser('hd-victim@example.com');
		const other = await makeUser('hd-other@example.com');
		await seedUserData(victim);
		await seedUserData(other);
		const res = await api('/my/hard-delete', {
			method: 'POST', token: victim.token,
			body: { password: 'password123', confirmText: 'DELETE' }
		});
		expect(res.json.code).toBe(200);
		expect(await countWhere('user', 'user_id = ?', other.userId)).toBe(1);
		expect(await countWhere('email', 'user_id = ?', other.userId)).toBe(1);
		expect(await countWhere('user_totp', 'user_id = ?', other.userId)).toBe(1);
		const otherLogin = await login('hd-other@example.com', nextIp());
		expect(otherLogin.json.code).toBe(200);
	});

	it('自定义壁纸文件随删号清除', async () => {
		const user = await makeUser('hd-wallpaper@example.com');
		const up = await api('/wallpaper/upload', {
			method: 'POST', token: user.token, body: { image: TINY_PNG }
		});
		expect(up.json.code).toBe(200);
		const { key, url } = up.json.data;
		expect(key.startsWith(`wallpapers/${user.userId}/`)).toBe(true);
		// 设为当前壁纸，再删号
		const setWp = await api('/my/wallpaper', {
			method: 'POST', token: user.token, body: { wallpaper: url, wallpaperTags: [] }
		});
		expect(setWp.json.code).toBe(200);
		expect(await env.kv.get(key)).not.toBeNull();
		const res = await api('/my/hard-delete', {
			method: 'POST', token: user.token,
			body: { password: 'password123', confirmText: 'DELETE' }
		});
		expect(res.json.code).toBe(200);
		expect(await env.kv.get(key)).toBeNull();
		const got = await SELF.fetch(`http://example.com/${url.slice(1)}`);
		expect(got.status).toBe(404);
	});

	it('管理员账号拒绝自助彻底删除', async () => {
		const admin = await makeUser('admin@example.com');
		const res = await api('/my/hard-delete', {
			method: 'POST', token: admin.token,
			body: { password: 'password123', confirmText: 'DELETE' }
		});
		expect(res.json.code).not.toBe(200);
		const still = await env.db.prepare(
			'SELECT COUNT(*) AS n FROM user WHERE user_id = ?'
		).bind(admin.userId).first();
		expect(still.n).toBe(1);
	});
});
