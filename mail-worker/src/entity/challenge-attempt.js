import { sqliteTable, text, integer} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
// $1000 安全悬赏挑战：尝试计数表（最小数据原则）。
// 只存 SHA-256 摘要 + 回执 id + 提交时间，绝不存暗号原文与方法原文。
export const challengeAttempt = sqliteTable('challenge_attempt', {
	attemptId: integer('attempt_id').primaryKey({ autoIncrement: true }),
	// sha256(phrase) hex
	phraseHash: text('phrase_hash').notNull().default(''),
	// sha256(method) hex
	methodHash: text('method_hash').notNull().default(''),
	// 回执 id（crypto.randomUUID）
	receiptId: text('receipt_id').notNull().default(''),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull()
});
export default challengeAttempt
