// Phase 8 F：隐私仪表盘 / 新 IP 提醒请求。
import http from '@/axios/index.js';

export function getPrivacyDashboard() {
	return http.get('/privacy/dashboard', { noMsg: true });
}

export function listNewIpAlerts() {
	return http.get('/security/new-ip-alerts', { noMsg: true });
}

export function acknowledgeNewIp(ip) {
	return http.post('/security/new-ip-alerts/acknowledge', { ip }, { noMsg: true });
}

export function listKnownIps() {
	return http.get('/security/known-ips', { noMsg: true });
}
