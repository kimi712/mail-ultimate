// $1000 安全悬赏挑战状态页测试：vitest + @cloudflare/vitest-pool-workers。
// 覆盖：
//   ① GET /challenge/status 公开可访问（无需登录）；信不存在时 exists=false、
//      其余字段为空，deadline 固定 2026-11-18T23:59:00+08:00；
//   ② 管理员最近一封 e2ee=1 邮件的存在证明（主题/时间/密文 SHA-256 指纹，
//      非 e2ee 邮件不算、取最新一封）；
//   ③ POST /challenge/submit 公开可访问，只存 SHA-256 哈希不存原文，
//      返回回执 id，统计计数 +1；
//   ④ 提交校验（空 phrase/method → 400）；同一 IP 每小时 10 次，
//      第 11 次 → 429。
// 注意：新路由 GET/POST /challenge/* 由本文件
// import '../src/api/challenge-api.js' 注册（webs.js 注册行已加；
// 注册后重复 import 无害，同一 handler）。
// 运行：mail-worker 下 npx vitest run test/challenge.spec.js。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { registerNew, loginNew } from './auth-helpers.js';
import '../src/api/challenge-api.js';

const TEST_JWT_SECRET = 'phase1-local-test-only-not-a-real-secret';
// wrangler.jsonc 的 admin（测试环境占位值）。
const ADMIN_EMAIL = 'admin@example.com';
const DEADLINE = '2026-11-18T23:59:00+08:00';
let ipCounter = 300;
let initText = '';
let adminUserId = 0;

function nextIp() {
	ipCounter += 1;
	return `203.0.113.${ipCounter}`;
}

async function sha256hex(s) {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
	return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 公开请求：不带 token，验证无需登录可访问。
async function api(path, { method = 'GET', body, ip } = {}) {
	const headers = { 'Content-Type': 'application/json' };
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
	return registerNew(api, email, { ip });
}

async function insertEmail({ userId, subject, content, e2ee, createTime }) {
	await env.db.prepare(
		`INSERT INTO email (send_email, account_id, user_id, subject, content, e2ee, type, create_time)
		 VALUES (?, 0, ?, ?, ?, ?, 0, ?)`
	).bind(ADMIN_EMAIL, userId, subject, content, e2ee, createTime).run();
}

async function status() {
	return api('/challenge/status', { ip: nextIp() });
}

async function attemptCount() {
	const row = await env.db.prepare(`SELECT COUNT(*) AS n FROM challenge_attempt`).first();
	return row.n;
}

const SETTING_COLUMN_MAP = {
	registerVerify: 'register_verify'
};

// 复用 phase7.spec.js 的 setSetting：D1 与 KV 缓存双写，
// registerVerify=1（CLOSE）= 注册不做人机验证。
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
	await setSetting({ registerVerify: 1 });
	// 注册即自动登录；这里只要 D1 里的管理员用户行（challenge 状态页
	// 只按 email 查 user_id，不用 token）。
	const reg = await register(ADMIN_EMAIL, nextIp());
	expect(reg.json.code).toBe(200);
	const row = await env.db.prepare('SELECT user_id FROM user WHERE email = ?').bind(ADMIN_EMAIL).first();
	adminUserId = row.user_id;
}, 30000);

