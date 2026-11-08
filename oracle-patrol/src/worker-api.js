// Worker API 客户端：登录拿 JWT + 调 /ipBlocklist/add、/alertLog/record、/quota/resend。
// 依据 mail-worker/src/const/constant.js：TOKEN_HEADER = 'Authorization'，
// 前端 axios 直接把裸 token 放进该头（无 "Bearer " 前缀）；
// 登录 POST /login {email, password} 返回 result.ok({token}) 即 {code:200, data:{token}}。
// dry-run 时不发任何写请求（只记录 dryRunCalls 并返回假成功）；GET 配额返回零用量假数据。

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WorkerApi {
  constructor({
    baseUrl,
    email,
    password,
    fetchImpl = fetch,
    dryRun = false,
    logger = console,
    retryAttempts = 3,
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.email = email;
    this.password = password;
    this.fetchImpl = fetchImpl;
    this.dryRun = !!dryRun;
    this.logger = logger;
    this.retryAttempts = retryAttempts;
    this.token = null;
    /** dry-run 下记录到的调用（测试与试运行用），不发真实请求。 */
    this.dryRunCalls = [];
  }

  async login() {
    // 登录只是取 token 的认证调用，不改任何业务状态，dry-run 下也真实执行
    //（否则后续 GET 读请求拿不到合法 token）。
    const res = await this.fetchImpl(`${this.baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.email, password: this.password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code !== 200 || !data.data?.token) {
      throw new Error(`Worker 登录失败: HTTP ${res.status} ${data.message || ''}`.trim());
    }
    this.token = data.data.token;
    return this.token;
  }

  /**
   * 通用请求：401 时重登一次；网络异常 / 5xx 最多重试 retryAttempts 次（指数退避）；
   * 其余 4xx 直接抛错。返回 result.ok 的 data 部分。
   */
  async request(path, { method = 'GET', body = null, auth = true, _retriedAuth = false } = {}) {
    // dry-run：只拦截写请求（POST/PUT/DELETE），读请求（GET）照常执行；
    // 登录（取 token）也不拦截。写请求只记录、不发出。
    if (this.dryRun && method !== 'GET') {
      this.dryRunCalls.push({ path, method, body });
      return { dryRun: true };
    }
    if (auth && !this.token) await this.login();
    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      let res;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(auth && this.token ? { Authorization: this.token } : {}),
          },
          ...(body !== null ? { body: JSON.stringify(body) } : {}),
        });
      } catch (e) {
        if (attempt < this.retryAttempts) {
          await sleep(500 * attempt);
          continue;
        }
        throw new Error(`Worker 请求异常 ${method} ${path}: ${e.message}`);
      }
      if (res.status === 401 && auth && !_retriedAuth) {
        this.token = null;
        await this.login();
        return this.request(path, { method, body, auth, _retriedAuth: true });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || (data.code !== undefined && data.code !== 200)) {
        const retryable = res.status >= 500;
        if (retryable && attempt < this.retryAttempts) {
          await sleep(500 * attempt);
          continue;
        }
        throw new Error(
          `Worker 请求失败 ${method} ${path}: HTTP ${res.status} ${data.message || ''}`.trim(),
        );
      }
      return data.data ?? data;
    }
    throw new Error(`Worker 请求失败 ${method} ${path}: 重试耗尽`);
  }

  /** 封禁 IP：scope 0 = 禁注册（巡检只用 0；scope 1 禁访问由人工在后台操作）。 */
  async addIpBlock({ ip, scope = 0, reason = '', expireTime = null }) {
    return this.request('/ipBlocklist/add', {
      method: 'POST',
      body: { ip, scope, reason, expireTime },
    });
  }

  /** 写告警日志：type patrol|quota|waf|system，source 由 Worker 端固定为 patrol。 */
  async recordAlert({ type, text }) {
    return this.request('/alertLog/record', { method: 'POST', body: { type, text } });
  }

  /** Resend 配额：{ day, month, dayBudget, monthBudget }。 */
  async getResendQuota() {
    return this.request('/quota/resend', { method: 'GET' });
  }
}
