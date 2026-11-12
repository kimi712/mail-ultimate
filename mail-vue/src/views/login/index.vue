<template>
  <div id="login-box" :style=" background ? 'background: var(--el-bg-color)' : ''" v-loading="oauthLoading" element-loading-text="登录中...">
    <IntroAnimation ref="introRef" />
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
    <!-- 注册页：斯诺登远景动态背景（随机一张 + 缓慢运镜循环），只在注册面板时显示。 -->
    <div v-if="show === 'register'" class="register-vista" :style="{ backgroundImage: `url('/wallpapers/${registerWallpaper}')` }"></div>
    <div v-if="show === 'register'" class="register-shade"></div>
    <div id="background-wrap" v-if="show === 'login' && !settingStore.settings.background">
      <div class="orb orb-1"></div>
      <div class="orb orb-2"></div>
      <div class="orb orb-3"></div>
      <div class="x1 cloud"></div>
      <div class="x2 cloud"></div>
      <div class="x3 cloud"></div>
      <div class="x4 cloud"></div>
      <div class="x5 cloud"></div>
    </div>
    <div v-if="show === 'login' && settingStore.settings.background" class="login-custom-bg" :style="background"></div>
    <!-- 无壁纸（用户选了纯色）且无管理员自定义背景时：补一张全屏远景当单层背景，
         否则左侧白色品牌文字落在浅色渐变底上看不清；壁纸开启时 body::before 已是单层全屏背景，这里不渲染。 -->
    <div v-if="show === 'login' && !hasWallpaper && !settingStore.settings.background" class="login-vista-fallback" :style="{ backgroundImage: `url('/wallpapers/${registerWallpaper}')` }"></div>
    <!-- 任务 1 分栏布局：桌面端左侧斯诺登开场大区（品牌 + 名言），右侧表单栏；移动端隐藏，恢复居中表单。
         背景只有一层全屏图（壁纸系统的 body::before，见 style.css）；左侧不再自己铺一张图——
         同一张图在两栏里 cover 裁剪不同、还带独立运镜，竖缝明显。 -->
    <aside class="login-showcase" aria-label="Snowden">
      <div v-if="show === 'login'" class="showcase-shade"></div>
      <div class="showcase-content">
        <span class="showcase-badge">
          <svg width="56" height="56" viewBox="0 0 36 36" fill="none">
            <defs>
              <linearGradient id="brandGradShowcase" x1="0" y1="0" x2="36" y2="36" gradientUnits="userSpaceOnUse">
                <stop stop-color="#2563eb"/>
                <stop offset="1" stop-color="#7c3aed"/>
              </linearGradient>
            </defs>
            <rect width="36" height="36" rx="10" fill="url(#brandGradShowcase)"/>
            <rect x="8" y="11" width="20" height="14" rx="2" stroke="#fff" stroke-width="1.8"/>
            <path d="M9 13l9 6 9-6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
        <h1 class="showcase-title" :class="{ 'title-display': titleUsesDisplayFont }">{{ settingStore.settings.title }}</h1>
        <p class="showcase-vision">{{ $t('loginPrivacyVision') }}</p>
        <figure class="showcase-quote">
          <transition name="login-quote-fade" mode="out-in">
            <div :key="loginQuoteIndex">
              <blockquote>“{{ LOGIN_QUOTES[loginQuoteIndex].en }}”</blockquote>
              <figcaption>{{ $t(LOGIN_QUOTES[loginQuoteIndex].key) }}</figcaption>
            </div>
          </transition>
          <figcaption class="showcase-quote-by">— Edward Snowden</figcaption>
        </figure>
      </div>
    </aside>
    <div class="form-wrapper">
      <div class="container">
        <span class="privacy-vision">{{ $t('loginPrivacyVision') }}</span>
        <!-- Phase 8 斯诺登元素补齐：顶部隐私承诺徽章行（锁图标 + 三项承诺）。 -->
        <div class="privacy-badges">
          <svg class="privacy-lock" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
          <span>{{ $t('loginPrivacyBadges') }}</span>
        </div>
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
        <span class="form-title" :class="{ 'title-display': titleUsesDisplayFont }">{{ settingStore.settings.title }}</span>
        <span class="form-desc" v-if="show === 'login'">{{ $t('loginTitle') }}</span>
        <span class="form-desc" v-else>{{ $t('regTitle') }}</span>
        <div v-show="show === 'login'">
          <template v-if="!totpStep">
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
          <!-- 忘记密码入口：登录按钮下方一眼可见的次要按钮（钥匙图标 + 加粗大字），跳公开的找回账号页 /recovery。 -->
          <div class="forgot" role="button" tabindex="0" @click="router.push({name: 'recovery'})" @keyup.enter="router.push({name: 'recovery'})">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M11 12l9-9"/><path d="M15.5 7.5l3 3"/><path d="M18 5l2.5 2.5"/></svg>
            <span>{{ $t('forgotPassword') }}</span>
          </div>
          <el-button v-for="p in oauthProviders" :key="p.key" class="btn" style="margin-top: 10px" @click="oauthLogin(p.key)">
            <el-avatar v-if="p.iconType === 'image'" :src="p.icon" :size="18" style="margin-right: 10px" />
            <Icon v-else :icon="p.icon" width="18" height="18" style="margin-right: 10px" />
            {{ p.label }}
          </el-button>
          </template>
          <!-- Phase 6 TOTP 第二步：密码通过且账号开 TOTP 时后端不返 JWT，只返 totpToken；
               这里输验证码换 JWT，不存 token、不跳页。 -->
          <template v-else>
            <p class="totp-step-title">{{ $t('loginTotpTitle') }}</p>
            <p class="totp-step-hint">{{ $t('loginTotpHint') }}</p>
            <el-input v-model="totpCode" :placeholder="$t('loginTotpCodePlaceholder')" type="text"
                      autocomplete="one-time-code" maxlength="12" @keyup.enter="submitTotp" @input="totpError = ''" />
            <!-- 错码常驻提示：3 秒 Toast 一闪就没，用户回头看面板时已无任何反馈；
                 错误行留在面板内（role=alert），直到输入新码或重试才消失。 -->
            <el-alert v-if="totpError" :title="totpError" type="error" show-icon :closable="false" class="totp-error" />
            <el-button class="btn" type="primary" @click="submitTotp" :loading="totpLoading"
            >{{ $t('loginTotpSubmit') }}
            </el-button>
            <div class="totp-back" role="button" tabindex="0" @click="backToPassword" @keyup.enter="backToPassword">{{ $t('loginTotpBack') }}</div>
          </template>
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
        <!-- 开场动画默认不再自动播放（2026-11-09 用户定：进站直接显示登录）；想看时点这里手动打开。 -->
        <div class="intro-replay" @click="introRef?.open()">{{ $t('intro.replay') }}</div>
        <!-- Phase 8 斯诺登元素补齐：底部名言三句轮换（淡入淡出，每 6 秒一句；英文原文与开场动画 QUOTES 同源，小字走 i18n intro.quote1/2/3）。 -->
        <figure class="login-quote">
          <transition name="login-quote-fade" mode="out-in">
            <div :key="loginQuoteIndex">
              <blockquote>“{{ LOGIN_QUOTES[loginQuoteIndex].en }}”</blockquote>
              <figcaption>{{ $t(LOGIN_QUOTES[loginQuoteIndex].key) }}</figcaption>
            </div>
          </transition>
          <figcaption class="login-quote-by">— Edward Snowden</figcaption>
        </figure>
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
import {computed, nextTick, onMounted, onUnmounted, reactive, ref, watch} from "vue";
import http from "@/axios/index.js";
import {websiteConfig} from "@/request/setting.js";
import {isEmail} from "@/utils/verify-utils.js";
import {useSettingStore} from "@/store/setting.js";
import {useAccountStore} from "@/store/account.js";
import {useUserStore} from "@/store/user.js";
import {useUiStore} from "@/store/ui.js";
import {Icon} from "@iconify/vue";
import {cvtR2Url} from "@/utils/convert.js";
import {loginUserInfo, getLocale, setLocale, getWallpaper, setWallpaper} from "@/request/my.js";
import {loginTotp} from "@/request/login.js";
import i18n from "@/i18n/index.js";
import { SUPPORTED_LOCALES, applyLocale, syncLocaleWithServer } from "@/i18n/locale.js";
import { syncWallpaperWithServer } from "@/utils/wallpaper.js";
import { loadPrefs } from "@/utils/preferences.js";
import {permsToRouter} from "@/perm/perm.js";
import {useI18n} from "vue-i18n";
import {ElMessageBox} from "element-plus";
import {oauthLinuxDoLogin, oauthGithubLogin, oauthGoogleLogin} from "@/request/ouath.js";
import {reloadTurnstileScript} from "@/utils/turnstile-script.js";
import { deriveAuthKeys, fetchLoginSalt, deriveLoginKeyOnly, generateLoginSalt, setLoginSalt, passwordStrengthScore } from "@/utils/authkeys.js";
import { probeE2eeState } from "@/utils/e2ee-migrate.js";
import { getDuressStatus } from "@/request/snowden3.js";
import IntroAnimation from "@/components/intro-animation/index.vue";

