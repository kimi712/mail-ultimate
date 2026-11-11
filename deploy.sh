#!/usr/bin/env bash
# 终极版邮箱 · 一键部署脚本（aevorynthtech.com）
# 用法：
#   cd ~/workspace/mail-ultimate
#   cp .deploy.env.example .deploy.env   # 首次：填好真实值（见 DEPLOY.md §1/§3）
#   ./deploy.sh
# 本脚本只做：校验配置 -> 前端构建 -> 生成 wrangler.deploy.toml -> 设置 field_enc_key
# secret 并校验 -> wrangler deploy。
# 不跑 /init（部署后按 DEPLOY.md §6 人工确认再调）；不碰老站 mail.flame.edu.kg；
# 不提交任何密钥；.deploy.env 与生成的 wrangler.deploy.toml 均已加入 .gitignore。
# Phase 8 §8.1：field_enc_key 必须是 wrangler secret，deploy.sh 每次部署都从
# .deploy.env 的 FIELD_ENC_KEY 设置它（值绝不打印、不写日志）；三项校验任一
# 失败即停部署——密钥长度 ≥32 且非 dummy、secret list 含 field_enc_key、
# 生成的 wrangler.deploy.toml 不得含 field_enc_key 的 [vars] 明文值。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.deploy.env"
[ -f "$ENV_FILE" ] || { echo "❌ 缺少 .deploy.env：先 cp .deploy.env.example .deploy.env 并填好真实值（见 DEPLOY.md §1/§3）"; exit 1; }
# shellcheck disable=SC1091
set -a; . "$ENV_FILE"; set +a

for v in D1_DATABASE_ID KV_NAMESPACE_ID R2_BUCKET_NAME ADMIN JWT_SECRET FIELD_ENC_KEY; do
	[ -n "${!v:-}" ] || { echo "❌ .deploy.env 缺少必填项：$v"; exit 1; }
done
[ "${#JWT_SECRET}" -ge 32 ] || { echo "❌ JWT_SECRET 太短（需 ≥32 字符，请用 openssl rand -hex 32 重新生成，绝不复用老站）"; exit 1; }
[ "$JWT_SECRET" != "phase1-local-test-only-not-a-real-secret" ] || { echo "❌ JWT_SECRET 是本地测试 dummy 值，部署前必须重新生成"; exit 1; }
# Phase 8 §8.1：FIELD_ENC_KEY 与 JWT_SECRET 绝不复用；长度 ≥32 且不得是本地测试 dummy 值。
# 值只经 stdin 传给 wrangler secret put，本脚本任何地方都不打印它、不写进日志。
FIELD_ENC_KEY_DUMMY="phase56-local-test-only-not-a-real-secret"
[ "${#FIELD_ENC_KEY}" -ge 32 ] || { echo "❌ FIELD_ENC_KEY 太短（需 ≥32 字符，请用 openssl rand -hex 32 重新生成，绝不复用 JWT_SECRET 与老站密钥）"; exit 1; }
[ "$FIELD_ENC_KEY" != "$FIELD_ENC_KEY_DUMMY" ] || { echo "❌ FIELD_ENC_KEY 是本地测试 dummy 值，部署前必须重新生成"; exit 1; }
GH_REPO="${GH_REPO:-}"
PROJECT_LINK="https://github.com/${GH_REPO:-aevorynthtech/mail-ultimate}"

command -v node >/dev/null || { echo "❌ 未找到 node"; exit 1; }
command -v npx >/dev/null || { echo "❌ 未找到 npx"; exit 1; }

echo "==> [1/4] 前端构建（mail-vue -> mail-worker/dist）"
npm --prefix mail-vue install --legacy-peer-deps --no-package-lock --no-save
npm --prefix mail-vue run build
[ -f mail-worker/dist/index.html ] || { echo "❌ 前端构建产物缺失：mail-worker/dist/index.html"; exit 1; }

echo "==> [2/4] 生成 mail-worker/wrangler.deploy.toml（变量来自 .deploy.env，不提交）"
cat > mail-worker/wrangler.deploy.toml <<EOF
# 由 deploy.sh 生成（aevorynthtech.com 部署专用），不要手改、不要提交。
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
bucket_name = "${R2_BUCKET_NAME}"

