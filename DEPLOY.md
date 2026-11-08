# 终极版邮箱 · 一键部署指南（aevorynthtech.com）

> 状态：**只做部署准备，未实际部署**。按本文档操作前，先确认 `PHASE2-4.md` §5 与 `PHASE5-6.md` §7 回归清单全部打勾、且无已知 bug 未修。
> 新站与老站 **完全隔离**：全套全新 Worker / D1 / KV / R2 / Email Routing / Turnstile，域名 **aevorynthtech.com**；老站 mail.flame.edu.kg、D1 `cloud-mail`、Worker `cloud-mail` 全程不动。
> 部署方式（用户 2026-11-08 13:39 改定，旧的“用户自己上传 GitHub”作废）：**由助手登录用户的 GitHub、自己部署新项目**（仓库名 `mail-ultimate`，见 §7）；**先部署当前 1–4 阶段完成的状态，5–6 阶段做完再更新部署**。本文件与 `PHASE5-6.md` 是 5–6 阶段完成后的更新。

## 0. 部署前检查清单（缺一项都不许部署）

- [ ] 本地测试全过：`mail-worker` 下 `npx vitest run test/phase1.spec.js test/phase2a.spec.js test/phase2c.spec.js test/phase6.spec.js`（phase1 23 个、phase2a 13 个、phase2c 26 个、phase6 30 个，共 92 个）；`smtp-relay` 下 `npm test`（12 个）；`mail-vue` 下 `node test/e2ee.smoke.mjs`（11 个）与 `node test/preferences-locale.smoke.mjs`（10 个）。
- [ ] 前端构建通过：`mail-vue` 下 `npm run build`（见 §5 说明：本机用 npm，不用 pnpm）。
- [ ] `PHASE2-4.md` §5 与 `PHASE5-6.md` §7 回归清单逐项打勾；已知问题清单为空（零已知 bug 方可交付，用户 2026-11-08 13:07 定）。
- [ ] `jwt_secret` 已重新生成（§3），**绝不复用老站的 jwt_secret**。
- [ ] `FIELD_ENC_KEY` 已生成并填入 `.deploy.env`（§3，第六阶段字段加密用；**不与 `jwt_secret` 复用**；不填则敏感字段存明文）。
- [ ] `.deploy.env` 已按 `.deploy.env.example` 填好，且**未提交进 Git**（`.gitignore` 已忽略）。
- [ ] Cloudflare 账号已登录：`npx wrangler login`（或 `CLOUDFLARE_API_TOKEN` 环境变量，权限需含 Workers/D1/KV/R2/Email/Zone 编辑）。
- [ ] 域名 aevorynthtech.com 已在该 Cloudflare 账号下托管（DNS 由 CF 接管）。

## 1. 新建 Cloudflare 资源（全套全新，不复用老站任何一个）

在 Cloudflare Dashboard（或 `wrangler` CLI）里新建，名字与老站区分开：

| 资源 | 新名字 | 备注 |
|---|---|---|
| Worker | `mail-ultimate` | 与老站 `cloud-mail` 不同名 |
| D1 数据库 | `mail-ultimate` | 记下 `database_id`，填进 `.deploy.env` 的 `D1_DATABASE_ID` |
| KV 命名空间 | `mail-ultimate-kv` | 记下 `id`，填 `KV_NAMESPACE_ID` |
| R2 存储桶 | `mail-ultimate` | 填 `R2_BUCKET_NAME` |
| Turnstile 站点 | `mail-aevorynthtech` | 见 §4 |

```bash
# CLI 方式（在已登录的前提下）
npx wrangler d1 create mail-ultimate
npx wrangler kv namespace create mail-ultimate-kv
npx wrangler r2 bucket create mail-ultimate
```

## 2. Email Routing（收信）与 Email Sending（发信）

### 2.1 收信 — Email Routing

1. Cloudflare Dashboard → 域名 aevorynthtech.com → **Email → Email Routing** → Enable。
2. 按向导加 MX 记录（CF 自动给出，指向 CF 收信服务器；**不要**指向任何甲骨文 IP）。
3. 建 Catch-All / 自定义地址规则：`*@aevorynthtech.com` → **Send to a Worker** → 选 Worker `mail-ultimate`。
   - Worker 的 `email()` 入口（`mail-worker/src/index.js` 的 `email: email`）负责收信落库。
