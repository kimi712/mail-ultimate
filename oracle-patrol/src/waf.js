// Cloudflare WAF 自定义规则同步（Rulesets API）。
// 已核实（Cloudflare WAF 文档《Create custom rules via API》）：
//   GET /client/v4/zones/{zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint
//   PUT 同地址 —— PUT 会全量替换该 phase 的全部规则，
//   因此必须先 GET 拿到现有规则，保留全部非目标规则原样（含 id），只改目标规则的表达式再 PUT。
// 目标规则按 description === wafRuleName 查找；表达式：
//   http.host eq "aevorynthtech.com" and ip.src in { <IP…> }
// 安全红线：只改目标规则；失败只记日志 + TG 告警，绝不删规则；黑名单为空时不推送（不动现有规则）。
export const WAF_PHASE = 'http_request_firewall_custom';

export function buildExpression(ips, host) {
  const uniq = [...new Set((ips || []).filter(Boolean))].sort();
  return `http.host eq "${host}" and ip.src in { ${uniq.join(' ')} }`;
}

export class WafClient {
  constructor({
    apiToken,
    zoneId,
    ruleName,
    baseUrl = 'https://api.cloudflare.com',
    fetchImpl = fetch,
    dryRun = false,
    logger = console,
  } = {}) {
    this.apiToken = apiToken;
    this.zoneId = zoneId;
    this.ruleName = ruleName;
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.dryRun = !!dryRun;
    this.logger = logger;
    /** dry-run 下记录到的调用（测试与试运行用），不发真实请求。 */
    this.dryRunCalls = [];
  }

  entrypointUrl() {
    return `${this.baseUrl}/client/v4/zones/${this.zoneId}/rulesets/phases/${WAF_PHASE}/entrypoint`;
  }

  headers() {
    return { Authorization: `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' };
  }

  /** 读 entrypoint 规则集；规则集不存在时 CF 返回 404，视为空规则集（后续 PUT 会创建）。 */
  async getEntrypoint() {
    const res = await this.fetchImpl(this.entrypointUrl(), { headers: this.headers() });
    if (res.status === 404) return { rules: [] };
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      const msg =
        (Array.isArray(data.errors) ? data.errors.map((e) => e.message || JSON.stringify(e)).join('; ') : '') ||
        `HTTP ${res.status}`;
      throw new Error(`WAF 读取 entrypoint 失败: ${msg}`);
    }
    return data.result ?? { rules: [] };
  }

  /**
   * 同步目标规则到给定 IP 集。返回 { changed, pushed, skipped?, dryRun?, error? }，永不抛错
   * （调用方据此记日志 / 发 TG 告警；WAF 失败不影响 D1 封禁结果）。
   */
  async sync(ips, host) {
    try {
      const list = [...new Set((ips || []).filter(Boolean))].sort();
      if (list.length === 0) {
        return { changed: false, pushed: false, skipped: 'empty' };
      }
      const entry = await this.getEntrypoint();
      const rules = Array.isArray(entry.rules) ? entry.rules : [];
      const expression = buildExpression(list, host);
      const existing = rules.find((r) => r.description === this.ruleName);
      if (existing && existing.expression === expression) {
        return { changed: false, pushed: false };
      }
      const nextRules = rules.map((r) =>
        r.description === this.ruleName
          ? { ...r, expression, action: 'block', enabled: true }
          : r,
      );
      if (!existing) {
        nextRules.push({ description: this.ruleName, expression, action: 'block', enabled: true });
      }
      if (this.dryRun) {
        this.dryRunCalls.push({ rules: nextRules });
        this.logger.log(`[dry-run][WAF] 将推送规则 ${this.ruleName}：${expression}`);
        return { changed: true, pushed: false, dryRun: true };
      }
      const res = await this.fetchImpl(this.entrypointUrl(), {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify({ rules: nextRules }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        const msg =
          (Array.isArray(data.errors)
            ? data.errors.map((e) => e.message || JSON.stringify(e)).join('; ')
            : '') || `HTTP ${res.status}`;
        return { changed: true, pushed: false, error: `WAF 推送失败: ${msg}` };
      }
      return { changed: true, pushed: true };
    } catch (e) {
      return { changed: false, pushed: false, error: `WAF 同步异常: ${e.message}` };
    }
  }
}
