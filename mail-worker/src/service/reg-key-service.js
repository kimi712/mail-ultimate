import orm from '../entity/orm';
import regKey from '../entity/reg-key';
import { inArray, like, eq, desc, sql, or, and, gt } from 'drizzle-orm';
import roleService from './role-service';
import BizError from '../error/biz-error';
import { toUtc } from '../utils/date-uitil';
import userService from './user-service';
import { t } from '../i18n/i18n.js';
import auditLogService from './audit-log-service';
import settingService from './setting-service';
import telegramService from './telegram-service';
import dayjs from 'dayjs';
import KvConst from '../const/kv-const';

const regKeyService = {

	async add(c, params, userId) {

		let {code,roleId,count,expireTime} = params;

		if (!code) {
			throw new BizError(t('emptyRegKey'));
		}

		if (!count) {
			throw new BizError(t('emptyRegKey'));
		}

		if (!expireTime) {
			throw new BizError(t('emptyRegKeyExpire'));
		}

		const regKeyRow = await orm(c).select().from(regKey).where(eq(regKey.code, code)).get();

		if (regKeyRow) {
			throw new BizError(t('isExistRegKye'));
		}

		const roleRow = await roleService.selectById(c, roleId);
		if (!roleRow) {
			throw new BizError(t('roleNotExist'));
		}

		const expireUtc = toUtc(expireTime)
		if (!expireUtc.isValid()) {
			throw new BizError(t('emptyRegKeyExpire'));
		}
		expireTime = expireUtc.format('YYYY-MM-DD HH:mm:ss')

		await orm(c).insert(regKey).values({code,roleId,count,userId,expireTime}).run();
		await auditLogService.record(c, {
			action: 'reg-key:add',
			targetType: 'reg_key',
			targetId: code,
			detail: { code, roleId, count }
		});
	},

	async delete(c, params) {
		let {regKeyIds} = params;
		regKeyIds = regKeyIds.split(',').map(id => Number(id));
		await orm(c).delete(regKey).where(inArray(regKey.regKeyId,regKeyIds)).run();
		await auditLogService.record(c, {
			action: 'reg-key:delete',
			targetType: 'reg_key',
			targetId: params.regKeyIds,
			detail: { regKeyIds: params.regKeyIds }
		});
	},

	async clearNotUse(c) {
		const now = toUtc().format('YYYY-MM-DD HH:mm:ss')
		await orm(c).delete(regKey).where(or(eq(regKey.count, 0), sql`datetime(${regKey.expireTime}) <= datetime(${now})`)).run();
	},

	selectByCode(c, code) {
		return orm(c).select().from(regKey).where(eq(regKey.code, code)).get();
	},

	async list(c, params) {

		const {code} = params
		let query = orm(c).select().from(regKey)

		if (code) {
			query = query.where(like(regKey.code, `${code}%`))
		}

		const regKeyList = await query.orderBy(desc(regKey.regKeyId)).all();
		const roleList = await roleService.roleSelectUse(c);

		const now = toUtc()

		regKeyList.forEach(regKeyRow => {

			const index = roleList.findIndex(roleRow => roleRow.roleId === regKeyRow.roleId)
			regKeyRow.roleName = index > -1 ? roleList[index].name : ''

			const expireTime = toUtc(regKeyRow.expireTime);

			if (!expireTime.isAfter(now)) {
				regKeyRow.expireTime = null
			}
		})

		return regKeyList;
	},

	async consumeCount(c, code) {
		const rows = await orm(c).update(regKey)
			.set({ count: sql`${regKey.count} - 1` })
			.where(and(eq(regKey.code, code), gt(regKey.count, 0)))
			.returning({ regKeyId: regKey.regKeyId });
		return rows.length > 0;
	},

	async restoreCount(c, code) {
		await orm(c).update(regKey)
			.set({ count: sql`${regKey.count} + 1` })
			.where(eq(regKey.code, code))
			.run();
	},

	async history(c, params) {
		const { regKeyId } = params;
		return userService.listByRegKeyId(c, regKeyId);
	},

	// Phase 2 A 路：密钥库存告警。读 setting.regKeyAlertThreshold（默认 500），
	// 查未过期密钥剩余总量（count > 0 且未过期）；低于阈值发 TG 告警
	// （sendAlert 第三参数 'reg-key'），每天最多 1 次（KV REG_KEY_ALERT_DAY + 日期去重）。
	// 全程 try/catch，永不抛错，不得影响注册主流程。
	async maybeAlertLowStock(c) {
		try {
			const setting = await settingService.query(c);
			const threshold = setting.regKeyAlertThreshold ?? 500;
			const row = await c.env.db.prepare(
				`SELECT COALESCE(SUM(count), 0) AS total FROM reg_key WHERE count > 0 AND datetime(expire_time) > datetime('now')`
			).first();
			const remaining = Number(row?.total) || 0;
			if (remaining >= threshold) {
				return;
			}
			const dateStr = dayjs().format('YYYY-MM-DD');
			const flagKey = KvConst.REG_KEY_ALERT_DAY + dateStr;
			if (await c.env.kv.get(flagKey)) {
				return;
			}
			await c.env.kv.put(flagKey, '1', { expirationTtl: 60 * 60 * 24 });
			await telegramService.sendAlert(c, `⚠️ 注册密钥库存告警\n剩余总量 ${remaining}（阈值 ${threshold}），请及时补充密钥。`, 'reg-key');
		} catch (e) {
			console.error('注册密钥库存告警失败:', e.message);
		}
	}
}

export default regKeyService;
