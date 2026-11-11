import orm from '../entity/orm';
import registerLog from '../entity/register-log';
import { eq, and, sql, count } from 'drizzle-orm';
import { registerLogConst } from '../const/entity-const';
import reqUtils from '../utils/req-utils';
import settingService from './setting-service';

// Phase 6：setting.log_ip_mask=1 时写入前对 ip 列脱敏（ip_segment 列不受影响）。
async function maybeMaskIp(c, ip) {
	try {
		const setting = await settingService.query(c);
		if (setting && Number(setting.logIpMask) === 1) {
			return reqUtils.maskIp(ip);
		}
	} catch (e) {
		// 读配置失败时不脱敏、不阻断写入
	}
	return ip;
}

// 注册日志：成功与失败都记。日志写入永不抛错，不得影响注册主流程。
// 时间口径：create_time 由 D1 以 CURRENT_TIMESTAMP（UTC）写入，
// 窗口统计一律用 SQLite datetime('now', ...) 比较，不混本地时区。
const registerLogService = {

	// Phase 7：UA 只用于人工识别设备，截断到 500 字符（与 login_log 一致），
	// 不把超长指纹串完整存库。
	async record(c, { ip = '', ipSegment = '', email = '', regKeyCode = '', result = registerLogConst.result.SUCCESS, failReason = '', verifyMode = 0, ua = '' }) {
		try {
			await orm(c).insert(registerLog).values({
				ip: await maybeMaskIp(c, ip), ipSegment, email, regKeyCode, result, failReason, verifyMode, ua: String(ua || '').slice(0, 500)
			}).run();
		} catch (e) {
			console.error('写注册日志失败:', e.message);
		}
	},

	// 并发占位（修先查后写竞态）：单条原子 INSERT，仅当窗口内 SUCCESS+RESERVED
	// 计数 < limit 时才插入一行 result=RESERVED，返回其 log_id；否则返回 null。
	// SQLite 单条语句原子执行，并发请求无法同时通过检查，从根本上堵住
	// “同一秒连建 10 个号”绕过 3/24h 限额的漏洞。
	async reserveSlot(c, { ip = '', ipSegment = '', email = '', limit = 3, windowHours = 24 }) {
		try {
			const res = await c.env.db.prepare(
				`INSERT INTO register_log (ip, ip_segment, email, result, create_time)
				 SELECT ?, ?, ?, ?, datetime('now')
				 WHERE (SELECT COUNT(*) FROM register_log WHERE ip_segment = ? AND result IN (0, 2) AND create_time >= datetime('now', ?)) < ?`
			).bind(
				await maybeMaskIp(c, ip), ipSegment, email || '',
				registerLogConst.result.RESERVED,
				ipSegment, `-${windowHours} hours`, limit
			).run();
			if (!res.meta || res.meta.changes === 0) return null;
			if (res.meta.last_row_id) return res.meta.last_row_id;
			// 兜底：取刚插入的占位行
			const row = await c.env.db.prepare(
				`SELECT log_id FROM register_log WHERE ip_segment = ? AND email = ? AND result = 2 ORDER BY log_id DESC LIMIT 1`
			).bind(ipSegment, email || '').first();
			return row?.log_id ?? null;
		} catch (e) {
			console.error('注册占位失败:', e.message);
			return null;
		}
	},

	// 把占位行收尾为最终结果（成功/失败），不另插新行，避免计数窗口抖动。
	async updateResult(c, logId, { result, failReason = '' }) {
		try {
			await orm(c).update(registerLog).set({ result, failReason }).where(eq(registerLog.logId, logId)).run();
		} catch (e) {
			console.error('更新注册日志失败:', e.message);
		}
	},

	async countSuccessBySegment(c, ipSegment, hours) {
		try {
			const row = await orm(c).select({ n: count() }).from(registerLog).where(and(
				eq(registerLog.ipSegment, ipSegment),
				eq(registerLog.result, registerLogConst.result.SUCCESS),
				sql`${registerLog.createTime} >= datetime('now', ${'-' + hours + ' hours'})`
			)).get();
			return row?.n || 0;
		} catch (e) {
			console.error('统计 IP 注册数失败:', e.message);
			return 0;
		}
	},

	async countAttemptsBySegment(c, ipSegment, minutes) {
		try {
			const row = await orm(c).select({ n: count() }).from(registerLog).where(and(
				eq(registerLog.ipSegment, ipSegment),
				sql`${registerLog.createTime} >= datetime('now', ${'-' + minutes + ' minutes'})`
			)).get();
			return row?.n || 0;
		} catch (e) {
			console.error('统计 IP 注册尝试数失败:', e.message);
			return 0;
		}
	},

	async countRecentAll(c, minutes) {
		try {
			const row = await orm(c).select({ n: count() }).from(registerLog).where(
				sql`${registerLog.createTime} >= datetime('now', ${'-' + minutes + ' minutes'})`
			).get();
			return row?.n || 0;
		} catch (e) {
			console.error('统计全站注册数失败:', e.message);
			return 0;
		}
	}

};

export default registerLogService;
