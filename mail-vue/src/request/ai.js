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

export function aiSummarize(payload) {
    return http.post('/ai/summarize', payload, {noMsg: true})
}

// 后端 AI 错误码（body.code）→ 前端 ai.* 翻译 key；
// 未知错误一律按 ai_unavailable 展示，不把原始错误码裸露给用户。
const AI_ERROR_KEYS = {
    ai_disabled: 'ai.disabled',
    ai_quota_exceeded: 'ai.quotaExceeded',
    ai_unavailable: 'ai.unavailable',
    ai_invalid_input: 'ai.invalidInput',
    ai_not_found: 'ai.notFound',
}

export function aiErrorI18nKey(code) {
    return AI_ERROR_KEYS[code] || 'ai.unavailable'
}
