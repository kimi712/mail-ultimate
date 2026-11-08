import app from '../hono/hono';
import result from '../model/result';
import orm from '../entity/orm';
import auditLog from '../entity/audit-log';
import { and, count, desc, eq, gte, lte, sql } from 'drizzle-orm';

// 审计日志查询（Phase 1 C 路）：按 ip / 操作 / 操作人 / 时间范围筛选 + 分页。
// 分页写法复用 user-service.list：num（1 起）、size（默认 50，上限 50）。
app.get('/auditLog/list', async (c) => {
	const params = c.req.query();
	let { num, size, ip, action, actorUserId, startDate, endDate } = params;

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
		conditions.push(sql`${auditLog.ip} LIKE ${ip + '%'}`);
	}
	if (action) {
		conditions.push(eq(auditLog.action, action));
	}
	if (actorUserId !== undefined && actorUserId !== '' && !isNaN(Number(actorUserId))) {
		conditions.push(eq(auditLog.actorUserId, Number(actorUserId)));
	}
	if (startDate) {
		conditions.push(gte(auditLog.createTime, startDate));
	}
	if (endDate) {
		conditions.push(lte(auditLog.createTime, endDate));
	}

	const where = conditions.length ? and(...conditions) : undefined;
	const offset = (num - 1) * size;

	const list = await orm(c).select().from(auditLog)
		.where(where)
		.orderBy(desc(auditLog.logId))
		.limit(size).offset(offset).all();
	const totalRow = await orm(c).select({ total: count() }).from(auditLog)
		.where(where).get();

	return c.json(result.ok({ list, total: totalRow.total }));
});
