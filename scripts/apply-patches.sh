#!/usr/bin/env bash
# 按 patches/README.md 顺序应用所有补丁，并把 additions/ 下的新文件 copy 到 upstream/。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM_DIR="${UPSTREAM_DIR:-$REPO_ROOT/upstream}"

# 应用顺序（见 patches/README.md）
MODULES=(
  property-trace
  network-analysis
  cookie-js-analysis
  fingerprint
  proxy
  jsvmp-trace
  agent-ui
  branding
)

if [[ ! -d "$UPSTREAM_DIR" ]]; then
  echo "[apply-patches] $UPSTREAM_DIR 不存在，先执行 ./scripts/bootstrap.sh" >&2
  exit 1
fi

cd "$UPSTREAM_DIR"

for module in "${MODULES[@]}"; do
  patches_dir="$REPO_ROOT/patches/$module"
  if [[ -d "$patches_dir" ]]; then
    shopt -s nullglob
    files=("$patches_dir"/*.patch)
    if (( ${#files[@]} == 0 )); then
      echo "[apply-patches] $module: 无 .patch 文件，跳过"
      continue
    fi
    echo "[apply-patches] $module: applying ${#files[@]} patches"
    for p in "${files[@]}"; do
      # 幂等：反打检查能过 = 该补丁已在工作树里 → 跳过（重复执行脚本安全，二开迭代常用）。
      if git apply --reverse --check "$p" >/dev/null 2>&1; then
        echo "  [skip] 已应用: $(basename "$p")"
      else
        git apply --index "$p"
      fi
    done
  fi
done

# 拷贝 additions/
if [[ -d "$REPO_ROOT/additions" ]]; then
  if [[ -n "$(find "$REPO_ROOT/additions" -mindepth 1 -not -name 'README.md' -print -quit 2>/dev/null)" ]]; then
    echo "[apply-patches] copying additions/ to $UPSTREAM_DIR"
    # 排除 agent-sidebar 的前端开发文件（Firefox 构建只需 bundle/html/css + .sys.mjs）
    # Windows 注意：原生 rsync 会把 "D:/..." 盘符路径误判为 host:path 远程语法，
    # 故统一切到 REPO_ROOT 用相对路径执行；rsync 不可用时退化为 cp -R。
    cd "$REPO_ROOT"
    REL_UPSTREAM="$(python3 -c "import os.path,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))" "$UPSTREAM_DIR" "$REPO_ROOT")"
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --exclude README.md --exclude node_modules --exclude dev \
        --exclude '*.jsx' --exclude 'package*.json' --exclude .gitignore \
        "additions/" "$REL_UPSTREAM/"
    else
      find additions -mindepth 1 -maxdepth 1 ! -name README.md -exec cp -R {} "$UPSTREAM_DIR/" \;
    fi
  fi
fi

python3 "$REPO_ROOT/scripts/apply-fingerprint-config.py" "$UPSTREAM_DIR"

echo "[apply-patches] done."
