// Phase 7 发信容灾测试：CF→Resend 自动回落。
// Service 级测试（直接调 emailService.sendCloudflare），mock c.env.email.send
// 抛错、mock Resend（vi.mock('resend')），不调真实服务；D1/KV 用本地 miniflare。
// 注意：vitest.config.js 指向的 wrangler.jsonc 没有 send_email 绑定，
// 故用 fakeCtx 自带 mock 的 email 绑定；Resend Key 经 context.resendToken 传入。
// 运行：mail-worker 下 npx vitest run test/phase7-failover.spec.js。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import emailService from '../src/service/email-service';

const TEST_JWT_SECRET = 'phase1-local-test-only-not-a-real-secret';
const CF_ERROR = 'destination address is not a verified address';
const RESEND_TOKEN = 're_test_key';

// Resend mock：行为由测试用例改 behavior 控制（ok | throw | error）。
const resendMock = vi.hoisted(() => ({
	calls: [],
	behavior: 'ok',
	nextId: 1
}));

vi.mock('resend', () => {
	class MockResend {
		constructor(token) {
			this.token = token;
			resendMock.calls.push({ kind: 'ctor', token });
		}
		emails = {
			send: async (form) => {
				resendMock.calls.push({ kind: 'emails.send', form });
				if (resendMock.behavior === 'throw') throw new Error('resend boom');
				if (resendMock.behavior === 'error') return { data: null, error: { message: 'resend api error' } };
				return { data: { id: `re_mock_${resendMock.nextId++}` }, error: null };
			}
		};
		batch = {
			send: async () => { throw new Error('failover must not use batch send'); }
		};
	}
	return { Resend: MockResend };
});

// CF email 绑定 mock：行为由测试用例控制（ok | throw | fail-address）。
const cfMock = {
	calls: [],
	behavior: 'ok',
	failAddress: null
};

function makeEmailBinding() {
	return {
		send: async (form) => {
			cfMock.calls.push(form);
			if (cfMock.behavior === 'throw') throw new Error(CF_ERROR);
			if (cfMock.behavior === 'fail-address' && form.to.includes(cfMock.failAddress)) {
				throw new Error(CF_ERROR);
			}
			return { messageId: `cf_mock_${cfMock.calls.length}` };
		}
	};
}

function fakeCtx() {
	return {
		env: { ...env, email: makeEmailBinding() },
		req: { header: () => null },
		get: () => undefined,
		set: () => {}
	};
}

function makeContext({ separate = false, recipients, resendToken = RESEND_TOKEN }) {
	return {
		separate,
		resendToken,
		sendParams: {
			name: 'Tester',
			accountEmail: 'sender@example.com',
			receiveEmail: recipients,
			subject: 'failover test',
			text: 'hi',
			html: '<p>hi</p>',
			attachments: [],
			sendType: 'send',
			messageId: null
		},
		saveParams: {
			accountId: 1, userId: 1, name: 'Tester', subject: 'failover test',
			text: 'hi', html: '<p>hi</p>', sendEmail: 'sender@example.com',
			messageId: null, sendType: 'send', useCloudflareEmail: true,
			roleRow: {}, r2Domain: '', imageDataList: [], attachments: [], e2ee: 0
		}
	};
}

// 统一消费 sendCloudflare 生成器：普通模式抛错与分开模式 yield error 都归一为 error。
async function runSendCloudflare(c, context) {
	const emails = [];
	let error = null;
	try {
		for await (const delivery of emailService.sendCloudflare(c, context)) {
			if (delivery.error) {
				error = new Error(delivery.error.message);
				break;
			}
			emails.push(...delivery.emails);
		}
	} catch (e) {
		error = e;
	}
	return { emails, error };
}

async function sentEmails() {
	const rows = await env.db.prepare(
		`SELECT email_id, status, resend_email_id, recipient FROM email WHERE type = 1 ORDER BY email_id`
	).all();
	return rows.results;
}

async function failoverAlerts() {
	const rows = await env.db.prepare(
		`SELECT log_id, type, text FROM alert_log WHERE type = 'failover' ORDER BY log_id`
	).all();
	return rows.results;
}

