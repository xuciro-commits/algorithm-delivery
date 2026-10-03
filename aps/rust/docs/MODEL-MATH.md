# 约束编译器设计与数学约束逐条对照（MODEL-MATH）

> 对应 SRS §3「数学问题定义（必须写成代码及测试）」与 §9「约束编译器设计和数学约束逐条单测；模型追溯关系设计」。
> 本文给出：编译流水线、业务 ID ↔ 内部索引的追溯设计、H01–H08 的数学形式 ↔ 代码 ↔ 单测三级对照。

---

## 1. 编译流水线（`compile(problem, capabilities) -> internal_model`）

```
PlanProblem(JSON, ISO 8601 带偏移)
   │
   ├─① 契约解析   model::parse_problem      ── 字段级 issue（收集式，不早退）
   │      产出：RawProblem（业务 ID 原样保留、时间已解析为绝对分钟）
   │
   ├─② 语义校验   validate::validate        ── 跨引用完整性、DAG、分辨率对齐、P1 越界
   │
   ├─③ 时间归一   compile::compile
   │      · t_rel = t_abs − meta.horizon_start_min      （内部一律非负相对整数分钟）
   │      · 跨夏令时安全：只做“绝对分钟”相减，不用当地墙上时钟
   │
   ├─④ 日历编译   calendar::build_windows
   │      · available 区间合并去重 → 扣除 blocked → 裁剪到 [0, H]
   │      · 输出“可落位窗口”序列（每台机器/每个人一份）
   │
   ├─⑤ 关系编译   · 工序拓扑序（跨订单 predecessors 一并入图）
   │             · 备选机器 × 能力过滤 → machine_candidates(o)
   │             · 合格人员过滤 → worker_eligible(o, w)（技能 + 全部资格）
   │
   ├─⑥ 追溯索引   ProblemIndex（业务 ID → 内部下标，双向）
   │
   └─⑦ 无解证明   Certificate（仅在可构造证明时产生；见 §3）
        产出：Compiled + Certificates + Warnings
```

**关键不变量**（均有可运行证据；测试名与 `cargo test` 输出一致）：

| 不变量 | 代码 | 测试 |
|--------|------|------|
| 时间解析/归一不依赖当地墙上时钟（跨夏令时安全） | `datetime.rs` | `datetime::tests::no_local_clock_subtraction`、`parses_with_offsets`、`civil_roundtrip_wide_range` |
| 契约字段（含时间与时域）逐字段校验 | `model.rs` | `model::tests::parses_baseline_fixture`、`reports_multiple_field_errors`、`rejects_bad_time_and_range` |
| 窗口序列严格升序、互不重叠，且不含任何 `blocked` 交集 | `calendar.rs` | `calendar::tests::windows_subtract_blocked_and_shrink`、`merge_and_subtract_edges` |
| 最早可落位尊重忙碌区间与 EST | `calendar.rs` | `calendar::tests::earliest_slot_respects_busy_and_est`、`earliest_slot_scans_multiple_windows` |
| 追溯映射可用于反查（业务 ID → 下标），且重复 ID 以首个为准 | `validate::ProblemIndex` / `validate::build_index` | `validate::tests::baseline_is_valid`、`detects_cycle_and_unknown_refs` |
| 内部下标 → 业务 ID 的回写正确（输出方案工序齐全且 ID 合法） | `compile::trace_op` → `engine::schedule_to_operations` | 集成测试 `baseline_solve_is_verified_feasible_and_material_bound`（断言 24 道工序与资源映射） |
| 编译产物不改变业务语义（数量、工期、物料数量原样） | `compile.rs` | 集成测试 `all_mock_fixtures_validate_against_contract`（四个夹具全部通过契约校验） |
| 放置/回滚幂等（`place` + `unplace` 复原） | `schedule.rs` | `schedule::tests::place_and_unplace_roundtrip` |
| 锚点包含日历事件与物料到货时刻 | `schedule.rs` | `schedule::tests::anchors_include_calendar_and_material_events` |

---

## 2. 追溯关系设计（业务 ID ↔ 数学变量）

SRS §1 要求「所有建模有业务 ID ↔ 数学变量的追溯映射」。本引擎的映射是**派生式**的，
不额外维护可变表，从而天然避免“映射与模型不同步”：

