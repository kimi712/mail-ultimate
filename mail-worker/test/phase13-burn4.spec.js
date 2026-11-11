// 斯诺登第四批测试：vitest + @cloudflare/vitest-pool-workers。
// 覆盖：P0-1 EXIF 剥离（JPEG/PNG/WebP/非图片/干净图）、P0-2 管理员审计
// （记高危操作、全局视图过滤、未知操作拒绝、接线覆盖表）、P1-3 阅后
// 即焚加固（burn 仅 E2EE、定时换算、焚毁留痕、核验）、P1-4 登录异常
// （评分、评估、留痕、通知、一键锁定/解锁）、P2-5 别名过期
// （设有效期、拒收判定、到期清扫）、P2-6 发信头最小化（白名单、
// 构造器、删头审计）。
// 运行：mail-worker 下 TZ=UTC npx vitest run test/phase13-burn4.spec.js。
// 注意：本测试池每个 it 之间不保留 D1 写入（快照回滚），每个 DB 用例
// 必须自己做 setup；跨用例共享的只有 beforeAll 建的用户与 token。
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import orm from '../src/entity/orm';
import user from '../src/entity/user';
import email from '../src/entity/email';
import emailAlias from '../src/entity/email-alias';
import aliasExpiry from '../src/entity/alias-expiry';
import loginLog from '../src/entity/login-log';
import knownIp from '../src/entity/known-ip';
import { eq } from 'drizzle-orm';
import { stripExifMetadata, hasExifMetadata } from '../src/utils/exif-strip';
import { minimizeHeaders, buildMinimalSendForm, describeRemovedHeaders } from '../src/utils/header-minimizer';
import adminAuditService from '../src/service/admin-audit-service';
import burnAfterReadingService, { resolveBurnPolicy } from '../src/service/burn-after-reading-service';
import loginAnomalyService, { scoreLoginAttempt, buildAnomalyEmail } from '../src/service/login-anomaly-service';
import aliasExpiryService, { resolveAliasExpiry, isExpiredAt } from '../src/service/alias-expiry-service';
import adminAuditApi from '../src/api/admin-audit-api';
import loginAnomalyApi from '../src/api/login-anomaly-api';
import burnApi from '../src/api/burn-after-reading-api';
import aliasExpiryApi from '../src/api/alias-expiry-api';

const ADMIN_EMAIL = 'admin@example.com';
const USER_EMAIL = 'burn4user@example.com';
const PWD = 'password123';
const KNOWN_IP = '203.0.113.50';
const NEW_IP = '203.0.113.99';
const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const UA_FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0';

async function api(path, { method = 'GET', body, token, ip } = {}) {
	const headers = { 'Content-Type': 'application/json' };
	if (token) headers['Authorization'] = token;
	if (ip) headers['CF-Connecting-IP'] = ip;
	const res = await SELF.fetch(`http://example.com/api${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	let json = null;
	try { json = await res.json(); } catch (e) { /* 非 JSON 忽略 */ }
	return { status: res.status, json };
}

function fakeCtx() {
	return { env, get: () => undefined, set: () => {}, req: { header: () => '' } };
}

async function userIdByEmail(c, emailAddr) {
	const row = await orm(c).select().from(user).where(eq(user.email, emailAddr)).get();
	return row ? row.userId : 0;
}

async function setSetting(fields) {
	const cached = (await env.kv.get('setting:', { type: 'json' })) || {};
	for (const [key, value] of Object.entries(fields)) {
		cached[key] = value;
	}
	await env.kv.put('setting:', JSON.stringify(cached));
}

let ADMIN_ID = 0;
let USER_ID = 0;

beforeAll(async () => {
	const initRes = await SELF.fetch(`http://example.com/api/init/${env.jwt_secret}`);
	expect(await initRes.text()).toBe('success');
	// 关 Turnstile 验证（register_verify=CLOSE），只测本路逻辑
	await setSetting({ registerVerify: 1 });
	const regAdmin = await api('/register', { method: 'POST', ip: KNOWN_IP, body: { email: ADMIN_EMAIL, password: PWD } });
	expect(regAdmin.json.code).toBe(200);
	const regUser = await api('/register', { method: 'POST', ip: KNOWN_IP, body: { email: USER_EMAIL, password: PWD } });
	expect(regUser.json.code).toBe(200);
	const c = fakeCtx();
	ADMIN_ID = await userIdByEmail(c, ADMIN_EMAIL);
	USER_ID = await userIdByEmail(c, USER_EMAIL);
});

