import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const auditLog = sqliteTable('audit_log', {
	logId: integer('log_id').primaryKey({ autoIncrement: true }),
	actorUserId: integer('actor_user_id').notNull().default(0),
	action: text('action').notNull().default(''),
	targetType: text('target_type').notNull().default(''),
	targetId: text('target_id').notNull().default(''),
	ip: text('ip').notNull().default(''),
	ua: text('ua').notNull().default(''),
	detail: text('detail').notNull().default(''),
	createTime: text('create_time').notNull().default(sql`CURRENT_TIMESTAMP`)
});
export default auditLog
