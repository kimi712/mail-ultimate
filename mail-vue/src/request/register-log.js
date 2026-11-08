import http from '@/axios/index.js'

export function registerLogList(params) {
    return http.get('/registerLog/list', {params: {...params}})
}