const {t} = useI18n();

// Phase 8 斯诺登元素补齐：登录页底部名言三句轮换。英文原文与开场动画
// intro-animation 的 QUOTES 同源（PHASE7.md §7 核实过的三句，一字不改），
// 各语种小字翻译走 i18n intro.quote1/2/3；每 6 秒换一句，淡入淡出。
const LOGIN_QUOTES = [
  {
    key: 'intro.quote1',
    en: "Arguing that you don't care about the right to privacy because you have nothing to hide is no different than saying you don't care about free speech because you have nothing to say.",
  },
  {
    key: 'intro.quote2',
    en: "Privacy isn't about something to hide. Privacy is about something to protect.",
  },
  {
    key: 'intro.quote3',
    en: 'Under observation, we act less free, which means we effectively are less free.',
  },
]
const loginQuoteIndex = ref(0)
let loginQuoteTimer = null
onMounted(() => {
  document.documentElement.classList.add('page-login')
  loginQuoteTimer = setInterval(() => {
    loginQuoteIndex.value = (loginQuoteIndex.value + 1) % LOGIN_QUOTES.length
  }, 6000)
})
onUnmounted(() => {
  document.documentElement.classList.remove('page-login')
  if (loginQuoteTimer) clearInterval(loginQuoteTimer)
})

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
  // botUaBlocked：浏览器标识异常（机器人 UA 硬拒）
  '浏览器标识异常，请用最新版 Chrome 或 Safari 重新打开本站再试': 'authErrBotUa',
  'Browser identification is abnormal, please reopen this site in the latest Chrome or Safari and try again': 'authErrBotUa',
  // regSegmentLimit：网段限额
  '这个网段今天注册的人太多了，请明天再试': 'authErrRegSegmentLimit',
  'Too many sign-ups from this network segment today, please try again tomorrow': 'authErrRegSegmentLimit',
  // regRandomNameBurst：随机名 + 集中注册
  '注册过于频繁，请稍后再试': 'authErrRegRandomName',
  'Sign-up blocked: too many similar sign-up attempts, please try again later': 'authErrRegRandomName',
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
  // authErrLoginFailed：登录失败通用错误（Phase 8 H：不区分邮箱不存在/已注销/已禁用/密码错）
  '邮箱或密码不正确，请重试。': 'authErrLoginFailed',
  'Incorrect email or password. Please try again.': 'authErrLoginFailed',
  // 2026-11-12 uwu 第 1 步：登录密钥机制的新错误（客户端太旧 / 登录密钥无效）
  '客户端太旧，请刷新页面后重新登录': 'authErrLoginClientOutdated',
  'Your client is outdated. Please refresh the page and log in again.': 'authErrLoginClientOutdated',
  '登录密钥无效，请刷新页面重试': 'authErrInvalidLoginKey',
  'Invalid login key. Please refresh the page and try again.': 'authErrInvalidLoginKey',
  // pwdTooWeak：注册口令强度 0 分（服务端底线，见 login-service.js）
  '密码太弱：请用至少 8 位，或混用大小写、数字、符号': 'pwdTooWeak',
  'Password too weak: use at least 8 characters, or mix upper/lower case, digits and symbols': 'pwdTooWeak',
  // totpInvalidCode：TOTP 第二步验证码错误（可重试，totpToken 仍有效）
  '二次验证码错误，请重试': 'loginTotpInvalidCode',
  'Invalid verification code, please try again': 'loginTotpInvalidCode',
  // totpTokenInvalid：TOTP 第二步已过期/无效（回密码登录重取 totpToken）
  '二次验证已过期，请重新登录': 'loginTotpExpired',
  'Two-factor verification expired, please sign in again': 'loginTotpExpired',
  // totpLocked：TOTP 第二步失败 5 次，totpToken 已作废（回密码登录）
  '二次验证失败次数过多，该验证已作废，请重新登录': 'loginTotpLocked',
  'Too many failed verification attempts, please sign in again': 'loginTotpLocked',
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
// Phase 6 TOTP 第二步：密码通过且账号开 TOTP 时，后端只返 totpToken 不返 JWT，
// 这里切到验证码输入，不存 token、不跳页；凭 totpToken 调 /login/totp 换 JWT。
const totpStep = ref(false)
const totpToken = ref('')
const totpCode = ref('')
const totpLoading = ref(false)
// TOTP 第二步错码常驻提示（面板内显示，输入新码/重试/回密码页时清空）。
const totpError = ref('')
// 2026-11-12 uwu 第 1 步：登录密钥机制（密码不出浏览器）。本次登录派生的
// 密钥放内存里，只到登录完成（TOTP 第二步也用它），随后交 saveToken 存盐 +
// 跑 E2EE 探针；口令原文用完即清，不落库、不写 localStorage。
// {salt, loginKey, mailKey, password}。
const pendingAuthKeys = ref(null)

