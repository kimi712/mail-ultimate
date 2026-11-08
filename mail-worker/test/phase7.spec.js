// Phase 7 测试：vitest + @cloudflare/vitest-pool-workers。
// 覆盖：v3_8DB 迁移（user_security.auto_lock_minutes 列 + log_ip_mask 默认开启）、
// GET /security/login-history（只查本人、UA 解析、地点恒空、读时脱敏）、
// 闲置自动锁定读写 + POST /security/unlock（对/错密码、5 次锁定）、
// GET /my/export（本人数据、不含密钥材料）、emailBriefColumns 含 e2ee、
// webhookSecret 字段加密落库、KV AUTH_INFO 不再存密码 hash/salt、
// 物理删除清掉登录历史与安全行。
// 写法复用 test/phase6.spec.js 的 fakeCtx/api/setSetting/makeUser。
// 运行：mail-worker 下 npx vitest run test/phase7.spec.js。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { emailBriefColumns } from '../src/lib/email-list-columns';

const TEST_JWT_SECRET = 'phase1-local-test-only-not-a-real-secret';
const ORIGIN = 'https://aevorynthtech.com';
let ipCounter = 200;
let initText = '';

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
	const res = await SELF.fetch(`http://example.com/api/init/${TEST_JWT_SECRET}`);
	initText = await res.text();
	await setSetting({ registerVerify: 1 });
}, 30000);

describe('v3_8DB 迁移', () => {
	it('init 成功', () => {
		expect(initText).toBe('success');
	});

	it('user_security 含 auto_lock_minutes 列；log_ip_mask 默认已开启', async () => {
		const cols = await env.db.prepare(`PRAGMA table_info(user_security)`).all();
		const names = cols.results.map((c) => c.name);
		expect(names).toContain('auto_lock_minutes');
		const row = await env.db.prepare(`SELECT log_ip_mask FROM setting LIMIT 1`).first();
		expect(Number(row.log_ip_mask)).toBe(1);
	});
});

describe('登录历史接口', () => {
	it('只返回本人的记录；字段含 time/ip/device/browser/isNewIp，location 恒为空', async () => {
		const userA = await makeUser('p7-hist-a@example.com');
		const ip2 = nextIp();
		await login('p7-hist-a@example.com', ip2);
		const userB = await makeUser('p7-hist-b@example.com');
		const res = await api('/security/login-history?num=1&size=20', { token: userA.token });
		expect(res.json.code).toBe(200);
		expect(res.json.data.total).toBe(2);
		for (const item of res.json.data.list) {
			expect(typeof item.time).toBe('string');
			expect(typeof item.ip).toBe('string');
			expect(typeof item.device).toBe('string');
			expect(typeof item.browser).toBe('string');
			expect(typeof item.isNewIp).toBe('number');
			expect(item.location).toBeNull();
		}
		// B 的记录里没有 A 的登录
		const resB = await api('/security/login-history?num=1&size=20', { token: userB.token });
		expect(resB.json.data.total).toBe(1);
		expect(JSON.stringify(resB.json.data.list)).not.toContain(userA.ip);
	});

	it('未登录拒绝；脱敏开启时读到的 IP 为掩码形式', async () => {
		const noAuth = await api('/security/login-history?num=1&size=20');
		expect(noAuth.json.code).not.toBe(200);
		await setSetting({ logIpMask: 1 });
		const user = await makeUser('p7-hist-mask@example.com');
		const res = await api('/security/login-history?num=1&size=20', { token: user.token });
		expect(res.json.code).toBe(200);
		expect(res.json.data.list[0].ip).toBe('203.0.113.0');
	});
});

describe('闲置自动锁定', () => {
	it('autoLockMinutes 读写；非法值 400', async () => {
		const user = await makeUser('p7-lock@example.com');
		const bad = await api('/my/security', {
			method: 'POST', token: user.token, body: { autoLockMinutes: 7 }
		});
		expect(bad.json.code).toBe(400);
		const ok = await api('/my/security', {
			method: 'POST', token: user.token, body: { autoLockMinutes: 15 }
		});
		expect(ok.json.code).toBe(200);
		expect(ok.json.data.autoLockMinutes).toBe(15);
		const get = await api('/my/security', { token: user.token });
		expect(get.json.data.autoLockMinutes).toBe(15);
	});

	it('unlock：密码正确 200；错误 401；连续 5 次错锁 403', async () => {
		const user = await makeUser('p7-unlock@example.com');
		const good = await api('/security/unlock', {
			method: 'POST', token: user.token, body: { password: 'password123' }
		});
		expect(good.json.code).toBe(200);
		for (let i = 0; i < 4; i++) {
			const bad = await api('/security/unlock', {
				method: 'POST', token: user.token, body: { password: 'wrong-password' }
			});
			expect(bad.json.code).toBe(401);
		}
		const fifth = await api('/security/unlock', {
			method: 'POST', token: user.token, body: { password: 'wrong-password' }
		});
		expect(fifth.json.code).toBe(403);
		// 锁定期内正确密码也被拒
		const locked = await api('/security/unlock', {
			method: 'POST', token: user.token, body: { password: 'password123' }
		});
		expect(locked.json.code).toBe(403);
	});
});

