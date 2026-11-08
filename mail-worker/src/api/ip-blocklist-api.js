import app from '../hono/hono';
import ipBlocklistService from '../service/ip-blocklist-service';
import result from '../model/result';
import BizError from '../error/biz-error';
import userContext from '../security/user-context';
import reqUtils from '../utils/req-utils';
import { ipBlocklistConst } from '../const/entity-const';

// Phase 1 A 路：IP 黑名单管理 API。路由挂 requirePerms + premKey（见 security.js）：
// list → ip-block:query；add/delete → ip-block:set。perm 种子行由 C 路写进 v3_5DB。
app.get('/ipBlocklist/list', async (c) => {
	const { scope, page, size } = c.req.query();
	const data = await ipBlocklistService.list(c, {
		scope: scope ?? null,
		page: Number(page) || 1,
		size: Math.min(Number(size) || 20, 100)
	});
	return c.json(result.ok(data));
});

app.post('/ipBlocklist/add', async (c) => {
	const { ip, ipSegment, scope, reason, expireTime } = await c.req.json();
	const cleanIp = (ip || '').trim();
	// 只给 ip 未给段时自动算段（IPv6 按 /64）；IPv4 段即原 IP。
	let cleanSegment = (ipSegment || '').trim();
	if (!cleanSegment && cleanIp) {
		cleanSegment = reqUtils.getIpSegment(c, cleanIp);
	}
	if (!cleanIp && !cleanSegment) {
		throw new BizError('IP 或 IP 段不能为空', 400);
	}
	const scopeNum = Number(scope);
	if (scopeNum !== ipBlocklistConst.scope.REGISTER && scopeNum !== ipBlocklistConst.scope.ACCESS) {
		throw new BizError('scope 只能是 0（禁注册）或 1（禁访问）', 400);
	}
	let createdBy = '';
	try {
		createdBy = userContext.getUser(c)?.email || '';
	} catch (e) {
		createdBy = '';
	}
	const row = await ipBlocklistService.add(c, {
		ip: cleanIp, ipSegment: cleanSegment, scope: scopeNum,
		reason: reason || '', expireTime: expireTime || null, createdBy
	});
	return c.json(result.ok(row));
});

app.delete('/ipBlocklist/delete', async (c) => {
	const { blockId } = c.req.query();
	if (!blockId) {
		throw new BizError('blockId 不能为空', 400);
	}
	await ipBlocklistService.remove(c, Number(blockId));
	return c.json(result.ok());
});
