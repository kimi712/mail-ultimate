import {useUserStore} from "@/store/user.js";
import {useSettingStore} from "@/store/setting.js";
import {useAccountStore} from "@/store/account.js";
import {useUiStore} from "@/store/ui.js";
import {loginUserInfo, getLocale, setLocale, getWallpaper, setWallpaper} from "@/request/my.js";
import {permsToRouter} from "@/perm/perm.js";
import router from "@/router";
import {websiteConfig} from "@/request/setting.js";
import i18n from "@/i18n/index.js";
import { applyLocale, syncLocaleWithServer, readStoredLocale, normalizeLocale } from "@/i18n/locale.js";
import { loadPrefs, applyPrefs, resolveDark } from "@/utils/preferences.js";
import { applyWallpaper, loadStoredWallpaper, syncWallpaperWithServer } from "@/utils/wallpaper.js";

// 浏览器语言完整匹配：navigator.languages 按偏好顺序逐个归一化到 14 语种短码，
// 任一匹配即返回；全不匹配返回 null（调用方再回落中文）。
// 不用 i18n/locale.js 的 detectBrowserLocale（它只分 zh/en，见 init 内注释）。
function detectBrowserShort() {
    try {
        const candidates = [];
        if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages);
        if (navigator.language) candidates.push(navigator.language);
        for (const lang of candidates) {
            const short = normalizeLocale(lang);
            if (short) return short;
        }
    } catch (e) {
        // 忽略，调用方回落中文
    }
    return null;
}

export async function init() {
    document.title = '\u200B'

    const settingStore = useSettingStore();
    const userStore = useUserStore();
    const accountStore = useAccountStore();

    const token = localStorage.getItem('token');
    // Phase 8 H 路：默认语言按浏览器语言走（navigator.languages 依次匹配 14 语种），
    // 匹配不到才回落中文；用户在设置里改过（localStorage mail-locale / 后端
    // user.locale）则以用户选择为准。注意：i18n/locale.js 的 detectBrowserLocale
    // 目前只分 zh/en（共享文件，本次不碰），这里不用它，改走下面的完整匹配。
    const initialShort = readStoredLocale()
        || (settingStore.lang || null)
        || detectBrowserShort()
        || 'zh';
    await applyLocale(i18n, settingStore, initialShort);

    // Phase 2 A 路补充：个性化偏好（主题/密度/通知开关）——读 localStorage mail-prefs，
    // 在挂载前应用，避免主题与密度闪烁。
    const prefs = loadPrefs();
    applyPrefs(prefs, useUiStore());

    // Phase 7 壁纸：首屏即按本地偏好应用背景（默认斯诺登远景），避免登录页闪烁。
    applyWallpaper(loadStoredWallpaper(), null, resolveDark(prefs.theme));

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

            // 速度优化：语言/壁纸与后端的对齐是非关键同步，不阻塞首屏挂载。
            // 本地偏好已在挂载前应用（applyLocale/applyWallpaper）；这里改后台跑，
            // 若后端值不同再覆盖（与原来一致，只是时机延后到挂载后，首屏少等两次往返）。
            // 两个函数内部已 try/catch，永不抛错；外层再挂 catch 兜底。
            syncLocaleWithServer({ i18n, settingStore, getLocale, setLocale }).catch(e => console.error(e));
            syncWallpaperWithServer({ getWallpaper, setWallpaper, isDark: resolveDark(prefs.theme) }).catch(e => console.error(e));
        }

    } else {
        setting = await websiteConfig();
        settingStore.settings = setting;
        settingStore.domainList = setting.domainList;
        document.title = setting.title;
    }
}
