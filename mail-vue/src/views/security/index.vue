<template>
  <div class="security-page">
    <el-scrollbar height="100%">
      <div class="box">
        <div class="title">{{ $t('securityCenter') }}</div>

        <!-- 安全评分：只展示，不锁功能 -->
        <div class="section">
          <div class="section-title">{{ $t('securityScore') }}</div>
          <div class="score-row">
            <div class="score-num">{{ score }}<span class="score-total">/100</span></div>
            <el-progress :percentage="score" :show-text="false" class="score-bar" />
          </div>
          <div class="score-tip">{{ $t('securityScoreTip') }}</div>
          <div class="score-list">
            <div class="score-item">
              <span>{{ $t('securityScoreTotp') }}</span>
              <el-tag :type="totpEnabled ? 'success' : 'info'">{{ totpEnabled ? $t('securityOn') + ' +30' : $t('securityOff') + ' +0' }}</el-tag>
            </div>
            <div class="score-item">
              <span>{{ $t('securityScorePasskey') }}</span>
              <el-tag :type="passkeys.length ? 'success' : 'info'">{{ passkeys.length ? $t('securityOn') + ' +30' : $t('securityOff') + ' +0' }}</el-tag>
            </div>
            <div class="score-item">
              <span>{{ $t('securityScoreLoginAlert') }}</span>
              <el-tag :type="security.loginAlert ? 'success' : 'info'">{{ security.loginAlert ? $t('securityOn') + ' +20' : $t('securityOff') + ' +0' }}</el-tag>
            </div>
            <div class="score-item">
              <span>{{ $t('securityScoreNoNewIp') }}</span>
              <el-tag :type="noNewIp30d ? 'success' : 'info'">{{ noNewIp30d ? $t('securityOn') + ' +20' : $t('securityOff') + ' +0' }}</el-tag>
            </div>
          </div>
        </div>

        <!-- 设备管理（当前登录的全部设备，发现陌生设备请立即踢出并改密码） -->
        <div class="section">
          <div class="section-title">{{ $t('sessionTitle') }}</div>
          <div class="desc">{{ $t('securityDevicesHint') }}</div>
          <div class="row">
            <el-button :loading="sessionLoading" @click="revokeOthers">{{ $t('sessionRevokeOthers') }}</el-button>
          </div>
          <el-table :data="sessionList" v-loading="sessionLoading" style="width: 100%" :empty-text="$t('sessionEmpty')">
            <el-table-column prop="ua" :label="$t('loginLogDevice')">
              <template #default="{row}">{{ row.ua || $t('sessionUnknown') }}</template>
            </el-table-column>
            <el-table-column prop="ip" :label="$t('loginLogIp')" width="160" />
            <el-table-column prop="createdAt" :label="$t('loginLogTime')" width="180" />
            <el-table-column width="150">
              <template #default="{row}">
                <el-tag v-if="row.current" type="success">{{ $t('sessionCurrent') }}</el-tag>
                <el-button v-else type="danger" link @click="revokeOne(row)">{{ $t('sessionRevoke') }}</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <!-- 登录历史（最近 20 条，走 Phase 7 新接口 GET /security/login-history） -->
        <div class="section">
          <div class="section-title">{{ $t('loginLogTitle') }}</div>
          <div class="desc">{{ $t('securityLoginHistoryNoGeo') }}</div>
          <el-table :data="loginLogList" v-loading="loginLogLoading" style="width: 100%" :empty-text="$t('loginLogEmpty')">
            <el-table-column prop="time" :label="$t('loginLogTime')" width="180" />
            <el-table-column prop="ip" :label="$t('loginLogIp')" width="160" />
            <el-table-column :label="$t('loginLogDevice')">
              <template #default="{row}">{{ [row.device, row.browser].filter(Boolean).join(' · ') || $t('sessionUnknown') }}</template>
            </el-table-column>
            <el-table-column :label="$t('securityLoginHistoryLocation')" width="110">
              <template #default="{row}">{{ row.location || $t('securityLoginHistoryNoLocation') }}</template>
            </el-table-column>
            <el-table-column :label="$t('loginLogNewIp')" width="110">
              <template #default="{row}">
                <el-tag v-if="row.isNewIp === 1" type="warning">{{ $t('loginLogIsNew') }}</el-tag>
                <el-tag v-else type="info">{{ $t('loginLogNotNew') }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <!-- TOTP 二次验证 -->
        <div class="section">
          <div class="section-title">{{ $t('totpTitle') }}</div>
          <div class="desc">{{ $t('totpDesc') }}</div>
          <div v-if="totpEnabled" class="row">
            <el-tag type="success">{{ $t('securityOn') }}</el-tag>
            <el-button @click="showDisableTotp = !showDisableTotp">{{ $t('totpDisable') }}</el-button>
          </div>
          <div v-else class="row">
            <el-tag type="info">{{ $t('securityOff') }}</el-tag>
            <el-button type="primary" :loading="totpLoading" @click="startTotpSetup">{{ $t('totpSetup') }}</el-button>
          </div>
          <div v-if="setupData" class="totp-setup">
            <div class="desc">{{ $t('totpSetupTip') }}</div>
            <div class="kv-row">
              <span class="kv-label">{{ $t('totpSecret') }}</span>
              <el-input :model-value="setupData.secret" readonly class="secret-input" />
              <el-button @click="copyText(setupData.secret)">{{ $t('totpCopy') }}</el-button>
            </div>
            <div class="kv-row">
              <span class="kv-label">{{ $t('totpOtpauthUrl') }}</span>
              <el-input :model-value="setupData.otpauthUrl" readonly class="secret-input" />
              <el-button @click="copyText(setupData.otpauthUrl)">{{ $t('totpCopy') }}</el-button>
            </div>
            <div class="kv-row">
              <span class="kv-label">{{ $t('totpCode') }}</span>
              <el-input v-model="setupCode" :placeholder="$t('totpCodePlaceholder')" maxlength="6" class="code-input" @keyup.enter="confirmTotpEnable" />
              <el-button type="primary" :loading="totpLoading" @click="confirmTotpEnable">{{ $t('totpEnable') }}</el-button>
            </div>
          </div>
          <div v-if="showDisableTotp && totpEnabled" class="totp-setup">
            <div class="desc">{{ $t('totpNeedPassword') }}</div>
            <div class="kv-row">
              <span class="kv-label">{{ $t('totpPassword') }}</span>
              <el-input v-model="disablePassword" type="password" :placeholder="$t('totpPasswordPlaceholder')" autocomplete="off" class="code-input" />
            </div>
            <div class="kv-row">
              <span class="kv-label">{{ $t('totpCode') }}</span>
              <el-input v-model="disableCode" :placeholder="$t('totpCodePlaceholder')" maxlength="6" class="code-input" @keyup.enter="confirmTotpDisable" />
              <el-button type="danger" :loading="totpLoading" @click="confirmTotpDisable">{{ $t('totpDisable') }}</el-button>
            </div>
          </div>
        </div>

        <!-- Passkey 管理 -->
        <div class="section">
          <div class="section-title">{{ $t('passkeyTitle') }}</div>
          <div class="desc">{{ $t('passkeyDesc') }}</div>
          <div class="row">
            <el-button type="primary" :loading="passkeyLoading" @click="registerPasskey">{{ $t('passkeyRegister') }}</el-button>
          </div>
          <el-table :data="passkeys" v-loading="passkeyLoading" style="width: 100%" :empty-text="$t('passkeyEmpty')">
            <el-table-column prop="credentialId" label="ID" />
            <el-table-column prop="name" :label="$t('passkeyTitle')" />
            <el-table-column prop="createdTime" :label="$t('passkeyCreated')" width="180" />
            <el-table-column width="110">
              <template #default="{row}">
                <el-button type="danger" link @click="deletePasskey(row)">{{ $t('delete') }}</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <!-- 提醒开关与保留期限 -->
        <div class="section">
          <div class="section-title">{{ $t('securityLoginAlert') }}</div>
          <div class="desc">{{ $t('securityLoginAlertDesc') }}</div>
          <div class="row">
            <el-switch v-model="loginAlertOn" :loading="saving" @change="onLoginAlertChange" />
            <span>{{ loginAlertOn ? $t('securityOn') : $t('securityOff') }}</span>
          </div>
        </div>
        <div class="section">
          <div class="section-title">{{ $t('securityRetention') }}</div>
          <div class="desc">{{ $t('securityRetentionDesc') }}</div>
          <el-select v-model="security.retentionDays" :disabled="saving" @change="onRetentionChange" style="width: 220px">
            <el-option :value="0" :label="$t('securityRetention0')" />
            <el-option :value="30" :label="$t('securityRetention30')" />
            <el-option :value="90" :label="$t('securityRetention90')" />
            <el-option :value="365" :label="$t('securityRetention365')" />
          </el-select>
        </div>

        <!-- 端到端加密（可选，诚实边界见 PHASE2-4.md §3.5） -->
        <div class="section">
          <div class="section-title">{{ $t('e2eeTitle') }}</div>
          <div class="desc">{{ $t('e2eeDesc') }}</div>
          <el-alert :closable="false" type="warning" show-icon class="e2ee-warn">
            <template #title>
              <div>{{ $t('e2eeWarnForgot') }}</div>
              <div>{{ $t('e2eeWarnSearch') }}</div>
              <div>{{ $t('e2eeWarnExternal') }}</div>
              <div>{{ $t('e2eeWarnAttachment') }}</div>
            </template>
          </el-alert>
          <div class="row">
            <el-tag :type="security.e2eeEnabled ? 'success' : 'info'">{{ security.e2eeEnabled ? $t('securityOn') : $t('securityOff') }}</el-tag>
            <el-tag :type="e2eeUnlocked ? 'success' : 'info'">{{ e2eeUnlocked ? $t('e2eeUnlocked') : $t('e2eeLocked') }}</el-tag>
          </div>
          <div class="kv-row">
            <span class="kv-label">{{ $t('e2eePassword') }}</span>
            <el-input v-model="e2eePassword" type="password" :placeholder="$t('e2eePasswordPlaceholder')" autocomplete="off" class="code-input" @keyup.enter="e2eeEnabled ? unlockE2ee() : enableE2ee()" />
            <el-button v-if="!security.e2eeEnabled" type="primary" :loading="e2eeLoading" @click="enableE2ee">{{ $t('e2eeEnableUnlock') }}</el-button>
            <el-button v-else-if="!e2eeUnlocked" type="primary" :loading="e2eeLoading" @click="unlockE2ee">{{ $t('e2eeUnlock') }}</el-button>
            <el-button v-else @click="lockE2ee">{{ $t('e2eeLock') }}</el-button>
          </div>
          <div class="desc">{{ $t('e2eePasswordHint') }}</div>
          <div v-if="security.e2eeEnabled" class="row">
            <el-button :loading="e2eeLoading" @click="disableE2ee">{{ $t('e2eeDisable') }}</el-button>
          </div>
        </div>

        <!-- 闲置自动锁定 -->
        <div class="section">
          <div class="section-title">{{ $t('securityAutoLock') }}</div>
          <div class="desc">{{ $t('securityAutoLockDesc') }}</div>
          <el-select v-model="security.autoLockMinutes" :disabled="saving" @change="onAutoLockChange" style="width: 220px">
            <el-option :value="0" :label="$t('securityAutoLock0')" />
            <el-option :value="5" :label="$t('securityAutoLock5')" />
            <el-option :value="15" :label="$t('securityAutoLock15')" />
            <el-option :value="30" :label="$t('securityAutoLock30')" />
          </el-select>
        </div>

        <!-- 我的数据：导出与删除 -->
        <div class="section">
          <div class="section-title">{{ $t('securityMyData') }}</div>
          <div class="desc">{{ $t('securityExportDesc') }}</div>
          <div class="row">
            <el-button :loading="exportLoading" @click="exportMyData">{{ $t('securityExport') }}</el-button>
          </div>
          <div class="desc">{{ $t('securityDeleteAccountDesc') }}</div>
          <div class="row">
            <el-button type="danger" :loading="deleteLoading" @click="deleteMyAccount">{{ $t('securityDeleteAccount') }}</el-button>
          </div>
          <div class="desc">{{ $t('securityHardDeleteAccountDesc') }}</div>
          <div class="row">
            <el-button type="danger" plain :loading="hardDeleteLoading" @click="hardDeleteDialogVisible = true">{{ $t('securityHardDeleteAccount') }}</el-button>
          </div>
        </div>

        <!-- 彻底删除确认框：密码 + 输入 DELETE，双重确认 -->
        <el-dialog v-model="hardDeleteDialogVisible" :title="$t('securityHardDeleteTitle')" width="480px" :close-on-click-modal="false">
          <div class="desc" style="margin-bottom: 12px">{{ $t('securityHardDeleteWarning') }}</div>
          <el-input v-model="hardDeletePassword" type="password" :placeholder="$t('securityHardDeletePassword')" autocomplete="off" show-password />
          <div class="desc" style="margin: 8px 0 12px">{{ $t('securityHardDeletePasswordHint') }}</div>
          <el-input v-model="hardDeleteConfirmText" :placeholder="$t('securityHardDeleteConfirmHint')" autocomplete="off" />
          <template #footer>
            <el-button @click="hardDeleteDialogVisible = false">{{ $t('cancel') }}</el-button>
            <el-button type="danger" :disabled="hardDeleteConfirmText !== 'DELETE'" :loading="hardDeleteLoading" @click="confirmHardDelete">{{ $t('securityHardDeleteButton') }}</el-button>
          </template>
        </el-dialog>

      </div>
    </el-scrollbar>
  </div>
</template>
<script setup>
import {ref, reactive, computed, defineOptions, onMounted} from 'vue'
import {useI18n} from 'vue-i18n'
import {useRouter} from 'vue-router'
import {userDelete, hardDeleteMyAccount} from '@/request/my.js'
import {
  getSecurity, setSecurity,
  totpSetup, totpEnable, totpDisable,
  passkeyRegisterOptions, passkeyRegister, passkeyList, passkeyDelete,
  sessions, revokeSession, revokeOtherSessions,
  loginHistory, exportData
} from '@/request/security.js'
import {
  generateSalt, unlockWithPassword, hasMemoryKey, clearMemoryKey
} from '@/utils/e2ee.js'
import {optionsToCreateArgs, credentialToJson} from '@/utils/webauthn.js'

defineOptions({
  name: 'security'
})

const {t} = useI18n()
const router = useRouter()

const security = reactive({
  loginAlert: 1,
  e2eeEnabled: 0,
  retentionDays: 0,
  e2eeSalt: '',
  autoLockMinutes: 0
})
const loginAlertOn = ref(true)
const saving = ref(false)

// 契约 §1.3 的 GET /my/security 未列出 totpEnabled 字段；若 B 路返回则采用，
// 否则按未开启计分（见汇报“待对齐项”）。本页内成功启用/关闭后立即同步本地状态。
const totpEnabled = ref(false)
const totpLoading = ref(false)
const setupData = ref(null)
const setupCode = ref('')
const showDisableTotp = ref(false)
const disablePassword = ref('')
const disableCode = ref('')

const passkeys = ref([])
const passkeyLoading = ref(false)

const loginLogList = ref([])
const loginLogLoading = ref(false)
const loginLogLoaded = ref(false)

const sessionList = ref([])
const sessionLoading = ref(false)

const e2eePassword = ref('')
const e2eeUnlocked = ref(false)
const e2eeLoading = ref(false)
const exportLoading = ref(false)
const deleteLoading = ref(false)
const hardDeleteDialogVisible = ref(false)
const hardDeletePassword = ref('')
const hardDeleteConfirmText = ref('')
const hardDeleteLoading = ref(false)

// 安全评分：TOTP +30、Passkey +30、登录提醒 +20、30 天内无异地登录 +20，满分 100。
const noNewIp30d = computed(() => {
  if (!loginLogLoaded.value) {
    return false
  }
  const now = Date.now()
  return !loginLogList.value.some((row) => {
    if (row.isNewIp !== 1 || !row.time) {
      return false
    }
    const ts = Date.parse(String(row.time).replace(' ', 'T') + 'Z')
    return !isNaN(ts) && (now - ts) <= 30 * 24 * 3600 * 1000
  })
})
const score = computed(() => {
  let s = 0
  if (totpEnabled.value) {
    s += 30
  }
  if (passkeys.value.length) {
    s += 30
  }
  if (security.loginAlert) {
    s += 20
  }
  if (noNewIp30d.value) {
    s += 20
  }
  return s
})

function toast(message, type) {
  ElMessage({message, type: type || 'error', plain: true})
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast(t('totpCopied'), 'success')
  } catch (e) {
    console.error(e)
    toast(t('copyFailMsg'))
  }
}

