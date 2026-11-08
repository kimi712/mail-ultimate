# 终极版邮箱 · SMTP 中继部署指南（smtp.aevorynthtech.com）

> 状态：**代码与测试已完成，未部署**。部署前先读 §0（有一个入口问题待总协调确认）。
> 新站与老站 **完全隔离**：SMTP 只发 `@aevorynthtech.com` 的信；老站 mail.flame.edu.kg、D1 `cloud-mail`、Worker `cloud-mail` 全程不动。
> 部署形态总则见 `DEPLOY.md`；本文件只讲 SMTP 中继（第五阶段 A 路交付：`smtp-relay/`）。

## 0. 部署前必读：两个必须先搞清的点

### 0.1 TLS 说明（设计勘误：不要再按 PHASE2-4.md §2 的笼统说法理解）

PHASE2-4.md §2.2 曾写“TLS 由 CF 边缘终止，边缘 → 甲骨文走 Tunnel 加密通道”。
**这是错的，必须纠正：**

- **Cloudflare Tunnel 只加密隧道传输本身**（cloudflared ↔ CF 边缘之间那一段），**不替 SMTP 做边缘 TLS 终止**。Tunnel 的公网入口只代理 HTTP(S)；它不会在边缘替你握一个 SMTP STARTTLS，也不会替你出示 `smtp.aevorynthtech.com` 的证书。
- 客户端（Outlook/Thunderbird/手机邮箱）做 STARTTLS（587）或直连 SSL/TLS（465）时，**面对的是 SMTP 守护进程自己的证书**——证书必须由守护进程自己持有、自己续期。
- 因此生产证书方案是：**Let's Encrypt DNS-01（经 CF DNS API）申请**（§4），守护进程启动时读入证书文件；续期后重启服务加载新证书。本地测试可用自签证书（§4.4，仅测试）。

### 0.2 入口问题（待总协调确认，部署前必须先定）

`cloudflared tunnel route dns` 建出的 `smtp.aevorynthtech.com`（CNAME 到 `*.cfargotunnel.com`）
默认只接 HTTP(S) 流量；**Outlook/Thunderbird/手机邮箱直连 587/465 的原始 TCP，在没有 Cloudflare Spectrum
的情况下到不了 Tunnel 入口**（Tunnel 的 TCP 公网入口要走客户端 `cloudflared access tcp`，邮件客户端跑不了它）。
本文件 §6 仍按契约给出 Tunnel 配置（config.yml 片段 + route dns 命令），但**部署前必须先确认以下任一方案**：

| 方案 | 说明 | 状态 |
|---|---|---|
| A. Cloudflare Spectrum（TCP 587/465） | Spectrum 按端口代理原始 TCP，边缘 TLS 由守护进程证书负责（§0.1），Tunnel 只做回源。需单独开通与付费 | ⏳ 待确认是否开通 |
| B. 客户端跑 cloudflared | 用户每台设备装 cloudflared 做 `access tcp`，邮件客户端连本地端口 | ❌ 不可行：手机邮箱/Outlook 用户装不了 |
| C. 587/465 直连甲骨文 IP | 违反 PHASE2-4.md §1.2 中国用户访问硬约束（用户入口不得指向甲骨文 IP，国内可能慢或连不上） | ❌ 不采用 |

**在方案 A 确认之前，不要向用户公布 `smtp.aevorynthtech.com`。** 若最终不用 Spectrum，
SMTP 入口需另行设计（由总协调定），守护进程本身不用改（它只监听 127.0.0.1:2525）。

## 1. 架构：守护进程只是协议适配器

```
Outlook / Thunderbird / 手机邮箱 App
  │  smtp.aevorynthtech.com:587 (STARTTLS) / :465 (隐式 TLS)
  │  （入口见 §0.2；证书是守护进程自己的，见 §0.1）
  ▼
Cloudflare 边缘 ── Cloudflare Tunnel (cloudflared) ──▶ 甲骨文 SMTP 守护进程
                                                              （Node.js，127.0.0.1:2525）
  │  ① SMTP AUTH：调 Worker POST /login 验用户邮箱+密码（现验现忘）
  │  ② 取 accountId：GET /account/list（JWT 放 Authorization 头，裸 token）
  │  ③ 解析 MIME → 调 Worker POST /email/send（用户本人 JWT）
  ▼
Worker（现有 email-service.send() 全套检查：角色发信次数、Resend 配额、渠道优先级）
  │  发信成功后 Resend 用量自动计数（send() 内已有 recordResendSent）
  ▼
CF Email Sending / Resend 发出
```

