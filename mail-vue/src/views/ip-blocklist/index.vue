<template>
  <div class="ip-blocklist-box">
    <div class="header-actions">
      <Icon class="icon" icon="ion:add-outline" width="23" height="23" @click="openAdd"/>
      <el-select v-model="params.scope" class="status-select" style="width: 120px" @change="search">
        <el-option :label="$t('all')" :value="''"/>
        <el-option :label="$t('blockRegister')" :value="0"/>
        <el-option :label="$t('blockAccess')" :value="1"/>
      </el-select>
      <Icon class="icon" icon="ion:reload" width="18" height="18" @click="refresh"/>
    </div>
    <el-scrollbar class="scrollbar">
      <div class="loading" :class="tableLoading ? 'loading-show' : 'loading-hide'">
        <loading/>
      </div>
      <el-table :data="blocklist" style="width: 100%" v-loading="tableLoading"
                element-loading-background="transparent">
        <el-table-column prop="ip" :label="$t('ip')" min-width="150" show-overflow-tooltip/>
        <el-table-column prop="ipSegment" :label="$t('ipSegment')" min-width="150" show-overflow-tooltip/>
        <el-table-column :label="$t('scope')" width="110">
          <template #default="props">
            <el-tag v-if="props.row.scope === 0" type="warning">{{ $t('blockRegister') }}</el-tag>
            <el-tag v-else type="danger">{{ $t('blockAccess') }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="reason" :label="$t('reason')" min-width="180" show-overflow-tooltip/>
        <el-table-column :label="$t('expireTime')" min-width="170">
          <template #default="props">
            <span :title="props.row.expireTime ? formatFullWithTimeZone(props.row.expireTime) : ''">{{ props.row.expireTime ? formatDateTime(props.row.expireTime) : $t('permanent') }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="createdBy" :label="$t('createdBy')" min-width="160" show-overflow-tooltip/>
        <el-table-column :label="$t('action')" width="90">
          <template #default="props">
            <el-button size="small" type="danger" @click="removeBlock(props.row)">{{ $t('unblock') }}</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="pagination" v-if="total > 10">
        <el-pagination
            :current-page="params.page"
            :page-size="params.size"
            background
            layout="prev, pager, next, sizes, total"
            :total="total"
            @size-change="sizeChange"
            @current-change="numChange"
        />
      </div>
    </el-scrollbar>
    <el-dialog class="dialog" v-model="showAdd" :title="$t('addBlock')" @closed="resetAddForm">
      <div class="container">
        <el-input v-model="addForm.ip" :placeholder="$t('ip')" @keyup.enter="submit"/>
        <el-input v-model="addForm.ipSegment" :placeholder="$t('ipSegmentPlaceholder')" @keyup.enter="submit"/>
        <el-select v-model="addForm.scope" :placeholder="$t('scope')">
          <el-option :label="$t('blockRegister')" :value="0"/>
          <el-option :label="$t('blockAccess')" :value="1"/>
        </el-select>
        <el-input v-model="addForm.reason" :placeholder="$t('reason')" @keyup.enter="submit"/>
        <el-input v-model="addForm.expireTime" :placeholder="$t('expireTimePlaceholder')" @keyup.enter="submit"/>
        <el-button class="btn" type="primary" @click="submit" :loading="addLoading"
        >{{ $t('add') }}
        </el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import {defineOptions, reactive, ref} from 'vue'
import {ipBlocklistList, ipBlocklistAdd, ipBlocklistDelete} from '@/request/ip-blocklist.js'
import {Icon} from "@iconify/vue";
import loading from "@/components/loading/index.vue";
import { formatDateTime, formatFullWithTimeZone } from "@/utils/datetime.js";
import {useI18n} from 'vue-i18n';

defineOptions({
  name: 'ip-blocklist'
})

const {t} = useI18n();
const blocklist = ref([])
const total = ref(0)
const tableLoading = ref(true)
const showAdd = ref(false)
const addLoading = ref(false)

const params = reactive({
  scope: '',
  page: 1,
  size: 15
})

const addForm = reactive({
  ip: '',
  ipSegment: '',
  scope: 0,
  reason: '',
  expireTime: ''
})

getList()

function getList() {
  tableLoading.value = true
  ipBlocklistList(params).then(data => {
    blocklist.value = data.list
    total.value = data.total
  }).finally(() => {
    tableLoading.value = false
  })
}

function search() {
  params.page = 1
  getList()
}

function refresh() {
  params.scope = ''
  params.page = 1
  getList()
}

function numChange(page) {
  params.page = page
  getList()
}

function sizeChange(size) {
  params.size = size
  getList()
}

function openAdd() {
  showAdd.value = true
}

function resetAddForm() {
  addForm.ip = ''
  addForm.ipSegment = ''
  addForm.scope = 0
  addForm.reason = ''
  addForm.expireTime = ''
}

function submit() {
  if (addLoading.value) return
  if (!addForm.ip && !addForm.ipSegment) {
    ElMessage({
      message: t('ipEmptyMsg'),
      type: "error",
      plain: true
    })
    return
  }
  addLoading.value = true
  const form = {...addForm}
  if (!form.expireTime) {
    form.expireTime = null
  }
  ipBlocklistAdd(form).then(() => {
    showAdd.value = false
    ElMessage({
      message: t('addSuccessMsg'),
      type: "success",
      plain: true
    })
    getList()
  }).finally(() => {
    addLoading.value = false
  })
}

function removeBlock(row) {
  ElMessageBox.confirm(t('unblockConfirm', {msg: row.ip || row.ipSegment}), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    ipBlocklistDelete(row.blockId).then(() => {
      ElMessage({
        message: t('delSuccessMsg'),
        type: "success",
        plain: true
      })
      getList()
    })
  });
}
</script>

<style lang="scss" scoped>
.ip-blocklist-box {
  overflow: hidden;
  height: 100%;
}

:deep(.el-dialog) {
  width: 400px !important;
  @media (max-width: 440px) {
    width: calc(100% - 40px) !important;
    margin-right: 20px !important;
    margin-left: 20px !important;
  }
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

.container {
  display: grid;
  grid-template-columns: 1fr;
  gap: 15px;
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

.btn {
  width: 100%;
}

.status-select {
  :deep(.el-select__wrapper) {
    min-height: 28px;
  }
}
</style>
