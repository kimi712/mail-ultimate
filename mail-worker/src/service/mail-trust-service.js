// Phase 8 子代理 E：邮件信任与控制（§12 项 1–4）。
// Layer 2 服务：追踪像素/远程图片拦截（服务端清洗）、发件人验证标识
// （SPF/DKIM/DMARC 解析，绝不编造）、信任发件人、垃圾邮件与钓鱼举报、
// 一键退订解析、用户偏好（撤回延迟）。
// 注意：撤回/定时发送的编排（pending_send / scheduled_email 两表 + 真正
// 执行发送）住在 email-service.js（它拥有 send 的全部校验与渠道逻辑），
// 本服务不 import email-service（避免循环依赖）；email-service import 本服务。
// 新表 trusted_sender / mail_prefs / spam_feedback 的 DDL 见子代理 E 汇报
// （由总协调并进 init.js v3_11DB）；表不存在时读路径返回默认值、写路径
// 抛 trust_table_missing（不静默吞掉）。
import { parseHTML } from 'linkedom';
import BizError from '../error/biz-error';
import auditLogService from './audit-log-service';
import telegramService from './telegram-service';

export const UNDO_DELAYS = [2, 3, 5, 10, 30];
export const DEFAULT_UNDO_SECONDS = 2;
export const MAX_SCHEDULE_DAYS = 30;
export const TRANSPARENT_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const AUTH_VALUES = ['pass', 'fail', 'none'];

// ---------------------------------------------------------------------------
// 纯函数：不碰 D1/KV，可直接单测
// ---------------------------------------------------------------------------

export function normalizeSender(address) {
	return String(address || '').trim().toLowerCase();
}

function isValidSender(address) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeSender(address));
}

// 把 PostalMime headerLines（{key, line}）、{name, value} 数组、原始头字
// 符串、Headers 实例或普通对象统一成 [{name, value}]。
export function headerEntries(headers) {
	if (!headers) return [];
	if (typeof headers === 'string') {
		return headers.split(/\r?\n/).filter(line => line.includes(':')).map(line => {
			const i = line.indexOf(':');
			return { name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
		});
	}
	if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
		const out = [];
		headers.forEach((value, name) => out.push({ name, value }));
		return out;
	}
	if (Array.isArray(headers)) {
		return headers.map(h => {
			if (typeof h === 'string') {
				const i = h.indexOf(':');
				return i < 0 ? { name: h.trim(), value: '' } : { name: h.slice(0, i).trim(), value: h.slice(i + 1).trim() };
			}
			if (h && typeof h.line === 'string') {
				const i = h.line.indexOf(':');
				return { name: (h.key || h.name || '').trim(), value: i < 0 ? '' : h.line.slice(i + 1).trim() };
			}
			return { name: String(h?.name || h?.key || ''), value: String(h?.value || '') };
		}).filter(e => e.name);
	}
	if (typeof headers === 'object') {
		return Object.entries(headers).map(([name, value]) => ({ name, value: String(value ?? '') }));
	}
	return [];
}

export function getHeaderValues(headers, name) {
	const lower = name.toLowerCase();
	return headerEntries(headers)
		.filter(e => e.name.toLowerCase() === lower)
		.map(e => e.value);
}

// Authentication-Results 里单个机制的结果归一化：
// pass→pass；fail/softfail/permerror→fail；none/neutral/temperror/policy/
// 其他未知值→none（未验证，绝不把未知说成通过）。
function normalizeAuthToken(value) {
	const v = String(value || '').trim().toLowerCase();
	if (v === 'pass') return 'pass';
	if (v === 'fail' || v === 'softfail' || v === 'permerror') return 'fail';
	return 'none';
}

