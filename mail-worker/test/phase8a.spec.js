// Phase 8 子代理 A 测试：部署与角色（根因根治，PHASE8-DESIGN.md §8）。
// 覆盖：
//   ① kernel/secrets 启动校验（缺失 / 太短 / dummy / 合法；env 与 ctx 两种入参）；
//   ② 默认角色：新鲜种子为 day/50；旧 ban 行被 v3_11DB 迁移修正；
//      已改过的值（day/100、count/10）不动；/init 幂等；
//   ③ settingService.refresh() 防呆：解密/解析失败时 KV 保留上一次的好值
//      + 写 alert_log，绝不置空 {}；成功路径仍正常更新 KV。
// 运行：mail-worker 下 npx vitest run test/phase8a.spec.js。
// 注意：跑在本地 miniflare（wrangler.jsonc 占位绑定），不连线上 D1/KV。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { validateFieldEncKey, getFieldEncKey, checkFieldEncKey, FIELD_ENC_KEY_MIN_LENGTH } from '../src/kernel/secrets';
import settingService from '../src/service/setting-service';

const TEST_JWT_SECRET = 'phase1-local-test-only-not-a-real-secret';
const VALID_KEY = 'a'.repeat(64);

function fakeCtx() {
	return {
		env,
		get: () => undefined,
		set: () => {}
	};
}

async function runInit() {
	const res = await SELF.fetch(`http://example.com/api/init/${TEST_JWT_SECRET}`);
	return res.text();
}

async function roleRow() {
	return env.db.prepare(`SELECT send_type AS sendType, send_count AS sendCount FROM role WHERE role_id = 1`).first();
}

async function kvSetting() {
	return env.kv.get('setting:', { type: 'json' });
}

let initText = '';
beforeAll(async () => {
	initText = await runInit();
}, 30000);

describe('kernel/secrets 启动校验', () => {
	it('缺失/空值返回 field_enc_key_missing', () => {
		for (const v of [undefined, null, '']) {
			const r = validateFieldEncKey(v);
			expect(r.ok).toBe(false);
			expect(r.code).toBe('field_enc_key_missing');
		}
		expect(validateFieldEncKey(123).code).toBe('field_enc_key_missing');
	});

	it('太短返回 field_enc_key_too_short（不含密钥值）', () => {
		const r = validateFieldEncKey('short-key');
		expect(r.ok).toBe(false);
		expect(r.code).toBe('field_enc_key_too_short');
		expect(r.message).not.toContain('short-key');
	});

	it('本地测试 dummy 值返回 field_enc_key_dummy', () => {
		const r = validateFieldEncKey('phase56-local-test-only-not-a-real-secret');
		expect(r.ok).toBe(false);
		expect(r.code).toBe('field_enc_key_dummy');
	});

	it('长度恰好 32 与更长均合法', () => {
		expect(validateFieldEncKey('k'.repeat(32)).ok).toBe(true);
		expect(validateFieldEncKey(VALID_KEY).ok).toBe(true);
		expect(FIELD_ENC_KEY_MIN_LENGTH).toBe(32);
	});

	it('checkFieldEncKey 接受 env 对象与 Hono 上下文两种入参', () => {
		expect(checkFieldEncKey({ field_enc_key: VALID_KEY }).ok).toBe(true);
		expect(checkFieldEncKey({ env: { field_enc_key: VALID_KEY } }).ok).toBe(true);
		expect(checkFieldEncKey({ env: { field_enc_key: 'phase56-local-test-only-not-a-real-secret' } }).code).toBe('field_enc_key_dummy');
		expect(checkFieldEncKey(null).code).toBe('field_enc_key_missing');
		expect(getFieldEncKey({ env: {} })).toBe('');
	});
});