function loadSecurity() {
  return getSecurity().then((data) => {
    if (!data) {
      return
    }
    security.loginAlert = data.loginAlert ? 1 : 0
    loginAlertOn.value = !!data.loginAlert
    security.e2eeEnabled = data.e2eeEnabled ? 1 : 0
    security.retentionDays = [0, 30, 90, 365].includes(data.retentionDays) ? data.retentionDays : 0
    security.autoLockMinutes = [0, 5, 15, 30].includes(data.autoLockMinutes) ? data.autoLockMinutes : 0
    security.e2eeSalt = data.e2eeSalt || ''
    if (data.totpEnabled === true) {
      totpEnabled.value = true
    }
    e2eeUnlocked.value = hasMemoryKey() && !!security.e2eeEnabled
  }).catch((e) => {
    console.error(e)
    toast(t('reqFailErrorMsg'))
  })
}

function loadPasskeys() {
  passkeyLoading.value = true
  return passkeyList().then((data) => {
    passkeys.value = Array.isArray(data) ? data : (data?.list || [])
    passkeyLoading.value = false
  }).catch(() => {
    passkeyLoading.value = false
  })
}

function loadLoginLog() {
  loginLogLoading.value = true
  return loginHistory({num: 1, size: 20}).then((data) => {
    loginLogList.value = data.list || []
    loginLogLoaded.value = true
    loginLogLoading.value = false
  }).catch(() => {
    loginLogLoading.value = false
  })
}

