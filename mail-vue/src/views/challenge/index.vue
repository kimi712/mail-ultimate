<!-- $1000 安全悬赏挑战：公开状态页（无需登录，不走 layout）。
  存在证明（主题 / 时间 / 密文 SHA-256 指纹，不含内容）+ 截止倒计时
  + 尝试统计 + 规则摘要 + 尝试计数表单（计数 + 回执，不是裁决通道：
  正式裁决提交渠道以悬赏帖为准）。
  文案中英双语用本页内置字典（不碰共享 i18n 文件；locale 以 zh 开头
  走中文，其余走英文）。样式沿用 recovery 公开页的卡片风格。 -->
<template>
  <div class="challenge-page">
    <div class="challenge-card">
      <div class="title">{{ t('title') }}</div>
      <div class="desc">{{ t('subtitle') }}</div>

      <!-- 奖金 + 截止倒计时 -->
      <div class="prize-row">
        <div class="prize">
          <div class="prize-amount">$1,000</div>
          <div class="prize-label">{{ t('prize') }}</div>
        </div>
        <div class="countdown">
          <div class="countdown-value">{{ countdown }}</div>
          <div class="countdown-label">{{ t('countdownLabel') }}</div>
        </div>
      </div>
      <div class="deadline-line">{{ t('deadline') }}：2026-11-18 23:59 (UTC+8)</div>

      <!-- 暂停横幅（uwu 第 5 步）：修复期间挑战暂停，只显示横幅、不接受提交 -->
      <div v-if="status.paused" class="warn-box">{{ t('paused') }}</div>

      <!-- 存在证明 -->
      <el-divider>{{ t('proofTitle') }}</el-divider>
      <div v-if="loading" class="desc">{{ t('loading') }}</div>
      <div v-else-if="loadError" class="warn-box">{{ t('loadError') }}</div>
      <div v-else-if="!status.exists" class="warn-box">{{ t('notPublished') }}</div>
      <div v-else class="proof-box">
        <div class="proof-row">
          <span class="proof-key">{{ t('proofSubject') }}</span>
          <span class="proof-value">{{ status.subject }}</span>
        </div>
        <div class="proof-row">
          <span class="proof-key">{{ t('proofSentAt') }}</span>
          <span class="proof-value">{{ status.sentAt }}</span>
        </div>
        <div class="proof-row">
          <span class="proof-key">{{ t('proofFingerprint') }}</span>
          <span class="proof-value fingerprint">{{ status.ciphertextSha256 }}</span>
        </div>
        <div class="proof-note">{{ t('proofNote') }}</div>
      </div>

      <!-- 尝试统计 -->
      <el-divider>{{ t('statsTitle') }}</el-divider>
      <div class="stats-row">
        <div class="stat">
          <div class="stat-value">{{ status.attempts ? status.attempts.count : 0 }}</div>
          <div class="stat-label">{{ t('statsCount') }}</div>
        </div>
        <div class="stat">
          <div class="stat-value small">{{ status.attempts && status.attempts.lastSubmittedAt ? status.attempts.lastSubmittedAt : '—' }}</div>
          <div class="stat-label">{{ t('statsLast') }}</div>
        </div>
      </div>

      <!-- 规则摘要 -->
      <el-divider>{{ t('rulesTitle') }}</el-divider>
      <ul class="rules">
        <li>{{ t('rule1') }}</li>
        <li>{{ t('rule2') }}</li>
        <li>{{ t('rule3') }}</li>
        <li>{{ t('rule4') }}</li>
        <li>{{ t('rule5') }}</li>
      </ul>

      <!-- 尝试计数表单：只计数 + 回执，不是裁决通道 -->
      <el-divider>{{ t('formTitle') }}</el-divider>
      <div v-if="status.paused" class="warn-box">{{ t('paused') }}</div>
      <div v-else class="warn-box">{{ t('formDisclaimer') }}</div>
      <el-form label-position="top" @submit.prevent>
        <el-form-item :label="t('formPhrase')">
          <el-input v-model="form.phrase" :placeholder="t('formPhrasePh')" autocomplete="off" />
        </el-form-item>
        <el-form-item :label="t('formMethod')">
          <el-input v-model="form.method" type="textarea" :rows="3" :placeholder="t('formMethodPh')" autocomplete="off" />
        </el-form-item>
        <el-button type="primary" :loading="submitting" :disabled="!canSubmit" style="width: 100%" @click="onSubmit">
          {{ t('formSubmit') }}
        </el-button>
      </el-form>
      <div v-if="receipt" class="receipt-box">
        {{ t('receipt') }}：<span class="fingerprint">{{ receipt }}</span>
      </div>

      <div class="row" style="margin-top: 16px">
        <el-button link @click="goLogin">{{ t('backToLogin') }}</el-button>
      </div>
    </div>
  </div>
