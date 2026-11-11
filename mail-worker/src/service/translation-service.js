import BizError from '../error/biz-error';
import aiService from './ai-service';

// Phase 8：翻译服务（Layer 2）。
// 读信翻译（邮件详情一键翻成用户语言，原文/译文对照显示）与写信多语言
// （写信/回信时选目标语言：助手按目标语言起草——compose/reply 本身不改，
// 写信页先由 ai-service 起草、再由本服务把草稿翻成目标语言；读信页则
// 直接翻邮件原文）。翻译走同一开源模型（复用 ai-service 主备降级）、
// 同一限额（每用户每天 50 次，只在成功返回后计数；一次 /ai/translate
// 调用无论分几段都只计 1 次）与同一开关（ai_enabled=0 返回 ai_disabled）。
// 长文分段：正文按 ≤3000 字一段切分（优先在换行/句号处断开），最多 4 段，
// 超出部分截断并在返回里明示 truncated=true（不静默丢内容）。
// 翻译结果可缓存：translate_cache 表，缓存键只含内容 SHA-256 hash 与
// 语种对（source_hash + source_lang + target_lang），不含用户身份；
// 缓存命中时不调模型、不计配额；缓存表未建（v3_11DB 未跑）时降级为不缓存，
// 翻译本身不受影响。E2EE 邮件服务端只有密文：前端解锁后把明文以 {text}
// 传进来（与摘要的既有做法一致），不走 emailId。
const LANG_NAMES = {
	'zh-CN': '中文', en: 'English', ja: '日本語', ko: '한국어',
	vi: 'Tiếng Việt', ru: 'Русский', es: 'Español', fr: 'Français'
};
const SHORT_TO_FULL = { zh: 'zh-CN', en: 'en', ja: 'ja', ko: 'ko', vi: 'vi', ru: 'ru', es: 'es', fr: 'fr' };
const MAX_TEXT_CHARS = 12000;
const CHUNK_CHARS = 3000;
const MAX_CHUNKS = 4;
const MAX_BODY_CHARS = 6000;

const TRANSLATE_PROMPTS = {
	'zh-CN': {
		translateSystem: '你是一位专业翻译。把下面的内容翻译成中文。只输出译文，不要加任何解释、前缀或多余文字；保留原文的换行、列表与格式；人名、地名、品牌名、邮箱地址、链接、代码不要翻译。',
		translateUser: '请翻译以下内容：'
	},
	'en': {
		translateSystem: 'You are a professional translator. Translate the following content into English. Output ONLY the translation, no explanation, prefix, or extra text; keep the original line breaks, lists and formatting; do not translate names, place names, brand names, email addresses, links, or code.',
		translateUser: 'Please translate the following content:'
	},
	'ja': {
		translateSystem: 'あなたはプロの翻訳者です。以下の内容を日本語に翻訳してください。訳文のみを出力し、説明や接頭辞、余計な文字は加えないでください。原文の改行、箇条書き、書式は保持し、人名・地名・ブランド名・メールアドレス・リンク・コードは翻訳しないでください。',
		translateUser: '以下の内容を翻訳してください：'
	},
	'ko': {
		translateSystem: '당신은 전문 번역가입니다. 아래 내용을 한국어로 번역하세요. 번역문만 출력하고 설명이나 접두사, 불필요한 텍스트는 추가하지 마세요. 원문의 줄바꿈, 목록, 형식을 유지하고 인명, 지명, 브랜드명, 이메일 주소, 링크, 코드는 번역하지 마세요.',
		translateUser: '다음 내용을 번역해 주세요:'
	},
	'vi': {
		translateSystem: 'Bạn là dịch giả chuyên nghiệp. Hãy dịch nội dung dưới đây sang tiếng Việt. Chỉ xuất bản dịch, không thêm lời giải thích, tiền tố hay văn bản thừa; giữ nguyên ngắt dòng, danh sách và định dạng gốc; không dịch tên người, địa danh, tên thương hiệu, địa chỉ email, liên kết hay mã.',
		translateUser: 'Hãy dịch nội dung sau:'
	},
	'ru': {
		translateSystem: 'Вы профессиональный переводчик. Переведите следующее содержимое на русский язык. Выводите ТОЛЬКО перевод, без объяснений, префиксов и лишнего текста; сохраняйте исходные переносы строк, списки и форматирование; не переводите имена, географические названия, бренды, адреса электронной почты, ссылки и код.',
		translateUser: 'Переведите следующее содержимое:'
	},
	'es': {
		translateSystem: 'Eres un traductor profesional. Traduce el siguiente contenido al español. Devuelve SOLO la traducción, sin explicaciones, prefijos ni texto adicional; conserva los saltos de línea, las listas y el formato original; no traduzcas nombres de personas, lugares, marcas, direcciones de correo, enlaces ni código.',
		translateUser: 'Traduce el siguiente contenido:'
	},
	'fr': {
		translateSystem: 'Vous êtes un traducteur professionnel. Traduisez le contenu suivant en français. Ne renvoyez QUE la traduction, sans explication, préfixe ni texte superflu ; conservez les sauts de ligne, les listes et la mise en forme d\'origine ; ne traduisez pas les noms de personnes, de lieux, de marques, les adresses e-mail, les liens ni le code.',
		translateUser: 'Traduisez le contenu suivant :'
	}
};

