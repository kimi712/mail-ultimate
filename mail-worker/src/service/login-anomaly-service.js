// 斯诺登第四批 P1-4：新设备登录通知强化 + 异常登录告警（新增服务，不改旧文件）。
// 现状核实（2026-11-11）：
//   已有：login_log（is_new_ip 标记）+ known_ip（“是我本人”确认后记为已知）
//     + new-ip-alert-service.listPendingAlerts()（站内待确认列表，安全中心
//     展示）+ notifyNewIpLogin()（TG 提醒，走管理员 TG 通道，需登录管线在
//     is_new_ip=1 时调一行——接线点在 login-service，审计员文件中，本批不碰）。
//   缺口：① 无邮件提醒（只有站内列表 + TG）；② 无“异常”判定（新国家 /
//     非常用时段）与二次验证要求；③ 通知里无“一键锁定账号”入口。
// 本批实现：
//   ① 异常评分 scoreLoginAttempt()（纯函数）：新 IP +2、新设备 +1、
//      非常用时段 +2、管理员号 +1、近 1 小时失败 ≥3 次 +2；
//      ≥4 分=anomaly（要求二次验证），2–3 分=watch，0–1 分=normal。
//      “新国家”不做判定：本站按 Phase 7 审计决定不记录登录地理位置
//      （login_log 无 location 列，new-ip-alert-service 明确 location 恒为
//      null），无法在不破坏隐私原则的前提下判断国家——改用“非常用时段”
//      （按本人近 50 次登录的 UTC 小时分布算）作为等效异常信号，
//      原因见报告 §P1-4。
//   ② evaluateLogin()：读 login_log + known_ip，给出本次登录的评估。
//   ③ notifyAnomaly()：TG 告警（现有通道）+ 审计留痕 + 返回邮件提醒
//      文案（buildAnomalyEmail）；sendAnomalyEmail() 按 deadman-service
//      的系统代发模式（executeSend + systemSend）把提醒发到用户本人
//      邮箱——发信失败只记日志，不阻断登录主流程。
//   ④ lockAccount() / unlockAccount()：一键锁定（user.status=BAN +
//      清 KV 会话 + 审计 user:locked-by-anomaly）与管理员解锁。
//      用户自锁走 POST /security/lock-account；管理员解锁走
//      POST /admin/login-anomalies/unlock（见 api/login-anomaly-api.js）。
// 接线点（需改 login-service.js，审计员文件中，本批不碰，补丁见报告）：
//   登录成功后 is_new_ip=1 时调 evaluateLogin() + notifyAnomaly()；
//   level=anomaly 时在登录响应里带 requireStepUp，由前端弹二次验证
//   （TOTP / 密码重验，二验本身走现有 /my/totp 与 /security/unlock 能力）。

import orm from '../entity/orm';
import loginLog from '../entity/login-log';
import knownIp from '../entity/known-ip';
import user from '../entity/user';
import { account } from '../entity/account';
import { userConst } from '../const/entity-const';
import KvConst from '../const/kv-const';
import adminAuditService from './admin-audit-service';
import userSecurityService from './user-security-service';
import telegramService from './telegram-service';
import emailService from './email-service';
import userService from './user-service';
import reqUtils from '../utils/req-utils';
import { desc, eq } from 'drizzle-orm';
import { UAParser } from 'ua-parser-js';

function parseDevice(ua) {
	try {
		const parser = new UAParser(String(ua || ''));
		const { browser, device, os } = parser.getResult();
		const browserText = browser.name ? `${browser.name} ${browser.version || ''}`.trim() : '';
		const osText = os.name ? `${os.name} ${os.version || ''}`.trim() : '';
		const deviceText = [device.vendor, device.model].filter(Boolean).join(' ')
			|| (device.type ? device.type : '') || 'Desktop';
		return { device: deviceText, browser: [browserText, osText].filter(Boolean).join(' / ') };
	} catch (e) {
		return { device: '', browser: '' };
	}
}

function hourOfDbTime(dbTime) {
	// 'YYYY-MM-DD HH:mm:ss' UTC，字典序即时间序；取小时段（UTC）。
	const m = String(dbTime || '').match(/ (\d{2}):/);
	return m ? Number(m[1]) : null;
}

function isUsualHour(hour, usualHours) {
	if (hour === null || !Array.isArray(usualHours) || !usualHours.length) return true;
	for (const h of usualHours) {
		const d = Math.abs(hour - h);
		if (d <= 1 || d >= 23) return true; // ±1 小时容差（含跨午夜）
	}
	return false;
}

