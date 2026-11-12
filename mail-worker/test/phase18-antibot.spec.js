// Phase 18 防批量薅号测试（v3_18DB）：vitest + @cloudflare/vitest-pool-workers。
// 覆盖：v3_18DB 迁移、UA 硬拒、9 位随机名 + 空白 UA + 集中注册（完整浏览器 UA 豁免）、
// 段级限流（24h 与 7 天累积）、UA 记录缺口修复（占位行/成功行都写真实 UA）。
// 注：每日自动清理层已按 2026-11-12 用户改令砍掉（服务、cron 挂接与相关用例均已删）。
//
// 说明：只测新站逻辑；老站（flame.edu.kg）一行不改、不部署。
// 运行：mail-worker 下 TZ=UTC npx vitest run test/phase18-antibot.spec.js。
// 注意：本文件跑在本地 miniflare（wrangler.jsonc 占位绑定），不连线上 D1/KV。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import reqUtils from '../src/utils/req-utils';
import { isBotUa, isBlankUa, isBotRegisterUa, isRandom9Name } from '../src/utils/bot-fingerprint';

const TEST_JWT_SECRET = 'phase1-local-test-only-not-a-real-secret';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BOT_UA = 'Mozilla/5.0';

function api(path, { method = 'GET', body, token, ip, ua } = {}) {
	const headers = { 'Content-Type': 'application/json' };
	if (token) headers['Authorization'] = token;
	if (ip) headers['CF-Connecting-IP'] = ip;
	if (ua !== undefined) headers['User-Agent'] = ua;
	return SELF.fetch(`http://example.com/api${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body)
	}).then(async (res) => {
		let json = null;
		try { json = await res.json(); } catch (e) { /* 非 JSON 忽略 */ }
		return { status: res.status, json };
	});
}

// ua 缺省 = 不发 User-Agent 头（服务端读到空白，与脚本/curl 行为一致）。
async function register(email, ip, extra = {}) {
	const { ua, ...body } = extra;
	return api('/register', {
		method: 'POST',
		ip,
		ua,
		body: { email, password: 'password123', ...body }
	});
}

// setting 字段（camelCase）同时写 D1 与 KV 缓存（复用 phase1.spec.js 的口径）。
const SETTING_COLUMN_MAP = {
	register: 'register',
	registerVerify: 'register_verify',
	regKey: 'reg_key',
	secretKey: 'secret_key',
	siteKey: 'site_key',
	ipRegLimit: 'ip_reg_limit',
	ipRegWindowHours: 'ip_reg_window_hours',
	regRateLimitPerMin: 'reg_rate_limit_per_min',
	regCircuitThreshold: 'reg_circuit_threshold',
	regCircuitOpen: 'reg_circuit_open',
	regSegmentLimit: 'reg_segment_limit'
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

function todayStr() {
	return new Date().toISOString().slice(0, 10);
}

let initText = '';
beforeAll(async () => {
	const res = await SELF.fetch(`http://example.com/api/init/${TEST_JWT_SECRET}`);
	initText = await res.text();
	// 关 Turnstile 验证（registerVerify=CLOSE），只测门禁本身；熔断阈值抬高，避免多注册测试误触。
	await setSetting({ registerVerify: 1, regCircuitThreshold: 999999, regSegmentLimit: 9 });
}, 30000);

describe('v3_18DB 迁移', () => {
	it('init 成功', () => {
		expect(initText).toBe('success');
	});

	it('setting 新列 reg_segment_limit 已建', async () => {
		const { results } = await env.db.prepare(`SELECT name FROM pragma_table_info('setting')`).all();
		expect(results.map((r) => r.name)).toContain('reg_segment_limit');
		const row = await env.db.prepare(`SELECT reg_segment_limit FROM setting LIMIT 1`).first();
		expect(row.reg_segment_limit).toBe(9);
	});

	it('register_log 新列 ip_subnet 与新索引已建', async () => {
		const { results } = await env.db.prepare(`SELECT name FROM pragma_table_info('register_log')`).all();
		expect(results.map((r) => r.name)).toContain('ip_subnet');
		const idx = await env.db.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_register_log_subnet_time', 'idx_user_create_time')`
		).all();
		expect(idx.results.map((r) => r.name).sort()).toEqual(['idx_register_log_subnet_time', 'idx_user_create_time']);
	});
});

