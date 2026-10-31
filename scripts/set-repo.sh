#!/usr/bin/env bash
# 把仓库里的占位地址替换成你自己的仓库地址（Gitee + GitHub 一起改）
#
#   ./scripts/set-repo.sh <Gitee空间> [仓库名] [GitHub空间]
#
#   ./scripts/set-repo.sh jacky mserm-crm              # 两个平台同名
#   ./scripts/set-repo.sh jacky mserm-crm mserm-org    # GitHub 用组织名
#
# 只改已跟踪的文本文件；替换后会提示哪些文件被改动。
set -euo pipefail

OWNER="${1:-}"
REPO="${2:-mserm-crm}"
GH_OWNER="${3:-$OWNER}"

if [[ -z "$OWNER" ]]; then
  cat <<'EOF'
用法：./scripts/set-repo.sh <Gitee空间> [仓库名] [GitHub空间]

  ./scripts/set-repo.sh jacky mserm-crm
  ./scripts/set-repo.sh jacky mserm-crm mserm-org
EOF
  exit 1
fi

cd "$(dirname "$0")/.."

OLD_GITEE="gitee.com/mserm/mserm-crm"
OLD_GITHUB="github.com/mserm/mserm-crm"
NEW_GITEE="gitee.com/$OWNER/$REPO"
NEW_GITHUB="github.com/$GH_OWNER/$REPO"

# 只处理已跟踪的文本文件，避免动到 .db / 二进制
mapfile -t FILES < <(git ls-files)

CHANGED=0
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || continue
  # 跳过本脚本自身（里面就有这两个占位常量）
  [[ "$f" == "scripts/set-repo.sh" ]] && continue
  if grep -qF -e "$OLD_GITEE" -e "$OLD_GITHUB" "$f" 2>/dev/null; then
    sed -e "s|$OLD_GITEE|$NEW_GITEE|g" -e "s|$OLD_GITHUB|$NEW_GITHUB|g" \
      "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    echo "已更新 $f"
    CHANGED=$((CHANGED + 1))
  fi
done

echo
if [[ "$CHANGED" == "0" ]]; then
  echo "没有找到占位地址，可能已经替换过了。当前地址："
else
  echo "完成，共更新 $CHANGED 个文件。"
fi
echo "  Gitee ：https://$NEW_GITEE"
echo "  GitHub：https://$NEW_GITHUB"
echo
echo "提交改动：git add -A && git commit -m 'chore: 更新仓库地址'"
