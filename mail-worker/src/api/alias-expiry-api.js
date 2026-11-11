// 斯诺登第四批 P2-5：别名有效期 API（新增路由文件）。
// 挂载：在 mail-worker/src/hono/webs.js 里加一行
//   import '../api/alias-expiry-api'
// 即可。
//   POST /alias/expiry {aliasId, days}
//       给自己的别名设有效期（days ∈ 0/1/7/30/90/365，0=不限期）。
//   GET /alias/expiry?aliasId=
//       查单个别名的有效期与是否已过期。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import aliasExpiryService from '../service/alias-expiry-service';
import BizError from '../error/biz-error';

app.post('/alias/expiry', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	if (!body.aliasId) {
		throw new BizError('缺少别名', 400);
	}
	const data = await aliasExpiryService.setExpiry(c, userContext.getUserId(c), body.aliasId, body.days);
	return c.json(result.ok(data));
});

app.get('/alias/expiry', async (c) => {
	const params = c.req.query();
	if (!params.aliasId) {
		throw new BizError('缺少别名', 400);
	}
	const data = await aliasExpiryService.getExpiry(c, userContext.getUserId(c), params.aliasId);
	return c.json(result.ok(data));
});

export default app;
