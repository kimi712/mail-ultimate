// smtp-relay 配置加载与校验（风格参照 oracle-patrol/src/config.js）。
// 规则：绝不在日志里打印任何密钥原文；真实配置只放 config.json（已进 .gitignore），
// 示例文件 config.example.json 只放 YOUR_xxx 占位符。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_KEYS = new Set(['botToken']);

export function defaultConfigPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'config.json');
}

/** 读配置 + 环境变量覆盖 + 默认值 + 校验必填。缺配置/缺必填直接抛错（调用方打印后退出）。 */
export function loadConfig({ configPath = defaultConfigPath(), env = process.env } = {}) {
  if (!existsSync(configPath)) {
    throw new Error(
      `SMTP 中继配置文件不存在: ${configPath}。请复制 config.example.json 为 config.json 并填入真实值（切勿提交真实配置到 Git）。`,
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

/** 环境变量覆盖（优先级高于 config.json；TG 凭证优先读环境变量）。 */
export function applyEnvOverrides(cfg, env = process.env) {
  const c = cfg ?? {};
  c.worker = c.worker ?? {};
  c.server = c.server ?? {};
  c.tls = c.tls ?? {};
  c.auth = c.auth ?? {};
  c.telegram = c.telegram ?? {};
  c.logging = c.logging ?? {};
  const set = (obj, key, value) => {
    if (value !== undefined && value !== '') obj[key] = value;
  };
  set(c.worker, 'baseUrl', env.WORKER_BASE_URL);
  set(c.worker, 'apiPrefix', env.WORKER_API_PREFIX);
  set(c.server, 'host', env.SMTP_HOST);
  if (env.SMTP_PORT !== undefined) c.server.port = Number(env.SMTP_PORT);
  set(c.server, 'hostname', env.SMTP_HOSTNAME);
  set(c.tls, 'certFile', env.SMTP_TLS_CERT);
  set(c.tls, 'keyFile', env.SMTP_TLS_KEY);
  if (env.SMTP_TLS_ENABLED !== undefined) {
    c.tls.enabled = env.SMTP_TLS_ENABLED === 'true' || env.SMTP_TLS_ENABLED === '1';
  }
  if (env.SMTP_TLS_IMPLICIT_PORT !== undefined) c.tls.implicitPort = Number(env.SMTP_TLS_IMPLICIT_PORT);
  if (env.SMTP_REQUIRE_TLS_FOR_AUTH !== undefined) {
    c.tls.requireTlsForAuth = env.SMTP_REQUIRE_TLS_FOR_AUTH === 'true' || env.SMTP_REQUIRE_TLS_FOR_AUTH === '1';
  }
  set(c.telegram, 'baseUrl', env.TG_API_BASE_URL);
  set(c.telegram, 'botToken', env.TG_BOT_TOKEN);
  set(c.telegram, 'chatId', env.TG_CHAT_ID);
  set(c.logging, 'file', env.SMTP_LOG_FILE);
  return c;
}

export function applyDefaults(cfg) {
  cfg.worker = cfg.worker ?? {};
  cfg.server = cfg.server ?? {};
  cfg.tls = cfg.tls ?? {};
  cfg.auth = cfg.auth ?? {};
  cfg.telegram = cfg.telegram ?? {};
  cfg.logging = cfg.logging ?? {};
  if (cfg.worker.baseUrl === undefined) cfg.worker.baseUrl = 'http://127.0.0.1:8787';
  if (cfg.worker.apiPrefix === undefined) cfg.worker.apiPrefix = '/api';
  if (cfg.worker.timeoutMs === undefined) cfg.worker.timeoutMs = 15000;
  if (cfg.server.host === undefined) cfg.server.host = '127.0.0.1';
  if (cfg.server.port === undefined) cfg.server.port = 2525;
  if (cfg.server.hostname === undefined) cfg.server.hostname = 'smtp.aevorynthtech.com';
  if (!Array.isArray(cfg.server.allowedDomains)) cfg.server.allowedDomains = ['aevorynthtech.com'];
  if (cfg.server.maxMessageBytes === undefined) cfg.server.maxMessageBytes = 10 * 1024 * 1024;
  if (cfg.server.maxRecipients === undefined) cfg.server.maxRecipients = 100;
  if (cfg.tls.enabled === undefined) cfg.tls.enabled = false;
  if (cfg.tls.requireTlsForAuth === undefined) cfg.tls.requireTlsForAuth = true;
  if (cfg.tls.implicitPort === undefined) cfg.tls.implicitPort = 465;
  if (cfg.tls.certFile === undefined) cfg.tls.certFile = '';
  if (cfg.tls.keyFile === undefined) cfg.tls.keyFile = '';
  if (cfg.auth.maxConnectionsPerIp === undefined) cfg.auth.maxConnectionsPerIp = 10;
  if (cfg.auth.maxAuthAttemptsPerHour === undefined) cfg.auth.maxAuthAttemptsPerHour = 30;
  if (cfg.auth.maxConsecutiveAuthFailures === undefined) cfg.auth.maxConsecutiveAuthFailures = 5;
  if (cfg.auth.blockMinutes === undefined) cfg.auth.blockMinutes = 15;
  if (cfg.auth.jwtTtlSeconds === undefined) cfg.auth.jwtTtlSeconds = 1800;
  if (cfg.telegram.baseUrl === undefined) cfg.telegram.baseUrl = 'https://api.telegram.org';
  if (cfg.telegram.alertOnBlock === undefined) cfg.telegram.alertOnBlock = true;
  if (cfg.logging.file === undefined) cfg.logging.file = 'smtp-relay.log';
  if (cfg.logging.level === undefined) cfg.logging.level = 'info';
  return cfg;
}

export function validateConfig(cfg) {
  const missing = [];
  const need = (value, name) => {
    if (value === undefined || value === null || value === '') missing.push(name);
  };
  need(cfg.worker?.baseUrl, 'worker.baseUrl');
  if (!/^https?:\/\//.test(cfg.worker.baseUrl ?? '')) {
    throw new Error(`worker.baseUrl 必须是 http(s) 地址，当前: ${cfg.worker.baseUrl}`);
  }
  // 25 端口永不接受：守护进程是提交中继（587/465），不是 MX 收信。
  if (cfg.server?.port === 25 || cfg.tls?.implicitPort === 25) {
    throw new Error('SMTP 中继禁止监听 25 端口（只做提交，不收信；收信走 Email Routing）。');
  }
  if (cfg.server?.host !== '127.0.0.1' && cfg.server?.host !== '::1') {
    throw new Error(
      `server.host 必须为 127.0.0.1（只接受本机 cloudflared 隧道连接），当前: ${cfg.server.host}`,
    );
  }
  if (cfg.auth?.jwtTtlSeconds > 3600) {
    throw new Error(`auth.jwtTtlSeconds 不得超过 3600 秒（JWT 只缓存短期），当前: ${cfg.auth.jwtTtlSeconds}`);
  }
  const num = (value, name, min, max) => {
    if (typeof value !== 'number' || Number.isNaN(value) || value < min || (max !== undefined && value > max)) {
      throw new Error(`配置项 ${name} 不合法: ${value}（应为 ${min}~${max ?? '∞'} 的数字）`);
    }
  };
  num(cfg.server.port, 'server.port', 0, 65535); // 0 = 临时端口（测试用）
  if (cfg.tls.implicitPort !== null && cfg.tls.implicitPort !== undefined) {
    num(cfg.tls.implicitPort, 'tls.implicitPort', 0, 65535); // 0 = 临时端口（测试用），null = 不启动
  }
  num(cfg.auth.maxConnectionsPerIp, 'auth.maxConnectionsPerIp', 1);
  num(cfg.auth.maxAuthAttemptsPerHour, 'auth.maxAuthAttemptsPerHour', 1);
  num(cfg.auth.maxConsecutiveAuthFailures, 'auth.maxConsecutiveAuthFailures', 1);
  num(cfg.auth.blockMinutes, 'auth.blockMinutes', 1);
  num(cfg.auth.jwtTtlSeconds, 'auth.jwtTtlSeconds', 60, 3600);
  num(cfg.worker.timeoutMs, 'worker.timeoutMs', 1000, 120000);
  // TLS 开启时证书路径必填（生产用 Let's Encrypt，见 SMTP-DEPLOY.md §4）。
  if (cfg.tls?.enabled) {
    need(cfg.tls.certFile, 'tls.certFile（tls.enabled=true 时必填）');
    need(cfg.tls.keyFile, 'tls.keyFile（tls.enabled=true 时必填）');
  }
  // TG 未配不致命：告警跳过并记日志，其余功能照常。
  if (missing.length) {
    throw new Error(`配置缺失必填项: ${missing.join('、')}。请补全 config.json 或对应环境变量。`);
  }
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