// 多条 Authentication-Results（多跳）合并：任一 pass 即 pass；无 pass
// 但有 fail 即 fail；否则 none。另用 Received-SPF 补 spf（无 auth 头时）。
export function parseAuthResults(headers) {
	const entries = headerEntries(headers);
	const authHeaders = getHeaderValues(entries, 'authentication-results');
	let spf = 'none';
	let dkim = 'none';
	let dmarc = 'none';
	for (const h of authHeaders) {
		for (const mech of ['spf', 'dkim', 'dmarc']) {
			const m = h.match(new RegExp(`(?:^|[;\\s])${mech}=([A-Za-z]+)`, 'i'));
			if (!m) continue;
			const v = normalizeAuthToken(m[1]);
			if (mech === 'spf') spf = v === 'pass' ? 'pass' : (spf === 'pass' ? 'pass' : v);
			if (mech === 'dkim') dkim = v === 'pass' ? 'pass' : (dkim === 'pass' ? 'pass' : v);
			if (mech === 'dmarc') dmarc = v === 'pass' ? 'pass' : (dmarc === 'pass' ? 'pass' : v);
		}
	}
	if (spf === 'none') {
		for (const v of getHeaderValues(entries, 'received-spf')) {
			const m = v.match(/^\s*([A-Za-z]+)/);
			if (m) {
				const n = normalizeAuthToken(m[1]);
				if (n !== 'none') spf = n;
				break;
			}
		}
	}
	// 有 DKIM-Signature 但没有任何 dkim= 结论：仍是 none（未验证），不推断通过。
	const status = (spf === 'fail' || dkim === 'fail' || dmarc === 'fail')
		? 'fail'
		: ((spf === 'pass' || dkim === 'pass' || dmarc === 'pass') ? 'pass' : 'unverified');
	return { spf, dkim, dmarc, status };
}

// 存储列（'' 表示无记录）→ 读信页用的 auth 对象；全空 = 未验证。
export function authFromColumns(row) {
	const spf = AUTH_VALUES.includes(row?.authSpf) ? row.authSpf : 'none';
	const dkim = AUTH_VALUES.includes(row?.authDkim) ? row.authDkim : 'none';
	const dmarc = AUTH_VALUES.includes(row?.authDmarc) ? row.authDmarc : 'none';
	const status = (spf === 'fail' || dkim === 'fail' || dmarc === 'fail')
		? 'fail'
		: ((spf === 'pass' || dkim === 'pass' || dmarc === 'pass') ? 'pass' : 'unverified');
	return { spf, dkim, dmarc, status };
}