function loadSessions() {
  sessionLoading.value = true
  return sessions().then((data) => {
    sessionList.value = Array.isArray(data) ? data : (data?.list || [])
    sessionLoading.value = false
  }).catch(() => {
    sessionLoading.value = false
  })
}

onMounted(() => {
  loadSecurity()
  loadPasskeys()
  loadLoginLog()
  loadSessions()
})

// ---- TOTP ----
function startTotpSetup() {
  totpLoading.value = true
  totpSetup().then((data) => {
    setupData.value = data
    setupCode.value = ''
    totpLoading.value = false
  }).catch((e) => {
    totpLoading.value = false
    toast(e?.message || t('reqFailErrorMsg'))
  })
}

function confirmTotpEnable() {
  if (!/^\d{6}$/.test(setupCode.value)) {
    toast(t('totpNeedCode'))
    return
  }
  totpLoading.value = true
  totpEnable(setupCode.value).then(() => {
    totpEnabled.value = true
    setupData.value = null
    setupCode.value = ''
    totpLoading.value = false
    toast(t('totpEnableSuccess'), 'success')
  }).catch((e) => {
    totpLoading.value = false
    toast(e?.message || t('reqFailErrorMsg'))
  })
}

function confirmTotpDisable() {
  if (!disablePassword.value || !/^\d{6}$/.test(disableCode.value)) {
    toast(t('totpNeedPassword'))
    return
  }
  totpLoading.value = true
  totpDisable(disablePassword.value, disableCode.value).then(() => {
    totpEnabled.value = false
    showDisableTotp.value = false
    disablePassword.value = ''
    disableCode.value = ''
    totpLoading.value = false
    toast(t('totpDisableSuccess'), 'success')
  }).catch((e) => {
    totpLoading.value = false
    toast(e?.message || t('reqFailErrorMsg'))
  })
}

