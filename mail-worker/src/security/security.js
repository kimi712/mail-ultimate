import BizError from '../error/biz-error';
import constant from '../const/constant';
import jwtUtils from '../utils/jwt-utils';
import KvConst from '../const/kv-const';
import dayjs from 'dayjs';
import userService from '../service/user-service';
import permService from '../service/perm-service';
import { t } from '../i18n/i18n'
import app from '../hono/hono';
import reqUtils from '../utils/req-utils';
import ipBlocklistService from '../service/ip-blocklist-service';
import { ipBlocklistConst } from '../const/entity-const';

const exclude = [
	'/login',
	'/register',
	'/oss',
	'/setting/websiteConfig',
	'/webhooks',
	'/init',
	'/public/genToken',
	'/telegram',
	'/test',
	'/oauth'
];

const requirePerms = [
	'/email/send',
	'/email/delete',
	'/account/list',
	'/account/delete',
	'/account/add',
	'/my/delete',
	'/my/hard-delete',
	'/analysis/echarts',
	'/role/add',
	'/role/list',
	'/role/delete',
	'/role/tree',
	'/role/set',
	'/role/setDefault',
	'/allEmail/list',
	'/allEmail/delete',
	'/allEmail/batchDelete',
	'/allEmail/latest',
	'/setting/setBackground',
	'/setting/deleteBackground',
	'/setting/set',
	'/setting/query',
	'/setting/setBlacklist',
	'/user/delete',
	'/user/setPwd',
	'/user/setStatus',
	'/user/setType',
	'/user/list',
	'/user/restore',
	'/user/resetSendCount',
	'/user/add',
	'/user/deleteAccount',
	'/user/allAccount',
	'/regKey/add',
	'/regKey/list',
	'/regKey/delete',
	'/regKey/clearNotUse',
	'/regKey/history',
	'/ipBlocklist/list',
	'/ipBlocklist/add',
	'/ipBlocklist/delete',
	'/registerLog/list',
	'/auditLog/list',
	'/alertLog/list',
	'/alertLog/record',
	'/quota/resend',
	'/user/export',
	'/user/groupByIp'
];

const premKey = {
	'email:delete': ['/email/delete'],
	'email:send': ['/email/send'],
	'account:add': ['/account/add'],
	'account:query': ['/account/list'],
	'account:delete': ['/account/delete'],
	'my:delete': ['/my/delete', '/my/hard-delete'],
	'role:add': ['/role/add'],
	'role:set': ['/role/set','/role/setDefault'],
	'role:query': ['/role/list', '/role/tree'],
	'role:delete': ['/role/delete'],
	'user:query': ['/user/list','/user/allAccount','/user/groupByIp'],
	'user:export': ['/user/export'],
	'user:add': ['/user/add'],
	'user:reset-send': ['/user/resetSendCount'],
	'user:set-pwd': ['/user/setPwd'],
	'user:set-status': ['/user/setStatus', '/user/restore'],
	'user:set-type': ['/user/setType'],
	'user:delete': ['/user/delete','/user/deleteAccount'],
	'all-email:query': ['/allEmail/list','/allEmail/latest'],
	'all-email:delete': ['/allEmail/delete','/allEmail/batchDelete'],
	'setting:query': ['/setting/query'],
	'setting:set': ['/setting/set', '/setting/setBackground','/setting/deleteBackground','/setting/setBlacklist'],
	'analysis:query': ['/analysis/echarts','/quota/resend'],
	'alert:query': ['/alertLog/list','/alertLog/record'],
	'reg-key:add': ['/regKey/add'],
	'reg-key:query': ['/regKey/list','/regKey/history'],
	'reg-key:delete': ['/regKey/delete','/regKey/clearNotUse'],
	'ip-block:query': ['/ipBlocklist/list'],
	'ip-block:set': ['/ipBlocklist/add','/ipBlocklist/delete'],
	'register-log:query': ['/registerLog/list'],
	'audit-log:query': ['/auditLog/list'],
};

app.use('*', async (c, next) => {
	// Phase 6：安全头，全站生效（await next() 之前设置）。
	// HSTS 不上 preload（进浏览器内置列表后撤回困难）；CSP 放行 Turnstile
	// 的 script 与 frame（challenges.cloudflare.com），否则注册页人机验证无法渲染。
	c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	c.header('Content-Security-Policy', "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'");
	c.header('X-Content-Type-Options', 'nosniff');
	c.header('X-Frame-Options', 'DENY');
	c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
	await next();
});

