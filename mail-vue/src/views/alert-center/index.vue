<template>
  <div class="alert-center-box">
    <div class="header-actions">
      <el-select v-model="params.type" class="status-select" style="width: 140px" @change="search">
        <el-option :label="$t('all')" value=""/>
        <el-option v-for="item in alertTypes" :key="item" :label="item" :value="item"/>
      </el-select>
      <Icon class="icon" icon="ion:reload" width="18" height="18" @click="refresh"/>
    </div>
    <el-scrollbar class="scrollbar">
      <div class="loading" :class="tableLoading ? 'loading-show' : 'loading-hide'">
        <loading/>
      </div>
      <el-table :data="alerts" style="width: 100%" v-loading="tableLoading"
                element-loading-background="transparent">
        <el-table-column :label="$t('type')" width="110">
          <template #default="props">
            <el-tag :type="tagType(props.row.type)">{{ props.row.type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="text" :label="$t('alertText')" min-width="300" show-overflow-tooltip/>
        <el-table-column prop="source" :label="$t('source')" width="110"/>
        <el-table-column :label="$t('date')" min-width="170">
          <template #default="props">
            <span :title="formatFullWithTimeZone(props.row.createTime)">{{ formatDateTime(props.row.createTime) }}</span>
          </template>
        </el-table-column>
      </el-table>
      <div class="pagination" v-if="total > 10">
        <el-pagination
            :current-page="params.num"
            :page-size="params.size"
            background
            layout="prev, pager, next, sizes, total"
            :total="total"
            @size-change="sizeChange"
            @current-change="numChange"
        />
      </div>
    </el-scrollbar>
  </div>
</template>

<script setup>
import {defineOptions, reactive, ref} from 'vue'
import {alertLogList} from '@/request/alert-center.js'
import {Icon} from "@iconify/vue";
import loading from "@/components/loading/index.vue";
import { formatDateTime, formatFullWithTimeZone } from "@/utils/datetime.js";

defineOptions({
  name: 'alert-center'
})

// 告警类型与后端 alert-log-service 约定一致：circuit | quota | reg-key | patrol | waf | system
const alertTypes = ['circuit', 'quota', 'reg-key', 'patrol', 'waf', 'system']
const alerts = ref([])
const total = ref(0)
const tableLoading = ref(true)

const params = reactive({
  type: '',
  num: 1,
  size: 15
})

getList()

function tagType(type) {
  if (type === 'circuit' || type === 'quota') return 'danger'
  if (type === 'reg-key' || type === 'waf') return 'warning'
  return 'info'
}

function getList() {
  tableLoading.value = true
  alertLogList(params).then(data => {
    alerts.value = data.list
    total.value = data.total
  }).finally(() => {
    tableLoading.value = false
  })
}

function search() {
  params.num = 1
  getList()
}

function refresh() {
  params.type = ''
  params.num = 1
  getList()
}

function numChange(num) {
  params.num = num
  getList()
}

function sizeChange(size) {
  params.size = size
  getList()
}
</script>

<style lang="scss" scoped>
.alert-center-box {
  overflow: hidden;
  height: 100%;
}

.header-actions {
  padding: 9px 15px;
  display: flex;
  gap: 15px;
  flex-wrap: wrap;
  align-items: center;
  box-shadow: var(--header-actions-border);
  font-size: 18px;

  .icon {
    cursor: pointer;
  }
}

.scrollbar {
  width: 100%;
  overflow: auto;
  height: calc(100% - 50px);
}

.pagination {
  margin-top: 15px;
  margin-bottom: 20px;
  padding-right: 30px;
  width: 100%;
  display: flex;
  justify-content: end;

  .el-pagination {
    align-self: end;
  }
}

.loading {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--loadding-background);
  left: 0;
  z-index: 2;
  top: 0;
  width: 100%;
  height: 100%;
}

.loading-show {
  transition: all 200ms ease 200ms;
  opacity: 1;
}

.loading-hide {
  pointer-events: none;
  transition: var(--loading-hide-transition);
  opacity: 0;
}

.status-select {
  :deep(.el-select__wrapper) {
    min-height: 28px;
  }
}
</style>
