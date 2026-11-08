import app from '../hono/hono';
import result from '../model/result';
import alertLogService from '../service/alert-log-service';

// 告警日志查询（Phase 2–4 总协调）：按 type / 时间范围筛选 + 分页。
// 分页写法复用 register-log-api：num（1 起）、size（默认 50，上限 50）。
app.get('/alertLog/list', async (c) => {
	const params = c.req.query();
	const { list, total } = await alertLogService.list(c, params);
	return c.json(result.ok({ list, total }));
});

// 告警日志记录（供甲骨文巡检调用，管理员 JWT）：type + text 必填。
app.post('/alertLog/record', async (c) => {
	const params = await c.req.json();
	const { type, text } = params || {};
	if (!text) {
		return c.json(result.fail('text is required'));
	}
	await alertLogService.record(c, { type: type || 'patrol', text, source: 'patrol' });
	return c.json(result.ok({}));
});
