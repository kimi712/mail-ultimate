import http from '@/axios/index.js'

export function ipBlocklistList(params) {
    return http.get('/ipBlocklist/list', {params: {...params}})
}

export function ipBlocklistAdd(form) {
    return http.post('/ipBlocklist/add', form)
}

export function ipBlocklistDelete(blockId) {
    return http.delete('/ipBlocklist/delete', {params: {blockId}})
}
