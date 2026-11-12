// Phase 1 测试（C 路）：vitest + @cloudflare/vitest-pool-workers。
// 覆盖：v3_5DB 迁移、注册成功、IP 限额、分钟限流、熔断、Turnstile 未配置、
// OAuth 绑定无 token 被拒、Resend 配额耗尽、审计写入、日志 list API、
// verify_record.ip 文本映射、telegram sendAlert 永不抛错。
//
// 说明：test/index.spec.js 的 Hello World 占位用例断言真实 Worker 返回
// "Hello World!"，与本 Worker（/api 路由 + SPA fallback）不符，故已删除，
// 由本文件取代。运行：mail-worker 下 npx vitest run test/phase1.spec.js。
// 注意：本文件跑在本地 miniflare（wrangler.jsonc 占位绑定），不连线上 D1/KV。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import turnstileService from '../src/service/turnstile-service';
import quotaService from '../src/service/quota-service';
import telegramService from '../src/service/telegram-service';
import verifyRecordService from '../src/service/verify-record-service';
import { registerNew, loginNew } from './auth-helpers.js';

const TEST_JWT_SECRET = 'phase1-local-test-only-not-a-real-secret';
const TEST_IP_OK = '203.0.113.1';
const TEST_IP_LIMIT = '203.0.113.2';
const TEST_IP_RATE = '203.0.113.3';
const TEST_IP_CIRCUIT = '203.0.113.4';

function fakeCtx(ip) {
	return {
		env,
		req: { header: (name) => (name === 'CF-Connecting-IP' ? ip : name === 'user-agent' ? 'phase1-test/1.0' : null) },
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
		// 非 JSON 响应（如 /init 的纯文本）忽略
	}
	return { status: res.status, json };
}

async function register(email, ip, extra = {}) {
	return registerNew(api, email, { ip, extra });
}

async function login(email, password = 'password123') {
	const res = await loginNew(api, email, { password });
	expect(res.json.code).toBe(200);
	return res.json.data.token;
}

// setting 字段（camelCase）同时写 D1 与 KV 缓存。
// 注意：entity/setting.js 尚无 §1 新列（B 路只改了 registerVerify 默认值），
// 故新列只能经此 helper 走原生 SQL + KV 合并写入；set() 走 Drizzle 的
// 旧列不受影响。refresh() 会用实体列重写 KV，未进实体的新列值以 D1 为准、
// 读时由各服务用 ?? 默认值兜底。
const SETTING_COLUMN_MAP = {
	register: 'register',
	registerVerify: 'register_verify',
	regKey: 'reg_key',
	secretKey: 'secret_key',
	siteKey: 'site_key',
	resendTokens: 'resend_tokens',
	ipRegLimit: 'ip_reg_limit',
	ipRegWindowHours: 'ip_reg_window_hours',
	regRateLimitPerMin: 'reg_rate_limit_per_min',
	regCircuitThreshold: 'reg_circuit_threshold',
	regCircuitOpen: 'reg_circuit_open',
	resendDayBudget: 'resend_day_budget',
	resendMonthBudget: 'resend_month_budget',
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
		binds.push(key === 'resendTokens' ? JSON.stringify(value) : value);
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

// 注意：vitest-pool-workers 默认 isolatedStorage:true，存储按 suite/test 分层
// 入栈/出栈：describe 的 beforeAll 只对本 describe 的测试可见。
// 因此 init 放在文件顶层 beforeAll（文件级 suite 层，全文件可见）；
// 跨测试累积的状态一律不依赖——每个测试需要的数据都在本测试内（或本
// describe 的 beforeAll 内）现造。
let initText = '';
beforeAll(async () => {
	const res = await SELF.fetch('http://example.com/api/init', { headers: { Authorization: `Bearer ${TEST_JWT_SECRET}` } });
	initText = await res.text();
}, 30000);

describe('v3_5DB 迁移', () => {
	it('init 成功', () => {
		expect(initText).toBe('success');
	});

	it('新建三张表', async () => {
		const { results } = await env.db.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('register_log', 'audit_log', 'ip_blocklist')`
		).all();
		expect(results.map((r) => r.name).sort()).toEqual(['audit_log', 'ip_blocklist', 'register_log']);
	});

	it('新建全部索引', async () => {
		const { results } = await env.db.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (
				'idx_register_log_segment_time', 'idx_register_log_create_time', 'idx_register_log_ip_time',
				'idx_audit_log_create_time', 'idx_audit_log_actor_time',
				'idx_ip_blocklist_ip', 'idx_ip_blocklist_segment',
				'idx_user_create_ip', 'idx_verify_record_ip_type')`
		).all();
		expect(results.length).toBe(9);
	});

	it('setting 新列（契约 §1）已建', async () => {
		const { results } = await env.db.prepare(`SELECT name FROM pragma_table_info('setting')`).all();
		const names = results.map((r) => r.name);
		for (const col of ['ip_reg_limit', 'ip_reg_window_hours', 'reg_rate_limit_per_min', 'reg_circuit_threshold', 'reg_circuit_open', 'resend_day_budget', 'resend_month_budget']) {
			expect(names).toContain(col);
		}
	});

	it('perm 种子行 37–42 已建且幂等', async () => {
		const { results } = await env.db.prepare(
			`SELECT perm_id, perm_key FROM perm WHERE perm_id BETWEEN 37 AND 42 ORDER BY perm_id`
		).all();
		expect(results.map((r) => r.perm_id)).toEqual([37, 38, 39, 40, 41, 42]);
		expect(results.map((r) => r.perm_key)).toEqual([null, 'ip-block:query', 'ip-block:set', null, 'register-log:query', 'audit-log:query']);
		// 再跑一次 init，种子行不翻倍
		const res = await SELF.fetch('http://example.com/api/init', { headers: { Authorization: `Bearer ${TEST_JWT_SECRET}` } });
		expect(await res.text()).toBe('success');
		const again = await env.db.prepare(`SELECT COUNT(*) AS n FROM perm WHERE perm_id BETWEEN 37 AND 42`).first();
		expect(again.n).toBe(6);
	});
});

