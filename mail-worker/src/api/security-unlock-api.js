// Phase 7：闲置自动锁定的解锁接口（最小实现）。
// POST /security/unlock {password}：仅校验登录密码是否正确，不签发新会话、
// 不轮换 token、不改 KV（锁定只是前端界面态，会话本身一直有效）。
// 防猜：连续失败 5 次后锁 5 分钟（KV UNLOCK_FAIL 计数，TTL 300 秒，
// 与 TOTP 的 5 次锁定同一口径）；成功后清零。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import userService from '../service/user-service';
import cryptoUtils from '../utils/crypto-utils';
import BizError from '../error/biz-error';
import KvConst from '../const/kv-const';
import { t } from '../i18n/i18n';

const MAX_ATTEMPTS = 5;
const LOCK_TTL_SECONDS = 300;

app.post('/security/unlock', async (c) => {
	const userId = userContext.getUserId(c);
	const body = await c.req.json().catch(() => ({}));
	const failKey = KvConst.UNLOCK_FAIL + userId;
	const fails = Number((await c.env.kv.get(failKey)) || 0);
	if (fails >= MAX_ATTEMPTS) {
		throw new BizError(t('securityUnlockLocked'), 403);
	}
	const userRow = await userService.selectById(c, userId);
	const ok = userRow && body.password
		&& await cryptoUtils.verifyPassword(body.password, userRow.salt, userRow.password);
	if (!ok) {
		const next = fails + 1;
		try {
			await c.env.kv.put(failKey, String(next), { expirationTtl: LOCK_TTL_SECONDS });
		} catch (e) {
			console.error('写解锁失败计数失败:', e.message);
		}
		if (next >= MAX_ATTEMPTS) {
			throw new BizError(t('securityUnlockLocked'), 403);
		}
		throw new BizError(t('IncorrectPwd'), 401);
	}
	try {
		await c.env.kv.delete(failKey);
	} catch (e) {
		// 清零失败不阻断解锁成功返回
	}
	return c.json(result.ok());
});
