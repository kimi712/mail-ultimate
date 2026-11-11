import BizError from '../error/biz-error';
import aiService from './ai-service';
import orm from '../entity/orm';
import aiChat from '../entity/ai-chat';
import { eq, and, desc } from 'drizzle-orm';

// Phase 8：AI 助手（Layer 2 领域服务，邮箱内常驻助手）。
// 能力：可对话（多轮，历史存 ai_chat）、归类（给邮件打标签/分文件夹建议）。
// 写信 / 回信 / 摘要不重复实现——助手 UI 直接调 ai-service 的现有端点
// （/ai/compose|reply|summarize）；翻译走 translation-service。
// 模型客户端统一复用 ai-service 的主备降级（主
// @cf/meta/llama-3.1-8b-instruct-fp8，备 @cf/qwen/qwen3.8-27b，
// 双不可用抛 ai_unavailable）；限额每用户每天 50 次，只在成功返回后计数
// （复用 ai-service._checkQuota / _recordUsage，与 compose/reply/
// summarize 共用同一 KV 计数器）；ai_enabled=0 时全部接口抛 ai_disabled；
// 只读本人未删邮件（复用 ai-service._selectOwnEmail，跨用户/不存在
// 一律 ai_not_found，不区分，不可探查他人邮件）。
// 提示词结构沿用 ai-service.js 的 PROMPTS（按 user.locale 生成，覆盖 8 语种）。
const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_MESSAGES = 20;
const RETENTION_DAYS = 30;

