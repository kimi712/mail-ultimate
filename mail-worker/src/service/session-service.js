// Phase 8 B · 会话（设备）管理（按新标准重写）。
// AUTH_INFO 存 tokens（每台设备一个 uuid），SESSION_META（KV，key 为
// session_meta:<userId>）存 digest → {ua, ip, createdAt, lastActiveAt}；
// digest 为 token uuid 前 8 位标识，完整 token 绝不返回。TTL 与 AUTH_INFO 相同（30 天）。
// - lastActiveAt：每次鉴权成功后刷新（security.js 中间件调 touchSession，
//   60 秒节流——同一会话 60 秒内只写一次 KV，避免每次请求都写放大；
//   写 KV 失败不阻断请求）。登录时 recordSession 以 createdAt 初始化。
// - 列表返回 lastActiveAt（缺失的老条目回落为 createdAt）与 device/browser
//   （由记录时拼好的 "浏览器 / 系统 / 设备" 拆回）；IP 按 setting.log_ip_mask
//   脱敏后展示（与登录历史同一口径）。
// - 踢出指定会话 / 踢出除当前外的全部会话：一键操作，删 AUTH_INFO token 的同时清 meta。
// 所有写操作 best-effort，失败只记日志，永不阻断登录/登出主流程。
import KvConst from '../const/kv-const';
import constant from '../const/constant';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';
import reqUtils from '../utils/req-utils';
import settingService from './setting-service';
import userContext from '../security/user-context';

// 同一会话两次 lastActiveAt 刷新之间的最小间隔（毫秒）：防 KV 写放大。
// 鉴权中间件每次请求都调 touchSession，但 60 秒内只写一次。
const TOUCH_THROTTLE_MS = 60 * 1000;

