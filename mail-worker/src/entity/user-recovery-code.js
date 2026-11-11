import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
// Phase 8 F：账号恢复码。只存 SHA-256 哈希（code_hash），明文永不存库、
// 不记日志；恢复码只显示一次。used=1 后不可再用；重新生成时旧码全部作废。
export const userRecoveryCode = sqliteTable('user_recovery_code', {
	codeId: integer('code_id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id').notNull(),
	codeHash: text('code_hash').notNull().default(''),
	used: integer('used').notNull().default(0),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
	usedAt: text('used_at')
});
export default userRecoveryCode
