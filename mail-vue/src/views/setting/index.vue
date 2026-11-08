<template>
  <div class="settings-page">
    <el-scrollbar height="100%">
  <div class="box">
    <div class="container">
      <div class="title">{{$t('profile')}}</div>
      <div class="item setting-row">
        <div>{{$t('username')}}</div>
        <div>
          <span v-if="setNameShow" class="edit-name-input">
            <el-input v-model="accountName"  ></el-input>
            <span class="edit-name" @click="setName">
             {{$t('save')}}
            </span>
          </span>
          <span v-else class="user-name">
            <span >{{ userStore.user.name }}</span>
            <span class="edit-name" @click="showSetName">
             {{$t('change')}}
            </span>
          </span>
        </div>
      </div>
      <div class="item setting-row">
        <div>{{$t('emailAccount')}}</div>
        <div>{{ userStore.user.email }}</div>
      </div>
      <div class="item setting-row">
        <div>{{$t('password')}}</div>
        <div>
          <el-button type="primary" @click="pwdShow = true">{{$t('changePwdBtn')}}</el-button>
        </div>
      </div>
    </div>
    <div class="language">
      <div class="title">{{$t('language')}}</div>
      <div class="language-row setting-row">
        <div>{{$t('preferredLanguage')}}</div>
        <el-select
            :model-value="langSelect"
            class="language-select"
            placeholder="Select"
            @change="changeLang"
        >
          <el-option v-for="item in SUPPORTED_LOCALES" :key="item.short" :label="item.label" :value="item.short" @pointerdown.prevent.stop="changeLang(item.short)"/>
        </el-select>
      </div>
    </div>
    <div class="preference-item">
      <div class="title" id="theme-label">{{$t('themeStyle')}}</div>
      <ThemeSelector/>
    </div>
    <div class="preference-item">
      <div class="title">{{$t('densitySetting')}}</div>
      <div class="language-row setting-row">
        <div>{{$t('densitySetting')}}</div>
        <el-radio-group v-model="density" @change="onDensityChange">
          <el-radio value="comfortable">{{ $t('densityComfortable') }}</el-radio>
          <el-radio value="compact">{{ $t('densityCompact') }}</el-radio>
        </el-radio-group>
      </div>
    </div>
    <div class="preference-item">
      <div class="title">{{$t('noticeSetting')}}</div>
      <div class="language-row setting-row">
        <div>{{$t('loginNotice')}}</div>
        <el-switch v-model="noticeOn" @change="onNoticeChange" />
      </div>
    </div>
    <div class="preference-item">
      <div class="title">{{$t('noticeTitle')}}</div>
      <div class="language-row setting-row">
        <div>{{$t('noticeInfo')}}</div>
        <div>
          <el-button @click="uiStore.showNotice()">{{$t('viewNotice')}}</el-button>
        </div>
      </div>
    </div>
    <div class="preference-item">
      <div class="title">{{$t('loginLogTitle')}}</div>
      <el-table :data="loginLogList" v-loading="loginLogLoading" style="width: 100%" :empty-text="$t('loginLogEmpty')">
        <el-table-column prop="createTime" :label="$t('loginLogTime')" width="180" />
        <el-table-column prop="ip" :label="$t('loginLogIp')" width="160" />
        <el-table-column prop="ua" :label="$t('loginLogDevice')" />
        <el-table-column :label="$t('loginLogNewIp')" width="110">
          <template #default="{row}">
            <el-tag v-if="row.isNewIp === 1" type="warning">{{ $t('loginLogIsNew') }}</el-tag>
            <el-tag v-else type="info">{{ $t('loginLogNotNew') }}</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <div class="del-email" v-perm="'my:delete'">
      <div class="title">{{$t('deleteUser')}}</div>
      <div style="color: var(--regular-text-color);">
        {{$t('delAccountMsg')}}
      </div>
      <div>
        <el-button type="primary" @click="deleteConfirm">{{$t('deleteUserBtn')}}</el-button>
      </div>
    </div>
    <el-dialog v-model="pwdShow" :title="$t('changePassword')" width="340">
      <div class="update-pwd">
        <el-input type="password" :placeholder="$t('newPassword')" v-model="form.password" autocomplete="off" @keyup.enter="submitPwd"/>
        <el-input type="password" :placeholder="$t('confirmPassword')" v-model="form.newPwd" autocomplete="off" @keyup.enter="submitPwd"/>
        <el-button type="primary" :loading="setPwdLoading" @click="submitPwd">{{$t('save')}}</el-button>
      </div>
    </el-dialog>
  </div>
    </el-scrollbar>
  </div>
</template>
<script setup>
import {reactive, ref, defineOptions, onMounted} from 'vue'
import {resetPassword, userDelete, loginLog, setLocale} from "@/request/my.js";
import i18n from "@/i18n/index.js";
import { SUPPORTED_LOCALES, SHORT_CODES, applyLocale, toStoredLocale } from "@/i18n/locale.js";
import { loadPrefs, savePrefs, applyPrefs } from "@/utils/preferences.js";
import {useUserStore} from "@/store/user.js";
import router from "@/router/index.js";
import {accountSetName} from "@/request/account.js";
import {useAccountStore} from "@/store/account.js";
import {useI18n} from "vue-i18n";
import {useSettingStore} from "@/store/setting.js";
import {useUiStore} from "@/store/ui.js";
import ThemeSelector from "@/components/theme-selector/index.vue";

