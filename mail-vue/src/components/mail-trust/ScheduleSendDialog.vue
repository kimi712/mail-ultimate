<template>
  <!-- Phase 8 E：定时发送对话框（总协调挂载进 views/send/index.vue 写信工具栏：
       “定时发送”按钮打开本弹窗，确认后把 scheduledAt 随发送表单一起发到
       /email/send；服务端只入库，到点才真正发）。 -->
  <el-dialog
    :model-value="modelValue"
    :title="$t('trust.scheduleSend')"
    width="420px"
    @update:model-value="emit('update:modelValue', $event)"
    @close="emit('cancel')"
  >
    <el-date-picker
      v-model="picked"
      type="datetime"
      :placeholder="$t('trust.schedulePickTime')"
      :disabled-date="disablePast"
      format="YYYY-MM-DD HH:mm"
      value-format="YYYY-MM-DD HH:mm:ss"
      style="width: 100%"
    />
    <div class="schedule-note">{{ $t('trust.scheduleNote') }}</div>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">{{ $t('cancel') }}</el-button>
      <el-button type="primary" :disabled="!picked" @click="confirm">{{ $t('confirm') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref } from 'vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue', 'confirm', 'cancel'])

const picked = ref('')

function disablePast(date) {
  return date.getTime() < Date.now() - 60 * 1000
}

function confirm() {
  if (!picked.value) return
  emit('confirm', picked.value)
  emit('update:modelValue', false)
}
</script>

<style scoped>
.schedule-note {
  margin-top: 10px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--secondary-text-color);
}
</style>
