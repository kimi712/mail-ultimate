// Phase 8 F：新设备 / 新 IP 登录提醒。
// 基于现有 login_log 的 is_new_ip 标记实现；不改 login-service.js 的登录流程
// （那是 B 的文件）。本服务只读 login_log + 维护 known_ip（用户点“我是我本人”
// 后该 IP 记为已知）。提醒分两路：
//   ① 站内提醒：GET /security/new-ip-alerts 列出待确认的新 IP 登录（仪表盘/
//      安全中心里一条醒目的提醒）；② 可选 TG 提醒：notifyNewIpLogin 由登录
//      管线在 is_new_ip=1 时调一次（接线点见汇报，总协调/B 在 login-service
//      里加一行调用），走现有 telegramService.sendAlert 告警通道，内容只含
//      脱敏 IP（maskIp），不含完整 IP；用户关了登录提醒开关（loginAlert=0）
//      时不发 TG。TG 通道是管理员告警通道（发往管理员绑定的 TG），用户级
//      “发到用户自己 TG”需用户绑定 chat_id，列入后续阶段。
import orm from '../entity/orm';
import loginLog from '../entity/login-log';
import knownIp from '../entity/known-ip';
import loginLogService from './login-log-service';
import userSecurityService from './user-security-service';
import settingService from './setting-service';
import telegramService from './telegram-service';
import reqUtils from '../utils/req-utils';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';
import { and, desc, eq } from 'drizzle-orm';
import { parseStoredUaText } from '../utils/device-text.js';

const newIpAlertService = {

	// 待确认的新 IP 登录（只查本人）：login_log 里 is_new_ip=1 且该 IP
	// 不在 known_ip 里的记录（近 30 天，最多 20 条）。location 恒为 null——
	// 本站不记录登录地理位置（PHASE7 审计决定）。
	async listPendingAlerts(c, userId) {
		const data = await loginLogService.listByUser(c, userId, { num: 1, size: 50 });
		const knownRows = await orm(c).select().from(knownIp).where(eq(knownIp.userId, userId)).all();
		const knownSet = new Set(knownRows.map(r => r.ip));
		const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
		let maskOn = false;
		try {
			const setting = await settingService.query(c);
			maskOn = setting && Number(setting.logIpMask) === 1;
		} catch (e) {
			maskOn = false;
		}
		const pending = [];
		for (const row of data.list) {
			if (row.isNewIp !== 1) continue;
			if (knownSet.has(row.ip)) continue;
			if (row.createTime < cutoff) continue;
			const parsed = parseStoredUaText(row.ua);
			pending.push({
				logId: row.logId,
				time: row.createTime,
				ip: maskOn ? reqUtils.maskIp(row.ip) : row.ip,
				rawIp: row.ip,
				device: parsed.device,
				browser: parsed.browser,
				location: null
			});
			if (pending.length >= 20) break;
		}
		return pending;
	},

	// “是我本人”：该 IP 记为已知。IP 必须出现在本人的 login_log 里，
// 否则拒绝（防跨用户确认他人 IP）。
	async acknowledge(c, userId, ip) {
		const value = String(ip || '').trim();
		if (!value) {
			throw new BizError(t('newIpAlertIpRequired'), 400);
		}
		const data = await loginLogService.listByUser(c, userId, { num: 1, size: 50 });
		const owned = data.list.some(r => r.ip === value);
		if (!owned) {
			throw new BizError(t('newIpAlertNotYours'), 404);
		}
		const existing = await orm(c).select().from(knownIp)
			.where(and(eq(knownIp.userId, userId), eq(knownIp.ip, value))).get();
		const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
		if (existing) {
			await orm(c).update(knownIp).set({ lastSeenAt: now })
				.where(eq(knownIp.knownId, existing.knownId)).run();
		} else {
			await orm(c).insert(knownIp).values({ userId, ip: value, firstSeenAt: now, lastSeenAt: now }).run();
		}
		return { ok: true, ip: value };
	},

	// 已知 IP 列表（只查本人）。
	async listKnownIps(c, userId) {
		const rows = await orm(c).select().from(knownIp)
			.where(eq(knownIp.userId, userId)).orderBy(desc(knownIp.lastSeenAt)).all();
		return rows.map(r => ({ ip: r.ip, firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt }));
	},

	// 新 IP 登录时的 TG 提醒（供登录管线在 is_new_ip=1 时调一次；本服务不
	// 改 login-service.js，接线由总协调/B 做）。用户关了登录提醒开关时
	// 不发；TG 文本只含脱敏 IP；永不抛错，不影响登录主流程。
	async notifyNewIpLogin(c, userId, { email = '', ip = '', ua = '' } = {}) {
		try {
			if (!await userSecurityService.isLoginAlertEnabled(c, userId)) {
				return { notified: false, reason: 'disabled' };
			}
			const parsed = parseStoredUaText(ua);
			const masked = reqUtils.maskIp(ip);
			await telegramService.sendAlert(c,
				`🔔 ${t('newIpAlertTgTitle')}\n${t('newIpAlertTgAccount')}: ${email}\n${t('newIpAlertTgIp')}: ${masked}\n${t('newIpAlertTgDevice')}: ${parsed.device} ${parsed.browser}`.trim(),
				'security');
			return { notified: true };
		} catch (e) {
			console.error('新 IP 登录 TG 提醒失败:', e.message);
			return { notified: false, reason: 'error' };
		}
	}
};

export default newIpAlertService;