// 登录成功后的后台检查（不阻断进站）：E2EE 探针（暴露/未迁移提示）+
// 胁迫密码 legacy 提示（老胁迫行须在安全中心重设一次）。
// 入口：saveToken(token, authKeys)，仅密码登录路径传 authKeys。
async function afterLoginChecks(authKeys) {
  if (!authKeys) return
  try {
    const probe = await probeE2eeState({ mailKey: authKeys.mailKey || null, password: authKeys.password || '' })
    if (probe?.state === 1) {
      ElMessage({
        message: t('e2eeExposedWarn'),
        type: 'warning',
        duration: 8000,
        plain: true,
      })
    } else if (probe?.state === 2) {
      ElMessage({
        message: t('e2eeNotMigratedWarn'),
        type: 'warning',
        duration: 8000,
        plain: true,
      })
    }
  } catch (e) {
    // best-effort：探针失败不阻断登录
  }
  try {
    const duress = await getDuressStatus()
    if (duress && duress.legacy) {
      ElMessage({
        message: t('duressLegacyWarn'),
        type: 'warning',
        duration: 8000,
        plain: true,
      })
    }
  } catch (e) {
    // best-effort
  }
}
const bindLoading = ref(false)
const oauthLoading = ref(false);
const showBindForm = ref(false);
const show = ref('login')
const introRef = ref(null)

