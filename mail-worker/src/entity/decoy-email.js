import { sqliteTable, text, integer} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// 隐藏邮箱（v3_16DB）：诱饵邮件。
// 诱饵会话的收件箱只读这张表：内容是设置第二密码时播种的、看起来真实的
// 普通邮件（欢迎信、账单、 newsletter 等），绝不含真实邮件的任何内容。
// 明文存放（诱饵本就是假内容，无需加密），与 email 表完全隔离。
export const decoyEmail = sqliteTable('decoy_email', {
	decoyId: integer('decoy_id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id').notNull(),
	sendEmail: text('send_email').notNull().default(''),
	name: text('name').notNull().default(''),
	subject: text('subject').notNull().default(''),
	text: text('text').notNull().default(''),
	content: text('content').notNull().default(''),
	unread: integer('unread').default(1).notNull(),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull()
});
export default decoyEmail
