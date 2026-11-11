// Phase 8 F：新设备 / 新 IP 登录提醒 API（只查本人）。
// 路由注册行见汇报（webs.js 由总协调加）。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import newIpAlertService from '../service/new-ip-alert-service';

// 待确认的新 IP 登录（近 30 天、is_new_ip=1、未确认过的）。
app.get('/security/new-ip-alerts', async (c) => {
	const list = await newIpAlertService.listPendingAlerts(c, userContext.getUserId(c));
	return c.json(result.ok({ list, total: list.length }));
});

// “是我本人”：该 IP 记为已知，此后不再提醒。
app.post('/security/new-ip-alerts/acknowledge', async (c) => {
	const { ip } = await c.req.json();
	const data = await newIpAlertService.acknowledge(c, userContext.getUserId(c), ip);
	return c.json(result.ok(data));
});

// 已知 IP 列表。
app.get('/security/known-ips', async (c) => {
	const list = await newIpAlertService.listKnownIps(c, userContext.getUserId(c));
	return c.json(result.ok({ list, total: list.length }));
});
