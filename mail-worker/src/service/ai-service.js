import emailUtils from '../utils/email-utils';
import { settingConst, isDel } from '../const/entity-const';
import BizError from '../error/biz-error';
import KvConst from '../const/kv-const';
import settingService from './setting-service';
import orm from '../entity/orm';
import user from '../entity/user';
import email from '../entity/email';
import { eq, and } from 'drizzle-orm';
import dayjs from 'dayjs';

// Phase 7：AI 写信 / 回信 / 摘要（Workers AI，开源权重模型，不接任何外部 AI API）。
// 模型（用户 2026-11-08 定，开源路线）：主 @cf/meta/llama-3.1-8b-instruct，
// 备 @cf/meta/llama-3-8b-instruct；主模型失败（抛错或空回复）时自动降级到
// 备用模型，两个都不可用时返回 ai_unavailable（BizError，Hono onError 恒
// 返回 HTTP 200、真实错误码在 body.code），不抛 500、不破坏发信等主流程。
// 后端只返回语言无关的错误码（ai_disabled / ai_quota_exceeded /
// ai_unavailable / ai_invalid_input / ai_not_found），不把任何自然语言提示
// 写死在返回里；前端按 body.code 查 ai.* 翻译 key 展示（key 清单见 PHASE7.md）。
// 提示词按用户语言（user.locale，默认 zh-CN）生成；限流每用户每天 50 次，
// KV 计数复用 quota-service 的 read-modify-write 写法（高并发下可能少计
// 几次）；只在 AI 成功返回后才计数，失败重试不消耗配额。
const PRIMARY_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const FALLBACK_MODEL = '@cf/meta/llama-3-8b-instruct';
const AI_DAILY_LIMIT = 50;
const MAX_BODY_CHARS = 6000;
const MAX_PROMPT_CHARS = 2000;
const TONES = ['formal', 'friendly', 'concise', 'neutral'];

