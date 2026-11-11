// 日期时间工具（Phase 8 · H 国际化）。
// 全部格式化走 Intl.DateTimeFormat / Intl.RelativeTimeFormat，按 locale 走：
// 月/日顺序、12/24 小时制、周起始日、千分位都由运行时的 locale 决定，
// 不再写死 YYYY-MM-DD / 24 小时等中国习惯格式。
// 本模块是纯函数（只读 localStorage / navigator 做默认值解析），
// 便于 node smoke 测试直接 import；不 import pinia / vue-i18n / router。
import { normalizeLocale, readStoredLocale } from '../i18n/locale.js';
import { loadPrefs } from './preferences.js';

// 内部短码（zh/en/ja/ko/vi/ru/es/fr/pt/id/de/ar/hi/th）→ Intl 用的完整语言标签。
export const LOCALE_TAGS = {
	zh: 'zh-CN',
	en: 'en-US',
	ja: 'ja-JP',
	ko: 'ko-KR',
	vi: 'vi-VN',
	ru: 'ru-RU',
	es: 'es-ES',
	fr: 'fr-FR',
	pt: 'pt-PT',
	id: 'id-ID',
	de: 'de-DE',
	ar: 'ar-SA',
	hi: 'hi-IN',
	th: 'th-TH'
};

export function toLocaleTag(short) {
	if (LOCALE_TAGS[short]) return LOCALE_TAGS[short];
	// 非 14 语种的合法 BCP 47 标签（如 de-DE）直接透传，Intl 自行处理；
	// 非法值回落 en-US。
	if (typeof short === 'string' && /^[a-z]{2,3}(-[A-Z]{2})?$/i.test(short.trim())) {
		return short.trim();
	}
	return LOCALE_TAGS.en;
}

// 当前界面语言短码：mail-locale > 浏览器语言 > zh（仅匹配不到时回落中文）。
export function resolveLocaleShort() {
	try {
		return readStoredLocale()
			|| normalizeLocale(typeof navigator !== 'undefined' ? navigator.language : '')
			|| 'zh';
	} catch (e) {
		return 'zh';
	}
}

export function resolveLocaleTag() {
	return toLocaleTag(resolveLocaleShort());
}

// 浏览器时区（Intl 标准接口）。
export function getBrowserTimeZone() {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch (e) {
		return 'UTC';
	}
}

export function isValidTimeZone(zone) {
	if (!zone || typeof zone !== 'string') return false;
	try {
		Intl.DateTimeFormat('en-US', { timeZone: zone });
		return true;
	} catch (e) {
		return false;
	}
}

// 生效时区：用户在设置里选的时区（mail-prefs.timeZone）；
// 'auto'/未设置/非法值 → 浏览器时区。
export function resolveTimeZone(prefsTimeZone) {
	const chosen = prefsTimeZone !== undefined
		? prefsTimeZone
		: (() => { try { return loadPrefs().timeZone; } catch (e) { return 'auto'; } })();
	if (chosen && chosen !== 'auto' && isValidTimeZone(chosen)) {
		return chosen;
	}
	return getBrowserTimeZone();
}

// 设置页时区下拉的候选（常用 IANA 时区；'auto' = 跟随浏览器）。
export const COMMON_TIME_ZONES = [
	'UTC',
	'America/New_York',
	'America/Chicago',
	'America/Denver',
	'America/Los_Angeles',
	'America/Toronto',
	'America/Mexico_City',
	'America/Sao_Paulo',
	'Europe/London',
	'Europe/Paris',
	'Europe/Berlin',
	'Europe/Madrid',
	'Europe/Moscow',
	'Africa/Cairo',
	'Asia/Dubai',
	'Asia/Karachi',
	'Asia/Kolkata',
	'Asia/Dhaka',
	'Asia/Bangkok',
	'Asia/Shanghai',
	'Asia/Taipei',
	'Asia/Hong_Kong',
	'Asia/Tokyo',
	'Asia/Seoul',
	'Australia/Sydney',
	'Pacific/Auckland'
];

