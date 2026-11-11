import { getTableColumns, sql } from 'drizzle-orm';
import email from '../entity/email';

export const EMAIL_LIST_TEXT_LEN = 300;

/** 去掉换行/回车/制表符，并压缩连续空格、标签间空白 */
function sqlStripWhitespace(column) {
	return sql`trim(replace(replace(replace(replace(replace(replace(
		coalesce(${column}, ''),
		char(13), ''),
		char(10), ''),
		char(9), ' '),
		'  ', ' '),
		'  ', ' '),
		'> <', '><'))`;
}

/** 完整查询：全部字段 */
export const emailListColumns = getTableColumns(email);

/** 摘要查询：列表 + 详情头部；有 text 则不读 content，没有才查 content（去空白），响应里不返回 content */
export const emailBriefColumns = {
	emailId: email.emailId,
	sendEmail: email.sendEmail,
	name: email.name,
	subject: email.subject,
	code: email.code,
	recipient: email.recipient,
	toEmail: email.toEmail,
	type: email.type,
	status: email.status,
	message: email.message,
	unread: email.unread,
	createTime: email.createTime,
	isDel: email.isDel,
	// 自毁邮件：列表页展示自毁标签与过期判断用（只传元数据，不含内容）。
	expireAt: email.expireAt,
	burnAfterRead: email.burnAfterRead,
	// Phase 7：列表页端到端加密徽标用（只传 0/1 标志，不含任何内容）。
	e2ee: email.e2ee,
	// 斯诺登第二批（v3_15DB）：发件人隐身 + 前向保密/抗量子。
	// sealedSender 为密封发件人信封（密文），cekWrapped 为按收件人包裹的一次性密钥
	// （密文），cekAlg 标明包裹算法；三者皆为密文/算法名，不含明文内容，列表页可安全
	// 返回，供前端在 E2EE 解锁后解密出真实发件人。
	sealedSender: email.sealedSender,
	cekWrapped: email.cekWrapped,
	cekAlg: email.cekAlg,
	e2eeVer: email.e2eeVer,
	// 斯诺登第三批（v3_16DB）：混淆投递/时间锁/可否认标记（只传元数据，不含密钥）。
	// mixDeliverAt 为投递生效时间（未来 = 尚未投递，前端不展示）；timelockUntil
	// 为解锁时刻（未来 = 内容未解锁，前端显示倒计时）；deniable 为可否认标记，
	// denyTag 为 CEK 对密文的 HMAC 标签（可验证、不可归因）。
	mixDeliverAt: email.mixDeliverAt,
	mixRelay: email.mixRelay,
	timelockUntil: email.timelockUntil,
	deniable: email.deniable,
	denyTag: email.denyTag,
	content: sql`CASE WHEN trim(coalesce(${email.text}, '')) != '' THEN NULL ELSE ${sqlStripWhitespace(email.content)} END`.as('content'),
	text: sql`substr(coalesce(${email.text}, ''), 1, ${EMAIL_LIST_TEXT_LEN})`.as('text'),
};