4. SPF / DKIM / DMARC：按 Dashboard 向导加 TXT 记录（SPF 含 `_spf.mx.cloudflare.net`，DKIM 由 CF 生成，DMARC 先 `p=none` 上线观察，稳定后收紧）。

### 2.2 发信 — Email Sending（主通道）+ Resend（备用通道）

> 用户 2026-11-08 13:21 定：**主通道 Cloudflare Email Sending，Resend 免费版做备用**（配额保护不变）。
> **不是“免费无限”**：CF Email Sending 发给任意收件人需要 **Workers Paid 计划**——用户已在付 Workers 付费版 $5/月，不用多花钱，**含 3000 封/月，超量 $0.35/1000 封**；免费版只能发给自己验证过的地址，**不能当主通道**。
> Resend 免费版（**100 封/天、3000 封/月**）继续做备用通道：只有 CF 通道不可用时才走 Resend，撞线即停发并 TG 告警（`email-service.js` 的配额保护）。
> 另：Cloudflare Email Service 自带 SMTP 提交端点 `smtp.mx.cloudflare.net:465`（仅隐式 TLS；用户名为字面量 `api_token`；密码为带 Email Sending: Edit 权限的 CF API token；不支持 587/465 以外的提交端口）——**这是账号级共享凭证认证，没有按用户区分、没有本站的角色发信次数与 Resend 配额概念，不能替代用户侧 SMTP**。用户侧 SMTP 仍走第五阶段的甲骨文守护进程（`SMTP-DEPLOY.md`）；该端点只作为管理员自用/排障的备选，**不要写进用户配置向导、不要公布给用户**。

**代码里的通道判定（先核对，再按步骤开通）：**

- `mail-worker/src/service/email-service.js:416`：`useCloudflareEmail = !!c.env.email`——主通道是否启用，只看 Worker 有没有绑定名叫 **`email`** 的 `send_email` 绑定。
- 优先级（`:485–497`）：全部站内收件人 → 本地投递；有站外收件人且 `email` 绑定存在 → 走 CF Email Sending（`:709` `c.env.email.send()`）；`email` 绑定不存在 → 走 Resend（进分支前先查日/月配额，超了就停发）。
- 注意：上游模板（`wrangler-action.toml`）只绑了名叫 **`forward`** 的 `send_email`，那是另一路——站内转发到已验证的其他邮箱（`email-service.js:1024` `forwardMime.send(c.env.forward, ...)`），**不是主发信通道**。只绑 `forward` 不绑 `email`，站外邮件会悄悄全走 Resend，主通道等于没开。**部署模板必须两个都绑**（见 §5.1）。

**开通步骤（按顺序做）：**

1. **确认 Workers Paid**：Dashboard → Workers & Pages → 确认当前计划为 Paid（$5/月）。免费计划下 Email Sending 只能发给验证过的地址，开了也当不了主通道；先升级再继续。
2. **开启 Email Sending**：Dashboard → 域名 aevorynthtech.com → **Email → Email Sending** → Enable。
3. **接入发送域名**：在 Email Sending 里添加发送域名 aevorynthtech.com，按向导完成域名验证。
4. **加 DNS 记录（缺一不可，缺了会被拒收或进垃圾箱）**：
   - **SPF**：TXT 记录，值按 Dashboard 向导给的为准（含 CF 发信源，如 `_spf.mx.cloudflare.net` 机制；不要自己拼一个“看起来对的”——以向导显示的为准）。
   - **DKIM**：按向导加 2 条 CNAME/TXT（选择器名与公钥由 CF 生成，每个域名不同，照抄向导的值）。
   - **DMARC**：TXT 记录 `_dmarc.aevorynthtech.com`，先 `v=DMARC1; p=none; rua=mailto:dmarc@aevorynthtech.com` 上线观察，收信正常、SPF/DKIM 对齐后收紧到 `p=quarantine`（不要一上来就 `p=reject`，配错会丢信）。
   - 等 DNS 生效后，在 Dashboard 里确认 SPF/DKIM 状态均为通过（Verified）。
