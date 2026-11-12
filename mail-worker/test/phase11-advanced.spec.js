// 斯诺登第二批测试：vitest + @cloudflare/vitest-pool-workers。
// 覆盖：v3_15DB 迁移（email 新列 sealed_sender / cek_wrapped / cek_alg / e2ee_ver、
// user_security 新列 mlkem_public_key / mlkem_priv_enc、dead_man_switch 新表）、
// 发件人隐身 + 前向保密（v2 密封信：收件行发件人置空、按收件人分发 CEK 包裹、
// 发件人已发送行保留明文 + 自己的包裹；缺发件人包裹 → 400；e2ee=0 时密封字段被丢弃；
// v1 旧路不受影响）、ML-KEM 密钥 API（格式校验/按地址取公钥/私钥只返回给本人）、
// 死亡开关 API（参数校验/布防/关闭）与 cron 检查全流程（提醒 → 宽限 → 执行通知 /
// 执行删除 / 重新活跃后状态机归零、旧提醒作废）。
// 运行：mail-worker 下 npx vitest run test/phase11-advanced.spec.js。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import deadmanService from '../src/service/deadman-service';

const IP_A = '203.0.113.61';
const IP_B = '203.0.113.62';
const IP_C = '203.0.113.63';
const IP_D = '203.0.113.64';

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

