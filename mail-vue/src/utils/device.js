// 设备文本展示归一化（2026-11-11 ④）。
// login_log.ua 存的是 '浏览器 / 系统 / 设备' 三段式，存量串里有脏数据
// （'Twitter undefined'、'Windows10'、'iOS18.3'、'Linuxundefined'）。
// 后端新写已清（getUserAgent）、三处 API 已改走共享解析；这里再对展示层
// 兜底一次：设置页/审计页直接显示 row.ua 的地方也干净。
const OS_SPACE_RE = /^(Windows|iOS|macOS|Android|Linux|ChromeOS)(\d)/

function cleanSegment(seg) {
	return String(seg || '').replace(/undefined/g, '').replace(/\s+/g, ' ').trim()
}

function cleanOs(os) {
	return cleanSegment(os).replace(OS_SPACE_RE, '$1 $2')
}

// 把存量三段式清干净再拼回 '浏览器 / 系统 / 设备'；单段串只清 'undefined'
export function formatDeviceText(text) {
	const s = String(text || '').trim()
	if (!s) return ''
	if (!s.includes(' / ')) return cleanSegment(s)
	const parts = s.split(' / ').map(p => p.trim())
	const browser = cleanSegment(parts[0])
	const os = cleanOs(parts[1])
	const device = cleanSegment(parts.slice(2).join(' / '))
	return [browser, os, device].filter(Boolean).join(' / ')
}

// 安全中心两列拼法：device · browser；都没有时回落到原始 ua（也清过）
export function formatDeviceBrowser(device, browser, fallbackUa) {
	const joined = [formatDeviceText(device), formatDeviceText(browser)]
		.filter(Boolean)
		.join(' · ')
	return joined || formatDeviceText(fallbackUa)
}
