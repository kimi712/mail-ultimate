// 斯诺登第三批测试：vitest + @cloudflare/vitest-pool-workers。
// 覆盖：v3_16DB 迁移（email 六列 / user zk 两列 / timelock_key /
// email_blind_index / user_decoy / decoy_email）、胁迫密码（设/改/关、
// 主密码进真实、第二密码进诱饵、错密码通用 501、诱饵不记失败不锁、
// 诱饵隔离：发信/联系人/别名/规则/设备/登录历史/管理路由）、
// 零知识身份（发挑战、正确响应登录、重放失败、错响应失败、未开通拒绝）、
// 邮件混淆（站内信延迟 15–180 秒、未生效列表不可见、生效后补跑转发/规则）、
// 时间锁（未来时刻暂存密钥、未到期解不开、到期懒释放写回、非法时刻按不锁）、
// 可否认认证（denyTag 存库、非 E2EE 时丢弃、非法标签丢弃）、
// 盲索引（发信存 token、收件方补传后可搜、非 E2EE 拒绝、删信清理）。
// 注意：本测试池每个 it 之间不保留 D1 写入（快照回滚），所以每个用例
// 必须自己做 setup（setSecondPassword / zk-setup / 发信都在用例内完成），
// 跨用例共享的只有 beforeAll 建的用户与 token。
// 运行：mail-worker 下 npx vitest run test/phase12-snowden3.spec.js。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import emailService from '../src/service/email-service';
import timelockService from '../src/service/timelock-service';

const IP_A = '203.0.113.71';
const IP_B = '203.0.113.72';
const IP_C = '203.0.113.73';
const IP_D = '203.0.113.74';
const IP_FRESH = '203.0.113.79';
const MAIN_PWD = 'password123';
const DURESS_PWD = 'duress-pass-1';

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
		body: { email, password: MAIN_PWD }
	});
}

async function login(email, ip, password = MAIN_PWD) {
	const res = await api('/login', { method: 'POST', ip, body: { email, password } });
	return res.json?.data?.token;
}

async function loginRaw(body, ip) {
	return api('/login', { method: 'POST', ip, body });
}

async function setSetting(fields) {
	const cached = (await env.kv.get('setting:', { type: 'json' })) || {};
	for (const [key, value] of Object.entries(fields)) {
		cached[key] = value;
	}
	await env.kv.put('setting:', JSON.stringify(cached));
}

function fakeCtx() {
	return { env, get: () => undefined, set: () => {} };
}

function isoIn(ms) {
	return new Date(Date.now() + ms).toISOString().slice(0, 19).replace('T', ' ');
}

function isoAgo(ms) {
	return new Date(Date.now() - ms).toISOString().slice(0, 19).replace('T', ' ');
}

