import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
// Phase 8 F：已知 IP（新设备 / 新 IP 提醒用）。用户在站内提醒上点
// “是我本人”后，该 IP 记入本表，此后同 IP 登录不再弹提醒。
// 唯一约束 user_id + ip。
export const knownIp = sqliteTable('known_ip', {
	knownId: integer('known_id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id').notNull(),
	ip: text('ip').notNull().default(''),
	firstSeenAt: text('first_seen_at').notNull().default(sql`CURRENT_TIMESTAMP`),
	lastSeenAt: text('last_seen_at').notNull().default(sql`CURRENT_TIMESTAMP`)
});
export default knownIp
