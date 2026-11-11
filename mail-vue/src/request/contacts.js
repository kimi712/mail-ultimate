// Phase 8 F：联系人请求。
import http from '@/axios/index.js';

export function listContacts(params) {
	return http.get('/contacts/list', { params, noMsg: true });
}

export function addContact(payload) {
	return http.post('/contacts/add', payload, { noMsg: true });
}

export function addContactFromEmail(emailId) {
	return http.post('/contacts/add-from-email', { emailId }, { noMsg: true });
}

export function suggestContacts(q) {
	return http.get('/contacts/suggest', { params: { q }, noMsg: true });
}

export function deleteContact(contactId) {
	return http.delete('/contacts/delete', { params: { contactId }, noMsg: true });
}
