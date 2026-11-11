<template>
  <!-- 斯诺登第四批 P0-1：EXIF 剥离可见说明（写信页附件区用）。
       用法（layout/write/index.vue 附件列表处，补丁见报告）：
         <ExifStripNotice :stripped="att.exifStripped" :removed="att.exifRemoved" />
       附件对象需带 exifStripped / exifRemoved 两个字段（stripExifFromFile 的返回值）。
       stripped=false 时不渲染任何内容，不打扰用户。 -->
  <div v-if="stripped" class="exif-strip-notice">
    <span class="exif-strip-icon">🛡️</span>
    <span class="exif-strip-text">{{ t('burn4ExifStripped') }}</span>
    <span v-if="removed && removed.length" class="exif-strip-detail" :title="removed.join(', ')">
      {{ t('burn4ExifStrippedDetail') }}
    </span>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

defineProps({
  stripped: { type: Boolean, default: false },
  removed: { type: Array, default: () => [] },
})
</script>

<style scoped>
.exif-strip-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 12px;
  color: #67c23a;
}
.exif-strip-detail {
  color: #909399;
}
</style>
