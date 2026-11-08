<template>
  <div class="box">
    <div class="header-actions">
      <Icon class="icon" icon="material-symbols-light:arrow-back-ios-new" width="20" height="20" @click="handleBack"/>
      <Icon v-perm="'email:delete'" class="icon" icon="uiw:delete" width="16" height="16" @click="handleDelete"/>
      <span class="star" v-if="emailStore.contentData.showStar">
        <Icon class="icon" @click="changeStar" v-if="email.isStar" icon="fluent-color:star-16" width="20" height="20"/>
        <Icon class="icon" @click="changeStar" v-else icon="solar:star-line-duotone" width="18.5" height="18.5"/>
      </span>
      <Icon class="icon" v-if="emailStore.contentData.showReply" v-perm="'email:send'"  @click="openReply" icon="fluent-mdl2:reply" width="19" height="19" />
      <Icon class="icon" v-if="emailStore.contentData.showReply" v-perm="'email:send'"  @click="openForward" icon="iconoir:arrow-up-right" width="20" height="20" />
      <!-- Phase 7：AI 摘要。aiEnabled 为 0（开关关闭）时隐藏；加密未解锁的邮件不可摘要（服务端只有密文）。 -->
      <el-button v-if="aiEnabled" size="small" :loading="aiSummarizing" :disabled="aiSummarizing || !canAiSummarize" @click="summarizeWithAi">{{ $t('ai.summarize') }}</el-button>
    </div>
    <div></div>
    <el-scrollbar class="scrollbar">
      <div class="container">
        <div class="email-title">
          {{ email.subject }}
        </div>
        <!-- Phase 7：AI 摘要面板（3–5 行），展示在详情页内；切邮件时清空。 -->
        <div v-if="aiSummarizing || aiSummary" class="ai-summary">
          <div class="ai-summary-head">
            <span class="ai-summary-title">{{ $t('ai.summary') }}</span>
            <span v-if="aiSummaryRemaining !== null" class="ai-summary-remaining">{{ $t('ai.remaining', {count: aiSummaryRemaining}) }}</span>
            <Icon v-if="aiSummary" class="icon" icon="material-symbols-light:close-rounded" width="18" height="18" @click="aiSummary = null" />
          </div>
          <div v-if="aiSummarizing" class="ai-summary-body">{{ $t('ai.generating') }}</div>
          <pre v-else class="ai-summary-body">{{ aiSummary }}</pre>
        </div>
        <div class="content">
          <div class="email-info">
            <div>
              <div class="send"><span class="send-source">{{$t('from')}}</span>
                <div class="send-name" ref="sendNameRef" :class="{ 'is-wrapped': senderWrapped }">
                  <span class="send-name-title">{{ email.name }}</span>
                  <span class="send-email"><{{ email.sendEmail }}></span>
                  <span class="sent-via" v-if="sentViaEmail">
                    <el-tooltip effect="dark" :content="$t('sentVia', { email: sentViaEmail })">
                      <span>
                        <el-tag size="small" disable-transitions>{{ $t('sentViaTag') }}</el-tag>
                      </span>
                    </el-tooltip>
                  </span>
                </div>
              </div>
              <div class="receive"><span class="source">{{$t('recipient')}}</span><span class="receive-email">{{  formateReceive(email.recipient) }}</span></div>
              <div class="date">
                <div>{{ formatDetailDate(email.createTime) }}</div>
              </div>
              <div class="enc-row">
                <el-tag v-if="email.e2ee === 1" type="success" size="small" effect="plain">
                  <Icon icon="mdi:lock" width="13" height="13" style="vertical-align: -2px" />
                  {{ $t('securityE2eeBadge') }}
                </el-tag>
                <span v-else class="transport-note">{{ $t('securityTransportEncrypted') }}</span>
              </div>
            </div>
            <el-alert v-if="email.status === 3" :closable="false" :title="toMessage(email.message)" class="email-msg" type="error" show-icon />
            <el-alert v-if="email.status === 4" :closable="false" :title="$t('complained')" class="email-msg" type="warning" show-icon />
            <el-alert v-if="email.status === 5" :closable="false" :title="$t('delayed')" class="email-msg" type="warning" show-icon />
          </div>
          <div v-if="email.e2ee === 1 && e2eeState !== 'ready'" class="e2ee-box">
            <el-alert :closable="false" :title="$t('e2eeLockedTitle')" type="warning" show-icon />
            <div class="desc">{{ $t('e2eeLockedDesc') }}</div>
            <div class="e2ee-unlock-row">
              <el-input v-model="e2eePassword" type="password" :placeholder="$t('e2eePasswordPlaceholder')" autocomplete="off" @keyup.enter="unlockE2ee" />
              <el-button type="primary" :loading="e2eeDecrypting" @click="unlockE2ee">{{ $t('e2eeUnlock') }}</el-button>
            </div>
            <el-alert v-if="e2eeState === 'error'" :closable="false" :title="$t('e2eeDecryptFailed')" type="error" show-icon />
          </div>
          <el-scrollbar class="htm-scrollbar" :class="!email.attList?.length ? 'bottom-distance' : ''">
            <ShadowHtml class="shadow-html" :html="formatImage(displayContent)" v-if="displayContent" />
            <pre v-else-if="displayText || email.e2ee !== 1" class="email-text" >{{displayText}}</pre>
          </el-scrollbar>
          <div class="att" v-if="email.attList?.length > 0">
            <div class="att-title">
              <span>{{$t('attachments')}}</span>
              <span>{{$t('attCount',{total: email.attList.length})}}</span>
            </div>
            <div class="att-box">

              <div class="att-item" v-for="att in email.attList" :key="att.attId">
                <div class="att-icon" @click="showImage(att.key)">
                  <Icon v-bind="getIconByName(att.filename)" />
                </div>
                <div class="att-name" @click="showImage(att.key)">
                  {{ att.filename }}
                </div>
                <div class="att-size">{{ formatBytes(att.size) }}</div>
                <div class="opt-icon att-icon">
                  <Icon v-if="isImage(att.filename)" icon="hugeicons:view" width="22" height="22" @click="showImage(att.key)"/>
                  <a :href="cvtR2Url(att.key)" download>
                    <Icon icon="system-uicons:push-down" width="22" height="22"/>
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </el-scrollbar>
    <el-image-viewer
        v-if="showPreview"
        :url-list="srcList"
        show-progress
        @close="showPreview = false"
    />
  </div>
