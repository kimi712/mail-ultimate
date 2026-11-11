// $1000 安全悬赏挑战：公开状态页 API（无需登录）。
// GET /challenge/status：存在证明 + 截止日 + 尝试统计。
// POST /challenge/submit：尝试计数 + 回执（只存 SHA-256 哈希），
// 不是裁决通道——正式裁决提交渠道以悬赏帖为准。
import app from '../hono/hono';
import result from '../model/result';
import challengeService from '../service/challenge-service';

app.get('/challenge/status', async (c) => {
	const data = await challengeService.status(c);
	return c.json(result.ok(data));
});

app.post('/challenge/submit', async (c) => {
	const data = await challengeService.submit(c, await c.req.json());
	return c.json(result.ok(data));
});