describe('注册门禁（A 路）', () => {
	beforeAll(async () => {
		// 关 Turnstile 验证（register_verify=CLOSE），只测门禁本身
		await setSetting({ registerVerify: 1 });
	});

	it('注册成功并写注册日志', async () => {
		const res = await register('ok1@example.com', TEST_IP_OK);
		expect(res.json.code).toBe(200);
		expect(res.json.data.regVerifyOpen).toBe(false);
		const row = await env.db.prepare(
			`SELECT result, ip, ip_segment FROM register_log WHERE email = 'ok1@example.com' ORDER BY log_id DESC LIMIT 1`
		).first();
		expect(row.result).toBe(0);
		// Phase 7：log_ip_mask 默认开启，register_log.ip 列存脱敏值（末段 → 0）；
		// ip_segment 列不受影响，仍为完整段。
		expect(row.ip).toBe('203.0.113.0');
		expect(row.ip_segment).toBe(TEST_IP_OK);
	});

	it('IP 限额：第 4 个同段注册被拒', async () => {
		for (let i = 1; i <= 3; i++) {
			const res = await register(`limit${i}@example.com`, TEST_IP_LIMIT);
			expect(res.json.code).toBe(200);
		}
		const res = await register('limit4@example.com', TEST_IP_LIMIT);
		expect(res.json.code).not.toBe(200);
		expect(res.json.message).toContain('注册已达上限');
		const row = await env.db.prepare(
			`SELECT result, fail_reason FROM register_log WHERE email = 'limit4@example.com' ORDER BY log_id DESC LIMIT 1`
		).first();
		expect(row.result).toBe(1);
		expect(row.fail_reason).toContain('注册已达上限');
	});

	it('分钟限流：第 6 次同段尝试被拒', async () => {
		for (let i = 1; i <= 5; i++) {
			const res = await register('not-an-email', TEST_IP_RATE);
			expect(res.json.message).toContain('非法邮箱');
		}
		const res = await register('not-an-email', TEST_IP_RATE);
		expect(res.json.code).not.toBe(200);
		expect(res.json.message).toContain('过于频繁');
	});

	it('熔断触发：全站 1 分钟超 20 次后拒绝注册', async () => {
		// 直接写 20 条最近 1 分钟内的注册日志（不依赖前面用例的计数）
		for (let i = 0; i < 20; i++) {
			await env.db.prepare(
				`INSERT INTO register_log (ip, ip_segment, email, result) VALUES ('198.51.100.1', '198.51.100.1', ?, 0)`
			).bind(`seed${i}@example.com`).run();
		}
		const res = await register('circuit1@example.com', TEST_IP_CIRCUIT);
		expect(res.json.code).not.toBe(200);
		expect(res.json.message).toContain('暂时关闭维护');
		// D1 熔断标志已置 1
		const settingRow = await env.db.prepare(`SELECT reg_circuit_open FROM setting`).first();
		expect(settingRow.reg_circuit_open).toBe(1);
		// 清理：删种子行、复位熔断标志，避免影响后续用例
		await env.db.prepare(`DELETE FROM register_log WHERE email LIKE 'seed%@example.com'`).run();
		await setSetting({ regCircuitOpen: 0 });
	});
});

