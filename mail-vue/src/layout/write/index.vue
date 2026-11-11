<template>
  <div class="send" v-show="show">
    <div class="write-box">
      <div class="title">
        <div class="title-left">
          <span class="title-text">
            <Icon icon="hugeicons:quill-write-01" width="28" height="28"/>
          </span>
          <span class="sender">{{ $t('sender') }}:</span>
          <span class="sender-name">{{ form.name }}</span>
          <span class="send-email"><{{ form.sendEmail }}></span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <el-tooltip v-if="e2eeEnabled" effect="dark" :content="$t('e2eeV2Hint')">
            <el-tag :type="e2eeUnlocked ? 'success' : 'warning'" size="small">{{ $t('e2eeBadge') }}</el-tag>
          </el-tooltip>
          <!-- Phase 7：AI 写信 / 回信。aiEnabled 为 0（开关关闭）时隐藏按钮；
               回信模式只显示 AI 回信，新写/转发/草稿只显示 AI 写信。 -->
          <el-button v-if="aiEnabled && form.sendType !== 'reply'" size="small" type="primary" plain @click="openAiDialog('compose')">{{ $t('ai.compose') }}</el-button>
          <el-button v-if="aiEnabled && form.sendType === 'reply'" size="small" type="primary" plain @click="openAiDialog('reply')">{{ $t('ai.reply') }}</el-button>
          <div @click="close" role="button" :aria-label="t('close')" tabindex="0" @keydown.enter="close" @keydown.space.prevent="close" style="cursor: pointer; display: flex;">
            <Icon icon="material-symbols-light:close-rounded" width="22" height="22"/>
          </div>
        </div>
      </div>
      <!-- 写信页顶部斯诺登名言小字，三句轮换。 -->
      <div class="write-quote-strip">
        <transition name="write-quote-fade" mode="out-in">
          <div :key="quoteIndex" class="write-quote">
            <span class="write-quote-en">“{{ QUOTES[quoteIndex].en }}”</span>
            <span class="write-quote-zh">{{ $t(QUOTES[quoteIndex].key) }}</span>
            <span class="write-quote-by">— Edward Snowden</span>
          </div>
        </transition>
      </div>
      <div class="container">
        <!-- Phase 8 E：撤回发送倒计时条（后端返回 pending 时显示；撤回后恢复草稿，超时后确认发出）。 -->
        <UndoSendBar v-if="pendingSend" :pending-id="pendingSend.pendingId" :undo-seconds="pendingSend.undoSeconds" :undo-until="pendingSend.undoUntil" @undo="onUndoSend" @expired="onUndoExpired" />
        <el-input-tag  @add-tag="addTagChange" tag-type="primary" @input="inputChange" size="default" v-model="form.receiveEmail" >
          <template #prefix>
            <div class="item-title" >{{ $t('recipient') }}</div>
            <el-select
                ref="mySelect"
                class="write-select"
                popper-class="write-select"
                :show-arrow="false"
                :no-match-text="' '"
                :no-data-text="' '"
                @visible-change="selectStatusChange"
                @change="selectChange"
            >
              <el-option
                  v-for="item in selectRecipientList"
                  :key="item"
                  :label="item"
                  :value="item"
                  style="color: #999896;"
              />
            </el-select>
          </template>
          <template #suffix>
            <div style="display: flex;margin-right: 3px;">
              <Icon icon="fa7-solid:user-plus" width="20" height="20" class="add-contact" @click.stop="openContacts" />
            </div>
          </template>
        </el-input-tag>
        <el-input v-model="form.subject" :placeholder="t('subject')" />
        <tinyEditor :def-value="defValue" ref="editor" @change="change" @focus="focusChange" />
        <div class="button-item">
          <div class="att-add" @click="chooseFile">
            <Icon icon="iconamoon:attachment-fill" width="24" height="24"/>
          </div>
          <div class="att-clear" @click="clearContent">
            <Icon icon="icon-park-outline:clear-format" width="24" height="24 "/>
          </div>
          <!-- 斯诺登第三批（v3_16DB）：隐写术——把短文本藏进 PNG 图片（仅站内有效，见说明）。 -->
          <el-tooltip effect="dark" :content="$t('stegoBtnHint')" placement="top">
            <div class="att-add" @click="stegoDialogVisible = true">
              <Icon icon="hugeicons:image-01" width="24" height="24"/>
            </div>
          </el-tooltip>
          <!-- 写信页 AI 主入口：底部工具栏里的渐变大按钮，一眼可见；顶部小按钮保留。 -->
          <el-button v-if="aiEnabled" class="ai-toolbar-btn" size="small" @click="openAiDialog(form.sendType === 'reply' ? 'reply' : 'compose')">
            <Icon icon="hugeicons:ai-chat-02" width="16" height="16"/>
            {{ form.sendType === 'reply' ? $t('ai.reply') : $t('ai.compose') }}
          </el-button>
          <div class="att-list">
            <div class="att-item" v-for="(item,index) in form.attachments" :key="index">
              <Icon v-bind="getIconByName(item.filename)"/>
              <span class="att-filename">{{ item.filename }}</span>
              <span class="att-size">{{ formatBytes(item.size) }}</span>
              <Icon style="cursor: pointer;" icon="material-symbols-light:close-rounded" @click="delAtt(index)"
                    width="22" height="22"/>
              <ExifStripNotice :stripped="item.exifStripped" :removed="item.exifRemoved" />
            </div>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <!-- 自毁邮件：选有效期（阅后即焚 / 1小时 / 1天 / 7天 / 30天），默认不过期。 -->
            <el-select v-model="form.expireOption" size="small" style="width: 130px" :placeholder="t('expireOptionNone')" placement="top-start">
              <el-option value="none" :label="t('expireOptionNone')" />
              <el-option value="burn" :label="t('expireOptionBurn')" />
              <el-option value="1h" :label="t('expireOption1h')" />
              <el-option value="1d" :label="t('expireOption1d')" />
              <el-option value="7d" :label="t('expireOption7d')" />
              <el-option value="30d" :label="t('expireOption30d')" />
            </el-select>
            <!-- 斯诺登第三批（v3_16DB）：时间锁——仅 E2EE 站内信可选；到时服务端才放行密钥。 -->
            <el-select v-if="e2eeEnabled" v-model="form.timelockOption" size="small" style="width: 130px" :placeholder="t('timelockNone')" placement="top-start">
              <el-option value="none" :label="t('timelockNone')" />
              <el-option value="1h" :label="t('timelock1h')" />
              <el-option value="1d" :label="t('timelock1d')" />
              <el-option value="7d" :label="t('timelock7d')" />
              <el-option value="30d" :label="t('timelock30d')" />
            </el-select>
            <!-- 斯诺登第三批（v3_16DB）：可否认认证——仅 E2EE 站内信可选；用共用密钥做 MAC，任何一方都能伪造，第三方无法证明是谁发的。 -->
            <el-tooltip v-if="e2eeEnabled" effect="dark" :content="$t('deniableHint')" placement="top">
              <el-checkbox v-model="form.deniable" size="small" style="margin-right: 4px">{{ $t('deniableLabel') }}</el-checkbox>
            </el-tooltip>
            <!-- Phase 8 E：定时发送（选时间后走同一 sendEmail，按 scheduledAt 发）。 -->
            <el-button size="small" @click="scheduleDialogVisible = true">{{ $t('trust.scheduleSend') }}</el-button>
            <el-dropdown split-button type="primary" trigger="click" placement="top" @click="sendEmail" @command="selectSendMode">
              {{ sendButtonLabel }}
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="together">
                    {{ $t(form.sendType === 'forward' ? 'forward' : 'send') }}
                  </el-dropdown-item>
                  <el-dropdown-item command="divide">
                    {{ separateSendLabel }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
        <!-- Phase 8 斯诺登元素补齐：发送按钮下方隐私小字。 -->
        <div class="send-privacy-note">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
          <span>{{ $t('writePrivacyNote') }}</span>
        </div>
      </div>
    </div>
    <el-dialog top="10vh" v-model="showContacts" @closed="clearSelectContact" :title="t('recentContacts')">
      <el-table ref="contactsTabRef" row-key="email" :data="contacts" style="height: 445px">
        <el-table-column type="selection" width="32" />
        <el-table-column property="email" :label="t('emailAccount')" >
          <template #default="props">
            <div class="email-row">{{ props.row.email }}</div>
          </template>
        </el-table-column>
        <el-table-column width="55" label="" >
          <template #default>
            <div style="display: flex;">
              <Icon icon="mage:user" style="color: var(--el-text-color-primary)" width="22" height="22" color="#606266" />
            </div>
          </template>
        </el-table-column>
      </el-table>
      <div class="contacts-bottom">
        <el-button type="default" @click="deleteContact">{{t('clear')}}</el-button>
        <el-button type="primary" @click="chooseContact">{{t('selectContacts')}}</el-button>
      </div>
    </el-dialog>
    <!-- Phase 7：AI 写信 / 回信对话框。生成后先预览草稿（标题 + 正文），
         点“使用草稿”才填入编辑器；remaining 为当日剩余次数。 -->
    <el-dialog v-model="aiDialogVisible" :title="aiDialogMode === 'reply' ? t('ai.reply') : aiDialogMode === 'polish' ? t('ai.polish') : t('ai.compose')" class="ai-dialog" @closed="resetAiDialog">
      <div v-if="aiDialogMode === 'compose'" class="ai-prompt">
        <el-input v-model="aiPrompt" type="textarea" :rows="4" maxlength="2000" show-word-limit :placeholder="t('ai.composePlaceholder')" />
      </div>
      <!-- 写信模式且已有正文时：提供“润色当前正文”入口，切到润色模式。 -->
      <div v-if="aiDialogMode === 'compose' && aiCanPolish" class="ai-polish-row">
        <span>{{ $t('ai.polishHint') }}</span>
        <el-button size="small" type="primary" plain @click="startAiPolish">{{ $t('ai.polishCurrent') }}</el-button>
      </div>
      <!-- 润色模式：说明 + 当前正文预览（只读），点生成后走 /ai/compose 润色。 -->
      <div v-if="aiDialogMode === 'polish'" class="ai-polish-note">
        <div>{{ $t('ai.polishNote') }}</div>
        <div class="ai-polish-source">{{ aiPolishSource }}</div>
      </div>
      <!-- AI 写信选项：语气 / 长度 / 语言，三组都直接传给后端影响生成结果；
           不选时用默认（语气自然、长度适中、语言跟随界面），与旧调用兼容。 -->
      <div class="ai-tone-row">
        <span class="ai-tone-label">{{ $t('ai.tone') }}</span>
        <el-select v-model="aiTone" style="width: 104px">
          <el-option value="formal" :label="t('ai.toneFormal')" />
          <el-option value="friendly" :label="t('ai.toneFriendly')" />
          <el-option value="concise" :label="t('ai.toneConcise')" />
          <el-option value="enthusiastic" :label="t('ai.toneEnthusiastic')" />
          <el-option value="neutral" :label="t('ai.toneNeutral')" />
        </el-select>
        <span class="ai-tone-label">{{ $t('ai.length') }}</span>
        <el-select v-model="aiLength" style="width: 96px">
          <el-option value="short" :label="t('ai.lengthShort')" />
          <el-option value="medium" :label="t('ai.lengthMedium')" />
          <el-option value="detailed" :label="t('ai.lengthDetailed')" />
        </el-select>
        <span class="ai-tone-label">{{ $t('ai.language') }}</span>
        <el-select v-model="aiLanguage" style="width: 118px">
          <el-option value="auto" :label="t('ai.languageAuto')" />
          <el-option value="zh-CN" :label="t('ai.languageZh')" />
          <el-option value="en" :label="t('ai.languageEn')" />
        </el-select>
      </div>
      <div v-if="aiDraft" class="ai-draft">
        <div class="ai-draft-label">{{ $t('ai.subject') }}</div>
        <div class="ai-draft-subject">{{ aiDraft.subject }}</div>
        <div class="ai-draft-label">{{ $t('ai.body') }}</div>
        <pre class="ai-draft-body">{{ aiDraft.body }}</pre>
      </div>
      <div v-if="aiRemaining !== null" class="ai-remaining">{{ $t('ai.remaining', {count: aiRemaining}) }}</div>
      <template #footer>
        <el-button @click="aiDialogVisible = false">{{ $t('cancel') }}</el-button>
        <el-button type="primary" :loading="aiGenerating" @click="generateAiDraft">{{ aiGenerateLabel }}</el-button>
        <el-button v-if="aiDraft" type="success" :disabled="aiGenerating" @click="useAiDraft">{{ $t('ai.useDraft') }}</el-button>
      </template>
    </el-dialog>
    <!-- Phase 8 E：定时发送选择器（确认后填 scheduledAt 并走同一 sendEmail）。 -->
    <ScheduleSendDialog v-model="scheduleDialogVisible" @confirm="onScheduleConfirm" />
    <!-- 斯诺登第三批（v3_16DB）：隐写术——把短文本藏进 PNG 图片最低有效位（仅站内有效；对外经 SMTP 转码可能失效）。 -->
    <el-dialog v-model="stegoDialogVisible" :title="$t('stegoTitle')" width="480px" :close-on-click-modal="false">
      <div class="desc" style="margin-bottom: 12px">{{ $t('stegoDesc') }}</div>
      <div class="desc" style="margin-bottom: 12px">{{ $t('stegoWarn') }}</div>
      <el-button @click="chooseStegoCarrier">{{ stegoCarrierName || $t('stegoChoosePng') }}</el-button>
      <div v-if="stegoCarrierName" class="desc" style="margin: 8px 0">{{ $t('stegoCapacity', { n: stegoCapacity }) }}</div>
      <el-input v-model="stegoText" type="textarea" :rows="3" :placeholder="$t('stegoTextPlaceholder')" style="margin-top: 12px" />
      <template #footer>
        <el-button @click="stegoDialogVisible = false">{{ $t('cancel') }}</el-button>
        <el-button type="primary" :loading="stegoLoading" :disabled="!stegoCarrierFile || !stegoText" @click="embedStego">{{ $t('stegoEmbedAttach') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>
<script setup>
import tinyEditor from '@/components/tiny-editor/index.vue'
import {h, nextTick, onMounted, onUnmounted, reactive, ref, toRaw, computed} from "vue";
import {Icon} from "@iconify/vue";
import {useUserStore} from "@/store/user.js";
import {emailSend} from "@/request/email.js";
import {isEmail} from "@/utils/verify-utils.js";
import {useAccountStore} from "@/store/account.js";
import {useEmailStore} from "@/store/email.js";
import {fileToBase64, formatBytes} from "@/utils/file-utils.js";
import {getIconByName} from "@/utils/icon-utils.js";
import sendPercent from "@/components/send-percent/index.vue"
import {toOssDomain} from "@/utils/convert.js";
import {formatDetailDate} from "@/utils/day.js";
import {useSettingStore} from "@/store/setting.js";
import {userDraftStore} from "@/store/draft.js";
import {useWriterStore} from "@/store/writer.js";
import db from "@/db/db.js";
import dayjs from "dayjs";
import {useI18n} from "vue-i18n";
import {friendlySendError} from "@/utils/send-error.js";
import {getSecurity} from "@/request/security.js";
import {aiCompose, aiReply, aiErrorI18nKey, aiComposeStream, aiReplyStream} from "@/request/ai.js";
import {hasMemoryKey, getMemoryKey, unlockWithPassword, isInternalEmail, generateCek, encryptEmailPartsV2, sealSender, wrapCekSym, computeDeniableTag, computeBlindToken, extractKeywords, getMemoryBlindKey} from "@/utils/e2ee.js";
// 斯诺登第四批 P0-1：附件 EXIF 剥离（发信前去掉 GPS/相机/拍摄时间）。
import { stripExifFromFile } from "@/utils/exif-strip.js";
import ExifStripNotice from "@/components/exif-strip-notice/index.vue";
import {embedText, stegoCapacityBytes} from "@/utils/stego.js";
import {wrapCekMlKem} from "@/utils/pqkem.js";
import {getMlkemPubkey} from "@/request/security.js";
import router from "@/router/index.js";
import {ElMessageBox} from "element-plus";
import UndoSendBar from '@/components/mail-trust/UndoSendBar.vue';
import ScheduleSendDialog from '@/components/mail-trust/ScheduleSendDialog.vue';
import {trustGetPrefs, trustCancelPending, trustConfirmPending, trustErrorI18nKey} from "@/request/mail-trust.js";
import {suggestContacts} from "@/request/contacts.js";

defineExpose({
  open,
  openReply,
  openForward,
  openDraft
})

const {t} = useI18n()
const writerStore = useWriterStore();

// 写信页顶部斯诺登名言小字：三句核实过的名言（与开场动画 QUOTES 同源），每 8 秒轮换。
const QUOTES = [
  {
    key: 'intro.quote1',
    en: 'Arguing that you don\'t care about the right to privacy because you have nothing to hide is no different than saying you don\'t care about free speech because you have nothing to say.',
  },
  {
    key: 'intro.quote2',
    en: 'Privacy isn\'t about something to hide. Privacy is about something to protect.',
  },
  {
    key: 'intro.quote3',
    en: 'Under observation, we act less free, which means we effectively are less free.',
  },
]
const quoteIndex = ref(0)
let quoteTimer = null
onMounted(() => {
  quoteTimer = setInterval(() => {
    quoteIndex.value = (quoteIndex.value + 1) % QUOTES.length
  }, 8000)
})
onUnmounted(() => {
  if (quoteTimer) clearInterval(quoteTimer)
})
const draftStore = userDraftStore()
const settingStore = useSettingStore()
const emailStore = useEmailStore();
const accountStore = useAccountStore()
const editor = ref({})
const userStore = useUserStore();
const show = ref(false);
const percent = ref(0)
let percentMessage = null
let sending = false
const defValue = ref('')
const contactsTabRef = ref({})
const showContacts = ref(false)
const mySelect = ref()
let selectStatus = false
const backReply = reactive({
  receiveEmail: [],
  subject: '',
  content: '',
  sendType: ''
})
const form = reactive({
  sendEmail: '',
  receiveEmail: [],
  accountId: -1,
  name: '',
  subject: '',
  content: '',
  sendType: '',
  manyType: 'together',
  text: '',
  emailId: 0,
  attachments: [],
  draftId: null,
  // 自毁邮件：写信时选有效期（none=不过期 / burn=阅后即焚 / 1h/1d/7d/30d），后端发信时刻算 expireAt。
  expireOption: 'none',
  // 斯诺登第三批（v3_16DB）：时间锁（仅 E2EE 站内信）与可否认认证开关。
  timelockOption: 'none',
  deniable: false,
})

const selectRecipientList = ref([])

// Phase 8 E：撤回发送 / 定时发送状态。undoSeconds 从偏好读（默认 2 秒）；
// scheduledAt 只由定时对话框设置、一次 sendEmail 消费完即清零；
// pendingSend 非空时写信框保持打开并显示倒计时条。
const undoSeconds = ref(2)
const scheduledAt = ref(null)
const pendingSend = ref(null)
const scheduleDialogVisible = ref(false)

// 斯诺登第三批（v3_16DB）：隐写术——选一张 PNG 载体 + 一段短文本，藏入后作为附件发出。
const stegoDialogVisible = ref(false)
const stegoCarrierFile = ref(null)
const stegoCarrierName = ref('')
const stegoCarrierSize = ref({w: 0, h: 0})
const stegoText = ref('')
const stegoLoading = ref(false)
const stegoCapacity = computed(() => {
  if (!stegoCarrierSize.value.w) return 0
  return stegoCapacityBytes(stegoCarrierSize.value.w, stegoCarrierSize.value.h)
})

function chooseStegoCarrier() {
  const doc = document.createElement('input')
  doc.setAttribute('type', 'file')
  doc.setAttribute('accept', 'image/png')
  doc.click()
  doc.onchange = async (e) => {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    if (file.type !== 'image/png') {
      ElMessage({message: t('stegoNeedPng'), type: 'error', plain: true})
      return
    }
    try {
      const bitmap = await createImageBitmap(file)
      stegoCarrierFile.value = file
      stegoCarrierName.value = file.name
      stegoCarrierSize.value = {w: bitmap.width, h: bitmap.height}
    } catch (err) {
      ElMessage({message: t('stegoNeedPng'), type: 'error', plain: true})
    }
  }
}

async function embedStego() {
  if (!stegoCarrierFile.value || !stegoText.value) return
  stegoLoading.value = true
  try {
    const blob = await embedText(stegoCarrierFile.value, stegoText.value)
    const filename = stegoCarrierName.value.replace(/\.png$/i, '') + '-stego.png'
    const content = await fileToBase64(new File([blob], filename, {type: 'image/png'}))
    // 隐写图由本站当场生成，无 EXIF；字段照常带上，保持附件对象结构一致。
    form.attachments.push({content, filename, size: blob.size, contentType: 'image/png', exifStripped: false, exifRemoved: []})
    stegoDialogVisible.value = false
    stegoText.value = ''
    stegoCarrierFile.value = null
    stegoCarrierName.value = ''
    ElMessage({message: t('stegoEmbedOk'), type: 'success', plain: true})
  } catch (err) {
    console.error(err)
    ElMessage({message: t(err?.message === 'text too long for this image' ? 'stegoTooLong' : 'stegoEmbedFail'), type: 'error', plain: true})
  } finally {
    stegoLoading.value = false
  }
}

async function onUndoSend() {
  if (!pendingSend.value) return
  try {
    const res = await trustCancelPending(pendingSend.value.pendingId)
    pendingSend.value = null
    if (res?.draft) {
      // 撤回后恢复成草稿：写回 Dexie 草稿 store，同时填回当前写信框可继续编辑。
      draftStore.setDraft = res.draft
      Object.assign(form, {...res.draft, manyType: res.draft.manyType || 'together'})
      defValue.value = ''
      setTimeout(() => defValue.value = form.content)
    }
    ElMessage({ message: t('trust.undoSuccess'), type: 'success', plain: true })
  } catch (e) {
    ElMessage({ message: t(trustErrorI18nKey(e.code)) || e.message, type: 'error', plain: true })
  }
}

async function onUndoExpired() {
  if (!pendingSend.value) return
  const id = pendingSend.value.pendingId
  pendingSend.value = null
  try {
    const result = await trustConfirmPending(id)
    const emailList = Array.isArray(result) ? result : result.emails
    if (emailList?.length) {
      emailList.forEach(item => emailStore.sendScroll?.addItem(item))
      userStore.refreshUserInfo()
      addRecipientRecord()
      ElNotification({
        title: t('sendSuccessMsg'),
        type: 'success',
        message: h('span', {style: 'color: teal'}, emailList[0].subject),
        position: 'bottom-right'
      })
    }
    if (form.draftId) {
      form.subject = ''
      form.content = ''
      form.receiveEmail = []
      draftStore.setDraft = {...toRaw(form)}
    }
    show.value = false
    resetForm()
  } catch (e) {
    // 确认失败：信还在 pending 里（后端未删），留着写信框让用户重试。
    ElMessage({ message: t(trustErrorI18nKey(e.code)) || e.message, type: 'error', plain: true })
    show.value = true
  }
}

function onScheduleConfirm(time) {
  scheduledAt.value = time
  scheduleDialogVisible.value = false
  sendEmail()
}

// Phase 7：AI 写信 / 回信。aiEnabled 取自 websiteConfig（settingStore.settings），
// 后端默认 1（开启）；为 0 时按钮隐藏。未取到配置时按开启处理（与后端 ?? 1 一致）。
const aiEnabled = computed(() => settingStore.settings?.aiEnabled !== 0)
const aiDialogVisible = ref(false)
const aiDialogMode = ref('compose') // 'compose' | 'reply' | 'polish'
const aiPrompt = ref('')
const aiTone = ref('neutral')
const aiGenerating = ref(false)
const aiDraft = ref(null) // {subject, body}
const aiRemaining = ref(null)
const aiCanPolish = ref(false) // 写信模式且编辑器已有正文时，显示“润色当前正文”入口
const aiPolishSource = ref('') // 润色源文本（当前正文，截到 1800 字以内）

// 生成按钮文案随模式变：回信 / 润色 / 写信；生成中显示“AI 生成中…”。
const aiGenerateLabel = computed(() => {
  if (aiGenerating.value) return t('ai.generating')
  if (aiDialogMode.value === 'reply') return t('ai.reply')
  if (aiDialogMode.value === 'polish') return t('ai.polish')
  return t('ai.compose')
})

// 读当前编辑器纯文本（润色用；form.text 只在输入事件时更新，直接读编辑器最可靠）。
function getEditorText() {
  try {
    if (editor.value && typeof editor.value.getContent === 'function') {
      const txt = editor.value.getContent({format: 'text'}) || ''
      if (txt.trim()) return txt
    }
  } catch (e) {}
  return form.text || ''
}

function openAiDialog(mode) {
  aiDialogMode.value = mode
  aiDraft.value = null
  aiLength.value = 'medium'
  aiLanguage.value = 'auto'
  aiCanPolish.value = getEditorText().trim().length > 0
  aiDialogVisible.value = true
}

// 润色模式：以当前正文为源（截到 1800 字以内，保证指令+正文不超过后端 2000 字上限）。
function startAiPolish() {
  const src = getEditorText().trim().slice(0, 1800)
  if (!src) {
    ElMessage({message: t('ai.polishEmpty'), type: 'error', plain: true})
    return
  }
  aiPolishSource.value = src
  aiDialogMode.value = 'polish'
  aiDraft.value = null
}
// AI 写信选项（默认：语气自然、长度适中、语言跟随界面；三组都直接传给后端，
// 语言选中文/英文时后端按该语言直接起草，不再起草后再翻译，省一次调用）。
const aiLength = ref('medium') // 'short' | 'medium' | 'detailed'
const aiLanguage = ref('auto') // 'auto' | 'zh-CN' | 'en'

function resetAiDialog() {
  aiPrompt.value = ''
  aiTone.value = 'neutral'
  aiLength.value = 'medium'
  aiLanguage.value = 'auto'
  aiDraft.value = null
  aiGenerating.value = false
  aiPolishSource.value = ''
}

// 流式生成时的增量解析：第一行非空行当标题，其余当正文；
// 只有标题一行时正文先空着，等正文 token 到了再填（与后端 _parseSubjectBody 同格式）。
function parseLiveSubjectBody(text) {
  const lines = String(text || '').split('\n')
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  if (i >= lines.length) return { subject: '', body: '' }
  const subject = lines[i].trim()
  let j = i + 1
  while (j < lines.length && !lines[j].trim()) j++
  return { subject, body: lines.slice(j).join('\n').trim() }
}

async function generateAiDraft() {
  if (aiGenerating.value) return
  if (aiDialogMode.value === 'compose' && !aiPrompt.value.trim()) {
    ElMessage({
      message: t('ai.invalidInput'),
      type: 'error',
      plain: true,
    })
    return
  }
  aiGenerating.value = true
  try {
    // 流式生成：逐 token 填预览，首 token 约 1-2 秒可见；流式失败时回退一次性生成。
    // 流式只在成功结束时才计 1 次配额，中途失败不计数，回退不重复扣。
    let rawText = ''
    const applyRaw = () => {
      const parsed = parseLiveSubjectBody(rawText)
      aiDraft.value = aiDialogMode.value === 'polish'
        ? {subject: form.subject || parsed.subject || '', body: parsed.body}
        : parsed
    }
    const streamOrFallback = async (mode, payload) => {
      try {
        if (mode === 'reply') return await aiReplyStream(payload, (d) => { rawText += d; applyRaw() })
        return await aiComposeStream(payload, (d) => { rawText += d; applyRaw() })
      } catch (e) {
        if (mode === 'reply') return await aiReply(payload)
        return await aiCompose(payload)
      }
    }
    let data
    if (aiDialogMode.value === 'compose') {
      data = await streamOrFallback('compose', {prompt: aiPrompt.value.trim(), tone: aiTone.value, length: aiLength.value, language: aiLanguage.value})
    } else if (aiDialogMode.value === 'polish') {
      // 润色按当前正文生成：指令 + 正文拼成 prompt 走 /ai/compose；源文本已截到 1800 字以内。
      const src = (aiPolishSource.value || getEditorText()).trim().slice(0, 1800)
      if (!src) {
        ElMessage({message: t('ai.polishEmpty'), type: 'error', plain: true})
        return
      }
      data = await streamOrFallback('compose', {prompt: t('ai.polishPrompt', {text: src}), tone: aiTone.value, length: aiLength.value, language: aiLanguage.value})
    } else {
      // 回信按原邮件生成：传本人的 emailId，后端读原邮件；无 emailId 时后端报 ai_not_found
      data = await streamOrFallback('reply', {emailId: form.emailId, tone: aiTone.value, length: aiLength.value, language: aiLanguage.value})
    }
    // 流结束：用后端最终解析结果覆盖增量解析（更准确）。
    // 润色不改标题：预览里也显示当前标题，避免“预览一个标题、用上另一个标题”。
    aiDraft.value = aiDialogMode.value === 'polish'
      ? {subject: form.subject || data.subject || '', body: data.body || ''}
      : {subject: data.subject || '', body: data.body || ''}
    if (typeof data.remaining === 'number') aiRemaining.value = data.remaining
  } catch (e) {
    handleAiError(e)
  } finally {
    aiGenerating.value = false
  }
}

// 把预览的 AI 草稿填入编辑器（标题进主题栏，正文经 defValue 进 TinyMCE，可再编辑）。
// 回信时 AI 正文放在引用原文之上，引用块（backReply.content）原样保留。
function useAiDraft() {
  if (!aiDraft.value) return
  // 润色只换正文，不动用户已写的标题。
  if (aiDialogMode.value !== 'polish' && aiDraft.value.subject) form.subject = aiDraft.value.subject
  const bodyHtml = textToHtml(aiDraft.value.body)
  if (aiDialogMode.value === 'reply') {
    defValue.value = bodyHtml + '<div><br></div>' + (backReply.content || '')
  } else {
    defValue.value = bodyHtml
  }
  aiDialogVisible.value = false
  aiDraft.value = null
}

// AI 返回的纯文本转编辑器 HTML：先转义再按行分段，避免原文 HTML 被当作标签解析。
function textToHtml(text) {
  const esc = String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  return esc.split(/\n/).map(line => line ? `<p style="margin: 0 0 8px;">${line}</p>` : '<p style="margin: 0 0 8px;"><br></p>').join('')
}

function handleAiError(e) {
  if (e && e.code === 401) {
    localStorage.removeItem('token')
    router.replace('/login')
    return
  }
  ElMessage({
    message: t(aiErrorI18nKey(e && e.code)),
    type: 'error',
    plain: true,
  })
}

// 第六阶段 C 路：端到端加密状态（打开写信框时 best-effort 拉取；后端未落地时按未开启处理）。
const e2eeEnabled = ref(false)
const e2eeSalt = ref('')
const e2eeUnlocked = ref(false)
function loadE2eeStatus() {
  getSecurity().then((data) => {
    e2eeEnabled.value = !!data?.e2eeEnabled
    e2eeSalt.value = data?.e2eeSalt || ''
    e2eeUnlocked.value = hasMemoryKey() && e2eeEnabled.value
  }).catch(() => {
    e2eeEnabled.value = false
  })
}

const contacts = computed(() => writerStore.sendRecipientRecord.map(item => ({email: item})))
const separateSendLabel = computed(() => t(form.sendType === 'forward' ? 'separateForward' : 'separateSend'))
const sendButtonLabel = computed(() => {
  if (form.manyType === 'divide') return separateSendLabel.value
  if (form.sendType === 'reply') return t('reply')
  if (form.sendType === 'forward') return t('forward')
  return t('send')
})

function selectSendMode(mode) {
  form.manyType = mode
}

function openContacts() {
  showContacts.value = true
  nextTick(() => {
    form.receiveEmail.forEach(item => {
      if (writerStore.sendRecipientRecord.includes(item)) {
        contactsTabRef.value.toggleRowSelection({email: item});
      }
    })
  })
}

function deleteContact() {
  ElMessageBox.confirm(t('confirmDeletionOfContacts'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    const contactList = contactsTabRef.value.getSelectionRows().map(item => item.email);
    form.receiveEmail = form.receiveEmail.filter(item => !contactList.includes(item));
    writerStore.sendRecipientRecord = writerStore.sendRecipientRecord.filter(item => !contactList.includes(item));
  })
}

function chooseContact() {

  const contactList = contactsTabRef.value.getSelectionRows().map(item => item.email);
  contactList.forEach(item => {
    if (!form.receiveEmail.includes(item)) {
      form.receiveEmail.push(item);
    }
  })

  form.receiveEmail = form.receiveEmail.filter(item => {
    return contactList.includes(item) || !writerStore.sendRecipientRecord.includes(item);
  });

  showContacts.value = false
}

function clearSelectContact() {
  contactsTabRef.value.clearSelection();
}

function selectChange(value) {
  form.receiveEmail.push(value)
}

function selectStatusChange(status) {
  selectStatus = status
}

const openSelect = () => {
  mySelect.value.toggleMenu()
}

async function inputChange(value) {

  selectRecipientList.value = writerStore.sendRecipientRecord.filter(item => value && !form.receiveEmail.includes(item) && item.startsWith(value)).slice(0, 10);

  // Phase 8 F：联系人联想（best-effort，与本地收件记录合并去重，上限 10 个）。
  if (value) {
    try {
      const contacts = await suggestContacts(value)
      const merged = [...selectRecipientList.value]
      for (const c of contacts || []) {
        const email = typeof c === 'string' ? c : c.email
        if (email && !form.receiveEmail.includes(email) && !merged.includes(email)) merged.push(email)
      }
      selectRecipientList.value = merged.slice(0, 10)
    } catch (e) {
      // 联想失败不影响输入
    }
  }

  if (!selectStatus && selectRecipientList.value.length > 0) {
    openSelect()
  }

  if (selectStatus && selectRecipientList.value.length === 0) {
    openSelect()
  }

}

function addTagChange(val) {

  const emails = Array.from(new Set(
      val.split(/[,，]/).map(item => item.trim()).filter(item => item)
  ));

  form.receiveEmail.splice(form.receiveEmail.length - 1, 1)

  let has = false
  emails.forEach(email => {
    if (isEmail(email) && !form.receiveEmail.includes(email)) {
      form.receiveEmail.push(email)
      has = true
    }
  })
  if (selectStatus && has) openSelect()
}

function clearContent() {
  ElMessageBox.confirm(t('clearContentConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    resetForm()
  })

}

function delAtt(index) {
  form.attachments.splice(index, 1);
}

function chooseFile() {
  const doc = document.createElement("input")
  doc.setAttribute("type", "file")
  doc.multiple = true;
  doc.click()
  doc.onchange = async (e) => {

    const fileList = e.target.files;

    for (const file of fileList) {

      // 斯诺登第四批 P0-1：图片附件先剥 EXIF（GPS/相机/拍摄时间）再入队；剥离失败返回原文件。
      const { file: cleanFile, stripped, removed } = await stripExifFromFile(file)
      const size = cleanFile.size
      const filename = cleanFile.name
      const contentType = cleanFile.type

      const content = await fileToBase64(cleanFile)
      form.attachments.push({content, filename, size, contentType, exifStripped: stripped, exifRemoved: removed})

    }

  }
}

async function sendEmail() {

  if (form.receiveEmail.length === 0) {
    ElMessage({
      message: t('emptyRecipientMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (!form.subject) {
    ElMessage({
      message: t('emptySubjectMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  form.content = editor.value.getContent();

  if (!form.content) {
    ElMessage({
      message: t('emptyContentMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (sending || pendingSend.value) {
    ElMessage({
      message: t('sendingErrorMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  // 第六阶段 C 路：E2EE 开启时加密 text/content 后发信并传 e2ee: 1；只加密副本 payload，
  // 不改 form（避免密文留在编辑器/草稿里）。附件本阶段不加密。
  // 斯诺登第二批（v3_15DB）：v2 信封——每封信单独生成一次性密钥 CEK，正文用 CEK
  // 加密；发件人用 CEK 密封成 sealedSender；CEK 按收件人分别包裹（对方有
  // ML-KEM-768 公钥时抗量子包裹，否则对称包裹）；发件人自己的那份用 KEK 对称包裹
  // （已发送副本用）。后端只在 E2EE 站内信时收这些字段，站外直接丢弃。
  // 注意：本块必须在进度提示创建之前——提前 return 时提示尚未创建，不会卡住。
  let payload = {...toRaw(form)}
  if (e2eeEnabled.value) {
    const domains = settingStore.domainList || []
    const external = form.receiveEmail.filter((addr) => !isInternalEmail(addr, domains))
    if (external.length) {
      ElMessage({
        message: t('e2eeExternalBlocked'),
        type: 'error',
        plain: true,
      })
      return
    }
    try {
      if (!hasMemoryKey()) {
        const {value: passphrase} = await ElMessageBox.prompt(t('e2eePasswordPlaceholder'), t('e2eeTitle'), {
          inputType: 'password',
          confirmButtonText: t('confirm'),
          cancelButtonText: t('cancel'),
        })
        if (!passphrase) {
          ElMessage({
            message: t('e2eeNeedPassword'),
            type: 'error',
            plain: true,
          })
          return
        }
        await unlockWithPassword(passphrase, e2eeSalt.value)
        e2eeUnlocked.value = true
      }
      const kek = getMemoryKey()
      const {key: cekKey, raw: cekRaw} = await generateCek()
      const enc = await encryptEmailPartsV2({text: form.text, content: form.content}, cekKey)
      const sealedSender = await sealSender({email: form.sendEmail, name: form.name}, cekKey)
      const cekWraps = []
      for (const addr of form.receiveEmail) {
        let wrapped = null
        let alg = 'sym'
        try {
          const res = await getMlkemPubkey(addr)
          const pub = res?.publicKey || ''
          if (pub) {
            wrapped = await wrapCekMlKem(cekRaw, pub)
            alg = 'mlkem768'
          }
        } catch (e) {
          // 取公钥失败 → 回落对称包裹，不阻断发信（前向保密仍然生效）。
        }
        if (!wrapped) {
          wrapped = await wrapCekSym(cekRaw, kek)
        }
        cekWraps.push({to: addr, alg, wrapped})
      }
      // 发件人自己的包裹（已发送副本用，恒为对称包裹；缺了它后端会 400 拒发）。
      cekWraps.push({to: form.sendEmail, alg: 'sym', wrapped: await wrapCekSym(cekRaw, kek)})
      // 诚实提示：有收件人回落到对称包裹时，对方没有抗量子密钥，只有与发件人
      // 共用同一加密密码才能解密（v1 模型的既有前提；ML-KEM 路径不受此限）。
      // 发信后 2 秒内可撤回（undo），故用警告提示而不拦截。
      if (cekWraps.some(w => w.to !== form.sendEmail && w.alg === 'sym')) {
        ElMessage({
          message: t('e2eeSymFallbackWarn'),
          type: 'warning',
          plain: true,
          duration: 6000,
        })
      }
      // 斯诺登第三批（v3_16DB）：时间锁 / 可否认 / 盲索引（仅 E2EE 站内信）。
      // 时间锁：按选项算解锁时刻（UTC 'YYYY-MM-DD HH:mm:ss'），服务端到时才放行密钥。
      const TIMELOCK_MS = { '1h': 3600000, '1d': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 }
      let timelockUntil = ''
      if (form.timelockOption && form.timelockOption !== 'none' && TIMELOCK_MS[form.timelockOption]) {
        const d = new Date(Date.now() + TIMELOCK_MS[form.timelockOption])
        timelockUntil = d.toISOString().slice(0, 19).replace('T', ' ')
      }
      // 可否认：用 CEK 对密文正文算 HMAC 标签（denyTag）；收件人解出 CEK 后也能
      // 算出同一标签，任何一方都能伪造，第三方无法证明是谁发的。
      let deniable = 0
      let denyTag = ''
      if (form.deniable) {
        try {
          denyTag = await computeDeniableTag(cekRaw, enc.content)
          deniable = 1
        } catch (e) {
          console.error('可否认标签计算失败（按不可否认发信）:', e)
        }
      }
      // 盲索引：从标题 + 纯文本提关键词，用盲索引密钥算 token 随信发；
      // 服务端只存 token，不解密正文。失败时不阻断发信（该信只是搜不到）。
      let blindTokens = []
      try {
        const blindKey = getMemoryBlindKey()
        if (blindKey) {
          const keywords = extractKeywords((form.subject || '') + ' ' + (form.text || ''), 50)
          for (const kw of keywords) {
            blindTokens.push(await computeBlindToken(kw, blindKey))
          }
        }
      } catch (e) {
        console.error('盲索引 token 计算失败:', e)
        blindTokens = []
      }
      payload = {...payload, text: enc.text, content: enc.content, e2ee: 1, e2eeVer: 2, sealedSender, cekWraps, timelockUntil, deniable, denyTag, blindTokens}
    } catch (e) {
      if (e === 'cancel') {
        return
      }
      console.error(e)
      ElMessage({
        message: t('e2eeEncryptFailed'),
        type: 'error',
        plain: true,
      })
      return
    }
  }

  percentMessage = ElMessage({
    message: () => h(sendPercent, {value: percent.value, desc: t('sending')}),
    dangerouslyUseHTMLString: true,
    plain: true,
    duration: 0,
    customClass: 'message-bottom'
  })

  sending = true

  // Phase 8 E：撤回延迟与定时时间进 payload。写信框不要在这里先关：
  // pending 时要留在框里显示倒计时条，scheduled/normal 成功时才关。
  payload.undoSeconds = undoSeconds.value
  if (scheduledAt.value) payload.scheduledAt = scheduledAt.value

  emailSend(payload, (e) => {
    percent.value = Math.round((e.loaded * 98) / e.total)
  }).then(result => {
    // Phase 8 E：pending / scheduled 分支必须在 result.emails 之前处理——
    // 这两种结果里没有 emails（pending 在窗口内根本没发，scheduled 还没到点）。
    if (result?.pending) {
      pendingSend.value = result
      return
    }
    if (result?.scheduled) {
      ElNotification({
        title: t('trust.scheduleSend'),
        type: 'success',
        message: t('trust.scheduleNote'),
        position: 'bottom-right'
      })
      if (form.draftId) {
        form.subject = ''
        form.content = ''
        form.receiveEmail = []
        draftStore.setDraft = {...toRaw(form)}
      }
      show.value = false
      resetForm()
      return
    }
    const emailList = Array.isArray(result) ? result : result.emails
    const email = emailList[0]
    emailList.forEach(item => {
      emailStore.sendScroll?.addItem(item)
    })

    userStore.refreshUserInfo();
    addRecipientRecord();

    if (result.failedRecipients?.length) {
      form.receiveEmail = result.failedRecipients
      show.value = true
      ElNotification({
        title: t('partialSendMsg', {count: emailList.length, failed: result.failedRecipients.length}),
        type: 'warning',
        message: result.error,
        position: 'bottom-right'
      })
      return
    }

    ElNotification({
      title: t('sendSuccessMsg'),
      type: "success",
      message: h('span', {style: 'color: teal'}, email.subject),
      position: 'bottom-right'
    })

    if (form.draftId) {
      form.subject = ''
      form.content = ''
      form.receiveEmail = []
      draftStore.setDraft = {...toRaw(form)}
    }

    show.value = false
    resetForm();
  }).catch((e) => {
    ElNotification({
      title: t('sendFailMsg'),
      type: e.code === 403 ? 'warning' : 'error',
      message: h('span', {style: 'color: teal'}, e.message && String(e.message).includes('e2eeExternalBlocked') ? t('e2eeExternalBlocked') : friendlySendError(e.message, t)),
      position: 'bottom-right'
    })
    if (e.code === 401) {
      localStorage.removeItem('token');
      router.replace('/login');
    }
    show.value = true
    addRecipientRecord();
  }).finally(() => {
    percentMessage.close()
    percent.value = 0
    sending = false
    // Phase 8 E：scheduledAt 一次 sendEmail 消费完即清零（避免下次点普通发送也被定时）。
    scheduledAt.value = null
  })
}

function addRecipientRecord() {
  writerStore.sendRecipientRecord = writerStore.sendRecipientRecord.filter(
      email => !form.receiveEmail.includes(email)
  );

  writerStore.sendRecipientRecord.unshift(...form.receiveEmail);
  writerStore.sendRecipientRecord = writerStore.sendRecipientRecord.slice(0, 500);
}

function resetForm() {
  form.receiveEmail = []
  form.subject = ''
  form.content = ''
  form.manyType = 'together'
  form.attachments = []
  form.sendType = ''
  form.emailId = 0
  form.draftId = null
  form.expireOption = 'none'
  form.timelockOption = 'none'
  form.deniable = false
  backReply.content = ''
  backReply.subject = ''
  backReply.receiveEmail = []
  backReply.sendType = ''
  editor.value.clearEditor()
}

function change(content, text) {
  form.content = content;
  form.text = text
}

function focusChange() {
  if (selectStatus) openSelect()
}

function openForward(email) {
  resetForm();

  email.subject = email.subject || ''

  form.subject = email.subject
  form.sendType = 'forward'

  defValue.value = ''

  setTimeout(() => {
    defValue.value = `
      ${formatImage(email.content) || `<pre style="font-family: inherit;word-break: break-word;white-space: pre-wrap;margin: 0">${email.text}</pre>`}
    `
    open()

    nextTick(() => {
      backReply.content = editor.value.getContent()
      backReply.subject = form.subject
      backReply.receiveEmail = form.receiveEmail
      backReply.sendType = form.sendType
    })

  });
}

function openReply(email) {

  resetForm();

  email.subject = email.subject || ''

  form.receiveEmail.push(email.sendEmail)
  form.subject = (
      email.subject.startsWith('Re:') ||
      email.subject.startsWith('Re：') ||
      email.subject.startsWith('回复：') ||
      email.subject.startsWith('回复:')) ? email.subject : 'Re: ' + email.subject
  form.sendType = 'reply'
  form.emailId = email.emailId

  defValue.value = ''

  setTimeout(() => {
    defValue.value = `
    <div></div>
    <div>
    <br>
        ${formatDetailDate(email.createTime)} ${email.name} &lt${email.sendEmail}&gt ${t('wrote')}:
    </div>
    <blockquote class="mceNonEditable" style="margin: 0 0 0 0.8ex;border-left: 1px solid rgb(204,204,204);padding-left: 1ex;">
      <articl>
          ${formatImage(email.content) || `<pre style="font-family: inherit;word-break: break-word;white-space: pre-wrap;margin: 0">${email.text}</pre>`}
      </article>
    </blockquote>`
    open()

    nextTick(() => {
      backReply.content = editor.value.getContent()
      backReply.subject = form.subject
      backReply.receiveEmail = form.receiveEmail
      backReply.sendType = form.sendType
    })
  })

}

function formatImage(content) {
  content = content || '';
  const domain = settingStore.settings.r2Domain;
  return content.replace(/{{domain}}/g, toOssDomain(domain) + '/');
}

function open() {
  if (!accountStore.currentAccount.email) {
    form.sendEmail = userStore.user.email;
    form.accountId = userStore.user.account.accountId;
    form.name = userStore.user.name;
  } else {
    form.sendEmail = accountStore.currentAccount.email;
    form.accountId = accountStore.currentAccount.accountId;
    form.name = accountStore.currentAccount.name;
  }
  show.value = true;
  editor.value.focus()
  // 第六阶段 C 路：每次打开写信框时刷新 E2EE 状态（回复/转发走 open()，草稿走 openDraft()，两处都调）。
  loadE2eeStatus()
  // Phase 8 E：每次打开写信框时刷新撤回延迟偏好（best-effort，失败用默认 2 秒）。
  trustGetPrefs().then(p => {
    if (p && typeof p.undoSeconds === 'number') undoSeconds.value = p.undoSeconds
  }).catch(() => {})
}

function openDraft(draft) {
  Object.assign(form, {...draft, manyType: draft.manyType || 'together'})
  defValue.value = ''
  setTimeout(() => defValue.value = form.content)
  show.value = true;
  editor.value.focus()
  loadE2eeStatus()
}

const handleKeyDown = (event) => {
  if (event.key === 'Escape') {
    close()
  }
};

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown);
});

function close() {

  if (selectStatus) openSelect();

  if (!form.content) {
    form.content = editor.value.getContent();
  }

  if (form.draftId) {
    draftStore.setDraft = {...toRaw(form)}
    show.value = false
    resetForm()
    return;
  }

  if (!(form.content || form.subject || form.receiveEmail.length > 0)) {
    show.value = false
    resetForm()
    return;
  }

  if (backReply.sendType === 'reply' || backReply.sendType === 'forward') {
    let subjectFlag = form.subject === backReply.subject
    let contentFlag = editor.value.getContent() === backReply.content
    let receiveFlag = form.receiveEmail.length === 1 && form.receiveEmail[0] === backReply.receiveEmail[0]
    if (backReply.sendType === 'forward' && form.receiveEmail.length === 0) {
      receiveFlag = true;
    }
    if (subjectFlag && contentFlag && receiveFlag) {
      resetForm();
      close()
      return;
    }
  }

  ElMessageBox.confirm(t('saveDraftConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning',
    distinguishCancelAndClose: true
  }).then(async () => {
    const formData = {...toRaw(form)};
    delete formData.draftId
    delete formData.attachments
    formData.createTime = dayjs().utc().format('YYYY-MM-DD HH:mm:ss');
    const draftId = await db.value.draft.add({...formData})
    db.value.att.add({draftId, attachments: toRaw(form.attachments)})
    draftStore.refreshList++
    show.value = false
    await nextTick(() => {
      resetForm()
    })
  }).catch((action) => {
    if (action === 'cancel') {
      show.value = false
      resetForm()
    }
  })

}

</script>
<style>
.write-select .el-select-dropdown__list {
  padding: 4px 4px !important;
}
.write-select .el-select-dropdown__item {
  padding: 0 10px 0 10px;
}

.write-select .el-select-dropdown {
  min-width: 0 !important;
}
</style>
<style scoped lang="scss">
.send {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 模态遮罩 + 层级：写信窗口是全屏模态，须盖住顶栏（z 100）、搜索下拉（z 1001）
     与右下角新邮件通知卡片（z 1999），否则底下内容透出并抢点击；
     层级取 2000，与 Element Plus 弹窗起始 z-index 持平，teleport 到 body 的
     下拉/对话框按 DOM 顺序后出现，仍能盖在遮罩之上。 */
  background: rgba(0, 0, 0, 0.45);
  z-index: 2000;

  .write-box {
    background: var(--el-bg-color);
    width: min(1367px, calc(100% - 80px));
    box-shadow: var(--el-box-shadow-light);
    border: 1px solid var(--el-border-color-light);
    transition: var(--el-transition-duration);
    padding: 15px;
    border-radius: 8px;
    display: grid;
    grid-template-rows: auto auto 1fr;
    overflow: hidden;
    @media (max-width: 1024px) {
      width: 100%;
      height: 100%;
      border-radius: 0;
      border: 0;
      padding-top: 10px;
    }

    @media (min-width: 1025px) {
      height: min(800px, calc(100vh - 60px));
    }

    .title {
      display: flex;
      justify-content: space-between;
      margin-bottom: 10px;

      .title-left {
        align-items: center;
        display: grid;
        grid-template-columns: auto auto auto 1fr;
      }

      .title-text {
      }

      .sender {
        margin-left: 8px;
      }

      .sender-name {
        margin-left: 8px;
        font-weight: bold;
      }

      .send-email {
        color: #999896;
        margin-left: 5px;
        white-space: nowrap;
        text-overflow: ellipsis;
        overflow: hidden;
      }


      div {
        display: flex;
        align-items: center;
      }
    }

    /* 写信页顶部斯诺登名言小字 */
    .write-quote-strip {
      padding: 2px 4px 10px;
      border-bottom: 1px solid var(--el-border-color-lighter);
      margin-bottom: 2px;
    }
    .write-quote {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 2px 8px;
      font-size: 12px;
      line-height: 1.5;
    }
    .write-quote-en {
      color: var(--el-text-color-primary);
      font-weight: 600;
    }
    .write-quote-zh {
      color: var(--el-text-color-secondary);
    }
    .write-quote-by {
      color: var(--el-text-color-placeholder);
      white-space: nowrap;
    }
    .write-quote-fade-enter-active, .write-quote-fade-leave-active { transition: opacity .6s ease; }
    .write-quote-fade-enter-from, .write-quote-fade-leave-to { opacity: 0; }

    .container {
      height: 100%;
      display: grid;
      grid-template-rows: auto auto 1fr auto auto;
      gap: 15px;

      /* Phase 8 斯诺登元素补齐：发送按钮下方隐私小字——锁图标 + 一行承诺（醒目药丸样式） */
      .send-privacy-note {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 7px 12px;
        border: 1px solid rgba(37, 99, 235, 0.25);
        border-radius: 999px;
        background: linear-gradient(90deg, rgba(37, 99, 235, 0.07), rgba(124, 58, 237, 0.07));
        font-size: 12px;
        font-weight: 600;
        color: var(--el-text-color-regular);

        svg {
          flex: none;
          color: var(--el-color-primary);
        }
      }

      .item-title {
      }

      .button-item {
        display: grid;
        grid-template-columns: auto auto auto 1fr auto;

        .att-add {
          cursor: pointer;
        }

        .att-clear {
          cursor: pointer;
          margin-left: 10px;
        }

        /* 写信页 AI 主入口：蓝紫渐变按钮，底部工具栏里一眼可见。 */
        .ai-toolbar-btn {
          background: linear-gradient(90deg, #2563eb, #7c3aed);
          border: none;
          color: #fff;
          font-weight: 600;
          margin-left: 10px;
          &:hover, &:focus {
            background: linear-gradient(90deg, #1d4ed8, #6d28d9);
            border: none;
            color: #fff;
          }
        }

        .att-list {
          display: grid;
          gap: 5px;
          grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
          padding-left: 10px;
          padding-right: 10px;
          max-height: 110px;
          overflow-y: auto;
          @media (max-width: 450px) {
            grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
          }

          .att-item {
            display: grid;
            grid-template-columns: auto 1fr auto auto;
            gap: 5px;
            height: 32px;
            font-size: 14px;
            padding: 4px 5px;
            background: var(--light-ill);
            border-radius: 4px;
            .att-filename {
              white-space: nowrap;
              text-overflow: ellipsis;
              overflow: hidden;
            }
          }
        }
      }
    }
  }

}

.email-row {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

:deep(.el-dialog) {
  width: 420px !important;
  @media (max-width: 460px) {
    width: calc(100% - 40px) !important;
    margin-right: 20px !important;
    margin-left: 20px !important;
  }
}

.contacts-bottom {
  display: flex;
  justify-content: end;
  margin-top: 10px;
}

.add-contact {
  color: var(--regular-text-color)
}

/* Phase 7：AI 写信 / 回信对话框 */
:deep(.ai-dialog) {
  width: 520px !important;
  @media (max-width: 560px) {
    width: calc(100% - 40px) !important;
  }
}

.ai-prompt {
  margin-bottom: 12px;
}

/* 写信模式已有正文时：润色入口行（提示 + “润色当前正文”按钮）。 */
.ai-polish-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

/* 润色模式：说明 + 当前正文只读预览。 */
.ai-polish-note {
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.ai-polish-source {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  background: var(--el-fill-color-light);
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow-y: auto;
}

.ai-tone-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;

  .ai-tone-label {
    font-size: 14px;
  }
}

.ai-draft {
  border-top: 1px solid var(--el-border-color-light);
  padding-top: 12px;

  .ai-draft-label {
    font-size: 13px;
    color: var(--secondary-text-color);
    margin-bottom: 4px;
  }

  .ai-draft-subject {
    font-weight: bold;
    margin-bottom: 10px;
    word-break: break-word;
  }

  .ai-draft-body {
    font-family: inherit;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0 0 4px;
    max-height: 260px;
    overflow-y: auto;
  }
}

.ai-remaining {
  margin-top: 10px;
  font-size: 13px;
  color: var(--secondary-text-color);
}

.write-select {
  position: absolute;
  width: 300px;
  left: 60px;
  z-index: 0;
  opacity: 0;
  pointer-events: none;
}

:deep(.el-input-tag__suffix) {
  padding-right: 4px;
}

.icon {
  cursor: pointer;
}
</style>
