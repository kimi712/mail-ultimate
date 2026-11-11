// Phase 8 F：邮件规则 / 过滤器 API（只查本人规则）。
// applyRules 由收信管线对新信调一次（接线点见汇报，HandleOnSiteEmail
// 落库后加一行调用），不经过 HTTP。路由注册行见汇报（webs.js 由总协调加）。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import mailRuleService from '../service/mail-rule-service';

app.post('/mail-rules/create', async (c) => {
	const data = await mailRuleService.create(c, userContext.getUserId(c), await c.req.json());
	return c.json(result.ok(data));
});

app.get('/mail-rules/list', async (c) => {
	const list = await mailRuleService.list(c, userContext.getUserId(c));
	return c.json(result.ok({ list }));
});

app.post('/mail-rules/update', async (c) => {
	const { ruleId, ...rest } = await c.req.json();
	const data = await mailRuleService.update(c, userContext.getUserId(c), ruleId, rest);
	return c.json(result.ok(data));
});

app.delete('/mail-rules/delete', async (c) => {
	const { ruleId } = c.req.query();
	await mailRuleService.remove(c, userContext.getUserId(c), ruleId);
	return c.json(result.ok());
});

// 重新排序：按 ruleIds 数组顺序重写 sort。
app.post('/mail-rules/reorder', async (c) => {
	const { ruleIds = [] } = await c.req.json();
	const list = await mailRuleService.reorder(c, userContext.getUserId(c), ruleIds);
	return c.json(result.ok({ list }));
});

// 某封信的标签（规则 tag / archive 动作的落地点）。
app.get('/mail-rules/labels', async (c) => {
	const { emailId } = c.req.query();
	const labels = await mailRuleService.listLabels(c, userContext.getUserId(c), emailId);
	return c.json(result.ok({ labels }));
});
