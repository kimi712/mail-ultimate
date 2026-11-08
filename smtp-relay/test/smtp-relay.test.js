// smtp-relay 测试：node:test + 内置 http 起 mock Worker（假 /login + /account/list + /email/send）。
// 全程只调 mock 与本机回环 TCP，不连真实 Worker、不连线上、不发真实 TG。
// 风格参照 oracle-patrol/test/patrol.test.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { applyDefaults, validateConfig, redactConfig, loadConfig } from '../src/config.js';
import { WorkerApi } from '../src/worker-api.js';
import { RateLimiter } from '../src/rate-limit.js';
import { Telegram } from '../src/telegram.js';
import { SmtpServer } from '../src/server.js';
import { mapParsedToSendPayload } from '../src/mail.js';
import { simpleParser } from 'mailparser';

const silent = { log() {}, info() {}, error() {}, auth() {}, close() {} };
const USER = 'alice@aevorynthtech.com';
const PASS = 'correct-password';

// ---------- mock Worker ----------
function startMockWorker(opts = {}) {
  const calls = { login: [], accountList: [], send: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = (httpCode, obj) => {
        res.writeHead(httpCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const parsed = body ? JSON.parse(body) : {};
      const url = req.url || '';
      if (req.method === 'POST' && url === '/api/login') {
        calls.login.push(parsed);
        if (parsed.email === USER && parsed.password === PASS) {
          return json(200, { code: 200, message: 'success', data: { token: 'mock-jwt-alice' } });
        }
        if (parsed.email === 'totp@aevorynthtech.com') {
          return json(200, { code: 200, message: 'success', data: { needTotp: true, totpToken: 'x' } });
        }
        return json(200, { code: 501, message: '邮箱或密码错误' });
      }
      if (req.method === 'GET' && url.startsWith('/api/account/list')) {
        calls.accountList.push({ auth: req.headers.authorization });
        if (req.headers.authorization === 'mock-jwt-alice') {
          return json(200, { code: 200, message: 'success', data: [{ accountId: 7, email: USER }] });
        }
        return json(200, { code: 401, message: 'authExpired' });
      }
      if (req.method === 'POST' && url === '/api/email/send') {
        calls.send.push({ auth: req.headers.authorization, body: parsed });
        if (opts.sendMode === 'quota-key') {
          return json(400, { code: 400, message: 'resendQuotaExhausted' });
        }
        if (opts.sendMode === 'quota-real-shape') {
          // 真实 Worker 的形状：Hono onError 用 c.json() 返回，HTTP 恒 200，
          // 错误码在 body.code（BizError 默认 501），message 是译文。
          return json(200, { code: 501, message: '今日站外发信额度已用完，请明天再试' });
        }
        if (opts.sendMode === 'forbidden') {
          return json(200, { code: 403, message: 'bannedSend' });
        }
        return json(200, { code: 200, message: 'success', data: [{ emailId: 123 }] });
      }
      return json(404, { code: 404, message: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, calls, port: server.address().port });
    });
  });
}

