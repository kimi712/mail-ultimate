<template>
  <div class="header">
    <div class="header-btn">
      <hanburger @click="changeAside"></hanburger>
      <span class="breadcrumb-item">{{ $t(route.meta.title) }}</span>
    </div>
    <div v-perm="'email:send'" class="writer-box">
      <el-button
        class="writer"
        size="default"
        :aria-label="$t('compose')"
        @click="openSend"
      >
        <el-icon :size="21">
          <Icon icon="material-symbols:edit-outline-sharp"/>
        </el-icon>
      </el-button>
    </div>
    <!-- Phase 7：顶栏常驻全局搜索（所有页面可用；面板内可切收件箱/已发送范围）。 -->
    <email-search
      :store="activeSearchStore"
      :search-options="activeSearchOptions"
      :scopes="searchScopes"
      :scope="searchScope"
      :class="{ 'account-show': accountPanelShow }"
      @update:scope="searchScope = $event"
      @search="goToSearchList"
      @reset="goToSearchList"
    />
    <div class="toolbar">
      <!-- Phase 7：顶栏语言切换器（地球图标 + 下拉，8 语种原生名；复用设置页同一切换机制）。 -->
      <el-dropdown trigger="click" popper-class="header-lang-dropdown" @command="changeLang">
        <div class="icon-item lang-switcher" :title="t('lang.language')" :aria-label="t('lang.language')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.9 5.7 3.9 9s-1.4 6.4-3.9 9c-2.5-2.6-3.9-5.7-3.9-9S9.5 5.6 12 3z"/></svg>
          <span class="lang-label">{{ currentLocaleLabel }}</span>
          <span class="lang-caret">▾</span>
        </div>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-for="item in SUPPORTED_LOCALES"
              :key="item.short"
              :command="item.short"
              :class="{ 'is-active-lang': item.short === settingStore.lang }"
            >{{ item.label }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <!-- Phase 7：壁纸快捷入口（跳设置页壁纸区 #wallpaper，区块由壁纸同事建）。 -->
      <div
        class="icon-item"
        role="button"
        tabindex="0"
        :title="t('lang.wallpaper')"
        :aria-label="t('lang.wallpaper')"
        @click="goToWallpaper"
        @keyup.enter="goToWallpaper"
      >
        <Icon icon="akar-icons:image" width="20" height="20"/>
      </div>
      <el-dropdown
        ref="userDropdownRef"
        trigger="click"
        :teleported="false"
        popper-class="detail-dropdown"
        @visible-change="userCardVisible = $event"
      >
        <div class="avatar">
          <div class="avatar-text">
            <div>{{ formatName(userStore.user.email) }}</div>
          </div>
          <Icon class="setting-icon" icon="mingcute:down-small-fill" width="24" height="24"/>
        </div>
        <template #dropdown>
          <div class="user-details">
            <div class="details-avatar">
              {{ formatName(userStore.user.email) }}
            </div>
            <div class="user-name">
              {{ userStore.user.name }}
            </div>
            <div class="detail-email" @click="copyEmail(userStore.user.email)">
              {{ userStore.user.email }}
            </div>
            <div class="detail-user-type">
              <el-tag>{{ userStore.user.role.name }}</el-tag>
            </div>
            <div class="action-info">
              <div>
                <span style="margin-right: 10px">{{ $t('sendCount') }}</span>
                <span style="margin-right: 10px">{{ $t('accountCount') }}</span>
              </div>
              <div>
                <div>
                  <span v-if="sendCount" style="margin-right: 5px">{{ sendCount }}</span>
                  <el-tag v-if="!hasPerm('email:send')">{{ sendType }}</el-tag>
                  <el-tag v-else>{{ sendType }}</el-tag>
                </div>
                <div>
                  <el-tag v-if="settingStore.settings.manyEmail || settingStore.settings.addEmail">
                    {{ $t('disabled') }}
                  </el-tag>
                  <span v-else-if="accountCount && hasPerm('account:add')"
                        style="margin-right: 5px">{{ $t('totalUserAccount', {msg: accountCount}) }}</span>
                  <el-tag v-else-if="!accountCount && hasPerm('account:add')">{{ $t('unlimited') }}</el-tag>
                  <el-tag v-else-if="!hasPerm('account:add')">{{ $t('unauthorized') }}</el-tag>
                </div>
              </div>
            </div>
            <div class="logout">
              <el-button type="primary" :loading="logoutLoading" @click="clickLogout">{{ $t('logOut') }}</el-button>
            </div>
          </div>
        </template>
      </el-dropdown>
    </div>
  </div>
</template>

<script setup>
import router from "@/router";
import hanburger from '@/components/hamburger/index.vue'
import {logout} from "@/request/login.js";
import {Icon} from "@iconify/vue";
import {useUiStore} from "@/store/ui.js";
import {useUserStore} from "@/store/user.js";
import {useRoute} from "vue-router";
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from "vue";
import {useSettingStore} from "@/store/setting.js";
import {hasPerm} from "@/perm/perm.js"
import {useI18n} from "vue-i18n";
import {setExtend} from "@/utils/day.js"
import emailSearch from '@/components/email-search/index.vue'
import {useEmailStore} from '@/store/email.js'
import {useSendStore} from '@/store/send.js'
import i18n from "@/i18n/index.js";
import {SUPPORTED_LOCALES, SHORT_CODES, applyLocale, toStoredLocale} from "@/i18n/locale.js";
import {setLocale} from "@/request/my.js";

const {t} = useI18n();
const route = useRoute();
const settingStore = useSettingStore();
const userStore = useUserStore();
const uiStore = useUiStore();
const emailStore = useEmailStore()
const sendStore = useSendStore()
const logoutLoading = ref(false)
const userDropdownRef = ref(null)
const userCardVisible = ref(false)
const outsidePointerEvents = ['mousedown', 'pointerup', 'mouseup', 'click', 'pointercancel']
let blockOutsideClick = false
const inboxSearchOptions = computed(() => [
  {label: t('titleDesc'), type: 'subject'},
  {label: t('searchSummaryContent'), type: 'content'},
  {label: t('sender'), type: 'sender'},
  {label: t('searchSenderAddress'), type: 'senderAddress'},
])
const sentSearchOptions = computed(() => [
  {label: t('titleDesc'), type: 'subject'},
  {label: t('searchSummaryContent'), type: 'content'},
  {label: t('searchRecipientAddress'), type: 'recipientAddress'},
])
const accountPanelShow = computed(() => uiStore.accountShow && hasPerm('account:query'))

// Phase 7：顶栏全局搜索范围（收件箱/已发送），默认跟随当前路由；
// 面板内切换范围只换 store，不跳页，真正搜索/重置时再跳到对应列表。
const searchScope = ref(route.meta.name === 'send' || isMailboxDetail('sent') ? 'sent' : 'inbox')
const searchScopes = computed(() => [
  {label: t('search.scopeInbox'), value: 'inbox'},
  {label: t('search.scopeSent'), value: 'sent'},
])
const activeSearchStore = computed(() => searchScope.value === 'sent' ? sendStore : emailStore)
const activeSearchOptions = computed(() => searchScope.value === 'sent' ? sentSearchOptions.value : inboxSearchOptions.value)

function isMailboxDetail(mailbox) {
  return route.meta.name === 'content' && route.params.mailbox === mailbox
}

watch(
  () => [route.name, route.params.mailbox],
  () => {
    if (route.meta.name === 'send' || isMailboxDetail('sent')) {
      searchScope.value = 'sent'
    } else if (route.meta.name === 'email' || isMailboxDetail('inbox')) {
      searchScope.value = 'inbox'
    }
  }
)

function goToSearchList() {
  const listName = searchScope.value === 'sent' ? 'send' : 'email'
  if (route.name !== listName) {
    router.push({name: listName})
  }
}

const accountCount = computed(() => {
  return userStore.user.role.accountCount
})

const sendType = computed(() => {

  if (settingStore.settings.send === 1) {
    return t('disabled')
  }

  if (!hasPerm('email:send')) {
    return t('unauthorized')
  }

  if (userStore.user.role.sendType === 'ban') {
    return t('sendBanned')
  }

  if (userStore.user.role.sendType === 'internal') {
    return t('sendInternal')
  }

  if (!userStore.user.role.sendCount) {
    return t('unlimited')
  }

  if (userStore.user.role.sendType === 'day') {
    return t('daily')
  }

  if (userStore.user.role.sendType === 'count') {
    return t('total')
  }
})

const sendCount = computed(() => {


  if (!hasPerm('email:send')) {
    return null
  }

  if (userStore.user.role.sendType === 'ban') {
    return null
  }

  if (userStore.user.role.sendType === 'internal') {
    return null
  }

  if (!userStore.user.role.sendCount) {
    return null
  }

  if (settingStore.settings.send === 1) {
    return null
  }

  return userStore.user.sendCount + '/' + userStore.user.role.sendCount
})

async function copyEmail(email) {
  try {
    await navigator.clipboard.writeText(email);
    ElMessage({
      message: t('copySuccessMsg'),
      type: 'success',
      plain: true,
    })
  } catch (err) {
    console.error(`${t('copyFailMsg')}:`, err);
    ElMessage({
      message: t('copyFailMsg'),
      type: 'error',
      plain: true,
    })
  }
}

// Phase 7：顶栏语言切换器（8 语种即时生效；复用设置页同一机制：
// applyLocale 懒加载文案 + 写本地 mail-locale，setLocale 同步后端 user.locale）。
const currentLocaleLabel = computed(() => {
  const found = SUPPORTED_LOCALES.find(item => item.short === settingStore.lang)
  return found ? found.label : '简体中文'
})

function changeLang(lang) {
  if (!SHORT_CODES.includes(lang) || lang === settingStore.lang) {
    return
  }
  // dayjs 相对时间只内置 zh-cn/en（与旧 changeLang 保持一致）。
  setExtend(lang === 'en' ? 'en' : 'zh-cn')
  applyLocale(i18n, settingStore, lang)
  // 已登录态同步到后端 user.locale；失败静默，下次登录时再同步。
  setLocale(toStoredLocale(lang)).catch(() => {
  })
}

// Phase 7：壁纸快捷入口——跳设置页壁纸区（id="wallpaper" 由壁纸同事建）。
async function goToWallpaper() {
  if (route.name !== 'setting') {
    await router.push({name: 'setting'})
    await nextTick()
  }
  try {
    window.location.hash = 'wallpaper'
  } catch (e) {
  }
  scrollToWallpaper(0)
}

function scrollToWallpaper(attempt) {
  const el = document.getElementById('wallpaper')
  if (el) {
    el.scrollIntoView({behavior: 'smooth', block: 'start'})
    return
  }
  // 壁纸区尚未挂载时重试；10 次后放弃，不报错。
  if (attempt < 10) {
    setTimeout(() => scrollToWallpaper(attempt + 1), 200)
  }
}

function openSend() {
  uiStore.writerRef.open()
}

function changeAside() {
  uiStore.asideShow = !uiStore.asideShow
}

function clickLogout() {
  logoutLoading.value = true
  logout().then(() => {
    localStorage.removeItem("token")
    router.replace('/login')
  }).finally(() => {
    logoutLoading.value = false
  })
}

function formatName(email) {
  return email[0]?.toUpperCase() || ''
}

function isInsideUserCard(target) {
  const element = target instanceof Element ? target : target?.parentElement
  if (!(element instanceof Element)) return false
  if (userDropdownRef.value?.$el?.contains(element)) return true
  return !!element.closest('.detail-dropdown')
}

function handleUserCardPointerDown(event) {
  blockOutsideClick = userCardVisible.value && !isInsideUserCard(event.target)
  if (!blockOutsideClick) return

  event.preventDefault()
  event.stopPropagation()
  userDropdownRef.value?.handleClose()
}

function handleUserCardPointerEvent(event) {
  if (!blockOutsideClick) return
  event.preventDefault()
  event.stopPropagation()
  if (event.type === 'pointerup' || event.type === 'pointercancel') {
    setTimeout(() => {
      blockOutsideClick = false
    })
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', handleUserCardPointerDown, true)
  outsidePointerEvents.forEach(type => {
    document.addEventListener(type, handleUserCardPointerEvent, true)
  })
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleUserCardPointerDown, true)
  outsidePointerEvents.forEach(type => {
    document.removeEventListener(type, handleUserCardPointerEvent, true)
  })
})

