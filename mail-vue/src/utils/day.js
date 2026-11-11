import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import 'dayjs/locale/en'
import 'dayjs/locale/ja'
import 'dayjs/locale/ko'
import 'dayjs/locale/vi'
import 'dayjs/locale/ru'
import 'dayjs/locale/es'
import 'dayjs/locale/fr'
import 'dayjs/locale/pt'
import 'dayjs/locale/id'
import 'dayjs/locale/de'
import 'dayjs/locale/ar'
import 'dayjs/locale/hi'
import 'dayjs/locale/th'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import {useSettingStore} from "@/store/setting.js";
import { formatListTime, resolveTimeZone, resolveLocaleTag } from './datetime.js';
const settingStore = useSettingStore();
dayjs.extend(utc)
dayjs.extend(timezone)
// 多语言扩展（2026-11-10，14 语种）：内部短码 → dayjs 语言包名（中文用 zh-cn，其余与短码相同）。
// 之前只内置 zh-cn/en，其它语言的相对时间会错回中文。
const DAYJS_LOCALES = { zh: 'zh-cn', en: 'en', ja: 'ja', ko: 'ko', vi: 'vi', ru: 'ru', es: 'es', fr: 'fr', pt: 'pt', id: 'id', de: 'de', ar: 'ar', hi: 'hi', th: 'th' };
export function toDayjsLocale(short) {
    return DAYJS_LOCALES[short] || 'en';
}
dayjs.locale(toDayjsLocale(settingStore.lang))

// Phase 8 H 路：时区不再在模块加载时快照为浏览器时区，
// 每次调用都走 resolveTimeZone()（用户在设置里改的时区优先，默认浏览器时区）。
// 列表时间与详情时间不再写死中文格式，统一走 utils/datetime.js 的 Intl 格式化。

export function fromNow(date) {
    // Gmail 列表样式：今天内相对时间，昨天带时间，今年内月日，跨年完整日期；
    // 月/日顺序与 12/24 小时制按当前 locale 走。
    return formatListTime(date, { locale: settingStore.lang || 'zh' });
}

export function updateNow(date) {
    if (isToday) {
        if (diffSeconds < 60) return `Just now`;
        if (diffMinutes < 60) return `${diffMinutes} min ago`;
        if (diffHours < 2) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
        return d.format('hh:mm A');
    }
}

export function formatDetailDate(time) {
    const d = dayjs.utc(time).tz(resolveTimeZone());
    const now = dayjs();
    const isSameYear = now.year() === d.year();
    const tag = resolveLocaleTag();
    const tz = resolveTimeZone();
    return new Intl.DateTimeFormat(tag, {
        timeZone: tz,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        ...(isSameYear ? {} : { year: 'numeric' }),
        hour: 'numeric',
        minute: '2-digit'
    }).format(d.toDate());
}

export function tzDayjs(time) {
    return dayjs.utc(time).tz(resolveTimeZone())
}

export function toUtc(time) {
    return dayjs(time).utc()
}

export function setExtend(short) {
    dayjs.locale(toDayjsLocale(short))
}
