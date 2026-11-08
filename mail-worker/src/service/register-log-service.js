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

	async record(c, { ip = '', ipSegment = '', email = '', regKeyCode = '', result = registerLogConst.result.SUCCESS, failReason = '', verifyMode = 0, ua = '' }) {
		try {
			await orm(c).insert(registerLog).values({
				ip: await maybeMaskIp(c, ip), ipSegment, email, regKeyCode, result, failReason, verifyMode, ua
			}).run();
		} catch (e) {
			console.error('写注册日志失败:', e.message);
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
