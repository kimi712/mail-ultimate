import app from '../hono/hono';
import result from '../model/result';
import quotaService from '../service/quota-service';

// Resend 配额查询（Phase 2–4 总协调）：返回日/月用量与预算，供后台仪表盘与甲骨文巡检读取。
// premKey 见 security.js：analysis:query。
app.get('/quota/resend', async (c) => {
	const usage = await quotaService.getResendUsage(c);
	return c.json(result.ok(usage));
});
