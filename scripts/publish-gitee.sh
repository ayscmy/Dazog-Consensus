#!/usr/bin/env bash
# ============================================================
# 一键发布到 Gitee
#
# 准备：
#   1. Gitee → 设置 → 私人令牌，勾选 projects 权限，复制令牌
#   2. 在仓库目录执行：
#
#      GITEE_TOKEN=你的令牌 \
#      GITEE_OWNER=你的空间地址 \
#      GITEE_REPO=mserm-crm \
#      ./scripts/publish-gitee.sh
#
# 说明：
#   - 仓库已存在时会跳过创建，直接推送
#   - 令牌只用于本次推送，不会写进 .git/config
# ============================================================
set -euo pipefail

OWNER="${GITEE_OWNER:-}"
REPO="${GITEE_REPO:-mserm-crm}"
TOKEN="${GITEE_TOKEN:-}"
DESC="${GITEE_DESC:-开源的集团级销售与回款管理系统：线索、商机、报价、合同、开票、回款一条链路。Node 22 + SQLite，零第三方依赖。}"

if [[ -z "$TOKEN" || -z "$OWNER" ]]; then
  cat <<'EOF'
缺少参数。

  GITEE_TOKEN   Gitee 私人令牌（设置 → 私人令牌，勾选 projects）
  GITEE_OWNER   Gitee 个人空间地址（个人主页 URL 里 gitee.com/ 后面那段）
  GITEE_REPO    仓库名，默认 mserm-crm

示例：
  GITEE_TOKEN=abc123 GITEE_OWNER=jacky ./scripts/publish-gitee.sh
EOF
  exit 1
fi

cd "$(dirname "$0")/.."

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "当前目录不是 Git 仓库"; exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "==> 当前分支：$BRANCH"

# 提交前兜底检查：确认没有把数据库带进版本库
if git ls-files | grep -qiE '\.(db|sqlite|zip|7z)$|^data/|^release/|^private/'; then
  echo "!! 检测到数据库或安装包已被跟踪，请先执行："
  echo "   git rm --cached -r data release private"
  exit 1
fi

echo "==> 检查 Gitee 仓库 $OWNER/$REPO"
HTTP="$(curl -s -o /tmp/gitee_repo.json -w '%{http_code}' \
  "https://gitee.com/api/v5/repos/$OWNER/$REPO?access_token=$TOKEN")"

if [[ "$HTTP" == "200" ]]; then
  echo "    仓库已存在，直接推送"
else
  echo "    创建仓库…"
  CREATE="$(curl -s -o /tmp/gitee_create.json -w '%{http_code}' -X POST \
    "https://gitee.com/api/v5/user/repos" \
    -d "access_token=$TOKEN" \
    -d "name=$REPO" \
    -d "description=$DESC" \
    -d "private=false" \
    -d "auto_init=false" \
    -d "has_issues=true" \
    -d "has_wiki=false")"
  if [[ "$CREATE" != "201" && "$CREATE" != "200" ]]; then
    echo "!! 创建失败（HTTP $CREATE）："
    cat /tmp/gitee_create.json; echo
    exit 1
  fi
  echo "    已创建"
fi

REMOTE="https://gitee.com/$OWNER/$REPO.git"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE"
else
  git remote add origin "$REMOTE"
fi

echo "==> 推送 $BRANCH → origin"
# 用带令牌的临时 URL 推送，避免令牌落到 .git/config
git push "https://oauth2:$TOKEN@gitee.com/$OWNER/$REPO.git" "$BRANCH:main"

git fetch origin --quiet || true
git branch --set-upstream-to="origin/main" "$BRANCH" 2>/dev/null || true

echo
echo "完成：https://gitee.com/$OWNER/$REPO"
echo "别忘了在仓库「管理 → 开源设置」里确认许可证为 AGPL-3.0，并填写项目简介与标签。"