// ---------- P0-1：EXIF 剥离（纯函数） ----------

function buildJpegWithExif() {
	// SOI + APP0(JFIF) + APP1(Exif，含 GPS 假数据) + SOS + 扫描数据 + EOI
	const soi = [0xff, 0xd8];
	const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
	const exifPayload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50, 0x53, 0x00, 0x43, 0x61, 0x6e, 0x6f, 0x6e]; // "Exif\0\0" + GPS + Canon
	const app1Len = exifPayload.length + 2;
	const app1 = [0xff, 0xe1, (app1Len >> 8) & 0xff, app1Len & 0xff, ...exifPayload];
	const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x11, 0x22, 0x33, 0xff, 0xd9];
	return Uint8Array.from([...soi, ...app0, ...app1, ...sos]);
}

describe('P0-1 EXIF strip', () => {
	it('JPEG：删 APP1 Exif 段，保留 APP0 与扫描数据', () => {
		const src = buildJpegWithExif();
		expect(hasExifMetadata(src)).toBe(true);
		const r = stripExifMetadata(src);
		expect(r.format).toBe('jpeg');
		expect(r.stripped).toBe(true);
		expect(r.removed).toContain('jpeg:APP1/Exif');
		expect(hasExifMetadata(r.data)).toBe(false);
		// 扫描数据 0x11 0x22 0x33 与 EOI 仍在；JFIF 标识仍在
		const text = Buffer.from(r.data).toString('latin1');
		expect(text).toContain('JFIF');
		expect(text).not.toContain('Exif');
		expect(text).not.toContain('Canon');
		expect(r.data[r.data.length - 5]).toBe(0x11);
		expect(r.data[r.data.length - 4]).toBe(0x22);
		expect(r.data[r.data.length - 3]).toBe(0x33);
		expect(r.data[r.data.length - 2]).toBe(0xff);
		expect(r.data[r.data.length - 1]).toBe(0xd9);
	});

	it('JPEG：无 EXIF 的图原样返回', () => {
		const clean = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
		const r = stripExifMetadata(clean);
		expect(r.stripped).toBe(false);
		expect(r.removed).toEqual([]);
		expect(Buffer.from(r.data).equals(Buffer.from(clean))).toBe(true);
	});

	it('PNG：删 tEXt 与 eXIf 块，保留 IHDR/IDAT/IEND', () => {
		const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		const chunk = (type, data) => {
			const len = data.length;
			const body = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3), ...data, 0, 0, 0, 0];
			return [(len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...body];
		};
		const src = Uint8Array.from([
			...sig,
			...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
			...chunk('tEXt', [...'GPS:31,121'.split('').map(c => c.charCodeAt(0))]),
			...chunk('eXIf', [0x45, 0x78, 0x69, 0x66, 0, 0, 1, 2, 3]),
			...chunk('IDAT', [0x08, 0x99, 0x01, 0x02]),
			...chunk('IEND', []),
		]);
		const r = stripExifMetadata(src);
		expect(r.format).toBe('png');
		expect(r.stripped).toBe(true);
		expect(r.removed).toContain('png:tEXt');
		expect(r.removed).toContain('png:eXIf');
		const text = Buffer.from(r.data).toString('latin1');
		expect(text).toContain('IHDR');
		expect(text).toContain('IDAT');
		expect(text).toContain('IEND');
		expect(text).not.toContain('GPS');
	});

	it('WebP：删 EXIF 块并修正 RIFF 长度', () => {
		const vp8x = [0x56, 0x50, 0x38, 0x58, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
		const exifData = [0x45, 0x78, 0x69, 0x66];
		const exif = [0x45, 0x58, 0x49, 0x46, 0x04, 0, 0, 0, ...exifData];
		const vp8l = [0x56, 0x50, 0x38, 0x4c, 0x02, 0, 0, 0, 0xaa, 0xbb];
		const body = [...vp8x, ...exif, ...vp8l];
		const riffSize = body.length + 4;
		const src = Uint8Array.from([0x52, 0x49, 0x46, 0x46, riffSize & 0xff, (riffSize >> 8) & 0xff, 0, 0, 0x57, 0x45, 0x42, 0x50, ...body]);
		const r = stripExifMetadata(src);
		expect(r.format).toBe('webp');
		expect(r.stripped).toBe(true);
		expect(r.removed).toContain('webp:EXIF');
		const riffLen = r.data[4] | (r.data[5] << 8) | (r.data[6] << 16) | (r.data[7] << 24);
		expect(riffLen).toBe(r.data.length - 8);
		expect(Buffer.from(r.data).toString('latin1')).not.toContain('EXIF');
	});

	it('非图片原样返回，不抛错', () => {
		const src = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
		const r = stripExifMetadata(src);
		expect(r.stripped).toBe(false);
		expect(r.format).toBe('');
		expect(Buffer.from(r.data).equals(Buffer.from(src))).toBe(true);
		expect(stripExifMetadata(null).stripped).toBe(false);
	});
});