</template>
<script setup>
import ShadowHtml from '@/components/shadow-html/index.vue'
import {computed, reactive, ref, watch, onMounted, onUnmounted, nextTick} from "vue";
import {useRouter} from 'vue-router'
import {ElMessage, ElMessageBox} from 'element-plus'
import {emailDelete, emailRead} from "@/request/email.js";
import {Icon} from "@iconify/vue";
import {useEmailStore} from "@/store/email.js";
import {useAccountStore} from "@/store/account.js";
import {formatDetailDate} from "@/utils/day.js";
import {starAdd, starCancel} from "@/request/star.js";
import {getExtName, formatBytes} from "@/utils/file-utils.js";
import {cvtR2Url,toOssDomain} from "@/utils/convert.js";
import {getIconByName} from "@/utils/icon-utils.js";
import {useSettingStore} from "@/store/setting.js";
import {allEmailDelete} from "@/request/all-email.js";
import {useUiStore} from "@/store/ui.js";
import {useI18n} from "vue-i18n";
import {EmailUnreadEnum} from "@/enums/email-enum.js";
import {sanitizeEmailHtml} from "@/utils/email-html.js";
import {getSecurity} from "@/request/security.js";
import {aiSummarize, aiErrorI18nKey} from "@/request/ai.js";
import {hasMemoryKey, unlockWithPassword, decryptEmailParts, clearMemoryKey} from "@/utils/e2ee.js";
const { t } = useI18n()

const uiStore = useUiStore();
const settingStore = useSettingStore();
const accountStore = useAccountStore();
const emailStore = useEmailStore();
const router = useRouter()
const sendNameRef = ref(null)
const senderWrapped = ref(false)
let senderResizeObserver = null

const showPreview = ref(false)
const srcList = reactive([])

