// Phase 7：安全中心专用的登录历史查询。
// 与旧接口 GET /my/loginLog 的区别：本接口只服务安全中心，返回字段按
// 展示口径整形——time（原 create_time）、ip（按 setting.log_ip_mask
// 脱敏规则展示；写时已脱敏的行不再二次脱敏）、device/browser（由 UA
// 解析出的人话设备/浏览器，不再把原始 UA 长串推给前端）、isNewIp。
// location：本站不记录地理位置（login_log 无地点列，也不做 IP 地理库
// 查询），恒为 null，前端据此显示“未记录”，见 PHASE7-PRIVACY-AUDIT.md。
// 仅限本人数据：userId 一律取 c.get('user').userId，无 premKey。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import loginLogService from '../service/login-log-service';
import settingService from '../service/setting-service';
import reqUtils from '../utils/req-utils';
import { UAParser } from 'ua-parser-js';

function parseDevice(ua) {
	try {
		const parser = new UAParser(String(ua || ''));
		const { browser, device, os } = parser.getResult();
		const browserText = browser.name ? `${browser.name} ${browser.version || ''}`.trim() : '';
		const osText = os.name ? `${os.name} ${os.version || ''}`.trim() : '';
		const deviceText = [device.vendor, device.model].filter(Boolean).join(' ')
			|| (device.type ? device.type : '') || 'Desktop';
		return { device: deviceText, browser: [browserText, osText].filter(Boolean).join(' / ') };
	} catch (e) {
		return { device: '', browser: '' };
	}
}

app.get('/security/login-history', async (c) => {
	const params = c.req.query();
	let num = Number(params.num);
	let size = Number(params.size);
	if (isNaN(num) || num < 1) {
		num = 1;
	}
	if (isNaN(size) || size < 1) {
		size = 20;
	}
	if (size > 50) {
		size = 50;
	}
	const userId = userContext.getUserId(c);
	const data = await loginLogService.listByUser(c, userId, { num, size });
	// 读时脱敏：写时已按开关脱敏；开关开启后、写时未脱敏的历史行在这里补脱敏。
	let maskOn = false;
	try {
		const setting = await settingService.query(c);
		maskOn = setting && Number(setting.logIpMask) === 1;
	} catch (e) {
		maskOn = false;
	}
	const list = data.list.map(row => {
		const parsed = parseDevice(row.ua);
		return {
			time: row.createTime,
			ip: maskOn ? reqUtils.maskIp(row.ip) : row.ip,
			device: parsed.device,
			browser: parsed.browser,
			isNewIp: row.isNewIp,
			location: null
		};
	});
	return c.json(result.ok({ list, total: data.total }));
});
