<template>
  <div class="content-box" ref="contentBox">
    <!-- Phase 8 E：远程图片拦截横条（服务端已清洗过一遍，这里是前端第二道）。
         只有确实拦住了远程图才出现；点“加载图片”恢复本封邮件的远程图。 -->
    <div v-if="blockedCount > 0 && !imagesLoaded" class="remote-block-bar">
      <span class="remote-block-text">{{ $t('trust.remoteBlocked', { count: blockedCount, tracking: trackingCount }) }}</span>
      <el-button size="small" @click="restoreRemoteImages">{{ $t('trust.loadImages') }}</el-button>
    </div>
    <div ref="container" class="content-html"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue'

const props = defineProps({
  html: {
    type: String,
    required: true
  },
  // Phase 8 E：信任发件人 / 用户全局放行时为 true，前端不拦截（服务端
  // 同样不拦截，两处口径一致）。默认 false = 拦截。
  allowRemote: {
    type: Boolean,
    default: false
  },
  // 视为本站的 host（R2 域名等），这些 host 的图不算远程。父组件挂载点传。
  localHosts: {
    type: Array,
    default: () => []
  }
})

const container = ref(null)
const contentBox = ref(null)
const blockedCount = ref(0)
const trackingCount = ref(0)
const imagesLoaded = ref(false)
let shadowRoot = null

const TRANSPARENT_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

function isRemoteSrc(src) {
  if (!src) return false
  const s = String(src).trim()
  if (/^https?:\/\//i.test(s)) {
    try {
      const host = new URL(s).hostname
      if (host === window.location.hostname) return false
      if ((props.localHosts || []).includes(host)) return false
    } catch (e) {
      return true
    }
    return true
  }
  return s.startsWith('//')
}

function isTrackingPixel(img) {
  const w = img.getAttribute('width')
  const h = img.getAttribute('height')
  if ((w !== null && ['0', '1'].includes(String(w).trim())) ||
    (h !== null && ['0', '1'].includes(String(h).trim()))) return true
  const style = img.getAttribute('style') || ''
  if (/(?:^|[;\s])width\s*:\s*0?1px/i.test(style) || /(?:^|[;\s])height\s*:\s*0?1px/i.test(style)) return true
  return /(pixel|tracking|beacon|track\.gif|open\.gif|__open)/i.test(img.getAttribute('src') || '')
}