// List-Unsubscribe 解析（RFC 2369 / 8058）：只认尖括号里的 http(s) 链接
// 与 mailto；List-Unsubscribe-Post 含 One-Click 才可后端一键 POST。
export function parseListUnsubscribe(headers) {
	const entries = headerEntries(headers);
	const values = getHeaderValues(entries, 'list-unsubscribe');
	if (!values.length) return null;
	const joined = values.join(' ');
	const tokens = [...joined.matchAll(/<([^<>]+)>/g)].map(m => m[1].trim());
	let url = null;
	let mailto = null;
	for (const token of tokens) {
		if (!url && /^https?:\/\//i.test(token)) url = token;
		if (!mailto && /^mailto:/i.test(token)) mailto = token.replace(/^mailto:/i, '').split('?')[0];
	}
	if (!url && !mailto) return null;
	const post = getHeaderValues(entries, 'list-unsubscribe-post').join(' ');
	const oneClick = /list-unsubscribe\s*=\s*one-click/i.test(post);
	return { url, mailto, oneClick };
}

export function isRemoteUrl(src) {
	if (!src) return false;
	const s = String(src).trim();
	return /^https?:\/\//i.test(s) || s.startsWith('//');
}

// 追踪像素判定：1×1/0×0 尺寸（属性或行内样式），或文件名含像素/追踪关键字。
export function isTrackingPixel(img) {
	const w = img.getAttribute('width');
	const h = img.getAttribute('height');
	if ((w !== null && ['0', '1'].includes(String(w).trim())) ||
		(h !== null && ['0', '1'].includes(String(h).trim()))) return true;
	const style = img.getAttribute('style') || '';
	if (/(?:^|[;\s])width\s*:\s*0?1px/i.test(style) || /(?:^|[;\s])height\s*:\s*0?1px/i.test(style)) return true;
	const src = img.getAttribute('src') || '';
	return /(pixel|tracking|beacon|track\.gif|open\.gif|__open)/i.test(src);
}

// 服务端清洗：远程图片一律拦截（src 移入 data-mail-remote-src，换成透明
// 像素占位；srcset/poster/background-image 同理），计数追踪像素。
// 本地资源（data: / cid: / {{domain}} / 相对路径 / /oss/）不动。
// allowRemote=true 时只计数不拦截（信任发件人 / 用户全局放行）。
// 返回 {html, blocked, tracking, remote, hasRemote}。
export function sanitizeRemoteImages(html, { allowRemote = false } = {}) {
	const empty = { html: html || '', blocked: 0, tracking: 0, remote: 0, hasRemote: false };
	if (!html) return empty;
	if (!/<img|background|<source|poster/i.test(html)) return empty;
	const { document } = parseHTML(html);
	let blocked = 0;
	let tracking = 0;
	let remote = 0;
	const blockImg = (el, srcAttr = 'src') => {
		const src = el.getAttribute(srcAttr);
		if (!isRemoteUrl(src)) return;
		remote++;
		const isPixel = srcAttr === 'src' && el.tagName === 'IMG' && isTrackingPixel(el);
		if (isPixel) tracking++;
		if (allowRemote) return;
		blocked++;
		el.setAttribute('data-mail-remote-src', src);
		el.setAttribute('data-mail-remote', '1');
		if (isPixel) el.setAttribute('data-mail-tracking', '1');
		if (srcAttr === 'src') el.setAttribute('src', TRANSPARENT_GIF);
		else el.removeAttribute(srcAttr);
		const srcset = el.getAttribute('srcset');
		if (srcset && /https?:\/\//i.test(srcset)) {
			el.setAttribute('data-mail-remote-srcset', srcset);
			el.removeAttribute('srcset');
		}
	};
	for (const img of Array.from(document.querySelectorAll('img'))) blockImg(img);
	for (const source of Array.from(document.querySelectorAll('source'))) blockImg(source);
	for (const video of Array.from(document.querySelectorAll('video'))) {
		const poster = video.getAttribute('poster');
		if (isRemoteUrl(poster)) {
			remote++;
			if (!allowRemote) {
				blocked++;
				video.setAttribute('data-mail-remote-poster', poster);
				video.setAttribute('data-mail-remote', '1');
				video.removeAttribute('poster');
			}
		}
	}
	for (const input of Array.from(document.querySelectorAll('input[type="image"]'))) blockImg(input);
	for (const el of Array.from(document.querySelectorAll('[background]'))) {
		const bg = el.getAttribute('background');
		if (isRemoteUrl(bg)) {
			remote++;
			if (!allowRemote) {
				blocked++;
				el.setAttribute('data-mail-remote-background', bg);
				el.setAttribute('data-mail-remote', '1');
				el.removeAttribute('background');
			}
		}
	}
	for (const el of Array.from(document.querySelectorAll('[style]'))) {
		const style = el.getAttribute('style') || '';
		const m = style.match(/url\(\s*(['"]?)(https?:\/\/[^)'"]+)\1\s*\)/i);
		if (!m) continue;
		remote++;
		if (allowRemote) continue;
		blocked++;
		el.setAttribute('data-mail-remote-style', style);
		el.setAttribute('data-mail-remote', '1');
		el.setAttribute('style', style.replace(/url\(\s*(['"]?)https?:\/\/[^)'"]+\1\s*\)/gi, 'url()'));
	}
	return { html: document.toString(), blocked, tracking, remote, hasRemote: remote > 0 };
}

// 速度优化：列存在性探测的 60 秒缓存（模块级，见 hasEmailTrustColumns）。
let trustColsCache = { value: null, at: 0 };
const TRUST_COLS_TTL_MS = 60 * 1000;

const mailTrustService = {

	// Phase 8 E 的 email 新列（auth_spf/auth_dkim/auth_dmarc/
	// unsubscribe_url/unsubscribe_mailto/unsubscribe_one_click/is_spam）
	// 由总协调并进 v3_11DB 才存在。实体 email.js 故意不加这些列（否则
	// 未合并前所有 email 查询都会 no-such-column，见 failover 实测）；
	// 本服务一律用 raw SQL 访问新列，并先探测，列不存在时降级（验证=
	// 未验证、不过滤 Spam），绝不让既有流程崩掉。合并 DDL 后即精确生效。
	// 速度优化：列存在性探测（SELECT ... LIMIT 0）每轮询都跑一次 D1，
	// 列只在部署/迁移时变，60 秒内缓存结果，省一次 D1 往返。
	// 最多 60 秒过期（迁移后最迟 60 秒生效，Spam 过滤短暂降级可接受）。
	async hasEmailTrustColumns(c) {
		const now = Date.now();
		if (trustColsCache.value !== null && now - trustColsCache.at < TRUST_COLS_TTL_MS) {
			return trustColsCache.value;
		}
		try {
			await c.env.db.prepare(`SELECT auth_spf FROM email LIMIT 0`).first();
			trustColsCache = { value: true, at: now };
			return true;
		} catch (e) {
			trustColsCache = { value: false, at: now };
			return false;
		}
	},

	// 批量取一批邮件的验证/退订/Spam 列（列不存在时返回空 Map）。
	async fetchAuthMap(c, emailIds) {
		const map = new Map();
		if (!emailIds || !emailIds.length) return map;
		try {
			const placeholders = emailIds.map(() => '?').join(',');
			const rows = await c.env.db.prepare(
				`SELECT email_id AS emailId, auth_spf AS authSpf, auth_dkim AS authDkim, auth_dmarc AS authDmarc,
					unsubscribe_url AS unsubscribeUrl, unsubscribe_mailto AS unsubscribeMailto,
					unsubscribe_one_click AS unsubscribeOneClick, is_spam AS isSpam
				 FROM email WHERE email_id IN (${placeholders})`
			).bind(...emailIds.map(Number)).all();
			for (const r of (rows.results || [])) map.set(Number(r.emailId), r);
		} catch (e) {
			// 列未合并：调用方按“未验证 / 无退订 / 非 Spam”处理。
		}
		return map;
	},

	// ---- 用户偏好（mail_prefs；无行 = 默认值） ----
	// forwardEmail：个人新邮件转发地址（空 = 不转发）。收信时把原信转发一份到该地址，
	// 用户在常用邮箱里就能收到新邮件提醒，不用手动进站查看；只转给收件人本人。
	async getPrefs(c, userId) {
		try {
			const row = await c.env.db.prepare(
				`SELECT undo_seconds AS undoSeconds, remote_images AS remoteImages, forward_email AS forwardEmail FROM mail_prefs WHERE user_id = ?`
			).bind(userId).first();
			if (!row) return { undoSeconds: DEFAULT_UNDO_SECONDS, remoteImages: 0, forwardEmail: '' };
			return {
				undoSeconds: UNDO_DELAYS.includes(Number(row.undoSeconds)) ? Number(row.undoSeconds) : DEFAULT_UNDO_SECONDS,
				remoteImages: Number(row.remoteImages) === 1 ? 1 : 0,
				forwardEmail: typeof row.forwardEmail === 'string' ? row.forwardEmail.trim() : ''
			};
		} catch (e) {
			console.error('读邮件偏好失败:', e.message);
			return { undoSeconds: DEFAULT_UNDO_SECONDS, remoteImages: 0, forwardEmail: '' };
		}
	},

	async setPrefs(c, userId, { undoSeconds, remoteImages, forwardEmail } = {}) {
		const prefs = await this.getPrefs(c, userId);
		if (undoSeconds !== undefined) {
			if (!UNDO_DELAYS.includes(Number(undoSeconds))) {
				throw new BizError('trust_invalid_undo_delay', 'trust_invalid_undo_delay');
			}
			prefs.undoSeconds = Number(undoSeconds);
		}
		if (remoteImages !== undefined) {
			if (![0, 1].includes(Number(remoteImages))) {
				throw new BizError('trust_invalid_remote_images', 'trust_invalid_remote_images');
			}
			prefs.remoteImages = Number(remoteImages);
		}
		if (forwardEmail !== undefined) {
			const addr = String(forwardEmail || '').trim();
			if (addr && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
				throw new BizError('trust_invalid_forward_email', 'trust_invalid_forward_email');
			}
			prefs.forwardEmail = addr;
		}
		await c.env.db.prepare(
			`INSERT INTO mail_prefs (user_id, undo_seconds, remote_images, forward_email) VALUES (?, ?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET undo_seconds = excluded.undo_seconds, remote_images = excluded.remote_images, forward_email = excluded.forward_email`
		).bind(userId, prefs.undoSeconds, prefs.remoteImages, prefs.forwardEmail || '').run();
		return prefs;
	},

	// ---- 信任发件人（trusted_sender；发件人地址全小写存） ----
	async listTrustedSenders(c, userId) {
		const rows = await c.env.db.prepare(
			`SELECT sender_email AS senderEmail, created_at AS createdAt FROM trusted_sender WHERE user_id = ? ORDER BY created_at DESC`
		).bind(userId).all();
		return (rows.results || []).map(r => r.senderEmail);
	},

	async isTrustedSender(c, userId, senderEmail) {
		const sender = normalizeSender(senderEmail);
		if (!sender) return false;
		const row = await c.env.db.prepare(
			`SELECT 1 AS x FROM trusted_sender WHERE user_id = ? AND sender_email = ?`
		).bind(userId, sender).first();
		return !!row;
	},

	async trustSender(c, userId, senderEmail) {
		const sender = normalizeSender(senderEmail);
		if (!isValidSender(sender)) {
			throw new BizError('trust_invalid_sender', 'trust_invalid_sender');
		}
		await c.env.db.prepare(
			`INSERT OR IGNORE INTO trusted_sender (user_id, sender_email) VALUES (?, ?)`
		).bind(userId, sender).run();
		return { senderEmail: sender, trusted: true };
	},

	async untrustSender(c, userId, senderEmail) {
		const sender = normalizeSender(senderEmail);
		await c.env.db.prepare(
			`DELETE FROM trusted_sender WHERE user_id = ? AND sender_email = ?`
		).bind(userId, sender).run();
		return { senderEmail: sender, trusted: false };
	},

	// ---- 读信页信任数据（服务端清洗计数 + 验证标识 + 退订 + 信任态） ----
	async getReadTrust(c, userId, emailId) {
		let row;
		try {
			row = await c.env.db.prepare(
				`SELECT email_id AS emailId, send_email AS sendEmail, subject, content, auth_spf AS authSpf,
					auth_dkim AS authDkim, auth_dmarc AS authDmarc, unsubscribe_url AS unsubscribeUrl,
					unsubscribe_mailto AS unsubscribeMailto, unsubscribe_one_click AS unsubscribeOneClick
				 FROM email WHERE email_id = ? AND user_id = ? AND is_del = 0`
			).bind(Number(emailId), userId).first();
		} catch (e) {
			// 新列未合并：退回无新列的查询（验证=未验证、退订=null）。
			row = await c.env.db.prepare(
				`SELECT email_id AS emailId, send_email AS sendEmail, subject, content
				 FROM email WHERE email_id = ? AND user_id = ? AND is_del = 0`
			).bind(Number(emailId), userId).first();
		}
		if (!row) {
			throw new BizError('trust_email_not_found', 'trust_email_not_found');
		}
		const prefs = await this.getPrefs(c, userId);
		const trusted = await this.isTrustedSender(c, userId, row.sendEmail);
		const allowRemote = trusted || prefs.remoteImages === 1;
		// 只计数不改库：allowRemote 时 blocked=0；否则给出拦截数（与列表
		// 接口的服务端清洗同一份 sanitizeRemoteImages 逻辑）。
		const scanned = sanitizeRemoteImages(row.content || '', { allowRemote });
		return {
			emailId: row.emailId,
			senderEmail: row.sendEmail,
			auth: authFromColumns(row),
			unsubscribe: (row.unsubscribeUrl || row.unsubscribeMailto)
				? { url: row.unsubscribeUrl || null, mailto: row.unsubscribeMailto || null, oneClick: Number(row.unsubscribeOneClick) === 1 }
				: null,
			trusted,
			allowRemote,
			remoteImages: { blocked: scanned.blocked, tracking: scanned.tracking, remote: scanned.remote, hasRemote: scanned.hasRemote }
		};
	},

	// 列表/详情接口共用：给每封邮件挂验证标识与退订信息；full 模式下再做
	// 服务端清洗（信任发件人/全局放行时只计数不拦截）。brief 模式不碰 content。
	// 验证/退订列经 fetchAuthMap 批量取（列未合并时为空 Map → 未验证）。
	async applyServerSanitize(c, userId, list, { full = true } = {}) {
		if (!list || !list.length) return list;
		const prefs = await this.getPrefs(c, userId);
		const authMap = await this.fetchAuthMap(c, list.map(item => item.emailId));
		let trustedSet = new Set();
		try {
			const rows = await c.env.db.prepare(
				`SELECT sender_email AS senderEmail FROM trusted_sender WHERE user_id = ?`
			).bind(userId).all();
			trustedSet = new Set((rows.results || []).map(r => String(r.senderEmail).toLowerCase()));
		} catch (e) {
			console.error('读信任发件人失败:', e.message);
		}
		for (const item of list) {
			const extra = authMap.get(Number(item.emailId)) || {};
			item.auth = authFromColumns(extra);
			item.unsubscribe = (extra.unsubscribeUrl || extra.unsubscribeMailto)
				? { url: extra.unsubscribeUrl || null, mailto: extra.unsubscribeMailto || null, oneClick: Number(extra.unsubscribeOneClick) === 1 }
				: null;
			item.isSpam = Number(extra.isSpam || 0);
			const allowRemote = trustedSet.has(normalizeSender(item.sendEmail)) || prefs.remoteImages === 1;
			item.trustedSender = allowRemote;
			if (!full) {
				item.remoteImages = { blocked: 0, tracking: 0, remote: 0, hasRemote: false };
				continue;
			}
			const scanned = sanitizeRemoteImages(item.content || '', { allowRemote });
			if (!allowRemote) item.content = scanned.html;
			item.remoteImages = { blocked: scanned.blocked, tracking: scanned.tracking, remote: scanned.remote, hasRemote: scanned.hasRemote };
		}
		return list;
	},

	// 写 is_spam 列：列未合并（v3_11DB 尚未并入）时报明确的
	// trust_table_missing，不静默吞掉（调用方是 Spam 操作，静默等于骗用户）。
	async _setIsSpam(c, emailId, value) {
		try {
			await c.env.db.prepare(`UPDATE email SET is_spam = ? WHERE email_id = ?`).bind(value, emailId).run();
		} catch (e) {
			throw new BizError('trust_table_missing', 'trust_table_missing');
		}
	},

	// ---- 垃圾邮件 / 钓鱼举报 ----
	async _ownReceivedMail(c, userId, emailId) {
		const row = await c.env.db.prepare(
			`SELECT email_id AS emailId, send_email AS sendEmail, subject, type
			 FROM email WHERE email_id = ? AND user_id = ? AND is_del = 0`
		).bind(Number(emailId), userId).first();
		if (!row) {
			throw new BizError('trust_email_not_found', 'trust_email_not_found');
		}
		return row;
	},

	// 标记垃圾邮件：进 Spam（email.is_spam=1，列表默认不再显示在收件箱），
	// 并记一条反馈（spam_feedback，供后续过滤规则用；同一用户同一邮件
	// 同一种类只记一次）。
	async markSpam(c, userId, emailId) {
		const row = await this._ownReceivedMail(c, userId, emailId);
		if (Number(row.type) !== 0) {
			throw new BizError('trust_not_received', 'trust_not_received');
		}
		await this._setIsSpam(c, row.emailId, 1);
		await c.env.db.prepare(
			`INSERT OR IGNORE INTO spam_feedback (user_id, email_id, sender_email, subject, kind) VALUES (?, ?, ?, ?, 'spam')`
		).bind(userId, row.emailId, row.sendEmail || '', row.subject || '').run();
		return { emailId: row.emailId, isSpam: 1 };
	},

	async unmarkSpam(c, userId, emailId) {
		const row = await this._ownReceivedMail(c, userId, emailId);
		await this._setIsSpam(c, row.emailId, 0);
		return { emailId: row.emailId, isSpam: 0 };
	},

	// 举报钓鱼：同时进 Spam + 记 phishing 反馈 + 写审计（只记元数据，不记
	// 正文）+ TG 告警（best-effort，无 TG 配置时只记 alert_log，不阻断）。
	async reportPhishing(c, userId, emailId) {
		const row = await this._ownReceivedMail(c, userId, emailId);
		if (Number(row.type) !== 0) {
			throw new BizError('trust_not_received', 'trust_not_received');
		}
		await this._setIsSpam(c, row.emailId, 1);
		await c.env.db.prepare(
			`INSERT OR IGNORE INTO spam_feedback (user_id, email_id, sender_email, subject, kind) VALUES (?, ?, ?, ?, 'phishing')`
		).bind(userId, row.emailId, row.sendEmail || '', row.subject || '').run();
		try {
			await auditLogService.record(c, {
				action: 'report_phishing',
				targetType: 'email',
				targetId: String(row.emailId),
				detail: { sender: row.sendEmail || '', subject: (row.subject || '').slice(0, 100) }
			});
		} catch (e) {
			console.error('钓鱼举报写审计失败:', e.message);
		}
		try {
			await telegramService.sendAlert(c,
				`🎣 钓鱼举报\n发件人：${row.sendEmail || ''}\n主题：${(row.subject || '').slice(0, 100)}\n邮件 id：${row.emailId}`,
				'phishing');
		} catch (e) {
			console.error('钓鱼举报发告警失败:', e.message);
		}
		return { emailId: row.emailId, reported: true, isSpam: 1 };
	},

	// 某发件人被多少个不同用户举报过（供后续自动过滤规则用；本阶段只读不自动拦）。
	async spamFeedbackCount(c, senderEmail) {
		const sender = normalizeSender(senderEmail);
		if (!sender) return 0;
		const row = await c.env.db.prepare(
			`SELECT COUNT(DISTINCT user_id) AS n FROM spam_feedback WHERE sender_email = ?`
		).bind(sender).first();
		return Number(row?.n || 0);
	},

	// ---- 一键退订 ----
	async getUnsubscribe(c, userId, emailId) {
		const row = await this._ownReceivedMail(c, userId, emailId);
		let full = null;
		try {
			full = await c.env.db.prepare(
				`SELECT unsubscribe_url AS unsubscribeUrl, unsubscribe_mailto AS unsubscribeMailto,
					unsubscribe_one_click AS unsubscribeOneClick FROM email WHERE email_id = ?`
			).bind(row.emailId).first();
		} catch (e) {
			// 新列未合并：无退订信息。
			return null;
		}
		if (!full?.unsubscribeUrl && !full?.unsubscribeMailto) return null;
		return {
			url: full.unsubscribeUrl || null,
			mailto: full.unsubscribeMailto || null,
			oneClick: Number(full.unsubscribeOneClick) === 1
		};
	},

	// oneClick 且有 url：后端直接 POST（RFC 8058），不经过用户浏览器；
	// 只有 url 无 oneClick：返回 open，前端新标签页打开（链接本身就是退订页）；
	// 只有 mailto：返回 mailto，前端打开写信（由用户确认发出，不自动发信）。
	async unsubscribe(c, userId, emailId, fetchFn) {
		const info = await this.getUnsubscribe(c, userId, emailId);
		if (!info) {
			throw new BizError('trust_no_unsubscribe', 'trust_no_unsubscribe');
		}
		if (info.url && info.oneClick) {
			const doFetch = fetchFn || fetch;
			let res;
			try {
				res = await doFetch(info.url, {
					method: 'POST',
					headers: { 'List-Unsubscribe': 'One-Click', 'Content-Type': 'application/x-www-form-urlencoded' },
					body: 'List-Unsubscribe=One-Click'
				});
			} catch (e) {
				throw new BizError('trust_unsubscribe_failed', 'trust_unsubscribe_failed');
			}
			if (!res || !res.ok) {
				throw new BizError('trust_unsubscribe_failed', 'trust_unsubscribe_failed');
			}
			return { emailId: Number(emailId), action: 'posted', url: info.url };
		}
		if (info.url) {
			return { emailId: Number(emailId), action: 'open', url: info.url };
		}
		return { emailId: Number(emailId), action: 'mailto', mailto: info.mailto };
	}
};

export default mailTrustService;
