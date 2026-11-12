import app from '../hono/hono';
import loginService from '../service/login-service';
import result from '../model/result';
import userContext from '../security/user-context';
import passkeyService from '../service/passkey-service';

// 取登录盐（2026-11-12 uwu 第 1 步）：公开接口（/login 前缀免鉴权）。
// GET /login/salt?email=… → { salt, version, decoySalt? }：version 1 = 旧
// SHA-256 凭证待迁移（本次登录顺带迁移），version 2 = 新口径；decoySalt
// 仅在胁迫密码已开通时返回。未知邮箱/已注销/已禁用一律返回随机盐 +
// version 2，不透露账号是否存在（登录时再以通用错误拒绝）。
app.get('/login/salt', async (c) => {
	const data = await loginService.getLoginSalt(c, c.req.query('email') || '');
	return c.json(result.ok(data));
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
