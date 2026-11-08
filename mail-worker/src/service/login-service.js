import BizError from '../error/biz-error';
import userService from './user-service';
import emailUtils from '../utils/email-utils';
import { isDel, settingConst, userConst, ipBlocklistConst, registerLogConst } from '../const/entity-const';
import JwtUtils from '../utils/jwt-utils';
import { v4 as uuidv4 } from 'uuid';
import KvConst from '../const/kv-const';
import constant from '../const/constant';
import userContext from '../security/user-context';
import verifyUtils from '../utils/verify-utils';
import accountService from './account-service';
import settingService from './setting-service';
import saltHashUtils from '../utils/crypto-utils';
import cryptoUtils from '../utils/crypto-utils';
import turnstileService from './turnstile-service';
import roleService from './role-service';
import regKeyService from './reg-key-service';
import dayjs from 'dayjs';
import { toUtc } from '../utils/date-uitil';
import { t } from '../i18n/i18n.js';
import verifyRecordService from './verify-record-service';
import reqUtils from '../utils/req-utils';
import registerLogService from './register-log-service';
import ipBlocklistService from './ip-blocklist-service';
import telegramService from './telegram-service';
import loginLogService from './login-log-service';
import emailService from './email-service';
import totpService from './totp-service';
import userSecurityService from './user-security-service';
import sessionService from './session-service';
import passkeyService from './passkey-service';

