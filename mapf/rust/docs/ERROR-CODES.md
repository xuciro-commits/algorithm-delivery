# 错误码表（`mapf/`）

所有对外错误均为结构化 Issue：`{code, severity(error|warning), path, message}`（`src/errors.rs`）。
`severity=error` 任一条 ⇒ `status=INVALID_INPUT`（或 `UNSUPPORTED`，当且仅当 code 为 `E-CAP-UNSUPPORTED-FEATURE`）。
`severity=warning` 只出现在 `notes`，不阻断求解。

## 输入契约层（parse/validate，`src/problem.rs`）

| Code | 触发条件 | 典型修复 |
|---|---|---|
| `E-MAPF-BAD-JSON` | 输入不是合法 JSON（含 BOM/尾逗号） | 用 `python3 -m json.tool` 先过一遍 |
| `E-MAPF-SCHEMA` | 顶层类型/必填结构错误 | 对照 `mapf-problem/1.0` schema |
| `E-MAPF-UNKNOWN-FIELD` | 出现未声明字段（白名单外一律拒绝） | 删除或改名；扩展字段走 `extensions`（如声明） |
| `E-MAPF-MISSING-FIELD` | 必填字段缺失（如 `map.width` 而 cells 推不出） | 补齐或给出 `cells` |
| `E-MAP-MAP-SHAPE` | `cells` 行宽 ≠ width 或行数 ≠ height | 检查行列主序 |
| `E-MAP-MAP-EMPTY` | 地图没有可通行格 | 至少一个非障碍格 |
| `E-ROBOT-DUP-ID` | 机器人 id 重复 | 全局唯一（大小写敏感） |
| `E-ROBOT-DUP-START` | 两车起点同格 | 起点即冲突：必须互异 |
| `E-ROBOT-DUP-GOAL` | 两车终点同格 | 目标格占用语义下必须互异 |
| `E-ROBOT-START-BLOCKED` / `E-ROBOT-GOAL-BLOCKED` | 起/终点落在障碍上 | 修正坐标或地图 |
| `E-ROBOT-START-EQ-GOAL` | 起点=终点（契约拒绝退化输入） | 无位移需求请从 robots 移除该车 |
| `E-ROBOT-COORD-RANGE` | 坐标越界 | 0 ≤ x < width, 0 ≤ y < height |
| `E-TIME-HORIZON` | `time_model.horizon` 非正整数且非 `"auto"` | 给正整数或 `auto` |
| `E-OBJ-KIND` | `objective.kind` 不在 `soc|makespan` | 二选一 |
| `E-CAP-UNSUPPORTED-FEATURE` | 使用未实现特性（动作时长、代价权重、并行边等） | 见 `mapf capabilities` 的 `unsupported_features` |
| `E-CAP-LIMIT-AGENTS` / `-MAP` / `-HORIZON` / `-BUDGET` | 超出当前档位限额 | native 放宽；wasm-light 见 CAPABILITIES.md |
| `E-BENCH-MAP-MISMATCH` | `benchmark.agents` 与 robots 实数不符（或 map 引用不一致） | 用 `mapf convert` 生成，勿手改 |
| `E-BENCH-HASH-MISMATCH` | `benchmark.*_sha256` 不是 `sha256:<64hex>` | 重跑 convert（哈希由工具写入） |
| `E-SNAP-SHAPE` / `E-SNAP-TIME` / `E-SNAP-PATH-MISMATCH` | 快照结构/时间戳/前缀与当前问题不一致 | 前缀必须逐格等于已走路径（可尾部补齐） |
| `E-SNAP-FROZEN-CONFLICT` | 冻结前缀内部存在相互冲突（含交换） | 快照本身不合法：先修复再提交 |
| `E-SNAP-FROZEN-ILLEGAL` | 冻结前缀含非法移动（跳格/穿墙） | 前缀必须是真执行过的路径 |
| `E-EVENT-KIND` / `E-EVENT-TARGET` / `E-EVENT-TIME` | 事件类型未知 / 引用不存在的机器人 / 时间早于快照 | 事件语义见 USAGE.md |

## 核验层（`src/verify.rs`，独立于求解器实现）

| Code | 含义 |
|---|---|
| `E-WALL-ENTRY` | 某步位于障碍格 |
| `E-MOVE-ILLEGAL` | 单步非 4 邻接也非同格等待（瞬移/对角线） |
| `E-CONFLICT-VERTEX` | 同一时刻两车同格（含停在目标上的驻留占用） |
| `E-CONFLICT-EDGE` | 同一时间片交换位置（边冲突） |
| `E-GOAL-UNREACHED` | 时域终点处未停在各自 goal |
| `E-GOAL-OCCUPY` | 目标格被他人永久占用后仍被穿越/滞留 |
| `E-FREEZE-BROKEN` | 解偏离 `dynamic.locked` 机器人冻结前缀 |
| `E-OBJ-SOC` / `E-OBJ-MAKESPAN` | 声明目标值与按路径重算值不符 |
| `E-PROOF-INVALID` | 状态声明与证据不符（无证明标记的 OPTIMAL、`w>1` 且下界未追平、下界>解值等） |
| `E-HASH-MISMATCH` | strict 模式下 `problem_hash` 与问题重算值不一致 |
| `E-INTERNAL` | 引擎自检异常（理论不可达；出现请按 issue 上报） |

## 求解状态与错误的关系

`INVALID_INPUT`（errors 非空，robots 为空数组）与 `UNSUPPORTED` 是**契约级**结论，
不是求解失败；`INFEASIBLE` 携带证明语义（声明时域内穷尽）；`UNKNOWN`/`CANCELLED`
不携带路径。全部形态都符合 `mapf-solution/1.0`（错误路径也是契约的一部分，
`check_contracts.py` 对此有专门用例）。
