<template>
  <el-scrollbar class="scroll">
    <div>
      <div class="title" :class="{ 'title-display': titleUsesDisplayFont }" role="button" tabindex="0" style="cursor:pointer" @click="router.push({name: 'email'})" @keyup.enter="router.push({name: 'email'})">
        <img class="logo" :src="logoUrl" alt="" />
        <div>{{settingStore.settings.title}}</div>
      </div>
      <!-- Phase 8 斯诺登元素补齐：品牌标语（logo 本体不动）。 -->
      <div class="brand-tagline">{{ $t('brandTagline') }}</div>
      <button v-perm="'email:send'" class="compose-bar" type="button" @click="openCompose">
        <Icon icon="material-symbols:edit-outline-sharp" width="22" height="22" />
        <span>{{ $t('compose') }}</span>
      </button>
      <el-menu :collapse="false" text-color="#fff" active-text-color="#fff" style="margin-top: 6px">
        <el-menu-item @click="router.push({name: 'email'})" index="email"
                      :class="route.meta.name === 'email' ? 'choose-item' : ''">
          <Icon icon="hugeicons:mailbox-01" width="20" height="20" />
          <span class="menu-name" style="margin-left: 16px">{{$t('inbox')}}</span>
        </el-menu-item>
        <!-- 安全中心放第二位，突出新功能。 -->
        <el-menu-item @click="router.push({name: 'security'})" index="security"
                      :class="route.meta.name === 'security' ? 'choose-item' : ''">
          <Icon icon="fluent:shield-20-regular" width="20" height="20" />
          <span class="menu-name" style="margin-left: 16px">{{$t('securityCenter')}}</span>
        </el-menu-item>
        <el-menu-item @click="router.push({name: 'send'})" index="send" v-perm="'email:send'"
                      :class="route.meta.name === 'send' ? 'choose-item' : ''">
          <Icon icon="cil:send" width="20" height="20" />
          <span class="menu-name" style="margin-left: 16px">{{$t('sent')}}</span>
        </el-menu-item>
        <el-menu-item @click="router.push({name: 'draft'})" index="draft" v-perm="'email:send'"
                      :class="route.meta.name === 'draft' ? 'choose-item' : ''">
          <Icon icon="ep:document" width="19" height="19" />
          <span class="menu-name" style="margin-left: 17px">{{$t('drafts')}}</span>
        </el-menu-item>
        <el-menu-item @click="router.push({name: 'star'})" index="star"
                      :class="route.meta.name === 'star' ? 'choose-item' : ''">
          <Icon icon="solar:star-line-duotone" width="20" height="20" />
          <span class="menu-name" style="margin-left: 16px">{{$t('starred')}}</span>
        </el-menu-item>
        <!-- Phase 8 E：垃圾邮件文件夹。 -->
        <el-menu-item @click="router.push({name: 'spam'})" index="spam"
                      :class="route.meta.name === 'spam' ? 'choose-item' : ''">
          <Icon icon="material-symbols:report-outline" width="20" height="20" />
          <span class="menu-name" style="margin-left: 16px">{{$t('spam')}}</span>
        </el-menu-item>
        <!-- 回收站：删掉的信先到这里，可恢复、可彻底删除，定时清理才会真正清掉。 -->
        <el-menu-item @click="router.push({name: 'trash'})" index="trash"
                      :class="route.meta.name === 'trash' ? 'choose-item' : ''">
          <Icon icon="fluent:delete-20-regular" width="20" height="20" />
          <span class="menu-name" style="margin-left: 16px">{{$t('trash')}}</span>
        </el-menu-item>
        <el-menu-item @click="router.push({name: 'setting'})" index="setting"
                      :class="route.meta.name === 'setting' ? 'choose-item' : ''">
          <Icon icon="fluent:settings-48-regular" width="20" height="20" />
          <span class="menu-name" style="margin-left: 16px">{{$t('settings')}}</span>
        </el-menu-item>
        <!-- Phase 8 F：隐私仪表盘 / 联系人 / 邮件规则。 -->
        <el-menu-item @click="router.push({name: 'privacy'})" index="privacy"
                      :class="route.meta.name === 'privacy' ? 'choose-item' : ''">
          <Icon icon="material-symbols:privacy-tip-outline" width="20" height="20" />
          <span class="menu-name" style="margin-left: 16px">{{$t('privacyDashboard')}}</span>
        </el-menu-item>
        <el-menu-item @click="router.push({name: 'contacts'})" index="contacts"
                      :class="route.meta.name === 'contacts' ? 'choose-item' : ''">
          <Icon icon="fluent:people-20-regular" width="20" height="20" />
          <span class="menu-name" style="margin-left: 16px">{{$t('contactsTitle')}}</span>
        </el-menu-item>
        <el-menu-item @click="router.push({name: 'mail-rules'})" index="mail-rules"
                      :class="route.meta.name === 'mail-rules' ? 'choose-item' : ''">
          <Icon icon="fluent:filter-20-regular" width="20" height="20" />
          <span class="menu-name" style="margin-left: 16px">{{$t('mailRulesTitle')}}</span>
        </el-menu-item>
        <div class="manage-title" v-perm="['all-email:query','user:query','role:query','setting:query','analysis:query','reg-key:query']">
          <div>{{$t('manage')}}</div>
        </div>
        <el-menu-item @click="router.push({name: 'analysis'})" index="analysis" v-perm="'analysis:query'"
                      :class="route.meta.name === 'analysis' ? 'choose-item' : ''">
          <Icon icon="fluent:data-pie-20-regular" width="24" height="24" />
          <span class="menu-name" style="margin-left: 13px">{{$t('analytics')}}</span>
        </el-menu-item>
        <el-menu-item @click="router.push({name: 'user'})" index="setting" v-perm="'user:query'"
                      :class="route.meta.name === 'user' ? 'choose-item' : ''">
          <Icon icon="si:user-alt-2-line" width="20" height="20" />
          <span class="menu-name" style="margin-left: 16px">{{$t('allUsers')}}</span>
        </el-menu-item>
        <el-menu-item @click="router.push({name: 'all-email'})" index="all-email" v-perm="'all-email:query'"
                      :class="route.meta.name === 'all-email' ? 'choose-item' : ''">
          <Icon icon="fluent:mail-list-28-regular" width="22" height="22" />
          <span class="menu-name" style="margin-left: 15px">{{$t('allMail')}}</span>
        </el-menu-item>
        <el-menu-item @click="router.push({name: 'role'})" index="setting" v-perm="'role:query'"
                      :class="route.meta.name === 'role' ? 'choose-item' : ''">
          <Icon icon="fluent:lock-closed-16-regular" width="22" height="22" />
          <span class="menu-name" style="margin-left: 15px">{{$t('permissions')}}</span>
        </el-menu-item>
        <el-menu-item @click="router.push({name: 'reg-key'})" index="reg-key" v-perm="'reg-key:query'"
                      :class="route.meta.name === 'reg-key' ? 'choose-item' : ''">
          <Icon icon="fluent:fingerprint-20-filled" width="22" height="22" />
          <span class="menu-name" style="margin-left: 15px">{{$t('inviteCode')}}</span>
        </el-menu-item>
        <el-menu-item @click="router.push({name: 'sys-setting'})" index="sys-setting" v-perm="'setting:query'"
                      :class="route.meta.name === 'sys-setting' ? 'choose-item' : ''">
          <Icon icon="eos-icons:system-ok-outlined" width="18" height="18" style="margin-left: 2px" />
          <span class="menu-name" style="margin-left: 17px">{{$t('SystemSettings')}}</span>
        </el-menu-item>
        <!-- 支持我们（捐赠）：金色高亮，点一下跳安全中心捐赠区（DOGE 地址 + 二维码 + TG 群）。2026-11-11 按用户要求移到侧栏最下方。 -->
        <el-menu-item @click="goDonate" index="donate" class="donate-item">
          <Icon icon="material-symbols:volunteer-activism-outline" width="20" height="20" />
          <span class="menu-name" style="margin-left: 16px">{{$t('donateSection')}}</span>
        </el-menu-item>
      </el-menu>
      <!-- 斯诺登视角：侧栏底部每日一句（只用开场动画里核实过的三句名言，按日期轮换），点一下进隐私仪表盘。 -->
      <div class="aside-quote" role="button" tabindex="0" @click="router.push({name: 'privacy'})" @keyup.enter="router.push({name: 'privacy'})">
        <Icon icon="fluent:shield-20-regular" width="16" height="16" class="aside-quote-icon" />
        <p class="aside-quote-text">“{{ $t('intro.quote' + dailyQuoteIndex) }}”</p>
        <p class="aside-quote-by">— Edward Snowden</p>
      </div>
    </div>
  </el-scrollbar>
