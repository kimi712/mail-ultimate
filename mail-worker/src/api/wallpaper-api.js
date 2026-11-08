import app from '../hono/hono';
import result from '../model/result';
import BizError from '../error/biz-error';
import userContext from '../security/user-context';
import r2Service from '../service/r2-service';
import fileUtils from '../utils/file-utils';

// Phase 7 壁纸：自定义壁纸上传（POST /wallpaper/upload）。
// 鉴权：/wallpaper/* 不在 security.js 白名单内，未登录由中间件统一拦 401；
// 无需额外权限点，任意登录用户可用（同 /ai/*）。
// 入参：JSON { image: 'data:image/jpeg|png|webp;base64,...' }（与 setBackground 同款 base64 入参，
// 前端不走 multipart，与现有 axios 拦截器兼容）。
// 校验：格式仅 jpeg/png/webp、解码后大小 ≤2MB；存 R2（未绑 R2 时按 r2Service 既有
// 回落走 KV/S3，与 setBackground 一致），路径 wallpapers/{userId}/{时间戳}.{ext}。
// 返回 { key, url }：key 为对象键，url 为本站可访问地址 /oss/{key}
// （无自定义 R2 域名时走本站 /oss/* 代理；配了 r2Domain 的前端用 cvtR2Url(key) 拼 CDN 地址）。
// 注意：/oss/* 在 security.js 白名单内，上传后的壁纸与附件、登录背景一样可公开访问。
const ALLOWED_MIME = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp'
};
const MAX_SIZE = 2 * 1024 * 1024;

app.post('/wallpaper/upload', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const { image } = body;
	if (typeof image !== 'string' || !image.startsWith('data:image/')) {
		throw new BizError('Invalid image', 400);
	}
	let file;
	try {
		file = fileUtils.base64ToFile(image);
	} catch (e) {
		throw new BizError('Invalid image', 400);
	}
	const ext = ALLOWED_MIME[file.type];
	if (!ext) {
		throw new BizError('Invalid image type', 400);
	}
	if (file.size > MAX_SIZE) {
		throw new BizError('Image too large', 400);
	}
	const arrayBuffer = await file.arrayBuffer();
	const userId = userContext.getUserId(c);
	const key = `wallpapers/${userId}/${Date.now()}.${ext}`;
	await r2Service.putObj(c, key, arrayBuffer, {
		contentType: file.type,
		cacheControl: `public, max-age=31536000, immutable`,
		contentDisposition: `inline; filename="wallpaper.${ext}"`
	});
	return c.json(result.ok({ key, url: `/oss/${key}` }));
});
