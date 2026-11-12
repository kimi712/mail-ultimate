<template>
  <div ref="rootRef" class="feature-search">
    <div class="fs-placeholder" @click="openPanel">
      <!-- 两个搜索一眼区分：功能搜索 = 放大镜 + 小齿轮（灰底角标）；邮件搜索是放大镜 + 小信封。 -->
      <span class="search-badge-icon" aria-hidden="true">
        <Icon icon="akar-icons:search" width="18" height="18" />
        <span class="search-badge search-badge-gear"><Icon icon="material-symbols:settings" width="9" height="9" /></span>
      </span>
      <span class="fs-placeholder-text">{{ t('featureSearchPlaceholder') }}</span>
    </div>
    <el-button
      class="fs-mobile-btn"
      size="default"
      :aria-label="t('featureSearchPlaceholder')"
      :aria-expanded="open"
      @click="openPanel"
    >
      <span class="search-badge-icon" aria-hidden="true">
        <Icon icon="akar-icons:search" width="20" height="20" />
        <span class="search-badge search-badge-gear"><Icon icon="material-symbols:settings" width="9" height="9" /></span>
      </span>
    </el-button>
    <Transition name="fs-panel-fade" @after-enter="focusInput">
      <div v-if="open" class="fs-panel-shell" @click.stop>
        <el-card class="fs-panel" shadow="always">
          <div class="fs-panel-title">
            <span class="search-badge-icon" aria-hidden="true">
              <Icon icon="akar-icons:search" width="18" height="18" />
              <span class="search-badge search-badge-gear"><Icon icon="material-symbols:settings" width="9" height="9" /></span>
            </span>
            <span>{{ t('featureSearchTitle') }}</span>
          </div>
          <div class="fs-panel-hint">{{ t('featureSearchHint') }}</div>
          <div class="fs-input">
            <el-input
              ref="inputRef"
              v-model="query"
              autocomplete="off"
              :placeholder="t('featureSearchPlaceholder')"
              clearable
              @input="onInput"
              @keydown="onKeydown"
            >
              <template #prefix>
                <Icon icon="akar-icons:search" width="16" height="16" />
              </template>
            </el-input>
          </div>
          <div class="fs-results">
            <div v-if="!filtered.length" class="fs-empty">{{ t('featureSearchNoResults') }}</div>
            <div
              v-for="(item, idx) in filtered"
              :key="item.id"
              class="fs-item"
              :class="{ active: idx === activeIndex }"
              @click="go(item)"
              @mouseenter="activeIndex = idx"
            >
              <span class="fs-item-title">{{ t(item.titleKey) }}</span>
              <span class="fs-item-page">{{ t(item.pageKey) }}</span>
            </div>
          </div>
        </el-card>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { useUiStore } from '@/store/ui.js'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const uiStore = useUiStore()

const rootRef = ref(null)
const inputRef = ref(null)
const open = ref(false)
const query = ref('')
const activeIndex = ref(0)

