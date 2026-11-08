import app from '../hono/hono';
import result from '../model/result';
import aiService from '../service/ai-service';
import userContext from '../security/user-context';

// Phase 7：AI 写信 / 回信 / 摘要（Workers AI 开源权重模型）。
// 鉴权：/ai/* 不在 security.js 白名单内，未登录由中间件统一拦 401；
// 无需额外权限点，任意登录用户可用。业务错误遵循项目约定：Hono onError
// 恒返回 HTTP 200，真实错误码在 body.code；AI 错误码为语言无关字符串
// （ai_disabled / ai_quota_exceeded / ai_unavailable / ai_invalid_input /
// ai_not_found），前端按 body.code 查 ai.* 翻译 key 展示。
app.post('/ai/compose', async (c) => {
	const data = await aiService.compose(c, userContext.getUserId(c), await c.req.json().catch(() => ({})));
	return c.json(result.ok(data));
});

app.post('/ai/reply', async (c) => {
	const data = await aiService.reply(c, userContext.getUserId(c), await c.req.json().catch(() => ({})));
	return c.json(result.ok(data));
});

app.post('/ai/summarize', async (c) => {
	const data = await aiService.summarize(c, userContext.getUserId(c), await c.req.json().catch(() => ({})));
	return c.json(result.ok(data));
});