# TEMP 2026-11-08：CF Email Sending 未在面板开通，email 绑定存在会让站外信优先走 CF 并报
# "destination address is not a verified address"、且不回落 Resend；先去掉 email 绑定，
# 让站外信走已验证的 Resend（付费 Key），等面板开通 CF 发信并验证发送域名后再恢复本段并重部署。
#[[send_email]]
#name = "email"

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
project_link = "${PROJECT_LINK}"

[build]
command = "npm --prefix ../mail-vue install --legacy-peer-deps --no-package-lock --no-save && npm --prefix ../mail-vue run build"
EOF

# Phase 8 §8.1：部署时校验（任一失败即停部署，set -e 下直接退出）。
# 校验 1：生成的 wrangler.deploy.toml 不得含 field_enc_key 的 [vars] 明文值
# （secret 与 vars 同名时 secret 优先，但明文 vars 是泄漏面，必须杜绝；
# 本模板本来就不写它，这里是防呆——万一将来有人加回去，部署立刻停住）。
echo "==> [3/4] 设置 field_enc_key secret 并校验（值不打印、不写日志）"
if grep -q "field_enc_key" mail-worker/wrangler.deploy.toml; then
	echo "❌ wrangler.deploy.toml 里出现 field_enc_key（疑似 [vars] 明文值）：field_enc_key 只允许以 wrangler secret 形式配置，禁止写进 toml"
	exit 1
fi
# 注意：wrangler 命令必须在 mail-worker 目录下用 --config wrangler.deploy.toml
# 跑（直接在仓库根目录跑会报 Worker name missing）；密钥值只经 stdin 传入。
printf '%s' "$FIELD_ENC_KEY" | (cd mail-worker && npx wrangler secret put field_enc_key --config wrangler.deploy.toml) || {
	echo "❌ wrangler secret put field_enc_key 失败，停止部署"
	exit 1
}
# 校验 2：wrangler secret list 含 field_enc_key（确认 secret 真的落到了线上 Worker）。
SECRET_LIST="$(cd mail-worker && npx wrangler secret list --config wrangler.deploy.toml)" || {
	echo "❌ wrangler secret list 失败，无法确认 field_enc_key 已设置，停止部署"
	exit 1
}
echo "$SECRET_LIST" | grep -q "field_enc_key" || {
	echo "❌ wrangler secret list 里没有 field_enc_key，停止部署（请检查 secret 是否设到了 Worker mail-ultimate 上）"
	exit 1
}
echo "✅ field_enc_key secret 已设置并核对通过（长度 ≥32、非 dummy、secret list 可见、toml 无明文）"

echo "==> [4/4] wrangler deploy（Worker mail-ultimate -> aevorynthtech.com）"
npx --prefix mail-worker wrangler deploy --config wrangler.deploy.toml 2>/dev/null || \
	(cd mail-worker && npx wrangler deploy --config wrangler.deploy.toml)

cat <<'EOF'

✅ 部署命令已执行。接下来按 DEPLOY.md §6 人工核对（不要跳过）：
  1. 跑 /init 建库：curl "https://aevorynthtech.com/api/init/<JWT_SECRET>"（只跑一次，幂等）
  2. 核对 D1：user.locale 列、setting 新列、login_log/alert_log/register_log/audit_log/ip_blocklist 五表、perm 37–45
     以及默认角色：role_id=1 应为 send_type='day'、send_count=50（不是 ban）
  2b. 核对密钥：跑完 /init 后用 REST API 核对 KV 的 setting: 缓存里 resendTokens 含发件域名
     （只核对域名 key 是否存在，不打印密钥值）；新注册测试账号能发站外信（见 DEPLOY.md §6）
  3. 管理后台填 Turnstile / Resend / TG，确认注册验证 = OPEN，建注册密钥
  4. 收发信冒烟 + 风控冒烟（见 DEPLOY.md §6）
  5. 甲骨文巡检上线（oracle-patrol/README.md）+ WAF 规则 mail-ultimate-ip-blocklist
EOF
