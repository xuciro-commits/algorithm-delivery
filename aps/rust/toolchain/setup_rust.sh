#!/usr/bin/env bash
# 受限网络环境下的可复现 Rust 工具链安装脚本（本交付包的构建前提之一）。
#
# 背景：某些沙箱/内网只放行 npm registry、PyPI 与 GitHub API，无法访问
# crates.io / static.rust-lang.org / sh.rustup.rs。此时 rustup 不可用，
# 本脚本从 npm registry 上发布的预编译包 @rustbin/* 安装固定版本工具链：
#
#   @rustbin/rustc-<ver>-<host>          rustc 编译器
#   @rustbin/cargo-<ver>-<host>          cargo
#   @rustbin/rust-std-<ver>-<host>       标准库（host，用于 native 构建）
#   @rustbin/rust-std-<ver>-wasm32-unknown-unknown  标准库（wasm 目标）
#
# 默认安装到 /opt/rust（需要 sudo），随后：
#   export PATH=/opt/rust/bin:$PATH
#
# 幂等：重复运行会覆盖同名文件；卸载直接 `sudo rm -rf /opt/rust`。
#
# 用法:
#   sudo bash setup_rust.sh [安装目录=/opt/rust] [版本=1.88.0]
#   bash setup_rust.sh "$HOME/.rust-npm" 1.88.0     # 免 sudo 安装
set -euo pipefail

PREFIX="${1:-/opt/rust}"
VERSION="${2:-1.88.0}"
REGISTRY="https://registry.npmjs.org"
HOST_TRIPLE="x86_64-unknown-linux-gnu"
WASM_TRIPLE="wasm32-unknown-unknown"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fetch_pkg() {
  local name="$1"   # 例如 rustc-1.88.0-x86_64-unknown-linux-gnu
  local tgz="$WORK/${name}.tgz"
  echo "==> 下载 @rustbin/${name}"
  curl -fsSL --retry 3 -o "$tgz" \
    "${REGISTRY}/@rustbin/${name}/-/${name}-${VERSION}.tgz"
  echo "==> 解包 ${name}"
  tar -xzf "$tgz" -C "$WORK"
}

# rustc / cargo / host std / wasm std
fetch_pkg "rustc-${VERSION}-${HOST_TRIPLE}"
fetch_pkg "cargo-${VERSION}-${HOST_TRIPLE}"
fetch_pkg "rust-std-${VERSION}-${HOST_TRIPLE}"
fetch_pkg "rust-std-${VERSION}-${WASM_TRIPLE}"

echo "==> 安装到 ${PREFIX}"
mkdir -p "$PREFIX"
# 各包的目录结构均为 package/{bin,lib,share,...}
cp -r "$WORK"/package/. "$PREFIX"/
chmod -R a+rX "$PREFIX"

export PATH="$PREFIX/bin:$PATH"
echo
echo "==> 完成："
"$PREFIX/bin/rustc" --version
"$PREFIX/bin/cargo" --version
echo "    host std: $(ls -d "$PREFIX"/lib/rustlib/${HOST_TRIPLE} 2>/dev/null || echo 缺失)"
echo "    wasm std: $(ls -d "$PREFIX"/lib/rustlib/${WASM_TRIPLE} 2>/dev/null || echo 缺失)"
echo
echo "请加入环境变量："
echo "    export PATH=${PREFIX}/bin:\$PATH"
echo "    export CARGO_HOME=\${CARGO_HOME:-\$HOME/.cargo}   # 也可指向任意可写目录"
echo
echo "验证：cd aps/rust && cargo build --release && cargo test --release"
