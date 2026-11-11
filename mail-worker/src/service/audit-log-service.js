// Phase 8 B：审计日志服务。record() 委托给 Layer 1 kernel/audit（最小化日志
// 统一入口：只记元数据、IP 脱敏、UA 截断 500、detail 按 key 名清洗、永不记正文
// 与密钥值）；原有行为（actor 取当前登录用户、无登录态记 0、写入永不抛错）不变。
// 新增 listByUser()：用户侧审计视图专用——只查本人（actor_user_id = userId），
// 支持按类型前缀筛选，保留期限与 setting.log_retention_days 一致（>0 时只返回
// 期限内的行；0 = 永久保留）。
import orm from '../entity/orm';
import auditLog from '../entity/audit-log';
import { and, count, desc, eq, gte, like, sql } from 'drizzle-orm';
import kernelAudit from '../kernel/audit';
import settingService from './setting-service';

// 用户侧审计视图的类型筛选：前端传的 type → audit_log.action 前缀白名单。
// 未命中白名单的 type 视为不过滤（不让非法输入拼出任意 LIKE）。
const USER_AUDIT_TYPE_PREFIXES = {
	login: 'login',
	security: 'security',
	totp: 'totp',
	passkey: 'passkey',
	export: 'export',
	delete: 'delete',
	session: 'session',
	setting: 'setting',
	user: 'user'
};

const auditLogService = {

	async record(c, { action = '', targetType = '', targetId = '', detail = {} } = {}) {
		await kernelAudit.audit(c, { action, targetType, targetId, detail });
	},

	async listByUser(c, userId, { num = 1, size = 20, type = '' } = {}) {
		size = Number(size);
		num = Number(num);
		if (isNaN(size) || size < 1) {
			size = 20;
		}
		if (isNaN(num) || num < 1) {
			num = 1;
		}
		if (size > 50) {
			size = 50;
		}
		const conditions = [eq(auditLog.actorUserId, Number(userId))];
		const prefix = USER_AUDIT_TYPE_PREFIXES[String(type || '')];
		if (prefix) {
			conditions.push(like(auditLog.action, `${prefix}:%`));
		}
		// 保留期限：与 log_retention_days 一致；读不到配置时不过滤（不丢数据）。
		try {
			const setting = await settingService.query(c);
			const days = Number(setting && (setting.logRetentionDays ?? setting.log_retention_days));
			if (days > 0) {
				conditions.push(gte(auditLog.createTime, sql`datetime('now', ${'-' + days + ' days'})`));
			}
		} catch (e) {
			// 读配置失败时不过滤
		}
		const where = and(...conditions);
		const offset = (num - 1) * size;
		const list = await orm(c).select().from(auditLog)
			.where(where)
			.orderBy(desc(auditLog.logId))
			.limit(size).offset(offset).all();
		const totalRow = await orm(c).select({ total: count() }).from(auditLog)
			.where(where).get();
		return { list, total: totalRow.total };
	}

};

export default auditLogService;
