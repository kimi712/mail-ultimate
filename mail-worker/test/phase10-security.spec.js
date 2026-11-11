// 斯诺登三件套测试：vitest + @cloudflare/vitest-pool-workers。
// 覆盖：v3_14DB 迁移（email 新列 expire_at / burn_after_read / expire_group、
// email_alias 新表、setting.canary_date）、resolveExpiry（none/burn/1h/1d/7d/30d/非法值）、
// POST /email/send 带 expireOption（1h：收发两端同组同 expireAt；burn：两端 burnAfterRead=1）、
// PUT /email/read opened=true 阅后即焚（收件人+发件人同组全删；opened=false 不烧）、
// 过期信列表剥离内容 + expired=1、sweepExpired 兜底清扫、
// 别名 API（生成/列表/10 个上限/停用/启用/删除/跨用户 404/停用别名拒收）、
// GET /my/canary（默认 2026-11-09，改 setting 后返回新日期）。
// 运行：mail-worker 下 npx vitest run test/phase10-security.spec.js。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import emailService from '../src/service/email-service';
import aliasService from '../src/service/alias-service';

const IP_A = '203.0.113.51';
const IP_B = '203.0.113.52';

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

async function register(email, ip) {
	return api('/register', {
		method: 'POST',
		ip,
		body: { email, password: 'password123' }
	});
}

async function login(email, ip, password = 'password123') {
	const res = await api('/login', { method: 'POST', ip, body: { email, password } });
	return res.json?.data?.token;
}

const SETTING_COLUMN_MAP = {
	registerVerify: 'register_verify',
	canaryDate: 'canary_date'
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

let tokenA, tokenB, userIdA, userIdB, accountIdA, accountIdB;

beforeAll(async () => {
	const res = await SELF.fetch(`http://example.com/api/init/${env.jwt_secret}`);
	expect(await res.text()).toBe('success');
	// 关 Turnstile 验证（register_verify=CLOSE），只测本路逻辑
	await setSetting({ registerVerify: 1 });

	const regA = await register('p10-a@example.com', IP_A);
	expect(regA.json.code).toBe(200);
	tokenA = await login('p10-a@example.com', IP_A);
	expect(tokenA).toBeTruthy();
	const regB = await register('p10-b@example.com', IP_B);
	expect(regB.json.code).toBe(200);
	tokenB = await login('p10-b@example.com', IP_B);
	expect(tokenB).toBeTruthy();
	userIdA = (await env.db.prepare(`SELECT user_id FROM user WHERE email = 'p10-a@example.com'`).first()).user_id;
	userIdB = (await env.db.prepare(`SELECT user_id FROM user WHERE email = 'p10-b@example.com'`).first()).user_id;
	accountIdA = (await env.db.prepare(`SELECT account_id FROM account WHERE user_id = ?`).bind(userIdA).first()).account_id;
	accountIdB = (await env.db.prepare(`SELECT account_id FROM account WHERE user_id = ?`).bind(userIdB).first()).account_id;
});

describe('v3_14DB 迁移', () => {
	it('email 表有 expire_at / burn_after_read / expire_group 三列', async () => {
		const cols = await env.db.prepare(`PRAGMA table_info(email)`).all();
		const names = (cols.results || []).map(r => r.name);
		expect(names).toContain('expire_at');
		expect(names).toContain('burn_after_read');
		expect(names).toContain('expire_group');
	});

	it('email_alias 表存在且 address 全局唯一', async () => {
		const t = await env.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='email_alias'`).first();
		expect(t?.name).toBe('email_alias');
		const idx = await env.db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_alias_address'`).first();
		expect(idx?.name).toBe('idx_alias_address');
	});

	it('setting 表有 canary_date 列，默认 2026-11-09', async () => {
		const cols = await env.db.prepare(`PRAGMA table_info(setting)`).all();
		const names = (cols.results || []).map(r => r.name);
		expect(names).toContain('canary_date');
		const row = await env.db.prepare(`SELECT canary_date FROM setting LIMIT 1`).first();
		expect(row.canary_date).toBe('2026-11-09');
	});
});

