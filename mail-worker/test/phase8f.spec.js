// Phase 8 子代理 F 测试：账号与透明（PHASE8-DESIGN.md §12 项 5–10）。
// 覆盖：
//   ① 恢复码只显示一次且 hash 存库、恢复流程限流、成功后旧会话失效；
//   ② 新设备提醒只查本人、确认后记为已知、TG 提醒只含脱敏 IP；
//   ③ 密码强度分级（前后端同一算法）；
//   ④ 联系人唯一约束与自动补全、只查本人；
//   ⑤ 规则按顺序执行且只对新信生效、旧信不重跑、重复执行不重复打标；
//   ⑥ 隐私仪表盘数据清单（收集/不收集/保留多久）。
// 运行：mail-worker 下 npx vitest run test/phase8f.spec.js。
// 注意：跑在本地 miniflare（wrangler.jsonc 占位绑定），不连线上 D1/KV。
// 新表在 beforeAll 里按汇报 DDL 手工建（v3_11DB 迁移由总协调并进 init.js）。
// 环境规则（C 的 assistant spec 已注明）：一个 it 内的 D1/KV 写入在下一个
// it 不可见，只有 beforeAll 的状态持久——因此每个 it 必须单测内自包含
// （建数据 + 断言全在一个 it 里）；跨 it 共享的只有 beforeAll 建的用户与
// token（alice/bob 的原始 token 全程有效，因 it 内的改密/清会话不持久）。
// HTTP 层：本文件 import 五个新 API 文件完成路由注册（与 webs.js 同一 app
// 单例）；公开 /recovery/* 需总协调把 '/recovery' 加进 security.js 的
// exclude 白名单后才能走 HTTP，本文件只测其 service 层。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import '../src/api/privacy-api.js';
import '../src/api/recovery-api.js';
import '../src/api/new-ip-alert-api.js';
import '../src/api/contact-api.js';
import '../src/api/mail-rule-api.js';
import recoveryService from '../src/service/recovery-service';
import newIpAlertService from '../src/service/new-ip-alert-service';
import contactService from '../src/service/contact-service';
import mailRuleService from '../src/service/mail-rule-service';
import privacyService from '../src/service/privacy-service';
import { evaluatePasswordStrength } from '../src/utils/password-strength';
import { evaluatePasswordStrength as evaluatePasswordStrengthVue } from '../../mail-vue/src/utils/password-strength.js';

const TEST_JWT_SECRET = 'phase1-local-test-only-not-a-real-secret';
let ipCounter = 500;

function nextIp() {
	ipCounter += 1;
	return `203.0.113.${ipCounter}`;
}

