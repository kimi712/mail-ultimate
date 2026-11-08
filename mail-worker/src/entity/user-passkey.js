import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
// Phase 6：Passkey / WebAuthn。服务端只存公钥（public_key_jwk 列存 JWK JSON，
// 私钥永不离开用户设备）；counter 用于防重放。
export const userPasskey = sqliteTable('user_passkey', {
	credentialId: text('credential_id').primaryKey(),
	userId: integer('user_id').notNull().default(0),
	publicKeyJwk: text('public_key_jwk').notNull().default(''),
	counter: integer('counter').notNull().default(0),
	transports: text('transports').notNull().default('[]'),
	name: text('name').notNull().default(''),
	createdTime: text('created_time').notNull().default(sql`CURRENT_TIMESTAMP`)
});
export default userPasskey
