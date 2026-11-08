import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const ipBlocklist = sqliteTable('ip_blocklist', {
	blockId: integer('block_id').primaryKey({ autoIncrement: true }),
	ip: text('ip').notNull().default(''),
	ipSegment: text('ip_segment').notNull().default(''),
	scope: integer('scope').notNull().default(0),
	reason: text('reason').notNull().default(''),
	expireTime: text('expire_time'),
	createdBy: text('created_by').notNull().default(''),
	createTime: text('create_time').notNull().default(sql`CURRENT_TIMESTAMP`)
});
export default ipBlocklist
