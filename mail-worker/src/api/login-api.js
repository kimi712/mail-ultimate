import app from '../hono/hono';
import loginService from '../service/login-service';
import result from '../model/result';
import userContext from '../security/user-context';
import passkeyService from '../service/passkey-service';
import zkService from '../service/zk-service';

// 斯诺登第三批（v3_16DB）：零知识登录挑战。公开接口（/login 前缀免鉴权）。
// GET /login/zk-challenge?email=… → { challengeId, nonce, salt, enabled }。
// 无论账号是否开通 ZK 都返回挑战（不开通时用随机盐），不透露开通状态；
// 挑战 5 分钟过期、一次有效。前端先算 verifier = SHA-256(salt + password)，
// 再算 response = SHA-256(verifier + nonce) base64，随登录请求一起发 zk 字段。
app.get('/login/zk-challenge', async (c) => {
	const challenge = await zkService.issueChallenge(c, c.req.query('email') || '');
	return c.json(result.ok(challenge));
});

// Phase 6：密码通过且用户开启 TOTP 时 login() 返回 {needTotp, totpToken}
// 而非 JWT，原样返回给前端走 POST /login/totp；否则照常返回 {token}。
app.post('/login', async (c) => {
	const loginResult = await loginService.login(c, await c.req.json());
	if (loginResult && typeof loginResult === 'object' && loginResult.needTotp) {
		return c.json(result.ok(loginResult));
	}
	return c.json(result.ok({ token: loginResult }));
});

app.post('/register', async (c) => {
	const jwt = await loginService.register(c, await c.req.json());
	return c.json(result.ok(jwt));
});

// Phase 6：TOTP 第二步。{totpToken, code} → {token}；失败 5 次作废 totpToken。
app.post('/login/totp', async (c) => {
	const token = await loginService.verifyTotpLogin(c, await c.req.json());
	return c.json(result.ok({ token }));
});

// Phase 6：Passkey 登录。options 按邮箱取 challenge；verify 验签通过后发 JWT。
app.post('/login/passkey-options', async (c) => {
	const { email } = await c.req.json();
	const options = await passkeyService.generateAuthenticationOptions(c, email);
	return c.json(result.ok(options));
});

app.post('/login/passkey-verify', async (c) => {
	const token = await loginService.loginWithPasskey(c, await c.req.json());
	return c.json(result.ok({ token }));
});

app.delete('/logout', async (c) => {
	await loginService.logout(c, userContext.getUserId(c));
	return c.json(result.ok());
});
