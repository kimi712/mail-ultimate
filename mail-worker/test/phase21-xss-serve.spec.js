// Phase 21 白帽反馈第二批测试（2026-11-12 uwu 新发现）：
//   #1 存储型 XSS——/attachments/、/static/、/oss/ 不再原样回吐发件人 mimeType，
//      只放行无害内联类型，其余 octet-stream + 强制下载，并加 nosniff + sandbox CSP；
//   #4 KV 对象键前缀检查——/oss/<key> 只认 attachments/、static/、wallpapers/，
//      运营键（auth-uid:、setting:、public_key: 等）一律 404；
//   #2 /public/* 三个接口已关（genToken、emailList、addUser 均 404）；
//   小项 /init/:secret 已改走 Authorization 请求头。
// 说明：只测新站逻辑；老站一行不改、不部署。
// 运行：mail-worker 下 TZ=UTC npx vitest run test/phase21-xss-serve.spec.js。
// 注意：本文件跑在本地 miniflare（wrangler.jsonc 占位绑定），不连线上 D1/KV。
// 本站实际跑在 KV 上（S3 未配、R2 未绑定），所以这里测的正是生产走的 KV 路。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

const TEST_JWT_SECRET = 'phase1-local-test-only-not-a-real-secret';

async function fetchRaw(path, { method = 'GET', body, headers = {} } = {}) {
	const res = await SELF.fetch(`http://example.com${path}`, {
		method,
		headers: { 'Content-Type': 'application/json', ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return res;
}

async function seedKv(key, content, metadata) {
	await env.kv.put(key, content, { metadata });
}

beforeAll(async () => {
	const res = await SELF.fetch('http://example.com/api/init', {
		headers: { Authorization: `Bearer ${TEST_JWT_SECRET}` },
	});
	const text = await res.text();
	expect(text).toBe('success');
});

describe('#1 附件 serve 头（/attachments/）', () => {
	it('text/html 不再按 HTML 出：octet-stream + 强制下载 + nosniff + sandbox', async () => {
		await seedKv('attachments/00000000000000000000000000000001.html', '<script>alert(1)</script>', {
			contentType: 'text/html',
			contentDisposition: 'inline;filename=x.html',
			cacheControl: 'max-age=259200',
		});
		const res = await fetchRaw('/attachments/00000000000000000000000000000001.html');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/octet-stream');
		expect(res.headers.get('content-disposition')).toBe('attachment');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('content-security-policy')).toBe('sandbox');
		expect(await res.text()).toBe('<script>alert(1)</script>');
	});

	it('image/svg+xml 同样强制下载（SVG 当文档会执行脚本）', async () => {
		await seedKv('attachments/00000000000000000000000000000002.svg', '<svg onload=alert(1)>', {
			contentType: 'image/svg+xml',
			contentDisposition: 'inline;filename=x.svg',
		});
		const res = await fetchRaw('/attachments/00000000000000000000000000000002.svg');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/octet-stream');
		expect(res.headers.get('content-disposition')).toBe('attachment');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('大写带参数的 Text/HTML; charset=utf-8 也被归一化后拦截', async () => {
		await seedKv('attachments/00000000000000000000000000000003.html', '<html>', {
			contentType: 'Text/HTML; charset=utf-8',
			contentDisposition: 'inline;filename=x.html',
		});
		const res = await fetchRaw('/attachments/00000000000000000000000000000003.html');
		expect(res.headers.get('content-type')).toBe('application/octet-stream');
		expect(res.headers.get('content-disposition')).toBe('attachment');
	});

	it('application/pdf 不内联（本站只下载 PDF，不预览）', async () => {
		await seedKv('attachments/00000000000000000000000000000004.pdf', '%PDF-1.4', {
			contentType: 'application/pdf',
			contentDisposition: 'inline;filename=x.pdf',
		});
		const res = await fetchRaw('/attachments/00000000000000000000000000000004.pdf');
		expect(res.headers.get('content-type')).toBe('application/octet-stream');
		expect(res.headers.get('content-disposition')).toBe('attachment');
	});

	it('image/png 照常内联显示（正文内嵌图不受影响），且带 nosniff + sandbox', async () => {
		await seedKv('attachments/00000000000000000000000000000005.png', 'FAKE-PNG-BYTES', {
			contentType: 'image/png',
			contentDisposition: 'inline;filename=x.png',
			cacheControl: 'max-age=259200',
		});
		const res = await fetchRaw('/attachments/00000000000000000000000000000005.png');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('content-disposition')).toBe('inline');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('content-security-policy')).toBe('sandbox');
		expect(res.headers.get('cache-control')).toBe('max-age=259200');
		expect(await res.text()).toBe('FAKE-PNG-BYTES');
	});

	it('text/plain 内联（带 nosniff 不会被嗅探成 HTML）', async () => {
		await seedKv('attachments/00000000000000000000000000000006.txt', 'hello', {
			contentType: 'text/plain',
			contentDisposition: 'inline;filename=x.txt',
		});
		const res = await fetchRaw('/attachments/00000000000000000000000000000006.txt');
		expect(res.headers.get('content-type')).toBe('text/plain');
		expect(res.headers.get('content-disposition')).toBe('inline');
	});

	it('Content-Disposition 不再下发字面 "null"（旧代码把 null 当值传的 bug）', async () => {
		await seedKv('attachments/00000000000000000000000000000007.jpg', 'FAKE-JPG', {
			contentType: 'image/jpeg',
		});
		const res = await fetchRaw('/attachments/00000000000000000000000000000007.jpg');
		expect(res.headers.get('content-disposition')).toBe('inline');
		expect(res.headers.get('content-disposition')).not.toBe('null');
	});
});

describe('#4 /oss/ 只认对象键前缀', () => {
	it('auth-uid:1（会话 token）404，不透露存在', async () => {
		await env.kv.put('auth-uid:1', JSON.stringify({ tokens: ['live-session-token'] }));
		const res = await fetchRaw('/oss/auth-uid:1');
		expect(res.status).toBe(404);
	});

	it('setting:（设置缓存）404', async () => {
		await env.kv.put('setting:', JSON.stringify({ domain: ['example.com'] }));
		const res = await fetchRaw('/oss/setting:');
		expect(res.status).toBe(404);
	});

	it('public_key:（全局公共 token）404', async () => {
		await env.kv.put('public_key:', 'some-uuid-token');
		const res = await fetchRaw('/oss/public_key:');
		expect(res.status).toBe(404);
	});

	it('attachments/ 前缀照常出', async () => {
		await seedKv('attachments/00000000000000000000000000000008.png', 'FAKE-PNG', {
			contentType: 'image/png',
			contentDisposition: 'inline;filename=x.png',
		});
		const res = await fetchRaw('/oss/attachments/00000000000000000000000000000008.png');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
	});

	it('wallpapers/ 前缀照常出', async () => {
		await seedKv('wallpapers/1/1700000000000.png', 'FAKE-WALLPAPER', {
			contentType: 'image/png',
			contentDisposition: 'inline',
		});
		const res = await fetchRaw('/oss/wallpapers/1/1700000000000.png');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
	});

	it('static/background/ 前缀照常出', async () => {
		await seedKv('static/background/00000000000000000000000000000009.jpg', 'FAKE-BG', {
			contentType: 'image/jpeg',
			contentDisposition: 'inline',
		});
		const res = await fetchRaw('/oss/static/background/00000000000000000000000000000009.jpg');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/jpeg');
	});

	it('不存在的对象键 404', async () => {
		const res = await fetchRaw('/oss/attachments/does-not-exist.png');
		expect(res.status).toBe(404);
	});
});

describe('#2 /public/* 已关闭', () => {
	// 注意：本应用的错误约定是 HTTP 200 + JSON 错误体（result.fail），
	// 所以“已关”的断言是：接口未成功执行（code ≠ 200、无 data），
	// 而不是 HTTP 404。路由已删，请求在鉴权层就被 authExpired 拦下。
	it('genToken 未执行（无 token 返回）', async () => {
		const res = await fetchRaw('/api/public/genToken', {
			method: 'POST',
			body: { email: 'admin@example.com', password: 'whatever' },
		});
		const json = await res.json();
		expect(json.code).not.toBe(200);
		expect(json.data).toBeFalsy();
	});

	it('emailList 未执行（无邮件列表返回）', async () => {
		const res = await fetchRaw('/api/public/emailList', {
			method: 'POST',
			body: { num: 1, size: 20 },
		});
		const json = await res.json();
		expect(json.code).not.toBe(200);
		expect(json.data).toBeFalsy();
	});

	it('addUser 未执行', async () => {
		const res = await fetchRaw('/api/public/addUser', {
			method: 'POST',
			body: { list: [] },
		});
		const json = await res.json();
		expect(json.code).not.toBe(200);
		expect(json.data).toBeFalsy();
	});
});

describe('小项 /init 改走请求头', () => {
	it('旧 URL 形式 /init/<secret> 已不存在（404）', async () => {
		const res = await fetchRaw(`/api/init/${TEST_JWT_SECRET}`);
		expect(res.status).toBe(404);
	});

	it('无 Authorization 头时拒绝（不跑迁移）', async () => {
		const res = await fetchRaw('/api/init');
		expect(await res.text()).toContain('mismatch');
	});

	it('Authorization: Bearer <secret> 能跑（且幂等）', async () => {
		const res = await fetchRaw('/api/init', {
			headers: { Authorization: `Bearer ${TEST_JWT_SECRET}` },
		});
		expect(await res.text()).toBe('success');
	});
});
