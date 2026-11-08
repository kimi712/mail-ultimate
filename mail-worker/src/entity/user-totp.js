import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
// Phase 6：TOTP 二次验证。secret_encrypted 为字段加密后的 base32 密钥
// （无 field_enc_key 时存明文，见 field-crypto.js）；backup_codes_hash 存
// 10 个一次性备份码的 SHA-256 hex 数组 JSON。
export const userTotp = sqliteTable('user_totp', {
	userId: integer('user_id').primaryKey(),
	secretEncrypted: text('secret_encrypted').notNull().default(''),
	enabled: integer('enabled').notNull().default(0),
	backupCodesHash: text('backup_codes_hash').notNull().default('[]'),
	createdTime: text('created_time').notNull().default(sql`CURRENT_TIMESTAMP`)
});
export default userTotp