5. **绑两个 `send_email` 绑定**（部署时由 `deploy.sh` 生成的 `wrangler.deploy.toml` 一次性带上，见 §5.1）：
   ```toml
   [[send_email]]
   name = "email"      # 主发信通道（Email Sending，任意收件人，需 Workers Paid）

   [[send_email]]
   name = "forward"    # 站内转发到已验证的其他邮箱，不是主通道
   ```
6. **Resend 备用通道**：在 Resend 新建域名 aevorynthtech.com、取 API Key；**不要复用老站的 Resend token**（老站 token 绑的是 mail.flame.edu.kg）。部署后在管理后台设置页填入（Resend Key 只填后台，不进 wrangler 配置、不写文档）。
7. **验证主通道真的在用**（部署后，`DEPLOY.md` §6 第 3 项冒烟时做）：管理后台 → 系统设置页，看发信服务一栏显示的是 **Cloudflare Email Sending** 还是 Resend Token（`setting-service.js:93` 的 `hasCfEmail = !!c.env.email` 决定显示）；再发一封站外测试信，确认走 CF 通道（Worker 日志 / 收件方收到的头里无 Resend 痕迹）。如果显示 Resend，说明 `email` 绑定没生效——回 §5.1 核对 `wrangler.deploy.toml` 里有没有 `name = "email"` 这一节。

## 3. 密钥与配置（全部重新生成，绝不复用老站）

| 配置项 | 怎么来 | 填哪里 |
|---|---|---|
| `JWT_SECRET` | `openssl rand -hex 32` 现场生成 | `.deploy.env` → `wrangler.deploy.toml` 的 `[vars] jwt_secret`；**同时也是 `/init` 的调用密钥**（见 §6） |
| `ADMIN` | 管理员邮箱（建议新建一个 `@aevorynthtech.com` 管理员账号，不用老站管理员邮箱） | `.deploy.env` |
| `DOMAIN` | `aevorynthtech.com` | `.deploy.env` |
| Turnstile Site Key / Secret Key | 见 §4，新站点 | 部署后在管理后台设置页填（不进 wrangler 配置） |
| Resend API Key | 见 §2.2，新域名 token | 部署后在管理后台设置页填 |
| Telegram Bot Token / Chat ID | 复用现有机器人亦可（告警通道与域名无关）；没有就新建 Bot | 管理后台设置页填 |
| `FIELD_ENC_KEY` | 第六阶段安全加固已实施（敏感字段应用层加密）：**部署时生成**（`openssl rand -hex 32`），填进 `.deploy.env`；**不与 `jwt_secret` 复用**；不填则敏感字段存明文（会打告警日志） | 生成后填 |

> ⚠️ 老站的 `jwt_secret`、Turnstile Secret Key、Resend token、CF API Token 一律不复用；`.deploy.env` 与生成的 `wrangler.deploy.toml` 都已加入 `.gitignore`，**绝不提交进 Git**。

## 4. Turnstile 新站点

1. Dashboard → **Turnstile** → Add site，名字 `mail-aevorynthtech`，域名填 `aevorynthtech.com`，模式 **Managed**（默认即可）。
2. 取 **Site Key** 与 **Secret Key**。
3. 部署并跑完 `/init` 后（§6），用管理员账号登录新站后台 → 设置页：填入 Site Key / Secret Key，并确认 **注册验证 = 每次验证（OPEN）**（第一阶段已把默认改成 OPEN；上线后在设置页再核对一次）。
4. Secret Key 只填进后台，**不贴聊天、不写文档、不进 Git**（Site Key 是公开值，可写文档）。

## 5. deploy.sh（一键部署）

脚本：`~/workspace/mail-ultimate/deploy.sh`（仓库根目录）。它只做三件事，不碰线上老站：

```bash
cd ~/workspace/mail-ultimate
cp .deploy.env.example .deploy.env   # 首次：按 §1/§3 填好真实值
./deploy.sh
```

脚本流程（见脚本内注释）：

