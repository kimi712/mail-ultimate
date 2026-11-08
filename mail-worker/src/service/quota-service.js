import KvConst from '../const/kv-const';
import settingService from './setting-service';
import telegramService from './telegram-service';
import dayjs from 'dayjs';

// Resend 全站配额保护：KV 日/月计数 + 撞线停发 + 80% 告警。
// 注意 KV 不是强一致、计数是 read-modify-write，高并发下可能少计几封；
// 预算检查读同一计数器，少量超支可接受（Resend 侧也有硬限制兜底）。
// 计数与告警永不抛错，不得影响发信主流程。
const quotaService = {

	_dayKey() {
		return KvConst.RESEND_DAY + dayjs().format('YYYY-MM-DD');
	},

	_monthKey() {
		return KvConst.RESEND_MONTH + dayjs().format('YYYY-MM');
	},

	async getResendUsage(c) {
		const setting = await settingService.query(c);
		let day = 0;
		let month = 0;
		try {
			day = Number(await c.env.kv.get(this._dayKey())) || 0;
		} catch (e) {
			console.error('读 Resend 日用量失败:', e.message);
		}
		try {
			month = Number(await c.env.kv.get(this._monthKey())) || 0;
		} catch (e) {
			console.error('读 Resend 月用量失败:', e.message);
		}
		return {
			day,
			month,
			dayBudget: setting.resendDayBudget || 100,
			monthBudget: setting.resendMonthBudget || 3000
		};
	},

	async hasResendBudget(c) {
		const usage = await this.getResendUsage(c);
		return usage.day < usage.dayBudget && usage.month < usage.monthBudget;
	},

	async recordResendSent(c, n) {
		if (!n || n <= 0) {
			return;
		}
		try {
			const dayKey = this._dayKey();
			const monthKey = this._monthKey();
			const dayCount = (Number(await c.env.kv.get(dayKey)) || 0) + n;
			await c.env.kv.put(dayKey, JSON.stringify(dayCount), { expirationTtl: 60 * 60 * 48 });
			const monthCount = (Number(await c.env.kv.get(monthKey)) || 0) + n;
			await c.env.kv.put(monthKey, JSON.stringify(monthCount), { expirationTtl: 60 * 60 * 24 * 40 });
		} catch (e) {
			console.error('记 Resend 用量失败:', e.message);
		}
	},

	// 用量达到预算 80% 时发一次 TG 告警（每天每档最多 1 次，用 KV 标记去重）。
	async maybeAlertQuota(c) {
		try {
			const usage = await this.getResendUsage(c);
			const dayPct = usage.dayBudget > 0 ? usage.day / usage.dayBudget : 0;
			const monthPct = usage.monthBudget > 0 ? usage.month / usage.monthBudget : 0;
			if (dayPct < 0.8 && monthPct < 0.8) {
				return;
			}
			const dateStr = dayjs().format('YYYY-MM-DD');
			const flagKey = KvConst.RESEND_ALERT_DAY + dateStr;
			if (await c.env.kv.get(flagKey)) {
				return;
			}
			await c.env.kv.put(flagKey, '1', { expirationTtl: 60 * 60 * 24 });
			if (typeof telegramService.sendAlert === 'function') {
				const lines = [];
				if (dayPct >= 0.8) {
					lines.push(`Resend 今日用量 ${usage.day}/${usage.dayBudget}（${Math.round(dayPct * 100)}%）`);
				}
				if (monthPct >= 0.8) {
					lines.push(`Resend 本月用量 ${usage.month}/${usage.monthBudget}（${Math.round(monthPct * 100)}%）`);
				}
				await telegramService.sendAlert(c, `⚠️ Resend 配额告警\n${lines.join('\n')}`);
			}
		} catch (e) {
			console.error('Resend 配额告警失败:', e.message);
		}
	}

};

export default quotaService;