function b64(bytes) {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

async function sha256b64(str) {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
	return b64(new Uint8Array(buf));
}

function randomSaltB64() {
	const rand = new Uint8Array(16);
	crypto.getRandomValues(rand);
	return b64(rand);
}

// 用例内自包含 setup：给用户 A 设胁迫密码并用它登录，返回诱饵 token。
// setSecondPassword 是 upsert，可反复调用；seedDecoyMail 幂等。
async function getDecoyToken() {
	const set = await api('/my/duress/set', {
		method: 'POST', token: tokenA,
		body: { password: MAIN_PWD, duressPassword: DURESS_PWD }
	});
	expect(set.json.code).toBe(200);
	const res = await loginRaw({ email: 'p12-a@example.com', password: DURESS_PWD }, IP_FRESH);
	expect(res.json.code).toBe(200);
	return res.json?.data?.token;
}

// 用例内自包含 setup：给用户 B 开通零知识登录，返回 { salt, verifier }。
async function setupZk() {
	const salt = randomSaltB64();
	const verifier = await sha256b64(salt + MAIN_PWD);
	const res = await api('/my/zk-setup', {
		method: 'POST', token: tokenB,
		body: { password: MAIN_PWD, salt, verifier }
	});
	expect(res.json.code).toBe(200);
	return { salt, verifier };
}

// C→D 发一封 v2 E2EE 站内信（extra 可附加 timelockUntil / deniable / denyTag / blindTokens）。
async function sendV2(subject, extra = {}) {
	const res = await api('/email/send', {
		method: 'POST', token: tokenC,
		body: {
			accountId: accountIdC, receiveEmail: ['p12-d@example.com'],
			subject, text: 'e2ee:v1:xxx', content: 'e2ee:v1:xxx',
			e2ee: 1, e2eeVer: 2,
			cekWraps: [
				{ to: 'p12-d@example.com', alg: 'sym', wrapped: 'wrap-for-d' },
				{ to: 'p12-c@example.com', alg: 'sym', wrapped: 'wrap-for-c' }
			],
			...extra
		}
	});
	expect(res.json.code).toBe(200);
	return res;
}

async function recvRow(userId, subject) {
	return env.db.prepare(
		`SELECT * FROM email WHERE user_id = ? AND type = 0 AND subject = ?`
	).bind(userId, subject).first();
}

let tokenA, tokenB, tokenC, tokenD, userIdA, userIdB, userIdC, userIdD;
let accountIdA, accountIdB, accountIdC, accountIdD;

beforeAll(async () => {
	const res = await SELF.fetch('http://example.com/api/init', { headers: { Authorization: `Bearer ${env.jwt_secret}` } });
	expect(await res.text()).toBe('success');
	// 关 Turnstile 验证（register_verify=CLOSE），只测本路逻辑
	await setSetting({ registerVerify: 1 });

	for (const [suffix, ip] of [['a', IP_A], ['b', IP_B], ['c', IP_C], ['d', IP_D]]) {
		const reg = await register(`p12-${suffix}@example.com`, ip);
		expect(reg.json.code).toBe(200);
	}
	tokenA = await login('p12-a@example.com', IP_A);
	tokenB = await login('p12-b@example.com', IP_B);
	tokenC = await login('p12-c@example.com', IP_C);
	tokenD = await login('p12-d@example.com', IP_D);
	expect(tokenA && tokenB && tokenC && tokenD).toBeTruthy();
	for (const [suffix, key] of [['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D']]) {
		const u = await env.db.prepare(`SELECT user_id FROM user WHERE email = 'p12-${suffix}@example.com'`).first();
		const a = await env.db.prepare(`SELECT account_id FROM account WHERE user_id = ?`).bind(u.user_id).first();
		if (key === 'A') { userIdA = u.user_id; accountIdA = a.account_id; }
		if (key === 'B') { userIdB = u.user_id; accountIdB = a.account_id; }
		if (key === 'C') { userIdC = u.user_id; accountIdC = a.account_id; }
		if (key === 'D') { userIdD = u.user_id; accountIdD = a.account_id; }
	}
});

describe('v3_16DB 迁移', () => {
	it('email 表有 mix_deliver_at / mix_relay / mix_notified / timelock_until / deniable / deny_tag 六列', async () => {
		const cols = await env.db.prepare(`PRAGMA table_info(email)`).all();
		const names = (cols.results || []).map(r => r.name);
		for (const c of ['mix_deliver_at', 'mix_relay', 'mix_notified', 'timelock_until', 'deniable', 'deny_tag']) {
			expect(names).toContain(c);
		}
	});

	it('user 表有 zk_salt / zk_verifier 两列', async () => {
		const cols = await env.db.prepare(`PRAGMA table_info(user)`).all();
		const names = (cols.results || []).map(r => r.name);
		expect(names).toContain('zk_salt');
		expect(names).toContain('zk_verifier');
	});

	it('timelock_key / email_blind_index / user_decoy / decoy_email 四张表存在', async () => {
		for (const t of ['timelock_key', 'email_blind_index', 'user_decoy', 'decoy_email']) {
			const row = await env.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).bind(t).first();
			expect(row?.name).toBe(t);
		}
	});
});

