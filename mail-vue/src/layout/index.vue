<template>
  <el-container class="layout" :class="{ 'has-wallpaper': hasWallpaper }">
    <el-aside
        class="aside"
        :class="uiStore.asideShow ? 'aside-show' : 'el-aside-hide'"
        @touchstart.passive="onAsideTouchStart"
        @touchmove.passive="onAsideTouchMove"
        @touchend="onAsideTouchEnd"
        @touchcancel="onAsideTouchEnd">
      <Aside />
    </el-aside>
    <div
        :class="(uiStore.asideShow && isMobile)? 'overlay-show':'overlay-hide'"
        @click="uiStore.asideShow = false"
    ></div>
    <el-container class="main-container">
      <el-main>
        <el-header>
            <Header />
        </el-header>
        <Main />
        <!-- Phase 8 斯诺登元素补齐：全站页脚。 -->
        <SiteFooter />
      </el-main>
    </el-container>
  </el-container>
  <writer ref="writerRef" />
  <AutoLock />
</template>

<script setup>
import Aside from '@/layout/aside/index.vue'
import Header from '@/layout/header/index.vue'
import Main from '@/layout/main/index.vue'
import SiteFooter from '@/components/site-footer/index.vue'
import AutoLock from '@/components/auto-lock/index.vue'
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import {useUiStore} from "@/store/ui.js";
import writer from '@/layout/write/index.vue'
import { currentWallpaper } from '@/utils/wallpaper.js'

// Phase 7 壁纸：有壁纸时布局面板半透明 + 毛玻璃，透出底层壁纸（规则在 style.css）。
const hasWallpaper = computed(() => !!currentWallpaper.value.url)

const uiStore = useUiStore();
const writerRef = ref({})
const isMobile = ref(window.innerWidth < 1025)

// 手机侧栏左滑收起：手指跟随 + 松手判定。只在手机端、侧栏打开时生效；
// 纵向滚动（菜单上下滑）不触发——只有横向位移占主导且向左才算一次收起手势。
const asideSwipe = ref({ tracking: false, startX: 0, startY: 0, dx: 0 })
function onAsideTouchStart(e) {
  if (!isMobile.value || !uiStore.asideShow || !e.touches.length) return
  const t = e.touches[0]
  asideSwipe.value = { tracking: true, startX: t.clientX, startY: t.clientY, dx: 0 }
}
function onAsideTouchMove(e) {
  const s = asideSwipe.value
  if (!s.tracking || !e.touches.length) return
  const t = e.touches[0]
  const dx = t.clientX - s.startX
  const dy = t.clientY - s.startY
  // 纵向滚动优先：竖向位移占主导时取消本次手势，不干扰菜单滚动。
  if (Math.abs(dy) > Math.abs(dx) * 1.2) {
    s.tracking = false
    e.currentTarget.style.transform = ''
    e.currentTarget.style.transition = ''
    return
  }
  if (dx >= 0) return
  s.dx = dx
  // 跟手：侧栏随手指左移（拖动时关掉过渡动画，松手再恢复）。
  const el = e.currentTarget
  el.style.transition = 'none'
  el.style.transform = `translateX(${dx}px)`
}
function onAsideTouchEnd(e) {
  const s = asideSwipe.value
  if (!s.tracking) return
  s.tracking = false
  const el = e.currentTarget
  el.style.transition = ''
  el.style.transform = ''
  // 左滑超过 70px 即收起；不够则弹回原位。
  if (s.dx <= -70) {
    uiStore.asideShow = false
  }
  s.dx = 0
}
const handleResize = () => {
  isMobile.value = window.innerWidth < 1025
  uiStore.asideShow = window.innerWidth > 1024;
}

onMounted(() => {
  uiStore.writerRef = writerRef

  window.addEventListener('resize', handleResize)
  handleResize()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
})
</script>

<style lang="scss" scoped>
.el-aside-hide {
  position: fixed;
  left: 0;
  height: 100%;
  z-index: 100;
  transform: translateX(-100%);
  transition: all 100ms ease;
}

.aside-show {
  -webkit-box-shadow: var(--aside-right-border);
  box-shadow: var(--aside-right-border);
  transform: translateX(0);
  transition: all 100ms ease;
  z-index: 101;
  @media (max-width: 1025px) {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 101;
    height: 100%;
    background: var(--el-bg-color);
  }
}

.el-aside {
  width: auto;
  transition: all 100ms ease;
}

.layout {
  height: 100%;
  position: fixed;
  width: 100%;
  top: 0;
  left: 0;
  overflow: hidden;
}

.main-container {
  min-height: 100%;
  background: var(--el-bg-color);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.el-main {
  padding: 0;
}

.el-header {
  background: var(--el-bg-color);
  border-bottom: solid 1px var(--el-border-color);
  padding: 0 0 0 0;
  /* 任务 2（2026-11-08）搜索面板被邮件正文透出/重叠的根因修复：
     壁纸开启时 .el-header 的 backdrop-filter 会创建层叠上下文（z-index auto），
     按 DOM 顺序会被后出现的 Main 邮件内容盖住，搜索面板（在顶栏内）整个被压在正文之下。
     给顶栏 position + 正 z-index，让它（含搜索下拉）始终盖住下方邮件内容。 */
  position: relative;
  z-index: 100;
  @media (max-width: 767px) {
    height: 50px;
  }
}

.overlay-show {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.4);
  z-index: 99;
  transition: all 0.3s;
}

.overlay-hide {
  display: flex;
  pointer-events: none;
  opacity: 0;
}
</style>
