<template>
  <el-alert v-if="sendRemain !== null" :title="t('todaySendRemain', {count: sendRemain})" type="info" show-icon :closable="false" class="send-remain" />
  <emailScroll ref="sendScroll"
               :cancel-success="cancelStar"
               :star-success="addStar"
               :getEmailList="getEmailList"
               :emailDelete="emailDelete"
               :star-add="starAdd"
               show-status
               actionLeft="4px"
               :star-cancel="starCancel"
               :highlight-text="sendStore.searchParams.text"
               @jump="jumpContent"
               :type="'send'"
  >
  </emailScroll>
</template>

<script>
// 发信失败人话映射已移到 @/utils/send-error.js（总协调集成）。
// 实际提示在 layout/write/index.vue 的 sendEmail().catch() 里弹，
// 那里直接 import { friendlySendError } from '@/utils/send-error.js'。
// 此处保留重导出，兼容已有引用。
export { sendErrorMap, friendlySendError } from '@/utils/send-error.js'
</script>

<script setup>
import {useAccountStore} from "@/store/account.js";
import {useEmailStore} from "@/store/email.js";
import {useSendStore} from "@/store/send.js";
import {useUserStore} from "@/store/user.js";
import {useI18n} from "vue-i18n";
import emailScroll from "@/components/email-scroll/index.vue"
import {emailList, emailDelete} from "@/request/email.js";
import {starAdd, starCancel} from "@/request/star.js";
import {defineOptions, onMounted, ref, watch, computed} from "vue";
import router from "@/router/index.js";

defineOptions({
  name: 'send'
})

const {t} = useI18n();
const emailStore = useEmailStore();
const sendStore = useSendStore();
const accountStore = useAccountStore();
const userStore = useUserStore();

// Phase 2 A 路：发件页显示“今日还剩 X 封”。
// 数据来自 store/user.js 的 loginUserInfo()（user.sendCount 与角色 role.sendCount）；
// role.sendCount 为空（不限量/无权限/被禁发）时不显示。
const sendRemain = computed(() => {
  const role = userStore.user?.role
  if (!role?.sendCount) {
    return null
  }
  return Math.max(0, role.sendCount - (userStore.user?.sendCount || 0))
})
const sendScroll = ref({})
onMounted(() => {
  emailStore.sendScroll = sendScroll;
})

watch(() => accountStore.currentAccountId, () => {
  sendScroll.value.refreshList();
})

watch(
  () => sendStore.searchParams,
  () => {
    sendScroll.value.refreshList()
  },
  {deep: true}
)

function jumpContent(email) {
  emailStore.contentData.email = emailStore.toContentEmail(email)
  emailStore.contentData.delType = 'logic'
  emailStore.contentData.showStar = true
  emailStore.contentData.showReply = true
  router.push({name: 'content', params: {mailbox: 'sent'}})
}

function addStar(email) {
  emailStore.starScroll?.addItem(email)
}

function cancelStar(email) {
  emailStore.starScroll?.deleteEmail([email.emailId])
}

function getEmailList(emailId, size) {
  const accountId =  accountStore.currentAccountId;
  const allReceive = accountStore.currentAccount.allReceive;
  return emailStore.fetchList(full =>
    emailList(accountId, allReceive, emailId, 0, size, 1, full, sendStore.searchParams)
  ).then(data => {
    data.latestEmail.reqAccountId = accountId;
    data.latestEmail.allReceive = allReceive;
    return data;
  })
}

</script>

<style scoped>
.icon {
  cursor: pointer;
}

.send-remain {
  margin-bottom: 10px;
}
</style>
