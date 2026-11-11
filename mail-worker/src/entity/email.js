import { sqliteTable, text, integer} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const email = sqliteTable('email', {
	emailId: integer('email_id').primaryKey({ autoIncrement: true }),
	sendEmail: text('send_email'),
	name: text('name'),
	senderEmail: text('sender_email').default('').notNull(),
	accountId: integer('account_id').notNull(),
	userId: integer('user_id').notNull(),
	subject: text('subject'),
	code: text('code').default('').notNull(),
	text: text('text'),
	content: text('content'),
	cc: text('cc').default('[]'),
	bcc: text('bcc').default('[]'),
	recipient: text('recipient'),
	toEmail: text('to_email').default('').notNull(),
	toName: text('to_name').default('').notNull(),
	inReplyTo: text('in_reply_to').default(''),
	relation: text('relation').default(''),
	messageId: text('message_id').default(''),
	type: integer('type').default(0).notNull(),
	status: integer('status').default(0).notNull(),
	resendEmailId: text('resend_email_id'),
	message: text('message'),
	unread: integer('unread').default(0).notNull(),
	// Phase 6：端到端加密标记（1 = 内容由客户端加密后上传，服务端不解密）
	e2ee: integer('e2ee').default(0).notNull(),
	// 发件人隐身（v3_15DB）：密封发件人信封 `sealed:v1:<base64(iv||ct)>`，正文密钥（CEK）
	// 加密的发件人 JSON {email, name}；密封收件行的 send_email/name 为空时用它恢复发件人。
	sealedSender: text('sealed_sender').notNull().default(''),
	// 前向保密 + 抗量子（v3_15DB）：按收件人包裹的一次性内容密钥（CEK）。
	// cekAlg：''=旧版（无 CEK，正文直接用 KEK 加密）；'sym'=CEK 经发送方 KEK 对称包裹
	// （信封 e2ee:v1:）；'mlkem768'=CEK 经收件人 ML-KEM-768 公钥包裹（信封 pq:v1:）。
	cekWrapped: text('cek_wrapped').notNull().default(''),
	cekAlg: text('cek_alg').notNull().default(''),
	// 正文信封版本（v3_15DB）：1=旧版（正文直接用 KEK 加密）；2=正文用 CEK 加密，
	// 读信时先按 cekAlg 解出 CEK 再解密正文。
	e2eeVer: integer('e2ee_ver').default(1).notNull(),
	// 自毁邮件（v3_14DB）：expireAt 为自毁时间（'YYYY-MM-DD HH:mm:ss' UTC，空 = 不过期）；
	// burnAfterRead=1 时收件人打开一次即删；expireGroup 为同封信收发两端共用的组标识，
	// 阅后即焚时按组删（收件人收件箱 + 发件人已发送一起删）。
	expireAt: text('expire_at').notNull().default(''),
	burnAfterRead: integer('burn_after_read').default(0).notNull(),
	expireGroup: text('expire_group').notNull().default(''),
	// 邮件混淆（v3_16DB）：站内投递生效时间（'YYYY-MM-DD HH:mm:ss' UTC，空 = 不混淆，
	// 立即投递）；mixRelay 为逻辑中继编号（R1–R5，仅站内时序混淆，不是 Tor）；
	// mixNotified=1 表示生效后转发/规则已补跑。
	mixDeliverAt: text('mix_deliver_at').notNull().default(''),
	mixRelay: text('mix_relay').notNull().default(''),
	mixNotified: integer('mix_notified').default(0).notNull(),
	// 时间锁加密（v3_16DB）：解锁时刻（'YYYY-MM-DD HH:mm:ss' UTC，空 = 不锁）；
	// 解锁前 CEK 包裹存在 timelock_key 表里，email.cek_wrapped 为空，读信解不开。
	timelockUntil: text('timelock_until').notNull().default(''),
	// 可否认认证（v3_16DB）：deniable=1 时正文另附 CEK 对密文的 HMAC 标签
	// （denyTag）；收件人同样持有 CEK，第三方无法证明是发件人还是收件人造的。
	deniable: integer('deniable').default(0).notNull(),
	denyTag: text('deny_tag').notNull().default(''),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull(),
	isDel: integer('is_del').default(0).notNull()
});
export default email