// 时区下拉显示：时区名 + 当前 UTC 偏移（如 Asia/Shanghai (GMT+8)）。
export function formatTimeZoneLabel(zone, locale) {
	if (zone === 'auto') return null; // 调用方用 i18n 的 timeZoneAuto 文案
	const tag = locale ? toLocaleTag(locale) : resolveLocaleTag();
	try {
		const parts = new Intl.DateTimeFormat(tag, {
			timeZone: zone,
			timeZoneName: 'shortOffset'
		}).formatToParts(new Date());
		const offset = (parts.find(p => p.type === 'timeZoneName') || {}).value || '';
		return offset ? `${zone} (${offset})` : zone;
	} catch (e) {
		return zone;
	}
}

// 服务端时间统一是 UTC 'YYYY-MM-DD HH:mm:ss'（无时区后缀）；
// 当字符串不带时区信息时按 UTC 解析，避免被当成本地时间。
export function parseServerTime(value) {
	if (value == null) return null;
	if (value instanceof Date) return value;
	if (typeof value === 'object' && typeof value.toDate === 'function') return value.toDate();
	if (typeof value === 'number') return new Date(value);
	if (typeof value === 'string') {
		const text = value.trim();
		if (!text) return null;
		if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) return new Date(text);
		if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text)) {
			return new Date(`${text.replace(' ', 'T')}Z`);
		}
		if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Date(`${text}T00:00:00Z`);
		return new Date(text);
	}
	return new Date(value);
}

function toDate(value) {
	const d = parseServerTime(value);
	return d && !isNaN(d.getTime()) ? d : null;
}

function opts(locale, timeZone) {
	return {
		locale: locale ? toLocaleTag(locale) : resolveLocaleTag(),
		timeZone: timeZone || resolveTimeZone()
	};
}

// 日期（按 locale 的月/日顺序）：en-US → Nov 8, 2026；de-DE → 8. Nov. 2026；zh-CN → 2026年11月8日。
// withYear=false 时省略年份。
export function formatDate(value, { locale, timeZone, withYear = true } = {}) {
	const d = toDate(value);
	if (!d) return '';
	const o = opts(locale, timeZone);
	return new Intl.DateTimeFormat(o.locale, {
		timeZone: o.timeZone, ...(withYear ? { year: 'numeric' } : {}), month: 'short', day: 'numeric'
	}).format(d);
}

// 时间（按 locale 的 12/24 小时制）：en-US → 2:30 PM；zh-CN/de-DE → 14:30。
export function formatTime(value, { locale, timeZone } = {}) {
	const d = toDate(value);
	if (!d) return '';
	const o = opts(locale, timeZone);
	return new Intl.DateTimeFormat(o.locale, {
		timeZone: o.timeZone, hour: 'numeric', minute: '2-digit'
	}).format(d);
}

// 日期 + 时间；withYear=false 时省略年份（列表今年内的邮件用）。
export function formatDateTime(value, { locale, timeZone, withYear = true } = {}) {
	const d = toDate(value);
	if (!d) return '';
	const o = opts(locale, timeZone);
	return new Intl.DateTimeFormat(o.locale, {
		timeZone: o.timeZone,
		...(withYear ? { year: 'numeric' } : {}),
		month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
	}).format(d);
}

// 完整时间 + 时区（悬停提示用）：Nov 8, 2026, 2:30:45 PM GMT+8 (Asia/Shanghai)。
export function formatFullWithTimeZone(value, { locale, timeZone } = {}) {
	const d = toDate(value);
	if (!d) return '';
	const o = opts(locale, timeZone);
	const main = new Intl.DateTimeFormat(o.locale, {
		timeZone: o.timeZone,
		year: 'numeric', month: 'short', day: 'numeric',
		hour: 'numeric', minute: '2-digit', second: '2-digit'
	}).format(d);
	const zoneName = new Intl.DateTimeFormat(o.locale, {
		timeZone: o.timeZone, timeZoneName: 'longOffset'
	}).formatToParts(d).find(p => p.type === 'timeZoneName');
	const offset = zoneName ? zoneName.value : o.timeZone;
	return `${main} ${offset} (${o.timeZone})`;
}

