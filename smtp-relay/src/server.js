// SMTP 守护进程：只做协议适配，不自造发信链路。
// 监听 127.0.0.1:2525（明文 + STARTTLS，Tunnel 侧）；可选 465 隐式 TLS 监听。
// 25 端口永不监听（config.js 校验拦截；收信走 Email Routing）。
// 支持 EHLO/HELO、STARTTLS、AUTH LOGIN/PLAIN、MAIL FROM、RCPT TO、DATA、RSET、NOOP、QUIT；
// VRFY/EXPN 拒绝（502）；STARTTLS 之前 AUTH 直接 530（tls.requireTlsForAuth=true 时）。
//
// 流程：AUTH → 调 Worker POST /login 现验现忘（密码不落盘、不缓存），只缓存短期 JWT
// （内存，TTL ≤ 1 小时，默认 30 分钟）+ accountId；DATA 后 mailparser 解析 MIME，
// 映射成 POST /email/send 参数发给 Worker；角色次数、Resend 配额、渠道优先级全部由
// Worker 的 email-service.send() 执行，SMTP 发信与网页发信计同一配额。
import net from 'node:net';
import tls from 'node:tls';
import { WorkerError } from './worker-api.js';
import { parseMailToSendPayload, isEmail } from './mail.js';

const CRLF = '\r\n';
const MAX_LINE = 1000;