const loginService = {

	// Phase 1 A 路：注册门禁。register(c, params) 是唯一入口（oauth 参数已删，
	// B 路同步改 bindUser 调用；旧的三参调用不再放行）。
	// 全程 try/catch 写注册日志：成功 result:0，任何 throw 记 result:1 + failReason 后 rethrow；
	// 日志写入本身永不抛错（registerLogService.record 内部 try/catch），不影响主流程。
	async register(c, params) {

		const { email, password, token, code } = params;
		const ip = reqUtils.getIp(c);
		const ipSegment = reqUtils.getIpSegment(c);
		const ua = c.req.header('user-agent') || '';
		// verifyMode 由内层在读到 setting 后写入 ctx；读不到时默认 CLOSE(1)。
		const ctx = { ip, ipSegment, verifyMode: settingConst.registerVerify.CLOSE };

		try {
			const result = await this._register(c, params, ctx);
			await registerLogService.record(c, {
				ip, ipSegment, email: email || '', regKeyCode: code || '',
				result: registerLogConst.result.SUCCESS, failReason: '',
				verifyMode: ctx.verifyMode, ua
			});
			return { regVerifyOpen: result.regVerifyOpen };
		} catch (err) {
			await registerLogService.record(c, {
				ip, ipSegment, email: email || '', regKeyCode: code || '',
				result: registerLogConst.result.FAIL,
				failReason: String(err?.message || err || 'register failed').slice(0, 200),
				verifyMode: ctx.verifyMode, ua
			});
			throw err;
		}
	},

	async _register(c, params, ctx) {

		const { email, password, token, code } = params;
		const { ip, ipSegment } = ctx;

		let { regKey, register, registerVerify, regVerifyCount, minEmailPrefix, emailPrefixFilter,
			ipRegLimit, ipRegWindowHours, regRateLimitPerMin, regCircuitThreshold, regCircuitOpen } = await settingService.query(c)

		ctx.verifyMode = registerVerify;

		if (register === settingConst.register.CLOSE) {
			throw new BizError(t('regDisabled'));
		}

		// ---- 注册门禁（契约 §6 A 路）：全部在 register===CLOSE 判断之后、格式校验之前 ----
		// 顺序：黑名单 scope=0 → 熔断 → 分钟限流 → 24h IP 限额。
		// 新 setting 列由 C 路迁移补齐；未迁移前用契约 §1 默认值兜底。
		// 1. 黑名单（禁注册）
		const blocked = await ipBlocklistService.isBlocked(c, ip, ipSegment, ipBlocklistConst.scope.REGISTER);
		if (blocked) {
			throw new BizError(t('ipBlockedRegister'), 429);
		}

		// 2. 熔断：已开直接拒；否则全站最近 1 分钟注册数 ≥ 阈值则自动置位 + 告警 + 拒
		const circuitThreshold = regCircuitThreshold ?? 20;
		if ((regCircuitOpen ?? 0) === 1) {
			throw new BizError(t('regCircuitOpen'), 429);
		}
		const recentAll = await registerLogService.countRecentAll(c, 1);
		if (recentAll >= circuitThreshold) {
			await this._tripCircuit(c, recentAll, circuitThreshold);
			throw new BizError(t('regCircuitOpen'), 429);
		}

		// 3. 分钟限流：同 IP 段 1 分钟内注册尝试（含失败）≥ 上限
		const rateLimitPerMin = regRateLimitPerMin ?? 5;
		const attempts = await registerLogService.countAttemptsBySegment(c, ipSegment, 1);
		if (attempts >= rateLimitPerMin) {
			throw new BizError(t('regTooFrequent'), 429);
		}

		// 4. IP 限额：同 IP 段窗口期内成功注册 ≥ 上限
		const ipLimit = ipRegLimit ?? 3;
		const windowHours = ipRegWindowHours ?? 24;
		const successCount = await registerLogService.countSuccessBySegment(c, ipSegment, windowHours);
		if (successCount >= ipLimit) {
			throw new BizError(t('regIpLimit'), 429);
		}
		// ---- 门禁结束 ----

		if (!verifyUtils.isEmail(email)) {
			throw new BizError(t('notEmail'));
		}

		if (emailUtils.getName(email).length < minEmailPrefix) {
			throw new BizError(t('minEmailPrefix', { msg: minEmailPrefix } ));
		}

		if (emailPrefixFilter.some(content => emailUtils.getName(email).includes(content)))  {
			throw new BizError(t('banEmailPrefix'));
		}

		if (emailUtils.getName(email).length > 64) {
			throw new BizError(t('emailLengthLimit'));
		}

		if (password.length > 30) {
			throw new BizError(t('pwdLengthLimit'));
		}

		if (password.length < 6) {
			throw new BizError(t('pwdMinLength'));
		}

		if (!c.env.domain.includes(emailUtils.getDomain(email))) {
			throw new BizError(t('notEmailDomain'));
		}

		let type = null;
		let regKeyId = 0

		if (regKey === settingConst.regKey.OPEN) {
			const result = await this.handleOpenRegKey(c, regKey, code)
			type = result?.type
			regKeyId = result?.regKeyId
		}

		if (regKey === settingConst.regKey.OPTIONAL) {
			const result = await this.handleOpenOptional(c, regKey, code)
			type = result?.type
			regKeyId = result?.regKeyId
		}

		const accountRow = await accountService.selectByEmailIncludeDel(c, email);

		if (accountRow && accountRow.isDel === isDel.DELETE) {
			throw new BizError(t('isDelUser'));
		}

		if (accountRow) {
			throw new BizError(t('isRegAccount'));
		}

		let defType = null

		if (!type) {
			const roleRow = await roleService.selectDefaultRole(c);
			defType = roleRow.roleId
		}


		const roleRow = await roleService.selectById(c, type || defType);

		if(!roleService.hasAvailDomainPerm(roleRow.availDomain, email)) {

			if (type) {
				throw new BizError(t('noDomainPermRegKey'),403)
			}

			if (defType) {
				throw new BizError(t('noDomainPermReg'),403)
			}

		}

		let regVerifyOpen = false

		// Phase 1 A/B 路约定：registerVerify !== CLOSE 即验证（OPEN 与 COUNT 都必验；
		// COUNT 的 verify_record 计数逻辑见末尾，原样保留）。
		if (registerVerify !== settingConst.registerVerify.CLOSE) {
			regVerifyOpen = true
			await turnstileService.verify(c,token)
		}

		const { salt, hash } = await saltHashUtils.hashPassword(password);

		let consumedCode = null
		const usingRegKey = regKey !== settingConst.regKey.CLOSE && type

		if (usingRegKey && !await regKeyService.consumeCount(c, code)) {
			if (regKey === settingConst.regKey.OPEN) {
				throw new BizError(t('noRegKeyCount'))
			}
			type = null
			regKeyId = 0
			defType = await this.useDefaultRole(c, email)
		}

		if (usingRegKey && type) {
			consumedCode = code
		}

		let userId

		try {
			userId = await userService.insert(c, { email, regKeyId, password: hash, salt, type: type || defType });
			await accountService.insert(c, { userId: userId, email, name: emailUtils.getName(email) });
		} catch (error) {
			if (consumedCode) {
				await regKeyService.restoreCount(c, consumedCode)
			}
			throw error
		}

		await userService.updateUserInfo(c, userId, true);

		// Phase 2 A 路：用掉注册码后检查密钥库存，低于阈值发 TG 告警（best-effort，永不阻断注册）。
		if (consumedCode) {
			try {
				await regKeyService.maybeAlertLowStock(c);
			} catch (e) {
				console.error('注册密钥库存告警失败:', e.message);
			}
		}

		// COUNT 计数逻辑原样保留：COUNT 现必验，regVerifyOpen 恒为 true，
		// 此分支不再触发；verify_record 仍由 setting-service.get()/websiteConfig
		// 与 add-email（ADD 类型）使用，故代码与 increaseRegCount 保留不动。
		if (registerVerify === settingConst.registerVerify.COUNT && !regVerifyOpen) {
			const row = await verifyRecordService.increaseRegCount(c);
			return {regVerifyOpen: row.count >= regVerifyCount}
		}

		return {regVerifyOpen}

	},

	// 熔断置位：D1 置 setting.reg_circuit_open=1（C 路迁移前列不存在会失败，只记日志）+
	// 刷新设置 KV 缓存 + TG 告警（sendAlert 由 C 路新增，未就位时跳过）。
	// 全程 best-effort，任何一步失败都不阻断本次拒绝。
	async _tripCircuit(c, recentCount, threshold) {
		try {
			await c.env.db.prepare('UPDATE setting SET reg_circuit_open = 1').run();
		} catch (e) {
			console.error('熔断置位失败（setting.reg_circuit_open 列可能尚未迁移）:', e.message);
		}
		try {
			await settingService.refresh(c);
		} catch (e) {
			console.error('熔断后刷新设置缓存失败:', e.message);
		}
		try {
			if (typeof telegramService.sendAlert === 'function') {
				await telegramService.sendAlert(c, `🚨 注册熔断已触发\n最近 1 分钟全站注册 ${recentCount} 次（阈值 ${threshold}），注册已自动关闭；管理员需手动恢复（setting.reg_circuit_open 置 0）。`);
			}
		} catch (e) {
			console.error('熔断 TG 告警失败:', e.message);
		}
	},

	async registerVerify() {

	},

	async handleOpenRegKey(c, regKey, code) {

		if (!code) {
			throw new BizError(t('emptyRegKey'));
		}

		const regKeyRow = await regKeyService.selectByCode(c, code);

		if (!regKeyRow) {
			throw new BizError(t('notExistRegKey'));
		}

		if (regKeyRow.count <= 0) {
			throw new BizError(t('noRegKeyCount'));
		}

		if (!toUtc(regKeyRow.expireTime).isAfter(toUtc())) {
			throw new BizError(t('regKeyExpire'));
		}

		return { type: regKeyRow.roleId, regKeyId: regKeyRow.regKeyId };
	},

	async useDefaultRole(c, email) {
		const defaultRole = await roleService.selectDefaultRole(c)
		if (!roleService.hasAvailDomainPerm(defaultRole.availDomain, email)) {
			throw new BizError(t('noDomainPermReg'), 403)
		}
		return defaultRole.roleId
	},

	async handleOpenOptional(c, regKey, code) {

		if (!code) {
			return null
		}

		const regKeyRow = await regKeyService.selectByCode(c, code);

		if (!regKeyRow) {
			return null
		}

		if (regKeyRow.count <= 0 || !toUtc(regKeyRow.expireTime).isAfter(toUtc())) {
			return null
		}

		return { type: regKeyRow.roleId, regKeyId: regKeyRow.regKeyId };
	},

	async login(c, params, noVerifyPwd = false) {

		const { email, password } = params;

		if ((!email || !password) && !noVerifyPwd) {
			throw new BizError(t('emailAndPwdEmpty'));
		}

		const userRow = await userService.selectByEmailIncludeDel(c, email);

		if (!userRow) {
			throw new BizError(t('notExistUser'));
		}

		if(userRow.isDel === isDel.DELETE) {
			throw new BizError(t('isDelUser'));
		}

		if(userRow.status === userConst.status.BAN) {
			throw new BizError(t('isBanUser'));
		}

		if (!await cryptoUtils.verifyPassword(password, userRow.salt, userRow.password) && !noVerifyPwd) {
			throw new BizError(t('IncorrectPwd'));
		}

		// Phase 6：密码通过后查 TOTP 开关。开启时不发正式 JWT，只返回一次性
		// totpToken（KV TOTP_PENDING，5 分钟过期），前端凭它调 POST /login/totp；
		// OAuth 登录（noVerifyPwd）同样走此检查。
		if (await totpService.isEnabled(c, userRow.userId)) {
			const totpToken = uuidv4();
			await c.env.kv.put(KvConst.TOTP_PENDING + totpToken, JSON.stringify({ userId: userRow.userId, attempts: 0 }), { expirationTtl: 300 });
			return { needTotp: true, totpToken };
		}

		return this._issueSession(c, userRow);
	},

	// TOTP 第二步：totpToken + 6 位码（或一次性备份码）换正式 JWT。
	// 失败 5 次作废该 totpToken，须重新密码登录；成功后删除 pending 记录。
	async verifyTotpLogin(c, params) {
		const { totpToken, code } = params || {};
		if (!totpToken) {
			throw new BizError(t('totpTokenInvalid'), 400);
		}
		const pending = await c.env.kv.get(KvConst.TOTP_PENDING + totpToken, { type: 'json' });
		if (!pending || !pending.userId) {
			throw new BizError(t('totpTokenInvalid'), 400);
		}
		const userRow = await userService.selectById(c, pending.userId);
		if (!userRow) {
			throw new BizError(t('notExistUser'), 400);
		}
		if (!await totpService.verifyLoginCode(c, pending.userId, code)) {
			const attempts = (pending.attempts || 0) + 1;
			if (attempts >= 5) {
				await c.env.kv.delete(KvConst.TOTP_PENDING + totpToken);
				throw new BizError(t('totpLocked'), 403);
			}
			await c.env.kv.put(KvConst.TOTP_PENDING + totpToken, JSON.stringify({ userId: pending.userId, attempts }), { expirationTtl: 300 });
			throw new BizError(t('totpInvalidCode'), 400);
		}
		await c.env.kv.delete(KvConst.TOTP_PENDING + totpToken);
		return this._issueSession(c, userRow);
	},

	// Passkey 登录：验签通过后签发正式 JWT（与密码登录同一会话路径）。
	async loginWithPasskey(c, params) {
		const { email, response } = params || {};
		const userId = await passkeyService.verifyAuthentication(c, email, response);
		const userRow = await userService.selectById(c, userId);
		if (!userRow) {
			throw new BizError(t('notExistUser'), 400);
		}
		if (userRow.isDel === isDel.DELETE) {
			throw new BizError(t('isDelUser'));
		}
		if (userRow.status === userConst.status.BAN) {
			throw new BizError(t('isBanUser'));
		}
		return this._issueSession(c, userRow);
	},

	// 密码 / TOTP / Passkey 三路共用的会话签发：JWT + AUTH_INFO + 登录日志 +
	// 新 IP 提醒（受 user_security.login_alert 开关控制）+ 会话元数据。
	async _issueSession(c, userRow) {
		const uuid = uuidv4();
		const jwt = await JwtUtils.generateToken(c,{ userId: userRow.userId, token: uuid });

		let authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userRow.userId, { type: 'json' });

		if (authInfo && (authInfo.user.email === userRow.email)) {

			if (authInfo.tokens.length > 10) {
				authInfo.tokens.shift();
			}

			authInfo.tokens.push(uuid);

		} else {

			authInfo = {
				tokens: [],
				user: userRow,
				refreshTime: dayjs().toISOString()
			};

			authInfo.tokens.push(uuid);

		}

		// Phase 2 A 路：updateUserInfo 会覆盖 activeIp，先取上次登录 IP 与本次 IP。
		// curIp 为 'Unknown'（无 CF-Connecting-IP）时无法判定为新 IP，不标新、不发提醒，避免误报。
		const prevIp = userRow.activeIp;
		const curIp = reqUtils.getIp(c);
		const isNewIp = prevIp && prevIp !== curIp && curIp !== 'Unknown' ? 1 : 0;

		await userService.updateUserInfo(c, userRow.userId);

		// Phase 2 A 路：登录成功后写登录日志；新 IP 时发站内提醒邮件。
		// 全程 best-effort，永不阻断登录；OAuth（noVerifyPwd=true）走同一代码路径。
		// Phase 6：login_alert 关闭后不再发提醒（登录历史照常记）。
		try {
			const uaInfo = reqUtils.getUserAgent(c);
			const uaText = [uaInfo.browser, uaInfo.os, uaInfo.device].filter(Boolean).join(' / ')
				|| (c.req.header('user-agent') || '');
			await loginLogService.record(c, {
				userId: userRow.userId,
				email: userRow.email,
				ip: curIp,
				ua: uaText,
				isNewIp
			});
			if (isNewIp && await userSecurityService.isLoginAlertEnabled(c, userRow.userId)) {
				await this._sendNewIpAlert(c, userRow, curIp, uaText);
			}
		} catch (e) {
			console.error('登录日志/新 IP 提醒失败:', e.message);
		}

		await c.env.kv.put(KvConst.AUTH_INFO + userRow.userId, JSON.stringify(authInfo), { expirationTtl: constant.TOKEN_EXPIRE });
		// Phase 6：登录时写会话元数据（digest → {ua, ip, createdAt}），best-effort。
		await sessionService.recordSession(c, userRow.userId, uuid);
		return jwt;
	},

	// 新 IP 登录提醒：站内投递给用户本人（收件人是本站域名邮箱，不占 Resend 配额）。
	// 发信失败只记日志，永不抛错。注意：普通角色的提醒邮件会按角色规则计 1 次发信量。
	async _sendNewIpAlert(c, userRow, curIp, uaText) {
		try {
			const accountRow = await accountService.selectByEmailIncludeDel(c, userRow.email);
			if (!accountRow) {
				return;
			}
			const nowUtc = new Date().toISOString().slice(0, 19).replace('T', ' ');
			const body = t('newIpLoginBody', { ip: curIp, time: nowUtc, device: uaText || '-' });
			await emailService.send(c, {
				accountId: accountRow.accountId,
				receiveEmail: [userRow.email],
				subject: t('newIpLoginSubject'),
				text: body,
				content: `<p>${body.replace(/\n/g, '<br>')}</p>`
			}, userRow.userId);
		} catch (e) {
			console.error('新 IP 登录提醒邮件发送失败:', e.message);
		}
	},

	async logout(c, userId) {
		const token = await userContext.getToken(c);
		const authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userId, { type: 'json' });
		if (!authInfo) {
			return;
		}
		const index = authInfo.tokens.findIndex(item => item === token);
		if (index > -1) {
			authInfo.tokens.splice(index, 1);
		}
		await c.env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify(authInfo), { expirationTtl: constant.TOKEN_EXPIRE });
		// Phase 6：登出时同步清本设备会话元数据。
		if (token) {
			await sessionService.clearSession(c, userId, token);
		}
	}

};

export default loginService;
