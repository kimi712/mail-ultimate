<template>
  <el-config-provider :locale="settingStore.lang === 'zh' ? zhCn : null">
    <router-view />
  </el-config-provider>
</template>
<script setup>
import { useI18n } from "vue-i18n";
import { watch } from "vue";
import {useSettingStore} from "@/store/setting.js";
import {useUiStore} from "@/store/ui.js";
import { applyWallpaper, currentWallpaper, loadStoredWallpaper } from "@/utils/wallpaper.js";
const settingStore = useSettingStore()
const uiStore = useUiStore()
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import('@/icons/index.js')
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
