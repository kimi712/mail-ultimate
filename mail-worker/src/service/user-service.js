import BizError from '../error/biz-error';
import accountService from './account-service';
import orm from '../entity/orm';
import user from '../entity/user';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { emailConst, isDel, roleConst, settingConst, userConst } from '../const/entity-const';
import kvConst from '../const/kv-const';
import KvConst from '../const/kv-const';
import cryptoUtils from '../utils/crypto-utils';
import emailService from './email-service';
import dayjs from 'dayjs';
import permService from './perm-service';
import roleService from './role-service';
import userContext from '../security/user-context';
import emailUtils from '../utils/email-utils';
import saltHashUtils from '../utils/crypto-utils';
import constant from '../const/constant';
import { t } from '../i18n/i18n'
import reqUtils from '../utils/req-utils';
import {oauth} from "../entity/oauth";
import loginLog from "../entity/login-log";
import userTotp from "../entity/user-totp";
import userPasskey from "../entity/user-passkey";
import userSecurity from "../entity/user-security";
import emailAlias from "../entity/email-alias";
import deadManSwitch from "../entity/dead-man-switch";
import oauthService from "./oauth-service";
import settingService from './setting-service';
import starService from './star-service';
import auditLogService from './audit-log-service';
import adminAuditService from './admin-audit-service';
import r2Service from './r2-service';

