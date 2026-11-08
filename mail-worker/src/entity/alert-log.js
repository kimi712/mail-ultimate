import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const alertLog = sqliteTable('alert_log', {
	logId: integer('log_id').primaryKey({ autoIncrement: true }),
	type: text('type').notNull().default('system'),
	text: text('text').notNull().default(''),
	source: text('source').notNull().default('worker'),
	createTime: text('create_time').notNull().default(sql`CURRENT_TIMESTAMP`)
});
export default alertLog
