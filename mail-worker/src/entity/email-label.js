import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
// Phase 8 F：邮件标签（规则 tag / archive 动作的落地点；本站暂无独立
// 归档文件夹与标签表，归档以 label='archive' 实现，列表页按标签筛即为
// 归档视图）。唯一约束 user_id + email_id + label，防重复打标。
export const emailLabel = sqliteTable('email_label', {
	labelId: integer('label_id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id').notNull(),
	emailId: integer('email_id').notNull(),
	label: text('label').notNull().default(''),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`)
});
export default emailLabel
