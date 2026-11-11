import orm from '../entity/orm';
import email from '../entity/email';
import { emailListColumns, emailBriefColumns, EMAIL_LIST_TEXT_LEN } from '../lib/email-list-columns';
import { attConst, emailConst, isDel, settingConst } from '../const/entity-const';
import { and, desc, eq, gt, inArray, notInArray, lt, count, asc, sql, ne, or, like, lte, gte } from 'drizzle-orm';
import { star } from '../entity/star';
import settingService from './setting-service';
import accountService from './account-service';
import BizError from '../error/biz-error';
import emailUtils from '../utils/email-utils';
import fileUtils from '../utils/file-utils';
import { Resend } from 'resend';
import attService from './att-service';
import { parseHTML } from 'linkedom';
import userService from './user-service';
import roleService from './role-service';
import user from '../entity/user';
import starService from './star-service';
import dayjs from 'dayjs';
import kvConst from '../const/kv-const';
import { t } from '../i18n/i18n'
import domainUtils from '../utils/domain-uitls';
import account from "../entity/account";
import { att } from '../entity/att';
import quotaService from './quota-service';
import telegramService from './telegram-service';
import webhookService from './webhook-service';
import forwardMime from '../utils/forward-mime';
import userSecurityService from './user-security-service';
import mailRuleService from './mail-rule-service';
import mailTrustService, { UNDO_DELAYS, DEFAULT_UNDO_SECONDS, MAX_SCHEDULE_DAYS, parseAuthResults, parseListUnsubscribe } from './mail-trust-service';
import aliasService from './alias-service';
import timelockService from './timelock-service';
import blindIndexService from './blind-index-service';
import decoyService from './decoy-service';
import userContext from '../security/user-context';
// 斯诺登第四批：阅后即焚策略（burn 强制 E2EE）与自动过期别名。
import burnAfterReadingService from './burn-after-reading-service';
import aliasExpiryService from './alias-expiry-service';

// 邮件混淆（v3_16DB）：站内投递随机延迟 15–180 秒 + 随机逻辑中继 R1–R5。
// 内置默认开启，无开关。延迟期间收件箱列表/最新邮件/未读计数均不可见；
// 转发（TG/ webhook/邮箱转发）与邮件规则在生效后由 cron 补跑，绝不提前泄露。
const MIX_DELAY_MIN_MS = 15 * 1000;
const MIX_DELAY_MAX_MS = 180 * 1000;
const MIX_RELAY_COUNT = 5;

// 自毁邮件有效期选项（前端写信页下拉值 → 后端在发信时刻算 expireAt，不信任客户端时间）。
// burn：阅后即焚（不设 expireAt，打开一次即删）；其余为相对时长。
const EXPIRE_OPTIONS = {
	none: null,
	burn: 'burn',
	'1h': 60 * 60 * 1000,
	'1d': 24 * 60 * 60 * 1000,
	'7d': 7 * 24 * 60 * 60 * 1000,
	'30d': 30 * 24 * 60 * 60 * 1000
};

