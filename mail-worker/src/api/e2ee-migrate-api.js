// E2EE 密钥重包 + 暴露状态 API（2026-11-12 uwu 第 1+2 步）。
// 全部仅限本人数据；诱饵会话下 wraps 返回空、rewrap/exposure 拒绝。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import e2eeMigrateService from '../service/e2ee-migrate-service';

app.get('/my/e2ee/wraps', async (c) => {
	const data = await e2eeMigrateService.listWraps(c, userContext.getUserId(c), {
		limit: c.req.query('limit'),
		offset: c.req.query('offset'),
	});
	return c.json(result.ok(data));
});

app.post('/my/e2ee/rewrap', async (c) => {
	const { items } = await c.req.json().catch(() => ({}));
	const data = await e2eeMigrateService.rewrap(c, userContext.getUserId(c), items);
	return c.json(result.ok(data));
});

app.post('/my/e2ee/exposure', async (c) => {
	const { state } = await c.req.json().catch(() => ({}));
	const data = await e2eeMigrateService.setExposure(c, userContext.getUserId(c), state);
	return c.json(result.ok(data));
});
