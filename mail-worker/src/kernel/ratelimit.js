// Phase 8 · Layer 1 通用限流原语（kernel/ratelimit）。
// KV 计数，固定窗口 + 失败计数 + 指数退避锁定；登录/注册/发信/AI 共用一套原语。
// - 计数 key 一律用 SHA-256 摘要（KV key 里不存原始 IP/邮箱明文，只存 16 位 hex 前缀）。
// - 固定窗口：consume() 在窗口内计数，满 limit 返回 allowed=false 与 retryAfterSec。
// - 锁定：setLock() 按指数退避算锁定时长（base × 3^(level-1)，上限 24h）；
//   getLock() 读锁（过期视为无锁）；clearLock() 解锁。
// - 所有方法永不抛错：KV 异常时放行（fail-open，不把限流故障变成全站不可用），
//   只记 console.error；调用方按返回的 allowed/locked 做业务决策。
// - 本文件不含任何业务语义（不限定“登录”）：维度、阈值、锁定级别由调用方传入。
// - 摘要用全局 WebCrypto（Workers / vitest pool 均提供），不 import node:crypto。

const WIN_PREFIX = 'rl:win:';
const LOCK_PREFIX = 'rl:lock:';
const MAX_LOCK_SECONDS = 24 * 3600;

async function shaHex(input) {
	try {
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(input)));
		return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
	} catch (e) {
		// WebCrypto 不可用时回落到简单哈希（仅作 key 分散，不作安全用途）。
		let h1 = 0xdeadbeef;
		let h2 = 0x41c6ce57;
		const s = String(input);
		for (let i = 0; i < s.length; i++) {
			const ch = s.charCodeAt(i);
			h1 = Math.imul(h1 ^ ch, 2654435761);
			h2 = Math.imul(h2 ^ ch, 1597334677);
		}
		h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
		h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
		return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
	}
}

// 维度 key：入参为业务维度字符串（如 `login:ip:1.2.3.4`），返回 KV 安全的摘要 key。
async function dimensionKey(dimension) {
	const hex = await shaHex(dimension);
	return hex.slice(0, 16);
}

// 指数退避锁定时长（秒）：base × 3^(level-1)，level 从 1 起，上限 24h。
// level=1 → base（登录场景 base=300，即首锁 5 分钟）。
function backoffSeconds(baseSeconds, level, capSeconds = MAX_LOCK_SECONDS) {
	const base = Math.max(1, Number(baseSeconds) || 60);
	const lvl = Math.max(1, Number(level) || 1);
	return Math.min(capSeconds, base * Math.pow(3, lvl - 1));
}

const ratelimit = {

	shaHex,
	dimensionKey,
	backoffSeconds,
	MAX_LOCK_SECONDS,

	// 固定窗口消费一次：返回 { allowed, count, retryAfterSec }。
	// count 为窗口内累计次数（含本次）；满 limit 时不增加计数（避免计数无限涨），
	// retryAfterSec 为窗口剩余秒数（供 Retry-After / 前端倒计时参考）。
	async consume(c, key, limit, windowSeconds) {
		const now = Math.floor(Date.now() / 1000);
		const kvKey = WIN_PREFIX + key;
		try {
			const raw = await c.env.kv.get(kvKey, { type: 'json' });
			let state = raw && typeof raw === 'object' ? raw : null;
			if (!state || !state.resetAt || state.resetAt <= now) {
				state = { count: 0, resetAt: now + windowSeconds };
			}
			if (state.count >= limit) {
				return { allowed: false, count: state.count, retryAfterSec: Math.max(1, state.resetAt - now) };
			}
			state.count += 1;
			const ttl = Math.max(1, state.resetAt - now);
			await c.env.kv.put(kvKey, JSON.stringify(state), { expirationTtl: ttl });
			return { allowed: true, count: state.count, retryAfterSec: 0 };
		} catch (e) {
			console.error('限流计数失败（放行）:', e.message);
			return { allowed: true, count: 0, retryAfterSec: 0 };
		}
	},

	// 读窗口内已累计次数（不消费），供调用方做阈值判断/展示。
	async peek(c, key) {
		const now = Math.floor(Date.now() / 1000);
		try {
			const raw = await c.env.kv.get(WIN_PREFIX + key, { type: 'json' });
			if (!raw || !raw.resetAt || raw.resetAt <= now) {
				return { count: 0, resetAt: 0 };
			}
			return { count: raw.count || 0, resetAt: raw.resetAt };
		} catch (e) {
			return { count: 0, resetAt: 0 };
		}
	},

	// 清窗口计数（成功后调用，如登录成功清账号维度的失败计数）。
	async clearWindow(c, key) {
		try {
			await c.env.kv.delete(WIN_PREFIX + key);
		} catch (e) {
			console.error('清限流窗口失败:', e.message);
		}
	},

	// 读锁：返回 { locked, until, level }；过期锁视为无锁（不主动删，由 TTL 兜底）。
	async getLock(c, key) {
		try {
			const raw = await c.env.kv.get(LOCK_PREFIX + key, { type: 'json' });
			if (!raw || !raw.until) {
				return { locked: false, until: 0, level: 0 };
			}
			const now = Math.floor(Date.now() / 1000);
			if (raw.until <= now) {
				return { locked: false, until: 0, level: raw.level || 0 };
			}
			return { locked: true, until: raw.until, level: raw.level || 1 };
		} catch (e) {
			console.error('读限流锁失败（视为无锁）:', e.message);
			return { locked: false, until: 0, level: 0 };
		}
	},

	// 上锁：level 不传时自动在旧 level 上 +1（指数退避升级）；返回 { until, level, seconds }。
	async setLock(c, key, baseSeconds, level) {
		try {
			const prev = await this.getLock(c, key);
			const nextLevel = level !== undefined ? Math.max(1, Number(level) || 1) : (prev.level || 0) + 1;
			const seconds = backoffSeconds(baseSeconds, nextLevel);
			const until = Math.floor(Date.now() / 1000) + seconds;
			await c.env.kv.put(LOCK_PREFIX + key, JSON.stringify({ until, level: nextLevel }), { expirationTtl: seconds });
			return { until, level: nextLevel, seconds };
		} catch (e) {
			console.error('写限流锁失败:', e.message);
			return { until: 0, level: 0, seconds: 0 };
		}
	},

	// 解锁（管理员手动解 / 锁到期后的清理）。
	async clearLock(c, key) {
		try {
			await c.env.kv.delete(LOCK_PREFIX + key);
		} catch (e) {
			console.error('清限流锁失败:', e.message);
		}
	}
};

export default ratelimit;
