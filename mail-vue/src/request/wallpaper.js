import http from '@/axios/index.js';

// Phase 7 壁纸：自定义壁纸上传（base64 JSON 入参，与 setBackground 同款，
// 前端不走 multipart，与现有 axios 拦截器兼容）。
export function uploadWallpaper(image) {
    return http.post('/wallpaper/upload', {image}, {noMsg: true})
}
