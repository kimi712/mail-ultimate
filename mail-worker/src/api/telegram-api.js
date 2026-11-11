import app from '../hono/hono';
import result from '../model/result';
import telegramService from '../service/telegram-service';

app.get('/telegram/getEmail/:token', async (c) => {
	const content = await telegramService.getEmailContent(c, c.req.param());
	c.header('Cache-Control', 'public, max-age=604800, immutable');
	return c.html(content)
});

// 用户自助绑定 Telegram 的 webhook 入口：TG 服务器推 update 过来，无需本站登录。
// security.js 的 exclude 已有 '/telegram' 前缀放行；处理函数永不抛错，
// 这里恒返回 200，避免 TG 因非 200 反复重试。
app.post('/telegram/webhook', async (c) => {
	const update = await c.req.json().catch(() => ({}));
	await telegramService.handleWebhookUpdate(c, update);
	return c.json(result.ok());
});

