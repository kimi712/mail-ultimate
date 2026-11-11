import orm from '../entity/orm';
import loginLog from '../entity/login-log';
import { count, desc, eq } from 'drizzle-orm';
import reqUtils from '../utils/req-utils';
import settingService from './setting-service';
import userContext from '../security/user-context';

// Phase 6：setting.log_ip_mask=1 时写入前对 ip 列脱敏。
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

// 登录日志服务（Phase 2 A 路）：登录成功后写一条记录，供本人查看。
// record 永不抛错，不得影响登录主流程；时间由 D1 以 CURRENT_TIMESTAMP（UTC）写入。
const loginLogService = {

	async record(c, { userId = 0, email = '', ip = '', ua = '', isNewIp = 0 } = {}) {
		try {
			await orm(c).insert(loginLog).values({
				userId,
				email,
				ip: await maybeMaskIp(c, ip),
				ua: String(ua || '').slice(0, 500),
				isNewIp: isNewIp ? 1 : 0
			}).run();
		} catch (e) {
			console.error('写登录日志失败:', e.message);
		}
	},

	async listByUser(c, userId, { num = 1, size = 50 } = {}) {
		// 诱饵会话（v3_16DB）：登录历史为空（不透露真实登录 IP/设备）。
		if (userContext.isDecoy(c)) {
			return { list: [], total: 0 };
		}
		size = Number(size);
		num = Number(num);
		if (isNaN(size)) {
			size = 50;
		}
		if (isNaN(num)) {
			num = 1;
		}
		if (size > 50) {
			size = 50;
		}
		const offset = (num - 1) * size;
		const where = eq(loginLog.userId, Number(userId));
		const list = await orm(c).select().from(loginLog)
			.where(where)
			.orderBy(desc(loginLog.logId))
			.limit(size).offset(offset).all();
		const totalRow = await orm(c).select({ total: count() }).from(loginLog)
			.where(where).get();
		return { list, total: totalRow.total };
	}

};

export default loginLogService;
