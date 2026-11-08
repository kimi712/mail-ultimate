import { sqliteTable, text, integer} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
const user = sqliteTable('user', {
	userId: integer('user_id').primaryKey({ autoIncrement: true }),
	email: text('email').notNull(),
	type: integer('type').default(1).notNull(),
	password: text('password').notNull(),
	salt: text('salt').notNull(),
	status: integer('status').default(0).notNull(),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`),
	activeTime: text('active_time'),
	createIp: text('create_ip'),
	activeIp: text('active_ip'),
	os: text('os'),
	browser: text('browser'),
	device: text('device'),
	sort: text('sort').default(0),
	sendCount: text('send_count').default(0),
	regKeyId: integer('reg_key_id').default(0).notNull(),
	isDel: integer('is_del').default(0).notNull(),
	// Phase 2–4：用户语言偏好（localStorage 为主，登录后同步到后端；空 = 跟随浏览器/默认中文）
	locale: text('locale').notNull().default(''),
	// Phase 7 壁纸：当前壁纸值（预置 id 或 /oss/wallpapers/... 自定义 URL；空 = 默认 snowden-vista）
	wallpaper: text('wallpaper').notNull().default(''),
	// Phase 7 壁纸：喜好标签，逗号分隔，供“为你推荐”匹配
	wallpaperTags: text('wallpaper_tags').notNull().default('')
});
export default user
