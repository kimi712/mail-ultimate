// Phase 8 F：邮件规则 / 过滤器。
// 条件（全部 AND，含匹配不区分大小写）：sender_contains / subject_contains /
// recipient_contains。动作（按数组顺序执行）：tag（打标签）、archive（归档，
// 以 label='archive' 落在 email_label，本站暂无独立归档文件夹）、mark_read、
// delete、forward（转发到指定邮箱：本服务只收集目标地址并记日志，实际投递
// 由收信管线（HandleOnSiteEmail 的调用方）用返回值 forwardTo 执行，见汇报）。
// 只对新收信件执行：applyRules 只接受刚落库的新邮件行，由总协调在
// HandleOnSiteEmail 落库后调一次；旧信永远不重跑（幂等：重复打标撞唯一约束
// 即跳过，已删邮件不再执行后续变更动作）。
import orm from '../entity/orm';
import mailRule from '../entity/mail-rule';
import emailLabel from '../entity/email-label';
import mailRuleLog from '../entity/mail-rule-log';
import email from '../entity/email';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';
import { and, asc, desc, eq } from 'drizzle-orm';
import userContext from '../security/user-context';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const ARCHIVE_LABEL = 'archive';
const CONDITION_KEYS = ['sender_contains', 'subject_contains', 'recipient_contains'];
const ACTION_TYPES = ['tag', 'archive', 'mark_read', 'delete', 'forward'];

function parseJson(text, fallback) {
	try {
		return JSON.parse(text || '');
	} catch (e) {
		return fallback;
	}
}

function validateCondition(condition) {
	if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
		throw new BizError(t('mailRuleConditionInvalid'), 400);
	}
	const keys = Object.keys(condition).filter(k => CONDITION_KEYS.includes(k));
	if (keys.length === 0) {
		throw new BizError(t('mailRuleConditionInvalid'), 400);
	}
	for (const key of keys) {
		const value = String(condition[key] || '').trim();
		if (!value || value.length > 200) {
			throw new BizError(t('mailRuleConditionInvalid'), 400);
		}
		condition[key] = value;
	}
	return condition;
}

function validateActions(actions) {
	if (!Array.isArray(actions) || actions.length === 0 || actions.length > 5) {
		throw new BizError(t('mailRuleActionInvalid'), 400);
	}
	for (const action of actions) {
		if (!action || !ACTION_TYPES.includes(action.type)) {
			throw new BizError(t('mailRuleActionInvalid'), 400);
		}
		if (action.type === 'tag') {
			const label = String(action.label || '').trim().slice(0, 50);
			if (!label) {
				throw new BizError(t('mailRuleActionInvalid'), 400);
			}
			action.label = label;
		}
		if (action.type === 'forward') {
			const to = String(action.to || '').trim().toLowerCase();
			if (!EMAIL_RE.test(to)) {
				throw new BizError(t('mailRuleActionInvalid'), 400);
			}
			action.to = to;
		}
	}
	return actions;
}

function publicRule(row) {
	return {
		ruleId: row.ruleId,
		name: row.name,
		condition: parseJson(row.conditionJson, {}),
		actions: parseJson(row.actionJson, []),
		enabled: row.enabled,
		sort: row.sort,
		createdAt: row.createdAt
	};
}