// 异常评分（纯函数，可单测）。usualHours 为本人常用登录小时（UTC，0–23）。
export function scoreLoginAttempt({
	isNewIp = false,
	isNewDevice = false,
	hourUtc = null,
	usualHours = [],
	isAdmin = false,
	failedAttemptsLastHour = 0,
} = {}) {
	const reasons = [];
	let score = 0;
	if (isNewIp) { score += 2; reasons.push('new_ip'); }
	if (isNewDevice) { score += 1; reasons.push('new_device'); }
	if (hourUtc !== null && !isUsualHour(hourUtc, usualHours)) { score += 2; reasons.push('unusual_hour'); }
	if (isAdmin) { score += 1; reasons.push('admin_account'); }
	if (Number(failedAttemptsLastHour) >= 3) { score += 2; reasons.push('recent_failures'); }
	const level = score >= 4 ? 'anomaly' : score >= 2 ? 'watch' : 'normal';
	return { score, level, requireStepUp: level === 'anomaly', reasons };
}

// 邮件提醒文案（纯函数）：只含脱敏 IP、设备、时间，不含完整 IP 与会话信息。
export function buildAnomalyEmail({ email = '', maskedIp = '', device = '', browser = '', time = '', level = 'watch' } = {}) {
	const subject = level === 'anomaly'
		? '[Snowden Mail] 异常登录告警：请立即检查你的账号'
		: '[Snowden Mail] 新设备登录提醒';
	const text = [
		'你好，',
		'',
		level === 'anomaly'
			? '你的账号刚刚出现一次异常登录，我们已要求二次验证。'
			: '你的账号刚刚在一台新设备上登录。',
		`账号：${email}`,
		`时间（UTC）：${time}`,
		`IP（已脱敏）：${maskedIp}`,
		`设备：${device} ${browser}`.trim(),
		'',
		'如果你本人操作，请忽略本邮件；如果你没有登录过，请立即在安全中心锁定账号并修改密码。',
		'这封提醒由系统自动发出，请勿回复。',
	].join('\n');
	return { subject, text, html: text.replace(/\n/g, '<br>') };
}

