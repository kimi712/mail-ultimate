<template>
  <div class="wallpaper-selector">
    <div class="wallpaper-desc">{{ t('wallpaper.desc') }}</div>

    <!-- 风格标签筛选：点一下即记为喜好标签（存用户偏好），网格按任一喜好标签过滤 -->
    <div class="wallpaper-tags" v-if="tags.length">
      <el-tag
        :type="likedTags.length === 0 ? '' : 'info'"
        class="wallpaper-tag"
        effect="plain"
        @click="clearLikedTags"
      >{{ t('wallpaper.all') }}</el-tag>
      <el-tag
        v-for="tag in tags"
        :key="tag"
        :type="likedTags.includes(tag) ? '' : 'info'"
        :effect="likedTags.includes(tag) ? 'dark' : 'plain'"
        class="wallpaper-tag"
        @click="toggleLikedTag(tag)"
      >{{ tag }}</el-tag>
    </div>

    <!-- 为你推荐：按喜好标签命中数排序，取前 3 -->
    <div class="wallpaper-recommend" v-if="recommended.length">
      <div class="wallpaper-sub-title">{{ t('wallpaper.recommended') }}</div>
      <div class="wallpaper-grid">
        <div
          v-for="item in recommended"
          :key="item.id"
          class="wallpaper-card"
          :class="{ 'is-selected': selected === item.id }"
          @click="selectWallpaper(item.id)"
        >
          <img :src="`/wallpapers/${item.file}`" :alt="displayName(item)" loading="lazy" />
          <span class="wallpaper-name">{{ displayName(item) }}</span>
          <span class="wallpaper-check" v-if="selected === item.id">✓</span>
        </div>
      </div>
    </div>

    <!-- 自定义上传 -->
    <div class="wallpaper-upload-row">
      <el-button type="primary" size="small" :loading="uploading" @click="triggerUpload">
        {{ t('wallpaper.upload') }}
      </el-button>
      <span class="wallpaper-hint">{{ t('wallpaper.uploadHint') }}</span>
      <input
        ref="fileInput"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        @change="onFileChange"
      />
    </div>

    <!-- 预置壁纸网格（按分类分组）+ 自定义分组 -->
    <div v-if="customList.length" class="wallpaper-group">
      <div class="wallpaper-sub-title">{{ t('wallpaper.custom') }}</div>
      <div class="wallpaper-grid">
        <div
          v-for="item in customList"
          :key="item.id"
          class="wallpaper-card"
          :class="{ 'is-selected': selected === item.url }"
          @click="selectWallpaper(item.url)"
        >
          <img :src="item.url" :alt="item.name" loading="lazy" />
          <span class="wallpaper-name">{{ item.name }}</span>
          <span class="wallpaper-check" v-if="selected === item.url">✓</span>
        </div>
      </div>
    </div>
    <div v-for="group in filteredGroups" :key="group.category" class="wallpaper-group">
      <div class="wallpaper-sub-title">{{ displayCategory(group) }}</div>
      <div class="wallpaper-grid">
        <div
          v-for="item in group.items"
          :key="item.id"
          class="wallpaper-card"
          :class="{ 'is-selected': selected === item.id }"
          @click="selectWallpaper(item.id)"
        >
          <img :src="`/wallpapers/${item.file}`" :alt="displayName(item)" loading="lazy" />
          <span class="wallpaper-name">{{ displayName(item) }}</span>
          <span class="wallpaper-check" v-if="selected === item.id">✓</span>
        </div>
      </div>
    </div>
    <div class="wallpaper-empty" v-if="list.length && !filteredGroups.length">
      {{ t('wallpaper.noMatch') }}
    </div>

    <div class="wallpaper-foot">
      <el-button size="small" @click="selectWallpaper('')">{{ t('wallpaper.resetDefault') }}</el-button>
      <span class="wallpaper-current" v-if="selected">{{ t('wallpaper.selected') }}：{{ selectedName }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { getWallpaper, setWallpaper } from '@/request/my.js'
import { uploadWallpaper } from '@/request/wallpaper.js'
import {
  DEFAULT_WALLPAPER_ID,
  MAX_UPLOAD_SIZE,
  ALLOWED_UPLOAD_TYPES,
  allTags,
  applyWallpaper,
  loadCustomWallpapers,
  loadStoredTags,
  loadStoredWallpaper,
  recommendWallpapers,
  resolveWallpaperUrl,
  saveCustomWallpapers,
  saveStoredTags,
  saveStoredWallpaper
} from '@/utils/wallpaper.js'
import { useUiStore } from '@/store/ui.js'

const { t, locale } = useI18n()
const uiStore = useUiStore()

const list = ref([])
const customList = ref(loadCustomWallpapers())
const selected = ref(loadStoredWallpaper())
const likedTags = ref(loadStoredTags())
const uploading = ref(false)
const fileInput = ref(null)

const tags = computed(() => allTags(list.value))
const recommended = computed(() => recommendWallpapers(list.value, likedTags.value, 3))

// 网格按喜好标签过滤：无喜好标签时全显；有则只显命中任一标签的
const filteredGroups = computed(() => {
  const groups = []
  const seen = new Set()
  const filtered = likedTags.value.length
    ? list.value.filter((w) => (w.tags || []).some((tag) => likedTags.value.includes(tag)))
    : list.value
  filtered.forEach((w) => {
    const key = w.category || ''
    if (!seen.has(key)) {
      seen.add(key)
      groups.push({ category: w.category, categoryEn: w.categoryEn, items: [] })
    }
    groups.find((g) => g.category === key).items.push(w)
  })
  return groups
})

const selectedName = computed(() => {
  if (!selected.value) return ''
  if (selected.value.startsWith('/')) {
    const found = customList.value.find((w) => w.url === selected.value)
    return found ? found.name : selected.value
  }
  const found = list.value.find((w) => w.id === selected.value)
  return found ? displayName(found) : selected.value
})

function displayName(item) {
  return locale.value === 'zh' ? item.name : (item.nameEn || item.name)
}

function displayCategory(group) {
  return locale.value === 'zh' ? group.category : (group.categoryEn || group.category)
}

// 选壁纸：本地立即生效（localStorage + 背景层），再 best-effort 同步后端
async function selectWallpaper(value) {
  selected.value = value || ''
  saveStoredWallpaper(selected.value)
  applyWallpaper(selected.value, list.value, uiStore.dark)
  try {
    await setWallpaper(selected.value, likedTags.value)
  } catch (e) {
    console.error('同步壁纸偏好失败:', e)
  }
}

function toggleLikedTag(tag) {
  const index = likedTags.value.indexOf(tag)
  if (index === -1) {
    likedTags.value.push(tag)
  } else {
    likedTags.value.splice(index, 1)
  }
  saveStoredTags(likedTags.value)
  // 喜好标签同样同步后端（与当前壁纸值一起写）
  setWallpaper(selected.value, likedTags.value).catch((e) => {
    console.error('同步壁纸偏好失败:', e)
  })
}

function clearLikedTags() {
  if (!likedTags.value.length) return
  likedTags.value = []
  saveStoredTags([])
  setWallpaper(selected.value, []).catch((e) => {
    console.error('同步壁纸偏好失败:', e)
  })
}

function triggerUpload() {
  fileInput.value?.click()
}

async function onFileChange(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  if (!ALLOWED_UPLOAD_TYPES.includes(file.type)) {
    ElMessage({ message: t('wallpaper.invalidType'), type: 'warning', plain: true })
    return
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    ElMessage({ message: t('wallpaper.uploadTooLarge'), type: 'warning', plain: true })
    return
  }
  uploading.value = true
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(new Error('read failed'))
      reader.readAsDataURL(file)
    })
    const res = await uploadWallpaper(dataUrl)
    const { key, url } = res || {}
    if (!url) throw new Error('empty url')
    const item = { id: key || url, url, name: file.name }
    customList.value = [item, ...customList.value.filter((w) => w.url !== url)]
    saveCustomWallpapers(customList.value)
    await selectWallpaper(url)
    ElMessage({ message: t('wallpaper.uploadSuccess'), type: 'success', plain: true })
  } catch (e) {
    console.error('上传壁纸失败:', e)
    ElMessage({ message: t('wallpaper.uploadFailed'), type: 'error', plain: true })
  } finally {
    uploading.value = false
  }
}

