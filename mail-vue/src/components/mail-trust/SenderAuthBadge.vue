<template>
  <!-- Phase 8 E：发件人身份验证标识（SPF / DKIM / DMARC）。
       只展示收信时取到的认证结果：无认证头 = 未验证，绝不编造通过。 -->
  <span class="auth-badge" :class="`auth-${auth.status}`">
    <el-tooltip effect="dark" placement="top">
      <template #content>
        <div class="auth-tip">
          <div>{{ tipTitle }}</div>
          <div>SPF: {{ authLabel(auth.spf) }} · DKIM: {{ authLabel(auth.dkim) }} · DMARC: {{ authLabel(auth.dmarc) }}</div>
          <div>{{ tipDetail }}</div>
        </div>
      </template>
      <span class="auth-label">
        <span v-if="auth.status === 'pass'">✓</span>
        <span v-else-if="auth.status === 'fail'">⚠</span>
        <span v-else>?</span>
        {{ statusText }}
      </span>
    </el-tooltip>
  </span>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  auth: {
    type: Object,
    default: () => ({ spf: 'none', dkim: 'none', dmarc: 'none', status: 'unverified' })
  }
})

const { t } = useI18n()

const statusText = computed(() => {
  if (props.auth.status === 'pass') return t('trust.authPass')
  if (props.auth.status === 'fail') return t('trust.authFail')
  return t('trust.authUnverified')
})

const tipTitle = computed(() => {
  if (props.auth.status === 'pass') return t('trust.authPassTip')
  if (props.auth.status === 'fail') return t('trust.authFailTip')
  return t('trust.authUnverifiedTip')
})

const tipDetail = computed(() => {
  if (props.auth.status === 'fail') return t('trust.authFailWarn')
  return ''
})

function authLabel(v) {
  if (v === 'pass') return t('trust.authValuePass')
  if (v === 'fail') return t('trust.authValueFail')
  return t('trust.authValueNone')
}
</script>

<style scoped>
.auth-badge {
  display: inline-flex;
  align-items: center;
  font-size: 12px;
  line-height: 1;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid transparent;
  cursor: default;
  white-space: nowrap;
}

.auth-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.auth-pass {
  color: #1a7f37;
  background: #e6f4ea;
  border-color: #b7dfc0;
}

.auth-fail {
  color: #9a6700;
  background: #fef3c7;
  border-color: #f5d67b;
}

.auth-unverified {
  color: var(--secondary-text-color);
  background: var(--light-ill);
  border-color: var(--light-border-color);
}

.auth-tip {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 320px;
  line-height: 1.5;
  white-space: normal;
}
</style>
