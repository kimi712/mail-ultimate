import { sqliteTable, text, integer} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// 时间锁加密（v3_16DB）：到时才放行的 CEK 包裹。
// 解锁前 email.cek_wrapped 为空、timelock_until 为解锁时刻；解锁时（读信懒释放
// 或 cron 扫表）把包裹写回 email 行并置 released=1。email_id 与 email 行 1:1。
export const timelockKey = sqliteTable('timelock_key', {
	emailId: integer('email_id').primaryKey(),
	cekWrapped: text('cek_wrapped').notNull().default(''),
	cekAlg: text('cek_alg').notNull().default(''),
	unlockAt: text('unlock_at').notNull().default(''),
	released: integer('released').default(0).notNull()
});
export default timelockKey
