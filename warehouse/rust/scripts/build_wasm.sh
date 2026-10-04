#!/usr/bin/env bash
# 可复现的 WASM 构建：同一份源码 → dist/warehouse_engine.wasm（wasm32-unknown-unknown）。
#
# 与 aps / mapf / agv 完全同一套约定：
#   * 零第三方依赖（只有仓库内 aps-engine 路径依赖）；
#   * 时间来自宿主导入的 env.aps_now_ms()，因此链接时允许未定义符号；
#   * 产物名固定 warehouse_engine.wasm，实验室的 sync 脚本按名字找它。
#
# 前置：
#   rustup target add wasm32-unknown-unknown        （官方 rustup）
#   或 bash ../../aps/rust/toolchain/setup_rust.sh  （受限网络：npm @rustbin 路线）
#
# 用法：
#   bash scripts/build_wasm.sh [输出目录=dist]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT_DIR="${1:-$ROOT/dist}"
TARGET=wasm32-unknown-unknown

cd "$ROOT"

if ! rustc --print target-list 2>/dev/null | grep -qx "$TARGET"; then
  echo "当前 rustc 不支持 $TARGET（请 rustup target add $TARGET，或运行 aps/rust/toolchain/setup_rust.sh）" >&2
  exit 1
fi

echo "==> 构建 ${TARGET}（release）"
RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=--allow-undefined" cargo build --release --target "$TARGET" --lib

TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
if command -v cargo >/dev/null 2>&1; then
  META_TARGET="$(cargo metadata --format-version 1 --no-deps 2>/dev/null \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["target_directory"])' 2>/dev/null || true)"
  [ -n "${META_TARGET:-}" ] && TARGET_DIR="$META_TARGET"
fi
SRC="$TARGET_DIR/$TARGET/release/warehouse_engine.wasm"
[ -f "$SRC" ] || { echo "未找到产物 $SRC" >&2; exit 1; }

mkdir -p "$OUT_DIR"
cp "$SRC" "$OUT_DIR/warehouse_engine.wasm"

if command -v wasm-opt >/dev/null 2>&1; then
  echo "==> wasm-opt -Oz"
  wasm-opt -Oz "$OUT_DIR/warehouse_engine.wasm" -o "$OUT_DIR/warehouse_engine.wasm"
fi

SIZE=$(wc -c < "$OUT_DIR/warehouse_engine.wasm")
SHA=$(sha256sum "$OUT_DIR/warehouse_engine.wasm" | cut -d' ' -f1)
echo "==> 产物: $OUT_DIR/warehouse_engine.wasm（${SIZE} 字节）"
echo "    sha256: $SHA"
echo "    导出: $(python3 - "$OUT_DIR/warehouse_engine.wasm" <<'PY'
import sys
data = open(sys.argv[1], 'rb').read()
i = 8


def uleb(i):
    v = s = 0
    while True:
        b = data[i]
        i += 1
        v |= (b & 0x7f) << s
        s += 7
        if not b & 0x80:
            return v, i


names = []
while i < len(data):
    sid = data[i]
    i += 1
    if sid == 0:
        continue
    size, i = uleb(i)
    end = i + size
    if sid == 7:
        cnt, j = uleb(i)
        for _ in range(cnt):
            ln, j = uleb(j)
            nm = data[j:j + ln].decode()
            j += ln
            kind = data[j]
            j += 1
            _, j = uleb(j)
            if kind == 0:
                names.append(nm)
    i = end
print(', '.join(names))
PY
)"

if command -v node >/dev/null 2>&1 && [ -f "$ROOT/web/warehouse-worker.js" ]; then
  echo "==> Node 冒烟测试"
  node "$ROOT/scripts/smoke_wasm.mjs" "$OUT_DIR/warehouse_engine.wasm" || {
    echo "冒烟测试失败（产物仍在，但请检查 ABI/内存/时钟导入）" >&2
    exit 1
  }
fi
