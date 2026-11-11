import orm from '../entity/orm';
import email from '../entity/email';
import user from '../entity/user';
import settingService from './setting-service';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
dayjs.extend(utc);
dayjs.extend(timezone);
import { eq, and, ne } from 'drizzle-orm';
import jwtUtils from '../utils/jwt-utils';
import emailMsgTemplate from '../template/email-msg';
import emailTextTemplate from '../template/email-text';
import emailHtmlTemplate from '../template/email-html';
import verifyUtils from '../utils/verify-utils';
import domainUtils from "../utils/domain-uitls";
import alertLogService from './alert-log-service';
import BizError from '../error/biz-error';

const TG_API_TIMEOUT_MS = 15000;
const TG_BIND_CODE_EXPIRE_MINUTES = 10;

const telegramService = {

	async getEmailContent(c, params) {

		const { token } = params

		const result = await jwtUtils.verifyToken(c, token);

		if (!result) {
			return emailTextTemplate('Access denied')
		}

		const emailRow = await orm(c).select().from(email).where(eq(email.emailId, result.emailId)).get();

		if (emailRow) {

			if (emailRow.content) {
				const { r2Domain } = await settingService.query(c);
				return emailHtmlTemplate(emailRow.content || '', r2Domain)
			} else {
				return emailTextTemplate(emailRow.text || '')
			}

		} else {
			return emailTextTemplate('The email does not exist')
		}

	},

	// 通用 TG 告警（Phase 1 C 路）：复用 tgBotToken / tgChatId（逗号分隔多人）。
	// Phase 2–4：第三参数 type 写入 alert_log（circuit | quota | reg-key | patrol | waf | system）；
	// 无 TG 配置时只写库不发 TG；fetch 失败只 console.error，永不抛错，不得影响主流程。
	async sendAlert(c, text, type = 'system') {
		// 先写库（best-effort；表未迁移时只记日志，不阻断 TG 发送）。
		try {
			await alertLogService.record(c, { type, text, source: 'worker' });
		} catch (e) {
			console.error('写告警日志失败:', e.message);
		}
		try {
			const { tgBotToken, tgChatId } = await settingService.query(c);

			if (!tgBotToken || !tgChatId) {
				return;
			}

			const tgChatIds = tgChatId.split(',').map(chatId => chatId.trim()).filter(Boolean);

			if (!tgChatIds.length) {
				return;
			}

			await Promise.all(tgChatIds.map(async chatId => {
				try {
					const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json'
						},
						body: JSON.stringify({
							chat_id: chatId,
							text
						}),
						signal: AbortSignal.timeout(TG_API_TIMEOUT_MS)
					});
					if (!res.ok) {
						console.error(`发送 Telegram 告警失败 status: ${res.status} response: ${await res.text()}`);
					}
				} catch (e) {
					console.error(`发送 Telegram 告警失败:`, e.message);
				}
			}));
		} catch (e) {
			console.error('发送 Telegram 告警失败:', e.message);
		}
	},

	// 给单个 chat 发一条纯文本消息（管理员登录提醒用）。
	// 未配机器人 token 或无 chat id 时直接返回 false；fetch 失败只记日志，
	// 永不抛错，不得影响主流程。
	async sendMessageToChat(c, chatId, text) {
		const { tgBotToken } = await settingService.query(c);
		if (!tgBotToken || !chatId) {
			return false;
		}
		try {
			const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					chat_id: String(chatId),
					text
				}),
				signal: AbortSignal.timeout(TG_API_TIMEOUT_MS)
			});
			if (!res.ok) {
				console.error(`发送 Telegram 消息失败 status: ${res.status} response: ${await res.text()}`);
				return false;
			}
			return true;
		} catch (e) {
			console.error('发送 Telegram 消息失败:', e.message);
			return false;
		}
	},

	// 内部：给单个 chat 发一条邮件通知（复用邮件 TG 模板 + View 按钮 + 验证码复制按钮）。
	// 失败只记日志，永不抛错，不得影响收信主流程。
	async sendEmailToChat(c, emailRow, chatId, settings) {
		const { tgBotToken, customDomain, tgMsgTo, tgMsgFrom, tgMsgText } = settings;

		if (!tgBotToken || !chatId) {
			return;
		}

		const jwtToken = await jwtUtils.generateToken(c, { emailId: emailRow.emailId })

		const webAppUrl = customDomain ? `${domainUtils.toOssDomain(customDomain)}/api/telegram/getEmail/${jwtToken}` : 'https://www.cloudflare.com/404'
		const inlineKeyboard = [
			[
				{
					text: 'View',
					web_app: { url: webAppUrl }
				}
			]
		];

		if (emailRow.code) {
			inlineKeyboard.push([
				{
					text: emailRow.code,
					copy_text: { text: emailRow.code }
				}
			]);
		}

		try {
			const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					chat_id: String(chatId),
					parse_mode: 'HTML',
					text: emailMsgTemplate(emailRow, tgMsgTo, tgMsgFrom, tgMsgText),
					reply_markup: {
						inline_keyboard: inlineKeyboard
					}
				}),
				signal: AbortSignal.timeout(TG_API_TIMEOUT_MS)
			});
			if (!res.ok) {
				console.error(`转发 Telegram 失败 status: ${res.status} response: ${await res.text()}`);
			}
		} catch (e) {
			console.error(`转发 Telegram 失败:`, e.message);
		}
	},

	// 站长转发（原有行为不变）：发给系统设置里配的 tgChatId（逗号分隔多人）。
	async sendEmailToBot(c, email) {
		const settings = await settingService.query(c);
		const tgChatIds = (settings.tgChatId || '').split(',').map(chatId => chatId.trim()).filter(Boolean);
		await Promise.all(tgChatIds.map(chatId => telegramService.sendEmailToChat(c, email, chatId, settings)));
	},

	// 用户自助绑定推送：发给该用户自己绑定的 chat id。
	async sendEmailToUser(c, email, chatId) {
		const settings = await settingService.query(c);
		await telegramService.sendEmailToChat(c, email, chatId, settings);
	},

	// 机器人用户名（供绑定链接 t.me/<username>?start=<code> 用）；拿不到返回 null。
	async getBotUsername(c) {
		const { tgBotToken } = await settingService.query(c);
		if (!tgBotToken) {
			return null;
		}
		try {
			const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/getMe`, {
				signal: AbortSignal.timeout(TG_API_TIMEOUT_MS)
			});
			if (!res.ok) {
				return null;
			}
			const data = await res.json();
			return data?.result?.username || null;
		} catch (e) {
			console.error('获取 Telegram 机器人用户名失败:', e.message);
			return null;
		}
	},

	// 生成一次性绑定码（16 位 URL 安全随机串，10 分钟有效），只写给本人。
	// 返回 { code, expiresAt }；调用方负责把码展示给用户。
	generateBindCode() {
		const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		let code = '';
		for (const b of bytes) {
			code += chars[b % chars.length];
		}
		const expiresAt = new Date(Date.now() + TG_BIND_CODE_EXPIRE_MINUTES * 60 * 1000).toISOString();
		return { code, expiresAt };
	},

	// Telegram webhook 处理：只认 /start <绑定码>，核对通过后把该 chat id 写进对应用户。
	// TG 要求 webhook 尽快返回 200，本函数永不抛错；回复失败也不影响绑定结果。
	async handleWebhookUpdate(c, update) {
		try {
			const msg = update?.message;
			const chatId = msg?.chat?.id;
			const text = (msg?.text || '').trim();
			if (!chatId || !text) {
				return;
			}

			const { tgBotToken } = await settingService.query(c);
			const reply = async (replyText) => {
				if (!tgBotToken) {
					return;
				}
				try {
					await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ chat_id: chatId, text: replyText }),
						signal: AbortSignal.timeout(TG_API_TIMEOUT_MS)
					});
				} catch (e) {
					console.error('回复 Telegram 失败:', e.message);
				}
			};

			// 只处理 /start；其它消息不回复，避免机器人被当成聊天对象滥用。
			if (!text.startsWith('/start')) {
				return;
			}
			const code = text.slice('/start'.length).trim();
			if (!code) {
				await reply('请先在邮箱设置页点「绑定 Telegram」，再点链接回来完成绑定。');
				return;
			}

			const row = await orm(c).select().from(user).where(eq(user.tgBindCode, code)).get();
			if (!row || !row.tgBindExpires) {
				await reply('绑定码无效，请在邮箱设置页重新生成绑定链接。');
				return;
			}
			if (new Date(row.tgBindExpires).getTime() <= Date.now()) {
				// 过期码清理，避免一直占着。
				await orm(c).update(user).set({ tgBindCode: '', tgBindExpires: '' }).where(eq(user.userId, row.userId)).run();
				await reply('绑定码已过期（10 分钟有效），请在邮箱设置页重新生成绑定链接。');
				return;
			}

			// 同一个 TG 账号只绑一个邮箱账号：先解掉别人身上的同一 chat id。
			await orm(c).update(user).set({ tgChatId: '' })
				.where(and(eq(user.tgChatId, String(chatId)), ne(user.userId, row.userId))).run();
			await orm(c).update(user).set({ tgChatId: String(chatId), tgBindCode: '', tgBindExpires: '' })
				.where(eq(user.userId, row.userId)).run();
			await reply(`绑定成功！新邮件会第一时间推送到这里。\n邮箱：${row.email}`);
		} catch (e) {
			console.error('处理 Telegram webhook 失败:', e.message);
		}
	},

	// 把 webhook 指到本站域名（供管理员在部署后调用；域名取系统设置的 customDomain，
	// 未配则取 env.domain 第一个）。返回 Telegram 实际指向的 URL。
	async setWebhook(c) {
		const { tgBotToken, customDomain } = await settingService.query(c);
		if (!tgBotToken) {
			throw new BizError('未配置 Telegram 机器人 token');
		}
		let domain = (customDomain || '').trim();
		if (!domain) {
			const domainList = c.env.domain;
			const first = Array.isArray(domainList) ? domainList[0] : null;
			if (!first) {
				throw new BizError('未配置域名');
			}
			domain = first;
		}
		const url = `${domainUtils.toOssDomain(domain)}/api/telegram/webhook`;
		const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/setWebhook`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ url }),
			signal: AbortSignal.timeout(TG_API_TIMEOUT_MS)
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok || !data.ok) {
			throw new BizError(`设置 Telegram webhook 失败：${data.description || res.status}`);
		}
		return { url };
	}

}

export default telegramService
