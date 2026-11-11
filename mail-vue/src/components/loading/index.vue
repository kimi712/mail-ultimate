<template>
  <div class="loading-wrap">
    <el-icon class="is-loading" :style="{ fontSize: `${size}px` }">
      <svg class="circular" viewBox="0 0 20 20">
        <g
            class="path2 loading-path"
            stroke-width="0"
            style="animation: none; stroke: none"
        >
          <circle r="3.375" class="dot1" rx="0" ry="0" />
          <circle r="3.375" class="dot2" rx="0" ry="0" />
          <circle r="3.375" class="dot4" rx="0" ry="0" />
          <circle r="3.375" class="dot3" rx="0" ry="0" />
        </g>
      </svg>
    </el-icon>
    <!-- Phase 8 斯诺登元素补齐：加载动画下方轮换小字（斯诺登主题短句，非引言原文，故不用引号、不署名；每 4 秒换一句）。 -->
    <transition name="loading-gloss-fade" mode="out-in">
      <div v-if="showQuote" class="loading-gloss" :key="glossIndex">{{ currentGloss }}</div>
    </transition>
  </div>
</template>

<script>
const LOADING_GLOSSES = ['loadingGloss1', 'loadingGloss2', 'loadingGloss3']

export default {
  props: {
    size: {
      type: Number,
      default: 30
    },
    showQuote: {
      type: Boolean,
      default: true
    }
  },
  data() {
    return {
      glossIndex: 0,
      glossTimer: null
    }
  },
  computed: {
    currentGloss() {
      return this.$t(LOADING_GLOSSES[this.glossIndex])
    }
  },
  mounted() {
    this.glossTimer = setInterval(() => {
      this.glossIndex = (this.glossIndex + 1) % LOADING_GLOSSES.length
    }, 4000)
  },
  beforeUnmount() {
    if (this.glossTimer) clearInterval(this.glossTimer)
  }
}
</script>

<style scoped>
/* Phase 8 斯诺登元素补齐：加载小字——纵向排列，动画在上、小字在下 */
.loading-wrap {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.loading-gloss {
  max-width: 320px;
  font-size: 12px;
  font-style: italic;
  line-height: 1.5;
  text-align: center;
  color: var(--el-text-color-placeholder);
}
.loading-gloss-fade-enter-active, .loading-gloss-fade-leave-active { transition: opacity .5s ease; }
.loading-gloss-fade-enter-from, .loading-gloss-fade-leave-to { opacity: 0; }
.el-select-dropdown__loading {
  display: flex;
  justify-content: center;
  align-items: center;
  height: calc(v-bind(size) * 3.33px);
  font-size: calc(v-bind(size) * 0.67px);
}

.circular {
  display: inline;
  height: v-bind(size) + 'px';
  width: v-bind(size) + 'px';
  animation: loading-rotate 2s linear infinite;
}
.path {
  animation: loading-dash 1.5s ease-in-out infinite;
  stroke-dasharray: 90, 150;
  stroke-dashoffset: 0;
  stroke-width: 2;
  stroke: var(--el-color-primary);
  stroke-linecap: round;
}
.loading-path .dot1 {
  transform: translate(3.75px, 3.75px);
  fill: var(--el-color-primary);
  animation: custom-spin-move 1s infinite linear alternate;
  opacity: 0.3;
}
.loading-path .dot2 {
  transform: translate(calc(100% - 3.75px), 3.75px);
  fill: var(--el-color-primary);
  animation: custom-spin-move 1s infinite linear alternate;
  opacity: 0.3;
  animation-delay: 0.4s;
}
.loading-path .dot3 {
  transform: translate(3.75px, calc(100% - 3.75px));
  fill: var(--el-color-primary);
  animation: custom-spin-move 1s infinite linear alternate;
  opacity: 0.3;
  animation-delay: 1.2s;
}
.loading-path .dot4 {
  transform: translate(calc(100% - 3.75px), calc(100% - 3.75px));
  fill: var(--el-color-primary);
  animation: custom-spin-move 1s infinite linear alternate;
  opacity: 0.3;
  animation-delay: 0.8s;
}
@keyframes loading-rotate {
  to {
    transform: rotate(360deg);
  }
}
@keyframes loading-dash {
  0% {
    stroke-dasharray: 1, 200;
    stroke-dashoffset: 0;
  }
  50% {
    stroke-dasharray: 90, 150;
    stroke-dashoffset: -40px;
  }
  100% {
    stroke-dasharray: 90, 150;
    stroke-dashoffset: -120px;
  }
}
@keyframes custom-spin-move {
  to {
    opacity: 1;
  }
}

.is-loading {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
</style>
