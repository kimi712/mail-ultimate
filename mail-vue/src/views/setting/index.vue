<template>
  <div class="settings-page">
    <el-scrollbar ref="scrollbarRef" height="100%">
  <div class="box">
    <!-- 顶部横排分区导航：点一下平滑滚动到对应分区 -->
    <section-nav :items="sectionNavItems" :container="scrollContainer" />
    <!-- Phase 8 斯诺登元素补齐：顶部隐私横幅（点击进隐私仪表盘）。 -->
    <div class="privacy-banner" @click="router.push({ name: 'privacy' })">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
      <span>{{ $t('settingsPrivacyBanner') }}</span>
      <span class="privacy-banner-link">{{ $t('privacyDashboard') }} ›</span>
    </div>
    <div class="container" id="sec-profile">
      <div class="title">{{$t('profile')}}</div>
      <div class="item setting-row">
        <div>{{$t('username')}}</div>
        <div>
          <span v-if="setNameShow" class="edit-name-input">
            <el-input v-model="accountName"  ></el-input>
            <span class="edit-name" @click="setName">
             {{$t('save')}}
            </span>
          </span>
          <span v-else class="user-name">
            <span >{{ userStore.user.name }}</span>
            <span class="edit-name" @click="showSetName">
             {{$t('change')}}
            </span>
          </span>
        </div>
      </div>
      <div class="item setting-row">
        <div>{{$t('emailAccount')}}</div>
        <div>{{ userStore.user.email }}</div>
      </div>
      <div class="item setting-row">
        <div>{{$t('password')}}</div>
        <div>
          <el-button type="primary" @click="pwdShow = true">{{$t('changePwdBtn')}}</el-button>
        </div>
      </div>
    </div>
    <!-- 账号恢复：备用邮箱 + 恢复码（登录后自助设置；隐私仪表盘里也有一份入口）。 -->
    <div class="preference-item" id="sec-recovery">
      <div class="title">{{ $t('recoverySection') }}</div>
      <div class="recovery-desc">{{ $t('recoverySectionDesc') }}</div>
      <div class="language-row setting-row">
        <div>{{ $t('recoveryBackupEmail') }}</div>
        <div class="recovery-value">
          <span v-if="backupEmail" class="recovery-email">{{ backupEmail }}</span>
          <span v-else class="recovery-notset">{{ $t('recoveryBackupEmailNotSet') }}</span>
        </div>
      </div>
      <div class="language-row setting-row">
        <div></div>
        <div class="recovery-actions">
          <el-button type="primary" @click="openBackupDialog">{{ backupEmail ? $t('change') : $t('recoveryBackupEmailSet') }}</el-button>
          <el-button v-if="backupEmail" plain type="danger" @click="onRemoveBackupEmail">{{ $t('recoveryBackupEmailRemove') }}</el-button>
        </div>
      </div>
      <div class="language-row setting-row">
        <div>{{ $t('recoveryCode') }}</div>
        <div>
          <span>{{ $t('recoveryCodesRemaining') }}：{{ recoveryRemaining }}</span>
          <el-button style="margin-left: 12px" @click="recoveryDialogVisible = true">{{ $t('recoveryGenerateCodes') }}</el-button>
        </div>
      </div>
      <div class="recovery-desc">{{ $t('recoveryCodesHint') }}</div>
    </div>
    <!-- 新邮件通知转发：收到新邮件时自动把原信转发一份到该邮箱（只转本人的），不用手动进站查看。 -->
    <div class="preference-item" id="sec-forward">
      <div class="title">{{ $t('forwardSection') }}</div>
      <div class="recovery-desc">{{ $t('forwardSectionDesc') }}</div>
      <div class="language-row setting-row">
        <div>{{ $t('forwardEmail') }}</div>
        <div class="recovery-value">
          <span v-if="forwardEmail" class="recovery-email">{{ forwardEmail }}</span>
          <span v-else class="recovery-notset">{{ $t('forwardEmailNotSet') }}</span>
        </div>
      </div>
      <div class="language-row setting-row">
        <div></div>
        <div class="recovery-actions">
          <el-button type="primary" @click="openForwardDialog">{{ forwardEmail ? $t('change') : $t('forwardEmailSet') }}</el-button>
          <el-button v-if="forwardEmail" plain type="danger" @click="onRemoveForwardEmail">{{ $t('forwardEmailRemove') }}</el-button>
        </div>
      </div>
    </div>
    <!-- Telegram 通知：绑定后新邮件立刻推送到用户自己的 TG。 -->
    <div class="preference-item" id="sec-telegram">
      <div class="title">{{ $t('tgUserSection') }}</div>
      <div class="recovery-desc">{{ $t('tgUserSectionDesc') }}</div>
      <div class="language-row setting-row">
        <div>{{ $t('tgUserSection') }}</div>
        <div class="recovery-value">
          <span v-if="tgBound" class="recovery-email">{{ $t('tgUserBound') }}</span>
          <span v-else class="recovery-notset">{{ $t('tgUserNotBound') }}</span>
        </div>
      </div>
      <div class="language-row setting-row">
        <div></div>
        <div class="recovery-actions">
          <el-button type="primary" :loading="tgBindLoading" @click="onBindTelegram">{{ $t('tgUserBind') }}</el-button>
          <el-button v-if="tgBound" plain type="danger" @click="onUnbindTelegram">{{ $t('tgUserUnbind') }}</el-button>
        </div>
      </div>
    </div>
    <!-- 一次性别名邮箱：随机前缀地址，别名收到的信进主收件箱；停用后拒收。 -->
    <div class="preference-item" id="sec-alias">
      <div class="title">{{ $t('aliasSection') }}</div>
      <div class="recovery-desc">{{ $t('aliasSectionDesc') }}</div>
      <div class="language-row setting-row">
        <div></div>
        <div class="recovery-actions">
          <el-button type="primary" :loading="aliasLoading" :disabled="aliasActiveCount >= 10" @click="onCreateAlias">{{ $t('aliasCreate') }}</el-button>
          <span class="recovery-notset">{{ $t('aliasCount', { count: aliasActiveCount }) }}</span>
        </div>
      </div>
      <!-- 跨页跳转根治：加载态预留 160px（表头 + 3 行别名），数据来了填进去不撑大页面。 -->
      <div class="tbl-reserve" :style="{ minHeight: aliasLoading ? '160px' : undefined }">
      <el-table :data="aliasList" v-loading="aliasLoading" style="width: 100%" :empty-text="$t('aliasEmpty')">
        <el-table-column prop="address" :label="$t('aliasAddress')" min-width="200" />
        <el-table-column :label="$t('aliasStatus')" width="110">
          <template #default="{row}">
            <el-tag :type="row.status === 0 ? 'success' : 'info'">{{ row.status === 0 ? $t('aliasActive') : $t('aliasDisabled') }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="recvCount" :label="$t('aliasRecvCount')" width="100" />
        <el-table-column width="220">
          <template #default="{row}">
            <el-button v-if="row.status === 0" link type="warning" @click="onDisableAlias(row)">{{ $t('aliasDisable') }}</el-button>
            <el-button v-else link type="success" @click="onEnableAlias(row)">{{ $t('aliasEnable') }}</el-button>
            <el-button link type="danger" @click="onDeleteAlias(row)">{{ $t('delete') }}</el-button>
          </template>
        </el-table-column>
      </el-table>
      </div>
    </div>
    <div class="language" id="sec-language">
      <div class="title">{{$t('language')}}</div>
      <div class="language-row setting-row">
        <div>{{$t('preferredLanguage')}}</div>
        <el-select
            :model-value="langSelect"
            class="language-select"
            :placeholder="$t('select')"
            @change="changeLang"
        >
          <el-option v-for="item in SUPPORTED_LOCALES" :key="item.short" :label="item.label" :value="item.short" @pointerdown.prevent.stop="changeLang(item.short)"/>
        </el-select>
      </div>
    </div>
    <div class="preference-item" id="sec-theme">
      <div class="title" id="theme-label">{{$t('themeStyle')}}</div>
      <ThemeSelector/>
    </div>
    <div class="preference-item" id="sec-density">
      <div class="title">{{$t('densitySetting')}}</div>
      <div class="language-row setting-row">
        <div>{{$t('densitySetting')}}</div>
        <el-radio-group v-model="density" @change="onDensityChange">
          <el-radio value="comfortable">{{ $t('densityComfortable') }}</el-radio>
          <el-radio value="compact">{{ $t('densityCompact') }}</el-radio>
        </el-radio-group>
      </div>
    </div>
    <div class="preference-item" id="sec-notice-setting">
      <div class="title">{{$t('noticeSetting')}}</div>
      <div class="language-row setting-row">
        <div>{{$t('loginNotice')}}</div>
        <el-switch v-model="noticeOn" @change="onNoticeChange" />
      </div>
    </div>
    <div class="preference-item" id="sec-timezone">
      <div class="title">{{$t('timeZoneSetting')}}</div>
      <div class="language-row setting-row">
        <div>{{$t('timeZoneSetting')}}</div>
        <el-select v-model="timeZone" class="language-select" @change="onTimeZoneChange">
          <el-option :label="$t('timeZoneAuto')" value="auto" />
          <el-option
            v-for="zone in COMMON_TIME_ZONES"
            :key="zone"
            :label="formatTimeZoneLabel(zone, settingStore.lang)"
            :value="zone"
          />
        </el-select>
      </div>
    </div>
    <div class="preference-item" id="sec-shortcuts">
      <div class="title">{{$t('shortcutsSetting')}}</div>
      <div class="language-row setting-row">
        <div>{{$t('shortcutsSetting')}}</div>
        <el-switch v-model="shortcutsOn" @change="onShortcutsChange" />
      </div>
      <div class="language-row setting-row">
        <div></div>
        <div>
          <el-button @click="showShortcutHelp = true">{{$t('shortcutsViewHelp')}}</el-button>
        </div>
      </div>
    </div>
    <div class="preference-item" id="sec-notice">
      <div class="title">{{$t('noticeTitle')}}</div>
      <div class="language-row setting-row">
        <div>{{$t('noticeInfo')}}</div>
        <div>
          <el-button @click="uiStore.showNotice()">{{$t('viewNotice')}}</el-button>
        </div>
      </div>
    </div>
    <div class="preference-item" id="sec-loginlog">
      <div class="title">{{$t('loginLogTitle')}}</div>
      <!-- 跨页跳转根治：加载态预留 840px（表头 + 20 行），数据来了填进去不撑大页面。 -->
      <div class="tbl-reserve" :style="{ minHeight: loginLogLoading ? '840px' : undefined }">
      <el-table :data="loginLogList" v-loading="loginLogLoading" style="width: 100%" :empty-text="$t('loginLogEmpty')">
        <el-table-column prop="createTime" :label="$t('loginLogTime')" width="180" />
        <el-table-column prop="ip" :label="$t('loginLogIp')" width="160" />
        <el-table-column :label="$t('loginLogDevice')">
          <!-- UA 单行省略（悬停看全文）：窄屏下 110 字符 UA 会换行撑高行高，行高必须确定化。 -->
          <template #default="{row}"><span class="cell-ellipsis" :title="row.ua || '-'">{{ row.ua || '-' }}</span></template>
        </el-table-column>
        <el-table-column :label="$t('loginLogNewIp')" width="110">
          <template #default="{row}">
            <el-tag v-if="row.isNewIp === 1" type="warning">{{ $t('loginLogIsNew') }}</el-tag>
            <el-tag v-else type="info">{{ $t('loginLogNotNew') }}</el-tag>
          </template>
        </el-table-column>
      </el-table>
      </div>
    </div>
    <div class="preference-item" id="wallpaper">
      <div class="title">{{$t('wallpaper.title')}}</div>
      <WallpaperSelector/>
    </div>
    <div class="del-email" id="sec-delete" v-perm="'my:delete'">
      <div class="title">{{$t('deleteUser')}}</div>
      <div style="color: var(--regular-text-color);">
        {{$t('delAccountMsg')}}
      </div>
      <div>
        <el-button type="primary" @click="deleteConfirm">{{$t('deleteUserBtn')}}</el-button>
      </div>
    </div>
    <ShortcutHelp v-model="showShortcutHelp" />
    <el-dialog v-model="pwdShow" :title="$t('changePassword')" width="340">
      <div class="update-pwd">
        <el-input type="password" :placeholder="$t('newPassword')" v-model="form.password" autocomplete="off" @keyup.enter="submitPwd"/>
        <el-input type="password" :placeholder="$t('confirmPassword')" v-model="form.newPwd" autocomplete="off" @keyup.enter="submitPwd"/>
        <el-button type="primary" :loading="setPwdLoading" @click="submitPwd">{{$t('save')}}</el-button>
      </div>
    </el-dialog>
    <!-- 备用邮箱设置 -->
    <el-dialog v-model="backupDialogVisible" :title="$t('recoveryBackupEmailSet')" width="480px" :close-on-click-modal="false">
      <el-input v-model="backupEmailInput" :placeholder="$t('recoveryBackupEmailPlaceholder')" autocomplete="off" />
      <div class="recovery-desc" style="margin-top: 8px">{{ $t('recoveryBackupEmailHint') }}</div>
      <template #footer>
        <el-button @click="backupDialogVisible = false">{{ $t('cancel') }}</el-button>
        <el-button type="primary" :loading="backupLoading" @click="onSaveBackupEmail">{{ $t('confirm') }}</el-button>
      </template>
    </el-dialog>
    <!-- 转发邮箱设置 -->
    <el-dialog v-model="forwardDialogVisible" :title="$t('forwardEmailSet')" width="480px" :close-on-click-modal="false">
      <el-input v-model="forwardEmailInput" :placeholder="$t('forwardEmailPlaceholder')" autocomplete="off" @keyup.enter="onSaveForwardEmail" />
      <div class="recovery-desc" style="margin-top: 8px">{{ $t('forwardSectionDesc') }}</div>
      <template #footer>
        <el-button @click="forwardDialogVisible = false">{{ $t('cancel') }}</el-button>
        <el-button type="primary" :loading="forwardLoading" @click="onSaveForwardEmail">{{ $t('confirm') }}</el-button>
      </template>
    </el-dialog>
    <!-- 绑定 Telegram：展示 t.me 链接（10 分钟有效） -->
    <el-dialog v-model="tgBindDialogVisible" :title="$t('tgUserBindTitle')" width="480px" :close-on-click-modal="false">
      <div v-if="tgBindLink" class="recovery-desc" style="margin-bottom: 12px">{{ $t('tgUserBindStep') }}</div>
      <div v-if="tgBindLink" style="text-align: center; margin-bottom: 12px">
        <el-button type="primary" @click="openTgBindLink">{{ $t('tgUserBindOpenBot') }}</el-button>
      </div>
      <div v-if="tgBindLink" class="recovery-code">{{ tgBindLink }}</div>
      <div v-else class="recovery-desc">{{ $t('tgUserBindNoBot') }}</div>
      <template #footer>
        <el-button @click="tgBindDialogVisible = false">{{ $t('cancel') }}</el-button>
        <el-button v-if="tgBindLink" type="primary" @click="copyTgBindLink">{{ $t('copy') }}</el-button>
      </template>
    </el-dialog>
    <!-- 生成恢复码：需当前密码；明文只显示一次 -->
    <el-dialog v-model="recoveryDialogVisible" :title="$t('recoveryGenerateCodes')" width="520px" :close-on-click-modal="false">
      <div v-if="!generatedCodes.length">
        <div class="recovery-desc" style="margin-bottom: 12px">{{ $t('recoveryGenerateHint') }}</div>
        <el-input v-model="recoveryPassword" type="password" :placeholder="$t('password')" autocomplete="off" show-password />
      </div>
      <div v-else>
        <el-alert :title="$t('recoveryShowOnce')" type="warning" :closable="false" style="margin-bottom: 12px" />
        <div v-for="code in generatedCodes" :key="code" class="recovery-code">{{ code }}</div>
      </div>
      <template #footer>
        <el-button @click="closeRecoveryDialog">{{ $t('cancel') }}</el-button>
        <el-button v-if="!generatedCodes.length" type="primary" :loading="recoveryLoading" @click="onGenerateCodes">{{ $t('confirm') }}</el-button>
        <el-button v-else type="primary" @click="copyCodes">{{ $t('copy') }}</el-button>
      </template>
    </el-dialog>
  </div>
    </el-scrollbar>
  </div>
</template>
<script setup>
import {reactive, ref, computed, defineOptions, onMounted} from 'vue'
import {resetPassword, userDelete, loginLog, setLocale, getTelegramStatus, createTelegramBindCode, unbindTelegram, getAliasList, createAlias, disableAlias, enableAlias, deleteAlias} from "@/request/my.js";
import i18n from "@/i18n/index.js";
import { SUPPORTED_LOCALES, SHORT_CODES, applyLocale, toStoredLocale } from "@/i18n/locale.js";
import { loadPrefs, savePrefs, applyPrefs } from "@/utils/preferences.js";
import { COMMON_TIME_ZONES, formatTimeZoneLabel } from "@/utils/datetime.js";
import ShortcutHelp from "@/components/shortcut-help/index.vue";
import {useUserStore} from "@/store/user.js";
import router from "@/router/index.js";
import {accountSetName} from "@/request/account.js";
import { getBackupEmail, setBackupEmail, deleteBackupEmail, recoveryCodesStatus, generateRecoveryCodes } from "@/request/recovery.js";
import { trustGetPrefs, trustSetPrefs } from "@/request/mail-trust.js";
import {useAccountStore} from "@/store/account.js";
import {useI18n} from "vue-i18n";
import {useSettingStore} from "@/store/setting.js";
import {useUiStore} from "@/store/ui.js";
import ThemeSelector from "@/components/theme-selector/index.vue";
import WallpaperSelector from "@/components/wallpaper-selector/index.vue";
import SectionNav from "@/components/section-nav/index.vue";
import { useRoute } from 'vue-router'
import {scrollToQueryAnchor} from '@/utils/anchor-scroll.js';

const { t } = useI18n()
const route = useRoute()
const accountStore = useAccountStore()
const settingStore = useSettingStore()
const uiStore = useUiStore()
const userStore = useUserStore();
// 顶部横排分区导航：点一下平滑滚动到对应分区
const scrollbarRef = ref(null)
const scrollContainer = computed(() => scrollbarRef.value?.wrapRef || null)
const sectionNavItems = computed(() => [
  { id: 'sec-profile', label: t('profile') },
  { id: 'sec-recovery', label: t('recoverySection') },
  { id: 'sec-forward', label: t('forwardSection') },
  { id: 'sec-telegram', label: t('tgUserSection') },
  { id: 'sec-alias', label: t('aliasSection') },
  { id: 'sec-language', label: t('language') },
  { id: 'sec-theme', label: t('themeStyle') },
  { id: 'sec-density', label: t('densitySetting') },
  { id: 'sec-notice-setting', label: t('noticeSetting') },
  { id: 'sec-timezone', label: t('timeZoneSetting') },
  { id: 'sec-shortcuts', label: t('shortcutsSetting') },
  { id: 'sec-notice', label: t('noticeTitle') },
  { id: 'sec-loginlog', label: t('loginLogTitle') },
  { id: 'wallpaper', label: t('wallpaper.title') },
  { id: 'sec-delete', label: t('deleteUser') },
])
const setPwdLoading = ref(false)
const setNameShow = ref(false)
const accountName = ref(null)
const langSelect = ref(settingStore.lang)

// Phase 2 A 路：登录记录（GET /my/loginLog，仅本人数据，最近 20 条）
const loginLogList = ref([])
const loginLogLoading = ref(true)
function fetchLoginLog() {
  loginLogLoading.value = true
  return loginLog({num: 1, size: 20}).then(data => {
    loginLogList.value = data.list || []
    loginLogLoading.value = false
  }).catch(() => {
    loginLogLoading.value = false
  })
}

// Phase 2 A 路补充：个性化偏好——布局密度与登录公告开关。
// 存 localStorage mail-prefs，切换即时生效并持久化（刷新后保持）。
const density = ref(loadPrefs().density)
const noticeOn = ref(loadPrefs().notice)
// Phase 8 H 路：时区（默认 auto = 浏览器时区）与 Gmail 快捷键开关（默认开），
// 同走 mail-prefs；改动即时生效（时间显示与按键监听每次都重读偏好）。
const timeZone = ref(loadPrefs().timeZone)
const shortcutsOn = ref(loadPrefs().shortcutsEnabled)
const showShortcutHelp = ref(false)
function onTimeZoneChange() {
  const prefs = loadPrefs()
  prefs.timeZone = timeZone.value
  savePrefs(prefs)
}
function onShortcutsChange() {
  const prefs = loadPrefs()
  prefs.shortcutsEnabled = shortcutsOn.value
  savePrefs(prefs)
}
function onDensityChange() {
  const prefs = loadPrefs()
  prefs.density = density.value
  savePrefs(prefs)
  applyPrefs(prefs, uiStore)
}
function onNoticeChange() {
  const prefs = loadPrefs()
  prefs.notice = noticeOn.value
  savePrefs(prefs)
}

defineOptions({
  name: 'setting'
})

function showSetName() {
  accountName.value = userStore.user.name
  setNameShow.value = true
}

function setName() {

  if (!accountName.value) {
    ElMessage({
      message: t('emptyUserNameMsg'),
      type: 'error',
      plain: true,
    })
    return;
  }

  setNameShow.value = false
  let name = accountName.value

  if (name === userStore.user.name) {
    return
  }

  userStore.user.name = accountName.value

  accountSetName(userStore.user.account.accountId,name).then(() => {
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })

    accountStore.changeUserAccountName = name

  }).catch(() => {
    userStore.user.name = name
  })
}

