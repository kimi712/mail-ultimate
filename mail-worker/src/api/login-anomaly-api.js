// 斯诺登第四批 P1-4：异常登录告警 API（新增路由文件）。
// 挂载：在 mail-worker/src/hono/webs.js 里加一行
//   import '../api/login-anomaly-api'
// 即可。
//   POST /security/lock-account {reason?}
//       一键锁定自己的账号（通知里的入口）：封禁 + 清会话 + 审计。
//       锁定后须管理员解锁，本人无法自助解锁（防盗号者反锁受害人后
//       再解锁的绕过——解锁走管理员通道）。
//   GET /security/login-anomalies
//       本人的异常登录记录（取自本人审计视图，action 前缀 login）。
//   POST /admin/login-anomalies/unlock {userId}
//       管理员解锁指定账号（仅管理员，判定同 admin-audit-api）。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import userService from '../service/user-service';
import auditLogService from '../service/audit-log-service';
import loginAnomalyService from '../service/login-anomaly-service';
import BizError from '../error/biz-error';

async function requireAdmin(c) {
	if (userContext.isDecoy(c)) {
		throw new BizError('无权访问', 403);
	}
	const userRow = await userService.selectById(c, userContext.getUserId(c));
	if (!userRow || String(userRow.email || '') !== String(c.env.admin || '')) {
		throw new BizError('仅管理员可见', 403);
	}
	return userRow;
}

app.post('/security/lock-account', async (c) => {
	const userId = userContext.getUserId(c);
	const body = await c.req.json().catch(() => ({}));
	const data = await loginAnomalyService.lockAccount(c, {
		actorUserId: userId,
		targetUserId: userId,
		reason: body.reason || 'self_lock',
	});
	return c.json(result.ok(data));
});

app.get('/security/login-anomalies', async (c) => {
	const params = c.req.query();
	const data = await auditLogService.listByUser(c, userContext.getUserId(c), {
		num: params.num,
		size: params.size,
		type: 'login',
	});
	return c.json(result.ok(data));
});

app.post('/admin/login-anomalies/unlock', async (c) => {
	const admin = await requireAdmin(c);
	const body = await c.req.json().catch(() => ({}));
	if (!body.userId) {
		throw new BizError('缺少用户', 400);
	}
	const data = await loginAnomalyService.unlockAccount(c, {
		actorUserId: admin.userId,
		targetUserId: Number(body.userId),
	});
	return c.json(result.ok(data));
});

export default app;