// ---- Passkey ----
async function registerPasskey() {
  if (!window.PublicKeyCredential || !navigator.credentials || !navigator.credentials.create) {
    toast(t('passkeyUnsupported'))
    return
  }
  passkeyLoading.value = true
  try {
    const options = await passkeyRegisterOptions()
    const credential = await navigator.credentials.create(optionsToCreateArgs(options))
    await passkeyRegister(credentialToJson(credential))
    toast(t('passkeyRegisterSuccess'), 'success')
    await loadPasskeys()
  } catch (e) {
    console.error(e)
    if (e && e.name !== 'NotAllowedError') {
      toast(e?.message || t('reqFailErrorMsg'))
    }
  } finally {
    passkeyLoading.value = false
  }
}

function deletePasskey(row) {
  ElMessageBox.confirm(t('passkeyDeleteConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    passkeyLoading.value = true
    passkeyDelete(row.credentialId).then(() => {
      toast(t('passkeyDeleteSuccess'), 'success')
      return loadPasskeys()
    }).catch((e) => {
      passkeyLoading.value = false
      toast(e?.message || t('reqFailErrorMsg'))
    })
  }).catch(() => {
  })
}

// ---- 设备管理 ----
function revokeOne(row) {
  ElMessageBox.confirm(t('sessionRevokeConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    sessionLoading.value = true
    revokeSession(row.digest).then(() => loadSessions()).catch((e) => {
      sessionLoading.value = false
      toast(e?.message || t('reqFailErrorMsg'))
    })
  }).catch(() => {
  })
}

