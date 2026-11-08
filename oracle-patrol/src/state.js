// state.json：巡检运行态（与 config.json 同目录，同样进 .gitignore）。
// 内容：lastWafSync / lastWafIpSet、告警去重（quotaAlerts）、AbuseIPDB 缓存（24h）、
// 连续失败次数 consecutiveFailures、失联告警是否已发 offlineAlertSent、lastRun。
// 损坏或缺失时回落默认态；保存用写临时文件 + rename（原子写）。
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export const ABUSE_CACHE_TTL_MS = 24 * 3600 * 1000;

export function defaultState() {
  return {
    version: 1,
    lastRun: null,
    lastWafSync: null,
    lastWafIpSet: [],
    consecutiveFailures: 0,
    offlineAlertSent: false,
    quotaAlerts: {},
    abuseCache: {},
  };
}

export class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = defaultState();
  }

  load() {
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
        this.state = {
          ...defaultState(),
          ...parsed,
          quotaAlerts: { ...(parsed.quotaAlerts || {}) },
          abuseCache: parsed.abuseCache || {},
        };
      }
    } catch (e) {
      // 损坏的 state 不阻断巡检：回落默认态，下次保存时覆盖。
      console.error(`state 读取失败（回落默认态）: ${e.message}`);
      this.state = defaultState();
    }
    return this.state;
  }

  save() {
    try {
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      renameSync(tmp, this.filePath);
    } catch (e) {
      console.error(`state 保存失败: ${e.message}`);
    }
  }

  /** AbuseIPDB 缓存：24h 内命中直接返回，否则返回 null（并清理过期项）。 */
  getAbuse(ip) {
    const entry = this.state.abuseCache[ip];
    if (!entry) return null;
    if (Date.now() - new Date(entry.at).getTime() > ABUSE_CACHE_TTL_MS) {
      delete this.state.abuseCache[ip];
      return null;
    }
    return entry.data;
  }

  setAbuse(ip, data) {
    this.state.abuseCache[ip] = { at: new Date().toISOString(), data };
  }

  pruneAbuse() {
    const now = Date.now();
    for (const [ip, entry] of Object.entries(this.state.abuseCache)) {
      if (now - new Date(entry.at).getTime() > ABUSE_CACHE_TTL_MS) delete this.state.abuseCache[ip];
    }
  }
}