describe('v3_17DB 迁移 + GET /challenge/status（公开）', () => {
	it('init 成功，challenge_attempt 表已建', async () => {
		expect(initText).toBe('success');
		const row = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'challenge_attempt'`
		).first();
		expect(row.n).toBe(1);
	});

	it('无需登录可访问；信不存在时 exists=false、其余字段为空', async () => {
		const res = await status();
		expect(res.json.code).toBe(200);
		const d = res.json.data;
		expect(d.exists).toBe(false);
		expect(d.subject).toBeNull();
		expect(d.sentAt).toBeNull();
		expect(d.ciphertextSha256).toBeNull();
		expect(d.deadline).toBe(DEADLINE);
		expect(d.prizeUsd).toBe(1000);
		expect(d.attempts.count).toBe(0);
		expect(d.attempts.lastSubmittedAt).toBeNull();
	});

	it('管理员最近一封 e2ee=1 邮件：主题/时间/密文指纹正确', async () => {
		const envelope = 'e2ee:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
		await insertEmail({
			userId: adminUserId,
			subject: 'Challenge: read me if you can',
			content: envelope,
			e2ee: 1,
			createTime: '2026-11-11 12:00:00'
		});
		const res = await status();
		const d = res.json.data;
		expect(d.exists).toBe(true);
		expect(d.subject).toBe('Challenge: read me if you can');
		expect(d.sentAt).toBe('2026-11-11 12:00:00');
		expect(d.ciphertextSha256).toBe(await sha256hex(envelope));
		// 指纹只是哈希，不含密文本身。
		expect(d.ciphertextSha256).not.toContain('e2ee:v1');
	});

	// 注意：vitest-pool-workers 在每个 it 之间把存储恢复到 beforeAll
	// 结束时的快照——上一个 it 插的邮件行到这里已不存在，所以本用例
	// 自包含：先插 e2ee 证明信，再插普通邮件、再插更新的 e2ee 信。
	it('非 e2ee 邮件不算证明；取最新一封 e2ee 邮件', async () => {
		const envelope = 'e2ee:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
		await insertEmail({
			userId: adminUserId,
			subject: 'Challenge: read me if you can',
			content: envelope,
			e2ee: 1,
			createTime: '2026-11-11 12:00:00'
		});
		let d = (await status()).json.data;
		expect(d.exists).toBe(true);
		expect(d.subject).toBe('Challenge: read me if you can');
		expect(d.ciphertextSha256).toBe(await sha256hex(envelope));

		// 更晚的普通邮件（e2ee=0）不应顶掉证明。
		await insertEmail({
			userId: adminUserId,
			subject: 'ordinary mail',
			content: 'hello',
			e2ee: 0,
			createTime: '2026-11-11 13:00:00'
		});
		d = (await status()).json.data;
		expect(d.exists).toBe(true);
		expect(d.subject).toBe('Challenge: read me if you can');

		// 再来一封更新的 e2ee 邮件，证明应指向最新一封。
		const envelope2 = 'pq:v1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==';
		await insertEmail({
			userId: adminUserId,
			subject: 'Challenge v2',
			content: envelope2,
			e2ee: 1,
			createTime: '2026-11-11 14:00:00'
		});
		d = (await status()).json.data;
		expect(d.subject).toBe('Challenge v2');
		expect(d.sentAt).toBe('2026-11-11 14:00:00');
		expect(d.ciphertextSha256).toBe(await sha256hex(envelope2));
	});
});

describe('POST /challenge/submit（公开、只存哈希、限流）', () => {
	it('无需登录可提交：返回回执 id，库里只存哈希不存原文', async () => {
		const phrase = 'test-phrase-never-store-me-12345';
		const method = 'test method: brute force the KEK, do not store this';
		const before = await attemptCount();
		const res = await api('/challenge/submit', {
			method: 'POST',
			ip: nextIp(),
			body: { phrase, method }
		});
		expect(res.json.code).toBe(200);
		expect(res.json.data.receiptId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
		);
		expect(res.json.data.count).toBe(before + 1);

		const row = await env.db.prepare(
			`SELECT phrase_hash AS phraseHash, method_hash AS methodHash, receipt_id AS receiptId
			 FROM challenge_attempt ORDER BY attempt_id DESC LIMIT 1`
		).first();
		expect(row.phraseHash).toBe(await sha256hex(phrase));
		expect(row.methodHash).toBe(await sha256hex(method));
		expect(row.receiptId).toBe(res.json.data.receiptId);
		// 整行序列化后不得出现原文（最小数据原则）。
		expect(JSON.stringify(row)).not.toContain(phrase);
		expect(JSON.stringify(row)).not.toContain(method);

		// status 的统计随之 +1。
		const d = (await status()).json.data;
		expect(d.attempts.count).toBe(before + 1);
		expect(d.attempts.lastSubmittedAt).not.toBeNull();
	});

	it('空 phrase / 空 method → 400，不入库', async () => {
		const before = await attemptCount();
		for (const body of [{ phrase: '', method: 'x' }, { phrase: 'x', method: '' }, { phrase: '  ', method: 'x' }, {}]) {
			const res = await api('/challenge/submit', { method: 'POST', ip: nextIp(), body });
			expect(res.json.code).toBe(400);
		}
		expect(await attemptCount()).toBe(before);
	});

	it('同一 IP 每小时 10 次：第 11 次 → 429，且不入库', async () => {
		const ip = nextIp();
		const before = await attemptCount();
		for (let i = 0; i < 10; i++) {
			const res = await api('/challenge/submit', {
				method: 'POST',
				ip,
				body: { phrase: `rate-limit-phrase-${i}`, method: `method-${i}` }
			});
			expect(res.json.code).toBe(200);
		}
		const blocked = await api('/challenge/submit', {
			method: 'POST',
			ip,
			body: { phrase: 'rate-limit-phrase-11', method: 'method-11' }
		});
		expect(blocked.json.code).toBe(429);
		expect(await attemptCount()).toBe(before + 10);
		// 换 IP 不受上一 IP 的窗口影响。
		const other = await api('/challenge/submit', {
			method: 'POST',
			ip: nextIp(),
			body: { phrase: 'other-ip-phrase', method: 'other-ip-method' }
		});
		expect(other.json.code).toBe(200);
	});
});
