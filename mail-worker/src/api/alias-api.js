import app from '../hono/hono';
import aliasService from '../service/alias-service';
import result from '../model/result';
import userContext from '../security/user-context';
import BizError from '../error/biz-error';

// 一次性别名邮箱（仅限本人数据）：列表 / 生成 / 停用 / 启用 / 删除。
// 别名收到的信进主收件箱；停用后往该别名发信直接拒收。
app.get('/my/alias', async (c) => {
	const list = await aliasService.list(c, userContext.getUserId(c));
	return c.json(result.ok(list));
});

app.post('/my/alias', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const item = await aliasService.create(c, userContext.getUserId(c), body.domain);
	return c.json(result.ok(item));
});

app.post('/my/alias/:id/disable', async (c) => {
	const data = await aliasService.setStatus(c, userContext.getUserId(c), c.req.param('id'), 1);
	return c.json(result.ok(data));
});

app.post('/my/alias/:id/enable', async (c) => {
	const data = await aliasService.setStatus(c, userContext.getUserId(c), c.req.param('id'), 0);
	return c.json(result.ok(data));
});

app.delete('/my/alias/:id', async (c) => {
	const data = await aliasService.remove(c, userContext.getUserId(c), c.req.param('id'));
	return c.json(result.ok(data));
});