</template>
<script setup>
import { ref, reactive, computed, defineOptions, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { getChallengeStatus, submitChallengeAttempt } from '@/request/challenge.js'

defineOptions({
  name: 'challenge'
})

// 截止：2026-11-18 23:59（北京时间），固定不动。
const DEADLINE_MS = new Date('2026-11-18T23:59:00+08:00').getTime()

const TEXTS = {
  zh: {
    title: '$1000 安全悬赏挑战',
    subtitle: '端到端加密邮件里的暗号，谁读到内容奖 $1000。',
    prize: '悬赏奖金',
    countdownLabel: '距截止还剩',
    countdownOver: '已截止',
    deadline: '截止时间',
    proofTitle: '挑战信存在证明',
    loading: '加载中…',
    loadError: '状态加载失败，请稍后刷新重试。',
    notPublished: '挑战信尚未发布。暗号与加密密码由站长本人设定后，存在证明会在这里出现。',
    proofSubject: '主题',
    proofSentAt: '发布时间',
    proofFingerprint: '密文指纹',
    proofNote: '指纹是密文信封的 SHA-256，只证明这封加密邮件存在，不泄露任何内容。',
    statsTitle: '尝试统计',
    statsCount: '已记录尝试',
    statsLast: '最近一次提交',
    rulesTitle: '规则摘要',
    rule1: '奖金 $1000，截止 2026-11-18 23:59（北京时间）。',
    rule2: '光报出暗号不算赢，必须讲清完整的破解路径。',
    rule3: '挑战信是真正的端到端加密邮件（浏览器 AES-GCM-256 + 抗量子 ML-KEM-768），正文与附件在浏览器内加密后再上传，服务器只存密文；标题、收发件人等元数据仍为明文。',
    rule4: '本页的提交只是计数 + 回执，正式裁决提交渠道以悬赏帖为准。',
    rule5: '暗号原文与破解方法原文不会被保存，只保存 SHA-256 哈希。',
    paused: '挑战已暂停：正在修复白帽安全研究员指出的问题，修复上线并复核通过后恢复。',
    formTitle: '记录一次尝试',
    formDisclaimer: '这里不是交答案的地方：提交只做计数并发回执，裁决与领奖请按悬赏帖里的渠道。不要在这里贴出你认为的完整答案以外的敏感信息。',
    formPhrase: '你读到的暗号',
    formPhrasePh: '填入暗号（只存哈希，不存原文）',
    formMethod: '破解路径（简述）',
    formMethodPh: '怎么读到的？用了什么方法（只存哈希，不存原文）',
    formSubmit: '提交尝试',
    receipt: '回执编号',
    submitOk: '已记录，感谢参与。',
    submitFail: '提交失败，请稍后重试。',
    backToLogin: '返回登录'
  },
  en: {
    title: '$1,000 Security Bounty Challenge',
    subtitle: 'A passphrase hides inside an end-to-end encrypted email. Read it, win $1,000.',
    prize: 'Bounty',
    countdownLabel: 'Time left',
    countdownOver: 'Challenge ended',
    deadline: 'Deadline',
    proofTitle: 'Proof the challenge email exists',
    loading: 'Loading…',
    loadError: 'Failed to load the status. Please refresh and try again.',
    notPublished: 'The challenge email has not been published yet. Once the site owner sets the passphrase and encryption password, the proof of existence will appear here.',
    proofSubject: 'Subject',
    proofSentAt: 'Sent at',
    proofFingerprint: 'Ciphertext fingerprint',
    proofNote: 'The fingerprint is the SHA-256 of the ciphertext envelope. It only proves this encrypted email exists and reveals nothing about its content.',
    statsTitle: 'Attempts',
    statsCount: 'Attempts recorded',
    statsLast: 'Last submission',
    rulesTitle: 'Rules in brief',
    rule1: 'Prize: $1,000. Deadline: 2026-11-18 23:59 (UTC+8).',
    rule2: 'Reporting the passphrase alone does not win — you must explain the full attack path.',
    rule3: 'The challenge email is genuinely end-to-end encrypted (browser AES-GCM-256 + post-quantum ML-KEM-768). Its body and attachments are encrypted in the browser before upload; the server only stores ciphertext. Subject, sender, and recipient metadata remain plaintext.',
    rule4: 'Submitting here only counts the attempt and returns a receipt. The official submission channel for adjudication is the one in the bounty post.',
    rule5: 'Your passphrase and method are never stored as text — only their SHA-256 hashes.',
    paused: 'Challenge paused: we are fixing issues reported by a white-hat security researcher. It will resume after the fixes are live and verified.',
    formTitle: 'Record an attempt',
    formDisclaimer: 'This is not where you submit your answer for adjudication: submissions here are only counted and receipted. For the verdict and the prize, use the channel in the bounty post.',
    formPhrase: 'The passphrase you read',
    formPhrasePh: 'Enter the passphrase (only its hash is stored)',
    formMethod: 'Attack path (brief)',
    formMethodPh: 'How did you read it? What method did you use (only its hash is stored)',
    formSubmit: 'Submit attempt',
    receipt: 'Receipt ID',
    submitOk: 'Recorded. Thank you for participating.',
    submitFail: 'Submission failed. Please try again later.',
    backToLogin: 'Back to login'
  }
}

const { locale } = useI18n()
const lang = computed(() => String(locale.value || '').toLowerCase().startsWith('zh') ? 'zh' : 'en')
const t = (key) => TEXTS[lang.value][key] || TEXTS.en[key] || key

const router = useRouter()
const loading = ref(true)
const loadError = ref(false)
const submitting = ref(false)
const status = ref({ exists: false, paused: false, subject: null, sentAt: null, ciphertextSha256: null, attempts: { count: 0, lastSubmittedAt: null } })
const form = reactive({ phrase: '', method: '' })
const receipt = ref('')
const now = ref(Date.now())

const canSubmit = computed(() => !status.value.paused && !!form.phrase.trim() && !!form.method.trim())

const countdown = computed(() => {
  const diff = DEADLINE_MS - now.value
  if (diff <= 0) return t('countdownOver')
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor(diff % 86400000 / 3600000)
  const minutes = Math.floor(diff % 3600000 / 60000)
  const seconds = Math.floor(diff % 60000 / 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
})

let timer = null

async function loadStatus() {
  loading.value = true
  loadError.value = false
  try {
    const data = await getChallengeStatus()
    if (data) status.value = data
  } catch (e) {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

async function onSubmit() {
  if (status.value.paused) return
  submitting.value = true
  try {
    const data = await submitChallengeAttempt(form.phrase.trim(), form.method.trim())
    receipt.value = data.receiptId || ''
    ElMessage({ message: t('submitOk'), type: 'success', plain: true })
    form.phrase = ''
    form.method = ''
    await loadStatus()
  } catch (e) {
    ElMessage({ message: (e && e.message) || t('submitFail'), type: 'error', plain: true })
  } finally {
    submitting.value = false
  }
}

function goLogin() {
  router.push('/login')
}

onMounted(() => {
  loadStatus()
  timer = setInterval(() => { now.value = Date.now() }, 1000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>
<style scoped>
.challenge-page {
  min-height: 100vh;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 24px;
}
.challenge-card {
  width: 100%;
  max-width: 560px;
  padding: 8px 0 32px;
}
.title {
  font-size: 22px;
  font-weight: 600;
  margin-bottom: 8px;
}
.desc {
  font-size: 13px;
  color: #909399;
  margin-bottom: 16px;
}
/* 奖金 + 倒计时：左右两栏 */
.prize-row {
  display: flex;
  gap: 12px;
  margin-bottom: 10px;
}
.prize,
.countdown {
  flex: 1;
  padding: 14px;
  border-radius: 10px;
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  background: var(--el-fill-color-lighter, #f4f4f5);
  text-align: center;
}
.prize-amount {
  font-size: 28px;
  font-weight: 700;
  color: #e6a23c;
}
.countdown-value {
  font-size: 20px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.prize-label,
.countdown-label {
  margin-top: 4px;
  font-size: 12px;
  color: #909399;
}
.deadline-line {
  font-size: 13px;
  color: #909399;
  text-align: center;
  margin-bottom: 4px;
}
/* 存在证明：浅底卡片 + 单一指纹字体 */
.proof-box {
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  background: var(--el-fill-color-lighter, #f4f4f5);
  font-size: 13px;
  line-height: 1.7;
}
.proof-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.proof-key {
  flex: none;
  width: 80px;
  color: #909399;
}
.proof-value {
  word-break: break-all;
}
.fingerprint {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}
.proof-note {
  margin-top: 8px;
  font-size: 12px;
  color: #909399;
}
/* 警告条：挑战信未发布 / 表单不是裁决通道 */
.warn-box {
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid #f5dab1;
  background: #fdf6ec;
  font-size: 13px;
  line-height: 1.7;
  color: #a16207;
  margin-bottom: 8px;
}
.stats-row {
  display: flex;
  gap: 12px;
}
.stat {
  flex: 1;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  background: var(--el-fill-color-lighter, #f4f4f5);
  text-align: center;
}
.stat-value {
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.stat-value.small {
  font-size: 14px;
  font-weight: 600;
}
.stat-label {
  margin-top: 4px;
  font-size: 12px;
  color: #909399;
}
.rules {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.9;
}
.receipt-box {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid #d1e7dd;
  background: #f0f9f4;
  font-size: 13px;
  color: #1e7d4d;
}
.row {
  display: flex;
  justify-content: center;
}
</style>
