# oracle-patrol — 甲骨文风控巡检服务

终极版邮箱（新站 `aevorynthtech.com`）的场外风控巡检，跑在甲骨文云实例上，与主站零交集。
每 5 分钟一轮：只读 D1 → 发现超限/有举报的注册 IP → 经 Worker API 封禁 → 同步 WAF → TG 告警。
**巡检挂了主站不受影响**；巡检本身不写 D1（写库唯一入口是 Worker API / CF 在线写）。

- Node ≥ 18，**零运行时依赖**（只用内置 `fetch` / `http`），`package.json` 里 `dependencies` 为空。
- 全部时间 UTC；日志里绝不打印任何密钥（启动时只打印脱敏后的配置）。

## 目录

| 文件 | 作用 |
|---|---|
| `package.json` | `type: module`，脚本：`start` / `once` / `dry-run` / `test` |
| `config.example.json` | 配置模板（只放 `YOUR_xxx` 占位符） |
| `config.json` | 真实配置（自己建，已进 `.gitignore`，**绝不提交**） |
| `state.json` | 运行态（自动生成，已进 `.gitignore`）：WAF 同步记录、告警去重、AbuseIPDB 缓存、连续失败次数 |
| `patrol.service` | systemd 单元 |
| `src/config.js` | 读配置 + 环境变量覆盖 + 校验必填 + 脱敏打印 |
| `src/d1.js` | CF D1 REST API 只读查询（`POST /client/v4/accounts/{id}/d1/database/{id}/query`） |
| `src/worker-api.js` | Worker API：`POST /login` 拿 JWT（`Authorization` 头直接放裸 token，见下）+ `/ipBlocklist/add`、`/alertLog/record`、`/quota/resend`；401 重登一次；网络/5xx 重试 3 次 |
| `src/waf.js` | Rulesets API：读 `http_request_firewall_custom` entrypoint，只改目标规则再全量 PUT |
| `src/abuseipdb.js` | AbuseIPDB `/api/v2/check`，结果缓存 24h（省免费额度 1000/天） |
| `src/telegram.js` | 直调 TG Bot API，失败永不抛错 |
| `src/state.js` | `state.json` 读写（原子写）、AbuseIPDB 缓存 24h |
| `src/patrol.js` | 单次巡检（5 个步骤，见下） |
| `src/index.js` | 入口：循环 + `--once` + `--dry-run` + `--config <path>` |
| `test/patrol.test.js` | `node:test` + 内置 http mock（CF D1 / WAF / TG / Worker / AbuseIPDB 五方） |

## 每轮巡检（UTC）

1. **注册超限**：D1 查 `regWindowHours`（默认 24h）内 `user` 表 `create_ip` 分组计数（`is_del=0` 且 `create_ip != ''`，`HAVING n >= regLimit` 默认 3）。未在 `ip_blocklist`（D1 直读，有效行：`expire_time` 为空或未过期）里的超限 IP → Worker `/ipBlocklist/add`（scope 0，reason：`巡检：24h 内注册 N 次`）+ TG 告警 + `/alertLog/record`（type `patrol`）。
2. **AbuseIPDB**：D1 查近 1h 新注册的不同 IP（上限 200 个），逐个查（缓存 24h）。`totalReports >= minReports`（默认 1，即 >0）→ 自动封（scope 0，reason：`巡检：AbuseIPDB 举报 N 次，最近举报类别：X、Y（最近举报 <时间>）`）+ 同步骤 1 的告警链；无举报只记日志，不封。
3. **Resend 配额**：`GET /quota/resend`（`{day, month, dayBudget, monthBudget}`）。日/月用量 ≥80% 告警，**每天每档 1 次**（state 去重）；≥100% 立即告警（每小时最多 1 次，防每 5 分钟刷屏）。
4. **WAF 同步**：WAF 规则 IP 集 = D1 `ip_blocklist` 全部有效行（**scope 0 与 1 都进 WAF**，沿用现网做法；IPv6 段拼 `/64`）。仅当表达式变化时才推；推送失败记日志 + TG 告警，**不影响 D1 封禁结果**。黑名单为空时不推送（不动现有规则）。
5. **失联检测**：步骤 1 的 D1 读不到算本轮失败；**连续 3 轮失败**发一次 TG“巡检失联”告警，恢复后发“巡检恢复”。

另：批量写之间隔 50ms 分批；`kumaPushUrl` 配了则每轮结束 GET 心跳（失败时带 `status=down`）。

## 配置

```bash
cp config.example.json config.json   # 再填真实值；config.json 已进 .gitignore，绝不提交
```

