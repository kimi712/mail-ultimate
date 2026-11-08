import { UAParser } from 'ua-parser-js';

// 把 IPv6 地址展开成 8 组 hextet（每组去前导 0、小写）；非法则返回 null。
function expandIPv6(addr) {
	const parts = addr.split('::');
	if (parts.length > 2) {
		return null;
	}
	const norm = (s) => s === '' ? [] : s.split(':').map(g => {
		if (!/^[0-9a-f]{1,4}$/.test(g)) {
			throw new Error('invalid hextet');
		}
		return parseInt(g, 16).toString(16);
	});
	try {
		if (parts.length === 1) {
			const groups = norm(parts[0]);
			return groups.length === 8 ? groups : null;
		}
		const left = norm(parts[0]);
		const right = norm(parts[1]);
		const missing = 8 - left.length - right.length;
		if (missing < 0) {
			return null;
		}
		return [...left, ...Array(missing).fill('0'), ...right];
	} catch (e) {
		return null;
	}
}

const reqUtils = {
	// Phase 1 A 路：只信任 CF-Connecting-IP（X-Forwarded-For 可伪造/含多 IP，已删回落）。
	getIp(c) {
		return  c.req.header('CF-Connecting-IP') ||
			'Unknown';
	},

	// IPv4 返回原 IP；IPv6 返回 /64（前 4 组 hextet，小写、展开 :: 归一化、去 %zone id）。
	// ip 参数可选：不传时取当前请求 IP（供 ip-blocklist API 用给定 IP 算段）。
	getIpSegment(c, ip) {
		const raw = (ip || this.getIp(c) || '').trim();
		if (!raw || raw === 'Unknown' || !raw.includes(':')) {
			return raw || 'Unknown';
		}
		try {
			// 去 zone id（如 fe80::1%eth0），小写
			let addr = raw.split('%')[0].toLowerCase();
			// IPv4 映射地址（::ffff:1.2.3.4）先把点分部分转成两组 hextet
			if (addr.includes('.')) {
				const lastColon = addr.lastIndexOf(':');
				const v4 = addr.slice(lastColon + 1);
				const parts = v4.split('.');
				if (parts.length !== 4 || parts.some(p => p === '' || Number(p) > 255)) {
					return addr;
				}
				const nums = parts.map(Number);
				const hi = ((nums[0] << 8) + nums[1]).toString(16);
				const lo = ((nums[2] << 8) + nums[3]).toString(16);
				addr = addr.slice(0, lastColon + 1) + hi + ':' + lo;
			}
			const groups = expandIPv6(addr);
			if (!groups) {
				return addr;
			}
			return groups.slice(0, 4).join(':');
		} catch (e) {
			console.error('解析 IP 段失败:', e.message);
			return raw;
		}
	},

	// Phase 6：IP 脱敏。IPv4 末段 → 0（如 1.2.3.4 → 1.2.3.0）；IPv6 只留 /64 段
	// （复用 getIpSegment 的归一化）；'Unknown' 与非法输入原样返回，永不抛错。
	// 只用于日志 ip 列的写入脱敏，ip_segment 列与限额/封禁检查不受影响。
	maskIp(ip) {
		try {
			const raw = String(ip || '').trim();
			if (!raw || raw === 'Unknown') {
				return raw;
			}
			if (raw.includes(':')) {
				return this.getIpSegment(null, raw);
			}
			const parts = raw.split('.');
			if (parts.length === 4 && parts.every(p => /^\d+$/.test(p) && Number(p) <= 255)) {
				return parts.slice(0, 3).join('.') + '.0';
			}
			return raw;
		} catch (e) {
			return ip;
		}
	},

	getUserAgent(c) {
		const ua = c.req.header('user-agent') || '';

		const parser = new UAParser(ua);
		const { browser, device, os } = parser.getResult();

		let browserInfo = null;
		let osInfo = null;

		if (browser.name) {
			browserInfo = browser.name + ' ' + browser.version;
		}

		if (os.name) {
			osInfo = os.name + os.version;
		}

		let deviceInfo = 'Desktop';

		const hasVendor = !!device?.vendor;
		const hasModel = !!device?.model;

		if (hasVendor || hasModel) {
			const vendor = device.vendor || '';
			const model = device.model || '';
			const type = device.type || '';

			const namePart = [vendor, model].filter(Boolean).join(' ');
			const typePart = type ? ` (${type})` : '';
			deviceInfo = (namePart + typePart).trim();
		}

		return {browser: browserInfo || '', device: deviceInfo || '', os: osInfo || ''}
	}
}

export default reqUtils
