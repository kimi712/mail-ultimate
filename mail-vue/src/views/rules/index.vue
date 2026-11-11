<!-- Phase 8 F：邮件规则 / 过滤器管理。
  规则按 sort 顺序执行（上移/下移调顺序）；条件为发件人/主题/收件人含匹配
  （全部 AND）；动作：打标签、归档、标记已读、删除、转发到指定邮箱。
  规则只对新收信件生效（applyRules 由收信管线对新信调一次，旧信不重跑）。
  路由 /mail-rules（注册行见汇报，由总协调加进 router/index.js）。 -->
<template>
  <div class="rules-page">
    <el-scrollbar height="100%">
      <div class="rules-body">
        <div class="title">{{ $t('mailRulesTitle') }}</div>
        <div class="desc">{{ $t('mailRulesDesc') }}</div>
        <div class="row">
          <el-button type="primary" @click="openCreate">{{ $t('mailRulesAdd') }}</el-button>
        </div>
        <el-table :data="rules" v-loading="loading" style="width: 100%" :empty-text="$t('mailRulesEmpty')">
          <el-table-column prop="name" :label="$t('mailRulesName')" width="180" />
          <el-table-column :label="$t('mailRulesCondition')">
            <template #default="{ row }">{{ describeCondition(row.condition) }}</template>
          </el-table-column>
          <el-table-column :label="$t('mailRulesActions')">
            <template #default="{ row }">{{ describeActions(row.actions) }}</template>
          </el-table-column>
          <el-table-column :label="$t('mailRulesEnabled')" width="90">
            <template #default="{ row }">
              <el-switch :model-value="row.enabled === 1" @change="onToggle(row, $event)" />
            </template>
          </el-table-column>
          <el-table-column width="200">
            <template #default="{ row, $index }">
              <el-button link :disabled="$index === 0" @click="onMove(row, -1)">↑</el-button>
              <el-button link :disabled="$index === rules.length - 1" @click="onMove(row, 1)">↓</el-button>
              <el-button link @click="openEdit(row)">{{ $t('edit') }}</el-button>
              <el-button type="danger" link @click="onDelete(row)">{{ $t('delete') }}</el-button>
            </template>
          </el-table-column>
        </el-table>

        <el-dialog v-model="dialogVisible" :title="editing ? $t('mailRulesEdit') : $t('mailRulesAdd')" width="560px" :close-on-click-modal="false">
          <el-form label-position="top">
            <el-form-item :label="$t('mailRulesName')">
              <el-input v-model="form.name" autocomplete="off" />
            </el-form-item>
            <el-form-item :label="$t('mailRulesConditionSender')">
              <el-input v-model="form.senderContains" :placeholder="$t('mailRulesContainsHint')" autocomplete="off" />
            </el-form-item>
            <el-form-item :label="$t('mailRulesConditionSubject')">
              <el-input v-model="form.subjectContains" :placeholder="$t('mailRulesContainsHint')" autocomplete="off" />
            </el-form-item>
            <el-form-item :label="$t('mailRulesConditionRecipient')">
              <el-input v-model="form.recipientContains" :placeholder="$t('mailRulesContainsHint')" autocomplete="off" />
            </el-form-item>
            <el-form-item :label="$t('mailRulesActions')">
              <el-checkbox-group v-model="form.actionTypes">
                <el-checkbox label="tag">{{ $t('mailRuleActionTag') }}</el-checkbox>
                <el-checkbox label="archive">{{ $t('mailRuleActionArchive') }}</el-checkbox>
                <el-checkbox label="mark_read">{{ $t('mailRuleActionMarkRead') }}</el-checkbox>
                <el-checkbox label="delete">{{ $t('mailRuleActionDelete') }}</el-checkbox>
                <el-checkbox label="forward">{{ $t('mailRuleActionForward') }}</el-checkbox>
              </el-checkbox-group>
            </el-form-item>
            <el-form-item v-if="form.actionTypes.includes('tag')" :label="$t('mailRuleActionTagLabel')">
              <el-input v-model="form.tagLabel" autocomplete="off" />
            </el-form-item>
            <el-form-item v-if="form.actionTypes.includes('forward')" :label="$t('mailRuleActionForwardTo')">
              <el-input v-model="form.forwardTo" autocomplete="off" />
            </el-form-item>
          </el-form>
          <template #footer>
            <el-button @click="dialogVisible = false">{{ $t('cancel') }}</el-button>
            <el-button type="primary" :loading="saving" @click="onSave">{{ $t('confirm') }}</el-button>
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
import { listRules, createRule, updateRule, deleteRule, reorderRules } from '@/request/rules.js'

