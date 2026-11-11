// Phase 8 · Layer 1 最小化日志统一入口（kernel/audit）。
// 只记元数据：actor / action / target / 脱敏 IP / 截断 UA；永不记正文与密钥值。
// - detail 只接受白名单式元数据：写入前按 key 名清洗，命中敏感 key
//   （password/secret/token/salt/hash/credential/private/auth/otp 类，
//   以及 code / *Code 结尾的 key——值本身就是秘密）的一律丢弃；
//   `keys`（被改设置项名列表）、`regKeyIds` 等 ID/名列表是合法元数据，保留。
//   序列化后截断 2000 字符。
// - IP 脱敏：读 KV `setting:` 缓存的 log_ip_mask（=1 时 IPv4 末段 → 0、IPv6 只留 /64）；
//   直接读 KV 缓存而不 import setting-service，避免与 setting-service ↔
//   audit-log-service 之间的循环依赖。读不到缓存时不脱敏、不阻断写入。
// - UA 截断 500 字符；不记地理位置；写入永不抛错，不得影响主流程。
// 旧的各 service 内联 record() 调用逐步迁到这里（本阶段先迁 audit-log-service
// 本身与新增的限流/审计路径，其余文件只在碰到时顺手迁）。
import orm from '../entity/orm';
import auditLog from '../entity/audit-log';
import reqUtils from '../utils/req-utils';
import userContext from '../security/user-context';
import KvConst from '../const/kv-const';

// 敏感 key 判定：密码/密钥/token/盐/hash/凭证类一律丢弃；`code` 与 `*Code`
// 结尾的 key（如注册码 code、备份码）同样丢弃（值本身就是秘密）；
// `keys`（被改设置项名列表）、`regKeyIds`（ID 列表）是合法元数据，不丢弃。
const FORBIDDEN_DETAIL_KEY = /pass(word)?|secret|token|passwd|pwd|salt|hash|credential|private|auth|otp|totp/i;
function isForbiddenDetailKey(k) {
	const lower = String(k).toLowerCase();
	if (FORBIDDEN_DETAIL_KEY.test(k)) {
		return true;
	}
	if (lower === 'code' || lower === 'key' || lower === 'apikey' || lower === 'api_key') {
		return true;
	}
	return /code$/i.test(k);
}
const MAX_DETAIL_LEN = 2000;
const MAX_UA_LEN = 500;

function scrubDetail(detail) {
	if (!detail || typeof detail !== 'object') {
		return {};
	}
	const out = {};
	for (const [k, v] of Object.entries(detail)) {
		if (isForbiddenDetailKey(k)) {
			continue;
		}
		if (v === null || v === undefined) {
			out[k] = v;
		} else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
			out[k] = typeof v === 'string' ? v.slice(0, 200) : v;
		} else if (Array.isArray(v)) {
			out[k] = v.slice(0, 10).map(item =>
				(typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
					? item : String(item).slice(0, 200));
		} else {
			// 嵌套对象只留一层标量，同样过敏感 key 清洗。
			const nested = {};
			for (const [nk, nv] of Object.entries(v)) {
				if (isForbiddenDetailKey(nk)) {
					continue;
				}
				if (typeof nv === 'string' || typeof nv === 'number' || typeof nv === 'boolean') {
					nested[nk] = typeof nv === 'string' ? nv.slice(0, 200) : nv;
				}
			}
			out[k] = nested;
		}
	}
	return out;
}

async function maybeMaskIp(c, ip) {
	try {
		const setting = await c.env.kv.get(KvConst.SETTING, { type: 'json' });
		const maskOn = setting && (Number(setting.logIpMask) === 1 || Number(setting.log_ip_mask) === 1);
		if (maskOn) {
			return reqUtils.maskIp(ip);
		}
	} catch (e) {
		// 读配置失败时不脱敏、不阻断写入
	}
	return ip;
}

const kernelAudit = {

	// 统一写审计日志。actorUserId 不传时取当前登录用户（无登录态记 0）。
	async audit(c, { actorUserId, action = '', targetType = '', targetId = '', detail = {} } = {}) {
		try {
			let actor = Number(actorUserId);
			if (!actor) {
				try {
					const user = userContext.getUser(c);
					actor = user && user.userId ? Number(user.userId) : 0;
				} catch (e) {
					actor = 0;
				}
			}
			let detailStr = '';
			try {
				detailStr = JSON.stringify(scrubDetail(detail)).slice(0, MAX_DETAIL_LEN);
			} catch (e) {
				detailStr = '';
			}
			await orm(c).insert(auditLog).values({
				actorUserId: actor || 0,
				action: String(action || '').slice(0, 200),
				targetType: String(targetType || '').slice(0, 100),
				targetId: String(targetId ?? '').slice(0, 200),
				ip: await maybeMaskIp(c, reqUtils.getIp(c)),
				ua: (c.req.header('user-agent') || '').slice(0, MAX_UA_LEN),
				detail: detailStr
			}).run();
		} catch (e) {
			console.error('写审计日志失败:', e.message);
		}
	},

	// 供测试与调用方复用的清洗函数（不写库）。
	scrubDetail,
	isForbiddenDetailKey
};

export default kernelAudit;
