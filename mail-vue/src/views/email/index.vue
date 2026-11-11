<template>
  <div class="inbox-page">
    <emailScroll ref="scroll"
               :cancel-success="cancelStar"
               :star-success="addStar"
               :getEmailList="getEmailList"
               :emailDelete="emailDelete"
               :star-add="starAdd"
               :star-cancel="starCancel"
               :email-read="emailRead"
               :show-unread="true"
               :highlight-text="emailStore.searchParams.text"
               actionLeft="4px"
               @jump="jumpContent"
               style="flex: 1; min-height: 0; height: auto;"
    >
    </emailScroll>
  </div>
</template>

<script setup>
import {useAccountStore} from "@/store/account.js";
import {useEmailStore} from "@/store/email.js";
import {useSettingStore} from "@/store/setting.js";
import emailScroll from "@/components/email-scroll/index.vue"
import {emailList, emailDelete, emailLatest, emailRead} from "@/request/email.js";
import {starAdd, starCancel} from "@/request/star.js";
import {defineOptions, onMounted, onUnmounted, ref, watch} from "vue";
import {sleep} from "@/utils/time-utils.js";
import router from "@/router/index.js";
import { useRoute } from 'vue-router'
import { notifyNewMail } from "@/utils/mail-notify.js";

defineOptions({
  name: 'email'
})

const route = useRoute();
const emailStore = useEmailStore();
const accountStore = useAccountStore();
const settingStore = useSettingStore();
const scroll = ref({})

// 速度优化：标签页不可见时暂停轮询（省服务器请求）；切回可见时立即拉一次，不用等满轮询间隔。
let pollNow = false;
function onVisibilityChange() {
  if (!document.hidden) pollNow = true;
}
onMounted(() => {
  emailStore.emailScroll = scroll;
  document.addEventListener('visibilitychange', onVisibilityChange);
  latest()
})
onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange);
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
  emailStore.contentData.delType = 'logic'
  emailStore.contentData.showUnread = true
  emailStore.contentData.showStar = true
  emailStore.contentData.showReply = true
  router.push({name: 'content', params: {mailbox: 'inbox'}})
}

const existIds = new Set();

async function latest() {
  while (true) {

    let autoRefresh = settingStore.settings.autoRefresh;
    // 切回可见时跳过等待立即拉一次；标签页不可见时不发请求（省服务器）。
    if (!pollNow) {
      await sleep(autoRefresh > 1 ? autoRefresh * 1000 : 3000);
    }
    pollNow = false;
    if (document.hidden) {
      continue;
    }

    if (route.name !== 'email') {
      continue;
    }

    const searchParams = emailStore.searchParams
    if (searchParams.text || searchParams.startDate || searchParams.endDate) {
      continue
    }

    const latestId = scroll.value.latestEmail?.emailId

    if (!scroll.value.firstLoad && autoRefresh > 1) {
      try {
        const accountId = accountStore.currentAccountId
        const allReceive = scroll.value.latestEmail?.allReceive
        let list = []

        //确保发起请求时最后一个邮件是当前账号的,或者
        if (accountId === scroll.value.latestEmail?.reqAccountId) {
          list = await emailLatest(latestId, accountId, allReceive);
        }

        //确保请求回来后，账号没有切换，时间排序没有改变，全部邮件类型没变
        if (accountId === accountStore.currentAccountId && allReceive === accountStore.currentAccount.allReceive) {
          if (list.length > 0) {
            emailStore.applyFullList(list)

            // 本轮新到的邮件（去重后）：收集起来，轮询结束统一弹一次大框提示（多封合并一条）。
            const newArrivals = [];
            for (let email of list) {

              email.reqAccountId = accountId;
              email.allReceive = allReceive;

              if (!existIds.has(email.emailId)) {

                existIds.add(email.emailId)
                scroll.value.addItem(email)
                newArrivals.push(email)

                await sleep(50)
              }

            }

            // 新邮件大框提示：右下角微软风格，3 秒自动关闭，点一下打开该封。
            if (newArrivals.length > 0) {
              notifyNewMail(newArrivals, (email) => jumpContent(email));
            }

          }

        }
      } catch (e) {
        if (e.code === 401 || e.code === 403) {
          settingStore.settings.autoRefresh = 0;
        }
        console.error(e)
      }
    }
  }
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
    emailList(accountId, allReceive, emailId, 0, size, 0, full, emailStore.searchParams)
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

.inbox-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

</style>
