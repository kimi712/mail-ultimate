// Phase 6：会话（设备）管理。AUTH_INFO 存 tokens（每台设备一个 uuid），
// SESSION_META（KV，key 为 session_meta:<userId>）存 digest → {ua, ip, createdAt}；
// digest 为 token uuid 前 8 位标识，完整 token 绝不返回。TTL 与 AUTH_INFO 相同（30 天）。
// 所有写操作 best-effort，失败只记日志，永不阻断登录/登出主流程。
import KvConst from '../const/kv-const';
import constant from '../const/constant';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';
import reqUtils from '../utils/req-utils';

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

	// 登录时记录本设备元数据。
	async recordSession(c, userId, tokenUuid) {
		try {
			const meta = await this._readMeta(c, userId);
			const uaInfo = reqUtils.getUserAgent(c);
			const ua = [uaInfo.browser, uaInfo.os, uaInfo.device].filter(Boolean).join(' / ')
				|| (c.req.header('user-agent') || '');
			meta[this.digestOf(tokenUuid)] = {
				ua,
				ip: reqUtils.getIp(c),
				createdAt: new Date().toISOString()
			};
			await this._writeMeta(c, userId, meta);
		} catch (e) {
			console.error('记录会话失败:', e.message);
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
		const authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userId, { type: 'json' });
		const tokens = authInfo?.tokens || [];
		const meta = await this._readMeta(c, userId);
		const currentDigest = this.digestOf(currentTokenUuid);
		return tokens.map(tokenUuid => {
			const digest = this.digestOf(tokenUuid);
			const info = meta[digest] || {};
			return {
				digest,
				ua: info.ua || '',
				ip: info.ip || '',
				createdAt: info.createdAt || '',
				current: digest === currentDigest
			};
		});
	},

	// 踢出指定设备：从 AUTH_INFO.tokens 删对应 token，并清其 meta。
	async revokeSession(c, userId, digest, currentTokenUuid) {
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
