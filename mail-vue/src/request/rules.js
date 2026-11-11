// Phase 8 F：邮件规则请求。
import http from '@/axios/index.js';

export function listRules() {
	return http.get('/mail-rules/list', { noMsg: true });
}

export function createRule(payload) {
	return http.post('/mail-rules/create', payload, { noMsg: true });
}

export function updateRule(payload) {
	return http.post('/mail-rules/update', payload, { noMsg: true });
}

export function deleteRule(ruleId) {
	return http.delete('/mail-rules/delete', { params: { ruleId }, noMsg: true });
}

export function reorderRules(ruleIds) {
	return http.post('/mail-rules/reorder', { ruleIds }, { noMsg: true });
}

export function listEmailLabels(emailId) {
	return http.get('/mail-rules/labels', { params: { emailId }, noMsg: true });
}