describe('resolveExpiry', () => {
	it('none/空/非法值 → 不过期', () => {
		for (const opt of ['none', '', undefined, 'bogus']) {
			const r = emailService.resolveExpiry(opt);
			expect(r).toEqual({ expireAt: '', burnAfterRead: 0, expireGroup: '' });
		}
	});

	it('burn → burnAfterRead=1、无 expireAt、有组标识', () => {
		const r = emailService.resolveExpiry('burn');
		expect(r.expireAt).toBe('');
		expect(r.burnAfterRead).toBe(1);
		expect(r.expireGroup).toMatch(/^[0-9a-f]{24}$/);
	});

	it('1h/1d/7d/30d → expireAt 在对应时长后（±2 分钟容差）', () => {
		const now = Date.now();
		const cases = { '1h': 3600e3, '1d': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
		for (const [opt, ms] of Object.entries(cases)) {
			const r = emailService.resolveExpiry(opt);
			expect(r.burnAfterRead).toBe(0);
			expect(r.expireGroup).toMatch(/^[0-9a-f]{24}$/);
			const at = new Date(r.expireAt.replace(' ', 'T') + 'Z').getTime();
			expect(Math.abs(at - (now + ms))).toBeLessThan(2 * 60e3);
		}
	});
});

describe('发信带 expireOption（真实发信路径）', () => {
	it('1h 自毁：收件人收件行与发件人已发送行同组、同 expireAt', async () => {
		const res = await api('/email/send', {
			method: 'POST', token: tokenA,
			body: {
				accountId: accountIdA,
				receiveEmail: ['p10-b@example.com'],
				subject: 'p10 1h 自毁', text: '1h body', content: '<p>1h body</p>',
				expireOption: '1h'
			}
		});
		expect(res.json.code).toBe(200);
		const recv = await env.db.prepare(
			`SELECT expire_at, burn_after_read, expire_group FROM email WHERE user_id = ? AND type = 0 AND subject = 'p10 1h 自毁'`
		).bind(userIdB).first();
		const sent = await env.db.prepare(
			`SELECT expire_at, burn_after_read, expire_group FROM email WHERE user_id = ? AND type = 1 AND subject = 'p10 1h 自毁'`
		).bind(userIdA).first();
		expect(recv).toBeTruthy();
		expect(sent).toBeTruthy();
		expect(recv.expire_at).not.toBe('');
		expect(recv.expire_at).toBe(sent.expire_at);
		expect(recv.expire_group).toBe(sent.expire_group);
		expect(recv.expire_group.length).toBe(24);
		expect(recv.burn_after_read).toBe(0);
		expect(sent.burn_after_read).toBe(0);
	});

	it('burn：两端 burnAfterRead=1、同组、无 expireAt', async () => {
		const res = await api('/email/send', {
			method: 'POST', token: tokenA,
			body: {
				accountId: accountIdA,
				receiveEmail: ['p10-b@example.com'],
				// 斯诺登第四批 P1-3：burn 强制 E2EE，明文信选 burn 会被拒（见下条用例），
				// 此处带 e2ee: 1 才能成功建 burn 信。
				subject: 'p10 burn', text: 'burn body', content: '<p>burn body</p>',
				expireOption: 'burn', e2ee: 1
			}
		});
		expect(res.json.code).toBe(200);
		const recv = await env.db.prepare(
			`SELECT expire_at, burn_after_read, expire_group, email_id FROM email WHERE user_id = ? AND type = 0 AND subject = 'p10 burn'`
		).bind(userIdB).first();
		const sent = await env.db.prepare(
			`SELECT expire_at, burn_after_read, expire_group FROM email WHERE user_id = ? AND type = 1 AND subject = 'p10 burn'`
		).bind(userIdA).first();
		expect(recv.burn_after_read).toBe(1);
		expect(sent.burn_after_read).toBe(1);
		expect(recv.expire_at).toBe('');
		expect(sent.expire_at).toBe('');
		expect(recv.expire_group).toBe(sent.expire_group);
		// 阅后即焚：收件人 opened=true 打开后，收件行 + 发件人已发送行同组全删。
		const read = await api('/email/read', {
			method: 'PUT', token: tokenB,
			body: { emailIds: [recv.email_id], opened: true }
		});
		expect(read.json.code).toBe(200);
		const goneRecv = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM email WHERE user_id = ? AND subject = 'p10 burn'`
		).bind(userIdB).first();
		const goneSent = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM email WHERE user_id = ? AND subject = 'p10 burn'`
		).bind(userIdA).first();
		expect(goneRecv.n).toBe(0);
		expect(goneSent.n).toBe(0);
	});

	it('burn 明文信被拒：不带 e2ee 选 burn 返回 400，不建信', async () => {
		const res = await api('/email/send', {
			method: 'POST', token: tokenA,
			body: {
				accountId: accountIdA,
				receiveEmail: ['p10-b@example.com'],
				subject: 'p10 burn-plain', text: 'plain burn', content: '<p>plain burn</p>',
				expireOption: 'burn'
			}
		});
		expect(res.json.code).toBe(400);
		const n = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM email WHERE subject = 'p10 burn-plain'`
		).first();
		expect(n.n).toBe(0);
	});

	it('opened=false 不烧：列表标已读只改 unread，不删信', async () => {
		await api('/email/send', {
			method: 'POST', token: tokenA,
			body: {
				accountId: accountIdA,
				receiveEmail: ['p10-b@example.com'],
				subject: 'p10 burn2', text: 'burn2', content: '<p>burn2</p>',
				expireOption: 'burn', e2ee: 1
			}
		});
		const recv = await env.db.prepare(
			`SELECT email_id FROM email WHERE user_id = ? AND type = 0 AND subject = 'p10 burn2'`
		).bind(userIdB).first();
		await api('/email/read', {
			method: 'PUT', token: tokenB,
			body: { emailIds: [recv.email_id] }
		});
		const still = await env.db.prepare(
			`SELECT COUNT(*) AS n, unread FROM email WHERE user_id = ? AND subject = 'p10 burn2' GROUP BY unread`
		).bind(userIdB).first();
		expect(still.n).toBe(1);
		expect(still.unread).toBe(1); // 已读
		// 清理：用 opened=true 烧掉，避免污染后续用例
		await api('/email/read', {
			method: 'PUT', token: tokenB,
			body: { emailIds: [recv.email_id], opened: true }
		});
	});
});

describe('过期信列表剥离 + sweepExpired', () => {
	it('已过期信：列表里 content/text 被剥离、expired=1；sweep 后彻底删除', async () => {
		// 直接插一封已过期的收件信（expire_at 为过去时间）
		const past = new Date(Date.now() - 3600e3).toISOString().slice(0, 19).replace('T', ' ');
		const accountB = await env.db.prepare(`SELECT account_id FROM account WHERE user_id = ?`).bind(userIdB).first();
		const ins = await env.db.prepare(
			`INSERT INTO email (user_id, account_id, type, subject, content, text, send_email, to_email, name, create_time, expire_at, burn_after_read, expire_group, status, unread, is_del)
			 VALUES (?, ?, 0, 'p10 expired', '<p>secret</p>', 'secret', 'p10-a@example.com', 'p10-b@example.com', 'p10-a', datetime('now'), ?, 0, '', 0, 0, 0)`
		).bind(userIdB, accountB.account_id, past).run();
		const emailId = ins.meta.last_row_id;
		const list = await api(`/email/list?type=0&accountId=${accountIdB}&size=20`, { token: tokenB });
		expect(list.json.code).toBe(200);
		const item = (list.json.data?.list || list.json.data || []).find(e => e.emailId === emailId);
		expect(item).toBeTruthy();
		expect(item.expired).toBe(1);
		expect(item.content || '').toBe('');
		expect(item.text || '').toBe('');
		// 兜底清扫删掉它
		const swept = await emailService.sweepExpired(fakeCtx());
		expect(swept.swept).toBeGreaterThanOrEqual(1);
		const gone = await env.db.prepare(`SELECT COUNT(*) AS n FROM email WHERE email_id = ?`).bind(emailId).first();
		expect(gone.n).toBe(0);
	});
});

describe('一次性别名 API', () => {
	// 注意：本测试池每个 it 用例之间不保留 D1 写入（快照回滚），
	// 所以每个用例自己创建别名，不跨用例共享 aliasId。
	async function makeAlias(token) {
		const res = await api('/my/alias', { method: 'POST', token });
		expect(res.json.code).toBe(200);
		return res.json.data;
	}

	it('生成别名：地址为随机前缀 @example.com，初始收信 0、启用中', async () => {
		const item = await makeAlias(tokenA);
		expect(item.address).toMatch(/^[a-z0-9]+@example\.com$/);
		expect(item.status).toBe(0);
		expect(item.recvCount).toBe(0);
	});

	it('列表含该别名；往别名发信进主收件箱且 recvCount+1', async () => {
		const item = await makeAlias(tokenA);
		const list = await api('/my/alias', { token: tokenA });
		expect(list.json.code).toBe(200);
		expect(list.json.data.some(a => a.aliasId === item.aliasId)).toBe(true);
		const send = await api('/email/send', {
			method: 'POST', token: tokenB,
			body: {
				accountId: accountIdB,
				receiveEmail: [item.address],
				subject: 'p10 alias mail', text: 'via alias', content: '<p>via alias</p>'
			}
		});
		expect(send.json.code).toBe(200);
		const inbox = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM email WHERE user_id = ? AND type = 0 AND subject = 'p10 alias mail'`
		).bind(userIdA).first();
		expect(inbox.n).toBe(1);
		const after = await api('/my/alias', { token: tokenA });
		const row = after.json.data.find(a => a.aliasId === item.aliasId);
		expect(row.recvCount).toBe(1);
	});

	it('停用别名后拒收：往停用别名发信不再进主收件箱', async () => {
		const item = await makeAlias(tokenA);
		const off = await api(`/my/alias/${item.aliasId}/disable`, { method: 'POST', token: tokenA });
		expect(off.json.code).toBe(200);
		expect(off.json.data.status).toBe(1);
		// 服务层直接判定：停用别名 resolve 仍返回行、但 status=1（调用方据此拒收，而非当成“查无此人”）
		const resolved = await aliasService.resolveAlias(fakeCtx(), item.address);
		expect(resolved?.alias?.status).toBe(1);
		const send = await api('/email/send', {
			method: 'POST', token: tokenB,
			body: {
				accountId: accountIdB,
				receiveEmail: [item.address],
				subject: 'p10 alias blocked', text: 'blocked', content: '<p>blocked</p>'
			}
		});
		expect(send.json.code).toBe(200); // 发信方不报错，站内静默拒收
		const inbox = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM email WHERE user_id = ? AND type = 0 AND subject = 'p10 alias blocked'`
		).bind(userIdA).first();
		expect(inbox.n).toBe(0);
		// 重新启用
		const on = await api(`/my/alias/${item.aliasId}/enable`, { method: 'POST', token: tokenA });
		expect(on.json.code).toBe(200);
		expect(on.json.data.status).toBe(0);
	});

	it('跨用户操作别人的别名 → 404；删除后列表里没有', async () => {
		const item = await makeAlias(tokenA);
		const cross = await api(`/my/alias/${item.aliasId}/disable`, { method: 'POST', token: tokenB });
		expect(cross.json.code).toBe(404);
		const del = await api(`/my/alias/${item.aliasId}`, { method: 'DELETE', token: tokenA });
		expect(del.json.code).toBe(200);
		const list = await api('/my/alias', { token: tokenA });
		expect(list.json.data.some(a => a.aliasId === item.aliasId)).toBe(false);
	});

	it('每用户最多 10 个启用中别名，第 11 个被拒', async () => {
		for (let i = 0; i < 10; i++) {
			const r = await api('/my/alias', { method: 'POST', token: tokenB });
			expect(r.json.code).toBe(200);
		}
		const over = await api('/my/alias', { method: 'POST', token: tokenB });
		expect(over.json.code).toBe(400);
		expect(over.json.message).toContain('上限');
	});
});

describe('金丝雀 GET /my/canary', () => {
	it('默认返回 2026-11-09；改 setting 后返回新日期', async () => {
		const first = await api('/my/canary', { token: tokenA });
		expect(first.json.code).toBe(200);
		expect(first.json.data.canaryDate).toBe('2026-11-09');
		await setSetting({ canaryDate: '2026-11-10' });
		const second = await api('/my/canary', { token: tokenA });
		expect(second.json.data.canaryDate).toBe('2026-11-10');
	});
});
