import app from '../hono/hono';
import result from '../model/result';
import assistantService from '../service/assistant-service';
import translationService from '../service/translation-service';
import userContext from '../security/user-context';

// Phase 8：AI 助手新端点（Layer 3 薄适配层：只做鉴权、入参透传、调用
// Layer 2、返回码映射）。/ai/* 不在 security.js 白名单内，未登录由中间
// 件统一拦 401；无需额外权限点，任意登录用户可用。业务错误遵循项目约定：
// Hono onError 恒返回 HTTP 200，真实错误码在 body.code；AI 错误码为语言
// 无关字符串（ai_disabled / ai_quota_exceeded / ai_unavailable /
// ai_invalid_input / ai_not_found），前端按 body.code 查 ai.* 翻译 key 展示。
// 已有的 /ai/compose|reply|summarize 在 ai-api.js，不在此重复实现。
// 路由注册行由总协调加进 webs.js（见 PHASE8 子代理 C 汇报）。
app.post('/ai/chat', async (c) => {
	const data = await assistantService.chat(c, userContext.getUserId(c), await c.req.json().catch(() => ({})));
	return c.json(result.ok(data));
});

app.get('/ai/chat/history', async (c) => {
	const data = await assistantService.history(c, userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.post('/ai/chat/clear', async (c) => {
	const data = await assistantService.clearHistory(c, userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.post('/ai/triage', async (c) => {
	const data = await assistantService.triage(c, userContext.getUserId(c), await c.req.json().catch(() => ({})));
	return c.json(result.ok(data));
});

app.post('/ai/translate', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	// stream: true 时返回 SSE 流式响应（逐 token），否则一次性 JSON。
	// 与 /ai/compose 同一约定：流式调用的业务错误在建流前抛出，走 onError 返回标准 JSON。
	if (body.stream) {
		return translationService.translateStream(c, userContext.getUserId(c), body);
	}
	const data = await translationService.translate(c, userContext.getUserId(c), body);
	return c.json(result.ok(data));
});
