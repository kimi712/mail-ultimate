// 用户文件安全 serve（2026-11-12 白帽反馈 #1：存储型 XSS）。
// 附件/壁纸/背景图的字节来自发件人或上传者，Content-Type 绝不能信任
// 发件人自带的 mimeType：同源 serve 时，text/html 与 image/svg+xml 会被
// 浏览器当作文档执行，脚本跑在本站源上，能读走 localStorage 里的会话
// token（同源脚本还削弱了 script-src 'self' 的意义）。
// 所有对外 serve 的用户文件（/attachments/、/static/、/oss/，经 R2/KV/S3
// 三路）统一走这里：
//   - 只放行无害的内联类型（图片 + 纯文本），其余一律
//     application/octet-stream + 强制下载；已入库的老对象同样受此约束，
//     不用迁移数据；
//   - 一律加 nosniff + sandbox CSP（万一被当文档加载也跑不了脚本）；
//   - Content-Disposition 不带文件名（发件人文件名未经清洗，绝不放进响应头）；
//   - 绝不把 null 写进响应头（旧代码把 null 当值传，会下发字面 "null"）。
// 残留：SVG 附件会变成强制下载（正文里内嵌的 SVG 图因此不显示，极少见）；
// localStorage 放会话 token 的问题仍在（改 httpOnly Cookie 是另一项大改动），
// 本修复堵的是“同源执行脚本”这条路。
const SAFE_INLINE_CONTENT_TYPES = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'image/avif',
	'image/bmp',
	'image/x-icon',
	'image/vnd.microsoft.icon',
	'text/plain',
]);

// 归一化 Content-Type：去参数（; charset=…）、小写；不是「类型/子类型」
// 形态的一律不认（返回 ''，调用方按非放行处理）。
function normalizeContentType(raw) {
	if (!raw || typeof raw !== 'string') return '';
	const t = raw.split(';')[0].trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(t)) return '';
	return t;
}

function isSafeInlineContentType(raw) {
	return SAFE_INLINE_CONTENT_TYPES.has(normalizeContentType(raw));
}

// 对外 serve 用的响应头：入参是 R2/KV/S3 存下来的元数据
// { contentType, contentDisposition, cacheControl }。
function safeServeHeaders(stored = {}) {
	const t = normalizeContentType(stored.contentType);
	const inline = SAFE_INLINE_CONTENT_TYPES.has(t);
	const headers = {
		'Content-Type': inline ? t : 'application/octet-stream',
		'Content-Disposition': inline ? 'inline' : 'attachment',
		'X-Content-Type-Options': 'nosniff',
		'Content-Security-Policy': 'sandbox',
	};
	const cc = stored.cacheControl;
	if (typeof cc === 'string' && cc.trim() !== '') {
		headers['Cache-Control'] = cc;
	}
	return headers;
}

// 入库时归一化要存的 contentType：放行类型原样存，其余存
// application/octet-stream（serve 层还会再算一遍，这里只是不让
// 库里留下“发件人自称 text/html”的脏元数据）。
function normalizeStoredContentType(raw) {
	const t = normalizeContentType(raw);
	return SAFE_INLINE_CONTENT_TYPES.has(t) ? t : 'application/octet-stream';
}

const safeServe = {
	SAFE_INLINE_CONTENT_TYPES,
	normalizeContentType,
	isSafeInlineContentType,
	safeServeHeaders,
	normalizeStoredContentType,
};

export { SAFE_INLINE_CONTENT_TYPES, normalizeContentType, isSafeInlineContentType, safeServeHeaders, normalizeStoredContentType };
export default safeServe;