function changeLang(lang) {
  // Phase 2 A 路补充：14 语种即时切换（不刷新）+ 登录态下同步到后端 user.locale。
  // el-option 的 pointerdown 与 el-select 的 change 会各触发一次，用当前语言去重。
  if (!SHORT_CODES.includes(lang) || lang === settingStore.lang) {
    return
  }
  applyLocale(i18n, settingStore, lang).then(() => {
    langSelect.value = lang
  })
  setLocale(toStoredLocale(lang)).catch(() => {
    // best-effort：后端同步失败不弹错，下次登录时再同步
  })
}

const pwdShow = ref(false)
const form = reactive({
  password: '',
  newPwd: '',
})

// 账号恢复：备用邮箱 + 恢复码（接口见 request/recovery.js；
// noMsg 模式下业务错误不自动弹提示，catch 里用后端返回的 message 弹错）。
const backupEmail = ref('')
const backupDialogVisible = ref(false)
const backupEmailInput = ref('')
const backupLoading = ref(false)
const recoveryRemaining = ref(0)
const recoveryDialogVisible = ref(false)
const recoveryPassword = ref('')
const recoveryLoading = ref(false)
const generatedCodes = ref([])

function fetchRecovery() {
  return Promise.all([
    getBackupEmail().then(data => {
      backupEmail.value = data?.backupEmail || ''
    }).catch(() => {}),
    recoveryCodesStatus().then(data => {
      recoveryRemaining.value = data?.remaining ?? 0
    }).catch(() => {}),
  ])
}

