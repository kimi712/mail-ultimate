// 斯诺登第四批 P0-2：管理员审计全局视图 API（新增路由文件）。
// 挂载：在 mail-worker/src/hono/webs.js 里加一行
//   import '../api/admin-audit-api'
// 即可（与 security-audit-api 同款挂载方式）。
// 全部只管理员可见：管理员判定与 security.js 的逃生口同口径——
// 当前登录用户的邮箱等于 c.env.admin；诱饵会话永远不算管理员。
//   GET /admin/audit-log?num&size&action&actorUserId&targetType&targetId
//       管理员全局审计记录（时间倒序，含操作人、操作、目标、脱敏 IP）。
//   GET /admin/audit-log/coverage
//       高危操作接线覆盖表（哪些已接线、哪些待补）。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import userService from '../service/user-service';
import adminAuditService from '../service/admin-audit-service';
import BizError from '../error/biz-error';

async function requireAdmin(c) {
	if (userContext.isDecoy(c)) {
		throw new BizError('无权访问', 403);
	}
	const userId = userContext.getUserId(c);
	const userRow = await userService.selectById(c, userId);
	if (!userRow || String(userRow.email || '') !== String(c.env.admin || '')) {
		throw new BizError('仅管理员可见', 403);
	}
	return userRow;
}

app.get('/admin/audit-log', async (c) => {
	await requireAdmin(c);
	const params = c.req.query();
	const data = await adminAuditService.listAdminAudit(c, {
		actorUserId: params.actorUserId ? Number(params.actorUserId) : undefined,
		action: params.action || '',
		targetType: params.targetType || '',
		targetId: params.targetId || '',
		num: params.num,
		size: params.size,
	});
	return c.json(result.ok(data));
});

app.get('/admin/audit-log/coverage', async (c) => {
	await requireAdmin(c);
	return c.json(result.ok({ coverage: adminAuditService.coverage() }));
});

export default app;