const mailRuleService = {

	async create(c, userId, { name = '', condition = {}, actions = [] } = {}) {
		// 诱饵会话（v3_16DB）：拒绝建规则（不动真实规则）。
		if (userContext.isDecoy(c)) {
			throw new BizError(t('unauthorized'), 403);
		}
		const ruleName = String(name || '').trim().slice(0, 100);
		if (!ruleName) {
			throw new BizError(t('mailRuleNameRequired'), 400);
		}
		const cond = validateCondition({ ...condition });
		const acts = validateActions(actions.map(a => ({ ...a })));
		const maxSortRow = await orm(c).select().from(mailRule)
			.where(eq(mailRule.userId, userId)).orderBy(desc(mailRule.sort)).limit(1).get();
		const sort = (maxSortRow ? Number(maxSortRow.sort) : -1) + 1;
		const { ruleId } = await orm(c).insert(mailRule).values({
			userId, name: ruleName,
			conditionJson: JSON.stringify(cond),
			actionJson: JSON.stringify(acts),
			enabled: 1, sort
		}).returning().get();
		return { ruleId, name: ruleName, condition: cond, actions: acts, enabled: 1, sort };
	},

	async list(c, userId) {
		// 诱饵会话（v3_16DB）：规则列表为空（不透露真实规则）。
		if (userContext.isDecoy(c)) {
			return [];
		}
		const rows = await orm(c).select().from(mailRule)
			.where(eq(mailRule.userId, userId)).orderBy(asc(mailRule.sort), asc(mailRule.ruleId)).all();
		return rows.map(publicRule);
	},

	async update(c, userId, ruleId, { name, condition, actions, enabled, sort } = {}) {
		// 诱饵会话（v3_16DB）：规则不存在（不透露真实规则）。
		if (userContext.isDecoy(c)) {
			throw new BizError(t('mailRuleNotFound'), 404);
		}
		const row = await orm(c).select().from(mailRule)
			.where(and(eq(mailRule.userId, userId), eq(mailRule.ruleId, Number(ruleId)))).get();
		if (!row) {
			throw new BizError(t('mailRuleNotFound'), 404);
		}
		const updates = {};
		if (name !== undefined) {
			const ruleName = String(name || '').trim().slice(0, 100);
			if (!ruleName) throw new BizError(t('mailRuleNameRequired'), 400);
			updates.name = ruleName;
		}
		if (condition !== undefined) updates.conditionJson = JSON.stringify(validateCondition({ ...condition }));
		if (actions !== undefined) updates.actionJson = JSON.stringify(validateActions(actions.map(a => ({ ...a }))));
		if (enabled !== undefined) updates.enabled = enabled ? 1 : 0;
		if (sort !== undefined) updates.sort = Number(sort) || 0;
		if (Object.keys(updates).length > 0) {
			await orm(c).update(mailRule).set(updates)
				.where(and(eq(mailRule.userId, userId), eq(mailRule.ruleId, Number(ruleId)))).run();
		}
		const updated = await orm(c).select().from(mailRule)
			.where(and(eq(mailRule.userId, userId), eq(mailRule.ruleId, Number(ruleId)))).get();
		return publicRule(updated);
	},

	async remove(c, userId, ruleId) {
		// 诱饵会话（v3_16DB）：假装删除成功，实际不动真实规则。
		if (userContext.isDecoy(c)) {
			return { ok: true };
		}
		await orm(c).delete(mailRule)
			.where(and(eq(mailRule.userId, userId), eq(mailRule.ruleId, Number(ruleId)))).run();
		return { ok: true };
	},

	// 重新排序：按传入的 ruleId 数组顺序重写 sort（只改本人的规则）。
	async reorder(c, userId, ruleIds = []) {
		// 诱饵会话（v3_16DB）：假装成功，实际不动真实规则。
		if (userContext.isDecoy(c)) {
			return { ok: true };
		}
		for (let i = 0; i < ruleIds.length; i++) {
			await orm(c).update(mailRule).set({ sort: i })
				.where(and(eq(mailRule.userId, userId), eq(mailRule.ruleId, Number(ruleIds[i])))).run();
		}
		return this.list(c, userId);
	},

	// 条件匹配（全部 AND；含匹配，不区分大小写）。
	matchesRule(rule, emailRow) {
		const condition = rule.condition || {};
		const haystacks = {
			sender_contains: `${emailRow.senderEmail || ''} ${emailRow.sendEmail || ''}`,
			subject_contains: emailRow.subject || '',
			recipient_contains: `${emailRow.toEmail || ''} ${emailRow.toName || ''}`
		};
		return Object.entries(condition).every(([key, needle]) => {
			if (!CONDITION_KEYS.includes(key)) return true;
			return haystacks[key].toLowerCase().includes(String(needle).toLowerCase());
		});
	},

	// 对一封刚收到的新信按顺序执行启用的规则。只由收信管线对新信调一次；
	// 旧信不重跑；重复打标撞唯一约束即跳过；一旦删信，后续规则只记日志、
	// 不再变更该信。返回 applied（命中记录）与 forwardTo（待投递的转发目标，
	// 由调用方用现有发信/转发通道投递，本服务不直接发信）。
	async applyRules(c, userId, emailRow) {
		const rules = (await this.list(c, userId)).filter(r => r.enabled === 1);
		const applied = [];
		const forwardTo = [];
		let deleted = false;
		for (const rule of rules) {
			if (!this.matchesRule(rule, emailRow)) continue;
			const doneActions = [];
			for (const action of rule.actions) {
				try {
					if (action.type === 'tag') {
						if (!deleted) {
							await this._addLabel(c, userId, emailRow.emailId, action.label);
							doneActions.push({ type: 'tag', label: action.label });
						}
					} else if (action.type === 'archive') {
						if (!deleted) {
							await this._addLabel(c, userId, emailRow.emailId, ARCHIVE_LABEL);
							doneActions.push({ type: 'archive' });
						}
					} else if (action.type === 'mark_read') {
						if (!deleted) {
							await orm(c).update(email).set({ unread: 1 })
								.where(and(eq(email.emailId, emailRow.emailId), eq(email.userId, userId))).run();
							doneActions.push({ type: 'mark_read' });
						}
					} else if (action.type === 'delete') {
						if (!deleted) {
							await orm(c).update(email).set({ isDel: 1 })
								.where(and(eq(email.emailId, emailRow.emailId), eq(email.userId, userId))).run();
							deleted = true;
							doneActions.push({ type: 'delete' });
						}
					} else if (action.type === 'forward') {
						if (!deleted) {
							forwardTo.push(action.to);
							doneActions.push({ type: 'forward', to: action.to });
						}
					}
				} catch (e) {
					// 单个动作失败只记日志、不中断后续规则（收信主流程不受影响）。
					console.error(`规则 ${rule.ruleId} 动作 ${action.type} 失败:`, e.message);
				}
			}
			await orm(c).insert(mailRuleLog).values({
				userId, ruleId: rule.ruleId, emailId: emailRow.emailId,
				actionsJson: JSON.stringify(doneActions)
			}).run();
			applied.push({ ruleId: rule.ruleId, ruleName: rule.name, actions: doneActions });
		}
		return { emailId: emailRow.emailId, applied, forwardTo: [...new Set(forwardTo)] };
	},

	async _addLabel(c, userId, emailId, label) {
		const existing = await orm(c).select().from(emailLabel)
			.where(and(
				eq(emailLabel.userId, userId),
				eq(emailLabel.emailId, Number(emailId)),
				eq(emailLabel.label, label))).get();
		if (existing) return;
		try {
			await orm(c).insert(emailLabel).values({ userId, emailId: Number(emailId), label }).run();
		} catch (e) {
			if (!String(e.message || '').includes('UNIQUE')) throw e;
		}
	},

	// 某封信的标签（供列表页展示用；只查本人）。
	async listLabels(c, userId, emailId) {
		const rows = await orm(c).select().from(emailLabel)
			.where(and(eq(emailLabel.userId, userId), eq(emailLabel.emailId, Number(emailId)))).all();
		return rows.map(r => r.label);
	}
};

export default mailRuleService;