// 功能索引：titleKey / pageKey 走 i18n（跟随语言切换），keywords 只做匹配用（含中英文）。
const ITEMS = [
  // 顶级页面
  { id: 'page-inbox', titleKey: 'inbox', pageKey: 'inbox', route: 'email', keywords: ['收件箱', '收信', 'inbox', 'mail'] },
  { id: 'page-sent', titleKey: 'sent', pageKey: 'sent', route: 'send', keywords: ['已发送', '发件', 'sent'] },
  { id: 'page-draft', titleKey: 'drafts', pageKey: 'drafts', route: 'draft', keywords: ['草稿', 'draft'] },
  { id: 'page-star', titleKey: 'starred', pageKey: 'starred', route: 'star', keywords: ['星标', '收藏', 'starred', 'star'] },
  { id: 'page-spam', titleKey: 'spam', pageKey: 'spam', route: 'spam', keywords: ['垃圾邮件', 'spam', 'junk'] },
  { id: 'page-setting', titleKey: 'settings', pageKey: 'settings', route: 'setting', keywords: ['设置', '个人设置', 'settings', 'preferences'] },
  { id: 'page-security', titleKey: 'securityCenter', pageKey: 'securityCenter', route: 'security', keywords: ['安全中心', '安全', 'security'] },
  { id: 'page-privacy', titleKey: 'privacyDashboard', pageKey: 'privacyDashboard', route: 'privacy', keywords: ['隐私仪表盘', '隐私', 'privacy'] },
  { id: 'page-contacts', titleKey: 'contactsTitle', pageKey: 'contactsTitle', route: 'contacts', keywords: ['联系人', '通讯录', 'contacts'] },
  { id: 'page-rules', titleKey: 'mailRulesTitle', pageKey: 'mailRulesTitle', route: 'mail-rules', keywords: ['邮件规则', '规则', 'rules', 'filter'] },
  { id: 'page-compose', titleKey: 'compose', pageKey: 'compose', action: 'compose', keywords: ['写信', '撰写', '新邮件', 'compose', 'write'] },
  // 设置页各大项
  { id: 'set-profile', titleKey: 'profile', pageKey: 'settings', route: 'setting', anchor: 'sec-profile', keywords: ['账户与密码', '账号', '用户名', '修改密码', '密码', 'account', 'password', 'username'] },
  { id: 'set-recovery', titleKey: 'recoverySection', pageKey: 'settings', route: 'setting', anchor: 'sec-recovery', keywords: ['账号恢复', '备用邮箱', '恢复码', 'recovery', 'backup email', 'recovery code'] },
  { id: 'set-forward', titleKey: 'forwardSection', pageKey: 'settings', route: 'setting', anchor: 'sec-forward', keywords: ['新邮件通知转发', '转发', '转发邮箱', 'forward', 'forwarding'] },
  { id: 'set-telegram', titleKey: 'tgUserSection', pageKey: 'settings', route: 'setting', anchor: 'sec-telegram', keywords: ['Telegram 通知', 'Telegram', 'TG', '绑定', 'telegram', 'bind'] },
  { id: 'set-alias', titleKey: 'aliasSection', pageKey: 'settings', route: 'setting', anchor: 'sec-alias', keywords: ['一次性别名', '别名', 'alias', 'disposable'] },
  { id: 'set-language', titleKey: 'language', pageKey: 'settings', route: 'setting', anchor: 'sec-language', keywords: ['语言', '语言环境', 'language'] },
  { id: 'set-theme', titleKey: 'themeStyle', pageKey: 'settings', route: 'setting', anchor: 'sec-theme', keywords: ['主题样式', '主题', 'theme'] },
  { id: 'set-density', titleKey: 'densitySetting', pageKey: 'settings', route: 'setting', anchor: 'sec-density', keywords: ['布局密度', '密度', 'density', 'layout'] },
  { id: 'set-notice-setting', titleKey: 'noticeSetting', pageKey: 'settings', route: 'setting', anchor: 'sec-notice-setting', keywords: ['通知', '通知设置', 'notifications'] },
  { id: 'set-timezone', titleKey: 'timeZoneSetting', pageKey: 'settings', route: 'setting', anchor: 'sec-timezone', keywords: ['时区', 'time zone', 'timezone'] },
  { id: 'set-shortcuts', titleKey: 'shortcutsSetting', pageKey: 'settings', route: 'setting', anchor: 'sec-shortcuts', keywords: ['键盘快捷键', '快捷键', 'shortcuts', 'keyboard'] },
  { id: 'set-notice', titleKey: 'noticeTitle', pageKey: 'settings', route: 'setting', anchor: 'sec-notice', keywords: ['系统公告', '公告', 'announcements'] },
  { id: 'set-loginlog', titleKey: 'loginLogTitle', pageKey: 'settings', route: 'setting', anchor: 'sec-loginlog', keywords: ['登录记录', '登录日志', 'sign-in history', 'login log'] },
  { id: 'set-wallpaper', titleKey: 'wallpaper.title', pageKey: 'settings', route: 'setting', anchor: 'wallpaper', keywords: ['壁纸', 'wallpaper', 'background'] },
  { id: 'set-delete', titleKey: 'deleteUser', pageKey: 'settings', route: 'setting', anchor: 'sec-delete', keywords: ['删除账户', '删除账号', '注销', 'delete account'] },
  // 安全中心各分区
  { id: 'sec-score', titleKey: 'securityScore', pageKey: 'securityCenter', route: 'security', anchor: 'sec-score', keywords: ['安全评分', '评分', 'security score'] },
  { id: 'sec-sessions', titleKey: 'sessionTitle', pageKey: 'securityCenter', route: 'security', anchor: 'sec-sessions', keywords: ['设备管理', '设备', '会话', 'devices', 'sessions'] },
  { id: 'sec-loginhistory', titleKey: 'loginLogTitle', pageKey: 'securityCenter', route: 'security', anchor: 'sec-login-history', keywords: ['登录历史', '登录记录', 'sign-in history'] },
  { id: 'sec-audit', titleKey: 'securityAuditTitle', pageKey: 'securityCenter', route: 'security', anchor: 'sec-audit', keywords: ['审计记录', '审计', 'audit'] },
  { id: 'sec-totp', titleKey: 'totpTitle', pageKey: 'securityCenter', route: 'security', anchor: 'sec-totp', keywords: ['TOTP', '二次验证', 'two-factor', '2fa'] },
  { id: 'sec-passkey', titleKey: 'passkeyTitle', pageKey: 'securityCenter', route: 'security', anchor: 'sec-passkey', keywords: ['Passkey', '通行密钥', 'passkey'] },
  { id: 'sec-loginalert', titleKey: 'securityLoginAlert', pageKey: 'securityCenter', route: 'security', anchor: 'sec-login-alert', keywords: ['登录提醒', '提醒开关', 'sign-in alerts'] },
  { id: 'sec-retention', titleKey: 'securityRetention', pageKey: 'securityCenter', route: 'security', anchor: 'sec-retention', keywords: ['数据保留期限', '保留期限', 'retention'] },
  { id: 'sec-e2ee', titleKey: 'e2eeTitle', pageKey: 'securityCenter', route: 'security', anchor: 'sec-e2ee', keywords: ['端到端加密', '加密', 'E2EE', 'encryption'] },
  { id: 'sec-mlkem', titleKey: 'mlkemTitle', pageKey: 'securityCenter', route: 'security', anchor: 'sec-mlkem', keywords: ['抗量子密钥', '抗量子', '量子', 'ML-KEM', 'post-quantum'] },
  { id: 'sec-deadman', titleKey: 'deadmanTitle', pageKey: 'securityCenter', route: 'security', anchor: 'sec-deadman', keywords: ['死亡开关', 'dead man', 'deadman'] },
  { id: 'sec-duress', titleKey: 'duressTitle', pageKey: 'securityCenter', route: 'security', anchor: 'sec-duress', keywords: ['胁迫密码', '胁迫', 'duress'] },
  { id: 'sec-shamir', titleKey: 'shamirTitle', pageKey: 'securityCenter', route: 'security', anchor: 'sec-shamir', keywords: ['密钥分片', 'Shamir', '分片', 'shards'] },
  { id: 'sec-zk', titleKey: 'zkTitle', pageKey: 'securityCenter', route: 'security', anchor: 'sec-zk', keywords: ['零知识身份', '零知识', 'zero-knowledge', 'zk'] },
  { id: 'sec-autolock', titleKey: 'securityAutoLock', pageKey: 'securityCenter', route: 'security', anchor: 'sec-autolock', keywords: ['闲置自动锁定', '自动锁定', 'auto-lock'] },
  { id: 'sec-mydata', titleKey: 'securityMyData', pageKey: 'securityCenter', route: 'security', anchor: 'sec-mydata', keywords: ['我的数据', '数据导出', 'my data', 'export'] },
  { id: 'sec-canary', titleKey: 'canarySection', pageKey: 'securityCenter', route: 'security', anchor: 'sec-canary', keywords: ['透明度与金丝雀', '金丝雀', 'canary', 'transparency'] },
  { id: 'sec-donate', titleKey: 'donateSection', pageKey: 'securityCenter', route: 'security', anchor: 'sec-donate', keywords: ['支持我们', '捐赠', 'DOGE', 'donate', 'donation'] },
  // 写信功能（打开写信窗口）
  { id: 'compose-expire', titleKey: 'expireBurnTag', pageKey: 'compose', action: 'compose', keywords: ['有效期', '阅后即焚', '自毁', 'expire', 'burn after reading', 'self-destruct'] },
  { id: 'compose-timelock', titleKey: 'timelockTitle', pageKey: 'compose', action: 'compose', keywords: ['时间锁', '时间锁加密', 'timelock', 'time-lock'] },
  { id: 'compose-deniable', titleKey: 'deniableLabel', pageKey: 'compose', action: 'compose', keywords: ['可否认认证', '可否认', 'deniable'] },
  { id: 'compose-stego', titleKey: 'stegoTitle', pageKey: 'compose', action: 'compose', keywords: ['隐写术', '隐写', 'steganography', 'stego'] },
  { id: 'compose-schedule', titleKey: 'trust.scheduleSend', pageKey: 'compose', action: 'compose', keywords: ['定时发送', '定时', 'schedule send'] },
]

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return ITEMS
  return ITEMS.filter((item) => {
    const hay = [t(item.titleKey), t(item.pageKey), ...item.keywords].join(' ').toLowerCase()
    return hay.includes(q)
  })
})