关键点（与 PHASE2-4.md §2.2 一致）：

- **不新增 Worker 发信端点，不自造发信链路。** 守护进程只调三个现有接口：`POST /login`、`GET /account/list`、`POST /email/send`。**绝不直调 Resend、绝不直写 D1、绝不直调 CF API 发信**，否则配额与风控会被绕过。
- **SMTP 发信与网页发信计入同一配额**：角色次数、Resend 配额、黑名单检查全部沿用 `send()`，守护进程内不再另设发信配额。
- **认证**：用户名 = 完整邮箱地址，密码 = 站内密码；密码现验现忘，只缓存短期 JWT（内存，TTL 默认 30 分钟，上限 1 小时，`config.js` 校验卡死）。
- **发件人 FROM 必须是该用户自己的 `@aevorynthtech.com` 邮箱**（守护进程先拦一道，Worker 的 `sendEmailNotCurUser` 再兜底）。
- **端口**：对外只开 587（STARTTLS，强制加密后才允许 AUTH）与 465（隐式 TLS）；**禁止 25 端口提交与明文 AUTH**（STARTTLS 之前 AUTH 直接回 530）。守护进程本身只监听 127.0.0.1:2525（+ 可选 465），绝不监听 25。
- **不建 MX**：只做提交，不收信；收信仍走 Email Routing。
- **不做 IMAP**：用户没提，本阶段只做 SMTP 发信。

## 2. 文件清单（A 路交付）

| 文件 | 作用 |
|---|---|
| `smtp-relay/package.json` | Node ≥ 18，`type: module`，`mailparser` 为唯一运行时依赖；脚本 `start` / `test` |
| `smtp-relay/config.example.json` | 配置模板（只放 `YOUR_xxx` 占位符） |
| `smtp-relay/config.json` | 真实配置（自己建，已进 `smtp-relay/.gitignore`，**绝不提交**） |
| `smtp-relay/.gitignore` | 忽略 `config.json` / `*.log` / `node_modules` |
| `smtp-relay/smtp-relay.service` | systemd 单元 |
| `smtp-relay/src/config.js` | 读配置 + 环境变量覆盖 + 校验必填 + 脱敏打印（风格同 `oracle-patrol/src/config.js`） |
| `smtp-relay/src/server.js` | SMTP 协议实现（EHLO/HELO、STARTTLS、AUTH LOGIN/PLAIN、MAIL/RCPT/DATA、RSET/NOOP/QUIT；VRFY 502） |
| `smtp-relay/src/worker-api.js` | Worker 客户端（`/login`、`/account/list`、`/email/send`；配额错误识别） |
| `smtp-relay/src/mail.js` | MIME → `/email/send` 参数映射（`mailparser`，附件 base64） |
| `smtp-relay/src/rate-limit.js` | 内存态限流（并发连接、每小时 AUTH 次数、连续失败封 IP） |
| `smtp-relay/src/telegram.js` | 最小 TG 发送函数（失败永不抛错；配置名复用巡检的 `tgBotToken`/`tgChatId`） |
| `smtp-relay/src/logger.js` | 本地日志（stdout + 追加写 `*.log`，UTC，绝不记密码/JWT） |
| `smtp-relay/src/index.js` | 入口（读配置 → 起服务；SIGINT/SIGTERM 优雅停服） |
| `smtp-relay/test/smtp-relay.test.js` | `node:test`，mock Worker 端到端测试（见 §10） |
| `SMTP-DEPLOY.md` | 本文件 |

## 3. 服务器准备

主服务与巡检同机：**3 核 18G 甲骨文实例**（ubuntu 用户）；热备：**1 核 6G 实例**，同配置，平时不启动（§9）。

```bash
# 两台机都做：Node ≥ 18（守护进程只用内置模块 + mailparser）
node --version   # 须 ≥ v18
sudo mkdir -p /opt/smtp-relay
sudo chown ubuntu:ubuntu /opt/smtp-relay
# 把 smtp-relay/ 目录拷到 /opt/smtp-relay（不要拷 node_modules，现场装）
cd /opt/smtp-relay && npm install --no-package-lock --no-save
```

