import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
// Phase 6：个性化安全中心（每用户自调）。login_alert 默认 1（异地提醒开）；
// e2ee_enabled 默认 0；retention_days 默认 0（永久保留），只接受 0/30/90/365；
// e2ee_salt 为 E2EE 密钥派生盐（前端生成，随 POST /my/security 保存）。
export const userSecurity = sqliteTable('user_security', {
	userId: integer('user_id').primaryKey(),
	loginAlert: integer('login_alert').notNull().default(1),
	e2eeEnabled: integer('e2ee_enabled').notNull().default(0),
	retentionDays: integer('retention_days').notNull().default(0),
	e2eeSalt: text('e2ee_salt').notNull().default(''),
	// Phase 7：闲置自动锁定分钟数（0=从不，5/15/30）。
	autoLockMinutes: integer('auto_lock_minutes').notNull().default(0),
	createdTime: text('created_time').notNull().default(sql`CURRENT_TIMESTAMP`)
});
export default userSecurity
