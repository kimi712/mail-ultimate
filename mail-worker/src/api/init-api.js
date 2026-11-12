import app from '../hono/hono';
import { dbInit } from '../init/init';

// 白帽反馈小项：JWT secret 不再放 URL 里（URL 会进访问日志、浏览器历史、
// Referer）。改走 Authorization: Bearer <secret> 请求头，见 DEPLOY.md §6。
app.get('/init', (c) => {
	return dbInit.init(c);
})