// ---------- P2-6：发信头最小化（纯函数） ----------

describe('P2-6 header minimizer', () => {
	it('只保留 in-reply-to/references，其余头全删', () => {
		const { kept, removed } = minimizeHeaders({
			'X-Mailer': 'SnowdenMail 1.0',
			'X-Originating-IP': '1.2.3.4',
			'User-Agent': 'Mozilla/5.0',
			'in-reply-to': '<abc@example.com>',
			'References': '<abc@example.com>',
		});
		expect(kept).toEqual({ 'in-reply-to': '<abc@example.com>', 'References': '<abc@example.com>' });
		expect(removed).toEqual(expect.arrayContaining(['X-Mailer', 'X-Originating-IP', 'User-Agent']));
		expect(removed).not.toContain('in-reply-to');
	});

	it('buildMinimalSendForm：回复带线程头，非回复不带 headers', () => {
		const reply = buildMinimalSendForm({
			name: 'A', accountEmail: 'a@example.com', receiveEmail: ['b@example.com'],
			subject: 'Re: hi', text: 'hi', html: '<p>hi</p>', sendType: 'reply', messageId: '<m@example.com>',
		});
		expect(reply.headers).toEqual({ 'in-reply-to': '<m@example.com>', references: '<m@example.com>' });
		expect(reply.from).toBe('A <a@example.com>');
		const normal = buildMinimalSendForm({
			name: 'A', accountEmail: 'a@example.com', receiveEmail: ['b@example.com'],
			subject: 'hi', text: 'hi', html: '<p>hi</p>',
		});
		expect(normal.headers).toBeUndefined();
		expect('X-Mailer' in normal).toBe(false);
	});

	it('describeRemovedHeaders 只报头名不报值', () => {
		expect(describeRemovedHeaders({ 'X-Mailer': 'secret-version', 'in-reply-to': '<x>' }))
			.toEqual(['X-Mailer']);
	});
});

// ---------- P1-3：阅后即焚策略（纯函数） ----------