// 相对时间（x 分钟前 / in x days，按 locale）：今天内用分钟/小时，
// 超出今天用“昨天 + 时间 / 今年内月日 / 跨年完整日期”（Gmail 列表样式）。
export function formatListTime(value, { locale, timeZone, now = new Date() } = {}) {
	const d = toDate(value);
	if (!d) return '';
	const o = opts(locale, timeZone);
	const rtf = new Intl.RelativeTimeFormat(o.locale, { numeric: 'auto' });
	const diffMs = d.getTime() - now.getTime();
	const diffSec = Math.round(diffMs / 1000);
	const absSec = Math.abs(diffSec);
	if (absSec < 60) return rtf.format(0, 'second');
	if (absSec < 3600) return rtf.format(Math.trunc(diffSec / 60), 'minute');
	if (absSec < 86400 && isSameDay(d, now, o.timeZone)) {
		return rtf.format(Math.trunc(diffSec / 3600), 'hour');
	}
	const fmt = (options) => new Intl.DateTimeFormat(o.locale, { timeZone: o.timeZone, ...options }).format(d);
	const yesterday = new Date(now.getTime() - 86400 * 1000);
	if (isSameDay(d, yesterday, o.timeZone)) {
		// 昨天 + 时间：en "Yesterday, 2:30 PM"；zh "昨天 14:30"
		// （Intl 返回小写 yesterday/gestern，句首首字母大写；
		// 中日韩用空格分隔，欧美语言用逗号分隔）
		const dayWord = rtf.format(-1, 'day');
		const capped = dayWord.charAt(0).toUpperCase() + dayWord.slice(1);
		const sep = ['zh', 'ja', 'ko'].includes(o.locale.slice(0, 2)) ? ' ' : ', ';
		return `${capped}${sep}${fmt({ hour: 'numeric', minute: '2-digit' })}`;
	}
	if (d.getFullYear() === now.getFullYear()) {
		return fmt({ month: 'short', day: 'numeric' });
	}
	return fmt({ year: 'numeric', month: 'short', day: 'numeric' });
}

function isSameDay(a, b, timeZone) {
	const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
	return f.format(a) === f.format(b);
}

// 数字与文件大小（按 locale 的千分位/小数点）：en-US 1,234；de-DE 1.234。
export function formatNumber(value, { locale } = {}) {
	const tag = locale ? toLocaleTag(locale) : resolveLocaleTag();
	return new Intl.NumberFormat(tag).format(value);
}

export function formatFileSize(bytes, { locale } = {}) {
	const tag = locale ? toLocaleTag(locale) : resolveLocaleTag();
	const nf = new Intl.NumberFormat(tag, { maximumFractionDigits: 1 });
	if (bytes == null || isNaN(bytes)) return '';
	if (bytes < 1024) return `${nf.format(bytes)} B`;
	if (bytes < 1024 * 1024) return `${nf.format(bytes / 1024)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${nf.format(bytes / (1024 * 1024))} MB`;
	return `${nf.format(bytes / (1024 * 1024 * 1024))} GB`;
}

// 周起始日（按 locale）：en-US → 0（周日）；zh-CN/de-DE/fr-FR → 1（周一）。
// 优先用 Intl.Locale.weekInfo（Chrome/Node 18+ 支持），不支持时按语言回落。
export function getWeekStartDay(locale) {
	const tag = locale ? toLocaleTag(locale) : resolveLocaleTag();
	try {
		const loc = new Intl.Locale(tag);
		if (loc.weekInfo && typeof loc.weekInfo.firstDay === 'number') {
			// weekInfo.firstDay：1=周一 … 7=周日 → 转 0=周日 … 6=周六
			return loc.weekInfo.firstDay % 7;
		}
	} catch (e) {
		// 忽略，回落到语言表
	}
	const short = (locale || resolveLocaleShort());
	return ['en', 'ko', 'ja'].includes(short) ? 0 : 1;
}
