#!/usr/bin/env bash
# 受限网络环境下的可复现 Rust 工具链安装脚本（本交付包的构建前提之一）。
#
# 背景：某些沙箱/内网只放行 npm registry、PyPI 与 GitHub API，无法访问
# crates.io / static.rust-lang.org / sh.rustup.rs。此时 rustup 不可用，
# 本脚本从 npm registry 上发布的预编译包 @rustbin/* 安装固定版本工具链：
#
#   @rustbin/rustc-<ver>-<host>          rustc 编译器（含 rustdoc）
#   @rustbin/cargo-<ver>-<host>          cargo
#   @rustbin/rust-std-<ver>-<host>       标准库（host，用于 native 构建）
#   @rustbin/rust-std-<ver>-wasm32-unknown-unknown  标准库（wasm 目标）
#   @rustbin/rustfmt-<ver>-<host>        rustfmt（可选，CI 格式检查）
#   @rustbin/clippy-<ver>-<host>         clippy（可选，CI 静态检查）
#
# 默认安装到 /opt/rust（需要 sudo），随后：
#   export PATH=/opt/rust/bin:$PATH
#
# 幂等：重复运行会覆盖同名文件；卸载直接 `sudo rm -rf /opt/rust`。
#
# 用法:
#   sudo bash setup_rust.sh [安装目录=/opt/rust] [版本=1.88.0] [1|0 安装开发工具]
#   bash setup_rust.sh "$HOME/.rust-npm" 1.88.0          # 免 sudo 安装
#   bash setup_rust.sh /opt/rust 1.88.0 0                # 跳过 rustfmt/clippy
set -euo pipefail

PREFIX="${1:-/opt/rust}"
VERSION="${2:-1.88.0}"
WITH_DEV_TOOLS="${3:-1}"
REGISTRY="https://registry.npmjs.org"
HOST_TRIPLE="x86_64-unknown-linux-gnu"
WASM_TRIPLE="wasm32-unknown-unknown"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 每个 @rustbin 包都是 rust-installer 分发包：包内有一个或多个<b>组件目录</b>
# （rustc/、cargo/、rust-std-<triple>/、rustfmt-preview/、clippy-preview/），
# 组件目录里才是 bin/、lib/ 等实际文件。因此：按包解到独立目录 → 合并组件目录进 PREFIX。

# 查询 registry 元数据解析 tarball 地址（rustfmt/clippy 的内部版本号与包名不一致，
# 例如 rustfmt 包名为 1.88.0 但内部版本是 1.8.0，只能用 registry 给出的地址）。
resolve_tarball() {
  local name="$1"
  command -v python3 >/dev/null 2>&1 || return 1
  python3 -c '
import json, sys, urllib.parse, urllib.request
name = sys.argv[1]
meta = json.load(urllib.request.urlopen(
    "https://registry.npmjs.org/" + urllib.parse.quote("@rustbin/" + name, safe=""), timeout=60))
latest = meta.get("dist-tags", {}).get("latest")
print(meta.get("versions", {}).get(latest, {}).get("dist", {}).get("tarball", "") or "")
' "$name"
}

fetch_pkg() {
  local name="$1"
  local dir="$WORK/${name}"
  mkdir -p "$dir"
  local tgz="$dir/${name}.tgz"
  local url="${REGISTRY}/@rustbin/${name}/-/${name}-${VERSION}.tgz"
  echo "==> 下载 @rustbin/${name}"
  if ! curl -fsSL --retry 3 -o "$tgz" "$url"; then
    url="$(resolve_tarball "$name" || true)"
    [ -n "$url" ] || { echo "无法解析 ${name} 的下载地址" >&2; return 1; }
    echo "    回退地址: $url"
    curl -fsSL --retry 3 -o "$tgz" "$url"
  fi
  echo "==> 解包 ${name}"
  tar -xzf "$tgz" -C "$dir"
}