function openPanel() {
  open.value = true
}

function closePanel() {
  open.value = false
}

function focusInput() {
  inputRef.value?.focus()
}

function onInput() {
  activeIndex.value = 0
}

function onKeydown(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = Math.min(activeIndex.value + 1, filtered.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = Math.max(activeIndex.value - 1, 0)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const item = filtered.value[activeIndex.value]
    if (item) go(item)
  } else if (e.key === 'Escape') {
    closePanel()
  }
}

// 同页跳转：布局已稳定，立即滚（找不到元素时重试 10 次）。
function scrollToAnchor(anchor, attempt = 0) {
  if (!anchor) return
  const el = document.getElementById(anchor)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }
  if (attempt < 10) {
    setTimeout(() => scrollToAnchor(anchor, attempt + 1), 200)
  }
}

// 跨页跳转（第三轮，确定性方案）：顶栏不再自己滚动、也不再猜"布局何时稳定"。
// 两轮失败的教训：安全中心 onMounted 一次发 10 个请求分波回来，offsetTop 稳定采样
// 会被数据波之间的空隙骗过，滚完迟到的数据又把分区顶出视口。根治办法是把滚动权
// 交给目标页：锚点经路由 query 传过去，目标页等自己的请求全落定后再滚一次
//（见 src/utils/anchor-scroll.js）。同页跳转布局已稳定，保持 scrollToAnchor 不动。

