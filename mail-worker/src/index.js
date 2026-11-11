import app from './hono/webs';
import { email } from './email/email';
import userService from './service/user-service';
import verifyRecordService from './service/verify-record-service';
import emailService from './service/email-service';
import r2Service from './service/r2-service';
import oauthService from './service/oauth-service';
import analysisService from './service/analysis-service';
import logRetentionService from './service/log-retention-service';
import deadmanService from './service/deadman-service';
// 斯诺登第四批 P2-5：自动过期别名到期清扫。
import aliasExpiryService from './service/alias-expiry-service';
import { validateFieldEncKey, getFieldEncKey } from './kernel/secrets';

// Phase 8 A §8.1：field_enc_key 启动校验状态（每个 isolate 只查一次）。
// 部署时 deploy.sh 已先校验并会直接失败，这里是第二道防线；
// 校验失败只记日志、不阻断请求（读信/登录不受影响；发信路径的
// setting-service.refresh() 也会校验并保留上一次正确的 KV 值）。
let fieldEncKeyChecked = false;
export default {
	 async fetch(req, env, ctx) {

		if (!fieldEncKeyChecked) {
			fieldEncKeyChecked = true;
			const chk = validateFieldEncKey(getFieldEncKey(env));
			if (!chk.ok) {
				console.error(`[field_enc_key] 启动校验失败 (${chk.code})：${chk.message}`);
			}
		}

		const url = new URL(req.url)

		if (url.pathname.startsWith('/api/')) {
			url.pathname = url.pathname.replace('/api', '')
			req = new Request(url.toString(), req)
			return app.fetch(req, env, ctx);
		}

		if (url.pathname.startsWith('/oss/')) {
			const key = url.pathname.slice('/oss/'.length);
			const resp = await r2Service.toObjResp({ env }, key);
			return resp || new Response('Not Found', { status: 404 });
		}

		 if (['/static/','/attachments/'].some(p => url.pathname.startsWith(p))) {
			 const resp = await r2Service.toObjResp({ env }, url.pathname.substring(1));
			 return resp || new Response('Not Found', { status: 404 });
		 }

		// /assets/* 是带 hash 的构建产物：文件不存在说明是旧版 index.html 引用的过期 chunk。
		// 不能让 SPA 回退把它当成 index.html 返回，否则浏览器拿到 HTML 当 JS 解析会报
		// “Failed to fetch dynamically imported module”，且边缘缓存会把这份 HTML 以
		// immutable 长缓存下来污染该 URL。直接 404，前端 main.js 的 chunk 失败处理会刷新拿新版。
		if (url.pathname.startsWith('/assets/')) {
			const resp = await env.assets.fetch(req);
			const ct = resp.headers.get('content-type') || '';
			const isJsOrCss = /\.(js|css|map)$/.test(url.pathname);
			if (isJsOrCss && ct.includes('text/html')) {
				return new Response('Not Found', { status: 404 });
			}
			return resp;
		}

		return env.assets.fetch(req);
	},
	email: email,
	async scheduled(c, env, ctx) {
		if (c.cron === '*/30 * * * *') {
			await analysisService.refreshEchartsCache({ env })
			return;
		}

		await verifyRecordService.clearRecord({ env })
		await userService.resetDaySendCount({ env })
		await emailService.completeReceiveAll({ env })
		await emailService.autoClean({ env })
		// 自毁邮件兜底清扫（每小时）：删掉已过期的信（D1 行 + 附件 + 星标）。
		try {
			await emailService.sweepExpired({ env });
		} catch (e) {
			console.error('自毁邮件清扫失败:', e.message);
		}
		// 斯诺登第四批 P2-5：自动过期别名到期清扫（best-effort，永不阻断 cron）。
		try {
			await aliasExpiryService.sweepExpiredAliases({ env });
		} catch (e) {
			console.error('别名到期清扫失败:', e.message);
		}
		// Phase 8 E：撤回/定时发送兜底扫表（窗口结束靠前端倒计时确认；用户关页面后
		// 由 cron 兜底发出，最晚约 1 小时。best-effort，永不阻断 cron）。
		try {
			await emailService.processDuePending({ env });
			await emailService.processDueScheduled({ env });
		} catch (e) {
			console.error('撤回/定时发送兜底扫表失败:', e.message);
		}
		// Phase 6：日志留存清理（每小时分支；best-effort，永不阻断 cron）。
		try {
			await logRetentionService.cleanup({ env });
		} catch (e) {
			console.error('日志留存清理失败:', e.message);
		}
		// 斯诺登第二批（v3_15DB）：死亡开关每小时检查（先提醒、再执行，全程幂等；
		// best-effort，永不阻断 cron。注意：cron 上下文无 c.req，kernelAudit 写审计
		// 会静默失败，提醒/执行以 dead_man_switch 行的 warned_at/executed_at 为准）。
		try {
			await deadmanService.check({ env });
		} catch (e) {
			console.error('死亡开关检查失败:', e.message);
		}
		// 斯诺登第三批（v3_16DB）：时间锁密钥到期放行 + 混淆信生效后补跑转发/规则
		// （每小时；best-effort，永不阻断 cron）。
		try {
			await emailService.processDueDeliveries({ env });
		} catch (e) {
			console.error('到期投递扫表失败:', e.message);
		}
		await analysisService.refreshEchartsCache({ env })
		await oauthService.clearNoBindOathUser({ env })
	},
};
