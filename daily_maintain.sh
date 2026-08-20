#!/bin/bash
# 大纵观共识 · 每日维护脚本（收盘后执行）
# 体检：语法检查 + 接口健康；校准：期货主力合约换月检测；提交：有变更自动 git commit
cd "$(dirname "$0")"

NODE="C:/Users/ayscm/.workbuddy/binaries/node/versions/22.22.2/node.exe"
PY="C:/Users/ayscm/.workbuddy/binaries/python/versions/3.13.12/python.exe"
DATE=$(date +%Y-%m-%d)

echo "========== 大纵观共识 每日维护 $DATE =========="

echo "--- [1] 代码语法体检 ---"
"$NODE" --check server.js && echo "  server.js 语法OK"
"$NODE" --check analysis.js && echo "  analysis.js 语法OK"

echo "--- [2] 接口健康检查（本地服务若在跑） ---"
if curl -s -m 5 -o /dev/null "http://localhost:8080/api/markets"; then
  echo "  本地服务正常"
else
  echo "  本地服务未运行（跳过，属正常，生产在服务器上）"
fi

echo "--- [3] 期货主力合约换月校准 ---"
"$PY" gen_futures.py 2>&1 | tail -3

echo "--- [4] 全市场股票清单校准（新股/退市） ---"
if [ -f gen_all_stocks.py ]; then
  "$PY" gen_all_stocks.py 2>&1 | tail -2
else
  echo "  gen_all_stocks.py 不存在，跳过"
fi

echo "--- [5] git 变更检测与提交 ---"
git add -A 2>/dev/null
if git diff --cached --quiet; then
  echo "  无变更，无需提交"
else
  git commit -m "chore: 每日维护 $DATE（主力合约/股票清单校准）" 2>&1 | tail -2
  echo "  已提交"
fi

echo "========== 维护完成 =========="