app.use('*', async (c, next) => {

	// Phase 1 A 路：scope=1 访问黑名单。放在 exclude 判断之前，对所有路径生效
	// （含 /login、/register、/oauth 等白名单）；直接读 D1，不依赖 KV 缓存。
	// 管理员逃生口：请求头带有效 JWT 且 KV 会话里的用户邮箱 === c.env.admin 时跳过。
	// 检查本身失败（D1 未迁移/未绑定）只记日志、不阻断请求；命中黑名单则抛 403。
	try {
		const blocked = await ipBlocklistService.isBlocked(c, reqUtils.getIp(c), reqUtils.getIpSegment(c), ipBlocklistConst.scope.ACCESS);
		if (blocked && !(await isAdminRequest(c))) {
			throw new BizError(t('ipBlockedAccess'), 403);
		}
	} catch (e) {
		if (e instanceof BizError) throw e;
		console.error('IP 访问黑名单检查失败:', e.message);
	}

	const path = c.req.path;

	// 边界匹配：path === item 或 path 以 item + '/' 开头。
	// 修复：旧的 startsWith 前缀匹配把 '/registerLog/list' 当成公开的 '/register'
	// 放行，导致未登录可读全站注册日志（无 token 返回 200）。
	const index = exclude.findIndex(item => {
		return path === item || path.startsWith(item + '/');
	});

	if (index > -1) {
		return await next();
	}

	if (path.startsWith('/public')) {

		const userPublicToken = await c.env.kv.get(KvConst.PUBLIC_KEY);
		const publicToken = c.req.header(constant.TOKEN_HEADER);
		if (publicToken !== userPublicToken) {
			throw new BizError(t('publicTokenFail'), 401);
		}
		return await next();
	}


	const jwt = c.req.header(constant.TOKEN_HEADER);

	const result = await jwtUtils.verifyToken(c, jwt);

	if (!result) {
		throw new BizError(t('authExpired'), 401);
	}

	const { userId, token } = result;
	const authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userId, { type: 'json' });

	if (!authInfo) {
		throw new BizError(t('authExpired'), 401);
	}

	if (!authInfo.tokens.includes(token)) {
		throw new BizError(t('authExpired'), 401);
	}

	const permIndex = requirePerms.findIndex(item => {
		return path === item || path.startsWith(item + '/');
	});

	if (permIndex > -1) {

		const permKeys = await permService.userPermKeys(c, authInfo.user.userId);

		const userPaths = permKeyToPaths(permKeys);

		const userPermIndex = userPaths.findIndex(item => {
			return path === item || path.startsWith(item + '/');
		});

		if (userPermIndex === -1 && authInfo.user.email !== c.env.admin) {
			throw new BizError(t('unauthorized'), 403);
		}

	}

	const refreshTime = dayjs(authInfo.refreshTime).startOf('day');
	const nowTime = dayjs().startOf('day')

	if (!nowTime.isSame(refreshTime)) {
		authInfo.refreshTime = dayjs().toISOString();
		await userService.updateUserInfo(c, authInfo.user.userId);
		await c.env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify(authInfo), { expirationTtl: constant.TOKEN_EXPIRE });
	}

	c.set('user',authInfo.user)

	return await next();
});

function permKeyToPaths(permKeys) {

	const paths = [];

	for (const key of permKeys) {
		const routeList = premKey[key];
		if (routeList && Array.isArray(routeList)) {
			paths.push(...routeList);
		}
	}
	return paths;
}

// 管理员逃生口：有效 JWT + KV 会话用户邮箱等于 c.env.admin。任一步失败返回 false。
async function isAdminRequest(c) {
	try {
		const jwt = c.req.header(constant.TOKEN_HEADER);
		if (!jwt) return false;
		const payload = await jwtUtils.verifyToken(c, jwt);
		if (!payload || !payload.userId) return false;
		const authInfo = await c.env.kv.get(KvConst.AUTH_INFO + payload.userId, { type: 'json' });
		return !!authInfo && !!authInfo.user && authInfo.user.email === c.env.admin;
	} catch (e) {
		console.error('管理员逃生口校验失败:', e.message);
		return false;
	}
}