describe('指纹纯函数', () => {
	it('isBotUa 只认恰好等于 "Mozilla/5.0"', () => {
		expect(isBotUa('Mozilla/5.0')).toBe(true);
		expect(isBotUa('  Mozilla/5.0  ')).toBe(true);
		expect(isBotUa(CHROME_UA)).toBe(false);
		expect(isBotUa('')).toBe(false);
		expect(isBotUa(null)).toBe(false);
	});

	it('空白 UA 单独不是机器人信号', () => {
		expect(isBlankUa('')).toBe(true);
		expect(isBlankUa(null)).toBe(true);
		expect(isBlankUa(BOT_UA)).toBe(false);
		expect(isBlankUa(CHROME_UA)).toBe(false);
	});

	it('isBotRegisterUa：空白或 "Mozilla/5.0" 才算', () => {
		expect(isBotRegisterUa('')).toBe(true);
		expect(isBotRegisterUa(BOT_UA)).toBe(true);
		expect(isBotRegisterUa(CHROME_UA)).toBe(false);
	});

	it('isRandom9Name：9 位无词义随机串（无“≥3 字母且含元音”的词块）', () => {
		// 机器人实测样本：均匀随机串，没有可读词块
		expect(isRandom9Name('a1b2c3d4e')).toBe(true);
		expect(isRandom9Name('A01nkhb3s')).toBe(true);
		expect(isRandom9Name('000r2s46v')).toBe(true);
		expect(isRandom9Name('srjgrzhjl')).toBe(true); // 9 位纯字母、零元音辅音串
		// 真人常用格式：都有可读词块，不算随机串（phase13 回归：burn4user 曾被误拦）
		expect(isRandom9Name('burn4user')).toBe(false); // burn / user 两个词块
		expect(isRandom9Name('liujun202')).toBe(false); // liujun 拼音词块
		expect(isRandom9Name('zhangsan1')).toBe(false); // zhangsan 拼音词块
		expect(isRandom9Name('xiangqian')).toBe(false);
		expect(isRandom9Name('sihongliu')).toBe(false);
		expect(isRandom9Name('Henrypaul')).toBe(false);
		expect(isRandom9Name('something')).toBe(false);
		expect(isRandom9Name('123456789')).toBe(false); // 9 位纯数字不算
		expect(isRandom9Name('a1b2c3d4')).toBe(false); // 8 位
		expect(isRandom9Name('a1b2c3d4e5')).toBe(false); // 10 位
		expect(isRandom9Name('a1b2c3d4-')).toBe(false); // 含符号
	});

	it('getIpSubnet：v4 /24、v6 /48、映射地址按 v4 算', () => {
		expect(reqUtils.getIpSubnet(null, '116.204.166.199')).toBe('116.204.166.0');
		expect(reqUtils.getIpSubnet(null, '203.0.113.1')).toBe('203.0.113.0');
		expect(reqUtils.getIpSubnet(null, '2408:8207:1832:f030::1')).toBe('2408:8207:1832');
		expect(reqUtils.getIpSubnet(null, '::ffff:116.204.166.199')).toBe('116.204.166.0');
		expect(reqUtils.getIpSubnet(null, 'Unknown')).toBe('Unknown');
		expect(reqUtils.getIpSubnet(null, 'not-an-ip')).toBe('not-an-ip');
	});
});

