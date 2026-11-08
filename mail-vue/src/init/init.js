import {useUserStore} from "@/store/user.js";
import {useSettingStore} from "@/store/setting.js";
import {useAccountStore} from "@/store/account.js";
import {useUiStore} from "@/store/ui.js";
import {loginUserInfo, getLocale, setLocale} from "@/request/my.js";
import {permsToRouter} from "@/perm/perm.js";
import router from "@/router";
import {websiteConfig} from "@/request/setting.js";
import i18n from "@/i18n/index.js";
import { applyLocale, syncLocaleWithServer, readStoredLocale, detectBrowserLocale, normalizeLocale } from "@/i18n/locale.js";
import { loadPrefs, applyPrefs } from "@/utils/preferences.js";

export async function init() {
    document.title = '\u200B'

    const settingStore = useSettingStore();
    const userStore = useUserStore();
    const accountStore = useAccountStore();

    const token = localStorage.getItem('token');
    // Phase 2 A 路补充：语言初始化。优先级：localStorage mail-locale >
    // 旧 settingStore.lang（pinia 持久化）> 浏览器；非默认语言按需懒加载。
    const initialShort = readStoredLocale()
        || (settingStore.lang || null)
        || normalizeLocale(detectBrowserLocale())
        || 'zh';
    await applyLocale(i18n, settingStore, initialShort);

    // Phase 2 A 路补充：个性化偏好（主题/密度/通知开关）——读 localStorage mail-prefs，
    // 在挂载前应用，避免主题与密度闪烁。
    applyPrefs(loadPrefs(), useUiStore());

    let setting = null;

    if (token) {
        const userPromise = loginUserInfo().catch(e => {
            console.error(e);
            return null;
        });

        const [s, user] = await Promise.all([websiteConfig(), userPromise]);
        setting = s;
        settingStore.settings = setting;
        settingStore.domainList = setting.domainList;
        document.title = setting.title;

        if (user) {
            accountStore.currentAccountId = user.account.accountId;
            accountStore.currentAccount = user.account;
            userStore.user = user;

            const routers = permsToRouter(user.permKeys);
            routers.forEach(routerData => {
                router.addRoute('layout', routerData);
            });

            // Phase 2 A 路补充：已登录时与后端 user.locale 同步——
            // 后端有值则以其为准回写本地，后端为空则把本地值写到后端。
            await syncLocaleWithServer({ i18n, settingStore, getLocale, setLocale });
        }

    } else {
        setting = await websiteConfig();
        settingStore.settings = setting;
        settingStore.domainList = setting.domainList;
        document.title = setting.title;
    }
}
