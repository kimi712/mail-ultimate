import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
// Phase 8 F：邮件规则 / 过滤器。condition_json 与 action_json 以 JSON 文本存，
// 结构由 mail-rule-service.js 校验（条件键白名单 + 动作类型白名单）。
// sort 越小越先执行；enabled 0=停用 1=启用。
export const mailRule = sqliteTable('mail_rules', {
	ruleId: integer('rule_id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id').notNull(),
	name: text('name').notNull().default(''),
	conditionJson: text('condition_json').notNull().default('{}'),
	actionJson: text('action_json').notNull().default('[]'),
	enabled: integer('enabled').notNull().default(1),
	sort: integer('sort').notNull().default(0),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`)
});
export default mailRule