describe('v3_11DB 默认角色', () => {
	it('init 成功', () => {
		expect(initText).toBe('success');
	});

	it('新鲜种子为 day/50（不再是 ban/NULL）', async () => {
		const row = await roleRow();
		expect(row.sendType).toBe('day');
		expect(row.sendCount).toBe(50);
	});

	it('旧 ban 行被迁移修正为 day/50', async () => {
		await env.db.prepare(`UPDATE role SET send_type = 'ban', send_count = NULL WHERE role_id = 1`).run();
		expect(await runInit()).toBe('success');
		const row = await roleRow();
		expect(row.sendType).toBe('day');
		expect(row.sendCount).toBe(50);
	});

	it('已改过的值不动：day/100 与 count/10', async () => {
		await env.db.prepare(`UPDATE role SET send_type = 'day', send_count = 100 WHERE role_id = 1`).run();
		expect(await runInit()).toBe('success');
		let row = await roleRow();
		expect(row.sendType).toBe('day');
		expect(row.sendCount).toBe(100);

		await env.db.prepare(`UPDATE role SET send_type = 'count', send_count = 10 WHERE role_id = 1`).run();
		expect(await runInit()).toBe('success');
		row = await roleRow();
		expect(row.sendType).toBe('count');
		expect(row.sendCount).toBe(10);
		// 恢复正式决策值，免得影响后续测试文件共用的默认角色预期。
		await env.db.prepare(`UPDATE role SET send_type = 'day', send_count = 50 WHERE role_id = 1`).run();
	});

	it('再跑一次 /init 幂等成功', async () => {
		expect(await runInit()).toBe('success');
		const row = await roleRow();
		expect(row.sendType).toBe('day');
		expect(row.sendCount).toBe(50);
	});
});

describe('settingService.refresh() resendTokens 防呆', () => {
	it('成功路径：D1 明文 JSON 正常写入 KV', async () => {
		await env.db.prepare(`UPDATE setting SET resend_tokens = ?`).bind(JSON.stringify({ 'aevorynthtech.com': 're_new_token_value' })).run();
		await settingService.refresh(fakeCtx());
		const cached = await kvSetting();
		expect(cached.resendTokens).toEqual({ 'aevorynthtech.com': 're_new_token_value' });
	});

	it('解密/解析失败：KV 保留上一次的好值 + 写 alert_log，绝不置空', async () => {
		// 上一次的好值先放进 KV（模拟线上曾成功刷新过的缓存）。
		const prev = (await kvSetting()) || {};
		prev.resendTokens = { 'aevorynthtech.com': 're_previous_good_value' };
		prev.emailPrefixFilter = '';
		await env.kv.put('setting:', JSON.stringify(prev));

		// D1 写一条无法解密的密文：合法 base64、但不是该密钥的有效 AES-GCM
		// 密文——decrypt 原样返回密文原文，JSON.parse 失败，走防呆分支。
		const garbage = btoa(String.fromCharCode(...new Uint8Array(32)));
		await env.db.prepare(`UPDATE setting SET resend_tokens = ?`).bind(`enc:v1:${garbage}`).run();

		await settingService.refresh(fakeCtx());

		const cached = await kvSetting();
		expect(cached.resendTokens).toEqual({ 'aevorynthtech.com': 're_previous_good_value' });

		const alerts = await env.db.prepare(
			`SELECT type, text FROM alert_log WHERE text LIKE '%resendTokens%' ORDER BY log_id DESC LIMIT 1`
		).all();
		expect(alerts.results.length).toBe(1);
		expect(alerts.results[0].type).toBe('system');
		// 告警文本不得含任何密钥值。
		expect(alerts.results[0].text).not.toContain('re_previous_good_value');
		expect(alerts.results[0].text).not.toContain(garbage);

		// 恢复 D1 为干净状态，免得影响后续测试。
		await env.db.prepare(`UPDATE setting SET resend_tokens = '{}'`).run();
		await settingService.refresh(fakeCtx());
		expect((await kvSetting()).resendTokens).toEqual({});
	});
});