function base64Decode(s) {
  try {
    return Buffer.from(String(s || '').trim(), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/** 从 "MAIL FROM:<a@b.c> SIZE=123" 这类命令里抠出尖括号内地址。 */
export function parseAddressArg(arg) {
  const m = String(arg || '').match(/<\s*([^<>]+)\s*>/);
  if (m) return m[1].trim();
  // 裸地址兜底（如 "MAIL FROM:a@b.c"）
  const m2 = String(arg || '').trim().match(/^([^\s:]+:[^\s]+|[^\s]+)$/);
  return m2 ? m2[1].replace(/^[A-Za-z]+:/, '').trim() : '';
}

export class SmtpServer {
  constructor({
    config,
    workerApi,
    rateLimiter,
    telegram = null,
    logger = console,
    tlsOptions = null, // {key, cert}；tls.enabled 时必填
  }) {
    this.config = config;
    this.workerApi = workerApi;
    this.rateLimiter = rateLimiter;
    this.telegram = telegram;
    this.logger = logger;
    this.tlsOptions = tlsOptions;
    this.servers = [];
    this.sessions = new Map(); // email(lower) -> {token, accountId, expiresAt}
    this.alertedBlocks = new Map(); // ip -> 上次封禁告警时间戳（去重）
  }

  get host() {
    return this.config.server.host;
  }

  get port() {
    return this.config.server.port;
  }

  get hostname() {
    return this.config.server.hostname;
  }

  get tlsEnabled() {
    return !!this.config.tls.enabled;
  }

  get requireTlsForAuth() {
    return this.config.tls.requireTlsForAuth !== false;
  }

  async start() {
    const plain = net.createServer((socket) => this.handleConnection(socket, false));
    await this.listen(plain, this.port);
    this.servers.push(plain);
    this.logger.info(`SMTP relay listening on ${this.host}:${this.port} (STARTTLS ${this.tlsEnabled ? 'on' : 'off'})`);
    if (this.tlsEnabled && this.config.tls.implicitPort !== null && this.config.tls.implicitPort !== undefined) {
      // implicitPort = 0 表示监听临时端口（测试用）；设为 null 则不启动隐式 TLS 监听。
      const implicit = net.createServer((socket) => {
        const secure = new tls.TLSSocket(socket, {
          isServer: true,
          key: this.tlsOptions.key,
          cert: this.tlsOptions.cert,
        });
        this.handleConnection(secure, true);
      });
      await this.listen(implicit, this.config.tls.implicitPort);
      this.servers.push(implicit);
      this.logger.info(`SMTP relay implicit TLS listening on ${this.host}:${this.config.tls.implicitPort}`);
    }
  }

  listen(server, port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, this.host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  async stop() {
    for (const s of this.servers) {
      await new Promise((resolve) => s.close(() => resolve()));
    }
    this.servers = [];
  }

  handleConnection(socket, isTls) {
    const ip = socket.remoteAddress || 'unknown';
    const conn = new SmtpConnection(this, socket, ip, isTls);
    conn.start();
  }

  /** JWT 内存缓存（TTL ≤ 1 小时，config 校验已卡上限）。 */
  getCachedSession(email) {
    const entry = this.sessions.get(String(email).toLowerCase());
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.sessions.delete(String(email).toLowerCase());
      return null;
    }
    return entry;
  }

  cacheSession(email, token, accountId) {
    this.sessions.set(String(email).toLowerCase(), {
      token,
      accountId,
      expiresAt: Date.now() + this.config.auth.jwtTtlSeconds * 1000,
    });
  }

  dropSession(email) {
    this.sessions.delete(String(email).toLowerCase());
  }

  /** 封禁 TG 告警（同一 IP 15 分钟内只告警一次，失败永不抛错）。 */
  async alertBlocked(ip, failures) {
    if (!this.telegram || this.config.telegram?.alertOnBlock === false) return;
    const now = Date.now();
    if (now - (this.alertedBlocks.get(ip) ?? 0) < 15 * 60 * 1000) return;
    this.alertedBlocks.set(ip, now);
    try {
      await this.telegram.send(
        `【SMTP 中继】IP ${ip} 因 AUTH 连续失败 ${failures} 次已被临时封禁 ${this.config.auth.blockMinutes} 分钟`,
      );
    } catch {
      // TG 失败永不拖垮主流程
    }
  }
}

class SmtpConnection {
  constructor(server, socket, ip, isTls) {
    this.server = server;
    this.socket = socket;
    this.ip = ip;
    this.tls = !!isTls;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.greeted = false;
    this.pumping = false;
    // 会话态
    this.auth = null; // {email, token, accountId}
    this.authStep = null; // {mechanism, username} AUTH LOGIN 进行中
    this.mailFrom = null;
    this.rcpts = [];
    this.dataMode = false;
    this.dataBuffer = Buffer.alloc(0);
    this.hello = false;
  }

  get log() {
    return this.server.logger;
  }

  start() {
    const deny = this.server.rateLimiter.checkConnection(this.ip);
    if (deny === 'blocked') {
      this.write(`421 4.7.0 Your IP is temporarily blocked, try again later${CRLF}`);
      this.log.info(`CONNECT ip=${this.ip} denied=blocked`);
      this.socket.end();
      return;
    }
    if (deny === 'too-many-connections') {
      this.write(`421 4.7.0 Too many connections from your IP${CRLF}`);
      this.log.info(`CONNECT ip=${this.ip} denied=too-many-connections`);
      this.socket.end();
      return;
    }
    this.server.rateLimiter.addConnection(this.ip);
    this.attachSocket(this.socket);
    this.write(`220 ${this.server.hostname} ESMTP Mail Ultimate SMTP Relay${CRLF}`);
    this.greeted = true;
  }

  attachSocket(socket) {
    this.socket = socket;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
    // 超时也须在 STARTTLS 升级后重设（新 TLSSocket 不继承旧 socket 的定时器）。
    socket.setTimeout(5 * 60 * 1000, () => {
      this.write(`421 4.7.0 Connection timed out${CRLF}`);
      this.close();
    });
  }

  write(s) {
    if (this.closed) return;
    try {
      this.socket.write(s);
    } catch {
      this.close();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.server.rateLimiter.removeConnection(this.ip);
    try {
      this.socket.destroy();
    } catch {
      // ignore
    }
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    void this.pump();
  }

  /** 串行处理缓冲区的行/DATA：保证 DATA 发完 250 后才处理后续命令，避免流水线竞态。 */
  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.closed) break;
        if (this.dataMode) {
          const end = this.buffer.indexOf(Buffer.from(`${CRLF}.${CRLF}`));
          const endAtStart =
            this.buffer.length >= 3 && this.buffer.subarray(0, 3).equals(Buffer.from(`.${CRLF}`));
          if (endAtStart) {
            const raw = this.dataBuffer;
            this.buffer = this.buffer.subarray(3);
            this.dataMode = false;
            this.dataBuffer = Buffer.alloc(0);
            await this.finishData(raw);
            continue;
          }
          if (end === -1) {
            // 未到结束符：把除尾部可能不完整的 "\r\n." 外的全部并入 dataBuffer，并做大小上限检查。
            const keep = Math.min(this.buffer.length, 4);
            const take = this.buffer.subarray(0, this.buffer.length - keep);
            if (take.length) {
              this.dataBuffer = Buffer.concat([this.dataBuffer, take]);
              if (this.dataBuffer.length > this.server.config.server.maxMessageBytes) {
                this.dataMode = false;
                this.dataBuffer = Buffer.alloc(0);
                this.buffer = Buffer.alloc(0);
                this.write(`552 5.3.4 Message too large${CRLF}`);
                this.resetMailState();
                continue;
              }
            }
            this.buffer = this.buffer.subarray(this.buffer.length - keep);
            break;
          }
          const raw = Buffer.concat([this.dataBuffer, this.buffer.subarray(0, end)]);
          this.buffer = this.buffer.subarray(end + 5);
          this.dataMode = false;
          this.dataBuffer = Buffer.alloc(0);
          await this.finishData(raw);
          continue;
        }
        const idx = this.buffer.indexOf(Buffer.from(CRLF));
        if (idx === -1) {
          if (this.buffer.length > MAX_LINE) {
            this.write(`500 5.5.2 Line too long${CRLF}`);
            this.buffer = Buffer.alloc(0);
          }
          break;
        }
        const line = this.buffer.subarray(0, idx).toString('utf8').replace(/\r$/, '');
        // 行尾多余 \r 容错（如客户端误发 \r\r\n）：单字命令 DATA/QUIT 否则会被判未识别。
        this.buffer = this.buffer.subarray(idx + 2);
        await this.handleLine(line);
        if (this.closed) break;
      }
    } finally {
      this.pumping = false;
    }
  }

  async handleLine(line) {
    // AUTH 进行中的续行（用户名/密码的 base64 回复）。
    if (this.authStep) {
      const step = this.authStep;
      this.authStep = null;
      if (step.mechanism === 'LOGIN') {
        if (!step.username) {
          this.authStep = { mechanism: 'LOGIN', username: base64Decode(line) };
          this.write(`334 UGFzc3dvcmQ6${CRLF}`);
          return;
        }
        const password = base64Decode(line);
        await this.doAuth(step.username, password);
        return;
      }
      if (step.mechanism === 'PLAIN') {
        await this.doAuthPlain(line);
        return;
      }
    }

    const [verbRaw, ...rest] = line.split(' ');
    const verb = (verbRaw || '').toUpperCase();
    const arg = rest.join(' ').trim();

    switch (verb) {
      case 'EHLO':
      case 'HELO':
        this.hello = true;
        this.resetMailState();
        this.write(this.ehloResponse(arg));
        break;
      case 'STARTTLS':
        await this.doStartTls();
        break;
      case 'AUTH':
        await this.doAuthCommand(arg);
        break;
      case 'MAIL':
        this.doMailFrom(arg);
        break;
      case 'RCPT':
        this.doRcptTo(arg);
        break;
      case 'DATA':
        this.doData();
        break;
      case 'RSET':
        this.resetMailState();
        this.write(`250 2.0.0 Ok${CRLF}`);
        break;
      case 'NOOP':
        this.write(`250 2.0.0 Ok${CRLF}`);
        break;
      case 'QUIT':
        this.write(`221 2.0.0 Bye${CRLF}`);
        this.socket.end(); // 优雅关闭：flush 完 221 再 FIN，close 事件里做计数清理
        break;
      case 'VRFY':
      case 'EXPN':
        // 拒绝：不泄露账号是否存在。
        this.write(`502 5.5.1 Command not implemented${CRLF}`);
        break;
      case 'HELP':
        this.write(`214 2.0.0 EHLO HELO STARTTLS AUTH MAIL RCPT DATA RSET NOOP QUIT${CRLF}`);
        break;
      case '':
        this.write(`500 5.5.2 Empty command${CRLF}`);
        break;
      default:
        this.write(`500 5.5.2 Command unrecognized${CRLF}`);
    }
  }

  ehloResponse(domain) {
    const host = this.server.hostname;
    const lines = [`250-${host} Hello ${domain || this.ip}`];
    if (this.server.tlsEnabled && !this.tls) lines.push('250-STARTTLS');
    if (!this.server.requireTlsForAuth || this.tls) lines.push('250-AUTH LOGIN PLAIN');
    lines.push(`250-SIZE ${this.server.config.server.maxMessageBytes}`);
    lines.push('250 8BITMIME');
    return lines.join(CRLF) + CRLF;
  }

  async doStartTls() {
    if (this.tls) {
      this.write(`503 5.5.1 TLS already active${CRLF}`);
      return;
    }
    if (!this.server.tlsEnabled || !this.server.tlsOptions) {
      this.write(`454 4.7.0 TLS not available${CRLF}`);
      return;
    }
    this.write(`220 2.0.0 Ready to start TLS${CRLF}`);
    // 把旧 socket 的监听拆掉再包 TLSSocket；已读进 this.buffer 的字节保留（STARTTLS 行本身已消费完）。
    try {
      this.socket.removeAllListeners('data');
      this.socket.removeAllListeners('error');
      this.socket.removeAllListeners('close');
    } catch {
      // ignore
    }
    const secure = new tls.TLSSocket(this.socket, {
      isServer: true,
      key: this.server.tlsOptions.key,
      cert: this.server.tlsOptions.cert,
    });
    this.tls = true;
    this.hello = false; // TLS 升级后客户端须重新 EHLO
    this.attachSocket(secure);
  }

  async doAuthCommand(arg) {
    if (this.server.requireTlsForAuth && !this.tls) {
      // STARTTLS 之前 AUTH 直接 530（强制加密后才允许 AUTH）。
      this.write(`530 5.7.0 Must issue a STARTTLS command first${CRLF}`);
      return;
    }
    const [mechRaw, initialRaw] = arg.split(/\s+/, 2);
    const mech = (mechRaw || '').toUpperCase();
    if (mech === 'LOGIN') {
      if (initialRaw) {
        this.authStep = { mechanism: 'LOGIN', username: base64Decode(initialRaw) };
        this.write(`334 UGFzc3dvcmQ6${CRLF}`);
      } else {
        this.authStep = { mechanism: 'LOGIN', username: '' };
        this.write(`334 VXNlcm5hbWU6${CRLF}`);
      }
      return;
    }
    if (mech === 'PLAIN') {
      if (initialRaw) {
        await this.doAuthPlain(initialRaw);
      } else {
        this.authStep = { mechanism: 'PLAIN' };
        this.write(`334 ${CRLF}`);
      }
      return;
    }
    this.write(`504 5.7.4 Unrecognized authentication type${CRLF}`);
  }

  async doAuthPlain(encoded) {
    const decoded = base64Decode(encoded);
    // PLAIN: [authzid] NUL authcid NUL password
    const parts = decoded.split('\x00');
    const username = parts.length >= 3 ? parts[1] : parts[0];
    const password = parts.length >= 3 ? parts[2] : parts[1] || '';
    await this.doAuth(username, password);
  }

  async doAuth(username, password) {
    const email = String(username || '').trim();
    try {
      if (!email || !password) {
        this.server.rateLimiter.recordAuthFailure(this.ip);
        this.log.auth(this.ip, email || '(empty)', false, 'empty-credentials');
        this.write(`535 5.7.8 Authentication credentials invalid${CRLF}`);
        return;
      }
      // 每小时 AUTH 尝试上限（先记一次，超了直接拒）。
      const cap = this.server.rateLimiter.recordAuthAttempt(this.ip);
      if (cap === 'blocked') {
        this.log.auth(this.ip, email, false, 'ip-blocked');
        this.write(`535 5.7.8 Authentication credentials invalid${CRLF}`);
        return;
      }
      if (cap === 'too-many-attempts') {
        this.log.auth(this.ip, email, false, 'too-many-attempts');
        this.write(`421 4.7.0 Too many authentication attempts, try again later${CRLF}`);
        return;
      }
      // 缓存命中：同一邮箱短期内已验过，直接复用 JWT，不再调 /login（密码现验现忘）。
      const cached = this.server.getCachedSession(email);
      if (cached) {
        this.auth = { email, token: cached.token, accountId: cached.accountId };
        this.server.rateLimiter.recordAuthSuccess(this.ip);
        this.log.auth(this.ip, email, true, 'cached');
        this.write(`235 2.7.0 Authentication successful${CRLF}`);
        return;
      }
      let token;
      try {
        token = await this.server.workerApi.login(email, password);
      } catch (e) {
        const fail = this.server.rateLimiter.recordAuthFailure(this.ip);
        this.log.auth(this.ip, email, false, e.message);
        if (fail.blocked) {
          await this.server.alertBlocked(this.ip, fail.failures);
          this.log.error(`AUTH ip=${this.ip} blocked for ${this.server.config.auth.blockMinutes} min after ${fail.failures} failures`);
        }
        if (e && e.needTotp) {
          this.write(`535 5.7.8 Two-factor authentication required, use webmail${CRLF}`);
        } else {
          this.write(`535 5.7.8 Authentication credentials invalid${CRLF}`);
        }
        return;
      }
      // 登录成功后取发件账号 id（/email/send 必填）。失败则本次 AUTH 不成立。
      let accountId;
      try {
        accountId = await this.server.workerApi.getAccountId(token, email);
      } catch (e) {
        this.log.auth(this.ip, email, false, `account-lookup: ${e.message}`);
        this.write(`535 5.7.8 Authentication credentials invalid${CRLF}`);
        return;
      }
      this.server.cacheSession(email, token, accountId);
      this.server.rateLimiter.recordAuthSuccess(this.ip);
      this.auth = { email, token, accountId };
      this.log.auth(this.ip, email, true);
      this.write(`235 2.7.0 Authentication successful${CRLF}`);
    } finally {
      // 密码只存在于本函数栈帧，返回即释放；绝不写日志、不进缓存。
      password = '';
    }
  }

  doMailFrom(arg) {
    if (!this.auth) {
      this.write(`530 5.7.0 Authentication required${CRLF}`);
      return;
    }
    const m = String(arg).match(/^FROM:\s*(.*)$/i);
    if (!m) {
      this.write(`501 5.5.2 Syntax error in MAIL FROM${CRLF}`);
      return;
    }
    const addr = parseAddressArg(m[1]);
    if (!isEmail(addr)) {
      this.write(`501 5.5.2 Invalid sender address${CRLF}`);
      return;
    }
    // 发件人 FROM 必须是用户自己的 @aevorynthtech.com 邮箱。
    if (addr.toLowerCase() !== this.auth.email.toLowerCase()) {
      this.write(`553 5.7.1 Sender address must match authenticated user${CRLF}`);
      return;
    }
    const domain = addr.split('@')[1].toLowerCase();
    if (!this.server.config.server.allowedDomains.map((d) => d.toLowerCase()).includes(domain)) {
      this.write(`553 5.7.1 Sender domain not allowed${CRLF}`);
      return;
    }
    this.mailFrom = addr;
    this.rcpts = [];
    this.write(`250 2.1.0 Ok${CRLF}`);
  }

  doRcptTo(arg) {
    if (!this.mailFrom) {
      this.write(`503 5.5.1 Need MAIL command first${CRLF}`);
      return;
    }
    const m = String(arg).match(/^TO:\s*(.*)$/i);
    if (!m) {
      this.write(`501 5.5.2 Syntax error in RCPT TO${CRLF}`);
      return;
    }
    const addr = parseAddressArg(m[1]);
    if (!isEmail(addr)) {
      this.write(`501 5.5.2 Invalid recipient address${CRLF}`);
      return;
    }
    if (this.rcpts.length >= this.server.config.server.maxRecipients) {
      this.write(`452 4.5.3 Too many recipients${CRLF}`);
      return;
    }
    this.rcpts.push(addr.toLowerCase());
    this.write(`250 2.1.5 Ok${CRLF}`);
  }

  doData() {
    if (!this.mailFrom || this.rcpts.length === 0) {
      this.write(`503 5.5.1 Need MAIL and RCPT commands first${CRLF}`);
      return;
    }
    this.dataMode = true;
    this.dataBuffer = Buffer.alloc(0);
    this.write(`354 End data with <CR><LF>.<CR><LF>${CRLF}`);
  }

  async finishData(raw) {
    // 去 dot-stuffing：行首 ".." → "."（结束符行本身已在解析时剥离）。
    const text = raw
      .toString('utf8')
      .split(CRLF)
      .map((line) => (line.startsWith('..') ? line.slice(1) : line))
      .join(CRLF);
    const auth = this.auth;
    const mailFrom = this.mailFrom;
    const envelopeRcpts = [...this.rcpts];
    this.resetMailState();
    let payload;
    try {
      payload = await parseMailToSendPayload(Buffer.from(text, 'utf8'), {
        accountId: auth.accountId,
        authEmail: auth.email,
      });
    } catch (e) {
      this.log.error(`DATA parse ip=${this.ip} email=${auth.email}: ${e.message}`);
      // From 与登录账号不一致等映射错误：永久失败，不重试。
      this.write(`550 5.7.1 ${sanitizeReply(e.message)}${CRLF}`);
      return;
    }
    // 信封收件人与 MIME 头收件人合并（客户端可能只填其一）；去重。
    const merged = [...new Set([...payload.receiveEmail, ...envelopeRcpts])];
    payload.receiveEmail = merged;
    try {
      await this.server.workerApi.sendEmail(auth.token, payload);
    } catch (e) {
      if (e instanceof WorkerError) {
        this.log.error(`SEND ip=${this.ip} email=${auth.email}: ${e.message}`);
        if (e.code === 401) {
          // JWT 失效：清缓存，下次连接重新登录。
          this.server.dropSession(auth.email);
          this.auth = null;
          this.write(`535 5.7.8 Authentication expired, please re-login${CRLF}`);
          return;
        }
        if (e.isQuota) {
          // 配额错误透传：回 4xx（452），客户端可稍后重试，但守护进程本身绝不重试。
          this.write(`452 4.2.2 Sending quota exhausted, try again later${CRLF}`);
          return;
        }
        if (e.code >= 400 && e.code < 500) {
          this.write(`550 5.7.1 ${sanitizeReply(e.message)}${CRLF}`);
          return;
        }
        // Worker 5xx / 网络故障：4xx 临时失败，客户端可重试。
        this.write(`451 4.3.0 Temporary failure, please try again later${CRLF}`);
        return;
      }
      this.log.error(`SEND ip=${this.ip} email=${auth.email}: unexpected ${e.message}`);
      this.write(`451 4.3.0 Temporary failure, please try again later${CRLF}`);
      return;
    }
    this.log.info(`SEND ip=${this.ip} email=${auth.email} from=${mailFrom} rcpts=${merged.length} ok`);
    this.write(`250 2.0.0 Ok: queued${CRLF}`);
  }

  resetMailState() {
    this.mailFrom = null;
    this.rcpts = [];
    this.dataMode = false;
    this.dataBuffer = Buffer.alloc(0);
  }
}

/** Worker 的中文报错原样塞进 SMTP 回复前先去掉换行/超长，避免协议注入与超长行。 */
function sanitizeReply(msg) {
  return String(msg || 'Send failed')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 200);
}