// 新邮件通知转发：forward_email 存在 mail_prefs；收信时把原信转发一份到该地址。
const forwardEmail = ref('')
const forwardDialogVisible = ref(false)
const forwardEmailInput = ref('')
const forwardLoading = ref(false)

function fetchForwardEmail() {
  return trustGetPrefs().then(data => {
    forwardEmail.value = data?.forwardEmail || ''
  }).catch(() => {})
}

function openForwardDialog() {
  forwardEmailInput.value = forwardEmail.value
  forwardDialogVisible.value = true
}

function onSaveForwardEmail() {
  if (forwardLoading.value) return
  const addr = (forwardEmailInput.value || '').trim()
  if (addr && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
    ElMessage({ message: t('forwardEmailInvalid'), type: 'error', plain: true })
    return
  }
  forwardLoading.value = true
  trustSetPrefs({ forwardEmail: addr }).then(() => {
    ElMessage({ message: t('saveSuccessMsg'), type: 'success', plain: true })
    forwardDialogVisible.value = false
    fetchForwardEmail()
  }).catch(err => {
    ElMessage({ message: err?.message || 'error', type: 'error', plain: true })
  }).finally(() => {
    forwardLoading.value = false
  })
}

function onRemoveForwardEmail() {
  ElMessageBox.confirm(t('forwardEmailRemove') + '?', {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    trustSetPrefs({ forwardEmail: '' }).then(() => {
      ElMessage({ message: t('saveSuccessMsg'), type: 'success', plain: true })
      fetchForwardEmail()
    }).catch(err => {
      ElMessage({ message: err?.message || 'error', type: 'error', plain: true })
    })
  })
}

