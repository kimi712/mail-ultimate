// Phase 8 F：联系人 / 通讯录（只查本人联系人）。
// 来源：手动添加、从往来邮件一键添加；写信时收件人自动补全调 suggest。
import orm from '../entity/orm';
import contact from '../entity/contact';
import email from '../entity/email';
import emailService from './email-service';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';
import { and, desc, eq, like, or } from 'drizzle-orm';
import userContext from '../security/user-context';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const contactService = {

	// 手动添加。邮箱归一化（去空格 + 小写）；同用户同邮箱重复时报友好错
	// （DB 唯一约束 user_id + email 是最后一道防线）。
	async add(c, userId, { name = '', email: rawEmail = '' } = {}) {
		const emailValue = String(rawEmail || '').trim().toLowerCase();
		if (!EMAIL_RE.test(emailValue)) {
			throw new BizError(t('contactEmailInvalid'), 400);
		}
		// 诱饵会话（v3_16DB）：假装添加成功，实际不写库（诱饵里看不到真实联系人，
		// 也不把诱饵操作写进真实通讯录）。
		if (userContext.isDecoy(c)) {
			const displayName = String(name || '').trim().slice(0, 100) || emailValue.split('@')[0];
			return { contactId: 0, userId, name: displayName, email: emailValue };
		}
		const displayName = String(name || '').trim().slice(0, 100) || emailValue.split('@')[0];
		const existing = await orm(c).select().from(contact)
			.where(and(eq(contact.userId, userId), eq(contact.email, emailValue))).get();
		if (existing) {
			throw new BizError(t('contactExists'), 400);
		}
		try {
			const { contactId } = await orm(c).insert(contact).values({
				userId, name: displayName, email: emailValue
			}).returning().get();
			return { contactId, userId, name: displayName, email: emailValue };
		} catch (e) {
			// 并发重复写入撞上唯一约束时，转友好错误（不把 DB 原文抛给前端）。
			if (String(e.message || '').includes('UNIQUE')) {
				throw new BizError(t('contactExists'), 400);
			}
			throw e;
		}
	},

	// 从一封往来邮件一键加联系人：收信取发件人（senderEmail/name），
	// 发信取收件人（toEmail/toName）。邮件须属于本人；已存在时返回
	// { added: false, contact }（一键添加是幂等的，不报错）。
	async addFromEmail(c, userId, emailId) {
		const row = await emailService.selectById(c, Number(emailId));
		if (!row || row.userId !== userId) {
			throw new BizError(t('contactEmailNotFound'), 404);
		}
		const isReceived = Number(row.type) === 0;
		const targetEmail = isReceived ? (row.senderEmail || '') : (row.toEmail || '');
		const targetName = isReceived ? (row.name || '') : (row.toName || '');
		if (!EMAIL_RE.test(String(targetEmail).trim().toLowerCase())) {
			throw new BizError(t('contactEmailInvalid'), 400);
		}
		const emailValue = String(targetEmail).trim().toLowerCase();
		const existing = await orm(c).select().from(contact)
			.where(and(eq(contact.userId, userId), eq(contact.email, emailValue))).get();
		if (existing) {
			return { added: false, contact: existing };
		}
		const created = await this.add(c, userId, { name: targetName, email: emailValue });
		return { added: true, contact: created };
	},

	// 列表 + 搜索（name / email 模糊匹配，只查本人）。
	async list(c, userId, { q = '', num = 1, size = 20 } = {}) {
		// 诱饵会话（v3_16DB）：联系人列表为空（诱饵里看不到真实联系人）。
		if (userContext.isDecoy(c)) {
			return { list: [], total: 0 };
		}
		num = Number(num) || 1;
		size = Number(size) || 20;
		if (size > 100) size = 100;
		const keyword = String(q || '').trim();
		const where = keyword
			? and(eq(contact.userId, userId), or(like(contact.name, `%${keyword}%`), like(contact.email, `%${keyword}%`)))
			: eq(contact.userId, userId);
		const list = await orm(c).select().from(contact)
			.where(where).orderBy(desc(contact.contactId)).limit(size).offset((num - 1) * size).all();
		const totalRow = await orm(c).select({ total: contact.contactId }).from(contact).where(where).all();
		return { list, total: totalRow.length };
	},

	// 写信时收件人自动补全：按邮箱/姓名前缀模糊匹配，最多 10 条，
	// 只返回 name + email（不返回无关字段）。
	async suggest(c, userId, q = '') {
		// 诱饵会话（v3_16DB）：不返回真实联系人补全。
		if (userContext.isDecoy(c)) {
			return [];
		}
		const keyword = String(q || '').trim();
		if (!keyword) {
			return [];
		}
		const rows = await orm(c).select().from(contact)
			.where(and(
				eq(contact.userId, userId),
				or(like(contact.name, `%${keyword}%`), like(contact.email, `%${keyword}%`))
			))
			.orderBy(desc(contact.contactId)).limit(10).all();
		return rows.map(r => ({ name: r.name, email: r.email }));
	},

	// 删除（只删本人的行；不存在也返回 ok，不透露他人数据）。
	async remove(c, userId, contactId) {
		// 诱饵会话（v3_16DB）：假装删除成功，实际不动真实通讯录。
		if (userContext.isDecoy(c)) {
			return { ok: true };
		}
		await orm(c).delete(contact)
			.where(and(eq(contact.userId, userId), eq(contact.contactId, Number(contactId)))).run();
		return { ok: true };
	}
};

export default contactService;
