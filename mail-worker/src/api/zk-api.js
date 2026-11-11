// 斯诺登第三批（v3_16DB）：零知识身份（务实版挑战-应答）。
// 登录验证不存可逆凭证：服务端只存 zkSalt + zkVerifier
// （zkVerifier = SHA-256(salt + password)，base64；不可逆推密码）。
// 登录流程：先 GET /login/zk-challenge?email=… 拿 nonce，再算 verifier =
// SHA-256(salt + password)，然后 response = SHA-256(verifier + nonce) base64，
// 随登录请求发 zk 字段。
// 挑战 5 分钟过期、一次有效。salt 与 verifier 的设置/更换均须先验主密码。
// 诱饵会话下：状态恒返回未开通，设置接口一律拒绝。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import zkService from '../service/zk-service';
import userService from '../service/user-service';
import cryptoUtils from '../utils/crypto-utils';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';

// 开通状态（诱饵会话下恒返回未开通）。
app.get('/my/zk-status', async (c) => {
	const userId = userContext.getUserId(c);
	if (userContext.isDecoy(c)) {
		return c.json(result.ok({ enabled: false }));
	}
	const enabled = await zkService.isEnabled(c, userId);
	return c.json(result.ok({ enabled }));
});

// 开通 / 更换：{ password（主密码）, salt, verifier }。
// salt：前端随机生成的 base64url（16 字节以上）；
// verifier：SHA-256(salt + password) base64（服务端只存它，不存密码）。
app.post('/my/zk-setup', async (c) => {
	const userId = userContext.getUserId(c);
	if (userContext.isDecoy(c)) {
		throw new BizError(t('unauthorized'), 403);
	}
	const { password, salt, verifier } = await c.req.json().catch(() => ({}));
	const userRow = await userService.selectById(c, userId);
	if (!userRow) {
		throw new BizError(t('notExistUser'), 400);
	}
	const ok = await cryptoUtils.verifyPassword(String(password || ''), userRow.salt, userRow.password);
	if (!ok) {
		throw new BizError(t('authErrLoginFailed'), 401);
	}
	await zkService.setup(c, userRow, salt, verifier);
	return c.json(result.ok({ enabled: true }));
});

// 关闭：{ password（主密码） }。
app.post('/my/zk-disable', async (c) => {
	const userId = userContext.getUserId(c);
	if (userContext.isDecoy(c)) {
		throw new BizError(t('unauthorized'), 403);
	}
	const { password } = await c.req.json().catch(() => ({}));
	const userRow = await userService.selectById(c, userId);
	if (!userRow) {
		throw new BizError(t('notExistUser'), 400);
	}
	const ok = await cryptoUtils.verifyPassword(String(password || ''), userRow.salt, userRow.password);
	if (!ok) {
		throw new BizError(t('authErrLoginFailed'), 401);
	}
	await zkService.disable(c, userRow);
	return c.json(result.ok({ enabled: false }));
});
