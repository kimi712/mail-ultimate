import http from '@/axios/index.js'
import axios from 'axios'
import {useSettingStore} from "@/store/setting.js";


export function userList(params) {
    return http.get('/user/list', {params: {...params}})
}

// Phase 2 C 路：导出用户 CSV。注意不能走 http 实例：axios 拦截器按 JSON
// {code, data} 解析响应，blob 会被误判为失败；这里直接用 axios + responseType blob。
// 后端 BizError 以 HTTP 200 + JSON {code: 400} 返回，blob 里的 JSON 须手动解析抛错。
export function userExportCsv(params) {
    return axios.get(`${import.meta.env.VITE_BASE_URL}/user/export`, {
        params: {...params},
        responseType: 'blob',
        headers: {
            Authorization: `${localStorage.getItem('token')}`,
            'accept-language': useSettingStore().lang || 'zh'
        }
    }).then(async res => {
        if (res.data.type && res.data.type.includes('text/csv')) {
            return res.data
        }
        let data = {}
        try {
            data = JSON.parse(await res.data.text())
        } catch (e) {
        }
        throw new Error(data.message || 'export failed')
    })
}

export function userGroupByIp(params) {
    return http.get('/user/groupByIp', {params: {...params}})
}

export function userSetPwd(params) {
    return http.put('/user/setPwd', params)
}

export function userSetStatus(params) {
    return http.put('/user/setStatus', params)
}

export function userSetType(params) {
    return http.put('/user/setType', params)
}


export function userDelete(userIds) {
    return http.delete('/user/delete', {params:{userIds: userIds + ''}})
}

export function userAdd(form) {
    return http.post('/user/add', form)
}

export function userRestSendCount(userId) {
    return http.put('/user/resetSendCount', {userId})
}

export function userRestore(userId,type) {
    return http.put('/user/restore', {userId,type})
}

export function userAllAccount(userId, num, size) {
    return http.get('/user/allAccount', {params:{userId,num,size}})
}

export function userDeleteAccount(accountId) {
    return http.delete('/user/deleteAccount', {params:{accountId}})
}