| 项 | 说明 |
|---|---|
| `cloudflare.apiToken` / `accountId` / `zoneId` / `d1DatabaseId` | CF API Token（需 `D1:Read` + `Zone:Rulesets:Edit` 权限）、账号 / Zone / D1 库 ID |
| `cloudflare.wafRuleName` | WAF 目标规则的 description，如 `mail-ultimate-ip-blocklist`（按名查找，不存在则新建追加） |
| `worker.baseUrl` | 如 `https://aevorynthtech.com/api` |
| `admin.email` / `admin.password` | Worker 管理员账号；**密码优先读环境变量 `MAIL_PATROL_ADMIN_PASSWORD`** |
| `abuseipdb.apiKey` / `maxAgeInDays: 90` / `minReports: 1` | 未配 `apiKey` 时步骤 2 跳过（不致命，其余步骤照常） |
| `telegram.botToken` / `chatId` | TG 告警通道 |
| `patrol.intervalMinutes: 5` / `regWindowHours: 24` / `regLimit: 3` / `wafSyncEnabled: true` / `dryRun: false` | 巡检参数 |
| `kumaPushUrl` | 可选，Uptime Kuma push 心跳 URL |

环境变量覆盖（优先级高于 `config.json`）：`CF_API_TOKEN`、`CF_ACCOUNT_ID`、`CF_ZONE_ID`、`CF_D1_DATABASE_ID`、`CF_WAF_RULE_NAME`、`WORKER_BASE_URL`、`MAIL_PATROL_ADMIN_EMAIL`、`MAIL_PATROL_ADMIN_PASSWORD`、`ABUSEIPDB_API_KEY`、`TG_BOT_TOKEN`、`TG_CHAT_ID`、`KUMA_PUSH_URL`、`PATROL_DRY_RUN`。另有仅测试用的 `CF_API_BASE_URL` / `TG_API_BASE_URL` / `ABUSEIPDB_API_BASE_URL`（把三方指向本地 mock，生产不用填）。

### 接口依据（已核实）

- **WAF Rulesets API**（Cloudflare WAF 文档《Create custom rules via API》）：`GET / PUT /client/v4/zones/{zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint`；PUT 会**全量替换**该 phase 的全部规则，所以必须先 GET、保留全部非目标规则原样（含 id）、只改目标规则的表达式再 PUT。表达式：`http.host eq "aevorynthtech.com" and ip.src in { <IP…> }`，action `block`。
- **Worker 登录**（`mail-worker/src/const/constant.js`：`TOKEN_HEADER = 'Authorization'`；前端 `mail-vue/src/axios/index.js` 直接把裸 token 放进该头，无 `Bearer ` 前缀）：`POST /login {email, password}` → `{code:200, data:{token}}`。
- **封禁写入口**（第一阶段 `ip-blocklist-service.js` / `api/ip-blocklist-api.js`）：`POST /ipBlocklist/add {ip, scope, reason, expireTime}`，scope 0 = 禁注册、1 = 禁访问；只给 ip 时 Worker 端自动算段（IPv6 按 /64）。
- **配额**（`quota-api.js` / `quota-service.js`）：`GET /quota/resend` → `{day, month, dayBudget, monthBudget}`。
- **告警日志**（`alert-log-api.js`）：`POST /alertLog/record {type, text}`，source 由 Worker 端固定为 `patrol`。

## 安装与试运行

```bash
cd oracle-patrol
node --version          # ≥ 18 即可，零依赖，无需 npm install
npm test                # node:test，10 个用例（见“验证结果”）

# 试运行（dry-run：不写 Worker/WAF/TG/AbuseIPDB；读请求照常，只读 D1 + GET 配额）
node src/index.js --once --dry-run --config /path/config.json
# 缺配置时明确报错退出，不连真实 API：
#   [patrol] 巡检配置文件不存在: .../config.json。请复制 config.example.json ...

# 单轮实跑（会真封禁、真发 TG，确认无误再上 systemd）
node src/index.js --once
```

## systemd 部署（甲骨文两台）

> **首次上线不在本机执行**：先把本目录传到服务器、填好真实配置、跑通一次 `--once --dry-run` 与一次 `--once`，再启用服务。

**主服务 — 3 核 18G 实例 `129.225.13.58`（ubuntu 用户）：**

