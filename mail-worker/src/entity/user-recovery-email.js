import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
// Phase 8 F：备用邮箱（可选填，用于收恢复链接）。一用户一行；
// verified 预留（备用邮箱验证邮件待总协调确认系统发信身份后接）。
export const userRecoveryEmail = sqliteTable('user_recovery_email', {
	userId: integer('user_id').primaryKey(),
	backupEmail: text('backup_email').notNull().default(''),
	verified: integer('verified').notNull().default(0),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`)
});
export default userRecoveryEmail