1. 校验 `.deploy.env` 必填项齐全、`jwt_secret` 长度 ≥ 32 且不等于本地测试 dummy 值。
2. 前端构建：`mail-vue` 下 `npm install --legacy-peer-deps --no-package-lock --no-save && npm run build`，产物进 `mail-worker/dist`（上游 `[build].command` 用 pnpm，本机 VM 未装 pnpm，改用 npm；构建产物与行为一致）。
3. 生成 `mail-worker/wrangler.deploy.toml`（模板见 §5.1，变量来自 `.deploy.env`；`[assets] directory = "./dist"`、`run_worker_first = true`，`/api/*` 先走 Worker，其余走静态资源）。
4. `npx wrangler deploy --config wrangler.deploy.toml`，部署 Worker `mail-ultimate` 并绑定路由 `aevorynthtech.com`（custom domain）。
5. 部署后打印检查清单（§6），**不自动跑 `/init`**——`/init` 必须人工确认后再调（只跑一次，幂等）。

### 5.1 wrangler.deploy.toml 模板（由 deploy.sh 生成，不要手写提交）

```toml
name = "mail-ultimate"
main = "src/index.js"
compatibility_date = "2025-06-04"

[observability]
enabled = true

[[routes]]
pattern = "aevorynthtech.com"
custom_domain = true
[[routes]]
pattern = "www.aevorynthtech.com"
custom_domain = true

[[d1_databases]]
binding = "db"
database_name = "mail-ultimate"
database_id = "${D1_DATABASE_ID}"

[[kv_namespaces]]
binding = "kv"
id = "${KV_NAMESPACE_ID}"

[[r2_buckets]]
binding = "r2"
bucket_name = "mail-ultimate"

[[send_email]]
name = "email"

[[send_email]]
name = "forward"

[ai]
binding = "ai"

[assets]
binding = "assets"
directory = "./dist"
not_found_handling = "single-page-application"
run_worker_first = true

[triggers]
crons = ["0 * * * *"]

[vars]
ai_model = ""
analysis_cache = true
domain = "[\"aevorynthtech.com\"]"
admin = "${ADMIN}"
jwt_secret = "${JWT_SECRET}"
project_link = "https://github.com/${GH_REPO}"

[build]
command = "npm --prefix ../mail-vue install --legacy-peer-deps --no-package-lock --no-save && npm --prefix ../mail-vue run build"
```

> 说明：`wrangler-action.toml` 是上游的 GitHub Action 模板（变量占位符 `${NAME}` 等），部署不用它；部署用 `wrangler.deploy.toml`（deploy.sh 生成）。`wrangler-dev.toml` / `wrangler-test.toml` 绑的是远端/测试资源，**部署时不要用**；本地验证只用 `wrangler.jsonc`（占位绑定，不连线上）。

## 6. 部署后检查清单（按顺序做，先跑 /init 再启用）

1. **跑 `/init` 建库**（只跑一次；幂等，可重跑核对）：
   ```bash
   curl "https://aevorynthtech.com/api/init/<JWT_SECRET>"
   # 预期返回 success。注意：/init/:secret 的 secret 就是 jwt_secret（init.js:8-11）。
   ```
   跑完立即核对（`wrangler d1 execute mail-ultimate --remote --command "..."`）：
   - `pragma_table_info(user)` 含 `locale` 列；`pragma_table_info(setting)` 含 `reg_key_alert_threshold`、`reg_circuit_open` 等新列；
   - `login_log` / `alert_log` / `register_log` / `audit_log` / `ip_blocklist` 五表存在；
   - `user_totp` / `user_passkey` / `user_security` 三表存在（第六阶段）；`pragma_table_info(setting)` 含 `log_retention_days`、`log_ip_mask`；`pragma_table_info(email)` 含 `e2ee`；
   - perm 37–45 存在（37–42 第一阶段，43–45 第二阶段：告警中心父、告警查看、用户导出）。