// Telegram 通知绑定：状态只读本人数据；绑定码 10 分钟有效，点链接去 TG 完成绑定。
const tgBound = ref(false)
const tgBindDialogVisible = ref(false)
const tgBindLink = ref('')
const tgBindLoading = ref(false)

function fetchTelegramStatus() {
  return getTelegramStatus().then(data => {
    tgBound.value = !!data?.bound
  }).catch(() => {})
}

function onBindTelegram() {
  if (tgBindLoading.value) return
  tgBindLoading.value = true
  createTelegramBindCode().then(data => {
    tgBindLink.value = data?.link || ''
    tgBindDialogVisible.value = true
  }).catch(err => {
    ElMessage({ message: err?.message || 'error', type: 'error', plain: true })
  }).finally(() => {
    tgBindLoading.value = false
  })
}

function openTgBindLink() {
  if (tgBindLink.value) window.open(tgBindLink.value, '_blank')
}

function copyTgBindLink() {
  navigator.clipboard.writeText(tgBindLink.value).then(() => {
    ElMessage({ message: 'OK', type: 'success', plain: true })
  }).catch(() => {})
}

function onUnbindTelegram() {
  ElMessageBox.confirm(t('tgUserUnbind') + '?', {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    unbindTelegram().then(() => {
      ElMessage({ message: t('saveSuccessMsg'), type: 'success', plain: true })
      fetchTelegramStatus()
    }).catch(err => {
      ElMessage({ message: err?.message || 'error', type: 'error', plain: true })
    })
  })
}

