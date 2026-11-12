// 设备文本解析（2026-11-11 ④）。
// login_log.ua / session meta.ua 存的是写时拼好的三段式 '浏览器 / 系统 / 设备'
// （见 login-service.js getUserAgent + session-service.js recordSession）。
// 不要再对它跑 UAParser——UAParser 认不出这种串：实测
// 'Chrome 156.0.0.0 / Windows10 / Desktop' 会被解析成 browser=''、
// device='Desktop'，安全中心登录历史就只剩光秃秃的 'Desktop'。
// 三段式直接按 ' / ' 拆；老数据若是原始 UA 头（含 Mozilla/），再走 UAParser 兜底。
// 顺带清存量脏串：'undefined' 字面、系统名缺空格（Windows10 → Windows 10）。
import { UAParser } from 'ua-parser-js';

const OS_SPACE_RE = /^(Windows|iOS|macOS|Android|Linux|ChromeOS)(\d)/;

function cleanSegment(seg) {
	return String(seg || '').replace(/undefined/g, '').replace(/\s+/g, ' ').trim();
}

function cleanOs(os) {
	return cleanSegment(os).replace(OS_SPACE_RE, '$1 $2');
}

function splitStoredUaText(ua) {
	const s = String(ua || '').trim();
	if (!s) return null;
	if (/mozilla\//i.test(s)) return null; // 原始 UA 头，走 UAParser 兜底
	const parts = s.split(' / ').map(p => p.trim());
	if (parts.length === 1) {
		// 单段存量串（如旧的 'Linuxundefined'）：当浏览器段直接清掉脏词返回
		return { device: '', browser: cleanSegment(parts[0]) };
	}
	const browser = cleanSegment(parts[0]);
	const os = cleanOs(parts[1]);
	const device = cleanSegment(parts.slice(2).join(' / '));
	return {
		device: device || 'Desktop',
		browser: [browser, os].filter(Boolean).join(' / ')
	};
}

function parseRawUa(ua) {
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

export function parseStoredUaText(ua) {
	return splitStoredUaText(ua) || parseRawUa(ua);
}

export default { parseStoredUaText };
