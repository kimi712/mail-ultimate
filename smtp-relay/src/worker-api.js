// Worker API 客户端：SMTP 守护进程唯一允许调的后端接口。
// 只调三个现有接口：POST /login、GET /account/list、POST /email/send。
// 绝不直调 Resend、绝不直写 D1、绝不直调 CF API 发信。
//
// 接口依据（已核实，mail-worker 源码）：
// - POST /login（src/api/login-api.js:6-9）：body {email, password}，
//   成功返回 result.ok({token}) 即 {code:200, message:'success', data:{token}}。
//   注意：Hono 的 onError（src/hono/hono.js:9）用 c.json() 返回错误，HTTP 状态恒为 200，
//   真实错误码在 body.code 里（BizError 默认 501），所以必须按 body.code 判错，不能只看 HTTP 状态。
// - GET /account/list（src/api/account-api.js:6-9）：Authorization 头放裸 token
//   （TOKEN_HEADER='Authorization'，src/const/constant.js:2；前端同款写法见
//   mail-vue/src/request/user.js:18），返回用户名下账号数组，元素含 accountId / email。
// - POST /email/send（src/api/email-api.js:27-30）：body 见 mail.js 的映射说明；
//   成功返回 result.ok(邮件行数组)。

export class WorkerError extends Error {
  /** @param {string} message Worker 返回的 message（原文透传用） */
  constructor(message, code = 0) {
    super(message);
    this.name = 'WorkerError';
    this.code = code;
    this.isQuota = isQuotaMessage(message);
  }
}

/** 配额耗尽判定：按 message 文本识别（与 HTTP/body 码无关）。 */
export function isQuotaMessage(message = '') {
  const m = String(message);
  return (
    m.includes('resendQuotaExhausted') ||
    m.includes('额度已用完') ||
    m.includes('quota') ||
    m.includes('Quota')
  );
}

export class WorkerApi {
  constructor({ baseUrl, apiPrefix = '/api', timeoutMs = 15000, fetchImpl = fetch } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.apiPrefix = apiPrefix.startsWith('/') ? apiPrefix : `/${apiPrefix}`;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async request(path, { method = 'GET', token = null, body = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = token; // 裸 token，不是 Bearer
      const res = await this.fetchImpl(`${this.baseUrl}${this.apiPrefix}${path}`, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      // 成功：body.code === 200（HTTP 状态不可信，见文件头注释）。
      if (data && data.code === 200) return data.data ?? {};
      const message = (data && data.message) || `Worker HTTP ${res.status}`;
      throw new WorkerError(String(message), (data && data.code) || res.status);
    } catch (e) {
      if (e instanceof WorkerError) throw e;
      if (e.name === 'AbortError') throw new WorkerError(`Worker 请求超时（${this.timeoutMs}ms）`, 504);
      throw new WorkerError(`Worker 请求失败: ${e.message}`, 502);
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST /login：用户名 = 完整邮箱地址，密码 = 站内密码。成功返回 JWT（字符串）。 */
  async login(email, password) {
    const data = await this.request('/login', { method: 'POST', body: { email, password } });
    // 第六阶段契约：用户开启 TOTP 时 /login 返回 {needTotp:true, totpToken} 而不是 token。
    // SMTP 客户端走不了二次验证页，明确拒掉（535），不在此静默降级。
    if (data && data.needTotp) {
      const err = new WorkerError('该账号已开启二次验证（TOTP），SMTP 暂不支持，请用网页端发信', 401);
      err.needTotp = true;
      throw err;
    }
    if (!data || typeof data.token !== 'string' || !data.token) {
      throw new WorkerError('Worker 登录返回异常：无 token', 502);
    }
    return data.token;
  }

  /** GET /account/list：按邮箱找账号，返回 accountId（/email/send 必填）。 */
  async getAccountId(token, email) {
    const list = await this.request('/account/list?size=30', { token });
    const rows = Array.isArray(list) ? list : list?.list || [];
    const row = rows.find((r) => String(r.email || '').toLowerCase() === String(email).toLowerCase());
    if (!row || typeof row.accountId !== 'number') {
      throw new WorkerError(`未找到该邮箱对应的发件账号: ${email}`, 404);
    }
    return row.accountId;
  }

  /** POST /email/send：payload 格式见 mail.js（与 email-service.js 的 send() 入参一致）。 */
  async sendEmail(token, payload) {
    return this.request('/email/send', { method: 'POST', token, body: payload });
  }
}
