<!-- Phase 8 F：本地密码强度计组件（纯前端计算，不把密码发给任何第三方）。
  用法：<PasswordStrengthMeter :password="pwd" />，内部调
  @/utils/password-strength.js 的 evaluatePasswordStrength。
  文案 key 见汇报 i18n 清单（pwdStrength*）。 -->
<template>
  <div v-if="password" class="pwd-strength">
    <div class="pwd-strength-bar">
      <span
        v-for="i in 4"
        :key="i"
        class="pwd-strength-seg"
        :class="{ active: i <= result.score, [result.level]: i <= result.score }"
      />
    </div>
    <div class="pwd-strength-label">{{ $t('pwdStrength' + capitalize(result.level)) }}</div>
    <div v-if="result.reasons.length" class="pwd-strength-reasons">
      <div v-for="reason in result.reasons" :key="reason" class="pwd-strength-reason">
        {{ $t('pwdStrengthReason' + capitalize(reason)) }}
      </div>
    </div>
  </div>
</template>
<script setup>
import { computed, defineOptions, defineProps } from 'vue'
import { evaluatePasswordStrength } from '@/utils/password-strength.js'

defineOptions({
  name: 'PasswordStrengthMeter'
})

const props = defineProps({
  password: {
    type: String,
    default: ''
  }
})

const result = computed(() => evaluatePasswordStrength(props.password))

function capitalize(s) {
  return String(s || '').replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase())
}
</script>
<style scoped>
.pwd-strength {
  margin-top: 8px;
}
.pwd-strength-bar {
  display: flex;
  gap: 4px;
}
.pwd-strength-seg {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: #e4e7ed;
}
.pwd-strength-seg.active.very_weak {
  background: #f56c6c;
}
.pwd-strength-seg.active.weak {
  background: #e6a23c;
}
.pwd-strength-seg.active.fair {
  background: #e6a23c;
}
.pwd-strength-seg.active.good {
  background: #67c23a;
}
.pwd-strength-seg.active.strong {
  background: #67c23a;
}
.pwd-strength-label {
  margin-top: 4px;
  font-size: 12px;
  color: #909399;
}
.pwd-strength-reasons {
  margin-top: 4px;
  font-size: 12px;
  color: #e6a23c;
}
</style>