</template>

<script setup>
import router from "@/router/index.js";
import {computed} from "vue";
import { useRoute } from "vue-router";
import {Icon} from "@iconify/vue";
import {useSettingStore} from "@/store/setting.js";
import {useUiStore} from "@/store/ui.js";

const settingStore = useSettingStore();
const uiStore = useUiStore();
const route = useRoute();
const logoUrl = `${import.meta.env.BASE_URL}mail.png`
const titleUsesDisplayFont = computed(() => !/\p{Script=Han}/u.test(settingStore.settings.title || ''))

// 侧栏底部每日一句：按日期轮换三句核实过的斯诺登名言（与开场动画同一批）。
const dailyQuoteIndex = computed(() => (new Date().getDate() % 3) + 1)

function openCompose() {
  uiStore.writerRef.open()
}

// 支持我们（捐赠）：跳安全中心捐赠区。已在安全中心时直接滚过去；
// 跨页时锚点经路由 query 传过去，目标页等数据落定后再滚（同功能搜索的跨页方案）。
function goDonate() {
  if (route.name === 'security') {
    const el = document.getElementById('sec-donate')
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
  }
  router.push({ name: 'security', query: { anchor: 'sec-donate' } })
}

</script>

<style lang="scss" scoped>

.title {
  margin: 10px 6px;
  height: 45px;
  border-radius: 6px;
  display: flex;
  position: relative;
  font-size: 18px;
  font-weight: 600;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  color: #ffffff;
  transition: all 0.3s ease;
  max-width: 240px;
  padding: 0 10px;
  > div {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    max-width: calc(240px - 20px - 32px - 5px);
  }

  .logo {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    object-fit: contain;
  }

  .user-right-icon {
    align-self: center;
    position: absolute;
    font-size: 12px;
    right: 8px;
    color: #ffffff;
  }

}