// 一次性别名邮箱：列表 / 生成（每用户最多 10 个启用中）/ 停用 / 启用 / 删除。
const aliasList = ref([])
const aliasLoading = ref(true)
const aliasActiveCount = computed(() => aliasList.value.filter(a => a.status === 0).length)

function fetchAliasList() {
  aliasLoading.value = true
  return getAliasList().then(data => {
    aliasList.value = Array.isArray(data) ? data : []
  }).catch(() => {}).finally(() => {
    aliasLoading.value = false
  })
}

// 跨页锚点跳转（功能搜索经路由 query 传 anchor）：原先 5 个 fetch 各自 onMounted、
// 没人汇总它们的 promise，顶栏只能猜"何时稳定"——两轮都失败。根治：一次 onMounted
// 把 5 个请求全汇总，等全落定（成功失败都算，8 秒超时兜底）再滚一次，时机天然正确。滚完清掉 query。
onMounted(() => {
  const jobs = [
    fetchLoginLog(),
    fetchRecovery(),
    fetchForwardEmail(),
    fetchTelegramStatus(),
    fetchAliasList(),
  ]
  scrollToQueryAnchor({ route, router, routeName: 'setting', jobs, getWrap: () => scrollContainer.value })
})

function onCreateAlias() {
  if (aliasLoading.value) return
  aliasLoading.value = true
  createAlias().then(() => {
    ElMessage({ message: t('saveSuccessMsg'), type: 'success', plain: true })
    fetchAliasList()
  }).catch(err => {
    aliasLoading.value = false
    ElMessage({ message: err?.message || 'error', type: 'error', plain: true })
  })
}

