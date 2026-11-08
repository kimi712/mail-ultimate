// Phase 7 壁纸系统测试：vitest + @cloudflare/vitest-pool-workers。
// 覆盖：v3_10DB 迁移（user.wallpaper / user.wallpaper_tags 列）、
// GET/POST /my/wallpaper 偏好往返与非法值拒绝、
// POST /wallpaper/upload（格式/2MB 校验、R2 路径与 /oss/ 可访问 URL、未登录拒绝）。
// 写法复用 test/phase2a.spec.js 的 fakeCtx/api/register/login/setSetting。
// 运行：mail-worker 下 npx vitest run test/phase7-wallpaper.spec.js。
// 注意：跑在本地 miniflare（wrangler.jsonc 占位绑定），不连线上 D1/KV；
// 未绑 R2 时上传走 r2Service 的 KV 回落（与 setBackground 一致），/oss/ 读回即验证该路径。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

const IP_A = '203.0.113.31';

async function api(path, { method = 'GET', body, token, ip, rawHeaders } = {}) {
	const headers = rawHeaders || { 'Content-Type': 'application/json' };
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

const SETTING_COLUMN_MAP = {
	registerVerify: 'register_verify'
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

let initText = '';
let token = '';
let userId = 0;

beforeAll(async () => {
	// /init 的 secret 取 worker env（wrangler.jsonc vars.jwt_secret，本地测试 dummy），
	// 不在测试文件里硬编码。
	const res = await SELF.fetch(`http://example.com/api/init/${env.jwt_secret}`);
	initText = await res.text();
	// 关 Turnstile 验证（register_verify=CLOSE），只测本路逻辑
	await setSetting({ registerVerify: 1 });

	const reg = await register('p7-wallpaper@example.com', IP_A);
	expect(reg.json.code).toBe(200);
	const loginRes = await login('p7-wallpaper@example.com', IP_A);
	expect(loginRes.json.code).toBe(200);
	token = loginRes.json.data.token;
	const row = await env.db.prepare(
		`SELECT user_id FROM user WHERE email = 'p7-wallpaper@example.com'`
	).first();
	userId = row.user_id;
}, 30000);

// 1x1 透明 PNG（data URL）
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=';
// 1x1 透明 GIF（不在允许格式内）
const TINY_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

describe('v3_10DB 迁移', () => {
	it('init 成功', () => {
		expect(initText).toBe('success');
	});

	it('user.wallpaper / user.wallpaper_tags 列已建', async () => {
		const { results } = await env.db.prepare(`SELECT name FROM pragma_table_info('user')`).all();
		const names = results.map((r) => r.name);
		expect(names).toContain('wallpaper');
		expect(names).toContain('wallpaper_tags');
	});
});

describe('壁纸偏好 /my/wallpaper（复用 user.locale 机制）', () => {
	it('默认空值：wallpaper 为空、wallpaperTags 为空数组', async () => {
		const res = await api('/my/wallpaper', { token });
		expect(res.json.code).toBe(200);
		expect(res.json.data.wallpaper).toBe('');
		expect(res.json.data.wallpaperTags).toEqual([]);
	});

	it('POST 预置 id + 喜好标签后 GET 读回，DB 同步', async () => {
		const set = await api('/my/wallpaper', {
			method: 'POST',
			token,
			body: { wallpaper: 'starry-sky', wallpaperTags: ['隐私', '电影感'] }
		});
		expect(set.json.code).toBe(200);
		const after = await api('/my/wallpaper', { token });
		expect(after.json.data.wallpaper).toBe('starry-sky');
		expect(after.json.data.wallpaperTags).toEqual(['隐私', '电影感']);
		const row = await env.db.prepare(
			`SELECT wallpaper, wallpaper_tags FROM user WHERE user_id = ?`
		).bind(userId).first();
		expect(row.wallpaper).toBe('starry-sky');
		expect(row.wallpaper_tags).toBe('隐私,电影感');
	});

	it('POST 自定义上传 URL 可存', async () => {
		const url = `/oss/wallpapers/${userId}/1234567890.jpg`;
		const set = await api('/my/wallpaper', {
			method: 'POST',
			token,
			body: { wallpaper: url, wallpaperTags: [] }
		});
		expect(set.json.code).toBe(200);
		const after = await api('/my/wallpaper', { token });
		expect(after.json.data.wallpaper).toBe(url);
	});

	it('非法 wallpaper 值被拒绝：路径穿越 / 含空格 / 过长', async () => {
		for (const bad of ['../secret', 'starry sky', 'x'.repeat(513), '/etc/passwd']) {
			const res = await api('/my/wallpaper', {
				method: 'POST',
				token,
				body: { wallpaper: bad, wallpaperTags: [] }
			});
			expect(res.json.code).toBe(400);
		}
	});

	it('非法喜好标签被拒绝：超 10 个 / 含逗号 / 单项超 20 字', async () => {
		const cases = [
			Array.from({ length: 11 }, (_, i) => `tag${i}`),
			['a,b'],
			['x'.repeat(21)]
		];
		for (const tags of cases) {
			const res = await api('/my/wallpaper', {
				method: 'POST',
				token,
				body: { wallpaper: '', wallpaperTags: tags }
			});
			expect(res.json.code).toBe(400);
		}
	});

	it('未登录读偏好被拒绝', async () => {
		const res = await api('/my/wallpaper', {});
		expect(res.status === 401 || res.json?.code === 401).toBe(true);
	});
});

describe('自定义上传 POST /wallpaper/upload', () => {
	it('未登录被拒绝', async () => {
		const res = await api('/wallpaper/upload', { method: 'POST', body: { image: TINY_PNG } });
		expect(res.status === 401 || res.json?.code === 401).toBe(true);
	});

	it('合法 PNG 上传成功：返回 wallpapers/{userId}/{时间戳}.png 与 /oss/ URL，且可读回', async () => {
		const res = await api('/wallpaper/upload', { method: 'POST', token, body: { image: TINY_PNG } });
		expect(res.json.code).toBe(200);
		const { key, url } = res.json.data;
		expect(key).toMatch(new RegExp(`^wallpapers/${userId}/\\d+\\.png$`));
		expect(url).toBe(`/oss/${key}`);
		// /oss/ 读回（本站代理；测试环境走 KV 回落存储）
		const got = await SELF.fetch(`http://example.com/${url.slice(1)}`);
		expect(got.status).toBe(200);
		expect(got.headers.get('Content-Type')).toContain('image/png');
	});

	it('非法格式被拒绝：GIF / 非 data URL / 空 body', async () => {
		for (const body of [{ image: TINY_GIF }, { image: 'not-a-data-url' }, {}]) {
			const res = await api('/wallpaper/upload', { method: 'POST', token, body });
			expect(res.json.code).toBe(400);
		}
	});

	it('超 2MB 被拒绝', async () => {
		// 'A' 为合法 base64 字符，约 2.8M 字符解码后约 2.1MB
		const big = 'data:image/png;base64,' + 'A'.repeat(2800000);
		const res = await api('/wallpaper/upload', { method: 'POST', token, body: { image: big } });
		expect(res.json.code).toBe(400);
	});
});
