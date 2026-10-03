# 能力档位（Capabilities）

引擎自描述接口：CLI `mapf capabilities [--profile native|wasm-light]`、
WASM `mapf_capabilities()`。输出符合 `mapf-capabilities/1.0`（`mapf/contracts/`）。

## 两个档位

| 维度 | native | wasm-light |
|---|---|---|
| 使用场景 | CLI / 服务 / CI / 基准 | 浏览器 Worker（Lab） |
| 机器人上限 | 无（内存内） | **120** |
| 地图格数上限 | 无 | **16384**（边长 ≤ 256） |
| 时域上限 | 无 | **1500** |
| 求解预算上限 | 无 | **120000 ms** |
| HL 展开上限 | 无 | **800000**（超限即 `UNKNOWN`，语义如实） |
| 动态事件数 | 32 | 32 |
| 输入体积 | 无 | 8 MiB |

超限不是崩溃：解析期以 `E-CAP-LIMIT-*` 结构化拒绝（`INVALID_INPUT`），
运行期资源上限触发则返回 `UNKNOWN` 并保留已找到的最优界信息。

## 共同能力（两档一致）

- **目标**：`soc`（总耗时）与 `makespan`（完时），各自独立下界与证明；
- **证明语义**：`can_prove_optimal_soc/makespan = true`、`can_prove_infeasible = true`
  （限“声明时域内”，见 MODEL-MATH.md §5–§6；`auto` 时域不享有 INFEASIBLE 资格）；
- **有界次优**：ECBS `w ∈ [1,3]`，FEASIBLE 必附 `lower_bound` 与可信差距；
  `w>1` 亦可宣告 OPTIMAL，当且仅当下界追平解值（verifier 同规则复核）；
- **动态事件**：快照冻结前缀（locked 覆盖核验）、目标变更、事件时间窗；
- **核验**：每次求解自动跑独立 verifier 并内嵌 `verify` 报告（可用
  `options.verify=false` 关闭，但基准/验收一律开启）；
- **确定性**：固定输入 + 引擎版本 + 种子 + 预算 ⇒ 语义指纹一致
  （指纹 = 全量方案 JSON 去掉 `metrics/search/id/semantic_digest/verify/notes/engine` 后的 sha256）。

## 明确不做（`unsupported_features`）

连续/带加速度的运动学、非单位动作时长、边代价权重、机器人异质速度、
路网（非栅格）拓扑、多目标 Pareto、任务分配/排序耦合、碰撞后重规划闭环
（提供快照重规划原语，不含业务侧编排）。这些在契约层被 `E-CAP-UNSUPPORTED-FEATURE`
拒绝，而不是被静默近似。

## 消费方式

- 实验室（`useMapfEngine`）装载时握手读取本档位，限额直接进参数面板边界；
- 集成方应将本档位作为**版本化能力清单**处理（`schema_version + engine + version + profile`），
  不要从错误消息文本推断能力；
- 校验脚本：`mapf/rust/scripts/check_contracts.py` 第 [5] 节断言两档输出各自符合契约。
