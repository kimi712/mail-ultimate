import analysisDao from '../dao/analysis-dao';
import orm from '../entity/orm';
import email from '../entity/email';
import { desc, count, eq, and, ne, isNotNull } from 'drizzle-orm';
import { emailConst } from '../const/entity-const';
import kvConst from '../const/kv-const';
import dayjs from 'dayjs';
import { toUtc } from '../utils/date-uitil';
import settingService from './setting-service';
import quotaService from './quota-service';
import { t } from '../i18n/i18n';
const analysisService = {

	async echarts(c, params) {
		if (!this.analysisCacheEnabled(c)) {
			return await this.queryEcharts(c, params);
		}

		const cacheKey = this.echartsCacheKey(params);
		const cache = await c.env.kv.get(cacheKey, { type: 'json' });

		if (cache) {
			return cache;
		}

		return await this.refreshEchartsCacheByKey(c, cacheKey);
	},

	async refreshEchartsCacheByKey(c, cacheKey) {
		const params = this.echartsParamsByCacheKey(cacheKey);
		const data = await this.queryEcharts(c, params);
		await c.env.kv.put(cacheKey, JSON.stringify(data));
		return data;
	},

	async refreshEchartsCache(c) {
		if (!this.analysisCacheEnabled(c)) {
			return;
		}

		const { keys } = await c.env.kv.list({ prefix: kvConst.ANALYSIS_ECHARTS });

		await Promise.all(keys.map(key => this.refreshEchartsCacheByKey(c, key.name)));
	},

	async queryEcharts(c, params) {

		const { timeZone } = params;

		let utcDate = toUtc().startOf('day');

		let localDate = utcDate.tz(timeZone);

		utcDate = dayjs(utcDate.format('YYYY-MM-DD HH:mm:ss'))

		localDate = dayjs(localDate.format('YYYY-MM-DD HH:mm:ss'))

		//获取时差
		const diffHours = localDate.diff(utcDate, 'hour',true);


		// Phase 2 C 路：风控查询与原有查询并行。任一风控查询失败不得拖垮
		// 整个仪表盘：safe() 捕获后给默认值，其余字段原样不动。
		const safe = (promise, fallback) => promise.catch((e) => {
			console.error('风控查询失败:', e.message);
			return fallback;
		});

		const [
			numberCount,
			nameRatio,
			userDayCountRaw,
			receiveDayCountRaw,
			sendDayCountRaw,
			daySendTotalRaw,
			registerTrendRaw,
			ipTop10,
			circuitCountRow,
			regKeyRemainingRow,
			resendUsage,
			setting
		] = await Promise.all([
			analysisDao.numberCount(c),

			orm(c)
				.select({ name: email.name, total: count() })
				.from(email)
				.where(and(eq(email.type, emailConst.type.RECEIVE), isNotNull(email.name),ne(email.name,'noreply'), ne(email.name,'')))
				.groupBy(email.name)
				.orderBy(desc(count()))
				.limit(6),


			analysisDao.userDayCount(c, diffHours),
			analysisDao.receiveDayCount(c, diffHours),
			analysisDao.sendDayCount(c, diffHours),

			c.env.kv.get(kvConst.SEND_DAY_COUNT + dayjs().format('YYYY-MM-DD')),

			// registerTrend：register_log result=0 近 15 天按日计数（UTC 日期序列，
			// 复用 filterEmptyDay；与 userDayCount 同样只取到昨天）。
			safe(c.env.db.prepare(
				`SELECT DATE(create_time) AS date, COUNT(*) AS total FROM register_log WHERE result = 0 AND create_time >= datetime('now', '-15 days') GROUP BY DATE(create_time) ORDER BY date ASC`
			).all().then(({ results }) => results), []),

			// ipTop10：user 表 create_ip Top 10（仅未删除用户）。
			safe(c.env.db.prepare(
				`SELECT create_ip, COUNT(*) AS total FROM user WHERE is_del = 0 AND create_ip IS NOT NULL AND create_ip != '' GROUP BY create_ip ORDER BY total DESC LIMIT 10`
			).all().then(({ results }) => results), []),

			// circuitEvents 条数：近 7 天 fail_reason 含熔断拒绝的失败注册。
			// 注意 fail_reason 存的是 t('regCircuitOpen') 的译文而非 key 本身，
			// 故按译文匹配（当前语言 + 中文兜底）；LIKE '%regCircuitOpen%' 恒为 0。
			// 另注意：D1 的 LIKE 对长中文模式会报 "LIKE or GLOB pattern too complex"，
			// 故用 instr() 做子串匹配，不用 LIKE。
			safe(c.env.db.prepare(
				`SELECT COUNT(*) AS n FROM register_log WHERE create_time >= datetime('now', '-7 days') AND (instr(fail_reason, ?) > 0 OR instr(fail_reason, ?) > 0)`
			).bind(t('regCircuitOpen'), '暂时关闭维护').first(), { n: 0 }),

			// regKeyRemaining：未过期密钥 SUM(count)。
			safe(c.env.db.prepare(
				`SELECT COALESCE(SUM(count), 0) AS total FROM reg_key WHERE count > 0 AND datetime(expire_time) > datetime('now')`
			).first(), { total: 0 }),

			safe(quotaService.getResendUsage(c), { day: 0, month: 0, dayBudget: 100, monthBudget: 3000 }),

			safe(settingService.query(c), {})
		]);


		const userDayCount = this.filterEmptyDay(userDayCountRaw, timeZone);
		const receiveDayCount = this.filterEmptyDay(receiveDayCountRaw, timeZone);
		const sendDayCount = this.filterEmptyDay(sendDayCountRaw, timeZone);
		const registerTrend = this.filterEmptyDay(registerTrendRaw, 'UTC');

		const daySendTotal = daySendTotalRaw || 0;

		return {
			numberCount,
			userDayCount,
			receiveRatio: {
				nameRatio
			},
			emailDayCount: {
				receiveDayCount,
				sendDayCount
			},
			daySendTotal: Number(daySendTotal),
			risk: {
				registerTrend,
				ipTop10,
				circuitEvents: {
					count: Number(circuitCountRow?.n || 0),
					open: Number(setting?.regCircuitOpen ?? 0)
				},
				regKeyRemaining: Number(regKeyRemainingRow?.total || 0),
				resendUsage
			}
		};
	},

	filterEmptyDay(data, timeZone) {
		const today = toUtc().tz(timeZone).subtract(1, 'day');
		const previousDays = Array.from({ length: 15 }, (_, i) => {
			return today.subtract(i, 'day').format('YYYY-MM-DD');
		}).reverse();

		return  previousDays.map(day => {
			const index = data.findIndex(item => item.date === day)
			const total = index > - 1 ? data[index].total : 0
			return {date: day,total}
		})

	},

	echartsCacheKey(params = {}) {
		return kvConst.ANALYSIS_ECHARTS + encodeURIComponent(params.timeZone || 'UTC');
	},

	echartsParamsByCacheKey(cacheKey) {
		return {
			timeZone: decodeURIComponent(cacheKey.replace(kvConst.ANALYSIS_ECHARTS, ''))
		};
	},

	analysisCacheEnabled(c) {
		return c.env.analysis_cache === true || c.env.analysis_cache === 'true';
	}
}

export default  analysisService
