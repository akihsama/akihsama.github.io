#!/usr/bin/env bash
# 把 Worker 地址写进前端 index.html，并校验没有把占位符 / /api 前缀写错。
# 用法：cp frontend.conf.example frontend.conf && 填 WORKER_URL && bash frontend.sh
set -euo pipefail
cd "$(dirname "$0")"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BLD=$'\033[1m'; NC=$'\033[0m'
say() { printf '%s==>%s %s\n' "$GRN" "$NC" "$*"; }
warn() { printf '%s[!]%s %s\n' "$YEL" "$NC" "$*"; }
die() { printf '%s[x]%s %s\n' "$RED" "$NC" "$*"; exit 1; }

[ -f frontend.conf ] || die "缺少 frontend.conf（cp frontend.conf.example frontend.conf 后填 WORKER_URL）"
# shellcheck disable=SC1091
set -a; . ./frontend.conf; set +a

URL="${WORKER_URL:-}"
[ -n "$URL" ] || die "frontend.conf 里 WORKER_URL 是空的"
URL="${URL%/}"; URL="${URL%/api}"
case "$URL" in
  https://*) ;;
  *) die "WORKER_URL 必须以 https:// 开头，当前：$URL" ;;
esac

# 定位前端文件
TARGET=""
for c in "$(cd .. && pwd)/app/index.html" "../app/index.html" "app/index.html"; do
  [ -f "$c" ] && TARGET="$c" && break
done
[ -n "$TARGET" ] || { warn "找不到 app/index.html，请在仓库根目录执行本脚本"; exit 1; }
say "目标文件：$TARGET"

# ── 探活（失败不阻断）──────────────────────────────────────────────
say "探活 $URL/api/v1/health"
CODE=$(curl -sS -o /tmp/_hf.json -w '%{http_code}' --connect-timeout 10 --max-time 25 "$URL/api/v1/health" 2>/dev/null || true)
if [ "$CODE" = "200" ]; then
  node -e 'const j=require("/tmp/_hf.json");const st=v=>v==="configured"?"已配置":"未配置("+v+")";
  console.log("  version :",j.version,"| model :",j.model);
  console.log("  deepseek:",st(j.platforms.deepseek),"| meituan:",st(j.platforms.meituan),"| shangou:",st(j.platforms.shangou));
  const b=j.budget||{}; console.log("  预算    : 已用",b.usedYuan,"/",b.budgetYuan,"元，剩",b.callsLeft,"次问答")' || true
else
  warn "探活没拿到 200（HTTP ${CODE:-超时}）。可能原因：Worker 还没部署、地址拼错，或本机到 workers.dev 不通"
  warn "仍会先写入地址；Worker 部署好后再跑一次本脚本即可复核"
fi

# ── 改 index.html ──────────────────────────────────────────────────
node - "$TARGET" "$URL" <<'EOF'
const fs = require('fs');
const [file, url] = process.argv.slice(2);
let s = fs.readFileSync(file, 'utf8');
// 只匹配代码里那行赋值，不碰注释里的示例
const re = /^([ \t]*const\s+API_BASE\s*=\s*)(['"])(.*?)\2;/m;
const m = s.match(re);
if (!m) { console.error('没找到未注释的 const API_BASE = "..."; 那行，文件结构可能变了'); process.exit(1); }
const old = m[3];
s = s.replace(re, (_all, head) => `${head}'${url}';`);
if (/^[ \t]*const\s+USE_MOCK\s*=\s*true;/m.test(s)) console.warn('[!] USE_MOCK 仍是 true，上线前记得关掉 mock');
fs.writeFileSync(file, s);
console.log(`  API_BASE: ${old || '(空)'} -> ${url}`);
EOF

say "完成"
if [ -n "$(cd "$(dirname "$TARGET")" && pwd)" ]; then
  say "本机预览：${BLD}cd $(cd "$(dirname "$TARGET")" && pwd) && python3 -m http.server 8000${NC}"
fi
