import app from '../hono/hono';
import result from '../model/result';
import settingService from '../service/setting-service';
import telegramService from '../service/telegram-service';
import userContext from "../security/user-context";

app.put('/setting/set', async (c) => {
	await settingService.set(c, await c.req.json());
	return c.json(result.ok());
});

// 管理员手动把 Telegram webhook 指到本站域名（部署后调用；
// 域名取系统设置的 customDomain，未配则取 env.domain 第一个）。
app.post('/setting/tgWebhook', async (c) => {
	const data = await telegramService.setWebhook(c);
	return c.json(result.ok(data));
});

app.get('/setting/query', async (c) => {
	const setting = await settingService.get(c);
	return c.json(result.ok(setting));
});

app.get('/setting/websiteConfig', async (c) => {
	const setting = await settingService.websiteConfig(c);
	return c.json(result.ok(setting));
})

app.put('/setting/setBackground', async (c) => {
	const key = await settingService.setBackground(c, await c.req.json());
	return c.json(result.ok(key));
});

app.delete('/setting/deleteBackground', async (c) => {
	await settingService.deleteBackground(c);
	return c.json(result.ok());
});

app.put('/setting/setBlacklist', async (c) => {
	const setting = await settingService.setBlacklist(c, await c.req.json());
	return c.json(result.ok(setting));
})

