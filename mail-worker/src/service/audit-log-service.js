import orm from '../entity/orm';
import auditLog from '../entity/audit-log';
import reqUtils from '../utils/req-utils';
import userContext from '../security/user-context';
import settingService from './setting-service';

// Phase 6：setting.log_ip_mask=1 时写入前对 ip 列脱敏。
async function maybeMaskIp(c, ip) {
	try {
		const setting = await settingService.query(c);
		if (setting && Number(setting.logIpMask) === 1) {
			return reqUtils.maskIp(ip);
		}
	} catch (e) {
		// 读配置失败时不脱敏、不阻断写入
	}
	return ip;
}

// 审计日志：管理员操作留痕。写入永不抛错，不得影响主流程。
const auditLogService = {

	async record(c, { action = '', targetType = '', targetId = '', detail = {} }) {
		try {
			let actorUserId = 0;
			try {
				const user = userContext.getUser(c);
				if (user && user.userId) {
					actorUserId = user.userId;
				}
			} catch (e) {
				// 未登录请求（如注册）无 actor，记 0
			}
			let detailStr = '';
			try {
				detailStr = JSON.stringify(detail || {}).slice(0, 2000);
			} catch (e) {
				detailStr = '';
			}
			await orm(c).insert(auditLog).values({
				actorUserId,
				action,
				targetType,
				targetId: String(targetId ?? ''),
				ip: await maybeMaskIp(c, reqUtils.getIp(c)),
				// Phase 7：UA 只用于人工识别操作者设备，截断到 500 字符。
				ua: (c.req.header('user-agent') || '').slice(0, 500),
				detail: detailStr
			}).run();
		} catch (e) {
			console.error('写审计日志失败:', e.message);
		}
	}

};

export default auditLogService;
