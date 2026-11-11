import emailUtils from '../utils/email-utils';

const TELEGRAM_MESSAGE_LIMIT = 3500;
const TRUNCATED_SUFFIX = '...';

function escapeHtml(text = '') {
	return text
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function truncateText(text, maxLength) {
	if (!text || text.length <= maxLength) {
		return text || '';
	}

	if (maxLength <= TRUNCATED_SUFFIX.length) {
		return TRUNCATED_SUFFIX.slice(0, maxLength);
	}

	return text.slice(0, maxLength - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX;
}

export default function emailMsgTemplate(email, tgMsgTo, tgMsgFrom, tgMsgText) {

	// 斯诺登第二批（v3_15DB）：发件人隐身的信在落盘记录里没有明文发件人，
	// Telegram 推送不显示真实发件人，只显示占位（真实发件人只在收件人解锁后可见）。
	const sealedFrom = !email.sendEmail && email.sealedSender ? '🔒 Sealed Sender' : '';
	const fromName = email.name || sealedFrom;
	const fromAddr = email.sendEmail || sealedFrom;

	let template = `<b>${escapeHtml(email.subject || '')}</b>`

		if (tgMsgFrom === 'only-name') {
			template += `

From\u200B：${escapeHtml(fromName)}`
		}

		if (tgMsgFrom === 'show') {
			template += `

From\u200B：${escapeHtml(fromName)}  &lt;${escapeHtml(fromAddr)}&gt;`
		}

		if(tgMsgTo === 'show' && tgMsgFrom === 'hide') {
			template += `

To：\u200B${escapeHtml(email.toEmail || '')}`

		} else if(tgMsgTo === 'show') {
		template += `
To：\u200B${escapeHtml(email.toEmail || '')}`
	}

	const text = escapeHtml(emailUtils.formatText(email.text) || emailUtils.htmlToText(email.content));

	if(tgMsgText === 'show') {
		const prefix = `${template}

`;
		const maxTextLength = Math.max(0, TELEGRAM_MESSAGE_LIMIT - prefix.length);
		template += `

${truncateText(text, maxTextLength)}`
	}

	return template;

}
