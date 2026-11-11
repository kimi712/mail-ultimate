<template>
  <div class="email-container">
    <div class="header-actions">
      <el-checkbox
          v-model="checkAll"
          :indeterminate="isIndeterminate"
          :disabled="!emailList.length || loading"
          @change="handleCheckAllChange"
      >
      </el-checkbox>
      <div class="header-left" :style="'padding-left:' + actionLeft">

        <slot name="first"></slot>
        <Icon class="icon reload" icon="ion:reload" width="18" height="18" @click="refresh"/>
        <Icon v-perm="'email:delete'" class="icon delete" icon="uiw:delete" width="16" height="16"
              v-if="getSelectedMailsIds().length > 0"
              @click="handleDelete"/>
        <Icon v-perm="'email:delete'" class="icon restore" icon="fluent:arrow-undo-20-regular" width="18" height="18"
              v-if="props.type === 'trash' && getSelectedMailsIds().length > 0"
              @click="handleRestore"/>
        <Icon v-perm="'email:delete'" class="icon delete" icon="fluent:mail-read-20-regular" width="21" height="21"
              v-if="getSelectedMailsIds().length > 0 && showUnread"
              @click="handleRead"/>
      </div>

      <div class="header-right">
        <span class="email-count" v-if="total">{{ $t('emailCount', {total: total}) }}</span>
        <Icon v-if="showAccountIcon" class="more-icon icon" width="16" height="16" icon="akar-icons:dot-grid-fill"
              @click="changeAccountShow"/>
      </div>
    </div>

    <div ref="scroll" class="scroll">
      <UseVirtualList ref="scrollbarRef"
                        @scroll="onScroll"
                        :list="list"
                        :options="{ itemHeight: itemHeight, overscan: 15 }"
                        class="virtual"
                        style="height: 100%"
                        v-if="!loading && emailList.length > 0"
                        :key="keyCount"
        >
          <template #default="{ data: item, index }" >
            <div :class="['email-row', props.type, { 'right-checked': item.rightChecked }]"
                 :data-checked="item.checked"
                 @click="jumpDetails(item)"
                 v-if="!item.expand"
                 :key="item.emailId"
                 @contextmenu="handleContextmenu($event, item)"
            >
              <el-checkbox :class=" props.type === 'all-email' ? 'all-email-checkbox' : 'checkbox'"
                           v-model="item.checked"
                           :disabled="!item.checked && isSelectMax"
                           @click.stop></el-checkbox>
              <div @click.stop="starChange(item)" class="pc-star" v-if="showStar">
                <Icon v-if="item.isStar" icon="fluent-color:star-16" width="20" height="20"/>
                <Icon v-else icon="solar:star-line-duotone" width="18" height="18"/>
              </div>
              <div v-if="!showStar"></div>
              <div class="title" :class="accountShow ? 'title-column' : 'title-column'">

                <div class="email-sender" :style=" (showStatus ? 'gap: 10px;' : '') + ((item.unread === EmailUnreadEnum.UNREAD && showUnread)  ? 'font-weight: bold' : '')">
                  <div class="email-status" v-if="showStatus">
                    <el-tooltip v-if="item.statusIcon" effect="dark" :content="item.statusIcon.content">
                      <Icon :icon="item.statusIcon.icon" :style="`color: ${item.statusIcon.color}`" width="20" height="20"/>
                    </el-tooltip>
                    <div class="del-status" v-if="item.isDel && item.status !== 6">
                      <el-tooltip effect="dark" :content="item.isDelContent">
                        <Icon class="icon" icon="mdi:email-remove" width="20" height="20"/>
                      </el-tooltip>
                    </div>
                  </div>
                  <div v-else></div>
                  <span class="name">
                    <span>
                      <div class="unread" v-if="isMobile && (item.unread === EmailUnreadEnum.UNREAD && showUnread) "/>
                      <slot name="name" :email="item"><span v-html="item.nameHtml"></span></slot>
                    </span>
                    <span>
                      <Icon v-if="item.isStar" icon="fluent-color:star-16" width="18" height="18"/>
                    </span>
                  </span>
                  <span class="phone-time">{{ item.formatCreateTime }}</span>
                </div>
                <div>
                  <div class="email-text">
                    <span class="email-subject" :style="(item.unread === EmailUnreadEnum.UNREAD && showUnread)  ? 'font-weight: bold' : ''">
                      <div class="unread" v-if="!isMobile && (item.unread === EmailUnreadEnum.UNREAD && showUnread) "/>
                      <span v-if="item.code" class="code-tag" @click.stop="copyCode(item.code)">[{{ t('codeLabel') }}{{ item.code }}]</span>
                      <span v-if="item.e2ee === 1" class="e2ee-lock" @click.stop>
                        <el-tooltip effect="dark" :content="t('securityE2eeBadge')">
                          <Icon icon="mdi:lock" width="15" height="15" style="color: #67C23A" />
                        </el-tooltip>
                      </span>
                      <span v-if="item.expired === 1" class="expire-tag" @click.stop>
                        <el-tooltip effect="dark" :content="t('expireDestroyed')">
                          <span style="color: #E6A23C">⏳ {{ t('expireDestroyedShort') }}</span>
                        </el-tooltip>
                      </span>
                      <span v-else-if="item.burnAfterRead === 1" class="expire-tag" @click.stop>
                        <el-tooltip effect="dark" :content="t('expireBurnTag')">
                          <span style="color: #E6A23C">🔥 {{ t('expireBurnShort') }}</span>
                        </el-tooltip>
                      </span>
                      <span v-else-if="item.expireAt" class="expire-tag" @click.stop>
                        <el-tooltip effect="dark" :content="t('expireAtTag', { time: item.expireAt })">
                          <span style="color: #E6A23C">⏳ {{ t('expireShort') }}</span>
                        </el-tooltip>
                      </span>
                      <span class="subject-text">
                        <slot name="subject" :email="item" >
                          <span v-html="item.subjectHtml"></span>
                        </slot>
                      </span>
                    </span>
                    <span class="email-content" v-html="item.listHtml"></span>
                  </div>
                  <div class="user-info" v-if="showUserInfo">
                    <div class="user">
                      <span>
                        <Icon icon="mynaui:user" width="20" height="20"/>
                      </span>
                      <span v-html="item.userEmailHtml"></span>
                    </div>
                    <div class="account">
                      <span>
                        <Icon icon="mdi-light:email" width="20" height="20"/>
                      </span>
                      <span v-html="item.accountEmailHtml"></span>
                    </div>
                  </div>
                </div>
              </div>
              <div class="email-right" :style="showUserInfo ? 'align-self: start;':''">
                <span v-if="aiEnabled && !item.e2ee" class="ai-quick-btn" :title="t('ai.assistantTitle')" @click.stop="openAiMenu($event, item)">
                  <Icon icon="hugeicons:ai-chat-02" width="18" height="18"/>
                </span>
                <span class="email-time" :style="(item.unread === EmailUnreadEnum.UNREAD && showUnread) ? 'font-weight: bold' : ''">{{ item.formatCreateTime }}</span>
              </div>
            </div>
            <skeletonBlock v-else-if="item.expand === 'loading'"
                           :rows="1"
                           :showStar="showStar"
                           :accountShow="accountShow"
                           :showStatus="showStatus"
                           :showUserInfo="showUserInfo"
                           :type="type"/>
            <div class="noLoading" v-else-if="item.expand === 'noMoreData'">
              <div>{{ $t('noMoreData') }}</div>
            </div>
          </template>
        </UseVirtualList>
      <skeletonBlock v-if="firstLoad && showFirstLoading"
                       :rows="20"
                       :showStar="showStar"
                       :accountShow="accountShow"
                       :showStatus="showStatus"
                       :showUserInfo="showUserInfo"
                       :type="type"/>
      <skeletonBlock v-if="loading"
                       :rows="skeletonRows"
                       :showStar="showStar"
                       :accountShow="accountShow"
                       :showStatus="showStatus"
                       :showUserInfo="showUserInfo"
                       :type="type"/>
      <div class="empty" v-if="noLoading && emailList.length === 0 && !loading">
        <el-empty :image-size="isMobile ? 120 : null">
          <template #description>
            <div class="empty-title">{{ emptyCopy.title }}</div>
            <div class="empty-desc">{{ emptyCopy.desc }}</div>
            <!-- Phase 8 斯诺登元素补齐：空状态名言轮换（核实过的三句，小字翻译走 i18n intro.quote1/2/3）。 -->
            <transition name="empty-quote-fade" mode="out-in">
              <div class="empty-quote" :key="emptyQuoteIndex">“{{ $t(EMPTY_QUOTES[emptyQuoteIndex]) }}” — Edward Snowden</div>
            </transition>
          </template>
          <el-button type="primary" @click="onEmptyAction">{{ emptyCopy.action }}</el-button>
        </el-empty>
      </div>
    </div>
    <el-dropdown
        ref="dropdownRef"
        @visible-change="visibleChange"
        :virtual-ref="triggerRef"
        :show-arrow="false"
        :popper-options="{
      modifiers: [{ name: 'offset', options: { offset: [0, 0] } }],
    }"
        virtual-triggering
        trigger="contextmenu"
        placement="bottom-start"
    >
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item v-if="rightClickEmail.code" @click="copyCode(rightClickEmail.code)" >
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="fluent-color:clipboard-24" width="20" height="20" />
                <span>{{t('copyCode')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item v-if="['email'].includes(props.type)" @click="emailRead(rightClickEmail.emailId)" >
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="fluent:mail-read-20-regular" width="20" height="20" />
                <span>{{t('markAsRead')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item v-if="['email','star'].includes(props.type)" @click="openReply(rightClickEmail)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="fluent-mdl2:reply" width="19" height="19"  />
                <span>{{t('reply')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item v-if="['email','send', 'star'].includes(props.type)" @click="openForward(rightClickEmail)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="iconoir:arrow-up-right" width="19" height="19"  />
                <span>{{t('forward')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item v-if="['email','send', 'star'].includes(props.type)" @click="starChange(rightClickEmail)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="solar:star-line-duotone" width="19" height="19"/>
                <span>{{t('star')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <!-- 列表 AI 快捷操作（与悬停 AI 按钮共用同一结果弹窗；加密邮件不进 AI）。 -->
          <el-dropdown-item v-if="aiEnabled && ['email','star'].includes(props.type) && !rightClickEmail.e2ee" @click="aiQuickAction('summarize', rightClickEmail)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="hugeicons:ai-chat-02" width="19" height="19"/>
                <span>{{t('ai.summarize')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item v-if="aiEnabled && ['email','star'].includes(props.type) && !rightClickEmail.e2ee" @click="aiQuickAction('translate', rightClickEmail)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="hugeicons:ai-chat-02" width="19" height="19"/>
                <span>{{t('ai.translate')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item v-if="aiEnabled && ['email','star'].includes(props.type) && !rightClickEmail.e2ee" @click="aiQuickAction('triage', rightClickEmail)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="hugeicons:ai-chat-02" width="19" height="19"/>
                <span>{{t('ai.triage')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item v-if="props.type === 'all-email'" @click="handleSearch('user', rightClickEmail.userEmail)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="iconoir:search" width="20" height="20" />
                <span>{{t('searchUser')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item v-if="props.type === 'all-email' " @click="handleSearch('account', rightClickEmail.toEmail)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="iconoir:search" width="20" height="20" />
                <span>{{t('searchEmail')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item v-if="props.type === 'all-email' " @click="handleSearch('name', rightClickEmail.name)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="iconoir:search" width="20" height="20" />
                <span>{{t('searchSender')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item v-if="props.type === 'trash'" @click="rightRestore(rightClickEmail.emailId)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="fluent:arrow-undo-20-regular" width="18" height="18" style="margin-left: 1px;margin-right: 3px" />
                <span>{{t('trashRestore')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item @click="rightDelete(rightClickEmail.emailId)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="uiw:delete" width="16" height="20" style="margin-left: 1px;margin-right: 3px" />
                <span>{{t('delete')}}</span>
              </div>
            </template>
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
    <!-- 列表 AI 快捷菜单（行内悬停 AI 按钮打开；与右键菜单共用同一结果弹窗）。 -->
    <el-dropdown
        ref="aiDropdownRef"
        :virtual-ref="aiTriggerRef"
        :show-arrow="false"
        virtual-triggering
        trigger="click"
        placement="bottom-start"
    >
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item @click="aiQuickAction('summarize', aiMenuEmail)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="hugeicons:ai-chat-02" width="19" height="19"/>
                <span>{{t('ai.summarize')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item @click="aiQuickAction('translate', aiMenuEmail)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="hugeicons:ai-chat-02" width="19" height="19"/>
                <span>{{t('ai.translate')}}</span>
              </div>
            </template>
          </el-dropdown-item>
          <el-dropdown-item @click="aiQuickAction('triage', aiMenuEmail)">
            <template #default>
              <div class="right-dropdown-item">
                <Icon icon="hugeicons:ai-chat-02" width="19" height="19"/>
                <span>{{t('ai.triage')}}</span>
              </div>
            </template>
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
    <!-- 列表 AI 结果弹窗（摘要/翻译/归类共用；归类带一键应用）。 -->
    <el-dialog v-model="aiResultVisible" :title="aiResultTitle" width="520px" class="ai-list-result-dialog">
      <div v-if="aiResultLoading" class="ai-result-body">{{ $t('ai.generating') }}</div>
      <div v-else-if="aiResultKind === 'triage' && aiResultTriage" class="ai-result-body">
        <div>
          <el-tag v-for="label in aiResultTriage.labels" :key="label" size="small" style="margin-right: 6px">{{ label }}</el-tag>
          <span v-if="!aiResultTriage.labels?.length">{{ $t('ai.triageNoLabel') }}</span>
        </div>
        <div>{{ $t('ai.triageFolder') }}：{{ aiResultTriage.folder }}</div>
        <div v-if="aiResultTriage.reason">{{ aiResultTriage.reason }}</div>
        <div class="ai-result-actions">
          <span v-if="aiResultRemaining !== null" class="ai-result-remaining">{{ $t('ai.remaining', {count: aiResultRemaining}) }}</span>
          <el-button type="primary" size="small" :loading="aiApplying" @click="applyListTriage">{{ $t('ai.applyTriage') }}</el-button>
        </div>
      </div>
      <div v-else>
        <pre class="ai-result-body">{{ aiResultText }}</pre>
        <div v-if="aiResultRemaining !== null" class="ai-result-remaining">{{ $t('ai.remaining', {count: aiResultRemaining}) }}</div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import {Icon} from "@iconify/vue";
import skeletonBlock from "@/components/email-scroll/skeleton/index.vue"
import {computed, onActivated, reactive, ref, watch, nextTick, onMounted, onUnmounted } from "vue";
import {useEmailStore} from "@/store/email.js";
import {useUiStore} from "@/store/ui.js";
import router from "@/router/index.js";
import {useSettingStore} from "@/store/setting.js";
import {sleep} from "@/utils/time-utils.js"
import {fromNow} from "@/utils/day.js";
import {useI18n} from "vue-i18n";
import {EmailUnreadEnum} from "@/enums/email-enum.js";
import { UseVirtualList } from '@vueuse/components'
import { useScroll } from '@vueuse/core'
import {aiSummarize, aiSummarizeStream, aiTranslate, aiTranslateStream, aiTriage, aiErrorI18nKey} from "@/request/ai.js";
import {SUPPORTED_LOCALES} from "@/i18n/locale.js";
import {hasMemoryKey} from "@/utils/e2ee.js";
import {decryptSealedSender} from "@/utils/sealed-mail.js";

// 斯诺登第二批（v3_15DB）：密封发件人列表展示。落盘记录没有明文发件人，列表先显示
// 占位；E2EE 已解锁时用收件人自己的密钥解密出真实发件人（只在前端内存里）。
// 缓存：emailId -> {email, name}（解出）或 null（已试过但解不出，不再重试）。
const sealedSenderCache = new Map();
const sealedSenderTrying = new Set();

function sealedSenderDisplayName(email) {
  const cached = sealedSenderCache.get(email.emailId);
  if (cached) return cached.name || cached.email || t('sealedSenderPlaceholder');
  return t('sealedSenderPlaceholder');
}

function tryDecryptSealedSenders(list) {
  if (!hasMemoryKey()) return;
  for (const email of list || []) {
    if (!email?.sealedSender || Number(email.e2eeVer) !== 2) continue;
    if (sealedSenderCache.has(email.emailId) || sealedSenderTrying.has(email.emailId)) continue;
    sealedSenderTrying.add(email.emailId);
    decryptSealedSender(email).then((sender) => {
      sealedSenderCache.set(email.emailId, sender);
      const row = emailList.find(e => e.emailId === email.emailId);
      if (row) applyHighlight(row);
    }).catch(() => {
      sealedSenderCache.set(email.emailId, null);
    }).finally(() => {
      sealedSenderTrying.delete(email.emailId);
    });
  }
}

const props = defineProps({
  getEmailList: Function,
  emailDelete: Function,
  emailRestore: Function,
  emailRead: Function,
  starAdd: Function,
  starCancel: Function,
  cancelSuccess: Function,
  starSuccess: Function,
  actionLeft: {
    type: String,
    default: '0'
  },
  timeSort: {
    type: Number,
    default: 0,
  },
  showStatus: {
    type: Boolean,
    default: false
  },
  showAccountIcon: {
    type: Boolean,
    default: true,
  },
  showUserInfo: {
    type: Boolean,
    default: false
  },
  showStar: {
    type: Boolean,
    default: true
  },
  allowStar: {
    type: Boolean,
    default: true
  },
  type: {
    type: String,
    default: 'email'
  },
  showFirstLoading: {
    type: Boolean,
    default: true
  },
  showUnread: {
    type: Boolean,
    default: false
  },
  highlightText: {
    type: String,
    default: ''
  }
})

const emit = defineEmits(['jump', 'refresh-before', 'delete-draft', 'right-search'])

const {t} = useI18n()
const settingStore = useSettingStore()
const uiStore = useUiStore();
const emailStore = useEmailStore();

// Phase 8 H 路：空状态按文件夹给引导（标题 + 一句说明 + 一个动作按钮），
// 不再是只有一句“没有任何邮件”的空白页。
const emptyCopy = computed(() => {
  switch (props.type) {
    case 'send':
      return { title: t('emptySentTitle'), desc: t('emptySentDesc'), action: t('emptyComposeAction') };
    case 'draft':
      return { title: t('emptyDraftTitle'), desc: t('emptyDraftDesc'), action: t('emptyComposeAction') };
    case 'star':
      return { title: t('emptyStarredTitle'), desc: t('emptyStarredDesc'), action: t('emptyBrowseInboxAction') };
    case 'all-email':
      return { title: t('emptyAllTitle'), desc: t('emptyAllDesc'), action: t('emptyComposeAction') };
    case 'spam':
      return { title: t('emptySpamTitle'), desc: t('emptySpamDesc'), action: t('emptyBrowseInboxAction') };
    default:
      return { title: t('emptyInboxTitle'), desc: t('emptyInboxDesc'), action: t('emptyComposeAction') };
  }
});
function onEmptyAction() {
  if (props.type === 'star' || props.type === 'spam') router.push({ name: 'email' });
  else uiStore.writerRef?.open?.();
}
// Phase 8 斯诺登元素补齐：空状态名言轮换（核实过的三句，小字翻译走 i18n
// intro.quote1/2/3，每 6 秒换一句，淡入淡出）。
const EMPTY_QUOTES = ['intro.quote1', 'intro.quote2', 'intro.quote3']
const emptyQuoteIndex = ref(0)
let emptyQuoteTimer = null
onMounted(() => {
  emptyQuoteTimer = setInterval(() => {
    emptyQuoteIndex.value = (emptyQuoteIndex.value + 1) % EMPTY_QUOTES.length
  }, 6000)
})
onUnmounted(() => {
  if (emptyQuoteTimer) clearInterval(emptyQuoteTimer)
})
const loading = ref(false);
const followLoading = ref(false);
const noLoading = ref(false);
const emailList = reactive([])
const expandList = reactive([])
const total = ref(0);
const checkAll = ref(false);
const isIndeterminate = ref(false);
const scroll = ref(null)
const firstLoad = ref(true)
let scrollTop = 0
const latestEmail = ref(null)
const scrollbarRef = ref(null)
// iPad can report a Mac platform when requesting desktop websites.
const isMacOS = /Mac/.test(navigator.platform) && navigator.maxTouchPoints <= 1
let reqLock = false
let isMobile = ref(innerWidth < 1367)
let skeletonRows = 0
const timePaddingRight = ref('');
const keyCount = ref(0);
const dropdownRef = ref(null);
const dropdownCloseLock = ref(false);
const dropdownShow = ref(false);
const rightClickEmail = ref({});
const MAX_SELECT_COUNT = 95;
const checkedEmailCount = ref(0);
const isSelectMax = computed(() => checkedEmailCount.value >= MAX_SELECT_COUNT);
let timer = null
const position = ref(
    DOMRect.fromRect({
      x: 0,
      y: 0,
    })
)

const triggerRef = ref({
  getBoundingClientRect() {
    return position.value;
  }
})

const queryParam = reactive({
  size: 50
});

defineExpose({
  refreshList,
  deleteEmail,
  addItem,
  handleList,
  emailList,
  firstLoad,
  latestEmail,
  noLoading,
  total
})

onActivated(() => {
  requestAnimationFrame(() => {
    const index = scrollTop / itemHeight.value
    scrollbarRef.value?.scrollTo(index);
  })
  // 回到列表时 E2EE 可能已在读信页解锁，补试一次密封发件人解密（不重新取数）。
  tryDecryptSealedSenders(emailList)
})

onMounted(() => {
  timer = setInterval(() => {
    emailList.forEach(email => {
      email.formatCreateTime = fromNow(email.createTime);
    })
  }, 1000 * 60);
})

onUnmounted(() => {
  clearInterval(timer)
})

getEmailList()

window.onresize = () => {
  isMobile.value = innerWidth < 1367
}

function onScroll(e) {
  scrollTop = e.target.scrollTop;
}

const { arrivedState } = useScroll(scrollbarRef, {
  offset: { bottom: isMobile.value ? 2200 : 1500 }
})


const list = computed(() => {
  return [...emailList, ...expandList]
})

const itemHeight = computed(() => {
    if (props.type === 'all-email') {
      return isMobile.value ? 132 : 65;
    } else  {
      return isMobile.value ? 83 : 48;
    }
})

watch(emailList, () => {
  updateHasScrollbar();
})

watch(scrollbarRef, () => {
  updateHasScrollbar();
})

// 强制刷新 (itemHeight 更改后虚拟滚动列表不会自己更新)
watch(itemHeight, () => {
  keyCount.value ++
})

watch(followLoading, (isFollowLoading) => {
  if (isFollowLoading) {
    expandList.push({
      emailId: 0,
      expand: 'loading'
    })
  } else {
    const index = expandList.findIndex(item => item.expand === 'loading')
    expandList.splice(index, 1);
  }
});

watch(noLoading, (isNoLoading) => {
  if (isNoLoading) {
    expandList.push({
      emailId: 0,
      expand: 'noMoreData'
    })
  } else {
    const index = expandList.findIndex(item => item.expand === 'noMoreData')
    expandList.splice(index, 1);
  }
})


// 监听是否到达底部
watch(() => arrivedState.bottom, (isBottom) => {
  if (isBottom && !loading.value) {
    loadData();
  }
});

watch(
    () => emailList.map(item => item.checked),
    () => {
      checkedEmailCount.value = emailList.length
      if (emailList.length > 0) {
        updateCheckStatus();
      }
    },
    {deep: true}
);


watch(() => emailStore.deleteIds, () => {
  if (emailStore.deleteIds) {
    deleteEmail(emailStore.deleteIds)
  }
})

watch(() => emailStore.cancelStarEmailId, () => {
  emailList.forEach(email => {
    if (email.emailId === emailStore.cancelStarEmailId) {
      email.isStar = 0
    }
  })
})

watch(() => emailStore.addStarEmailId, () => {
  emailList.forEach(email => {
    if (email.emailId === emailStore.addStarEmailId) {
      email.isStar = 1
    }
  })
})

window.addEventListener('wheel', (event) => {
  if (dropdownShow.value) {
    dropdownRef.value.handleClose();
  }
  aiDropdownRef.value?.handleClose();
})

function openReply(email) {
  const fullEmail = emailStore.detailMap[email.emailId]
  if (!fullEmail) return
  uiStore.writerRef.openReply(fullEmail)
}

function openForward(email) {
  const fullEmail = emailStore.detailMap[email.emailId]
  if (!fullEmail) return
  uiStore.writerRef.openForward(fullEmail)
}

function visibleChange(e) {
  dropdownShow.value = e;
  dropdownCloseLock.value = true;
  setTimeout(() => {
    dropdownCloseLock.value = false;
  },1500)

  if (!e && rightClickEmail.value.rightChecked) {
    rightClickEmail.value.rightChecked = false
  }
}

const handleContextmenu = (event, email) => {

  if (props.type === 'draft') {
    return
  }

  if (rightClickEmail.value.rightChecked) {
    rightClickEmail.value.rightChecked = false
  }

  const { clientX, clientY } = event
  position.value = DOMRect.fromRect({
    x: clientX,
    y: clientY,
  })
  event.preventDefault();
  dropdownRef.value?.handleOpen();

  rightClickEmail.value = email;
  rightClickEmail.value.rightChecked = true
}

// 列表 AI 快捷操作：行内悬停 AI 按钮 / 右键菜单共用同一结果弹窗。
// E2EE 邮件不进 AI（服务端只有密文），入口直接隐藏；与读信页 canAiSummarize 一致。
const aiEnabled = computed(() => settingStore.settings?.aiEnabled !== 0)
const aiTargetLang = computed(() => (SUPPORTED_LOCALES.find(i => i.short === settingStore.lang) || SUPPORTED_LOCALES[0]).code)
const aiMenuEmail = ref({})
const aiDropdownRef = ref(null)
const aiPosition = ref(DOMRect.fromRect({x: 0, y: 0}))
const aiTriggerRef = ref({
  getBoundingClientRect() {
    return aiPosition.value;
  }
})
const aiResultVisible = ref(false)
const aiResultKind = ref('summarize')
const aiResultTitle = computed(() => aiResultKind.value === 'triage' ? t('ai.triageResult') : aiResultKind.value === 'translate' ? t('ai.translation') : t('ai.summary'))
const aiResultLoading = ref(false)
const aiResultText = ref('')
const aiResultTriage = ref(null)
const aiResultRemaining = ref(null)
const aiApplying = ref(false)

function openAiMenu(event, email) {
  if (!aiEnabled.value || email?.e2ee === 1) return
  aiMenuEmail.value = email
  const rect = event.currentTarget.getBoundingClientRect()
  aiPosition.value = DOMRect.fromRect({
    x: rect.left,
    y: rect.bottom + 4,
  })
  aiDropdownRef.value?.handleOpen()
}

async function aiQuickAction(kind, email) {
  if (!email?.emailId || aiResultLoading.value) return
  aiResultKind.value = kind
  aiResultVisible.value = true
  aiResultLoading.value = true
  aiResultText.value = ''
  aiResultTriage.value = null
  try {
    let data
    if (kind === 'summarize') {
      // 流式摘要：逐 token 填结果，首 token 约 1-2 秒可见；流式失败时回退一次性生成。
      let live = ''
      try {
        const done = await aiSummarizeStream({emailId: email.emailId}, (d) => { live += d; aiResultText.value = live })
        aiResultText.value = done.summary || live
        data = done
      } catch (e) {
        data = await aiSummarize({emailId: email.emailId})
        aiResultText.value = data.summary || ''
      }
    } else if (kind === 'translate') {
      // 流式翻译：逐 token 填结果；流式失败时回退一次性生成。
      let live = ''
      try {
        const done = await aiTranslateStream({emailId: email.emailId, targetLang: aiTargetLang.value}, (d) => { live += d; aiResultText.value = live })
        aiResultText.value = done.translatedText || live
        data = done
      } catch (e) {
        data = await aiTranslate({emailId: email.emailId, targetLang: aiTargetLang.value})
        aiResultText.value = data.translatedText || ''
      }
    } else {
      data = await aiTriage({emailId: email.emailId})
      aiResultTriage.value = {labels: data.labels || [], folder: data.folder || 'inbox', reason: data.reason || ''}
      aiMenuEmail.value = email
    }
    if (typeof data?.remaining === 'number') aiResultRemaining.value = data.remaining
  } catch (e) {
    aiResultVisible.value = false
    ElMessage({message: t(aiErrorI18nKey(e && e.code)), type: 'error', plain: true})
  } finally {
    aiResultLoading.value = false
  }
}

// 归类一键应用：星标/删除走现有接口；收件箱无需移动；归档只是
// email_label 上的标签，无手动归档接口，不可应用，只提示。
async function applyListTriage() {
  const email = aiMenuEmail.value
  const folder = aiResultTriage.value?.folder
  if (!email?.emailId || !folder || aiApplying.value) return
  if (folder === 'star') {
    if (typeof props.starAdd !== 'function') return
    aiApplying.value = true
    try {
      if (!email.isStar) {
        await props.starAdd(email.emailId)
        email.isStar = 1
        props.starSuccess?.(email)
      }
      ElMessage({message: t('ai.triageApplied'), type: 'success', plain: true})
      aiResultVisible.value = false
    } catch (e) {
      ElMessage({message: t('ai.unavailable'), type: 'error', plain: true})
    } finally {
      aiApplying.value = false
    }
  } else if (folder === 'trash') {
    aiApplying.value = true
    try {
      await props.emailDelete([email.emailId])
      emailStore.deleteIds = [email.emailId]
      ElMessage({message: t('ai.triageApplied'), type: 'success', plain: true})
      aiResultVisible.value = false
    } catch (e) {
      ElMessage({message: t('ai.unavailable'), type: 'error', plain: true})
    } finally {
      aiApplying.value = false
    }
  } else if (folder === 'inbox') {
    ElMessage({message: t('ai.triageApplyInbox'), type: 'info', plain: true})
  } else {
    ElMessage({message: t('ai.triageApplyArchive'), type: 'info', plain: true})
  }
}

function updateHasScrollbar() {
  nextTick(() => {

    if (isMacOS) {
      timePaddingRight.value = '15px'
      return
    }

    const doc = document.querySelector('.virtual');
    if (doc) {
      if (doc.scrollHeight > doc.clientHeight) {
        timePaddingRight.value = '6px';
      } else {
        timePaddingRight.value = '15px'
      }
    }
  })
}

function getSkeletonRows() {
  if (emailList.length > 20) return skeletonRows = 20
  if (emailList.length === 0) return skeletonRows = 1
  skeletonRows = emailList.length
}

const accountShow = computed(() => {
  return uiStore.accountShow && settingStore.settings.manyEmail === 0
})

function starChange(email) {

  if (!email.isStar) {

    if (!props.allowStar) return;

    email.isStar = 1;
    props.starAdd(email.emailId).then(() => {
      email.isStar = 1;
      props.starSuccess(email)
    }).catch(e => {
      console.error(e)
      email.isStar = 0
    })
  } else {

    email.isStar = 0;
    props.starCancel(email.emailId).then(() => {
      email.isStar = 0;
      props.cancelSuccess?.(email)
    }).catch(e => {
      console.error(e)
      email.isStar = 1;
    })
  }
}

function changeAccountShow() {
  uiStore.accountShow = !uiStore.accountShow;
}

const handleRead = () => {
  const emailIds = getSelectedMailsIds();
  props.emailRead(emailIds);
  localRead(emailIds);
}

function emailRead(emailId) {
  props.emailRead([emailId])
  localRead([emailId]);
}

function localRead(emailIds) {
  emailIds.forEach(emailId => {
    const index = emailList.findIndex(email => email.emailId === emailId);
    if (index > -1) {
      emailList[index].unread = EmailUnreadEnum.READ;
      emailList[index].checked = false;
    }
  })
}

function rightDelete(emailId) {
  // 单封删除一律二次确认（之前只有全部邮件视图弹确认，收件箱右键直接删）；
  // 回收站里是彻底删除，文案单独提示“无法恢复”。
  const confirmKey = props.type === 'trash' ? 'delOneTrashEmailConfirm' : 'delOneEmailConfirm'
  ElMessageBox.confirm(t(confirmKey), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    props.emailDelete([emailId]).then(() => {
      ElMessage({
        message: t('delSuccessMsg'),
        type: 'success',
        plain: true
      })
      emailStore.deleteIds = [emailId];
    })
  })
}

// 回收站右键恢复单封（恢复不删东西，不用二次确认）。
function rightRestore(emailId) {
  if (!props.emailRestore) {
    return
  }
  props.emailRestore([emailId]).then(() => {
    ElMessage({
      message: t('trashRestoreSuccessMsg'),
      type: 'success',
      plain: true
    })
    emailStore.deleteIds = [emailId];
  })
}

function handleSearch(type, value) {
  emit('right-search', type, value);
}

async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code);
    ElMessage({
      message: t('copySuccessMsg'),
      type: 'success',
      plain: true
    })
  } catch (err) {
    console.error(`${t('copyFailMsg')}:`, err);
    ElMessage({
      message: t('copyFailMsg'),
      type: 'error',
      plain: true
    })
  }
}

function handleDelete() {
  // 回收站里是彻底删除，文案单独提示“无法恢复”。
  const confirmKey = props.type === 'trash' ? 'delTrashEmailsConfirm' : 'delEmailsConfirm'
  ElMessageBox.confirm(t(confirmKey), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {

    if (props.type === 'draft') {
      const draftIds = getSelectedDraftsIds();
      emit('delete-draft', draftIds);
      return;
    }

    const emailIds = getSelectedMailsIds();
    props.emailDelete(emailIds).then(() => {
      ElMessage({
        message: t('delSuccessMsg'),
        type: 'success',
        plain: true
      })
      emailStore.deleteIds = emailIds;
    })
  })
}

// 回收站恢复：选中的信移回收件箱（恢复不删东西，不用二次确认）。
function handleRestore() {
  if (!props.emailRestore) {
    return
  }
  const emailIds = getSelectedMailsIds();
  if (!emailIds.length) {
    return
  }
  props.emailRestore(emailIds).then(() => {
    ElMessage({
      message: t('trashRestoreSuccessMsg'),
      type: 'success',
      plain: true
    })
    emailStore.deleteIds = emailIds;
  })
}

function deleteEmail(emailIds) {
  emailIds.forEach(emailId => {
    emailList.forEach((item, index) => {
      if (emailId === item.emailId) {
        emailList.splice(index, 1);
      }
    })
  })
  if (emailList.length < queryParam.size && !noLoading.value) {
    getEmailList()
  }
}

function addItem(email) {

  const existIndex = emailList.findIndex(item => item.emailId === email.emailId)

  if (existIndex > -1) {
    return false;
  }

  email.formatCreateTime = fromNow(email.formatCreateTime);

  if (props.timeSort) {
    if (noLoading.value) {
      handleList([email]);
      emailList.push(email);
    }

    if (email.emailId > latestEmail.value?.emailId) {
      latestEmail.value = email
    }

    total.value++
    return true;
  }


  const index = emailList.findIndex(item => item.emailId < email.emailId)

  if (index !== -1) {
    handleList([email]);
    emailList.splice(index, 0, email);
  } else {
    if (noLoading.value) {
      handleList([email]);
      emailList.push(email);
    }
  }

  if (email.emailId > latestEmail.value?.emailId) {
    latestEmail.value = email
  }

  total.value++
  return true;
}

function handleCheckAllChange(val) {
  if (val) {
    let count = 0;
    emailList.forEach(item => {
      if (count < MAX_SELECT_COUNT) {
        item.checked = true;
        count++;
      } else {
        item.checked = false;
      }
    });
  } else {
    emailList.forEach(item => item.checked = false);
  }
  isIndeterminate.value = false;
}

// 获取选中的邮件列表id
function getSelectedMailsIds() {
  return emailList.filter(item => item.checked).map(item => item.emailId);
}

function getSelectedDraftsIds() {
  return emailList.filter(item => item.checked).map(item => item.draftId);
}

function updateCheckStatus() {
  const checkedCount = emailList.filter(item => item.checked).length;
  checkedEmailCount.value = checkedCount;
  const atMax = checkedCount >= MAX_SELECT_COUNT;
  checkAll.value = emailList.length > 0 && (checkedCount === emailList.length || atMax);
  isIndeterminate.value = checkedCount > 0 && !checkAll.value;
}

function jumpDetails(email) {

  if (dropdownShow.value) {
    dropdownRef.value.handleClose();
    return;
  }

  if (!dropdownCloseLock.value) {
    const sel = window.getSelection();
    if (sel.toString().trim()) {
      return
    }
  }
  emit('jump', email)
}


function getEmailList(refresh = false) {

  if (reqLock) return;

  let emailId = emailList.length > 0 ? emailList.at(-1).emailId : 0;

  reqLock = true

  if (!refresh) {

    if (loading.value || noLoading.value) {
      reqLock = false
      return
    }

  } else {
    getSkeletonRows()
    emailId = 0
    loading.value = true
    scrollTop = 0
  }

  if (emailList.length === 0) {
    loading.value = true
  } else {
    followLoading.value = !refresh;
  }
  let start = Date.now();

  props.getEmailList(emailId, queryParam.size).then(async data => {
    let end = Date.now();
    let duration = end - start;
    if (duration < 300 && !emailId) {
        await sleep(300 - duration)
    }
    firstLoad.value = false

    let list = data.list.map(item => ({
      ...item,
      checked: false
    }));


    if (refresh) {
      emailList.length = 0
    }

    latestEmail.value = data.latestEmail

    handleList(list);
    emailList.push(...list);
    if (refresh) scrollbarRef.value?.setScrollTop(0);

    noLoading.value = data.list.length < queryParam.size;
    followLoading.value = data.list.length >= queryParam.size;

    total.value = data.total;
  }).finally(() => {
    loading.value = false
    reqLock = false
  })
}

function handleList(list) {
  list.forEach(email => {
    email.formatCreateTime = fromNow(email.createTime);
    email.test = t('received')
    const statusIconMap = {
      0: { icon: 'ic:round-mark-email-read', color: '#51C76B', content: t('received') },
      1: { icon: 'bi:send-arrow-up-fill',  color: '#51C76B', content: t('sent') },
      2: { icon: 'bi:send-check-fill',     color: '#51C76B', content: t('delivered') },
      3: { icon: 'bi:send-x-fill',         color: '#F56C6C', content: t('bounced') },
      8: { icon: 'bi:send-x-fill',         color: '#F56C6C', content: t('bounced') },
      4: { icon: 'bi:send-exclamation-fill', color: '#FBBD08', content: t('complained') },
      5: { icon: 'bi:send-arrow-up-fill',  color: '#FBBD08', content: t('delayed') },
      6: { icon: 'mdi:email-lock', color: '#909399', content: t('saving') },
      7: { icon: 'ic:round-mark-email-read', color: '#FBBD08', content: t('noRecipient') },
    };

    if (email.isDel) {
      email.isDelContent = t('selectDeleted');
    }
    email.statusIcon = statusIconMap[email.status];
    applyHighlight(email);
  })
  // 密封发件人：本批行加载完后，若 E2EE 已解锁，尝试解密出真实发件人。
  tryDecryptSealedSenders(list);
}

function applyHighlight(email) {
  // 密封发件人：显示解密出的真实发件人，未解锁时显示占位（不暴露明文）。
  email.nameHtml = renderHighlight(email.sealedSender ? sealedSenderDisplayName(email) : email.name);
  email.subjectHtml = renderHighlight(email.subject);
  email.listHtml = renderHighlight(email.listText || email.text);
  email.userEmailHtml = renderHighlight(email.userEmail);
  email.accountEmailHtml = renderHighlight(email.type === 0 ? email.toEmail : email.sendEmail);
}

watch(() => props.highlightText, () => {
  emailList.forEach(applyHighlight);
})

function refresh() {
  emit('refresh-before')
  if (props.skeleton) {
    scrollbarRef.value.setScrollTop(0)
  }
  refreshList()
}

function refreshList() {
  checkAll.value = false;
  isIndeterminate.value = false;
  getEmailList(true);
}

function loadData() {
  getEmailList()
}


function escapeHtml(value) {
  return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
}

function renderHighlight(value) {
  const text = value == null ? '' : String(value)
  if (!text) return '\u200B'
  const keyword = props.highlightText?.trim()
  if (!keyword) return escapeHtml(text)
  const pattern = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  let html = ''
  let lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    html += escapeHtml(text.slice(lastIndex, index))
    html += `<mark class="search-hit">${escapeHtml(match[0])}</mark>`
    lastIndex = index + match[0].length
  }
  html += escapeHtml(text.slice(lastIndex))
  return html
}

</script>
<style lang="scss" scoped>
:deep(.search-hit) {
  background-color: var(--search-hit-background);
  color: inherit;
  padding: 0;
  border-radius: 2px;
}


.email-container {
  display: grid;
  grid-template-rows: auto 1fr;
  padding: 0;
  font-size: 14px;
  color: var(--el-text-color-primary);
  overflow: hidden;
  height: 100%;
}

.scroll {
  margin: 0;
  height: 100%;
  overflow: hidden;

  .virtual {
    will-change: scroll-position;
  }

  .empty {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100%;
    width: 100%;
  }

  .empty-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  .empty-desc {
    margin-top: 6px;
    font-size: 14px;
    color: var(--el-text-color-secondary);
  }

  /* Phase 8 斯诺登元素补齐：空状态名言——小字斜体，居中，克制 */
  .empty-quote {
    margin: 16px auto 0;
    max-width: 420px;
    font-size: 12px;
    font-style: italic;
    line-height: 1.6;
    color: var(--el-text-color-placeholder);
  }

  .empty-quote-fade-enter-active, .empty-quote-fade-leave-active { transition: opacity .6s ease; }
  .empty-quote-fade-enter-from, .empty-quote-fade-leave-to { opacity: 0; }

  .noLoading {
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 15px 0 0 0;
    color: var(--secondary-text-color);
  }

  .follow-loading {
    height: 60px;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .loading {
    display: flex;
    justify-content: center;
    align-items: center;
    background: var(--loadding-background);
    height: 100%;
    width: 100%;
    position: absolute;
    z-index: 1;
    top: 0;
    left: 0;
  }

  .loading-show {
    transition: all 200ms ease 200ms;
    opacity: 1;
  }

  .loading-hide {
    pointer-events: none;
    transition: var(--loading-hide-transition);
    opacity: 0;
  }
}

:deep(.email-row) {
  display: flex;
  padding: 8px 0;
  justify-content: space-between;
  box-shadow: var(--header-actions-border);
  cursor: pointer;
  align-items: center;
  position: relative;
  transition: background 0.15s ease-in-out, box-shadow 0.15s ease-in-out;
  height: 48px;
  @media (max-width: 1366px) {
    height: 83px;
  }

  @media (pointer: coarse) {
    /* 触屏 */
    user-select: none;
  }
  &.all-email {
    height: 65px;
    @media (max-width: 1366px) {
      height: 132px;
    }
  }
  .user-info {
    display: flex;
    flex-wrap: wrap;
    column-gap: 10px;
    margin-top: 5px;
    margin-bottom: 2px;
    color: var(--email-scroll-content-color);
    @media (max-width: 1366px) {
      flex-direction: column;
    }

    .user, .account {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      transition: all 300ms;
      line-height: 12px;
      max-width: 300px;
      min-width: 0;

      @media (max-width: 1223px) {
        max-width: 280px;
      }

      span:first-child {
        position: relative;
      }

      span:last-child {
        margin-left: 5px;
        position: relative;
        bottom: 5px;
      }
    }
  }

  .checkbox {
    display: flex;
    padding-left: 15px;
    padding-right: 20px;
    justify-content: center;
  }

  .all-email-checkbox {
    display: flex;
    padding-left: 15px;
    padding-right: 20px;
    justify-content: center;
    @media (min-width: 1367px) {
      justify-content: start;
      height: 100%;
      align-self: start;
      padding-bottom: 30px;
    }
  }

  .title-column {
    @media (max-width: 1366px) {
      grid-template-columns: 1fr !important;
      gap: 4px !important;
    }
  }

  .title {
    flex: 1;
    display: grid;
    grid-template-columns: 240px 1fr;
    @media (max-width: 1366px) {
      padding-right: 15px;
    }
    @media (max-width: 1366px) {
      grid-template-columns: 1fr;
      gap: 4px;
    }

    .email-sender {
      color: var(--el-text-color-primary);
      display: grid;
      grid-template-columns: auto 1fr auto;

      .email-status {
        display: flex;
        flex-direction: column;
        align-content: center;
        @media (max-width: 1366px) {
          flex-direction: row;
          gap: 5px;
        }
      }

      .name {
        display: grid;
        gap: 5px;
        grid-template-columns: auto 1fr;

        > span:last-child {
          display: flex;
          align-items: center;
        }

        @media (min-width: 1366px) {
          grid-template-columns: 1fr;
          > span:last-child {
            display: none;
          }
        }

        > span:first-child {
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }

        .name-skeleton {
          width: 150px;
          height: 1rem;
          @media (max-width: 767px) {
            width: 130px;
          }
        }
      }

      .phone-time {
        font-weight: normal;
        font-size: 12px;
        @media (min-width: 1367px) {
          display: none;
        }
      }
    }

    .email-text-skeleton {
      .text-skeleton-one {
        width: 80%;
        height: 16px;
        @media (max-width: 1366px) {
          width: 40%;
        }
        @media (max-width: 767px) {
          width: 70%;
        }
      }

      .text-skeleton-two {
        width: min(300px, 100%);
        height: 16px;
        @media (min-width: 1367px) {
          display: none;
        }
        @media (max-width: 1366px) {
          width: 100%;
        }
      }
    }

    .email-text {
      display: grid;
      grid-template-columns: auto 1fr;
      @media (max-width: 1366px) {
        grid-template-columns: 1fr;
      }

      .email-subject {
        display: flex;
        align-items: center;
        gap: 6px;
        overflow: hidden;
        white-space: nowrap;
        min-width: 0;
        @media (min-width: 1367px) {
          padding-left: 5px;
        }
      }

      .code-tag {
        flex: 0 0 auto;
        max-width: 170px;
        height: 20px;
        line-height: 20px;
        font-size: 14px;
        color: var(--el-text-color-primary);
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        cursor: pointer;
      }

      .e2ee-lock {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
      }

      .subject-text {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        min-width: 0;
      }

      .email-content {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        padding-left: 10px;
        color: var(--email-scroll-content-color);
        @media (max-width: 1366px) {
          padding-left: 0;
          margin-top: 0;
        }
      }
    }
  }


  .email-right {
    text-align: right;
    font-size: 12px;
    white-space: nowrap;
    display: flex;
    padding-left: 15px;
    align-items: center;
    @media (max-width: 1366px) {
      display: none;
    }
  }

  // 列表 AI 快捷按钮：平时隐藏，行悬停时出现（只在桌面端，移动端走读信页 AI 按钮）。
  .ai-quick-btn {
    display: none;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 4px;
    cursor: pointer;
    color: var(--el-text-color-secondary);
    margin-right: 4px;

    &:hover {
      background: var(--base-fill);
      color: var(--el-color-primary);
    }
  }

  &:hover .ai-quick-btn {
    display: flex;
  }

  .email-right-skeleton {
    @media (max-width: 1366px) {
      display: none;
    }
  }

  &:hover {
    background-color: var(--email-hover-background);
    z-index: 0;
  }

  &.right-checked,
  &.right-checked:hover {
    background-color: var(--email-right-click-background);
  }

  /*&[data-checked="true"] {
    background-color: #c2dbff;
  }*/
}


.phone-star {
  display: none;
}

.pc-star {
  display: flex;
  width: 40px;
}

@media (max-width: 1366px) {
  .pc-star {
    display: none;
  }
  .phone-star {
    display: block;
    align-self: end;
    padding-right: 16px;
    padding-top: 8px;
  }
  .star-pd {
    padding-top: 6px !important;
  }
}

.email-time {
  padding-right: v-bind(timePaddingRight);
}

:deep(.el-scrollbar__view) {
  height: 100%;
}

.header-actions {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 15px;
  padding: 3px 15px;
  box-shadow: var(--header-actions-border);

  .header-left {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    position: relative;
    column-gap: 20px;
    row-gap: 8px;
    padding-left: 2px;
    color: var(--el-text-color-primary);;
  }

  .header-right {
    display: grid;
    grid-template-columns: auto auto;
    align-items: start;
    height: 100%;
    color: var(--el-text-color-primary);;

    .email-count {
      white-space: nowrap;
      margin-top: 6px;
    }
  }

  .icon {
    font-size: 18px;
    cursor: pointer;
  }

  .reload {
    margin-left: 2px;
  }

  .more-icon {
    margin-top: 8px;
    margin-left: 15px;
  }
}

.del-status {
  color: var(--el-color-info);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  bottom: 1px;
}



.right-dropdown-item {
  display: flex;
  gap: 10px;
}

:deep(.el-dropdown-menu__item:last-child) {
  padding-bottom: 10px;
}

:deep(.el-dropdown-menu__item:first-child) {
  padding-top: 10px;
}

:deep(.el-dropdown-menu__item) {
  padding-right: 14px;
  padding-left: 14px;
}

.unread {
  height: 6px;
  width: 6px;
  background: var(--el-color-primary);
  margin-bottom: 2px;
  margin-right: 5px;
  border-radius: 50%;
  display: inline-block;
  justify-content: center;
}

ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

// 列表 AI 结果弹窗。
.ai-result-body {
  font-family: inherit;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  line-height: 1.6;
  font-size: 13px;
}

.ai-result-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.ai-result-remaining {
  font-size: 12px;
  color: var(--secondary-text-color);
  flex: 1;
}

</style>