function onDisableAlias(row) {
  disableAlias(row.aliasId).then(() => fetchAliasList()).catch(err => {
    ElMessage({ message: err?.message || 'error', type: 'error', plain: true })
  })
}

function onEnableAlias(row) {
  enableAlias(row.aliasId).then(() => fetchAliasList()).catch(err => {
    ElMessage({ message: err?.message || 'error', type: 'error', plain: true })
  })
}

function onDeleteAlias(row) {
  ElMessageBox.confirm(row.address + '?', {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    deleteAlias(row.aliasId).then(() => fetchAliasList()).catch(err => {
      ElMessage({ message: err?.message || 'error', type: 'error', plain: true })
    })
  })
}

function openBackupDialog() {
  backupEmailInput.value = backupEmail.value
  backupDialogVisible.value = true
}

function onSaveBackupEmail() {
  if (backupLoading.value) return
  backupLoading.value = true
  setBackupEmail(backupEmailInput.value).then(() => {
    ElMessage({ message: t('saveSuccessMsg'), type: 'success', plain: true })
    backupDialogVisible.value = false
    fetchRecovery()
  }).catch(err => {
    ElMessage({ message: err?.message || 'error', type: 'error', plain: true })
  }).finally(() => {
    backupLoading.value = false
  })
}

function onRemoveBackupEmail() {
  ElMessageBox.confirm(t('recoveryBackupEmailRemove') + '?', {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    deleteBackupEmail().then(() => {
      ElMessage({ message: t('saveSuccessMsg'), type: 'success', plain: true })
      fetchRecovery()
    })
  })
}

