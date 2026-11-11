<template>
  <!-- Phase 8：AI 助手常驻面板（多轮对话 + 剩余次数 + 一键清空历史）。
       由顶栏入口打开；aiEnabled 为 0 时入口隐藏（见 layout/header）。
       新文案 key 见子代理 C 汇报 i18n 清单（ai.assistant*），由总协调合并。 -->
  <el-dialog v-model="visible" :title="t('ai.assistantTitle')" width="520px" class="ai-assistant-dialog" @open="loadHistory" @closed="onClosed">
    <div class="ai-assistant-body">
      <div class="ai-assistant-meta">
        <span v-if="remaining !== null" class="ai-assistant-remaining">{{ $t('ai.remaining', {count: remaining}) }}</span>
        <span class="ai-assistant-privacy">{{ $t('ai.assistantPrivacy') }}</span>
        <el-button size="small" type="danger" plain :disabled="clearing || messages.length === 0" :loading="clearing" @click="clearHistory">{{ $t('ai.assistantClear') }}</el-button>
      </div>
      <!-- 快捷提问：从读信页打开时才有 emailId，问题带当前邮件上下文。 -->
      <div v-if="props.emailId" class="ai-assistant-chips">
        <el-button size="small" round :disabled="sending" @click="quickAsk('summarize')">{{ $t('ai.assistantChipSummarize') }}</el-button>
        <el-button size="small" round :disabled="sending" @click="quickAsk('reply')">{{ $t('ai.assistantChipReply') }}</el-button>
        <el-button size="small" round :disabled="sending" @click="quickAsk('translate')">{{ $t('ai.assistantChipTranslate') }}</el-button>
      </div>
      <el-scrollbar ref="scrollRef" class="ai-assistant-scroll" max-height="420px">
        <div v-if="messages.length === 0 && !loading" class="ai-assistant-empty">{{ $t('ai.assistantEmpty') }}</div>
        <div v-for="(msg, idx) in messages" :key="idx" class="ai-assistant-msg" :class="'ai-assistant-msg-' + msg.role">
          <div class="ai-assistant-role">{{ msg.role === 'user' ? $t('ai.assistantYou') : $t('ai.assistantTitle') }}</div>
          <pre class="ai-assistant-text">{{ msg.content }}</pre>
        </div>
        <div v-if="sending" class="ai-assistant-msg ai-assistant-msg-assistant">
          <div class="ai-assistant-role">{{ $t('ai.assistantTitle') }}</div>
          <div class="ai-assistant-text">{{ $t('ai.generating') }}</div>
        </div>
      </el-scrollbar>
      <div class="ai-assistant-input-row">
        <el-input v-model="input" type="textarea" :rows="2" maxlength="2000" show-word-limit :placeholder="t('ai.assistantPlaceholder')" @keyup.enter.exact.prevent="send" />
        <el-button type="primary" :loading="sending" :disabled="sending || !input.trim()" @click="send">{{ $t('ai.assistantSend') }}</el-button>
      </div>
    </div>
  </el-dialog>
</template>
<script setup>
import {ref, nextTick} from "vue";
import {useI18n} from "vue-i18n";
import {ElMessage} from "element-plus";
import {aiChat, aiChatHistory, aiClearChat, aiErrorI18nKey} from "@/request/ai.js";

const {t} = useI18n();
const visible = defineModel({type: Boolean, default: false});
// 当前邮件上下文（读信页打开时传入 emailId，助手可结合该邮件回答；不传则纯对话）。
const props = defineProps({
  emailId: {type: Number, default: null}
});

const messages = ref([]); // {role: 'user'|'assistant', content}
const input = ref('');
const sending = ref(false);
const loading = ref(false);
const clearing = ref(false);
const remaining = ref(null);
const scrollRef = ref(null);

function scrollToBottom() {
  nextTick(() => {
    const wrap = scrollRef.value?.$el?.querySelector?.('.el-scrollbar__wrap');
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  });
}

async function loadHistory() {
  loading.value = true;
  try {
    const data = await aiChatHistory();
    messages.value = (data.messages || []).map(m => ({role: m.role, content: m.content}));
    scrollToBottom();
  } catch (e) {
    ElMessage({message: t(aiErrorI18nKey(e && e.code)), type: 'error', plain: true});
  } finally {
    loading.value = false;
  }
}

async function send() {
  const text = input.value.trim();
  if (!text || sending.value) return;
  sending.value = true;
  messages.value.push({role: 'user', content: text});
  input.value = '';
  scrollToBottom();
  try {
    const data = await aiChat({message: text, emailId: props.emailId || undefined});
    messages.value.push({role: 'assistant', content: data.reply || ''});
    if (typeof data.remaining === 'number') remaining.value = data.remaining;
  } catch (e) {
    ElMessage({message: t(aiErrorI18nKey(e && e.code)), type: 'error', plain: true});
  } finally {
    sending.value = false;
    scrollToBottom();
  }
}

// 快捷提问：把预设问题填入输入框后走同一 send()，emailId 上下文由后端接上。
const QUICK_PROMPTS = {
  summarize: 'ai.assistantPromptSummarize',
  reply: 'ai.assistantPromptReply',
  translate: 'ai.assistantPromptTranslate',
}
function quickAsk(kind) {
  if (sending.value) return
  input.value = t(QUICK_PROMPTS[kind])
  send()
}

async function clearHistory() {
  clearing.value = true;
  try {
    await aiClearChat();
    messages.value = [];
  } catch (e) {
    ElMessage({message: t(aiErrorI18nKey(e && e.code)), type: 'error', plain: true});
  } finally {
    clearing.value = false;
  }
}

function onClosed() {
  input.value = '';
  sending.value = false;
}
</script>
<style scoped>
.ai-assistant-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.ai-assistant-remaining {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.ai-assistant-privacy {
  flex: 1;
  color: var(--el-text-color-placeholder);
  font-size: 12px;
}
.ai-assistant-chips {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.ai-assistant-scroll {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 10px;
  margin-bottom: 10px;
}
.ai-assistant-empty {
  color: var(--el-text-color-placeholder);
  font-size: 13px;
  text-align: center;
  padding: 24px 0;
}
.ai-assistant-msg {
  margin-bottom: 12px;
}
.ai-assistant-msg-user {
  text-align: right;
}
.ai-assistant-msg-user .ai-assistant-text {
  background: var(--el-color-primary-light-9);
  display: inline-block;
  text-align: left;
}
.ai-assistant-role {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 4px;
}
.ai-assistant-text {
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  padding: 8px 10px;
}
.ai-assistant-input-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.ai-assistant-input-row .el-textarea {
  flex: 1;
}
</style>
