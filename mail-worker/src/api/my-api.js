import app from '../hono/hono';
import userService from '../service/user-service';
import result from '../model/result';
import userContext from '../security/user-context';
import loginLogService from '../service/login-log-service';
import orm from '../entity/orm';
import user from '../entity/user';
import { eq } from 'drizzle-orm';
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
// 仅限本人数据；locale 只接受 8 种对外存储值（中文 zh-CN、英文 en、其余 6 种短码同值）。
const LOCALES = ['zh-CN', 'en', 'ja', 'ko', 'vi', 'ru', 'es', 'fr'];

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


