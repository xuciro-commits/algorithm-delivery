#!/usr/bin/env python3
"""生成 mapf/bench/manifest.json（可再生基准清单）。

语义（对齐 Moving AI 官方规则，见 bench/UPSTREAM.md）：
* `{map}-even-N.scen` 的第 i 行 = 第 i 台车（bucket 平衡随机序）；
* “n 车实例” = 同一 scen 文件的前 n 行 ⇒ 一个文件覆盖多个规模；
* 每个规模上限 = 文件行数（小地图自然截断，如 empty-8-8 只有 32 行）。

用法：python3 mapf/bench/gen_manifest.py  （在仓库任意位置运行均可）
"""
import hashlib
import json

import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAPS = ["empty-8-8", "empty-16-16", "room-32-32-4", "maze-32-32-4", "warehouse-10-20-10-2-1"]
SCEN_SELECTOR = re.compile(r"^(\d+)\t(\S+\.map)\t(\d+)\t(\d+)\t")


def sha256(p: Path) -> str:
    return "sha256:" + hashlib.sha256(p.read_bytes()).hexdigest()


def scen_lines(p: Path) -> int:
    n = 0
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("version"):
            continue
        if SCEN_SELECTOR.match(line):
            n += 1
    return n


def main() -> None:
    entries = []
    for m in MAPS:
        map_file = HERE / "maps" / f"{m}.map"
        scen_file = HERE / "scen" / f"{m}-even-1.scen"
        if not map_file.exists() or not scen_file.exists():
            raise SystemExit(f"缺少数据文件：{map_file} / {scen_file}（先运行下载脚本）")
        lines = scen_lines(scen_file)
        counts = []
        k = 2
        while k <= 128 and k <= lines:
            counts.append(k)
            k *= 2
        entries.append(
            {
                "name": f"{m}-even-1",
                "family": m,
                "map_file": f"maps/{m}.map",
                "map_sha256": sha256(map_file),
                "scen_file": f"scen/{m}-even-1.scen",
                "scen_sha256": sha256(scen_file),
                "agent_counts": counts,
                "note": f"Moving AI even-scenario #1（bucket 平衡）；文件覆盖 {lines} 台车，取前 n 行构造 n 车实例",
            }
        )
    manifest = {
        "schema_version": "mapf-bench-manifest/1.0",
        "entries": entries,
        "budgets_ms": [1000, 5000],
        "objectives": ["soc", "makespan"],
        # 基准用有界次优 ECBS（w=1.5）：贴近 20+ 车工程实践；OPTIMAL 只在可证明时出现。
        "suboptimality_factor": 1.5,
        "seed": 42,
        "horizon": "auto",
        "upstream": {
            "repository": "https://github.com/mcapoor/MovingAI-MAPF-Benchmarks",
            "origin": "https://movingai.com/benchmarks/mapf/index.html",
            "license": "Open Data Commons Attribution License (ODC-BY)",
            "citation": 'Stern et al., "Multi-Agent Pathfinding: Definitions, Variants, and Benchmarks", SoCS 2019, pp. 151-158.',
        },
    }
    out = HERE / "manifest.json"
    out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    n_inst = sum(len(e["agent_counts"]) for e in entries)
    print(f"已写入 {out}（{len(entries)} 个实例族，{n_inst} 个规模组合 × 2 预算 × 2 目标）")


if __name__ == "__main__":
    main()