describe('P1-3 burn policy', () => {
	it('明文信选 burn 被降级并给原因', () => {
		const p = resolveBurnPolicy({ e2ee: 0, expireOption: 'burn' });
		expect(p.allowed).toBe(false);
		expect(p.downgraded).toBe(true);
		expect(p.reason).toBe('burn_requires_e2ee');
		expect(p.burnAfterRead).toBe(0);
	});

	it('E2EE 信选 burn 允许，带组标识', () => {
		const p = resolveBurnPolicy({ e2ee: 1, expireOption: 'burn' });
		expect(p.allowed).toBe(true);
		expect(p.burnAfterRead).toBe(1);
		expect(p.expireAt).toBe('');
		expect(p.expireGroup.startsWith('burn_')).toBe(true);
	});

	it('定时自毁按服务端时钟换算（固定 now 可断言）', () => {
		const nowMs = Date.parse('2026-11-11T00:00:00.000Z');
		const p = resolveBurnPolicy({ e2ee: 0, expireOption: '1h', nowMs });
		expect(p.expireAt).toBe('2026-11-11 01:00:00');
		expect(p.burnAfterRead).toBe(0);
		expect(resolveBurnPolicy({ e2ee: 0, expireOption: 'none' }).expireGroup).toBe('');
		expect(resolveBurnPolicy({ e2ee: 0, expireOption: 'bogus' }).expireAt).toBe('');
	});
});

// ---------- P1-4：登录异常评分（纯函数） ----------

describe('P1-4 anomaly scoring', () => {
	it('新 IP+新设备+非常用时段+管理员 = 6 分 anomaly，要求二验', () => {
		const r = scoreLoginAttempt({
			isNewIp: true, isNewDevice: true, hourUtc: 4,
			usualHours: [9, 10, 20], isAdmin: true, failedAttemptsLastHour: 0,
		});
		expect(r.score).toBe(6);
		expect(r.level).toBe('anomaly');
		expect(r.requireStepUp).toBe(true);
		expect(r.reasons).toEqual(expect.arrayContaining(['new_ip', 'new_device', 'unusual_hour', 'admin_account']));
	});

	it('常用时段已知 IP/设备 = 0 分 normal', () => {
		const r = scoreLoginAttempt({ isNewIp: false, isNewDevice: false, hourUtc: 10, usualHours: [9, 10, 20] });
		expect(r.score).toBe(0);
		expect(r.level).toBe('normal');
		expect(r.requireStepUp).toBe(false);
	});

	it('仅新 IP = 2 分 watch，不要求二验；失败 ≥3 次再 +2', () => {
		expect(scoreLoginAttempt({ isNewIp: true }).level).toBe('watch');
		expect(scoreLoginAttempt({ isNewIp: true }).requireStepUp).toBe(false);
		expect(scoreLoginAttempt({ isNewIp: true, failedAttemptsLastHour: 3 }).score).toBe(4);
		expect(scoreLoginAttempt({ isNewIp: true, failedAttemptsLastHour: 3 }).level).toBe('anomaly');
	});

	it('无基线时不判非常用时段', () => {
		expect(scoreLoginAttempt({ hourUtc: 4, usualHours: [] }).reasons).not.toContain('unusual_hour');
	});

	it('邮件提醒文案只含脱敏 IP', () => {
		const m = buildAnomalyEmail({ email: USER_EMAIL, maskedIp: '203.0.113.0', device: 'Desktop', browser: 'Chrome', time: '2026-11-11 02:00:00', level: 'anomaly' });
		expect(m.subject).toContain('异常登录告警');
		expect(m.text).toContain('203.0.113.0');
		expect(m.text).not.toContain('203.0.113.99');
	});
});

// ---------- P2-5：别名过期换算（纯函数） ----------

