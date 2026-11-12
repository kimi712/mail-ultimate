import orm from '../entity/orm';
import registerLog from '../entity/register-log';
import { eq, and, sql, count, inArray } from 'drizzle-orm';
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
			// 批量薅号防线（v3_18DB）：ip_subnet 用原始 IP 算（脱敏前），脱敏后的 ip 列
			//（末段 → 0）算不出准确 /24。迁移前旧行该列为空串，段限流计数时跳过空串。
			const ipSubnet = reqUtils.getIpSubnet(c, ip);
			await orm(c).insert(registerLog).values({
				ip: await maybeMaskIp(c, ip), ipSegment, ipSubnet, email, regKeyCode, result, failReason, verifyMode, ua: String(ua || '').slice(0, 500)
			}).run();
		} catch (e) {
			console.error('写注册日志失败:', e.message);
		}
	},

	// 并发占位（修先查后写竞态）：单条原子 INSERT，仅当窗口内 SUCCESS+RESERVED
	// 计数 < limit 时才插入一行 result=RESERVED，返回其 log_id；否则返回 null。
	// SQLite 单条语句原子执行，并发请求无法同时通过检查，从根本上堵住
	// “同一秒连建 10 个号”绕过 3/24h 限额的漏洞。
	// 批量薅号防线（v3_18DB）：同一原子语句里再加两道段级限流——
	// ① 同网段 24 小时内 SUCCESS+RESERVED < segmentLimit（默认 9，设置可调）；
	// ② 同网段滚动 7 天内 < segmentLimit × 3（默认 27）：同一批代理 IP 多日累积
	//    也能拦住（2026-11-08 19:35 与 11-10 两波用的是同一批代理 IP）。
	//    7 天 cap 只拦持续薅号的网段——共用出口真人一天 2 个、一周 14 个到不了 27。
	// ip_subnet 为空（迁移前旧行）或 'Unknown' 时段检查自动跳过（skipSegment=1），
	// 不把历史行算进同一个“空网段”，不误拦未知 IP。
	async reserveSlot(c, { ip = '', ipSegment = '', email = '', limit = 3, windowHours = 24, segmentLimit = 9, segmentWindowHours = 24, ipSubnet = '', ua = '' }) {
		try {
			const subnet = ipSubnet || reqUtils.getIpSubnet(c, ip);
			const skipSegment = (!subnet || subnet === 'Unknown') ? 1 : 0;
			const weekLimit = Math.max(1, Number(segmentLimit) * 3);
			// 占位行同步写 ua（截断 500，与 record() 同口径）：原先没写，凡是拿到占位
			// 行后才失败/成功的注册，日志 ua 全是空，清理的 UA 信号与人工取证都会失真。
			const uaText = String(ua || '').slice(0, 500);
			const res = await c.env.db.prepare(
				`INSERT INTO register_log (ip, ip_segment, ip_subnet, email, result, ua, create_time)
				 SELECT ?, ?, ?, ?, ?, ?, datetime('now')
				 WHERE (SELECT COUNT(*) FROM register_log WHERE ip_segment = ? AND result IN (0, 2) AND create_time >= datetime('now', ?)) < ?
				 AND (? = 1 OR (SELECT COUNT(*) FROM register_log WHERE ip_subnet = ? AND ip_subnet != '' AND result IN (0, 2) AND create_time >= datetime('now', ?)) < ?)
				 AND (? = 1 OR (SELECT COUNT(*) FROM register_log WHERE ip_subnet = ? AND ip_subnet != '' AND result IN (0, 2) AND create_time >= datetime('now', ?)) < ?)`
			).bind(
				await maybeMaskIp(c, ip), ipSegment, subnet, email || '',
				registerLogConst.result.RESERVED, uaText,
				ipSegment, `-${windowHours} hours`, limit,
				skipSegment, subnet, `-${segmentWindowHours} hours`, segmentLimit,
				skipSegment, subnet, '-7 days', weekLimit
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

	// 批量薅号防线：同网段窗口内 SUCCESS+RESERVED 数（reserveSlot 占位失败后，
	// 由调用方用它区分“单 IP 限额”还是“网段限额”）。
	async countRecentBySubnet(c, subnet, hours) {
		try {
			if (!subnet || subnet === 'Unknown') return 0;
			const row = await orm(c).select({ n: count() }).from(registerLog).where(and(
				eq(registerLog.ipSubnet, subnet),
				inArray(registerLog.result, [registerLogConst.result.SUCCESS, registerLogConst.result.RESERVED]),
				sql`${registerLog.createTime} >= datetime('now', ${'-' + hours + ' hours'})`
			)).get();
			return row?.n || 0;
		} catch (e) {
			console.error('统计网段注册数失败:', e.message);
			return 0;
		}
	},

	// 批量薅号防线：同 IP（ip_segment；v4 即完整 IP）最近 N 分钟内 SUCCESS+RESERVED 数。
	// 只认成功与占位，不认纯失败尝试——避免真人一次输错密码后重试被误判为“集中注册”。
	async countRecentSuccessBySegment(c, ipSegment, minutes) {
		try {
			const row = await orm(c).select({ n: count() }).from(registerLog).where(and(
				eq(registerLog.ipSegment, ipSegment),
				inArray(registerLog.result, [registerLogConst.result.SUCCESS, registerLogConst.result.RESERVED]),
				sql`${registerLog.createTime} >= datetime('now', ${'-' + minutes + ' minutes'})`
			)).get();
			return row?.n || 0;
		} catch (e) {
			console.error('统计 IP 近期注册数失败:', e.message);
			return 0;
		}
	},

	// 批量薅号防线：同网段最近 N 分钟内 SUCCESS+RESERVED 数。
	async countRecentSuccessBySubnet(c, subnet, minutes) {
		try {
			if (!subnet || subnet === 'Unknown') return 0;
			const row = await orm(c).select({ n: count() }).from(registerLog).where(and(
				eq(registerLog.ipSubnet, subnet),
				inArray(registerLog.result, [registerLogConst.result.SUCCESS, registerLogConst.result.RESERVED]),
				sql`${registerLog.createTime} >= datetime('now', ${'-' + minutes + ' minutes'})`
			)).get();
			return row?.n || 0;
		} catch (e) {
			console.error('统计网段近期注册数失败:', e.message);
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
