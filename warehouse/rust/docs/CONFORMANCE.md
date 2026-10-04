# 需求追溯（SRS § → 代码 → 场景 → 验收判据）

需求基准：[`../../WAREHOUSE-SRS.md`](../../WAREHOUSE-SRS.md)。
本表把每一条可验证的需求落到具体代码与验收场景上，便于审阅时"按行指认"。

## 1. 域模型与拓扑

| SRS | 实现 | 验收场景 | 判据 |
| --- | --- | --- | --- |
| §2.1 拓扑结构 | `src/wh/topology.rs`（`build_topology / derive_locations / NodeGraph / dijkstra`） | 全部 | `diagnose` 打印派生库位数；库位由 racks×levels×bays×depths 推导 |
| §2.2 图与成本 | `src/wh/routing.rs`（`RouteModel / travel_time / move_seconds / location_costs`） | S01/S05/J01 | 时间来自梯形曲线；欧氏距离只用于设备打分 |
| §2.2 库位连通性 | `topology.rs`：站台 ↔ 提升机底座主干 + 横巷 | D16/D17 | 跨分组任务可达（否则 `node_seconds` = inf，时间线出现非有限时间） |
| §2.1 冻结/封闭 | `contract.rs`（`frozenLocations`）、`asrs/solver.rs::World::location_blocked` | D21/D23/E09/E10 | 冻结库位 / 封闭巷道内无动作 |

## 2. 域 A 库位优化

| SRS | 实现 | 场景 | 判据 |
| --- | --- | --- | --- |
| §3.1 基础对照策略 | `src/slotting/strategies.rs`（16 个算法名，含 8 个基础策略） | S01–S08 | `comparison.baselines` 三行齐备 |
| §3.2A ALNS/LNS | `src/slotting/search.rs`（破坏-修复算子 + 接受准则） | S09–S14 | `search.iterations/restarts` 与收敛轨迹（真实迭代） |
| §3.2B 禁忌 / 退火 / 爬山 | 同上（`tabu` / `sa` / `hill`） | S05/S06 | 算法名与参数可切换；结果可复现 |
| §3.2C 多目标 | `src/slotting/multiobj.rs`（NSGA-II：非支配排序 + 拥挤度 + 精英） | S15–S18/J09 | `pareto` 非空；`objectives[]` 多目标值 |
| §3.2D 鲁棒 | `src/slotting/robust.rs`（情景集 + 最坏情形） | S19–S21 | `stabilitySeeds` 与鲁棒指标 |
| §3.3 动态调整 | `src/slotting/dynamic.rs`（事件驱动再优化 + 搬迁预算） | S22–S24/E02/E13 | `migrations[]` 带原因与代价；预算未超 |
| §3.4 目标与约束 | `src/slotting/mod.rs`（目标函数/权重/hard constraints） | 全部 S | 每个目标有方向与数值；硬约束违反 → error |
| §3.5 输出与解释 | `src/engine.rs::slotting_solution_json` | S23/S24 | `assignment/unassigned/objectives/comparison/explanation` |

## 3. 域 B 密集立库调度

| SRS | 实现 | 场景 | 判据 |
| --- | --- | --- | --- |
| §4.2.1 任务分配 | `asrs/solver.rs::select_device`（能力过滤 + 最早可用 + 空驶下界） | D01–D24 | `result.taskStates[].deviceIds` 只出现有能力设备 |
| §4.2.2 任务排序 | `order_tasks`（fifo/priority/edd/joint-alns） | D07–D12 | 策略可切换；EDD 的 `lateTasks` 更低 |
| §4.2.3 无冲突路径 | `asrs/network.rs::ReservationTable`（位置桶索引 + 容量） | D06/D15/D16 | 硬 `LANE_MUTUAL_EXCLUSION` = 0 |
| §4.2.4 等待与死锁 | `earliest / would_deadlock / add_wait` | D06/E01 | `blockedMoves / deadlocksPrevented / conflicts` 有值且留痕 |
| §4.2.5 交接与缓存 | 站台/缓存资源容量、`bufferPeak / stationPeak` | D02/D03/E11 | 无 `BUFFER_CAPACITY` 违规 |
| §4.2.6 双指令 | `dual_command` 配对统计 | D12/J03/J12 | `dualCommandPairs > 0` |
| §4.2.7 多深位倒垛 | `World::blockers_with / relocation_target` + 派生任务 | D04/D05/J04 | `relocationTasks > 0` 且 `derivedTasksDone` 与之一致 |
| §4.2.8 动态事件 | `World::apply_events` + `run_task` 的时间窗/降级处理 | D18–D24/E01–E14 | 故障窗口无动作；取消任务不出现在时间线 |
| §4.3 时间一致 | `asrs/verify.rs`（重算运动学 + `*0.85` 硬下限） | D01/D16/X12 | 硬 `TIME_CONSISTENCY` = 0（D01 的历史误报已定位为求解器问题，未放宽容差） |
| §4.3 台账守恒 | `verify.rs::INVENTORY_CONSERVATION` | E13/J04 | load/unload 逐条对账 |
| §4.4 指标 | `asrs/solver.rs` 指标段 + `engine.rs::metrics_json` | 全部 D/E/J | 指标全部由时间线重算，验证器复核 |
| §1.3 可解释（调度侧） | `asrs/mod.rs::solution_json` 的 `explanation{dispatch,reasons,note}` | 全部 D / 联合 J | 文案里的数字全部来自本次真实推演（完工 / 吞吐 / 冲突 / 倒垛 / 双指令 / 预约数），面板不做二次措辞 |

