<!-- Phase 7：闲置自动锁定。挂在登录后的 layout 里（登录页不在 layout 内，不受影响）。
  行为：读 GET /my/security 的 autoLockMinutes（0=从不）；无操作满 N 分钟后
  全屏锁定，须输入登录密码调 POST /security/unlock 解锁。锁定本身不登出、
  不轮换会话，只是界面态；锁定同时清掉内存中的 E2EE 密钥（解锁 E2EE 需重新输入加密密码）。
  安全中心改设置后会派发 window 事件 auto-lock-settings-changed 告知本组件刷新时长。 -->
<template>
  <div v-if="locked" class="auto-lock-overlay">
    <div class="auto-lock-box">
      <div class="auto-lock-title">{{ $t('securityLockedTitle') }}</div>
      <div class="auto-lock-desc">{{ $t('securityLockedDesc') }}</div>
      <el-input
        v-model="password"
        type="password"
        :placeholder="$t('securityUnlockPassword')"
        autocomplete="off"
        class="auto-lock-input"
        @keyup.enter="doUnlock"
      />
      <el-button type="primary" :loading="unlocking" class="auto-lock-btn" @click="doUnlock">
        {{ $t('securityUnlock') }}
      </el-button>
    </div>
  </div>
</template>
<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { getSecurity, unlock } from '@/request/security.js'
import { clearMemoryKey } from '@/utils/e2ee.js'

const { t } = useI18n()
const locked = ref(false)
const password = ref('')
const unlocking = ref(false)
let minutes = 0
let timer = null
let lastReset = 0

function clearTimer() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

function armTimer() {
  clearTimer()
  if (!minutes || minutes <= 0 || locked.value) {
    return
  }
  timer = setTimeout(lockScreen, minutes * 60 * 1000)
}

function lockScreen() {
  if (locked.value) {
    return
  }
  clearTimer()
  // 锁定即清内存 E2EE 密钥：别人拿到已登录的电脑也看不到加密邮件明文。
  try {
    clearMemoryKey()
  } catch (e) {
    // best-effort
  }
  password.value = ''
  locked.value = true
}

function onActivity() {
  if (locked.value) {
    return
  }
  // 高频事件节流：5 秒内只重设一次计时器。
  const now = Date.now()
  if (now - lastReset < 5000) {
    return
  }
  lastReset = now
  armTimer()
}

function onSettingsChanged(e) {
  const next = Number(e?.detail?.autoLockMinutes)
  if (!isNaN(next)) {
    minutes = next
    armTimer()
  }
}

function loadMinutes() {
  getSecurity().then((data) => {
    if (!data) {
      return
    }
    const next = Number(data.autoLockMinutes)
    minutes = isNaN(next) ? 0 : next
    armTimer()
  }).catch(() => {
    // 读不到设置就不锁定，绝不因安全组件故障把用户锁在外面。
  })
}

function doUnlock() {
  if (!password.value || unlocking.value) {
    return
  }
  unlocking.value = true
  unlock(password.value).then(() => {
    password.value = ''
    locked.value = false
    unlocking.value = false
    lastReset = Date.now()
    armTimer()
  }).catch((e) => {
    unlocking.value = false
    ElMessage({
      message: e?.message || t('securityUnlockFailed'),
      type: 'error',
      plain: true
    })
  })
}

const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click', 'wheel', 'touchstart']

onMounted(() => {
  loadMinutes()
  ACTIVITY_EVENTS.forEach((name) => window.addEventListener(name, onActivity, { passive: true }))
  window.addEventListener('auto-lock-settings-changed', onSettingsChanged)
})

onBeforeUnmount(() => {
  clearTimer()
  ACTIVITY_EVENTS.forEach((name) => window.removeEventListener(name, onActivity))
  window.removeEventListener('auto-lock-settings-changed', onSettingsChanged)
})
</script>
<style scoped lang="scss">
.auto-lock-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.72);
  backdrop-filter: blur(6px);
}

.auto-lock-box {
  width: 360px;
  max-width: calc(100vw - 40px);
  padding: 32px 28px;
  border-radius: 10px;
  background: var(--el-bg-color);
  display: flex;
  flex-direction: column;
  gap: 16px;

  .auto-lock-title {
    font-size: 20px;
    font-weight: bold;
  }

  .auto-lock-desc {
    font-size: 14px;
    color: var(--regular-text-color);
    line-height: 1.6;
  }

  .auto-lock-input {
    width: 100%;
  }

  .auto-lock-btn {
    width: 100%;
  }
}
</style>
