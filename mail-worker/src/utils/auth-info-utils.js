import KvConst from '../const/kv-const';
import { sleep } from './time-utils';

// KV 最终一致性重试读：登录刚把新 token 写进 KV，紧接着读（尤其另一边缘
// 节点）可能读到旧值，直接判 401 会误杀刚登录的会话。读不到或 token
// 不在列表时重试几次再放弃，只影响本来就要失败的路径，成功路径不受影响。
// token 传了时，只有读到包含该 token 的 authInfo 才算命中；不传 token
// 时读到非空 authInfo 即返回。重试耗尽返回最后一次读到的值（可能为 null），
// 调用方按原有逻辑判 401 / 走新建分支。
export async function getAuthInfoWithRetry(c, userId, token, { attempts = 3, delayMs = 200 } = {}) {
	let authInfo = null;
	for (let i = 0; i < attempts; i++) {
		authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userId, { type: 'json' });
		if (authInfo && (!token || (Array.isArray(authInfo.tokens) && authInfo.tokens.includes(token)))) {
			return authInfo;
		}
		if (i < attempts - 1) {
			await sleep(delayMs);
		}
	}
	return authInfo;
}
