// 斯诺登第三批（v3_16DB）请求：胁迫密码 / 可搜索加密（盲索引）/ 零知识身份。
import http from '@/axios/index.js';

// ---- 胁迫密码（第二密码）----
export function getDuressStatus() {
	return http.get('/my/duress/status', {noMsg: true});
}

export function setDuressPassword(password, duressPassword) {
	return http.post('/my/duress/set', {password, duressPassword}, {noMsg: true});
}

export function changeDuressPassword(password, duressPassword) {
	return http.post('/my/duress/change', {password, duressPassword}, {noMsg: true});
}

export function disableDuressPassword(password) {
	return http.post('/my/duress/disable', {password}, {noMsg: true});
}

// ---- 可搜索加密（盲索引）----
// 读信解密后补传：{ emailId, tokens }；tokens 为前端用盲索引密钥算的 HMAC。
export function submitBlindIndex(emailId, tokens) {
	return http.post('/my/blind-index', {emailId, tokens}, {noMsg: true});
}

// 盲索引搜索：{ token } → { emailIds }。
export function blindSearch(token) {
	return http.post('/my/blind-search', {token}, {noMsg: true});
}

// ---- 零知识身份 ----
// 开通状态（登录后）。
export function getZkStatus() {
	return http.get('/my/zk-status', {noMsg: true});
}

// 开通/更换：{ password（主密码）, salt, verifier }。
export function setupZk(password, salt, verifier) {
	return http.post('/my/zk-setup', {password, salt, verifier}, {noMsg: true});
}

// 关闭：{ password（主密码） }。
export function disableZk(password) {
	return http.post('/my/zk-disable', {password}, {noMsg: true});
}
