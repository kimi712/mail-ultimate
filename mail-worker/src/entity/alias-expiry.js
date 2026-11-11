import { sqliteTable, text, integer} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
// 斯诺登第四批 P2-5：别名有效期（新增表，不改 email_alias 原表）。
// alias_expiry 是 email_alias 的附表：aliasId 1 对 1；expiresAt 为
// 别名停止收信的时刻（'YYYY-MM-DD HH:mm:ss' UTC）；行被删 = 不限期。
// 之所以用附表而不是给 email_alias 加 expires_at 列：email_alias 的
// 实体与 init 迁移正由审计员改动，本批不碰其文件；附表由本服务
// ensureTable() 懒创建（CREATE TABLE IF NOT EXISTS），部署时无需
// 额外迁移，旧库直接可用。
export const aliasExpiry = sqliteTable('alias_expiry', {
	aliasId: integer('alias_id').primaryKey(),
	userId: integer('user_id').notNull(),
	expiresAt: text('expires_at').notNull().default(''),
	notified: integer('notified').default(0).notNull(),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull()
});
export default aliasExpiry