## 4. 域 C 联合优化

| SRS | 实现 | 场景 | 判据 |
| --- | --- | --- | --- |
| §5 闭环 | `src/joint.rs`（库位 → 真实调度 → 反馈 → 迭代） | J01–J12 | `rounds[]` 每轮都有实测指标 |
| §5 联合目标 | `joint_objective()`（可复算加权） | J04/J06 | `explanation.reasons` 给出公式与数值 |
| §5 对比矩阵 | `build_comparison()`（随机 / ABC / 联合，同一调度口径） | J01–J08 | `comparison` 三行数字来自真实调度 |
| §5 Pareto | `build_pareto()`（权重网格 + 真实评估 + 非支配筛选） | J09 | `pareto` 非空且 `paretoNote` 说明采样方式 |
| §5 可解释 | `explanation.{slotting,dispatch,reasons}` | J01/J09 | 三条必答问题都有非空字符串 |
| §5 两段各自复核 | `verify.rs::compose_joint_verification`（调度段用求解时的报告 + 库位段选定最优轮后补一次独立核验） | J01–J12 | 信封 `verification.kind == "joint"`、两段都 `ok` 才为真；`tests/engine_pipeline.rs::joint_verification_covers_both_halves` 守这条 |
| §3.5/§10 关联簇 | `search.rs` 输出 `SlottingOutcome::cluster_of_sku` → `engine.rs::slotting_clusters_json` → 信封 `result.clusters{count,bySku,note}`（联合解同样带） | S01–S24/J04 | 三维叠加与解释读同一份引擎聚类（前端不重聚类，避免"面板说 N 簇、画布画另一套"） |

## 5. 契约 / 可复现 / 状态 / 规模

| SRS | 实现 | 校验 | 判据 |
| --- | --- | --- | --- |
| §6 状态语义 | `src/errors.rs`（10 个状态 + `code()`） | `acceptance` status-semantics | 报告状态必须在允许集合；`INTERNAL_ERROR` 仅用于验证失败 |
| §7 契约 | `contracts/*.schema.json` + `make_schemas.py` | `scripts/check_contracts.py` | schema 防漂移 + mock 校验 + 输出校验 |
| §7 指纹 | `engine.rs::fingerprint`（SHA-256，含输入） | `acceptance` reproducibility | 同种子 `objective` Δ < 1e-9 |
| §7 退出码 | `main.rs::exit_for` | `check_contracts.py` | 0/1/2/3 语义 |
| §8 规模诚实 | `capabilities.rs`（native vs wasm-light 上限） | `acceptance` scale-honesty | 超档 → `UNSUPPORTED` + `SCALE_TOO_LARGE`，不静默裁剪；`X01`/`X02` 另带规模下限（SKU ≥150k / 库位 ≥1.5M），"把规模调小再报小数字"过不了 |
| §8 合成数据 | `scenario.rs`（86 场景 × 6 档位：tiny/small/medium/large/extreme/**stress**） | `scenarios`/`generate` | `stats` 报告实际规模；未知档位显式 `VALUE_RANGE`（不回退 small）；`stress` = 150k SKU / 1 900 800 库位（需求 §8 区间） |
| §10 实验室集成 | `lab/src/modules/{slotting,dense-asrs,warehouse-shared}`（只投影引擎输出，不算指标） | `npm run test:warehouse:scenes`（纯 Node，20 项断言） | 落位来源（`assignment`/`slottingAssignment`）、关联簇叠加（只画 ≥0 的簇）、倒垛图层（成对状态迁移才算一次）都由引擎字段驱动 |
| §1.5 未实现能力不假装 | `asrs/mod.rs::unsupported_policy_requests` | `tests/engine_pipeline.rs::unsupported_policy_values_are_rejected_not_ignored` | 契约里未实现的策略取值（`conflictPolicy` / `allowYield` / `reschedulePolicy` / `crossLevelTransfer` / 两个时域位 / `horizonSeconds`）→ `UNSUPPORTED` + `issues[]` 指出字段路径，不静默按默认策略求解 |
| §1.5 文档承诺可调即实现 | `asrs/solver.rs::AsrsOptions::from_json`（`maxTasks`） | `docs/USAGE.md` §2.1 支持矩阵 | 文档里出现的每个选项键都能在代码里找到读取点（支持矩阵逐行对应） |

## 6. 验收套件（86 场景）

```
./target/release/warehouse acceptance --ids D17 --out /tmp/a.json     # 单场景（沙箱推荐）
./target/release/warehouse acceptance --family joint --out /tmp/j.json # 按族
./target/release/warehouse acceptance --out /tmp/all.json              # 全量（≥8 GB 内存）
```

判据：`status-semantics` · `solution-presence` · `independent-verification` ·
`scale-honesty` · `reproducibility` · `shows:<tag>`（现象级断言，
例如 `relocation` 必须有倒垛、`pareto` 必须有非支配点、`violation` 必须报出违规）。

> 反过来说：`shows:` 检查失败**不允许**通过降低断言来"修好"——2026-10 的一次修订中，
> D04 因为落点选择只看同列而恒无倒垛，正确做法是修 `relocation_target`（同层最近空位兜底），
> 而不是删掉 `relocation` 断言。
