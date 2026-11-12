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
import { isBotUa, isBotRegisterUa, isRandom9Name } from '../utils/bot-fingerprint';
import ipBlocklistService from './ip-blocklist-service';
import telegramService from './telegram-service';
import loginLogService from './login-log-service';
import emailService from './email-service';
import totpService from './totp-service';
import userSecurityService from './user-security-service';
import sessionService from './session-service';
import { getAuthInfoWithRetry } from '../utils/auth-info-utils';
import passkeyService from './passkey-service';
import recoveryService from './recovery-service';
import newIpAlertService from './new-ip-alert-service';
// 斯诺登第四批 P1-4：新设备登录通知强化 + 异常登录告警。
import loginAnomalyService from './login-anomaly-service';
import ratelimit from '../kernel/ratelimit';
import kernelAudit from '../kernel/audit';
import alertLogService from './alert-log-service';
import decoyService from './decoy-service';
import zkService from './zk-service';
import { sleep } from '../utils/time-utils';

// Phase 8 B · 登录限流默认值（setting 未迁移/读不到时兜底；迁移后管理员可在
// setting 里调：login_rate_limit_window_min / login_rate_limit_ip_max /
// login_rate_limit_acct_max / login_rate_limit_lock_base_min，见 PHASE8-B.md DDL 清单）。
// 窗口 15 分钟；IP 与账号维度各 5 次失败后锁定；首锁 5 分钟，指数退避（×3，上限 24h）。
const LOGIN_RATE_LIMIT_DEFAULTS = { windowMin: 15, ipMax: 5, acctMax: 5, lockBaseMin: 5 };

// 管理员渐进延迟（替代 30 分钟硬锁）：硬锁会被知道管理员邮箱的人利用来锁死
// 管理员本人（拒绝服务漏洞）。改为失败 >= 5 次后每次登录尝试服务端强制延迟：
// 第 6 次 5 秒、第 7 次 10 秒、第 8 次 20 秒、第 9 次 40 秒，封顶 60 秒；
// 账号永不锁定。暴力破解靠高频试密码，延迟让攻击者每分钟只能试一两次，
// 管理员本人输错只多等几秒。计数窗口与普通登录限流同窗（默认 15 分钟）；
// 登录成功清零（见 _issueSession）。
// 注意：普通账号维度的硬锁（login:acct:）也不适用于管理员（见 _recordLoginFailure），
// 否则换个锁名照样能把管理员锁在外面；IP 维度锁保留（锁的是攻击者 IP）。
const ADMIN_USER_ID = 1;
const ADMIN_FAIL_MAX = 5; // 延迟起始阈值：窗口内累计失败 >= 5 次后开始延迟
const ADMIN_DELAY_BASE_SECONDS = 5; // 第 6 次延迟 5 秒，之后每次翻倍
const ADMIN_DELAY_MAX_SECONDS = 60; // 封顶 60 秒
const ADMIN_FAIL_COUNT_LIMIT = 1000; // 管理员失败计数窗口上限（只计数、不上锁；须远大于阈值，count 才能继续涨、延迟才能递增）

// 管理员渐进延迟（秒）：failCount 为当前窗口内累计失败次数。
// count < 5 → 0；5 → 5；6 → 10；7 → 20；8 → 40；>= 9 → 60（封顶）。
export function adminDelaySeconds(failCount) {
	const n = Math.max(0, Number(failCount) || 0);
	if (n < ADMIN_FAIL_MAX) return 0;
	return Math.min(ADMIN_DELAY_BASE_SECONDS * Math.pow(2, n - ADMIN_FAIL_MAX), ADMIN_DELAY_MAX_SECONDS);
}

