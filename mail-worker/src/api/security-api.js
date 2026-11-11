// Phase 6：安全中心 / TOTP / Passkey / 会话管理 API（全部仅限本人数据，
// 无 premKey，任意登录用户可用；userId 一律取 c.get('user').userId）。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import totpService from '../service/totp-service';
import passkeyService from '../service/passkey-service';
import sessionService from '../service/session-service';
import userSecurityService from '../service/user-security-service';
import userService from '../service/user-service';

// ---- TOTP ----
// Phase 8 B：换绑（已启用 TOTP 时重开 setup）须传旧码 oldCode 验旧码；
// setup 返回 {secret, otpauthUrl, qr}，qr 为本地编码的二维码矩阵（不调外部 API）。
app.post('/my/totp/setup', async (c) => {
	const userId = userContext.getUserId(c);
	const userRow = await userService.selectById(c, userId);
	const body = await c.req.json().catch(() => ({}));
	const data = await totpService.setup(c, userId, userRow.email, body.oldCode);
	return c.json(result.ok(data));
});

app.post('/my/totp/enable', async (c) => {
	const { code } = await c.req.json();
	const data = await totpService.enable(c, userContext.getUserId(c), code);
	return c.json(result.ok(data));
});

app.post('/my/totp/disable', async (c) => {
	const { password, code } = await c.req.json();
	await totpService.disable(c, userContext.getUserId(c), password, code);
	return c.json(result.ok());
});

// ---- Passkey ----
app.post('/my/passkey/register-options', async (c) => {
	const userId = userContext.getUserId(c);
	const userRow = await userService.selectById(c, userId);
	const options = await passkeyService.generateRegistrationOptions(c, userId, userRow.email);
	return c.json(result.ok(options));
});

app.post('/my/passkey/register', async (c) => {
	const userId = userContext.getUserId(c);
	const userRow = await userService.selectById(c, userId);
	const data = await passkeyService.verifyAndStoreRegistration(c, userId, userRow.email, await c.req.json());
	return c.json(result.ok(data));
});

app.get('/my/passkey/list', async (c) => {
	const rows = await passkeyService.listCredentials(c, userContext.getUserId(c));
	return c.json(result.ok(rows.map(row => ({
		credentialId: row.credentialId,
		name: row.name,
		createdTime: row.createdTime
	}))));
});

app.delete('/my/passkey/:credentialId', async (c) => {
	await passkeyService.deleteCredential(c, userContext.getUserId(c), c.req.param('credentialId'));
	return c.json(result.ok());
});

// ---- 会话（设备）管理 ----
app.get('/my/sessions', async (c) => {
	const userId = userContext.getUserId(c);
	const currentToken = await userContext.getToken(c);
	const list = await sessionService.listSessions(c, userId, currentToken);
	return c.json(result.ok(list));
});

app.post('/my/sessions/revoke', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const userId = userContext.getUserId(c);
	const currentToken = await userContext.getToken(c);
	if (body.allExceptCurrent) {
		const data = await sessionService.revokeAllExceptCurrent(c, userId, currentToken);
		return c.json(result.ok(data));
	}
	const data = await sessionService.revokeSession(c, userId, body.digest, currentToken);
	return c.json(result.ok(data));
});

// ---- 个性化安全中心 ----
app.get('/my/security', async (c) => {
	const data = await userSecurityService.get(c, userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.post('/my/security', async (c) => {
	const body = await c.req.json();
	const data = await userSecurityService.set(c, userContext.getUserId(c), body);
	return c.json(result.ok(data));
});

// ---- 抗量子（v3_15DB）：ML-KEM-768 密钥对 ----
// 公钥可公开（发件方按收件地址取，用来包裹一次性密钥 CEK）；加密私钥只返回给
// 本人（服务端无法解密，取回后由前端用 KEK 解密再解封 CEK）。
app.get('/my/security/mlkem-pubkey', async (c) => {
	const email = String(c.req.query('email') || '').trim();
	if (!email) return c.json(result.ok({ publicKey: '' }));
	const publicKey = await userSecurityService.getMlkemPublicKeyByEmail(c, email);
	return c.json(result.ok({ publicKey }));
});

app.get('/my/security/mlkem-private', async (c) => {
	const privEnc = await userSecurityService.getMlkemPrivEnc(c, userContext.getUserId(c));
	return c.json(result.ok({ privEnc }));
});

app.post('/my/security/mlkem-keys', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const data = await userSecurityService.setMlkemKeys(c, userContext.getUserId(c), body);
	return c.json(result.ok(data));
});