const CHAT_PROMPTS = {
	'zh-CN': {
		chatSystem: '你是一位邮箱内置助手。用中文回答。回答要简洁、准确，只围绕邮件和邮箱使用的问题；不知道就直说不知道，不要编造。不要输出任何与回答无关的解释。',
		triageSystem: '你是一位邮件归类助手。用中文回答。只输出 JSON，不要输出任何其他文字。JSON 格式：{"labels":["标签1","标签2"],"folder":"建议文件夹","reason":"一句话理由"}。标签从以下集合里选（可多选）：工作、财务、账单、订阅、社交、推广、通知、验证码、重要、待办、垃圾。文件夹从以下集合里选一个：inbox、star、archive、trash。',
		triageUser: '请给以下邮件打归类建议：'
	},
	'en': {
		chatSystem: 'You are an in-mailbox assistant. Answer in English. Keep answers short and accurate, only about email and mailbox use; if you do not know, say so — do not invent facts. Do not output anything unrelated to the answer.',
		triageSystem: 'You are an email triage assistant. Answer in English. Output ONLY JSON, no other text. JSON format: {"labels":["label1","label2"],"folder":"suggested folder","reason":"one-sentence reason"}. Pick labels (multiple allowed) from: work, finance, bills, subscriptions, social, promotions, notifications, verification codes, important, todo, spam. Pick exactly one folder from: inbox, star, archive, trash.',
		triageUser: 'Please suggest triage labels for the following email:'
	},
	'ja': {
		chatSystem: 'あなたはメールボックス内蔵アシスタントです。日本語で答えてください。回答は簡潔で正確に、メールとメールボックスの使い方に関するものだけにしてください。分からない場合は分からないと言い、作り話はしないでください。回答と関係のない説明は出力しないでください。',
		triageSystem: 'あなたはメール分類アシスタントです。日本語で答えてください。JSON のみを出力し、他の文字は出力しないでください。JSON 形式：{"labels":["ラベル1","ラベル2"],"folder":"推奨フォルダ","reason":"一文の理由"}。ラベルは次から複数選択：仕事、財務、請求、購読、ソーシャル、プロモーション、通知、認証コード、重要、TODO、迷惑メール。フォルダは次から1つ：inbox、star、archive、trash。',
		triageUser: '以下のメールの分類提案をしてください：'
	},
	'ko': {
		chatSystem: '당신은 메일함 내장 어시스턴트입니다. 한국어로 답하세요. 답변은 간결하고 정확하게, 이메일과 메일함 사용에 관한 것만 다루세요. 모르면 모른다고 말하고 지어내지 마세요. 답변과 무관한 설명은 출력하지 마세요.',
		triageSystem: '당신은 이메일 분류 어시스턴트입니다. 한국어로 답하세요. JSON만 출력하고 다른 텍스트는 출력하지 마세요. JSON 형식: {"labels":["레이블1","레이블2"],"folder":"추천 폴더","reason":"한 문장 이유"}. 레이블은 다음에서 복수 선택: 업무, 금융, 청구서, 구독, 소셜, 프로모션, 알림, 인증 코드, 중요, 할 일, 스팸. 폴더는 다음 중 하나: inbox, star, archive, trash.',
		triageUser: '다음 이메일의 분류 제안을 해 주세요:'
	},
	'vi': {
		chatSystem: 'Bạn là trợ lý tích hợp trong hộp thư. Hãy trả lời bằng tiếng Việt. Câu trả lời ngắn gọn, chính xác, chỉ xoay quanh email và việc dùng hộp thư; không biết thì nói không biết, đừng bịa. Không xuất thêm lời giải thích không liên quan.',
		triageSystem: 'Bạn là trợ lý phân loại email. Hãy trả lời bằng tiếng Việt. Chỉ xuất JSON, không thêm văn bản nào khác. Định dạng JSON: {"labels":["nhãn1","nhãn2"],"folder":"thư mục gợi ý","reason":"lý do một câu"}. Chọn nhãn (được nhiều) trong: công việc, tài chính, hóa đơn, đăng ký, mạng xã hội, khuyến mãi, thông báo, mã xác minh, quan trọng, việc cần làm, thư rác. Chọn một thư mục trong: inbox, star, archive, trash.',
		triageUser: 'Hãy gợi ý phân loại cho email sau:'
	},
	'ru': {
		chatSystem: 'Вы встроенный помощник почтового ящика. Отвечайте на русском языке. Ответы — короткие и точные, только о почте и использовании ящика; если не знаете, так и скажите, не выдумывайте. Не добавляйте ничего, не относящегося к ответу.',
		triageSystem: 'Вы помощник по сортировке писем. Отвечайте на русском языке. Выводите ТОЛЬКО JSON, без другого текста. Формат JSON: {"labels":["метка1","метка2"],"folder":"предлагаемая папка","reason":"причина одним предложением"}. Метки (можно несколько) из списка: работа, финансы, счета, подписки, соцсети, акции, уведомления, коды подтверждения, важное, задачи, спам. Папка — одна из: inbox, star, archive, trash.',
		triageUser: 'Предложите сортировку для следующего письма:'
	},
	'es': {
		chatSystem: 'Eres un asistente integrado en el buzón. Responde en español. Respuestas breves y precisas, solo sobre el correo y el uso del buzón; si no lo sabes, dilo, no inventes. No añadas nada ajeno a la respuesta.',
		triageSystem: 'Eres un asistente de clasificación de correos. Responde en español. Devuelve SOLO JSON, sin ningún otro texto. Formato JSON: {"labels":["etiqueta1","etiqueta2"],"folder":"carpeta sugerida","reason":"motivo en una frase"}. Etiquetas (varias permitidas) de: trabajo, finanzas, facturas, suscripciones, social, promociones, notificaciones, códigos de verificación, importante, pendientes, spam. Carpeta, una de: inbox, star, archive, trash.',
		triageUser: 'Sugiere una clasificación para el siguiente correo:'
	},
	'fr': {
		chatSystem: 'Vous êtes un assistant intégré à la boîte mail. Répondez en français. Réponses courtes et précises, uniquement sur le courrier et l\'usage de la boîte mail ; si vous ne savez pas, dites-le, n\'inventez rien. N\'ajoutez rien d\'étranger à la réponse.',
		triageSystem: 'Vous êtes un assistant de tri des e-mails. Répondez en français. Ne renvoyez QUE du JSON, aucun autre texte. Format JSON : {"labels":["étiquette1","étiquette2"],"folder":"dossier suggéré","reason":"motif en une phrase"}. Étiquettes (plusieurs possibles) parmi : travail, finances, factures, abonnements, social, promotions, notifications, codes de vérification, important, à faire, spam. Dossier, un seul parmi : inbox, star, archive, trash.',
		triageUser: 'Proposez un tri pour l\'e-mail suivant :'
	}
};

