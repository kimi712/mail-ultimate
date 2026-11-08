// oracle-patrol 配置加载与校验。
// 规则：绝不在日志里打印任何密钥原文；真实配置只放 config.json（已进 .gitignore），
// 示例文件 config.example.json 只放 YOUR_xxx 占位符。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_KEYS = new Set(['apiToken', 'password', 'apiKey', 'botToken']);

export function defaultConfigPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'config.json');
}

/** 读配置 + 环境变量覆盖 + 默认值 + 校验必填。缺配置/缺必填直接抛错（调用方打印后退出）。 */
export function loadConfig({ configPath = defaultConfigPath(), env = process.env } = {}) {
  if (!existsSync(configPath)) {
    throw new Error(
      `巡检配置文件不存在: ${configPath}。请复制 config.example.json 为 config.json 并填入真实值（切勿提交真实配置到 Git）；仅试运行可用 --dry-run + mock 配置。`,
    );
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`配置文件解析失败 ${configPath}: ${e.message}`);
  }
  const cfg = applyEnvOverrides(raw, env);
  applyDefaults(cfg);
  validateConfig(cfg);
  return cfg;
}

/** 环境变量覆盖（优先级高于 config.json；密码优先读环境变量）。 */
export function applyEnvOverrides(cfg, env = process.env) {
  const c = cfg ?? {};
  c.cloudflare = c.cloudflare ?? {};
  c.worker = c.worker ?? {};
  c.admin = c.admin ?? {};
  c.abuseipdb = c.abuseipdb ?? {};
  c.telegram = c.telegram ?? {};
  c.patrol = c.patrol ?? {};
  const set = (obj, key, value) => {
    if (value !== undefined && value !== '') obj[key] = value;
  };
  set(c.cloudflare, 'apiToken', env.CF_API_TOKEN);
  set(c.cloudflare, 'accountId', env.CF_ACCOUNT_ID);
  set(c.cloudflare, 'zoneId', env.CF_ZONE_ID);
  set(c.cloudflare, 'd1DatabaseId', env.CF_D1_DATABASE_ID);
  set(c.cloudflare, 'wafRuleName', env.CF_WAF_RULE_NAME);
  // 仅测试/试运行用：把 CF / TG / AbuseIPDB 指向本地 mock（默认官方地址，生产不用填）。
  set(c.cloudflare, 'baseUrl', env.CF_API_BASE_URL);
  set(c.telegram, 'baseUrl', env.TG_API_BASE_URL);
  set(c.abuseipdb, 'baseUrl', env.ABUSEIPDB_API_BASE_URL);
  set(c.worker, 'baseUrl', env.WORKER_BASE_URL);
  set(c.admin, 'email', env.MAIL_PATROL_ADMIN_EMAIL);
  set(c.admin, 'password', env.MAIL_PATROL_ADMIN_PASSWORD);
  set(c.abuseipdb, 'apiKey', env.ABUSEIPDB_API_KEY);
  set(c.telegram, 'botToken', env.TG_BOT_TOKEN);
  set(c.telegram, 'chatId', env.TG_CHAT_ID);
  if (env.KUMA_PUSH_URL !== undefined) c.kumaPushUrl = env.KUMA_PUSH_URL;
  if (env.PATROL_DRY_RUN !== undefined) {
    c.patrol.dryRun = env.PATROL_DRY_RUN === 'true' || env.PATROL_DRY_RUN === '1';
  }
  return c;
}

export function applyDefaults(cfg) {
  cfg.cloudflare = cfg.cloudflare ?? {};
  cfg.worker = cfg.worker ?? {};
  cfg.admin = cfg.admin ?? {};
  cfg.abuseipdb = cfg.abuseipdb ?? {};
  cfg.telegram = cfg.telegram ?? {};
  cfg.patrol = cfg.patrol ?? {};
  if (cfg.abuseipdb.maxAgeInDays === undefined) cfg.abuseipdb.maxAgeInDays = 90;
  if (cfg.abuseipdb.minReports === undefined) cfg.abuseipdb.minReports = 1;
  if (cfg.patrol.intervalMinutes === undefined) cfg.patrol.intervalMinutes = 5;
  if (cfg.patrol.regWindowHours === undefined) cfg.patrol.regWindowHours = 24;
  if (cfg.patrol.regLimit === undefined) cfg.patrol.regLimit = 3;
  if (cfg.patrol.wafSyncEnabled === undefined) cfg.patrol.wafSyncEnabled = true;
  if (cfg.patrol.dryRun === undefined) cfg.patrol.dryRun = false;
  if (cfg.kumaPushUrl === undefined) cfg.kumaPushUrl = '';
  return cfg;
}

export function validateConfig(cfg) {
  const missing = [];
  const need = (value, name) => {
    if (value === undefined || value === null || value === '') missing.push(name);
  };
  need(cfg.cloudflare?.apiToken, 'cloudflare.apiToken');
  need(cfg.cloudflare?.accountId, 'cloudflare.accountId');
  need(cfg.cloudflare?.zoneId, 'cloudflare.zoneId');
  need(cfg.cloudflare?.d1DatabaseId, 'cloudflare.d1DatabaseId');
  need(cfg.cloudflare?.wafRuleName, 'cloudflare.wafRuleName');
  need(cfg.worker?.baseUrl, 'worker.baseUrl');
  need(cfg.admin?.email, 'admin.email');
  need(cfg.admin?.password, 'admin.password（或环境变量 MAIL_PATROL_ADMIN_PASSWORD）');
  need(cfg.telegram?.botToken, 'telegram.botToken');
  need(cfg.telegram?.chatId, 'telegram.chatId');
  if (missing.length) {
    throw new Error(`配置缺失必填项: ${missing.join('、')}。请补全 config.json 或对应环境变量。`);
  }
  if (!/^https?:\/\//.test(cfg.worker.baseUrl)) {
    throw new Error(`worker.baseUrl 必须是 http(s) 地址，当前: ${cfg.worker.baseUrl}`);
  }
  const num = (value, name, min, max) => {
    if (typeof value !== 'number' || Number.isNaN(value) || value < min || (max !== undefined && value > max)) {
      throw new Error(`配置项 ${name} 不合法: ${value}（应为 ${min}~${max ?? '∞'} 的数字）`);
    }
  };
  num(cfg.patrol.intervalMinutes, 'patrol.intervalMinutes', 1);
  num(cfg.patrol.regWindowHours, 'patrol.regWindowHours', 1, 720);
  num(cfg.patrol.regLimit, 'patrol.regLimit', 1);
  num(cfg.abuseipdb.maxAgeInDays, 'abuseipdb.maxAgeInDays', 1, 365);
  num(cfg.abuseipdb.minReports, 'abuseipdb.minReports', 0);
  // AbuseIPDB 未配 key 时不致命：步骤②跳过并记日志（巡检其余步骤照常）。
  return cfg;
}

/** 脱敏打印用：递归把密钥类字段替换为 ********，原对象不动。 */
export function redactConfig(cfg) {
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = SECRET_KEYS.has(k) ? '********' : walk(v);
      }
      return out;
    }
    return value;
  };
  return walk(cfg);
}