// CSV 字段转义：含逗号/双引号/换行时加双引号包裹，内部双引号翻倍。
function csvEscape(value) {
	const text = String(value);
	if (/[",\r\n]/.test(text)) {
		return '"' + text.replace(/"/g, '""') + '"';
	}
	return text;
}

const userService = {

	async loginUserInfo(c, userId) {

		const userRow = await userService.selectById(c, userId);

		if (!userRow) {
			throw new BizError(t('authExpired'), 401);
		}

		const account = await accountService.selectByEmailIncludeDel(c, userRow.email);

		// 诱饵会话（v3_16DB）：只给“普通用户”身份——发信量归零、无任何权限、
		// 角色用默认角色（不透露真实角色/管理员身份/真实发信量）。
		if (userContext.isDecoy(c)) {
			const defaultRole = await roleService.selectDefaultRole(c);
			return {
				userId: userRow.userId,
				sendCount: 0,
				email: userRow.email,
				account,
				name: account.name,
				permKeys: [],
				role: await this.clampRoleDayLimit(c, defaultRole),
				type: defaultRole?.roleId ?? userRow.type
			};
		}

		const [roleRow, permKeys] = await Promise.all([
			roleService.selectById(c, userRow.type),
			userRow.email === c.env.admin ? Promise.resolve(['*']) : permService.userPermKeys(c, userId)
		]);
		const clampedRole = await this.clampRoleDayLimit(c, roleRow);

		const user = {};
		user.userId = userRow.userId;
		user.sendCount = userRow.sendCount;
		user.email = userRow.email;
		user.account = account;
		user.name = account.name;
		user.permKeys = permKeys;
		user.role = clampedRole;
		user.type = userRow.type;

		if (c.env.admin === userRow.email) {
			user.role = constant.ADMIN_ROLE
			user.type = 0;
		}

		return user;
	},


	// 每邮箱每日上限（v3_19DB）：把 day 角色的 sendCount 钳到
	// min(角色额度, 设置 daySendLimit，默认 5)，供发件页“今日还剩 X 封”显示；
	// 读设置失败时返回原角色，不阻断登录。
	async clampRoleDayLimit(c, roleRow) {
		if (!roleRow || roleRow.sendType !== 'day' || !roleRow.sendCount) {
			return roleRow;
		}
		try {
			const setting = await settingService.query(c);
			return { ...roleRow, sendCount: roleService.effectiveDayLimit(roleRow, setting?.daySendLimit) };
		} catch (e) {
			return roleRow;
		}
	},

	async resetPassword(c, params, userId) {

		const { password } = params;

		if (password.length < 6) {
			throw new BizError(t('pwdMinLength'));
		}
		const { salt, hash } = await cryptoUtils.hashPassword(password);
		await orm(c).update(user).set({ password: hash, salt: salt }).where(eq(user.userId, userId)).run();
	},

	selectByEmail(c, email) {
		return orm(c).select().from(user).where(
			and(
				sql`${user.email} COLLATE NOCASE = ${email}`,
				eq(user.isDel, isDel.NORMAL)))
			.get();
	},

	async insert(c, params) {
		const { userId } = await orm(c).insert(user).values({ ...params }).returning().get();
		return userId;
	},

	selectByEmailIncludeDel(c, email) {
		return orm(c).select().from(user).where(sql`${user.email} COLLATE NOCASE = ${email}`).get();
	},

	selectByIdIncludeDel(c, userId) {
		return orm(c).select().from(user).where(eq(user.userId, userId)).get();
	},

	selectById(c, userId) {
		return orm(c).select().from(user).where(
			and(
				eq(user.userId, userId),
				eq(user.isDel, isDel.NORMAL)))
			.get();
	},

	async delete(c, userId) {
		const { syncDelete } = await settingService.query(c);
		if (syncDelete === settingConst.syncDelete.OPEN) {
			// physicsDelete 内已写 user:physics-delete 审计，不再重复记 user:delete。
			await this.physicsDelete(c, { userIds: String(userId) });
			await c.env.kv.delete(kvConst.AUTH_INFO + userId)
			return;
		}
		await orm(c).update(user).set({ isDel: isDel.DELETE }).where(eq(user.userId, userId)).run();
		await c.env.kv.delete(kvConst.AUTH_INFO + userId)
		await auditLogService.record(c, {
			action: 'user:delete',
			targetType: 'user',
			targetId: userId,
			detail: { isDel: isDel.DELETE }
		});
	},

	async physicsDelete(c, params) {
		let { userIds } = params;
		userIds = userIds.split(',').map(Number);
		// 先读出各用户当前壁纸（user 行删后就读不到了），供个人文件清理用。
		let wallpapers = {};
		try {
			const rows = await orm(c).select({ userId: user.userId, wallpaper: user.wallpaper })
				.from(user).where(inArray(user.userId, userIds)).all();
			for (const row of rows) wallpapers[row.userId] = row.wallpaper || '';
		} catch (e) {
			console.error('物理删除读取壁纸失败:', e.message);
		}
		await starService.removeByUserIds(c, userIds);
		await accountService.physicsDeleteByUserIds(c, userIds);
		await oauthService.deleteByUserIds(c, userIds);
		await orm(c).delete(user).where(inArray(user.userId, userIds)).run();
		// Phase 7：物理删除时一并清除该用户的个人安全数据，否则删号后
		// 登录历史/TOTP/Passkey/安全设置行仍以 user_id 孤儿形式留在库里。
		// audit_log / register_log 的行有意保留（管理员操作留痕与风控计数，
		// 且受 log_retention_days 定期清理约束），见 PHASE7-PRIVACY-AUDIT.md。
		try {
			for (const userId of userIds) {
				await orm(c).delete(loginLog).where(eq(loginLog.userId, userId)).run();
				await orm(c).delete(userTotp).where(eq(userTotp.userId, userId)).run();
				await orm(c).delete(userPasskey).where(eq(userPasskey.userId, userId)).run();
				await orm(c).delete(userSecurity).where(eq(userSecurity.userId, userId)).run();
				// 斯诺登第二批（v3_15DB）：死亡开关行随账号一起删（否则孤儿行残留）；
				// 同时补上上一批的已知缺口：一次性别名行也随账号删（否则别名地址仍被
				// 唯一索引占用，删号后无法再注册该别名）。
				await orm(c).delete(deadManSwitch).where(eq(deadManSwitch.userId, userId)).run();
				await orm(c).delete(emailAlias).where(eq(emailAlias.userId, userId)).run();
				await c.env.kv.delete(KvConst.SESSION_META + userId);
				// 个人文件（自定义壁纸）：最佳努力清理，失败不阻断删号。
				await this.removeUserFiles(c, userId, wallpapers[userId]);
			}
		} catch (e) {
			console.error('物理删除附加清理失败:', e.message);
		}
		await auditLogService.record(c, {
			action: 'user:physics-delete',
			targetType: 'user',
			targetId: String(params.userIds),
			detail: { userIds: params.userIds }
		});
	},

	// 删除某用户的个人文件：自定义壁纸（wallpapers/{userId}/...）。
	// R2/KV 按前缀列出全部删除；S3 无 list 接口，只删当前壁纸。最佳努力，
	// 任一环节失败只记日志，不抛错（删号本身不受影响）。
	async removeUserFiles(c, userId, wallpaperValue) {
		const prefix = `wallpapers/${userId}/`;
		const keys = new Set();
		if (typeof wallpaperValue === 'string' && wallpaperValue) {
			const key = wallpaperValue.replace(/^\/oss\//, '');
			if (key.startsWith(prefix)) keys.add(key);
		}
		try {
			const storageType = await r2Service.storageType(c);
			if (storageType === 'R2' && c.env.r2?.list) {
				let cursor;
				for (let page = 0; page < 5; page++) {
					const res = await c.env.r2.list({ prefix, cursor });
					for (const obj of res.objects || []) keys.add(obj.key);
					if (!res.truncated) break;
					cursor = res.cursor;
				}
			} else if (storageType === 'KV') {
				let cursor;
				for (let page = 0; page < 5; page++) {
					const res = await c.env.kv.list({ prefix, cursor });
					for (const k of res.keys || []) keys.add(k.name);
					if (res.list_complete) break;
					cursor = res.cursor;
				}
			}
		} catch (e) {
			console.error('列出用户个人文件失败:', e.message);
		}
		if (keys.size === 0) return;
		try {
			await r2Service.delete(c, [...keys]);
		} catch (e) {
			console.error('删除用户个人文件失败:', e.message);
		}
	},

	// 自助彻底删除：不看 setting.syncDelete，用户本人决定即物理删除。
	// 双重确认：密码（有密码的账号必须通过；无密码的 OAuth 账号跳过）+
	// 确认文字必须为 DELETE。管理员账号拒绝自助彻底删除。
	async hardDeleteSelf(c, userId, params = {}) {
		const { password = '', confirmText = '' } = params;
		const userRow = await this.selectByIdIncludeDel(c, userId);
		if (!userRow) {
			throw new BizError(t('authExpired'), 401);
		}
		if (c.env.admin && userRow.email
			&& String(userRow.email).toLowerCase() === String(c.env.admin).toLowerCase()) {
			throw new BizError(t('hardDeleteAdminBlocked'), 403);
		}
		if (confirmText !== 'DELETE') {
			throw new BizError(t('hardDeleteConfirmMismatch'), 400);
		}
		if (userRow.password) {
			if (!await cryptoUtils.verifyPassword(password, userRow.salt, userRow.password)) {
				throw new BizError(t('IncorrectPwd'), 400);
			}
		}
		// physicsDelete 内已写 user:physics-delete 审计（只记用户 id，不含内容），不再重复记。
		await this.physicsDelete(c, { userIds: String(userId) });
		await c.env.kv.delete(kvConst.AUTH_INFO + userId);
	},

	async list(c, params) {

		let { num, size, email, timeSort, status, createIp, createIpPrefix } = params;

		size = Number(size);
		num = Number(num);
		timeSort = Number(timeSort);
		params.isDel = Number(params.isDel);

		if (isNaN(size)) {
			size = 50;
		}

		if (isNaN(num)) {
			num = 1;
		}

		if (size > 50) {
			size = 50;
		}

		num = (num - 1) * size;

		const conditions = [];

		if (status > -1) {
			conditions.push(eq(user.status, status));
			conditions.push(eq(user.isDel, isDel.NORMAL));
		}


		if (email) {
			conditions.push(sql`${user.email} COLLATE NOCASE LIKE ${email + '%'}`);
		}

		// Phase 2 C 路：按注册 IP 筛选。createIp 精确匹配优先于 createIpPrefix
		// 前缀匹配，二者只取其一；前缀写法复用 email 的 COLLATE NOCASE LIKE。
		if (createIp) {
			conditions.push(eq(user.createIp, createIp));
		} else if (createIpPrefix) {
			conditions.push(sql`${user.createIp} COLLATE NOCASE LIKE ${createIpPrefix + '%'}`);
		}


		if (params.isDel) {
			conditions.push(eq(user.isDel, params.isDel));
		}


		const query = orm(c).select({
			...user,
			username: oauth.username,
			trustLevel: oauth.trustLevel,
			avatar: oauth.avatar,
			name: oauth.name,
			platform: oauth.platform
		}).from(user).leftJoin(oauth, eq(oauth.userId, user.userId))
			.where(and(...conditions));


		if (timeSort) {
			query.orderBy(asc(user.userId));
		} else {
			query.orderBy(desc(user.userId));
		}

		const list = await query.limit(size).offset(num);

		const { total } = await orm(c)
			.select({ total: count() })
			.from(user)
			.where(and(...conditions)).get();
		const userIds = list.map(user => user.userId);

		const types = [...new Set(list.map(user => user.type))];

		const [emailCounts, delEmailCounts, sendCounts, delSendCounts, accountCounts, delAccountCounts, roleList] = await Promise.all([
			emailService.selectUserEmailCountList(c, userIds, emailConst.type.RECEIVE),
			emailService.selectUserEmailCountList(c, userIds, emailConst.type.RECEIVE, isDel.DELETE),
			emailService.selectUserEmailCountList(c, userIds, emailConst.type.SEND),
			emailService.selectUserEmailCountList(c, userIds, emailConst.type.SEND, isDel.DELETE),
			accountService.selectUserAccountCountList(c, userIds),
			accountService.selectUserAccountCountList(c, userIds, isDel.DELETE),
			roleService.selectByIdsHasPermKey(c, types,'email:send')
		]);

		const receiveMap = Object.fromEntries(emailCounts.map(item => [item.userId, item.count]));
		const sendMap = Object.fromEntries(sendCounts.map(item => [item.userId, item.count]));
		const accountMap = Object.fromEntries(accountCounts.map(item => [item.userId, item.count]));

		const delReceiveMap = Object.fromEntries(delEmailCounts.map(item => [item.userId, item.count]));
		const delSendMap = Object.fromEntries(delSendCounts.map(item => [item.userId, item.count]));
		const delAccountMap = Object.fromEntries(delAccountCounts.map(item => [item.userId, item.count]));

		for (const user of list) {

			// 绑定码是 10 分钟有效的活凭证，不进管理列表返回（只留 tgChatId 供展示绑定状态）。
			delete user.tgBindCode;
			delete user.tgBindExpires;

			const userId = user.userId;

			user.receiveEmailCount = receiveMap[userId] || 0;
			user.sendEmailCount = sendMap[userId] || 0;
			user.accountCount = accountMap[userId] || 0;

			user.delReceiveEmailCount = delReceiveMap[userId] || 0;
			user.delSendEmailCount = delSendMap[userId] || 0;
			user.delAccountCount = delAccountMap[userId] || 0;

			const roleIndex = roleList.findIndex(roleRow => user.type === roleRow.roleId);
			let sendAction = {};

			if (roleIndex > -1) {
				sendAction.sendType = roleList[roleIndex].sendType;
				sendAction.sendCount = roleList[roleIndex].sendCount;
				sendAction.hasPerm = true;
			} else {
				sendAction.hasPerm = false;
			}

			if (user.email === c.env.admin) {
				sendAction.sendType = constant.ADMIN_ROLE.sendType;
				sendAction.sendCount = constant.ADMIN_ROLE.sendCount;
				sendAction.hasPerm = true;
				user.type = 0
			}

			user.sendAction = sendAction;
		}

		return { list, total };
	},

	// Phase 2 C 路：按注册 IP 聚合（风控：同一 IP 注册多个账号）。
	// 只统计未删除且 create_ip 非空的用户；min 为最少注册数，默认 2。
	async groupByIp(c, { min = 2 } = {}) {
		min = Number(min);
		if (isNaN(min) || min < 1) {
			min = 2;
		}
		const { results } = await c.env.db.prepare(
			`SELECT create_ip, COUNT(*) AS total FROM user WHERE is_del = 0 AND create_ip != '' GROUP BY create_ip HAVING total >= ? ORDER BY total DESC LIMIT 100`
		).bind(min).all();
		return results;
	},

	// Phase 2 C 路：导出用户 CSV（列固定：userId, email, createIp, activeIp,
	// status, type, createTime）。复用 list() 的筛选参数，分页循环拉全量；
	// 总行数超过 5000 时拒绝并提示缩小筛选，避免一次性导出拖垮 D1。
	async exportCsv(c, params) {
		const first = await this.list(c, { ...params, num: 1, size: 50 });
		if (first.total > 5000) {
			throw new BizError(t('exportTooManyRows'), 400);
		}
		const rows = [...first.list];
		const pages = Math.ceil(first.total / 50);
		for (let num = 2; num <= pages; num++) {
			const page = await this.list(c, { ...params, num, size: 50 });
			rows.push(...page.list);
		}
		const header = ['userId', 'email', 'createIp', 'activeIp', 'status', 'type', 'createTime'];
		const lines = [header.join(',')];
		for (const row of rows) {
			const values = [
				row.userId ?? '',
				row.email ?? '',
				row.createIp ?? '',
				row.activeIp ?? '',
				row.status ?? '',
				row.type ?? '',
				row.createTime ?? ''
			];
			lines.push(values.map(csvEscape).join(','));
		}
		return lines.join('\r\n');
	},

	async updateUserInfo(c, userId, recordCreateIp = false) {



		const activeIp = reqUtils.getIp(c);

		const {os, browser, device} = reqUtils.getUserAgent(c);

		const params = {
			os,
			browser,
			device,
			activeIp,
			activeTime: dayjs().format('YYYY-MM-DD HH:mm:ss')
		};

		if (recordCreateIp) {
			params.createIp = activeIp;
		}

		await orm(c)
			.update(user)
			.set(params)
			.where(eq(user.userId, userId))
			.run();
	},

	async setPwd(c, params) {

		const { password, userId } = params;
		await this.resetPassword(c, { password }, userId);
		await c.env.kv.delete(KvConst.AUTH_INFO + userId);
		await adminAuditService.recordAdminAction(c, {
			actorUserId: userContext.getUserId(c), action: 'user:set-password',
			targetId: String(userId), detail: {},
		});
	},

	async setStatus(c, params) {

		const { status, userId } = params;

		await orm(c)
			.update(user)
			.set({ status })
			.where(eq(user.userId, userId))
			.run();

		if (status === userConst.status.BAN) {
			await c.env.kv.delete(KvConst.AUTH_INFO + userId);
		}
		await auditLogService.record(c, {
			action: 'user:set-status',
			targetType: 'user',
			targetId: userId,
			detail: { status }
		});
	},

	async setType(c, params) {

		const { type, userId } = params;

		const roleRow = await roleService.selectById(c, type);

		if (!roleRow) {
			throw new BizError(t('roleNotExist'));
		}

		await orm(c)
			.update(user)
			.set({ type })
			.where(eq(user.userId, userId))
			.run();

		await adminAuditService.recordAdminAction(c, {
			actorUserId: userContext.getUserId(c), action: 'user:set-type',
			targetId: String(userId), detail: { roleId: type },
		});
	},

	async incrUserSendCount(c, quantity, userId) {
		await orm(c).update(user).set({
			sendCount: sql`${user.sendCount}
	  +
	  ${quantity}`
		}).where(eq(user.userId, userId)).run();
	},

	async updateAllUserType(c, type, curType) {
		await orm(c)
			.update(user)
			.set({ type })
			.where(eq(user.type, curType))
			.run();
	},

	async add(c, params) {

		let { email, type, password } = params;

		if (!c.env.domain.includes(emailUtils.getDomain(email))) {
			throw new BizError(t('notEmailDomain'));
		}

		if (password.length < 6) {
			throw new BizError(t('pwdMinLength'));
		}

		const accountRow = await accountService.selectByEmailIncludeDel(c, email);

		if (accountRow && accountRow.isDel === isDel.DELETE) {
			throw new BizError(t('isDelUser'));
		}

		if (accountRow) {
			throw new BizError(t('isRegAccount'));
		}

		let role;
		if (type === undefined) {
			role = await roleService.selectDefaultRole(c);
			type = role?.roleId;
		} else {
			role = await roleService.selectById(c, type);
		}

		if (!role) {
			throw new BizError(t('roleNotExist'));
		}

		const { salt, hash } = await saltHashUtils.hashPassword(password);

		const userId = await userService.insert(c, { email, password: hash, salt, type });

		await userService.updateUserInfo(c, userId, true);

		await accountService.insert(c, { userId: userId, email, type, name: emailUtils.getName(email) });
	},

	async resetDaySendCount(c) {
		// 仅 UTC 0 点执行，便于配合每小时 cron
		if (new Date().getUTCHours() !== 0) {
			return;
		}
		const roleList = await roleService.selectByIdsAndSendType(c, 'email:send', roleConst.sendType.DAY);
		const roleIds = roleList.map(action => action.roleId);
		await orm(c).update(user).set({ sendCount: 0 }).where(inArray(user.type, roleIds)).run();
	},

	async resetSendCount(c, params) {
		await orm(c).update(user).set({ sendCount: 0 }).where(eq(user.userId, params.userId)).run();
	},

	// 管理员给指定用户解绑 Telegram（清掉 tg_chat_id 与未用的绑定码）。
	async unbindTelegram(c, params) {
		const { userId } = params;
		if (!userId) {
			throw new BizError('缺少用户', 400);
		}
		await orm(c).update(user).set({ tgChatId: '', tgBindCode: '', tgBindExpires: '' })
			.where(eq(user.userId, userId)).run();
		await auditLogService.record(c, {
			action: 'user:unbind-telegram',
			targetType: 'user',
			targetId: userId,
			detail: {}
		});
	},

	async restore(c, params) {
		const { userId, type } = params
		await orm(c)
			.update(user)
			.set({ isDel: isDel.NORMAL })
			.where(eq(user.userId, userId))
			.run();
		const userRow = await this.selectById(c, userId);
		await accountService.restoreByEmail(c, userRow.email);

		if (type) {
			await emailService.restoreByUserId(c, userId);
			await accountService.restoreByUserId(c, userId);
		}

		await auditLogService.record(c, {
			action: 'user:restore',
			targetType: 'user',
			targetId: userId,
			detail: { type: type || 0 }
		});
	},

	listByRegKeyId(c, regKeyId) {
		return orm(c)
			.select({email: user.email,createTime: user.createTime})
			.from(user)
			.where(eq(user.regKeyId, regKeyId))
			.orderBy(desc(user.userId))
			.all();
	}
};

export default userService;