function onGenerateCodes() {
  if (recoveryLoading.value) return
  recoveryLoading.value = true
  generateRecoveryCodes(recoveryPassword.value).then(data => {
    generatedCodes.value = data?.codes || data?.data?.codes || []
  }).catch(err => {
    ElMessage({ message: err?.message || 'error', type: 'error', plain: true })
  }).finally(() => {
    recoveryLoading.value = false
  })
}

function closeRecoveryDialog() {
  recoveryDialogVisible.value = false
  recoveryPassword.value = ''
  generatedCodes.value = []
  fetchRecovery()
}

function copyCodes() {
  navigator.clipboard.writeText(generatedCodes.value.join('\n')).then(() => {
    ElMessage({ message: 'OK', type: 'success', plain: true })
  }).catch(() => {})
}

const deleteConfirm = () => {
  ElMessageBox.confirm(t('delAccountConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    userDelete().then(() => {
      localStorage.removeItem('token');
      router.replace('/login');
      ElMessage({
        message: t('delSuccessMsg'),
        type: 'success',
        plain: true,
      })
    })
  })
}


function submitPwd() {

  if (setPwdLoading.value) return

  if (!form.password) {
    ElMessage({
      message: t('emptyPwdMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (form.password.length < 6) {
    ElMessage({
      message: t('pwdLengthMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (form.password !== form.newPwd) {
    ElMessage({
      message: t('confirmPwdFailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  setPwdLoading.value = true
  resetPassword(form.password).then(() => {
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })
    pwdShow.value = false
    setPwdLoading.value = false
    form.password = ''
    form.newPwd = ''
  }).catch(() => {
    setPwdLoading.value = false
  })

}

</script>
<style scoped lang="scss">
.settings-page {
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.box {
    /* 整页一张卡：导航、横幅、各分区同处一个卡面，不再是散落的浮件。 */
    margin: 16px;
    padding: 28px 32px;
    background: var(--el-bg-color-overlay);
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 16px;

    @media (max-width: 767px) {
      margin: 12px;
      padding: 20px;
    }

    /* 导航栏收进卡片当顶栏：与卡片同底色、左右通栏、底部分隔线，吸顶时仍是一体。 */
    :deep(.section-nav) {
      margin: -28px -32px 8px;
      padding: 12px 32px;
      background: var(--el-bg-color-overlay);
      border-radius: 16px 16px 0 0;
      border-bottom: 1px solid var(--el-border-color-lighter);

      @media (max-width: 767px) {
        margin: -20px -20px 8px;
        padding: 12px 20px;
      }
    }

  /* 分区锚点滚动时不被吸顶导航遮住标题（实测 56px 会盖住标题顶 10–15px，改 76px） */
  .container,
  .preference-item,
  .language,
  .del-email {
    scroll-margin-top: 76px;
  }

  /* 跨页跳转根治：动态表格的预留高度容器（加载态 min-height，数据来了填进去不撑大页面）。 */
  .tbl-reserve {
    width: 100%;
  }

  /* 表格长字段单行省略（悬停 title 看全文），行高确定化、不随内容换行波动。 */
  .cell-ellipsis {
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* 顶部隐私横幅——窄条、可点击，与卡片同色系的浅底细边，不再单独抢眼。 */
  .privacy-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 24px;
    padding: 10px 14px;
    border-radius: 10px;
    background: var(--el-fill-color-lighter);
    border: 1px solid var(--el-border-color-lighter);
    font-size: 13px;
    color: var(--el-text-color-primary);
    cursor: pointer;

    svg {
      flex: none;
      color: var(--el-color-primary);
    }

    .privacy-banner-link {
      margin-left: auto;
      font-size: 12px;
      color: var(--el-color-primary);
      white-space: nowrap;
    }
  }

  .update-pwd {
    display: flex;
    flex-direction: column;
    gap: 15px;
  }

  /* 账号恢复分区 */
  .recovery-desc {
    font-size: 13px;
    color: var(--regular-text-color);
    line-height: 1.7;
  }

  .recovery-email {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recovery-notset {
    color: #e6a23c;
    font-weight: 600;
  }

  .recovery-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }

  .recovery-code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 15px;
    letter-spacing: .08em;
    text-align: center;
    padding: 8px;
    margin-bottom: 6px;
    border-radius: 8px;
    background: var(--el-fill-color-lighter);
  }

  .title {
    font-size: 18px;
    font-weight: bold;
  }

  .container {
    font-size: 14px;
    display: grid;
    gap: 20px;
    margin-bottom: 32px;

    .item {
      position: relative;
      .user-name {
        display: grid;
        grid-template-columns: minmax(0, auto) max-content;
        justify-content: start;
        align-items: center;
        span:first-child {
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }
      }

      .edit-name-input {
        position: absolute;
        bottom: -6px;
        .el-input {
          width: min(200px,calc(100vw - 222px));
        }
      }

      .edit-name {
        color: #4dabff;
        padding-left: 10px;
        white-space: nowrap;
        cursor: pointer;
      }

    }
  }

  .preference-item,
  .language {
    display: flex;
    flex-direction: column;
    gap: 20px;
    margin-bottom: 32px;
    align-items: flex-start;

  }

  .setting-row {
    width: 100%;
    display: grid;
    grid-template-columns: 120px 220px;
    align-items: center;
    column-gap: 110px;
    font-size: 14px;

    > div:first-child {
      font-weight: bold;
      min-width: 0;
      text-align: left;
    }

    > div:last-child {
      min-width: 0;
      overflow: hidden;
      text-align: left;
    }

    @media (max-width: 767px) {
      grid-template-columns: 120px minmax(0, 1fr);
      column-gap: 24px;
    }
  }

  .language-select {
    width: 150px;
    max-width: 100%;
  }

  .del-email {
    font-size: 14px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
}

/* 壁纸模式：卡片与内容区同款半透明 + 毛玻璃，壁纸仍 faint 可见。 */
html[data-wallpaper="1"] .layout.has-wallpaper .box {
  background: rgba(13, 18, 28, 0.62);
  backdrop-filter: blur(12px) saturate(1.1);
  -webkit-backdrop-filter: blur(12px) saturate(1.1);
}
html.dark[data-wallpaper="1"] .layout.has-wallpaper .box {
  background: rgba(10, 10, 14, 0.62);
}
@media (max-width: 767px) {
  html[data-wallpaper="1"] .layout.has-wallpaper .box {
    background: rgba(13, 18, 28, 0.72);
  }
  html.dark[data-wallpaper="1"] .layout.has-wallpaper .box {
    background: rgba(10, 10, 14, 0.72);
  }
}

</style>
