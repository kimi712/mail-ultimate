import http from '@/axios/index.js';

// 2026-11-12 uwu 第 1 步：登录不再发明文密码（登录页改走取盐→浏览器派生
// 登录密钥），旧 login(email, password) 已删，防后人误用。

// Phase 6 TOTP 第二步：totpToken + 验证码（6 位动态码或备份码）换正式 JWT。
// noMsg：由登录页统一弹映射后的人话并处理 locked/expired 回退，不弹两次。
export function loginTotp(totpToken, code) {
    return http.post('/login/totp', {totpToken: totpToken, code: code}, {noMsg: true})
}

export function logout() {
    return http.delete('/logout')
}

export function register(form) {
    return http.post('/register', form)
}