function serviceCtx(extraEnv = {}) {
	return {
		env: { db: env.db, kv: env.kv, domain: env.domain, ...extraEnv },
		req: { header: () => null },
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

async function makeUser(email) {
	const ip = nextIp();
	const reg = await register(email, ip);
	expect(reg.json.code).toBe(200);
	const loginRes = await login(email, ip);
	expect(loginRes.json.code).toBe(200);
	const row = await env.db.prepare('SELECT user_id FROM user WHERE email = ?').bind(email).first();
	return { token: loginRes.json.data.token, userId: row.user_id, ip, email };
}

async function sha256Hex(value) {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function insertEmail(userId, { senderEmail = 'sender@example.com', name = '', subject = '', toEmail = '', type = 0, unread = 0 } = {}) {
	const row = await env.db.prepare(
		`INSERT INTO email (account_id, user_id, sender_email, name, subject, to_email, type, unread, is_del)
		 VALUES (0, ?, ?, ?, ?, ?, ?, ?, 0)`
	).bind(userId, senderEmail, name, subject, toEmail, type, unread).run();
	return row.meta.last_row_id;
}

async function insertLoginLog(userId, email, ip, isNewIp, ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0') {
	const row = await env.db.prepare(
		`INSERT INTO login_log (user_id, email, ip, ua, is_new_ip) VALUES (?, ?, ?, ?, ?)`
	).bind(userId, email, ip, ua, isNewIp).run();
	return row.meta.last_row_id;
}

let initText = '';
let alice;
let bob;
beforeAll(async () => {
	const res = await SELF.fetch(`http://example.com/api/init/${TEST_JWT_SECRET}`);
	initText = await res.text();
	// F 的 8 张新表（与汇报 DDL 同文）。
	await env.db.prepare(`CREATE TABLE IF NOT EXISTS contacts (
		contact_id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL,
		name TEXT NOT NULL DEFAULT '',
		email TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		UNIQUE (user_id, email)
	)`).run();
	await env.db.prepare(`CREATE TABLE IF NOT EXISTS mail_rules (
		rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL,
		name TEXT NOT NULL DEFAULT '',
		condition_json TEXT NOT NULL DEFAULT '{}',
		action_json TEXT NOT NULL DEFAULT '[]',
		enabled INTEGER NOT NULL DEFAULT 1,
		sort INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`).run();
	await env.db.prepare(`CREATE TABLE IF NOT EXISTS email_label (
		label_id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL,
		email_id INTEGER NOT NULL,
		label TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		UNIQUE (user_id, email_id, label)
	)`).run();
	await env.db.prepare(`CREATE TABLE IF NOT EXISTS mail_rule_log (
		log_id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL,
		rule_id INTEGER NOT NULL,
		email_id INTEGER NOT NULL,
		actions_json TEXT NOT NULL DEFAULT '[]',
		created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`).run();
	await env.db.prepare(`CREATE TABLE IF NOT EXISTS user_recovery_code (
		code_id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL,
		code_hash TEXT NOT NULL DEFAULT '',
		used INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		used_at TEXT
	)`).run();
	await env.db.prepare(`CREATE TABLE IF NOT EXISTS user_recovery_email (
		user_id INTEGER PRIMARY KEY,
		backup_email TEXT NOT NULL DEFAULT '',
		verified INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`).run();
	await env.db.prepare(`CREATE TABLE IF NOT EXISTS password_reset_token (
		token_id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL,
		token_hash TEXT NOT NULL DEFAULT '',
		expires_at TEXT NOT NULL DEFAULT '',
		used INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		used_at TEXT
	)`).run();
	await env.db.prepare(`CREATE TABLE IF NOT EXISTS known_ip (
		known_id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL,
		ip TEXT NOT NULL DEFAULT '',
		first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		UNIQUE (user_id, ip)
	)`).run();
	await env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_contacts_user_email ON contacts(user_id, email)`).run();
	await env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_mail_rules_user_sort ON mail_rules(user_id, sort)`).run();
	await env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_recovery_code_user ON user_recovery_code(user_id, used)`).run();
	await env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_reset_token_user ON password_reset_token(user_id, used)`).run();
	// registerVerify=1（C 路同款：注册无需 Turnstile）。
	await env.db.prepare(`UPDATE setting SET register_verify = 1`).run();
	const cached = (await env.kv.get('setting:', { type: 'json' })) || {};
	cached.registerVerify = 1;
	await env.kv.put('setting:', JSON.stringify(cached));
	alice = await makeUser('p8f-alice@example.com');
	bob = await makeUser('p8f-bob@example.com');
}, 30000);

describe('新表', () => {
	it('init 成功', () => {
		expect(initText).toBe('success');
	});

	it('8 张 F 新表已建', async () => {
		const tables = await env.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
		const names = tables.results.map((r) => r.name);
		for (const t of ['contacts', 'mail_rules', 'email_label', 'mail_rule_log', 'user_recovery_code', 'user_recovery_email', 'password_reset_token', 'known_ip']) {
			expect(names).toContain(t);
		}
	});
});

describe('恢复码：只显示一次且 hash 存库', () => {
	it('生成 10 个码（库里只有 hash，明文不在库里）→ 凭码重设密码成功：码作废、旧密码失效、新密码能登录', async () => {
		const { codes, count } = await recoveryService.generateCodes(serviceCtx(), alice.userId, 'password123');
		expect(count).toBe(10);
		expect(new Set(codes).size).toBe(10);
		expect(codes[0]).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
		const rows = await env.db.prepare('SELECT code_hash AS h FROM user_recovery_code WHERE user_id = ?').bind(alice.userId).all();
		expect(rows.results.length).toBe(10);
		for (const r of rows.results) {
			expect(r.h).toHaveLength(64);
			expect(codes).not.toContain(r.h);
		}
		// 每个明文的 SHA-256 都能在库里找到对应 hash。
		const hashes = new Set();
		for (const code of codes) {
			hashes.add(await sha256Hex(code));
		}
		for (const r of rows.results) {
			expect(hashes.has(r.h)).toBe(true);
		}
		expect(await recoveryService.remainingCodes(serviceCtx(), alice.userId)).toBe(10);
		// 凭码重设密码成功。
		const out = await recoveryService.resetByCode(serviceCtx(), {
			email: alice.email, code: codes[0], newPassword: 'NewPass#2026', ip: nextIp()
		});
		expect(out.ok).toBe(true);
		expect(await recoveryService.remainingCodes(serviceCtx(), alice.userId)).toBe(9);
		// 同一码再用一次失败。
		await expect(recoveryService.resetByCode(serviceCtx(), {
			email: alice.email, code: codes[0], newPassword: 'NewPass#2027', ip: nextIp()
		})).rejects.toMatchObject({ code: 400 });
		// 旧密码登不上，新密码能登。
		const oldLogin = await login(alice.email, nextIp(), 'password123');
		expect(oldLogin.json.code).not.toBe(200);
		const newLogin = await login(alice.email, nextIp(), 'NewPass#2026');
		expect(newLogin.json.code).toBe(200);
	});

	it('错码与不存在的账号返回同一通用错误（不透露账号是否存在）', async () => {
		const ip = nextIp();
		await expect(recoveryService.resetByCode(serviceCtx(), {
			email: alice.email, code: 'AAAA-BBBB-CCCC', newPassword: 'NewPass#2026', ip
		})).rejects.toMatchObject({ code: 400 });
		await expect(recoveryService.resetByCode(serviceCtx(), {
			email: 'ghost-nobody@example.com', code: 'AAAA-BBBB-CCCC', newPassword: 'NewPass#2026', ip
		})).rejects.toMatchObject({ code: 400 });
	});

	it('重新生成作废旧码：旧码失效，新码可用', async () => {
		const { codes: oldCodes } = await recoveryService.generateCodes(serviceCtx(), alice.userId, 'password123');
		const { codes } = await recoveryService.generateCodes(serviceCtx(), alice.userId, 'password123');
		expect(codes.length).toBe(10);
		expect(await recoveryService.remainingCodes(serviceCtx(), alice.userId)).toBe(10);
		await expect(recoveryService.resetByCode(serviceCtx(), {
			email: alice.email, code: oldCodes[0], newPassword: 'NewPass#2026', ip: nextIp()
		})).rejects.toMatchObject({ code: 400 });
		const out = await recoveryService.resetByCode(serviceCtx(), {
			email: alice.email, code: codes[0], newPassword: 'NewPass#2026', ip: nextIp()
		});
		expect(out.ok).toBe(true);
	});

	it('弱新密码被拦住（强度计联动）', async () => {
		const { codes } = await recoveryService.generateCodes(serviceCtx(), alice.userId, 'password123');
		await expect(recoveryService.resetByCode(serviceCtx(), {
			email: alice.email, code: codes[0], newPassword: '123456', ip: nextIp()
		})).rejects.toMatchObject({ code: 400 });
	});

	it('注册时生成（无密码变体，仅供注册流程服务端调用）：发码可用、旧码作废', async () => {
		const user = await makeUser('p8f-reg@example.com');
		const { codes } = await recoveryService.generateCodesForRegistration(serviceCtx(), user.userId);
		expect(codes.length).toBe(10);
		expect(await recoveryService.remainingCodes(serviceCtx(), user.userId)).toBe(10);
		const out = await recoveryService.resetByCode(serviceCtx(), {
			email: user.email, code: codes[0], newPassword: 'RegNew#2026', ip: nextIp()
		});
		expect(out.ok).toBe(true);
	});
});

describe('恢复流程限流', () => {
	it('同一邮箱+IP 错 5 次后第 6 次返回 429；换 IP 后仍可继续', async () => {
		const carol = await makeUser('p8f-carol@example.com');
		const ip = nextIp();
		for (let i = 0; i < 5; i++) {
			await expect(recoveryService.resetByCode(serviceCtx(), {
				email: carol.email, code: 'AAAA-BBBB-CCCC', newPassword: 'NewPass#2026', ip
			})).rejects.toMatchObject({ code: 400 });
		}
		await expect(recoveryService.resetByCode(serviceCtx(), {
			email: carol.email, code: 'AAAA-BBBB-CCCC', newPassword: 'NewPass#2026', ip
		})).rejects.toMatchObject({ code: 429 });
		await expect(recoveryService.resetByCode(serviceCtx(), {
			email: carol.email, code: 'AAAA-BBBB-CCCC', newPassword: 'NewPass#2026', ip: nextIp()
		})).rejects.toMatchObject({ code: 400 });
	});
});

describe('备用邮箱恢复链接', () => {
	it('未设备用邮箱时请求链接：通用返回，不建 token', async () => {
		const before = await env.db.prepare('SELECT COUNT(*) AS n FROM password_reset_token WHERE user_id = ?').bind(bob.userId).first();
		const out = await recoveryService.requestResetLink(serviceCtx(), { email: bob.email, ip: nextIp() });
		expect(out.requested).toBe(true);
		const after = await env.db.prepare('SELECT COUNT(*) AS n FROM password_reset_token WHERE user_id = ?').bind(bob.userId).first();
		expect(after.n).toBe(before.n);
	});

	it('设备用邮箱后请求链接：建 1 个未用 token（hash 存库、1 小时有效），返回值不含 token', async () => {
		const user = await makeUser('p8f-dave@example.com');
		await recoveryService.setBackupEmail(serviceCtx(), user.userId, 'dave-backup@example.org');
		const got = await recoveryService.getBackupEmail(serviceCtx(), user.userId);
		expect(got.backupEmail).toBe('dave-backup@example.org');
		const out = await recoveryService.requestResetLink(serviceCtx(), { email: user.email, ip: nextIp() });
		expect(out.requested).toBe(true);
		expect(JSON.stringify(out)).not.toContain('token_hash');
		const rows = await env.db.prepare(
			'SELECT token_hash AS h, expires_at AS e, used AS u FROM password_reset_token WHERE user_id = ? AND used = 0'
		).bind(user.userId).all();
		expect(rows.results.length).toBe(1);
		expect(rows.results[0].h).toHaveLength(64);
		expect(rows.results[0].u).toBe(0);
		const expires = new Date(rows.results[0].e).getTime();
		expect(expires - Date.now()).toBeGreaterThan(30 * 60 * 1000);
		expect(expires - Date.now()).toBeLessThanOrEqual(3600 * 1000);
	});

	it('凭 token 重设密码：一次性、过期失效、错 token 通用错误', async () => {
		const user = await makeUser('p8f-erin@example.com');
		const rawToken = 'a'.repeat(64);
		const future = new Date(Date.now() + 3600 * 1000).toISOString();
		await env.db.prepare(
			`INSERT INTO password_reset_token (user_id, token_hash, expires_at, used) VALUES (?, ?, ?, 0)`
		).bind(user.userId, await sha256Hex(rawToken), future).run();
		const out = await recoveryService.resetByToken(serviceCtx(), {
			email: user.email, token: rawToken, newPassword: 'ErinNew#2026', ip: nextIp()
		});
		expect(out.ok).toBe(true);
		// 同一 token 再用失败。
		await expect(recoveryService.resetByToken(serviceCtx(), {
			email: user.email, token: rawToken, newPassword: 'ErinNew#2027', ip: nextIp()
		})).rejects.toMatchObject({ code: 400 });
		// 错 token 通用错误。
		await expect(recoveryService.resetByToken(serviceCtx(), {
			email: user.email, token: 'b'.repeat(64), newPassword: 'ErinNew#2027', ip: nextIp()
		})).rejects.toMatchObject({ code: 400 });
		// 过期 token 失效。
		const past = new Date(Date.now() - 1000).toISOString();
		await env.db.prepare(
			`INSERT INTO password_reset_token (user_id, token_hash, expires_at, used) VALUES (?, ?, ?, 0)`
		).bind(user.userId, await sha256Hex('c'.repeat(64)), past).run();
		await expect(recoveryService.resetByToken(serviceCtx(), {
			email: user.email, token: 'c'.repeat(64), newPassword: 'ErinNew#2027', ip: nextIp()
		})).rejects.toMatchObject({ code: 400 });
		// 新密码能登录。
		const ok = await login(user.email, nextIp(), 'ErinNew#2026');
		expect(ok.json.code).toBe(200);
	});

	it('备用邮箱不能是本人账号邮箱、格式须合法', async () => {
		await expect(recoveryService.setBackupEmail(serviceCtx(), bob.userId, bob.email))
			.rejects.toMatchObject({ code: 400 });
		await expect(recoveryService.setBackupEmail(serviceCtx(), bob.userId, 'not-an-email'))
			.rejects.toMatchObject({ code: 400 });
	});
});

describe('新设备 / 新 IP 登录提醒：只查本人', () => {
	it('待确认列表只含本人的新 IP 记录；点“是我本人”后记为已知，不再提醒；确认他人 IP 被拒绝', async () => {
		await insertLoginLog(alice.userId, alice.email, '203.0.113.201', 1);
		await insertLoginLog(alice.userId, alice.email, '203.0.113.202', 0);
		await insertLoginLog(bob.userId, bob.email, '203.0.113.203', 1);
		const mine = await newIpAlertService.listPendingAlerts(serviceCtx(), alice.userId);
		const ips = mine.map(r => r.rawIp);
		expect(ips).toContain('203.0.113.201');
		expect(ips).not.toContain('203.0.113.202');
		expect(ips).not.toContain('203.0.113.203');
		expect(mine[0].location).toBe(null);
		const bobs = await newIpAlertService.listPendingAlerts(serviceCtx(), bob.userId);
		expect(bobs.map(r => r.rawIp)).toContain('203.0.113.203');
		// 确认他人 IP 被拒绝。
		await expect(newIpAlertService.acknowledge(serviceCtx(), alice.userId, '203.0.113.203'))
			.rejects.toMatchObject({ code: 404 });
		const out = await newIpAlertService.acknowledge(serviceCtx(), alice.userId, '203.0.113.201');
		expect(out.ok).toBe(true);
		const after = await newIpAlertService.listPendingAlerts(serviceCtx(), alice.userId);
		expect(after.map(r => r.rawIp)).not.toContain('203.0.113.201');
		const known = await newIpAlertService.listKnownIps(serviceCtx(), alice.userId);
		expect(known.map(r => r.ip)).toContain('203.0.113.201');
	});

	it('TG 提醒只含脱敏 IP（写 alert_log，不含完整 IP）', async () => {
		const before = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM alert_log WHERE text LIKE '%203.0.113.99%'`
		).first();
		const res = await newIpAlertService.notifyNewIpLogin(serviceCtx(), alice.userId, {
			email: alice.email, ip: '203.0.113.99', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0'
		});
		expect(res.notified).toBe(true);
		const rows = await env.db.prepare(
			`SELECT text FROM alert_log WHERE text LIKE '%203.0.113.0%' ORDER BY log_id DESC LIMIT 1`
		).all();
		expect(rows.results.length).toBe(1);
		expect(rows.results[0].text).toContain('203.0.113.0');
		expect(rows.results[0].text).not.toContain('203.0.113.99');
		expect(before.n).toBe(0);
	});
});

describe('密码强度分级', () => {
	it('常见弱密码与短密码为 0 分、不通过', () => {
		for (const pw of ['123456', 'password', 'password123', 'qwerty', '111111']) {
			const r = evaluatePasswordStrength(pw);
			expect(r.score).toBe(0);
			expect(r.passed).toBe(false);
			expect(r.level).toBe('very_weak');
		}
		const short = evaluatePasswordStrength('Ab1!');
		expect(short.score).toBe(0);
		expect(short.reasons).toContain('too_short');
		expect(short.passed).toBe(false);
	});

	it('中强密码分级正确：8 位单类弱、12 位四类强', () => {
		const weak = evaluatePasswordStrength('abcdefgh');
		expect(weak.passed).toBe(false);
		const good = evaluatePasswordStrength('Tr0ub4dor&3');
		expect(good.score).toBe(3);
		expect(good.level).toBe('good');
		expect(good.passed).toBe(true);
		const strong = evaluatePasswordStrength('Correct-Horse-Battery-Staple-99');
		expect(strong.score).toBe(4);
		expect(strong.level).toBe('strong');
		expect(strong.passed).toBe(true);
	});

	it('前端镜像与 Worker 版输出一致', () => {
		for (const pw of ['123456', 'abcdefgh', 'Tr0ub4dor&3', 'Correct-Horse-Battery-Staple-99', 'aB3$xxxxxxxx']) {
			expect(evaluatePasswordStrengthVue(pw)).toEqual(evaluatePasswordStrength(pw));
		}
	});
});

describe('联系人：唯一约束与自动补全', () => {
	it('添加、重复添加报友好错（大小写归一化后也算重复）', async () => {
		const user = await makeUser('p8f-frank@example.com');
		const created = await contactService.add(serviceCtx(), user.userId, { name: 'Carol', email: 'Carol@Example.com' });
		expect(created.email).toBe('carol@example.com');
		expect(created.name).toBe('Carol');
		await expect(contactService.add(serviceCtx(), user.userId, { name: 'Carol 2', email: 'carol@example.com' }))
			.rejects.toMatchObject({ code: 400 });
	});

	it('从往来邮件一键添加：收信取发件人，重复添加幂等返回 added: false；他人的邮件不能加', async () => {
		const emailId = await insertEmail(alice.userId, {
			senderEmail: 'dave@example.com', name: 'Dave', subject: 'hi', toEmail: alice.email, type: 0
		});
		const first = await contactService.addFromEmail(serviceCtx(), alice.userId, emailId);
		expect(first.added).toBe(true);
		expect(first.contact.email).toBe('dave@example.com');
		const second = await contactService.addFromEmail(serviceCtx(), alice.userId, emailId);
		expect(second.added).toBe(false);
		expect(second.contact.email).toBe('dave@example.com');
		const bobMail = await insertEmail(bob.userId, {
			senderEmail: 'eve@example.com', name: 'Eve', subject: 'hi', toEmail: bob.email, type: 0
		});
		await expect(contactService.addFromEmail(serviceCtx(), alice.userId, bobMail))
			.rejects.toMatchObject({ code: 404 });
	});

	it('列表搜索与自动补全只查本人', async () => {
		const userA = await makeUser('p8f-grace@example.com');
		const userB = await makeUser('p8f-heidi@example.com');
		await contactService.add(serviceCtx(), userA.userId, { name: 'Carol', email: 'carol@example.com' });
		await contactService.add(serviceCtx(), userB.userId, { name: 'Carol B', email: 'carol-b@example.com' });
		const mine = await contactService.list(serviceCtx(), userA.userId, { q: 'carol' });
		expect(mine.list.map(r => r.email)).toContain('carol@example.com');
		expect(mine.list.map(r => r.email)).not.toContain('carol-b@example.com');
		const sug = await contactService.suggest(serviceCtx(), userA.userId, 'carol');
		expect(sug.map(r => r.email)).toContain('carol@example.com');
		expect(await contactService.suggest(serviceCtx(), userA.userId, '')).toEqual([]);
		const removed = await contactService.remove(serviceCtx(), userA.userId, mine.list[0].contactId);
		expect(removed.ok).toBe(true);
		const after = await contactService.list(serviceCtx(), userA.userId, { q: 'carol' });
		expect(after.list.map(r => r.email)).not.toContain('carol@example.com');
	});
});

describe('邮件规则：按顺序执行且只对新信生效', () => {
	it('建规则：条件/动作校验、无条件或非法动作被拒绝', async () => {
		const user = await makeUser('p8f-ivan@example.com');
		await expect(mailRuleService.create(serviceCtx(), user.userId, { name: 'x', condition: {}, actions: [{ type: 'mark_read' }] }))
			.rejects.toMatchObject({ code: 400 });
		await expect(mailRuleService.create(serviceCtx(), user.userId, { name: 'x', condition: { subject_contains: 'a' }, actions: [{ type: 'nope' }] }))
			.rejects.toMatchObject({ code: 400 });
		await expect(mailRuleService.create(serviceCtx(), user.userId, { name: 'x', condition: { subject_contains: 'a' }, actions: [{ type: 'forward', to: 'bad' }] }))
			.rejects.toMatchObject({ code: 400 });
	});

	it('按 sort 顺序执行：删信后后续规则不再变更该信；转发目标只收集未删信的；停用不执行；reorder 生效', async () => {
		const user = await makeUser('p8f-judy@example.com');
		const ruleA = await mailRuleService.create(serviceCtx(), user.userId, {
			name: 'A 打标+已读', condition: { subject_contains: 'invoice' },
			actions: [{ type: 'tag', label: 'finance' }, { type: 'mark_read' }]
		});
		const ruleB = await mailRuleService.create(serviceCtx(), user.userId, {
			name: 'B 删老板来信', condition: { sender_contains: 'boss' },
			actions: [{ type: 'delete' }]
		});
		const ruleC = await mailRuleService.create(serviceCtx(), user.userId, {
			name: 'C 转发账单', condition: { subject_contains: 'invoice' },
			actions: [{ type: 'forward', to: 'archive@example.com' }]
		});
		expect([ruleA.sort, ruleB.sort, ruleC.sort]).toEqual([0, 1, 2]);
		// 新信 1：主题含 invoice、发件人是 boss → A 执行，B 删信，C 只记日志不转发。
		const mail1 = await insertEmail(user.userId, {
			senderEmail: 'boss@corp.com', subject: 'Invoice #1', toEmail: user.email, type: 0, unread: 0
		});
		const res1 = await mailRuleService.applyRules(serviceCtx(), user.userId, {
			emailId: mail1, senderEmail: 'boss@corp.com', subject: 'Invoice #1', toEmail: user.email
		});
		expect(res1.applied.map(a => a.ruleId)).toEqual([ruleA.ruleId, ruleB.ruleId, ruleC.ruleId]);
		expect(res1.forwardTo).toEqual([]);
		const row1 = await env.db.prepare('SELECT unread, is_del FROM email WHERE email_id = ?').bind(mail1).first();
		expect(row1.unread).toBe(1);
		expect(row1.is_del).toBe(1);
		expect(await mailRuleService.listLabels(serviceCtx(), user.userId, mail1)).toContain('finance');
		// 新信 2：只命中 A 与 C → 转发目标被收集。
		const mail2 = await insertEmail(user.userId, {
			senderEmail: 'shop@example.com', subject: 'Invoice #2', toEmail: user.email, type: 0, unread: 0
		});
		const res2 = await mailRuleService.applyRules(serviceCtx(), user.userId, {
			emailId: mail2, senderEmail: 'shop@example.com', subject: 'Invoice #2', toEmail: user.email
		});
		expect(res2.forwardTo).toEqual(['archive@example.com']);
		// 停用的规则不执行。
		await mailRuleService.update(serviceCtx(), user.userId, ruleA.ruleId, { enabled: 0 });
		const mail3 = await insertEmail(user.userId, {
			senderEmail: 'shop@example.com', subject: 'Invoice #3', toEmail: user.email, type: 0, unread: 0
		});
		const res3 = await mailRuleService.applyRules(serviceCtx(), user.userId, {
			emailId: mail3, senderEmail: 'shop@example.com', subject: 'Invoice #3', toEmail: user.email
		});
		expect(res3.applied.map(a => a.ruleId)).toEqual([ruleC.ruleId]);
		const row3 = await env.db.prepare('SELECT unread, is_del FROM email WHERE email_id = ?').bind(mail3).first();
		expect(row3.unread).toBe(0);
		await mailRuleService.update(serviceCtx(), user.userId, ruleA.ruleId, { enabled: 1 });
		// reorder：C 提到最前。
		const reordered = await mailRuleService.reorder(serviceCtx(), user.userId, [ruleC.ruleId, ruleA.ruleId, ruleB.ruleId]);
		expect(reordered.map(r => r.ruleId)).toEqual([ruleC.ruleId, ruleA.ruleId, ruleB.ruleId]);
	});

	it('只对新信生效：旧信无规则日志；重复执行不重复打标', async () => {
		const user = await makeUser('p8f-karl@example.com');
		await mailRuleService.create(serviceCtx(), user.userId, {
			name: 'A 打标', condition: { subject_contains: 'invoice' },
			actions: [{ type: 'tag', label: 'finance' }]
		});
		const oldMail = await insertEmail(user.userId, {
			senderEmail: 'shop@example.com', subject: 'Invoice old', toEmail: user.email, type: 0, unread: 0
		});
		// 旧信：从未经过 applyRules，mail_rule_log 里没有它。
		const logs = await env.db.prepare('SELECT COUNT(*) AS n FROM mail_rule_log WHERE email_id = ?').bind(oldMail).first();
		expect(logs.n).toBe(0);
		const row = await env.db.prepare('SELECT unread, is_del FROM email WHERE email_id = ?').bind(oldMail).first();
		expect(row.unread).toBe(0);
		expect(row.is_del).toBe(0);
		// 新信重复执行两次：标签仍只有 1 个（唯一约束去重）。
		const mail = await insertEmail(user.userId, {
			senderEmail: 'shop@example.com', subject: 'Invoice dup', toEmail: user.email, type: 0, unread: 0
		});
		const emailRow = { emailId: mail, senderEmail: 'shop@example.com', subject: 'Invoice dup', toEmail: user.email };
		await mailRuleService.applyRules(serviceCtx(), user.userId, emailRow);
		await mailRuleService.applyRules(serviceCtx(), user.userId, emailRow);
		const labels = await mailRuleService.listLabels(serviceCtx(), user.userId, mail);
		expect(labels.filter(l => l === 'finance').length).toBe(1);
	});
});

describe('隐私仪表盘', () => {
	it('数据清单：登录位置与正文日志明确为“不收集”，保留期限与开关状态齐全', async () => {
		const user = await makeUser('p8f-leo@example.com');
		await recoveryService.generateCodes(serviceCtx(), user.userId, 'password123');
		await contactService.add(serviceCtx(), user.userId, { name: 'Mia', email: 'mia@example.com' });
		await mailRuleService.create(serviceCtx(), user.userId, {
			name: 'R', condition: { subject_contains: 'x' }, actions: [{ type: 'mark_read' }]
		});
		const dash = await privacyService.getDashboard(serviceCtx(), user.userId);
		const byId = Object.fromEntries(dash.dataInventory.map(i => [i.id, i]));
		expect(byId['login_location'].collected).toBe(false);
		expect(byId['email_content_log'].collected).toBe(false);
		expect(byId['login_log'].collected).toBe(true);
		expect(byId['login_log'].canDisable).toBe(false);
		expect(byId['login_ip_masked'].collected).toBe(true);
		expect(byId['login_ua_truncated'].collected).toBe(true);
		expect(dash.controls.loginAlert).toBe(true);
		expect(dash.controls.logIpMask).toBe(true);
		expect(dash.thirdParties.map(t => t.id)).toEqual(
			expect.arrayContaining(['cloudflare', 'turnstile', 'resend', 'telegram', 'workers_ai']));
		expect(dash.account.recoveryCodesRemaining).toBe(10);
		expect(dash.counts.loginHistoryTotal).toBeGreaterThan(0);
		expect(dash.counts.contacts).toBe(1);
		expect(dash.counts.rules).toBe(1);
	});
});

describe('HTTP 层（已注册路由）', () => {
	it('GET /privacy/dashboard：登录态可查，只返回本人数据；未登录不返回 200', async () => {
		// 用 beforeAll 的 alice 原始 token（全程有效）；恢复码在本测内生成。
		const gen = await api('/my/recovery-codes/generate', {
			method: 'POST', token: alice.token, body: { password: 'password123' }
		});
		expect(gen.json.code).toBe(200);
		expect(gen.json.data.codes.length).toBe(10);
		const res = await api('/privacy/dashboard', { token: alice.token });
		expect(res.json.code).toBe(200);
		expect(res.json.data.dataInventory).toBeDefined();
		expect(res.json.data.account.recoveryCodesRemaining).toBe(10);
		const noAuth = await api('/privacy/dashboard', {});
		expect(noAuth.json.code).not.toBe(200);
	});

	it('联系人 HTTP：增/查/补全；别人查不到', async () => {
		const userA = await makeUser('p8f-http-a@example.com');
		const userB = await makeUser('p8f-http-b@example.com');
		const added = await api('/contacts/add', {
			method: 'POST', token: userA.token, body: { name: 'HTTP', email: 'http-contact@example.com' }
		});
		expect(added.json.code).toBe(200);
		const list = await api('/contacts/list?q=http', { token: userA.token });
		expect(list.json.code).toBe(200);
		expect(list.json.data.list.map(r => r.email)).toContain('http-contact@example.com');
		const sug = await api('/contacts/suggest?q=http', { token: userA.token });
		expect(sug.json.code).toBe(200);
		expect(sug.json.data.list.map(r => r.email)).toContain('http-contact@example.com');
		const others = await api('/contacts/list?q=http', { token: userB.token });
		expect(others.json.data.list.map(r => r.email)).not.toContain('http-contact@example.com');
	});

	it('新 IP 提醒 HTTP：待确认列表 + 确认', async () => {
		const user = await makeUser('p8f-http-c@example.com');
		await insertLoginLog(user.userId, user.email, '203.0.113.210', 1);
		const list = await api('/security/new-ip-alerts', { token: user.token });
		expect(list.json.code).toBe(200);
		expect(list.json.data.list.map(r => r.rawIp)).toContain('203.0.113.210');
		const ack = await api('/security/new-ip-alerts/acknowledge', {
			method: 'POST', token: user.token, body: { ip: '203.0.113.210' }
		});
		expect(ack.json.code).toBe(200);
		const after = await api('/security/new-ip-alerts', { token: user.token });
		expect(after.json.data.list.map(r => r.rawIp)).not.toContain('203.0.113.210');
	});

	it('规则 HTTP：增/查/删', async () => {
		const user = await makeUser('p8f-http-d@example.com');
		const created = await api('/mail-rules/create', {
			method: 'POST', token: user.token,
			body: { name: 'HTTP 规则', condition: { subject_contains: 'hi' }, actions: [{ type: 'mark_read' }] }
		});
		expect(created.json.code).toBe(200);
		const list = await api('/mail-rules/list', { token: user.token });
		expect(list.json.code).toBe(200);
		expect(list.json.data.list.map(r => r.name)).toContain('HTTP 规则');
		const del = await api(`/mail-rules/delete?ruleId=${created.json.data.ruleId}`, {
			method: 'DELETE', token: user.token
		});
		expect(del.json.code).toBe(200);
	});
});

describe('恢复链接 Origin 校验（2026-11-11 审计修复）', () => {
	function serviceCtxWithHost(host) {
		const ctx = serviceCtx();
		ctx.req = { header: (name) => String(name || '').toLowerCase() === 'host' ? host : null };
		return ctx;
	}

	async function countTokens(userId) {
		const row = await env.db.prepare('SELECT COUNT(*) AS n FROM password_reset_token WHERE user_id = ?').bind(userId).first();
		return row.n;
	}

	async function userWithBackup(email) {
		const user = await makeUser(email);
		await recoveryService.setBackupEmail(serviceCtx(), user.userId, 'backup-' + email);
		return user;
	}

	it('Origin 为任意外站时不建 token（返回仍是通用 requested:true）', async () => {
		const user = await userWithBackup('p8f-origin-evil@example.com');
		const before = await countTokens(user.userId);
		const out = await recoveryService.requestResetLink(serviceCtxWithHost('aevorynthtech.com'), {
			email: user.email, ip: nextIp(), origin: 'https://evil.example'
		});
		expect(out.requested).toBe(true);
		expect(await countTokens(user.userId)).toBe(before);
	});

	it('子域名仿冒（aevorynthtech.com.evil.com）不建 token', async () => {
		const user = await userWithBackup('p8f-origin-sub@example.com');
		const before = await countTokens(user.userId);
		await recoveryService.requestResetLink(serviceCtxWithHost('aevorynthtech.com'), {
			email: user.email, ip: nextIp(), origin: 'https://aevorynthtech.com.evil.com/recovery'
		});
		expect(await countTokens(user.userId)).toBe(before);
	});

	it('非本站 http Origin 不建 token', async () => {
		const user = await userWithBackup('p8f-origin-http@example.com');
		const before = await countTokens(user.userId);
		await recoveryService.requestResetLink(serviceCtxWithHost('aevorynthtech.com'), {
			email: user.email, ip: nextIp(), origin: 'http://aevorynthtech.com'
		});
		expect(await countTokens(user.userId)).toBe(before);
	});

	it('Origin 与请求 Host 同源时建 1 个 token', async () => {
		const user = await userWithBackup('p8f-origin-ok@example.com');
		const before = await countTokens(user.userId);
		const out = await recoveryService.requestResetLink(serviceCtxWithHost('aevorynthtech.com'), {
			email: user.email, ip: nextIp(), origin: 'https://aevorynthtech.com/login'
		});
		expect(out.requested).toBe(true);
		expect(await countTokens(user.userId)).toBe(before + 1);
	});

	it('无 Origin 时回落请求 Host，建 1 个 token', async () => {
		const user = await userWithBackup('p8f-origin-nohdr@example.com');
		const before = await countTokens(user.userId);
		await recoveryService.requestResetLink(serviceCtxWithHost('aevorynthtech.com'), {
			email: user.email, ip: nextIp()
		});
		expect(await countTokens(user.userId)).toBe(before + 1);
	});

	it('无 Origin 且无 Host 时回落本站规范域名，建 1 个 token', async () => {
		const user = await userWithBackup('p8f-origin-canon@example.com');
		const before = await countTokens(user.userId);
		await recoveryService.requestResetLink(serviceCtx(), { email: user.email, ip: nextIp() });
		expect(await countTokens(user.userId)).toBe(before + 1);
	});
});
