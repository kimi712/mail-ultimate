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
	wallpaperTags: text('wallpaper_tags').notNull().default(''),
	// Phase 8 B：密码修改时间（供安全评分算密码年龄；改密路径负责写）
	pwdChangedAt: text('pwd_changed_at'),
	// 用户自助绑定 Telegram（v3_13DB）：绑定的 TG chat id（空 = 未绑定）；
	// tgBindCode 为一次性绑定码（10 分钟有效），tgBindExpires 为过期时间（ISO 字符串，空 = 无有效码）。
	tgChatId: text('tg_chat_id').notNull().default(''),
	tgBindCode: text('tg_bind_code').notNull().default(''),
	tgBindExpires: text('tg_bind_expires').notNull().default(''),
	// 2026-11-12 uwu 第 2 步：E2EE 暴露状态（0=正常/已统一，1=已暴露
	// ——加密密码与登录密码相同、服务端曾可推出邮件密钥，2=老模型未迁移）。
	// 由登录后后台探测（e2ee-migrate.js）写入，供安全中心常驻提示。
	e2eeExposed: integer('e2ee_exposed').default(0).notNull()
});
export default user
