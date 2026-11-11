import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
// Phase 8 F：密码重置 token（备用邮箱恢复链接用）。只存 SHA-256 哈希
// （token_hash），明文只进邮件链接、不存库；有效期 1 小时；一次性，
// 用过即 used=1。
export const passwordResetToken = sqliteTable('password_reset_token', {
	tokenId: integer('token_id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id').notNull(),
	tokenHash: text('token_hash').notNull().default(''),
	expiresAt: text('expires_at').notNull().default(''),
	used: integer('used').notNull().default(0),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
	usedAt: text('used_at')
});
export default passwordResetToken