```bash
# 1. 传目录到 /opt/oracle-patrol（与 patrol.service 里的路径一致）
# 2. 真实配置（二选一，推荐环境变量放密码）：
cp config.example.json /opt/oracle-patrol/config.json   # 填真实值
#   或只把密码放环境变量文件（0600）：
sudo install -m 0600 /dev/null /etc/oracle-patrol.env
sudo tee /etc/oracle-patrol.env >/dev/null <<'EOF'
MAIL_PATROL_ADMIN_PASSWORD=...
EOF
# 3. 试运行 + 单轮实跑（确认 TG 能收到告警、WAF 规则正确）
cd /opt/oracle-patrol && node src/index.js --once --dry-run
cd /opt/oracle-patrol && node src/index.js --once
# 4. 启用服务
sudo cp patrol.service /etc/systemd/system/patrol.service
sudo systemctl daemon-reload && sudo systemctl enable --now patrol.service
sudo systemctl status patrol.service
sudo journalctl -u patrol.service -f   # 看日志；启动行只打印脱敏配置
```

**热备 — 1 核 6G 实例：** 同一份目录 + 同一份配置传过去，服务文件同样安装但**不启动**（`systemctl enable` 但不 `start`，或保持 `disable`）：

```bash
sudo cp patrol.service /etc/systemd/system/patrol.service
sudo systemctl daemon-reload && sudo systemctl enable patrol.service
# 主服务失联（TG 收到“巡检失联”告警）时，在热备上手动启动：
sudo systemctl start patrol.service
# 主恢复后停掉热备，避免双活重复封禁/重复告警：
sudo systemctl stop patrol.service
```

**Uptime Kuma push 心跳：** Kuma 里建一个 Push 类型的监控，把 URL 填进 `config.json` 的 `kumaPushUrl`（如 `https://kuma.example.com/api/push/xxxx`）。巡检每轮成功 GET 一次；连续失败时带 `status=down`。Kuma 超过 `intervalMinutes × 3` 没收到心跳即判为 down（建议 Kuma 端超时设 16 分钟）。

## 排障

| 现象 | 查法 |
|---|---|
| 启动即退出、`配置文件不存在` | `config.json` 是否在 `patrol.service` 的 `WorkingDirectory`（`/opt/oracle-patrol`）下；或用 `--config` 指定 |
| `配置缺失必填项` | 按报错列出的项补 `config.json` 或环境变量；密码可用 `MAIL_PATROL_ADMIN_PASSWORD` |
| TG 收不到告警 | 先看 `journalctl -u patrol.service` 有无 `TG 发送失败`；核对 `telegram.botToken/chatId`，机器人须已和 chat 建联 |
| WAF 规则没变 | 日志看 `WAF：IP 集未变`（正常）还是 `WAF 同步失败`（Token 缺 `Zone:Rulesets:Edit` 或规则集被手动改名——按 `wafRuleName` 查找，改名后会追加一条新规则，旧规则不会被删） |
| 连续“巡检失联” | 查 D1/Worker 是否可达：`node src/index.js --once --dry-run` 看步骤 1 报错；巡检挂了不影响主站注册/收发信 |
| `state.json` 损坏 | 直接删掉重建（默认态），只丢告警去重与 AbuseIPDB 缓存记录 |

## 交付记录（B 路，2026-11-08）

### 模块清单

- `package.json`（`type: module`，Node ≥ 18，`dependencies` 为空，零运行时依赖）+ `.gitignore`（忽略 `config.json` / `state.json` / `*.env`）+ `config.example.json`（只放 `YOUR_xxx` 占位符）+ `patrol.service`（systemd 单元）
- `src/config.js`（读配置 + 环境变量覆盖 + 校验必填 + 脱敏打印）、`src/d1.js`（D1 REST 只读查询）、`src/worker-api.js`（登录拿 JWT + `/ipBlocklist/add`、`/alertLog/record`、`/quota/resend`，401 重登一次，网络/5xx 重试 3 次）、`src/waf.js`（Rulesets API：先 GET entrypoint、只改目标规则、PUT 全量回写；表达式 `http.host eq "aevorynthtech.com" and ip.src in { ... }`）、`src/abuseipdb.js`（`/api/v2/check`，24h 缓存）、`src/telegram.js`（直调 TG Bot API，失败永不抛错）、`src/state.js`（`state.json`：lastWafSync、告警去重、AbuseIPDB 缓存、连续失败次数、lastRun）、`src/patrol.js`（单次巡检 5 步）、`src/index.js`（循环 + `--once` + `--dry-run` + `--config`）
- `test/patrol.test.js`（`node:test` + 内置 http mock 五方）
- 与 `mail-ultimate` 主代码零交集：只在 `oracle-patrol/` 内新建文件，未改其他任何文件（`git status` 核对：`oracle-patrol/` 为全新未追踪目录；其余改动均为 A/C 路并行工作）。

