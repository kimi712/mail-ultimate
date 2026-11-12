import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const registerLog = sqliteTable('register_log', {
	logId: integer('log_id').primaryKey({ autoIncrement: true }),
	ip: text('ip').notNull().default(''),
	ipSegment: text('ip_segment').notNull().default(''),
	// 批量薅号防线（v3_18DB）：注册 IP 所属网段键——v4 为 /24（如 '116.204.166.0'），
	// v6 为 /48（如 '2408:8207:1832'）；由 register-log-service 写入，供段级限流计数。
	// 旧行迁移后为空串，段限流计数时跳过空串，不把历史行算进同一个“空网段”。
	ipSubnet: text('ip_subnet').notNull().default(''),
	email: text('email').notNull().default(''),
	regKeyCode: text('reg_key_code').notNull().default(''),
	result: integer('result').notNull().default(0),
	failReason: text('fail_reason').notNull().default(''),
	verifyMode: integer('verify_mode').notNull().default(0),
	ua: text('ua').notNull().default(''),
	createTime: text('create_time').notNull().default(sql`CURRENT_TIMESTAMP`)
});
export default registerLog