| 业务实体 | 数学对象 | 追溯入口（`validate::ProblemIndex`，构建于 `validate::build_index`） |
|----------|----------|----------|
| `orders[j].id` | 订单 `j`（`COrder`） | `index.orders["ORD-001"] -> j` |
| `operations[k].id` | 工序变量组 `o`（`COp`：`start[o]`/`end[o]`/`x[o,m]`/`y[o,w]`） | `index.operations["ORD-001-CUT"] -> (order_j, op_o)` |
| `machines[m].id` | 备选机器集合中的 `m` | `index.machines["CUT-01"] -> m` |
| `workers[w].id` | 人员分配 `y[o,w]` 的候选 `w` | `index.workers["EMP-W01"] -> w` |
| `tools[t].id` | 独占资源 `t`（占用区间） | `index.tools["DIE-SHARED-01"] -> t` |
| `materials[q].id` | 库存余额函数 `inv[q](t)` 的科目 `q` | `index.materials["M-PAINT"] -> q` |

反向（内部 → 业务）：`Compiled::trace_op(op) -> (order_id, operation_id)`，由 `schedule_to_operations()`
写入 `PlanSolution.operations`。

产出侧：`schedule_to_operations()` 把内部下标重新映射回业务 ID 写入 `PlanSolution.operations`；
`explain.rs` 则用同一映射反向定位（`--operation ORD-001-CUT` → 内部下标 → 打印备选、窗口、账本）。

**为什么不用“变量编号”**：`PlanSolution` 是跨引擎契约（CP-SAT 后端/浏览器 WASM/独立校验器共用），
对外只暴露业务 ID；把“变量编号”留在引擎内部，保证换求解器时契约不变（SRS §0.1）。

---

## 3. H01–H08：数学 ↔ 代码 ↔ 测试

记号：工序 `o`；备选机器 `m ∈ alt(o)`，时长 `d[o,m]`；人员 `w`；工具 `t`；物料 `q`。
`x[o,m] ∈ {0,1}`（备选选择）、`y[o,w] ∈ {0,1}`（人员分配），`Σ_m x[o,m] = 1`、`Σ_w y[o,w] = 1`。

| # | 数学形式 | 求解侧实现 | 求解器自检 | 独立校验器（不复用求解器路径） | 逐条单测 / 变异 |
|---|----------|-----------|-----------|------------------------------|----------------|
| **H01** | `end[o] = start[o] + Σ_m x[o,m]·d[o,m]` | `Schedule::place` 写入 `Assign{dur}`；`earliest_placement` 只用该机器时长 | `schedule::overlap_violation` 前的一致性检查 | `schedule::tests::place_and_unplace_roundtrip`；验收 S06「时长为 0」「时长与备选机器不符」 |
| **H02** | `start[o] ≥ end[pred]`；`start[first] ≥ release_at(order)` | `Schedule::op_ready` 取 `max(release, max end[preds])` | `ledger/overlap` 之外的 `op_ready` 契约 | `solver::tests::dispatches_baseline_completely`；验收 S06「工序逆序」「早于投放时间」 |
| **H03** | `x[o,m] ⇒ m ∈ alt(o) ∧ capability(m) ⊇ skill(o)`；同机区间不相交 | `machine_candidates()` 能力过滤；`placement_ok` 检查机器空闲 | `overlap_violation` | `solver::tests::search_returns_feasible_within_budget`（含机器重叠自检）；验收 S06「无该能力的机器」「机器重叠」 |
| **H04** | `[start[o], end[o]] ⊆ ⋃windows(m)`（单条连续窗口）且 `∩ blocked = ∅` | `calendar::earliest_slot` + `placement_ok`（整段落窗） | `overlap_violation` 中的窗口判定 | `calendar::tests::windows_subtract_blocked_and_shrink`、`schedule::tests::placement_respects_calendar_gaps`、`solver/dispatch::tests::respects_machine_breakdown_window`；验收 S02 + S06「跨班次空档」「与停机区间重叠」 |
| **H05** | `Σ_w y[o,w] = 1`；`y[o,w] ⇒ skill(o) ⊆ skills(w) ∧ quals(o) ⊆ quals(w)`；同人区间不相交 | `worker_eligible()`；`placement_ok` 检查人员空闲；无合格人员 → 编译期证书 | 自检：人员重叠 | `solver/dispatch::tests::infeasible_fixture_yields_no_schedule`；验收 S04 + S06「无技能人员」「人员重叠」 |
| **H06** | 工具 `t ∈ tools(o)` 在 `[start,end]` 独占；`|tools(o)|` 个资源同时占用 | `placement_ok` 检查每个工具空闲；`place/qounplace` 维护 `tool_busy` | `overlap_violation`（工具维度） | `solver/dispatch::tests::every_rule_produces_feasible_schedule_on_baseline`（含工装重叠自检）；验收 S06「工装缺失」「工装重叠」 |
| **H07** | `inv[q](t) = init[q] + Σ_{r:at_r ≤ t} recv[r] − Σ_{o: start_o ≤ t} use[o,q] ≥ 0`，同一时刻先入库后领料 | `schedule.rs` 维护按时间排序的消耗序列；`ledger_violation` 快检 | `ledger_violation`（自检） | `ledger::tests::witness_has_no_overdraft_on_baseline`、`same_timestamp_receipt_is_consumed_after_arrival`、`material_delay_scenario_is_event_ordered`、`schedule::tests::material_suffix_check_matches_full_ledger`；验收 S03 + S06「缺料提前开工」 |
| **H08** | 全部订单工序都排入 `[0, H]`：`∀o: 0 ≤ start[o] ∧ end[o] ≤ H`；且方案含全部工序 | 拓扑遍历保证不丢工序；`is_complete()` | `is_complete()` | `objective::tests::incomplete_schedule_has_no_objective`；验收 S06「超出规划时域」「工序缺失」 |

