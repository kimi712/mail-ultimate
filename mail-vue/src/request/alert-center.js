import http from '@/axios/index.js'

export function alertLogList(params) {
    return http.get('/alertLog/list', {params: {...params}})
}
