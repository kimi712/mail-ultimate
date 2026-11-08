import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const registerLog = sqliteTable('register_log', {
	logId: integer('log_id').primaryKey({ autoIncrement: true }),
	ip: text('ip').notNull().default(''),
	ipSegment: text('ip_segment').notNull().default(''),
	email: text('email').notNull().default(''),
	regKeyCode: text('reg_key_code').notNull().default(''),
	result: integer('result').notNull().default(0),
	failReason: text('fail_reason').notNull().default(''),
	verifyMode: integer('verify_mode').notNull().default(0),
	ua: text('ua').notNull().default(''),
	createTime: text('create_time').notNull().default(sql`CURRENT_TIMESTAMP`)
});
export default registerLog