### 验证结果（实跑，全部通过）

- `npm test`（`node --test`，Node v24.22.1）：**10/10 通过**，约 1.1–2.9s。覆盖：config 缺文件/缺必填/环境变量覆盖/脱敏；WAF 表达式去重排序、IPv6 /64、过期行、已封判定、WAF IP 集；WAF 更新目标规则且保留其他规则（含 id）、未变不 PUT、缺失追加、空集不推、PUT 失败不抛错；AbuseIPDB 24h 缓存命中不调接口；巡检 ① 超限封禁（scope 0 + 原因写明次数）与已封跳过、WAF 同步含该 IP；巡检 ② 有举报封、无举报不封；巡检 ③ 日配额 80% 每天 1 次、月配额 100% 立即告警；dry-run 零写请求（Worker 封禁 / WAF PUT / TG / AbuseIPDB / alertLog 均为 0）；巡检 ⑤ 连续 3 轮 D1 失败发一次“巡检失联”、恢复后发“巡检恢复”；`index --once --dry-run` 子进程 exit 0、缺配置 exit 1。
  - 注意：`node --test test/` 在此 Node 版本下会把目录当模块解析而失败，改用 `node --test`（`npm test` 已按此写）。
- `node --check` 全部 9 个 `src/*.js` 通过。
- **试运行 1（缺配置）**：`node src/index.js --once --dry-run` → 明确报错、exit 1，未连任何 API：
  `[patrol] 巡检配置文件不存在: .../oracle-patrol/config.json。请复制 config.example.json 为 config.json 并填入真实值（切勿提交真实配置到 Git）；仅试运行可用 --dry-run + mock 配置。`
- **试运行 2（mock 全流程）**：本地 mock 服务器（D1 返回超限 IP `203.0.113.10` 5 次、已封 scope 1 行 `192.0.2.1`、近 1h 新 IP `198.51.100.7`；配额日 85/100），`node src/index.js --once --dry-run --config /tmp/patrol-trial/config.json` → exit 0，输出：`[dry-run] 将封禁 203.0.113.10（巡检：24h 内注册 5 次）`、`[dry-run][TG] ⚠️ Resend 配额告警（日）：85/100（85%）`、`[dry-run][WAF] 将推送规则 … in { 192.0.2.1 203.0.113.10 }`，汇总 `blocked:[203.0.113.10]`、`quota.dayPct:0.85`、`waf.dryRun:true`、`failed:false`；mock 侧收到的写请求 **0 条**（只有 3 次 D1 读 + 1 次登录 + 1 次配额 GET + 1 次 WAF GET）；启动行打印的配置中全部密钥均为 `********`；`state.json` 正常落盘（`quotaAlerts.day80: 2026-11-08`）。试运行中发现并已修复一处日志文案 bug（dry-run 下 WAF 曾误报“IP 集未变”）。
- 全程未连线上：开发与测试只调本地 mock 或 `--dry-run`；代码、日志、文档里无任何真实密钥/token/密码（`grep` 核对：除 `config.example.json` 的 `YOUR_xxx` 占位符外无密钥字样）。

### 未完成项

- [ ] **首次上线未执行**（按契约，不在本机执行）：真实 `config.json` 填写、甲骨文两台部署、`--once --dry-run` + `--once` 实跑、systemd 启用、Uptime Kuma push 监控创建。步骤见上文“systemd 部署”。
- [ ] **未做真实 WAF 规则创建验证**：WAF 目标规则 `mail-ultimate-ip-blocklist` 在新站 Zone 里是否已存在、PUT 全量回写是否与现有其他规则冲突，需上线时以 `--once --dry-run` 先看拟推送表达式，确认无误再实跑。现有规则不会被删（只改目标规则表达式，其余规则原样回写），但改名前请先在 CF 控制台核对规则名。
- [ ] **双活未做自动切换**：热备为手动启动/停止，未做自动故障转移（避免双活重复封禁/重复告警）；如需自动切换，应加分布式锁或由 Kuma 告警触发人工操作。
- [ ] **AbuseIPDB 类别映射只覆盖官方 1–23 号类别**，未知类别号显示为 `类别#N`；不影响封禁判定。
- [ ] dry-run 下 AbuseIPDB 查询被跳过（省额度），因此试运行看不到步骤 2 的“拟封禁”判定；要验证步骤 2 请看单测“巡检②”或用非 dry-run 的 `--once` 实跑。
