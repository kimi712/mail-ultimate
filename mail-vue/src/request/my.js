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

export function resetPassword(password) {
    return http.put('/my/resetPassword', {password})
}

export function userDelete() {
    return http.delete('/my/delete')
}

// 自助彻底删除：双重确认（密码 + 输入 DELETE），物理删除全部数据，不可恢复。
export function hardDeleteMyAccount(password, confirmText) {
    return http.post('/my/hard-delete', { password, confirmText })
}

