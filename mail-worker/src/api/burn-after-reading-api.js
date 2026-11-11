// 斯诺登第四批 P1-3：阅后即焚策略 API（新增路由文件）。
// 挂载：在 mail-worker/src/hono/webs.js 里加一行
//   import '../api/burn-after-reading-api'
// 即可。
//   GET /email/burn-policy?e2ee=1&expireOption=burn
//       写信页发信前校验：burn 是否允许（明文信选 burn 会被降级，
//       返回 allowed=false + reason=burn_requires_e2ee，前端据此
//       提示用户改开 E2EE 或改选定时自毁）。
//   GET /email/burn-verify?group=burn_xxx
//       核验某组是否已彻底焚毁（remaining=0 为已焚毁；组不属于本人时
//       不透露，返回 not_yours）。
// 注意：真正的焚毁执行仍在 email-service.read() 与 sweepExpired() 里，
// 本 API 只做策略判定与核验，不复制删除逻辑。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import burnAfterReadingService from '../service/burn-after-reading-service';

app.get('/email/burn-policy', async (c) => {
	const params = c.req.query();
	const policy = burnAfterReadingService.resolveBurnPolicy({
		e2ee: Number(params.e2ee || 0),
		expireOption: params.expireOption || 'none',
	});
	return c.json(result.ok(policy));
});

app.get('/email/burn-verify', async (c) => {
	const params = c.req.query();
	const data = await burnAfterReadingService.verifyGroupBurned(
		c,
		userContext.getUserId(c),
		params.group || ''
	);
	return c.json(result.ok(data));
});

export default app;