describe('导出我的数据', () => {
	it('返回本人资料/安全设置/会话/登录历史/计数，不含密码与密钥材料', async () => {
		const user = await makeUser('p7-export@example.com');
		const res = await api('/my/export', { token: user.token });
		expect(res.json.code).toBe(200);
		const data = res.json.data;
		expect(data.user.email).toBe('p7-export@example.com');
		expect(typeof data.security).toBe('object');
		expect(Array.isArray(data.sessions)).toBe(true);
		expect(Array.isArray(data.loginHistory)).toBe(true);
		expect(data.loginHistory.length).toBe(1);
		expect(data.counts.accounts).toBe(1);
		const flat = JSON.stringify(data);
		expect(flat).not.toContain('password');
		expect(flat).not.toContain('salt');
		expect(flat).not.toContain('secret_encrypted');
		expect(flat).not.toContain('public_key_jwk');
		const other = await makeUser('p7-export-b@example.com');
		const resOther = await api('/my/export', { token: other.token });
		expect(resOther.json.data.user.email).toBe('p7-export-b@example.com');
	});
});

describe('邮件列表加密标志与字段加密', () => {
	it('emailBriefColumns 含 e2ee（列表页徽标的数据来源）', () => {
		expect('e2ee' in emailBriefColumns).toBe(true);
	});

	it('webhookSecret 落库为 enc:v1: 信封', async () => {
		// 测试环境管理员邮箱为 admin@example.com（wrangler-test.toml），
		// 与 phase6 字段加密用例同款写法。
		const user = await makeUser('admin@example.com');
		const setRes = await api('/setting/set', {
			method: 'PUT',
			token: user.token,
			body: { webhookSecret: 'whsec-p7-test-value' }
		});
		expect(setRes.json.code).toBe(200);
		const dbRow = await env.db.prepare(
			`SELECT webhook_secret FROM setting LIMIT 1`
		).first();
		expect(dbRow.webhook_secret.startsWith('enc:v1:')).toBe(true);
		expect(dbRow.webhook_secret).not.toContain('whsec-p7-test-value');
	});
});

describe('KV 凭证材料最小化', () => {
	it('登录后 AUTH_INFO 的 user 不含 password 与 salt', async () => {
		const user = await makeUser('p7-kv@example.com');
		const authInfo = await env.kv.get(`auth-uid:${user.userId}`, { type: 'json' });
		expect(authInfo).toBeTruthy();
		expect(authInfo.user).toBeTruthy();
		expect(authInfo.user.email).toBe('p7-kv@example.com');
		expect(authInfo.user.password).toBeUndefined();
		expect(authInfo.user.salt).toBeUndefined();
		expect(authInfo.user.userId).toBe(user.userId);
	});
});

describe('物理删除清掉个人安全数据', () => {
	it('删号后 login_log 与 user_security 行消失', async () => {
		await setSetting({ syncDelete: 0 });
		const user = await makeUser('p7-del@example.com');
		await api('/my/security', {
			method: 'POST', token: user.token, body: { autoLockMinutes: 5 }
		});
		const before = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM login_log WHERE user_id = ?`
		).bind(user.userId).first();
		expect(before.n).toBe(1);
		const del = await api('/my/delete', { method: 'DELETE', token: user.token });
		expect(del.json.code).toBe(200);
		const gone = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM login_log WHERE user_id = ?`
		).bind(user.userId).first();
		expect(gone.n).toBe(0);
		const secGone = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM user_security WHERE user_id = ?`
		).bind(user.userId).first();
		expect(secGone.n).toBe(0);
		const userGone = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM user WHERE user_id = ?`
		).bind(user.userId).first();
		expect(userGone.n).toBe(0);
		await setSetting({ syncDelete: 1 });
	});
});
