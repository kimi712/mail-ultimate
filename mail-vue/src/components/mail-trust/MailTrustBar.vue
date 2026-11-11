<template>
  <!-- Phase 8 E：读信页信任操作条（总协调挂载进 views/content/index.vue，
       锚点见子代理 E 汇报）。只做本封邮件的操作，不改读信视图本身。 -->
  <div class="trust-bar">
    <SenderAuthBadge :auth="auth" />
    <el-alert
      v-if="auth.status === 'fail'"
      :closable="false"
      :title="$t('trust.authFailWarn')"
      type="warning"
      show-icon
      class="trust-alert"
    />
    <div class="trust-actions">
      <el-button size="small" @click="toggleTrust">
        {{ trusted ? $t('trust.untrustSender') : $t('trust.trustSender') }}
      </el-button>
      <el-button size="small" @click="toggleSpam">
        {{ isSpam ? $t('trust.notSpam') : $t('trust.markSpam') }}
      </el-button>
      <el-button size="small" type="danger" plain @click="confirmPhishing">
        {{ $t('trust.reportPhishing') }}
      </el-button>
      <el-button
        v-if="unsubscribe && (unsubscribe.url || unsubscribe.mailto)"
        size="small"
        type="primary"
        plain
        :loading="unsubLoading"
        @click="doUnsubscribe"
      >
        {{ $t('trust.unsubscribe') }}
      </el-button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from 'vue-i18n'
import SenderAuthBadge from './SenderAuthBadge.vue'
import {
  trustSender, untrustSender, trustMarkSpam, trustNotSpam,
  trustReportPhishing, trustUnsubscribe, trustErrorI18nKey
} from '@/request/mail-trust.js'

const props = defineProps({
  emailId: { type: Number, required: true },
  senderEmail: { type: String, default: '' },
  auth: { type: Object, default: () => ({ spf: 'none', dkim: 'none', dmarc: 'none', status: 'unverified' }) },
  unsubscribe: { type: Object, default: null },
  trusted: { type: Boolean, default: false },
  isSpam: { type: Boolean, default: false }
})

const emit = defineEmits(['trust-change', 'spam-change', 'reported', 'unsubscribed'])

const { t } = useI18n()
const trusted = ref(props.trusted)
const isSpam = ref(props.isSpam)
const unsubLoading = ref(false)

const auth = computed(() => props.auth || { spf: 'none', dkim: 'none', dmarc: 'none', status: 'unverified' })

function showErr(e) {
  ElMessage({ message: t(trustErrorI18nKey(e && e.code)), type: 'error', plain: true })
}

async function toggleTrust() {
  try {
    if (trusted.value) {
      await untrustSender(props.senderEmail)
      trusted.value = false
    } else {
      await trustSender(props.senderEmail)
      trusted.value = true
    }
    emit('trust-change', trusted.value)
    ElMessage({ message: t(trusted.value ? 'trust.trustAdded' : 'trust.trustRemoved'), type: 'success', plain: true })
  } catch (e) {
    showErr(e)
  }
}

async function toggleSpam() {
  try {
    if (isSpam.value) {
      await trustNotSpam(props.emailId)
      isSpam.value = false
    } else {
      await trustMarkSpam(props.emailId)
      isSpam.value = true
    }
    emit('spam-change', isSpam.value)
    ElMessage({ message: t(isSpam.value ? 'trust.spamMarked' : 'trust.spamUnmarked'), type: 'success', plain: true })
  } catch (e) {
    showErr(e)
  }
}

function confirmPhishing() {
  ElMessageBox.confirm(t('trust.reportPhishingConfirm'), t('trust.reportPhishing'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(async () => {
    try {
      await trustReportPhishing(props.emailId)
      isSpam.value = true
      emit('reported', true)
      emit('spam-change', true)
      ElMessage({ message: t('trust.reportPhishingDone'), type: 'success', plain: true })
    } catch (e) {
      showErr(e)
    }
  }).catch(() => {})
}

async function doUnsubscribe() {
  unsubLoading.value = true
  try {
    const data = await trustUnsubscribe(props.emailId)
    if (data.action === 'open' && data.url) {
      window.open(data.url, '_blank', 'noopener')
    } else if (data.action === 'mailto' && data.mailto) {
      window.location.href = `mailto:${data.mailto}`
    }
    emit('unsubscribed', data)
    ElMessage({ message: t('trust.unsubscribeDone'), type: 'success', plain: true })
  } catch (e) {
    showErr(e)
  } finally {
    unsubLoading.value = false
  }
}
</script>

<style scoped>
.trust-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.trust-alert {
  max-width: 560px;
}

.trust-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
