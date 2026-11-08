import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const loginLog = sqliteTable('login_log', {
	logId: integer('log_id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id').notNull().default(0),
	email: text('email').notNull().default(''),
	ip: text('ip').notNull().default(''),
	ua: text('ua').notNull().default(''),
	isNewIp: integer('is_new_ip').notNull().default(0),
	createTime: text('create_time').notNull().default(sql`CURRENT_TIMESTAMP`)
});
export default loginLog