describe('胁迫密码（用户 A）', () => {
	it('未设置时状态为未启用（用从未设置过的用户 D 查）', async () => {
		const res = await api('/my/duress/status', { token: tokenD });
		expect(res.json.code).toBe(200);
		expect(res.json.data.enabled).toBe(false);
	});

	it('设置时主密码错误 → 400，不透露其他信息', async () => {
		const res = await api('/my/duress/set', {
			method: 'POST', token: tokenA,
			body: { password: 'wrong-main-password', duressPassword: DURESS_PWD }
		});
		expect(res.json.code).toBe(400);
	});

	it('胁迫密码与主密码相同 → 400', async () => {
		const res = await api('/my/duress/set', {
			method: 'POST', token: tokenA,
			body: { password: MAIN_PWD, duressPassword: MAIN_PWD }
		});
		expect(res.json.code).toBe(400);
	});

	it('胁迫密码短于 8 位 → 400', async () => {
		const res = await api('/my/duress/set', {
			method: 'POST', token: tokenA,
			body: { password: MAIN_PWD, duressPassword: 'short' }
		});
		expect(res.json.code).toBe(400);
	});

	it('正常设置 → 200，诱饵邮件播种 8 封', async () => {
		const res = await api('/my/duress/set', {
			method: 'POST', token: tokenA,
			body: { password: MAIN_PWD, duressPassword: DURESS_PWD }
		});
		expect(res.json.code).toBe(200);
		expect(res.json.data.enabled).toBe(true);
		const st = await api('/my/duress/status', { token: tokenA });
		expect(st.json.data.enabled).toBe(true);
		const n = await env.db.prepare(`SELECT COUNT(*) AS n FROM decoy_email WHERE user_id = ?`).bind(userIdA).first();
		expect(n.n).toBe(8);
	});

	it('主密码登录仍进真实邮箱：看得到 B 发来的真信', async () => {
		await api('/my/duress/set', {
			method: 'POST', token: tokenA,
			body: { password: MAIN_PWD, duressPassword: DURESS_PWD }
		});
		const send = await api('/email/send', {
			method: 'POST', token: tokenB,
			body: { accountId: accountIdB, receiveEmail: ['p12-a@example.com'], subject: 'p12 real mail', text: 'real', content: 'real' }
		});
		expect(send.json.code).toBe(200);
		await env.db.prepare(`UPDATE email SET mix_deliver_at = '' WHERE user_id = ? AND subject = 'p12 real mail'`).bind(userIdA).run();
		const list = await api(`/email/list?type=0&accountId=${accountIdA}&size=20`, { token: tokenA });
		expect(list.json.code).toBe(200);
		const items = list.json.data?.list || [];
		expect(items.some(e => e.subject === 'p12 real mail')).toBe(true);
		// 真实列表里没有诱饵信（诱饵 id 为负数，只在诱饵视图出现）
		expect(items.some(e => Number(e.emailId) < 0)).toBe(false);
	});

	it('错密码登录 → 通用 501，不透露胁迫密码存在', async () => {
		const res = await loginRaw({ email: 'p12-a@example.com', password: 'totally-wrong' }, IP_FRESH);
		expect(res.json.code).toBe(501);
		expect(res.json?.data?.token).toBeFalsy();
	});

	it('胁迫密码登录成功：只见 8 封诱饵信，看不到真信', async () => {
		await api('/my/duress/set', {
			method: 'POST', token: tokenA,
			body: { password: MAIN_PWD, duressPassword: DURESS_PWD }
		});
		// 先放一封真信进 A 的收件箱（对照组）
		const send = await api('/email/send', {
			method: 'POST', token: tokenB,
			body: { accountId: accountIdB, receiveEmail: ['p12-a@example.com'], subject: 'p12 real mail', text: 'real', content: 'real' }
		});
		expect(send.json.code).toBe(200);
		await env.db.prepare(`UPDATE email SET mix_deliver_at = '' WHERE user_id = ? AND subject = 'p12 real mail'`).bind(userIdA).run();
		const res = await loginRaw({ email: 'p12-a@example.com', password: DURESS_PWD }, IP_FRESH);
		expect(res.json.code).toBe(200);
		const decoyToken = res.json?.data?.token;
		expect(decoyToken).toBeTruthy();
		const list = await api(`/email/list?type=0&accountId=${accountIdA}&size=20`, { token: decoyToken });
		expect(list.json.code).toBe(200);
		const items = list.json.data?.list || [];
		expect(items.length).toBe(8);
		expect(items.every(e => Number(e.emailId) < 0)).toBe(true);
		expect(items.some(e => e.subject === 'p12 real mail')).toBe(false);
	});

	it('胁迫登录记一条审计（主人事后可取证）', async () => {
		const decoyToken = await getDecoyToken();
		expect(decoyToken).toBeTruthy();
		const n = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'security:duress-login' AND target_id = ?`
		).bind(String(userIdA)).first();
		expect(n.n).toBeGreaterThanOrEqual(1);
	});

	it('诱饵会话隔离：发信 403、状态恒假、联系人/别名/规则/登录历史为空、TG 未绑定、管理路由 403', async () => {
		const decoyToken = await getDecoyToken();
		const send = await api('/email/send', {
			method: 'POST', token: decoyToken,
			body: { accountId: accountIdA, receiveEmail: ['p12-b@example.com'], subject: 'decoy send', text: 'x', content: 'x' }
		});
		expect(send.json.code).toBe(403);
		const st = await api('/my/duress/status', { token: decoyToken });
		expect(st.json.code).toBe(200);
		expect(st.json.data.enabled).toBe(false);
		const zk = await api('/my/zk-status', { token: decoyToken });
		expect(zk.json.data.enabled).toBe(false);
		const alias = await api('/my/alias', { token: decoyToken });
		expect(alias.json.code).toBe(200);
		expect((alias.json.data?.list || alias.json.data || []).length).toBe(0);
		const contacts = await api('/contacts/list', { token: decoyToken });
		expect(contacts.json.code).toBe(200);
		expect((contacts.json.data?.list || contacts.json.data || []).length).toBe(0);
		const rules = await api('/mail-rules/list', { token: decoyToken });
		expect(rules.json.code).toBe(200);
		expect((rules.json.data?.list || rules.json.data || []).length).toBe(0);
		const logs = await api('/my/loginLog', { token: decoyToken });
		expect(logs.json.code).toBe(200);
		expect((logs.json.data?.list || logs.json.data || []).length).toBe(0);
		const tg = await api('/my/telegram', { token: decoyToken });
		expect(tg.json.code).toBe(200);
		expect(tg.json.data.bound).toBe(false);
		const admin = await api('/user/list', { token: decoyToken });
		expect(admin.json.code).toBe(403);
		const change = await api('/my/duress/change', {
			method: 'POST', token: decoyToken,
			body: { password: MAIN_PWD, duressPassword: 'duress-pass-2' }
		});
		expect(change.json.code).toBe(403);
	});

	it('关闭时主密码错误 → 400；正常关闭后胁迫密码登录 → 501', async () => {
		await api('/my/duress/set', {
			method: 'POST', token: tokenA,
			body: { password: MAIN_PWD, duressPassword: DURESS_PWD }
		});
		const bad = await api('/my/duress/disable', {
			method: 'POST', token: tokenA, body: { password: 'wrong-main-password' }
		});
		expect(bad.json.code).toBe(400);
		const ok = await api('/my/duress/disable', {
			method: 'POST', token: tokenA, body: { password: MAIN_PWD }
		});
		expect(ok.json.code).toBe(200);
		expect(ok.json.data.enabled).toBe(false);
		const res = await loginRaw({ email: 'p12-a@example.com', password: DURESS_PWD }, IP_FRESH);
		expect(res.json.code).toBe(501);
	});
});

describe('零知识身份（用户 B）', () => {
	it('未开通时挑战照常发放（enabled=false，不透露开通状态；用从未开通的用户 D 查）', async () => {
		const res = await api('/login/zk-challenge?email=p12-d@example.com');
		expect(res.json.code).toBe(200);
		expect(res.json.data.enabled).toBe(false);
		expect(res.json.data.challengeId).toBeTruthy();
		expect(res.json.data.nonce).toBeTruthy();
		expect(res.json.data.salt).toBeTruthy();
	});

	it('开通时主密码错误 → 401；salt/verifier 非法 → 400', async () => {
		const salt = randomSaltB64();
		const verifier = await sha256b64(salt + MAIN_PWD);
		const badPwd = await api('/my/zk-setup', {
			method: 'POST', token: tokenB,
			body: { password: 'wrong-main-password', salt, verifier }
		});
		expect(badPwd.json.code).toBe(401);
		const badSalt = await api('/my/zk-setup', {
			method: 'POST', token: tokenB,
			body: { password: MAIN_PWD, salt: 'xx', verifier }
		});
		expect(badSalt.json.code).toBe(400);
		const badVerifier = await api('/my/zk-setup', {
			method: 'POST', token: tokenB,
			body: { password: MAIN_PWD, salt, verifier: 'not-base64!' }
		});
		expect(badVerifier.json.code).toBe(400);
	});

	it('正常开通 → 200，服务端只存盐与验证子', async () => {
		const { salt, verifier } = await setupZk();
		const row = await env.db.prepare(`SELECT zk_salt, zk_verifier FROM user WHERE user_id = ?`).bind(userIdB).first();
		expect(row.zk_salt).toBe(salt);
		expect(row.zk_verifier).toBe(verifier);
		const st = await api('/my/zk-status', { token: tokenB });
		expect(st.json.data.enabled).toBe(true);
	});

	it('正确挑战-应答登录成功；同一挑战重放 → 401', async () => {
		const { salt, verifier } = await setupZk();
		const ch = await api('/login/zk-challenge?email=p12-b@example.com');
		expect(ch.json.data.enabled).toBe(true);
		expect(ch.json.data.salt).toBe(salt);
		const response = await sha256b64(verifier + ch.json.data.nonce);
		const res = await loginRaw({
			email: 'p12-b@example.com', password: MAIN_PWD,
			zk: { challengeId: ch.json.data.challengeId, response }
		}, IP_FRESH);
		expect(res.json.code).toBe(200);
		expect(res.json?.data?.token).toBeTruthy();
		// 同一挑战重放 → 401（一次有效）
		const replay = await loginRaw({
			email: 'p12-b@example.com', password: MAIN_PWD,
			zk: { challengeId: ch.json.data.challengeId, response }
		}, IP_FRESH);
		expect(replay.json.code).toBe(401);
	});

	it('错误响应 → 401', async () => {
		await setupZk();
		const ch = await api('/login/zk-challenge?email=p12-b@example.com');
		const badResponse = await sha256b64('wrong-verifier' + ch.json.data.nonce);
		const res = await loginRaw({
			email: 'p12-b@example.com', password: MAIN_PWD,
			zk: { challengeId: ch.json.data.challengeId, response: badResponse }
		}, IP_FRESH);
		expect(res.json.code).toBe(401);
	});

	it('未开通账号（用户 D）带 zk 登录 → 401', async () => {
		const ch = await api('/login/zk-challenge?email=p12-d@example.com');
		expect(ch.json.data.enabled).toBe(false);
		const response = await sha256b64('whatever-verifier' + ch.json.data.nonce);
		const res = await loginRaw({
			email: 'p12-d@example.com', password: MAIN_PWD,
			zk: { challengeId: ch.json.data.challengeId, response }
		}, IP_FRESH);
		expect(res.json.code).toBe(401);
	});

	it('关闭后 ZK 登录 → 401', async () => {
		const { verifier } = await setupZk();
		const bad = await api('/my/zk-disable', {
			method: 'POST', token: tokenB, body: { password: 'wrong-main-password' }
		});
		expect(bad.json.code).toBe(401);
		const ok = await api('/my/zk-disable', {
			method: 'POST', token: tokenB, body: { password: MAIN_PWD }
		});
		expect(ok.json.code).toBe(200);
		expect(ok.json.data.enabled).toBe(false);
		const row = await env.db.prepare(`SELECT zk_salt, zk_verifier FROM user WHERE user_id = ?`).bind(userIdB).first();
		expect(row.zk_verifier || '').toBe('');
		const ch = await api('/login/zk-challenge?email=p12-b@example.com');
		const response = await sha256b64(verifier + ch.json.data.nonce);
		const res = await loginRaw({
			email: 'p12-b@example.com', password: MAIN_PWD,
			zk: { challengeId: ch.json.data.challengeId, response }
		}, IP_FRESH);
		expect(res.json.code).toBe(401);
	});
});

describe('邮件混淆（C→D）', () => {
	it('站内信随机延迟 15–180 秒、随机逻辑中继 R1–R5；未生效时列表不可见；发件人已发送副本不延迟', async () => {
		const before = Date.now();
		const send = await api('/email/send', {
			method: 'POST', token: tokenC,
			body: { accountId: accountIdC, receiveEmail: ['p12-d@example.com'], subject: 'p12 mix', text: 'mix', content: 'mix' }
		});
		expect(send.json.code).toBe(200);
		const row = await recvRow(userIdD, 'p12 mix');
		expect(row).toBeTruthy();
		const deliverMs = new Date(row.mix_deliver_at.replace(' ', 'T') + 'Z').getTime();
		expect(deliverMs - before).toBeGreaterThanOrEqual(10 * 1000);
		expect(deliverMs - before).toBeLessThanOrEqual(185 * 1000);
		expect(/^R[1-5]$/.test(row.mix_relay)).toBe(true);
		expect(Number(row.mix_notified)).toBe(0);
		// 未生效：列表里看不到
		const list = await api(`/email/list?type=0&accountId=${accountIdD}&size=20`, { token: tokenD });
		const items = list.json.data?.list || [];
		expect(items.some(e => e.subject === 'p12 mix')).toBe(false);
		// 发件人已发送副本不延迟，立即可见
		const sentList = await api(`/email/list?type=1&accountId=${accountIdC}&size=20`, { token: tokenC });
		const sentItems = sentList.json.data?.list || [];
		expect(sentItems.some(e => e.subject === 'p12 mix')).toBe(true);
	});

	it('生效后补跑：列表可见，processDueDeliveries 置 mix_notified=1', async () => {
		const send = await api('/email/send', {
			method: 'POST', token: tokenC,
			body: { accountId: accountIdC, receiveEmail: ['p12-d@example.com'], subject: 'p12 mix', text: 'mix', content: 'mix' }
		});
		expect(send.json.code).toBe(200);
		await env.db.prepare(`UPDATE email SET mix_deliver_at = ? WHERE user_id = ? AND subject = 'p12 mix'`).bind(isoAgo(60 * 1000), userIdD).run();
		const list = await api(`/email/list?type=0&accountId=${accountIdD}&size=20`, { token: tokenD });
		const items = list.json.data?.list || [];
		expect(items.some(e => e.subject === 'p12 mix')).toBe(true);
		await emailService.processDueDeliveries(fakeCtx());
		const row = await recvRow(userIdD, 'p12 mix');
		expect(Number(row.mix_notified)).toBe(1);
	});

	it('站外收件人无可用通道时发送被拒（501），不产生任何邮件行（也就不会被混淆）', async () => {
		// 测试环境既无 CF Email Sending 绑定、也无 Resend Token，站外发送
		// 在 executeSend 前置检查即被拒；混淆只在 allInternal 时才发生
		// （executeSend 内 mix = allInternal ? resolveMix() : 空）。
		const send = await api('/email/send', {
			method: 'POST', token: tokenC,
			body: { accountId: accountIdC, receiveEmail: ['someone@outside.example'], subject: 'p12 mix external', text: 'x', content: 'x' }
		});
		expect(send.json.code).toBe(501);
		const n = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM email WHERE subject = 'p12 mix external'`
		).first();
		expect(n.n).toBe(0);
	});
});

