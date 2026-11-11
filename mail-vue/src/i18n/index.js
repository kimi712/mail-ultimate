import { createI18n } from 'vue-i18n';
import en from './en.js'
import zh from './zh.js'
import { readStoredLocale, detectBrowserLocale, normalizeLocale } from './locale.js';

// Phase 2 A 路补充：14 语种。zh/en 随首屏打包；其余 12 种（ja/ko/vi/ru/es/fr/pt/id/de/ar/hi/th）
// 按需懒加载（见 locale.js loadLocaleMessages），首屏不新增外部请求。
// 初始语言：localStorage mail-locale > 浏览器；缺失 key 回落英文。
const storedShort = readStoredLocale();
const initialShort = storedShort || normalizeLocale(detectBrowserLocale()) || 'zh';
const i18n = createI18n({
    legacy: false,
    locale: initialShort,
    fallbackLocale: 'en',
    messages: {
        zh,
        en
    },
});

export default i18n;