2. **管理后台设置**（管理员登录后）：填 Turnstile Site/Secret Key、Resend Key、TG Bot Token/Chat ID；确认注册验证 = OPEN、单 IP 24h 限 3、熔断阈值 20/分钟、密钥告警阈值 500；新建至少一把注册密钥。
3. **收发信冒烟**：注册一个测试账号（走 Turnstile）→ 登录 → 发一封站内信 → 发一封站外信（走 CF Email）→ 从外部邮箱回一封（走 Email Routing 收信）→ 确认收发都通。**站外信发出前先核对主通道**：管理后台 → 系统设置页，发信服务一栏须显示 **Cloudflare Email Sending**（不是 Resend Token）；若显示 Resend，说明 `email` 绑定没生效，回 §2.2 第 5 步核对 `wrangler.deploy.toml` 里有没有 `name = "email"` 这一节。
4. **风控冒烟**：后台用户列表 IP 列/筛选/导出、仪表盘 risk 卡片、封禁管理页、告警中心、注册日志页逐项打开一次；故意用同一 IP 注册第 4 个账号应被拒（`regIpLimit` 人话提示）。
5. **巡检上线**（甲骨文，见 `oracle-patrol/README.md`）：填真实 `config.json`（D1 ID、CF API Token、TG、管理员账号）→ `--once --dry-run` 看拟封禁/WAF 表达式无误 → `--once` 实跑一次 → systemd 启用；Uptime Kuma 建 push 监控；热备机只装不启动。
6. **WAF 规则**：在 aevorynthtech.com 的 Zone 里建规则 `mail-ultimate-ip-blocklist`（表达式 `http.host eq "aevorynthtech.com" and ip.src in { ... }`，初始为空集或巡检首次同步后自动生成；巡检只改这一条规则，不动其他规则）。
7. **回滚预案**：任何一步失败，先停新站注册（设置页关注册验证改为 CLOSE 或直接停 Worker 的路由），不要动老站；Worker 可 `wrangler rollback` 回上一版本；D1 有问题时用甲骨文备份恢复（备份同步见 `oracle-patrol/README.md`）；`/init` 幂等，可重跑。
8. **安全加固与 SMTP 冒烟**（见 `PHASE5-6.md` §7 回归 25–36）：TOTP 开通→登录验证、Passkey 注册→登录、会话踢出、安全中心读写、E2EE 站外拒发/站内解密、安全头、日志清理、IP 脱敏逐项核对；SMTP 守护进程部署后真实联调（`SMTP-DEPLOY.md`）。**注意：公网 587/465 入口待 Spectrum 方案确认（`PHASE5-6.md` §6.1），确认前不要向用户公布 `smtp.aevorynthtech.com`。**

## 7. GitHub 集成（只留接口）

- 部署方式（用户 2026-11-08 13:39 改定）：**由助手登录用户的 GitHub、自己部署新项目**（仓库名 `mail-ultimate`；GitHub 账号用户说需要的话可以给，密码类凭证须走安全卡片，绝不明文索要）。先部署当前 1–4 阶段完成的状态，5–6 阶段做完再更新部署。
- `deploy.sh` 里留了 `GH_REPO` 变量（格式 `用户名/仓库名`），只用于 `wrangler.deploy.toml` 的 `project_link` 展示字段；上传完成后再填，不填也不影响部署。
- 上传后建议动作：`git remote add origin https://github.com/<GH_REPO>.git && git push -u origin main`；仓库设为私有；确认 `.deploy.env` / `wrangler.deploy.toml` / `oracle-patrol/config.json` / `state.json` 均未被提交（`.gitignore` 已覆盖）。

## 8. 不做的事（部署时也不要顺手做）

- 不迁移老站数据（用户、邮件、注册密钥一律不迁，新站从零开始）。
- 不复用老站任何密钥、Token、D1/KV/R2、Turnstile 站点、WAF 规则。
- SMTP 服务与第六阶段安全加固**已实施**（见 `PHASE5-6.md`、`SMTP-DEPLOY.md`），部署时按 §6 第 8 项冒烟核对；**公网 587/465 入口待 Spectrum 方案确认，确认前只留 `smtp.aevorynthtech.com` 的 DNS 规划、不建记录、不向用户公布**。
- 部署全程不碰 mail.flame.edu.kg 的任何配置；新站出问题不拿老站当试验场。
