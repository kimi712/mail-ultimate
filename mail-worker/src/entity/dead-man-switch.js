import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
// 死亡开关（v3_15DB）：每用户一行。用户自选失联期限（30/60/90 天）与触发动作：
// 'delete' = 删除全部邮件与账号数据（走 physicsDelete）；'notify' = 把指定内容发给指定联系人。
// 安全规则（防误触发）：
// - 提醒：失联满（期限 - 7 天）时发提醒邮件给用户本人，warned_at 留痕；
// - 执行：仅当已提醒（warned_at 非空）且提醒已发出满 7 天且仍失联满期限时才执行；
// - 取消：任意一次登录/活动都会刷新 user.active_time，失联天数归零，自动取消待执行；
//   用户也可在设置页随时关闭。
// status：'off' 未启用 / 'armed' 已布防 / 'warned' 已提醒待执行 / 'executed' 已执行。
export const deadManSwitch = sqliteTable('dead_man_switch', {
	userId: integer('user_id').primaryKey(),
	enabled: integer('enabled').notNull().default(0),
	inactivityDays: integer('inactivity_days').notNull().default(90),
	action: text('action').notNull().default('delete'),
	contactEmail: text('contact_email').notNull().default(''),
	message: text('message').notNull().default(''),
	warnedAt: text('warned_at').notNull().default(''),
	executedAt: text('executed_at').notNull().default(''),
	status: text('status').notNull().default('off'),
	createTime: text('create_time').notNull().default(sql`CURRENT_TIMESTAMP`),
	updateTime: text('update_time').notNull().default(sql`CURRENT_TIMESTAMP`)
});
export default deadManSwitch
