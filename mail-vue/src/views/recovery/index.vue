<!-- Phase 8 F：忘记密码 / 账号恢复页（公开页，不走 layout）。
  两种方式：① 恢复码重设密码；② 备用邮箱收恢复链接（链接带一次性 token，
  1 小时有效）。新密码用本地密码强度计（PasswordStrengthMeter）当场校验，
  弱密码拦住。路由 /recovery（注册行见汇报，由总协调加进 router/index.js）。
  登录页的“忘记密码”入口由 G 在 login/index.vue 里加一行跳 /recovery。 -->
<template>
  <div class="recovery-page">
    <div class="recovery-card">
      <div class="title">{{ $t('recoveryTitle') }}</div>
      <div class="desc">{{ $t('recoveryDesc') }}</div>
      <!-- 两条路一眼看清：① 恢复码 ② 备用邮箱链接 -->
      <div class="paths-hint">
        <div class="paths-hint-item"><span class="paths-num">1</span><span>{{ $t('recoveryPathsHintCode') }}</span></div>
        <div class="paths-hint-item"><span class="paths-num">2</span><span>{{ $t('recoveryPathsHintEmail') }}</span></div>
      </div>
      <el-tabs v-model="mode">
        <el-tab-pane :label="$t('recoveryByCode')" name="code">
          <el-form label-position="top" @submit.prevent>
            <el-form-item :label="$t('email')">
              <el-input v-model="form.email" autocomplete="off" />
            </el-form-item>
            <el-form-item :label="$t('recoveryCode')">
              <el-input v-model="form.code" placeholder="XXXX-XXXX-XXXX" autocomplete="off" />
            </el-form-item>
            <el-form-item :label="$t('newPassword')">
              <el-input v-model="form.newPassword" type="password" autocomplete="off" show-password />
              <PasswordStrengthMeter :password="form.newPassword" />
            </el-form-item>
            <el-form-item :label="$t('confirmPassword')">
              <el-input v-model="form.confirmPassword" type="password" autocomplete="off" show-password />
            </el-form-item>
            <el-button type="primary" :loading="loading" :disabled="!canSubmit" style="width: 100%" @click="onResetByCode">
              {{ $t('recoveryResetPassword') }}
            </el-button>
          </el-form>
        </el-tab-pane>
        <el-tab-pane :label="$t('recoveryByEmail')" name="link">
          <el-form label-position="top" @submit.prevent>
            <el-form-item :label="$t('email')">
              <el-input v-model="form.email" autocomplete="off" />
            </el-form-item>
            <el-button type="primary" :loading="loading" style="width: 100%" @click="onRequestLink">
              {{ $t('recoverySendLink') }}
            </el-button>
            <div v-if="linkSent" class="desc" style="margin-top: 12px">{{ $t('recoveryLinkSent') }}</div>
          </el-form>
          <el-divider>{{ $t('recoveryHaveLink') }}</el-divider>
          <el-form label-position="top" @submit.prevent>
            <el-form-item :label="$t('recoveryToken')">
              <el-input v-model="form.token" autocomplete="off" />
            </el-form-item>
            <el-form-item :label="$t('newPassword')">
              <el-input v-model="form.newPassword" type="password" autocomplete="off" show-password />
              <PasswordStrengthMeter :password="form.newPassword" />
            </el-form-item>
            <el-form-item :label="$t('confirmPassword')">
              <el-input v-model="form.confirmPassword" type="password" autocomplete="off" show-password />
            </el-form-item>
            <el-button type="primary" :loading="loading" :disabled="!canSubmitToken" style="width: 100%" @click="onResetByToken">
              {{ $t('recoveryResetPassword') }}
            </el-button>
          </el-form>
        </el-tab-pane>
      </el-tabs>
      <!-- 没备用邮箱、恢复码也丢了：系统发不出重置链接，只能找管理员（后端防枚举口径不动：无备用邮箱时请求链接仍返回成功）。 -->
      <div class="no-reset-hint">
        <span>{{ $t('recoveryNoResetHint') }}</span>
        <a href="mailto:admin@aevorynthtech.com">admin@aevorynthtech.com</a>
      </div>
      <div class="row" style="margin-top: 16px">
        <el-button link @click="goLogin">{{ $t('recoveryBackToLogin') }}</el-button>
      </div>
    </div>
  </div>
</template>
<script setup>
import { ref, reactive, computed, defineOptions, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import PasswordStrengthMeter from '@/components/password-strength/index.vue'
import { evaluatePasswordStrength } from '@/utils/password-strength.js'
import { resetByCode, requestResetLink, resetByToken } from '@/request/recovery.js'

defineOptions({
  name: 'recovery'
})

const route = useRoute()
const router = useRouter()
const mode = ref('code')
const loading = ref(false)
const linkSent = ref(false)
const form = reactive({ email: '', code: '', token: '', newPassword: '', confirmPassword: '' })

const canSubmit = computed(() =>
  !!form.email && !!form.code && evaluatePasswordStrength(form.newPassword).passed &&
  form.newPassword === form.confirmPassword)
const canSubmitToken = computed(() =>
  !!form.email && !!form.token && evaluatePasswordStrength(form.newPassword).passed &&
  form.newPassword === form.confirmPassword)

async function onResetByCode() {
  loading.value = true
  try {
    await resetByCode(form.email, form.code, form.newPassword)
    ElMessage({ message: 'OK', type: 'success', plain: true })
    router.push('/login')
  } finally {
    loading.value = false
  }
}

async function onRequestLink() {
  loading.value = true
  try {
    await requestResetLink(form.email)
    linkSent.value = true
  } finally {
    loading.value = false
  }
}

async function onResetByToken() {
  loading.value = true
  try {
    await resetByToken(form.email, form.token, form.newPassword)
    ElMessage({ message: 'OK', type: 'success', plain: true })
    router.push('/login')
  } finally {
    loading.value = false
  }
}

function goLogin() {
  router.push('/login')
}

onMounted(() => {
  if (route.query.email) form.email = String(route.query.email)
  if (route.query.token) {
    form.token = String(route.query.token)
    mode.value = 'link'
  }
})
</script>
<style scoped>
.recovery-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.recovery-card {
  width: 100%;
  max-width: 440px;
}
.title {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 8px;
}
.desc {
  font-size: 13px;
  color: #909399;
  margin-bottom: 16px;
}
/* 两条找回路一览：编号圆点 + 一行说明，放在标签页上方 */
.paths-hint {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 18px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  background: var(--el-fill-color-lighter, #f4f4f5);
}
.paths-hint-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-primary, #303133);
}
.paths-num {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: linear-gradient(135deg, #2563eb, #7c3aed);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  line-height: 20px;
  text-align: center;
}
/* 找不回时的提示：琥珀色警告条，管理员邮箱可点 */
.no-reset-hint {
  margin-top: 18px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid #f5dab1;
  background: #fdf6ec;
  font-size: 13px;
  line-height: 1.7;
  color: #a16207;
}
.no-reset-hint a {
  color: var(--el-color-primary, #409eff);
  font-weight: 600;
  text-decoration: none;
}
.no-reset-hint a:hover {
  text-decoration: underline;
}
.row {
  display: flex;
  justify-content: center;
}
</style>
