// Phase 8 F：账号恢复 API（恢复码 + 备用邮箱）。
// 公开路由（/recovery/*）须进 security.js 的 exclude 白名单（见汇报，
// 由总协调加 '/recovery' 一行），否则未登录态会被鉴权中间件拦住。
// 其余 /my/* 路由走正常登录态鉴权。错误一律通用口径，不透露账号是否存在。
// 路由注册行见汇报（webs.js 由总协调加）。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import recoveryService from '../service/recovery-service';
import reqUtils from '../utils/req-utils';

// ---- 登录态：恢复码管理 ----
// 生成一组新恢复码（需当前密码；明文只返回这一次，前端必须当场展示并提醒保存）。
app.post('/my/recovery-codes/generate', async (c) => {
	const { password } = await c.req.json();
	const data = await recoveryService.generateCodes(c, userContext.getUserId(c), password);
	return c.json(result.ok(data));
});

// 剩余可用恢复码数（不返回任何码本身）。
app.get('/my/recovery-codes/status', async (c) => {
	const remaining = await recoveryService.remainingCodes(c, userContext.getUserId(c));
	return c.json(result.ok({ remaining }));
});

// ---- 登录态：备用邮箱 ----
app.get('/my/backup-email', async (c) => {
	const data = await recoveryService.getBackupEmail(c, userContext.getUserId(c));
	return c.json(result.ok(data || { backupEmail: '', verified: 0 }));
});

app.post('/my/backup-email', async (c) => {
	const { backupEmail } = await c.req.json();
	const data = await recoveryService.setBackupEmail(c, userContext.getUserId(c), backupEmail);
	return c.json(result.ok(data));
});

app.delete('/my/backup-email', async (c) => {
	await recoveryService.deleteBackupEmail(c, userContext.getUserId(c));
	return c.json(result.ok());
});

// ---- 公开：忘密码 ----
// 凭恢复码重设密码（限流 5 次 / 15 分钟 / 邮箱+IP）。
app.post('/recovery/reset-by-code', async (c) => {
	const { email, code, newPassword } = await c.req.json();
	await recoveryService.resetByCode(c, { email, code, newPassword, ip: reqUtils.getIp(c) });
	return c.json(result.ok());
});

// 请求恢复链接（发往备用邮箱；无论成败一律返回 requested: true）。
app.post('/recovery/request-link', async (c) => {
	const { email } = await c.req.json();
	const origin = c.req.header('Origin') || c.req.header('Referer') || '';
	const data = await recoveryService.requestResetLink(c, { email, ip: reqUtils.getIp(c), origin });
	return c.json(result.ok(data));
});

// 凭恢复链接 token 重设密码（限流 5 次 / 15 分钟 / 邮箱+IP）。
app.post('/recovery/reset-by-token', async (c) => {
	const { email, token, newPassword } = await c.req.json();
	await recoveryService.resetByToken(c, { email, token, newPassword, ip: reqUtils.getIp(c) });
	return c.json(result.ok());
});