</script>
<style>
.detail-dropdown {
  color: var(--el-text-color-primary) !important;
}

.header-lang-dropdown .is-active-lang {
  color: var(--el-color-primary);
  font-weight: 700;
}
</style>
<style lang="scss" scoped>

:deep(.el-popper.is-pure) {
  border-radius: 6px;
}

.user-details {
  width: 250px;
  font-size: 14px;
  display: grid;
  grid-template-columns: 1fr;
  justify-items: center;

  .user-name {
    font-weight: bold;
    margin-top: 10px;
    padding-left: 20px;
    padding-right: 20px;
    width: 250px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    text-align: center;
  }

  .detail-user-type {
    margin-top: 10px;
  }

  .action-info {
    width: 100%;
    display: grid;
    grid-template-columns: auto auto;
    margin-top: 10px;

    > div:first-child {
      display: grid;
      align-items: center;
      gap: 10px;
    }

    > div:last-child {
      display: grid;
      gap: 10px;
      text-align: center;

      > div {
        display: flex;
        align-items: center;
      }
    }
  }

  .detail-email {
    padding-left: 20px;
    padding-right: 20px;
    width: 250px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    text-align: center;
    color: var(--regular-text-color);
    cursor: pointer;
  }

  .logout {
    margin-top: 20px;
    width: 100%;
    padding-left: 10px;
    padding-right: 10px;
    padding-bottom: 10px;

    .el-button {
      border-radius: 6px;
      height: 28px;
      width: 100%;
    }
  }

  .details-avatar {
    margin-top: 20px;
    height: 40px;
    width: 40px;
    background: var(--el-bg-color);
    color: var(--el-text-color-primary);
    border: 1px solid var(--dark-border);
    font-size: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
  }
}


