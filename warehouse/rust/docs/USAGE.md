# 使用手册（CLI / WASM / Worker）

引擎：`rust-warehouse`（对外名称 `warehouse`，CLI 可执行文件名沿用 `warehouse`）。同一份源码产出 native 可执行程序 `warehouse` 与 wasm 模块
`warehouse_engine.wasm`。所有命令的 **stdout 永远是纯 JSON**（便于管道），人类可读摘要写 stderr。

## 1. 命令行

```
warehouse <命令> [--flags]

命令
  solve       求解（按文档 kind 自动分派 slotting / asrs / joint）
  verify      独立核验（输入 = 问题 + 方案/时间线）
  generate    按场景 id + 规模档位生成问题文档
  scenarios   列出 86 个标准场景（含族、规模、mustShow 标签）
  acceptance  验收套件（单场景 / 按族 / 全量）
  bench       基准用例（如实报告规模、质量与资源占用）
  diagnose    给定实例的诊断信息（拓扑规模、可达性、能力矩阵）
  capabilities 档位能力声明（native / wasm-light）
  codes       错误码与状态码清单
  version     版本

flags
  --in <path>        输入文件（缺省读 stdin）
  --options <path>   参数覆盖 JSON
  --out <path>       输出文件（缺省写 stdout）
  --scenario <id>    generate / acceptance 的场景
  --scale <档位>     tiny | small | medium | large | extreme | stress
                     （未知档位显式报 INVALID_INPUT，不会回退成 small）
  --seed <n>         随机种子
  --family <族>      acceptance：slotting | dispatch | event | joint | stress
  --ids <列表>       acceptance：逗号分隔场景 id（沙箱里最常用的方式）
  --limit <n>        acceptance：最多跑几个场景
  --case <id>        bench：只跑指定用例
  --tier <档位>      bench：只跑指定档位
  --loose            verify：宽松模式（软约束降级为警告）
```

退出码：`0` 有效结果 / `1` 用法或 IO 错误 / `2` `INVALID_INPUT` 或 `UNSUPPORTED` /
`3` `INTERNAL_ERROR`、`CANCELLED`，或验收 / 基准存在失败项。

规模档位（`generate --scenario <id> --scale <key>`；`scenarios` 子命令里的 `scales[]` 是同一份表）：

| 档位 | SKU | 库位（推导值） | 任务 | 订单 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `tiny` | 8 | 24 | 12 | 60 | 端到端冒烟 |
| `small` | 60 | 168 | 120 | 800 | mock 与基准轻档 |
| `medium` | 400 | 4 800 | 900 | 6 000 | 中等规模对照 |
| `large` | 8 000 | 69 120 | 6 000 | 60 000 | 大实例（`D16` 等） |
| `extreme` | 60 000 | 792 000 | 20 000 | 120 000 | 极端规模（`D17`） |
| `stress` | 150 000 | 1 900 800 | 20 000 | 200 000 | 需求文档 §8 的 150k SKU / 500k–2M 库位区间（`X01`/`X02`；占用率 55%） |

`large` / `extreme` / `stress` 档在验收里会关掉信封内时间线与求解时核验（内存换稳定），
这不是"跳过检查"：独立核验另有对抗用例（`X12`），且 `--out` 的结果文件里 `verification` 字段会如实写 null。

## 2. 参数覆盖（`--options`）

```json
{
  "algorithm": "alns",
  "seed": 7,
  "budgetMs": 3000,
  "dualCommand": true,
  "conflictPolicy": "reservation",
  "allowYield": true,
  "maxIterations": 400,
  "maxTasks": 20000,
  "includeTimeline": true,
  "verify": true
}
```

* `includeTimeline:false` 用于大规模批量（20k 任务的时间线有 ~1.1 亿字符，写盘和内存都贵）；
  关掉后 `timeline` 为 `null`，但 `metrics`、`verification`、`result` 仍然完整。
