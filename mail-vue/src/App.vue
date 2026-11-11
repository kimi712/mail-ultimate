<template>
  <el-config-provider :locale="elLocale">
    <router-view />
    <!-- 新邮件大框提示（微软风格，右下角，3 秒自动关闭），全局挂载 -->
    <MailNotify />
  </el-config-provider>
</template>
<script setup>
import { useI18n } from "vue-i18n";
import { watch, computed } from "vue";
import {useSettingStore} from "@/store/setting.js";
import {useUiStore} from "@/store/ui.js";
import MailNotify from "@/components/mail-notify/index.vue";
import { applyWallpaper, currentWallpaper, loadStoredWallpaper } from "@/utils/wallpaper.js";
const settingStore = useSettingStore()
const uiStore = useUiStore()
import zhCn from 'element-plus/es/locale/lang/zh-cn';
// 多语言扩展（2026-11-10，14 语种）：Element Plus 内置文案（日期选择、分页、空状态等）
// 按界面语言切换，之前只有 zh-cn / 默认英文两档。
import enUs from 'element-plus/es/locale/lang/en';
import ja from 'element-plus/es/locale/lang/ja';
import ko from 'element-plus/es/locale/lang/ko';
import vi from 'element-plus/es/locale/lang/vi';
import ru from 'element-plus/es/locale/lang/ru';
import es from 'element-plus/es/locale/lang/es';
import fr from 'element-plus/es/locale/lang/fr';
import pt from 'element-plus/es/locale/lang/pt';
import id from 'element-plus/es/locale/lang/id';
import de from 'element-plus/es/locale/lang/de';
import ar from 'element-plus/es/locale/lang/ar';
import hi from 'element-plus/es/locale/lang/hi';
import th from 'element-plus/es/locale/lang/th';
const EL_LOCALES = { zh: zhCn, en: enUs, ja, ko, vi, ru, es, fr, pt, id, de, ar, hi, th };
const elLocale = computed(() => EL_LOCALES[settingStore.lang] || enUs);
import('@/icons/index.js')
import { useMailShortcuts } from "@/utils/useMailShortcuts.js";
useMailShortcuts()
const { locale } = useI18n()
locale.value = settingStore.lang
watch(() => settingStore.lang, () => locale.value = settingStore.lang)
// Phase 7 壁纸：挂载即按本地偏好应用背景（init 里已应用过一次，这里再对齐，
// 覆盖热更新等 init 未跑的场景）；深色切换时重算压暗遮罩。
applyWallpaper(loadStoredWallpaper(), null, uiStore.dark)
watch(() => uiStore.dark, (isDark) => {
  applyWallpaper(currentWallpaper.value.value, null, isDark)
})
</script>
