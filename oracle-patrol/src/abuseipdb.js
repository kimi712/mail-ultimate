// AbuseIPDB 查询：GET /api/v2/check?ipAddress=&maxAgeInDays=&verbose=1
// 响应 data：{ totalReports, abuseConfidenceScore, lastReportedAt, countryCode,
//   reports: [{ categories: [数字…], reportedAt }] }（verbose=1 时含 reports）。
// 免费额度 1000 次/天：结果缓存 24h（经 state.js 写 state.json），缓存命中不调接口。
// dry-run 时不调 AbuseIPDB（返回 null，调用方跳过本步）。

export const ABUSE_CATEGORIES = {
  1: 'DNS 劫持',
  2: 'DNS 投毒',
  3: '欺诈订单',
  4: 'DDoS 攻击',
  5: 'FTP 暴力破解',
  6: 'Ping of Death',
  7: '钓鱼',
  8: 'VoIP 欺诈',
  9: '开放代理',
  10: 'Web 垃圾',
  11: '邮件垃圾',
  12: '博客垃圾',
  13: 'VPN 出口',
  14: '端口扫描',
  15: '入侵',
  16: 'SQL 注入',
  17: '欺骗',
  18: '暴力破解',
  19: '恶意爬虫',
  20: '被利用主机',
  21: 'Web 应用攻击',
  22: 'SSH 攻击',
  23: 'IoT 攻击',
};

export class AbuseIpDb {
  constructor({
    apiKey,
    maxAgeInDays = 90,
    minReports = 1,
    baseUrl = 'https://api.abuseipdb.com',
    fetchImpl = fetch,
    cache = null,
    dryRun = false,
    logger = console,
  } = {}) {
    this.apiKey = apiKey;
    this.maxAgeInDays = maxAgeInDays;
    this.minReports = minReports;
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.cache = cache; // { get(ip) -> data|null, set(ip, data) }
    this.dryRun = !!dryRun;
    this.logger = logger;
  }

  /** 返回 null 表示跳过（dry-run）；否则返回 { ip, totalReports, abuseConfidenceScore, lastReportedAt, countryCode, categories, categoryIds }。 */
  async check(ip) {
    if (this.dryRun) {
      this.logger.log(`[dry-run][AbuseIPDB] 跳过查询 ${ip}`);
      return null;
    }
    if (this.cache) {
      const hit = this.cache.get(ip);
      if (hit) return hit;
    }
    const url =
      `${this.baseUrl}/api/v2/check?ipAddress=${encodeURIComponent(ip)}` +
      `&maxAgeInDays=${this.maxAgeInDays}&verbose=1`;
    const res = await this.fetchImpl(url, {
      headers: { Key: this.apiKey, Accept: 'application/json' },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.data) {
      throw new Error(
        `AbuseIPDB 查询失败 ${ip}: HTTP ${res.status} ${data.errors?.[0]?.detail || ''}`.trim(),
      );
    }
    const d = data.data;
    const categoryIds = [
      ...new Set([
        ...(Array.isArray(d.reports) ? d.reports.flatMap((r) => r.categories || []) : []),
        ...(Array.isArray(d.categories) ? d.categories : []),
      ]),
    ];
    const out = {
      ip,
      totalReports: Number(d.totalReports || 0),
      abuseConfidenceScore: Number(d.abuseConfidenceScore || 0),
      lastReportedAt: d.lastReportedAt || null,
      countryCode: d.countryCode || null,
      categories: categoryIds.map((id) => ABUSE_CATEGORIES[id] || `类别#${id}`),
      categoryIds,
    };
    if (this.cache) this.cache.set(ip, out);
    return out;
  }
}
