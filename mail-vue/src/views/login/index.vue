<template>
  <div id="login-box" :style=" background ? 'background: var(--el-bg-color)' : ''" v-loading="oauthLoading" element-loading-text="登录中...">
    <div class="locale-switcher">
      <el-dropdown trigger="click" @command="onSwitchLocale">
        <span class="locale-btn">
          <svg class="locale-globe" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.9 5.7 3.9 9s-1.4 6.4-3.9 9c-2.5-2.6-3.9-5.7-3.9-9S9.5 5.6 12 3z"/></svg>
          <span>{{ currentLocaleLabel }}</span>
          <span class="locale-caret">▾</span>
        </span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="item in SUPPORTED_LOCALES" :key="item.short" :command="item.short">{{ item.label }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
    <div id="background-wrap" v-if="!settingStore.settings.background">
      <div class="orb orb-1"></div>
      <div class="orb orb-2"></div>
      <div class="orb orb-3"></div>
      <div class="x1 cloud"></div>
      <div class="x2 cloud"></div>
      <div class="x3 cloud"></div>
      <div class="x4 cloud"></div>
      <div class="x5 cloud"></div>
    </div>
    <div v-else :style="background"></div>
    <div class="form-wrapper">
      <div class="container">
        <span class="brand-badge">
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
            <defs>
              <linearGradient id="brandGrad" x1="0" y1="0" x2="36" y2="36" gradientUnits="userSpaceOnUse">
                <stop stop-color="#2563eb"/>
                <stop offset="1" stop-color="#7c3aed"/>
              </linearGradient>
            </defs>
            <rect width="36" height="36" rx="10" fill="url(#brandGrad)"/>
            <rect x="8" y="11" width="20" height="14" rx="2" stroke="#fff" stroke-width="1.8"/>
            <path d="M9 13l9 6 9-6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
        <span class="form-title">{{ settingStore.settings.title }}</span>
        <span class="form-desc" v-if="show === 'login'">{{ $t('loginTitle') }}</span>
        <span class="form-desc" v-else>{{ $t('regTitle') }}</span>
        <div v-show="show === 'login'">
          <el-input :class="!hideLoginDomain ? 'email-input' : ''" v-model="form.email"
                    type="text" :placeholder="$t('emailAccount')" autocomplete="off" @keyup.enter="submit">
            <template #append v-if="!hideLoginDomain">
              <div @click.stop="openSelect">
                <el-select
                    v-if="show === 'login'"
                    ref="mySelect"
                    v-model="suffix"
                    :placeholder="$t('select')"
                    class="select"
                >
                  <el-option
                      v-for="item in domainList"
                      :key="item"
                      :label="item"
                      :value="item"
                  />
                </el-select>
                <div style="color: var(--el-text-color-primary)">
                  <span>{{ suffix }}</span>
                  <Icon class="setting-icon" icon="mingcute:down-small-fill" width="20" height="20"/>
                </div>
              </div>
            </template>
          </el-input>
          <el-input v-model="form.password" :placeholder="$t('password')" type="password" autocomplete="off" @keyup.enter="submit">
          </el-input>
          <el-button class="btn" type="primary" @click="submit" :loading="loginLoading"
          >{{ $t('loginBtn') }}
          </el-button>
          <el-button v-for="p in oauthProviders" :key="p.key" class="btn" style="margin-top: 10px" @click="oauthLogin(p.key)">
            <el-avatar v-if="p.iconType === 'image'" :src="p.icon" :size="18" style="margin-right: 10px" />
            <Icon v-else :icon="p.icon" width="18" height="18" style="margin-right: 10px" />
            {{ p.label }}
          </el-button>
        </div>
        <div v-show="show !== 'login'">
          <el-input :class="!hideLoginDomain ? 'email-input' : ''" v-model="registerForm.email" type="text" :placeholder="$t('emailAccount')"
                    autocomplete="off" @keyup.enter="submitRegister">
            <template #append v-if="!hideLoginDomain">
              <div @click.stop="openSelect">
                <el-select
                    v-if="show !== 'login'"
                    ref="mySelect"
                    v-model="suffix"
                    :placeholder="$t('select')"
                    class="select"
                >
                  <el-option
                      v-for="item in domainList"
                      :key="item"
                      :label="item"
                      :value="item"
                  />
                </el-select>
                <div>
                  <span>{{ suffix }}</span>
                  <Icon class="setting-icon" icon="mingcute:down-small-fill" width="20" height="20"/>
                </div>
              </div>
            </template>
          </el-input>
          <el-input v-model="registerForm.password" :placeholder="$t('password')" type="password" autocomplete="off" @keyup.enter="submitRegister"/>
          <el-input v-model="registerForm.confirmPassword" :placeholder="$t('confirmPwd')" type="password"
                    autocomplete="off" @keyup.enter="submitRegister"/>
          <el-input v-if="settingStore.settings.regKey === 0" v-model="registerForm.code" :placeholder="$t('regKey')"
                    type="text" autocomplete="off" @keyup.enter="submitRegister"/>
          <el-input v-if="settingStore.settings.regKey === 2" v-model="registerForm.code"
                    :placeholder="$t('regKeyOptional')" type="text" autocomplete="off" @keyup.enter="submitRegister"/>
          <div v-show="verifyShow"
               ref="turnstileContainer"
               :key="turnstileContainerKey"
               class="register-turnstile"
               :data-sitekey="settingStore.settings.siteKey"
               data-callback="onTurnstileSuccess"
               data-error-callback="onTurnstileError"
               data-after-interactive-callback="loadAfter"
               data-before-interactive-callback="loadBefore"
          >
            <span style="font-size: 12px;color: #F56C6C" v-if="botJsError">{{ $t('verifyModuleFailed', {action: $t('regBtn')}) }}</span>
          </div>
          <el-alert v-if="turnstileFailed" :title="t('turnstileLoadFailed')" type="warning" show-icon :closable="false" style="margin-bottom: 18px" />
          <el-button class="btn" style="margin: 0" type="primary" @click="submitRegister" :loading="registerLoading"
          >{{ $t('regBtn') }}
          </el-button>
          <el-button v-for="p in oauthProviders" :key="p.key" class="btn" style="margin-top: 10px" @click="oauthLogin(p.key)">
            <el-avatar v-if="p.iconType === 'image'" :src="p.icon" :size="18" style="margin-right: 10px" />
            <Icon v-else :icon="p.icon" width="18" height="18" style="margin-right: 10px" />
            {{ p.label }}
          </el-button>
        </div>
        <template v-if="settingStore.settings.register === 0">
          <div class="switch" @click="show = 'register'" v-if="show === 'login'">{{ $t('noAccount') }}
            <span>{{ $t('regSwitch') }}</span></div>
          <div class="switch" @click="show = 'login'" v-else>{{ $t('hasAccount') }} <span>{{ $t('loginSwitch') }}</span>
          </div>
        </template>
      </div>
    </div>
    <el-dialog class="bind-dialog" v-model="showBindForm"  title="注册邮箱" >
      <div class="bind-container">
        <el-input :class="!hideLoginDomain ? 'email-input' : ''" v-model="bindForm.email" type="text" :placeholder="$t('emailAccount')" autocomplete="off" @keyup.enter="bind">
          <template #append v-if="!hideLoginDomain">
            <div @click.stop="openSelect">
              <el-select
                  ref="mySelect"
                  v-model="suffix"
                  :placeholder="$t('select')"
                  class="select"
              >
                <el-option
                    v-for="item in domainList"
                    :key="item"
                    :label="item"
                    :value="item"
                />
              </el-select>
              <div>
                <span>{{ suffix }}</span>
                <Icon class="setting-icon" icon="mingcute:down-small-fill" width="20" height="20"/>
              </div>
            </div>
          </template>
        </el-input>
        <el-input v-if="settingStore.settings.regKey === 0" v-model="bindForm.code" :placeholder="$t('regKey')"
                  type="text" autocomplete="off" @keyup.enter="bind"/>
        <el-input v-if="settingStore.settings.regKey === 2" v-model="bindForm.code"
                  :placeholder="$t('regKeyOptional')" type="text" autocomplete="off" @keyup.enter="bind"/>
        <div v-show="bindVerifyShow"
             ref="bindTurnstileContainer"
             :key="bindTurnstileContainerKey"
             class="register-turnstile"
             :data-sitekey="settingStore.settings.siteKey"
             data-callback="onTurnstileSuccess"
             data-error-callback="onTurnstileError"
             data-after-interactive-callback="loadAfter"
             data-before-interactive-callback="loadBefore"
        >
          <span style="font-size: 12px;color: #F56C6C" v-if="botJsError">{{ $t('verifyModuleFailed', {action: $t('regBtn')}) }}</span>
        </div>
        <el-alert v-if="turnstileFailed" :title="t('turnstileLoadFailed')" type="warning" show-icon :closable="false" />
        <el-button class="btn" type="primary" @click="bind" :loading="bindLoading"
        >绑定
        </el-button>
      </div>
    </el-dialog>
    <a v-show="settingStore.settings.projectLink" class="github" href="https://github.com/maillab/cloud-mail">
      <Icon icon="mingcute:github-line" color="#1890ff" width="20" height="20" />
    </a>
  </div>
</template>

<script setup>
import router from "@/router";
import {useRoute} from "vue-router";
import {computed, nextTick, reactive, ref} from "vue";
import http from "@/axios/index.js";
import {websiteConfig} from "@/request/setting.js";
import {isEmail} from "@/utils/verify-utils.js";
import {useSettingStore} from "@/store/setting.js";
import {useAccountStore} from "@/store/account.js";
import {useUserStore} from "@/store/user.js";
import {useUiStore} from "@/store/ui.js";
import {Icon} from "@iconify/vue";
import {cvtR2Url} from "@/utils/convert.js";
import {loginUserInfo, getLocale, setLocale} from "@/request/my.js";
import i18n from "@/i18n/index.js";
import { SUPPORTED_LOCALES, applyLocale, syncLocaleWithServer } from "@/i18n/locale.js";
import { loadPrefs } from "@/utils/preferences.js";
import {permsToRouter} from "@/perm/perm.js";
import {useI18n} from "vue-i18n";
import {oauthLinuxDoLogin, oauthGithubLogin, oauthGoogleLogin} from "@/request/ouath.js";
import {reloadTurnstileScript} from "@/utils/turnstile-script.js";

const {t} = useI18n();

// Phase 2 A 路：注册/登录后端报错映射成人话。
// 后端抛的是 t('key') 解析后的中/英文串（见 mail-worker/src/i18n/zh.js、en.js），
// 故映射表同时覆盖 zh 与 en 两种原文；未命中时原样返回，不吞掉未知报错。
// 注意：axios 拦截器会对非 200 响应自动弹后端原文（见 src/axios/index.js），
// 本页登录/注册/绑定三个请求改走 noMsg，由这里统一弹映射后的人话，避免一条报错弹两次。
const authErrorMap = {
  // noRegKeyCount：注册码剩余次数不足
  '注册码剩余次数不足': 'authErrNoRegKeyCount',
  'Invite code has no remaining uses': 'authErrNoRegKeyCount',
  // regKeyExpire：注册码已过期
  '注册码已过期': 'authErrRegKeyExpire',
  'Invite code has expired': 'authErrRegKeyExpire',
  // botVerifyFail：人机验证失败
  '人机验证失败,请重试': 'authErrBotVerifyFail',
  'Bot verification failed, please try again': 'authErrBotVerifyFail',
  // emptyBotToken：需要进行人机验证
  '需要进行人机验证': 'authErrEmptyBotToken',
  'Please verify that you are human': 'authErrEmptyBotToken',
  // regIpLimit：该 IP 注册已达上限
  '该网络今日注册已达上限，请明天再试': 'authErrRegIpLimit',
  'Too many sign-ups from this network today, please try again tomorrow': 'authErrRegIpLimit',
  // regTooFrequent：操作太频繁
  '注册请求过于频繁，请稍后再试': 'authErrRegTooFrequent',
  'Too many sign-up attempts, please try again later': 'authErrRegTooFrequent',
  // regCircuitOpen：注册暂时关闭维护中
  '注册功能暂时关闭维护中，请稍后再试': 'authErrRegCircuitOpen',
  'Sign-up is temporarily closed for maintenance, please try again later': 'authErrRegCircuitOpen',
  // turnstileNotConfigured：验证服务未配置
  '人机验证未配置，请联系管理员': 'authErrTurnstileNotConfigured',
  'Bot verification is not configured, please contact the administrator': 'authErrTurnstileNotConfigured',
  // ipBlockedRegister：该 IP 已被封禁
  '该网络已被限制注册': 'authErrIpBlockedRegister',
  'Sign-up from this network is blocked': 'authErrIpBlockedRegister',
}

function friendlyAuthError(err) {
  const raw = err?.message || ''
  const key = authErrorMap[raw]
  return key ? t(key) : (raw || t('reqFailErrorMsg'))
}

function showAuthError(err) {
  ElMessage({
    message: friendlyAuthError(err),
    type: 'error',
    plain: true,
  })
}
const accountStore = useAccountStore();
const userStore = useUserStore();
const uiStore = useUiStore();
const settingStore = useSettingStore();
const route = useRoute();
const loginLoading = ref(false)
const bindLoading = ref(false)
const oauthLoading = ref(false);
const showBindForm = ref(false);
const show = ref('login')

const oauthKeys = ['linuxdo', 'github', 'google']

const oauthProvider = computed(() => {
  const fromState = route.query.state
  if (oauthKeys.includes(fromState)) return fromState
  const fromStore = sessionStorage.getItem('oauthProvider')
  return oauthKeys.includes(fromStore) ? fromStore : null
})

const oauthProviders = computed(() => {
  const allProviders = [
    { key: 'google', label: 'Google', icon: 'devicon:google', iconType: 'iconify' },
    { key: 'github', label: 'GitHub', icon: 'codicon:github-inverted', iconType: 'iconify' },
    { key: 'linuxdo', label: 'LinuxDo', icon: '/image/linuxdo.webp', iconType: 'image' },
  ]
  return allProviders.filter(p => settingStore.settings[p.key + 'Switch'] === 0)
})

const bindForm = reactive({
  email: '',
  oauthUserId: '',
  code: ''
})

const form = reactive({
  email: '',
  password: '',

});
const mySelect = ref()
const suffix = ref('')
const registerForm = reactive({
  email: '',
  password: '',
  confirmPassword: '',
  code: null
})
const domainList = settingStore.domainList;
const registerLoading = ref(false)
suffix.value = domainList[0]
const verifyShow = ref(false)
const bindVerifyShow = ref(false)
const bindTurnstileContainer = ref(null)
const bindTurnstileContainerKey = ref(0)
let verifyToken = ''
let turnstileId = null
let botJsError = ref(false)
let turnstileFailed = ref(false)
let verifyErrorCount = 0
let turnstileRecoveryAttempted = false
const turnstileContainer = ref(null)
const turnstileContainerKey = ref(0)

async function recoverTurnstile() {
  if (turnstileRecoveryAttempted) return
  turnstileRecoveryAttempted = true
  botJsError.value = false
  turnstileFailed.value = false
  verifyToken = ''
  turnstileId = null
  turnstileContainerKey.value++
  try {
    const api = await reloadTurnstileScript()
    await nextTick()
    if (show.value === 'login' || !turnstileContainer.value) return
    turnstileId = api.render(turnstileContainer.value)
  } catch (error) {
    botJsError.value = true
    turnstileFailed.value = true
    console.warn('Turnstile recovery failed', error)
  } finally {
    turnstileRecoveryAttempted = false
  }
}

async function renderBindTurnstile() {
  await nextTick()
  if (!bindTurnstileContainer.value) return
  try {
    // 绑定流程与注册流程互斥，复用同一个 turnstileId / verifyToken；
    // 每次都重新渲染进绑定容器，不复用注册容器的 widget。
    turnstileId = window.turnstile.render(bindTurnstileContainer.value)
  } catch (e) {
    botJsError.value = true
    turnstileFailed.value = true
    console.log('人机验证js加载失败')
    recoverBindTurnstile()
  }
}

async function recoverBindTurnstile() {
  if (turnstileRecoveryAttempted) return
  turnstileRecoveryAttempted = true
  botJsError.value = false
  turnstileFailed.value = false
  verifyToken = ''
  turnstileId = null
  bindTurnstileContainerKey.value++
  try {
    const api = await reloadTurnstileScript()
    await nextTick()
    if (!showBindForm.value || !bindTurnstileContainer.value) return
    turnstileId = api.render(bindTurnstileContainer.value)
  } catch (error) {
    botJsError.value = true
    turnstileFailed.value = true
    console.warn('Turnstile recovery failed', error)
  } finally {
    turnstileRecoveryAttempted = false
  }
}

window.onTurnstileSuccess = (token) => {
  verifyToken = token;
  turnstileFailed.value = false;
};

window.onTurnstileError = (e) => {
  if (verifyErrorCount >= 4) {
    return
  }
  verifyErrorCount++
  console.warn('人机验加载失败', e)
  setTimeout(() => {
    nextTick(() => {
      if (!turnstileId) {
        turnstileId = window.turnstile.render('.register-turnstile')
      } else {
        window.turnstile.reset(turnstileId);
      }
    })
  }, 1500)
};

window.loadAfter = (e) => {
  console.log('loadAfter')
}

window.loadBefore = (e) => {
  console.log('loadBefore')
}

const loginOpacity = computed(() => {
  const opacity = settingStore.settings.loginOpacity
  return uiStore.dark ? `rgba(0, 0, 0, ${opacity})` : `rgba(255, 255, 255, ${opacity})`
})

const hideLoginDomain = computed(() => settingStore.settings.loginDomain === 1)

const background = computed(() => {

  return settingStore.settings.background ? {
    'background-image': `url(${cvtR2Url(settingStore.settings.background)})`,
    'background-repeat': 'no-repeat',
    'background-size': 'cover',
    'background-position': 'center'
  } : ''
})

const openSelect = () => {
  mySelect.value.toggleMenu()
}

// Phase 2 A 路补充：公开页语言切换器（右上角，8 种语言名用各自母语显示）。
// 未登录时只写本地 mail-locale；登录后由 saveToken() 再与后端同步。
const currentLocaleLabel = computed(() => {
  const found = SUPPORTED_LOCALES.find(item => item.short === settingStore.lang)
  return found ? found.label : '简体中文'
})

async function onSwitchLocale(short) {
  await applyLocale(i18n, settingStore, short)
}

const getFullEmail = (email) => {
  return hideLoginDomain.value ? email : email + suffix.value
}

const getEmailName = (email) => {
  return email.split('@')[0]
}

function oauthLogin(provider) {
  const clientId = settingStore.settings[provider + 'ClientId']
  const redirectUri = encodeURIComponent(window.location.origin + '/login')
  sessionStorage.setItem('oauthProvider', provider)
  const authorizeUrls = {
    linuxdo: `https://connect.linux.do/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=openid+profile+email&state=${provider}`,
    github: `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=user:email&state=${provider}`,
    google: `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=openid+profile+email&state=${provider}`,
  }
  window.location.href = authorizeUrls[provider]
}

const loginFns = {
  linuxdo: oauthLinuxDoLogin,
  github: oauthGithubLogin,
  google: oauthGoogleLogin,
}

oauthGetUser();

async function oauthGetUser() {

  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  if (!code || !oauthProvider.value) return

  const provider = oauthProvider.value
  oauthLoading.value = true
  sessionStorage.removeItem('oauthProvider')
  window.history.replaceState({}, '', window.location.origin + window.location.pathname)

  loginFns[provider](code, window.location.origin + '/login').then(data => {

    bindForm.oauthUserId = data.userInfo.oauthUserId;

    if (!data.token) {
      // 绑定页单独验：丢弃注册流程可能残留的旧 token，强制重新验证
      verifyToken = ''
      bindVerifyShow.value = false
      showBindForm.value = true
      oauthLoading.value = false
      ElMessage({
        message: '请注册绑定一个邮箱',
        type: 'warning',
        duration: 4000,
        plain: true,
      })
      return;
    }

    saveToken(data.token);
  }).catch(() => {
    oauthLoading.value = false
  })
}

function bind() {

  if (bindLoading.value) return

  if (!bindForm.email) {
    ElMessage({
      message: t('emptyEmailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }


  if (getEmailName(bindForm.email).length < settingStore.settings.minEmailPrefix) {
    ElMessage({
      message: t('minEmailPrefix', {msg: settingStore.settings.minEmailPrefix}),
      type: 'error',
      plain: true,
    })
    return
  }

  let email = getFullEmail(bindForm.email);


  if (!isEmail(email)) {
    ElMessage({
      message: t('notEmailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (settingStore.settings.regKey === 0) {

    if (!bindForm.code) {

      ElMessage({
        message: t('emptyRegKeyMsg'),
        type: 'error',
        plain: true,
      })
      return
    }

  }

  // OAuth 绑定走与普通注册同样的验证：registerVerify 为 OPEN(0) 或 COUNT(2) 时必验
  if (!verifyToken && (settingStore.settings.registerVerify === 0 || settingStore.settings.registerVerify === 2)) {
    if (!bindVerifyShow.value) {
      bindVerifyShow.value = true
      renderBindTurnstile()
    } else if (botJsError.value) {
      recoverBindTurnstile()
    } else {
      ElMessage({
        message: t('botVerifyMsg'),
        type: 'error',
        plain: true,
      })
    }
    return
  }

  const form = {email, oauthUserId: bindForm.oauthUserId, code: bindForm.code, token: verifyToken}

  bindLoading.value = true
  // noMsg：拦截器不弹后端原文，由下面 catch 统一弹映射后的人话
  http.put('/oauth/bindUser', form, {noMsg: true}).then(data => {
    verifyToken = ''
    bindVerifyShow.value = false
    saveToken(data.token)
  }).catch((err) => {
    bindLoading.value = false
    // token 一次性使用，失败后清掉并重置 widget，避免旧 token 被重放
    verifyToken = ''
    if (turnstileId) {
      try {
        window.turnstile.reset(turnstileId)
      } catch (e) {
      }
    }
    showAuthError(err)
  })
}

const submit = () => {

  if (loginLoading.value) return

  if (!form.email) {
    ElMessage({
      message: t('emptyEmailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  let email = getFullEmail(form.email);

  if (!isEmail(email)) {
    ElMessage({
      message: t('notEmailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (!form.password) {
    ElMessage({
      message: t('emptyPwdMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  loginLoading.value = true
  // noMsg：拦截器不弹后端原文，由下面 catch 统一弹映射后的人话
  http.post('/login', {email, password: form.password}, {noMsg: true}).then(async data => {
    await saveToken(data.token)
  }).catch(showAuthError).finally(() => {
    loginLoading.value = false
  })
}

async function saveToken(token) {
  localStorage.setItem('token', token)
  refreshWebsiteConfig()
  const user = await loginUserInfo();
  // Phase 2 A 路补充：登录成功后同步语言偏好——后端有值则以其为准回写本地，
  // 后端为空则把本地 mail-locale 写到后端（best-effort，不阻断登录）。
  await syncLocaleWithServer({ i18n, settingStore, getLocale, setLocale });
  accountStore.currentAccountId = user.account.accountId;
  accountStore.currentAccount = user.account;
  userStore.user = user;
  const routers = permsToRouter(user.permKeys);
  routers.forEach(routerData => {
    router.addRoute('layout', routerData);
  });
  await router.replace({name: 'layout'})
  // Phase 2 A 路补充：登录后是否弹系统公告，尊重用户的通知开关（默认开）。
  if (loadPrefs().notice !== false) {
    uiStore.showNotice()
  }
  oauthLoading.value = false;
  bindLoading.value = false;
}

function refreshWebsiteConfig() {
  websiteConfig().then(setting => {
    settingStore.settings = setting
    settingStore.domainList = setting.domainList
    if (!suffix.value && setting.domainList.length > 0) {
      suffix.value = setting.domainList[0]
    }
    document.title = setting.title
  }).catch(e => {
    console.error(e)
  })
}


function submitRegister() {

  if (registerLoading.value) return

  if (!registerForm.email) {
    ElMessage({
      message: t('emptyEmailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  console.log(registerForm.email)

  if (getEmailName(registerForm.email).length < settingStore.settings.minEmailPrefix) {
    ElMessage({
      message: t('minEmailPrefix', {msg: settingStore.settings.minEmailPrefix}),
      type: 'error',
      plain: true,
    })
    return
  }

  const email = getFullEmail(registerForm.email);

  if (!isEmail(email)) {
    ElMessage({
      message: t('notEmailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (!registerForm.password) {
    ElMessage({
      message: t('emptyPwdMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (registerForm.password.length < 6) {
    ElMessage({
      message: t('pwdLengthMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (registerForm.password !== registerForm.confirmPassword) {

    ElMessage({
      message: t('confirmPwdFailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (settingStore.settings.regKey === 0) {

    if (!registerForm.code) {

      ElMessage({
        message: t('emptyRegKeyMsg'),
        type: 'error',
        plain: true,
      })
      return
    }

  }

  if (!verifyToken && (settingStore.settings.registerVerify === 0 || settingStore.settings.registerVerify === 2)) {
    if (turnstileRecoveryAttempted) return
    if (!verifyShow.value) {
      verifyShow.value = true
      nextTick(() => {
        if (!turnstileId) {
          try {
            turnstileId = window.turnstile.render('.register-turnstile')
          } catch (e) {
            botJsError.value = true
            turnstileFailed.value = true
            console.log('人机验证js加载失败')
            recoverTurnstile()
          }
        } else {
          window.turnstile.reset('.register-turnstile')
        }
      })
    } else if (botJsError.value) {
      recoverTurnstile()
    } else {
      ElMessage({
        message: t('botVerifyMsg'),
        type: "error",
        plain: true
      })
    }
    return;
  }

  registerLoading.value = true

  const form = {
    email,
    password: registerForm.password,
    token: verifyToken,
    code: registerForm.code
  }

  // noMsg：拦截器不弹后端原文，由下面 catch 统一弹映射后的人话
  http.post('/register', form, {noMsg: true}).then(({regVerifyOpen}) => {
    show.value = 'login'
    registerForm.email = ''
    registerForm.password = ''
    registerForm.confirmPassword = ''
    registerForm.code = ''
    registerLoading.value = false
    verifyToken = ''
    settingStore.settings.regVerifyOpen = regVerifyOpen
    verifyShow.value = false
    ElMessage({
      message: t('regSuccessMsg'),
      type: 'success',
      plain: true,
    })
  }).catch(res => {

    registerLoading.value = false
    showAuthError(res)

    if (res.code === 400) {
      verifyToken = ''
      settingStore.settings.regVerifyOpen = true
      if (turnstileId) {
        window.turnstile.reset(turnstileId)
      } else {
        nextTick(() => {
          turnstileId = window.turnstile.render('.register-turnstile')
        })
      }
      verifyShow.value = true

    }
  });
}

</script>


<style>
.el-select-dropdown__item {
  padding: 0 15px;
}

.no-autofill-pwd {
  .el-input__inner {
    -webkit-text-security: disc !important;
  }
}
</style>

<style lang="scss" scoped>

.form-wrapper {
  position: fixed;
  right: 0;
  height: 100%;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  @media (max-width: 767px) {
    width: 100%;
  }
}

.container {
  background: v-bind(loginOpacity);
  /* Phase 2 A 路补充：玻璃拟态——磨砂面板 + 柔和描边 + 大阴影 */
  backdrop-filter: blur(18px) saturate(1.3);
  -webkit-backdrop-filter: blur(18px) saturate(1.3);
  border: 1px solid rgba(255, 255, 255, .65);
  box-shadow: 0 24px 60px rgba(37, 99, 235, .18);
  padding-left: 40px;
  padding-right: 40px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  width: 450px;
  height: 100%;
  border-left: 1px solid var(--login-border);
  box-shadow: var(--el-box-shadow-light);
  @media (max-width: 1024px) {
    padding: 20px 18px;
    width: 384px;
    margin-left: 18px;
  }
  @media (max-width: 767px) {
    border: 1px solid var(--login-border);
    padding: 20px 18px;
    border-radius: 6px;
    height: fit-content;
    width: 100%;
    margin-right: 18px;
    margin-left: 18px;
  }

  .btn {
    height: 36px;
    width: 100%;
    border-radius: 10px;
  }

  /* Phase 2 A 路补充：主操作按钮——蓝紫渐变 + 阴影 + 悬停上浮 */
  .btn.el-button--primary {
    background: linear-gradient(135deg, #2563eb, #7c3aed);
    border: none;
    box-shadow: 0 10px 24px rgba(79, 70, 229, .35);
    font-weight: 600;
    letter-spacing: 2px;
    transition: filter .2s, transform .2s, box-shadow .2s;
  }

  .btn.el-button--primary:hover,
  .btn.el-button--primary:focus-visible {
    filter: brightness(1.1);
    transform: translateY(-1px);
    box-shadow: 0 14px 28px rgba(79, 70, 229, .4);
  }

  .btn.el-button--primary:active {
    transform: translateY(0);
  }

  .form-desc {
    margin-top: 5px;
    margin-bottom: 18px;
    color: var(--form-desc-color);
  }

  .form-title {
    font-weight: bold;
    font-size: 22px !important;
    /* Phase 2 A 路补充：标题蓝紫渐变字 */
    background: linear-gradient(90deg, #1d4ed8, #7c3aed);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    width: fit-content;
  }

  /* Phase 2 A 路补充：品牌徽章（内联 SVG 信封） */
  .brand-badge {
    display: inline-flex;
    width: fit-content;
    margin-bottom: 12px;
    filter: drop-shadow(0 8px 16px rgba(79, 70, 229, .35));
  }

  .switch {
    margin-top: 20px;
    text-align: center;

    span {
      color: var(--login-switch-color);
      cursor: pointer;
    }
  }

  :deep(.el-input__wrapper) {
    border-radius: 6px;
    background: var(--el-bg-color);
  }

  .email-input :deep(.el-input__wrapper) {
    border-radius: 6px 0 0 6px;
    background: var(--el-bg-color);
  }

  .el-input {
    height: 38px;
    width: 100%;
    margin-bottom: 18px;

    :deep(.el-input__inner) {
      height: 36px;
    }
  }
}

:deep(.el-select-dropdown__item) {
  padding: 0 10px;
}

:deep(.bind-dialog) {
  width: 400px !important;
  @media (max-width: 440px) {
    width: calc(100% - 40px) !important;
    margin-right: 20px !important;
    margin-left: 20px !important;
  }
}

.bind-container {
  display: grid;
  grid-template-columns: 1fr;
  gap: 15px;
}

.setting-icon {
  position: relative;
  top: 6px;
}

.github {
  position: fixed;
  width: 35px;
  height: 35px;
  display: flex;
  justify-content: center;
  align-items: center;
  border-radius: 50%;
  background: var(--el-bg-color);
  bottom: 10px;
  right: 10px;
  z-index: 1000;
  border: 1px solid var(--el-border-color-light);
  box-shadow: var(--el-box-shadow-light);
  cursor: pointer;
}

:deep(.el-input-group__append) {
  padding: 0 !important;
  padding-left: 8px !important;
  padding-right: 4px !important;
  background: var(--el-bg-color);
  border-radius: 0 8px 8px 0;
}

:deep(.el-button+.el-button) {
  margin: 0;
}

.register-turnstile {
  margin-bottom: 18px;
}

.select {
  position: absolute;
  right: 30px;
  width: 100px;
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
}

.custom-style {
  margin-bottom: 10px;
}

.custom-style .el-segmented {
  --el-border-radius-base: 6px;
  width: 180px;
}


#login-box {
  background: linear-gradient(135deg, #dbeafe 0%, #e0f2fe 32%, #ede9fe 64%, #fce7f3 100%);
  font: 100% Arial, sans-serif;
  height: 100%;
  margin: 0;
  padding: 0;
  overflow-x: hidden;
  display: grid;
  grid-template-columns: 1fr;
}

/* Phase 2 A 路补充：语言切换器（右上角玻璃小药丸） */
.locale-switcher {
  position: fixed;
  top: 14px;
  right: 14px;
  z-index: 20;
}

.locale-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 13px;
  border-radius: 999px;
  background: rgba(255, 255, 255, .8);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, .7);
  box-shadow: 0 6px 18px rgba(37, 99, 235, .16);
  color: #1e293b;
  font-size: 13px;
  cursor: pointer;
  outline: none;
}

.locale-btn:focus-visible {
  box-shadow: 0 0 0 2px rgba(37, 99, 235, .45);
}

.locale-globe {
  flex: none;
}

.locale-caret {
  font-size: 11px;
  color: #64748b;
}

/* Phase 2 A 路补充：背景装饰光斑（纯 CSS 柔光圆） */
.orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(60px);
  opacity: .75;
  pointer-events: none;
}

.orb-1 {
  width: 340px;
  height: 340px;
  left: -80px;
  top: -60px;
  background: radial-gradient(circle, #93c5fd, transparent 70%);
}

.orb-2 {
  width: 300px;
  height: 300px;
  left: 30%;
  bottom: -100px;
  background: radial-gradient(circle, #c4b5fd, transparent 70%);
}

.orb-3 {
  width: 240px;
  height: 240px;
  right: 28%;
  top: 12%;
  background: radial-gradient(circle, #fbcfe8, transparent 70%);
}


#background-wrap {
  height: 100%;
  z-index: 0;
}

@keyframes animateCloud {
  0% {
    margin-left: -500px;
  }

  100% {
    margin-left: 100%;
  }
}

.x1 {
  animation: animateCloud 30s linear infinite;
  transform: scale(0.65);
}

.x2 {
  animation: animateCloud 15s linear infinite;
  transform: scale(0.3);
}

.x3 {
  animation: animateCloud 25s linear infinite;
  transform: scale(0.5);
}

.x4 {
  animation: animateCloud 13s linear infinite;
  transform: scale(0.4);
}

.x5 {
  animation: animateCloud 20s linear infinite;
  transform: scale(0.55);
}

.cloud {
  background: linear-gradient(to bottom, #fff 5%, #f1f1f1 100%);
  border-radius: 100px;
  box-shadow: 0 8px 5px rgba(0, 0, 0, 0.1);
  height: 120px;
  width: 350px;
  position: relative;
}

.cloud:after,
.cloud:before {
  content: "";
  position: absolute;
  background: #fff;
  z-index: -1;
}

.cloud:after {
  border-radius: 100px;
  height: 100px;
  left: 50px;
  top: -50px;
  width: 100px;
}

.cloud:before {
  border-radius: 200px;
  height: 180px;
  width: 180px;
  right: 50px;
  top: -90px;
}

/* Phase 2 A 路补充：输入框聚焦态更清晰 */
.container :deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1px #2563eb inset, 0 0 0 4px rgba(37, 99, 235, .15);
}

/* Phase 2 A 路补充：移动端优先——输入框与主按钮加高到 44px，方便触控 */
@media (max-width: 767px) {
  .container .el-input {
    height: 44px;
  }

  .container .btn {
    height: 44px;
  }

  .locale-switcher {
    top: 10px;
    right: 10px;
  }
}

</style>