describe('注册门禁：机器人 UA 与随机名', () => {
	it('UA 恰好等于 "Mozilla/5.0" 直接被拒，不建号', async () => {
		const res = await register('botua1@example.com', '203.0.113.51', { ua: BOT_UA });
		expect(res.json.code).not.toBe(200);
		expect(res.json.message).toContain('浏览器标识异常');
		const row = await env.db.prepare(`SELECT user_id FROM user WHERE email = 'botua1@example.com'`).first();
		expect(row).toBeNull();
	});

	it('空白 UA 单次注册不拦（真人流量里也有大量空白 UA）', async () => {
		const res = await register('blankua1@example.com', '203.0.113.52');
		expect(res.json.code).toBe(200);
	});

	it('完整浏览器 UA 的 9 位随机名同 IP 连注两次不受名规则影响', async () => {
		const ip = '203.0.113.53';
		const r1 = await register('e5f6g7h8i@example.com', ip, { ua: CHROME_UA });
		expect(r1.json.code).toBe(200);
		const r2 = await register('f6g7h8i9j@example.com', ip, { ua: CHROME_UA });
		expect(r2.json.code).toBe(200);
	});

	it('9 位随机名 + 空白 UA + 同 IP 10 分钟内第 2 次被拒', async () => {
		const ip = '203.0.113.54';
		const r1 = await register('g7h8i9j0k@example.com', ip, { ua: CHROME_UA });
		expect(r1.json.code).toBe(200);
		// 空白 UA 的第 2 次：同 IP 10 分钟内已有 1 次成功 + 本次占位 = 2，命中名规则
		const r2 = await register('h8i9j0k1l@example.com', ip);
		expect(r2.json.code).not.toBe(200);
		expect(r2.json.message).toContain('过于频繁');
	});

	it('纯字母 9 位真名 + 空白 UA + 同 IP 连注不被名规则拦', async () => {
		const ip = '203.0.113.55';
		const r1 = await register('xiangqian@example.com', ip);
		expect(r1.json.code).toBe(200);
		const r2 = await register('sihongliu@example.com', ip);
		expect(r2.json.code).toBe(200);
	});
});

describe('注册门禁：段级限流', () => {
	it('同 /24 段 24 小时内第 10 个注册被拒（阈值临时调成 3）', async () => {
		await setSetting({ regSegmentLimit: 3 });
		try {
			for (let i = 1; i <= 3; i++) {
				const res = await register(`seg${i}@example.com`, `203.0.114.${10 + i}`, { ua: CHROME_UA });
				expect(res.json.code).toBe(200);
			}
			const res = await register('seg4@example.com', '203.0.114.14', { ua: CHROME_UA });
			expect(res.json.code).not.toBe(200);
			expect(res.json.message).toContain('网段');
			// register_log.ip_subnet 已写入 /24 键
			const row = await env.db.prepare(
				`SELECT ip_subnet FROM register_log WHERE email = 'seg1@example.com' ORDER BY log_id DESC LIMIT 1`
			).first();
			expect(row.ip_subnet).toBe('203.0.114.0');
		} finally {
			await setSetting({ regSegmentLimit: 9 });
		}
	});

	it('7 天累积 cap：同网段 2 天前已攒 27 个，新注册被拒（24h 内为 0）', async () => {
		// 直接播种 27 条两天前的成功日志（同网段 203.0.115.0），不走注册接口（不触熔断/分钟限流）
		for (let i = 0; i < 27; i++) {
			await env.db.prepare(
				`INSERT INTO register_log (ip, ip_segment, ip_subnet, email, result, create_time)
				 VALUES (?, ?, '203.0.115.0', ?, 0, datetime('now', '-2 days'))`
			).bind(`203.0.115.${1 + (i % 250)}`, `203.0.115.${1 + (i % 250)}`, `seed7d${i}@example.com`).run();
		}
		const res = await register('seg7d@example.com', '203.0.115.200', { ua: CHROME_UA });
		expect(res.json.code).not.toBe(200);
		expect(res.json.message).toContain('网段');
		// 清理种子，避免影响后续用例
		await env.db.prepare(`DELETE FROM register_log WHERE email LIKE 'seed7d%@example.com'`).run();
	});
});

describe('注册日志 UA 记录（占位行补 ua）', () => {
	it('成功注册的日志行记下真实 UA（不是空）', async () => {
		const res = await register('ualog1@example.com', '203.0.118.1', { ua: CHROME_UA });
		expect(res.json.code).toBe(200);
		const row = await env.db.prepare(
			`SELECT result, ua FROM register_log WHERE email = 'ualog1@example.com' ORDER BY log_id DESC LIMIT 1`
		).first();
		expect(row.result).toBe(0);
		expect(row.ua).toBe(CHROME_UA);
	});

	it('占位后失败的注册（密码过短）日志行也记下真实 UA', async () => {
		const res = await register('ualog2@example.com', '203.0.118.2', { ua: CHROME_UA, password: '12345' });
		expect(res.json.code).not.toBe(200);
		const row = await env.db.prepare(
			`SELECT result, ua FROM register_log WHERE email = 'ualog2@example.com' ORDER BY log_id DESC LIMIT 1`
		).first();
		expect(row.result).toBe(1);
		expect(row.ua).toBe(CHROME_UA);
	});
});