describe('时间锁加密（C→D）', () => {
	it('未来解锁时刻：收件行密钥被暂存、行内 cek 为空、timelock_key 在位', async () => {
		const unlockAt = isoIn(3600 * 1000);
		await sendV2('p12 timelock', { timelockUntil: unlockAt });
		const row = await recvRow(userIdD, 'p12 timelock');
		expect(row).toBeTruthy();
		expect(row.timelock_until).toBe(unlockAt);
		expect(row.cek_wrapped || '').toBe('');
		const key = await env.db.prepare(`SELECT unlock_at, released FROM timelock_key WHERE email_id = ?`).bind(row.email_id).first();
		expect(key).toBeTruthy();
		expect(key.unlock_at).toBe(unlockAt);
		expect(Number(key.released)).toBe(0);
	});

	it('未到期不释放：releaseOne 返回 false，密钥仍在暂存', async () => {
		const unlockAt = isoIn(3600 * 1000);
		await sendV2('p12 timelock', { timelockUntil: unlockAt });
		const row = await recvRow(userIdD, 'p12 timelock');
		const ok = await timelockService.releaseOne(fakeCtx(), row.email_id);
		expect(ok).toBe(false);
		const row2 = await env.db.prepare(`SELECT cek_wrapped FROM email WHERE email_id = ?`).bind(row.email_id).first();
		expect(row2.cek_wrapped || '').toBe('');
	});

	it('到期后懒释放：列表触发后包裹写回、暂存行删除、再释放返回 false', async () => {
		const unlockAt = isoIn(3600 * 1000);
		await sendV2('p12 timelock', { timelockUntil: unlockAt });
		const row = await recvRow(userIdD, 'p12 timelock');
		const past = isoAgo(60 * 1000);
		await env.db.prepare(`UPDATE email SET timelock_until = ?, mix_deliver_at = '' WHERE email_id = ?`).bind(past, row.email_id).run();
		await env.db.prepare(`UPDATE timelock_key SET unlock_at = ? WHERE email_id = ?`).bind(past, row.email_id).run();
		const list = await api(`/email/list?type=0&accountId=${accountIdD}&size=20`, { token: tokenD });
		const items = list.json.data?.list || [];
		expect(items.some(e => e.subject === 'p12 timelock')).toBe(true);
		const row2 = await env.db.prepare(`SELECT cek_wrapped, cek_alg FROM email WHERE email_id = ?`).bind(row.email_id).first();
		expect(row2.cek_wrapped).toBe('wrap-for-d');
		expect(row2.cek_alg).toBe('sym');
		const key = await env.db.prepare(`SELECT COUNT(*) AS n FROM timelock_key WHERE email_id = ?`).bind(row.email_id).first();
		expect(key.n).toBe(0);
		// 幂等：再释放一次返回 false
		const again = await timelockService.releaseOne(fakeCtx(), row.email_id);
		expect(again).toBe(false);
	});

	it('非法时刻按不锁处理：过去时刻 / 超 365 天都不锁', async () => {
		await sendV2('p12 timelock past', { timelockUntil: isoAgo(3600 * 1000) });
		const row = await recvRow(userIdD, 'p12 timelock past');
		expect(row.timelock_until || '').toBe('');
		expect(row.cek_wrapped).toBe('wrap-for-d');
		await sendV2('p12 timelock far', { timelockUntil: isoIn(400 * 86400 * 1000) });
		const row2 = await recvRow(userIdD, 'p12 timelock far');
		expect(row2.timelock_until || '').toBe('');
		expect(row2.cek_wrapped).toBe('wrap-for-d');
	});
});

