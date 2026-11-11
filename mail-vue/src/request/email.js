import http from '@/axios/index.js';

export function emailList(accountId, allReceive, emailId, timeSort, size, type, full, searchParams = {}) {
    const {type: searchType, text, startDate, endDate, spam, trash} = searchParams
    return http.get('/email/list', {params: {accountId, allReceive, emailId, timeSort, size, type, full, searchType, text, startDate, endDate, spam, trash}})
}

export function emailDelete(emailIds) {
    return http.delete('/email/delete?emailIds=' + emailIds)
}

// 回收站：把已删邮件恢复到收件箱。
export function emailRestore(emailIds) {
    return http.put('/email/restore', {emailIds: Array.isArray(emailIds) ? emailIds.join(',') : emailIds})
}

// 回收站：彻底删除（无法恢复）。
export function emailPhysicsDelete(emailIds) {
    return http.delete('/email/physicsDelete?emailIds=' + emailIds)
}

export function emailLatest(emailId, accountId, allReceive) {
    return http.get('/email/latest', {params: {emailId, accountId, allReceive}, noMsg: true, timeout: 35 * 1000})
}

export function emailRead(emailIds, opened) {
    // opened=true：详情页打开（内容已进前端）才传，阅后即焚靠它触发；列表“标已读”不传，不烧。
    return http.put('/email/read', {emailIds, opened: opened === true})
}

export function emailSend(form,progress) {
    return http.post('/email/send', form,{
        onUploadProgress: (e) => {
            progress(e)
        },
        noMsg: true
    })
}
