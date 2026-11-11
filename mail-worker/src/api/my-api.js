import app from '../hono/hono';
import userService from '../service/user-service';
import settingService from '../service/setting-service';
import telegramService from '../service/telegram-service';
import result from '../model/result';
import userContext from '../security/user-context';
import loginLogService from '../service/login-log-service';
import orm from '../entity/orm';
import user from '../entity/user';
import { eq } from 'drizzle-orm';
import { settingConst } from '../const/entity-const';
import BizError from '../error/biz-error';

app.get('/my/loginUserInfo', async (c) => {
	const user = await userService.loginUserInfo(c, userContext.getUserId(c));
	return c.json(result.ok(user));
});

// Phase 2 A 路：本人登录记录。无 premKey（任意登录用户），userId 取 c.get('user').userId，仅限本人数据。
// 分页同 register-log-api：num（1 起）、size（默认 50，上限 50）。
app.get('/my/loginLog', async (c) => {
	const params = c.req.query();
	let { num, size } = params;

	size = Number(size);
	num = Number(num);

	if (isNaN(size)) {
		size = 50;
	}
	if (isNaN(num)) {
		num = 1;
	}
	if (size > 50) {
		size = 50;
	}

	const userId = c.get('user').userId;
	const data = await loginLogService.listByUser(c, userId, { num, size });
	return c.json(result.ok(data));
});

// Phase 2 A 路补充：语言偏好同步（后端 user.locale 列，总协调已在 v3_6DB 加列）。
// 仅限本人数据；locale 只接受 14 种对外存储值（中文 zh-CN、英文 en、其余 12 种短码同值）。
// 2026-11-10 由 8 种扩到 14 种（新增 pt/id/de/ar/hi/th，与前端 locale.js 保持一致）。
const LOCALES = ['zh-CN', 'en', 'ja', 'ko', 'vi', 'ru', 'es', 'fr', 'pt', 'id', 'de', 'ar', 'hi', 'th'];

app.get('/my/locale', async (c) => {
	const userId = c.get('user').userId;
	const row = await orm(c).select({ locale: user.locale }).from(user)
		.where(eq(user.userId, userId)).get();
	return c.json(result.ok({ locale: row?.locale || '' }));
});

app.post('/my/locale', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const { locale } = body;
	if (!LOCALES.includes(locale)) {
		throw new BizError('Invalid locale', 400);
	}
	const userId = c.get('user').userId;
	await orm(c).update(user).set({ locale }).where(eq(user.userId, userId)).run();
	return c.json(result.ok());
});

// Phase 7 壁纸：壁纸偏好同步（后端 user.wallpaper / user.wallpaper_tags，v3_10DB 加列）。
// 仅限本人数据；wallpaper 为预置清单 id（如 snowden-vista）或自定义上传 URL
// （/oss/wallpapers/{userId}/{时间戳}.{ext}），空 = 默认 snowden-vista；
// wallpaperTags 为喜好标签数组（最多 10 个，每项 ≤20 字），逗号分隔存库。
const WALLPAPER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const WALLPAPER_CUSTOM_RE = /^\/oss\/wallpapers\/\d+\/\d+\.(jpg|png|webp)$/;

function normalizeWallpaperTags(tags) {
	if (!Array.isArray(tags)) {
		throw new BizError('Invalid wallpaperTags', 400);
	}
	if (tags.length > 10) {
		throw new BizError('Invalid wallpaperTags', 400);
	}
	return tags.map((tag) => String(tag).trim()).filter((tag) => {
		if (!tag || tag.length > 20 || tag.includes(',')) {
			throw new BizError('Invalid wallpaperTags', 400);
		}
		return true;
	});
}

app.get('/my/wallpaper', async (c) => {
	const userId = c.get('user').userId;
	const row = await orm(c).select({ wallpaper: user.wallpaper, wallpaperTags: user.wallpaperTags }).from(user)
		.where(eq(user.userId, userId)).get();
	return c.json(result.ok({
		wallpaper: row?.wallpaper || '',
		wallpaperTags: row?.wallpaperTags ? row.wallpaperTags.split(',').filter(Boolean) : []
	}));
});