// Phase 7：AI 摘要。aiEnabled 取自 websiteConfig（settingStore.settings），
// 后端默认 1（开启）；为 0 时按钮隐藏。未取到配置时按开启处理（与后端 ?? 1 一致）。
const aiEnabled = computed(() => settingStore.settings?.aiEnabled !== 0)
const aiSummarizing = ref(false)
const aiSummary = ref(null)
const aiSummaryRemaining = ref(null)
// 加密邮件只有解锁后才有明文可摘要；未解锁时禁用（服务端 D1 里只有密文）。
const canAiSummarize = computed(() => {
  if (!email.value?.emailId) return false
  if (isE2eeMail.value && e2eeState.value !== 'ready') return false
  return true
})

async function summarizeWithAi() {
  if (aiSummarizing.value || !canAiSummarize.value) return
  aiSummarizing.value = true
  aiSummary.value = null
  try {
    let data
    if (isE2eeMail.value && e2eeState.value === 'ready') {
      // 已解密的加密邮件直接传明文，避免后端对密文做摘要
      data = await aiSummarize({subject: email.value.subject, body: decryptedText.value || email.value.text})
    } else {
      data = await aiSummarize({emailId: email.value.emailId})
    }
    aiSummary.value = data.summary || ''
    if (typeof data.remaining === 'number') aiSummaryRemaining.value = data.remaining
  } catch (e) {
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
  } finally {
    aiSummarizing.value = false
  }
}

// 第六阶段 C 路：端到端加密邮件解密。
// 解密结果只放在本页局部 ref 里，绝不写回 emailStore（store 会持久化 contentData，
// 写回等于把明文落盘）。e2eeState: 'plain' 未加密 / 'locked' 未解锁 / 'decrypting'
// 解密中 / 'ready' 已解密 / 'error' 解密失败。
const e2eeState = ref('plain')
const e2eePassword = ref('')
const e2eeDecrypting = ref(false)
const e2eeSalt = ref('')
const decryptedContent = ref('')
const decryptedText = ref('')
const isE2eeMail = computed(() => email.value?.e2ee === 1)
const displayContent = computed(() => {
  if (isE2eeMail.value) {
    return e2eeState.value === 'ready' ? decryptedContent.value : ''
  }
  return email.value?.content || ''
})
const displayText = computed(() => {
  if (isE2eeMail.value) {
    return e2eeState.value === 'ready' ? decryptedText.value : ''
  }
  return email.value?.text || ''
})

let e2eeMailId = 0
async function tryDecryptE2ee() {
  if (!hasMemoryKey()) {
    e2eeState.value = 'locked'
    // 懒加载 salt，供解锁时用；失败不弹错，等用户点解锁时再取
    if (!e2eeSalt.value) {
      getSecurity().then((d) => {
        e2eeSalt.value = d?.e2eeSalt || ''
      }).catch(() => {
      })
    }
    return
  }
  const mail = email.value
  if (!mail?.content && !mail?.text) {
    return // 正文还没到齐，等 watch 再触发
  }
  e2eeState.value = 'decrypting'
  try {
    const parts = await decryptEmailParts({text: mail.text, content: mail.content})
    if (email.value?.emailId !== mail.emailId) {
      return // 解密期间切走了邮件，丢弃结果
    }
    decryptedText.value = parts.text
    decryptedContent.value = sanitizeEmailHtml(parts.content)
    e2eeState.value = 'ready'
  } catch (e) {
    console.error(e)
    clearMemoryKey()
    e2eeState.value = 'error'
  }
}

async function unlockE2ee() {
  if (!e2eePassword.value) {
    ElMessage({
      message: t('e2eeNeedPassword'),
      type: 'error',
      plain: true,
    })
    return
  }
  if (!e2eeSalt.value) {
    try {
      const d = await getSecurity()
      e2eeSalt.value = d?.e2eeSalt || ''
    } catch (e) {
      // 忽略，见下 salt 为空的分支
    }
  }
  if (!e2eeSalt.value) {
    ElMessage({
      message: t('e2eeUnlockFailed'),
      type: 'error',
      plain: true,
    })
    return
  }
  e2eeDecrypting.value = true
  try {
    await unlockWithPassword(e2eePassword.value, e2eeSalt.value)
    e2eePassword.value = ''
    e2eeState.value = ''
    await tryDecryptE2ee()
    if (e2eeState.value === 'error') {
      ElMessage({
        message: t('e2eeDecryptFailed'),
        type: 'error',
        plain: true,
      })
    }
  } catch (e) {
    console.error(e)
    clearMemoryKey()
    e2eeState.value = 'error'
    ElMessage({
      message: t('e2eeUnlockFailed'),
      type: 'error',
      plain: true,
    })
  } finally {
    e2eeDecrypting.value = false
  }
}