function daysAgoSql(n) {
	return new Date(Date.now() - n * 24 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
}

async function setActiveDaysAgo(userId, days) {
	await env.db.prepare(`UPDATE user SET active_time = ? WHERE user_id = ?`).bind(daysAgoSql(days), userId).run();
}

async function setWarnedDaysAgo(userId, days) {
	await env.db.prepare(`UPDATE dead_man_switch SET warned_at = ? WHERE user_id = ?`).bind(daysAgoSql(days), userId).run();
}

async function userRow(userId) {
	return env.db.prepare(`SELECT * FROM user WHERE user_id = ?`).bind(userId).first();
}

async function deadmanRow(userId) {
	return env.db.prepare(`SELECT * FROM dead_man_switch WHERE user_id = ?`).bind(userId).first();
}

let tokenA, tokenB, tokenC, tokenD, userIdA, userIdB, userIdC, userIdD, accountIdA, accountIdB, accountIdC, accountIdD;

beforeAll(async () => {
	const res = await SELF.fetch('http://example.com/api/init', { headers: { Authorization: `Bearer ${env.jwt_secret}` } });
	expect(await res.text()).toBe('success');
	// 关 Turnstile 验证（register_verify=CLOSE），只测本路逻辑
	await setSetting({ registerVerify: 1 });

	for (const [suffix, ip] of [['a', IP_A], ['b', IP_B], ['c', IP_C], ['d', IP_D]]) {
		const reg = await register(`p11-${suffix}@example.com`, ip);
		expect(reg.json.code).toBe(200);
	}
	tokenA = await login('p11-a@example.com', IP_A);
	tokenB = await login('p11-b@example.com', IP_B);
	tokenC = await login('p11-c@example.com', IP_C);
	tokenD = await login('p11-d@example.com', IP_D);
	expect(tokenA && tokenB && tokenC && tokenD).toBeTruthy();
	for (const [suffix, key] of [['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D']]) {
		const u = await env.db.prepare(`SELECT user_id FROM user WHERE email = 'p11-${suffix}@example.com'`).first();
		const a = await env.db.prepare(`SELECT account_id FROM account WHERE user_id = ?`).bind(u.user_id).first();
		if (key === 'A') { userIdA = u.user_id; accountIdA = a.account_id; }
		if (key === 'B') { userIdB = u.user_id; accountIdB = a.account_id; }
		if (key === 'C') { userIdC = u.user_id; accountIdC = a.account_id; }
		if (key === 'D') { userIdD = u.user_id; accountIdD = a.account_id; }
	}
});

describe('v3_15DB 迁移', () => {
	it('email 表有 sealed_sender / cek_wrapped / cek_alg / e2ee_ver 四列', async () => {
		const cols = await env.db.prepare(`PRAGMA table_info(email)`).all();
		const names = (cols.results || []).map(r => r.name);
		expect(names).toContain('sealed_sender');
		expect(names).toContain('cek_wrapped');
		expect(names).toContain('cek_alg');
		expect(names).toContain('e2ee_ver');
	});

	it('user_security 表有 mlkem_public_key / mlkem_priv_enc 两列', async () => {
		const cols = await env.db.prepare(`PRAGMA table_info(user_security)`).all();
		const names = (cols.results || []).map(r => r.name);
		expect(names).toContain('mlkem_public_key');
		expect(names).toContain('mlkem_priv_enc');
	});

	it('dead_man_switch 表存在', async () => {
		const t = await env.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='dead_man_switch'`).first();
		expect(t?.name).toBe('dead_man_switch');
	});
});

describe('发件人隐身 + 前向保密（v2 密封信）', () => {
	it('A→B 密封信：B 的收件行发件人置空、密封信封与 B 的包裹在位；A 的已发送行保留明文 + 自己的包裹', async () => {
		const res = await api('/email/send', {
			method: 'POST', token: tokenA,
			body: {
				accountId: accountIdA,
				receiveEmail: ['p11-b@example.com'],
				subject: 'p11 sealed', text: 'e2ee:v1:xxx', content: 'e2ee:v1:xxx',
				e2ee: 1, e2eeVer: 2,
				sealedSender: 'sealed:v1:AAAABBBB',
				cekWraps: [
					{ to: 'p11-b@example.com', alg: 'sym', wrapped: 'wrap-for-b' },
					{ to: 'p11-a@example.com', alg: 'sym', wrapped: 'wrap-for-a' }
				]
			}
		});
		expect(res.json.code).toBe(200);
		const recv = await env.db.prepare(
			`SELECT send_email, name, sealed_sender, cek_wrapped, cek_alg, e2ee_ver, e2ee FROM email WHERE user_id = ? AND type = 0 AND subject = 'p11 sealed'`
		).bind(userIdB).first();
		expect(recv).toBeTruthy();
		expect(recv.send_email).toBe('');
		expect(recv.name).toBe('');
		expect(recv.sealed_sender).toBe('sealed:v1:AAAABBBB');
		expect(recv.cek_wrapped).toBe('wrap-for-b');
		expect(recv.cek_alg).toBe('sym');
		expect(recv.e2ee_ver).toBe(2);
		expect(recv.e2ee).toBe(1);
		const sent = await env.db.prepare(
			`SELECT send_email, name, sealed_sender, cek_wrapped, cek_alg, e2ee_ver FROM email WHERE user_id = ? AND type = 1 AND subject = 'p11 sealed'`
		).bind(userIdA).first();
		expect(sent).toBeTruthy();
		expect(sent.send_email).toBe('p11-a@example.com');
		expect(sent.name).toBeTruthy();
		expect(sent.sealed_sender).toBe('sealed:v1:AAAABBBB');
		expect(sent.cek_wrapped).toBe('wrap-for-a');
		expect(sent.cek_alg).toBe('sym');
		expect(sent.e2ee_ver).toBe(2);
	});

	it('v2 信缺发件人自己的包裹 → 400（不写出不可读的信）', async () => {
		const res = await api('/email/send', {
			method: 'POST', token: tokenA,
			body: {
				accountId: accountIdA,
				receiveEmail: ['p11-b@example.com'],
				subject: 'p11 no self wrap', text: 'x', content: 'x',
				e2ee: 1, e2eeVer: 2,
				sealedSender: 'sealed:v1:XXXX',
				cekWraps: [{ to: 'p11-b@example.com', alg: 'sym', wrapped: 'wrap-for-b' }]
			}
		});
		expect(res.json.code).toBe(400);
		const gone = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM email WHERE subject = 'p11 no self wrap'`
		).first();
		expect(gone.n).toBe(0);
	});

	it('e2ee=0 时密封字段被丢弃（不写进任何一行）', async () => {
		const res = await api('/email/send', {
			method: 'POST', token: tokenA,
			body: {
				accountId: accountIdA,
				receiveEmail: ['p11-b@example.com'],
				subject: 'p11 plain sealed fields', text: 'plain', content: 'plain',
				e2ee: 0, e2eeVer: 2,
				sealedSender: 'sealed:v1:SHOULD-DROP',
				cekWraps: [
					{ to: 'p11-b@example.com', alg: 'sym', wrapped: 'wrap-b' },
					{ to: 'p11-a@example.com', alg: 'sym', wrapped: 'wrap-a' }
				]
			}
		});
		expect(res.json.code).toBe(200);
		const recv = await env.db.prepare(
			`SELECT send_email, sealed_sender, cek_wrapped, e2ee_ver FROM email WHERE user_id = ? AND type = 0 AND subject = 'p11 plain sealed fields'`
		).bind(userIdB).first();
		expect(recv.send_email).toBe('p11-a@example.com');
		expect(recv.sealed_sender).toBe('');
		expect(recv.cek_wrapped).toBe('');
		expect(recv.e2ee_ver).toBe(1);
	});

	it('v1 旧路：不传密封字段照常发，sealed_sender/cek_wrapped 为空、e2ee_ver=1', async () => {
		const res = await api('/email/send', {
			method: 'POST', token: tokenA,
			body: {
				accountId: accountIdA,
				receiveEmail: ['p11-b@example.com'],
				subject: 'p11 legacy v1', text: 'v1', content: 'v1', e2ee: 1
			}
		});
		expect(res.json.code).toBe(200);
		const recv = await env.db.prepare(
			`SELECT send_email, sealed_sender, cek_wrapped, e2ee_ver FROM email WHERE user_id = ? AND type = 0 AND subject = 'p11 legacy v1'`
		).bind(userIdB).first();
		expect(recv.send_email).toBe('p11-a@example.com');
		expect(recv.sealed_sender).toBe('');
		expect(recv.cek_wrapped).toBe('');
		expect(recv.e2ee_ver).toBe(1);
	});
});