const { t } = useI18n()
const accountStore = useAccountStore()
const settingStore = useSettingStore()
const uiStore = useUiStore()
const userStore = useUserStore();
const setPwdLoading = ref(false)
const setNameShow = ref(false)
const accountName = ref(null)
const langSelect = ref(settingStore.lang)

// Phase 2 A 路：登录记录（GET /my/loginLog，仅本人数据，最近 20 条）
const loginLogList = ref([])
const loginLogLoading = ref(false)
function fetchLoginLog() {
  loginLogLoading.value = true
  loginLog({num: 1, size: 20}).then(data => {
    loginLogList.value = data.list || []
    loginLogLoading.value = false
  }).catch(() => {
    loginLogLoading.value = false
  })
}
onMounted(fetchLoginLog)

// Phase 2 A 路补充：个性化偏好——布局密度与登录公告开关。
// 存 localStorage mail-prefs，切换即时生效并持久化（刷新后保持）。
const density = ref(loadPrefs().density)
const noticeOn = ref(loadPrefs().notice)
function onDensityChange() {
  const prefs = loadPrefs()
  prefs.density = density.value
  savePrefs(prefs)
  applyPrefs(prefs, uiStore)
}
function onNoticeChange() {
  const prefs = loadPrefs()
  prefs.notice = noticeOn.value
  savePrefs(prefs)
}

defineOptions({
  name: 'setting'
})

function showSetName() {
  accountName.value = userStore.user.name
  setNameShow.value = true
}

function setName() {

  if (!accountName.value) {
    ElMessage({
      message: t('emptyUserNameMsg'),
      type: 'error',
      plain: true,
    })
    return;
  }

  setNameShow.value = false
  let name = accountName.value

  if (name === userStore.user.name) {
    return
  }

  userStore.user.name = accountName.value

  accountSetName(userStore.user.account.accountId,name).then(() => {
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })

    accountStore.changeUserAccountName = name

  }).catch(() => {
    userStore.user.name = name
  })
}

function changeLang(lang) {
  // Phase 2 A 路补充：8 语种即时切换（不刷新）+ 登录态下同步到后端 user.locale。
  // el-option 的 pointerdown 与 el-select 的 change 会各触发一次，用当前语言去重。
  if (!SHORT_CODES.includes(lang) || lang === settingStore.lang) {
    return
  }
  applyLocale(i18n, settingStore, lang).then(() => {
    langSelect.value = lang
  })
  setLocale(toStoredLocale(lang)).catch(() => {
    // best-effort：后端同步失败不弹错，下次登录时再同步
  })
}

const pwdShow = ref(false)
const form = reactive({
  password: '',
  newPwd: '',
})

const deleteConfirm = () => {
  ElMessageBox.confirm(t('delAccountConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    userDelete().then(() => {
      localStorage.removeItem('token');
      router.replace('/login');
      ElMessage({
        message: t('delSuccessMsg'),
        type: 'success',
        plain: true,
      })
    })
  })
}


function submitPwd() {

  if (setPwdLoading.value) return

  if (!form.password) {
    ElMessage({
      message: t('emptyPwdMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (form.password.length < 6) {
    ElMessage({
      message: t('pwdLengthMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (form.password !== form.newPwd) {
    ElMessage({
      message: t('confirmPwdFailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  setPwdLoading.value = true
  resetPassword(form.password).then(() => {
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })
    pwdShow.value = false
    setPwdLoading.value = false
    form.password = ''
    form.newPwd = ''
  }).catch(() => {
    setPwdLoading.value = false
  })

}

</script>
<style scoped lang="scss">
.settings-page {
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.box {
  padding: 40px 40px;

  @media (max-width: 767px) {
    padding: 30px 30px;
  }

  .update-pwd {
    display: flex;
    flex-direction: column;
    gap: 15px;
  }

  .title {
    font-size: 18px;
    font-weight: bold;
  }

  .container {
    font-size: 14px;
    display: grid;
    gap: 20px;
    margin-bottom: 40px;

    .item {
      position: relative;
      .user-name {
        display: grid;
        grid-template-columns: minmax(0, auto) max-content;
        justify-content: start;
        align-items: center;
        span:first-child {
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }
      }

      .edit-name-input {
        position: absolute;
        bottom: -6px;
        .el-input {
          width: min(200px,calc(100vw - 222px));
        }
      }

      .edit-name {
        color: #4dabff;
        padding-left: 10px;
        white-space: nowrap;
        cursor: pointer;
      }

    }
  }

  .preference-item,
  .language {
    display: flex;
    flex-direction: column;
    gap: 20px;
    margin-bottom: 40px;
    align-items: flex-start;

  }

  .setting-row {
    width: 100%;
    display: grid;
    grid-template-columns: 120px 220px;
    align-items: center;
    column-gap: 110px;
    font-size: 14px;

    > div:first-child {
      font-weight: bold;
      min-width: 0;
      text-align: left;
    }

    > div:last-child {
      min-width: 0;
      overflow: hidden;
      text-align: left;
    }

    @media (max-width: 767px) {
      grid-template-columns: 120px minmax(0, 1fr);
      column-gap: 24px;
    }
  }

  .language-select {
    width: 150px;
    max-width: 100%;
  }

  .del-email {
    font-size: 14px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
}
</style>