// 邮件切换 / 正文到齐时触发；error 态等用户重新解锁，不自动重试。
watch(() => [email.value?.emailId, email.value?.e2ee, email.value?.content, email.value?.text], () => {
  const mail = email.value
  if (!mail || mail.e2ee !== 1) {
    e2eeState.value = 'plain'
    decryptedContent.value = ''
    decryptedText.value = ''
    e2eeMailId = 0
    return
  }
  if (mail.emailId !== e2eeMailId) {
    e2eeMailId = mail.emailId
    e2eeState.value = ''
    decryptedContent.value = ''
    decryptedText.value = ''
  }
  if (e2eeState.value === 'error') {
    return
  }
  tryDecryptE2ee()
}, {flush: 'post', immediate: true})


const email = computed(() => emailStore.contentData.email || {
  emailId: 0,
  attList: [],
  content: '',
  text: '',
  recipient: '[]',
})

// Phase 7：切邮件时清空上封邮件的 AI 摘要（写在这里，email 已定义，避免 TDZ）。
watch(() => email.value?.emailId, () => {
  aiSummary.value = null
  aiSummaryRemaining.value = null
})

const sentViaEmail = computed(() => {
  const raw = String(email.value.senderEmail || '').trim()
  if (!raw) return ''
  const matched = raw.match(/<([^>]+)>/)
  const address = (matched ? matched[1] : raw).trim()
  if (!address || address.toLowerCase() === String(email.value.sendEmail || '').trim().toLowerCase()) return ''
  return address
})

watch(() => accountStore.currentAccountId, () => {
  handleBack()
})

let readRequesting = false

function contentWidth(el) {
  const range = document.createRange()
  range.selectNodeContents(el)
  const width = range.getBoundingClientRect().width
  range.detach()
  return width
}

function updateSenderWrap() {
  const root = sendNameRef.value
  if (!root) return
  const name = root.querySelector('.send-name-title')
  const mail = root.querySelector('.send-email')
  const tag = root.querySelector('.sent-via')
  if (!name || !mail) {
    senderWrapped.value = false
    return
  }
  const gap = 6
  let need = contentWidth(name) + gap + contentWidth(mail)
  if (tag) need += gap + contentWidth(tag)
  senderWrapped.value = need > root.clientWidth + 0.5
}


function tryMarkRead() {
  if (!emailStore.contentData.showUnread || readRequesting) return
  const current = email.value
  if (!current?.emailId || current.unread !== EmailUnreadEnum.UNREAD) return

  // 等详情数据就绪（detailMap 已写入，或正文已有内容）再标已读
  const full = emailStore.detailMap[current.emailId]
  const detailReady = !!full || !!(current.content || current.text)
  if (!detailReady) return

  readRequesting = true
  const emailId = current.emailId
  current.unread = EmailUnreadEnum.READ
  if (emailStore.detailMap[emailId]) {
    emailStore.detailMap[emailId].unread = EmailUnreadEnum.READ
  }
  emailStore.markListRead(emailId)
  emailRead([emailId]).finally(() => {
    readRequesting = false
  })
}

watch(
  () => [
    email.value?.emailId,
    email.value?.content,
    email.value?.text,
    emailStore.detailMap[email.value?.emailId]
  ],
  () => tryMarkRead(),
  { flush: 'post' }
)

watch(
  () => [email.value?.name, email.value?.sendEmail, sentViaEmail.value],
  () => nextTick(updateSenderWrap)
)

onMounted(() => {
  tryMarkRead()
  window.addEventListener('keydown', handleKeyDown);
  senderResizeObserver = new ResizeObserver(() => updateSenderWrap())
  if (sendNameRef.value) senderResizeObserver.observe(sendNameRef.value)
  nextTick(updateSenderWrap)
})

