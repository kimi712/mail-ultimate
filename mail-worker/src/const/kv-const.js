const KvConst = {
	AUTH_INFO: 'auth-uid:',
	SETTING: 'setting:',
	SEND_DAY_COUNT: 'send_day_count:',
	ANALYSIS_ECHARTS: 'analysis_echarts:',
	PUBLIC_KEY: "public_key:",
	RESEND_DAY: 'resend_day:',
	RESEND_MONTH: 'resend_month:',
	RESEND_ALERT_DAY: 'resend_quota_alert_day:',
	REG_KEY_ALERT_DAY: 'reg_key_alert_day:',
	// Phase 6：TOTP 待验证（value: {userId, attempts}，TTL 300 秒）
	TOTP_PENDING: 'totp_pending:',
	// Phase 6：Passkey challenge（value: challenge 字符串，TTL 300 秒）
	PASSKEY_CHALLENGE: 'passkey_challenge:',
	// Phase 6：会话元数据（value: {digest: {ua, ip, createdAt}}，与 AUTH_INFO 同 TTL）
	SESSION_META: 'session_meta:'
}

export default KvConst;