补充契约级断言（不属于 H01–H08，但验收要求）：`DUPLICATE_OPERATION`、`UNKNOWN_OPERATION`、
`SNAPSHOT_MISMATCH`、`TENANT_MISMATCH`、`UNKNOWN_TOOL`、`UNKNOWN_MATERIAL`、`ORDER_ID`。

### 3.1 目标函数

```
completion(j)  = max{ end[o] : o ∈ 订单 j }                （verify/compare 同口径）
tardiness(j)   = max(0, completion(j) − due_at(j))
phase1         = Σ_j priority(j) · tardiness(j)
phase2         = makespan = max{ end[o] } − horizon_start   （不恶化 phase1 的前提下）
```

字典序比较键 `key = (phase1, phase2)`；`makespan` 策略为 `(phase2, phase1)`（SRS 要求的对照策略）。
实现：`objective::evaluate`；比较：`ObjectiveValue::key`。

### 3.2 有效下界（三类）与最优性判据

`best_bound = max(路径下界, 产能+物料下界, 日历流量下界)`；三者**各自**都必须是有效下界
（即：不得高于任何可行排程的 makespan），否则会推出伪 `OPTIMAL`。实现与论证见
`objective::{path_lower_bound, capacity_lower_bound, flow_lower_bound}`。

**(1) 路径下界**（含投放时间、单机窗口、`blocked` 空档）

```
alone_start(o) = min over m ∈ alt(o)：在 windows(m)∖blocked 上单独占机的最早可开工时刻
b(o)           = max( release(order), max_{p ∈ preds(o)} b(p), alone_start(o) ) + min_duration(o)
LB_path        = max_o b(o)
```

放松掉机器/人员/工装/物料竞争与时长选择耦合，只可能低估 → 有效。

**(2) 产能下界（含物料到货门槛）**：按“技能 + 资格 + 备选机器集合”分组（同组共用机器池 `M` 台）：

```
W = Σ_{o ∈ g} min_duration(o)                     （组内总工时）
LB_cap(g) ≥ ceil(W / M)                           （纯产能）
对每个到货时刻 T：
    Avail(T) = 初始库存 + Σ{到货时刻 < T 的数量}
    Knap(A)  = 组内需料工序在 Σ数量 ≤ A 下可取的最大工时（0/1 背包）
    LB_cap(g) ≥ T + ceil((W − Knap(Avail(T))) / M)   （仅当 W − Knap > 0）
LB_cap = max over g
```

领料语义是“**开工即领、不退回**”（`ledger::replay_material` 按 `start` 记账），故累计领料单调不减
且不超过累计到货；于是“`T` 之前开工”的工序数量之和 ≤ `Avail(T)`，其工时 ≤ `Knap(Avail(T))`；
剩余工序只能在 ≥ `T` 开工，其工时必须占用机器池在 `T` 之后的时间 → 得到上式。
**注意**：把“投放 ≤ T 的工时之和”计入 `[T, …]` 会**高估**下界（那些工序可能已在 `T` 前加工完），
这是本函数早期版本的错误，现由对抗测试封堵。

**(3) 日历流量下界**：对每个候选投放时刻 `R`（各订单 `release` 去重，≥0）：

```
W(R)   = Σ_{投放时刻 ≥ R 的工序} min_duration
cap(t) = Σ_{机器 ∈ 池} (该机器在 [R, t] 内可用分钟数)   （blocked 已在编译期扣除）
LB_flow(R) = min{ t ≥ R : cap(t) ≥ W(R) }
LB_flow   = max over g, R
```

投放不早于 `R` 的工序不可能在 `R` 之前开工，其全部工时必须落在 `[R, makespan]` 内，
且只能占用各机器自己的可用窗口（每台机器同一时刻至多一道工序）；忽略人员/工装/物料/前置
只会高估可用产能 → 结果不晚于真实最优 → 有效。该式把“每天只有两班 8 小时”这类
日历损耗计入下界，因此在按日历加权的实例上显著强于（1)(2)。

**有效性证据**（比公式更能说明问题）：

