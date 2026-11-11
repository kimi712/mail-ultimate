// Phase 8 F：隐私仪表盘 / 透明度中心 API（只读，仅限本人）。
// 路由注册行见汇报（webs.js 由总协调加）。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import privacyService from '../service/privacy-service';

app.get('/privacy/dashboard', async (c) => {
	const data = await privacyService.getDashboard(c, userContext.getUserId(c));
	return c.json(result.ok(data));
});
