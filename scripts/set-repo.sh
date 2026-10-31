#!/usr/bin/env bash
# 把仓库里所有占位地址（gitee.com/mserm/mserm-crm）替换成你自己的仓库地址
#
#   ./scripts/set-repo.sh <空间地址> [仓库名]
#   例：./scripts/set-repo.sh jacky mserm-crm
set -euo pipefail

OWNER="${1:-}"
REPO="${2:-mserm-crm}"
if [[ -z "$OWNER" ]]; then
  echo "用法：./scripts/set-repo.sh <Gitee 空间地址> [仓库名]"; exit 1
fi

cd "$(dirname "$0")/.."
OLD="gitee.com/mserm/mserm-crm"
NEW="gitee.com/$OWNER/$REPO"

FILES=(
  README.md
  package.json
  site/src/routes.js
  site/.env.example
  docs/13-开源版与数据库获取.md
  CONTRIBUTING.md
)

for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || continue
  if grep -q "$OLD" "$f"; then
    # macOS 与 GNU sed 的 -i 参数不同，这里用临时文件保证兼容
    sed "s|$OLD|$NEW|g" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    echo "已更新 $f"
  fi
done

echo
echo "完成。当前仓库地址：https://$NEW"
echo "如已提交过，请执行：git add -A && git commit -m 'chore: 更新仓库地址'"
