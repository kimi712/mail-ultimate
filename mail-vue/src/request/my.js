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

export function resetPassword(password) {
    return http.put('/my/resetPassword', {password})
}

export function userDelete() {
    return http.delete('/my/delete')
}

