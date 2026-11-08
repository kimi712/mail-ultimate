// Phase 6：日志留存清理（每小时 cron 分支调用，见 src/index.js scheduled()）。
// 删 create_time 早于 setting.log_retention_days 天（默认 90，0 = 永久保留）的
// register_log / audit_log / login_log，分批删（每批 ≤500 行，避免 D1 写超时）；
// 用户 retention_days > 0 时软删该用户超期邮件（email.is_del = 1，先软删；
// 物理删除本阶段不做）。全程 best-effort，永不抛错、永不阻断 cron。
// c 可为 Hono 上下文或 {env}（scheduled 侧传 {env}）；时间统一 UTC
// （SQLite datetime('now', ...) 即 UTC，与 create_time 的 CURRENT_TIMESTAMP 一致）。
const BATCH_SIZE = 500;
const LOG_TABLES = ['register_log', 'audit_log', 'login_log'];

const logRetentionService = {

	async cleanup(c) {
		const result = { logsDeleted: 0, emailsSoftDeleted: 0 };
		try {
			const env = c?.env ?? c;
			if (!env || !env.db) {
				return result;
			}
			let retentionDays = 90;
			try {
				const row = await env.db.prepare('SELECT log_retention_days FROM setting LIMIT 1').first();
				if (row && row.log_retention_days !== null && row.log_retention_days !== undefined) {
					retentionDays = Number(row.log_retention_days);
				}
			} catch (e) {
				console.error('读日志留存配置失败，按默认 90 天清理:', e.message);
			}
			if (retentionDays > 0) {
				result.logsDeleted = await this._cleanupLogs(env, retentionDays);
			}
			result.emailsSoftDeleted = await this._softDeleteUserEmails(env);
		} catch (e) {
			console.error('日志留存清理失败:', e.message);
		}
		return result;
	},

	async _cleanupLogs(env, days) {
		let total = 0;
		for (const table of LOG_TABLES) {
			try {
				while (true) {
					const res = await env.db.prepare(
						`DELETE FROM ${table} WHERE log_id IN ` +
						`(SELECT log_id FROM ${table} WHERE create_time < datetime('now', ?) LIMIT ?)`
					).bind(`-${days} days`, BATCH_SIZE).run();
					const changed = res?.meta?.changes ?? 0;
					total += changed;
					if (changed < BATCH_SIZE) {
						break;
					}
				}
			} catch (e) {
				console.error(`清理 ${table} 失败:`, e.message);
			}
		}
		return total;
	},

	async _softDeleteUserEmails(env) {
		let total = 0;
		let users = [];
		try {
			const { results } = await env.db.prepare(
				'SELECT user_id, retention_days FROM user_security WHERE retention_days > 0'
			).all();
			users = results || [];
		} catch (e) {
			console.error('读用户保留期限失败:', e.message);
			return 0;
		}
		for (const userRow of users) {
			const days = Number(userRow.retention_days);
			if (!days || days <= 0) {
				continue;
			}
			try {
				while (true) {
					const res = await env.db.prepare(
						`UPDATE email SET is_del = 1 WHERE email_id IN ` +
						`(SELECT email_id FROM email WHERE user_id = ? AND is_del = 0 AND create_time < datetime('now', ?) LIMIT ?)`
					).bind(userRow.user_id, `-${days} days`, BATCH_SIZE).run();
					const changed = res?.meta?.changes ?? 0;
					total += changed;
					if (changed < BATCH_SIZE) {
						break;
					}
				}
			} catch (e) {
				console.error(`软删用户 ${userRow.user_id} 超期邮件失败:`, e.message);
			}
		}
		return total;
	}
};

export default logRetentionService;
