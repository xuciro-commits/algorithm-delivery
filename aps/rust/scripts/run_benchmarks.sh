#!/usr/bin/env bash
# 一键复现 24/240/2400 工序 × 3 个种子 的基准测试，并生成 Markdown 表格。
#
#   bash scripts/run_benchmarks.sh [runs=3] [time_limit_ms=2000] [out_dir=target/bench]
#
# 说明：
#  - 规模生成使用引擎自带的 benchgen（与 aps/tests/generate_benchmark.py 逐字节一致）；
#  - 24 工序即 mock/baseline.json 本身；
#  - 原始 JSON 落在 out_dir，便于对比不同机器的结果；
#  - 该基准是“规模/序列化压测”，不是耦合调度难度基准（见 docs/BENCHMARKS.md）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APS="$(cd "$ROOT/.." && pwd)"

RUNS="${1:-3}"
LIMIT_MS="${2:-2000}"
OUT_DIR="${3:-$ROOT/target/bench}"
BIN="${APS_BIN:-}"

cd "$ROOT"
if [ -z "$BIN" ]; then
  echo "==> 构建 release CLI"
  cargo build --release --quiet
  TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
  BIN="$TARGET_DIR/release/aps"
fi
[ -x "$BIN" ] || { echo "找不到可执行文件 $BIN" >&2; exit 1; }

mkdir -p "$OUT_DIR"
echo "==> 生成 240 / 2400 规模问题（与 Python 生成器逐字节一致）"
"$BIN" benchmark --baseline "$APS/mock/baseline.json" --operations 240  --out "$OUT_DIR/problem-240.json" >/dev/null
"$BIN" benchmark --baseline "$APS/mock/baseline.json" --operations 2400 --out "$OUT_DIR/problem-2400.json" >/dev/null

printf '\n| 规模(工序) | seed | 编译中位(ms) | 首解均值(ms) | 求解中位(ms) | 总计中位(ms) | 峰值内存(MB) | 状态 | 加权延期 | makespan | 下界 | 相对差距 |\n'
printf '|---|---|---|---|---|---|---|---|---|---|---|---|\n'

run_one() {
  local ops="$1" problem="$2" seed="$3"
  local out="$OUT_DIR/bench-${ops}-seed${seed}.json"
  "$BIN" bench --problem "$problem" --runs "$RUNS" --time-limit-ms "$LIMIT_MS" --seed "$seed" --json > "$out"
  python3 - "$out" "$ops" "$seed" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
det = d["detail"]
first = [x["metrics"]["first_feasible_ms"] for x in det if x["metrics"]["first_feasible_ms"] is not None]
obj = next((x["objective"] for x in det if x["objective"]), None) or {}
print("| {} | {} | {:.1f} | {:.1f} | {:.1f} | {:.1f} | {:.2f} | {} | {} | {} | {} | {} |".format(
    sys.argv[2], sys.argv[3],
    d["compile"]["median_ms"], (sum(first) / len(first)) if first else 0,
    d["solve"]["median_ms"], d["total"]["median_ms"],
    d["peak_memory_bytes_max"] / 1048576, "/".join(sorted(set(d["statuses"]))),
    obj.get("weighted_tardiness_minutes", "—"), obj.get("makespan_minutes", "—"),
    obj.get("best_bound", "—"),
    ("{:.2f}".format(obj["relative_gap"]) if isinstance(obj.get("relative_gap"), (int, float)) else "—"),
))
PY
}

for seed in 42 73 2026; do
  run_one 24  "$APS/mock/baseline.json"  "$seed"
  run_one 240 "$OUT_DIR/problem-240.json" "$seed"
  run_one 2400 "$OUT_DIR/problem-2400.json" "$seed"
done

echo
echo "原始结果: $OUT_DIR（bench-<规模>-seed<种子>.json）"
echo "注意：求解中位 ≈ 时间预算（启发式跑满预算或提前证明最优），这不是耗时缺陷。"
