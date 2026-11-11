<template>
  <!-- 产品自己的开场动画（不是广告位，无任何推广/外部内容）。
       全屏覆盖在登录页之上；登录表单在遮罩下正常挂载加载，不被阻塞。 -->
  <transition name="intro-fade" @after-leave="onAfterLeave">
    <div v-if="visible" class="intro-overlay" role="dialog" :aria-label="$t('intro.skip')" @click.self="dismiss()">
      <div class="intro-vista" aria-hidden="true" :style="{ backgroundImage: `url('/wallpapers/${introWallpaper}')` }"></div>
      <div class="intro-shade" aria-hidden="true"></div>

      <button class="intro-skip" type="button" @click="dismiss()">{{ $t('intro.skip') }}</button>

      <div class="intro-center">
        <span class="intro-badge" aria-hidden="true">
          <svg width="54" height="54" viewBox="0 0 36 36" fill="none">
            <defs>
              <linearGradient id="introBrandGrad" x1="0" y1="0" x2="36" y2="36" gradientUnits="userSpaceOnUse">
                <stop stop-color="#2563eb" />
                <stop offset="1" stop-color="#7c3aed" />
              </linearGradient>
            </defs>
            <rect width="36" height="36" rx="10" fill="url(#introBrandGrad)" />
            <rect x="8" y="11" width="20" height="14" rx="2" stroke="#fff" stroke-width="1.8" />
            <path d="M9 13l9 6 9-6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
        <h1 class="intro-brand" :class="{ 'title-display': titleUsesDisplayFont }"><span class="intro-brand-text">{{ brandTitle }}</span></h1>
      </div>

      <div class="intro-quote-wrap">
        <transition name="quote-fade" mode="out-in">
          <figure class="intro-quote" :key="quoteIndex">
            <blockquote class="intro-quote-en">“{{ QUOTES[quoteIndex].en }}”</blockquote>
            <figcaption class="intro-quote-sub">{{ $t(QUOTES[quoteIndex].key) }}</figcaption>
            <figcaption class="intro-quote-by">— Edward Snowden</figcaption>
          </figure>
        </transition>
      </div>

    </div>
  </transition>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useSettingStore } from '@/store/setting.js'

// 斯诺登名言：只用 PHASE7-NOTES.md 里核实过的三句英文原文，全文照用，不编新的。
// 英文原文固定不变；各语种小字翻译走 i18n intro.quote1/2/3。
const QUOTES = [
  {
    key: 'intro.quote1',
    en: 'Arguing that you don\'t care about the right to privacy because you have nothing to hide is no different than saying you don\'t care about free speech because you have nothing to say.',
  },
  {
    key: 'intro.quote2',
    en: 'Privacy isn\'t about something to hide. Privacy is about something to protect.',
  },
  {
    key: 'intro.quote3',
    en: 'Under observation, we act less free, which means we effectively are less free.',
  },
]

// 开场背景：15 张斯诺登远景同款壁纸，每次进入随机挑一张，不再固定 snowden-vista。
const SNOWDEN_WALLPAPERS = [
  'snowden-vista.jpg',
  'snowden-02.jpg',
  'snowden-03.jpg',
  'snowden-04.jpg',
  'snowden-05.jpg',
  'snowden-06.jpg',
  'snowden-07.jpg',
  'snowden-08.jpg',
  'snowden-09.jpg',
  'snowden-10.jpg',
  'snowden-11.jpg',
  'snowden-18.jpg',
  'snowden-19.jpg',
  'snowden-20.jpg',
  'snowden-21.jpg',
]
const introWallpaper = SNOWDEN_WALLPAPERS[Math.floor(Math.random() * SNOWDEN_WALLPAPERS.length)]

const AUTO_DISMISS_MS = 16000
const QUOTE_INTERVAL_MS = 5000

const settingStore = useSettingStore()
// 品牌字标：与登录页同一来源（后端网站配置 title），不自创新名字；
// 配置未加载完成前先用 Mail 占位，配置到达后自动更新。
const brandTitle = computed(() => settingStore.settings?.title || 'Mail')

// 任务 4：品牌标题不含汉字时才用展示字体（与侧栏/登录页同规则）。
const titleUsesDisplayFont = computed(() => !/\p{Script=Han}/u.test(settingStore.settings?.title || ''))

