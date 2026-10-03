# 使用说明（CLI 与 JSON API）

引擎：`rust-ecbs-cbs` v1.0.0 · 契约：`mapf-problem/1.0` → `mapf-solution/1.0`（见 `mapf/contracts/`）。
**它是什么**：离散栅格、同步单位时间步上的多机器人路径规划（MAPF）+ 独立方案核验 + Moving AI 基准工具。
**它不做什么**：不建模动作时长/动力学/加权边、不做任务分配、不提供常驻服务（一切均为进程内/浏览器内计算）。

## 子命令

```bash
mapf solve <problem.json> [--out sol.json]
    [--objective soc|makespan] [--budget-ms N] [--w 1.0..3.0] [--seed N]
    [--planner auto|ecbs|pp] [--no-verify] [--profile native|wasm-light]
mapf verify <problem.json> <solution.json> [--out report.json] [--strict]
mapf acceptance [--report docs/ACCEPTANCE.md] [--json docs/acceptance-results.json]
mapf capabilities [--profile native|wasm-light] [--out caps.json]
mapf convert --map <f.map> --scen <f.scen> --agents N [--horizon 0=auto] --out <problem.json>
mapf bench --manifest bench/manifest.json [--only FAMILY] [--budgets 1000,5000]
    [--objective soc|makespan] [--out results.json]
mapf fingerprint <solution.json>
mapf version
```

约定：所有子命令把 JSON 写到 stdout 或 `--out`；**进度与细节走 stderr**，管道消费永远拿纯 JSON。
退出码：0 成功（含 INVALID_INPUT 之类的合法“否定结论”输出）；1 存在未通过项（acceptance）或 I/O 错误。

## 问题文件（最小例）

```jsonc
{
  "schema_version": "mapf-problem/1.0",
  "id": "m02-crossing",
  "map": { "width": 5, "height": 5, "cells": [".....", "...#.", ".....", ".#...", "....."] },
  "robots": [
    { "id": "AGV-A", "start": [0, 2], "goal": [4, 2] },
    { "id": "AGV-B", "start": [2, 0], "goal": [2, 4] }
  ],
  "objective": { "kind": "soc" },
  "time_model": { "horizon": "auto" },
  "solver": { "time_limit_ms": 5000, "suboptimality_factor": 1.5, "seed": 42 }
}
```

- `cells` 行主序，`#`/`T`/`S` 为不可通行（其余字符视为可走）；
- 坐标 `[x, y]`，x=列、y=行；同步步进：每一步每车必须“4 邻接移动或原地等待”；
- 目标格语义为**占用**：到达后可停在 goal 上，他人不得踏入被永久占用的 goal（由此引出
  goal-parking 约束，模型细节见 MODEL-MATH.md §3）；
- 可选块：`dynamic`（快照/事件）、`benchmark`（Moving AI 溯源，convert 生成）、`tags`（演示元数据，引擎忽略）。

## 动态事件（`dynamic`）

```jsonc
"dynamic": {
  "snapshot": {
    "time": 2,                       // 已执行到 t=2（t=0 为出发点）
    "frozen_steps": 1,               // t=3 仍被锁定；之后允许改道
    "robots": [
      { "id": "AGV-A", "path": [[0,0],[1,0],[2,0],[2,0]], "goal": [2,0] }
      // path 前缀 = 已走+冻结步；goal 可与问题主 goal 不同（改派目标）
    ]
  },
  "events": [
    { "type": "block_cells", "at": 3, "until": 6, "cells": [[2,2]] },
    { "type": "remove_cell", "at": 4, "cells": [[3,3]] },
    { "type": "goal_change", "at": 2, "robot": "AGV-B", "goal": [4,4] }
  ]
}
```

语义要点（实现于 `src/dynamic.rs`）：锁定车的冻结前缀逐格不可偏离（verifier 会查
`E-FREEZE-BROKEN`）；“停在原 goal 且未被事件逼迫”的车视同驻留锁定；冲突检查只在
**两车冻结窗口的交集内**比对前缀。输出携带 `dynamic` 统计
（`affected_agents / path_change_steps / frozen_prefix_covered / replan`）。

## 方案输出（要点）

`status ∈ {OPTIMAL, FEASIBLE, INFEASIBLE, UNKNOWN, INVALID_INPUT, UNSUPPORTED, CANCELLED}`；
`objective = {kind, value, lower_bound, suboptimality_factor, direction}`；
`robots[] = {id, start, goal, path, arrival, steps, locked}`（path[0]=start，逐步一格）；
`metrics` 为运行期性能块（不参与语义指纹）；`search` 含 HL/LL 展开数等诊断；
`verified` + 内嵌 `verify` 报告（引擎自产方案被自己的独立核验器拒绝时状态降级为
`UNKNOWN` 并附 `notes`——宁缺毋滥原则）。

## JSON API（无 WASM 的宿主）

若你在 Rust 侧复用 crate：`mapf_engine::engine::solve_json(&str, &SolveOptions, &CancelToken)`
返回 `{status, solution_json}`；`mapf_engine::verify::verify_json(...)` 独立核验；
`mapf_engine::acceptance::run_all()` 供测试内嵌。禁止绕过 `problem::parse` 直接喂内部结构。

## 浏览器

见 `mapf/rust/web/mapf-worker.js` 头注释与 `lab/src/core/mapf/`；要点：
求解同步占用 Worker，**取消 = terminate + 自动重建**；指纹/核验必须用 `raw` 原文。
