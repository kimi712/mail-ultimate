// 斯诺登第四批 P0-2：管理员操作审计可见化（新增服务，不改旧文件）。
// 现状核实（2026-11-11）：
//   已接线：user:delete / user:physics-delete / user:set-status /
//     user:restore / user:unbind-telegram / setting:update（只记被改 key 名，
//     不记密钥值）；用户侧视图 GET /security/audit-log 只能看本人记录。
//   缺口：① /user/setPwd（user-service.setPwd）改他人密码无审计；
//     ② /user/setType（user-service.setType）改角色无审计；
//     ③ role-service.setRole 改角色权限（含 permIds）无审计；
//     ④ 没有管理员全局视图（跨用户查所有管理员操作）。
// 本服务提供：① 高危操作注册表（白名单，防手误写错 action 导致记录
// 查不到）；② recordAdminAction() —— 各高危点调一行即可接线，
// 写审计本身永不抛错（底层 kernel/audit 兜底）；③ listAdminAudit() ——
// 管理员全局视图专用查询（按操作人 / 操作 / 目标过滤，只管理员可见，
// 调用方须先验管理员身份，见 api/admin-audit-api.js）；
// ④ coverage() —— 接线覆盖表，供审计页直接展示“哪些已接线、哪些待补”。
// 注意：setPwd / setType / setRole 三处接线需在 user-service.js 与
// role-service.js 各加一行（这两个文件正由审计员改动，本批不碰，
// 精确补丁见报告 §P0-2，部署统筹接线时按贴）。

import orm from '../entity/orm';
import auditLog from '../entity/audit-log';
import kernelAudit from '../kernel/audit';
import reqUtils from '../utils/req-utils';
import { and, count, desc, eq } from 'drizzle-orm';
import BizError from '../error/biz-error';

// 高危操作注册表：action → 说明。只允许这张表里的 action 写入管理员审计，
// 避免各处手写字符串拼错导致“记了却查不到”。
export const HIGH_RISK_ACTIONS = {
	'user:set-password': { labelZh: '管理员改他人密码', labelEn: 'Admin reset user password', targetType: 'user', severity: 'high' },
	'user:delete': { labelZh: '删号（软删）', labelEn: 'Delete user (soft)', targetType: 'user', severity: 'high' },
	'user:physics-delete': { labelZh: '批量删号（物理删除）', labelEn: 'Delete users (physical)', targetType: 'user', severity: 'high' },
	'user:set-status': { labelZh: '改账号状态（封禁/解封）', labelEn: 'Change account status', targetType: 'user', severity: 'high' },
	'user:set-type': { labelZh: '改用户角色', labelEn: 'Change user role', targetType: 'user', severity: 'high' },
	'user:restore': { labelZh: '恢复账号', labelEn: 'Restore user', targetType: 'user', severity: 'medium' },
	'user:unbind-telegram': { labelZh: '解绑用户 Telegram', labelEn: 'Unbind user Telegram', targetType: 'user', severity: 'medium' },
	'user:locked-by-anomaly': { labelZh: '异常登录锁定账号', labelEn: 'Lock account on anomalous login', targetType: 'user', severity: 'high' },
	'user:unlock': { labelZh: '管理员解锁账号', labelEn: 'Unlock account by admin', targetType: 'user', severity: 'high' },
	'setting:update': { labelZh: '改系统设置', labelEn: 'Update system settings', targetType: 'setting', severity: 'high' },
	'role:perm-update': { labelZh: '改角色权限', labelEn: 'Update role permissions', targetType: 'role', severity: 'high' },
	'email:burned': { labelZh: '阅后即焚已销毁', labelEn: 'Burn-after-reading destroyed', targetType: 'email', severity: 'medium' },
	'login:anomaly': { labelZh: '异常登录告警', labelEn: 'Anomalous login alert', targetType: 'user', severity: 'medium' },
	'alias:expired': { labelZh: '别名到期停用', labelEn: 'Alias expired and disabled', targetType: 'alias', severity: 'low' },
};