function go(item) {
  closePanel()
  if (item.action === 'compose') {
    uiStore.writerRef?.open?.()
    return
  }
  if (!item.route) return
  if (route.name === item.route) {
    // 同页：布局已稳定，直接滚；同时清掉可能残留的上一次跨页 anchor，
    // 避免目标页待处理的 query 滚动把它抢回去。
    scrollToAnchor(item.anchor)
    if (route.query.anchor) {
      const nextQuery = { ...route.query }
      delete nextQuery.anchor
      router.replace({ query: nextQuery })
    }
    return
  }
  // 跨页：锚点经路由 query 传给目标页，目标页等自己的数据全落定后再滚一次。
  router.push({ name: item.route, query: item.anchor ? { anchor: item.anchor } : {} })
}

function handleDocumentClick(event) {
  if (!open.value) return
  if (rootRef.value?.contains(event.target)) return
  // 只关闭面板，不拦截点击（此前邮件搜索面板曾因 preventDefault 吞点击导致顶栏按钮点了没反应）。
  closePanel()
}

function handleDocumentKeydown(event) {
  if (event.key === 'Escape' && open.value) {
    closePanel()
  }
}

onMounted(() => {
  document.addEventListener('click', handleDocumentClick, true)
  document.addEventListener('keydown', handleDocumentKeydown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick, true)
  document.removeEventListener('keydown', handleDocumentKeydown, true)
})
</script>

<style lang="scss" scoped>
.feature-search {
  /* 流式布局：跟在邮件搜索框后面排布，不再 absolute left: 552px
    （邮件搜索框宽度随标题/页面变化，固定 552px 会与它重叠或留大缝）。
    relative 仍是下拉面板的定位基准。 */
  position: relative;
  z-index: 10;
  flex: 0 0 240px;
  height: 36px;

  @media (max-width: 1280px) {
    flex-basis: 220px;
  }

  @media (max-width: 1279px) {
    display: none;
  }
}

.fs-placeholder {
  width: 100%;
  height: 36px;
  border-radius: 6px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  text-align: left;
  white-space: nowrap;
  cursor: text;
}

.fs-placeholder-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 14px;
}

/* 两个搜索一眼区分：功能搜索 = 放大镜 + 小齿轮（灰底角标）；邮件搜索是放大镜 + 小信封（蓝底角标）。 */
.search-badge-icon {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
}

.search-badge {
  position: absolute;
  right: -5px;
  bottom: -4px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  border: 1.5px solid var(--el-bg-color);
  box-sizing: border-box;
}

.search-badge-mail {
  background: var(--el-color-primary);
}

.search-badge-gear {
  background: #7c8698;
}

/* 面板顶标题 + 提示：点开后也一眼知道这是搜功能的，搜到点一下就跳过去。 */
.fs-panel-title {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 12px 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}

.fs-panel-hint {
  padding: 4px 12px 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.fs-mobile-btn {
  display: none;
}

@media (max-width: 767px) {
  .feature-search {
    position: static;
    transform: none;
    /* 桌面端 flex-basis 是 240px，移动端必须同时改 flex-basis
       （只改 width 会被 flex-basis 盖掉）。 */
    flex: 0 0 32px;
    width: 32px;
    height: 32px;
    display: block;
  }

  .fs-placeholder {
    display: none;
  }

  .fs-mobile-btn {
    display: inline-flex;
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

  .feature-search .fs-panel-shell {
    top: calc(100% + 8px);
    left: 50%;
    right: auto;
    width: min(420px, calc(100vw - 30px));
    translate: -50% 0;
  }
}

.fs-panel-shell {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 1001;
  width: 340px;
  background: var(--el-bg-color-overlay, var(--el-bg-color, #ffffff));
  border-radius: 6px;
}

.fs-panel {
  width: 100%;
}

.fs-input {
  margin-bottom: 8px;
}

.fs-results {
  max-height: 320px;
  overflow-y: auto;
}

.fs-empty {
  padding: 12px 10px;
  color: var(--el-text-color-secondary);
  font-size: 14px;
  text-align: center;
}

.fs-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;

  &.active {
    background: var(--el-fill-color-light);
  }
}

.fs-item-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--el-text-color-primary);
}

.fs-item-page {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