// 前端第二道拦截：服务端已把远程 src 移入 data-mail-remote-src 的只计数；
// 漏网的远程 src 在这里同样拦截（绝不只靠服务端一处）。
function blockRemoteImages() {
  if (!shadowRoot) return
  blockedCount.value = 0
  trackingCount.value = 0
  if (props.allowRemote) return
  const count = (isPixel) => {
    blockedCount.value++
    if (isPixel) trackingCount.value++
  }
  for (const img of Array.from(shadowRoot.querySelectorAll('img'))) {
    if (img.hasAttribute('data-mail-remote-src')) {
      count(img.hasAttribute('data-mail-tracking'))
      continue
    }
    const src = img.getAttribute('src')
    if (!isRemoteSrc(src)) continue
    const pixel = isTrackingPixel(img)
    img.setAttribute('data-mail-remote-src', src)
    img.setAttribute('data-mail-remote', '1')
    if (pixel) img.setAttribute('data-mail-tracking', '1')
    img.setAttribute('src', TRANSPARENT_GIF)
    const srcset = img.getAttribute('srcset')
    if (srcset && /https?:\/\//i.test(srcset)) {
      img.setAttribute('data-mail-remote-srcset', srcset)
      img.removeAttribute('srcset')
    }
    count(pixel)
  }
  for (const source of Array.from(shadowRoot.querySelectorAll('source'))) {
    if (source.hasAttribute('data-mail-remote-src')) { count(false); continue }
    const src = source.getAttribute('src')
    if (!isRemoteSrc(src)) continue
    source.setAttribute('data-mail-remote-src', src)
    source.setAttribute('data-mail-remote', '1')
    source.removeAttribute('src')
    count(false)
  }
  for (const video of Array.from(shadowRoot.querySelectorAll('video'))) {
    if (video.hasAttribute('data-mail-remote-poster')) { count(false); continue }
    const poster = video.getAttribute('poster')
    if (!isRemoteSrc(poster)) continue
    video.setAttribute('data-mail-remote-poster', poster)
    video.setAttribute('data-mail-remote', '1')
    video.removeAttribute('poster')
    count(false)
  }
  for (const el of Array.from(shadowRoot.querySelectorAll('[style]'))) {
    if (el.hasAttribute('data-mail-remote-style')) { count(false); continue }
    const style = el.getAttribute('style') || ''
    if (!/url\(\s*(['"]?)https?:\/\//i.test(style)) continue
    el.setAttribute('data-mail-remote-style', style)
    el.setAttribute('data-mail-remote', '1')
    el.setAttribute('style', style.replace(/url\(\s*(['"]?)https?:\/\/[^)'"]+\1\s*\)/gi, 'url()'))
    count(false)
  }
}

// 用户点“加载图片”：只恢复本封邮件被拦的远程图（不改信任状态；
// 想以后自动加载，点读信页的“信任此发件人”）。
function restoreRemoteImages() {
  if (!shadowRoot) return
  for (const el of Array.from(shadowRoot.querySelectorAll('[data-mail-remote-src]'))) {
    el.setAttribute('src', el.getAttribute('data-mail-remote-src'))
    el.removeAttribute('data-mail-remote-src')
    el.removeAttribute('data-mail-remote')
    el.removeAttribute('data-mail-tracking')
    const srcset = el.getAttribute('data-mail-remote-srcset')
    if (srcset) {
      el.setAttribute('srcset', srcset)
      el.removeAttribute('data-mail-remote-srcset')
    }
  }
  for (const el of Array.from(shadowRoot.querySelectorAll('[data-mail-remote-poster]'))) {
    el.setAttribute('poster', el.getAttribute('data-mail-remote-poster'))
    el.removeAttribute('data-mail-remote-poster')
    el.removeAttribute('data-mail-remote')
  }
  for (const el of Array.from(shadowRoot.querySelectorAll('[data-mail-remote-style]'))) {
    el.setAttribute('style', el.getAttribute('data-mail-remote-style'))
    el.removeAttribute('data-mail-remote-style')
    el.removeAttribute('data-mail-remote')
  }
  imagesLoaded.value = true
  blockedCount.value = 0
  trackingCount.value = 0
  autoScale()
}

function updateContent() {
  if (!shadowRoot) return;

  // 1. 提取 <body> 的 style 属性（如果存在）
  const bodyStyleRegex = /<body[^>]*style="([^"]*)"[^>]*>/i;
  const bodyStyleMatch = props.html.match(bodyStyleRegex);
  const bodyStyle = bodyStyleMatch ? bodyStyleMatch[1] : '';

  // 2. 移除 <body> 标签（保留内容）
  const cleanedHtml = props.html.replace(/<\/?body[^>]*>/gi, '');

  // 3. 将 body 的 style 应用到 .shadow-content
  shadowRoot.innerHTML = `
    <style>
      :host {
        all: initial;
        width: 100%;
        height: 100%;
        font-family: Inter, 'Helvetica Neue', Helvetica, 'PingFang SC',
                    'Hiragino Sans GB', 'Microsoft YaHei', '微软雅黑', Arial, sans-serif;
        font-size: 14px;
        line-height: 1.5;
        color: #13181D;
        word-break: break-word;
      }

      h1, h2, h3, h4 {
          font-size: 18px;
          font-weight: 700;
      }

      p {
        margin: 0;
      }

      a {
        text-decoration: none;
        color: #0E70DF;
      }

      .shadow-content {
        background: #FFFFFF;
        width: fit-content;
        height: fit-content;
        min-width: 100%;
        ${bodyStyle ? bodyStyle : ''} /* 注入 body 的 style */
      }

      img:not(table img) {
        max-width: 100%;
        height: auto !important;
      }

    </style>
    <div class="shadow-content">
      ${cleanedHtml}
    </div>
  `;
}

function autoScale() {
  if (!shadowRoot || !contentBox.value) return

  const parent = contentBox.value
  const shadowContent = shadowRoot.querySelector('.shadow-content')

  if (!shadowContent) return

  const parentWidth = parent.offsetWidth
  const childWidth = shadowContent.scrollWidth

  if (childWidth === 0) return

  const scale = parentWidth / childWidth

  const hostElement = shadowRoot.host
  hostElement.style.zoom = scale
}

function render() {
  imagesLoaded.value = false
  updateContent()
  blockRemoteImages()
  autoScale()
}

onMounted(() => {
  shadowRoot = container.value.attachShadow({ mode: 'open' })
  render()
})

watch(() => props.html, () => {
  render()
})

watch(() => props.allowRemote, () => {
  render()
})
</script>

<style scoped>
.content-box {
  width: 100%;
  height: 100%;
  overflow: hidden;
  font-family: Inter, "Helvetica Neue", Helvetica, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "微软雅黑", Arial, sans-serif;
}

.content-html {
  width: 100%;
  height: 100%;
}

.remote-block-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  margin-bottom: 10px;
  border: 1px solid var(--light-border-color);
  border-radius: 6px;
  background: var(--light-ill);
  font-size: 13px;
  line-height: 1.5;
}

.remote-block-text {
  flex: 1;
  color: var(--regular-text-color);
}
</style>