onMounted(async () => {
  try {
    const res = await fetch('/wallpapers/wallpapers.json')
    const data = await res.json()
    if (Array.isArray(data)) list.value = data
  } catch (e) {
    console.error('加载壁纸清单失败:', e)
    ElMessage({ message: t('wallpaper.loadFailed'), type: 'error', plain: true })
    return
  }
  // 默认选中 snowden-vista：本地无值且后端无值时即为默认
  if (!selected.value) {
    applyWallpaper('', list.value, uiStore.dark)
  }
  // 后端有值则以其为准（登录后 init 已同步过一次，这里再对齐一次，避免直接进设置页时过期）
  try {
    const server = await getWallpaper()
    if (server?.wallpaper || (server?.wallpaperTags || []).length) {
      selected.value = server.wallpaper || ''
      likedTags.value = server.wallpaperTags || []
      saveStoredWallpaper(selected.value)
      saveStoredTags(likedTags.value)
      applyWallpaper(selected.value, list.value, uiStore.dark)
    }
  } catch (e) {
    console.error('读取壁纸偏好失败:', e)
  }
})
</script>

<style lang="scss" scoped>
.wallpaper-selector {
  width: 100%;
}
.wallpaper-desc {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin-bottom: 10px;
}
.wallpaper-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.wallpaper-tag {
  cursor: pointer;
  user-select: none;
}
.wallpaper-sub-title {
  font-size: 13px;
  font-weight: 600;
  margin: 12px 0 8px;
}
.wallpaper-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 10px;
}
.wallpaper-card {
  position: relative;
  cursor: pointer;
  border-radius: 8px;
  overflow: hidden;
  border: 2px solid transparent;
  aspect-ratio: 16 / 10;
}
.wallpaper-card img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.wallpaper-card.is-selected {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.35);
}
.wallpaper-name {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 10px 6px 4px;
  font-size: 12px;
  color: #fff;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.65));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wallpaper-check {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--el-color-primary);
  color: #fff;
  font-size: 13px;
  line-height: 20px;
  text-align: center;
}
.wallpaper-upload-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 12px 0 4px;
  flex-wrap: wrap;
}
.wallpaper-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.wallpaper-empty {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  padding: 12px 0;
}
.wallpaper-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.wallpaper-current {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
</style>