app.post('/my/wallpaper', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const { wallpaper = '', wallpaperTags = [] } = body;
	if (typeof wallpaper !== 'string' || wallpaper.length > 512
		|| (wallpaper !== '' && !WALLPAPER_ID_RE.test(wallpaper) && !WALLPAPER_CUSTOM_RE.test(wallpaper))) {
		throw new BizError('Invalid wallpaper', 400);
	}
	const tags = normalizeWallpaperTags(wallpaperTags);
	const userId = c.get('user').userId;
	await orm(c).update(user).set({ wallpaper, wallpaperTags: tags.join(',') })
		.where(eq(user.userId, userId)).run();
	return c.json(result.ok());
});

app.put('/my/resetPassword', async (c) => {
	await userService.resetPassword(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.delete('/my/delete', async (c) => {
	await userService.delete(c, userContext.getUserId(c));
	return c.json(result.ok());
});

// 自助彻底删除：双重确认（密码 + 输入 DELETE），不看 setting.syncDelete，
// 用户本人决定即物理删除全部数据。见 PHASE7-HARDDELETE.md。
app.post('/my/hard-delete', async (c) => {
	await userService.hardDeleteSelf(c, userContext.getUserId(c), await c.req.json().catch(() => ({})));
	return c.json(result.ok());
});

// 用户自助绑定 Telegram：仅限本人数据。
// GET /my/telegram：绑定状态（bound / chatId）。
// POST /my/telegram/bind-code：生成一次性绑定码（10 分钟有效），
// 返回 t.me 链接；需站长已配 Bot Token 且用户推送总开关开启。
// POST /my/telegram/unbind：解绑（清掉 tg_chat_id 与未用的绑定码）。
app.get('/my/telegram', async (c) => {
	// 诱饵会话（v3_16DB）：恒返回未绑定（不透露真实绑定状态）。
	if (userContext.isDecoy(c)) {
		return c.json(result.ok({ bound: false, chatId: '' }));
	}
	const userId = c.get('user').userId;
	const row = await orm(c).select({ tgChatId: user.tgChatId }).from(user)
		.where(eq(user.userId, userId)).get();
	const chatId = row?.tgChatId || '';
	return c.json(result.ok({ bound: !!chatId, chatId }));
});

app.post('/my/telegram/bind-code', async (c) => {
	// 诱饵会话（v3_16DB）：拒绝生成绑定码（不写真实绑定状态）。
	if (userContext.isDecoy(c)) {
		throw new BizError('Telegram 推送未开启（站长未配置机器人）', 400);
	}
	const { tgBotToken, tgUserPush } = await settingService.query(c);
	if (!tgBotToken) {
		throw new BizError('Telegram 推送未开启（站长未配置机器人）', 400);
	}
	if (tgUserPush === settingConst.tgUserPush.CLOSE) {
		throw new BizError('Telegram 推送已关闭', 400);
	}
	const userId = c.get('user').userId;
	const { code, expiresAt } = telegramService.generateBindCode();
	await orm(c).update(user).set({ tgBindCode: code, tgBindExpires: expiresAt })
		.where(eq(user.userId, userId)).run();
	const botUsername = await telegramService.getBotUsername(c);
	const link = botUsername ? `https://t.me/${botUsername}?start=${code}` : '';
	return c.json(result.ok({ code, link, botUsername: botUsername || '', expiresAt }));
});

app.post('/my/telegram/unbind', async (c) => {
	// 诱饵会话（v3_16DB）：假装解绑成功，实际不动真实绑定。
	if (userContext.isDecoy(c)) {
		return c.json(result.ok());
	}
	const userId = c.get('user').userId;
	await orm(c).update(user).set({ tgChatId: '', tgBindCode: '', tgBindExpires: '' })
		.where(eq(user.userId, userId)).run();
	return c.json(result.ok());
});

// 金丝雀声明日期（安全中心展示）：取 setting.canary_date，默认部署当天，管理员在系统设置里改。
app.get('/my/canary', async (c) => {
	const { canaryDate } = await settingService.query(c);
	return c.json(result.ok({ canaryDate: canaryDate || '2026-11-09' }));
});


