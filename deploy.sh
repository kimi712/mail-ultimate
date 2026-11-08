#!/usr/bin/env bash
# 终极版邮箱 · 一键部署脚本（aevorynthtech.com）
# 用法：
#   cd ~/workspace/mail-ultimate
#   cp .deploy.env.example .deploy.env   # 首次：填好真实值（见 DEPLOY.md §1/§3）
#   ./deploy.sh
# 本脚本只做：校验配置 -> 前端构建 -> 生成 wrangler.deploy.toml -> wrangler deploy。
# 不跑 /init（部署后按 DEPLOY.md §6 人工确认再调）；不碰老站 mail.flame.edu.kg；
# 不提交任何密钥；.deploy.env 与生成的 wrangler.deploy.toml 均已加入 .gitignore。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.deploy.env"
[ -f "$ENV_FILE" ] || { echo "❌ 缺少 .deploy.env：先 cp .deploy.env.example .deploy.env 并填好真实值（见 DEPLOY.md §1/§3）"; exit 1; }
# shellcheck disable=SC1091
set -a; . "$ENV_FILE"; set +a

for v in D1_DATABASE_ID KV_NAMESPACE_ID R2_BUCKET_NAME ADMIN JWT_SECRET; do
	[ -n "${!v:-}" ] || { echo "❌ .deploy.env 缺少必填项：$v"; exit 1; }
done
[ "${#JWT_SECRET}" -ge 32 ] || { echo "❌ JWT_SECRET 太短（需 ≥32 字符，请用 openssl rand -hex 32 重新生成，绝不复用老站）"; exit 1; }
[ "$JWT_SECRET" != "phase1-local-test-only-not-a-real-secret" ] || { echo "❌ JWT_SECRET 是本地测试 dummy 值，部署前必须重新生成"; exit 1; }
GH_REPO="${GH_REPO:-}"
PROJECT_LINK="https://github.com/${GH_REPO:-aevorynthtech/mail-ultimate}"

command -v node >/dev/null || { echo "❌ 未找到 node"; exit 1; }
command -v npx >/dev/null || { echo "❌ 未找到 npx"; exit 1; }

echo "==> [1/3] 前端构建（mail-vue -> mail-worker/dist）"
npm --prefix mail-vue install --legacy-peer-deps --no-package-lock --no-save
npm --prefix mail-vue run build
[ -f mail-worker/dist/index.html ] || { echo "❌ 前端构建产物缺失：mail-worker/dist/index.html"; exit 1; }

echo "==> [2/3] 生成 mail-worker/wrangler.deploy.toml（变量来自 .deploy.env，不提交）"
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

echo "==> [3/3] wrangler deploy（Worker mail-ultimate -> aevorynthtech.com）"
npx --prefix mail-worker wrangler deploy --config wrangler.deploy.toml 2>/dev/null || \
	(cd mail-worker && npx wrangler deploy --config wrangler.deploy.toml)

cat <<'EOF'

✅ 部署命令已执行。接下来按 DEPLOY.md §6 人工核对（不要跳过）：
  1. 跑 /init 建库：curl "https://aevorynthtech.com/api/init/<JWT_SECRET>"（只跑一次，幂等）
  2. 核对 D1：user.locale 列、setting 新列、login_log/alert_log/register_log/audit_log/ip_blocklist 五表、perm 37–45
  3. 管理后台填 Turnstile / Resend / TG，确认注册验证 = OPEN，建注册密钥
  4. 收发信冒烟 + 风控冒烟（见 DEPLOY.md §6）
  5. 甲骨文巡检上线（oracle-patrol/README.md）+ WAF 规则 mail-ultimate-ip-blocklist
EOF
