import http from '@/axios/index.js';

export function loginUserInfo() {
    return http.get('/my/loginUserInfo')
}

export function loginLog(params) {
    return http.get('/my/loginLog', {params})
}

// Phase 2 A 路补充：语言偏好同步（后端 user.locale 列）
export function getLocale() {
    return http.get('/my/locale', {noMsg: true})
}

export function setLocale(locale) {
    return http.post('/my/locale', {locale}, {noMsg: true})
}

// Phase 7 壁纸：壁纸偏好同步（后端 user.wallpaper / user.wallpaper_tags，v3_10DB）
export function getWallpaper() {
    return http.get('/my/wallpaper', {noMsg: true})
}

export function setWallpaper(wallpaper, wallpaperTags = []) {
    return http.post('/my/wallpaper', {wallpaper, wallpaperTags}, {noMsg: true})
}

// 用户自助绑定 Telegram（后端 user.tg_chat_id / tg_bind_code，v3_13DB）。
// noMsg：错误由调用方按需提示，避免拦截器与组件重复弹错。
export function getTelegramStatus() {
    return http.get('/my/telegram', {noMsg: true})
}

export function createTelegramBindCode() {
    return http.post('/my/telegram/bind-code', {}, {noMsg: true})
}

export function unbindTelegram() {
    return http.post('/my/telegram/unbind', {}, {noMsg: true})
}

// 一次性别名邮箱（后端 email_alias 表）：列表 / 生成 / 停用 / 启用 / 删除。
export function getAliasList() {
    return http.get('/my/alias', {noMsg: true})
}

export function createAlias() {
    return http.post('/my/alias', {}, {noMsg: true})
}

export function disableAlias(aliasId) {
    return http.post(`/my/alias/${aliasId}/disable`, {}, {noMsg: true})
}

export function enableAlias(aliasId) {
    return http.post(`/my/alias/${aliasId}/enable`, {}, {noMsg: true})
}

export function deleteAlias(aliasId) {
    return http.delete(`/my/alias/${aliasId}`, {noMsg: true})
}

// 金丝雀声明日期（安全中心展示）。
export function getCanary() {
    return http.get('/my/canary', {noMsg: true})
}

export function resetPassword(loginKey, salt) {
    return http.put('/my/resetPassword', {loginKey, salt})
}

export function userDelete() {
    return http.delete('/my/delete')
}

// 自助彻底删除：双重确认（登录密钥 + 输入 DELETE），物理删除全部数据，不可恢复。
export function hardDeleteMyAccount(loginKey, confirmText) {
    return http.post('/my/hard-delete', { loginKey, confirmText })
}

