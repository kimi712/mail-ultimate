const KvConst = {
	AUTH_INFO: 'auth-uid:',
	SETTING: 'setting:',
	SEND_DAY_COUNT: 'send_day_count:',
	ANALYSIS_ECHARTS: 'analysis_echarts:',
	RESEND_DAY: 'resend_day:',
	RESEND_MONTH: 'resend_month:',
	RESEND_ALERT_DAY: 'resend_quota_alert_day:',
	REG_KEY_ALERT_DAY: 'reg_key_alert_day:',
	// Phase 6：TOTP 待验证（value: {userId, attempts}，TTL 300 秒）
	TOTP_PENDING: 'totp_pending:',
	// Phase 6：Passkey challenge（value: challenge 字符串，TTL 300 秒）
	PASSKEY_CHALLENGE: 'passkey_challenge:',
	// Phase 6：会话元数据（value: {digest: {ua, ip, createdAt}}，与 AUTH_INFO 同 TTL）
	SESSION_META: 'session_meta:',
	// Phase 7：闲置解锁连续失败计数（value: 数字，TTL 300 秒；5 次后锁 5 分钟）
	UNLOCK_FAIL: 'unlock_fail:',
	// Phase 7：AI 每用户每天调用计数（value: 数字，key 含 userId 与日期，TTL 48 小时；上限 50）
	AI_DAY: 'ai_day:'
}

export default KvConst;
