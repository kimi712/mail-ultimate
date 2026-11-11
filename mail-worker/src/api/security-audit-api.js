// Phase 8 B · 用户侧审计视图 + 安全评分 API（新增模块文件，独立路由，
// webs.js 注册行见 PHASE8-B.md，由总协调加）。
// 全部仅限本人数据：userId 一律取 c.get('user').userId，无 premKey。
// - GET /security/audit-log?num&size&type：本人的审计记录（登录、改密、改设置、
//   导出、删除、TOTP/Passkey 变更、限流锁定等）；type 按白名单前缀筛选
//   （login/security/totp/passkey/export/delete/session/setting/user）；
//   保留期限与 setting.log_retention_days 一致；IP 按 log_ip_mask 脱敏展示，
//   UA 截断 120 字符展示（库内仍为 500 截断原文）。
// - GET /security/score：安全评分（总分 100 + 9 项分项得分 + 改进建议 key 列表），
//   规则见 user-security-service.getScore 与 PHASE8-B.md 评分规则表。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import auditLogService from '../service/audit-log-service';
import userSecurityService from '../service/user-security-service';
import settingService from '../service/setting-service';
import reqUtils from '../utils/req-utils';

const UA_DISPLAY_LEN = 120;

app.get('/security/audit-log', async (c) => {
	const params = c.req.query();
	let num = Number(params.num);
	let size = Number(params.size);
	if (isNaN(num) || num < 1) {
		num = 1;
	}
	if (isNaN(size) || size < 1) {
		size = 20;
	}
	if (size > 50) {
		size = 50;
	}
	const userId = userContext.getUserId(c);
	const data = await auditLogService.listByUser(c, userId, { num, size, type: params.type || '' });
	// 读时脱敏：写时已按开关脱敏；开关开启后、写时未脱敏的历史行在这里补脱敏。
	let maskOn = false;
	try {
		const setting = await settingService.query(c);
		maskOn = setting && (Number(setting.logIpMask) === 1 || Number(setting.log_ip_mask) === 1);
	} catch (e) {
		maskOn = false;
	}
	const detailOf = (row) => {
		try {
			return row.detail ? JSON.parse(row.detail) : {};
		} catch (e) {
			return {};
		}
	};
	const list = data.list.map(row => ({
		time: row.createTime,
		action: row.action,
		targetType: row.targetType,
		targetId: row.targetId,
		ip: maskOn ? reqUtils.maskIp(row.ip) : row.ip,
		ua: String(row.ua || '').slice(0, UA_DISPLAY_LEN),
		detail: detailOf(row)
	}));
	return c.json(result.ok({ list, total: data.total }));
});

app.get('/security/score', async (c) => {
	const data = await userSecurityService.getScore(c, userContext.getUserId(c));
	return c.json(result.ok(data));
});