// 注册页动态背景：15 张斯诺登远景同款壁纸，每次进入随机挑一张（与开场动画同源）。
const REGISTER_WALLPAPERS = [
  'snowden-vista.jpg',
  'snowden-02.jpg',
  'snowden-03.jpg',
  'snowden-04.jpg',
  'snowden-05.jpg',
  'snowden-06.jpg',
  'snowden-07.jpg',
  'snowden-08.jpg',
  'snowden-09.jpg',
  'snowden-10.jpg',
  'snowden-11.jpg',
  'snowden-18.jpg',
  'snowden-19.jpg',
  'snowden-20.jpg',
  'snowden-21.jpg',
]
const registerWallpaper = REGISTER_WALLPAPERS[Math.floor(Math.random() * REGISTER_WALLPAPERS.length)]

// 任务 4 标题展示字体：品牌标题不含汉字时才用 Bebas/Montserrat 展示字体（与侧栏同规则）。
const titleUsesDisplayFont = computed(() => !/\p{Script=Han}/u.test(settingStore.settings.title || ''))

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

// 批量薅号防线：注册页切过来就预渲染 Turnstile，不用等第一次提交才出现。
// 老站注册页的问题就是后台开着、前端没渲染出验证框——懒加载只在提交时才渲染，
// 脚本没加载完或 siteKey 为空时用户看到的是空白框、提交永远失败。
// 这里切到注册页就渲染：验证开启（registerVerify 0/2）且 siteKey 已配才渲染；
// siteKey 为空时直接亮告警（后端本来就会拒），不静默留白。
// 已渲染过就 remove 后重渲进当前容器（绑定流程共用同一个 turnstileId，别复用错容器）。
async function ensureRegisterTurnstile() {
  if (!(settingStore.settings.registerVerify === 0 || settingStore.settings.registerVerify === 2)) return
  if (!settingStore.settings.siteKey) {
    botJsError.value = true
    turnstileFailed.value = true
    return
  }
  verifyShow.value = true
  try {
    await nextTick()
    if (!turnstileContainer.value) return
    if (turnstileId) {
      try { window.turnstile.remove(turnstileId) } catch (e) { /* 旧 widget 已不在 */ }
      turnstileId = null
      verifyToken = ''
    }
    if (!window.turnstile?.render) {
      const api = await reloadTurnstileScript()
      await nextTick()
      if (!turnstileContainer.value) return
      turnstileId = api.render(turnstileContainer.value)
      return
    }
    turnstileId = window.turnstile.render(turnstileContainer.value)
  } catch (e) {
    botJsError.value = true
    turnstileFailed.value = true
    console.log('人机验证js加载失败')
    recoverTurnstile()
  }
}

watch(show, (val) => {
  if (val === 'register') {
    ensureRegisterTurnstile()
  }
})

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