function revokeOthers() {
  ElMessageBox.confirm(t('sessionRevokeOthersConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    sessionLoading.value = true
    revokeOtherSessions().then(() => loadSessions()).catch((e) => {
      sessionLoading.value = false
      toast(e?.message || t('reqFailErrorMsg'))
    })
  }).catch(() => {
  })
}

// ---- 提醒开关 / 保留期限（即时保存，失败回滚） ----
function onLoginAlertChange(value) {
  saving.value = true
  const prev = security.loginAlert
  security.loginAlert = value ? 1 : 0
  setSecurity({loginAlert: value ? 1 : 0}).then(() => {
    saving.value = false
  }).catch((e) => {
    security.loginAlert = prev
    loginAlertOn.value = !!prev
    saving.value = false
    toast(e?.message || t('reqFailErrorMsg'))
  })
}

function onRetentionChange(value) {
  saving.value = true
  const prev = security.retentionDays
  setSecurity({retentionDays: value}).then(() => {
    saving.value = false
  }).catch((e) => {
    security.retentionDays = prev
    saving.value = false
    toast(e?.message || t('reqFailErrorMsg'))
  })
}

// ---- 闲置自动锁定 / 我的数据（Phase 7） ----
function onAutoLockChange(value) {
  saving.value = true
  const prev = security.autoLockMinutes
  setSecurity({autoLockMinutes: value}).then(() => {
    saving.value = false
    window.dispatchEvent(new CustomEvent('auto-lock-settings-changed', {detail: {autoLockMinutes: value}}))
  }).catch((e) => {
    security.autoLockMinutes = prev
    saving.value = false
    toast(e?.message || t('reqFailErrorMsg'))
  })
}

