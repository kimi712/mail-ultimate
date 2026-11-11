<template>
  <div class="audit-log-box">
    <div class="header-actions">
      <div class="search">
        <el-input
            v-model="params.action"
            class="search-input"
            :placeholder="$t('searchByAction')"
        >
        </el-input>
      </div>
      <div class="search">
        <el-input
            v-model="params.ip"
            class="search-input"
            :placeholder="$t('searchByIp')"
        >
        </el-input>
      </div>
      <el-date-picker
          v-model="dateRange"
          type="daterange"
          :start-placeholder="$t('startDate')"
          :end-placeholder="$t('endDate')"
          value-format="YYYY-MM-DD"
          @change="search"
      />
      <Icon class="icon" icon="iconoir:search" @click="search" width="20" height="20"/>
      <Icon class="icon" icon="ion:reload" width="18" height="18" @click="refresh"/>
    </div>
    <el-scrollbar class="scrollbar">
      <div class="loading" :class="tableLoading ? 'loading-show' : 'loading-hide'">
        <loading/>
      </div>
      <el-table :data="logs" style="width: 100%" v-loading="tableLoading"
                element-loading-background="transparent">
        <el-table-column prop="action" :label="$t('actionName')" min-width="170" show-overflow-tooltip/>
        <el-table-column prop="actorUserId" :label="$t('actorUserId')" width="100"/>
        <el-table-column prop="targetType" :label="$t('targetType')" width="120"/>
        <el-table-column prop="targetId" :label="$t('targetId')" min-width="120" show-overflow-tooltip/>
        <el-table-column prop="ip" :label="$t('ip')" min-width="140" show-overflow-tooltip/>
        <el-table-column prop="detail" :label="$t('detail')" min-width="220" show-overflow-tooltip/>
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
import {auditLogList} from '@/request/audit-log.js'
import {Icon} from "@iconify/vue";
import loading from "@/components/loading/index.vue";
import { formatDateTime, formatFullWithTimeZone } from "@/utils/datetime.js";

defineOptions({
  name: 'audit-log'
})

const logs = ref([])
const total = ref(0)
const tableLoading = ref(true)
const dateRange = ref(null)

const params = reactive({
  action: '',
  ip: '',
  startDate: '',
  endDate: '',
  num: 1,
  size: 15
})

getList()

function getList() {
  tableLoading.value = true
  const query = {...params}
  if (dateRange.value && dateRange.value.length === 2) {
    query.startDate = dateRange.value[0]
    query.endDate = dateRange.value[1]
  }
  auditLogList(query).then(data => {
    logs.value = data.list
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
  params.action = ''
  params.ip = ''
  params.startDate = ''
  params.endDate = ''
  dateRange.value = null
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
.audit-log-box {
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

  .search-input {
    width: min(200px, calc(100vw - 140px));
  }

  .search {
    :deep(.el-input-group) {
      height: 28px;
    }

    :deep(.el-input__inner) {
      height: 28px;
    }
  }

  .icon {
    cursor: pointer;
  }
}

.scrollbar {
  width: 100%;
  overflow: auto;
  height: calc(100% - 50px);
  @media (max-width: 464px) {
    height: calc(100% - 90px);
  }
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
</style>