onUnmounted(() => {
  emailStore.contentData.showUnread = false;
  readRequesting = false
  window.removeEventListener('keydown', handleKeyDown);
  senderResizeObserver?.disconnect()
})

function handleKeyDown(event) {
  if (event.key !== 'Escape') return;
  if (showPreview.value) return;
  if (document.querySelector('.el-message-box')) return;
  const writeBox = document.querySelector('.write-box');
  if (writeBox && writeBox.offsetParent !== null) return;
  handleBack();
}

function openReply() {
  uiStore.writerRef.openReply(e2eeSafeEmail())
}

function openForward() {
  uiStore.writerRef.openForward(e2eeSafeEmail())
}

// 回复/转发加密邮件时引用解密后的正文（未解锁时仍为原文，即密文信封，不扩范围）。
function e2eeSafeEmail() {
  if (e2eeState.value === 'ready') {
    return {...email.value, content: decryptedContent.value, text: decryptedText.value}
  }
  return email.value
}

function toMessage(message) {
  return  message ? JSON.parse(message).message : '';
}

function formatImage(content) {
  content = content || '';
  const domain = settingStore.settings.r2Domain;
  return  content.replace(/{{domain}}/g, toOssDomain(domain) + '/');
}

function showImage(key) {
  if (!isImage(key)) return;
  const url = cvtR2Url(key)
  srcList.length = 0
  srcList.push(url)
  showPreview.value = true
}

function isImage(filename) {
  return ['png', 'jpg', 'jpeg', 'bmp', 'gif','jfif'].includes(getExtName(filename))
}

function formateReceive(recipient) {
  if (!recipient) return ''
  recipient = JSON.parse(recipient)
  return recipient.map(item => item.address).join(', ')
}

function changeStar() {
  if (email.value.isStar) {
    email.value.isStar = 0;
    starCancel(email.value.emailId).then(() => {
      email.value.isStar = 0;
      emailStore.cancelStarEmailId = email.value.emailId
      setTimeout(() => emailStore.cancelStarEmailId = 0)
      emailStore.starScroll?.deleteEmail([email.value.emailId])
    }).catch((e) => {
      console.error(e)
      email.value.isStar = 1;
    })
  } else {
    email.value.isStar = 1;
    starAdd(email.value.emailId).then(() => {
      email.value.isStar = 1;
      emailStore.addStarEmailId = email.value.emailId
      setTimeout(() => emailStore.addStarEmailId = 0)
      emailStore.starScroll?.addItem(email.value)
    }).catch((e) => {
      console.error(e)
      email.value.isStar = 0;
    })
  }
}

const handleBack = () => {
  router.back()
}

const handleDelete = () => {
  ElMessageBox.confirm(t('delEmailConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    if (emailStore.contentData.delType === 'logic') {
      emailDelete(email.value.emailId).then(() => {
        ElMessage({
          message: t('delSuccessMsg'),
          type: 'success',
          plain: true,
        })
        emailStore.deleteIds = [email.value.emailId]
      })
    } else  {

      allEmailDelete(email.value.emailId).then(() => {
        ElMessage({
          message: t('delSuccessMsg'),
          type: 'success',
          plain: true,
        })
        emailStore.deleteIds = [email.value.emailId]
      })
    }

    router.back()
  })
}
</script>
<style scoped lang="scss">
.box {
  height: 100%;
  overflow: hidden;
}

.header-actions {
  padding: 9px 15px 9px;
  display: flex;
  align-items: center;
  gap: 20px;
  box-shadow: var(--header-actions-border);
  font-size: 18px;
  .star {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 21px;
  }
  .icon {
    cursor: pointer;
  }
}


.scrollbar {
  height: calc(100% - 38px);
  width: 100%;
}