.header {
  text-align: right;
  font-size: 12px;
  display: grid;
  height: 100%;
  gap: 10px;
  grid-template-columns: auto 1fr;
  position: relative;
}

@media (max-width: 767px) {
  .header {
    display: flex;
    align-items: center;
  }

  .header-btn {
    flex: 1;
  }

  .toolbar {
    flex-shrink: 0;
  }
}

.writer-box {
  display: none;

  @media (max-width: 767px) {
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-left: 0;
    flex-shrink: 0;

    .writer {
      width: 32px;
      height: 32px;
      padding: 0;
      border: none;
      background: transparent;
      box-shadow: none;
      --el-button-bg-color: transparent;
      --el-button-border-color: transparent;
      --el-button-hover-bg-color: transparent;
      --el-button-hover-border-color: transparent;
      --el-button-active-bg-color: transparent;
      --el-button-active-border-color: transparent;
      --el-button-outline-color: transparent;
    }
  }
}

.header-btn {
  display: inline-flex;
  align-items: center;
  height: 100%;
  min-width: 0;
}

.breadcrumb-item {
  font-weight: bold;
  font-size: 14px;
  color: var(--el-text-color-primary);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.toolbar {
  display: flex;
  justify-content: end;
  align-items: center;
  gap: 15px;
  @media (max-width: 767px) {
    gap: 10px;
  }

  .icon-item {
    align-self: center;
    width: 30px;
    height: 30px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  .icon-item:hover {
    background: var(--base-fill);
  }

  .lang-switcher {
    width: auto;
    padding: 0 8px;
    gap: 4px;
    font-size: 13px;
    color: var(--el-text-color-primary);
    white-space: nowrap;

    .lang-label {
      max-width: 76px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .lang-caret {
      font-size: 10px;
      color: var(--el-text-color-secondary);
    }
  }

  @media (max-width: 767px) {
    .lang-switcher .lang-label,
    .lang-switcher .lang-caret {
      display: none;
    }
  }

  .avatar {
    display: flex;
    align-items: center;
    cursor: pointer;

    .avatar-text {
      box-sizing: border-box;
      background: var(--el-bg-color);
      color: var(--el-text-color-primary);
      height: 32px;
      width: 32px;
      display: flex;
      justify-content: center;
      align-items: center;
      border-radius: 8px;
      border: 1px solid var(--dark-border);
    }

    .setting-icon {
      position: relative;
      top: 0;
      margin-right: 10px;
      bottom: 10px;
    }
  }

}

.el-tooltip__trigger:first-child:focus-visible {
  outline: unset;
}
</style>