describe('ML-KEM 密钥 API', () => {
	// 1184 字节的合法 base64（ML-KEM-768 封装公钥尺寸）：1579 个 'A' + '='。
	const fakePub = 'A'.repeat(1579) + '=';
	const fakePriv = 'e2ee:v1:' + 'A'.repeat(100);

	it('公钥长度不对 → 400；私钥不是 e2ee:v1: 信封 → 400', async () => {
		const badPub = await api('/my/security/mlkem-keys', {
			method: 'POST', token: tokenA,
			body: { publicKey: 'AAAA', privEnc: fakePriv }
		});
		expect(badPub.json.code).toBe(400);
		const badPriv = await api('/my/security/mlkem-keys', {
			method: 'POST', token: tokenA,
			body: { publicKey: fakePub, privEnc: 'plain-text-not-envelope' }
		});
		expect(badPriv.json.code).toBe(400);
	});

	it('合法密钥对存入后 mlkemEnabled=1；发件方可按收件地址取到公钥', async () => {
		const set = await api('/my/security/mlkem-keys', {
			method: 'POST', token: tokenB,
			body: { publicKey: fakePub, privEnc: fakePriv }
		});
		expect(set.json.code).toBe(200);
		expect(set.json.data.mlkemEnabled).toBe(1);
		// A 按 B 的地址取公钥（公钥可公开，任意登录用户可取）
		const pub = await api(`/my/security/mlkem-pubkey?email=p11-b@example.com`, { token: tokenA });
		expect(pub.json.code).toBe(200);
		expect(pub.json.data.publicKey).toBe(fakePub);
		// 未生成密钥的用户返回空
		const none = await api(`/my/security/mlkem-pubkey?email=p11-a@example.com`, { token: tokenB });
		expect(none.json.data.publicKey).toBe('');
	});

	it('加密私钥只返回给本人：B 取到自己的，A 取到自己的（空），取不到 B 的', async () => {
		// 注意：本测试池每个 it 用例之间不保留 D1 写入（快照回滚），密钥对须在本用例内重建。
		const set = await api('/my/security/mlkem-keys', {
			method: 'POST', token: tokenB,
			body: { publicKey: fakePub, privEnc: fakePriv }
		});
		expect(set.json.code).toBe(200);
		const privB = await api('/my/security/mlkem-private', { token: tokenB });
		expect(privB.json.code).toBe(200);
		expect(privB.json.data.privEnc).toBe(fakePriv);
		const privA = await api('/my/security/mlkem-private', { token: tokenA });
		expect(privA.json.code).toBe(200);
		expect(privA.json.data.privEnc).toBe('');
	});

	it('重新生成覆盖旧密钥对', async () => {
		const fakePub2 = 'B'.repeat(1579) + '=';
		const set = await api('/my/security/mlkem-keys', {
			method: 'POST', token: tokenB,
			body: { publicKey: fakePub2, privEnc: fakePriv }
		});
		expect(set.json.code).toBe(200);
		const pub = await api(`/my/security/mlkem-pubkey?email=p11-b@example.com`, { token: tokenA });
		expect(pub.json.data.publicKey).toBe(fakePub2);
	});
});