describe('P2-5 alias expiry resolve', () => {
	it('7 天换算准确；0=不限期；非法天数=不限期', () => {
		const nowMs = Date.parse('2026-11-11T00:00:00.000Z');
		expect(resolveAliasExpiry(7, nowMs)).toBe('2026-11-18 00:00:00');
		expect(resolveAliasExpiry(0, nowMs)).toBe('');
		expect(resolveAliasExpiry(5, nowMs)).toBe('');
		expect(isExpiredAt('2026-11-10 23:59:59', nowMs)).toBe(true);
		expect(isExpiredAt('2026-11-12 00:00:00', nowMs)).toBe(false);
		expect(isExpiredAt('', nowMs)).toBe(false);
	});
});

// ---------- P0-2：管理员审计（DB） ----------

describe('P0-2 admin audit', () => {
	it('记高危操作后全局视图可查到操作人/操作/目标', async () => {
		const c = fakeCtx();
		expect(ADMIN_ID).toBeGreaterThan(0);
		expect(USER_ID).toBeGreaterThan(0);
		await adminAuditService.recordAdminAction(c, {
			actorUserId: ADMIN_ID, action: 'user:set-password', targetId: String(USER_ID), detail: { via: 'admin_panel' },
		});
		const data = await adminAuditService.listAdminAudit(c, { action: 'user:set-password' });
		const row = data.list.find(r => r.actorUserId === ADMIN_ID && String(r.targetId) === String(USER_ID));
		expect(row).toBeTruthy();
		expect(row.actionLabel).toBeTruthy();
		expect(row.detail.via).toBe('admin_panel');
		// 密码值绝不能出现在 detail 里（kernel 清洗兜底也在这里验证）
		expect(JSON.stringify(row.detail)).not.toContain('password123');
	});

	it('未知 action 拒绝写入（防拼错导致查不到）', async () => {
		const c = fakeCtx();
		await expect(adminAuditService.recordAdminAction(c, {
			actorUserId: ADMIN_ID, action: 'user:typo-action', targetId: '1', detail: {},
		})).rejects.toThrow();
		await expect(adminAuditService.listAdminAudit(c, { action: 'user:typo-action' })).rejects.toThrow();
	});

	it('接线覆盖表如实标出三处待补', () => {
		const cov = adminAuditService.coverage();
		const byAction = Object.fromEntries(cov.map(r => [r.action, r]));
		expect(byAction['user:set-password'].status).toBe('needs-patch');
		expect(byAction['user:set-type'].status).toBe('needs-patch');
		expect(byAction['role:perm-update'].status).toBe('needs-patch');
		expect(byAction['user:physics-delete'].status).toBe('wired');
		expect(byAction['setting:update'].status).toBe('wired');
	});
});

// ---------- P1-3：焚毁留痕与核验（DB） ----------

describe('P1-3 burn receipt', () => {
	it('焚毁留痕只记元数据，核验能区分残留与已焚毁', async () => {
		const c = fakeCtx();
		const group = `burn_test_${Date.now()}`;
		await orm(c).insert(email).values({
			accountId: 1, userId: USER_ID, senderEmail: USER_EMAIL,
			recipient: 'other@example.com',
			toEmail: 'other@example.com', toName: '', subject: 'secret-subject-must-not-leak',
			expireGroup: group, burnAfterRead: 1,
		}).run();
		const before = await burnAfterReadingService.verifyGroupBurned(c, USER_ID, group);
		expect(before.burned).toBe(false);
		expect(before.remaining).toBe(1);

		await burnAfterReadingService.recordBurnReceipt(c, {
			actorUserId: USER_ID, expireGroup: group, burnedEmailIds: [1], readerUserId: USER_ID,
		});
		const audit = await adminAuditService.listAdminAudit(c, { action: 'email:burned' });
		const row = audit.list.find(r => r.targetId === group);
		expect(row).toBeTruthy();
		expect(row.detail.burnedCount).toBe(1);
		expect(JSON.stringify(row.detail)).not.toContain('secret-subject');

		await orm(c).delete(email).where(eq(email.expireGroup, group)).run();
		const after = await burnAfterReadingService.verifyGroupBurned(c, USER_ID, group);
		expect(after.burned).toBe(true);
		expect(after.remaining).toBe(0);
	});
});