function exportMyData() {
  exportLoading.value = true
  exportData().then((data) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    a.href = url
    a.download = `mail-export-${stamp}.json`
    a.click()
    URL.revokeObjectURL(url)
    exportLoading.value = false
    toast(t('securityExportDone'), 'success')
  }).catch((e) => {
    exportLoading.value = false
    toast(e?.message || t('reqFailErrorMsg'))
  })
}

function deleteMyAccount() {
  ElMessageBox.confirm(t('securityDeleteAccountConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    deleteLoading.value = true
    userDelete().then(() => {
      localStorage.removeItem('token')
      router.replace('/login')
    }).catch((e) => {
      deleteLoading.value = false
      toast(e?.message || t('reqFailErrorMsg'))
    })
  }).catch(() => {
  })
}

// 彻底删除：密码 + 输入 DELETE 双重确认；成功后清 token 回登录页。
async function confirmHardDelete() {
  if (hardDeleteConfirmText.value !== 'DELETE') {
    toast(t('securityHardDeleteWrongText'))
    return
  }
  hardDeleteLoading.value = true
  try {
    await hardDeleteMyAccount(hardDeletePassword.value, hardDeleteConfirmText.value)
    localStorage.removeItem('token')
    hardDeleteDialogVisible.value = false
    hardDeletePassword.value = ''
    hardDeleteConfirmText.value = ''
    router.replace('/login')
  } catch (e) {
    hardDeleteLoading.value = false
    toast(e?.message || t('reqFailErrorMsg'))
  }
}