describe('死亡开关 API', () => {
	it('默认未启用（90 天 / 删除）', async () => {
		const res = await api('/my/deadman', { token: tokenA });
		expect(res.json.code).toBe(200);
		expect(res.json.data.enabled).toBe(0);
		expect(res.json.data.inactivityDays).toBe(90);
		expect(res.json.data.action).toBe('delete');
		expect(res.json.data.status).toBe('off');
	});

	it('非法参数一律 400：期限/动作/联系人/内容', async () => {
		const cases = [
			{ inactivityDays: 45, action: 'delete' },
			{ inactivityDays: 30, action: 'explode' },
			{ inactivityDays: 30, action: 'notify', contactEmail: '', message: 'hi' },
			{ inactivityDays: 30, action: 'notify', contactEmail: 'not-an-email', message: 'hi' },
			{ inactivityDays: 30, action: 'notify', contactEmail: 'p11-b@example.com', message: '' },
		];
		for (const body of cases) {
			const res = await api('/my/deadman', { method: 'POST', token: tokenA, body });
			expect(res.json.code).toBe(400);
		}
	});

	it('布防 notify 成功；disable 关闭', async () => {
		const set = await api('/my/deadman', {
			method: 'POST', token: tokenA,
			body: { enabled: true, inactivityDays: 30, action: 'notify', contactEmail: 'p11-b@example.com', message: 'p11 遗言测试' }
		});
		expect(set.json.code).toBe(200);
		expect(set.json.data.enabled).toBe(1);
		expect(set.json.data.status).toBe('armed');
		expect(set.json.data.contactEmail).toBe('p11-b@example.com');
		const off = await api('/my/deadman/disable', { method: 'POST', token: tokenA });
		expect(off.json.code).toBe(200);
		expect(off.json.data.enabled).toBe(0);
		expect(off.json.data.status).toBe('off');
	});
});

