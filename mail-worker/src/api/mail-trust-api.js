// Phase 8 子代理 E：邮件信任与控制 API（Layer 3 薄适配层）。
// 路由注册行由总协调加进 webs.js（见子代理 E 汇报）。
// /mail-trust/* 不在 security.js 白名单内，未登录由中间件统一拦 401；
// 无需额外权限点，任意登录用户只能操作自己的邮件/偏好/信任列表。
// 业务错误遵循项目约定：Hono onError 恒返回 HTTP 200，真实错误码在
// body.code（trust_* 字符串码，前端按码查 trust.* 翻译 key 展示）。
// 发送本身仍走 POST /email/send（body 带 undoSeconds / scheduledAt
// 即进撤回/定时流程）；本文件只做撤回确认/取消、定时列表/取消与信任侧操作。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import mailTrustService from '../service/mail-trust-service';
import emailService from '../service/email-service';

app.get('/mail-trust/read/:emailId', async (c) => {
	const data = await mailTrustService.getReadTrust(c, userContext.getUserId(c), c.req.param('emailId'));
	return c.json(result.ok(data));
});

app.get('/mail-trust/prefs', async (c) => {
	const data = await mailTrustService.getPrefs(c, userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.put('/mail-trust/prefs', async (c) => {
	const data = await mailTrustService.setPrefs(c, userContext.getUserId(c), await c.req.json().catch(() => ({})));
	return c.json(result.ok(data));
});

app.get('/mail-trust/trusted-senders', async (c) => {
	const data = await mailTrustService.listTrustedSenders(c, userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.post('/mail-trust/trust-sender', async (c) => {
	const { senderEmail } = await c.req.json().catch(() => ({}));
	const data = await mailTrustService.trustSender(c, userContext.getUserId(c), senderEmail);
	return c.json(result.ok(data));
});

app.delete('/mail-trust/trust-sender', async (c) => {
	const data = await mailTrustService.untrustSender(c, userContext.getUserId(c), c.req.query('senderEmail'));
	return c.json(result.ok(data));
});

app.post('/mail-trust/spam', async (c) => {
	const { emailId } = await c.req.json().catch(() => ({}));
	const data = await mailTrustService.markSpam(c, userContext.getUserId(c), emailId);
	return c.json(result.ok(data));
});

app.post('/mail-trust/not-spam', async (c) => {
	const { emailId } = await c.req.json().catch(() => ({}));
	const data = await mailTrustService.unmarkSpam(c, userContext.getUserId(c), emailId);
	return c.json(result.ok(data));
});

app.post('/mail-trust/report-phishing', async (c) => {
	const { emailId } = await c.req.json().catch(() => ({}));
	const data = await mailTrustService.reportPhishing(c, userContext.getUserId(c), emailId);
	return c.json(result.ok(data));
});

app.get('/mail-trust/unsubscribe/:emailId', async (c) => {
	const data = await mailTrustService.getUnsubscribe(c, userContext.getUserId(c), c.req.param('emailId'));
	return c.json(result.ok(data));
});

app.post('/mail-trust/unsubscribe', async (c) => {
	const { emailId } = await c.req.json().catch(() => ({}));
	const data = await mailTrustService.unsubscribe(c, userContext.getUserId(c), emailId);
	return c.json(result.ok(data));
});

app.get('/mail-trust/pending/:pendingId', async (c) => {
	const data = await emailService.getPendingSend(c, userContext.getUserId(c), c.req.param('pendingId'));
	return c.json(result.ok(data));
});

app.post('/mail-trust/pending/:pendingId/cancel', async (c) => {
	const data = await emailService.cancelPendingSend(c, userContext.getUserId(c), c.req.param('pendingId'));
	return c.json(result.ok(data));
});

app.post('/mail-trust/pending/:pendingId/confirm', async (c) => {
	const data = await emailService.confirmPendingSend(c, c.req.param('pendingId'), { userId: userContext.getUserId(c) });
	return c.json(result.ok(data));
});

app.get('/mail-trust/scheduled', async (c) => {
	const data = await emailService.listScheduled(c, userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.post('/mail-trust/scheduled/:scheduledId/cancel', async (c) => {
	const data = await emailService.cancelScheduled(c, userContext.getUserId(c), c.req.param('scheduledId'));
	return c.json(result.ok(data));
});