// ---- E2EE ----
async function enableE2ee() {
  if (!e2eePassword.value) {
    toast(t('e2eeNeedPassword'))
    return
  }
  e2eeLoading.value = true
  try {
    const salt = security.e2eeSalt || generateSalt()
    await setSecurity({e2eeEnabled: 1, e2eeSalt: salt})
    security.e2eeSalt = salt
    await unlockWithPassword(e2eePassword.value, salt)
    security.e2eeEnabled = 1
    e2eeUnlocked.value = true
    e2eePassword.value = ''
  } catch (e) {
    console.error(e)
    toast(e?.message || t('reqFailErrorMsg'))
  } finally {
    e2eeLoading.value = false
  }
}

async function unlockE2ee() {
  if (!e2eePassword.value || !security.e2eeSalt) {
    toast(t('e2eeNeedPassword'))
    return
  }
  e2eeLoading.value = true
  try {
    await unlockWithPassword(e2eePassword.value, security.e2eeSalt)
    e2eeUnlocked.value = true
    e2eePassword.value = ''
  } catch (e) {
    console.error(e)
    toast(t('e2eeUnlockFailed'))
  } finally {
    e2eeLoading.value = false
  }
}

function lockE2ee() {
  clearMemoryKey()
  e2eeUnlocked.value = false
}

function disableE2ee() {
  e2eeLoading.value = true
  setSecurity({e2eeEnabled: 0}).then(() => {
    security.e2eeEnabled = 0
    clearMemoryKey()
    e2eeUnlocked.value = false
    e2eeLoading.value = false
  }).catch((e) => {
    e2eeLoading.value = false
    toast(e?.message || t('reqFailErrorMsg'))
  })
}
</script>
<style scoped lang="scss">
.security-page {
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.box {
  padding: 40px 40px;

  @media (max-width: 767px) {
    padding: 30px 20px;
  }

  .title {
    font-size: 20px;
    font-weight: bold;
    margin-bottom: 30px;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-bottom: 40px;
    align-items: flex-start;
    max-width: 860px;

    .section-title {
      font-size: 18px;
      font-weight: bold;
    }

    .desc {
      font-size: 14px;
      color: var(--regular-text-color);
      line-height: 1.6;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
  }

  .score-row {
    display: flex;
    align-items: center;
    gap: 20px;
    width: 100%;

    .score-num {
      font-size: 36px;
      font-weight: bold;
      white-space: nowrap;

      .score-total {
        font-size: 16px;
        color: var(--secondary-text-color);
      }
    }

    .score-bar {
      flex: 1;
    }
  }

  .score-tip {
    font-size: 13px;
    color: var(--secondary-text-color);
  }

  .score-list {
    width: 100%;
    display: grid;
    gap: 10px;

    .score-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 14px;
      padding: 8px 0;
      border-bottom: 1px solid var(--light-border-color);
    }
  }

  .totp-setup {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
    border: 1px solid var(--light-border-color);
    border-radius: 6px;
  }

  .kv-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;

    .kv-label {
      width: 90px;
      font-size: 14px;
      font-weight: bold;
      flex-shrink: 0;
    }

    .secret-input {
      flex: 1;
      min-width: 200px;
    }

    .code-input {
      width: 260px;
      max-width: 100%;
    }
  }

  .e2ee-warn {
    width: 100%;
  }
}
</style>