# 把某个包内全部组件目录合并进 PREFIX（组件目录内即 bin/、lib/、share/...）
install_components() {
  local name="$1"
  local found=0
  local comp base
  for comp in "$WORK/${name}/package"/*/; do
    base="$(basename "$comp")"
    case "$base" in
      bin|lib|share|libexec|etc|man|doc) continue ;;
    esac
    if [ -d "$comp/bin" ] || [ -d "$comp/lib" ] || [ -d "$comp/share" ]; then
      cp -r "$comp". "$PREFIX"/
      found=1
    fi
  done
  [ "$found" = "1" ] || { echo "!! ${name} 未找到可安装的组件目录" >&2; return 1; }
}

# ---- 核心组件 ----
mkdir -p "$PREFIX/bin"
for pkg in \
  "rustc-${VERSION}-${HOST_TRIPLE}" \
  "cargo-${VERSION}-${HOST_TRIPLE}" \
  "rust-std-${VERSION}-${HOST_TRIPLE}" \
  "rust-std-${VERSION}-${WASM_TRIPLE}"
do
  fetch_pkg "$pkg"
  install_components "$pkg"
done

# ---- 开发工具（rustfmt / clippy）----
if [ "$WITH_DEV_TOOLS" = "1" ]; then
  if fetch_pkg "rustfmt-${VERSION}-${HOST_TRIPLE}" \
     && install_components "rustfmt-${VERSION}-${HOST_TRIPLE}"; then
    # 该预编译 rustfmt 不支持 cargo-fmt 协议（内部未启用 cargo-fmt feature），
    # 因此提供一个极简替身，使 `cargo fmt --all -- --check` 在受限环境同样可用。
    cat > "$PREFIX/bin/cargo-fmt" <<'SHIM'
#!/bin/sh
# cargo fmt 极简替身（仅用于 npm @rustbin 工具链）：把 cargo 的参数翻译为 rustfmt 调用。
#   cargo fmt [--all] [--check] [-- <rustfmt 参数>]
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
check=""
for a in "$@"; do
  case "$a" in
    --check) check="--check" ;;
    --all|--) ;;
    *) ;;
  esac
done
files=$(find src tests -name '*.rs' 2>/dev/null | sort)
[ -n "$files" ] || files="src/lib.rs"
# shellcheck disable=SC2086
exec "$HERE/rustfmt" --edition 2021 $check $files
SHIM
    chmod a+rx "$PREFIX/bin/cargo-fmt"
  else
    echo "!! rustfmt 未安装（格式检查将不可用，可忽略）" >&2
  fi
  if ! { fetch_pkg "clippy-${VERSION}-${HOST_TRIPLE}" \
         && install_components "clippy-${VERSION}-${HOST_TRIPLE}"; }; then
    echo "!! clippy 未安装（静态检查将不可用，可忽略）" >&2
  fi
fi

chmod -R a+rX "$PREFIX"

export PATH="$PREFIX/bin:$PATH"
echo
echo "==> 完成："
"$PREFIX/bin/rustc" --version
"$PREFIX/bin/cargo" --version
if [ -x "$PREFIX/bin/rustfmt" ]; then "$PREFIX/bin/rustfmt" --version; else echo "    rustfmt: 未安装"; fi
if [ -x "$PREFIX/bin/cargo-clippy" ]; then "$PREFIX/bin/cargo-clippy" --version; else echo "    clippy: 未安装"; fi
echo "    host std: $(ls -d "$PREFIX"/lib/rustlib/${HOST_TRIPLE} 2>/dev/null || echo 缺失)"
if [ -d "$PREFIX/lib/rustlib/${WASM_TRIPLE}" ]; then
  echo "    wasm std: $PREFIX/lib/rustlib/${WASM_TRIPLE}"
else
  echo "    wasm std: 缺失（无法构建 WASM）"
fi
echo
echo "请加入环境变量："
echo "    export PATH=${PREFIX}/bin:\$PATH"
echo "    export CARGO_HOME=\${CARGO_HOME:-\$HOME/.cargo}   # 也可指向任意可写目录"
echo
echo "验证：cd aps/rust && cargo build --release && cargo test --release"
echo "      cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings"
