<template>
  <div class="theme-options" role="radiogroup" :aria-label="t('themeStyle')">
    <label
      v-for="option in themeOptions"
      :key="option.label"
      class="theme-card"
      :class="{ 'is-selected': uiStore.dark === option.dark }"
    >
      <span class="theme-preview" :class="{ 'preview-dark': option.dark }" aria-hidden="true">
        <span class="preview-sidebar"><i/><i/><i/></span>
        <span class="preview-main"><i/><i/><i/></span>
      </span>
      <span class="theme-caption">
        <span>{{ t(option.label) }}</span>
        <input
          type="radio"
          :name="groupName"
          :value="option.mode"
          :checked="themeMode === option.mode"
          @change="selectTheme(option.mode, $event)"
        >
      </span>
    </label>
  </div>
</template>

<script setup>
import {ref, useId} from 'vue'
import {useI18n} from 'vue-i18n'
import {useUiStore} from '@/store/ui.js'
import { loadPrefs, savePrefs, resolveDark, syncSystemThemeListener } from '@/utils/preferences.js'

const {t} = useI18n()
const uiStore = useUiStore()
const groupName = useId()
// Phase 2 A 路补充：主题三档——浅色 / 深色 / 跟随系统。模式存 localStorage mail-prefs.theme，
// 解析后的 dark 值仍走既有 uiStore.dark（pinia 持久化）与根元素 dark 类。
const themeMode = ref(loadPrefs().theme)
const themeOptions = [
  {label: 'lightTheme', mode: 'light', dark: false},
  {label: 'darkTheme', mode: 'dark', dark: true},
  {label: 'systemTheme', mode: 'system', dark: null},
]

function selectTheme(mode, event) {
  if (mode === themeMode.value) return
  const bounds = event.currentTarget.closest('.theme-card')?.getBoundingClientRect()
  const prefs = loadPrefs()
  prefs.theme = mode
  savePrefs(prefs)
  themeMode.value = mode
  // 跟随系统时注册系统主题监听；切回手动档时取消监听
  syncSystemThemeListener(mode, uiStore)
  changeDark(resolveDark(mode), {
    x: bounds ? bounds.left + bounds.width / 2 : window.innerWidth / 2,
    y: bounds ? bounds.top + bounds.height / 2 : window.innerHeight / 2,
  })
}

function changeDark(nextIsDark, origin) {
  if (nextIsDark === uiStore.dark) return

  const root = document.documentElement
  const applyTheme = () => {
    root.classList.toggle('dark', nextIsDark)
    const isMobile = !window.matchMedia("(pointer: fine) and (hover: hover)").matches
    document.getElementById('theme-color-meta')?.setAttribute(
      'content',
      nextIsDark ? (isMobile ? '#141414' : '#000000') : (isMobile ? '#191A23' : '#F1F1F1')
    )
    uiStore.dark = nextIsDark
  }

  if (!document.startViewTransition) {
    applyTheme()
    return
  }

  const endRadius = Math.hypot(
    Math.max(origin.x, window.innerWidth - origin.x),
    Math.max(origin.y, window.innerHeight - origin.y)
  )
  root.setAttribute('data-theme-to', nextIsDark ? 'dark' : 'light')
  root.style.setProperty('--vt-x', `${origin.x}px`)
  root.style.setProperty('--vt-y', `${origin.y}px`)
  root.style.setProperty('--vt-end-radius', `${endRadius + 10}px`)
  const transition = document.startViewTransition(applyTheme)
  transition.finished.finally(() => root.removeAttribute('data-theme-to'))
}
</script>

<style scoped lang="scss">
.theme-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 180px));
  gap: 16px;
  width: 100%;
  max-width: 564px;
}

.theme-card {
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  cursor: pointer;

  &:hover,
  &.is-selected {
    border-color: var(--el-color-primary);
  }

  &.is-selected {
    box-shadow: 0 0 0 1px var(--el-color-primary);
  }

  &:has(input:focus-visible) {
    outline: 2px solid var(--el-color-primary);
    outline-offset: 3px;
  }
}

.theme-preview {
  display: flex;
  aspect-ratio: 1.6;
  overflow: hidden;
  border: 1px solid #dfe1e5;
  border-radius: 4px;
  background: #ffffff;

  i {
    display: block;
    height: 6px;
    border-radius: 2px;
    background: #e2e4e8;
  }

  .preview-sidebar {
    display: grid;
    align-content: start;
    gap: 8px;
    width: 28%;
    padding: 12px 6px;
    background: #f0f1f3;

    i:first-child {
      background: #91caff;
    }
  }

  .preview-main {
    display: grid;
    flex: 1;
    align-content: start;
    gap: 12px;
    padding: 12px;

    i:first-child {
      width: 55%;
    }
  }

  &.preview-dark {
    background: #202124;
    border-color: #45474b;

    i {
      background: #505359;
    }

    .preview-sidebar {
      background: #303236;

      i:first-child {
        background: #409eff;
      }
    }
  }
}

.theme-caption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 32px;
  padding-top: 4px;
  font-size: 14px;
  color: var(--el-text-color-primary);

  input {
    flex-shrink: 0;
    margin: 0;
    accent-color: var(--el-color-primary);
    cursor: pointer;
  }
}
</style>
