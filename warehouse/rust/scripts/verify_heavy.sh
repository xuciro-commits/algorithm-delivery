#!/usr/bin/env bash
# 重型本地验证（**CI 不跑这些**，见根 README「本地重型验证（CI 不跑，请在本机跑）」）。
#
#   bash scripts/verify_heavy.sh                    # 86 个标准场景按族验收 + 契约符合性
#   bash scripts/verify_heavy.sh --with-bench       # 再加全量基准（10 个 case，native 档）
#   FAMILIES="stress" bash scripts/verify_heavy.sh  # 只跑某一族（如 X01/X02 压力档）
#   BENCH_TIER=wasm-light bash scripts/verify_heavy.sh --with-bench   # 基准换档
#   WAREHOUSE_BIN=/path/to/warehouse bash scripts/verify_heavy.sh     # 用别的二进制
#
# 为什么不在 CI 里跑：这些都是**负荷/规模**验证，不是通过性验证。
#   * `stress` 族 = 需求 §8 的 150k SKU / 1.9M 库位档，每例求解预算 30 s，建议 ≥8 GB 内存；
#   * `dispatch` 族峰值内存约 3.2 GB（其中 D17 是 20k 任务 / 616 设备，单例 ≈58 s）；
#   * 全量 86 场景一次连跑会把所有时间线堆在同一个进程里，所以这里**按族**跑、逐族断言，
#     和 CI 以前那版命令完全相同，只是搬到了本机。
#
# 参考耗时（2 vCPU 沙箱实测，M 系列芯片会快得多）：slotting 族 ≈8 s、event 族 ≈1 s、joint 族 ≈68 s；
# dispatch 族与 stress 族（X01/X02 = 150k SKU / 1.9M 库位）求解需要 ≥8 GB 内存，沙箱（3.9 GB）跑不完，
# 本机 36 GB 足够；生成侧已优化：X01 出题 13 s（344.9 MB 文档），全量基准（10 个 case）数分钟。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
cd "$root"

with_bench="no"
for arg in "$@"; do
  case "$arg" in
    --with-bench) with_bench="yes" ;;
    -h | --help)
      echo "用法：bash scripts/verify_heavy.sh [--with-bench]"
      echo "  FAMILIES=\"slotting dispatch event joint stress\"  只跑部分族"
      echo "  BENCH_TIER=native|wasm-light                      基准档位（默认 native）"
      exit 0
      ;;
    *)
      echo "未知参数：$arg（支持 --with-bench / --help）" >&2
      exit 2
      ;;
  esac
done

bin="${WAREHOUSE_BIN:-$root/target/release/warehouse}"
if [ ! -x "$bin" ]; then
  echo "== 没找到 $bin，先做 release 构建"
  cargo build --release --locked
fi

families="${FAMILIES:-slotting dispatch event joint stress}"
all_families="slotting dispatch event joint stress"
mkdir -p target

for family in $families; do
  out="target/acceptance-$family.json"
  echo "== 验收族 $family"
  "$bin" acceptance --family "$family" --out "$out"
  python3 - "$out" "$family" <<'PY'
import json
import sys

path, family = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as handle:
    data = json.load(handle)
total = int(data.get("total", 0))
passed = int(data.get("passed", 0))
failed = int(data.get("failed", -1))
print(f"   {family}: {passed}/{total} 通过，失败 {failed}")
sys.exit(1 if failed != 0 else 0)
PY
done

# 五个族都跑了才断言"总数正好 86"，只跑子集时不做这个断言（避免误报）。
if [ "$families" = "$all_families" ]; then
  python3 - <<'PY'
import glob
import json

rows = []
for path in sorted(glob.glob("target/acceptance-*.json")):
    with open(path, encoding="utf-8") as handle:
        rows.append(json.load(handle))
total = sum(int(row.get("total", 0)) for row in rows)
passed = sum(int(row.get("passed", 0)) for row in rows)
failed = sum(int(row.get("failed", 0)) for row in rows)
assert total == 86, ("标准场景总数应为 86", total)
assert failed == 0, ("存在失败的场景", failed)
print(f"== 验收合计：{passed}/{total} 通过，失败 0（S01–S24 / D01–D24 / E01–E14 / J01–J12 / X01–X12）")
PY
else
  echo "（只跑了 $families，跳过 86 个场景的合计断言）"
fi

echo "== 契约符合性（schema 防漂移 / mock / 引擎输出 / verify 报告 / 对抗样例）"
python3 scripts/check_contracts.py

if [ "$with_bench" = "yes" ]; then
  tier="${BENCH_TIER:-native}"
  echo "== 全量基准（10 个 case，tier=$tier，核验必须通过）"
  "$bin" bench --tier "$tier" --out target/bench-full.json
  python3 - <<'PY'
import json

with open("target/bench-full.json", encoding="utf-8") as handle:
    rows = json.load(handle)["rows"]
bad = [row["name"] for row in rows if not row["pass"]]
assert not bad, ("基准未通过", bad)
for row in rows:
    objective = row.get("objective")
    objective_text = "-" if objective is None else str(objective)
    print(
        "   %-16s %-9s %-8s %9.1f ms  objective=%-10s verificationOk=%s"
        % (row["name"], row["domain"], row["scale"], row["runtimeMs"], objective_text, row["verificationOk"])
    )
print(f"== 基准 {len(rows)} 行全部 pass（状态与独立核验都通过），结果见 target/bench-full.json")
PY
fi

echo "== 完成（重活都在本机跑完了；CI 只负责通过性门）"