describe('Turnstile（B 路）', () => {
	it('未配置 secret 时 verify() 抛 turnstileNotConfigured', async () => {
		await setSetting({ secretKey: '' });
		await expect(turnstileService.verify(fakeCtx(TEST_IP_OK), 'dummy-token')).rejects.toThrow('人机验证未配置');
	});

	it('注册开启验证且无 token 时被拒', async () => {
		await setSetting({ registerVerify: 0, secretKey: '' });
		const res = await register('turnstile1@example.com', '203.0.113.5');
		expect(res.json.code).not.toBe(200);
		expect(res.json.message).toContain('人机验证');
		await setSetting({ registerVerify: 1 });
	});
});

describe('OAuth 绑定（B 路）', () => {
	it('无 token 时绑定被拒，不建账号', async () => {
		await setSetting({ registerVerify: 0, secretKey: '' });
		await env.db.prepare(
			`INSERT INTO oauth (oauth_user_id, platform, user_id) VALUES ('phase1-oauth-1', 'github', 0)`
		).run();
		const res = await api('/oauth/bindUser', {
			method: 'PUT',
			ip: '203.0.113.6',
			body: { email: 'oauthbind@example.com', oauthUserId: 'phase1-oauth-1', code: '', token: '' }
		});
		expect(res.json.code).not.toBe(200);
		expect(res.json.message).toContain('人机验证');
		const userRow = await env.db.prepare(`SELECT user_id FROM user WHERE email = 'oauthbind@example.com'`).first();
		expect(userRow).toBeNull();
		await setSetting({ registerVerify: 1 });
	});
});

