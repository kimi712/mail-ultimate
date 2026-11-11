// Phase 8 F：账号恢复请求（公开接口，无需登录态）。
import http from '@/axios/index.js';

export function generateRecoveryCodes(password) {
	return http.post('/my/recovery-codes/generate', { password }, { noMsg: true });
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

export function resetByCode(email, code, newPassword) {
	return http.post('/recovery/reset-by-code', { email, code, newPassword }, { noMsg: true });
}

export function requestResetLink(email) {
	return http.post('/recovery/request-link', { email }, { noMsg: true });
}

export function resetByToken(email, token, newPassword) {
	return http.post('/recovery/reset-by-token', { email, token, newPassword }, { noMsg: true });
}
