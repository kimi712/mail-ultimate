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
import sessionService from '../service/session-service';
import { getAuthInfoWithRetry } from '../utils/auth-info-utils';

const exclude = [
	'/login',
	'/register',
	'/oss',
	'/setting/websiteConfig',
	'/webhooks',
	'/init',
	'/telegram',
	'/test',
	'/oauth',
	// Phase 8 F：公开的账号恢复接口（/recovery/*）不走鉴权
	'/recovery',
	// $1000 安全悬赏挑战：公开状态页（/challenge/*）不走鉴权
	'/challenge'
];

const requirePerms = [
	'/email/send',
	'/email/delete',
	'/email/restore',
	'/email/physicsDelete',
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
	'/setting/tgWebhook',
	'/user/delete',
	'/user/setPwd',
	'/user/setStatus',
	'/user/unbindTelegram',
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
	'email:delete': ['/email/delete', '/email/restore', '/email/physicsDelete'],
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
	'user:set-status': ['/user/setStatus', '/user/restore', '/user/unbindTelegram'],
	'user:set-type': ['/user/setType'],
	'user:delete': ['/user/delete','/user/deleteAccount'],
	'all-email:query': ['/allEmail/list','/allEmail/latest'],
	'all-email:delete': ['/allEmail/delete','/allEmail/batchDelete'],
	'setting:query': ['/setting/query'],
	'setting:set': ['/setting/set', '/setting/setBackground','/setting/deleteBackground','/setting/setBlacklist', '/setting/tgWebhook'],
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

	const jwt = c.req.header(constant.TOKEN_HEADER);

	const result = await jwtUtils.verifyToken(c, jwt);

	if (!result) {
		throw new BizError(t('authExpired'), 401);
	}

	const { userId, token } = result;

	// 斯诺登第三批（v3_16DB）：胁迫密码签发的诱饵 token（payload.decoy=1）。
	// 诱饵会话下所有接口只读诱饵/空数据（见 user-context.isDecoy 各处分支），
	// 且一律禁入需要权限的管理路由——即使该账号本身是管理员。
	const decoyMode = result.decoy === 1;
	c.set('decoyMode', decoyMode);

	// KV 最终一致性：登录刚写入的 token，紧接着读可能读到旧值（另一边缘
	// 节点还没同步），直接判 401 会误杀刚登录的会话。读不到或 token 不在
	// 列表时重试 3 次（间隔 200ms）再判 401。
	const authInfo = await getAuthInfoWithRetry(c, userId, token, { attempts: 3, delayMs: 200 });

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

		// 诱饵会话禁入一切管理路由（不透露“诱饵”身份，只报无权限）。
		if (decoyMode) {
			throw new BizError(t('unauthorized'), 403);
		}

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

	// Phase 8 B：每次鉴权成功后刷新会话最后活跃时间（60 秒节流，见
	// session-service.touchSession；写 KV 失败不阻断请求）。
	try {
		await sessionService.touchSession(c, authInfo.user.userId, token);
	} catch (e) {
		console.error('刷新会话最后活跃时间失败:', e.message);
	}

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
// 斯诺登第三批（v3_16DB）：诱饵会话（payload.decoy=1）永远不算管理员。
async function isAdminRequest(c) {
	try {
		const jwt = c.req.header(constant.TOKEN_HEADER);
		if (!jwt) return false;
		const payload = await jwtUtils.verifyToken(c, jwt);
		if (!payload || !payload.userId) return false;
		if (payload.decoy === 1) return false;
		const authInfo = await c.env.kv.get(KvConst.AUTH_INFO + payload.userId, { type: 'json' });
		return !!authInfo && !!authInfo.user && authInfo.user.email === c.env.admin;
	} catch (e) {
		console.error('管理员逃生口校验失败:', e.message);
		return false;
	}
}