> ⚠️ 不要用 pnpm（VM 未装，本机约定用 npm）。

## 4. 配置

```bash
cp config.example.json config.json   # 再填真实值；config.json 已进 .gitignore，绝不提交
```

| 项 | 说明 |
|---|---|
| `worker.baseUrl` | Worker API 地址。**本地联调默认 `http://127.0.0.1:8787`**（`wrangler dev`）；**生产填 `https://aevorynthtech.com/api`**（`apiPrefix` 默认 `/api`，与 `wrangler.deploy.toml` 的路由一致） |
| `worker.timeoutMs` | 调 Worker 超时，默认 15000ms |
| `server.host` / `server.port` | 固定 `127.0.0.1:2525`（只接受本机 cloudflared 连接；校验会拒绝非回环地址与 25 端口） |
| `server.hostname` | `smtp.aevorynthtech.com`（问候语与 EHLO 回复用） |
| `server.allowedDomains` | `["aevorynthtech.com"]`（FROM 域名白名单） |
| `server.maxMessageBytes` / `server.maxRecipients` | 默认 10MB / 100 人 |
| `tls.enabled` / `tls.certFile` / `tls.keyFile` | 生产必须 `true` + 证书路径（§4）；`tls.enabled=true` 时缺证书路径启动即报错退出 |
| `tls.implicitPort` | 465 隐式 TLS 监听端口；`null` 则不启动（只留 2525 + STARTTLS） |
| `tls.requireTlsForAuth` | 默认 `true`：STARTTLS 之前 AUTH 直接 530。**本地无证书联调时才设 `false`（仅开发，绝不用于生产）** |
| `auth.maxConnectionsPerIp` / `maxAuthAttemptsPerHour` | 每 IP 并发连接上限 10 / 每小时 AUTH 尝试上限 30 |
| `auth.maxConsecutiveAuthFailures` / `auth.blockMinutes` | AUTH 连续失败 5 次 → 临时封该 IP 15 分钟（内存黑名单 + 记日志 + TG 告警） |
| `auth.jwtTtlSeconds` | JWT 内存缓存 TTL，默认 1800 秒（30 分钟），校验上限 3600 秒 |
| `telegram.botToken` / `telegram.chatId` | TG 告警通道（与巡检同一机器人即可；**优先走环境变量 `TG_BOT_TOKEN` / `TG_CHAT_ID`**，见 `smtp-relay.service` 的 `EnvironmentFile`） |
| `logging.file` | 本地日志文件，默认 `smtp-relay.log`（工作目录下） |

环境变量覆盖（优先级高于 `config.json`）：`WORKER_BASE_URL`、`SMTP_HOST`、`SMTP_PORT`、`SMTP_HOSTNAME`、`SMTP_TLS_CERT`、`SMTP_TLS_KEY`、`SMTP_TLS_ENABLED`、`SMTP_REQUIRE_TLS_FOR_AUTH`、`TG_BOT_TOKEN`、`TG_CHAT_ID`、`SMTP_LOG_FILE`。

## 5. TLS 证书（生产）

### 5.1 申请：Let's Encrypt DNS-01（经 CF DNS API）

用 DNS-01 而不用 HTTP-01：甲骨文上没有对公网开 80 端口，HTTP-01 验证走不通；DNS-01 只需 CF API 改 TXT 记录。

```bash
# 1. 装 certbot + Cloudflare DNS 插件（Ubuntu）
sudo apt update && sudo apt install -y certbot python3-certbot-dns-cloudflare

# 2. 建 CF API 凭证文件（权限：Zone:DNS:Edit，仅限 aevorynthtech.com 这个 Zone）
sudo mkdir -p /etc/letsencrypt
sudo tee /etc/letsencrypt/cloudflare.ini > /dev/null <<'EOF'
dns_cloudflare_api_token = YOUR_CLOUDFLARE_API_TOKEN
EOF
sudo chmod 0600 /etc/letsencrypt/cloudflare.ini

# 3. 申请（只给 smtp 子域名，不用泛域名）
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d smtp.aevorynthtech.com \
  --non-interactive --agree-tos -m admin@aevorynthtech.com

# 证书落盘位置（certbot 默认）：
#   /etc/letsencrypt/live/smtp.aevorynthtech.com/fullchain.pem
#   /etc/letsencrypt/live/smtp.aevorynthtech.com/privkey.pem
```

