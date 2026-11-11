// 斯诺登第四批请求封装（前端）。
// 后端路由见 mail-worker/src/api/ 下新增的四个 api 文件；挂载前
// （webs.js 加 import 行）这些请求会 404，属待接线状态，见报告。
import http from '@/axios/index.js'

// P0-2 管理员审计全局视图（仅管理员）
export function getAdminAuditLog(params) {
	return http.get('/admin/audit-log', { params, noMsg: true })
}

export function getAdminAuditCoverage() {
	return http.get('/admin/audit-log/coverage', { noMsg: true })
}

// P1-3 阅后即焚策略判定与核验
export function getBurnPolicy(e2ee, expireOption) {
	return http.get('/email/burn-policy', { params: { e2ee, expireOption }, noMsg: true })
}

export function verifyBurnGroup(group) {
	return http.get('/email/burn-verify', { params: { group }, noMsg: true })
}

// P1-4 一键锁定账号（自锁）与本人异常登录记录
export function lockMyAccount(reason) {
	return http.post('/security/lock-account', { reason: reason || 'self_lock' }, { noMsg: true })
}

export function getMyLoginAnomalies(params) {
	return http.get('/security/login-anomalies', { params, noMsg: true })
}

// P2-5 别名有效期
export function setAliasExpiry(aliasId, days) {
	return http.post('/alias/expiry', { aliasId, days }, { noMsg: true })
}

export function getAliasExpiry(aliasId) {
	return http.get('/alias/expiry', { params: { aliasId }, noMsg: true })
}
