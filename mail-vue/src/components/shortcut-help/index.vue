<template>
  <el-dialog
    :model-value="modelValue"
    :title="$t('shortcutHelpTitle')"
    width="480"
    @update:model-value="$emit('update:modelValue', $event)"
    @close="$emit('update:modelValue', false)"
  >
    <div class="shortcut-help">
      <p class="shortcut-help-desc">{{ $t('shortcutHelpDesc') }}</p>
      <div class="shortcut-row" v-for="item in SHORTCUT_MAP" :key="item.id">
        <kbd class="shortcut-key">{{ item.key }}</kbd>
        <span>{{ $t(item.labelKey) }}</span>
      </div>
    </div>
    <template #footer>
      <el-button type="primary" @click="$emit('update:modelValue', false)">
        {{ $t('confirm') }}
      </el-button>
    </template>
  </el-dialog>
</template>
<script setup>
import { ElDialog, ElButton } from 'element-plus';
import { SHORTCUT_MAP } from '@/utils/shortcuts.js';

defineProps({
  modelValue: { type: Boolean, default: false }
});
defineEmits(['update:modelValue']);
</script>
<style scoped>
.shortcut-help {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.shortcut-help-desc {
  margin: 0 0 12px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.shortcut-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 6px 0;
  font-size: 14px;
}
.shortcut-key {
  min-width: 28px;
  padding: 3px 8px;
  border: 1px solid var(--el-border-color);
  border-bottom-width: 2px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  font-family: inherit;
  font-size: 13px;
  text-align: center;
}
</style>
