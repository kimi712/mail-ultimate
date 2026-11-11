import JwtUtils from '../utils/jwt-utils';
import constant from '../const/constant';

const userContext = {
	getUserId(c) {
		return c.get('user').userId;
	},

	getUser(c) {
		return c.get('user');
	},

	// 斯诺登第三批（v3_16DB）：诱饵会话标志。security.js 中间件在 JWT 验签
	// 通过后按 payload.decoy 置位；诱饵会话下邮件/联系人/别名/设置等接口
	// 一律返回诱饵或空数据，绝不触碰真实数据。
	isDecoy(c) {
		try {
			return c.get('decoyMode') === true;
		} catch (e) {
			return false;
		}
	},

	async getToken(c) {
		const jwt = c.req.header(constant.TOKEN_HEADER);
		const result = await JwtUtils.verifyToken(c,jwt);
		return result?.token;
	},
};
export default userContext;