defineOptions({
  name: 'mail-rules'
})

const { t } = useI18n()
const rules = ref([])
const loading = ref(false)
const dialogVisible = ref(false)
const saving = ref(false)
const editing = ref(null)
const form = reactive({
  name: '', senderContains: '', subjectContains: '', recipientContains: '',
  actionTypes: [], tagLabel: '', forwardTo: ''
})

function describeCondition(condition) {
  const parts = []
  if (condition.sender_contains) parts.push(`${t('mailRulesConditionSender')}: ${condition.sender_contains}`)
  if (condition.subject_contains) parts.push(`${t('mailRulesConditionSubject')}: ${condition.subject_contains}`)
  if (condition.recipient_contains) parts.push(`${t('mailRulesConditionRecipient')}: ${condition.recipient_contains}`)
  return parts.join('；') || '-'
}

function describeActions(actions) {
  return (actions || []).map(a => {
    if (a.type === 'tag') return `${t('mailRuleActionTag')}(${a.label})`
    if (a.type === 'forward') return `${t('mailRuleActionForward')}(${a.to})`
    return t('mailRuleAction' + a.type.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase()))
  }).join('、') || '-'
}

function buildPayload() {
  const condition = {}
  if (form.senderContains.trim()) condition.sender_contains = form.senderContains.trim()
  if (form.subjectContains.trim()) condition.subject_contains = form.subjectContains.trim()
  if (form.recipientContains.trim()) condition.recipient_contains = form.recipientContains.trim()
  const actions = form.actionTypes.map(type => {
    if (type === 'tag') return { type, label: form.tagLabel.trim() }
    if (type === 'forward') return { type, to: form.forwardTo.trim() }
    return { type }
  })
  return { name: form.name.trim(), condition, actions }
}

function resetForm() {
  editing.value = null
  Object.assign(form, { name: '', senderContains: '', subjectContains: '', recipientContains: '', actionTypes: [], tagLabel: '', forwardTo: '' })
}

function openCreate() {
  resetForm()
  dialogVisible.value = true
}

function openEdit(row) {
  resetForm()
  editing.value = row
  form.name = row.name
  form.senderContains = row.condition.sender_contains || ''
  form.subjectContains = row.condition.subject_contains || ''
  form.recipientContains = row.condition.recipient_contains || ''
  form.actionTypes = (row.actions || []).map(a => a.type)
  const tag = (row.actions || []).find(a => a.type === 'tag')
  const fwd = (row.actions || []).find(a => a.type === 'forward')
  form.tagLabel = tag ? tag.label : ''
  form.forwardTo = fwd ? fwd.to : ''
  dialogVisible.value = true
}

async function load() {
  loading.value = true
  try {
    const res = await listRules()
    rules.value = res.data?.data?.list || res.data?.list || []
  } finally {
    loading.value = false
  }
}

async function onSave() {
  saving.value = true
  try {
    const payload = buildPayload()
    if (editing.value) {
      await updateRule({ ruleId: editing.value.ruleId, ...payload })
    } else {
      await createRule(payload)
    }
    ElMessage({ message: 'OK', type: 'success', plain: true })
    dialogVisible.value = false
    load()
  } finally {
    saving.value = false
  }
}

async function onToggle(row, enabled) {
  await updateRule({ ruleId: row.ruleId, enabled: enabled ? 1 : 0 })
  load()
}

async function onMove(row, delta) {
  const idx = rules.value.findIndex(r => r.ruleId === row.ruleId)
  const target = idx + delta
  if (target < 0 || target >= rules.value.length) return
  const ids = rules.value.map(r => r.ruleId)
  const tmp = ids[idx]
  ids[idx] = ids[target]
  ids[target] = tmp
  await reorderRules(ids)
  load()
}

async function onDelete(row) {
  await ElMessageBox.confirm(t('mailRulesDeleteConfirm'), { type: 'warning' })
  await deleteRule(row.ruleId)
  ElMessage({ message: 'OK', type: 'success', plain: true })
  load()
}

onMounted(load)
</script>
<style scoped>
.rules-page {
  height: 100%;
}
.rules-body {
  padding: 20px;
  max-width: 960px;
}
.title {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 8px;
}
.desc {
  font-size: 13px;
  color: #909399;
  margin-bottom: 16px;
}
.row {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}
</style>