const ALLOWED_LABELS = new Set(['工作', '财务', '账单', '订阅', '社交', '推广', '通知', '验证码', '重要', '待办', '垃圾',
	'work', 'finance', 'bills', 'subscriptions', 'social', 'promotions', 'notifications', 'verification codes', 'important', 'todo', 'spam']);
const ALLOWED_FOLDERS = new Set(['inbox', 'star', 'archive', 'trash']);

const assistantService = {
	CHAT_PROMPTS,

	// POST /ai/chat：{message, emailId?, targetLang?} -> {reply, remaining}
	// 多轮对话：读最近 20 条本人历史作上下文；emailId 传入时把该邮件
	// （本人未删）作为上下文贴进本次用户消息；每次模型调用计 1 次配额。
	async chat(c, userId, params = {}) {
		const message = typeof params.message === 'string' ? params.message.trim() : '';
		if (!message || message.length > MAX_MESSAGE_CHARS) {
			throw new BizError('ai_invalid_input', 'ai_invalid_input');
		}
		await aiService._assertEnabled(c);
		await aiService._checkQuota(c, userId);
		const locale = this._resolveLocale(await aiService._getUserLocale(c, userId), params.targetLang);
		const prompts = CHAT_PROMPTS[locale] || CHAT_PROMPTS['zh-CN'];

		let userContent = message;
		if (params.emailId !== undefined && params.emailId !== null && params.emailId !== '') {
			const row = await aiService._selectOwnEmail(c, userId, Number(params.emailId));
			if (!row) {
				throw new BizError('ai_not_found', 'ai_not_found');
			}
			const body = aiService._emailBodyText(row);
			userContent = `${prompts.triageUser}\n${row.subject || ''}\n\n${body}\n\n${message}`;
		}

		const history = await this._loadHistory(c, userId);
		const messages = [{ role: 'system', content: prompts.chatSystem }];
		for (const item of history) {
			messages.push({ role: item.role, content: item.content });
		}
		messages.push({ role: 'user', content: userContent });

		const reply = await aiService._runChat(c, messages, { maxTokens: 1024 });
		const remaining = await aiService._recordUsage(c, userId);
		// 只在模型成功返回后落库对话（失败不留半截记录、不计配额）。
		try {
			await this._appendHistory(c, userId, 'user', message);
			await this._appendHistory(c, userId, 'assistant', reply);
			await this._pruneExpired(c, userId);
		} catch (e) {
			console.error('保存对话历史失败:', e.message);
		}
		return { reply, remaining };
	},

	// GET /ai/chat/history：返回最近 20 条本人对话（旧 → 新排序）。
	async history(c, userId) {
		await aiService._assertEnabled(c);
		const rows = await this._loadHistory(c, userId);
		return { messages: rows.map(r => ({ role: r.role, content: r.content, createdAt: r.createdAt })) };
	},

	// POST /ai/chat/clear：一键清空本人全部对话历史 -> {cleared}
	async clearHistory(c, userId) {
		await aiService._assertEnabled(c);
		let cleared = 0;
		try {
			const res = await orm(c).delete(aiChat).where(eq(aiChat.userId, userId)).run();
			cleared = res?.meta?.changes ?? 0;
		} catch (e) {
			console.error('清空对话历史失败:', e.message);
			throw new BizError('ai_unavailable', 'ai_unavailable');
		}
		return { cleared };
	},

	// POST /ai/triage：{emailId} -> {labels, folder, reason, remaining}
	// 模型只返回 JSON；解析失败时用原文兜底（labels 为空、folder inbox、
	// reason 取模型原文截断），不把解析失败升级成 ai_unavailable——
	// 模型已成功返回，归类建议降级展示比报错更符合“助手”定位。
	async triage(c, userId, params = {}) {
		if (params.emailId === undefined || params.emailId === null || params.emailId === '') {
			throw new BizError('ai_invalid_input', 'ai_invalid_input');
		}
		await aiService._assertEnabled(c);
		await aiService._checkQuota(c, userId);
		const row = await aiService._selectOwnEmail(c, userId, Number(params.emailId));
		if (!row) {
			throw new BizError('ai_not_found', 'ai_not_found');
		}
		const locale = await aiService._getUserLocale(c, userId);
		const prompts = CHAT_PROMPTS[locale] || CHAT_PROMPTS['zh-CN'];
		const body = aiService._emailBodyText(row);
		const text = await aiService._runChat(c, [
			{ role: 'system', content: prompts.triageSystem },
			{ role: 'user', content: `${prompts.triageUser}\n${row.subject || ''}\n\n${body}` }
		], { maxTokens: 512, temperature: 0.3 });
		const remaining = await aiService._recordUsage(c, userId);
		return { ...this._parseTriage(text), remaining };
	},

	_parseTriage(text) {
		const fallback = { labels: [], folder: 'inbox', reason: String(text || '').slice(0, 200) };
		if (!text) return fallback;
		const start = text.indexOf('{');
		const end = text.lastIndexOf('}');
		if (start < 0 || end <= start) return fallback;
		try {
			const parsed = JSON.parse(text.slice(start, end + 1));
			const labels = Array.isArray(parsed.labels)
				? parsed.labels.map(l => String(l).trim()).filter(l => ALLOWED_LABELS.has(l)).slice(0, 5)
				: [];
			const folder = ALLOWED_FOLDERS.has(parsed.folder) ? parsed.folder : 'inbox';
			const reason = typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 200) : '';
			return { labels, folder, reason };
		} catch (e) {
			return fallback;
		}
	},

	// targetLang 接受完整码（zh-CN）或短码（zh）；非法值回落到用户 locale。
	_resolveLocale(userLocale, targetLang) {
		if (typeof targetLang !== 'string' || !targetLang.trim()) return userLocale;
		const short = targetLang.trim();
		const map = { zh: 'zh-CN', en: 'en', ja: 'ja', ko: 'ko', vi: 'vi', ru: 'ru', es: 'es', fr: 'fr' };
		if (CHAT_PROMPTS[short]) return short;
		if (map[short]) return map[short];
		return userLocale;
	},

	async _loadHistory(c, userId) {
		try {
			const rows = await orm(c).select().from(aiChat)
				.where(eq(aiChat.userId, userId))
				.orderBy(desc(aiChat.chatId)).limit(MAX_HISTORY_MESSAGES);
			return rows.reverse();
		} catch (e) {
			// ai_chat 表尚未迁移时（v3_11DB 未跑）对话仍可用，只是不带历史。
			console.error('读对话历史失败:', e.message);
			return [];
		}
	},

	async _appendHistory(c, userId, role, content) {
		await orm(c).insert(aiChat).values({ userId, role, content }).run();
	},

	// 默认只保留 30 天：删本人早于 30 天前的行（D1 CURRENT_TIMESTAMP 为 UTC，
	// 与 datetime('now') 同基准）。失败不阻断本次对话返回。
	async _pruneExpired(c, userId) {
		try {
			await c.env.db.prepare(
				`DELETE FROM ai_chat WHERE user_id = ? AND created_at < datetime('now', ?)`
			).bind(userId, `-${RETENTION_DAYS} days`).run();
		} catch (e) {
			console.error('清理过期对话历史失败:', e.message);
		}
	}
};

export default assistantService;