// 管理员判定：user_id 1（历史口径；测试库首个用户也是 1）或邮箱等于环境
// 变量 c.env.admin（代码库内管理员的 canonical 定义，见 security.js
// isAdminRequest）。老站 admin@flame.edu.kg 是 user_id 2，只认 user_id 1
// 会漏掉真正的管理员账号，故两条件任一成立即算管理员。
export function isAdminUser(c, userRow) {
	if (!userRow) return false;
	if (userRow.userId === ADMIN_USER_ID) return true;
	const adminEmail = String(c?.env?.admin || '').trim().toLowerCase();
	return !!adminEmail && String(userRow.email || '').trim().toLowerCase() === adminEmail;
}

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
		const ctx = { ip, ipSegment, ua, verifyMode: settingConst.registerVerify.CLOSE };

		try {
			const result = await this._register(c, params, ctx);
			// 有占位行则 UPDATE 收尾（改 SUCCESS），无占位行（如门禁前已抛错）才 INSERT 新行。
			if (ctx.reservedLogId) {
				await registerLogService.updateResult(c, ctx.reservedLogId, {
					result: registerLogConst.result.SUCCESS, failReason: ''
				});
			} else {
				await registerLogService.record(c, {
					ip, ipSegment, email: email || '', regKeyCode: code || '',
					result: registerLogConst.result.SUCCESS, failReason: '',
					verifyMode: ctx.verifyMode, ua
				});
			}
			// 注册即登录：把 _register 签发的 JWT 与恢复码一并返回，前端直接进站。
			return { regVerifyOpen: result.regVerifyOpen, recoveryCodes: result.recoveryCodes || null, token: result.token || null };
		} catch (err) {
			if (ctx.reservedLogId) {
				await registerLogService.updateResult(c, ctx.reservedLogId, {
					result: registerLogConst.result.FAIL,
					failReason: String(err?.message || err || 'register failed').slice(0, 200)
				});
			} else {
				await registerLogService.record(c, {
					ip, ipSegment, email: email || '', regKeyCode: code || '',
					result: registerLogConst.result.FAIL,
					failReason: String(err?.message || err || 'register failed').slice(0, 200),
					verifyMode: ctx.verifyMode, ua
				});
			}
			throw err;
		}
	},

	async _register(c, params, ctx) {

		// 后端 trim（与 11:43 前端 trim 对齐，双保险）：手机键盘常在邮箱/密码前后误加空格，
		// 注册与登录须用同一处理，否则注册成功却登不上。注意：门禁日志与后续校验都用 trim 后的值。
		let { email, password, token, code } = params;
		email = String(email || '').trim();
		password = String(password || '').trim();
		const { ip, ipSegment } = ctx;

		let { regKey, register, registerVerify, regVerifyCount, minEmailPrefix, emailPrefixFilter,
			ipRegLimit, ipRegWindowHours, regRateLimitPerMin, regCircuitThreshold, regCircuitOpen, regSegmentLimit } = await settingService.query(c)

		ctx.verifyMode = registerVerify;

		if (register === settingConst.register.CLOSE) {
			throw new BizError(t('regDisabled'));
		}

		// 批量薅号门禁 1：机器人 UA 硬拒。UA 取请求头 user-agent 原样；
		// 光秃秃的 "Mozilla/5.0" 没有任何真实浏览器会发，可单独拒。
		// 空白 UA 不单独拒——真人流量里也有大量空白 UA（脚本/curl/部分客户端不带 UA）。
		if (isBotUa(ctx.ua)) {
			throw new BizError(t('botUaBlocked'), 429);
		}

		// ---- 注册门禁（契约 §6 A 路）：全部在 register===CLOSE 判断之后、格式校验之前 ----
		// 顺序：黑名单 scope=0 → 熔断 → 分钟限流 → 24h IP 限额。
		// 新 setting 列由 C 路迁移补齐；未迁移前用契约 §1 默认值兜底。
		// 提速：三项独立读（黑名单、全站 1 分钟注册数、同 IP 段 1 分钟尝试数）并行，
		// 再按原顺序判定，任一判定语义不变。熔断已开时仍先拒，不多做读。
		const circuitThreshold = regCircuitThreshold ?? 20;
		if ((regCircuitOpen ?? 0) === 1) {
			throw new BizError(t('regCircuitOpen'), 429);
		}
		const rateLimitPerMin = regRateLimitPerMin ?? 5;
		const [blocked, recentAll, attempts] = await Promise.all([
			ipBlocklistService.isBlocked(c, ip, ipSegment, ipBlocklistConst.scope.REGISTER),
			registerLogService.countRecentAll(c, 1),
			registerLogService.countAttemptsBySegment(c, ipSegment, 1),
		]);
		// 1. 黑名单（禁注册）
		if (blocked) {
			throw new BizError(t('ipBlockedRegister'), 429);
		}

		// 2. 熔断：全站最近 1 分钟注册数 ≥ 阈值则自动置位 + 告警 + 拒
		if (recentAll >= circuitThreshold) {
			await this._tripCircuit(c, recentAll, circuitThreshold);
			throw new BizError(t('regCircuitOpen'), 429);
		}

		// 3. 分钟限流：同 IP 段 1 分钟内注册尝试（含失败）≥ 上限
		if (attempts >= rateLimitPerMin) {
			throw new BizError(t('regTooFrequent'), 429);
		}

		// 4. IP 限额：原子占位。先查后写有竞态（同一秒多请求同时读到 count<limit
		// 便全部通过），故改用单条条件 INSERT 先占位；占不上即超限。
		// 占位行 result=RESERVED，不计入成功数、计入分钟尝试数；外层收尾时 UPDATE 为最终结果。
		const ipLimit = ipRegLimit ?? 3;
		const windowHours = ipRegWindowHours ?? 24;
		const segmentLimit = regSegmentLimit ?? 9;
		const ipSubnet = reqUtils.getIpSubnet(c, ip);
		const reservedLogId = await registerLogService.reserveSlot(c, {
			ip, ipSegment, email: email || '', limit: ipLimit, windowHours,
			segmentLimit, segmentWindowHours: windowHours, ipSubnet, ua: ctx.ua
		});
		if (!reservedLogId) {
			// 占位失败可能是单 IP 限额，也可能是网段限额（24h 或 7 天累积）：
			// 读数区分，报错口径对得上，管理员在注册日志里也能定位。
			const segCount24h = await registerLogService.countRecentBySubnet(c, ipSubnet, windowHours);
			const segCount7d = segCount24h >= segmentLimit ? segCount24h : await registerLogService.countRecentBySubnet(c, ipSubnet, 168);
			if (segCount24h >= segmentLimit || segCount7d >= segmentLimit * 3) {
				throw new BizError(t('regSegmentLimit'), 429);
			}
			throw new BizError(t('regIpLimit'), 429);
		}
		ctx.reservedLogId = reservedLogId;
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

		// 批量薅号门禁 2：9 位随机名 + 空白 UA + 短时集中注册，三者组合才拒。
		// 空白 UA 单独不是信号（真人流量里也大量出现）；完整浏览器 UA 的真人
		//（哪怕名字像随机串，如 zhangsan1）不受这条影响。纯字母 9 位名（如 xiangqian、
		// sihongliu 这类真名）不含数字，不进随机名判定，直接放行。
		// “集中”取两个维度：同 IP 10 分钟内第 2 次成功/占位，或同网段 60 分钟内第 3 次
		//（2026-11-10 爆发号同 /24 段 2 小时攒 21 个，靠换 IP 绕单 IP 限额）。
		if (isRandom9Name(emailUtils.getName(email)) && isBotRegisterUa(ctx.ua)) {
			const [ipRecent, segRecent] = await Promise.all([
				registerLogService.countRecentSuccessBySegment(c, ipSegment, 10),
				registerLogService.countRecentSuccessBySubnet(c, ipSubnet, 60)
			]);
			if (ipRecent >= 2 || segRecent >= 3) {
				throw new BizError(t('regRandomNameBurst'), 429);
			}
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
			userId = await userService.insert(c, { email, regKeyId, password: hash, salt, type: type || defType, createIp: ip });
			await accountService.insert(c, { userId: userId, email, name: emailUtils.getName(email) });
		} catch (error) {
			if (consumedCode) {
				await regKeyService.restoreCount(c, consumedCode)
			}
			throw error
		}

		// Phase 8 F：注册时生成 10 个恢复码（只显示一次），随注册响应一次返回；
		// 生成失败不阻断注册（恢复码可在登录后于隐私仪表盘里重新生成）。
		let recoveryCodes = null;
		try {
			const codesResult = await recoveryService.generateCodesForRegistration(c, userId);
			recoveryCodes = codesResult?.codes || null;
		} catch (e) {
			console.error('注册时生成恢复码失败:', e.message);
		}

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

		// 注册即记密码强度桶（KV，只存 0–5 级，不存密码本身，供安全评分读取），
		// 与登录时的逻辑一致；否则新用户安全评分里密码强度项恒为 0。
		try {
			await c.env.kv.put('pwd_strength:' + userId,
				JSON.stringify({ score: this.passwordStrength(password), at: new Date().toISOString() }),
				{ expirationTtl: 90 * 86400 });
		} catch (e) {
			// best-effort，不阻断注册
		}

		// 注册完成直接签发会话（自动登录）：新用户 activeIp 为空，_issueSession 内
		// isNewIp=0，不会误发新 IP 提醒；活跃信息由 _issueSession 内 updateUserInfo 写。
		// 签发失败不阻断注册（用户已建好），前端无 token 时回落到登录页。
		// 注意：params 里已解构出 Turnstile 的 token，故这里用 sessionToken 避免重名。
		let sessionToken = null;
		try {
			const userRow = await userService.selectById(c, userId);
			sessionToken = await this._issueSession(c, userRow);
		} catch (e) {
			console.error('注册后签发会话失败:', e.message);
		}
		return {regVerifyOpen, recoveryCodes, token: sessionToken}

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

		// 后端 trim（与注册端对齐；前端 11:43 已 trim，这里是双保险）。
		let { email, password, zk } = params;
		email = String(email || '').trim();
		password = String(password || '').trim();

		if ((!email || !password) && !noVerifyPwd) {
			throw new BizError(t('emailAndPwdEmpty'));
		}

		// Phase 8 B · 登录限流（IP + 账号双维度，Layer 1 kernel/ratelimit）：
		// 先查锁（密码与 OAuth 登录都查），锁定中直接返回通用错误，不透露账号是否存在；
		// 密码校验失败记一次失败（未知账号同样计数，避免用“锁没锁”反推账号是否存在）。
		const ip = reqUtils.getIp(c);
		const cfg = await this._loginRateLimitConfig(c);
		const { ipKey, acctKey } = await this._loginLimitKeys(ip, email);
		const locked = await this._checkLoginLocked(c, ipKey, acctKey);
		if (locked) {
			throw new BizError(t('loginRateLimited'), 429);
		}
		const fail = async (err) => {
			if (!noVerifyPwd) {
				const res = await this._recordLoginFailure(c, { ip, ipKey, acctKey, cfg, isAdmin: isAdminUser(c, userRow) });
				if (res.locked) {
					throw new BizError(t('loginRateLimited'), 429);
				}
			}
			throw err;
		};

		// Phase 8 H：登录失败一律返回通用错误（邮箱或密码不正确），不区分
		// “邮箱不存在 / 账号已注销 / 已禁用 / 密码错”，防止枚举账号是否存在。
		// 失败计数（B 的限流）不受影响——四种情况都照常记一次失败。
		const userRow = await userService.selectByEmailIncludeDel(c, email);

		if (!userRow) {
			await fail(new BizError(t('authErrLoginFailed')));
		}

		if(userRow.isDel === isDel.DELETE) {
			await fail(new BizError(t('authErrLoginFailed')));
		}

		if(userRow.status === userConst.status.BAN) {
			await fail(new BizError(t('authErrLoginFailed')));
		}

		// 管理员渐进延迟（替代 30 分钟硬锁，防 DoS）：窗口内失败 >= 5 次后，
		// 每次密码登录尝试服务端强制延迟（5s → 10s → 20s → 40s → 60s 封顶），
		// 账号永不锁定；成功登录后计数清零（见 _issueSession）。
		// 延迟放在密码校验之前、放在用户查到之后：正确与错误密码耗时相同，
		// 不泄露密码对错；OAuth 登录（noVerifyPwd）不走密码猜测，不延迟。
		if (!noVerifyPwd && isAdminUser(c, userRow)) {
			try {
				const { count } = await ratelimit.peek(c, 'login:admin-fail:' + acctKey);
				const delaySec = adminDelaySeconds(count);
				if (delaySec > 0) {
					await sleep(delaySec * 1000);
				}
			} catch (e) {
				// 延迟读取失败视为无延迟（fail-open，不把限流故障变成登录不可用）
			}
		}

		// 零知识挑战（v3_16DB）：登录请求带了 zk 字段时，先验挑战再验密码；
		// 挑战无效按一次登录失败计数（防用挑战接口绕过登录限流）。
		// response = SHA-256(verifier + nonce) base64，其中
		// verifier = SHA-256(salt + password)；服务端只存 zkSalt/zkVerifier
		// （验证子），用 verifier 重算比对，绝不把 response 当密码存。
		if (!noVerifyPwd && zk && typeof zk === 'object' && zk.challengeId) {
			const zkOk = await zkService.verifyResponse(c, userRow, zk.challengeId, zk.response);
			if (!zkOk) {
				await fail(new BizError(t('zkChallengeInvalid'), 401));
			}
		}

		// 密码校验 +  legacy 自愈：11:43 前端 trim 修复之前，手机键盘常在密码末尾误加空格，
		// 那些账号的密码 hash 是按带空格版本存的；现在前端统一 trim 后它们永远登不上。
		// 依次尝试 trim 版 → 尾空格 → 首空格；命中带空格版本时用 trim 版重算 hash 存回（自愈），
		// 下次直接用 trim 版登录。OAuth 登录（noVerifyPwd）跳过此段。
		if (!noVerifyPwd) {
			let pwdOk = await cryptoUtils.verifyPassword(password, userRow.salt, userRow.password);
			let healed = false;
			if (!pwdOk) {
				for (const variant of [password + ' ', ' ' + password]) {
					if (await cryptoUtils.verifyPassword(variant, userRow.salt, userRow.password)) {
						pwdOk = true;
						healed = true;
						break;
					}
				}
			}
			if (!pwdOk) {
				// 胁迫密码（v3_16DB）：主密码不对时，试第二密码；命中则签发诱饵
				// 会话（JWT 含 decoy=1），不记失败、不上锁、不告警；
				// 不命中时报错文案与普通登录失败完全一致（不透露“胁迫密码存在”）。
				if (await decoyService.verifySecondPassword(c, userRow.userId, password)) {
					return this._issueSession(c, userRow, { decoy: true });
				}
				await fail(new BizError(t('authErrLoginFailed')));
			}
			if (healed) {
				try {
					await userService.resetPassword(c, { password }, userRow.userId);
				} catch (e) {
					console.error('登录密码自愈失败（不阻断登录）:', e.message);
				}
			}
		}

		// 密码通过：记密码强度桶（KV，只存 0–5 级，不存密码本身，供安全评分读取）。
		if (!noVerifyPwd && password) {
			try {
				await c.env.kv.put('pwd_strength:' + userRow.userId,
					JSON.stringify({ score: this.passwordStrength(password), at: new Date().toISOString() }),
					{ expirationTtl: 90 * 86400 });
			} catch (e) {
				// best-effort，不阻断登录
			}
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

	// 密码强度 0–5 级：长度≥8（+1）、≥12（+1）、大小写混用（+1）、含数字（+1）、含符号（+1）。
	passwordStrength(password) {
		const pwd = String(password || '');
		let score = 0;
		if (pwd.length >= 8) {
			score += 1;
		}
		if (pwd.length >= 12) {
			score += 1;
		}
		if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) {
			score += 1;
		}
		if (/\d/.test(pwd)) {
			score += 1;
		}
		if (/[^A-Za-z0-9]/.test(pwd)) {
			score += 1;
		}
		return score;
	},

	// 限流配置：读 setting（未迁移/读不到时用默认值兜底，永不抛错）。
	async _loginRateLimitConfig(c) {
		try {
			const s = await settingService.query(c);
			return {
				windowMin: Number(s?.loginRateLimitWindowMin ?? s?.login_rate_limit_window_min ?? LOGIN_RATE_LIMIT_DEFAULTS.windowMin) || LOGIN_RATE_LIMIT_DEFAULTS.windowMin,
				ipMax: Number(s?.loginRateLimitIpMax ?? s?.login_rate_limit_ip_max ?? LOGIN_RATE_LIMIT_DEFAULTS.ipMax) || LOGIN_RATE_LIMIT_DEFAULTS.ipMax,
				acctMax: Number(s?.loginRateLimitAcctMax ?? s?.login_rate_limit_acct_max ?? LOGIN_RATE_LIMIT_DEFAULTS.acctMax) || LOGIN_RATE_LIMIT_DEFAULTS.acctMax,
				lockBaseMin: Number(s?.loginRateLimitLockBaseMin ?? s?.login_rate_limit_lock_base_min ?? LOGIN_RATE_LIMIT_DEFAULTS.lockBaseMin) || LOGIN_RATE_LIMIT_DEFAULTS.lockBaseMin
			};
		} catch (e) {
			return { ...LOGIN_RATE_LIMIT_DEFAULTS };
		}
	},

	// 限流维度 key（SHA-256 摘要，KV 里不存 IP/邮箱明文）。
	async _loginLimitKeys(ip, email) {
		return {
			ipKey: await ratelimit.dimensionKey(`login:ip:${ip || 'Unknown'}`),
			acctKey: await ratelimit.dimensionKey(`login:acct:${String(email || '').toLowerCase()}`)
		};
	},

	// 查锁：任一维度锁定即返回 { dimension, until, level }，否则 null。
	async _checkLoginLocked(c, ipKey, acctKey) {
		try {
			const ipLock = await ratelimit.getLock(c, 'login:ip:' + ipKey);
			if (ipLock.locked) {
				return { dimension: 'ip', ...ipLock };
			}
			const acctLock = await ratelimit.getLock(c, 'login:acct:' + acctKey);
			if (acctLock.locked) {
				return { dimension: 'account', ...acctLock };
			}
		} catch (e) {
			// 查锁失败视为无锁（fail-open）
		}
		return null;
	},

	// 记一次登录失败：IP 与账号窗口各消费一次；任一窗口满则上锁（指数退避），
	// 记 audit_log（元数据）与 alert_log（1 小时内同一维度只告警一次）。
	async _recordLoginFailure(c, { ip, ipKey, acctKey, cfg, isAdmin = false }) {
		const windowSeconds = cfg.windowMin * 60;
		let locked = null;
		try {
			const ipRes = await ratelimit.consume(c, 'login:ip:' + ipKey, cfg.ipMax, windowSeconds);
			// 管理员不走账号维度硬锁：账号锁会被知道管理员邮箱的人利用来锁死管理
			// 员本人（拒绝服务）。管理员的失败只计 IP 维度（锁攻击者 IP，不锁账号）
			// 与 admin-fail 维度（驱动渐进延迟）；普通用户保持原规则。
			let acctRes = { allowed: true };
			if (!isAdmin) {
				acctRes = await ratelimit.consume(c, 'login:acct:' + acctKey, cfg.acctMax, windowSeconds);
			}
			if (!ipRes.allowed) {
				const lock = await ratelimit.setLock(c, 'login:ip:' + ipKey, cfg.lockBaseMin * 60);
				locked = { dimension: 'ip', ...lock };
			} else if (!acctRes.allowed) {
				const lock = await ratelimit.setLock(c, 'login:acct:' + acctKey, cfg.lockBaseMin * 60);
				locked = { dimension: 'account', ...lock };
			}
		} catch (e) {
			console.error('登录失败计数失败:', e.message);
		}
		// 管理员失败计数（只计数、不上锁）：供登录入口的渐进延迟使用。
		// 旧逻辑是 5 次失败即固定锁 30 分钟，已删除（拒绝服务漏洞）；计数窗口
		// 上限放宽到 ADMIN_FAIL_COUNT_LIMIT，让 count 能继续涨、延迟能递增；
		// 触发延迟的当次仍返回原错误（5 次失败都返回 501，延迟从下一次尝试起生效）。
		if (isAdmin) {
			try {
				await ratelimit.consume(c, 'login:admin-fail:' + acctKey, ADMIN_FAIL_COUNT_LIMIT, windowSeconds);
			} catch (e) {
				console.error('管理员登录失败计数失败:', e.message);
			}
		}
		if (locked && locked.seconds > 0) {
			const minutes = Math.round(locked.seconds / 60);
			try {
				await kernelAudit.audit(c, {
					action: 'login:rate_limited', targetType: 'login', targetId: acctKey.slice(0, 12),
					detail: { dimension: locked.dimension, lockMinutes: minutes, level: locked.level }
				});
			} catch (e) {
				// best-effort
			}
			await this._maybeAlertLoginLock(c, locked.dimension === 'ip' ? ipKey : acctKey,
				`登录限流锁定：${locked.dimension === 'ip' ? 'IP' : '账号'}因多次登录失败被锁定 ${minutes} 分钟（IP ${reqUtils.maskIp(ip)}）`);
			return { locked: true, ...locked };
		}
		return { locked: false };
	},

	// 限流锁定告警（同一维度 1 小时内只发一次，防刷屏）。
	async _maybeAlertLoginLock(c, dimKey, text) {
		try {
			const flagKey = 'rl:alert:login:' + dimKey;
			const seen = await c.env.kv.get(flagKey);
			if (seen) {
				return;
			}
			await c.env.kv.put(flagKey, '1', { expirationTtl: 3600 });
			await alertLogService.record(c, { type: 'ratelimit', text, source: 'worker' });
		} catch (e) {
			console.error('登录限流告警失败:', e.message);
		}
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
	// 斯诺登第三批（v3_16DB）：options.decoy=true 时签发诱饵会话——JWT 载
	// decoy=1（security.js 据此置位诱饵模式）；不更新 activeIp/activeTime
	// （不让胁迫登录重置死亡开关时钟），不写登录日志、不发新 IP 提醒、不发
	// TG 提醒（胁迫登录不触发任何告警）；只记一条审计 'security:duress-login'
	// 供本人事后取证（见 decoy-service.recordDuressLogin）。
	async _issueSession(c, userRow, options = {}) {
		const decoy = options.decoy === true;
		const uuid = uuidv4();
		const jwt = await JwtUtils.generateToken(c, { userId: userRow.userId, token: uuid, ...(decoy ? { decoy: 1 } : {}) });

		// Phase 8 B：完整登录成功后清账号维度的登录失败计数（IP 维度的不清除，
		// 防止攻击者用一次成功登录洗掉同一 IP 下其他账号的失败计数）。
		// 诱饵会话不碰限流状态。
		if (!decoy) {
			try {
				const acctKey = await ratelimit.dimensionKey(`login:acct:${String(userRow.email || '').toLowerCase()}`);
				await ratelimit.clearWindow(c, 'login:acct:' + acctKey);
				// 管理员加严：登录成功清管理员失败计数。
				if (isAdminUser(c, userRow)) {
					await ratelimit.clearWindow(c, 'login:admin-fail:' + acctKey);
				}
			} catch (e) {
				// best-effort，不阻断登录
			}
		}

		// KV 最终一致性：读不到时重试一次再走新建分支。
		let authInfo = await getAuthInfoWithRetry(c, userRow.userId, null, { attempts: 2, delayMs: 200 });

		// Phase 7：KV 里不再存密码 hash 与 salt。authInfo.user 只供鉴权中间件
		// 取 userId/email（见 security.js），hash/salt 落 KV 等于把凭证材料
		// 放在 D1 之外的第二个存储里；旧 KV 条目在用户下次登录时被覆盖。
		const { password: _pwd, salt: _salt, ...safeUser } = userRow;
		if (authInfo && (authInfo.user.email === userRow.email)) {

			if (authInfo.tokens.length > 10) {
				authInfo.tokens.shift();
			}

			authInfo.tokens.push(uuid);

		} else {

			authInfo = {
				tokens: [],
				user: safeUser,
				refreshTime: dayjs().toISOString()
			};

			authInfo.tokens.push(uuid);

		}

		// Phase 7：旧 KV 条目里的 user 仍可能含密码 hash/salt，每次登录都用
		// 本次的 safeUser 覆盖，确保重登录后 KV 里不再有凭证材料。
		authInfo.user = safeUser;

		// Phase 2 A 路：updateUserInfo 会覆盖 activeIp，先取上次登录 IP 与本次 IP。
		// curIp 为 'Unknown'（无 CF-Connecting-IP）时无法判定为新 IP，不标新、不发提醒，避免误报。
		// 诱饵会话不更新 activeIp/activeTime（不让胁迫登录重置死亡开关时钟）。
		const prevIp = userRow.activeIp;
		const curIp = reqUtils.getIp(c);
		const isNewIp = prevIp && prevIp !== curIp && curIp !== 'Unknown' ? 1 : 0;

		if (!decoy) {
			await userService.updateUserInfo(c, userRow.userId);
		}

		// Phase 2 A 路：登录成功后写登录日志；新 IP 时发站内提醒邮件。
		// 全程 best-effort，永不阻断登录；OAuth（noVerifyPwd=true）走同一代码路径。
		// Phase 6：login_alert 关闭后不再发提醒（登录历史照常记）。
		// 诱饵会话：不写登录日志、不发任何提醒（新 IP 提醒邮件、TG 提醒一律
		// 跳过），只记一条审计 'security:duress-login' 供本人事后取证。
		if (decoy) {
			try {
				await decoyService.recordDuressLogin(c, userRow.userId, curIp);
			} catch (e) {
				// best-effort
			}
		} else {
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
				// Phase 8 F：新 IP 登录 TG 提醒（走管理员告警通道，文本只含脱敏 IP；
				// 服务内部再验一次登录提醒开关；best-effort，永不阻断登录）。
				await newIpAlertService.notifyNewIpLogin(c, userRow.userId, { email: userRow.email, ip: curIp, ua: uaText });
			}
				// 斯诺登第四批 P1-4：新 IP 登录异常评估 + 告警（TG/邮件/审计留痕）。
				// best-effort，永不阻断登录。level=anomaly 的强制二次验证
				// （requireStepUp）需登录响应携 flag + 前端配合，本批暂未接线（已记入夜间核查报告）；
				// 异常已通过 TG/邮件/审计告警，管理员可凭通知一键锁定账号。
				if (isNewIp) {
					try {
						const evaluation = await loginAnomalyService.evaluateLogin(c, userRow.userId, { ip: curIp, ua: uaText, isAdmin: isAdminUser(c, userRow) });
						if (evaluation.level !== 'normal') {
							const { emailAlert } = await loginAnomalyService.notifyAnomaly(c, { userId: userRow.userId, email: userRow.email, evaluation, ip: curIp, ua: uaText });
							void loginAnomalyService.sendAnomalyEmail(c, { userId: userRow.userId, emailAlert });
						}
					} catch (e) {
						console.error('登录异常评估失败:', e.message);
					}
				}
				// 管理员加严：管理员每次登录成功都发 TG 提醒（与新 IP
				// 提醒无关，每次都发；诱饵会话走另一分支，不发）。
				if (isAdminUser(c, userRow)) {
					await this._sendAdminLoginAlert(c, userRow, curIp, uaText);
				}
		} catch (e) {
			console.error('登录日志/新 IP 提醒失败:', e.message);
		}
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

	// 管理员登录提醒（Telegram 版）：管理员每次登录成功后发一条 TG 消息到
	// 管理员本人绑定的 Telegram（user.tg_chat_id），走本站已配的 TG 机器人
	// （setting.tg_bot_token）。未绑 TG 或本站未配机器人时只记日志，不发
	// 邮件兜底、不阻断登录；正文不含密码、token、验证码。
	async _sendAdminLoginAlert(c, userRow, curIp, uaText) {
		try {
			const chatId = String(userRow.tgChatId || '').trim();
			if (!chatId) {
				console.log('管理员登录提醒未发送：管理员未绑定 Telegram');
				return;
			}
			const host = c.req.header('host') || '';
			const site = host.includes('aevorynthtech') ? `新站 (${host})` : host.includes('flame.edu.kg') ? `老站 (${host})` : (host || '-');
			const bj = new Date(Date.now() + 8 * 3600 * 1000);
			const bjTime = bj.toISOString().slice(0, 19).replace('T', ' ') + ' (北京时间)';
			const text = t('adminLoginAlertTg', { email: userRow.email, site, time: bjTime, ip: curIp || '-', device: uaText || '-' });
			const ok = await telegramService.sendMessageToChat(c, chatId, text);
			if (!ok) {
				console.log('管理员登录提醒未发送：Telegram 发送失败或本站未配机器人 token');
			}
		} catch (e) {
			console.error('管理员登录提醒发送失败:', e.message);
		}
	},

	async logout(c, userId) {
		const token = await userContext.getToken(c);
		// KV 最终一致性：读不到时重试一次再放弃。
		const authInfo = await getAuthInfoWithRetry(c, userId, null, { attempts: 2, delayMs: 200 });
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