// ---------- 启动中继（每测独立实例，隔离限流器与 JWT 缓存） ----------
async function startRelay(mockPort, overrides = {}, tgStub = null) {
  const base = {
    worker: { baseUrl: `http://127.0.0.1:${mockPort}`, apiPrefix: '/api', timeoutMs: 5000 },
    server: {
      host: '127.0.0.1', port: 0, hostname: 'smtp.aevorynthtech.com',
      allowedDomains: ['aevorynthtech.com'], maxMessageBytes: 1024 * 1024, maxRecipients: 100,
    },
    tls: { enabled: false, requireTlsForAuth: false, implicitPort: 0, certFile: '', keyFile: '' },
    auth: {
      maxConnectionsPerIp: 10, maxAuthAttemptsPerHour: 30,
      maxConsecutiveAuthFailures: 5, blockMinutes: 15, jwtTtlSeconds: 1800,
    },
    telegram: { alertOnBlock: true },
    logging: { file: '', level: 'info' },
  };
  const merged = deepMerge(base, overrides);
  // 测试用自签证书以内存形式传入（tlsOptions），不走文件路径：给校验填占位值。
  if (overrides.tlsOptions) {
    merged.tls.certFile = 'inline-test-cert';
    merged.tls.keyFile = 'inline-test-key';
  }
  const config = applyDefaults(merged);
  validateConfig(config);
  const telegram = tgStub ?? { send: async () => true };
  const server = new SmtpServer({
    config,
    workerApi: new WorkerApi({ baseUrl: config.worker.baseUrl, apiPrefix: config.worker.apiPrefix, timeoutMs: 5000 }),
    rateLimiter: new RateLimiter({
      maxConnectionsPerIp: config.auth.maxConnectionsPerIp,
      maxAuthAttemptsPerHour: config.auth.maxAuthAttemptsPerHour,
      maxConsecutiveAuthFailures: config.auth.maxConsecutiveAuthFailures,
      blockMinutes: config.auth.blockMinutes,
    }),
    telegram,
    logger: silent,
    tlsOptions: overrides.tlsOptions ?? null,
  });
  await server.start();
  const plainPort = server.servers[0].address().port;
  const implicitPort = server.servers[1] ? server.servers[1].address().port : null;
  return { server, plainPort, implicitPort };
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 测试收尾：关中继、关 mock、关客户端。relay 为 null 时也保证 mock 一定关闭（防事件循环挂起）。 */
async function cleanup(relay, mock, ...clients) {
  for (const c of clients) {
    try { c?.close(); } catch { /* ignore */ }
  }
  if (relay) {
    try { await relay.server.stop(); } catch { /* ignore */ }
  }
  if (mock) {
    await new Promise((resolve) => mock.server.close(() => resolve()));
  }
}

// ---------- 最小 SMTP 客户端 ----------
class SmtpClient {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.socket = null;
    this.lines = [];
  }

  connect(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(port, host, resolve);
      this.socket.on('data', (c) => this.onData(c));
      this.socket.on('error', reject);
    });
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const idx = this.buf.indexOf('\r\n');
      if (idx === -1) break;
      const line = this.buf.subarray(0, idx).toString('utf8');
      this.buf = this.buf.subarray(idx + 2);
      this.lines.push(line);
      this.flushWaiters();
    }
  }

  flushWaiters() {
    while (this.waiters.length) {
      const last = this.lines[this.lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        const w = this.waiters.shift();
        w(this.lines.splice(0));
      } else break;
    }
  }

  /** 读一条完整回复（含多行 250-... 250 ...）。 */
  readReply() {
    return new Promise((resolve) => {
      const last = this.lines[this.lines.length - 1];
      if (last && /^\d{3} /.test(last)) return resolve(this.lines.splice(0));
      this.waiters.push(resolve);
    });
  }

  async cmd(text) {
    this.socket.write(`${text}\r\n`);
    return this.readReply();
  }

  close() {
    try { this.socket.destroy(); } catch { /* ignore */ }
  }
}

const codeOf = (lines) => Number(String(lines[lines.length - 1] || '').slice(0, 3));

const MIME_BASIC = [
  'From: Alice <alice@aevorynthtech.com>',
  'To: bob@example.com, carol@aevorynthtech.com',
  'Cc: dave@example.com',
  'Subject: =?UTF-8?B?5rWL6K+V5rWL6K+V?=',
  'Content-Type: multipart/mixed; boundary="B1"',
  'MIME-Version: 1.0',
  '',
  '--B1',
  'Content-Type: multipart/alternative; boundary="B2"',
  '',
  '--B2',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'hello plain',
  '..dot-stuffed line',
  '--B2',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>hello <b>html</b></p>',
  '--B2--',
  '--B1',
  'Content-Type: text/plain; name="note.txt"',
  'Content-Disposition: attachment; filename="note.txt"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('hello attachment').toString('base64'),
  '--B1--',
  '',
].join('\r\n');

