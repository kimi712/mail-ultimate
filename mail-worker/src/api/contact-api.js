// Phase 8 F：联系人 / 通讯录 API（只查本人联系人）。
// 路由注册行见汇报（webs.js 由总协调加）。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import contactService from '../service/contact-service';

app.post('/contacts/add', async (c) => {
	const data = await contactService.add(c, userContext.getUserId(c), await c.req.json());
	return c.json(result.ok(data));
});

// 从一封往来邮件一键加联系人（已存在时返回 added: false，不报错）。
app.post('/contacts/add-from-email', async (c) => {
	const { emailId } = await c.req.json();
	const data = await contactService.addFromEmail(c, userContext.getUserId(c), emailId);
	return c.json(result.ok(data));
});

app.get('/contacts/list', async (c) => {
	const data = await contactService.list(c, userContext.getUserId(c), c.req.query());
	return c.json(result.ok(data));
});

// 写信时收件人自动补全（q 模糊匹配 name/email，最多 10 条）。
app.get('/contacts/suggest', async (c) => {
	const { q = '' } = c.req.query();
	const list = await contactService.suggest(c, userContext.getUserId(c), q);
	return c.json(result.ok({ list }));
});

app.delete('/contacts/delete', async (c) => {
	const { contactId } = c.req.query();
	await contactService.remove(c, userContext.getUserId(c), contactId);
	return c.json(result.ok());
});