const sessionService = {

	digestOf(tokenUuid) {
		return String(tokenUuid || '').slice(0, 8);
	},

	async _readMeta(c, userId) {
		try {
			return (await c.env.kv.get(KvConst.SESSION_META + userId, { type: 'json' })) || {};
		} catch (e) {
			return {};
		}
	},

	async _writeMeta(c, userId, meta) {
		try {
			await c.env.kv.put(KvConst.SESSION_META + userId, JSON.stringify(meta), { expirationTtl: constant.TOKEN_EXPIRE });
		} catch (e) {
			console.error('写会话元数据失败:', e.message);
		}
	},

	async _maskIpOn(c, ip) {
		try {
			const setting = await settingService.query(c);
			if (setting && (Number(setting.logIpMask) === 1 || Number(setting.log_ip_mask) === 1)) {
				return reqUtils.maskIp(ip);
			}
		} catch (e) {
			// 读配置失败时不脱敏、不阻断返回
		}
		return ip;
	},

	// 记录时拼好的 ua 形如 "Chrome 120 / Windows 10 / Desktop"，拆回 device/browser。
	_parseDeviceBrowser(ua) {
		const parts = String(ua || '').split(' / ').map(s => s.trim()).filter(Boolean);
		if (parts.length === 0) {
			return { device: '', browser: '' };
		}
		if (parts.length === 1) {
			return { device: '', browser: parts[0] };
		}
		return {
			browser: parts.slice(0, parts.length - 1).join(' / '),
			device: parts[parts.length - 1]
		};
	},

	// 登录时记录本设备元数据（lastActiveAt 与 createdAt 同值初始化）。
	async recordSession(c, userId, tokenUuid) {
		try {
			const meta = await this._readMeta(c, userId);
			const uaInfo = reqUtils.getUserAgent(c);
			const ua = [uaInfo.browser, uaInfo.os, uaInfo.device].filter(Boolean).join(' / ')
				|| (c.req.header('user-agent') || '');
			const now = new Date().toISOString();
			meta[this.digestOf(tokenUuid)] = {
				ua,
				ip: reqUtils.getIp(c),
				createdAt: now,
				lastActiveAt: now
			};
			await this._writeMeta(c, userId, meta);
		} catch (e) {
			console.error('记录会话失败:', e.message);
		}
	},

	// 每次鉴权成功后刷新最后活跃时间（60 秒节流，写 KV 失败不阻断请求）。
	// 由 security.js 鉴权中间件调用；本函数自身永不抛错。
	async touchSession(c, userId, tokenUuid) {
		try {
			if (!userId || !tokenUuid) {
				return;
			}
			const digest = this.digestOf(tokenUuid);
			const meta = await this._readMeta(c, userId);
			const entry = meta[digest];
			if (!entry) {
				return;
			}
			const nowMs = Date.now();
			const lastMs = entry.lastActiveAt ? Date.parse(entry.lastActiveAt) : 0;
			if (!isNaN(lastMs) && nowMs - lastMs < TOUCH_THROTTLE_MS) {
				return;
			}
			entry.lastActiveAt = new Date(nowMs).toISOString();
			await this._writeMeta(c, userId, meta);
		} catch (e) {
			console.error('刷新会话最后活跃时间失败:', e.message);
		}
	},

	// 登出时同步清本设备元数据。
	async clearSession(c, userId, tokenUuid) {
		try {
			const meta = await this._readMeta(c, userId);
			delete meta[this.digestOf(tokenUuid)];
			await this._writeMeta(c, userId, meta);
		} catch (e) {
			console.error('清除会话元数据失败:', e.message);
		}
	},

	async listSessions(c, userId, currentTokenUuid) {
		// 诱饵会话（v3_16DB）：只返回当前这一个会话（不透露用户的其他真实设备），
		// 内容用本次请求的 UA/IP 现拼，看起来像正常单设备登录。
		if (userContext.isDecoy(c)) {
			const ua = c.req.header('user-agent') || '';
			const { device, browser } = this._parseDeviceBrowser(ua);
			const now = new Date().toISOString();
			return [{
				digest: this.digestOf(currentTokenUuid),
				ua,
				device,
				browser,
				ip: await this._maskIpOn(c, reqUtils.getIp(c)),
				createdAt: now,
				lastActiveAt: now,
				current: true
			}];
		}
		const authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userId, { type: 'json' });
		const tokens = authInfo?.tokens || [];
		const meta = await this._readMeta(c, userId);
		const currentDigest = this.digestOf(currentTokenUuid);
		const list = [];
		for (const tokenUuid of tokens) {
			const digest = this.digestOf(tokenUuid);
			const info = meta[digest] || {};
			const { device, browser } = this._parseDeviceBrowser(info.ua || '');
			list.push({
				digest,
				ua: info.ua || '',
				device,
				browser,
				ip: await this._maskIpOn(c, info.ip || ''),
				createdAt: info.createdAt || '',
				// 老条目（重写前写入）无 lastActiveAt，回落为 createdAt。
				lastActiveAt: info.lastActiveAt || info.createdAt || '',
				current: digest === currentDigest
			});
		}
		return list;
	},

	// 踢出指定设备：从 AUTH_INFO.tokens 删对应 token，并清其 meta。
	async revokeSession(c, userId, digest, currentTokenUuid) {
		// 诱饵会话（v3_16DB）：假装踢出成功，实际不动任何真实会话。
		if (userContext.isDecoy(c)) {
			return { revoked: digest };
		}
		const authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userId, { type: 'json' });
		if (!authInfo) {
			throw new BizError(t('sessionNotFound'), 404);
		}
		const before = authInfo.tokens.length;
		authInfo.tokens = authInfo.tokens.filter(tokenUuid => this.digestOf(tokenUuid) !== digest);
		if (authInfo.tokens.length === before) {
			throw new BizError(t('sessionNotFound'), 404);
		}
		await c.env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify(authInfo), { expirationTtl: constant.TOKEN_EXPIRE });
		const meta = await this._readMeta(c, userId);
		delete meta[digest];
		await this._writeMeta(c, userId, meta);
		return { revoked: digest };
	},

	// 踢出除当前设备外的全部会话。
	async revokeAllExceptCurrent(c, userId, currentTokenUuid) {
		// 诱饵会话（v3_16DB）：假装成功，实际不动任何真实会话（绝不能让胁迫者
		// 一键踢掉用户本人的全部设备）。
		if (userContext.isDecoy(c)) {
			return { revoked: 0 };
		}
		const authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userId, { type: 'json' });
		if (!authInfo) {
			return { revoked: 0 };
		}
		const currentDigest = this.digestOf(currentTokenUuid);
		const kept = authInfo.tokens.filter(tokenUuid => this.digestOf(tokenUuid) === currentDigest);
		const revoked = authInfo.tokens.length - kept.length;
		authInfo.tokens = kept;
		await c.env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify(authInfo), { expirationTtl: constant.TOKEN_EXPIRE });
		const meta = await this._readMeta(c, userId);
		for (const digest of Object.keys(meta)) {
			if (digest !== currentDigest) {
				delete meta[digest];
			}
		}
		await this._writeMeta(c, userId, meta);
		return { revoked };
	}
};

export default sessionService;
