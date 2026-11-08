// 安全中心请求（第六阶段 C 路）：路径与 payload 一字不差按 PHASE5-6-CONTRACT.md §1.3。
// 注意：后端（B 路）与本前端并行开发，接口可能尚未落地；请求本身用 noMsg，
// 失败时由调用方按需提示，不由拦截器自动弹错。
// loginLog 复用 request/my.js 的 loginLog，不在此重复定义。
import http from '@/axios/index.js';

export function getSecurity() {
	return http.get('/my/security', {noMsg: true});
}

// retentionDays 只接受 0/30/90/365；e2eeSalt 仅在开启 E2EE 且后端未返回 salt 时由前端生成后传入。
export function setSecurity(payload) {
	return http.post('/my/security', payload, {noMsg: true});
}

export function totpSetup() {
	return http.post('/my/totp/setup', {}, {noMsg: true});
}

export function totpEnable(code) {
	return http.post('/my/totp/enable', {code}, {noMsg: true});
}

export function totpDisable(password, code) {
	return http.post('/my/totp/disable', {password, code}, {noMsg: true});
}

export function passkeyRegisterOptions() {
	return http.post('/my/passkey/register-options', {}, {noMsg: true});
}

export function passkeyRegister(response) {
	return http.post('/my/passkey/register', {response}, {noMsg: true});
}

export function passkeyList() {
	return http.get('/my/passkey/list', {noMsg: true});
}

export function passkeyDelete(credentialId) {
	return http.delete('/my/passkey/' + encodeURIComponent(credentialId), {noMsg: true});
}

export function sessions() {
	return http.get('/my/sessions', {noMsg: true});
}

export function revokeSession(digest) {
	return http.post('/my/sessions/revoke', {digest}, {noMsg: true});
}

export function revokeOtherSessions() {
	return http.post('/my/sessions/revoke', {allExceptCurrent: true}, {noMsg: true});
}
