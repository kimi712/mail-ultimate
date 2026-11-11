<template>
  <div ref="searchRef" class="email-search">
    <div class="search-placeholder" @click="openSearch">
      <!-- 两个搜索一眼区分：邮件搜索 = 放大镜 + 小信封（蓝底角标）。 -->
      <span class="search-badge-icon" aria-hidden="true">
        <Icon icon="akar-icons:search" width="20" height="20"/>
        <span class="search-badge search-badge-mail"><Icon icon="material-symbols:mail-outline" width="9" height="9"/></span>
      </span>
      <span class="search-placeholder-text" :class="{ 'has-search-text': savedSearchSummary }" :title="savedSearchSummary">
        {{ savedSearchSummary || t('searchMail') }}
      </span>
    </div>
    <el-button
      class="mobile-search-button"
      size="default"
      :aria-label="t('searchMail')"
      :aria-expanded="visible"
      @click="openSearch"
    >
      <span class="search-badge-icon" aria-hidden="true">
        <Icon icon="akar-icons:search" width="20" height="20"/>
        <span class="search-badge search-badge-mail"><Icon icon="material-symbols:mail-outline" width="9" height="9"/></span>
      </span>
    </el-button>
    <Transition name="search-panel-fade" @after-enter="focusInputOnDesktop">
      <div v-if="visible" class="search-panel-shell" @click.stop>
        <el-card class="search-panel" shadow="always">
          <div class="search-panel-title">
            <span class="search-badge-icon" aria-hidden="true">
              <Icon icon="akar-icons:search" width="18" height="18"/>
              <span class="search-badge search-badge-mail"><Icon icon="material-symbols:mail-outline" width="9" height="9"/></span>
            </span>
            <span>{{ t('searchMail') }}</span>
          </div>
          <div class="search-input">
            <el-input
              ref="inputRef"
              v-model="searchText"
              autocomplete="off"
              :placeholder="searchPlaceholder"
              @keyup.enter="handleSearch"
            />
          </div>
          <div class="search-content">
            <div v-if="props.scopes.length > 1" class="search-scope">
              <div class="search-content-title">{{ t('search.scope') }}</div>
              <div class="custom-style">
                <el-segmented
                  :model-value="props.scope"
                  :options="props.scopes"
                  :props="{ label: 'label', value: 'value' }"
                  @change="$emit('update:scope', $event)"
                />
              </div>
            </div>
            <div class="search-content-title">{{ t('searchType') }}</div>
            <div class="custom-style">
              <el-segmented
                v-model="searchType"
                :options="searchOptions"
                :props="{ label: 'label', value: 'type' }"
              />
            </div>
            <div class="search-date-range">
              <div class="search-date-field">
                <div class="search-date-label">{{ t('searchDateFrom') }}</div>
                <el-date-picker
                  v-model="startDate"
                  type="date"
                  :editable="false"
                  value-format="YYYY-MM-DD"
                  :placeholder="t('searchStartDate')"
                />
              </div>
              <div class="search-date-field">
                <div class="search-date-label">{{ t('searchDateTo') }}</div>
                <el-date-picker
                  v-model="endDate"
                  type="date"
                  :editable="false"
                  value-format="YYYY-MM-DD"
                  :placeholder="t('searchEndDate')"
                  :disabled-date="disableEndDate"
                />
              </div>
            </div>
          </div>
          <div class="search-actions">
            <el-button @click="handleReset">{{ t('reset') }}</el-button>
            <el-button type="primary" @click="handleSearch">{{ t('searchBtn') }}</el-button>
          </div>
        </el-card>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import { formatDate } from '@/utils/datetime.js'
import {Icon} from '@iconify/vue'
import {useI18n} from 'vue-i18n'

const {t} = useI18n()
const emit = defineEmits(['search', 'reset', 'update:scope'])
const props = defineProps({
  store: {
    type: Object,
    required: true,
  },
  searchOptions: {
    type: Array,
    required: true,
  },
  // Phase 7：文件夹范围（顶栏全局搜索用）。不传则不显示范围选择，保持原有单文件夹行为。
  scopes: {
    type: Array,
    default: () => [],
  },
  scope: {
    type: String,
    default: '',
  },
})

const searchRef = ref(null)
const inputRef = ref(null)
const searchText = ref('')
const searchType = ref('subject')
const startDate = ref('')
const endDate = ref('')
const visible = ref(false)
const selectedSearchOption = computed(() =>
  props.searchOptions.find(option => option.type === searchType.value)
)
const savedSearchSummary = computed(() => {
  const params = props.store.searchParams
  const parts = []
  const text = params.text?.trim()
  const fieldKeys = {
    subject: 'searchSummarySubject',
    content: 'searchSummaryContent',
    sender: 'searchSummarySender',
    senderAddress: 'searchSummarySenderAddress',
    recipientAddress: 'searchSummaryRecipientAddress',
  }

  if (text) {
    parts.push(`${t(fieldKeys[params.type] || fieldKeys.subject)}:${text}`)
  }
  if (params.startDate && params.endDate) {
    parts.push(`${formatSummaryDate(params.startDate)} ${t('searchSummaryRange')} ${formatSummaryDate(params.endDate)}`)
  } else if (params.startDate) {
    parts.push(`${t('searchSummaryAfter')}:${formatSummaryDate(params.startDate)}`)
  } else if (params.endDate) {
    parts.push(`${t('searchSummaryBefore')}:${formatSummaryDate(params.endDate)}`)
  }
  return parts.join('\u00a0\u00a0')
})
const searchPlaceholder = computed(() =>
  t('searchMailBy', {field: selectedSearchOption.value?.label || t('titleDesc')})
)