// ---------- P1-4：登录异常评估/通知/锁定（DB） ----------

describe('P1-4 login anomaly', () => {
	it('已知 IP+同设备评估为低分；新 IP+新设备评估为 watch 以上', async () => {
		const c = fakeCtx();
		const base = { userId: USER_ID, email: USER_EMAIL, ip: KNOWN_IP, ua: UA_CHROME, isNewIp: 0, createTime: '2026-11-11 09:00:00' };
		await orm(c).insert(loginLog).values([
			{ ...base, createTime: '2026-11-11 09:00:00' },
			{ ...base, createTime: '2026-11-11 10:00:00' },
			{ ...base, createTime: '2026-11-11 20:00:00' },
		]).run();
		await orm(c).insert(knownIp).values({ userId: USER_ID, ip: KNOWN_IP, firstSeenAt: '2026-11-11 09:00:00', lastSeenAt: '2026-11-11 10:00:00' }).run();

		const known = await loginAnomalyService.evaluateLogin(c, USER_ID, { ip: KNOWN_IP, ua: UA_CHROME });
		expect(known.isNewIp).toBe(false);
		expect(known.isNewDevice).toBe(false);
		expect(known.level).toBe('normal');

		const fresh = await loginAnomalyService.evaluateLogin(c, USER_ID, { ip: NEW_IP, ua: UA_FIREFOX });
		expect(fresh.isNewIp).toBe(true);
		expect(fresh.isNewDevice).toBe(true);
		expect(fresh.score).toBeGreaterThanOrEqual(3);
		expect(fresh.reasons).toEqual(expect.arrayContaining(['new_ip', 'new_device']));
	});

	it('notifyAnomaly 写审计且不抛错（无 TG 配置时只走站内留痕）', async () => {
		const c = fakeCtx();
		const ev = await loginAnomalyService.evaluateLogin(c, USER_ID, { ip: KNOWN_IP, ua: UA_CHROME });
		const r = await loginAnomalyService.notifyAnomaly(c, {
			userId: USER_ID, email: USER_EMAIL, evaluation: ev, ip: KNOWN_IP, ua: UA_CHROME,
		});
		expect(r.ok).toBe(true);
		expect(r.emailAlert.subject).toBeTruthy();
		const audit = await adminAuditService.listAdminAudit(c, { action: 'login:anomaly' });
		expect(audit.list.some(x => String(x.targetId) === String(USER_ID))).toBe(true);
	});

	it('一键锁定后状态为 BAN 且有审计；管理员解锁恢复 NORMAL', async () => {
		const c = fakeCtx();
		const reg = await api('/register', { method: 'POST', ip: KNOWN_IP, body: { email: 'lockme@example.com', password: PWD } });
		expect(reg.status).toBe(200);
		const targetId = await userIdByEmail(c, 'lockme@example.com');
		expect(targetId).toBeGreaterThan(0);

		const locked = await loginAnomalyService.lockAccount(c, { actorUserId: targetId, targetUserId: targetId, reason: 'self_lock' });
		expect(locked.status).toBe(1);
		const row = await orm(c).select().from(user).where(eq(user.userId, targetId)).get();
		expect(row.status).toBe(1);
		const audit = await adminAuditService.listAdminAudit(c, { action: 'user:locked-by-anomaly' });
		expect(audit.list.some(x => String(x.targetId) === String(targetId))).toBe(true);

		const unlocked = await loginAnomalyService.unlockAccount(c, { actorUserId: ADMIN_ID, targetUserId: targetId });
		expect(unlocked.status).toBe(0);
		const row2 = await orm(c).select().from(user).where(eq(user.userId, targetId)).get();
		expect(row2.status).toBe(0);
	});
});

