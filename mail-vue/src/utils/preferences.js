// 个性化偏好（Phase 2 A 路补充）：主题 / 布局密度 / 通知开关。
// 存储：localStorage mail-prefs（前端本地偏好；语言另有 mail-locale + 后端 user.locale）。
// 顶层无副作用（只有常量与函数定义），便于 node smoke 测试直接 import。
export const PREFS_KEY = 'mail-prefs';
export const THEME_MODES = ['light', 'dark', 'system'];
export const DENSITIES = ['comfortable', 'compact'];
// Phase 8 H 路：timeZone（'auto' = 跟随浏览器时区；其余为 IANA 时区名）与
// shortcutsEnabled（Gmail 快捷键开关，默认开）进同一 mail-prefs 存储。
export const DEFAULT_PREFS = { theme: 'light', density: 'comfortable', notice: true, timeZone: 'auto', shortcutsEnabled: true };

function normalizeTimeZone(value) {
	if (!value || typeof value !== 'string') return DEFAULT_PREFS.timeZone;
	if (value === 'auto') return 'auto';
	try {
		Intl.DateTimeFormat('en-US', { timeZone: value });
		return value;
	} catch (e) {
		return DEFAULT_PREFS.timeZone;
	}
}

export function loadPrefs() {
	let raw = null;
	try {
		raw = localStorage.getItem(PREFS_KEY);
	} catch (e) {
		raw = null;
	}
	let parsed = {};
	try {
		parsed = raw ? JSON.parse(raw) : {};
	} catch (e) {
		parsed = {};
	}
	if (!parsed || typeof parsed !== 'object') {
		parsed = {};
	}
	return {
		theme: THEME_MODES.includes(parsed.theme) ? parsed.theme : DEFAULT_PREFS.theme,
		density: DENSITIES.includes(parsed.density) ? parsed.density : DEFAULT_PREFS.density,
		notice: typeof parsed.notice === 'boolean' ? parsed.notice : DEFAULT_PREFS.notice,
		timeZone: normalizeTimeZone(parsed.timeZone),
		shortcutsEnabled: typeof parsed.shortcutsEnabled === 'boolean' ? parsed.shortcutsEnabled : DEFAULT_PREFS.shortcutsEnabled
	};
}

export function savePrefs(prefs) {
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
	} catch (e) {
		// 隐私模式等写失败时静默，界面偏好仍已生效
	}
}

// 主题解析：light/dark 直接取值；system 跟随系统（prefers-color-scheme）。
export function resolveDark(theme) {
	if (theme === 'dark') {
		return true;
	}
	if (theme === 'light') {
		return false;
	}
	try {
		return window.matchMedia('(prefers-color-scheme: dark)').matches;
	} catch (e) {
		return false;
	}
}

// 跟随系统：监听系统主题变化并实时同步（仅 system 模式下注册监听）。
let systemMedia = null;
let systemListener = null;

export function syncSystemThemeListener(mode, uiStore) {
	unwatchSystemTheme();
	if (mode !== 'system') {
		return;
	}
	try {
		systemMedia = window.matchMedia('(prefers-color-scheme: dark)');
		systemListener = () => {
			applyThemeOnly(resolveDark('system'), uiStore);
		};
		if (systemMedia.addEventListener) {
			systemMedia.addEventListener('change', systemListener);
		} else if (systemMedia.addListener) {
			systemMedia.addListener(systemListener);
		}
	} catch (e) {
		// 不支持 matchMedia 的环境直接按浅色处理
	}
}

function unwatchSystemTheme() {
	try {
		if (systemMedia && systemListener) {
			if (systemMedia.removeEventListener) {
				systemMedia.removeEventListener('change', systemListener);
			} else if (systemMedia.removeListener) {
				systemMedia.removeListener(systemListener);
			}
		}
	} catch (e) {
		// 忽略
	}
	systemMedia = null;
	systemListener = null;
}

// 只改主题本身：根元素 dark 类 + theme-color + uiStore.dark（与 ThemeSelector 的行为一致）。
export function applyThemeOnly(isDark, uiStore) {
	try {
		document.documentElement.classList.toggle('dark', isDark);
		const isMobile = !window.matchMedia('(pointer: fine) and (hover: hover)').matches;
		document.getElementById('theme-color-meta')?.setAttribute(
			'content',
			isDark ? (isMobile ? '#141414' : '#000000') : (isMobile ? '#191A23' : '#F1F1F1')
		);
	} catch (e) {
		// 忽略
	}
	if (uiStore) {
		uiStore.dark = isDark;
	}
}

// 应用全部偏好：主题（跟随系统时注册监听）+ 密度（根元素 data-density 属性，
// 紧凑规则见 style.css 的 html[data-density="compact"] 部分）。
export function applyPrefs(prefs, uiStore) {
	const safe = {
		theme: THEME_MODES.includes(prefs?.theme) ? prefs.theme : DEFAULT_PREFS.theme,
		density: DENSITIES.includes(prefs?.density) ? prefs.density : DEFAULT_PREFS.density,
		notice: typeof prefs?.notice === 'boolean' ? prefs.notice : DEFAULT_PREFS.notice,
		timeZone: normalizeTimeZone(prefs?.timeZone),
		shortcutsEnabled: typeof prefs?.shortcutsEnabled === 'boolean' ? prefs.shortcutsEnabled : DEFAULT_PREFS.shortcutsEnabled
	};
	syncSystemThemeListener(safe.theme, uiStore);
	applyThemeOnly(resolveDark(safe.theme), uiStore);
	try {
		document.documentElement.dataset.density = safe.density;
	} catch (e) {
		// 忽略
	}
	return safe;
}
