#!/usr/bin/env bash
# ============================================================
# 一键发布：Gitee（主）+ GitHub（镜像）
#
#   ./scripts/publish.sh            # 两边都推
#   ./scripts/publish.sh gitee      # 只推 Gitee
#   ./scripts/publish.sh github     # 只推 GitHub
#
# 需要环境变量：
#   GITEE_OWNER     Gitee 空间地址（个人主页 gitee.com/ 后面那段）
#   GITEE_TOKEN     Gitee 私人令牌（设置 → 私人令牌，勾选 projects）
#   GITHUB_OWNER    GitHub 用户名或组织名
#   GITHUB_TOKEN    GitHub Personal Access Token（classic，勾选 repo）
#
# 可选：
#   REPO_NAME       仓库名，默认 mserm-crm（两边同名）
#   BRANCH          分支，默认取当前分支
#   GITEE_DESC / GITHUB_DESC   仓库简介
#
# 说明：
#   - 仓库不存在时用 API 自动创建（公开、不初始化 README）
#   - 令牌只在推送瞬间通过 GIT_ASKPASS 传入，不写入 .git/config，也不会出现在 URL 里
#   - 推送前检查版本库里有没有 .db / release/ / private/，有则中断
# ============================================================
set -euo pipefail

TARGET="${1:-both}"
REPO_NAME="${REPO_NAME:-mserm-crm}"
DESC="${GITEE_DESC:-开源的集团级销售与回款管理系统：线索、商机、报价、合同、开票、回款一条链路。Node 22 + SQLite，零第三方依赖。}"

case "$TARGET" in
  both|gitee|github) ;;
  *) echo "用法：./scripts/publish.sh [both|gitee|github]"; exit 1 ;;
esac

cd "$(dirname "$0")/.."

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "当前目录不是 Git 仓库"; exit 1
fi

BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
echo "==> 分支：$BRANCH   目标：$TARGET"

# ---------- 推送前兜底检查 ----------
if git ls-files | grep -qiE '\.(db|sqlite|sqlite3|zip|7z)$|^data/|^release/|^private/|(^|/)\.env$'; then
  echo "!! 版本库里出现了数据库 / 安装包 / 私有目录，已中断。请先执行："
  echo "   git rm --cached -r data release private"
  git ls-files | grep -iE '\.(db|sqlite|sqlite3|zip|7z)$|^data/|^release/|^private/|(^|/)\.env$' | head
  exit 1
fi

# 未提交的改动提醒（不阻塞）
if [[ -n "$(git status --porcelain)" ]]; then
  echo "!! 有未提交的改动，推送的是已提交内容："
  git status --short | head -5
fi

# ---------- 临时 askpass，避免令牌落到配置文件或进程参数里 ----------
ASKPASS="$(mktemp)"
trap 'rm -f "$ASKPASS" 2>/dev/null || true' EXIT
cat > "$ASKPASS" <<'EOS'
#!/bin/sh
case "$1" in
  *[Uu]sername*) printf '%s' "$GIT_USER" ;;
  *[Pp]assword*) printf '%s' "$GIT_PASS" ;;
esac
EOS
chmod +x "$ASKPASS"

push_remote() {  # push_remote <别名> <url> <用户名> <令牌>
  local name="$1" url="$2" user="$3" token="$4"
  if git remote get-url "$name" >/dev/null 2>&1; then
    git remote set-url "$name" "$url"
  else
    git remote add "$name" "$url"
  fi
  # 关掉 credential.helper，只让临时 askpass 提供凭据：令牌不进任何配置文件
  GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 GIT_USER="$user" GIT_PASS="$token" \
    git -c credential.helper= push --quiet -u "$name" "$BRANCH:refs/heads/$BRANCH" \
    && echo "    推送成功 → $url"
}

# ---------- Gitee ----------
publish_gitee() {
  local owner="${GITEE_OWNER:-}" token="${GITEE_TOKEN:-}"
  if [[ -z "$owner" || -z "$token" ]]; then
    echo "!! 缺少 GITEE_OWNER / GITEE_TOKEN，跳过 Gitee"; return 1
  fi
  echo "==> Gitee: $owner/$REPO_NAME"
  local api="https://gitee.com/api/v5"
  local code
  code="$(curl -s -o /tmp/gitee_repo.json -w '%{http_code}' -m 30 \
    "$api/repos/$owner/$REPO_NAME?access_token=$token")"
  if [[ "$code" == "200" ]]; then
    echo "    仓库已存在"
  else
    echo "    创建仓库…"
    code="$(curl -s -o /tmp/gitee_create.json -w '%{http_code}' -m 30 -X POST "$api/user/repos" \
      -d "access_token=$token" -d "name=$REPO_NAME" -d "description=$DESC" \
      -d "private=false" -d "auto_init=false" -d "has_issues=true" -d "has_wiki=false")"
    if [[ "$code" != "201" && "$code" != "200" ]]; then
      echo "!! 创建失败（HTTP $code）："; cat /tmp/gitee_create.json; echo; return 1
    fi
    echo "    已创建"
  fi
  push_remote origin "https://gitee.com/$owner/$REPO_NAME.git" "$owner" "$token"
  echo "    仓库地址：https://gitee.com/$owner/$REPO_NAME"
}

# ---------- GitHub ----------
publish_github() {
  local owner="${GITHUB_OWNER:-}" token="${GITHUB_TOKEN:-}"
  if [[ -z "$owner" || -z "$token" ]]; then
    echo "!! 缺少 GITHUB_OWNER / GITHUB_TOKEN，跳过 GitHub"; return 1
  fi
  echo "==> GitHub: $owner/$REPO_NAME"
  local api="https://api.github.com"
  local code
  code="$(curl -s -o /tmp/gh_repo.json -w '%{http_code}' -m 30 \
    -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" \
    "$api/repos/$owner/$REPO_NAME")"
  if [[ "$code" == "200" ]]; then
    echo "    仓库已存在"
  elif [[ "$code" == "404" ]]; then
    echo "    创建仓库…"
    code="$(curl -s -o /tmp/gh_create.json -w '%{http_code}' -m 30 -X POST "$api/user/repos" \
      -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" \
      -d "{\"name\":\"$REPO_NAME\",\"description\":\"$DESC\",\"private\":false,\"has_issues\":true,\"has_wiki\":false,\"auto_init\":false}")"
    if [[ "$code" != "201" && "$code" != "200" ]]; then
      echo "!! 创建失败（HTTP $code）："; cat /tmp/gh_create.json; echo; return 1
    fi
    echo "    已创建"
  else
    echo "!! 查询失败（HTTP $code），请检查令牌权限（需 repo 范围）："; head -c 300 /tmp/gh_repo.json; echo; return 1
  fi
  push_remote github "https://github.com/$owner/$REPO_NAME.git" "$owner" "$token"
  echo "    仓库地址：https://github.com/$owner/$REPO_NAME"
}

FAILED=0
[[ "$TARGET" == "both" || "$TARGET" == "gitee" ]] && { publish_gitee || FAILED=1; }
[[ "$TARGET" == "both" || "$TARGET" == "github" ]] && { publish_github || FAILED=1; }

echo
if [[ "$FAILED" == "1" ]]; then
  echo "部分目标未完成，检查上面的提示后重试。"
  exit 1
fi
echo "完成。后续每次提交，执行 ./scripts/publish.sh 即可让两边保持同步。"
echo "Gitee 建仓后记得在「管理 → 开源设置」确认许可证 AGPL-3.0、填写简介与标签。"