// 8 语种提示词：{tone} 由语气表填充；composeUser / replyUser / summarizeUser
// 为用户消息前缀（原邮件内容本身不翻译，直接原样贴入）。
const PROMPTS = {
	'zh-CN': {
		composeSystem: '你是一位邮件写作助手。用中文写邮件。语气：{tone}。输出格式：第一行只写邮件标题（不要加“标题：”等前缀），空一行，然后是邮件正文。不要输出任何解释或多余文字。',
		replySystem: '你是一位邮件回复助手。用中文回复。语气：{tone}。输出格式：第一行只写回复标题（在原标题前加“Re: ”，不要加其他前缀），空一行，然后是回复正文。回复要紧扣原邮件内容。不要输出任何解释或多余文字。',
		summarizeSystem: '你是一位邮件摘要助手。用中文摘要下面的邮件，输出 3-5 行，每行一个要点，不要编号，不要输出任何解释或多余文字。',
		composeUser: '请根据以下要求写一封邮件：',
		replyUser: '请回复以下邮件：',
		summarizeUser: '请摘要以下邮件：',
		from: '发件人', subject: '标题',
		tones: { formal: '正式、措辞得体', friendly: '亲切友好', concise: '简洁精炼', neutral: '自然得体' }
	},
	'en': {
		composeSystem: 'You are an email writing assistant. Write the email in English. Tone: {tone}. Output format: the first line is the subject line only (no "Subject:" prefix), then a blank line, then the email body. Do not output any explanation or extra text.',
		replySystem: 'You are an email reply assistant. Reply in English. Tone: {tone}. Output format: the first line is the reply subject (prefix the original subject with "Re: ", no other prefix), then a blank line, then the reply body. Keep the reply relevant to the original email. Do not output any explanation or extra text.',
		summarizeSystem: 'You are an email summarization assistant. Summarize the email below in English in 3–5 lines, one key point per line, no numbering, no explanation or extra text.',
		composeUser: 'Please write an email based on the following request:',
		replyUser: 'Please reply to the following email:',
		summarizeUser: 'Please summarize the following email:',
		from: 'From', subject: 'Subject',
		tones: { formal: 'formal and polite', friendly: 'warm and friendly', concise: 'concise and to the point', neutral: 'natural and appropriate' }
	},
	'ja': {
		composeSystem: 'あなたはメール作成アシスタントです。日本語でメールを書いてください。口調：{tone}。出力形式：1行目に件名のみ（「件名：」などの接頭辞なし）、空行を挟んで本文。説明や余計な文字は出力しないでください。',
		replySystem: 'あなたはメール返信アシスタントです。日本語で返信してください。口調：{tone}。出力形式：1行目に返信の件名のみ（元の件名の前に「Re: 」を付ける）、空行を挟んで返信本文。返信は元のメール内容に沿ってください。説明や余計な文字は出力しないでください。',
		summarizeSystem: 'あなたはメール要約アシスタントです。以下のメールを日本語で 3〜5 行に要約してください。1行に要点を1つ、番号なし、説明や余計な文字は出力しないでください。',
		composeUser: '以下の要望に沿ってメールを書いてください：',
		replyUser: '以下のメールに返信してください：',
		summarizeUser: '以下のメールを要約してください：',
		from: '差出人', subject: '件名',
		tones: { formal: '丁寧で格式ばった', friendly: '親しみやすく温かい', concise: '簡潔で要点を押さえた', neutral: '自然で適切な' }
	},
	'ko': {
		composeSystem: '당신은 이메일 작성 도우미입니다. 한국어로 이메일을 작성하세요. 말투: {tone}. 출력 형식: 첫 줄에는 제목만(접두사 없음), 빈 줄 다음에 본문. 설명이나 불필요한 텍스트는 출력하지 마세요.',
		replySystem: '당신은 이메일 답장 도우미입니다. 한국어로 답장하세요. 말투: {tone}. 출력 형식: 첫 줄에는 답장 제목만(원본 제목 앞에 "Re: " 추가), 빈 줄 다음에 답장 본문. 답장은 원본 메일 내용에 충실하게 작성하세요. 설명이나 불필요한 텍스트는 출력하지 마세요.',
		summarizeSystem: '당신은 이메일 요약 도우미입니다. 아래 이메일을 한국어로 3~5줄로 요약하세요. 한 줄에 핵심 내용 하나씩, 번호 없이, 설명이나 불필요한 텍스트는 출력하지 마세요.',
		composeUser: '다음 요청에 따라 이메일을 작성해 주세요:',
		replyUser: '다음 이메일에 답장해 주세요:',
		summarizeUser: '다음 이메일을 요약해 주세요:',
		from: '발신인', subject: '제목',
		tones: { formal: '격식 있고 정중한', friendly: '친근하고 따뜻한', concise: '간결하고 핵심적인', neutral: '자연스럽고 적절한' }
	},
	'vi': {
		composeSystem: 'Bạn là trợ lý viết email. Hãy viết email bằng tiếng Việt. Giọng điệu: {tone}. Định dạng đầu ra: dòng đầu tiên chỉ ghi tiêu đề (không thêm tiền tố), sau đó một dòng trống rồi đến nội dung email. Không xuất thêm lời giải thích hay văn bản thừa.',
		replySystem: 'Bạn là trợ lý trả lời email. Hãy trả lời bằng tiếng Việt. Giọng điệu: {tone}. Định dạng đầu ra: dòng đầu tiên chỉ ghi tiêu đề trả lời (thêm "Re: " vào trước tiêu đề gốc), sau đó một dòng trống rồi đến nội dung trả lời. Nội dung phải bám sát email gốc. Không xuất thêm lời giải thích hay văn bản thừa.',
		summarizeSystem: 'Bạn là trợ lý tóm tắt email. Hãy tóm tắt email dưới đây bằng tiếng Việt trong 3–5 dòng, mỗi dòng một ý chính, không đánh số, không thêm lời giải thích hay văn bản thừa.',
		composeUser: 'Hãy viết email theo yêu cầu sau:',
		replyUser: 'Hãy trả lời email sau:',
		summarizeUser: 'Hãy tóm tắt email sau:',
		from: 'Người gửi', subject: 'Tiêu đề',
		tones: { formal: 'trang trọng, lịch sự', friendly: 'thân thiện, ấm áp', concise: 'ngắn gọn, súc tích', neutral: 'tự nhiên, phù hợp' }
	},
	'ru': {
		composeSystem: 'Вы помощник по написанию писем. Напишите письмо на русском языке. Тон: {tone}. Формат вывода: первая строка — только тема письма (без префикса), затем пустая строка, затем текст письма. Не добавляйте объяснений или лишнего текста.',
		replySystem: 'Вы помощник по ответам на письма. Ответьте на русском языке. Тон: {tone}. Формат вывода: первая строка — только тема ответа (добавьте "Re: " перед исходной темой), затем пустая строка, затем текст ответа. Ответ должен относиться к исходному письму. Не добавляйте объяснений или лишнего текста.',
		summarizeSystem: 'Вы помощник по составлению сводок писем. Составьте резюме письма ниже на русском языке в 3–5 строках, по одному ключевому пункту в строке, без нумерации, объяснений и лишнего текста.',
		composeUser: 'Напишите письмо по следующему запросу:',
		replyUser: 'Ответьте на следующее письмо:',
		summarizeUser: 'Составьте резюме следующего письма:',
		from: 'Отправитель', subject: 'Тема',
		tones: { formal: 'официальный, вежливый', friendly: 'тёплый, дружелюбный', concise: 'краткий, по существу', neutral: 'естественный, уместный' }
	},
	'es': {
		composeSystem: 'Eres un asistente para redactar correos. Escribe el correo en español. Tono: {tone}. Formato de salida: la primera línea es solo el asunto (sin prefijo), luego una línea en blanco y después el cuerpo del correo. No añadas explicaciones ni texto adicional.',
		replySystem: 'Eres un asistente para responder correos. Responde en español. Tono: {tone}. Formato de salida: la primera línea es solo el asunto de la respuesta (añade "Re: " delante del asunto original), luego una línea en blanco y después el cuerpo de la respuesta. La respuesta debe ceñirse al correo original. No añadas explicaciones ni texto adicional.',
		summarizeSystem: 'Eres un asistente para resumir correos. Resume el correo siguiente en español en 3–5 líneas, un punto clave por línea, sin numeración, sin explicaciones ni texto adicional.',
		composeUser: 'Escribe un correo según la siguiente solicitud:',
		replyUser: 'Responde al siguiente correo:',
		summarizeUser: 'Resume el siguiente correo:',
		from: 'Remitente', subject: 'Asunto',
		tones: { formal: 'formal y cortés', friendly: 'cálido y amistoso', concise: 'conciso y directo', neutral: 'natural y adecuado' }
	},
	'fr': {
		composeSystem: 'Vous êtes un assistant de rédaction d\'e-mails. Rédigez l\'e-mail en français. Ton : {tone}. Format de sortie : la première ligne contient uniquement l\'objet (sans préfixe), puis une ligne vide, puis le corps de l\'e-mail. N\'ajoutez aucune explication ni texte superflu.',
		replySystem: 'Vous êtes un assistant de réponse aux e-mails. Répondez en français. Ton : {tone}. Format de sortie : la première ligne contient uniquement l\'objet de la réponse (ajoutez « Re: » devant l\'objet d\'origine), puis une ligne vide, puis le corps de la réponse. La réponse doit se rapporter à l\'e-mail d\'origine. N\'ajoutez aucune explication ni texte superflu.',
		summarizeSystem: 'Vous êtes un assistant de résumé d\'e-mails. Résumez l\'e-mail ci-dessous en français en 3 à 5 lignes, un point clé par ligne, sans numérotation, sans explication ni texte superflu.',
		composeUser: 'Rédigez un e-mail selon la demande suivante :',
		replyUser: 'Répondez à l\'e-mail suivant :',
		summarizeUser: 'Résumez l\'e-mail suivant :',
		from: 'Expéditeur', subject: 'Objet',
		tones: { formal: 'formel et poli', friendly: 'chaleureux et amical', concise: 'concis et direct', neutral: 'naturel et approprié' }
	}
};

