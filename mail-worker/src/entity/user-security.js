import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
// Phase 6：个性化安全中心（每用户自调）。login_alert 默认 1（异地提醒开）；
// e2ee_enabled 默认 0；retention_days 默认 0（永久保留），只接受 0/30/90/365；
// e2ee_salt 为 E2EE 密钥派生盐（前端生成，随 POST /my/security 保存）。
// 抗量子（v3_15DB）：mlkem_public_key 为 ML-KEM-768 封装公钥（可公开，供发件方包裹
// 一次性密钥）；mlkem_priv_enc 为 ML-KEM-768 解封私钥经用户 KEK（加密密码派生密钥）
// 加密后的信封（e2ee:v1:），服务端无法解密，只在本人解锁后由前端取回使用。
export const userSecurity = sqliteTable('user_security', {
	userId: integer('user_id').primaryKey(),
	loginAlert: integer('login_alert').notNull().default(1),
	e2eeEnabled: integer('e2ee_enabled').notNull().default(0),
	retentionDays: integer('retention_days').notNull().default(0),
	e2eeSalt: text('e2ee_salt').notNull().default(''),
	mlkemPublicKey: text('mlkem_public_key').notNull().default(''),
	mlkemPrivEnc: text('mlkem_priv_enc').notNull().default(''),
	// Phase 7：闲置自动锁定分钟数（0=从不，5/15/30）。
	autoLockMinutes: integer('auto_lock_minutes').notNull().default(0),
	createdTime: text('created_time').notNull().default(sql`CURRENT_TIMESTAMP`)
});
export default userSecurity
