// 斯诺登第三批（v3_16DB）请求：胁迫密码 / 可搜索加密（盲索引）。
import http from '@/axios/index.js';

// ---- 胁迫密码（第二密码）----
export function getDuressStatus() {
	return http.get('/my/duress/status', {noMsg: true});
}

export function setDuressPassword(mainLoginKey, duressPassword) {
	return http.post('/my/duress/set', {mainLoginKey, duressPassword}, {noMsg: true});
}

export function changeDuressPassword(mainLoginKey, duressPassword) {
	return http.post('/my/duress/change', {mainLoginKey, duressPassword}, {noMsg: true});
}

export function disableDuressPassword(mainLoginKey) {
	return http.post('/my/duress/disable', {mainLoginKey}, {noMsg: true});
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