function todayStr() {
	return new Date().toISOString().slice(0, 10);
}

beforeAll(async () => {
	await SELF.fetch('http://example.com/api/init', { headers: { Authorization: `Bearer ${TEST_JWT_SECRET}` } });
	// Resend 配额放宽，避免预算干扰回落逻辑本身（配额不够的用例单独写 KV 撞线）。
	const cached = (await env.kv.get('setting:', { type: 'json' })) || {};
	cached.resendDayBudget = 100000;
	cached.resendMonthBudget = 100000;
	await env.kv.put('setting:', JSON.stringify(cached));
}, 30000);

beforeEach(async () => {
	cfMock.calls = [];
	cfMock.behavior = 'ok';
	cfMock.failAddress = null;
	resendMock.calls = [];
	resendMock.behavior = 'ok';
	await env.kv.delete(`resend_day:${todayStr()}`);
	await env.kv.delete(`resend_month:${todayStr().slice(0, 7)}`);
});

describe('CF→Resend 自动回落', () => {
	it('CF 成功不回落：不调 Resend、不计配额、状态 DELIVERED', async () => {
		const c = fakeCtx();
		const { emails, error } = await runSendCloudflare(c, makeContext({ recipients: ['outside@other.com'] }));
		expect(error).toBeNull();
		expect(emails).toHaveLength(1);
		expect(emails[0].status).toBe(2); // DELIVERED
		expect(emails[0].resendEmailId).toBe('cf_mock_1');
		expect(cfMock.calls).toHaveLength(1);
		expect(resendMock.calls).toHaveLength(0);
		expect(await env.kv.get(`resend_day:${todayStr()}`)).toBeNull();
		expect(await failoverAlerts()).toHaveLength(0);
	});

	it('CF 抛错→Resend 成功：只走 Resend，状态 SENT，记 Resend id', async () => {
		cfMock.behavior = 'throw';
		const c = fakeCtx();
		const { emails, error } = await runSendCloudflare(c, makeContext({ recipients: ['outside@other.com'] }));
		expect(error).toBeNull();
		expect(emails).toHaveLength(1);
		expect(emails[0].status).toBe(1); // SENT（Resend 渠道，不是 CF 的 DELIVERED）
		expect(emails[0].resendEmailId).toBe('re_mock_1');
		const sends = resendMock.calls.filter(call => call.kind === 'emails.send');
		expect(sends).toHaveLength(1);
		expect(sends[0].form.to).toEqual(['outside@other.com']);
		expect(resendMock.calls.find(call => call.kind === 'ctor').token).toBe(RESEND_TOKEN);
		// 回落成功按实际收件人数计配额
		expect(Number(await env.kv.get(`resend_day:${todayStr()}`))).toBe(1);
	});

	it('CF 抛错→无 Resend Key→返回原始 CF 错误，不调 Resend、不写记录', async () => {
		cfMock.behavior = 'throw';
		const c = fakeCtx();
		const { emails, error } = await runSendCloudflare(c, makeContext({ recipients: ['outside@other.com'], resendToken: null }));
		expect(error).not.toBeNull();
		expect(error.message).toBe(CF_ERROR);
		expect(emails).toHaveLength(0);
		expect(resendMock.calls).toHaveLength(0);
		expect(await sentEmails()).toHaveLength(0);
	});

	it('CF 抛错→配额不够→不切 Resend，返回原始错误，配额计数不动', async () => {
		cfMock.behavior = 'throw';
		const dayKey = `resend_day:${todayStr()}`;
		await env.kv.put(dayKey, '100000'); // 撞上 beforeAll 放宽后的日预算
		const c = fakeCtx();
		const { emails, error } = await runSendCloudflare(c, makeContext({ recipients: ['outside@other.com'] }));
		expect(error).not.toBeNull();
		expect(error.message).toBe(CF_ERROR);
		expect(emails).toHaveLength(0);
		expect(resendMock.calls).toHaveLength(0);
		expect(await sentEmails()).toHaveLength(0);
		expect(await env.kv.get(dayKey)).toBe('100000');
	});

	it('分开发送：CF 只失败 1 人→只重发该人，成功的 2 人不重复投递', async () => {
		cfMock.behavior = 'fail-address';
		cfMock.failAddress = 'b@other.com';
		const c = fakeCtx();
		const recipients = ['a@other.com', 'b@other.com', 'c@other.com'];
		const { emails, error } = await runSendCloudflare(c, makeContext({ separate: true, recipients }));
		expect(error).toBeNull();
		expect(emails).toHaveLength(3);
		// a、c 走 CF（DELIVERED + CF id），b 走 Resend 回落（SENT + Resend id）
		const byRecipient = {};
		for (const row of emails) {
			const address = JSON.parse(row.recipient)[0].address;
			byRecipient[address] = row;
		}
		expect(byRecipient['a@other.com'].status).toBe(2);
		expect(byRecipient['a@other.com'].resendEmailId).toMatch(/^cf_mock_/);
		expect(byRecipient['b@other.com'].status).toBe(1);
		expect(byRecipient['b@other.com'].resendEmailId).toMatch(/^re_mock_/);
		expect(byRecipient['c@other.com'].status).toBe(2);
		expect(byRecipient['c@other.com'].resendEmailId).toMatch(/^cf_mock_/);
		// Resend 只被调 1 次且只发给 b；CF 调了 3 次（每人 1 次）
		const sends = resendMock.calls.filter(call => call.kind === 'emails.send');
		expect(sends).toHaveLength(1);
		expect(sends[0].form.to).toEqual(['b@other.com']);
		expect(cfMock.calls).toHaveLength(3);
	});

	it('回落本身抛错→返回原始 CF 错误，不写发送记录', async () => {
		cfMock.behavior = 'throw';
		resendMock.behavior = 'throw';
		const c = fakeCtx();
		const { emails, error } = await runSendCloudflare(c, makeContext({ recipients: ['outside@other.com'] }));
		expect(error).not.toBeNull();
		expect(error.message).toBe(CF_ERROR); // 原始 CF 错误，不被 Resend 的 'resend boom' 掩盖
		expect(emails).toHaveLength(0);
		expect(resendMock.calls.filter(call => call.kind === 'emails.send')).toHaveLength(1);
		expect(await sentEmails()).toHaveLength(0);
		const alerts = await failoverAlerts();
		expect(alerts.length).toBeGreaterThanOrEqual(1);
		expect(alerts[0].text).toContain('Resend 回落也失败');
	});

	it('Resend 返回 error 对象也视为回落失败→返回原始 CF 错误', async () => {
		cfMock.behavior = 'throw';
		resendMock.behavior = 'error';
		const c = fakeCtx();
		const { emails, error } = await runSendCloudflare(c, makeContext({ recipients: ['outside@other.com'] }));
		expect(error).not.toBeNull();
		expect(error.message).toBe(CF_ERROR);
		expect(emails).toHaveLength(0);
		expect(await sentEmails()).toHaveLength(0);
		const alerts = await failoverAlerts();
		expect(alerts.length).toBeGreaterThanOrEqual(1);
		expect(alerts[0].text).toContain('resend api error');
	});

	it('回落触发日志/告警记录：alert_log type=failover，含 CF 失败与 Resend 发出信息', async () => {
		cfMock.behavior = 'throw';
		const c = fakeCtx();
		const { error } = await runSendCloudflare(c, makeContext({ recipients: ['outside@other.com'] }));
		expect(error).toBeNull();
		const alerts = await failoverAlerts();
		expect(alerts).toHaveLength(1);
		expect(alerts[0].type).toBe('failover');
		expect(alerts[0].text).toContain('发信回落 CF→Resend');
		expect(alerts[0].text).toContain('sender@example.com');
		expect(alerts[0].text).toContain('outside@other.com');
		expect(alerts[0].text).toContain(CF_ERROR);
		expect(alerts[0].text).toContain('Resend 已发出');
		// 测试环境未配 tgBotToken/tgChatId，sendAlert 只写库不发 TG（复用现有行为）。
	});
});