// 壁纸是否生效（App.vue 启动时已 applyWallpaper）：生效时 body::before 就是单层全屏背景；
// 未生效（用户选了纯色）时 login-vista-fallback 补一张全屏远景。登录页挂载时给 <html>
// 挂 page-login，壁纸层只在登录页缓慢放大（离开登录页即停，不动收件箱）；手机端同样生效。
const hasWallpaper = computed(() => {
  try { return document.documentElement.dataset.wallpaper === '1' } catch (e) { return false }
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
  const name = String(email || '').trim();
  if (hideLoginDomain.value) return name;
  // 用户若已输入完整邮箱（含 @），不再追加域名后缀，避免 user@flame.edu.kg@flame.edu.kg；
  // 同时 trim 掉手机键盘误加的前后空格，否则注册与登录的邮箱对不上。
  if (name.includes('@')) return name;
  return name + suffix.value;
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
  // 密码 trim：手机键盘常在末尾误加空格，注册与登录须用同一处理，否则注册成功却登不上。
  // noMsg：拦截器不弹后端原文，由下面 catch 统一弹映射后的人话
  // 2026-11-12 uwu 第 1 步：密码不出浏览器。先取盐 → 浏览器内 PBKDF2-600k +
  // HKDF 一分二（登录密钥 + 邮件密钥）→ 只发登录密钥。老用户（version 1）
  // 本次带一次明文密码做迁移桥，服务端验旧 hash 后即存新验证器。
  const passwordTrimmed = String(form.password || '').trim()
  const loginPromise = (async () => {
    pendingAuthKeys.value = null
    const saltInfo = await fetchLoginSalt(email)
    const authKeys = await deriveAuthKeys(passwordTrimmed, saltInfo.salt)
    const body = { email, loginKey: authKeys.loginKey, pwdScore: passwordStrengthScore(passwordTrimmed) }
    // 胁迫密码已开通时：同一口令再按胁迫盐派生一次，服务端先试主密钥、再试胁迫密钥。
    if (saltInfo.decoySalt) {
      body.decoyLoginKey = await deriveLoginKeyOnly(passwordTrimmed, saltInfo.decoySalt)
    }
    if (saltInfo.version === 1) {
      // 老用户迁移桥：本次带一次明文密码，服务端验旧 hash 通过后即存新验证器。
      body.password = passwordTrimmed
    }
    pendingAuthKeys.value = { salt: saltInfo.salt, loginKey: authKeys.loginKey, mailKey: authKeys.mailKey, password: passwordTrimmed }
    return http.post('/login', body, {noMsg: true})
  })()
  loginPromise.then(async data => {
    // TOTP 第二步：密码通过但账号开 TOTP 时后端不返 JWT，只返 totpToken；
    // 切到验证码输入，不存 token、不跳页。旧逻辑直接 saveToken(data.token)，
    // data.token 为 undefined 时会把字符串 "undefined" 写进 localStorage，
    // 随后 loginUserInfo 带着无效 token 调接口 → 401 → 弹「身份认证失效」。
    if (data && data.needTotp) {
      totpToken.value = data.totpToken || ''
      totpCode.value = ''
      totpStep.value = true
      return
    }
    if (data && data.token) {
      await saveToken(data.token, pendingAuthKeys.value)
      return
    }
    // 防御：既无 token 又非 TOTP，不写 localStorage，直接报错。
    showAuthError(new Error(t('reqFailErrorMsg')))
  }).catch((e) => {
    pendingAuthKeys.value = null
    showAuthError(e)
  }).finally(() => {
    loginLoading.value = false
  })
}

// Phase 6 TOTP 第二步提交：totpToken + 码（6 位动态码或备份码）换正式 JWT。
// 错码留在验证码页可重试；失败 5 次（totpLocked 403）或 totpToken 过期/无效时回密码登录。
function submitTotp() {
  if (totpLoading.value) return
  const code = String(totpCode.value || '').trim().replace(/\s+/g, '')
  if (!code) {
    ElMessage({
      message: t('totpNeedCode'),
      type: 'error',
      plain: true,
    })
    return
  }
  totpLoading.value = true
  totpError.value = ''
  loginTotp(totpToken.value, code).then(async data => {
    totpCode.value = ''
    totpError.value = ''
    if (data && data.token) {
      await saveToken(data.token, pendingAuthKeys.value)
      return
    }
    resetTotpStep()
    showAuthError(new Error(t('reqFailErrorMsg')))
  }).catch((e) => {
    // 400 错码：留在验证码页可重试（totpToken 仍有效），错误行常驻面板内；
    // 403 作废 / totpToken 过期：回密码登录，错误行随面板一起清掉。
    if (e && (e.code === 403 || (e.message && authErrorMap[e.message] === 'loginTotpExpired'))) {
      resetTotpStep()
    } else {
      totpCode.value = ''
      totpError.value = friendlyAuthError(e)
    }
    showAuthError(e)
  }).finally(() => {
    totpLoading.value = false
  })
}

function resetTotpStep() {
  totpStep.value = false
  totpToken.value = ''
  totpCode.value = ''
  totpError.value = ''
}

function backToPassword() {
  resetTotpStep()
}

async function saveToken(token, authKeys) {
  // 防御：绝不把 undefined / 空串写进 localStorage（旧 bug：TOTP 用户
  // data.token 为 undefined，存成字符串 "undefined" 后处处 401）。
  if (!token || token === 'undefined') {
    localStorage.removeItem('token')
    ElMessage({
      message: t('reqFailErrorMsg'),
      type: 'error',
      plain: true,
    })
    return
  }
  localStorage.setItem('token', token)
  // 2026-11-12 uwu 第 1 步：密码登录时把本次派生的盐存进内存（不写
  // localStorage），供改密/自删等需重新派生登录密钥的流程用；随后后台跑
  // E2EE 探针与胁迫 legacy 提示（不阻断进站）。口令原文用完即清。
  const keys = authKeys || null
  pendingAuthKeys.value = null
  if (keys && keys.salt) {
    setLoginSalt(keys.salt)
  }
  if (keys) {
    afterLoginChecks(keys)
  }
  refreshWebsiteConfig()
  // 登录提速：取用户信息与同步语言/壁纸偏好三者互不依赖，并行跑，
  // 不再一个等一个。语言/壁纸同步内部已 try/catch（失败返回 null），不会拖垮登录；
  // 只有 loginUserInfo 失败才会阻断登录。
  const [user] = await Promise.all([
    loginUserInfo(),
    // Phase 2 A 路补充：登录成功后同步语言偏好——后端有值则以其为准回写本地，
    // 后端为空则把本地 mail-locale 写到后端（best-effort，不阻断登录）。
    syncLocaleWithServer({ i18n, settingStore, getLocale, setLocale }),
    // Phase 7 壁纸：登录成功后同步壁纸偏好（同款机制）。
    syncWallpaperWithServer({ getWallpaper, setWallpaper, isDark: uiStore.dark }),
  ]);
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


async function submitRegister() {

  if (registerLoading.value) return

  if (!registerForm.email) {
    ElMessage({
      message: t('emptyEmailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

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

  // 与服务端注册底线同规则（服务端只剩上报的 pwdScore 可作底线，见
  // login-service.js）：0 分口令（<8 位且单一大小写、无数字、无符号）
  // 在提交前就拦住，别等服务端拒。
  if (passwordStrengthScore(registerForm.password) < 1) {
    ElMessage({
      message: t('pwdTooWeak'),
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
      ensureRegisterTurnstile()
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

  // 2026-11-12 uwu 第 1 步：注册时浏览器生成盐、派生登录密钥 + 邮件密钥，
  // 只发登录密钥 + 盐；密码原文不出浏览器。邮件密钥随 saveToken 解锁 E2EE。
  const passwordTrimmed = String(registerForm.password || '').trim()
  let registerAuthKeys = null
  let registerSalt = ''
  try {
    registerSalt = generateLoginSalt()
    registerAuthKeys = await deriveAuthKeys(passwordTrimmed, registerSalt)
  } catch (e) {
    registerLoading.value = false
    showAuthError(new Error(t('reqFailErrorMsg')))
    return
  }

  const form = {
    email,
    loginKey: registerAuthKeys.loginKey,
    salt: registerSalt,
    token: verifyToken,
    code: registerForm.code,
    pwdScore: passwordStrengthScore(passwordTrimmed)
  }

  // noMsg：拦截器不弹后端原文，由下面 catch 统一弹映射后的人话
  http.post('/register', form, {noMsg: true}).then(async ({regVerifyOpen, recoveryCodes, token}) => {
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
    // Phase 8 F：注册时生成的恢复码只显示这一次，立即弹框让用户保存；用户确认后再自动登录。
    if (Array.isArray(recoveryCodes) && recoveryCodes.length) {
      try {
        await ElMessageBox.alert(
          recoveryCodes.join('<br>') + '<br><br>' + t('recoveryShowOnce'),
          t('recoveryGenerateCodes'),
          { confirmButtonText: t('confirm'), dangerouslyUseHTMLString: true }
        )
      } catch (e) {
        // 用户关掉弹框也继续自动登录
      }
    }
    // 注册完成自动登录：后端已签发 token，直接进站，不用再输一次密码。
    // 无 token 或自动登录失败时回落到登录页（后端签发失败不阻断注册）。
    if (token) {
      try {
        await saveToken(token, { salt: registerSalt, loginKey: registerAuthKeys.loginKey, mailKey: registerAuthKeys.mailKey, password: passwordTrimmed })
      } catch (e) {
        console.error('注册后自动登录失败，回落到登录页:', e)
        show.value = 'login'
      }
    } else {
      show.value = 'login'
    }
  }).catch(res => {

    registerLoading.value = false
    showAuthError(res)

    if (res.code === 400) {
      verifyToken = ''
      settingStore.settings.regVerifyOpen = true
      ensureRegisterTurnstile()
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

/* Phase 8 G：登录面板居中（水平 + 垂直居中，卡片最大宽度 432px） */
.form-wrapper {
  position: fixed;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px 16px;
  box-sizing: border-box;
}

.container {
  background: v-bind(loginOpacity);
  /* Phase 2 A 路补充：玻璃拟态——磨砂面板 + 柔和描边 + 大阴影 */
  backdrop-filter: blur(18px) saturate(1.3);
  -webkit-backdrop-filter: blur(18px) saturate(1.3);
  border: 1px solid rgba(255, 255, 255, .65);
  box-shadow: 0 24px 60px rgba(37, 99, 235, .18);
  padding: 32px 36px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  width: 100%;
  max-width: 432px;
  height: auto;
  max-height: calc(100vh - 40px);
  overflow-y: auto;
  border-radius: 16px;
  border: 1px solid var(--login-border);
  box-shadow: var(--el-box-shadow-light);
  @media (max-width: 767px) {
    padding: 24px 20px;
    max-height: calc(100vh - 24px);
    border-radius: 12px;
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
    font-size: 30px !important;
    /* Phase 2 A 路补充：标题蓝紫渐变字 */
    background: linear-gradient(90deg, #1d4ed8, #7c3aed);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    width: fit-content;
  }

  /* 任务 4：非汉字品牌标题用展示字体（Bebas Neue / Montserrat），够大够粗。 */
  .form-title.title-display {
    font-family: var(--font-display);
    letter-spacing: .02em;
  }

  /* Phase 2 A 路补充：品牌徽章（内联 SVG 信封） */
  .brand-badge {
    display: inline-flex;
    width: fit-content;
    margin-bottom: 12px;
    filter: drop-shadow(0 8px 16px rgba(79, 70, 229, .35));
  }

  /* Phase 8 斯诺登元素补齐：顶部隐私承诺徽章行——锁图标 + 三项承诺，小字克制 */
  .privacy-badges {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    width: fit-content;
    margin-bottom: 14px;
    padding: 5px 10px;
    border-radius: 999px;
    border: 1px solid var(--el-border-color-lighter);
    background: var(--el-fill-color-lighter);
    font-size: 11px;
    letter-spacing: .04em;
    color: var(--form-desc-color);

    .privacy-lock {
      flex: none;
      color: var(--el-color-primary);
    }
  }

  /* Phase 8 G：顶部隐私愿景行——小字大写字母间距，克制不抢眼 */
  .privacy-vision {
    font-size: 11px;
    letter-spacing: .18em;
    text-transform: uppercase;
    color: var(--form-desc-color);
    margin-bottom: 14px;
  }

  /* Phase 8 G：底部斯诺登名言——卡片内底部分隔线之上，居中，克制 */
  .login-quote {
    margin: 22px 0 0;
    padding-top: 18px;
    border-top: 1px solid var(--el-border-color-lighter);
    text-align: center;

    blockquote {
      margin: 0 0 8px;
      font-size: 13px;
      line-height: 1.6;
      font-style: italic;
      color: var(--el-text-color-primary);
    }

    figcaption {
      font-size: 12px;
      line-height: 1.6;
      color: var(--form-desc-color);
    }

    .login-quote-by {
      margin-top: 6px;
      font-size: 11px;
      letter-spacing: .08em;
      color: var(--form-desc-color);
    }
  }

  /* Phase 8 斯诺登元素补齐：底部名言轮换淡入淡出（与开场动画 quote-fade 同参数） */
  .login-quote-fade-enter-active, .login-quote-fade-leave-active { transition: opacity .6s ease, transform .6s ease; }
  .login-quote-fade-enter-from { opacity: 0; transform: translateY(8px); }
  .login-quote-fade-leave-to { opacity: 0; transform: translateY(-8px); }

  .switch {
    margin-top: 20px;
    text-align: center;

    span {
      color: var(--login-switch-color);
      cursor: pointer;
    }
  }

  /* 开场动画重播入口：小字居中链接，与切换注册/登录同一视觉层级 */
  .intro-replay {
    margin-top: 12px;
    text-align: center;
    font-size: 13px;
    color: var(--login-switch-color);
    cursor: pointer;
  }

  /* 忘记密码入口：登录按钮正下方的次要按钮——满宽浅底描边 + 加粗大字 + 钥匙图标，一眼可见 */
  .forgot {
    margin-top: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 11px 12px;
    border-radius: 10px;
    border: 1px solid var(--el-border-color);
    background: var(--el-fill-color-lighter);
    font-size: 15px;
    font-weight: 600;
    color: var(--el-color-primary);
    cursor: pointer;
    transition: filter .2s, border-color .2s;

    &:hover, &:focus-visible {
      filter: brightness(1.05);
      border-color: var(--el-color-primary);
      outline: none;
    }

    svg {
      flex: none;
    }
  }

  /* Phase 6 TOTP 第二步：标题 + 提示 + 返回密码登录链接。 */
  .totp-step-title {
    margin: 0 0 8px;
    font-size: 17px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  .totp-step-hint {
    margin: 0 0 18px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--form-desc-color);
  }

  .totp-back {
    margin-top: 16px;
    text-align: center;
    font-size: 13px;
    color: var(--login-switch-color);
    cursor: pointer;
  }

  /* TOTP 错码常驻提示：夹在输入框与提交按钮之间，面板内正常流，不会被遮住。 */
  .totp-error {
    margin: 12px 0 0;
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
  /* 任务 1：改为 fixed 脱离 #login-box 网格流（否则分栏时会占一格），视觉位置不变。 */
  position: fixed;
  inset: 0;
  height: 100%;
  z-index: 0;
}

/* 任务 1：自定义背景层同样 fixed，不占网格位置。 */
.login-custom-bg {
  position: fixed;
  inset: 0;
  z-index: 0;
}

/* 无壁纸时的单层全屏远景（与 body::before 同款慢运镜，见 style.css 的 wallpaper-kenburns；
   桌面端与手机端同样 fixed 全屏）。 */
.login-vista-fallback {
  position: fixed;
  inset: 0;
  z-index: 0;
  background: center / cover no-repeat;
  animation: wallpaper-kenburns 45s ease-in-out infinite alternate;
  pointer-events: none;
}

/* 注册页：斯诺登远景动态背景（随机一张 + 无限缓慢运镜，来回呼吸式推近拉远）。 */
.register-vista {
  position: fixed;
  inset: -4%;
  z-index: 0;
  background: center / cover no-repeat;
  animation: register-kenburns 28s ease-in-out infinite alternate;
}
.register-shade {
  position: fixed;
  inset: 0;
  z-index: 1;
  background: linear-gradient(180deg, rgba(5, 8, 20, 0.35) 0%, rgba(5, 8, 20, 0.10) 40%, rgba(5, 8, 20, 0.55) 100%);
  pointer-events: none;
}
@keyframes register-kenburns {
  0% { transform: scale(1.02) translate(0, 0); }
  100% { transform: scale(1.14) translate(-1.8%, -2%); }
}
@media (prefers-reduced-motion: reduce) {
  .register-vista {
    animation: none;
  }
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
  /* Phase 8 G：移动端同样居中，留白收窄 */
  .form-wrapper {
    padding: 12px;
  }

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

/* 任务 1：左侧斯诺登开场大区（默认隐藏，桌面端分栏时显示）。
   注意：这里不再自己铺背景图（旧 .showcase-vista 已删）——背景只有一层全屏图，
   本区背景透明，透出壁纸系统的 body::before；否则两边裁剪不同必出竖缝。 */
.login-showcase {
  display: none;
  position: relative;
  overflow: hidden;
  min-height: 0;
  background: transparent;
  color: #fff;
}

.showcase-shade {
  /* 单层背景的统一遮罩：fixed 全屏，纵向渐变、无横向边缘，任何宽度都不会出现竖缝；
     与 body::before 的 0.3 遮罩叠加，保证左侧白字在任何壁纸上都可读。
     只在登录态渲染（注册态由 .register-shade 负责）。 */
  position: fixed;
  inset: 0;
  z-index: 0;
  background: linear-gradient(180deg, rgba(5, 8, 20, .45) 0%, rgba(5, 8, 20, .12) 45%, rgba(5, 8, 20, .72) 100%);
  pointer-events: none;
}

.showcase-content {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  text-align: center;
  gap: 16px;
  height: 100%;
  max-width: 620px;
  padding: 48px;
  box-sizing: border-box;
}

.showcase-badge {
  display: inline-flex;
  width: fit-content;
  filter: drop-shadow(0 8px 20px rgba(0, 0, 0, .45));
}

.showcase-title {
  margin: 0;
  font-size: clamp(42px, 5.5vw, 68px);
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: .01em;
  text-shadow: 0 2px 28px rgba(0, 0, 0, .55);
}

/* 任务 4：非汉字品牌标题用展示字体。 */
.showcase-title.title-display {
  font-family: var(--font-display);
  letter-spacing: .04em;
}

.showcase-vision {
  margin: 0;
  font-size: 11px;
  letter-spacing: .22em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, .78);
}

.showcase-quote {
  margin: 8px 0 0;
}

.showcase-quote blockquote {
  margin: 0 0 10px;
  font-size: clamp(17px, 1.6vw, 22px);
  font-style: italic;
  line-height: 1.65;
  color: rgba(255, 255, 255, .94);
  text-shadow: 0 1px 14px rgba(0, 0, 0, .5);
}

.showcase-quote figcaption {
  font-size: 13px;
  color: rgba(255, 255, 255, .8);
}

.showcase-quote-by {
  margin-top: 10px;
  font-size: 12px;
  letter-spacing: .12em;
  color: rgba(255, 255, 255, .6);
}

@media (prefers-reduced-motion: reduce) {
  .login-vista-fallback {
    animation: none;
  }
}

/* 任务 1 分栏布局（桌面端 ≥768px）：#login-box 两栏——左侧斯诺登开场大区，右侧表单栏。
   背景层（#background-wrap / .login-custom-bg / .login-vista-fallback / .register-vista /
   .showcase-shade）均为 fixed，不占网格位置；网格内只有 .login-showcase 与 .form-wrapper 两个子项。 */
@media (min-width: 768px) {
  #login-box {
    grid-template-columns: minmax(0, 1fr) 480px;
  }

  .login-showcase {
    display: flex;
  }

  .form-wrapper {
    position: relative;
    inset: auto;
  }

  /* 名言已搬到左侧大区，卡片内的不再重复显示。 */
  .container .login-quote {
    display: none;
  }
}

</style>
