<template>
  <!-- 新邮件通知：右下角弹出卡片（仿系统通知形式），斯诺登主题个性化：深蓝底 + 金色描边，3 秒自动关闭 -->
  <div class="mail-notify-wrap" v-if="mailNotifies.length > 0">
    <transition-group name="mail-notify-slide" tag="div" class="mail-notify-stack">
      <div
        v-for="n in mailNotifies"
        :key="n.id"
        class="mail-notify-card"
        @click="openMail(n)"
      >
        <div class="mail-notify-head">
          <span class="mail-notify-app">
            <span class="mail-notify-icon">🔒</span>
            <span class="mail-notify-appname">{{ $t('notifyNewMail') }}</span>
          </span>
          <span class="mail-notify-time">{{ $t('notifyNow') }}</span>
          <button class="mail-notify-x" @click.stop="dismissNotify(n.id)">✕</button>
        </div>
        <div class="mail-notify-title">{{ n.title }}</div>
        <div class="mail-notify-subject">{{ n.subject }}</div>
        <div class="mail-notify-preview" v-if="n.preview">{{ n.preview }}</div>
        <div class="mail-notify-count" v-if="n.count > 1">{{ $t('notifyMultiCount', { count: n.count }) }}</div>
        <div class="mail-notify-bar"><span class="mail-notify-bar-fill" /></div>
      </div>
    </transition-group>
  </div>
</template>

<script setup>
import { mailNotifies, dismissNotify } from '@/utils/mail-notify.js';

function openMail(n) {
  dismissNotify(n.id);
  if (n.onOpen) {
    // 单封直接打开该封；多封打开第一封（最新一封）
    n.onOpen(n.emails[0]);
  }
}
</script>

<style scoped>
/* 右下角弹出：仿系统通知形式，斯诺登主题深蓝底 + 金色描边 */
.mail-notify-wrap {
  position: fixed;
  right: 20px;
  bottom: 20px;
  /* 须低于写信窗口遮罩（z 2000）：写信打开时新邮件通知不得浮在模态窗口之上
     盖住底部的有效期/发送控件；平时仍高于页面内容（顶栏 100、搜索下拉 1001）。 */
  z-index: 1999;
  pointer-events: none;
}
.mail-notify-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: flex-end;
}
.mail-notify-card {
  pointer-events: auto;
  width: 400px;
  max-width: calc(100vw - 40px);
  background: #0b1e3a;
  border: 1px solid rgba(251, 191, 36, 0.4);
  border-left: 4px solid #fbbf24;
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(2, 6, 23, 0.55);
  padding: 14px 16px 12px;
  cursor: pointer;
  color: #f1f5f9;
  overflow: hidden;
  position: relative;
}
.mail-notify-card:hover {
  background: #12294d;
}
.mail-notify-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.mail-notify-app {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: #fbbf24;
  letter-spacing: 0.04em;
}
.mail-notify-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: #fbbf24;
  color: #0b1e3a;
  font-size: 13px;
}
.mail-notify-time {
  margin-left: auto;
  font-size: 12px;
  color: #94a3b8;
}
.mail-notify-x {
  border: none;
  background: transparent;
  color: #94a3b8;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
}
.mail-notify-x:hover {
  background: rgba(148, 163, 184, 0.2);
  color: #fff;
}
.mail-notify-title {
  font-size: 16px;
  font-weight: 800;
  color: #ffffff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mail-notify-subject {
  font-size: 14px;
  font-weight: 600;
  color: #e2e8f0;
  margin-top: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mail-notify-preview {
  font-size: 13px;
  color: #94a3b8;
  margin-top: 4px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.mail-notify-count {
  font-size: 12px;
  color: #fbbf24;
  margin-top: 6px;
  font-weight: 600;
}
/* 底部 3 秒倒计时条（金色） */
.mail-notify-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(251, 191, 36, 0.25);
}
.mail-notify-bar-fill {
  display: block;
  height: 100%;
  background: #fbbf24;
  animation: mail-notify-countdown 3s linear forwards;
}
@keyframes mail-notify-countdown {
  from { width: 100%; }
  to { width: 0%; }
}
/* 下方滑入 / 滑出 */
.mail-notify-slide-enter-active {
  transition: all 0.28s ease-out;
}
.mail-notify-slide-leave-active {
  transition: all 0.22s ease-in;
}
.mail-notify-slide-enter-from {
  opacity: 0;
  transform: translateY(20px);
}
.mail-notify-slide-leave-to {
  opacity: 0;
  transform: translateY(20px);
}
</style>
