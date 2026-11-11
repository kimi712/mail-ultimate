// 斯诺登第三批（v3_16DB）：胁迫密码（第二密码）管理。
// 主密码进真实邮箱，胁迫密码进诱饵邮箱（只看得到播种的诱饵邮件，不暴露
// 真实数据、不触发任何告警）。设/改/关均须先验主密码（防会话被盗后被人
// 悄悄改掉；校验由 decoy-service.setSecondPassword/disable 内部完成）。
// 注意：诱饵会话下这些接口一律返回“未设置”（不透露真实设置状态）。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import decoyService from '../service/decoy-service';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';

// 状态：是否已设胁迫密码（诱饵会话下恒返回未设置）。
app.get('/my/duress/status', async (c) => {
	const userId = userContext.getUserId(c);
	if (userContext.isDecoy(c)) {
		return c.json(result.ok({ enabled: false }));
	}
	const status = await decoyService.getStatus(c, userId);
	return c.json(result.ok({ enabled: status.enabled === 1 }));
});

// 设置胁迫密码：{ password（主密码）, duressPassword }。
// 内部验主密码、验第二密码≠主密码、播种诱饵邮件。
app.post('/my/duress/set', async (c) => {
	const userId = userContext.getUserId(c);
	if (userContext.isDecoy(c)) {
		throw new BizError(t('unauthorized'), 403);
	}
	const { password, duressPassword } = await c.req.json().catch(() => ({}));
	const status = await decoyService.setSecondPassword(c, userId, {
		password: duressPassword, currentPassword: password
	});
	return c.json(result.ok({ enabled: status.enabled === 1 }));
});

// 改胁迫密码：{ password（主密码）, duressPassword（新） }。
// 与设置同一入口（setSecondPassword 已存在时为覆盖更新）。
app.post('/my/duress/change', async (c) => {
	const userId = userContext.getUserId(c);
	if (userContext.isDecoy(c)) {
		throw new BizError(t('unauthorized'), 403);
	}
	const { password, duressPassword } = await c.req.json().catch(() => ({}));
	const status = await decoyService.setSecondPassword(c, userId, {
		password: duressPassword, currentPassword: password
	});
	return c.json(result.ok({ enabled: status.enabled === 1 }));
});

// 关闭胁迫密码：{ password（主密码） }。
app.post('/my/duress/disable', async (c) => {
	const userId = userContext.getUserId(c);
	if (userContext.isDecoy(c)) {
		throw new BizError(t('unauthorized'), 403);
	}
	const { password } = await c.req.json().catch(() => ({}));
	const status = await decoyService.disable(c, userId, { password });
	return c.json(result.ok({ enabled: status.enabled === 1 }));
});
