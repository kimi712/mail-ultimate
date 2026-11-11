import http from '@/axios/index.js';

// Phase 8 E：邮件信任与控制。
// 后端业务错误遵循项目约定：HTTP 恒 200，真实错误码在 body.code
// （trust_* 字符串码）；一律用 noMsg，由调用方按 body.code 查 trust.*
// 翻译展示（映射见 trustErrorI18nKey）。
export function trustRead(emailId) {
    return http.get(`/mail-trust/read/${emailId}`, { noMsg: true })
}

export function trustGetPrefs() {
    return http.get('/mail-trust/prefs', { noMsg: true })
}

export function trustSetPrefs(payload) {
    return http.put('/mail-trust/prefs', payload, { noMsg: true })
}

export function trustListSenders() {
    return http.get('/mail-trust/trusted-senders', { noMsg: true })
}

export function trustSender(senderEmail) {
    return http.post('/mail-trust/trust-sender', { senderEmail }, { noMsg: true })
}

export function untrustSender(senderEmail) {
    return http.delete('/mail-trust/trust-sender', { params: { senderEmail }, noMsg: true })
}

export function trustMarkSpam(emailId) {
    return http.post('/mail-trust/spam', { emailId }, { noMsg: true })
}

export function trustNotSpam(emailId) {
    return http.post('/mail-trust/not-spam', { emailId }, { noMsg: true })
}

export function trustReportPhishing(emailId) {
    return http.post('/mail-trust/report-phishing', { emailId }, { noMsg: true })
}

export function trustGetUnsubscribe(emailId) {
    return http.get(`/mail-trust/unsubscribe/${emailId}`, { noMsg: true })
}

export function trustUnsubscribe(emailId) {
    return http.post('/mail-trust/unsubscribe', { emailId }, { noMsg: true })
}

export function trustGetPending(pendingId) {
    return http.get(`/mail-trust/pending/${pendingId}`, { noMsg: true })
}

export function trustCancelPending(pendingId) {
    return http.post(`/mail-trust/pending/${pendingId}/cancel`, {}, { noMsg: true })
}

export function trustConfirmPending(pendingId) {
    return http.post(`/mail-trust/pending/${pendingId}/confirm`, {}, { noMsg: true })
}

export function trustListScheduled() {
    return http.get('/mail-trust/scheduled', { noMsg: true })
}

export function trustCancelScheduled(scheduledId) {
    return http.post(`/mail-trust/scheduled/${scheduledId}/cancel`, {}, { noMsg: true })
}

// 后端 trust_* 错误码（body.code）→ 前端 trust.* 翻译 key；
// 未知错误一律按 trust.error 展示，不把原始错误码裸露给用户。
const TRUST_ERROR_KEYS = {
    trust_email_not_found: 'trust.emailNotFound',
    trust_not_received: 'trust.notReceived',
    trust_invalid_sender: 'trust.invalidSender',
    trust_invalid_undo_delay: 'trust.invalidUndoDelay',
    trust_invalid_remote_images: 'trust.invalidRemoteImages',
    trust_invalid_forward_email: 'trust.invalidForwardEmail',
    trust_invalid_sender_account: 'trust.invalidSenderAccount',
    trust_no_recipient: 'trust.noRecipient',
    trust_invalid_schedule_time: 'trust.invalidScheduleTime',
    trust_pending_not_found: 'trust.pendingNotFound',
    trust_pending_cancelled: 'trust.pendingCancelled',
    trust_pending_sent: 'trust.pendingSent',
    trust_pending_failed: 'trust.pendingFailed',
    trust_undo_expired: 'trust.undoExpired',
    trust_undo_not_expired: 'trust.undoNotExpired',
    trust_schedule_not_found: 'trust.scheduleNotFound',
    trust_schedule_not_pending: 'trust.scheduleNotPending',
    trust_no_unsubscribe: 'trust.noUnsubscribe',
    trust_unsubscribe_failed: 'trust.unsubscribeFailed',
}

export function trustErrorI18nKey(code) {
    return TRUST_ERROR_KEYS[code] || 'trust.error'
}
