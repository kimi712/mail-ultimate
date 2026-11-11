import { sqliteTable, text, integer} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
// 一次性别名邮箱（v3_14DB）：用户生成的随机前缀地址，别名收到的信进主收件箱。
// address 全局唯一；status 0=启用 / 1=停用（停用后往该别名发信直接拒收）；
// recvCount 为该别名累计收信数；alias 不存主邮箱，映射只在服务端维护。
export const emailAlias = sqliteTable('email_alias', {
	aliasId: integer('alias_id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id').notNull(),
	accountId: integer('account_id').notNull(),
	localPart: text('local_part').notNull(),
	domain: text('domain').notNull(),
	address: text('address').notNull(),
	status: integer('status').default(0).notNull(),
	recvCount: integer('recv_count').default(0).notNull(),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull(),
	isDel: integer('is_del').default(0).notNull()
});
export default emailAlias
