<template>
  <div class="section-nav" ref="navRef">
    <button
      v-for="item in items"
      :key="item.id"
      class="section-nav-item"
      :class="{ active: activeId === item.id }"
      type="button"
      @click="jump(item.id)"
    >{{ item.label }}</button>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({
  // [{ id, label }]，label 为已翻译好的显示名
  items: { type: Array, required: true },
  // 滚动容器（el-scrollbar 的 wrap 元素），用于 scrollspy 的 IntersectionObserver root；不传则用视口
  container: { type: Object, default: null },
})

const navRef = ref(null)
const activeId = ref(props.items[0]?.id || '')

function jump(id) {
  activeId.value = id
  const el = document.getElementById(id)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

let observer = null
let scrollTarget = null
let rafId = 0

// 高亮判定：与 anchor-scroll.js 的落点用同一条线——导航栏底部 + margin-bottom + 12px。
// 之前 observer 按 band 内可见分区的 top 升序取第一个，锚点落点（导航栏底 + 12px）
// 比 band 顶（56px）低约 16px，上一分区仍在 band 内且 top 更小，于是跳“死亡开关”
// 后高亮的却是上一节“抗量子密钥”。改成：取 top 落在该线之上（含线）的最后一个分区。
function calcActiveLine() {
  const nav = navRef.value
  if (!nav) return 76
  const marginBottom = parseFloat(getComputedStyle(nav).marginBottom) || 0
  const root = props.container || null
  const navBottom = root
    ? nav.getBoundingClientRect().bottom - root.getBoundingClientRect().top
    : nav.getBoundingClientRect().bottom
  return navBottom + marginBottom + 12
}

function updateActive() {
  if (!props.items.length) return
  const root = props.container || null
  const rootTop = root ? root.getBoundingClientRect().top : 0
  const line = calcActiveLine()
  let current = ''
  for (const item of props.items) {
    const el = document.getElementById(item.id)
    if (!el) continue
    const top = el.getBoundingClientRect().top - rootTop
    if (top <= line + 2) current = item.id
    else break
  }
  if (!current) current = props.items[0]?.id || ''
  if (current) activeId.value = current
}

// 滚动时更新高亮（rAF 节流）；observer 只当布局变化的触发器（数据分波回来撑大表格时
// rect 变化但不滚动，也要重算）；挂载后补算，覆盖 v-perm 分区晚挂载。
function onScroll() {
  if (rafId) return
  rafId = requestAnimationFrame(() => { rafId = 0; updateActive() })
}

function setupObserver() {
  if (observer) observer.disconnect()
  if (scrollTarget) {
    scrollTarget.removeEventListener('scroll', onScroll)
    scrollTarget = null
  }
  if (!props.items.length) return
  observer = new IntersectionObserver(() => updateActive(), { root: props.container || null, rootMargin: '0px' })
  props.items.forEach((item) => {
    const el = document.getElementById(item.id)
    if (el) observer.observe(el)
  })
  scrollTarget = props.container || window
  scrollTarget.addEventListener('scroll', onScroll, { passive: true })
  updateActive()
}

onMounted(() => {
  setupObserver()
  // 带 v-perm 的分区可能晚挂载，稍后再建一次 observer 补上
  setTimeout(setupObserver, 500)
  setTimeout(updateActive, 1200)
})

watch(() => props.container, () => setupObserver())

onBeforeUnmount(() => {
  if (observer) observer.disconnect()
  if (scrollTarget) scrollTarget.removeEventListener('scroll', onScroll)
  if (rafId) cancelAnimationFrame(rafId)
})
</script>

<style lang="scss" scoped>
.section-nav {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  gap: 8px;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 10px 2px 12px;
  margin-bottom: 8px;
  /* 粘性栏必须不透明：透明时滚动中的内容（蓝色按钮等）会从栏下透出，
     与半透明胶囊叠在一起，标签被压住、按钮文字被截断（如设置页“绑定 Telegram”
     按钮卡在栏下 7 秒以上）。底色与页面同色，壁纸模式下与 .main-view 同款
     半透明 + 毛玻璃，仍融入页面。 */
  background: var(--el-bg-color);
  border-bottom: 0;

  &::-webkit-scrollbar {
    display: none;
  }
}

/* 壁纸模式：与 .main-view 同款半透明 + 毛玻璃，融入页面且不透内容。 */
html[data-wallpaper="1"] .layout.has-wallpaper .section-nav {
  background: rgba(13, 18, 28, 0.62);
  backdrop-filter: blur(12px) saturate(1.1);
  -webkit-backdrop-filter: blur(12px) saturate(1.1);
}
html.dark[data-wallpaper="1"] .layout.has-wallpaper .section-nav {
  background: rgba(10, 10, 14, 0.62);
}
@media (max-width: 767px) {
  html[data-wallpaper="1"] .layout.has-wallpaper .section-nav {
    background: rgba(13, 18, 28, 0.72);
  }
  html.dark[data-wallpaper="1"] .layout.has-wallpaper .section-nav {
    background: rgba(10, 10, 14, 0.72);
  }
}

.section-nav-item {
  flex-shrink: 0;
  /* 未选中：极淡的同色浅底 + 无边框，不再是一排实色芯片，视觉上就是一行文字标签；
     滚动时内容从下方滑过，浅底仍能托住文字不糊。 */
  border: 1px solid transparent;
  background: rgba(127, 127, 127, 0.14);
  color: var(--el-text-color-regular);
  border-radius: 16px;
  padding: 5px 12px;
  font-size: 13px;
  line-height: 1.4;
  cursor: pointer;
  white-space: nowrap;

  &.active {
    background: var(--el-color-primary);
    border-color: var(--el-color-primary);
    color: #fff;
  }
}
</style>
