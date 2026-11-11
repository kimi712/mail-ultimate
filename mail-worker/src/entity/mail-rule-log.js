import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
// Phase 8 F：规则执行记录（每条新信命中规则后记一行：规则、邮件、
// 实际执行的动作 JSON）。只作审计/排障用，不含邮件正文。
export const mailRuleLog = sqliteTable('mail_rule_log', {
	logId: integer('log_id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id').notNull(),
	ruleId: integer('rule_id').notNull(),
	emailId: integer('email_id').notNull(),
	actionsJson: text('actions_json').notNull().default('[]'),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`)
});
export default mailRuleLog
