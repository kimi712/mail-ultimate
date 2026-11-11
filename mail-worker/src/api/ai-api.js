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
	const body = await c.req.json().catch(() => ({}));
	// stream: true 时返回 SSE 流式响应（逐 token），否则一次性 JSON。
	// 流式调用的业务错误（配额/输入非法等）在建流前抛出，走 Hono onError 返回标准 JSON 错误，前端按 content-type 区分。
	if (body.stream) {
		return aiService.composeStream(c, userContext.getUserId(c), body);
	}
	const data = await aiService.compose(c, userContext.getUserId(c), body);
	return c.json(result.ok(data));
});

app.post('/ai/reply', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	if (body.stream) {
		return aiService.replyStream(c, userContext.getUserId(c), body);
	}
	const data = await aiService.reply(c, userContext.getUserId(c), body);
	return c.json(result.ok(data));
});

app.post('/ai/summarize', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	// stream: true 时返回 SSE 流式响应（逐 token），否则一次性 JSON。
	// 与 /ai/compose 同一约定：流式调用的业务错误在建流前抛出，走 onError 返回标准 JSON。
	if (body.stream) {
		return aiService.summarizeStream(c, userContext.getUserId(c), body);
	}
	const data = await aiService.summarize(c, userContext.getUserId(c), body);
	return c.json(result.ok(data));
});

// AI 用量查询（顶栏额度展示用）：只读当日计数，不调模型、不计次数、
// 不受 aiEnabled 开关影响（开关关闭时顶栏入口隐藏，前端也不会调它）。
app.get('/ai/usage', async (c) => {
	const data = await aiService._getUsage(c, userContext.getUserId(c));
	return c.json(result.ok(data));
});