describe('Resend 配额（C 路）', () => {
	it('quotaService：日计数达预算时无预算，低于预算时有预算', async () => {
		const dayKey = `resend_day:${todayStr()}`;
		await env.kv.put(dayKey, '100');
		expect(await quotaService.hasResendBudget(fakeCtx(TEST_IP_OK))).toBe(false);
		await env.kv.put(dayKey, '99');
		expect(await quotaService.hasResendBudget(fakeCtx(TEST_IP_OK))).toBe(true);
		await env.kv.delete(dayKey);
	});

	it('quotaService.recordResendSent 按封数累计日/月', async () => {
		const dayKey = `resend_day:${todayStr()}`;
		const monthKey = `resend_month:${todayStr().slice(0, 7)}`;
		await env.kv.delete(dayKey);
		await env.kv.delete(monthKey);
		await quotaService.recordResendSent(fakeCtx(TEST_IP_OK), 3);
		expect(Number(await env.kv.get(dayKey))).toBe(3);
		expect(Number(await env.kv.get(monthKey))).toBe(3);
		await env.kv.delete(dayKey);
		await env.kv.delete(monthKey);
	});

	it('配额耗尽时 send() 抛 resendQuotaExhausted，不调 Resend、不写发送记录', async () => {
		await setSetting({ registerVerify: 1, resendTokens: { 'example.com': 're_phase1_dummy' } });
		await env.db.prepare(`UPDATE role SET send_type = 'count', send_count = 100, avail_domain = '' WHERE role_id = 1`).run();
		const reg = await register('sender@example.com', '203.0.113.7');
		expect(reg.json.code).toBe(200);
		const token = await login('sender@example.com');
		const accountRow = await env.db.prepare(`SELECT account_id, user_id FROM account WHERE email = 'sender@example.com'`).first();
		const dayKey = `resend_day:${todayStr()}`;
		await env.kv.put(dayKey, '100');
		const res = await api('/email/send', {
			method: 'POST',
			token,
			body: {
				accountId: accountRow.account_id,
				receiveEmail: ['outside@other.com'],
				subject: 'quota test',
				text: 'hi',
				content: '<p>hi</p>'
			}
		});
		expect(res.json.code).not.toBe(200);
		expect(res.json.message).toContain('发信额度已用完');
		const sentCount = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM email WHERE user_id = ? AND type = 1`
		).bind(accountRow.user_id).first();
		expect(sentCount.n).toBe(0);
		expect(await env.kv.get(dayKey)).toBe('100');
		await env.kv.delete(dayKey);
	});
});

describe('审计日志与日志 list API（C 路）', () => {
	let adminToken;
	let targetUserId;

	beforeAll(async () => {
		await setSetting({ registerVerify: 1 });
		const reg = await register('admin@example.com', '203.0.113.8');
		expect(reg.json.code).toBe(200);
		adminToken = await login('admin@example.com');
		// 本 describe 专用的目标用户与日志探针（不依赖其他 describe 的数据，
		// 隔离存储下其他测试写的数据在本 describe 不可见）。
		const target = await register('audit-target@example.com', TEST_IP_OK);
		expect(target.json.code).toBe(200);
		const targetRow = await env.db.prepare(`SELECT user_id FROM user WHERE email = 'audit-target@example.com'`).first();
		targetUserId = targetRow.user_id;
		// 一条失败注册，供 result=1 筛选测试用（与下面测试同层可见）
		await register('not-an-email', TEST_IP_OK);
	}, 30000);

	it('setting:set 写 setting:update 审计（detail 只有 key 列表）', async () => {
		const res = await api('/setting/set', { method: 'PUT', token: adminToken, body: { title: 'Phase1 Test' } });
		expect(res.json.code).toBe(200);
		const row = await env.db.prepare(
			`SELECT action, detail FROM audit_log WHERE action = 'setting:update' ORDER BY log_id DESC LIMIT 1`
		).first();
		expect(row).not.toBeNull();
		expect(row.detail).toContain('title');
		expect(row.detail).not.toContain('Phase1 Test');
	});

	it('user:set-status 写审计', async () => {
		const res = await api('/user/setStatus', {
			method: 'PUT',
			token: adminToken,
			body: { userId: targetUserId, status: 1 }
		});
		expect(res.json.code).toBe(200);
		const row = await env.db.prepare(
			`SELECT action, target_id FROM audit_log WHERE action = 'user:set-status' ORDER BY log_id DESC LIMIT 1`
		).first();
		expect(row).not.toBeNull();
		expect(String(row.target_id)).toBe(String(targetUserId));
	});

	it('reg-key:add / reg-key:delete 写审计', async () => {
		const add = await api('/regKey/add', {
			method: 'POST',
			token: adminToken,
			body: { code: 'PHASE1-KEY-1', roleId: 1, count: 5, expireTime: '2030-01-01 00:00:00' }
		});
		expect(add.json.code).toBe(200);
		const added = await env.db.prepare(
			`SELECT action FROM audit_log WHERE action = 'reg-key:add' ORDER BY log_id DESC LIMIT 1`
		).first();
		expect(added).not.toBeNull();
		const keyRow = await env.db.prepare(`SELECT rege_key_id FROM reg_key WHERE code = 'PHASE1-KEY-1'`).first();
		const del = await api(`/regKey/delete?regKeyIds=${keyRow.rege_key_id}`, { method: 'DELETE', token: adminToken });
		expect(del.json.code).toBe(200);
		const deleted = await env.db.prepare(
			`SELECT action FROM audit_log WHERE action = 'reg-key:delete' ORDER BY log_id DESC LIMIT 1`
		).first();
		expect(deleted).not.toBeNull();
	});

	it('registerLog list：按 ip 筛选 + 分页', async () => {
		// beforeAll 已在本 describe 层注册 audit-target@example.com（TEST_IP_OK）。
		// Phase 7：log_ip_mask 默认开启，库里存的是脱敏 IP，故按脱敏值筛选。
		const res = await api(`/registerLog/list?ip=203.0.113.0&num=1&size=10`, { token: adminToken });
		expect(res.json.code).toBe(200);
		expect(res.json.data.total).toBeGreaterThanOrEqual(1);
		for (const row of res.json.data.list) {
			expect(row.ip.startsWith('203.0.113.0')).toBe(true);
		}
	});

	it('registerLog list：按结果筛选', async () => {
		// beforeAll 已在本 describe 层做过一次失败注册（result=1）
		const res = await api('/registerLog/list?result=1&num=1&size=50', { token: adminToken });
		expect(res.json.code).toBe(200);
		expect(res.json.data.total).toBeGreaterThanOrEqual(1);
		for (const row of res.json.data.list) {
			expect(row.result).toBe(1);
		}
	});

	it('auditLog list：按 action 筛选', async () => {
		// 先在本测试内写一条 setting:update，再查（隔离存储下其他测试的审计行不可见）
		const set = await api('/setting/set', { method: 'PUT', token: adminToken, body: { title: 'Phase1 List Probe' } });
		expect(set.json.code).toBe(200);
		const res = await api('/auditLog/list?action=setting:update&num=1&size=10', { token: adminToken });
		expect(res.json.code).toBe(200);
		expect(res.json.data.total).toBeGreaterThanOrEqual(1);
		for (const row of res.json.data.list) {
			expect(row.action).toBe('setting:update');
		}
	});
});

describe('其他 C 路改动', () => {
	it('verify_record.ip 以文本存取（ORM 映射修正）', async () => {
		const c = fakeCtx('203.0.113.9');
		await verifyRecordService.increaseRegCount(c);
		const row = await env.db.prepare(`SELECT ip, typeof(ip) AS t FROM verify_record WHERE ip = '203.0.113.9'`).first();
		expect(row).not.toBeNull();
		expect(row.ip).toBe('203.0.113.9');
		expect(row.t).toBe('text');
	});

	it('telegram sendAlert 无配置时永不抛错', async () => {
		await setSetting({ tgBotToken: '', tgChatId: '' });
		await expect(telegramService.sendAlert(fakeCtx(TEST_IP_OK), 'phase1 test alert')).resolves.toBeUndefined();
	});
});
