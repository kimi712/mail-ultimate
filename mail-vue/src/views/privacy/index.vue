<!-- Phase 8 F：隐私仪表盘 / 透明度中心。
  入口挂载点见汇报：安全中心“我的数据”区旁加入口按钮（security/index.vue
  是 B 的文件，由总协调加一行），或设置页菜单；本视图路由 /privacy（路由
  注册行见汇报，由总协调加进 router/index.js）。
  开关操作复用现有 /my/security（request/security.js 的 setSecurity），
  本页不直接改任何设置；新 IP 提醒确认调 request/privacy.js。 -->
<template>
  <div class="privacy-page">
    <el-scrollbar height="100%">
      <div class="privacy-body">
        <div class="title">{{ $t('privacyDashboard') }}</div>
        <div class="desc">{{ $t('privacyDashboardDesc') }}</div>

        <!-- 数据清单：收集了什么、没收集什么、每项保留多久、能不能关 -->
        <div class="section">
          <div class="section-title">{{ $t('privacyDataInventory') }}</div>
          <el-table :data="dashboard?.dataInventory || []" style="width: 100%">
            <el-table-column :label="$t('privacyItem')" width="220">
              <template #default="{ row }">{{ $t('privacyItem' + capitalize(row.id)) }}</template>
            </el-table-column>
            <el-table-column :label="$t('privacyCollected')" width="120">
              <template #default="{ row }">
                <el-tag v-if="row.collected === true" type="success">{{ $t('privacyYes') }}</el-tag>
                <el-tag v-else-if="row.collected === false" type="info">{{ $t('privacyNo') }}</el-tag>
                <el-tag v-else-if="row.collected === 'encrypted'" type="warning">{{ $t('privacyItemE2eeEncrypted') }}</el-tag>
                <el-tag v-else type="danger">{{ $t('privacyItemE2eePlaintext') }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column :label="$t('privacyRetention')" width="120">
              <template #default="{ row }">
                {{ retentionLabel(row.retentionText) }}
              </template>
            </el-table-column>
            <el-table-column :label="$t('privacyCanDisable')">
              <template #default="{ row }">
                <span v-if="row.canDisable">{{ $t('privacyCanDisableYes') }}</span>
                <span v-else>{{ $t('privacyCanDisableNo') }}：{{ row.whyRequired ? $t('privacyWhy' + capitalize(row.whyRequired)) : '' }}</span>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <!-- Phase 8 斯诺登元素补齐：顶部名言横幅（主推句英文原文一字不改 + 小字翻译 + 署名）。 -->
        <figure class="privacy-quote">
          <blockquote>“{{ PRIVACY_QUOTE_EN }}”</blockquote>
          <figcaption>{{ $t('intro.quote1') }}</figcaption>
          <figcaption class="privacy-quote-by">— Edward Snowden</figcaption>
        </figure>

        <!-- 新设备 / 新 IP 登录提醒：醒目的待确认提醒 -->
        <el-alert
          v-if="pendingAlerts.length"
          :title="$t('newIpAlertTitle')"
          type="warning"
          :description="$t('newIpAlertDesc')"
          show-icon
          :closable="false"
          style="margin-bottom: 16px"
        />
        <div v-if="pendingAlerts.length" class="section">
          <div class="section-title">{{ $t('newIpAlertPending') }}</div>
          <el-table :data="pendingAlerts" style="width: 100%" :empty-text="$t('newIpAlertEmpty')">
            <el-table-column prop="time" :label="$t('loginLogTime')" width="180" />
            <el-table-column prop="ip" :label="$t('loginLogIp')" width="160" />
            <el-table-column prop="device" :label="$t('loginLogDevice')" />
            <el-table-column :label="$t('securityLoginHistoryLocation')" width="110">
              <template #default>{{ $t('securityLoginHistoryNoLocation') }}</template>
            </el-table-column>
            <el-table-column width="180">
              <template #default="{ row }">
                <el-button type="success" size="small" :loading="ackLoading === row.rawIp" @click="onAcknowledge(row)">
                  {{ $t('newIpAlertAcknowledge') }}
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <!-- 可控开关（复用现有 /my/security） -->
        <div v-if="dashboard" class="section">
          <div class="section-title">{{ $t('privacyControls') }}</div>
          <div class="row">
            <span>{{ $t('securityLoginAlert') }}</span>
            <el-switch v-model="controls.loginAlert" :disabled="saving" @change="onControlChange('loginAlert', $event)" />
          </div>
          <div class="row">
            <span>{{ $t('privacyE2ee') }}</span>
            <el-switch v-model="controls.e2eeEnabled" :disabled="saving" @change="onControlChange('e2eeEnabled', $event)" />
          </div>
          <div class="row">
            <span>{{ $t('securityRetention') }}</span>
            <el-select v-model="controls.retentionDays" :disabled="saving" @change="onControlChange('retentionDays', $event)" style="width: 220px">
              <el-option :value="0" :label="$t('securityRetention0')" />
              <el-option :value="30" :label="$t('securityRetention30')" />
              <el-option :value="90" :label="$t('securityRetention90')" />
              <el-option :value="365" :label="$t('securityRetention365')" />
            </el-select>
          </div>
          <div class="desc">
            {{ $t('privacyIpMask') }}：{{ dashboard.controls.logIpMask ? $t('securityOn') : $t('securityOff') }} ·
            {{ $t('privacyAi') }}：{{ dashboard.controls.aiEnabled ? $t('securityOn') : $t('securityOff') }}
          </div>
        </div>

        <!-- 第三方清单 -->
        <div class="section">
          <div class="section-title">{{ $t('privacyThirdParties') }}</div>
          <el-table :data="dashboard?.thirdParties || []" style="width: 100%">
            <el-table-column :label="$t('privacyThirdParty')" width="220">
              <template #default="{ row }">{{ $t('privacyThird' + capitalize(row.id)) }}</template>
            </el-table-column>
            <el-table-column :label="$t('privacyPurpose')">
              <template #default="{ row }">{{ $t('privacyPurpose' + capitalize(row.purpose)) }}</template>
            </el-table-column>
            <el-table-column :label="$t('privacyRequired')" width="100">
              <template #default="{ row }">{{ row.required ? $t('privacyYes') : $t('privacyNo') }}</template>
            </el-table-column>
            <el-table-column :label="$t('privacyConfigured')" width="100">
              <template #default="{ row }">{{ row.configured ? $t('privacyYes') : $t('privacyNo') }}</template>
            </el-table-column>
          </el-table>
        </div>

        <!-- 账号恢复状态 -->
        <div v-if="dashboard" class="section">
          <div class="section-title">{{ $t('privacyAccountRecovery') }}</div>
          <div class="desc">
            {{ $t('recoveryCodesRemaining') }}：{{ dashboard.account.recoveryCodesRemaining }} ·
            {{ $t('recoveryBackupEmail') }}：{{ dashboard.account.backupEmailSet ? dashboard.account.backupEmailMasked : $t('privacyNotSet') }}
          </div>
          <div class="row">
            <el-button @click="recoveryDialogVisible = true">{{ $t('recoveryGenerateCodes') }}</el-button>
            <el-button @click="backupDialogVisible = true">{{ $t('recoveryBackupEmailSet') }}</el-button>
          </div>
        </div>

        <!-- 生成恢复码：需当前密码；明文只显示一次 -->
        <el-dialog v-model="recoveryDialogVisible" :title="$t('recoveryGenerateCodes')" width="520px" :close-on-click-modal="false">
          <div v-if="!generatedCodes.length">
            <div class="desc" style="margin-bottom: 12px">{{ $t('recoveryGenerateHint') }}</div>
            <el-input v-model="recoveryPassword" type="password" :placeholder="$t('password')" autocomplete="off" show-password />
          </div>
          <div v-else>
            <el-alert :title="$t('recoveryShowOnce')" type="warning" :closable="false" style="margin-bottom: 12px" />
            <div v-for="code in generatedCodes" :key="code" class="recovery-code">{{ code }}</div>
          </div>
          <template #footer>
            <el-button @click="closeRecoveryDialog">{{ $t('cancel') }}</el-button>
            <el-button v-if="!generatedCodes.length" type="primary" :loading="recoveryLoading" @click="onGenerateCodes">
              {{ $t('confirm') }}
            </el-button>
            <el-button v-else type="primary" @click="copyCodes">{{ $t('copy') }}</el-button>
          </template>
        </el-dialog>

        <!-- 备用邮箱 -->
        <el-dialog v-model="backupDialogVisible" :title="$t('recoveryBackupEmailSet')" width="480px" :close-on-click-modal="false">
          <el-input v-model="backupEmailInput" :placeholder="$t('recoveryBackupEmailPlaceholder')" autocomplete="off" />
          <div class="desc" style="margin-top: 8px">{{ $t('recoveryBackupEmailHint') }}</div>
          <template #footer>
            <el-button @click="backupDialogVisible = false">{{ $t('cancel') }}</el-button>
            <el-button type="primary" :loading="backupLoading" @click="onSaveBackupEmail">{{ $t('confirm') }}</el-button>
          </template>
        </el-dialog>
      </div>
    </el-scrollbar>
  </div>
</template>
<script setup>
import { ref, reactive, defineOptions, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { getPrivacyDashboard, listNewIpAlerts, acknowledgeNewIp } from '@/request/privacy.js'
import { generateRecoveryCodes, setBackupEmail } from '@/request/recovery.js'
import { setSecurity } from '@/request/security.js'

defineOptions({
  name: 'privacy'
})

// Phase 8 斯诺登元素补齐：顶部名言横幅（主推句英文原文一字不改，见 PHASE7.md §7）。
const PRIVACY_QUOTE_EN = "Arguing that you don't care about the right to privacy because you have nothing to hide is no different than saying you don't care about free speech because you have nothing to say."

const { t } = useI18n()

// 保留期限文案：后端给 'never' / 'forever' / '90d' 这类值，转成“从不收集 / 永久保留 / 90 天”。
function retentionLabel(text) {
  if (text === 'never') return t('privacyNever')
  if (text === 'forever') return t('privacyForever')
  const m = /^(\d+)d$/.exec(String(text || ''))
  if (m) return t('privacyRetentionDays', { days: m[1] })
  return text || ''
}

const dashboard = ref(null)
const pendingAlerts = ref([])
const ackLoading = ref('')
const saving = ref(false)
const controls = reactive({ loginAlert: true, e2eeEnabled: false, retentionDays: 0 })

const recoveryDialogVisible = ref(false)
const recoveryPassword = ref('')
const recoveryLoading = ref(false)
const generatedCodes = ref([])

const backupDialogVisible = ref(false)
const backupEmailInput = ref('')
const backupLoading = ref(false)

function capitalize(s) {
  return String(s || '').replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase())
}

async function loadAll() {
  const [dashRes, alertRes] = await Promise.all([getPrivacyDashboard(), listNewIpAlerts()])
  dashboard.value = dashRes.data?.data || dashRes.data || null
  pendingAlerts.value = alertRes.data?.data?.list || alertRes.data?.list || []
  if (dashboard.value?.controls) {
    Object.assign(controls, dashboard.value.controls)
  }
}

async function onAcknowledge(row) {
  ackLoading.value = row.rawIp
  try {
    await acknowledgeNewIp(row.rawIp)
    ElMessage({ message: 'OK', type: 'success', plain: true })
    await loadAll()
  } finally {
    ackLoading.value = ''
  }
}

async function onControlChange(key, value) {
  saving.value = true
  try {
    await setSecurity({ [key]: key === 'retentionDays' ? value : (value ? 1 : 0) })
  } finally {
    saving.value = false
  }
}

async function onGenerateCodes() {
  recoveryLoading.value = true
  try {
    const res = await generateRecoveryCodes(recoveryPassword.value)
    generatedCodes.value = res.data?.data?.codes || res.data?.codes || []
  } finally {
    recoveryLoading.value = false
  }
}

function closeRecoveryDialog() {
  recoveryDialogVisible.value = false
  recoveryPassword.value = ''
  generatedCodes.value = []
  loadAll()
}

async function copyCodes() {
  try {
    await navigator.clipboard.writeText(generatedCodes.value.join('\n'))
    ElMessage({ message: 'OK', type: 'success', plain: true })
  } catch (e) {
    // 剪贴板不可用时用户可手动复制
  }
}

async function onSaveBackupEmail() {
  backupLoading.value = true
  try {
    await setBackupEmail(backupEmailInput.value)
    ElMessage({ message: 'OK', type: 'success', plain: true })
    backupDialogVisible.value = false
    loadAll()
  } finally {
    backupLoading.value = false
  }
}

onMounted(loadAll)
</script>
<style scoped>
.privacy-page {
  height: 100%;
}
.privacy-body {
  padding: 20px;
  max-width: 960px;
}
.title {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 8px;
}
.desc {
  font-size: 13px;
  color: #909399;
  margin-bottom: 16px;
}
/* Phase 8 斯诺登元素补齐：顶部名言横幅——深色渐变底 + 左侧蓝紫 accent 边 */
.privacy-quote {
  margin: 0 0 20px;
  padding: 16px 20px;
  border-radius: 12px;
  border-left: 3px solid #7c3aed;
  background: linear-gradient(135deg, rgba(37, 99, 235, .12), rgba(124, 58, 237, .12));
}
.privacy-quote blockquote {
  margin: 0 0 8px;
  font-size: 14px;
  line-height: 1.7;
  font-style: italic;
  color: var(--el-text-color-primary);
}
.privacy-quote figcaption {
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
.privacy-quote .privacy-quote-by {
  margin-top: 6px;
  font-size: 11px;
  letter-spacing: .08em;
  color: var(--el-text-color-secondary);
}
.section {
  margin-bottom: 24px;
}
.section-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.recovery-code {
  font-family: monospace;
  font-size: 15px;
  letter-spacing: 1px;
  padding: 6px 0;
  border-bottom: 1px dashed #e4e7ed;
}
</style>