`config.json` 对应填：

```json
"tls": {
  "enabled": true,
  "certFile": "/etc/letsencrypt/live/smtp.aevorynthtech.com/fullchain.pem",
  "keyFile": "/etc/letsencrypt/live/smtp.aevorynthtech.com/privkey.pem",
  "implicitPort": 465,
  "requireTlsForAuth": true
}
```

> 注意：`privkey.pem` 只有 root 可读。systemd 单元以 `ubuntu` 用户运行会读不到——
> 做法二选一：① 把守护进程的 `User=` 改为 `root`（不推荐）；② 给证书目录加 ACL：
> `sudo setfacl -R -m u:ubuntu:rX /etc/letsencrypt/live /etc/letsencrypt/archive`，
> 并在续期钩子里重新授权（certbot 续期会新建文件，ACL 需用默认 ACL 继承：
> `sudo setfacl -R -d -m u:ubuntu:rX /etc/letsencrypt/archive`）。

### 5.2 自动续期

certbot 自带 systemd timer（每天两次检查，60 天有效期、到期前 30 天自动续）：

```bash
systemctl list-timers | grep certbot   # 确认 certbot.timer 在跑
sudo certbot renew --dry-run           # 先演练一次续期流程
```

守护进程启动时才读证书，**续期后必须重启服务才能加载新证书**。在续期钩子目录放重启脚本：

```bash
sudo tee /etc/letsencrypt/renewal-hooks/deploy/restart-smtp-relay.sh > /dev/null <<'EOF'
#!/bin/sh
# 证书续期成功后重启 SMTP 中继以加载新证书（短暂断开，已建立会话的客户端按标准重连）
systemctl restart smtp-relay
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/restart-smtp-relay.sh
```

> 也可以用 `certbot renew --deploy-hook "systemctl restart smtp-relay"`（只对当次 renew 生效，不如钩子目录持久）。

### 5.3 本地测试：自签证书（测试专用）

```bash
# 仅本地联调 / 自动化测试用，绝不用于生产（客户端会报证书不可信）
openssl req -x509 -newkey rsa:2048 -keyout /tmp/smtp-test-key.pem \
  -out /tmp/smtp-test-cert.pem -days 1 -nodes -subj "/CN=smtp.aevorynthtech.com"
```

测试套件（`test/smtp-relay.test.js`）就是用 openssl 现场生成自签证书做 STARTTLS 握手测试的。

## 6. systemd 部署与 cloudflared Tunnel

### 6.1 systemd

```bash
sudo cp smtp-relay.service /etc/systemd/system/smtp-relay.service
# TG 凭证放环境变量文件（root:root 0600），不进 config.json：
sudo tee /etc/smtp-relay.env > /dev/null <<'EOF'
TG_BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
TG_CHAT_ID=YOUR_TELEGRAM_CHAT_ID
EOF
sudo chmod 0600 /etc/smtp-relay.env
sudo systemctl daemon-reload
sudo systemctl enable --now smtp-relay
sudo systemctl status smtp-relay   # 看启动行：监听 127.0.0.1:2525（+ 465），配置为脱敏打印
sudo journalctl -u smtp-relay -f   # 看日志
```

### 6.2 cloudflared Tunnel（只做提交入口，不建 MX）

```bash
# 1. 建隧道（已有一条隧道复用即可，不必为 SMTP 单建）
cloudflared tunnel create mail-ultimate
# 2. 本机跑 cloudflared（与巡检同机；建议也做成 systemd 服务，见 cloudflared 官方文档）
# 3. config.yml（/etc/cloudflared/config.yml 或 ~/.cloudflared/config.yml）：
```

```yaml
tunnel: <TUNNEL_ID 或名字 mail-ultimate>
credentials-file: /etc/cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: smtp.aevorynthtech.com
    service: tcp://127.0.0.1:2525
  - service: http_status:404
```