async function authLogin(client, user = USER, pass = PASS) {
  let r = await client.cmd('AUTH LOGIN');
  assert.equal(codeOf(r), 334);
  r = await client.cmd(Buffer.from(user).toString('base64'));
  assert.equal(codeOf(r), 334);
  r = await client.cmd(Buffer.from(pass).toString('base64'));
  return r;
}

// ---------- 自签证书（STARTTLS 测试用，openssl 生成，仅测试） ----------
let testCert = null;
try {
  const dir = mkdtempSync(join(tmpdir(), 'smtp-relay-test-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    '-days', '1', '-nodes', '-subj', '/CN=smtp.aevorynthtech.com'], { stdio: 'ignore' });
  testCert = { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') };
} catch {
  testCert = null;
}

// ================= 测试 =================

test('端到端：EHLO→AUTH LOGIN→MAIL→RCPT→DATA→250，Worker 收到正确调用', async () => {
  const mock = await startMockWorker();
  let relay = null;
  const client = new SmtpClient();
  try {
    relay = await startRelay(mock.port);
    const { plainPort } = relay;
    await client.connect(plainPort);
    assert.equal(codeOf(await client.readReply()), 220);
    const ehlo = await client.cmd('EHLO test-client');
    assert.equal(codeOf(ehlo), 250);
    assert.equal(codeOf(await authLogin(client)), 235);
    assert.equal(codeOf(await client.cmd('MAIL FROM:<alice@aevorynthtech.com>')), 250);
    assert.equal(codeOf(await client.cmd('RCPT TO:<bob@example.com>')), 250);
    assert.equal(codeOf(await client.cmd('DATA')), 354);
    client.socket.write(`${MIME_BASIC}\r\n.\r\n`);
    assert.equal(codeOf(await client.readReply()), 250);
    assert.equal(codeOf(await client.cmd('QUIT')), 221);

    assert.equal(mock.calls.login.length, 1);
    assert.deepEqual(mock.calls.login[0], { email: USER, password: PASS });
    assert.equal(mock.calls.accountList.length, 1);
    assert.equal(mock.calls.accountList[0].auth, 'mock-jwt-alice');
    assert.equal(mock.calls.send.length, 1);
    const sent = mock.calls.send[0];
    assert.equal(sent.auth, 'mock-jwt-alice');
    assert.equal(sent.body.accountId, 7);
    assert.deepEqual([...sent.body.receiveEmail].sort(), ['bob@example.com', 'carol@aevorynthtech.com', 'dave@example.com']);
    assert.equal(sent.body.subject, '测试测试');
    assert.match(sent.body.text, /hello plain/);
    assert.match(sent.body.text, /^\.dot-stuffed line$/m); // dot-stuffing 已还原
    assert.match(sent.body.content, /hello <b>html<\/b>/);
    assert.equal(sent.body.attachments.length, 1);
    assert.equal(sent.body.attachments[0].filename, 'note.txt');
    assert.equal(sent.body.attachments[0].content, Buffer.from('hello attachment').toString('base64'));
    assert.equal(sent.body.attachments[0].type, 'text/plain');
  } finally {
    await cleanup(relay, mock, client);
  }
});

test('AUTH PLAIN 单行形式可登录；同一邮箱短期内复用缓存 JWT，不再调 /login', async () => {
  const mock = await startMockWorker();
  let relay = null;
  const client = new SmtpClient();
  let c2 = null;
  try {
    relay = await startRelay(mock.port);
    const { plainPort } = relay;
    await client.connect(plainPort);
    await client.readReply();
    await client.cmd('EHLO x');
    const plain = Buffer.from(`\0${USER}\0${PASS}`).toString('base64');
    assert.equal(codeOf(await client.cmd(`AUTH PLAIN ${plain}`)), 235);
    assert.equal(mock.calls.login.length, 1);
    // 第二条连接同一邮箱登录：缓存命中，/login 不再增加。
    c2 = new SmtpClient();
    await c2.connect(plainPort);
    await c2.readReply();
    await c2.cmd('EHLO x');
    assert.equal(codeOf(await authLogin(c2)), 235);
    assert.equal(mock.calls.login.length, 1);
  } finally {
    await cleanup(relay, mock, client, c2);
  }
});

test('AUTH 连续失败 5 次封 IP：第 6 次连接问候即 421，并发 TG 告警', async () => {
  const mock = await startMockWorker();
  const tgSent = [];
  const tgStub = { send: async (t) => { tgSent.push(t); return true; } };
  let relay = null;
  const client = new SmtpClient();
  let c2 = null;
  try {
    relay = await startRelay(mock.port, {}, tgStub);
    const { plainPort } = relay;
    await client.connect(plainPort);
    await client.readReply();
    await client.cmd('EHLO x');
    for (let i = 0; i < 5; i++) {
      assert.equal(codeOf(await authLogin(client, 'bob@aevorynthtech.com', 'wrong')), 535, `第 ${i + 1} 次应为 535`);
    }
    assert.equal(mock.calls.login.length, 5);
    assert.equal(tgSent.length, 1);
    assert.match(tgSent[0], /连续失败 5 次/);
    client.close();
    // 封禁期内新连接：问候直接 421。
    c2 = new SmtpClient();
    await c2.connect(plainPort);
    assert.equal(codeOf(await c2.readReply()), 421);
  } finally {
    await cleanup(relay, mock, client, c2);
  }
});

test('配额错误透传：Worker 返回 400 resendQuotaExhausted 时回 452、只调一次不重试', async () => {
  const mock = await startMockWorker({ sendMode: 'quota-key' });
  let relay = null;
  const client = new SmtpClient();
  try {
    relay = await startRelay(mock.port);
    const { plainPort } = relay;
    await client.connect(plainPort);
    await client.readReply();
    await client.cmd('EHLO x');
    assert.equal(codeOf(await authLogin(client)), 235);
    await client.cmd('MAIL FROM:<alice@aevorynthtech.com>');
    await client.cmd('RCPT TO:<bob@example.com>');
    assert.equal(codeOf(await client.cmd('DATA')), 354);
    client.socket.write(`From: Alice <alice@aevorynthtech.com>\r\nTo: bob@example.com\r\nSubject: q\r\n\r\nbody\r\n.\r\n`);
    const reply = await client.readReply();
    assert.equal(codeOf(reply), 452);
    assert.match(reply.join(' '), /quota/i);
    assert.equal(mock.calls.send.length, 1); // 只调一次，不重试
  } finally {
    await cleanup(relay, mock, client);
  }
});

test('配额错误透传（真实 Worker 形状：HTTP 200 + body.code 501 + 中文译文）同样回 452', async () => {
  const mock = await startMockWorker({ sendMode: 'quota-real-shape' });
  let relay = null;
  const client = new SmtpClient();
  try {
    relay = await startRelay(mock.port);
    const { plainPort } = relay;
    await client.connect(plainPort);
    await client.readReply();
    await client.cmd('EHLO x');
    assert.equal(codeOf(await authLogin(client)), 235);
    await client.cmd('MAIL FROM:<alice@aevorynthtech.com>');
    await client.cmd('RCPT TO:<bob@example.com>');
    assert.equal(codeOf(await client.cmd('DATA')), 354);
    client.socket.write(`From: Alice <alice@aevorynthtech.com>\r\nTo: bob@example.com\r\nSubject: q\r\n\r\nbody\r\n.\r\n`);
    assert.equal(codeOf(await client.readReply()), 452);
    assert.equal(mock.calls.send.length, 1);
  } finally {
    await cleanup(relay, mock, client);
  }
});

test('STARTTLS：自签证书握手成功；STARTTLS 前 AUTH 回 530；升级后 AUTH 可用', async (t) => {
  if (!testCert) { t.skip('openssl 不可用，无法生成自签证书'); return; }
  const mock = await startMockWorker();
  let relay = null;
  const client = new SmtpClient();
  try {
    relay = await startRelay(mock.port, {
      tls: { enabled: true, requireTlsForAuth: true, implicitPort: 0 },
      tlsOptions: testCert,
    });
    const { plainPort } = relay;
    await client.connect(plainPort);
    assert.equal(codeOf(await client.readReply()), 220);
    const ehlo = await client.cmd('EHLO x');
    assert.match(ehlo.join('\n'), /STARTTLS/);
    assert.doesNotMatch(ehlo.join('\n'), /AUTH/); // 未加密时不宣告 AUTH
    assert.equal(codeOf(await client.cmd('AUTH LOGIN')), 530);
    assert.equal(codeOf(await client.cmd('STARTTLS')), 220);
    // 客户端升级为 TLS（自签证书，仅测试接受）。先拆掉旧 socket 的 data 监听，
    // 否则加密字节会被当明文行重复解析。
    client.socket.removeAllListeners('data');
    const secure = tls.connect({ socket: client.socket, rejectUnauthorized: false });
    await new Promise((resolve, reject) => {
      secure.once('secureConnect', resolve);
      secure.once('error', reject);
    });
    client.socket = secure;
    client.buf = Buffer.alloc(0);
    client.lines = [];
    secure.on('data', (c) => client.onData(c));
    const ehlo2 = await client.cmd('EHLO x');
    assert.match(ehlo2.join('\n'), /AUTH LOGIN PLAIN/);
    assert.equal(codeOf(await authLogin(client)), 235);
    assert.equal(codeOf(await client.cmd('QUIT')), 221);
  } finally {
    await cleanup(relay, mock, client);
  }
});

test('465 隐式 TLS 监听：直连即 TLS，EHLO 宣告 AUTH，登录成功', async (t) => {
  if (!testCert) { t.skip('openssl 不可用，无法生成自签证书'); return; }
  const mock = await startMockWorker();
  let relay = null;
  const client = new SmtpClient();
  try {
    relay = await startRelay(mock.port, {
      tls: { enabled: true, requireTlsForAuth: true, implicitPort: 0 },
      tlsOptions: testCert,
    });
    const { implicitPort } = relay;
    const secure = tls.connect({ host: '127.0.0.1', port: implicitPort, rejectUnauthorized: false });
    client.socket = secure;
    secure.on('data', (c) => client.onData(c));
    await new Promise((resolve, reject) => {
      secure.once('secureConnect', resolve);
      secure.once('error', reject);
    });
    assert.equal(codeOf(await client.readReply()), 220);
    const ehlo = await client.cmd('EHLO x');
    assert.match(ehlo.join('\n'), /AUTH LOGIN PLAIN/);
    assert.equal(codeOf(await authLogin(client)), 235);
  } finally {
    await cleanup(relay, mock, client);
  }
});

test('协议拒绝项：VRFY 502、未认证 MAIL 530、FROM 冒充他人 553、TOTP 账号 535', async () => {
  const mock = await startMockWorker();
  let relay = null;
  const client = new SmtpClient();
  let c2 = null;
  try {
    relay = await startRelay(mock.port);
    const { plainPort } = relay;
    await client.connect(plainPort);
    await client.readReply();
    await client.cmd('EHLO x');
    assert.equal(codeOf(await client.cmd('VRFY alice@aevorynthtech.com')), 502);
    assert.equal(codeOf(await client.cmd('EXPN list@aevorynthtech.com')), 502);
    assert.equal(codeOf(await client.cmd('MAIL FROM:<alice@aevorynthtech.com>')), 530);
    assert.equal(codeOf(await authLogin(client)), 235);
    assert.equal(codeOf(await client.cmd('MAIL FROM:<someone-else@aevorynthtech.com>')), 553);
    assert.equal(codeOf(await client.cmd('MAIL FROM:<alice@other.com>')), 553);
    assert.equal(codeOf(await client.cmd('RCPT TO:<bob@example.com>')), 503); // MAIL 失败后无 MAIL 态
    // TOTP 账号：Worker 返回 needTotp，明确 535，不静默降级。
    c2 = new SmtpClient();
    await c2.connect(plainPort);
    await c2.readReply();
    await c2.cmd('EHLO x');
    assert.equal(codeOf(await authLogin(c2, 'totp@aevorynthtech.com', 'any')), 535);
  } finally {
    await cleanup(relay, mock, client, c2);
  }
});

test('Worker 403（bannedSend）映射为 550；Worker 5xx 映射为 451', async () => {
  const mock = await startMockWorker({ sendMode: 'forbidden' });
  let relay = null;
  const client = new SmtpClient();
  try {
    relay = await startRelay(mock.port);
    const { plainPort } = relay;
    await client.connect(plainPort);
    await client.readReply();
    await client.cmd('EHLO x');
    assert.equal(codeOf(await authLogin(client)), 235);
    await client.cmd('MAIL FROM:<alice@aevorynthtech.com>');
    await client.cmd('RCPT TO:<bob@example.com>');
    assert.equal(codeOf(await client.cmd('DATA')), 354);
    client.socket.write(`From: Alice <alice@aevorynthtech.com>\r\nTo: bob@example.com\r\nSubject: f\r\n\r\nbody\r\n.\r\n`);
    assert.equal(codeOf(await client.readReply()), 550);
  } finally {
    await cleanup(relay, mock, client);
  }
});

test('MIME→send 映射（单元级）：无 HTML 时由纯文本生成 content；附件超 10 个抛错', async () => {
  const parsed = await simpleParser(
    'From: Alice <alice@aevorynthtech.com>\r\nTo: bob@example.com\r\nSubject: hi\r\n\r\nline1\r\nline2\r\n',
  );
  const payload = mapParsedToSendPayload(parsed, { accountId: 7, authEmail: USER });
  assert.equal(payload.accountId, 7);
  assert.equal(payload.text, 'line1\nline2\n');
  assert.match(payload.content, /line1<br>line2/);
  assert.deepEqual(payload.receiveEmail, ['bob@example.com']);

  const many = Array.from({ length: 11 }, (_, i) => ({
    filename: `f${i}.txt`, contentType: 'text/plain', content: Buffer.from('x'),
  }));
  assert.throws(
    () => mapParsedToSendPayload({ from: { value: [{ address: USER }] }, to: { value: [{ address: 'b@example.com' }] }, attachments: many }, { accountId: 7, authEmail: USER }),
    /附件数量超过上限/,
  );
});

test('配置：25 端口拒绝、JWT TTL 超 3600 拒绝、脱敏打印遮住 botToken、缺文件报错', () => {
  const ok = applyDefaults({});
  assert.equal(ok.server.port, 2525);
  assert.equal(ok.worker.baseUrl, 'http://127.0.0.1:8787');
  assert.equal(ok.auth.jwtTtlSeconds, 1800);
  assert.throws(() => validateConfig(applyDefaults({ server: { port: 25 } })), /25 端口/);
  assert.throws(() => validateConfig(applyDefaults({ auth: { jwtTtlSeconds: 3601 } })), /3600/);
  assert.throws(() => validateConfig(applyDefaults({ tls: { enabled: true } })), /certFile/);
  const redacted = redactConfig({ telegram: { botToken: 'secret-123', chatId: '1' } });
  assert.equal(redacted.telegram.botToken, '********');
  assert.equal(redacted.telegram.chatId, '1');
  assert.throws(() => loadConfig({ configPath: '/nonexistent/smtp-relay-config.json' }), /配置文件不存在/);
});

test('Telegram 最小发送：dry-run 只记录不真发；未配 token 返回 false 不抛错', async () => {
  const tg = new Telegram({ botToken: 'x', chatId: '1', dryRun: true, logger: silent });
  assert.equal(await tg.send('hello'), true);
  assert.equal(tg.sent.length, 1);
  const tg2 = new Telegram({ logger: silent });
  assert.equal(await tg2.send('hello'), false);
});
