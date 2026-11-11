import PostalMime from 'postal-mime';
import emailService from '../service/email-service';
import accountService from '../service/account-service';
import settingService from '../service/setting-service';
import attService from '../service/att-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { emailConst, isDel, settingConst } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import roleService from '../service/role-service';
import userService from '../service/user-service';
import telegramService from '../service/telegram-service';
import aiService from '../service/ai-service';
import webhookService from '../service/webhook-service';
import mailTrustService from '../service/mail-trust-service';
import aliasService from '../service/alias-service';
// 斯诺登第四批 P2-5：自动过期别名（收信入口拒收已过期别名）。
import aliasExpiryService from '../service/alias-expiry-service';

export async function email(message, env, ctx) {

	try {

		const {
			receive,
			tgChatId,
			tgBotStatus,
			tgUserPush,
			forwardStatus,
			forwardEmail,
			webhookStatus,
			webhookUrl,
			webhookRetry,
			webhookSecret,
			ruleEmail,
			ruleType,
			r2Domain,
			noRecipient,
			blackSubject,
			blackContent,
			blackFrom,
			aiCode,
			aiCodeFilter
		} = await settingService.query({ env });

		if (receive === settingConst.receive.CLOSE) {
			message.setReject('Service suspended');
			return;
		}

		const reader = message.raw.getReader();
		let content = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			content += new TextDecoder().decode(value);
		}

		const email = await PostalMime.parse(content);


		const blockFlag = checkBlock(blackSubject, blackContent, blackFrom, email);

		if (blockFlag) {
			message.setReject('Message rejected');
			return;
		}

		let account = await accountService.selectByEmailIncludeDel({ env: env }, message.to);

		if (!account) {
			const baseEmail = emailUtils.getBaseEmail(message.to);
			if (baseEmail && baseEmail !== message.to) {
				account = await accountService.selectByEmailIncludeDel({ env: env }, baseEmail);
			}
		}

		// 一次性别名：账号匹配不到时按别名找；停用的别名直接拒收（SMTP 层拒绝），
		// 启用的按主人账号收信（收信计数在入库成功后加）。
		let aliasHit = null;
		if (!account) {
			try {
				aliasHit = await aliasService.resolveAlias({ env: env }, message.to);
			} catch (e) {
				console.error('别名解析失败:', e.message);
			}
			if (aliasHit) {
				if (aliasHit.alias.status === 1) {
					message.setReject('Recipient disabled');
					return;
				}
				// 斯诺登第四批 P2-5：已过有效期的别名同样拒收。
				const expiryCheck = await aliasExpiryService.isAliasReceivingBlocked({ env: env }, message.to);
				if (expiryCheck.blocked) {
					message.setReject('Recipient expired');
					return;
				}
				account = aliasHit.account;
			}
		}

		if (!account && noRecipient === settingConst.noRecipient.CLOSE) {
			message.setReject('Recipient not found');
			return;
		}

		let userRow = {}

		if (account) {
			 userRow = await userService.selectByIdIncludeDel({ env: env }, account.userId);
		}

		if (account && userRow.email !== env.admin) {

			let { banEmail, availDomain } = await roleService.selectByUserId({ env: env }, account.userId);

			if (!roleService.hasAvailDomainPerm(availDomain, message.to)) {
				message.setReject('The recipient is not authorized to use this domain.');
				return;
			}

			if(roleService.isBanEmail(banEmail, email.from.address)) {
				message.setReject('The recipient is disabled from receiving emails.');
				return;
			}

		}


		if (!email.to) {
			email.to = [{ address: message.to, name: emailUtils.getName(message.to)}]
		}

		const toName = email.to.find(item => item.address === message.to)?.name || '';
		const code = await aiService.extractCode({ env }, email, { aiCode, aiCodeFilter });
		const fromAddress = email.from?.address || '';

		const params = {
			toEmail: message.to,
			toName: toName,
			sendEmail: fromAddress,
			name: email.from?.name || emailUtils.getName(fromAddress),
			senderEmail: message.from || '',
			subject: email.subject,
			code,
			content: email.html,
			text: email.text,
			cc: email.cc ? JSON.stringify(email.cc) : '[]',
			bcc: email.bcc ? JSON.stringify(email.bcc) : '[]',
			recipient: JSON.stringify(email.to),
			inReplyTo: email.inReplyTo,
			relation: email.references,
			messageId: email.messageId,
			userId: account ? account.userId : 0,
			accountId: account ? account.accountId : 0,
			isDel: isDel.DELETE,
			status: emailConst.status.SAVING
		};

		const attachments = [];
		const cidAttachments = [];

		for (let item of email.attachments) {
			let attachment = { ...item };
			attachment.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(attachment.content) + fileUtils.getExtFileName(item.filename);
			attachment.size = item.content.length ?? item.content.byteLength;
			attachments.push(attachment);
			if (attachment.contentId) {
				cidAttachments.push(attachment);
			}
		}

		// Phase 8 E：把原始认证头传给收信入库，供发件人验证（SPF/DKIM/DMARC）
		// 与一键退订解析；未接线前已入库邮件的验证一律显示“未验证”。
		let emailRow = await emailService.receive({ env }, { ...params, headers: email.headerLines }, cidAttachments, r2Domain);

		attachments.forEach(attachment => {
			attachment.emailId = emailRow.emailId;
			attachment.userId = emailRow.userId;
			attachment.accountId = emailRow.accountId;
		});

		try {
			if (attachments.length > 0) {
				await attService.addAtt({ env }, attachments);
			}
		} catch (e) {
			console.error(e);
		}

		emailRow = await emailService.completeReceive({ env }, account ? emailConst.status.RECEIVE : emailConst.status.NOONE, emailRow.emailId);

		// 一次性别名收信计数（别名投递成功才计）。
		if (aliasHit && account && emailRow.status === emailConst.status.RECEIVE) {
			await aliasService.incrementRecv({ env: env }, aliasHit.alias.aliasId);
		}


		if (ruleType === settingConst.ruleType.RULE) {

			const emails = ruleEmail.split(',');

			if (!emails.includes(message.to)) {
				return;
			}

		}

		//转发到TG
		if (tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {
			await telegramService.sendEmailToBot({ env }, emailRow)
		}

		//用户自助绑定 TG 推送：收件人本人绑了 TG 且站长开启了用户推送时，
		//推一条给该用户本人；失败只记日志，不影响收信入库。
		if (account && tgUserPush === settingConst.tgUserPush.OPEN && userRow.tgChatId && userRow.isDel === isDel.NORMAL) {
			try {
				await telegramService.sendEmailToUser({ env }, emailRow, userRow.tgChatId)
			} catch (e) {
				console.error('用户 TG 推送失败：', e);
			}
		}

		//个人新邮件转发（通知）：收件账号所属用户在偏好里配了 forward_email 时，
		//把原信转发一份到该地址，用户在常用邮箱里就能收到新邮件提醒，不用手动进站查看。
		//只转给收件人本人，不影响其他用户；转发失败只记日志，不影响收信入库。
		if (account) {
			try {
				const prefs = await mailTrustService.getPrefs({ env }, account.userId);
				const forwardTo = (prefs.forwardEmail || '').trim();
				if (forwardTo) {
					await message.forward(forwardTo);
				}
			} catch (e) {
				console.error('个人邮件转发失败：', e);
			}
		}

		//转发到其他邮箱
		if (forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail) {

			const emails = forwardEmail.split(',');

			await Promise.all(emails.map(async email => {

				try {
					await message.forward(email);
				} catch (e) {
					console.error(`转发邮箱 ${email} 失败：`, e);
				}

			}));

		}

		//转发到 Webhook
		if (webhookStatus === settingConst.webhookStatus.OPEN && webhookUrl) {
			await webhookService.sendEmail({ env }, emailRow, webhookUrl, webhookRetry, webhookSecret);
		}

	} catch (e) {
		console.error('邮件接收异常: ', e);
		throw e
	}
}

function checkBlock(blackSubjectStr, blackContentStr, blackFromStr, email) {

	const blackFromList = blackFromStr ? blackFromStr.split(',') : []
	const blackContentList = blackContentStr ? blackContentStr.split(',') : []
	const blackSubjectList = blackSubjectStr ? blackSubjectStr.split(',') : []

	for (const blackSubject of blackSubjectList) {
		if (email.subject?.includes(blackSubject)) {
			return true
		}
	}

	for (const blackContent of blackContentList) {
		if (email.html?.includes(blackContent) || email.text?.includes(blackContent)) {
			return true
		}
	}

	for (const blackFrom of blackFromList) {
		if (email.from.address === blackFrom || emailUtils.getDomain(email.from.address) === blackFrom) {
			return true
		}
	}

	return false

}