const adminAuditService = {

	isHighRiskAction(action) {
		return Object.prototype.hasOwnProperty.call(HIGH_RISK_ACTIONS, action);
	},

	// 高危操作记审计。action 不在注册表时抛错（调用方拼错要立刻暴露，
	// 不能静默记一条查不到的记录）；写库失败永不抛错（kernel 兜底）。
	async recordAdminAction(c, { actorUserId = 0, action = '', targetId = '', detail = {} } = {}) {
		if (!this.isHighRiskAction(action)) {
			throw new BizError(`未知高危操作: ${action}`, 400);
		}
		const meta = HIGH_RISK_ACTIONS[action];
		// 直接调 kernel/audit：audit-log-service.record() 不透传 actorUserId，
		// 高危操作必须显式记操作人，不能依赖当前登录态推断。
		await kernelAudit.audit(c, {
			actorUserId: Number(actorUserId) || 0,
			action,
			targetType: meta.targetType,
			targetId: String(targetId ?? ''),
			detail,
		});
		return { ok: true, action };
	},

	// 管理员全局视图：查所有操作人的高危记录（时间倒序）。
	// 只供管理员接口调用；普通用户仍走 auditLogService.listByUser（仅本人）。
	async listAdminAudit(c, { actorUserId, action = '', targetType = '', targetId = '', num = 1, size = 20 } = {}) {
		size = Number(size);
		num = Number(num);
		if (isNaN(size) || size < 1) size = 20;
		if (num < 1 || isNaN(num)) num = 1;
		if (size > 50) size = 50;
		const conditions = [];
		if (actorUserId) conditions.push(eq(auditLog.actorUserId, Number(actorUserId)));
		if (action) {
			if (!this.isHighRiskAction(action)) throw new BizError(`未知高危操作: ${action}`, 400);
			conditions.push(eq(auditLog.action, action));
		}
		if (targetType) conditions.push(eq(auditLog.targetType, String(targetType)));
		if (targetId !== '' && targetId !== undefined && targetId !== null) {
			conditions.push(eq(auditLog.targetId, String(targetId)));
		}
		const where = conditions.length ? and(...conditions) : undefined;
		const offset = (num - 1) * size;
		let listQuery = orm(c).select().from(auditLog);
		if (where) listQuery = listQuery.where(where);
		const list = await listQuery.orderBy(desc(auditLog.logId)).limit(size).offset(offset).all();
		let totalQuery = orm(c).select({ total: count() }).from(auditLog);
		if (where) totalQuery = totalQuery.where(where);
		const totalRow = await totalQuery.get();
		let maskOn = false;
		try {
			const setting = await c.env.kv.get('setting:', { type: 'json' });
			maskOn = !!setting && (Number(setting.logIpMask) === 1 || Number(setting.log_ip_mask) === 1);
		} catch (e) {
			maskOn = false;
		}
		const parseDetail = (row) => {
			try { return row.detail ? JSON.parse(row.detail) : {}; } catch (e) { return {}; }
		};
		return {
			list: list.map(row => ({
				logId: row.logId,
				time: row.createTime,
				actorUserId: row.actorUserId,
				action: row.action,
				actionLabel: HIGH_RISK_ACTIONS[row.action]?.labelZh || row.action,
				targetType: row.targetType,
				targetId: row.targetId,
				ip: maskOn ? reqUtils.maskIp(row.ip) : row.ip,
				ua: String(row.ua || '').slice(0, 120),
				detail: parseDetail(row),
			})),
			total: totalRow ? totalRow.total : 0,
		};
	},

	// 接线覆盖表：审计页可直接展示。status wired = 已有审计记录；
	// needs-patch = 已确认缺失，补丁见报告（文件正由审计员改动，本批不碰）。
	coverage() {
		return [
			{ action: 'user:set-password', callSite: 'user-service.setPwd (/user/setPwd)', status: 'needs-patch', note: '改他人密码后无审计；补一行 recordAdminAction 即可' },
			{ action: 'user:set-type', callSite: 'user-service.setType (/user/setType)', status: 'needs-patch', note: '改角色后无审计；补一行 recordAdminAction 即可' },
			{ action: 'role:perm-update', callSite: 'role-service.setRole', status: 'needs-patch', note: '改角色权限（含 permIds）后无审计；补一行 recordAdminAction 即可' },
			{ action: 'user:delete', callSite: 'user-service.delete', status: 'wired', note: '已有 user:delete 审计' },
			{ action: 'user:physics-delete', callSite: 'user-service.physicsDelete', status: 'wired', note: '已有 user:physics-delete 审计（含批量）' },
			{ action: 'user:set-status', callSite: 'user-service.setStatus', status: 'wired', note: '已有 user:set-status 审计' },
			{ action: 'user:restore', callSite: 'user-service.restore', status: 'wired', note: '已有 user:restore 审计' },
			{ action: 'user:unbind-telegram', callSite: 'user-service.unbindTelegram', status: 'wired', note: '已有 user:unbind-telegram 审计' },
			{ action: 'setting:update', callSite: 'setting-service.update', status: 'wired', note: '已有 setting:update 审计（只记 key 名，不记密钥值）' },
			{ action: 'user:locked-by-anomaly', callSite: 'login-anomaly-service.lockAccount', status: 'wired', note: '本批新增，见 login-anomaly-service.js' },
			{ action: 'email:burned', callSite: 'burn-after-reading-service.recordBurnReceipt', status: 'wired', note: '本批新增（阅后即焚销毁留痕）' },
			{ action: 'login:anomaly', callSite: 'login-anomaly-service.recordAnomaly', status: 'wired', note: '本批新增（异常登录告警留痕）' },
		];
	},
};

export default adminAuditService;
