import orm from '../entity/orm';
import ipBlocklist from '../entity/ip-blocklist';
import { eq, and, or, sql } from 'drizzle-orm';
import { ipBlocklistConst } from '../const/entity-const';
import auditLogService from './audit-log-service';
import dayjs from 'dayjs';

// 应用层 IP 黑名单。第二阶段甲骨文巡检的写入口就是 add/remove。
// 检查直接读 D1（§8 坑 2：关键开关不只依赖 KV 缓存）；ip / ip_segment 均有索引。
const ipBlocklistService = {

	async isBlocked(c, ip, ipSegment, scope) {
		try {
			const now = dayjs().format('YYYY-MM-DD HH:mm:ss');
			const row = await orm(c).select().from(ipBlocklist).where(and(
				or(eq(ipBlocklist.ip, ip || ''), eq(ipBlocklist.ipSegment, ipSegment || '')),
				eq(ipBlocklist.scope, scope),
				or(sql`${ipBlocklist.expireTime} IS NULL`, sql`${ipBlocklist.expireTime} > ${now}`)
			)).get();
			return row || null;
		} catch (e) {
			console.error('查 IP 黑名单失败:', e.message);
			return null;
		}
	},

	async add(c, { ip = '', ipSegment = '', scope = ipBlocklistConst.scope.REGISTER, reason = '', expireTime = null, createdBy = '' }) {
		const row = await orm(c).insert(ipBlocklist).values({
			ip, ipSegment, scope, reason, expireTime, createdBy
		}).returning().get();
		await auditLogService.record(c, {
			action: 'ip-block:add',
			targetType: 'ip_blocklist',
			targetId: row.blockId,
			detail: { ip, ipSegment, scope, reason, expireTime }
		});
		return row;
	},

	async remove(c, blockId) {
		const row = await orm(c).select().from(ipBlocklist).where(eq(ipBlocklist.blockId, blockId)).get();
		await orm(c).delete(ipBlocklist).where(eq(ipBlocklist.blockId, blockId)).run();
		await auditLogService.record(c, {
			action: 'ip-block:remove',
			targetType: 'ip_blocklist',
			targetId: blockId,
			detail: row ? { ip: row.ip, ipSegment: row.ipSegment, scope: row.scope } : {}
		});
		return row;
	},

	async list(c, { scope = null, page = 1, size = 20 } = {}) {
		const conditions = [];
		if (scope !== null && scope !== undefined && scope !== '') {
			conditions.push(eq(ipBlocklist.scope, Number(scope)));
		}
		const where = conditions.length ? and(...conditions) : undefined;
		const offset = (page - 1) * size;
		const list = await orm(c).select().from(ipBlocklist)
			.where(where).orderBy(sql`${ipBlocklist.blockId} DESC`).limit(size).offset(offset).all();
		const totalRow = await orm(c).select({ n: sql`COUNT(*)` }).from(ipBlocklist).where(where).get();
		return { list, total: Number(totalRow?.n || 0) };
	}

};

export default ipBlocklistService;
