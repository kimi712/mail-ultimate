import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Phase 8（AI 助手多轮对话历史）：ai_chat 表。
// user_id + role（'user' | 'assistant'）+ content + created_at。
// 默认只保留 30 天（assistant-service.chat 每次调用时顺手清理过期行，
// 再由日志清理任务兜底）；用户可在助手面板一键清空（DELETE 本人全部行）。
// 对话内容默认不用于训练、不出本站；本表不存任何邮件正文以外的用户隐私
// 之外的东西——只存对话本身。
export const aiChat = sqliteTable('ai_chat', {
	chatId: integer('chat_id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id').notNull(),
	role: text('role').notNull(),
	content: text('content').notNull().default(''),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull()
});
export default aiChat;
