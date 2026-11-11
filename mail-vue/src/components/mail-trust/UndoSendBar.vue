<template>
  <!-- Phase 8 E：撤回条（总协调挂载进 views/send/index.vue：/email/send 返回
       {pending:true} 时展示）。倒计时结束自动触发 onExpired（父组件调
       confirm 接口真正发出）；点“撤回”调 cancel 接口，信回草稿。
       机制：延迟发出，不是发出去再追回——窗口内信还没离开本站。 -->
  <div class="undo-bar">
    <span class="undo-text">{{ $t('trust.undoCountdown', { seconds: remaining }) }}</span>
    <el-button size="small" type="primary" :loading="undoLoading" @click="onUndo">
      {{ $t('trust.undoSend') }}
    </el-button>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  pendingId: { type: Number, required: true },
  undoSeconds: { type: Number, default: 10 },
  // 服务端返回的 undoUntil（'YYYY-MM-DD HH:mm:ss'，服务端时钟为准）。
  undoUntil: { type: String, default: '' }
})

const emit = defineEmits(['undo', 'expired'])

const remaining = ref(props.undoSeconds)
const undoLoading = ref(false)
let timer = null

function parseUndoUntil() {
  if (!props.undoUntil) return null
  const d = new Date(props.undoUntil.replace(' ', 'T') + 'Z')
  return isNaN(d.getTime()) ? null : d.getTime()
}

function tick() {
  const target = parseUndoUntil()
  if (target) {
    remaining.value = Math.max(0, Math.ceil((target - Date.now()) / 1000))
  } else {
    remaining.value = Math.max(0, remaining.value - 1)
  }
  if (remaining.value <= 0) {
    stop()
    emit('expired', props.pendingId)
  }
}

function stop() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function onUndo() {
  undoLoading.value = true
  emit('undo', props.pendingId)
}

onMounted(() => {
  tick()
  timer = setInterval(tick, 250)
})

onUnmounted(() => {
  stop()
})
</script>

<style scoped>
.undo-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--light-border-color);
  border-radius: 6px;
  background: var(--light-ill);
  font-size: 14px;
}

.undo-text {
  flex: 1;
}
</style>