describe('可否认认证（C→D）', () => {
	const TAG = 'ab'.repeat(32); // 64 位 hex

	it('v2 信 deniable=1：标记与标签存库（收件行与发件人已发送副本）', async () => {
		await sendV2('p12 deniable', { deniable: 1, denyTag: TAG });
		const row = await recvRow(userIdD, 'p12 deniable');
		expect(Number(row.deniable)).toBe(1);
		expect(row.deny_tag).toBe(TAG);
		const sent = await env.db.prepare(
			`SELECT deniable, deny_tag FROM email WHERE user_id = ? AND type = 1 AND subject = 'p12 deniable'`
		).bind(userIdC).first();
		expect(Number(sent.deniable)).toBe(1);
		expect(sent.deny_tag).toBe(TAG);
	});

	it('非法标签被丢弃（太短）', async () => {
		await sendV2('p12 deniable bad tag', { deniable: 1, denyTag: 'abc' });
		const row = await recvRow(userIdD, 'p12 deniable bad tag');
		expect(Number(row.deniable)).toBe(1);
		expect(row.deny_tag || '').toBe('');
	});

	it('非 E2EE 信的可否认标记被丢弃', async () => {
		const send = await api('/email/send', {
			method: 'POST', token: tokenC,
			body: {
				accountId: accountIdC, receiveEmail: ['p12-d@example.com'],
				subject: 'p12 deniable plain', text: 'x', content: 'x',
				e2ee: 0, deniable: 1, denyTag: TAG
			}
		});
		expect(send.json.code).toBe(200);
		const row = await recvRow(userIdD, 'p12 deniable plain');
		expect(Number(row.deniable)).toBe(0);
		expect(row.deny_tag || '').toBe('');
	});
});

