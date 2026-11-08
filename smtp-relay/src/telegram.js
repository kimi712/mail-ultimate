// Telegram 最小发送函数（复用 oracle-patrol/src/telegram.js 的约定：
// 直调 Bot API，失败永不抛错，不拖垮主流程；dry-run 只记录不真发）。
// 配置名复用巡检的 tgBotToken/tgChatId（此处为 telegram.botToken / telegram.chatId）。
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
    if (!this.botToken || !this.chatId) {
      this.logger.log(`[TG 未配置，跳过告警] ${text}`);
      return false;
    }
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
