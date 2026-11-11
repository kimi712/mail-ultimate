<!-- 回收站：复用收件箱列表组件，trash=1 只列 is_del=1 的信；
     本页的删除是彻底删除（emailPhysicsDelete），恢复走 emailRestore；
     轮询 latest() 默认排除已删邮件，故本页不做自动刷新（进页/切账号时刷新列表）。
     误删的信先到这里，定时清理（auto_clean_days）才会真正清掉。 -->
<template>
  <emailScroll ref="scroll"
               :type="'trash'"
               :cancel-success="cancelStar"
               :star-success="addStar"
               :getEmailList="getEmailList"
               :emailDelete="emailPhysicsDelete"
               :emailRestore="emailRestore"
               :star-add="starAdd"
               :star-cancel="starCancel"
               :email-read="emailRead"
               :show-unread="true"
               :highlight-text="emailStore.searchParams.text"
               actionLeft="4px"
               @jump="jumpContent"
  >
  </emailScroll>
</template>

<script setup>
import {useAccountStore} from "@/store/account.js";
import {useEmailStore} from "@/store/email.js";
import {useSettingStore} from "@/store/setting.js";
import emailScroll from "@/components/email-scroll/index.vue"
import {emailList, emailPhysicsDelete, emailRestore, emailRead} from "@/request/email.js";
import {starAdd, starCancel} from "@/request/star.js";
import {defineOptions, onMounted, ref, watch} from "vue";
import router from "@/router/index.js";
import { useRoute } from 'vue-router'

defineOptions({
  name: 'trash'
})

const route = useRoute();
const emailStore = useEmailStore();
const accountStore = useAccountStore();
const settingStore = useSettingStore();
const scroll = ref({})
onMounted(() => {
  emailStore.emailScroll = scroll;
})


watch(() => accountStore.currentAccountId, () => {
  scroll.value.refreshList();
})

watch(
  () => emailStore.searchParams,
  () => {
    scroll.value.refreshList()
  },
  {deep: true}
)

function jumpContent(email) {
  emailStore.contentData.email = emailStore.toContentEmail(email)
  // 回收站里读信再点删除 = 彻底删除（不再走逻辑删除，也不用管理员接口）。
  emailStore.contentData.delType = 'trash'
  emailStore.contentData.showUnread = true
  emailStore.contentData.showStar = true
  emailStore.contentData.showReply = true
  router.push({name: 'content', params: {mailbox: 'inbox'}})
}

const existIds = new Set();

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
    emailList(accountId, allReceive, emailId, 0, size, 0, full, {...emailStore.searchParams, trash: 1})
  ).then(data => {
    data.latestEmail.reqAccountId = accountId;
    data.latestEmail.allReceive = allReceive;
    return data;
  })
}

</script>
<style>
.icon {
  cursor: pointer;
}
</style>
