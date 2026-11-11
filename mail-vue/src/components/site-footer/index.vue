<!-- Phase 8 斯诺登元素补齐：全站页脚——隐私承诺 + 斯诺登致敬，链接到隐私仪表盘。 -->
<template>
  <footer class="site-footer">
    <svg class="footer-lock" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
    <span>{{ $t('footerBuiltForPrivacy') }} — {{ $t('footerInspiredBy') }}</span>
    <span class="footer-sep">·</span>
    <a class="footer-link" @click="goPrivacy">{{ $t('privacyDashboard') }}</a>
  </footer>
</template>

<script setup>
import router from '@/router/index.js'

function goPrivacy() {
  router.push({ name: 'privacy' })
}
</script>

<style scoped>
.site-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 14px 16px 18px;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
}
.footer-lock {
  flex: none;
  color: var(--el-color-primary);
}
.footer-sep {
  color: var(--el-border-color);
}
.footer-link {
  color: var(--el-color-primary);
  cursor: pointer;
}
.footer-link:hover {
  text-decoration: underline;
}
</style>