* 库位侧的算法/预算也可通过 `problem.algorithm` 段给出（契约优先于 `--options` 的缺省）。
* **只送引擎真正实现的取值**：下表以外的取值不会被"静默忽略"，而是返回 `UNSUPPORTED`
  并在 `issues[]` 里指出字段路径（SRS §1.5：未实现的能力必须如实标"未支持"）。

### 2.1 支持矩阵（按域）

| 域 | 键 | 支持的取值 | 说明 |
| --- | --- | --- | --- |
| 库位 | `algorithm` | `capabilities.domains[slotting].algorithms[*].id` | 8 个基础对照策略 + 元启发式/多目标/鲁棒/动态算法 |
| 库位 | `seed` / `budgetMs` / `maxIterations` | 任意非负 | `budgetMs` 是软预算，超时按状态语义上报 |
| 库位 | `verify` | `true`（默认）/ `false` | 关掉后 `verification` 不内嵌，需单独 `verify` 才可交付 |
| 库位 | `temperature` / `tabuTenure` / `seeds` | 任意非负 | 分别覆盖 SA 初温、禁忌期约、多种子鲁棒情景 |
| 立库 | `algorithm` | `fifo` · `priority` · `priority-edd` · `nearest-device` · `dual-command` · `joint-alns` | 见 `capabilities.domains[asrs].algorithms` |
| 立库 | `dualCommand` | `true`（默认）/ `false` | 出库 + 入库配对，`false` 即单指令对照 |
| 立库 | `verify` / `includeTimeline` | `true`（默认）/ `false` | `includeTimeline:false` 时无时间线、无法回放与逐步核验 |
| 立库 | `maxTasks` | 1 – 1 000 000（默认 20 000） | 任务处理上限；超过时返回 `UNSUPPORTED` 而不是静默丢任务 |
| 立库 | `conflictPolicy` | `"reservation"`（默认） | 时空预约；**其它取值 → `UNSUPPORTED`**（未实现 yield 等策略） |
| 立库 | `allowYield` | `true`（默认） | 允许设备在互斥资源前等待/让行；`false` → `UNSUPPORTED` |
| 立库 | `horizonSeconds` | `0`（默认） | 引擎总是把所有在册任务推演到结束；非 0 → `UNSUPPORTED` |
| 联合 | `algorithm` / `seed` / `budgetMs` / `rounds` | 任意非负 | `rounds` 被夹在 1–12 |
| 联合 | `throughputWeight` / `travelWeight` | 任意非负 | 只在联合目标函数里起作用（不改变指标口径） |
| 联合 | `dualCommand` / `includeTimeline` / `verify` | `true`（默认）/ `false` | 透传给联合内部的调度段 |
| — | `strict`（`verify` 子命令） | `true`（默认）/ `false` | 验证器的严格模式；`false` 只报硬违规 |

问题文档侧的 `dispatch.conflictPolicy / allowYield / reschedulePolicy / crossLevelTransfer /
rollingHorizon_s / simulationHorizon_s` 同样按上表口径校验：只有默认（已实现）取值会被接受。

## 3. 结果信封

```json
{
  "engine": "rust-warehouse",
  "engineVersion": "1.0.0",
  "rulesetVersion": "…(基于 1.88.0)…",
  "fingerprint": "…sha256…",
  "status": "FEASIBLE",
  "runtimeMs": 12.3,
  "issues": [ { "code": "…", "path": "problem.tasks[3]", "message": "…" } ],
  "metrics": { "tasksTotal": 120, "tasksDone": 120, "…": "…" },
  "objective": 11655.2,
  "result": { "kind": "asrs", "algorithm": "priority-edd", "servicePlan": { "devices": [] } },
  "timeline": { "devices": [], "tasks": [], "bufferStates": [], "locationStates": [], "horizon_s": 0 },
  "verification": { "ok": true, "checked": {}, "violations": [] }
}
```