// 2026-11-09 用户定：开场动画默认不再自动播放，进站直接显示登录；
// 想看时点登录页底部的“观看开场动画”手动打开（登录页通过 ref 调 open()）。
const visible = ref(false)
const quoteIndex = ref(0)

let rotateTimer = null
let dismissTimer = null

function startTimers() {
  stopTimers()
  quoteIndex.value = 0
  rotateTimer = setInterval(() => {
    quoteIndex.value = (quoteIndex.value + 1) % QUOTES.length
  }, QUOTE_INTERVAL_MS)
  dismissTimer = setTimeout(() => dismiss(), AUTO_DISMISS_MS)
}

function open() {
  if (visible.value) return
  visible.value = true
  startTimers()
}

defineExpose({ open })

function dismiss() {
  if (!visible.value) return
  visible.value = false
}

function onAfterLeave() {
  stopTimers()
}

function onKeydown(e) {
  if (e.key === 'Escape') dismiss()
}

function stopTimers() {
  if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null }
  if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  stopTimers()
  window.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
/* 纯 CSS 动效：无视频、无重型库、无新增依赖。 */
.intro-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  overflow: hidden;
  background: #0b1020;
  color: #fff;
  font-family: inherit;
  cursor: default;
}

.intro-vista {
  position: absolute;
  inset: -4%;
  /* 背景图由 :style 随机绑定（11 张斯诺登同款之一），这里只定位置与铺满方式 */
  background: center / cover no-repeat;
  /* 16 秒两程运镜（与 AUTO_DISMISS_MS=16000 对齐，全程不停）：
     0–8s 第一程 scale 1.02→1.12 + 向左上平移；
     8–16s 第二程继续同向平移 + 轻微缩放至 1.18，50% 关键帧保证衔接无跳变；
     linear 保证全程匀速、不在 8s 处停顿。 */
  animation: intro-kenburns 16s linear both;
}

.intro-shade {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(180deg, rgba(5, 8, 20, 0.25) 0%, rgba(5, 8, 20, 0.05) 40%, rgba(5, 8, 20, 0.78) 100%);
}

@keyframes intro-kenburns {
  0% { transform: scale(1.02) translate(0, 0); }
  /* 8s：第一程终点，同时是第二程起点，数值连续、无跳变 */
  50% { transform: scale(1.12) translate(-1.2%, -1.5%); }
  /* 16s：第二程终点，继续同向平移 + 轻微缩放 */
  100% { transform: scale(1.18) translate(-2.4%, -2.8%); }
}

.intro-skip {
  position: absolute;
  top: 20px;
  right: 24px;
  padding: 8px 18px;
  border: 1px solid rgba(255, 255, 255, 0.45);
  border-radius: 999px;
  background: rgba(10, 14, 30, 0.35);
  color: rgba(255, 255, 255, 0.92);
  font-size: 14px;
  letter-spacing: 0.08em;
  cursor: pointer;
  backdrop-filter: blur(4px);
  transition: background 0.3s, border-color 0.3s;
}
.intro-skip:hover {
  background: rgba(255, 255, 255, 0.18);
  border-color: rgba(255, 255, 255, 0.8);
}

.intro-center {
  position: absolute;
  left: 50%;
  top: 34%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  text-align: center;
}

.intro-badge {
  display: block;
  filter: drop-shadow(0 6px 24px rgba(37, 99, 235, 0.55));
  animation: intro-rise 0.9s ease-out 0.7s both;
}
.intro-badge svg { display: block; }

.intro-brand {
  margin: 0;
  font-size: clamp(40px, 7vw, 68px);
  font-weight: 700;
  letter-spacing: 0.06em;
  line-height: 1.15;
  text-shadow: 0 2px 28px rgba(0, 0, 0, 0.6);
  /* 入场 0.9s 上浮（不变）+ 8s 起极轻微呼吸光晕（5s 一周期，无限循环，
     只动 text-shadow，不碰 transform/opacity，与入场动画无冲突） */
  animation:
    intro-rise 0.9s ease-out 0.9s both,
    intro-breathe 5s ease-in-out 8s infinite;
}

