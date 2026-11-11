// 斯诺登第三批（v3_16DB）：可搜索加密 / 盲索引。
// 务实版：关键词 blind index。前端用 KEK 对关键词做 HMAC 得到 token，
// 服务端只存 token → emailId 映射，匹配时不解密正文。
// 界面必须如实说明：这是可搜索加密，不是全同态加密；服务端能看到
// “哪些信共享同一个关键词”（访问模式），看不到关键词本身和正文。
// 诱饵会话下：提交直接丢弃（假装成功），搜索返回空。
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import blindIndexService from '../service/blind-index-service';
import emailService from '../service/email-service';

// 读信解密后补传盲索引：{ emailId, tokens: [token, ...] }。
// 只接受本人名下 E2EE 信的 token；token 须为 64 位 hex（HMAC-SHA256）。
app.post('/my/blind-index', async (c) => {
	const userId = userContext.getUserId(c);
	if (userContext.isDecoy(c)) {
		return c.json(result.ok({ stored: 0 }));
	}
	const { emailId, tokens } = await c.req.json().catch(() => ({}));
	const id = Number(emailId) || 0;
	const row = id ? await emailService.selectById(c, id) : null;
	if (!row || row.userId !== userId || Number(row.e2ee) !== 1) {
		return c.json(result.ok({ stored: 0 }));
	}
	const stored = await blindIndexService.storeTokens(c, id, userId, tokens);
	return c.json(result.ok({ stored }));
});

// 盲索引搜索：{ token } → 命中信的 id 列表（只限本人 E2EE 信）。
// 前端再按 id 拉取列表（列表接口本身会过滤混淆未生效与时间锁未解锁的信）。
app.post('/my/blind-search', async (c) => {
	const userId = userContext.getUserId(c);
	if (userContext.isDecoy(c)) {
		return c.json(result.ok({ emailIds: [] }));
	}
	const { token } = await c.req.json().catch(() => ({}));
	const emailIds = await blindIndexService.searchIds(c, userId, token);
	return c.json(result.ok({ emailIds }));
});
