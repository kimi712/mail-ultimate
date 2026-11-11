import { sqliteTable, text, integer} from 'drizzle-orm/sqlite-core';

// 可搜索加密（v3_16DB）：盲索引。
// token = HMAC(用户 KEK, 归一化关键词)，服务端只按 (user_id, token) 匹配
// email_id，永远看不到关键词明文与正文。同一封信收发双方各用自己的 KEK
// 建索引（行按 user_id 区分），互不干扰。
export const emailBlindIndex = sqliteTable('email_blind_index', {
	emailId: integer('email_id').notNull(),
	userId: integer('user_id').notNull(),
	token: text('token').notNull()
});
export default emailBlindIndex
