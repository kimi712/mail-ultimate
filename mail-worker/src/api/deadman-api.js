// 死亡开关（v3_15DB）：仅限本人配置，userId 一律取 c.get('user').userId。
// GET /my/deadman：当前配置 + 最后活跃 + 失联天数；
// POST /my/deadman：布防/改参（enabled/inactivityDays/action/contactEmail/message）；
// POST /my/deadman/disable：关闭开关（随时可关，任意登录也会因 active_time 刷新而自动取消）。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import deadmanService from '../service/deadman-service';

app.get('/my/deadman', async (c) => {
	const data = await deadmanService.get(c, userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.post('/my/deadman', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const data = await deadmanService.set(c, userContext.getUserId(c), body);
	return c.json(result.ok(data));
});

app.post('/my/deadman/disable', async (c) => {
	const data = await deadmanService.disable(c, userContext.getUserId(c));
	return c.json(result.ok(data));
});