* `metrics` 的字段清单见 `WAREHOUSE-SRS.md` §4.4 / §3；
* `timeline` 只在 `includeTimeline` 打开时存在；**逐步骤明细在 `timeline.devices[].steps`**
  （含 `resource_id`、`resources`、`delayed_by_s`），`result.servicePlan` 只给每台设备的作业量汇总；
* 所有消耗性字段（`travelMeters / energyKwh / makespan_s`）都由时间线重算，验证器会再算一遍并与上报值比对。

## 4. 独立核验（`verify`）

`verify` 吃的是"问题 + 方案"，两种形态都接受：

```jsonc
// asrs
{ "kind": "asrs", "problem": { …问题… }, "timeline": { …引擎输出的 timeline… } }
// slotting
{ "kind": "slotting", "problem": { … }, "solution": { "assignment": [ … ], "algorithm": "alns" } }
// joint
{ "kind": "joint", "slotting": { … }, "asrs": { … }, "timeline": { … }, "solution": { … } }
```

验证器**不信任**上报指标：它按契约重新解析问题、按设备运动学重放时间线、
重新计算 makespan/行驶米数/能耗/冲突，并逐项比对；发现不一致即写 violation。
X12 场景（`acceptance --ids X12`）守的就是这条：人为篡改后的方案必须 `ok=false`。

## 5. WASM

```bash
bash scripts/build_wasm.sh           # → dist/warehouse_engine.wasm（+ Node 冒烟）
node scripts/smoke_wasm.mjs [wasm] [mock 目录]
```

导出（`src/wasm_api.rs`，`wh_` 前缀）：

| 导出 | 说明 |
| --- | --- |
| `wh_alloc/wh_free/wh_free_result/wh_result_ptr/wh_result_len` | 内存与结果缓冲 |
| `wh_solve` | 按 `kind` 分派求解 |
| `wh_solve_with_options` | 带参数覆盖求解 |
| `wh_solve_summary` | 求解 + 顶层 `summary` |
| `wh_verify` | 独立核验（输入是"问题 + 方案"文档） |
| `wh_generate` | 按 `{scenarioId, scale, seed}` 生成问题文档 |
| `wh_scenarios` / `wh_capabilities` / `wh_version` / `wh_peak_memory_bytes` / `wh_cancel` | 场景清单 / 能力 / 版本 / 峰值内存 / 取消 |

宿主必须提供 `env.aps_now_ms()`（`performance.now()`）；缺少它时 wasm 无法实例化，
这是刻意的：宁可报错也不要静默用假时间。

## 6. Worker（浏览器）

```js
import { installWorker, spawnSolver } from './warehouse-worker.js';

// 页面侧：spawnSolver 内部按需重建 Worker（取消 = terminate + 重建）
const solver = spawnSolver(new URL('./warehouse-worker.js', import.meta.url), {
  wasm: precompiledModule, // 主线程预编译，重建线程时省一次编译
});
const { status, envelope } = await solver.solve(problemText, { includeTimeline: true });
solver.cancel(); // 立即打断在途求解
```

* `solve()` 在 Worker 内**同步**执行；`{type:'cancel'}` 只对尚未开始的排队请求有效，
  真正即时取消必须 `terminate()`（`spawnSolver` 已封装）；
* `engine.scenarios()` / `engine.generate()` 让面板的选择器与 CLI 共用同一份清单，
  前端不硬编码场景列表。

## 7. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `status: UNSUPPORTED` + `SCALE_TOO_LARGE` | 任务数超档位上限；native 上限更高，或调 `maxTasks`（不能静默裁剪） |
| `verification.ok=false` 且状态 `INTERNAL_ERROR` | 结果不可交付：看 `verification.violations` 的 code 与位置 |
| 输出很大（几十 MB） | 关掉 `includeTimeline`，或用 `--out` 写文件而不是 stdout |
| wasm 实例化报错 `aps_now_ms` | 宿主没注入时钟；见 `web/warehouse-worker.js` 的 `imports` |
| `verify` 报"缺少待验证的设备时间线" | 传了求解信封而不是"问题 + timeline"；见本文 §4 |
