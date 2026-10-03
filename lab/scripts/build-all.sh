#!/usr/bin/env bash
# 一键本地复现 CI 的完整实验室构建链路（不依赖开发人员手工复制任何产物）：
#
#   wasm 构建 → 同步引擎/清单/Mock/基准 → 类型检查 + 打包 → 核心冒烟 → dist 校验 → Pages 子路径仿真
#
# 用法：
#   bash lab/scripts/build-all.sh                 # 默认子路径 /algorithm-delivery/
#   LAB_BASE=/ bash lab/scripts/build-all.sh      # 本地根路径开发用
#   LAB_BENCH_SIZES=off bash lab/scripts/build-all.sh   # 跳过基准生成
#
# 依赖：Rust 工具链（aps/rust/toolchain/setup_rust.sh 可装）、Node 20+。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lab_dir="$(cd "$here/.." && pwd)"
repo_root="$(cd "$lab_dir/.." && pwd)"
export LAB_BASE="${LAB_BASE:-/algorithm-delivery/}"
export LAB_BENCH_SIZES="${LAB_BENCH_SIZES:-240,c48,c96}"

log() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }

log "1/6 构建 WASM 引擎（唯一来源：aps/rust）"
(cd "$repo_root/aps/rust" && bash scripts/build_wasm.sh)

log "2/6 构建 CLI（生成基准数据用）"
(cd "$repo_root/aps/rust" && cargo build --release --locked)
# 尊重 CARGO_TARGET_DIR（CI 未设置；本地/沙箱常用它隔离 target）
cli="$repo_root/aps/rust/target/release/aps"
if [ ! -x "$cli" ] && [ -n "${CARGO_TARGET_DIR:-}" ] && [ -x "$CARGO_TARGET_DIR/release/aps" ]; then
  cli="$CARGO_TARGET_DIR/release/aps"
fi
export LAB_APS_BIN="${LAB_APS_BIN:-$cli}"
[ -x "$LAB_APS_BIN" ] || { echo "✗ 找不到 aps CLI：$LAB_APS_BIN"; exit 1; }

log "3/6 安装实验室依赖"
(cd "$lab_dir" && npm install --no-audit --no-fund)

log "4/6 同步引擎清单 + 构建（typecheck + vite build）"
(cd "$lab_dir" && npm run build)

log "5/6 核心冒烟 + 运行器生命周期 + 渲染 + dist 校验"
(cd "$lab_dir" && npm run test:core && npm run test:runner && npm run test:render && npm run test:dist)

log "6/6 Pages 子路径仿真"
(cd "$lab_dir" && node scripts/check-pages.mjs)

log "完成：$lab_dir/dist（可直接用 python3 -m http.server 在 dist 目录内预览）"
