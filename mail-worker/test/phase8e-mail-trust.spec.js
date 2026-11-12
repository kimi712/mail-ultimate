// Phase 8 子代理 E 测试：邮件信任与控制（§12 项 1–4）。
// vitest + @cloudflare/vitest-pool-workers。service 层测试；HTTP 层新端点
// （/mail-trust/*）待总协调把 mail-trust-api 注册进 webs.js 后再补冒烟。
// 新表 trusted_sender / mail_prefs / spam_feedback / pending_send /
// scheduled_email 与 email 新列在 beforeAll 里按汇报 DDL 自建/自加
// （v3_11DB 迁移由总协调并进 init.js；ALTER 逐条 try/catch，合并后重跑也不炸）。
// 运行：mail-worker 下 npx vitest run test/phase8e-mail-trust.spec.js。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import emailService from '../src/service/email-service';
import { registerNew, loginNew } from './auth-helpers.js';
import mailTrustService, {
	sanitizeRemoteImages, parseAuthResults, parseListUnsubscribe
} from '../src/service/mail-trust-service';

const TEST_JWT_SECRET = 'phase1-local-test-only-not-a-real-secret';
let ipCounter = 600;

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

async function setSetting(fields) {
	const map = { registerVerify: 'register_verify' };
	const assignments = [];
	const binds = [];
	for (const [key, value] of Object.entries(fields)) {
		const column = map[key];
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

function serviceCtx() {
	return {
		env: { db: env.db, kv: env.kv, domain: env.domain, AI: undefined },
		req: { header: () => null },
		get: () => undefined,
		set: () => {}
	};
}

async function createTrustTables() {
	const ddls = [
		`CREATE TABLE IF NOT EXISTS trusted_sender (
			user_id INTEGER NOT NULL,
			sender_email TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (user_id, sender_email)
		)`,
		`CREATE TABLE IF NOT EXISTS mail_prefs (
			user_id INTEGER PRIMARY KEY,
			undo_seconds INTEGER NOT NULL DEFAULT 10,
			remote_images INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS spam_feedback (
			feedback_id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL,
			email_id INTEGER NOT NULL,
			sender_email TEXT NOT NULL DEFAULT '',
			subject TEXT NOT NULL DEFAULT '',
			kind TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE (user_id, email_id, kind)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_spam_feedback_sender ON spam_feedback(sender_email)`,
		`CREATE TABLE IF NOT EXISTS pending_send (
			pending_id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL,
			payload TEXT NOT NULL DEFAULT '',
			undo_until TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			result TEXT NOT NULL DEFAULT '',
			error TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_pending_send_due ON pending_send(status, undo_until)`,
		`CREATE TABLE IF NOT EXISTS scheduled_email (
			scheduled_id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL,
			account_id INTEGER NOT NULL,
			payload TEXT NOT NULL DEFAULT '',
			scheduled_at TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			attempts INTEGER NOT NULL DEFAULT 0,
			result TEXT NOT NULL DEFAULT '',
			error TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			sent_at TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_scheduled_email_due ON scheduled_email(status, scheduled_at)`,
		`ALTER TABLE email ADD COLUMN auth_spf TEXT NOT NULL DEFAULT '';`,
		`ALTER TABLE email ADD COLUMN auth_dkim TEXT NOT NULL DEFAULT '';`,
		`ALTER TABLE email ADD COLUMN auth_dmarc TEXT NOT NULL DEFAULT '';`,
		`ALTER TABLE email ADD COLUMN unsubscribe_url TEXT NOT NULL DEFAULT '';`,
		`ALTER TABLE email ADD COLUMN unsubscribe_mailto TEXT NOT NULL DEFAULT '';`,
		`ALTER TABLE email ADD COLUMN unsubscribe_one_click INTEGER NOT NULL DEFAULT 0;`,
		`ALTER TABLE email ADD COLUMN is_spam INTEGER NOT NULL DEFAULT 0;`
	];
	for (const ddl of ddls) {
		try {
			await env.db.prepare(ddl).run();
		} catch (e) {
			// 列已存在（v3_11DB 已合并）时跳过，与 init.js 迁移风格一致。
		}
	}
}

async function insertEmail(userId, accountId, {
	sendEmail = 'news@promo.example.org', subject = '测试邮件',
	content = '<p>hello</p>', text = 'hello', type = 0,
	authSpf = '', authDkim = '', authDmarc = '',
	unsubscribeUrl = '', unsubscribeMailto = '', unsubscribeOneClick = 0, isSpam = 0
} = {}) {
	const row = await env.db.prepare(
		`INSERT INTO email (account_id, user_id, send_email, name, subject, text, content, type, is_del,
			auth_spf, auth_dkim, auth_dmarc, unsubscribe_url, unsubscribe_mailto, unsubscribe_one_click, is_spam)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`
	).bind(accountId, userId, sendEmail, sendEmail.split('@')[0], subject, text, content, type,
		authSpf, authDkim, authDmarc, unsubscribeUrl, unsubscribeMailto, unsubscribeOneClick, isSpam).run();
	return row.meta.last_row_id;
}

async function emailRow(emailId) {
	return env.db.prepare(`SELECT * FROM email WHERE email_id = ?`).bind(emailId).first();
}

async function countReceived(userId, subject) {
	const row = await env.db.prepare(
		`SELECT COUNT(*) AS n FROM email WHERE user_id = ? AND type = 0 AND subject = ? AND is_del = 0`
	).bind(userId, subject).first();
	return row.n;
}

function sendParams(aliceAccountId, bobEmail, subject) {
	return {
		accountId: aliceAccountId,
		name: 'Alice',
		sendType: 'normal',
		receiveEmail: [bobEmail],
		subject,
		text: 'hi bob',
		content: '<p>hi bob</p>',
		attachments: []
	};
}

let initText = '';
let alice;
let bob;
let aliceAccountId;
let bobAccountId;
beforeAll(async () => {
	const res = await SELF.fetch('http://example.com/api/init', { headers: { Authorization: `Bearer ${TEST_JWT_SECRET}` } });
	initText = await res.text();
	await setSetting({ registerVerify: 1 });
	await createTrustTables();
	alice = await makeUser('p8e-alice@example.com');
	bob = await makeUser('p8e-bob@example.com');
	aliceAccountId = await accountIdOf('p8e-alice@example.com');
	bobAccountId = await accountIdOf('p8e-bob@example.com');
}, 30000);

describe('建表与初始化', () => {
	it('init 成功', () => {
		expect(initText).toBe('success');
	});

	it('新表与 email 新列已建', async () => {
		const tables = await env.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
		const names = tables.results.map((r) => r.name);
		for (const t of ['trusted_sender', 'mail_prefs', 'spam_feedback', 'pending_send', 'scheduled_email']) {
			expect(names).toContain(t);
		}
		const cols = await env.db.prepare(`PRAGMA table_info(email)`).all();
		const colNames = cols.results.map((r) => r.name);
		for (const col of ['auth_spf', 'auth_dkim', 'auth_dmarc', 'unsubscribe_url', 'unsubscribe_mailto', 'unsubscribe_one_click', 'is_spam']) {
			expect(colNames).toContain(col);
		}
	});
});

describe('1. 追踪像素 / 远程图片拦截（纯函数）', () => {
	const html = '<p>hi</p>'
		+ '<img src="https://tracker.example.org/pixel.gif" width="1" height="1">'
		+ '<img src="https://cdn.example.org/banner.jpg" width="600" height="200">'
		+ '<img src="data:image/png;base64,AAA">'
		+ '<img src="cid:abc123">'
		+ '<img src="{{domain}}/att/1.png">'
		+ '<div style="background-image:url(https://tracker.example.org/bg.jpg)">x</div>';

	it('默认拦截：远程图与背景图被换成占位，追踪像素计 1，本地图不动', () => {
		const out = sanitizeRemoteImages(html);
		expect(out.blocked).toBe(3);
		expect(out.tracking).toBe(1);
		expect(out.remote).toBe(3);
		expect(out.hasRemote).toBe(true);
		// src 已换成占位（不再加载）；原地址只留在 data-mail-remote-src
		// 里，供前端“加载图片”恢复——拦截 ≠ 删地址。
		// 注意：data-mail-remote-src="URL" 里含 src="URL" 子串，断言须带前导空格。
		expect(out.html).not.toContain(' src="https://tracker.example.org/pixel.gif"');
		expect(out.html).not.toContain(' src="https://cdn.example.org/banner.jpg"');
		expect(out.html).toContain('data-mail-remote-src="https://tracker.example.org/pixel.gif"');
		expect(out.html).toContain('data-mail-tracking="1"');
		expect(out.html).toContain('data:image/png;base64,AAA');
		expect(out.html).toContain('cid:abc123');
		expect(out.html).toContain('{{domain}}/att/1.png');
	});

	it('allowRemote=true：只计数不拦截，原文原样返回', () => {
		const out = sanitizeRemoteImages(html, { allowRemote: true });
		expect(out.blocked).toBe(0);
		expect(out.tracking).toBe(1);
		expect(out.remote).toBe(3);
		expect(out.html).toContain('https://tracker.example.org/pixel.gif');
	});

	it('无远程图：blocked=0，原文不动', () => {
		const out = sanitizeRemoteImages('<p>plain</p><img src="/oss/a.png">');
		expect(out.blocked).toBe(0);
		expect(out.hasRemote).toBe(false);
	});

	it('空内容不报错', () => {
		expect(sanitizeRemoteImages('')).toEqual({ html: '', blocked: 0, tracking: 0, remote: 0, hasRemote: false });
		expect(sanitizeRemoteImages(null)).toEqual({ html: '', blocked: 0, tracking: 0, remote: 0, hasRemote: false });
	});
});

describe('2. 发件人验证标识（纯函数 + 收信入库）', () => {
	it('三项全 pass → status=pass', () => {
		const auth = parseAuthResults([
			{ key: 'authentication-results', line: 'Authentication-Results: mx.example.com; spf=pass smtp.mailfrom=bank.com; dkim=pass header.i=@bank.com; dmarc=pass header.from=bank.com' }
		]);
		expect(auth).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass', status: 'pass' });
	});

	it('spf=fail → status=fail（dkim 通过也不掩盖）', () => {
		const auth = parseAuthResults([
			{ key: 'authentication-results', line: 'Authentication-Results: mx.example.com; spf=fail smtp.mailfrom=evil.com; dkim=pass header.i=@evil.com; dmarc=fail' }
		]);
		expect(auth.status).toBe('fail');
		expect(auth.spf).toBe('fail');
		expect(auth.dmarc).toBe('fail');
	});

	it('没有认证头 → 全 none、status=unverified（绝不编造通过）', () => {
		expect(parseAuthResults([])).toEqual({ spf: 'none', dkim: 'none', dmarc: 'none', status: 'unverified' });
		expect(parseAuthResults(null)).toEqual({ spf: 'none', dkim: 'none', dmarc: 'none', status: 'unverified' });
	});

	it('只有 DKIM-Signature、无 dkim= 结论 → 仍是 none，不推断通过', () => {
		const auth = parseAuthResults([
			{ key: 'dkim-signature', line: 'DKIM-Signature: v=1; a=rsa-sha256; d=bank.com; s=sel;' }
		]);
		expect(auth.dkim).toBe('none');
		expect(auth.status).toBe('unverified');
	});

	it('Received-SPF 可补 spf；softfail 算 fail', () => {
		const auth = parseAuthResults([
			{ key: 'received-spf', line: 'Received-SPF: softfail (mx: 1.2.3.4 is not permitted)' }
		]);
		expect(auth.spf).toBe('fail');
		expect(auth.status).toBe('fail');
	});

	it('receive() 带 headers 入库：auth 与退订列都写进去了', async () => {
		const headers = [
			{ key: 'authentication-results', line: 'Authentication-Results: mx.example.com; spf=pass smtp.mailfrom=bank.com; dkim=pass header.i=@bank.com; dmarc=pass' },
			{ key: 'list-unsubscribe', line: 'List-Unsubscribe: <https://bank.com/unsub>, <mailto:leave@bank.com>' },
			{ key: 'list-unsubscribe-post', line: 'List-Unsubscribe-Post: List-Unsubscribe=One-Click' }
		];
		const row = await emailService.receive({ env }, {
			toEmail: 'p8e-alice@example.com',
			toName: 'alice',
			sendEmail: 'news@bank.com',
			name: 'bank',
			senderEmail: 'news@bank.com',
			subject: '对账单',
			content: '<p>statement</p>',
			text: 'statement',
			recipient: '[]',
			accountId: aliceAccountId,
			userId: alice.userId,
			isDel: 0,
			status: 0,
			headers
		}, [], 'https://cdn.example.com');
		const saved = await emailRow(row.emailId);
		expect(saved.auth_spf).toBe('pass');
		expect(saved.auth_dkim).toBe('pass');
		expect(saved.auth_dmarc).toBe('pass');
		expect(saved.unsubscribe_url).toBe('https://bank.com/unsub');
		expect(saved.unsubscribe_mailto).toBe('leave@bank.com');
		expect(saved.unsubscribe_one_click).toBe(1);
	});

	it('parseListUnsubscribe：url/mailto/oneClick 各取其值；无头返回 null', () => {
		expect(parseListUnsubscribe([])).toBeNull();
		const out = parseListUnsubscribe([
			{ name: 'List-Unsubscribe', value: '<https://x.example.org/u>, <mailto:off@x.example.org>' },
			{ name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' }
		]);
		expect(out).toEqual({ url: 'https://x.example.org/u', mailto: 'off@x.example.org', oneClick: true });
		const noClick = parseListUnsubscribe([
			{ name: 'List-Unsubscribe', value: '<https://x.example.org/u>' }
		]);
		expect(noClick).toEqual({ url: 'https://x.example.org/u', mailto: null, oneClick: false });
	});
});

describe('1+2. 列表服务端清洗与信任发件人', () => {
	it('列表默认拦截远程图：content 被清洗，remoteImages.blocked=1，auth 挂上', async () => {
		const emailId = await insertEmail(alice.userId, aliceAccountId, {
			sendEmail: 'news@promo.example.org',
			subject: '清洗测试',
			content: '<p>hi</p><img src="https://tracker.example.org/p.gif" width="1" height="1">',
			authSpf: 'pass', authDkim: 'pass', authDmarc: 'pass'
		});
		const { list } = await emailService.list(serviceCtx(), { accountId: aliceAccountId, type: 0, size: 50, full: 1 }, alice.userId);
		const item = list.find(e => e.emailId === emailId);
		expect(item).toBeDefined();
		expect(item.content).not.toContain(' src="https://tracker.example.org/p.gif"');
		expect(item.content).toContain('data-mail-remote-src');
		expect(item.remoteImages).toMatchObject({ blocked: 1, tracking: 1, hasRemote: true });
		expect(item.auth).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass', status: 'pass' });
		expect(item.trustedSender).toBe(false);
	});

	it('信任发件人后：同一封信不再拦截（blocked=0，原文保留）', async () => {
		// 注意：vitest-pool-workers 默认 isolatedStorage=true，测试间写入
		// 会回滚——本用例自建数据，不依赖上一条测试插的信。
		const emailId = await insertEmail(alice.userId, aliceAccountId, {
			sendEmail: 'news@promo.example.org',
			subject: '清洗测试',
			content: '<p>hi</p><img src="https://tracker.example.org/p.gif" width="1" height="1">',
			authSpf: 'pass', authDkim: 'pass', authDmarc: 'pass'
		});
		await mailTrustService.trustSender(serviceCtx(), alice.userId, 'NEWS@promo.example.org');
		expect(await mailTrustService.isTrustedSender(serviceCtx(), alice.userId, 'news@promo.example.org')).toBe(true);
		const { list } = await emailService.list(serviceCtx(), { accountId: aliceAccountId, type: 0, size: 50, full: 1 }, alice.userId);
		const item = list.find(e => e.emailId === emailId);
		expect(item).toBeDefined();
		expect(item.content).toContain('https://tracker.example.org/p.gif');
		expect(item.remoteImages.blocked).toBe(0);
		expect(item.trustedSender).toBe(true);
		const trust = await mailTrustService.getReadTrust(serviceCtx(), alice.userId, item.emailId);
		expect(trust.allowRemote).toBe(true);
		expect(trust.remoteImages.blocked).toBe(0);
		await mailTrustService.untrustSender(serviceCtx(), alice.userId, 'news@promo.example.org');
		expect(await mailTrustService.isTrustedSender(serviceCtx(), alice.userId, 'news@promo.example.org')).toBe(false);
	});

	it('无认证头的信：getReadTrust 返回 unverified', async () => {
		const emailId = await insertEmail(alice.userId, aliceAccountId, { subject: '无认证头', content: '<p>x</p>' });
		const trust = await mailTrustService.getReadTrust(serviceCtx(), alice.userId, emailId);
		expect(trust.auth).toEqual({ spf: 'none', dkim: 'none', dmarc: 'none', status: 'unverified' });
		expect(trust.unsubscribe).toBeNull();
		expect(trust.trusted).toBe(false);
	});

	it('trustSender 拒绝非法地址；别人的信读不到 trust 数据', async () => {
		let code = '';
		try {
			await mailTrustService.trustSender(serviceCtx(), alice.userId, 'not-an-email');
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('trust_invalid_sender');
		const bobMail = await insertEmail(bob.userId, bobAccountId, { subject: 'bob 的信' });
		try {
			await mailTrustService.getReadTrust(serviceCtx(), alice.userId, bobMail);
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('trust_email_not_found');
	});
});

describe('偏好（撤回延迟）', () => {
	it('默认 2 秒；可改 3/5/10/30；非法值报错', async () => {
		// 默认撤回延迟 2 秒（2026-11-09 用户改，取代旧默认 3 秒）；偏好新增 forwardEmail 字段。
		expect(await mailTrustService.getPrefs(serviceCtx(), alice.userId)).toEqual({ undoSeconds: 2, remoteImages: 0, forwardEmail: '' });
		expect(await mailTrustService.setPrefs(serviceCtx(), alice.userId, { undoSeconds: 30 })).toEqual({ undoSeconds: 30, remoteImages: 0, forwardEmail: '' });
		expect(await mailTrustService.getPrefs(serviceCtx(), alice.userId)).toEqual({ undoSeconds: 30, remoteImages: 0, forwardEmail: '' });
		let code = '';
		try {
			await mailTrustService.setPrefs(serviceCtx(), alice.userId, { undoSeconds: 7 });
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('trust_invalid_undo_delay');
		await mailTrustService.setPrefs(serviceCtx(), alice.userId, { undoSeconds: 10 });
	});
});

describe('3. 撤回（延迟发送）', () => {
	it('undoSeconds=10：只建 pending，不发信、不计发件记录', async () => {
		const before = await countReceived(bob.userId, '撤回测试A');
		const res = await emailService.send(serviceCtx(), { ...sendParams(aliceAccountId, 'p8e-bob@example.com', '撤回测试A'), undoSeconds: 10 }, alice.userId);
		expect(res.pending).toBe(true);
		expect(res.undoSeconds).toBe(10);
		expect(res.pendingId).toBeGreaterThan(0);
		expect(await countReceived(bob.userId, '撤回测试A')).toBe(before);
		const row = await env.db.prepare(`SELECT status FROM pending_send WHERE pending_id = ?`).bind(res.pendingId).first();
		expect(row.status).toBe('pending');
	});

	it('窗口内确认 → trust_undo_not_expired，信仍没发', async () => {
		const res = await emailService.send(serviceCtx(), { ...sendParams(aliceAccountId, 'p8e-bob@example.com', '撤回测试B'), undoSeconds: 10 }, alice.userId);
		let code = '';
		try {
			await emailService.confirmPendingSend(serviceCtx(), res.pendingId, { userId: alice.userId });
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('trust_undo_not_expired');
		expect(await countReceived(bob.userId, '撤回测试B')).toBe(0);
		// 清理：取消掉，避免影响后续扫表
		const cancelled = await emailService.cancelPendingSend(serviceCtx(), alice.userId, res.pendingId);
		expect(cancelled.cancelled).toBe(true);
		expect(cancelled.draft.subject).toBe('撤回测试B');
	});

	it('窗口内取消：信回草稿（draft 原样返回），再确认报已取消', async () => {
		const res = await emailService.send(serviceCtx(), { ...sendParams(aliceAccountId, 'p8e-bob@example.com', '撤回测试C'), undoSeconds: 5 }, alice.userId);
		const cancelled = await emailService.cancelPendingSend(serviceCtx(), alice.userId, res.pendingId);
		expect(cancelled.cancelled).toBe(true);
		expect(cancelled.draft.subject).toBe('撤回测试C');
		expect(cancelled.draft.receiveEmail).toEqual(['p8e-bob@example.com']);
		expect(await countReceived(bob.userId, '撤回测试C')).toBe(0);
		let code = '';
		try {
			await emailService.confirmPendingSend(serviceCtx(), res.pendingId, { userId: alice.userId, now: new Date(Date.now() + 60000) });
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('trust_pending_cancelled');
		// 别人的 pending 取消不到
		const res2 = await emailService.send(serviceCtx(), { ...sendParams(aliceAccountId, 'p8e-bob@example.com', '撤回测试C2'), undoSeconds: 5 }, alice.userId);
		try {
			await emailService.cancelPendingSend(serviceCtx(), bob.userId, res2.pendingId);
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('trust_pending_not_found');
		await emailService.cancelPendingSend(serviceCtx(), alice.userId, res2.pendingId);
	});

	it('窗口结束后确认：真正发出，bob 收到，pending 置 sent', async () => {
		const res = await emailService.send(serviceCtx(), { ...sendParams(aliceAccountId, 'p8e-bob@example.com', '撤回测试D'), undoSeconds: 5 }, alice.userId);
		const out = await emailService.confirmPendingSend(serviceCtx(), res.pendingId, { userId: alice.userId, now: new Date(Date.now() + 6000) });
		expect(out.sent).toBe(true);
		expect(out.emails.length).toBeGreaterThan(0);
		expect(await countReceived(bob.userId, '撤回测试D')).toBe(1);
		const row = await env.db.prepare(`SELECT status FROM pending_send WHERE pending_id = ?`).bind(res.pendingId).first();
		expect(row.status).toBe('sent');
	});

	it('processDuePending 兜底：过窗口的 pending 被扫表发出', async () => {
		const res = await emailService.send(serviceCtx(), { ...sendParams(aliceAccountId, 'p8e-bob@example.com', '撤回测试E'), undoSeconds: 5 }, alice.userId);
		const swept = await emailService.processDuePending(serviceCtx(), { now: new Date(Date.now() + 6000) });
		expect(swept.sent).toBeGreaterThanOrEqual(1);
		expect(await countReceived(bob.userId, '撤回测试E')).toBe(1);
		// 未过窗口的不扫
		const res2 = await emailService.send(serviceCtx(), { ...sendParams(aliceAccountId, 'p8e-bob@example.com', '撤回测试F'), undoSeconds: 30 }, alice.userId);
		const swept2 = await emailService.processDuePending(serviceCtx(), { now: new Date(Date.now() + 1000) });
		expect(await countReceived(bob.userId, '撤回测试F')).toBe(0);
		await emailService.cancelPendingSend(serviceCtx(), alice.userId, res2.pendingId);
		expect(swept2.processed).toBe(0);
	});

	it('非法 undoSeconds=7 报错；undoSeconds=0 立即发出', async () => {
		let code = '';
		try {
			await emailService.send(serviceCtx(), { ...sendParams(aliceAccountId, 'p8e-bob@example.com', '撤回测试G'), undoSeconds: 7 }, alice.userId);
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('trust_invalid_undo_delay');
		const out = await emailService.send(serviceCtx(), { ...sendParams(aliceAccountId, 'p8e-bob@example.com', '撤回测试H'), undoSeconds: 0 }, alice.userId);
		expect(Array.isArray(out)).toBe(true);
		expect(await countReceived(bob.userId, '撤回测试H')).toBe(1);
	});

	it('_pendingNowIso 幂等：自身产出的字符串原样返回，不再走 new Date() 重解析（非 UTC 运行时重解析会平移窗口）', () => {
		const iso = emailService._pendingNowIso(new Date('2026-11-08T11:44:45.000Z'));
		expect(iso).toBe('2026-11-08 11:44:45');
		expect(emailService._pendingNowIso(iso)).toBe(iso);
		expect(emailService._pendingNowIso(new Date('2026-11-08T11:44:45.000Z'))).toBe(iso);
	});
});

describe('3. 定时发送', () => {
	it('未来时间只入库不发；到点扫表发出；可取消', async () => {
		const at = new Date(Date.now() + 60 * 1000).toISOString();
		const res = await emailService.send(serviceCtx(), { ...sendParams(aliceAccountId, 'p8e-bob@example.com', '定时测试A'), scheduledAt: at }, alice.userId);
		expect(res.scheduled).toBe(true);
		expect(res.scheduledId).toBeGreaterThan(0);
		expect(await countReceived(bob.userId, '定时测试A')).toBe(0);
		// 未到点不发
		const early = await emailService.processDueScheduled(serviceCtx(), { now: new Date() });
		expect(await countReceived(bob.userId, '定时测试A')).toBe(0);
		// 到点发出
		const due = await emailService.processDueScheduled(serviceCtx(), { now: new Date(Date.now() + 61 * 1000) });
		expect(due.sent).toBeGreaterThanOrEqual(1);
		expect(await countReceived(bob.userId, '定时测试A')).toBe(1);
		expect(early.processed).toBe(0);
	});

	it('定时信在列表里可见、可取消；取消后到点也不发', async () => {
		const at = new Date(Date.now() + 60 * 1000).toISOString();
		const res = await emailService.send(serviceCtx(), { ...sendParams(aliceAccountId, 'p8e-bob@example.com', '定时测试B'), scheduledAt: at }, alice.userId);
		const list = await emailService.listScheduled(serviceCtx(), alice.userId);
		const item = list.find(e => e.scheduledId === res.scheduledId);
		expect(item).toBeDefined();
		expect(item.subject).toBe('定时测试B');
		expect(item.status).toBe('pending');
		const cancelled = await emailService.cancelScheduled(serviceCtx(), alice.userId, res.scheduledId);
		expect(cancelled.cancelled).toBe(true);
		const due = await emailService.processDueScheduled(serviceCtx(), { now: new Date(Date.now() + 61 * 1000) });
		expect(await countReceived(bob.userId, '定时测试B')).toBe(0);
		expect(due.processed).toBe(0);
		// 已取消的不能再取消
		let code = '';
		try {
			await emailService.cancelScheduled(serviceCtx(), alice.userId, res.scheduledId);
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('trust_schedule_not_pending');
	});

	it('过去时间 / 超 30 天 / 无效时间都报错', async () => {
		for (const bad of [
			new Date(Date.now() - 1000).toISOString(),
			new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
			'not-a-date'
		]) {
			let code = '';
			try {
				await emailService.send(serviceCtx(), { ...sendParams(aliceAccountId, 'p8e-bob@example.com', '定时测试C'), scheduledAt: bad }, alice.userId);
			} catch (e) {
				code = e.code;
			}
			expect(code).toBe('trust_invalid_schedule_time');
		}
	});
});

describe('4. 垃圾邮件 / 钓鱼举报 / 一键退订', () => {
	it('标记垃圾邮件：进 Spam（收件箱默认不列，spam=1 列出），并记反馈', async () => {
		const emailId = await insertEmail(alice.userId, aliceAccountId, { subject: '垃圾测试A' });
		const out = await mailTrustService.markSpam(serviceCtx(), alice.userId, emailId);
		expect(out).toEqual({ emailId, isSpam: 1 });
		expect((await emailRow(emailId)).is_spam).toBe(1);
		const fb = await env.db.prepare(`SELECT kind FROM spam_feedback WHERE user_id = ? AND email_id = ?`).bind(alice.userId, emailId).first();
		expect(fb.kind).toBe('spam');
		const inbox = await emailService.list(serviceCtx(), { accountId: aliceAccountId, type: 0, size: 50, full: 0 }, alice.userId);
		expect(inbox.list.find(e => e.emailId === emailId)).toBeUndefined();
		const spamBox = await emailService.list(serviceCtx(), { accountId: aliceAccountId, type: 0, size: 50, full: 0, spam: 1 }, alice.userId);
		expect(spamBox.list.find(e => e.emailId === emailId)).toBeDefined();
		// 不是垃圾邮件：回收件箱
		await mailTrustService.unmarkSpam(serviceCtx(), alice.userId, emailId);
		expect((await emailRow(emailId)).is_spam).toBe(0);
		const inbox2 = await emailService.list(serviceCtx(), { accountId: aliceAccountId, type: 0, size: 50, full: 0 }, alice.userId);
		expect(inbox2.list.find(e => e.emailId === emailId)).toBeDefined();
	});

	it('标记别人的信 / 发件箱的信报错', async () => {
		const bobMail = await insertEmail(bob.userId, bobAccountId, { subject: 'bob 的垃圾测试' });
		let code = '';
		try {
			await mailTrustService.markSpam(serviceCtx(), alice.userId, bobMail);
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('trust_email_not_found');
		const sentMail = await insertEmail(alice.userId, aliceAccountId, { subject: '发件箱', type: 1 });
		try {
			await mailTrustService.markSpam(serviceCtx(), alice.userId, sentMail);
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('trust_not_received');
	});

	it('举报钓鱼：进 Spam + phishing 反馈 + 审计记录', async () => {
		const emailId = await insertEmail(alice.userId, aliceAccountId, {
			sendEmail: 'support@fake-bank.example', subject: '您的账户异常'
		});
		const out = await mailTrustService.reportPhishing(serviceCtx(), alice.userId, emailId);
		expect(out).toEqual({ emailId, reported: true, isSpam: 1 });
		expect((await emailRow(emailId)).is_spam).toBe(1);
		const fb = await env.db.prepare(`SELECT kind FROM spam_feedback WHERE user_id = ? AND email_id = ? AND kind = 'phishing'`).bind(alice.userId, emailId).first();
		expect(fb.kind).toBe('phishing');
		const audit = await env.db.prepare(`SELECT action FROM audit_log WHERE action = 'report_phishing' AND target_id = ?`).bind(String(emailId)).first();
		expect(audit.action).toBe('report_phishing');
		expect(await mailTrustService.spamFeedbackCount(serviceCtx(), 'support@fake-bank.example')).toBe(1);
	});

	it('一键退订：oneClick 走后端 POST；无 oneClick 返回 open（不发请求）；只有 mailto 返回 mailto', async () => {
		const calls = [];
		const fakeFetch = async (url, opts) => {
			calls.push({ url, opts });
			return { ok: true };
		};
		const emailId = await insertEmail(alice.userId, aliceAccountId, {
			subject: '退订测试A', unsubscribeUrl: 'https://promo.example.org/unsub', unsubscribeOneClick: 1
		});
		const posted = await mailTrustService.unsubscribe(serviceCtx(), alice.userId, emailId, fakeFetch);
		expect(posted).toEqual({ emailId, action: 'posted', url: 'https://promo.example.org/unsub' });
		expect(calls.length).toBe(1);
		expect(calls[0].opts.method).toBe('POST');
		expect(calls[0].opts.headers['List-Unsubscribe']).toBe('One-Click');

		const emailId2 = await insertEmail(alice.userId, aliceAccountId, {
			subject: '退订测试B', unsubscribeUrl: 'https://promo.example.org/unsub2', unsubscribeOneClick: 0
		});
		const opened = await mailTrustService.unsubscribe(serviceCtx(), alice.userId, emailId2, fakeFetch);
		expect(opened.action).toBe('open');
		expect(calls.length).toBe(1); // 没再发请求

		const emailId3 = await insertEmail(alice.userId, aliceAccountId, {
			subject: '退订测试C', unsubscribeMailto: 'leave@promo.example.org'
		});
		const mailed = await mailTrustService.unsubscribe(serviceCtx(), alice.userId, emailId3, fakeFetch);
		expect(mailed).toEqual({ emailId: emailId3, action: 'mailto', mailto: 'leave@promo.example.org' });

		const emailId4 = await insertEmail(alice.userId, aliceAccountId, { subject: '退订测试D' });
		let code = '';
		try {
			await mailTrustService.unsubscribe(serviceCtx(), alice.userId, emailId4, fakeFetch);
		} catch (e) {
			code = e.code;
		}
		expect(code).toBe('trust_no_unsubscribe');
	});
});