const aiService = {
	PRIMARY_MODEL,
	FALLBACK_MODEL,
	DAILY_LIMIT: AI_DAILY_LIMIT,

	async extractCode(c, email, options = {}) {
		if (!this.shouldExtractCode(options.aiCode, options.aiCodeFilter, email)) {
			return '';
		}

		const ai = c.env.ai;

		try {
			const subject = email.subject || '';
			const text = emailUtils.formatText(email.text || '');
			const htmlText = emailUtils.htmlToText(email.html || '');
			const body = (htmlText || text).slice(0, 6000);

			if (!subject && !body) {
				return '';
			}

			const result = await ai.run(c.env.ai_model || '@cf/meta/llama-3.1-8b-instruct-fast', {
				messages: [
					{
						role: 'system',
						content: 'You extract verification codes from emails. Return only JSON like {"code":"12345678"} or {"code":""}. The code must be 8 characters or fewer and must not contain spaces. If the code is longer than 8 characters or contains spaces, return {"code":""}. Do not explain.'
					},
					{
						role: 'user',
						content: `Subject: ${subject}\n\n${body}`
					}
				],
				temperature: 0,
				max_tokens: 32
			});

			const content = typeof result === 'string' ? result : result?.response || '';
			const json = typeof content === 'string' ? JSON.parse(content) : content;
			if (typeof json.code !== 'string') {
				return '';
			}

			if (json.code.length > 8 || /\s/.test(json.code)) {
				return '';
			}

			return json.code;
		} catch (e) {
			console.error('验证码提取失败: ', e);
			return '';
		}
	},

	shouldExtractCode(aiCode, aiCodeFilterStr, email) {
		if (aiCode !== settingConst.aiCode.OPEN) {
			return false;
		}

		const filterList = aiCodeFilterStr ? aiCodeFilterStr.split(',').map(item => item.trim().toLowerCase()).filter(Boolean) : [];

		if (filterList.length === 0) {
			return true;
		}

		const fromEmail = (email.from?.address || '').trim().toLowerCase();
		const fromDomain = emailUtils.getDomain(fromEmail).toLowerCase();

		return filterList.some(item => item === fromEmail || item === fromDomain);
	},

	// ---- Phase 7：写信 / 回信 / 摘要 ----

	// POST /ai/compose：{prompt, tone?} -> {subject, body, remaining}
	async compose(c, userId, params = {}) {
		const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
		if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
			throw new BizError('ai_invalid_input', 'ai_invalid_input');
		}
		const tone = TONES.includes(params.tone) ? params.tone : 'neutral';
		await this._assertEnabled(c);
		await this._checkQuota(c, userId);
		const locale = await this._getUserLocale(c, userId);
		const prompts = PROMPTS[locale];
		const text = await this._runChat(c, [
			{ role: 'system', content: this._systemPrompt(locale, 'composeSystem', tone) },
			{ role: 'user', content: `${prompts.composeUser}\n${prompt}` }
		], { maxTokens: 1024 });
		const { subject, body } = this._parseSubjectBody(text);
		const remaining = await this._recordUsage(c, userId);
		return { subject, body, remaining };
	},

	// POST /ai/reply：{emailId} 或 {subject, body, sender} -> {subject, body, remaining}
	async reply(c, userId, params = {}) {
		let subject = '';
		let body = '';
		let sender = '';
		if (params.emailId !== undefined && params.emailId !== null && params.emailId !== '') {
			const row = await this._selectOwnEmail(c, userId, Number(params.emailId));
			if (!row) {
				throw new BizError('ai_not_found', 'ai_not_found');
			}
			subject = row.subject || '';
			body = this._emailBodyText(row);
			sender = row.sendEmail || row.name || '';
		} else {
			subject = typeof params.subject === 'string' ? params.subject.trim() : '';
			body = typeof params.body === 'string' ? params.body.trim() : '';
			sender = typeof params.sender === 'string' ? params.sender.trim() : '';
		}
		if (!subject && !body) {
			throw new BizError('ai_invalid_input', 'ai_invalid_input');
		}
		const tone = TONES.includes(params.tone) ? params.tone : 'neutral';
		await this._assertEnabled(c);
		await this._checkQuota(c, userId);
		const locale = await this._getUserLocale(c, userId);
		const prompts = PROMPTS[locale];
		const text = await this._runChat(c, [
			{ role: 'system', content: this._systemPrompt(locale, 'replySystem', tone) },
			{ role: 'user', content: `${prompts.replyUser}\n${prompts.from}：${sender}\n${prompts.subject}：${subject}\n\n${body.slice(0, MAX_BODY_CHARS)}` }
		], { maxTokens: 1024 });
		let parsed = this._parseSubjectBody(text);
		if (!parsed.subject && subject) {
			parsed = { subject: `Re: ${subject.replace(/^Re:\s*/i, '')}`, body: parsed.body };
		}
		const remaining = await this._recordUsage(c, userId);
		return { subject: parsed.subject, body: parsed.body, remaining };
	},

	// POST /ai/summarize：{emailId} 或 {body, subject?} -> {summary, remaining}
	async summarize(c, userId, params = {}) {
		let subject = '';
		let body = '';
		if (params.emailId !== undefined && params.emailId !== null && params.emailId !== '') {
			const row = await this._selectOwnEmail(c, userId, Number(params.emailId));
			if (!row) {
				throw new BizError('ai_not_found', 'ai_not_found');
			}
			subject = row.subject || '';
			body = this._emailBodyText(row);
		} else {
			subject = typeof params.subject === 'string' ? params.subject.trim() : '';
			body = typeof params.body === 'string' ? params.body.trim() : '';
		}
		if (!body) {
			throw new BizError('ai_invalid_input', 'ai_invalid_input');
		}
		await this._assertEnabled(c);
		await this._checkQuota(c, userId);
		const locale = await this._getUserLocale(c, userId);
		const prompts = PROMPTS[locale];
		const text = await this._runChat(c, [
			{ role: 'system', content: this._systemPrompt(locale, 'summarizeSystem', 'neutral') },
			{ role: 'user', content: `${prompts.summarizeUser}\n${prompts.subject}：${subject}\n\n${body.slice(0, MAX_BODY_CHARS)}` }
		], { maxTokens: 512 });
		const summary = text.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 5).join('\n');
		const remaining = await this._recordUsage(c, userId);
		return { summary, remaining };
	},

	// 主模型失败时降级到备用模型；两个都不可用（或未绑定 AI）时抛 ai_unavailable。
	async _runChat(c, messages, { maxTokens = 1024, temperature = 0.7 } = {}) {
		const ai = c.env?.AI;
		if (!ai || typeof ai.run !== 'function') {
			throw new BizError('ai_unavailable', 'ai_unavailable');
		}
		let lastError = null;
		for (const model of [PRIMARY_MODEL, FALLBACK_MODEL]) {
			try {
				const res = await ai.run(model, { messages, max_tokens: maxTokens, temperature });
				const text = typeof res === 'string' ? res : (res?.response || '');
				if (typeof text === 'string' && text.trim()) {
					return text.trim();
				}
				lastError = new Error('empty AI response');
			} catch (e) {
				lastError = e;
			}
		}
		console.error('AI 调用失败: ', lastError?.message);
		throw new BizError('ai_unavailable', 'ai_unavailable');
	},

	// ai_enabled 直白布尔语义：1 = 开启（默认），0 = 关闭；列不存在的老库
	// （undefined）按默认开启处理；关闭时三个接口一律返回 ai_disabled。
	async _assertEnabled(c) {
		const setting = await settingService.query(c);
		if (setting && setting.aiEnabled === 0) {
			throw new BizError('ai_disabled', 'ai_disabled');
		}
	},

	_aiDayKey(userId) {
		return KvConst.AI_DAY + userId + ':' + dayjs().format('YYYY-MM-DD');
	},

	async _getUsage(c, userId) {
		try {
			const used = Number(await c.env.kv.get(this._aiDayKey(userId))) || 0;
			return { used, limit: AI_DAILY_LIMIT, remaining: Math.max(0, AI_DAILY_LIMIT - used) };
		} catch (e) {
			console.error('读 AI 日用量失败:', e.message);
			return { used: 0, limit: AI_DAILY_LIMIT, remaining: AI_DAILY_LIMIT };
		}
	},

	async _checkQuota(c, userId) {
		const usage = await this._getUsage(c, userId);
		if (usage.used >= AI_DAILY_LIMIT) {
			throw new BizError('ai_quota_exceeded', 'ai_quota_exceeded');
		}
		return usage;
	},

	// 只在 AI 成功返回后计数；计数失败只记日志，不破坏本次成功返回。
	async _recordUsage(c, userId) {
		try {
			const key = this._aiDayKey(userId);
			const count = (Number(await c.env.kv.get(key)) || 0) + 1;
			await c.env.kv.put(key, JSON.stringify(count), { expirationTtl: 60 * 60 * 48 });
			return Math.max(0, AI_DAILY_LIMIT - count);
		} catch (e) {
			console.error('记 AI 用量失败:', e.message);
			return 0;
		}
	},

	async _getUserLocale(c, userId) {
		try {
			const row = await orm(c).select({ locale: user.locale }).from(user)
				.where(eq(user.userId, userId)).get();
			if (row?.locale && PROMPTS[row.locale]) {
				return row.locale;
			}
		} catch (e) {
			console.error('读取用户语言失败:', e.message);
		}
		return 'zh-CN';
	},

	// 只读本人未删邮件；跨用户 / 不存在一律返回 null（上层统一报 ai_not_found，
	// 不区分“不存在”与“不是你的”，避免探查他人邮件）。
	async _selectOwnEmail(c, userId, emailId) {
		if (!emailId) {
			return null;
		}
		return orm(c).select().from(email).where(
			and(eq(email.emailId, emailId),
				eq(email.userId, userId),
				eq(email.isDel, isDel.NORMAL)))
			.get();
	},

	_emailBodyText(row) {
		const htmlText = emailUtils.htmlToText(row.content || '');
		const text = emailUtils.formatText(row.text || '');
		return (htmlText || text).slice(0, MAX_BODY_CHARS);
	},

	_systemPrompt(locale, kind, tone) {
		const prompts = PROMPTS[locale] || PROMPTS['zh-CN'];
		const toneText = (prompts.tones && prompts.tones[tone]) || prompts.tones.neutral;
		return prompts[kind].replace('{tone}', toneText);
	},

	// 约定输出：第一行标题、空一行、正文。单行输出时整行当正文、标题留空。
	_parseSubjectBody(text) {
		const lines = String(text || '').split('\n');
		let i = 0;
		while (i < lines.length && !lines[i].trim()) {
			i++;
		}
		if (i >= lines.length) {
			return { subject: '', body: '' };
		}
		const subject = lines[i].trim().replace(/^(subject|标题|件名|제목|tiêu đề|тема|asunto|objet)[：:]\s*/i, '');
		let j = i + 1;
		while (j < lines.length && !lines[j].trim()) {
			j++;
		}
		const body = lines.slice(j).join('\n').trim();
		if (!body) {
			return { subject: '', body: subject };
		}
		return { subject, body };
	}
};

export default aiService;
