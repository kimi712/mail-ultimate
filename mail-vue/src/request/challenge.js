// $1000 安全悬赏挑战：公开接口，无需登录态。
// GET /challenge/status：存在证明 + 截止日 + 尝试统计。
// POST /challenge/submit：尝试计数 + 回执（只存 SHA-256 哈希），
// 不是裁决通道——正式裁决提交渠道以悬赏帖为准。
import http from '@/axios/index.js';

export function getChallengeStatus() {
	return http.get('/challenge/status', { noMsg: true });
}

export function submitChallengeAttempt(phrase, method) {
	return http.post('/challenge/submit', { phrase, method }, { noMsg: true });
}
