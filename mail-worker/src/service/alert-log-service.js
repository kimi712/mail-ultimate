import orm from '../entity/orm';
import alertLog from '../entity/alert-log';
import { and, count, desc, eq, gte, lte } from 'drizzle-orm';

// 告警日志服务（Phase 2–4 总协调）：TG 告警的统一落库 + 查询。
// 所有方法永不抛错，不得影响主流程（调用方是 sendAlert 与巡检记录接口）。
const alertLogService = {

	// type: circuit | quota | reg-key | patrol | waf | system；source: worker | patrol
	async record(c, { type = 'system', text = '', source = 'worker' } = {}) {
		try {
			if (!text) {
				return;
			}
			await orm(c).insert(alertLog).values({
				type,
				text: String(text).slice(0, 2000),
				source
			}).run();
		} catch (e) {
			console.error('写告警日志失败:', e.message);
		}
	},

	async list(c, { type, num = 1, size = 50, startDate, endDate } = {}) {
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

		const conditions = [];
		if (type) {
			conditions.push(eq(alertLog.type, type));
		}
		if (startDate) {
			conditions.push(gte(alertLog.createTime, startDate));
		}
		if (endDate) {
			conditions.push(lte(alertLog.createTime, endDate));
		}

		const where = conditions.length ? and(...conditions) : undefined;
		const offset = (num - 1) * size;

		const list = await orm(c).select().from(alertLog)
			.where(where)
			.orderBy(desc(alertLog.logId))
			.limit(size).offset(offset).all();
		const totalRow = await orm(c).select({ total: count() }).from(alertLog)
			.where(where).get();

		return { list, total: totalRow.total };
	}

};

export default alertLogService;
