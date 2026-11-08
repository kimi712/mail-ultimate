import app from '../hono/hono';
import result from '../model/result';
import orm from '../entity/orm';
import registerLog from '../entity/register-log';
import { and, count, desc, eq, gte, lte, sql } from 'drizzle-orm';

// 注册日志查询（Phase 1 C 路）：按 ip / 结果 / 时间范围筛选 + 分页。
// 分页写法复用 user-service.list：num（1 起）、size（默认 50，上限 50）。
app.get('/registerLog/list', async (c) => {
	const params = c.req.query();
	let { num, size, ip, result: resultParam, startDate, endDate } = params;

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
	if (ip) {
		conditions.push(sql`${registerLog.ip} LIKE ${ip + '%'}`);
	}
	if (resultParam !== undefined && resultParam !== '' && !isNaN(Number(resultParam))) {
		conditions.push(eq(registerLog.result, Number(resultParam)));
	}
	if (startDate) {
		conditions.push(gte(registerLog.createTime, startDate));
	}
	if (endDate) {
		conditions.push(lte(registerLog.createTime, endDate));
	}

	const where = conditions.length ? and(...conditions) : undefined;
	const offset = (num - 1) * size;

	const list = await orm(c).select().from(registerLog)
		.where(where)
		.orderBy(desc(registerLog.logId))
		.limit(size).offset(offset).all();
	const totalRow = await orm(c).select({ total: count() }).from(registerLog)
		.where(where).get();

	return c.json(result.ok({ list, total: totalRow.total }));
});
