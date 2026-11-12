// Phase 8 F：账号恢复请求（公开接口，无需登录态）。
import http from '@/axios/index.js';

export function generateRecoveryCodes(loginKey) {
	return http.post('/my/recovery-codes/generate', { loginKey }, { noMsg: true });
}

export function recoveryCodesStatus() {
	return http.get('/my/recovery-codes/status', { noMsg: true });
}

export function getBackupEmail() {
	return http.get('/my/backup-email', { noMsg: true });
}

export function setBackupEmail(backupEmail) {
	return http.post('/my/backup-email', { backupEmail }, { noMsg: true });
}

export function deleteBackupEmail() {
	return http.delete('/my/backup-email', { noMsg: true });
}

// 2026-11-12 uwu 第 1 步：新密码在浏览器内派生（PBKDF2-600k + HKDF），
// 只发登录密钥 + 新盐，不发明文密码。重置后旧口令加密的邮件不可读
// （旧密钥已丢），页内有明示。
export function resetByCode(email, code, loginKey, salt) {
	return http.post('/recovery/reset-by-code', { email, code, loginKey, salt }, { noMsg: true });
}

export function requestResetLink(email) {
	return http.post('/recovery/request-link', { email }, { noMsg: true });
}

export function resetByToken(email, token, loginKey, salt) {
	return http.post('/recovery/reset-by-token', { email, token, loginKey, salt }, { noMsg: true });
}