@keyframes intro-breathe {
  0%, 100% { text-shadow: 0 2px 28px rgba(0, 0, 0, 0.6); }
  50% { text-shadow: 0 2px 28px rgba(0, 0, 0, 0.6), 0 0 44px rgba(165, 180, 252, 0.35); }
}

/* 任务 4：非汉字品牌标题用展示字体（Bebas Neue / Montserrat），够大够粗。 */
.intro-brand.title-display {
  font-family: var(--font-display);
  letter-spacing: 0.08em;
}

.intro-brand-text {
  background: linear-gradient(100deg, #fff 40%, #c7d2fe 50%, #fff 60%);
  background-size: 220% 100%;
  background-position: 120% 0;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  /* 光效扫过字标：首道 2.1s（第一幕入场后，原样保留）；
     第二幕再各一道轻微扫过——8s 与 13s 各 1.2s；
     同一 intro-shine 复用三遍，首尾位置（120% / -120%）光带都在字外，
     复位不可见、不刺眼。 */
  animation:
    intro-shine 1.6s ease-in-out 2.1s both,
    intro-shine 1.2s ease-in-out 8s both,
    intro-shine 1.2s ease-in-out 13s both;
}

@keyframes intro-rise {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes intro-shine {
  from { background-position: 120% 0; }
  to { background-position: -120% 0; }
}

.intro-quote-wrap {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 12%;
  /* 居中不用 left:50% + translateX(-50%)：入场动画 intro-rise（fill both）
     的终态 transform: translateY(0) 会覆盖 base 的 translateX(-50%），
     导致整块名言右移半个身位、右缘被裁（PHASE7 遗留 bug，实测 rect.x=640）。
     改用 left/right:0 + margin auto 居中，动画只动 Y 轴，不再打架。 */
  margin-inline: auto;
  width: min(860px, 88vw);
  text-align: center;
  animation: intro-rise 0.9s ease-out 1.4s both;
}

.intro-quote { margin: 0; }

.intro-quote-en {
  margin: 0 0 12px;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: clamp(16px, 2.4vw, 22px);
  font-style: italic;
  line-height: 1.65;
  color: rgba(255, 255, 255, 0.95);
  text-shadow: 0 1px 12px rgba(0, 0, 0, 0.7);
}

.intro-quote-sub {
  font-size: 13px;
  line-height: 1.6;
  color: rgba(255, 255, 255, 0.72);
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.7);
}

.intro-quote-by {
  margin-top: 8px;
  font-size: 12px;
  letter-spacing: 0.14em;
  color: rgba(255, 255, 255, 0.55);
}

.intro-nomore {
  position: absolute;
  right: 24px;
  bottom: 20px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.75);
  cursor: pointer;
  user-select: none;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.7);
}
.intro-nomore input {
  accent-color: #6366f1;
  cursor: pointer;
}

/* 名言轮换：上浮 + 淡入（不只是透明度变化）。
   旧句向上浮出、新句从下方浮入；每句 5 秒（QUOTE_INTERVAL_MS），
   mode="out-in" 下离场 0.6s + 入场 0.6s。 */
.quote-fade-enter-active, .quote-fade-leave-active { transition: opacity 0.6s ease, transform 0.6s ease; }
.quote-fade-enter-from { opacity: 0; transform: translateY(14px); }
.quote-fade-leave-to { opacity: 0; transform: translateY(-10px); }

/* 整层淡入淡出（出现 0.6 秒，消失 0.5 秒） */
.intro-fade-enter-active { transition: opacity 0.6s ease; }
.intro-fade-leave-active { transition: opacity 0.5s ease; }
.intro-fade-enter-from, .intro-fade-leave-to { opacity: 0; }

@media (prefers-reduced-motion: reduce) {
  .intro-vista, .intro-badge, .intro-brand, .intro-brand-text, .intro-quote-wrap {
    animation: none !important;
  }
  /* 呼吸光晕随 .intro-brand 的 animation:none 一并停用；
     名言轮换与整层淡入淡出也改为瞬时切换，不留 transform/opacity 过渡。 */
  .quote-fade-enter-active, .quote-fade-leave-active,
  .intro-fade-enter-active, .intro-fade-leave-active {
    transition: none !important;
  }
}
</style>