// ---------- 新 API 文件可加载（路由已注册，待 webs.js 挂载） ----------

describe('new APIs mountable', () => {
	it('四个新 API 文件加载成功且路由已注册', () => {
		const pathsOf = (api) => api.routes.map(r => `${r.method} ${r.path}`);
		expect(pathsOf(adminAuditApi)).toEqual(expect.arrayContaining([
			'GET /admin/audit-log', 'GET /admin/audit-log/coverage',
		]));
		expect(pathsOf(loginAnomalyApi)).toEqual(expect.arrayContaining([
			'POST /security/lock-account', 'GET /security/login-anomalies',
			'POST /admin/login-anomalies/unlock',
		]));
		expect(pathsOf(burnApi)).toEqual(expect.arrayContaining([
			'GET /email/burn-policy', 'GET /email/burn-verify',
		]));
		expect(pathsOf(aliasExpiryApi)).toEqual(expect.arrayContaining([
			'POST /alias/expiry', 'GET /alias/expiry',
		]));
	});
});

// ---------- P2-5：别名过期（DB） ----------

describe('P2-5 alias expiry', () => {
	it('设有效期、拒收判定、到期清扫全链路', async () => {
		const c = fakeCtx();
		const address = `exp${Date.now()}@example.com`;
		await orm(c).insert(emailAlias).values({
			userId: USER_ID, accountId: 1, localPart: address.split('@')[0],
			domain: 'example.com', address, status: 0, recvCount: 0,
		}).run();
		const aliasRow = await orm(c).select().from(emailAlias).where(eq(emailAlias.address, address)).get();
		expect(aliasRow).toBeTruthy();
		const aliasId = aliasRow.aliasId;

		const set = await aliasExpiryService.setExpiry(c, USER_ID, aliasId, 30);
		expect(set.expiresAt).not.toBe('');
		const got = await aliasExpiryService.getExpiry(c, USER_ID, aliasId);
		expect(got.expiresAt).toBe(set.expiresAt);
		expect(got.expired).toBe(false);
		expect((await aliasExpiryService.isAliasReceivingBlocked(c, address)).blocked).toBe(false);

		// 非法天数拒绝
		await expect(aliasExpiryService.setExpiry(c, USER_ID, aliasId, 5)).rejects.toThrow();

		// 模拟到期：把 expires_at 改成过去，再清扫
		await orm(c).update(aliasExpiry).set({ expiresAt: '2020-01-01 00:00:00' })
			.where(eq(aliasExpiry.aliasId, aliasId)).run();
		expect((await aliasExpiryService.isAliasReceivingBlocked(c, address)).blocked).toBe(true);
		expect((await aliasExpiryService.isAliasReceivingBlocked(c, address)).reason).toBe('expired');
		const swept = await aliasExpiryService.sweepExpiredAliases(c);
		expect(swept.swept).toBe(1);
		expect(swept.aliasIds).toContain(aliasId);
		const afterRow = await orm(c).select().from(emailAlias).where(eq(emailAlias.aliasId, aliasId)).get();
		expect(afterRow.status).toBe(1);
		const audit = await adminAuditService.listAdminAudit(c, { action: 'alias:expired' });
		expect(audit.list.some(x => String(x.targetId) === String(aliasId))).toBe(true);
	});

	it('别人的别名不能设有效期', async () => {
		const c = fakeCtx();
		const address = `other${Date.now()}@example.com`;
		await orm(c).insert(emailAlias).values({
			userId: ADMIN_ID, accountId: 1, localPart: address.split('@')[0],
			domain: 'example.com', address, status: 0, recvCount: 0,
		}).run();
		const aliasRow = await orm(c).select().from(emailAlias).where(eq(emailAlias.address, address)).get();
		await expect(aliasExpiryService.setExpiry(c, USER_ID, aliasRow.aliasId, 7)).rejects.toThrow();
	});
});
