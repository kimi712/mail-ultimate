// 内存态限流与防滥用（守护进程内，进程重启即清零；Worker 侧的角色次数与
// Resend 配额是第二道防线，自动生效）。
// - 每 IP 并发连接上限（默认 10）
// - 每小时 AUTH 尝试上限（默认 30）
// - AUTH 连续失败 N 次（默认 5）临时封该 IP M 分钟（默认 15），内存黑名单 + 记日志
// now 注入用于测试（默认 Date.now）。

export class RateLimiter {
  constructor({
    maxConnectionsPerIp = 10,
    maxAuthAttemptsPerHour = 30,
    maxConsecutiveAuthFailures = 5,
    blockMinutes = 15,
    now = () => Date.now(),
  } = {}) {
    this.maxConnectionsPerIp = maxConnectionsPerIp;
    this.maxAuthAttemptsPerHour = maxAuthAttemptsPerHour;
    this.maxConsecutiveAuthFailures = maxConsecutiveAuthFailures;
    this.blockMs = blockMinutes * 60 * 1000;
    this.now = now;
    this.connections = new Map(); // ip -> 当前连接数
    this.authAttempts = new Map(); // ip -> [时间戳...]（1 小时滑动窗口）
    this.failures = new Map(); // ip -> 连续失败次数
    this.blockedUntil = new Map(); // ip -> 解除封禁时间戳
  }

  /** 该 IP 是否正处临时封禁期（过期自动清）。 */
  isBlocked(ip) {
    const until = this.blockedUntil.get(ip);
    if (!until) return false;
    if (this.now() >= until) {
      this.blockedUntil.delete(ip);
      this.failures.delete(ip);
      return false;
    }
    return true;
  }

  blockedUntilMs(ip) {
    return this.blockedUntil.get(ip) ?? 0;
  }

  /** 连接准入：先查封禁，再查并发上限。返回 null 表示放行，否则为拒绝原因。 */
  checkConnection(ip) {
    if (this.isBlocked(ip)) return 'blocked';
    if ((this.connections.get(ip) ?? 0) >= this.maxConnectionsPerIp) return 'too-many-connections';
    return null;
  }

  addConnection(ip) {
    this.connections.set(ip, (this.connections.get(ip) ?? 0) + 1);
  }

  removeConnection(ip) {
    const n = (this.connections.get(ip) ?? 1) - 1;
    if (n <= 0) this.connections.delete(ip);
    else this.connections.set(ip, n);
  }

  /** AUTH 尝试准入：封禁中或 1 小时内尝试超上限则拒绝。调用成功 AUTH 前先记一次。 */
  recordAuthAttempt(ip) {
    const t = this.now();
    const windowStart = t - 60 * 60 * 1000;
    const list = (this.authAttempts.get(ip) ?? []).filter((ts) => ts > windowStart);
    if (this.isBlocked(ip)) return 'blocked';
    if (list.length >= this.maxAuthAttemptsPerHour) return 'too-many-attempts';
    list.push(t);
    this.authAttempts.set(ip, list);
    return null;
  }

  /** AUTH 成功：清连续失败计数（小时窗口计数保留，防高频重登）。 */
  recordAuthSuccess(ip) {
    this.failures.delete(ip);
  }

  /**
   * AUTH 失败：连续失败达阈值则封 IP。返回 { blocked: boolean }。
   * 封禁后失败计数不清零到解封时（isBlocked 过期自动清）。
   */
  recordAuthFailure(ip) {
    const n = (this.failures.get(ip) ?? 0) + 1;
    this.failures.set(ip, n);
    if (n >= this.maxConsecutiveAuthFailures) {
      this.blockedUntil.set(ip, this.now() + this.blockMs);
      return { blocked: true, failures: n };
    }
    return { blocked: false, failures: n };
  }
}