```bash
# 4. 建 DNS 记录（CNAME 到隧道；只建这一条，不建 MX——收信仍走 Email Routing）
cloudflared tunnel route dns <tunnel> smtp.aevorynthtech.com
# 5. 启动/重载 cloudflared
sudo systemctl restart cloudflared
```

> 再次提醒（§0.2）：上述 Tunnel 配置只解决“回源到守护进程”，**公网 587/465 入口还需
> Spectrum 确认**。在确认前不要公布客户端配置。

## 7. 客户端配置向导（部署确认后发给用户）

通用参数（三端一致）：

| 项 | 值 |
|---|---|
| 服务器 | `smtp.aevorynthtech.com` |
| 端口 / 加密 | **587 + STARTTLS**（首选）或 **465 + SSL/TLS** |
| 用户名 | 完整邮箱地址（如 `alice@aevorynthtech.com`） |
| 密码 | 站内密码（与网页登录同一个） |
| 发件人 | 必须与用户名一致（冒充他人发件会被 553 拒绝） |

### Outlook（桌面版 / 新版 Outlook）

设置 → 账户 → 添加账户 → 手动设置 → SMTP：服务器 `smtp.aevorynthtech.com`，端口 `587`，
加密方式选 **STARTTLS**，用户名填完整邮箱，密码填站内密码。
若 587 不通，改端口 `465`、加密方式 **SSL/TLS** 再试。

### Thunderbird

账户设置 → 发件服务器（SMTP）→ 添加：服务器名 `smtp.aevorynthtech.com`，端口 `587`，
连接安全性 **STARTTLS**，认证方式 **普通密码**，用户名完整邮箱。
（465 则连接安全性选 **SSL/TLS**。）

### 手机邮箱（iOS 邮件 / Android Gmail 等）

发件服务器填 `smtp.aevorynthtech.com`，端口 `587`，开启 TLS（STARTTLS），用户名完整邮箱、
密码站内密码；465 则选 SSL。**收件仍用原来的方式（网页端 / Email Routing），SMTP 只负责发信，
不要在手机上配 IMAP/POP（本站不提供）。**

### 限制（先告诉用户，免得他踩坑）

- 开启了 TOTP 二次验证的账号暂不能用 SMTP 发信（SMTP 客户端走不了二次验证页，服务器回 535）——
  这类账号请用网页端发信；等第六阶段 B 路落地后再评估 SMTP 的 TOTP 方案。
- 发信额度与网页端共用同一角色限额与 Resend 配额；额度用完时客户端会收到 452（稍后重试），
  不是密码错了，不要反复改密码。
- 附件单个邮件上限 10 个（Worker 侧 `attLimit`），超了回 550。

## 8. 排障

| 现象 | 查什么 | 命令 / 动作 |
|---|---|---|
| 服务起不来 | 配置缺失/证书读不到 | `journalctl -u smtp-relay -n 50`；启动报错会直接写明缺哪项（exit 1，不带病运行） |
| 客户端连不上 587/465 | 入口是否通（先确认 §0.2 方案 A 已开通） | `openssl s_client -connect smtp.aevorynthtech.com:587 -starttls smtp` 应看到 `220` 与守护进程证书（CN=smtp.aevorynthtech.com，颁发者 Let's Encrypt） |
| `530 Must issue a STARTTLS command first` | 客户端没开加密就 AUTH | 客户端改 587+STARTTLS 或 465+SSL/TLS；明文 AUTH 是故意拒绝的 |
| `535 Authentication credentials invalid` | 密码错 / 账号被封 / TOTP 账号 | 先网页登录核对密码；查 `smtp-relay.log` 的 AUTH 行（只记邮箱与结果，不记密码） |
| `421 Your IP is temporarily blocked` | AUTH 连续失败 5 次封 15 分钟 | 等 15 分钟或重启服务清内存黑名单（重启即清零）；查日志看是哪个 IP 在撞库 |
| `452 Sending quota exhausted` | Resend 配额 / 角色当日限额用完 | 不是故障：等次日额度恢复；查管理后台 Resend 用量；**守护进程不重试**，客户端按标准稍后重试即可 |
| `553 Sender address must match` | 客户端发件人 ≠ 登录账号 | 把客户端“发件人”改成与用户名一致的邮箱 |
| `550 bannedSend / daySendLimit` | 角色被禁发 / 当日额度满 | Worker 侧规则，查后台角色设置（守护进程原样透传） |
| 发信后对方没收到 | Worker 侧通道 | 按 `DEPLOY.md` §6 第 3 项核对主通道（管理后台发信服务一栏须显示 Cloudflare Email Sending） |
| 证书过期 | 续期钩子没跑 | `sudo certbot certificates` 看有效期；`sudo certbot renew --force-renewal` 手动续一次并确认钩子重启了服务 |