watch(
  () => props.searchOptions,
  options => {
    if (!options.some(option => option.type === searchType.value)) {
      searchType.value = options[0]?.type || 'subject'
    }
  },
  {immediate: true}
)

// Phase 7：顶栏切文件夹范围时 store 随之更换，从新 store 恢复该文件夹已存的搜索条件。
watch(
  () => props.store,
  () => {
    restoreSavedSearch()
  }
)

watch(startDate, value => {
  if (value && endDate.value && endDate.value < value) {
    endDate.value = ''
  }
})

function openSearch() {
  if (visible.value) {
    closeSearch()
    return
  }

  restoreSavedSearch()
  visible.value = true
}

function focusInput() {
  inputRef.value?.focus()
}

function focusInputOnDesktop() {
  if (!window.matchMedia('(max-width: 1024px)').matches) {
    focusInput()
  }
}

function disableEndDate(date) {
  if (!startDate.value) return false

  const start = new Date(`${startDate.value}T00:00:00`)
  return date < start
}

function closeSearch() {
  visible.value = false
  restoreSavedSearch()
}

function restoreSavedSearch() {
  const params = props.store.searchParams
  searchText.value = params.text || ''
  searchType.value = props.searchOptions.some(option => option.type === params.type)
    ? params.type
    : props.searchOptions[0]?.type || 'subject'
  startDate.value = toLocalSearchDate(params.startDate)
  endDate.value = toLocalSearchDate(params.endDate)
}

