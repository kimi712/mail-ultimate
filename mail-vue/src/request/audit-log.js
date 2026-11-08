import http from '@/axios/index.js'

export function auditLogList(params) {
    return http.get('/auditLog/list', {params: {...params}})
}
