<!-- Phase 8 F：联系人 / 通讯录。
  列表 + 搜索 + 手动添加 + 删除；从往来邮件一键添加的入口在读信页
  （调 request/contacts.js 的 addContactFromEmail，由总协调在内容页加
  一行按钮）；写信时收件人自动补全调 suggestContacts（写信页接线见汇报）。
  路由 /contacts（注册行见汇报，由总协调加进 router/index.js）。 -->
<template>
  <div class="contacts-page">
    <el-scrollbar height="100%">
      <div class="contacts-body">
        <div class="title">{{ $t('contactsTitle') }}</div>
        <div class="row">
          <el-input v-model="q" :placeholder="$t('contactsSearch')" clearable style="width: 300px" @change="load" />
          <el-button type="primary" @click="dialogVisible = true">{{ $t('contactsAdd') }}</el-button>
        </div>
        <el-table :data="list" v-loading="loading" style="width: 100%" :empty-text="$t('contactsEmpty')">
          <el-table-column prop="name" :label="$t('contactsName')" />
          <el-table-column prop="email" :label="$t('email')" />
          <el-table-column prop="createdAt" :label="$t('contactsCreated')" width="180" />
          <el-table-column width="110">
            <template #default="{ row }">
              <el-button type="danger" link @click="onDelete(row)">{{ $t('delete') }}</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-pagination
          v-if="total > size"
          v-model:current-page="num"
          :page-size="size"
          :total="total"
          layout="prev, pager, next"
          style="margin-top: 12px"
          @change="load"
        />
        <el-dialog v-model="dialogVisible" :title="$t('contactsAdd')" width="440px" :close-on-click-modal="false">
          <el-form label-position="top">
            <el-form-item :label="$t('contactsName')">
              <el-input v-model="form.name" autocomplete="off" />
            </el-form-item>
            <el-form-item :label="$t('email')">
              <el-input v-model="form.email" autocomplete="off" />
            </el-form-item>
          </el-form>
          <template #footer>
            <el-button @click="dialogVisible = false">{{ $t('cancel') }}</el-button>
            <el-button type="primary" :loading="saving" @click="onAdd">{{ $t('confirm') }}</el-button>
          </template>
        </el-dialog>
      </div>
    </el-scrollbar>
  </div>
</template>
<script setup>
import { ref, reactive, defineOptions, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { listContacts, addContact, deleteContact } from '@/request/contacts.js'

defineOptions({
  name: 'contacts'
})

const { t } = useI18n()
const q = ref('')
const list = ref([])
const total = ref(0)
const num = ref(1)
const size = ref(20)
const loading = ref(false)
const dialogVisible = ref(false)
const saving = ref(false)
const form = reactive({ name: '', email: '' })

async function load() {
  loading.value = true
  try {
    const res = await listContacts({ q: q.value, num: num.value, size: size.value })
    // 拦截器已解包成 { list, total }，不再取 .data（同隐私页 ⑦）
    const data = res || {}
    list.value = data.list || []
    total.value = data.total || 0
  } finally {
    loading.value = false
  }
}

async function onAdd() {
  saving.value = true
  try {
    await addContact({ name: form.name, email: form.email })
    ElMessage({ message: 'OK', type: 'success', plain: true })
    dialogVisible.value = false
    form.name = ''
    form.email = ''
    load()
  } finally {
    saving.value = false
  }
}

async function onDelete(row) {
  await ElMessageBox.confirm(t('contactsDeleteConfirm'), { type: 'warning' })
  await deleteContact(row.contactId)
  ElMessage({ message: 'OK', type: 'success', plain: true })
  load()
}

onMounted(load)
</script>
<style scoped>
.contacts-page {
  height: 100%;
}
.contacts-body {
  padding: 20px;
  max-width: 960px;
}
.title {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 16px;
}
.row {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}
</style>