describe('死亡开关 cron 检查全流程', () => {
	it('刚布防、未失联 → check() 不提醒不执行', async () => {
		await api('/my/deadman', {
			method: 'POST', token: tokenA,
			body: { enabled: true, inactivityDays: 30, action: 'notify', contactEmail: 'p11-b@example.com', message: 'p11 遗言测试' }
		});
		const result = await deadmanService.check(fakeCtx());
		expect(result.checked).toBeGreaterThanOrEqual(1);
		expect(result.reminded).toBe(0);
		expect(result.executed).toBe(0);
		const row = await deadmanRow(userIdA);
		expect(row.warned_at).toBe('');
	});

	it('失联 25 天（满提醒线 23 天、未满期限 30 天）→ 发提醒给本人，warned_at 留痕；再查一次不重复提醒、不执行', async () => {
		// 注意：本测试池每个 it 用例之间不保留 D1 写入（快照回滚），开关须在本用例内重建。
		await api('/my/deadman', {
			method: 'POST', token: tokenA,
			body: { enabled: true, inactivityDays: 30, action: 'notify', contactEmail: 'p11-b@example.com', message: 'p11 遗言测试' }
		});
		await setActiveDaysAgo(userIdA, 25);
		const result = await deadmanService.check(fakeCtx());
		expect(result.reminded).toBe(1);
		expect(result.executed).toBe(0);
		const row = await deadmanRow(userIdA);
		expect(row.warned_at).not.toBe('');
		expect(row.status).toBe('warned');
		const reminder = await env.db.prepare(
			`SELECT subject FROM email WHERE user_id = ? AND type = 0 AND subject LIKE '%死亡开关%'`
		).bind(userIdA).first();
		expect(reminder).toBeTruthy();
		// 第二次检查：已提醒、未满期限 → 只等，不重复提醒、不执行
		const again = await deadmanService.check(fakeCtx());
		expect(again.reminded).toBe(0);
		expect(again.executed).toBe(0);
	});

	it('失联 35 天 + 提醒已发 8 天 → 执行 notify：B 收到遗言信，开关标记 executed + 关闭', async () => {
		// 注意：本测试池每个 it 用例之间不保留 D1 写入（快照回滚），全流程须在本用例内走完：
		// 布防 → 失联 25 天发提醒 → 失联 35 天且提醒满 8 天执行。
		await api('/my/deadman', {
			method: 'POST', token: tokenA,
			body: { enabled: true, inactivityDays: 30, action: 'notify', contactEmail: 'p11-b@example.com', message: 'p11 遗言测试' }
		});
		await setActiveDaysAgo(userIdA, 25);
		const reminded = await deadmanService.check(fakeCtx());
		expect(reminded.reminded).toBe(1);
		await setActiveDaysAgo(userIdA, 35);
		await setWarnedDaysAgo(userIdA, 8);
		const result = await deadmanService.check(fakeCtx());
		expect(result.executed).toBe(1);
		const note = await env.db.prepare(
			`SELECT text FROM email WHERE user_id = ? AND type = 0 AND text = 'p11 遗言测试'`
		).bind(userIdB).first();
		expect(note).toBeTruthy();
		const row = await deadmanRow(userIdA);
		expect(row.enabled).toBe(0);
		expect(row.status).toBe('executed');
		expect(row.executed_at).not.toBe('');
		// A 本人未被删除（notify 动作不删号）
		expect(await userRow(userIdA)).toBeTruthy();
	});

	it('删除动作：失联 35 天 + 提醒已发 8 天 → 账号与邮件全删，开关行随账号一起清掉', async () => {
		await api('/my/deadman', {
			method: 'POST', token: tokenC,
			body: { enabled: true, inactivityDays: 30, action: 'delete' }
		});
		// 给 C 先留一封信，验证执行后连信一起删
		await api('/email/send', {
			method: 'POST', token: tokenC,
			body: { accountId: accountIdC, receiveEmail: ['p11-b@example.com'], subject: 'p11 c mail', text: 'c', content: 'c' }
		});
		await setActiveDaysAgo(userIdC, 35);
		// 手动把 warned_at 置为 8 天前（跳过提醒等待，直接到执行线）
		await env.db.prepare(`UPDATE dead_man_switch SET warned_at = ? WHERE user_id = ?`).bind(daysAgoSql(8), userIdC).run();
		const result = await deadmanService.check(fakeCtx());
		expect(result.executed).toBe(1);
		expect(await userRow(userIdC)).toBeFalsy();
		const mails = await env.db.prepare(`SELECT COUNT(*) AS n FROM email WHERE user_id = ?`).bind(userIdC).first();
		expect(mails.n).toBe(0);
		expect(await deadmanRow(userIdC)).toBeFalsy();
	});

	it('重新活跃后状态机归零：提醒过、再登录 → warned_at 清掉，不凭旧提醒执行', async () => {
		await api('/my/deadman', {
			method: 'POST', token: tokenD,
			body: { enabled: true, inactivityDays: 30, action: 'notify', contactEmail: 'p11-b@example.com', message: 'p11 d 遗言' }
		});
		await setActiveDaysAgo(userIdD, 25);
		const first = await deadmanService.check(fakeCtx());
		expect(first.reminded).toBe(1);
		expect((await deadmanRow(userIdD)).warned_at).not.toBe('');
		// 模拟用户重新登录（active_time 刷新回现在）
		await env.db.prepare(`UPDATE user SET active_time = datetime('now') WHERE user_id = ?`).bind(userIdD).run();
		const second = await deadmanService.check(fakeCtx());
		expect(second.reminded).toBe(0);
		expect(second.executed).toBe(0);
		const row = await deadmanRow(userIdD);
		expect(row.warned_at).toBe('');
		expect(row.status).toBe('armed');
		// B 没有收到 D 的遗言信（未执行）
		const note = await env.db.prepare(
			`SELECT COUNT(*) AS n FROM email WHERE user_id = ? AND type = 0 AND text = 'p11 d 遗言'`
		).bind(userIdB).first();
		expect(note.n).toBe(0);
	});
});
