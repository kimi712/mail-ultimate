import app from '../hono/hono';
import userService from '../service/user-service';
import result from '../model/result';
import userContext from '../security/user-context';
import accountService from '../service/account-service';

app.delete('/user/delete', async (c) => {
	await userService.physicsDelete(c, c.req.query());
	return c.json(result.ok());
});

app.put('/user/setPwd', async (c) => {
	await userService.setPwd(c, await c.req.json());
	return c.json(result.ok());
});

app.put('/user/setStatus', async (c) => {
	await userService.setStatus(c, await c.req.json());
	return c.json(result.ok());
});

app.put('/user/setType', async (c) => {
	await userService.setType(c, await c.req.json());
	return c.json(result.ok());
});

app.get('/user/list', async (c) => {
	const data = await userService.list(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(data));
});

// Phase 2 C 路：导出用户 CSV（权限 user:export，见 security.js）。
// BOM 由响应体首字符提供，供 Excel 识别中文；文件名带日期。
app.get('/user/export', async (c) => {
	const csv = await userService.exportCsv(c, c.req.query());
	const date = new Date().toISOString().slice(0, 10);
	return new Response('\uFEFF' + csv, {
		status: 200,
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="users-${date}.csv"`
		}
	});
});

// Phase 2 C 路：按注册 IP 聚合（权限 user:query，见 security.js）。
app.get('/user/groupByIp', async (c) => {
	const { min } = c.req.query();
	const data = await userService.groupByIp(c, { min });
	return c.json(result.ok(data));
});

app.post('/user/add', async (c) => {
	await userService.add(c, await c.req.json());
	return c.json(result.ok());
});

app.put('/user/resetSendCount', async (c) => {
	await userService.resetSendCount(c, await c.req.json());
	return c.json(result.ok());
});

// 管理员给指定用户解绑 Telegram（权限 user:set-status，见 security.js）。
app.put('/user/unbindTelegram', async (c) => {
	await userService.unbindTelegram(c, await c.req.json());
	return c.json(result.ok());
});

app.put('/user/restore', async (c) => {
	await userService.restore(c, await c.req.json());
	return c.json(result.ok());
});

app.get('/user/allAccount', async (c) => {
	const data = await accountService.allAccount(c, c.req.query());
	return c.json(result.ok(data));
});

app.delete('/user/deleteAccount', async (c) => {
	await accountService.physicsDelete(c, c.req.query());
	return c.json(result.ok());
});