function toLocalSearchDate(dateValue) {
  if (!dateValue) return ''

  const date = new Date(`${dateValue.replace(' ', 'T')}Z`)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatSummaryDate(dateValue) {
  // 搜索摘要里的日期按当前 locale 显示（之前写死 YYYY-MM-DD）
  return formatDate(dateValue)
}

function handleDocumentKeydown(event) {
  if (event.key === 'Escape' && visible.value) {
    closeSearch()
  }
}

function handleDocumentClick(event) {
  const target = event.target
  const isDatePickerPopup = target?.closest?.(
    '.el-picker__popper, .el-picker-panel'
  )

  if (
    !visible.value
    || searchRef.value?.contains(target)
    || isDatePickerPopup
  ) {
    return
  }

  // 任务 3（2026-11-08）：只关闭面板，不拦截点击。
  // 此前这里 preventDefault + stopPropagation 会在捕获阶段吞掉面板外一切点击——
  // 搜索面板开着时点顶栏 AI 按钮，点击到不了按钮，AI 面板打不开（用户报“点了没反应”）。
  // 改成只 closeSearch()，让本次点击继续传到目标按钮（AI 打开、面板同时关闭）。
  closeSearch()
}

function formatSearchDate(dateValue, endOfDay = false) {
  if (!dateValue) return ''

  const [year, month, day] = dateValue.split('-').map(Number)
  const localDate = new Date(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
  )

  return localDate.toISOString().slice(0, 19).replace('T', ' ')
}

function handleSearch() {
  props.store.setSearchParams({
    text: searchText.value.trim(),
    type: searchType.value,
    startDate: formatSearchDate(startDate.value),
    endDate: formatSearchDate(endDate.value, true),
  })
  emit('search', searchText.value.trim(), searchType.value)
  closeSearch()
}

function handleReset() {
  searchText.value = ''
  searchType.value = 'subject'
  startDate.value = ''
  endDate.value = ''
  props.store.setSearchParams({
    text: '',
    type: 'subject',
    startDate: '',
    endDate: '',
  })
  emit('reset')
  closeSearch()
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
.email-search {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 10;
  /* 任务 2：面板加宽到 520px，四段分段器 + 两个日期选择器不再挤。 */
  width: min(520px, calc(100% - 20px));
  height: 36px;
  @media (max-width: 1280px) {
    width: min(450px, calc(100% - 20px));
  }
  @media (max-width: 1080px) {
    width: min(400px, calc(100% - 20px));
  }
}

@media (min-width: 768px) {
  .email-search.account-show {
    left: 259px;
  }
}

/* account-show（收件箱/已发送/邮件详情页，左侧有 259px 账号栏）时收窄：
   此前宽度不变（520px），右沿伸到 779px，与左侧 536px 起的功能搜索框重叠
   240px——功能框盖在上面，把邮件框里伸过 536px 的已保存搜索摘要拦腰切断，
   半个字被盖住就是顶栏左框文字重叠/糊掉的根因。
   收窄后右沿与非 account-show 时一致：宽屏 259+261=520（功能框在 552，间距 32px）；
   1280px 时 259+191=450（功能框在 482，间距 32px）；≤1279px 功能框隐藏，不收窄。 */
@media (min-width: 1281px) {
  .email-search.account-show {
    width: 261px;
  }
}

@media (min-width: 1280px) and (max-width: 1280px) {
  .email-search.account-show {
    width: 191px;
  }
}

/* 面板与触发框解耦：account-show 时触发框收窄到 261/191px，面板仍保持 520px 宽
  （面板里四段分段器 + 两个日期选择器需要这个宽度）。只在 ≥1280px 生效，
   窄屏下面板仍跟触发框同宽，不会溢出视口。 */
@media (min-width: 1280px) {
  .email-search.account-show .search-panel-shell {
    width: min(520px, calc(100vw - 279px));
  }
}

.search-placeholder {
  width: 100%;
  height: 36px;
  border-radius: 6px;
  box-sizing: border-box;
}

.search-placeholder {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  text-align: left;
  white-space: nowrap;
  cursor: text;
  position: relative;
  z-index: 0;
}

.search-placeholder-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 15px;
}

.search-placeholder-text.has-search-text {
  color: var(--el-text-color-primary);
}

/* 两个搜索一眼区分：邮件搜索 = 放大镜 + 小信封（蓝底角标）；功能搜索是放大镜 + 小齿轮（灰底角标）。 */
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

/* 面板顶标题：点开后也一眼知道这是哪个搜索。 */
.search-panel-title {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 12px 2px;
  font-size: 15px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}

.mobile-search-button {
  display: none;
}

@media (max-width: 767px) {
  .email-search {
    position: static;
    transform: none;
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    margin-left: auto;
  }

  .search-placeholder {
    display: none;
  }

  .mobile-search-button {
    display: inline-flex;
    width: 32px;
    height: 32px;
    padding: 0;
    border: none;
    /* 邮件搜索：蓝底角标 + 淡蓝底，一眼区别于功能搜索的透明底。 */
    background: rgba(24, 144, 255, 0.14);
    box-shadow: none;
    --el-button-bg-color: rgba(24, 144, 255, 0.14);
    --el-button-border-color: transparent;
    --el-button-hover-bg-color: rgba(24, 144, 255, 0.22);
    --el-button-hover-border-color: transparent;
    --el-button-active-bg-color: rgba(24, 144, 255, 0.26);
    --el-button-active-border-color: transparent;
    --el-button-outline-color: transparent;
  }

  .email-search .search-panel-shell {
    top: calc(100% + 8px);
    left: 50%;
    right: auto;
    width: min(450px, calc(100vw - 30px));
    translate: -50% 0;
  }
}

.search-panel-shell {
  position: absolute;
  top: -4px;
  left: 0;
  z-index: 1001;
  width: 100%;
  /* 任务 2：背景加兜底，保证面板不透明、盖住下方邮件正文。 */
  background: var(--el-bg-color-overlay, var(--el-bg-color, #ffffff));
}

.search-panel {
  width: 100%;
  height: auto;
  min-height: 0;
  box-sizing: border-box;
  --el-card-bg-color: var(--el-bg-color-overlay);
  background-color: var(--el-card-bg-color) !important;
  border-radius: 6px !important;
  border: 1px solid var(--el-border-color) !important;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16) !important;
  overflow: hidden;
  isolation: isolate;
}

.search-panel :deep(.el-card__body) {
  position: relative;
  z-index: 1;
  padding: 3px;
  background-color: var(--el-card-bg-color) !important;
}

.search-panel-shell {
  box-sizing: border-box;
}

.search-panel-fade-enter-active,
.search-panel-fade-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.search-panel-fade-enter-from,
.search-panel-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.search-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 25px;
  padding-bottom: 15px;
  padding-right: 15px;
}

.search-content {
  padding: 20px 15px 0;
}

.search-scope {
  margin-bottom: 20px;
}

.search-content-title {
  font-size: 14px;
  font-weight: 700;
  line-height: 20px;
  color: var(--el-text-color-primary);
  width: 100%;
  text-align: left !important;
}

.custom-style {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-start;
  margin-top: 8px;
}

.custom-style .el-segmented {
  --el-border-radius-base: 6px;
  max-width: 100%;
}

.search-date-range {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 20px;
}

.search-date-field {
  /* 任务 2：每栏最少 200px，窄屏时自动换行上下排，不再左右挤扁。 */
  flex: 1 1 200px;
  min-width: 200px;
}

.search-date-label {
  margin-bottom: 4px;
  font-size: 14px;
  font-weight: 700;
  line-height: 20px;
  color: var(--el-text-color-primary);
  text-align: left;
}

.search-date-field :deep(.el-date-editor) {
  width: 100%;
}

.search-input {
  --el-input-bg-color: var(--el-bg-color-overlay);
  margin: 4px -3px 0;
  padding: 0 8px 6px;
  border-bottom: solid 1px var(--el-border-color);
}

.search-input :deep(.el-input__wrapper),
.search-input :deep(.el-input__wrapper.is-focus) {
  box-shadow: none !important;
}

.search-input :deep(.el-input__inner::placeholder) {
  font-size: 15px;
}
</style>
