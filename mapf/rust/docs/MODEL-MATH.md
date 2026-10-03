# 数学模型与证明骨架

本文件是引擎语义的**规范文本**：实现（`src/problem.rs`、`planner.rs`、`ecbs.rs`、
`dynamic.rs`、`verify.rs`）与本节冲突时以本文件为准，并应有回归测试兜底。

## §1 实例

栅格 `G=(V,E)`（4 邻接），n 台机器人，`start_i ≠ goal_j`，全部机器人共享同一时间片语义。

- 时间：离散 `t = 0..H`（`horizon`，或 auto：`max_i d_manhattan(i) + 2·|V| + 2n` 上界内搜索）；
- 动作：`(v,t) → (v',t+1)`，`v'=v`（等待）或 `(v,v')∈E`；单位代价；
- 速度/动力/装卸时间不在模型内（契约层直接拒绝，见 ERROR-CODES.md）。

## §2 冲突

对任意 t：
- **顶点冲突**：`p_i(t) = p_j(t)`，i≠j（含双方或一方停在 goal 上）；
- **边交换冲突**：`p_i(t)=u, p_i(t+1)=v` 且 `p_j(t)=v, p_j(t+1)=u`。

无其它冲突类型（不建模宽度/转弯半径）。

## §3 目标格占用（stay-at-target）

机器人到达 goal 后**永久驻留**：`(p_i(t)=goal_i, ∀t≥arrival_i)` 是解的一部分，因此
goal 占据时空资源——他人不得在其 arrival 之后踏入 `goal_i`，两车 goal 必须互异
（契约校验 `E-ROBOT-DUP-GOAL`）。推论：

1. LL 的启发必须允许“停在目标上的他车”被绕开；给 LL 的 goal-parking 约束把
   被占 goal 邻格的滞留时间也考虑进来（`planner.rs::goal_park_ok/max_goal_cons`）；
2. PP/ECBS  reservation 必须覆盖 `t = arrival_i..H` 整段驻留（只预留到 arrival 是
   M09 自检拒收的历史根因）；
3. 起点=终点的“零步机器人”不是合法输入（`E-ROBOT-START-EQ-GOAL`）；其需求是运营层
   判定，不属于路径规划。

## §4 目标函数

`SOC = Σ_i arrival_i`（到达即停，路径长 = arrival）；`Makespan = max_i arrival_i`。
最小化；两者共享同一约束集，仅 LL 代价函数与 HL 聚合不同。

## §5 算法族与完备性

- **PP（优先搜索）**：距离降序 + seed 打散的确定性优先序，逐车 A* + 预留；只作
  首解上界与“首解时间”指标，不宣称最优。
- **ECBS/CBS**：HL 二叉约束树（顶点/边约束），LL 时空 A*，启发 `h = Σ_i d_manhattan(i)`
  （SOC）或 `max_i d_manhattan(i)`（Makespan）——两者对各自目标均可采纳；
  FOCAL 按 `w` 窗过滤（`f ≤ w·LB_root`，w=1 退化为最优 CBS）。
- 冲突选择为确定性 tie-break（时间、机器人 id 字典序），保证同输入同轨迹。

**终止性**：时域 H 有限 ⇒ 状态空间有限 ⇒ HL 节点上约束单调增、无重复约束集 ⇒ 终止。

## §6 证明语义（何时允许说什么）

| 结论 | 条件（实现即证据） |
|---|---|
| `OPTIMAL` | `UB ≤ open.min`（Focal 堆按 f 排序，open.min 是**整个**剩余搜索空间的下界）；w>1 时同样成立——界追平即最优 |
| `FEASIBLE` | 存在解但 `UB > open_min/w` 且预算耗尽：输出解 + LB + 差距 ≤ w（w 界由 FOCAL 语义给出） |
| `INFEASIBLE` | 显式声明的 H 下 open 穷尽且无解；**auto-H 不享有该资格**（自动上界不是问题的一部分） |
| `UNKNOWN` | 预算/展开上限耗尽且无满足 w 窗的可行节点；含“有解但自检未通过被降级”的情形 |

verifier 独立复核 `E-PROOF-INVALID`：OPTIMAL 必须有 `optimality_proven` 且（w=1 或
`lower_bound == value`）；下界不得大于解值；FEASIBLE 差距必须 ≤ w。

## §7 动态快照（`dynamic.rs`）

- 前缀 `p_i(0..T_freeze)` 固定：解必须逐格包含它（否则 `E-FREEZE-BROKEN`）；
- “锁定”判据：`快照时刻在 goal ∧ goal 未被事件改动 ∧ 该 goal 未在前缀内被后续
  非法路径污染` ⇒ 视为驻留锁定至 H；被事件逼迫离开的车不锁定；
- 前缀间冲突只在窗口交集 `[0, min(T_a, T_b)]` 内检查（超出他车承诺窗口的
  “未来位置”不得用于否决本快照——幻影冲突的历史根因）；
- 事件（block_cells/remove_cell/goal_change）在 t=at 起生效，until 缺省为永久；
- 语义保证：新旧解在 `t ≤ snapshot.time` 完全一致（执行侧无撕裂）。

## §8 确定性与指纹

同输入 + 同引擎版本 + 同种子 + 同预算 ⇒ 同语义结果。
语义指纹 = `sha256(canonical(solution − {metrics, search, id, semantic_digest, verify, notes, engine}))`
（键序无关规范化）。浮点值仅出现在被排除的 metrics 中，不影响指纹。

## §9 复杂度与预算

单次 LL A*：`O(H·|V|·log)`；HL 节点数上界 `2^{|conflicts|}`（实际由 FOCAL 窗约束）。
wasm-light 档位上限见 CAPABILITIES.md；基准实测（含最难格）见 BENCHMARKS.md。