describe('盲索引（C→D）', () => {
	const T1 = 'aa'.repeat(32);
	const T2 = 'bb'.repeat(32);

	it('发信时盲 token 存入发件方名下，发件方可搜到；不存在的 token 返回空', async () => {
		await sendV2('p12 blind', { blindTokens: [T1, T2] });
		const sent = await env.db.prepare(
			`SELECT email_id FROM email WHERE user_id = ? AND type = 1 AND subject = 'p12 blind'`
		).bind(userIdC).first();
		const n = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM email_blind_index WHERE email_id = ? AND user_id = ?`
		).bind(sent.email_id, userIdC).first();
		expect(n.n).toBe(2);
		const search = await api('/my/blind-search', {
			method: 'POST', token: tokenC, body: { token: T1 }
		});
		expect(search.json.code).toBe(200);
		expect(search.json.data.emailIds).toContain(sent.email_id);
		const miss = await api('/my/blind-search', {
			method: 'POST', token: tokenC, body: { token: 'cc'.repeat(32) }
		});
		expect(miss.json.data.emailIds).toEqual([]);
	});

	it('收件方读信后补传自己的 token，之后收件方可搜到', async () => {
		await sendV2('p12 blind', { blindTokens: [T1, T2] });
		const recv = await recvRow(userIdD, 'p12 blind');
		await env.db.prepare(`UPDATE email SET mix_deliver_at = '' WHERE email_id = ?`).bind(recv.email_id).run();
		const res = await api('/my/blind-index', {
			method: 'POST', token: tokenD,
			body: { emailId: recv.email_id, tokens: [T1] }
		});
		expect(res.json.code).toBe(200);
		expect(res.json.data.stored).toBe(1);
		const search = await api('/my/blind-search', {
			method: 'POST', token: tokenD, body: { token: T1 }
		});
		expect(search.json.data.emailIds).toContain(recv.email_id);
	});

	it('非 E2EE 信补传盲索引 → stored 0', async () => {
		const send = await api('/email/send', {
			method: 'POST', token: tokenC,
			body: { accountId: accountIdC, receiveEmail: ['p12-d@example.com'], subject: 'p12 blind plain', text: 'x', content: 'x' }
		});
		expect(send.json.code).toBe(200);
		const plain = await recvRow(userIdD, 'p12 blind plain');
		const res = await api('/my/blind-index', {
			method: 'POST', token: tokenD,
			body: { emailId: plain.email_id, tokens: [T1] }
		});
		expect(res.json.code).toBe(200);
		expect(res.json.data.stored).toBe(0);
	});

	it('诱饵会话搜盲索引返回空', async () => {
		const decoyToken = await getDecoyToken();
		const res = await api('/my/blind-search', {
			method: 'POST', token: decoyToken, body: { token: T1 }
		});
		expect(res.json.code).toBe(200);
		expect(res.json.data.emailIds).toEqual([]);
	});

	it('彻底删除邮件时盲索引行随之清理', async () => {
		await sendV2('p12 blind', { blindTokens: [T1, T2] });
		const recv = await recvRow(userIdD, 'p12 blind');
		await env.db.prepare(`UPDATE email SET mix_deliver_at = '' WHERE email_id = ?`).bind(recv.email_id).run();
		await api('/my/blind-index', {
			method: 'POST', token: tokenD,
			body: { emailId: recv.email_id, tokens: [T1] }
		});
		const before = await env.db.prepare(`SELECT COUNT(*) AS n FROM email_blind_index WHERE email_id = ?`).bind(recv.email_id).first();
		expect(before.n).toBeGreaterThanOrEqual(1);
		// 同步删除开（syncDelete=0）：DELETE /email/delete 直接物理删除
		await setSetting({ syncDelete: 0 });
		const del = await api(`/email/delete?emailIds=${recv.email_id}`, {
			method: 'DELETE', token: tokenD
		});
		expect(del.json.code).toBe(200);
		const gone = await env.db.prepare(`SELECT COUNT(*) AS n FROM email WHERE email_id = ?`).bind(recv.email_id).first();
		expect(gone.n).toBe(0);
		const n = await env.db.prepare(`SELECT COUNT(*) AS n FROM email_blind_index WHERE email_id = ?`).bind(recv.email_id).first();
		expect(n.n).toBe(0);
	});
});

describe('回复只认本人邮件（2026-11-11 审计修复）', () => {
	it('用他人收件行 id 回复被拒；用自己已发送行 id 回复成功', async () => {
		// B 发一封站内信给 D：D 的收件行只属于 D。
		const send = await api('/email/send', {
			method: 'POST', token: tokenB,
			body: { accountId: accountIdB, receiveEmail: ['p12-d@example.com'], subject: 'p12 reply-target', text: 'hi D', content: 'hi D' }
		});
		expect(send.json.code).toBe(200);
		const dRow = await recvRow(userIdD, 'p12 reply-target');
		expect(dRow).toBeTruthy();
		// A 不是 D：拿 D 的收件行 id 回复，必须判“原邮件不存在”。
		const attack = await api('/email/send', {
			method: 'POST', token: tokenA,
			body: { accountId: accountIdA, receiveEmail: ['p12-a@example.com'], subject: 'Re: p12 reply-target', text: 'r', content: 'r', sendType: 'reply', emailId: dRow.email_id }
		});
		expect(attack.json.code).not.toBe(200);
		// 对照组：A 回复自己的已发送行，成功。
		const selfSend = await api('/email/send', {
			method: 'POST', token: tokenA,
			body: { accountId: accountIdA, receiveEmail: ['p12-a@example.com'], subject: 'p12 self mail', text: 'self', content: 'self' }
		});
		expect(selfSend.json.code).toBe(200);
		const ownRow = await env.db.prepare(
			`SELECT email_id FROM email WHERE user_id = ? AND type = 1 AND subject = 'p12 self mail'`
		).bind(userIdA).first();
		expect(ownRow).toBeTruthy();
		const ok = await api('/email/send', {
			method: 'POST', token: tokenA,
			body: { accountId: accountIdA, receiveEmail: ['p12-a@example.com'], subject: 'Re: p12 self mail', text: 'r', content: 'r', sendType: 'reply', emailId: ownRow.email_id }
		});
		expect(ok.json.code).toBe(200);
	});
});
