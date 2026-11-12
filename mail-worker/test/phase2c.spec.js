// Phase 2 C 路测试：vitest + @cloudflare/vitest-pool-workers。
// 覆盖：user list 按 IP 筛选（精确/前缀/精确优先）、groupByIp 聚合、
// export 上限 5000 与 CSV 头 + BOM、queryEcharts 含 risk 字段、
// 黑名单/日志 list API 权限（无权限 403，有权限 200）。
//
// 写法复用 test/phase1.spec.js 的 fakeCtx/api/register/login/setSetting。
// 运行：mail-worker 下 npx vitest run test/phase2c.spec.js。
// 注意：本文件跑在本地 miniflare（wrangler.jsonc 占位绑定），不连线上 D1/KV。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { registerNew, loginNew } from './auth-helpers.js';

const TEST_JWT_SECRET = 'phase1-local-test-only-not-a-real-secret';

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
		// 非 JSON 响应（如 CSV 导出）忽略
	}
	return { status: res.status, json, res };
}

async function register(email, ip) {
	return registerNew(api, email, { ip });
}

async function login(email, password = 'password123') {
	const res = await loginNew(api, email, { password });
	expect(res.json.code).toBe(200);
	return res.json.data.token;
}

// setting 字段（camelCase）同时写 D1 与 KV 缓存（复用 phase1.spec.js 的做法）。
const SETTING_COLUMN_MAP = {
	registerVerify: 'register_verify',
	regCircuitOpen: 'reg_circuit_open'
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

let initText = '';
beforeAll(async () => {
	const res = await SELF.fetch('http://example.com/api/init', { headers: { Authorization: `Bearer ${TEST_JWT_SECRET}` } });
	initText = await res.text();
	// 关 Turnstile 验证（register_verify=CLOSE），只测 IP 筛选/分组/导出本身
	await setSetting({ registerVerify: 1 });
}, 30000);

async function adminToken() {
	const reg = await register('admin@example.com', '203.0.113.40');
	expect(reg.json.code).toBe(200);
	return login('admin@example.com');
}

describe('用户 IP 筛选与分组', () => {
	let token;
	const IP_A = '203.0.113.21';
	const IP_B = '203.0.113.22';

	beforeAll(async () => {
		token = await adminToken();
		for (const email of ['ip-a1@example.com', 'ip-a2@example.com']) {
			const res = await register(email, IP_A);
			expect(res.json.code).toBe(200);
		}
		const res = await register('ip-b1@example.com', IP_B);
		expect(res.json.code).toBe(200);
	}, 30000);

	it('init 成功', () => {
		expect(initText).toBe('success');
	});

	it('list 按 createIp 精确筛选', async () => {
		const res = await api(`/user/list?createIp=${IP_A}&num=1&size=50`, { token });
		expect(res.json.code).toBe(200);
		expect(res.json.data.total).toBe(2);
		for (const row of res.json.data.list) {
			expect(row.createIp).toBe(IP_A);
		}
	});

	it('list 按 createIpPrefix 前缀筛选', async () => {
		const res = await api('/user/list?createIpPrefix=203.0.113.2&num=1&size=50', { token });
		expect(res.json.code).toBe(200);
		expect(res.json.data.total).toBe(3);
		for (const row of res.json.data.list) {
			expect(row.createIp.startsWith('203.0.113.2')).toBe(true);
		}
	});

	it('createIp 与 createIpPrefix 同时给时只取精确匹配', async () => {
		const res = await api(`/user/list?createIp=${IP_A}&createIpPrefix=${IP_B}&num=1&size=50`, { token });
		expect(res.json.code).toBe(200);
		expect(res.json.data.total).toBe(2);
		for (const row of res.json.data.list) {
			expect(row.createIp).toBe(IP_A);
		}
	});

	it('groupByIp：min=2 只返回注册数达标的 IP', async () => {
		const res = await api('/user/groupByIp?min=2', { token });
		expect(res.json.code).toBe(200);
		expect(Array.isArray(res.json.data)).toBe(true);
		const rowA = res.json.data.find((r) => r.create_ip === IP_A);
		expect(rowA).toBeDefined();
		expect(rowA.total).toBe(2);
		expect(res.json.data.find((r) => r.create_ip === IP_B)).toBeUndefined();
	});

	it('groupByIp：min=1 含单注册 IP', async () => {
		const res = await api('/user/groupByIp?min=1', { token });
		expect(res.json.code).toBe(200);
		const rowB = res.json.data.find((r) => r.create_ip === IP_B);
		expect(rowB).toBeDefined();
		expect(rowB.total).toBe(1);
	});
});

describe('用户导出 CSV', () => {
	let token;
	const IP_EXPORT = '203.0.113.31';
	const IP_BULK = '203.0.113.32';

	beforeAll(async () => {
		token = await adminToken();
		for (const email of ['exp1@example.com', 'exp2@example.com']) {
			const res = await register(email, IP_EXPORT);
			expect(res.json.code).toBe(200);
		}
	}, 30000);

	it('export 返回 CSV：BOM + 表头 + 筛选出的行', async () => {
		// 注意：不能走 api() 辅助函数——它内部先调 res.json() 会消费掉 body，
		// CSV 文本须直接用 SELF.fetch 读。
		const res = await SELF.fetch(`http://example.com/api/user/export?createIp=${IP_EXPORT}`, {
			headers: { Authorization: token }
		});
		expect(res.headers.get('content-type')).toContain('text/csv');
		const text = await res.text();
		expect(text.charCodeAt(0)).toBe(0xfeff);
		const lines = text.slice(1).split('\r\n');
		expect(lines[0]).toBe('userId,email,createIp,activeIp,status,type,createTime');
		expect(lines.length).toBe(3); // 表头 + 2 行
		expect(text).toContain('exp1@example.com');
		expect(text).toContain('exp2@example.com');
		expect(text).toContain(IP_EXPORT);
	});

	it('export 超过 5000 行返回 400', async () => {
		// 一条 SQL 造 5001 个同 IP 用户（只为触发上限分支，不走注册接口）
		await env.db.prepare(
			`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 5001)
			 INSERT INTO user (email, type, password, salt, status, is_del, create_ip)
			 SELECT 'bulk' || n || '@example.com', 1, 'x', 'x', 0, 0, ? FROM seq`
		).bind(IP_BULK).run();
		const res = await api(`/user/export?createIp=${IP_BULK}`, { token });
		expect(res.json.code).toBe(400);
		expect(res.json.message).toBeTruthy();
	});
});

describe('仪表盘 risk 字段', () => {
	let token;
	const IP_RISK = '203.0.113.41';

	beforeAll(async () => {
		token = await adminToken();
		for (const email of ['risk1@example.com', 'risk2@example.com']) {
			const res = await register(email, IP_RISK);
			expect(res.json.code).toBe(200);
		}
		// 一条近 7 天内的熔断拒绝记录（fail_reason 存的是译文，见 analysis-service 注释）
		await env.db.prepare(
			`INSERT INTO register_log (ip, ip_segment, email, result, fail_reason) VALUES (?, ?, 'risk-circuit@example.com', 1, '注册功能暂时关闭维护中，请稍后再试')`
		).bind(IP_RISK, IP_RISK).run();
		// 一张未过期、有余量的注册密钥
		await env.db.prepare(
			`INSERT INTO reg_key (code, count, role_id, expire_time) VALUES ('PHASE2C-KEY-1', 5, 1, '2030-01-01 00:00:00')`
		).run();
	}, 30000);

	it('queryEcharts 含 risk 对象，各子字段结构正确', async () => {
		const res = await api('/analysis/echarts?timeZone=UTC', { token });
		expect(res.json.code).toBe(200);
		const risk = res.json.data.risk;
		expect(risk).toBeDefined();

		// 注册趋势：15 天 UTC 日期序列
		expect(Array.isArray(risk.registerTrend)).toBe(true);
		expect(risk.registerTrend.length).toBe(15);
		for (const item of risk.registerTrend) {
			expect(typeof item.date).toBe('string');
			expect(typeof item.total).toBe('number');
		}

		// IP Top 10：含本 describe 注册的 IP（2 个账号）
		expect(Array.isArray(risk.ipTop10)).toBe(true);
		const row = risk.ipTop10.find((r) => r.create_ip === IP_RISK);
		expect(row).toBeDefined();
		expect(row.total).toBe(2);

		// 熔断事件：近 7 天至少 1 条（beforeAll 插入的），当前熔断关闭
		expect(risk.circuitEvents.count).toBeGreaterThanOrEqual(1);
		expect(risk.circuitEvents.open).toBe(0);

		// 密钥剩余量：至少含 beforeAll 插入的 5 个
		expect(risk.regKeyRemaining).toBeGreaterThanOrEqual(5);

		// Resend 用量：沿用 quotaService 结构
		expect(risk.resendUsage).toBeDefined();
		expect(typeof risk.resendUsage.day).toBe('number');
		expect(typeof risk.resendUsage.month).toBe('number');
		expect(typeof risk.resendUsage.dayBudget).toBe('number');
		expect(typeof risk.resendUsage.monthBudget).toBe('number');
	});

	it('熔断开启时 circuitEvents.open 为 1', async () => {
		await setSetting({ regCircuitOpen: 1 });
		const res = await api('/analysis/echarts?timeZone=UTC', { token });
		expect(res.json.code).toBe(200);
		expect(res.json.data.risk.circuitEvents.open).toBe(1);
		await setSetting({ regCircuitOpen: 0 });
	});

	it('原有字段原样不动', async () => {
		const res = await api('/analysis/echarts?timeZone=UTC', { token });
		expect(res.json.code).toBe(200);
		expect(res.json.data.numberCount).toBeDefined();
		expect(res.json.data.userDayCount).toBeDefined();
		expect(res.json.data.emailDayCount).toBeDefined();
		expect(typeof res.json.data.daySendTotal).toBe('number');
	});
});

describe('黑名单/日志 list API 权限', () => {
	let token;
	let noPermToken;

	beforeAll(async () => {
		token = await adminToken();
		// 建一个零权限角色，并把一个普通用户挂到该角色下
		const addRole = await api('/role/add', {
			method: 'POST',
			token,
			body: { name: 'phase2c-noperm', permIds: [], banEmail: [], availDomain: [] }
		});
		expect(addRole.json.code).toBe(200);
		const roleRow = await env.db.prepare(`SELECT role_id FROM role WHERE name = 'phase2c-noperm'`).first();
		const reg = await register('noperm@example.com', '203.0.113.42');
		expect(reg.json.code).toBe(200);
		const userRow = await env.db.prepare(`SELECT user_id FROM user WHERE email = 'noperm@example.com'`).first();
		const setType = await api('/user/setType', {
			method: 'PUT',
			token,
			body: { type: roleRow.role_id, userId: userRow.user_id }
		});
		expect(setType.json.code).toBe(200);
		noPermToken = await login('noperm@example.com');
	}, 30000);

	it.each([
		['/ipBlocklist/list', 'ip-block:query'],
		['/registerLog/list', 'register-log:query'],
		['/auditLog/list', 'audit-log:query'],
		['/alertLog/list', 'alert:query'],
		['/user/export', 'user:export'],
		['/user/groupByIp', 'user:query']
	])('%s 无权限时返回 403', async (path) => {
		const res = await api(path, { token: noPermToken });
		expect(res.json.code).toBe(403);
	});

	// 回归：security.js exclude 曾用 startsWith 前缀匹配，把 '/registerLog/list'
	// 当成公开的 '/register' 放行，无 token 直接返回 200（可读全站注册日志）。
	// 修复为边界匹配后，无 token 必须返回 401。
	it.each([
		['/registerLog/list'],
		['/auditLog/list'],
		['/alertLog/list'],
		['/ipBlocklist/list']
	])('%s 无 token 时返回 401（不得当成公开接口放行）', async (path) => {
		const res = await api(path, {});
		expect(res.json.code).toBe(401);
	});

	it.each([
		['/ipBlocklist/list'],
		['/registerLog/list'],
		['/auditLog/list'],
		['/alertLog/list'],
		['/user/groupByIp?min=2']
	])('%s 管理员可正常访问', async (path) => {
		const res = await api(path, { token });
		expect(res.json.code).toBe(200);
	});
});
