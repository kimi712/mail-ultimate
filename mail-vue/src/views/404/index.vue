<template>
<div class="box-404">
  <el-empty :image-size="isPhone ? 120 : 0" class="empty" :description="$t('error404')" >
    <el-button  type="primary" @click="router.replace({name: 'layout'})">{{$t('home')}}</el-button>
  </el-empty>
  <!-- Phase 8 斯诺登元素补齐：404 页名言（核实过的第二句，小字翻译走 i18n intro.quote2）。 -->
  <div class="quote-404">“{{ $t('intro.quote2') }}” — Edward Snowden</div>
</div>
</template>

<script lang="js" setup>
import router from "@/router/index.js";

let isPhone = window.innerWidth < 1025
</script>

<style scoped lang="scss">
.box-404 {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}
/* Phase 8 斯诺登元素补齐：404 页名言——小字斜体，克制 */
.quote-404 {
  margin-top: 8px;
  max-width: 420px;
  padding: 0 20px;
  text-align: center;
  font-size: 12px;
  font-style: italic;
  line-height: 1.6;
  color: var(--el-text-color-placeholder);
}
</style>