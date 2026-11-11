import { sqliteTable, text, integer} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// 胁迫密码 + 隐藏邮箱（v3_16DB）：第二密码。
// passwordHash/salt 与主密码同一算法（SHA-256(salt+password) base64，见
// crypto-utils），但存在独立表、独立 salt，与主密码永不混淆。
// 用第二密码登录时签发 decoy:1 会话，只读 decoy_email 的诱饵邮件；
// seeded=1 表示诱饵邮件已生成过（首次设置时播种）。
export const userDecoy = sqliteTable('user_decoy', {
	userId: integer('user_id').primaryKey(),
	passwordHash: text('password_hash').notNull().default(''),
	salt: text('salt').notNull().default(''),
	enabled: integer('enabled').default(0).notNull(),
	seeded: integer('seeded').default(0).notNull(),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`),
	updateTime: text('update_time').default(sql`CURRENT_TIMESTAMP`)
});
export default userDecoy
