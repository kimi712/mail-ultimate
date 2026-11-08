// Telegram 直调 Bot API。发送失败永不抛错（只记日志 + 返回 false），不拖垮巡检。
// dry-run 时不发真实消息，只记录到 this.sent 并打印。
export class Telegram {
  constructor({
    botToken,
    chatId,
    baseUrl = 'https://api.telegram.org',
    fetchImpl = fetch,
    dryRun = false,
    logger = console,
  } = {}) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.dryRun = !!dryRun;
    this.logger = logger;
    /** 已发送（或 dry-run 下拟发送）的消息记录，测试用。 */
    this.sent = [];
  }

  async send(text) {
    if (this.dryRun) {
      this.sent.push({ text, dryRun: true });
      this.logger.log(`[dry-run][TG] ${text}`);
      return true;
    }
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        this.logger.error(`TG 发送失败: HTTP ${res.status} ${data.description || ''}`.trim());
        return false;
      }
      this.sent.push({ text });
      return true;
    } catch (e) {
      this.logger.error(`TG 发送异常: ${e.message}`);
      return false;
    }
  }
}
