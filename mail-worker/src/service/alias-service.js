import orm from '../entity/orm';
import emailAlias from '../entity/email-alias';
import account from '../entity/account';
import settingService from './setting-service';
import roleService from './role-service';
import BizError from '../error/biz-error';
import { eq, and, sql } from 'drizzle-orm';
import userContext from '../security/user-context';

// 一次性别名邮箱：用户生成的随机前缀地址，别名收到的信进主收件箱。
// 每用户最多 10 个启用中别名；别名地址全局唯一；停用后发往该别名直接拒收。
// 别名与主账号的映射只在服务端维护，别名地址本身不泄露主邮箱。
const MAX_ACTIVE_ALIAS = 10;
const LOCAL_PART_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;

function randomLocalPart() {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	let s = '';
	for (const b of bytes) {
		s += 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36];
	}
	return 'a' + s.slice(0, 9);
}

const aliasService = {

	// 用户的别名列表（不含已删；按创建时间倒序）。
	// 诱饵会话（v3_16DB）：返回空（不透露真实别名地址）。
	async list(c, userId) {
		if (userContext.isDecoy(c)) {
			return [];
		}
		const rows = await orm(c).select().from(emailAlias)
			.where(and(eq(emailAlias.userId, userId), eq(emailAlias.isDel, 0)))
			.orderBy(sql`${emailAlias.aliasId} DESC`).all();
		return rows.map(r => ({
			aliasId: r.aliasId,
			address: r.address,
			localPart: r.localPart,
			domain: r.domain,
			status: r.status,
			recvCount: r.recvCount,
			createTime: r.createTime
		}));
	},

	// 生成一个新别名：随机前缀 + 用户主账号的域名。domain 可指定（须为用户有权限的站内域名）。
	// 诱饵会话（v3_16DB）：拒绝生成（不写真实别名）。
	async create(c, userId, domain) {
		if (userContext.isDecoy(c)) {
			throw new BizError('别名生成失败，请重试', 500);
		}
		const activeCountRow = await orm(c).select({ n: sql`count(*)` }).from(emailAlias)
			.where(and(
				eq(emailAlias.userId, userId),
				eq(emailAlias.isDel, 0),
				eq(emailAlias.status, 0)
			)).get();
		if (Number(activeCountRow?.n || 0) >= MAX_ACTIVE_ALIAS) {
			throw new BizError('别名数量已达上限（最多 10 个启用中）', 400);
		}
		// 主账号（取用户第一个未删账号）决定默认域名；domain 参数须为该用户有权限的站内域名。
		const accounts = await orm(c).select().from(account)
			.where(and(eq(account.userId, userId), eq(account.isDel, 0)))
			.orderBy(sql`${account.accountId} ASC`).all();
		if (!accounts.length) {
			throw new BizError('还没有邮箱账号，无法生成别名', 400);
		}
		const { domainList } = await settingService.query(c);
		const domains = (domainList || []).map(d => String(d).toLowerCase());
		let chosenDomain = '';
		if (domain) {
			const d = String(domain).toLowerCase();
			if (!domains.includes(d)) {
				throw new BizError('域名无效', 400);
			}
			chosenDomain = d;
		} else {
			const mainEmail = accounts[0].email || '';
			chosenDomain = '@' + mainEmail.split('@').slice(1).join('@').toLowerCase();
			if (!domains.includes(chosenDomain)) {
				throw new BizError('域名无效', 400);
			}
		}
		// 域名权限：用户角色须有该域的使用权。
		const roleRow = await roleService.selectByUserId(c, userId);
		if (roleRow && !roleService.hasAvailDomainPerm(roleRow.availDomain, 'x' + chosenDomain)) {
			throw new BizError('没有该域名的使用权限', 403);
		}
		// 随机前缀撞库重试（地址全局唯一约束兜底）。
		for (let attempt = 0; attempt < 5; attempt++) {
			const localPart = randomLocalPart();
			const address = `${localPart}${chosenDomain}`;
			try {
				// .returning().get() 返回单行对象（不是数组），不要解构。
				const row = await orm(c).insert(emailAlias).values({
					userId,
					accountId: accounts[0].accountId,
					localPart,
					domain: chosenDomain,
					address,
					status: 0,
					recvCount: 0
				}).returning().get();
				return {
					aliasId: row.aliasId,
					address: row.address,
					status: row.status,
					recvCount: row.recvCount,
					createTime: row.createTime
				};
			} catch (e) {
				if (!String(e?.message || '').includes('UNIQUE')) {
					throw e;
				}
			}
		}
		throw new BizError('别名生成失败，请重试', 500);
	},

	// 停用 / 启用（仅本人）。
	// 诱饵会话（v3_16DB）：别名不存在（不透露真实别名）。
	async setStatus(c, userId, aliasId, status) {
		if (userContext.isDecoy(c)) {
			throw new BizError('别名不存在', 404);
		}
		if (status !== 0 && status !== 1) {
			throw new BizError('状态无效', 400);
		}
		const row = await orm(c).select().from(emailAlias)
			.where(and(
				eq(emailAlias.aliasId, Number(aliasId)),
				eq(emailAlias.userId, userId),
				eq(emailAlias.isDel, 0)
			)).get();
		if (!row) {
			throw new BizError('别名不存在', 404);
		}
		await orm(c).update(emailAlias).set({ status })
			.where(eq(emailAlias.aliasId, Number(aliasId))).run();
		return { aliasId: Number(aliasId), status };
	},

	// 删除（软删，仅本人）。
	// 诱饵会话（v3_16DB）：别名不存在（不透露真实别名）。
	async remove(c, userId, aliasId) {
		if (userContext.isDecoy(c)) {
			throw new BizError('别名不存在', 404);
		}
		const row = await orm(c).select().from(emailAlias)
			.where(and(
				eq(emailAlias.aliasId, Number(aliasId)),
				eq(emailAlias.userId, userId),
				eq(emailAlias.isDel, 0)
			)).get();
		if (!row) {
			throw new BizError('别名不存在', 404);
		}
		await orm(c).update(emailAlias).set({ isDel: 1 })
			.where(eq(emailAlias.aliasId, Number(aliasId))).run();
		return { aliasId: Number(aliasId) };
	},

	// 收信路由：按完整地址找别名（大小写不敏感）。返回 { alias, account } 或 null。
	// 停用的别名也返回（调用方据此拒收，而不是当成“查无此人”）。
	async resolveAlias(c, address) {
		const addr = String(address || '').trim().toLowerCase();
		if (!addr) {
			return null;
		}
		const alias = await orm(c).select().from(emailAlias)
			.where(and(
				sql`${emailAlias.address} COLLATE NOCASE = ${addr}`,
				eq(emailAlias.isDel, 0)
			)).get();
		if (!alias) {
			return null;
		}
		const acc = await orm(c).select().from(account)
			.where(eq(account.accountId, alias.accountId)).get();
		if (!acc || acc.isDel) {
			return null;
		}
		return { alias, account: acc };
	},

	// 收信计数（投递成功后调，best-effort）。
	async incrementRecv(c, aliasId) {
		try {
			await orm(c).update(emailAlias)
				.set({ recvCount: sql`${emailAlias.recvCount} + 1` })
				.where(eq(emailAlias.aliasId, Number(aliasId))).run();
		} catch (e) {
			console.error('别名收信计数失败:', e.message);
		}
	}
};

export default aliasService;