const loginAnomalyService = {

	scoreLoginAttempt,
	buildAnomalyEmail,
	parseDevice,

	// 本次登录评估：读本人近 50 条 login_log + known_ip。
	// 返回 { isNewIp, isNewDevice, hourUtc, usualHours, score, level,
	// requireStepUp, reasons, maskedIp, device, browser }。
	async evaluateLogin(c, userId, { ip = '', ua = '', isAdmin = false } = {}) {
		const rows = await orm(c).select().from(loginLog)
			.where(eq(loginLog.userId, Number(userId)))
			.orderBy(desc(loginLog.logId)).limit(50).all();
		const knownRows = await orm(c).select().from(knownIp)
			.where(eq(knownIp.userId, Number(userId))).all();
		const knownSet = new Set(knownRows.map(r => r.ip));
		const isNewIp = !!ip && !knownSet.has(ip);
		const parsed = parseDevice(ua);
		const seenDevices = new Set(rows.slice(0, 20).map(r => {
			const p = parseDevice(r.ua);
			return `${p.device}|${p.browser}`;
		}));
		const isNewDevice = rows.length > 0 && !seenDevices.has(`${parsed.device}|${parsed.browser}`);
		const usualHours = [...new Set(rows.map(r => hourOfDbTime(r.createTime)).filter(h => h !== null))];
		const hourUtc = new Date().getUTCHours();
		// 注意：login_log 只有成功登录行，无失败次数字段；failedAttemptsLastHour
		// 暂传 0（评分函数保留该输入，待登录限流计数接线后再传入真实值）。
		const scored = scoreLoginAttempt({
			isNewIp,
			isNewDevice,
			hourUtc,
			usualHours,
			isAdmin,
			failedAttemptsLastHour: 0,
		});
		return {
			userId: Number(userId),
			ip: reqUtils.maskIp(ip),
			isNewIp,
			isNewDevice,
			hourUtc,
			usualHours,
			device: parsed.device,
			browser: parsed.browser,
			...scored,
		};
	},

	// 异常留痕：只记脱敏 IP 与评分元数据，不记完整 IP。永不抛错。
	async recordAnomaly(c, { actorUserId = 0, targetUserId = 0, evaluation = {}, ip = '' } = {}) {
		try {
			await adminAuditService.recordAdminAction(c, {
				actorUserId,
				action: 'login:anomaly',
				targetId: String(targetUserId || ''),
				detail: {
					level: evaluation.level || 'watch',
					score: evaluation.score || 0,
					reasons: evaluation.reasons || [],
					maskedIp: reqUtils.maskIp(ip),
				},
			});
			return { ok: true };
		} catch (e) {
			console.error('异常登录留痕失败:', e.message);
			return { ok: false };
		}
	},

	// 异常通知三路：① TG 告警（现有管理员通道，best-effort）；
	// ② 审计留痕；③ 返回邮件提醒文案（调用方用 sendAnomalyEmail 发出）。
	async notifyAnomaly(c, { userId = 0, email = '', evaluation = {}, ip = '', ua = '' } = {}) {
		const time = new Date().toISOString().slice(0, 19).replace('T', ' ');
		const emailAlert = buildAnomalyEmail({
			email,
			maskedIp: reqUtils.maskIp(ip),
			device: evaluation.device || parseDevice(ua).device,
			browser: evaluation.browser || parseDevice(ua).browser,
			time,
			level: evaluation.level || 'watch',
		});
		try {
			if (await userSecurityService.isLoginAlertEnabled(c, userId)) {
				await telegramService.sendAlert(c,
					`⚠️ ${emailAlert.subject}\n账号：${email}\n时间（UTC）：${time}\nIP（已脱敏）：${reqUtils.maskIp(ip)}\n等级：${evaluation.level || 'watch'}（${evaluation.score || 0} 分）`,
					'security');
			}
		} catch (e) {
			console.error('异常登录 TG 提醒失败:', e.message);
		}
		await this.recordAnomaly(c, { actorUserId: userId, targetUserId: userId, evaluation, ip });
		return { ok: true, emailAlert };
	},

	// 邮件提醒发出（系统代发模式，同 deadman-service）：以用户本人身份
	// 发给自己，站内投递；用户无发件账号时返回 { sent:false }，不抛错。
	async sendAnomalyEmail(c, { userId = 0, emailAlert = null } = {}) {
		try {
			if (!emailAlert) return { sent: false, reason: 'no_alert' };
			const userRow = await userService.selectById(c, userId);
			if (!userRow) return { sent: false, reason: 'no_user' };
			const accounts = await orm(c).select().from(account)
				.where(eq(account.userId, Number(userId))).all();
			const sender = accounts.find(a => String(a.email || '').toLowerCase() === String(userRow.email || '').toLowerCase()) || accounts[0];
			if (!sender) return { sent: false, reason: 'no_sender_account' };
			await emailService.executeSend(c, {
				accountId: sender.accountId,
				receiveEmail: [userRow.email],
				subject: emailAlert.subject,
				text: emailAlert.text,
				content: emailAlert.html,
				e2ee: 0,
			}, Number(userId), { systemSend: true });
			return { sent: true };
		} catch (e) {
			console.error('异常登录邮件提醒发送失败:', e.message);
			return { sent: false, reason: 'error' };
		}
	},

	// 一键锁定账号：封禁 + 清会话 + 审计。actorUserId=targetUserId 时为自锁；
	// 管理员代锁时 actor 为管理员。永不删数据（解锁可恢复）。
	async lockAccount(c, { actorUserId = 0, targetUserId = 0, reason = 'anomaly' } = {}) {
		const target = Number(targetUserId);
		if (!target) throw new Error('缺少用户');
		await orm(c).update(user).set({ status: userConst.status.BAN })
			.where(eq(user.userId, target)).run();
		try { await c.env.kv.delete(KvConst.AUTH_INFO + target); } catch (e) { /* 会话清理 best-effort */ }
		await adminAuditService.recordAdminAction(c, {
			actorUserId: Number(actorUserId) || target,
			action: 'user:locked-by-anomaly',
			targetId: String(target),
			detail: { reason: String(reason || 'anomaly').slice(0, 100) },
		});
		return { ok: true, userId: target, status: userConst.status.BAN };
	},

	// 管理员解锁：恢复 NORMAL + 审计。
	async unlockAccount(c, { actorUserId = 0, targetUserId = 0 } = {}) {
		const target = Number(targetUserId);
		if (!target) throw new Error('缺少用户');
		await orm(c).update(user).set({ status: userConst.status.NORMAL })
			.where(eq(user.userId, target)).run();
		await adminAuditService.recordAdminAction(c, {
			actorUserId: Number(actorUserId) || 0,
			action: 'user:unlock',
			targetId: String(target),
			detail: {},
		});
		return { ok: true, userId: target, status: userConst.status.NORMAL };
	},
};

export default loginAnomalyService;