const translationService = {
	TRANSLATE_PROMPTS,
	LANG_NAMES,

	// 翻译公共前置：解析目标语种/原文（emailId 或明文）、校验开关与配额、查缓存。
	// 返回 {targetLang, sourceLang, subject, sliced, truncated, cacheKey, cached}；
	// cached 非 null 时为缓存译文（调用方直接返回，不调模型、不计配额）。
	async _resolveTranslateInput(c, userId, params = {}) {
		const targetLang = this._normalizeLang(params.targetLang)
			|| (await aiService._getUserLocale(c, userId));
		if (!LANG_NAMES[targetLang]) {
			throw new BizError('ai_invalid_input', 'ai_invalid_input');
		}
		const sourceLang = typeof params.sourceLang === 'string' && params.sourceLang.trim()
			? params.sourceLang.trim() : 'auto';

		let subject = '';
		let text = '';
		if (params.emailId !== undefined && params.emailId !== null && params.emailId !== '') {
			const row = await aiService._selectOwnEmail(c, userId, Number(params.emailId));
			if (!row) {
				throw new BizError('ai_not_found', 'ai_not_found');
			}
			subject = row.subject || '';
			text = aiService._emailBodyText(row);
		} else {
			subject = typeof params.subject === 'string' ? params.subject.trim() : '';
			text = typeof params.text === 'string' ? params.text.trim() : '';
		}
		if (!subject && !text) {
			throw new BizError('ai_invalid_input', 'ai_invalid_input');
		}

		await aiService._assertEnabled(c);
		await aiService._checkQuota(c, userId);

		const fullText = subject ? `${subject}\n\n${text}` : text;
		const truncated = fullText.length > MAX_TEXT_CHARS;
		const sliced = fullText.slice(0, MAX_TEXT_CHARS);

		// 缓存：键 = 内容 hash + 语种对，不含用户身份。
		const cacheKey = await this._cacheKey(sliced, sourceLang, targetLang);
		const cached = await this._cacheGet(c, cacheKey);
		return { targetLang, sourceLang, subject, sliced, truncated, cacheKey, cached };
	},

	// POST /ai/translate：{emailId} 或 {text, subject?} + {targetLang?, sourceLang?}
	// -> {translatedText, subject?, sourceLang, targetLang, truncated, cached, remaining}
	// targetLang 缺省时取用户 locale；sourceLang 缺省为 'auto'（由模型自行判断，
	// 不做单独的语言检测调用）。缓存命中时 remaining 为当前剩余（不扣减）。
	async translate(c, userId, params = {}) {
		const { targetLang, sourceLang, subject, sliced, truncated, cacheKey, cached }
			= await this._resolveTranslateInput(c, userId, params);
		if (cached !== null) {
			const usage = await aiService._getUsage(c, userId);
			return {
				translatedText: cached, subject: '', sourceLang, targetLang,
				truncated, cached: true, remaining: usage.remaining
			};
		}

		const prompts = TRANSLATE_PROMPTS[targetLang];
		const chunks = this._splitChunks(sliced);
		// 长文分段并行翻译：各段同时调模型，总耗时约等于最慢一段，不再是各段之和。
		const out = await Promise.all(chunks.map(chunk => aiService._runChat(c, [
			{ role: 'system', content: prompts.translateSystem },
			{ role: 'user', content: `${prompts.translateUser}\n${chunk}` }
		], { maxTokens: 2048, temperature: 0.3 })));
		const translatedText = out.join('\n');
		const remaining = await aiService._recordUsage(c, userId);
		await this._cachePut(c, cacheKey, sourceLang, targetLang, translatedText);
		return {
			translatedText, subject: '', sourceLang, targetLang,
			truncated, cached: false, remaining
		};
	},

	// 流式翻译：与 translate 相同的校验/配额/缓存，但逐 token 以 SSE 返回，
	// 首 token 约 1-2 秒可见。长文各段并行建流、按原文顺序逐段转发 delta，
	// 总耗时约等于最慢一段。用量只在流成功结束时记 1 次；中途断开不计数，
	// 前端回退一次性翻译也不重复扣。缓存命中时直接把缓存译文当一段 delta 发出。
	async translateStream(c, userId, params = {}) {
		const { targetLang, sourceLang, subject, sliced, truncated, cacheKey, cached }
			= await this._resolveTranslateInput(c, userId, params);
		const encoder = new TextEncoder();
		const sseHeaders = {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
		};
		const doneFrame = (payload) => encoder.encode(`data: ${JSON.stringify({ done: true, ...payload })}\n\n`);
		if (cached !== null) {
			const usage = await aiService._getUsage(c, userId);
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: cached })}\n\n`));
					controller.enqueue(doneFrame({ translatedText: cached, subject: '', sourceLang, targetLang, truncated, cached: true, remaining: usage.remaining }));
					controller.close();
				}
			});
			return new Response(stream, { headers: sseHeaders });
		}
		const prompts = TRANSLATE_PROMPTS[targetLang];
		const chunks = this._splitChunks(sliced);
		// 各段并行建流（每段主备降级在 _runChatStream 内做）；建流失败在发任何
		// 帧之前抛出，走 onError 返回标准 JSON，前端回退一次性翻译。
		const runs = await Promise.all(chunks.map(chunk => aiService._runChatStream(c, [
			{ role: 'system', content: prompts.translateSystem },
			{ role: 'user', content: `${prompts.translateUser}\n${chunk}` }
		], { maxTokens: 2048, temperature: 0.3 })));
		const self = this;
		const stream = new ReadableStream({
			async start(controller) {
				try {
					// 按原文顺序逐段转发 delta；段与段之间补一个换行
					// （与一次性版 out.join('\n') 一致）。
					for (let i = 0; i < runs.length; i++) {
						if (i > 0) {
							controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: '\n' })}\n\n`));
						}
						const reader = runs[i].stream.getReader();
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							controller.enqueue(value);
						}
					}
					const translatedText = runs.map(r => r.getText()).join('\n');
					const remaining = await aiService._recordUsage(c, userId);
					await self._cachePut(c, cacheKey, sourceLang, targetLang, translatedText);
					controller.enqueue(doneFrame({ translatedText, subject: '', sourceLang, targetLang, truncated, cached: false, remaining }));
					controller.close();
				} catch (e) {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: 'ai_unavailable' })}\n\n`));
					controller.close();
				}
			}
		});
		return new Response(stream, { headers: sseHeaders });
	},

	// 写信多语言：把一段已起草的文本（标题 + 正文拼成 text 传入）翻成目标语言。
	// 与 translate 同一入口（{text, targetLang}），前端写信页复用，不另开端点。
	_normalizeLang(value) {
		if (typeof value !== 'string' || !value.trim()) return '';
		const v = value.trim();
		if (LANG_NAMES[v]) return v;
		if (SHORT_TO_FULL[v]) return SHORT_TO_FULL[v];
		return '';
	},

	_splitChunks(text) {
		if (text.length <= CHUNK_CHARS) return [text];
		const chunks = [];
		let rest = text;
		while (rest.length > 0 && chunks.length < MAX_CHUNKS) {
			if (rest.length <= CHUNK_CHARS) {
				chunks.push(rest);
				break;
			}
			let cut = rest.lastIndexOf('\n', CHUNK_CHARS);
			if (cut < CHUNK_CHARS * 0.5) cut = rest.lastIndexOf('。', CHUNK_CHARS);
			if (cut < CHUNK_CHARS * 0.5) cut = rest.lastIndexOf('. ', CHUNK_CHARS);
			if (cut < CHUNK_CHARS * 0.5) cut = CHUNK_CHARS;
			chunks.push(rest.slice(0, cut + 1));
			rest = rest.slice(cut + 1);
		}
		return chunks;
	},

	async _cacheKey(text, sourceLang, targetLang) {
		const input = `${sourceLang}|${targetLang}|${text}`;
		try {
			if (typeof crypto !== 'undefined' && crypto.subtle?.digest) {
				const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
				return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
			}
		} catch (e) {
			// 回落到 FNV-1a（测试/无 subtle 环境），仍只由内容与语种对决定。
		}
		let h = 0x811c9dc5;
		for (let i = 0; i < input.length; i++) {
			h ^= input.charCodeAt(i);
			h = Math.imul(h, 0x01000193) >>> 0;
		}
		return `fnv1a-${h.toString(16)}`;
	},

	async _cacheGet(c, sourceHash) {
		try {
			const row = await c.env.db.prepare(
				`SELECT result FROM translate_cache WHERE source_hash = ?`
			).bind(sourceHash).first();
			return row?.result ?? null;
		} catch (e) {
			return null; // 表未建时降级为不缓存
		}
	},

	async _cachePut(c, sourceHash, sourceLang, targetLang, result) {
		try {
			// hash 本身已含语种对；source_lang / target_lang 列只作审计/排查用。
			await c.env.db.prepare(
				`INSERT OR REPLACE INTO translate_cache (source_hash, source_lang, target_lang, result) VALUES (?, ?, ?, ?)`
			).bind(sourceHash, sourceLang, targetLang, result).run();
		} catch (e) {
			console.error('写翻译缓存失败:', e.message);
		}
	}
};

export default translationService;
