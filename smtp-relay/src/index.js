// smtp-relay 入口：读配置 → 起 SMTP 守护进程。用法：
//   cp config.example.json config.json   # 填真实值（本地 wrangler dev 默认 http://127.0.0.1:8787）
//   npm start
// 信号 SIGINT/SIGTERM 优雅停服；配置缺失/证书读不到直接报错退出（exit 1），不带病运行。
import { readFileSync } from 'node:fs';
import { loadConfig, redactConfig } from './config.js';
import { createLogger } from './logger.js';
import { WorkerApi } from './worker-api.js';
import { RateLimiter } from './rate-limit.js';
import { Telegram } from './telegram.js';
import { SmtpServer } from './server.js';

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(`[smtp-relay] 配置错误: ${e.message}`);
    process.exit(1);
  }

  const logger = createLogger({ file: config.logging.file, level: config.logging.level });

  let tlsOptions = null;
  if (config.tls.enabled) {
    try {
      tlsOptions = {
        key: readFileSync(config.tls.keyFile, 'utf8'),
        cert: readFileSync(config.tls.certFile, 'utf8'),
      };
    } catch (e) {
      logger.error(`TLS 证书读取失败: ${e.message}`);
      process.exit(1);
    }
  } else if (config.tls.requireTlsForAuth) {
    // 生产形态要求 TLS；本地无证书联调时把 tls.requireTlsForAuth 设 false（仅开发用，
    // 绝不用于生产——见 SMTP-DEPLOY.md §4）。
    logger.info('TLS 未启用：STARTTLS 不可用，AUTH 仍要求 TLS（requireTlsForAuth=true），本地联调请改配置');
  }

  const workerApi = new WorkerApi({
    baseUrl: config.worker.baseUrl,
    apiPrefix: config.worker.apiPrefix,
    timeoutMs: config.worker.timeoutMs,
  });
  const rateLimiter = new RateLimiter({
    maxConnectionsPerIp: config.auth.maxConnectionsPerIp,
    maxAuthAttemptsPerHour: config.auth.maxAuthAttemptsPerHour,
    maxConsecutiveAuthFailures: config.auth.maxConsecutiveAuthFailures,
    blockMinutes: config.auth.blockMinutes,
  });
  const telegram = new Telegram({
    botToken: config.telegram.botToken,
    chatId: config.telegram.chatId,
    baseUrl: config.telegram.baseUrl,
    logger,
  });

  const server = new SmtpServer({ config, workerApi, rateLimiter, telegram, logger, tlsOptions });

  logger.info(`smtp-relay 启动，配置: ${JSON.stringify(redactConfig(config))}`);

  const shutdown = async (signal) => {
    logger.info(`收到 ${signal}，正在停服…`);
    try {
      await server.stop();
    } finally {
      logger.close();
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  server.start().catch((e) => {
    logger.error(`启动失败: ${e.message}`);
    logger.close();
    process.exit(1);
  });
}

main();