手动验证一封（不依赖邮件客户端，服务器本机）：

```bash
# 经 Tunnel 侧 2525 明文口验协议（本机 only；生产 2525 只绑 127.0.0.1）
printf 'EHLO test\r\nAUTH LOGIN\r\n' | timeout 5 openssl s_client -connect 127.0.0.1:2525 -starttls smtp -quiet 2>/dev/null | head -5
# 正常应看到 220 问候 + 250-STARTTLS + AUTH 前 530（未加密 AUTH 被拒）
```

## 9. 热备（1 核 6G 实例）

- 热备机上装**同一份** `smtp-relay/` + 同一份 `config.json`（Worker 地址、TG、证书路径一致；
  证书：热备机也跑一份 certbot DNS-01 拿同一域名的证书，或从主实例同步 `/etc/letsencrypt/`——
  二选一，不要手工拷私钥到聊天记录或仓库）。
- 热备机的 `smtp-relay` 服务**默认停用**（`systemctl disable smtp-relay`，不要 `enable`）：
  ```bash
  # 热备机：只装不启动
  sudo systemctl disable --now smtp-relay
  ```
- 故障时手动切换：主实例停服 → 热备机上 `sudo systemctl enable --now smtp-relay`，
  并把 Tunnel 的 cloudflared 指向热备机（或在热备机上启动同一条隧道的 cloudflared；
  **同一时间只跑一个 cloudflared**，避免两个源抢同一条隧道）。
- 无自动故障转移（与巡检热备一致，手动切换）。切换后在客户端发一封测试信验证（§8 最后一节）。

## 10. 测试（本地实跑，部署前必过）

```bash
cd smtp-relay
npm test   # node --test，12 个用例（mock Worker + 本机回环 TCP，全程不连线上）
```

覆盖：EHLO→AUTH→MAIL→RCPT→DATA→250 全程端到端；AUTH PLAIN；JWT 缓存复用；
AUTH 失败 5 次封 IP + TG 告警 + 第 6 次连接问候 421；MIME→send 映射（含附件 base64、dot-stuffing 还原、
无 HTML 时由纯文本生成 content）；配额错误透传（Worker 返回 400 `resendQuotaExhausted` 时回 452、
只调一次不重试；真实 Worker 形状 HTTP 200 + body.code 501 + 中文译文同样回 452）；
STARTTLS 自签证书握手（STARTTLS 前 AUTH 530、升级后 AUTH 可用）；465 隐式 TLS；
VRFY/EXPN 502、未认证 MAIL 530、FROM 冒充 553、TOTP 账号 535；Worker 403→550；
配置校验（25 端口拒绝、JWT TTL 超 3600 拒绝、脱敏打印）。

## 11. 运维要点

- **日志**：`journalctl -u smtp-relay` 与工作目录 `smtp-relay.log`（UTC 时间；所有 AUTH 尝试都记一行，
  只含 IP/邮箱/结果，绝不记密码与 JWT）。日志文件已进 `.gitignore`。
- **告警**：AUTH 连续失败封 IP 时发 TG（同一 IP 15 分钟内只告警一次）；TG 未配时只记日志，不阻断服务。
- **重启**：守护进程无状态（限流黑名单与 JWT 缓存全在内存），`systemctl restart smtp-relay` 即恢复；
  重启后黑名单清零、已建立的 SMTP 会话断开，客户端按标准重连即可。
- **升级**：更新代码后 `npm install --no-package-lock --no-save`（只装 `mailparser`），再 `systemctl restart smtp-relay`；
  先跑 `npm test` 通过再重启。
- **绝不动线上**：本服务不连 mail.flame.edu.kg、D1 `cloud-mail`、Worker `cloud-mail`；
  调的永远是 `worker.baseUrl` 指向的新站 Worker（本地默认 `http://127.0.0.1:8787`）。
