// Cloudflare D1 REST API 只读查询。
// POST /client/v4/accounts/{account_id}/d1/database/{database_id}/query
// 巡检只读 D1，绝不经 D1 写库（写库唯一入口是 Worker API / CF 在线写）。
export class D1Client {
  constructor({
    apiToken,
    accountId,
    databaseId,
    baseUrl = 'https://api.cloudflare.com',
    fetchImpl = fetch,
    logger = console,
  } = {}) {
    this.apiToken = apiToken;
    this.accountId = accountId;
    this.databaseId = databaseId;
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.logger = logger;
  }

  /** 只读查询，返回 rows 数组（D1 返回 { success, result: [{ results }] }）。 */
  async query(sql, params = []) {
    const url = `${this.baseUrl}/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sql, params }),
      });
    } catch (e) {
      throw new Error(`D1 请求异常: ${e.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      const msg =
        (Array.isArray(data.errors) ? data.errors.map((e) => e.message || JSON.stringify(e)).join('; ') : '') ||
        `HTTP ${res.status}`;
      throw new Error(`D1 查询失败: ${msg}`);
    }
    const first = Array.isArray(data.result) ? data.result[0] : null;
    return first?.results ?? [];
  }
}
