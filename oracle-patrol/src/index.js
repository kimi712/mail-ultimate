// oracle-patrol 入口：循环巡检。
//   node src/index.js                 循环（默认每 patrol.intervalMinutes 分钟一轮）
//   node src/index.js --once          只跑一轮后退出（失败时 exit 1）
//   node src/index.js --once --dry-run 试运行：不写 Worker/WAF/TG/AbuseIPDB，只读 D1
//   node src/index.js --config /path/config.json   指定配置文件
// 缺配置 / 配置不合法时明确报错并 exit 1，绝不连真实 API。
import { dirname, resolve } from 'node:path';
import { loadConfig, redactConfig, defaultConfigPath } from './config.js';
import { D1Client } from './d1.js';
import { WorkerApi } from './worker-api.js';
import { WafClient } from './waf.js';
import { AbuseIpDb } from './abuseipdb.js';
import { Telegram } from './telegram.js';
import { StateStore } from './state.js';
import { runPatrol } from './patrol.js';

function parseArgs(argv) {
  const args = { once: false, dryRun: false, config: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--once') args.once = true;
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--config' && argv[i + 1]) args.config = argv[++i];
    else if (argv[i].startsWith('--config=')) args.config = argv[i].slice('--config='.length);
    else {
      console.error(`未知参数: ${argv[i]}（可用：--once --dry-run --config <path>）`);
      process.exit(2);
    }
  }
  return args;
}

function buildClients(config, state) {
  const dryRun = !!config.patrol.dryRun;
  const d1 = new D1Client({
    apiToken: config.cloudflare.apiToken,
    accountId: config.cloudflare.accountId,
    databaseId: config.cloudflare.d1DatabaseId,
    ...(config.cloudflare.baseUrl ? { baseUrl: config.cloudflare.baseUrl } : {}),
  });
  const worker = new WorkerApi({
    baseUrl: config.worker.baseUrl,
    email: config.admin.email,
    password: config.admin.password,
    dryRun,
  });
  const waf = new WafClient({
    apiToken: config.cloudflare.apiToken,
    zoneId: config.cloudflare.zoneId,
    ruleName: config.cloudflare.wafRuleName,
    dryRun,
    ...(config.cloudflare.baseUrl ? { baseUrl: config.cloudflare.baseUrl } : {}),
  });
  const abuse = config.abuseipdb?.apiKey
    ? new AbuseIpDb({
        apiKey: config.abuseipdb.apiKey,
        maxAgeInDays: config.abuseipdb.maxAgeInDays,
        minReports: config.abuseipdb.minReports,
        dryRun,
        ...(config.abuseipdb.baseUrl ? { baseUrl: config.abuseipdb.baseUrl } : {}),
        cache: {
          get: (ip) => state.getAbuse(ip),
          set: (ip, data) => state.setAbuse(ip, data),
        },
      })
    : null;
  const telegram = new Telegram({
    botToken: config.telegram.botToken,
    chatId: config.telegram.chatId,
    dryRun,
    ...(config.telegram.baseUrl ? { baseUrl: config.telegram.baseUrl } : {}),
  });
  return { d1, worker, waf, abuse, telegram, fetchImpl: fetch };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let config;
  try {
    config = loadConfig({ configPath: args.config || defaultConfigPath() });
  } catch (e) {
    console.error(`[patrol] ${e.message}`);
    process.exit(1);
  }
  if (args.dryRun) config.patrol.dryRun = true;
  const dryRun = !!config.patrol.dryRun;
  const configDir = dirname(resolve(args.config || defaultConfigPath()));
  const state = new StateStore(resolve(configDir, 'state.json'));
  state.load();
  const clients = buildClients(config, state);

  console.log(
    `[patrol] 启动${dryRun ? '（dry-run：不写 Worker/WAF/TG/AbuseIPDB，只读 D1）' : ''} ` +
      `配置: ${JSON.stringify(redactConfig(config))}`,
  );

  const runOnce = async () => {
    const summary = await runPatrol({ config, ...clients, state, logger: console, now: new Date() });
    console.log(`[patrol] 本轮完成: ${JSON.stringify(summary)}`);
    return summary;
  };

  if (args.once) {
    const summary = await runOnce();
    process.exit(summary.failed ? 1 : 0);
  }

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    console.log('[patrol] 收到停止信号，退出');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    await runOnce();
  } catch (e) {
    console.error(`[patrol] 本轮异常: ${e.message}`);
  }
  const timer = setInterval(async () => {
    try {
      await runOnce();
    } catch (e) {
      console.error(`[patrol] 本轮异常: ${e.message}`);
    }
  }, config.patrol.intervalMinutes * 60 * 1000);
  timer.unref?.();
}

main().catch((e) => {
  console.error(`[patrol] 启动失败: ${e.message}`);
  process.exit(1);
});