function randomGroupId() {
	const bytes = new Uint8Array(12);
	crypto.getRandomValues(bytes);
	return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

const emailService = {

	async list(c, params, userId) {

		// 诱饵会话（v3_16DB）：收件箱只读诱饵邮件（负数 emailId），与真实数据完全隔离。
		// 只处理收件箱视图（type=0）；已发送/其他视图返回空列表（诱饵没有发件记录）。
		if (userContext.isDecoy(c)) {
			const type = Number(params.type);
			// 诱饵会话没有回收站：trash 视图返回空。
			if (Number(params.trash) === 1 || type !== emailConst.type.RECEIVE) {
				return { list: [], total: 0, latestEmail: { emailId: 0, accountId: Number(params.accountId) || 0, userId } };
			}
			const rows = await decoyService.listDecoyMail(c, userId, { size: params.size });
			return { list: rows, total: rows.length, latestEmail: rows[0] ? { emailId: rows[0].emailId, accountId: Number(params.accountId) || 0, userId } : { emailId: 0, accountId: Number(params.accountId) || 0, userId } };
		}

		// 时间锁懒释放（v3_16DB）：先把本用户已到期的密钥写回，再查列表——
		// 到期的信在本次列表里就是可读状态。转发/规则补跑由 cron 每小时做，不在这里做。
		try {
			await timelockService.releaseDueForUser(c, userId);
		} catch (e) { /* best-effort */ }

		let {
			emailId,
			type,
			accountId,
			size,
			timeSort,
			allReceive,
			full,
			text,
			searchType,
			startDate,
			endDate,
			spam,
			trash,
		} = params;

		size = Number(size);
		type = Number(type);
		emailId = Number(emailId) || 0;
		timeSort = Number(timeSort);
		accountId = Number(accountId);
		allReceive = Number(allReceive);
		full = Number(full);

		if (isNaN(type)) {
			type = 0;
		}

		if (isNaN(accountId)) {
			throw new BizError(t('emptyAccountId'));
		}

		if (isNaN(size)) {
			size = 10;
		}

		if (isNaN(full)) {
			full = 1;
		}

		full = full === 1;

		if (size > 50) {
			size = 50;
		}

		if (isNaN(allReceive)) {
			let accountRow = await accountService.selectById(c, accountId);
			allReceive = accountRow.allReceive;
		}

		// Phase 8 E：spam=1 只列 Spam；默认（spam 缺省/0）只列非 Spam——标记
		// 为垃圾邮件的信即离开收件箱。只认数字 1 为 Spam 视图。
		// is_spam 列由 v3_11DB 加（实体故意不含该列，见 mail-trust-service
		// 注释）；列不存在时探测失败，不加过滤条件、不崩既有流程。
		// 回收站：trash=1 只列已删（is_del=1）的信；回收站不分垃圾/非垃圾，
		// spam 过滤跳过（已删的垃圾邮件也在回收站里）。
		spam = Number(spam) === 1 ? 1 : 0;
		trash = Number(trash) === 1 ? 1 : 0;
		const hasTrustCols = await mailTrustService.hasEmailTrustColumns(c);
		const spamSql = (!trash && hasTrustCols) ? sql`email.is_spam = ${spam ? 1 : 0}` : null;

		const filters = this.emailListFilters({
			userId,
			accountId,
			type,
			allReceive,
			emailId,
			timeSort,
			text,
			searchType,
			startDate,
			endDate,
			spamSql,
			trash,
		});
		const countFilters = this.emailListFilters({
			userId,
			accountId,
			type,
			allReceive,
			withCursor: false,
			text,
			searchType,
			startDate,
			endDate,
			spamSql,
			trash,
		});
		const columns = full ? emailListColumns : emailBriefColumns;

		const query = orm(c)
			.select({
				...columns,
				starId: star.starId
			})
			.from(email)
			.leftJoin(
				star,
				and(
					eq(star.emailId, email.emailId),
					eq(star.userId, userId)
				)
			)
			.innerJoin(
				account,
				eq(account.accountId, email.accountId)
			)
			.where(and(...filters));

		if (timeSort) {
			query.orderBy(asc(email.emailId));
		} else {
			query.orderBy(desc(email.emailId));
		}

		const listQuery = query.limit(size).all();

		const totalQuery = orm(c).select({ total: count() }).from(email)
			.innerJoin(
				account,
				eq(account.accountId, email.accountId)
			)
			.where(and(...countFilters))
			.get();

		const latestEmailQuery = orm(c).select({
			emailId: email.emailId,
			accountId: email.accountId,
			userId: email.userId,
		}).from(email).where(
			and(
				eq(email.userId, userId),
				eq(email.type, type),
				eq(email.isDel, isDel.NORMAL),
				// 邮件混淆（v3_16DB）：收件箱的最新邮件不含未生效的混淆信。
				type === emailConst.type.RECEIVE ? sql`(${email.mixDeliverAt} = '' OR ${email.mixDeliverAt} <= datetime('now'))` : undefined,
				allReceive ? undefined : eq(email.accountId, accountId)
			))
			.orderBy(desc(email.emailId)).limit(1).get();

		let [list, totalRow, latestEmail] = await Promise.all([listQuery, totalQuery, latestEmailQuery]);

		list = list.map(item => ({
			...item,
			isStar: item.starId != null ? 1 : 0
		}));

		// 自毁邮件：已过期的信在服务端剥离内容与摘要，只留元数据并打 expired=1，
		// 前端据此显示“此邮件已自毁”；真正删除由 cron sweepExpired 兜底（每小时）。
		// 注意：这里只剥离不删除——列表里留一个墓碑，打开时才能看到“已自毁”而不是凭空消失。
		const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
		for (const item of list) {
			if (item.expireAt && item.expireAt <= nowStr) {
				item.expired = 1;
				item.content = '';
				item.text = '';
			}
		}

		if (full) {
			await this.emailAddAtt(c, list);
		} else {
			this.applyListText(list);
		}
		// 过期信不给附件清单（附件随信一起自毁）。
		for (const item of list) {
			if (item.expired === 1) {
				item.attList = [];
			}
		}

		// Phase 8 E：服务端清洗（远程图片拦截 + 验证标识 + 退订信息挂载）。
		// full 模式清洗 content；brief 模式只挂元数据（不碰截断后的 content）。
		await mailTrustService.applyServerSanitize(c, userId, list, { full });

		if (!latestEmail) {
			latestEmail = {
				emailId: 0,
				accountId: accountId,
				userId: userId,
			}
		}

		return { list, total: totalRow.total, latestEmail };
	},

	toListText(item) {
		const raw = emailUtils.formatText(item.text) || emailUtils.htmlToText(item.content);
		return raw.replace(/\s+/g, ' ').trim().slice(0, EMAIL_LIST_TEXT_LEN);
	},

	applyListText(list) {
		for (const item of list) {
			item.listText = this.toListText(item);
			delete item.text;
			delete item.content;
		}
		return list;
	},

	emailListFilters({
		userId,
		accountId,
		type,
		allReceive,
		emailId,
		timeSort,
		withCursor = true,
		text,
		searchType,
		startDate,
		endDate,
		spamSql = null,
		trash = false,
	}) {
		const conditions = [
			eq(email.userId, userId),
			eq(email.type, type),
			// 回收站视图只列已删的信，其余视图只列未删的信。
			eq(email.isDel, trash ? isDel.DELETE : isDel.NORMAL),
			eq(account.isDel, isDel.NORMAL),
		];
		// 邮件混淆（v3_16DB）：收件箱只列已生效的信——混淆延迟未到的信在列表、
		// 计数、最新邮件里一律不可见（发件人已发送视图不受影响）。
		if (type === emailConst.type.RECEIVE) {
			conditions.push(sql`(${email.mixDeliverAt} = '' OR ${email.mixDeliverAt} <= datetime('now'))`);
		}
		// Phase 8 E：Spam 隔离（raw sql 片段，实体不含 is_spam 列；
		// 列未合并时 spamSql 为 null，不过滤）。
		if (spamSql) {
			conditions.push(spamSql);
		}
		if (!allReceive) {
			conditions.push(eq(email.accountId, accountId));
		}
		if (withCursor && emailId) {
			conditions.push(timeSort ? gt(email.emailId, emailId) : lt(email.emailId, emailId));
		}

		if (text?.trim() && searchType) {
			const searchText = `%${text.trim()}%`;

			if (searchType === 'subject') {
				conditions.push(sql`${email.subject} COLLATE NOCASE LIKE ${searchText}`);
			}

			if (searchType === 'content') {
				conditions.push(
					or(
						sql`${email.text} COLLATE NOCASE LIKE ${searchText}`,
						sql`${email.content} COLLATE NOCASE LIKE ${searchText}`,
					)
				);
			}

			if (searchType === 'sender') {
				conditions.push(sql`${email.name} COLLATE NOCASE LIKE ${searchText}`);
			}

			if (searchType === 'senderAddress') {
				conditions.push(sql`${email.sendEmail} COLLATE NOCASE LIKE ${searchText}`);
			}

			if (searchType === 'recipientAddress') {
				conditions.push(sql`${email.toEmail} COLLATE NOCASE LIKE ${searchText}`);
			}
		}

		if (startDate) {
			conditions.push(gte(email.createTime, startDate));
		}

		if (endDate) {
			conditions.push(lte(email.createTime, endDate));
		}

		return conditions;
	},

	allEmailListFilters({ emailId, name, subject, accountEmail, userEmail, type, timeSort, withCursor = true }) {
		const conditions = [];

		if (type === 'send') {
			conditions.push(eq(email.type, emailConst.type.SEND));
		}

		if (type === 'receive') {
			conditions.push(eq(email.type, emailConst.type.RECEIVE));
		}

		if (type === 'delete') {
			conditions.push(eq(email.isDel, isDel.DELETE));
		}

		if (type === 'noone') {
			conditions.push(eq(email.status, emailConst.status.NOONE));
		}

		if (userEmail) {
			conditions.push(sql`${user.email} COLLATE NOCASE LIKE ${userEmail + '%'}`);
		}

		if (accountEmail) {
			conditions.push(
				or(
					sql`${email.toEmail} COLLATE NOCASE LIKE ${accountEmail + '%'}`,
					sql`${email.sendEmail} COLLATE NOCASE LIKE ${accountEmail + '%'}`,
				)
			);
		}

		if (name) {
			conditions.push(sql`${email.name} COLLATE NOCASE LIKE ${name + '%'}`);
		}

		if (subject) {
			conditions.push(sql`${email.subject} COLLATE NOCASE LIKE ${subject + '%'}`);
		}

		if (withCursor && emailId) {
			conditions.push(timeSort ? gt(email.emailId, emailId) : lt(email.emailId, emailId));
		}

		return conditions;
	},

	async delete(c, params, userId) {
		const { emailIds } = params;
		const emailIdList = emailIds.split(',').map(Number);
		// 诱饵会话（v3_16DB）：只删诱饵邮件（负数 id），不动真实邮件。
		if (userContext.isDecoy(c)) {
			const decoyIds = emailIdList.filter(id => id < 0);
			if (decoyIds.length) {
				await decoyService.deleteDecoyMail(c, userId, decoyIds);
			}
			return;
		}
		const { syncDelete } = await settingService.query(c);

		if (syncDelete === settingConst.syncDelete.OPEN) {
			const owned = await orm(c).select({ emailId: email.emailId }).from(email)
				.where(and(eq(email.userId, userId), inArray(email.emailId, emailIdList)))
				.all();
			const ownedIds = owned.map(row => row.emailId);
			if (ownedIds.length) {
				await this.physicsDelete(c, { emailIds: ownedIds.join(',') });
			}
			return;
		}

		await orm(c).update(email).set({ isDel: isDel.DELETE }).where(
			and(
				eq(email.userId, userId),
				inArray(email.emailId, emailIdList)))
			.run();
	},

	// 回收站恢复：把已删邮件移回收件箱（is_del 改回 0），只动自己的信。
	// 诱饵会话没有回收站，直接返回。
	async restore(c, params, userId) {
		if (userContext.isDecoy(c)) {
			return;
		}
		const { emailIds } = params;
		const emailIdList = String(emailIds || '').split(',').map(Number).filter(Boolean);
		if (!emailIdList.length) {
			return;
		}
		await orm(c).update(email).set({ isDel: isDel.NORMAL }).where(
			and(
				eq(email.userId, userId),
				eq(email.isDel, isDel.DELETE),
				inArray(email.emailId, emailIdList))
		).run();
	},

	// 回收站彻底删除：只删已在回收站里（is_del=1）且属于自己的信；
	// 先验归属，再走物理删除（清附件/星标/盲索引），防 inbox 越权直删。
	async deletePhysics(c, params, userId) {
		if (userContext.isDecoy(c)) {
			return;
		}
		const { emailIds } = params;
		const emailIdList = String(emailIds || '').split(',').map(Number).filter(Boolean);
		if (!emailIdList.length) {
			return;
		}
		const owned = await orm(c).select({ emailId: email.emailId }).from(email)
			.where(and(
				eq(email.userId, userId),
				eq(email.isDel, isDel.DELETE),
				inArray(email.emailId, emailIdList)
			)).all();
		const ownedIds = owned.map(row => row.emailId);
		if (ownedIds.length) {
			await this.physicsDelete(c, { emailIds: ownedIds.join(',') });
		}
	},

	// Phase 8 E：收信时把认证头与退订头解析结果一并入库（email.js 挂载点：
	// receive 前把 PostalMime 的 email.headerLines 传进 params.headers；
	// 无 headers 时不写 = 未验证，绝不编造）。新列由 v3_11DB 加；列不
	// 存在时 UPDATE 失败静默跳过（不阻断收信），合并 DDL 后即入库。
	// 本方法改为 async（原同步返回 drizzle 结果；email.js 本就 await 它）。
	async receive(c, params, cidAttList, r2domain) {
		const { headers, ...rest } = params;
		rest.content = this.imgReplace(rest.content, cidAttList, r2domain)
		const row = await orm(c).insert(email).values({ ...rest }).returning().get();
		if (headers) {
			try {
				await this.storeAuthResults(c, row.emailId, headers);
			} catch (e) {
				console.error('收信写认证结果失败:', e.message);
			}
		}
		// Phase 8 F：站外收信落库后跑一次用户邮件规则（只对新信；无收件人时跳过）。
		await this._applyMailRules(c, row);
		return row;
	},

	// Phase 8 E：给已入库邮件补写认证/退订结果（email.js 挂载点备选：receive
	// 之后调一次本方法；与 receive() 内解析同一份逻辑，不重复造轮子）。
	// raw SQL 写新列；列不存在时不抛错（返回解析结果供调用方内存里用）。
	async storeAuthResults(c, emailId, headers) {
		// 注意：parseAuthResults / parseListUnsubscribe 是命名导出，不在
		// mailTrustService 默认对象上（此前误写成对象方法，undefined 被
		// try/catch 静默吞掉，导致认证列一直写不进去——已修）。
		const auth = parseAuthResults(headers);
		const unsub = parseListUnsubscribe(headers);
		try {
			await c.env.db.prepare(
				`UPDATE email SET auth_spf = ?, auth_dkim = ?, auth_dmarc = ?,
					unsubscribe_url = ?, unsubscribe_mailto = ?, unsubscribe_one_click = ?
				 WHERE email_id = ?`
			).bind(
				auth.spf === 'none' ? '' : auth.spf,
				auth.dkim === 'none' ? '' : auth.dkim,
				auth.dmarc === 'none' ? '' : auth.dmarc,
				unsub?.url || '', unsub?.mailto || '', unsub?.oneClick ? 1 : 0,
				Number(emailId)
			).run();
		} catch (e) {
			console.error('写认证/退订结果失败（列可能未合并）:', e.message);
		}
		return { ...auth, unsubscribe: unsub };
	},

	// Phase 8 E：发送入口分流（原发送体见 executeSend，行为不变）。
	// 机制说明（写进文案与汇报，不假装“发出去再追回”）：
	// - scheduledAt 为未来时间 → 只入库 scheduled_email，到点才真正发；
	// - undoSeconds ∈ {5,10,30} → 只入库 pending_send，窗口内未确认
	//   不发任何东西；窗口结束后由前端倒计时确认（主路径）或 cron 兜底
	//   扫表（processDuePending）触发 executeSend；窗口内取消即作废，
	//   内容原样退回草稿；
	// - 两参数都不带 → 立即发送（老调用方与既有测试行为不变）。
	async send(c, params, userId) {
		// 诱饵会话（v3_16DB）：不可发信。返回“发送功能已停用”（与普通停用
		// 同文案），绝不暴露“诱饵”身份。
		if (userContext.isDecoy(c)) {
			throw new BizError(t('disabledSend'), 403);
		}
		if (params.scheduledAt) {
			return this.scheduleSend(c, params, userId, params.scheduledAt);
		}
		if (params.undoSeconds !== undefined && params.undoSeconds !== null) {
			const n = Number(params.undoSeconds);
			if (!Number.isFinite(n) || n < 0) {
				throw new BizError('trust_invalid_undo_delay', 'trust_invalid_undo_delay');
			}
			// undoSeconds=0 = 明确要求立即发送（写信页“立即发送”旁路）。
			if (n > 0) {
				return this.createPendingSend(c, params, userId, n);
			}
		}
		return this.executeSend(c, params, userId);
	},

	// 邮件混淆（v3_16DB）：站内信随机延迟 15–180 秒 + 随机逻辑中继 R1–R5。
	// 返回 {deliverAt: 'YYYY-MM-DD HH:mm:ss' UTC, relay: 'R1'..'R5'}。
	// 仅站内收件人生效；发件人自己的已发送副本不延迟（发件人看得到自己发的信）。
	resolveMix() {
		const delay = MIX_DELAY_MIN_MS + Math.floor(Math.random() * (MIX_DELAY_MAX_MS - MIX_DELAY_MIN_MS));
		return {
			deliverAt: this._pendingNowIso(Date.now() + delay),
			relay: 'R' + (1 + Math.floor(Math.random() * MIX_RELAY_COUNT))
		};
	},

	// 混淆/时间锁到期后的补跑（cron 每小时 + 懒释放后复用同一入口）：
	// 对已生效的收件行补跑转发（TG/ webhook/邮箱转发）与邮件规则，再把
	// mix_notified 置 1。emailIds 为 email 表行 id（正数）。
	async processReleasedMail(c, emailIds) {
		const ids = (Array.isArray(emailIds) ? emailIds : [emailIds]).map(Number).filter(Boolean);
		if (!ids.length) return 0;
		let n = 0;
		for (const id of ids) {
			try {
				const row = await orm(c).select().from(email).where(eq(email.emailId, id)).get();
				if (!row || Number(row.type) !== emailConst.type.RECEIVE) continue;
				const atts = await attService.selectByEmailIds(c, [id]).catch(() => []);
				await this.forwardOnSiteEmail(c, [row], { sendParams: {
					receiveEmail: [row.toEmail], attachments: atts || []
				} });
				await this._applyMailRules(c, row);
				await orm(c).update(email).set({ mixNotified: 1 })
					.where(eq(email.emailId, id)).run();
				n++;
			} catch (e) {
				console.error('到期投递补跑失败:', id, e.message);
			}
		}
		return n;
	},

	// cron 每小时：① 释放全站已到期的时间锁密钥；② 找出混淆已生效但尚未
	// 补跑转发/规则的收件行；③ 一并补跑。返回处理数（best-effort，永不抛错）。
	async processDueDeliveries(c) {
		try {
			const released = await timelockService.releaseDueAll(c);
			let dueMix = [];
			try {
				const now = this._pendingNowIso(Date.now());
				const rows = await orm(c).select({ emailId: email.emailId }).from(email).where(and(
					eq(email.type, emailConst.type.RECEIVE),
					eq(email.mixNotified, 0),
					sql`${email.mixDeliverAt} != ''`,
					lte(email.mixDeliverAt, now)
				)).all();
				dueMix = rows.map(r => Number(r.emailId));
			} catch (e) {
				dueMix = [];
			}
			const ids = [...new Set([...(released || []), ...dueMix])];
			if (!ids.length) return 0;
			return await this.processReleasedMail(c, ids);
		} catch (e) {
			console.error('到期投递扫表失败:', e.message);
			return 0;
		}
	},

	// 自毁邮件：按写信页的 expireOption 在发信时刻算出 expireAt / burnAfterRead / expireGroup。
	// expireAt 用服务端时钟（'YYYY-MM-DD HH:mm:ss' UTC，与 createTime 同格式，字典序即时间序）；
	// burn 不设 expireAt，只给组标识；none/非法值全部按不过期处理。组标识让收发两端同组，
	// 阅后即焚时按组一起删（收件人 + 发件人已发送）。
	resolveExpiry(expireOption) {
		const empty = { expireAt: '', burnAfterRead: 0, expireGroup: '' };
		if (!expireOption || expireOption === 'none') {
			return empty;
		}
		if (expireOption === 'burn') {
			return { expireAt: '', burnAfterRead: 1, expireGroup: randomGroupId() };
		}
		const duration = EXPIRE_OPTIONS[expireOption];
		if (!duration) {
			return empty;
		}
		return {
			expireAt: this._pendingNowIso(Date.now() + duration),
			burnAfterRead: 0,
			expireGroup: randomGroupId()
		};
	},

	// 发送入口：公共校验、参数准备、渠道选择和结果汇总。
	async executeSend(c, params, userId, opts = {}) {
		// 死亡开关等系统代发：opts.systemSend=true 时跳过角色发信限制（禁用/仅站内/
		// 日限额）。systemSend 只能由服务端 service 经第 4 个参数传入，绝不从 params
		// （请求体）读——前端传 systemSend 无效，防绕过角色限制。
		const systemSend = opts.systemSend === true;
		let {
			accountId, //发送账号id
			name, //发件人名字
			sendType, //发件类型
			emailId, //邮件id，如果是回复邮件会带
			receiveEmail, //收件人邮箱
			text, //邮件纯文本
			content, //邮件内容
			subject, //邮件标题
			e2ee, // Phase 6：端到端加密标记（0/1），客户端加密后传 1，存 email.e2ee 列
			// 斯诺登第二批（v3_15DB）：发件人隐身 + 前向保密/抗量子（仅 E2EE 站内信有效）。
			// sealedSender：密封发件人信封 `sealed:v1:<base64(iv||ct)>`（CEK 加密的发件人 JSON）；
			// cekWraps：按收件人包裹的一次性密钥 [{to, alg, wrapped}]，alg ∈ {'sym','mlkem768'}；
			// e2eeVer：正文信封版本（1=旧版直接用 KEK 加密，2=正文用 CEK 加密）。
			sealedSender, cekWraps, e2eeVer,
			// 斯诺登第三批（v3_16DB，仅 E2EE 站内信有效）：
			// timelockUntil：时间锁解锁时刻（前端传 'YYYY-MM-DD HH:mm:ss' UTC 或时间戳，
			//   后端校验为未来时刻才生效，否则按不锁处理）；
			// deniable：可否认认证标记（0/1）；denyTag：CEK 对密文的 HMAC 标签；
			// blindTokens：盲索引 token 数组（前端用 KEK 对关键词做 HMAC，服务端只存 token）。
			timelockUntil, deniable, denyTag, blindTokens,
			attachments = [] //附件
		} = params;

		// 速度优化：前置的几组查询互不依赖，并行跑（原来是 5 次串行 D1/KV 往返）。
		// 第 1 批：设置 + 正文图片处理（图片处理内部自己再读一次设置，不依赖外层结果）。
		const [{ resendTokens, r2Domain, send, domainList }, { imageDataList, html }] = await Promise.all([
			settingService.query(c),
			attService.toImageUrlHtml(c, content)
		]);

		//判断是否关闭发件功能
		if (send === settingConst.send.CLOSE) {
			throw new BizError(t('disabledSend'), 403);
		}

		// 第 2 批：用户、发件账号互不依赖，并行查；回复原邮件也提前发起查询，
		// 但“原邮件不存在”的错误仍在原位置（账号校验之后）抛，保持报错顺序不变。
		const replyEmailPromise = sendType === 'reply' ? this.selectOwnById(c, emailId, userId) : Promise.resolve(null);
		const [userRow, accountRow] = await Promise.all([
			userService.selectById(c, userId),
			accountService.selectById(c, accountId)
		]);

		//判断接收方是不是全部为站内邮箱
		const allInternal = receiveEmail.every(email => {
			const domain = '@' + emailUtils.getDomain(email);
			return domainList.includes(domain);
		});

		// 第 3 批：角色（依赖 userRow）与 E2EE 开关（依赖 allInternal）互不依赖，并行查。
		// Phase 6：E2EE 后端门。发件用户 e2ee_enabled=1 且收件人含站外地址时拒发
		// （加密内容不能走站外中继；服务端不解密、不校验密文内容）。
		const [roleRow, e2eeEnabled] = await Promise.all([
			roleService.selectById(c, userRow.type),
			!allInternal ? userSecurityService.isE2eeEnabled(c, userId) : Promise.resolve(false)
		]);
		if (!allInternal && e2eeEnabled) {
			throw new BizError(t('e2eeExternalBlocked'), 400);
		}

		const e2eeFlag = Number(e2ee) === 1 ? 1 : 0;

		// 斯诺登第二批（v3_15DB）：发件人隐身 + 前向保密/抗量子，仅 E2EE 站内信有效。
		// 站外收件人存在时（或 e2ee 未标记）直接丢弃这些字段，绝不把密封信封/密钥包裹
		// 写进站外投递路径；旧版前端不传这些字段时走旧版 v1 路径（e2eeVer=1）。
		const sealedSenderStr = (e2eeFlag === 1 && allInternal && typeof sealedSender === 'string')
			? sealedSender.slice(0, 4096) : '';
		const cekWrapsArr = (e2eeFlag === 1 && allInternal && Array.isArray(cekWraps))
			? cekWraps.filter(w => w && typeof w.to === 'string' && typeof w.wrapped === 'string'
				&& (w.alg === 'sym' || w.alg === 'mlkem768')).slice(0, 64) : [];
		const e2eeVerNum = (e2eeFlag === 1 && allInternal && Number(e2eeVer) === 2) ? 2 : 1;

		// 斯诺登第三批（v3_16DB，仅 E2EE 站内信有效）：
		// 时间锁：只接受未来的解锁时刻（非法/过去/超 365 天按不锁处理；时间以服务端时钟为准）。
		// 可否认：deniable=1 时存标记 + HMAC 标签（标签为 hex，最长 128 字符）。
		// 盲索引：只收字符串 token 数组（上限 50 个，供发件方已发送副本检索用）。
		const timelockUntilStr = (e2eeFlag === 1 && allInternal && e2eeVerNum === 2)
			? timelockService.resolveUnlockAt(timelockUntil) : '';
		const deniableFlag = (e2eeFlag === 1 && allInternal && Number(deniable) === 1) ? 1 : 0;
		const denyTagStr = (deniableFlag === 1 && typeof denyTag === 'string' && /^[0-9a-fA-F]{32,128}$/.test(denyTag))
			? denyTag.toLowerCase() : '';
		const blindTokensArr = (e2eeFlag === 1 && Array.isArray(blindTokens))
			? blindTokens.filter(t => typeof t === 'string' && t.length > 0 && t.length <= 128).slice(0, 50) : [];

		// 邮件混淆（v3_16DB，仅站内收件人生效）：随机延迟 15–180 秒 + 随机逻辑中继。
		// 发件人自己的已发送副本不延迟；站外信不混淆。
		const mix = allInternal ? this.resolveMix() : { deliverAt: '', relay: '' };

		// 自毁邮件：发信时刻按选项算出过期时间/阅后即焚/组标识，进 saveParams 后由
		// saveSentEmail 写进发件记录，HandleOnSiteEmail 原样带给各收件人行。
		// 斯诺登第四批 P1-3：只有 burn 选项走策略判定（明文信选 burn 时降级并报错，
		// 不在用户不知情时给“已彻底销毁”的假安全感）；定时选项仍走原 resolveExpiry，
		// 保持组标识格式（24 位 hex）与服务端时钟行为不变。
		let expiry;
		if (params.expireOption === 'burn') {
			const burnPolicy = burnAfterReadingService.resolveBurnPolicy({ e2ee: e2eeFlag, expireOption: 'burn' });
			if (burnPolicy.downgraded) {
				throw new BizError(t('burn4BurnRequiresE2ee'), 400);
			}
			expiry = { expireAt: burnPolicy.expireAt, burnAfterRead: burnPolicy.burnAfterRead, expireGroup: burnPolicy.expireGroup };
		} else {
			expiry = this.resolveExpiry(params.expireOption);
		}

		if (c.env.admin !== userRow.email && !systemSend) {

			//发件被禁用
			if (roleRow.sendType === 'ban') {
				throw new BizError(t('bannedSend'), 403);
			}

			//发件被禁用
			if (roleRow.sendType === 'internal' && !allInternal) {
				throw new BizError(t('onlyInternalSend'), 403);
			}

		}

		//如果不是管理员，权限设置了发送次数（系统代发 systemSend 不受日限额约束，
		// 否则死亡开关提醒信可能因用户当天发信满额而发不出去）。
		if (c.env.admin !== userRow.email && roleRow.sendCount && !systemSend) {

			if (userRow.sendCount >= roleRow.sendCount) {
				if (roleRow.sendType === 'day') throw new BizError(t('daySendLimit'), 403);
				if (roleRow.sendType === 'count') throw new BizError(t('totalSendLimit'), 403);
			}

			if (userRow.sendCount + receiveEmail.length > roleRow.sendCount) {
				if (roleRow.sendType === 'day') throw new BizError(t('daySendLack'), 403);
				if (roleRow.sendType === 'count') throw new BizError(t('totalSendLack'), 403);
			}

		}

		// accountRow 已在第 2 批并行查出，这里只做校验（顺序不变）。
		if (!accountRow) {
			throw new BizError(t('senderAccountNotExist'));
		}

		if (accountRow.userId !== userId) {
			throw new BizError(t('sendEmailNotCurUser'));
		}

		if (c.env.admin !== userRow.email) {
			//用户没有这个域名的使用权限
			if(!roleService.hasAvailDomainPerm(roleRow.availDomain, accountRow.email)) {
				throw new BizError(t('noDomainPermSend'),403)
			}

		}

		const domain = emailUtils.getDomain(accountRow.email);
		const resendToken = resendTokens[domain];
		const useCloudflareEmail = !!c.env.email;

		//如果接收方存在站外邮箱，又没有发信服务
		if (!useCloudflareEmail && !resendToken && !allInternal) {
			throw new BizError(t('noSendProvider'));
		}

		//没有发件人名字自动截取
		if (!name) {
			name = emailUtils.getName(accountRow.email);
		}

		let emailRow = {
			messageId: null
		};

		//如果是回复邮件（查询已在第 2 批提前发起，这里只等结果并校验，报错位置不变）
		if (sendType === 'reply') {

			emailRow = await replyEmailPromise;

			if (!emailRow) {
				throw new BizError(t('notExistEmailReply'));
			}

		}

		const sendParams = {
			name,
			accountEmail: accountRow.email,
			receiveEmail,
			subject,
			text,
			html,
			attachments: [...imageDataList, ...attachments],
			sendType,
			messageId: emailRow.messageId
		};

		if (imageDataList.length > 10) {
			throw new BizError(t('imageAttLimit'));
		}
		if (attachments.length > 10) {
			throw new BizError(t('attLimit'));
		}

		const separate = params.manyType === 'divide';
		// sendParams 用于渠道请求，saveParams 保留保存记录所需的账号、权限和附件数据。
		// skipRules：规则转发再投递时带 true，防止站内转发目标再次命中同一规则造成循环转发。
		const context = {
			separate, allInternal, useCloudflareEmail, resendToken, sendParams,
			// 斯诺登第二批（v3_15DB）：按收件人包裹的一次性密钥，供 sendInternal 转交给
			// HandleOnSiteEmail 按收件地址分发（发件人自己的那份由 saveSentEmail 从中取）。
			cekWraps: cekWrapsArr,
			skipRules: params.skipRules === true,
			saveParams: {
				accountId, userId, name, subject, text, html,
				sendEmail: accountRow.email,
				messageId: emailRow.messageId,
				sendType, useCloudflareEmail, roleRow, r2Domain,
				imageDataList, attachments,
				e2ee: e2eeFlag,
				sealedSender: sealedSenderStr,
				e2eeVer: e2eeVerNum,
				cekWraps: cekWrapsArr,
				expireAt: expiry.expireAt,
				burnAfterRead: expiry.burnAfterRead,
				expireGroup: expiry.expireGroup,
				// 斯诺登第三批（v3_16DB）：时间锁 / 可否认 / 混淆（收件行）进保存参数。
				timelockUntil: timelockUntilStr,
				deniable: deniableFlag,
				denyTag: denyTagStr,
				mixDeliverAt: mix.deliverAt,
				mixRelay: mix.relay
			}
		};

		// 有站外收件人时看一眼 Resend 配额水位（best-effort，maybeAlertQuota 永不抛错）。
		// 速度优化：告警只是通知，不卡发送——先启动、与渠道发送并行，发送完成后再等它。
		// 配额“门禁”是下面的 hasResendBudget，仍在发前查，不动。
		const quotaAlertPromise = !allInternal ? quotaService.maybeAlertQuota(c) : Promise.resolve();

		// 全部站内收件人走本地投递；存在站外收件人时优先 CF，其次 Resend。
		// Phase 7 发信容灾：配了 CF 时先走 CF，CF 某组抛错才切 Resend 单发该组
		// （sendCloudflare → tryResendFallback；无 Key/配额不够/回落失败时
		// 返回原始 CF 错误）。无 CF 时 Resend 是唯一外发通道，撞线即停发并告警。
		let deliveries;
		if (allInternal) {
			deliveries = this.sendInternal(c, context);
		} else if (useCloudflareEmail) {
			deliveries = this.sendCloudflare(c, context);
		} else {
			// 进 Resend 分支前查配额：日/月任一超预算即停发，不调 Resend、不写发送记录。
			if (!await quotaService.hasResendBudget(c)) {
				throw new BizError(t('resendQuotaExhausted'));
			}
			deliveries = this.sendResend(c, context);
		}

		const emailResults = [];
		let sendError = '';

		// 渠道每完成一组发送并保存记录后返回结果，后续发送失败仍保留已完成部分。
		for await (const delivery of deliveries) {
			if (delivery.error) {
				sendError = delivery.error.message;
				break;
			}

			emailResults.push(...delivery.emails);
		}

		// 等配额告警完成再返回（它与发送并行跑过，正常已完成；永不抛错，不影响发送结果）。
		await quotaAlertPromise;

		// 可搜索加密（v3_16DB）：发件方已发送副本的盲索引（发件方自己的 KEK 算的
		// token，存发件方名下，供发件方以后搜自己的已发送加密信；收信方那份由收信方
		// 读信解密后补传）。失败不阻断返回。
		if (blindTokensArr.length && emailResults.length) {
			try {
				for (const row of emailResults) {
					if (row && row.emailId) {
						await blindIndexService.storeTokens(c, row.emailId, userId, blindTokensArr);
					}
				}
			} catch (e) {
				console.error('盲索引保存失败:', e.message);
			}
		}

		if (!separate) {
			if (sendError) throw new BizError(sendError);
			return emailResults;
		}

		// 分开发送只返回尚未完成的收件人，供前端保留并重试。
		const sentRecipients = emailResults.flatMap(item =>
			JSON.parse(item.recipient).map(recipient => recipient.address)
		);
		return {
			emails: emailResults,
			failedRecipients: sendParams.receiveEmail.filter(address => !sentRecipients.includes(address)),
			error: sendError
		};
	},

	// Phase 8 E：撤回（延迟发送）与定时发送编排。pending_send /
	// scheduled_email 两表 DDL 见子代理 E 汇报（总协调并进 v3_11DB）。
	// 时间统一存 'YYYY-MM-DD HH:mm:ss'（与 email.createTime 同格式，
	// 字典序比较即时间比较；一律按服务端时钟，不信任客户端时间）。
	// 注意：本函数产出的就是 UTC 的该格式字符串；调用方（processDuePending）
	// 把它再传回 confirmPendingSend 时必须原样返回，绝不能再走 new Date()
	// 重解析——'YYYY-MM-DD HH:mm:ss' 无时区标记，new Date() 按本地时区
	// 解析，非 UTC 运行时会把窗口整体平移一个时区偏移，导致兜底扫表
	// 静默漏发（2026-11-08 曾出现 swept.sent=0 且无任何日志的故障，
	// 虽未能复现，但此处是同类故障的唯一时区相关隐患点，已堵死）。
	_pendingNowIso(now) {
		if (typeof now === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(now)) {
			return now;
		}
		const d = now instanceof Date ? now : new Date(now || Date.now());
		return d.toISOString().slice(0, 19).replace('T', ' ');
	},

	_pendingPayload(params) {
		const { undoSeconds, scheduledAt, ...rest } = params;
		return rest;
	},

	async _getPendingRow(c, pendingId) {
		return c.env.db.prepare(
			`SELECT pending_id AS pendingId, user_id AS userId, payload, undo_until AS undoUntil,
				status, result, error FROM pending_send WHERE pending_id = ?`
		).bind(Number(pendingId)).first();
	},

	// 撤回窗口创建：只做轻量校验（账号归属、收件人、附件上限），完整校验
	// （角色/配额/渠道）在窗口结束真正执行时由 executeSend 再跑一遍；
	// 窗口内不发任何东西、不计配额、不写发件记录。
	async createPendingSend(c, params, userId, undoSeconds) {
		if (!UNDO_DELAYS.includes(Number(undoSeconds))) {
			throw new BizError('trust_invalid_undo_delay', 'trust_invalid_undo_delay');
		}
		const accountRow = params.accountId ? await accountService.selectById(c, params.accountId) : null;
		if (!accountRow || accountRow.userId !== userId) {
			throw new BizError('trust_invalid_sender_account', 'trust_invalid_sender_account');
		}
		if (!Array.isArray(params.receiveEmail) || !params.receiveEmail.length) {
			throw new BizError('trust_no_recipient', 'trust_no_recipient');
		}
		if ((params.attachments || []).length > 10) {
			throw new BizError('attLimit');
		}
		const undoUntil = this._pendingNowIso(Date.now() + Number(undoSeconds) * 1000);
		const payload = this._pendingPayload(params);
		const inserted = await c.env.db.prepare(
			`INSERT INTO pending_send (user_id, payload, undo_until, status) VALUES (?, ?, ?, 'pending')`
		).bind(userId, JSON.stringify(payload), undoUntil).run();
		const pendingId = inserted.meta.last_row_id;
		return { pending: true, pendingId, undoSeconds: Number(undoSeconds), undoUntil };
	},

	async getPendingSend(c, userId, pendingId) {
		const row = await this._getPendingRow(c, pendingId);
		if (!row || Number(row.userId) !== Number(userId)) {
			throw new BizError('trust_pending_not_found', 'trust_pending_not_found');
		}
		return { pendingId: row.pendingId, status: row.status, undoUntil: row.undoUntil };
	},

	// 窗口内取消：作废待发送件，原文退回草稿（draft 即原发送参数，前端
	// 存入本地 Dexie 草稿箱；服务端无草稿表，不另建）。
	async cancelPendingSend(c, userId, pendingId) {
		const row = await this._getPendingRow(c, pendingId);
		if (!row || Number(row.userId) !== Number(userId)) {
			throw new BizError('trust_pending_not_found', 'trust_pending_not_found');
		}
		if (row.status !== 'pending') {
			throw new BizError('trust_undo_expired', 'trust_undo_expired');
		}
		if (this._pendingNowIso() > row.undoUntil) {
			throw new BizError('trust_undo_expired', 'trust_undo_expired');
		}
		await c.env.db.prepare(
			`UPDATE pending_send SET status = 'cancelled' WHERE pending_id = ?`
		).bind(row.pendingId).run();
		let draft = {};
		try { draft = JSON.parse(row.payload || '{}'); } catch (e) { draft = {}; }
		return { cancelled: true, pendingId: row.pendingId, draft };
	},

	// 窗口结束后确认发出（主路径：写信页倒计时结束时调；兜底：cron 调
	// processDuePending）。窗口内调 → trust_undo_not_expired，绝不提前发。
	// userId 传了就校验归属（API 层传；cron 扫表不传）。
	async confirmPendingSend(c, pendingId, { now, userId } = {}) {
		const row = await this._getPendingRow(c, pendingId);
		if (!row) {
			throw new BizError('trust_pending_not_found', 'trust_pending_not_found');
		}
		if (userId !== undefined && Number(row.userId) !== Number(userId)) {
			throw new BizError('trust_pending_not_found', 'trust_pending_not_found');
		}
		if (row.status === 'cancelled') {
			throw new BizError('trust_pending_cancelled', 'trust_pending_cancelled');
		}
		if (row.status === 'sent') {
			throw new BizError('trust_pending_sent', 'trust_pending_sent');
		}
		if (row.status === 'failed') {
			throw new BizError('trust_pending_failed', 'trust_pending_failed');
		}
		const nowIso = this._pendingNowIso(now);
		if (nowIso < row.undoUntil) {
			throw new BizError('trust_undo_not_expired', 'trust_undo_not_expired');
		}
		let payload = {};
		try { payload = JSON.parse(row.payload || '{}'); } catch (e) { payload = {}; }
		try {
			const emails = await this.executeSend(c, payload, Number(row.userId));
			const ids = (Array.isArray(emails) ? emails : (emails?.emails || [])).map(e => e.emailId).filter(Boolean);
			await c.env.db.prepare(
				`UPDATE pending_send SET status = 'sent', result = ? WHERE pending_id = ?`
			).bind(JSON.stringify(ids), row.pendingId).run();
			return { sent: true, pendingId: row.pendingId, emails: ids };
		} catch (e) {
			await c.env.db.prepare(
				`UPDATE pending_send SET status = 'failed', error = ? WHERE pending_id = ?`
			).bind(String(e?.message || e).slice(0, 500), row.pendingId).run();
			throw e;
		}
	},

	// cron 兜底扫表（总协调挂载进 index.js scheduled()）：把已过窗口仍
	// pending 的件逐个发出；单封失败不阻断其他。前端倒计时确认是主路径，
	// 本方法只防“用户关了页面导致信永远不发”。
	// 注意：单封失败必须记日志（pendingId + 错误码/信息）。此前 catch 里
	// 只 failed++ 不记日志，2026-11-08 曾出现 swept.sent=0 且全程无任何
	// 日志可查的故障；兜底扫表是“防丢信”的最后一道网，静默失败不可接受。
	async processDuePending(c, { now } = {}) {
		const nowIso = this._pendingNowIso(now);
		const rows = await c.env.db.prepare(
			`SELECT pending_id AS pendingId FROM pending_send WHERE status = 'pending' AND undo_until <= ? ORDER BY pending_id ASC LIMIT 50`
		).bind(nowIso).all();
		let sent = 0;
		let failed = 0;
		for (const r of (rows.results || [])) {
			try {
				await this.confirmPendingSend(c, r.pendingId, { now: nowIso });
				sent++;
			} catch (e) {
				failed++;
				console.error(`[processDuePending] pending ${r.pendingId} 兜底发送失败:`, e?.code || e?.message || e);
			}
		}
		return { processed: (rows.results || []).length, sent, failed };
	},

	// 定时发送：只入库，到点才发（processDueScheduled 触发）。不计配额、
	// 不写发件记录，直到真正发出那一刻。
	async scheduleSend(c, params, userId, scheduledAt) {
		const at = new Date(scheduledAt);
		if (isNaN(at.getTime())) {
			throw new BizError('trust_invalid_schedule_time', 'trust_invalid_schedule_time');
		}
		const nowMs = Date.now();
		if (at.getTime() <= nowMs || at.getTime() > nowMs + MAX_SCHEDULE_DAYS * 24 * 60 * 60 * 1000) {
			throw new BizError('trust_invalid_schedule_time', 'trust_invalid_schedule_time');
		}
		const accountRow = params.accountId ? await accountService.selectById(c, params.accountId) : null;
		if (!accountRow || accountRow.userId !== userId) {
			throw new BizError('trust_invalid_sender_account', 'trust_invalid_sender_account');
		}
		if (!Array.isArray(params.receiveEmail) || !params.receiveEmail.length) {
			throw new BizError('trust_no_recipient', 'trust_no_recipient');
		}
		const payload = this._pendingPayload(params);
		const inserted = await c.env.db.prepare(
			`INSERT INTO scheduled_email (user_id, account_id, payload, scheduled_at, status) VALUES (?, ?, ?, ?, 'pending')`
		).bind(userId, params.accountId, JSON.stringify(payload), this._pendingNowIso(at)).run();
		return { scheduled: true, scheduledId: inserted.meta.last_row_id, scheduledAt: this._pendingNowIso(at) };
	},

	async listScheduled(c, userId) {
		const rows = await c.env.db.prepare(
			`SELECT scheduled_id AS scheduledId, account_id AS accountId, payload, scheduled_at AS scheduledAt,
				status, attempts, error, created_at AS createdAt, sent_at AS sentAt
			 FROM scheduled_email WHERE user_id = ?
			 ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, scheduled_at DESC LIMIT 50`
		).bind(userId).all();
		return (rows.results || []).map(r => {
			let p = {};
			try { p = JSON.parse(r.payload || '{}'); } catch (e) { p = {}; }
			return {
				scheduledId: r.scheduledId,
				accountId: r.accountId,
				subject: p.subject || '',
				receiveEmail: p.receiveEmail || [],
				scheduledAt: r.scheduledAt,
				status: r.status,
				attempts: r.attempts,
				error: r.error || '',
				createdAt: r.createdAt,
				sentAt: r.sentAt
			};
		});
	},

	async cancelScheduled(c, userId, scheduledId) {
		const row = await c.env.db.prepare(
			`SELECT scheduled_id AS scheduledId, user_id AS userId, status FROM scheduled_email WHERE scheduled_id = ?`
		).bind(Number(scheduledId)).first();
		if (!row || Number(row.userId) !== Number(userId)) {
			throw new BizError('trust_schedule_not_found', 'trust_schedule_not_found');
		}
		if (row.status !== 'pending') {
			throw new BizError('trust_schedule_not_pending', 'trust_schedule_not_pending');
		}
		await c.env.db.prepare(
			`UPDATE scheduled_email SET status = 'cancelled' WHERE scheduled_id = ?`
		).bind(row.scheduledId).run();
		return { cancelled: true, scheduledId: row.scheduledId };
	},

	// cron 扫表（总协调挂载进 index.js scheduled()）：到点的定时信逐个
	// 真正发出；单封失败记 attempts，3 次后置 failed，不无限重试。
	async processDueScheduled(c, { now } = {}) {
		const nowIso = this._pendingNowIso(now);
		const rows = await c.env.db.prepare(
			`SELECT scheduled_id AS scheduledId, user_id AS userId, payload, attempts FROM scheduled_email
			 WHERE status = 'pending' AND scheduled_at <= ? ORDER BY scheduled_id ASC LIMIT 50`
		).bind(nowIso).all();
		let sent = 0;
		let failed = 0;
		for (const r of (rows.results || [])) {
			let payload = {};
			try { payload = JSON.parse(r.payload || '{}'); } catch (e) { payload = {}; }
			try {
				const emails = await this.executeSend(c, payload, Number(r.userId));
				const ids = (Array.isArray(emails) ? emails : (emails?.emails || [])).map(e => e.emailId).filter(Boolean);
				await c.env.db.prepare(
					`UPDATE scheduled_email SET status = 'sent', sent_at = ?, result = ? WHERE scheduled_id = ?`
				).bind(nowIso, JSON.stringify(ids), r.scheduledId).run();
				sent++;
			} catch (e) {
				const attempts = Number(r.attempts || 0) + 1;
				const status = attempts >= 3 ? 'failed' : 'pending';
				await c.env.db.prepare(
					`UPDATE scheduled_email SET attempts = ?, status = ?, error = ? WHERE scheduled_id = ?`
				).bind(attempts, status, String(e?.message || e).slice(0, 500), r.scheduledId).run();
				failed++;
				// 与 processDuePending 同理：兜底扫表失败必须记日志，不可静默。
				console.error(`[processDueScheduled] scheduled ${r.scheduledId} 兜底发送失败(第 ${attempts} 次):`, e?.code || e?.message || e);
			}
		}
		return { processed: (rows.results || []).length, sent, failed };
	},

	// 站内发送：普通发送共用一条发件记录，分开发送则每人一条，再写入站内收件箱。
	async *sendInternal(c, { separate, sendParams, saveParams, skipRules, cekWraps }) {
		const recipientGroups = separate
			? sendParams.receiveEmail.map(address => [address])
			: [sendParams.receiveEmail];
		for (const receiveEmail of recipientGroups) {
			const emailResult = await this.saveSentEmail(c, { ...saveParams, receiveEmail });
			const emailRowList = await this.HandleOnSiteEmail(c, receiveEmail, emailResult, emailResult.attList, { skipRules: skipRules === true, cekWraps: Array.isArray(cekWraps) ? cekWraps : [], mixDeliverAt: saveParams.mixDeliverAt || '', mixRelay: saveParams.mixRelay || '' });
			// 邮件混淆（v3_16DB）：未生效的信不跑转发（TG/ webhook/邮箱转发），
			// 由 cron 在生效后补跑；已生效的立即转发。
			const nowStr = this._pendingNowIso(Date.now());
			const immediateRows = emailRowList.filter(r => !r.mixDeliverAt || r.mixDeliverAt <= nowStr);
			await this.forwardOnSiteEmail(c, immediateRows, { sendParams: { ...sendParams, receiveEmail } });
			yield { emails: [emailResult] };
		}
	},

	// CF 发送：普通发送一次提交所有收件人，分开发送逐人调用并保存结果。
	// Phase 7 发信容灾：某组 CF 抛错时自动切 Resend 单发该组收件人（见 tryResendFallback）；
	// CF 成功的组绝不重发；回落失败/无 Key/配额不够时返回原始 CF 错误。
	async *sendCloudflare(c, { separate, sendParams, saveParams, resendToken }) {
		const recipientGroups = separate
			? sendParams.receiveEmail.map(address => [address])
			: [sendParams.receiveEmail];
		for (const receiveEmail of recipientGroups) {
			let result;
			try {
				result = await this.sendByCloudflareEmail(c, { ...sendParams, receiveEmail });
			} catch (error) {
				const fallback = await this.tryResendFallback(c, { cfError: error, receiveEmail, sendParams, saveParams, resendToken });
				if (fallback.ok) {
					yield { emails: [fallback.emailResult] };
					continue;
				}
				if (!separate) throw fallback.error;
				// 分开发送遇到渠道错误即停止，已成功的记录由入口汇总。
				yield { error: { message: fallback.error.message } };
				return;
			}
			const emailResult = await this.saveSentEmail(c, {
				...saveParams, receiveEmail, providerId: result.data.id
			});
			yield { emails: [emailResult] };
		}
	},

	// Phase 7 发信容灾：CF 失败后的 Resend 回落（只发本组收件人）。
	// 切流条件：已配 Resend Key 且 Resend 日/月配额够。任一不满足、或回落本身失败，
	// 都返回原始 CF 错误（不掩盖、不写发送记录）；回落成功才按 Resend 记 SENT + Resend id
	// 并计配额。每次实际回落尝试（成功/失败）都记日志/告警（见 logSendFailover）。
	async tryResendFallback(c, { cfError, receiveEmail, sendParams, saveParams, resendToken }) {
		if (!resendToken) {
			return { ok: false, error: cfError };
		}
		let hasBudget = false;
		try {
			hasBudget = await quotaService.hasResendBudget(c);
		} catch (e) {
			console.error('回落前查 Resend 配额失败，不切 Resend:', e.message);
		}
		if (!hasBudget) {
			return { ok: false, error: cfError };
		}
		let result;
		try {
			// 单发（不用 sendResend 的批量接口）：回落只针对失败的这一组收件人，
			// 且批量接口不支持附件，单发无此限制。
			result = await this.sendByResend(resendToken, { ...sendParams, receiveEmail });
		} catch (fallbackError) {
			await this.logSendFailover(c, { receiveEmail, sendParams, cfError, fallbackError });
			return { ok: false, error: cfError };
		}
		if (result?.error) {
			await this.logSendFailover(c, { receiveEmail, sendParams, cfError, fallbackError: new Error(result.error.message || 'Resend error') });
			return { ok: false, error: cfError };
		}
		// 回落成功：按 Resend 渠道记 SENT（useCloudflareEmail=false），providerId 为 Resend id。
		const emailResult = await this.saveSentEmail(c, {
			...saveParams, receiveEmail, providerId: result.data?.id, useCloudflareEmail: false
		});
		await quotaService.recordResendSent(c, receiveEmail.length);
		await this.logSendFailover(c, { receiveEmail, sendParams, cfError, providerId: result.data?.id });
		return { ok: true, emailResult };
	},

	// 回落日志/告警：复用 telegramService.sendAlert（先写 alert_log 再发 TG，永不抛错；
	// 无 TG 配置时只记库不发 TG）。成功与失败的回落尝试都记一条，
	// 文本只含发件人/收件人/错误摘要，不含正文。
	async logSendFailover(c, { receiveEmail, sendParams, cfError, fallbackError, providerId }) {
		try {
			const lines = [
				'🔁 发信回落 CF→Resend',
				`发件人：${sendParams?.accountEmail || ''}`,
				`收件人：${receiveEmail.join(', ')}`,
				`CF 失败：${cfError?.message || cfError}`
			];
			if (providerId) {
				lines.push(`Resend 已发出（id ${providerId}）`);
			}
			if (fallbackError) {
				lines.push(`Resend 回落也失败：${fallbackError.message || fallbackError}，已返回 CF 原始错误`);
			}
			await telegramService.sendAlert(c, lines.join('\n'), 'failover');
		} catch (e) {
			console.error('记发信回落日志失败:', e.message);
		}
	},

	// Resend 分开发送一次最多提交 100 封独立邮件，普通发送仍调用单封接口。
	async *sendResend(c, { separate, resendToken, sendParams, saveParams }) {
		if (separate && sendParams.receiveEmail.length > 100) {
			throw new BizError(t('resendRecipientLimit'));
		}
		// 批量接口不支持附件，包含正文转换得到的内嵌附件。
		if (separate && sendParams.attachments.length > 0) {
			throw new BizError(t('resendSeparateAttachments'));
		}
		let result;
		try {
			result = separate
				? await this.sendBatchByResend(resendToken, sendParams)
				: await this.sendByResend(resendToken, sendParams);
		} catch (error) {
			if (!separate) throw error;
			yield { error: { message: error.message } };
			return;
		}
		if (result.error) {
			yield { error: result.error };
			return;
		}
		// 严格校验模式下，批量返回的邮件 ID 按提交顺序对应各收件人。
		const items = separate
			? sendParams.receiveEmail.map((address, index) => ({
				receiveEmail: [address], id: result.data.data[index].id
			}))
			: [{ receiveEmail: sendParams.receiveEmail, id: result.data?.id }];
		const emails = [];
		for (const item of items) {
			emails.push(await this.saveSentEmail(c, {
				...saveParams, receiveEmail: item.receiveEmail, providerId: item.id
			}));
		}
		// Resend API 成功后按实际成功收件人数计配额（普通发送一封多收件人按收件人数；
		// 分开发送按保存成功的封数；失败不计）。不能用 emails.length：普通发送只有 1 条记录。
		const sentCount = emails.reduce((n, e) => {
			try {
				return n + JSON.parse(e.recipient || '[]').length;
			} catch (err) {
				return n + 1;
			}
		}, 0);
		await quotaService.recordResendSent(c, sentCount);
		yield { emails };
	},

	// 三个渠道共用的发件记录保存：恢复正文图片 URL、保存附件并更新发送计数。
	async saveSentEmail(c, params) {
		const {
			accountId, userId, name, subject, text, html, sendEmail, receiveEmail,
			providerId, messageId, sendType, useCloudflareEmail,
			roleRow, r2Domain, attachments, e2ee,
			expireAt = '', burnAfterRead = 0, expireGroup = '',
			// 斯诺登第二批（v3_15DB）：密封发件人信封 + 正文信封版本 + 按收件人包裹的 CEK。
			sealedSender = '', cekWraps = [], e2eeVer = 1,
			// 斯诺登第三批（v3_16DB）：时间锁 / 可否认 / 混淆。
			timelockUntil = '', deniable = 0, denyTag = '',
			mixDeliverAt = '', mixRelay = ''
		} = params;
		// v2 信要求发件人自己的密钥包裹必须随信附带（否则已发送副本自己也解不开）；
		// 缺失时直接报错，提示客户端升级，不要静默写出一条不可读的 v2 信。
		const selfWrap = Array.isArray(cekWraps)
			? cekWraps.find(w => w && String(w.to || '').toLowerCase() === String(sendEmail || '').toLowerCase())
			: null;
		if (Number(e2eeVer) === 2 && !selfWrap) {
			throw new BizError(t('e2eeMissingSelfWrap'), 400);
		}
		const imageDataList = params.imageDataList.map(item => ({
			...item, contentId: `<${item.contentId.replace(/^<|>$/g, '')}>`
		}));
		const emailData = {
			sendEmail, name, subject, text, accountId, userId,
			content: this.imgReplace(html, imageDataList, r2Domain),
			status: useCloudflareEmail ? emailConst.status.DELIVERED : emailConst.status.SENT,
			type: emailConst.type.SEND,
			resendEmailId: providerId,
			e2ee: e2ee ? 1 : 0,
			expireAt,
			burnAfterRead: burnAfterRead ? 1 : 0,
			expireGroup,
			// 斯诺登第二批（v3_15DB）：密封发件人信封 + 正文信封版本 + 发件人自己的 CEK 包裹
			// （收件人那份由 HandleOnSiteEmail 按地址从 cekWraps 取，这里只存发件人自己的）。
			sealedSender: typeof sealedSender === 'string' ? sealedSender : '',
			e2eeVer: Number(e2eeVer) === 2 ? 2 : 1,
			cekWrapped: selfWrap?.wrapped || '',
			cekAlg: selfWrap?.alg || '',
			// 斯诺登第三批（v3_16DB）：可否认标记 + HMAC 标签；时间锁解锁时刻。
			// 发件人自己的已发送副本不混淆（立即能看到），但时间锁同样生效。
			deniable: deniable ? 1 : 0,
			denyTag: typeof denyTag === 'string' ? denyTag : '',
			timelockUntil: typeof timelockUntil === 'string' ? timelockUntil : '',
			recipient: JSON.stringify(receiveEmail.map(address => ({ address, name: '' })))
		};
		if (sendType === 'reply') {
			emailData.inReplyTo = messageId;
			emailData.relation = messageId;
		}
		// 速度优化：以下三组互不依赖，并行跑（失败语义不变）。
		// ① 计数自增与邮件入库并行：自增本来就在入库前触发，入库失败仍会计数（原来也一样）。
		// ② 两类附件保存并行（都只依赖 emailId）。
		// ③ 日统计 KV 读改写与入库/附件并行（纯统计，不依赖邮件行；并发两封的读改写竞态原来就有，未变）。
		const insertAndAtts = (async () => {
			const [row] = await Promise.all([
				orm(c).insert(email).values(emailData).returning().get(),
				(roleRow.sendCount && roleRow.sendType !== 'internal')
					? userService.incrUserSendCount(c, receiveEmail.length, userId)
					: Promise.resolve()
			]);
			await Promise.all([
				imageDataList.length > 0 ? attService.saveArticleAtt(c, imageDataList, userId, accountId, row.emailId) : Promise.resolve(),
				attachments?.length > 0 ? attService.saveSendAtt(c, attachments, userId, accountId, row.emailId) : Promise.resolve()
			]);
			return row;
		})();
		const dayCount = (async () => {
			const dateStr = dayjs().format('YYYY-MM-DD');
			const daySendTotal = await c.env.kv.get(kvConst.SEND_DAY_COUNT + dateStr);
			if (!daySendTotal) {
				await c.env.kv.put(kvConst.SEND_DAY_COUNT + dateStr, JSON.stringify(receiveEmail.length), { expirationTtl: 60 * 60 * 24 });
			} else {
				await c.env.kv.put(kvConst.SEND_DAY_COUNT + dateStr, JSON.stringify(Number(daySendTotal) + receiveEmail.length), { expirationTtl: 60 * 60 * 24 });
			}
		})();
		const emailResult = await insertAndAtts;
		await dayCount;

		// 时间锁（v3_16DB）：发件人自己的 CEK 包裹暂存 timelock_key，行里
		// cek_wrapped 清空——解锁前发件人自己的已发送副本也解不开（与收件方一致）。
		if (timelockUntil && Number(e2eeVer) === 2 && selfWrap?.wrapped) {
			try {
				await timelockService.holdKey(c, emailResult.emailId, {
					cekWrapped: selfWrap.wrapped, cekAlg: selfWrap.alg || 'sym', unlockAt: timelockUntil
				});
				await orm(c).update(email).set({ cekWrapped: '', cekAlg: '' })
					.where(eq(email.emailId, emailResult.emailId)).run();
				emailResult.cekWrapped = '';
				emailResult.cekAlg = '';
			} catch (e) {
				console.error('时间锁暂存发件人密钥失败:', e.message);
			}
		}

		const attList = await attService.selectByEmailIds(c, [emailResult.emailId]);
		emailResult.attList = attList;

		return emailResult;
	},

	// 附件已在 Resend 处理器中校验，批量接口为每位收件人构造独立邮件。
	async sendBatchByResend(resendToken, params) {
		const resend = new Resend(resendToken);
		const sendForm = {
			from: `${params.name} <${params.accountEmail}>`,
			subject: params.subject,
			text: params.text,
			html: params.html
		};
		if (params.sendType === 'reply' && params.messageId) {
			sendForm.headers = {
				'in-reply-to': params.messageId,
				'references': params.messageId
			};
		}
		return resend.batch.send(params.receiveEmail.map(address => ({
			...sendForm, to: [address]
		})), { batchValidation: 'strict' });
	},

	async sendByCloudflareEmail(c, params) {
		const sendForm = {
			from: { email: params.accountEmail, name: params.name },
			to: [...params.receiveEmail],
			subject: params.subject
		};

		if (params.text) {
			sendForm.text = params.text;
		}

		if (params.html) {
			sendForm.html = params.html;
		}

		const attachments = await this.toCloudflareAttachments(params.attachments);
		if (attachments.length > 0) {
			sendForm.attachments = attachments;
		}

		if (params.sendType === 'reply' && params.messageId) {
			sendForm.headers = {
				'in-reply-to': params.messageId,
				'references': params.messageId
			};
		}

		const result = await c.env.email.send(sendForm);

		return {
			data: {
				id: result.messageId
			}
		};
	},

	async sendByResend(resendToken, params) {
		const resend = new Resend(resendToken);

		const sendForm = {
			from: `${params.name} <${params.accountEmail}>`,
			to: [...params.receiveEmail],
			subject: params.subject,
			text: params.text,
			html: params.html,
			attachments: await this.toResendAttachments(params.attachments)
		};

		if (params.sendType === 'reply') {
			sendForm.headers = {
				'in-reply-to': params.messageId,
				'references': params.messageId
			};
		}

		return await resend.emails.send(sendForm);
	},

	async toCloudflareAttachments(attachments) {
		const arrayBufferAttachments = await this.toArrayBufferAttachments(attachments);

		return arrayBufferAttachments.map(attachment => {
			const item = {
				content: attachment.content,
				filename: attachment.filename,
				type: attachment.mimeType || attachment.contentType || attachment.type || 'application/octet-stream',
				disposition: attachment.contentId ? 'inline' : 'attachment'
			};

			if (attachment.contentId) {
				item.contentId = attachment.contentId.replace(/^<|>$/g, '');
			}

			return item;
		});
	},

	async toResendAttachments(attachments = []) {
		const result = [];

		for (const attachment of attachments) {
			const content = await this.toAttachmentBase64(attachment);
			if (!content) {
				continue;
			}

			result.push({
				...attachment,
				content,
				contentType: attachment.contentType || attachment.mimeType || attachment.type || 'application/octet-stream'
			});
		}

		return result;
	},

	async toArrayBufferAttachments(attachments = []) {
		const result = [];

		for (const attachment of attachments) {
			const content = await this.toAttachmentArrayBuffer(attachment);
			if (!content) {
				continue;
			}

			result.push({ ...attachment, content });
		}

		return result;
	},

	async toAttachmentBase64(attachment) {
		let content = attachment.content;

		if (!content) {
			return null;
		}

		if (typeof content === 'string') {
			if (content.startsWith('data:')) {
				content = content.split(',')[1] || content;
			}
			return content.replace(/\s+/g, '');
		}

		const arrayBuffer = await this.toAttachmentArrayBuffer(attachment);
		if (!arrayBuffer) {
			return null;
		}

		const bytes = new Uint8Array(arrayBuffer);
		let binary = '';

		for (let i = 0; i < bytes.length; i += 0x8000) {
			binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		}

		return btoa(binary);
	},

	async toAttachmentArrayBuffer(attachment) {
		let content = attachment.content;

		if (!content) {
			return null;
		}

		if (content instanceof ArrayBuffer) {
			return content;
		}

		if (content instanceof Uint8Array) {
			return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
		}

		if (typeof content === 'string') {
			if (content.startsWith('data:')) {
				content = content.split(',')[1] || content;
			}
			return fileUtils.base64ToUint8Array(content.replace(/\s+/g, '')).buffer;
		}

		return content;
	},

	//处理站内邮件发送
	// Phase 8 F：新收信件跑一次用户邮件规则（只对新信；旧信不重跑）。
	// 转发动作的投递走现有发信通道（this.send），并带 skipRules 防止站内
	// 转发目标再次命中同一规则造成循环转发。全程 best-effort：规则表未
	// 迁移、单条规则失败、单封转发失败都只记日志，不阻断收信主流程。
	// 注意：E2EE 加密邮件的正文是密文，规则转发会原样转发密文（收件方需
	// 有密钥才能读）；打标签/归档/标记已读/删除只动元数据，不受影响。
	async _applyMailRules(c, emailRow) {
		if (!emailRow || !emailRow.userId) {
			return;
		}
		let result;
		try {
			result = await mailRuleService.applyRules(c, emailRow.userId, emailRow);
		} catch (e) {
			console.error('邮件规则执行失败:', e.message);
			return;
		}
		const targets = result?.forwardTo || [];
		for (const target of targets) {
			try {
				await this.send(c, {
					accountId: emailRow.accountId,
					receiveEmail: [target],
					subject: 'Fwd: ' + (emailRow.subject || ''),
					text: emailRow.text || '',
					content: emailRow.content || '',
					skipRules: true
				}, emailRow.userId);
			} catch (e) {
				console.error('规则转发投递失败:', target, e.message);
			}
		}
	},

	async HandleOnSiteEmail(c, receiveEmail, sendEmailData, attList, opts = {}) {

		const { noRecipient  } = await settingService.query(c);

		//查询所有收件人账号信息
		let accountList = await orm(c).select().from(account).where(inArray(sql`${account.email} COLLATE NOCASE`, receiveEmail)).all();

		// 对于含+未精确匹配的收件人，获取基础地址账号
		const plusEmails = receiveEmail.filter(
			e => e.includes('+') && !accountList.some(a => a.email.toLowerCase() === e.toLowerCase())
		);
		const baseAccounts = [];
		if (plusEmails.length > 0) {
			const baseEmails = [...new Set(
				plusEmails.map(e => emailUtils.getBaseEmail(e)).filter(Boolean)
			)];
			const existing = new Set(accountList.map(a => a.email.toLowerCase()));
			const needed = baseEmails.filter(e => !existing.has(e.toLowerCase()));
			if (needed.length > 0) {
				const rows = await orm(c).select().from(account)
					.where(inArray(sql`${account.email} COLLATE NOCASE`, needed)).all();
				baseAccounts.push(...rows);
			}
		}

		// 合并精确匹配和基础地址匹配的账号用于权限查询
		const allAccounts = [...accountList, ...baseAccounts];

		// 一次性别名：收件地址先按账号精确匹配；匹配不到的再按别名找（别名收到的信进主收件箱）。
		// 别名解析在权限查询之前做，别名主人的角色也要进 roleList。
		const aliasHits = new Map();
		const aliasAccounts = [];
		const aliasSeen = new Set(allAccounts.map(a => a.accountId));
		for (const email of receiveEmail) {
			const lower = email.toLowerCase();
			const matched = allAccounts.some(a => a.email.toLowerCase() === lower)
				|| (email.includes('+') && allAccounts.some(a => {
					const base = emailUtils.getBaseEmail(email);
					return base && a.email.toLowerCase() === base.toLowerCase();
				}));
			if (matched) {
				continue;
			}
			try {
				const hit = await aliasService.resolveAlias(c, email);
				if (hit) {
					aliasHits.set(lower, hit);
					if (!aliasSeen.has(hit.account.accountId)) {
						aliasSeen.add(hit.account.accountId);
						aliasAccounts.push(hit.account);
					}
				}
			} catch (e) {
				console.error('别名解析失败:', e.message);
			}
		}
		allAccounts.push(...aliasAccounts);

		//查询所有收件人权限身份
		const userIds = allAccounts.map(accountRow => accountRow.userId);
		let roleList = await roleService.selectByUserIds(c, userIds);

		//封装数据库准备保存到数据库
		const emailDataList = [];

		for (const email of receiveEmail) {

			//把发件人邮件改成收件
			const emailValues = {...sendEmailData}
			emailValues.status = emailConst.status.RECEIVE;
			emailValues.type = emailConst.type.RECEIVE;
			emailValues.toEmail = email;
			emailValues.toName = emailUtils.getName(email);
			emailValues.emailId = null;

			// 斯诺登第二批（v3_15DB）：发件人隐身 + 前向保密/抗量子。
			// 密封信（sendEmailData.sealedSender 非空）时收件行的明文发件人置空，只留密封
			// 信封；收件人解锁 E2EE 后由前端用 CEK 解密信封恢复发件人。服务端发信时仍知
			// 发件人（认证/限额/黑名单需要），保证的是落盘记录不暴露发件人。
			// 每位收件人的 CEK 包裹按收件地址从 opts.cekWraps 取（密封信封本身对所有
			// 收件人共用同一份，因为 CEK 相同）；找不到包裹时留空，读信会明确报错，
			// 而不是静默看到乱码。黑名单检查仍用 sendEmailData.sendEmail（真实发件人）。
			if (sendEmailData.sealedSender) {
				emailValues.sendEmail = '';
				emailValues.name = '';
			}
			if (Number(sendEmailData.e2eeVer) === 2) {
				const wrap = Array.isArray(opts.cekWraps)
					? opts.cekWraps.find(w => w && String(w.to || '').toLowerCase() === email.toLowerCase())
					: null;
				emailValues.cekWrapped = wrap?.wrapped || '';
				emailValues.cekAlg = wrap?.alg || '';
				// 时间锁（v3_16DB）：收件人这份的 CEK 包裹先记下来，入库后暂存
				// timelock_key、行里 cek_wrapped 清空（解锁前解不开）。
				emailValues._timelockWrap = wrap || null;
			}

			// 邮件混淆（v3_16DB）：收件行记投递生效时间 + 逻辑中继编号；
			// 发件人已发送行不记（sendEmailData 里没有这两个字段，不会带过来）。
			if (opts.mixDeliverAt) {
				emailValues.mixDeliverAt = opts.mixDeliverAt;
				emailValues.mixRelay = opts.mixRelay || '';
			}

			let accountRow = allAccounts.find(accountRow => accountRow.email.toLowerCase() === email.toLowerCase());

			// 精确匹配不到时回退到主地址（去掉 +tag）
			if (!accountRow && email.includes('+')) {
				const baseEmail = emailUtils.getBaseEmail(email);
				accountRow = allAccounts.find(accountRow => accountRow.email.toLowerCase() === baseEmail.toLowerCase());
			}

			// 一次性别名：停用的别名直接拒收（不建收件记录）；启用的按主人账号收信。
			const aliasHit = aliasHits.get(email.toLowerCase());
			if (!accountRow && aliasHit) {
				if (aliasHit.alias.status === 1) {
					continue;
				}
				// 斯诺登第四批 P2-5：已过有效期的别名同样拒收。
				const expiryCheck = await aliasExpiryService.isAliasReceivingBlocked(c, email);
				if (expiryCheck.blocked) {
					continue;
				}
				accountRow = aliasHit.account;
			}

			//如果收件人存在就把邮件信息改成收件人的
			if (accountRow) {

				//设置给收件人保存
				emailValues.userId = accountRow.userId;
				emailValues.accountId = accountRow.accountId;
				emailValues.type = emailConst.type.RECEIVE;
				emailValues.status = emailConst.status.RECEIVE;

				const roleRow = roleList.find(roleRow => roleRow.userId === accountRow.userId);

				let { banEmail, availDomain } = roleRow;

				//如果收件人没有这个域名的使用权限和有邮件拦截，就把邮件改为拒收状态
				if (email !== c.env.admin) {

					if (!roleService.hasAvailDomainPerm(availDomain, email)) {
						emailValues.status = emailConst.status.BOUNCED;
						emailValues.message = `The recipient <${email}> is not authorized to use this domain.`;
					} else if(roleService.isBanEmail(banEmail, sendEmailData.sendEmail)) {
						emailValues.status = emailConst.status.BOUNCED;
						emailValues.message = `The recipient <${email}> is disabled from receiving emails.`;
					}

				}

				emailDataList.push(emailValues);

			} else {

				//设置无收件人邮件信息
				emailValues.userId = 0;
				emailValues.accountId = 0;
				emailValues.type = emailConst.type.RECEIVE;
				emailValues.status = emailConst.status.NOONE;

				//如果无人收件关闭改为拒收
				if (noRecipient === settingConst.noRecipient.CLOSE) {
					emailValues.status = emailConst.status.BOUNCED;
					emailValues.message = `Recipient not found: <${email}>`;
				}

				emailDataList.push(emailValues);

			}

		}

		//保存邮件
		const receiveEmailList = emailDataList.filter(emailRow => emailRow.status === emailConst.status.RECEIVE || emailRow.status === emailConst.status.NOONE);
		const emailRowList = [];

		for (const emailData of receiveEmailList) {

			// _timelockWrap 是临时变量，不是 D1 列，入库前剥掉。
			const { _timelockWrap, ...rowValues } = emailData;
			const emailRow = await orm(c).insert(email).values(rowValues).returning().get();
			emailRowList.push(emailRow);

			// 时间锁（v3_16DB）：收件人这份的 CEK 包裹暂存 timelock_key，行里
			// cek_wrapped 清空——解锁前收件人解不开（发件人那份同理已暂存）。
			if (emailData.timelockUntil && _timelockWrap?.wrapped) {
				try {
					await timelockService.holdKey(c, emailRow.emailId, {
						cekWrapped: _timelockWrap.wrapped,
						cekAlg: _timelockWrap.alg || 'sym',
						unlockAt: emailData.timelockUntil
					});
					await orm(c).update(email).set({ cekWrapped: '', cekAlg: '' })
						.where(eq(email.emailId, emailRow.emailId)).run();
					emailRow.cekWrapped = '';
					emailRow.cekAlg = '';
				} catch (e) {
					console.error('时间锁暂存收件人密钥失败:', e.message);
				}
			}

			//设置附件保存
			for (const attRow of attList) {
				const attValues = {...attRow};
				attValues.emailId = emailRow.emailId;
				attValues.accountId = emailRow.accountId;
				attValues.userId = emailRow.userId;
				attValues.attId = null;
				await orm(c).insert(att).values(attValues).run();
			}

		}

		const bouncedEmail = emailDataList.find(emailRow => emailRow.status === emailConst.status.BOUNCED);

		// Phase 8 F：站内收信落库后跑一次用户邮件规则（只对新信；skipRules 时跳过，
		// 防止规则转发再次命中同一规则造成循环转发）。
		if (!opts.skipRules) {
			for (const emailRow of emailRowList) {
				// 邮件混淆（v3_16DB）：未生效的信不跑邮件规则（避免规则移动/转发提前
				// 泄露），由 cron 在生效后补跑（processDueDeliveries）。
				if (emailRow.mixDeliverAt) {
					const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
					if (emailRow.mixDeliverAt > now) continue;
				}
				await this._applyMailRules(c, emailRow);
			}
		}


		let status = emailConst.status.DELIVERED;
		let message = ''
		//如果有拒收邮件，就把发件人的邮件改成拒收
		if (bouncedEmail) {
			const messageJson = { message: bouncedEmail.message };
			message = JSON.stringify(messageJson);
			status = emailConst.status.BOUNCED;
		}

		await orm(c).update(email).set({ status, message: message }).where(eq(email.emailId, sendEmailData.emailId)).run();

		// 一次性别名收信计数（投递成功的别名才计）。
		for (const emailRow of emailRowList) {
			const hit = aliasHits.get(String(emailRow.toEmail || '').toLowerCase());
			if (hit && emailRow.status === emailConst.status.RECEIVE) {
				await aliasService.incrementRecv(c, hit.alias.aliasId);
			}
		}

		return emailRowList;
	},

	//站内邮件不经过 email 事件，在这里按转发规则推送
	async forwardOnSiteEmail(c, emailRowList, { sendParams }) {

		const { tgBotStatus, tgChatId, forwardStatus, forwardEmail, webhookStatus, webhookUrl, webhookRetry, webhookSecret, ruleEmail, ruleType } = await settingService.query(c);

		if (ruleType === settingConst.ruleType.RULE) {
			const emails = ruleEmail.split(',');
			emailRowList = emailRowList.filter(emailRow => emails.includes(emailRow.toEmail));
		}

		for (const emailRow of emailRowList) {

			//转发到TG
			if (tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {
				await telegramService.sendEmailToBot(c, emailRow);
			}

			//转发到 Webhook
			if (webhookStatus === settingConst.webhookStatus.OPEN && webhookUrl) {
				await webhookService.sendEmail(c, emailRow, webhookUrl, webhookRetry, webhookSecret);
			}

		}

		//转发到其他邮箱。发件人用站内实际发件人，信头收件人保留原收件人，信封送到已验证地址。
		if (forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail && emailRowList.length > 0) {

			const addresses = forwardEmail.split(',').map(address => address.trim()).filter(Boolean);
			const params = {
				...sendParams,
				attachments: await this.toCloudflareAttachments(sendParams.attachments || []),
				receiveEmail: emailRowList.map(row => ({ address: row.toEmail, name: row.toName || '' })).filter(item => item.address)
			};

			await Promise.all(addresses.map(async address => {

				try {
					const result = await forwardMime.send(c.env.forward, params, address);
					if (result?.error) {
						console.error(`转发邮箱 ${address} 失败：`, result.error);
					}
				} catch (e) {
					console.error(`转发邮箱 ${address} 失败：`, e);
				}

			}));

		}

	},

	imgReplace(content, cidAttList, r2domain) {

		if (!content) {
			return ''
		}

		const { document } = parseHTML(content);

		const images = Array.from(document.querySelectorAll('img'));

		const useAtts = []

		for (const img of images) {

			const src = img.getAttribute('src');
			if (src && src.startsWith('cid:') && cidAttList) {

				const cid = src.replace(/^cid:/, '');
				const attCidIndex = cidAttList.findIndex(cidAtt => cidAtt.contentId.replace(/^<|>$/g, '') === cid);

				if (attCidIndex > -1) {
					const cidAtt = cidAttList[attCidIndex];
					img.setAttribute('src', '{{domain}}' + cidAtt.key);
					useAtts.push(cidAtt)
				}

			}

			r2domain = domainUtils.toOssDomain(r2domain)

			if (src && src.startsWith(r2domain + '/')) {
				img.setAttribute('src', src.replace(r2domain + '/', '{{domain}}'));
			}

		}

		useAtts.forEach(att => {
			att.type = attConst.type.EMBED
		})

		return document.toString();
	},

	// 回复原邮件只认本人名下的行（自己的收件行/已发送行）：跨用户 emailId
	// 在此直接判不存在，不让攻击者用 sendType=reply 探查他人邮件是否存在、
	// 也不让他人邮件的 messageId 经 In-Reply-To 外泄。其余调用方（星标/
	// 联系人/盲索引）仍在各自位置验归属，不动 selectById。
	async selectOwnById(c, emailId, userId) {
		const id = Number(emailId) || 0;
		if (!id || !userId) return null;
		return orm(c).select().from(email).where(
			and(eq(email.emailId, id),
				eq(email.userId, userId),
				eq(email.isDel, isDel.NORMAL)))
			.get();
	},

	async selectById(c, emailId) {
		const id = Number(emailId) || 0;
		// 诱饵会话（v3_16DB）：负数 id 读诱饵邮件；正数 id 在诱饵会话下不存在。
		if (userContext.isDecoy(c)) {
			if (id >= 0) return null;
			return decoyService.getDecoyMail(c, userContext.getUserId(c), id);
		}
		if (!id) return null;
		// 时间锁懒释放（v3_16DB）：已到期的密钥先写回，读信才能解密。
		try {
			await timelockService.releaseOne(c, id);
		} catch (e) { /* best-effort */ }
		const row = await orm(c).select().from(email).where(
			and(eq(email.emailId, id),
				eq(email.isDel, isDel.NORMAL)))
			.get();
		if (!row) return null;
		// 邮件混淆（v3_16DB）：收件行混淆未生效时当作不存在（打不开、看不到）。
		if (Number(row.type) === emailConst.type.RECEIVE && row.mixDeliverAt) {
			const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
			if (row.mixDeliverAt > now) return null;
		}
		return row;
	},

	async latest(c, params, userId) {
		let { emailId, accountId, allReceive } = params;
		emailId = Number(emailId) || 0; // 未传 emailId 时从头拉取，避免 gt(undefined) 触发 D1_TYPE_ERROR
		allReceive = Number(allReceive);

		// 诱饵会话（v3_16DB）：最新邮件只读诱饵邮件（id 为负数）。
		if (userContext.isDecoy(c)) {
			const rows = await decoyService.listDecoyMail(c, userId, { size: 20 });
			const newer = rows.filter(r => Math.abs(r.emailId) > Math.abs(emailId));
			return newer.slice(0, 20);
		}

		// 时间锁懒释放（v3_16DB）：先把本用户已到期的密钥写回，再查最新邮件。
		try {
			await timelockService.releaseDueForUser(c, userId);
		} catch (e) { /* best-effort */ }

		if (isNaN(allReceive)) {
			let accountRow = await accountService.selectById(c, accountId);
			allReceive = accountRow.allReceive;
		}

		const list = await orm(c).select({ ...emailListColumns }).from(email)
			.innerJoin(
				account,
				eq(account.accountId, email.accountId)
			)
			.where(
				and(
					gt(email.emailId, emailId),
					eq(email.userId, userId),
					eq(email.isDel, isDel.NORMAL),
					// Phase 8 E：Spam 不进最新邮件流（列未合并时不过滤）。
					(await mailTrustService.hasEmailTrustColumns(c)) ? sql`email.is_spam = 0` : undefined,
					eq(account.isDel, isDel.NORMAL),
					allReceive ? undefined : eq(email.accountId, accountId),
					eq(email.type, emailConst.type.RECEIVE),
					// 邮件混淆（v3_16DB）：未生效的混淆信不进最新邮件流（不弹新邮件提醒）。
					sql`(${email.mixDeliverAt} = '' OR ${email.mixDeliverAt} <= datetime('now'))`
				))
			.orderBy(desc(email.emailId))
			.limit(20);

		await this.emailAddAtt(c, list);
		for (const item of list) {
			item.listText = this.toListText(item);
		}
		// Phase 8 E：与 list() 同一份服务端清洗（Spam 不进最新邮件流）。
		await mailTrustService.applyServerSanitize(c, userId, list, { full: true });
		return list;
	},

	async physicsDelete(c, params) {
		let { emailIds } = params;
		emailIds = emailIds.split(',').map(Number);
		await attService.removeByEmailIds(c, emailIds);
		await starService.removeByEmailIds(c, emailIds);
		// 可搜索加密（v3_16DB）：删信时清理该信的盲索引行。
		await blindIndexService.deleteByEmailIds(c, emailIds);
		await orm(c).delete(email).where(inArray(email.emailId, emailIds)).run();
	},

	async physicsDeleteUserIds(c, userIds) {
		await attService.removeByUserIds(c, userIds);
		// 可搜索加密 + 胁迫密码（v3_16DB）：删号时清理该用户的盲索引与第二密码/诱饵邮件。
		for (const userId of userIds) {
			await blindIndexService.deleteByUserId(c, userId);
			await decoyService.deleteByUserId(c, userId);
		}
		await orm(c).delete(email).where(inArray(email.userId, userIds)).run();
	},

	updateEmailStatus(c, params) {
		const { status, resendEmailId, message } = params;
		return orm(c).update(email).set({
			status: status,
			message: message
		}).where(eq(email.resendEmailId, resendEmailId)).returning().get();
	},

	async selectUserEmailCountList(c, userIds, type, del = isDel.NORMAL) {
		const result = await orm(c)
			.select({
				userId: email.userId,
				count: count(email.emailId)
			})
			.from(email)
			.where(and(
				inArray(email.userId, userIds),
				eq(email.type, type),
				eq(email.isDel, del),
				ne(email.status, emailConst.status.SAVING),
			))
			.groupBy(email.userId);
		return result;
	},

	async allList(c, params) {

		let { emailId, size, name, subject, accountEmail, userEmail, type, timeSort, full } = params;

		size = Number(size);
		emailId = Number(emailId) || 0;
		timeSort = Number(timeSort);
		full = Number(full);

		if (type === undefined) {
			type = 'receive';
		}

		if (isNaN(size)) {
			size = 10;
		}

		if (size > 50) {
			size = 50;
		}

		if (isNaN(full)) {
			full = 1;
		}

		full = full === 1;

		const filters = this.allEmailListFilters({ emailId, name, subject, accountEmail, userEmail, type, timeSort });
		const countFilters = this.allEmailListFilters({ emailId, name, subject, accountEmail, userEmail, type, timeSort, withCursor: false });
		const columns = full ? emailListColumns : emailBriefColumns;

		const query = orm(c).select({ ...columns, userEmail: user.email })
			.from(email)
			.leftJoin(user, eq(email.userId, user.userId))
			.where(and(...filters));

		// count 不搜用户时无需 join user
		const queryCount = userEmail
			? orm(c).select({ total: count() })
				.from(email)
				.leftJoin(user, eq(email.userId, user.userId))
				.where(and(...countFilters))
			: orm(c).select({ total: count() })
				.from(email)
				.where(and(...countFilters));

		if (timeSort) {
			query.orderBy(asc(email.emailId));
		} else {
			query.orderBy(desc(email.emailId));
		}

		const listQuery = query.limit(size).all();
		const totalQuery = queryCount.get();
		const latestEmailQuery = orm(c).select({
			emailId: email.emailId,
			accountId: email.accountId,
			userId: email.userId,
		}).from(email)
			.where(and(
				eq(email.type, emailConst.type.RECEIVE),
				// 邮件混淆（v3_16DB）：最新邮件不含未生效的混淆信。
				sql`(${email.mixDeliverAt} = '' OR ${email.mixDeliverAt} <= datetime('now'))`
			))
			.orderBy(desc(email.emailId)).limit(1).get();

		let [list, totalRow, latestEmail] = await Promise.all([listQuery, totalQuery, latestEmailQuery]);

		if (full) {
			await this.emailAddAtt(c, list);
		} else {
			this.applyListText(list);
		}

		if (!latestEmail) {
			latestEmail = {
				emailId: 0,
				accountId: 0,
				userId: 0,
			}
		}

		return { list: list, total: totalRow.total, latestEmail };
	},

	async allEmailLatest(c, params) {

		const { emailId } = params;

		let list = await orm(c).select({ ...emailListColumns, userEmail: user.email }).from(email)
			.leftJoin(user, eq(email.userId, user.userId))
			.where(
				and(
					gt(email.emailId, emailId),
					eq(email.type, emailConst.type.RECEIVE)
				))
			.orderBy(desc(email.emailId))
			.limit(20);

		await this.emailAddAtt(c, list);
		for (const item of list) {
			item.listText = this.toListText(item);
		}
		return list;
	},

	async emailAddAtt(c, list) {

		const emailIds = list.map(item => item.emailId);

		if (emailIds.length > 0) {

			const attList = await attService.selectByEmailIds(c, emailIds);

			list.forEach(emailRow => {
				const atts = attList.filter(attRow => attRow.emailId === emailRow.emailId);
				emailRow.attList = atts;
			});
		}
	},

	async restoreByUserId(c, userId) {
		await orm(c).update(email).set({ isDel: isDel.NORMAL }).where(eq(email.userId, userId)).run();
	},

	async completeReceive(c, status, emailId) {
		return await orm(c).update(email).set({
			isDel: isDel.NORMAL,
			status: status
		}).where(eq(email.emailId, emailId)).returning().get();
	},

	async completeReceiveAll(c) {
		// 用 EXISTS 走 status=6 部分索引 + account 主键；避免 IN (SELECT account_id FROM account) 触发全盘扫描
		await c.env.db.prepare(
			`UPDATE email
			 SET status = ${emailConst.status.RECEIVE}
			 WHERE status = ${emailConst.status.SAVING}
			   AND EXISTS (SELECT 1 FROM account WHERE account.account_id = email.account_id)`
		).run();
		await c.env.db.prepare(
			`UPDATE email
			 SET status = ${emailConst.status.NOONE}
			 WHERE status = ${emailConst.status.SAVING}`
		).run();
	},

	async autoClean(c) {
		const { autoCleanDays, autoCleanExclude } = await settingService.query(c);
		const days = Number(autoCleanDays);

		if (!days || days <= 0) {
			return;
		}

		const cutoff = dayjs().subtract(days, 'day').format('YYYY-MM-DD HH:mm:ss');
		const excludeEmails = String(autoCleanExclude || '')
			.split(/[,，]/)
			.map(item => item.trim())
			.filter(Boolean);

		let excludeUserIds = [];
		if (excludeEmails.length) {
			const rows = await orm(c)
				.select({ userId: user.userId })
				.from(user)
				.where(sql`${user.email} COLLATE NOCASE IN (${sql.join(excludeEmails.map(email => sql`${email}`), sql`, `)})`)
				.all();
			excludeUserIds = rows.map(row => row.userId);
		}

		const batchSize = 95;

		while (true) {
			const conditions = [lt(email.createTime, cutoff)];
			if (excludeUserIds.length) {
				conditions.push(notInArray(email.userId, excludeUserIds));
			}

			const rows = await orm(c)
				.select({ emailId: email.emailId })
				.from(email)
				.where(and(...conditions))
				.limit(batchSize)
				.all();

			if (!rows.length) {
				break;
			}

			const emailIds = rows.map(row => row.emailId);
			await this.physicsDelete(c, { emailIds: emailIds.join(',') });

			if (rows.length < batchSize) {
				break;
			}
		}
	},

	async batchDelete(c, params) {
		let { sendName, sendEmail, toEmail, subject, startTime, endTime, type  } = params

		let right = type === 'left' || type === 'include'
		let left = type === 'include'

		const conditions = []

		if (sendName) {
			conditions.push(like(email.name,`${left ? '%' : ''}${sendName}${right ? '%' : ''}`))
		}

		if (subject) {
			conditions.push(like(email.subject,`${left ? '%' : ''}${subject}${right ? '%' : ''}`))
		}

		if (sendEmail) {
			conditions.push(like(email.sendEmail,`${left ? '%' : ''}${sendEmail}${right ? '%' : ''}`))
		}

		if (toEmail) {
			conditions.push(like(email.toEmail,`${left ? '%' : ''}${toEmail}${right ? '%' : ''}`))
		}

		if (startTime && endTime) {
			conditions.push(gte(email.createTime,`${startTime}`))
			conditions.push(lte(email.createTime,`${endTime}`))
		}

		if (conditions.length === 0) {
			return;
		}

		const emailIdsRow = await orm(c).select({emailId: email.emailId}).from(email).where(conditions.length > 1 ? and(...conditions) : conditions[0]).all();

		const emailIds = emailIdsRow.map(row => row.emailId);

		if (emailIds.length === 0){
			return;
		}

		await attService.removeByEmailIds(c, emailIds);

		await orm(c).delete(email).where(conditions.length > 1 ? and(...conditions) : conditions[0]).run();
	},

	async physicsDeleteByAccountId(c, accountId) {
		await attService.removeByAccountId(c, accountId);
		await orm(c).delete(email).where(eq(email.accountId, accountId)).run();
	},

	async read(c, params, userId) {
		const { emailIds, opened } = params;
		const ids = Array.isArray(emailIds) ? emailIds.map(Number).filter(Boolean) : [];
		if (!ids.length) {
			return;
		}
		// 诱饵会话（v3_16DB）：只标记诱饵邮件已读（负数 id），不动真实邮件。
		if (userContext.isDecoy(c)) {
			const decoyIds = ids.filter(id => id < 0);
			if (decoyIds.length) {
				await decoyService.markDecoyRead(c, userId, decoyIds);
			}
			return;
		}
		// 阅后即焚：仅当 opened=true（详情页打开、内容已进前端）且为收件人自己的收件行时触发；
		// 列表里“标已读”不带 opened，不烧。按 expireGroup 一起删（收件人 + 发件人已发送）。
		if (opened === true) {
			const burnRows = await orm(c).select({
				emailId: email.emailId,
				expireGroup: email.expireGroup
			}).from(email).where(and(
				eq(email.userId, userId),
				inArray(email.emailId, ids),
				eq(email.type, emailConst.type.RECEIVE),
				eq(email.burnAfterRead, 1)
			)).all();
			const groups = [...new Set(burnRows.map(r => r.expireGroup).filter(Boolean))];
			const burnedIds = new Set(burnRows.map(r => r.emailId));
			for (const group of groups) {
				const groupRows = await orm(c).select({ emailId: email.emailId }).from(email)
					.where(eq(email.expireGroup, group)).all();
				const groupIds = groupRows.map(r => r.emailId);
				if (groupIds.length) {
					await this.physicsDelete(c, { emailIds: groupIds.join(',') });
					// 斯诺登第四批 P1-3：焚毁留痕（只记元数据，不记主题/正文/收件人邮箱）。
					await burnAfterReadingService.recordBurnReceipt(c, {
						actorUserId: userId, expireGroup: group,
						burnedEmailIds: groupIds, readerUserId: userId,
					});
					for (const id of groupIds) {
						burnedIds.add(id);
					}
				}
			}
			const restIds = ids.filter(id => !burnedIds.has(id));
			if (restIds.length) {
				await orm(c).update(email).set({ unread: emailConst.unread.READ }).where(and(eq(email.userId, userId), inArray(email.emailId, restIds)));
			}
			return;
		}
		await orm(c).update(email).set({ unread: emailConst.unread.READ }).where(and(eq(email.userId, userId), inArray(email.emailId, ids)));
	},

	// 自毁邮件兜底清扫（cron 每小时调）：删掉所有已过期的信（D1 行 + 附件 + 星标，
	// 经 physicsDelete 彻底删除）。best-effort，永不抛错。
	async sweepExpired(c) {
		const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
		try {
			const rows = await c.env.db.prepare(
				`SELECT email_id AS emailId FROM email WHERE expire_at != '' AND expire_at <= ? LIMIT 200`
			).bind(nowStr).all();
			const ids = (rows.results || []).map(r => r.emailId).filter(Boolean);
			if (!ids.length) {
				return { swept: 0 };
			}
			await this.physicsDelete(c, { emailIds: ids.join(',') });
			return { swept: ids.length };
		} catch (e) {
			console.error('自毁邮件清扫失败:', e.message);
			return { swept: 0, error: e.message };
		}
	}
};

export default emailService;
