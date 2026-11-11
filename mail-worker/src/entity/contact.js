import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
// Phase 8 F：联系人 / 通讯录。唯一约束 user_id + email（DDL 见汇报，
// 由总协调并进 v3_11DB 迁移；唯一约束同时防并发重复写入）。
export const contact = sqliteTable('contacts', {
	contactId: integer('contact_id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id').notNull(),
	name: text('name').notNull().default(''),
	email: text('email').notNull().default(''),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`)
});
export default contact