| 测试 | 做法 | 覆盖 |
|------|------|------|
| `material_bound_never_exceeds_brute_force_optimum` | 单机 + 单人员 + 物料到货门槛 + 多订单不同投放时刻；DFS 枚举全部订单间交错（单机下即精确最优），断言 `LB ≤ 真实最优 ≤ 引擎解` | 80 个随机实例 |
| `capacity_bound_is_valid_and_tighter_on_contention` | 竞争型实例上对比纯产能与含物料门槛的下界，并断言下界 ≤ 引擎可行解 | 喷涂瓶颈实例 |
| `coupled_is_schedulable_and_bounds_are_valid_at_scale` | 8/16/24/48 订单竞争型实例，三类下界分别 ≤ 可行解，且总下界 = 三者取大 | 4 组规模 |

于是最优性判据为：

| 条件 | 结论 | 状态 |
|------|------|------|
| `phase1 = 0`（其理论下界）且 `makespan ≤ best_bound` | 两个分量同时取下界 ⇒ 可证明最优 | `OPTIMAL` + `optimality_proven=true` |
| 仅 `makespan ≤ best_bound`（`makespan` 策略） | `phase1` 已被证明为 0 | 同上 |
| 其他 | 未证明 | `FEASIBLE` + `best_bound` / `relative_gap` |

档位一致性：`wasm-light` 的 `can_prove_optimal=false`，即使达到下界也只报 `FEASIBLE`。
参考实例（`aps/mock/baseline.json`）现可证明最优：`OPTIMAL`，makespan = best_bound = 1560
（瓶颈为 1 台喷涂机 + `M-PAINT` 在 10-06T08:00 的到货门槛）。

单测：`objective::tests::lower_bound_is_valid_on_baseline`、`objective::tests`（见上表）；
集成测试 `optimal_is_claimed_only_when_lower_bound_is_attained`（单链实例 → 105 分钟 = LB → `OPTIMAL`）
与 `optimal_is_not_fabricated_when_tardiness_cannot_be_proven`（压缩交期 → 必然延期 → 绝不 `OPTIMAL`）。
验收侧：`aps accept` 的 S01/S02 会**独立重算**下界后才接受 `OPTIMAL`。

### 3.3 可构造的无解证明（`INFEASIBLE` 的准入条件）

| 证书码 | 数学含义 | 产生位置 |
|--------|----------|----------|
| `NO_ELIGIBLE_MACHINE` | `∀m ∈ alt(o): ¬capable(m)` 或任何可用窗口都放不下 `d[o,m]` ⇒ `Σ_m x[o,m] = 1` 不可满足 | `compile.rs` |
| `NO_ELIGIBLE_WORKER` | `∀w: ¬(skill ∧ quals ∧ calendar)` ⇒ `Σ_w y[o,w] = 1` 不可满足 | `compile.rs` |
| `MATERIAL_SHORTAGE` | `init[q] + Σ recv[q] < Σ use[o,q]` | `compile.rs` |
| `CHAIN_TOO_LONG` | 关键链（最短时长路径）下界 `> H` | `compile.rs` |
| `CERTIFICATE_TRUNCATED` | 证书列表超过上限（防噪声，仅作说明） | `compile.rs` |

引擎只在这四类证书之一成立时返回 `INFEASIBLE`（判据见 S04）；其余搜索失败一律
`NO_SOLUTION_FOUND` / `UNKNOWN`（SRS §4 状态协议）。

---

## 4. 约束编译器的单测清单（可直接运行）

```bash
cd aps/rust
cargo test --release --lib model       # 契约字段解析（收集式报错）
cargo test --release --lib validate    # 跨引用完整性、DAG、索引构建
cargo test --release --lib calendar    # 窗口合并/扣 blocked/最早可落位
cargo test --release --lib schedule    # 放置/回滚/日历空档/账本/锚点
cargo test --release --lib datetime    # ISO 8601 解析与跨时区/夏令时安全
cargo test --release --lib objective   # 目标口径与下界
cargo test --release --lib ledger      # 事件序账本（同刻先入库，正反例）
cargo test --release --lib solver      # 多规则构造、同 seed 可复现、预算内出解、无解夹具
cargo test --release --lib acceptance  # 验收套件本身不放在单元测试里，见下方说明
cargo test --release --test engine_integration   # 端到端契约与诚实性断言
```

> 逐条变异数据（18 组，覆盖 H01–H08 + 契约级）见 `src/acceptance.rs::mutations()`；
> 端到端验收用 `cd aps && aps accept`（或 `cargo test --release --test acceptance_suite -- --ignored`）；
> 交付包另有 `aps/tests/verify_mock.py` 的 7 组反例可交叉验证（非生产校验器）。