.container {
  font-size: 14px;
  padding-left: 20px;
  padding-right: 20px;
  padding-top: 10px;
  @media (max-width: 1023px) {
    padding-left: 15px;
    padding-right: 15px;
  }

  .email-title {
    font-size: 20px;
    font-weight: bold;
    margin-bottom: 10px;
  }

  .htm-scrollbar {
  }

  .content {
    display: flex;
    flex-direction: column;

    .att {
      margin-top: 30px;
      margin-bottom: 30px;
      border: 1px solid var(--light-border-color);
      padding: 14px;
      border-radius: 6px;
      width: fit-content;
      .att-box {
        min-width: min(410px,calc(100vw - 60px));
        max-width: 600px;
        display: grid;
        gap: 12px;
        grid-template-rows: 1fr;
      }

      .att-title {
        margin-bottom: 8px;
        display: flex;
        justify-content: space-between;
        span:first-child {
          font-weight: bold;
        }
      }

      .att-item {
        cursor: pointer;
        div {
          align-self: center;
        }
        background: var(--light-ill);
        padding: 5px 7px;
        border-radius: 4px;
        align-self: start;
        display: grid;
        grid-template-columns: auto 1fr auto auto;
        .att-icon {
          display: grid;
        }

        .att-size {
          color: var(--secondary-text-color);
        }

        .att-name {
          margin-left: 8px;
          margin-right: 8px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          word-break: break-all;
        }

        .att-image {
          width: 60px;
          height: 60px;
          object-fit: contain;
        }

        .opt-icon {
          padding-left: 10px;
          color: var(--secondary-text-color);
          align-items: center;
          display: flex;
          gap: 8px;
          cursor: pointer;
          a {
            color: var(--secondary-text-color);
            align-items: center;
            display: flex;
          }
        }
      }
    }

    .email-info {

      border-bottom: 1px solid var(--light-border-color);
      margin-bottom: 20px;
      padding-bottom: 8px;
      @media (max-width: 1024px) {
        margin-bottom: 15px;
      }
      .date {
        color: var(--regular-text-color);
        margin-bottom: 6px;
      }

      .email-msg {
        max-width: 400px;
        width: fit-content;
        margin-bottom: 15px;
      }

      .send {
        display: flex;
        margin-bottom: 6px;

        .send-name {
          color: var(--regular-text-color);
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          column-gap: 6px;

          .send-email {
            max-width: 100%;
            overflow-wrap: anywhere;
          }

          &.is-wrapped {
            .send-name-title {
              order: 1;
            }

            .sent-via {
              order: 2;
            }

            .send-email {
              order: 3;
              flex-basis: 100%;
            }
          }
        }
      }

      .receive {
        margin-bottom: 6px;
        display: flex;
        .receive-email {
          max-width: 700px;
          word-break: break-word;
        }
        span:nth-child(2) {
          color: var(--regular-text-color);
        }
      }

      .send-source {
        white-space: nowrap;
        font-weight: bold;
        padding-right: 10px;
      }

      .source {
        white-space: nowrap;
        font-weight: bold;
        padding-right: 10px;
      }
    }
  }
}

.shadow-html::after  {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--message-block-color); /* 半透明黑色蒙层 */
  pointer-events: none; /* 不影响点击 */
}

.email-text {
  font-family: inherit;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

.bottom-distance {
  margin-bottom: 30px;
}

.e2ee-box {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 20px;
  max-width: 560px;

  .desc {
    font-size: 14px;
    color: var(--regular-text-color);
    line-height: 1.6;
  }

  .e2ee-unlock-row {
    display: flex;
    gap: 10px;
  }
}

// Phase 7：加密状态标识行（端到端锁形徽标 / 普通邮件低调的传输加密文字）。
.enc-row {
  margin-top: 4px;

  .transport-note {
    font-size: 12px;
    color: var(--secondary-text-color);
  }
}

// Phase 7：AI 摘要面板。
.ai-summary {
  border: 1px solid var(--light-border-color);
  border-radius: 6px;
  background: var(--light-ill);
  padding: 12px 14px;
  margin-bottom: 16px;

  .ai-summary-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;

    .ai-summary-title {
      font-weight: bold;
    }

    .ai-summary-remaining {
      font-size: 12px;
      color: var(--secondary-text-color);
      flex: 1;
    }

    .icon {
      cursor: pointer;
    }
  }

  .ai-summary-body {
    font-family: inherit;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    line-height: 1.6;
  }
}


</style>