/* 任务 4：品牌标题用全局展示字体（Bebas Neue / Montserrat），字号加大加粗。 */
.title.title-display {
  font-family: var(--font-display);
  font-size: 26px;
  font-weight: 700;
  letter-spacing: .02em;
}

/* 品牌标语：顶级规则（之前误嵌在 .title 里，编译成 .title .brand-tagline，实际是兄弟节点，样式从未生效）。 */
.brand-tagline {
  margin: -4px 6px 10px 52px;
  font-size: 10px;
  letter-spacing: .22em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, .55);
}

/* 斯诺登视角：侧栏底部每日一句，点一下进隐私仪表盘。 */
.aside-quote {
  margin: 16px 12px 12px;
  padding: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  cursor: pointer;
  color: rgba(255, 255, 255, 0.75);
}

.aside-quote:hover {
  background: rgba(255, 255, 255, 0.06);
  border-radius: 6px;
}

.aside-quote-icon {
  color: rgba(255, 255, 255, 0.55);
}

.aside-quote-text {
  margin: 6px 0;
  font-size: 12px;
  line-height: 1.6;
}

.aside-quote-by {
  margin: 0;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
  text-align: right;
}

.compose-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: calc(100% - 24px);
  height: 42px;
  margin-right: 12px;
  margin-left: 12px;
  margin-bottom: 15px;
  border: 0;
  border-radius: 8px;
  background: #1890ff;
  color: #ffffff;
  font-family: inherit;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;

  &:hover {
    background: #1064c0;
  }

  @media (max-width: 767px) {
    display: none;
  }
}

.manage-title {
  margin-top: 12px;
  padding-left: 20px;
  color: #fff;
}

.el-menu-item {
  margin: 2px 12px !important;
  border-radius: 6px;
  height: 32px;
  padding: 6px 10px !important;
  font-size: 14px;
}

/* 支持我们（捐赠）：金色高亮，一眼看到。 */
.donate-item {
  color: #fbbf24 !important;
  font-weight: 600;
}
.donate-item:hover {
  background: rgba(251, 191, 36, 0.12) !important;
}

.choose-item {
  font-weight: 400;
  background: var(--aside-menu-active-background) !important;
  backdrop-filter: blur(4px);
}

@media (hover: hover) {
  .el-menu-item:hover {
    background: rgba(255, 255, 255, 0.08) !important;
  }
}

.menu-name {
  user-select: none;
}


:deep(.el-scrollbar__wrap--hidden-default ) {
  background: var(--aside-backgound) !important;
}

:deep(.el-menu-item) {
  background: var(--aside-backgound);
}

:deep(.el-menu) {
  background: var(--aside-backgound);
}

.el-menu {
  border-right: 0;
  width: 260px;
}

:deep(.el-divider__text) {
  background: var(--aside-backgound);
  color: #FFFFFF;
}

.scroll {

}
</style>
