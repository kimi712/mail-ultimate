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

// E2EE 密钥重包（2026-11-12 uwu 第 2 步）：取 sym 包裹 / 分批重包 / 上报暴露状态。
export function listE2eeWraps(limit = 200, offset = 0) {
	return http.get('/my/e2ee/wraps', {params: {limit, offset}, noMsg: true});
}
export function rewrapE2ee(items) {
	return http.post('/my/e2ee/rewrap', {items}, {noMsg: true});
}
export function reportE2eeExposure(state) {
	return http.post('/my/e2ee/exposure', {state}, {noMsg: true});
}

export function totpSetup(oldCode) {
	return http.post('/my/totp/setup', {oldCode: oldCode || ''}, {noMsg: true});
}

export function totpEnable(code) {
	return http.post('/my/totp/enable', {code}, {noMsg: true});
}

export function totpDisable(loginKey, code) {
	return http.post('/my/totp/disable', {loginKey, code}, {noMsg: true});
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

// Phase 7：安全中心专用登录历史（时间/IP/设备/浏览器/是否新 IP/地点恒为空）。
export function loginHistory(params) {
	return http.get('/security/login-history', {params, noMsg: true});
}

// 斯诺登第二批（v3_15DB）：抗量子 ML-KEM-768 密钥 + 死亡开关。
// 公钥可公开（发件方按收件地址取）；加密私钥只返回给本人。
export function getMlkemPubkey(email) {
	return http.get('/my/security/mlkem-pubkey', {params: {email}, noMsg: true});
}

export function getMlkemPrivate() {
	return http.get('/my/security/mlkem-private', {noMsg: true});
}

export function setMlkemKeys(publicKey, privEnc) {
	return http.post('/my/security/mlkem-keys', {publicKey, privEnc}, {noMsg: true});
}

export function getDeadman() {
	return http.get('/my/deadman', {noMsg: true});
}

export function setDeadman(payload) {
	return http.post('/my/deadman', payload, {noMsg: true});
}

export function disableDeadman() {
	return http.post('/my/deadman/disable', {}, {noMsg: true});
}

// Phase 7：闲置锁定后解锁，只校验登录密码，不产生新会话。
export function unlock(loginKey) {
	return http.post('/security/unlock', {loginKey}, {noMsg: true});
}

// Phase 7：导出我的数据（JSON，不含邮件正文与任何密钥材料）。
export function exportData() {
	return http.get('/my/export', {noMsg: true});
}

// Phase 8 B：安全评分（总分 100 + 分项得分 + 改进建议 key 列表）。
export function getSecurityScore() {
	return http.get('/security/score', {noMsg: true});
}

// Phase 8 B：用户侧审计视图（只查本人；type 按白名单前缀筛选）。
export function myAuditLog(params) {
	return http.get('/security/audit-log', {params, noMsg: true});
}
