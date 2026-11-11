// 语言偏好工具（Phase 2 A 路补充：8 语种；2026-11-10 扩到 14 语种，
// 新增 pt/id/de/ar/hi/th；ar 为 RTL 语言，切换时同步 document.dir）。
// 本模块是纯函数，不 import i18n / store / request，避免循环依赖
// （i18n/index.js 与 axios 互相引用，request 层又依赖 axios）。
// 内部短码（zh/en/ja/ko/vi/ru/es/fr/pt/id/de/ar/hi/th）与既有代码的 settingStore.lang、$t 保持一致；
// 对外存储值（localStorage mail-locale、后端 user.locale）用完整码，中文为 zh-CN。
export const STORAGE_KEY = 'mail-locale';

export const SUPPORTED_LOCALES = [
	{ code: 'zh-CN', short: 'zh', label: '简体中文' },
	{ code: 'en', short: 'en', label: 'English' },
	{ code: 'ja', short: 'ja', label: '日本語' },
	{ code: 'ko', short: 'ko', label: '한국어' },
	{ code: 'vi', short: 'vi', label: 'Tiếng Việt' },
	{ code: 'ru', short: 'ru', label: 'Русский' },
	{ code: 'es', short: 'es', label: 'Español' },
	{ code: 'fr', short: 'fr', label: 'Français' },
	{ code: 'pt', short: 'pt', label: 'Português' },
	{ code: 'id', short: 'id', label: 'Bahasa Indonesia' },
	{ code: 'de', short: 'de', label: 'Deutsch' },
	{ code: 'ar', short: 'ar', label: 'العربية', rtl: true },
	{ code: 'hi', short: 'hi', label: 'हिन्दी' },
	{ code: 'th', short: 'th', label: 'ไทย' }
];

export const STORED_CODES = SUPPORTED_LOCALES.map(item => item.code);
export const SHORT_CODES = SUPPORTED_LOCALES.map(item => item.short);

// 任意输入（存储值/浏览器语言/旧短码）归一化为内部短码；无法识别返回 null。
export function normalizeLocale(input) {
	if (!input || typeof input !== 'string') {
		return null;
	}
	const lower = input.trim().toLowerCase();
	const found = SUPPORTED_LOCALES.find(item => item.code.toLowerCase() === lower || item.short === lower);
	if (found) {
		return found.short;
	}
	// 带地区的语言码（en-US / ja-JP / fr-FR 等）取主语言部分匹配
	const base = lower.split('-')[0];
	const baseFound = SUPPORTED_LOCALES.find(item => item.short === base);
	if (baseFound) {
		return baseFound.short;
	}
	if (lower.startsWith('zh')) {
		return 'zh';
	}
	return null;
}

// 内部短码转对外存储值（中文 zh → zh-CN，其余不变）。
export function toStoredLocale(short) {
	const found = SUPPORTED_LOCALES.find(item => item.short === short);
	return found ? found.code : 'en';
}

// 浏览器语言：按 navigator.languages 偏好顺序逐个归一化匹配 14 语种，
// 匹配不到才回落 'en'（旧逻辑只分 zh/en，日语浏览器会被误判成英文）。
// 返回对外存储值；调用方再经 normalizeLocale() 转内部短码。
export function detectBrowserLocale() {
	try {
		const langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''])
		for (const lang of langs) {
			const short = normalizeLocale(lang);
			if (short) {
				return toStoredLocale(short);
			}
		}
		return 'en';
	} catch (e) {
		return 'en';
	}
}

export function readStoredLocale() {
	try {
		return normalizeLocale(localStorage.getItem(STORAGE_KEY));
	} catch (e) {
		return null;
	}
}

export function writeStoredLocale(short) {
	try {
		localStorage.setItem(STORAGE_KEY, toStoredLocale(short));
	} catch (e) {
		// 隐私模式等写失败时静默，界面语言仍已切换
	}
}

// zh/en 随首屏打包；其余 12 种按需懒加载（显式 import 表，Vite 各自打独立 chunk，
// 首屏不新增外部请求）。
const loaders = {
	ja: () => import('./ja.js'),
	ko: () => import('./ko.js'),
	vi: () => import('./vi.js'),
	ru: () => import('./ru.js'),
	es: () => import('./es.js'),
	fr: () => import('./fr.js'),
	pt: () => import('./pt.js'),
	id: () => import('./id.js'),
	de: () => import('./de.js'),
	ar: () => import('./ar.js'),
	hi: () => import('./hi.js'),
	th: () => import('./th.js')
};
const loadedShorts = new Set(['zh', 'en']);

export async function loadLocaleMessages(i18n, short) {
	if (loadedShorts.has(short)) {
		return;
	}
	const loader = loaders[short];
	if (!loader) {
		return;
	}
	const mod = await loader();
	i18n.global.setLocaleMessage(short, mod.default || mod);
	loadedShorts.add(short);
}

// 切换语言并持久化：懒加载文案 → 设 vue-i18n locale → 同步 settingStore.lang
// （既有代码的 accept-language、dayjs、Element Plus 语言都读它）→ 写 mail-locale。
// 全界面即时生效，无需刷新。
export async function applyLocale(i18n, settingStore, short) {
	const target = SHORT_CODES.includes(short) ? short : 'zh';
	await loadLocaleMessages(i18n, target);
	i18n.global.locale.value = target;
	if (settingStore) {
		settingStore.lang = target;
	}
	writeStoredLocale(target);
	// html lang 跟界面语言同步：否则 Chrome 会弹“翻译网页吗？”（见 index.html 内联脚本）。
	// RTL 语言（阿拉伯语）同步 document.dir，整站布局自动镜像；切回其它语言时恢复 ltr。
	try {
		document.documentElement.lang = toStoredLocale(target);
		const entry = SUPPORTED_LOCALES.find(item => item.short === target);
		document.documentElement.dir = entry && entry.rtl ? 'rtl' : 'ltr';
	} catch (e) {
		// 非浏览器环境忽略
	}
	return target;
}

// 登录后同步：后端有值 → 以后端为准回写本地；后端为空 → 把本地值写到后端。
// getLocale/setLocale 由调用方从 request/my.js 传入（本模块不 import request，避免循环依赖）。
// 全程 best-effort，失败只记日志，不阻断登录流程。
export async function syncLocaleWithServer({ i18n, settingStore, getLocale, setLocale }) {
	try {
		const res = await getLocale();
		const serverLocale = res?.locale || '';
		const serverShort = normalizeLocale(serverLocale);
		if (serverShort) {
			await applyLocale(i18n, settingStore, serverShort);
			return serverShort;
		}
		const localShort = readStoredLocale() || settingStore?.lang || 'zh';
		await setLocale(toStoredLocale(localShort));
		return localShort;
	} catch (e) {
		console.error('同步语言偏好失败:', e);
		return null;
	}
}
