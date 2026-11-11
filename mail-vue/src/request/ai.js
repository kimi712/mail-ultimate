import http from '@/axios/index.js';

// Phase 7：AI 写信 / 回信 / 摘要（Workers AI）。
// 后端业务错误遵循项目约定：HTTP 恒 200，真实错误码在 body.code
// （ai_disabled / ai_quota_exceeded / ai_unavailable / ai_invalid_input /
// ai_not_found）；axios 拦截器对非 200 的 code 会弹原始 message，
// 故此处一律用 noMsg，由调用方按 body.code 查 ai.* 翻译展示。

export function aiCompose(payload) {
    return http.post('/ai/compose', payload, {noMsg: true})
}

export function aiReply(payload) {
    return http.post('/ai/reply', payload, {noMsg: true})
}

// 流式写信 / 回信：fetch + SSE，逐 token 回调 onDelta；结束帧返回
// {subject, body, remaining}。后端业务错误在建流前以 JSON 返回（非 SSE），
// 按 content-type 区分后按 code 抛错，调用方用 aiErrorI18nKey 展示。
// axios 不支持流式读取响应体，故此处直接用 fetch，鉴权头与 axios 拦截器一致。
export function aiComposeStream(payload, onDelta) {
    return aiStream('/ai/compose', payload, onDelta)
}

export function aiReplyStream(payload, onDelta) {
    return aiStream('/ai/reply', payload, onDelta)
}

async function aiStream(path, payload, onDelta) {
    const res = await fetch(`${import.meta.env.VITE_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `${localStorage.getItem('token')}`,
        },
        body: JSON.stringify({ ...payload, stream: true }),
    })
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream')) {
        const data = await res.json().catch(() => ({}))
        throw data
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let donePayload = null
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
            const event = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            for (const line of event.split('\n')) {
                const t = line.trim()
                if (!t.startsWith('data:')) continue
                let obj
                try { obj = JSON.parse(t.slice(5).trim()) } catch { continue }
                if (typeof obj.delta === 'string' && obj.delta) onDelta(obj.delta)
                if (obj.done) donePayload = obj
                if (obj.error) throw { code: obj.error }
            }
        }
    }
    if (!donePayload) throw { code: 'ai_unavailable' }
    return donePayload
}

export function aiSummarize(payload) {
    return http.post('/ai/summarize', payload, {noMsg: true})
}

// 流式摘要：逐 token 回调，结束帧返回 {summary, remaining}。
// 服务端业务错误在建流前以 JSON 返回，aiStream 会把它转成带 code 的异常，
// 调用方据此回退一次性 aiSummarize。
export function aiSummarizeStream(payload, onDelta) {
    return aiStream('/ai/summarize', payload, onDelta)
}

// Phase 8：AI 助手（多轮对话 / 归类）与翻译。约定与 Phase 7 相同：
// 后端业务错误 HTTP 恒 200，真实错误码在 body.code，调用方按 body.code
// 查 ai.* 翻译展示，故一律用 noMsg。
export function aiChat(payload) {
    return http.post('/ai/chat', payload, {noMsg: true})
}

export function aiChatHistory() {
    return http.get('/ai/chat/history', {noMsg: true})
}

export function aiClearChat() {
    return http.post('/ai/chat/clear', {}, {noMsg: true})
}

export function aiTriage(payload) {
    return http.post('/ai/triage', payload, {noMsg: true})
}

export function aiTranslate(payload) {
    return http.post('/ai/translate', payload, {noMsg: true})
}

// 流式翻译：逐 token 回调，结束帧返回
// {translatedText, sourceLang, targetLang, truncated, cached, remaining}。
export function aiTranslateStream(payload, onDelta) {
    return aiStream('/ai/translate', payload, onDelta)
}

// AI 当日用量查询（顶栏额度展示用）：只读计数，不调模型、不计次数。
export function aiUsage() {
    return http.get('/ai/usage', {noMsg: true})
}

// 后端 AI 错误码（body.code）→ 前端 ai.* 翻译 key；
// 未知错误一律按 ai_unavailable 展示，不把原始错误码裸露给用户。
const AI_ERROR_KEYS = {
    ai_disabled: 'ai.disabled',
    ai_quota_exceeded: 'ai.quotaExceeded',
    ai_unavailable: 'ai.unavailable',
    ai_invalid_input: 'ai.invalidInput',
    ai_not_found: 'ai.notFound',
    ai_e2ee_unsupported: 'ai.e2eeUnsupported',
}

export function aiErrorI18nKey(code) {
    return AI_ERROR_KEYS[code] || 'ai.unavailable'
}
