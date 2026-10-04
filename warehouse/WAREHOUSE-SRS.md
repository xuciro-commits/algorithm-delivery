# Warehouse Optimization Suite · 需求规格（SRS）

> 本文件是 `warehouse/` 交付物的**需求基准**。实现（`warehouse/rust/`）、契约
> （`warehouse/contracts/`）、Mock（`warehouse/mock/`）、验收场景（`src/scenario.rs` 的 86 个场景）
> 与实验室面板（`lab/src/modules/slotting`、`lab/src/modules/dense-asrs`）都以此为准；
> 需求 → 代码 → 场景 → 验收判据的对应关系见 `warehouse/rust/docs/CONFORMANCE.md`。

## 0. 范围与名词

系统包含两个算法域与一个把两者闭合起来的联合域，全部以**同一份 Rust 核心**实现，
可编译为 native CLI 与 wasm32 模块（浏览器 Web Worker 内求解，同一份源码，不做前端重写）。

| 名词 | 含义 |
| --- | --- |
| SKU | 商品/物料主数据（周转率、ABC 类、关联族、单位重量） |
| 货位（location） | 由拓扑**推导**出的最小存储单元：`货架 × 排(bay) × 层(level) × 深位(depth)` |
| 货物单元（LU） | 一个托盘/料箱（`loadUnit`），占一个货位 |
| 巷道（aisle） | 货架之间的水平通道，端头为 `endNode`；每层一条独立的 lane 资源 |
| 提升机（lift） | 跨层搬运设备（货物提升机 `pallet-lift` / 巷道提升机 `aisle-lift`），井道为独占资源 |
| 穿梭车（shuttle） | 巷道内水平搬运设备（层穿梭车 `layer-shuttle` / 四向穿梭车 `four-way-shuttle`） |
| 输送机（conveyor） | 站台与巷道之间的连续运输段 |
| 深位（depth） | 密集立库中同一 column 的多个储位，深度大的位被前排阻挡，取放需先**倒垛** |
| 双指令（dual command） | 一次行程内完成「出库 + 顺路入库」两个作业 |
| 联合优化 | 用**真实设备调度结果**评价库位方案，并把调度暴露的拥堵反馈回库位模型 |

## 1. 目标与验收原则

1. **两条腿都要真**：库位优化不是"按 ABC 排序"，密集立库调度不是"最短距离排队"，
   必须实现元启发式与真实设备运动学（见 §3、§4）。
2. **闭环**：联合优化必须用真实调度（含冲突、等待、倒垛）评价库位方案，并给出反馈迭代记录。
3. **可解释**：任何方案都要回答——为什么货物放在这些库位；为什么设备按这个顺序运行；
   这个方案相对现状/随机基线改善了多少（同口径数字，不是理论最短距离）。
4. **可复现**：同输入 + 同种子 + 同引擎版本 ⇒ 逐位一致的结果；结果带 `fingerprint`。
5. **不造假**：指标、时间线、冲突、倒垛都来自引擎；未实现的能力必须如实标"未支持"，
   求解规模不得裁剪后声称全量（大实例如实报告实际完成数与资源占用）。
6. **状态语义严格区分**（§6）：`FEASIBLE` 与 `OPTIMAL_PROVEN` 不得混用，
   只有给出证明才能声明 `INFEASIBLE_PROVEN`，预算耗尽且无解才算 `BUDGET_EXCEEDED`。
7. **独立验证**：验证器只吃契约 JSON，自行重放约束、重算指标，与解上报数字逐项比对；
   人为篡改方案必须报出具体违规。

## 2. 域模型（拓扑与设备）

### 2.1 拓扑

由 `TopologyParams` 生成或由契约直接给出，包含：

* `areas`（区域：ASRS / 人工区 / 出库区 / 入库区 / 拣选区）；
* `aisles`：`id / level / length_m / axis / endNodeIds / rackIds / bidirectional`；
* `racks`：`id / aisle_id / levels[{level, y_m, height_m}] / bays / depth / side`；
* `nodes`（节点骨架）与 `links`（`mode ∈ {rail, road, conveyor, lift-shaft}`、`length_m`、
  `capacity`、`bidirectional`、`allowMeeting`）；
* `devices`：`kind ∈ {pallet-lift, aisle-lift, layer-shuttle, four-way-shuttle, agv, conveyor}`，
  每台设备带 `motion`（`speed_mps / accel_mps2 / transfer_s / handover_s / change_level_s /
  loaded_speed_factor`）、`capability`（可服务 `aisles / levels / areas`、`capacity_kg`、
  `capacity_loads`）、`exclusive_resources`（井道等独占资源）、`energy_*`；
* `stations`（站台：方向、缓存容量、`servedBy` 设备）、`buffers`（缓存位：容量、停留上限）；
* `frozenLocations`（逻辑冻结）与设备状态（`up / down / degraded`）。

**库位是推导量**：`derive_locations(topology)` = `racks × levels × bays × depths`，
契约里不接受"直接给一个库位数"。典型规模：150k–500k SKU、500k–2M 库位（见 §9）。

### 2.2 图与成本

* 节点图 `NodeGraph`：库位节点 `LOC:{id}` 通过 `lift-shaft / rail` 链挂在巷道端头，
  巷道端点通过横巷（`cross-aisle`，单/双车道）与主通道相连；
* 最短路：`dijkstra`（二叉堆）与 `dijkstra_until`（目标确定即停 + 点对缓存）；
* 时间：**梯形速度曲线** `travel_time(distance, v, a)`，含加减速段；
* 巷道内行驶时间按轨道距离计算，跨层必须经提升设备（井道为独占资源，调度层保证合法性）；
* **禁止**用欧氏距离近似设备运行成本（唯一例外：设备指派时的空驶下界，仅用于打分，不进入指标）。

## 3. 域 A：库位优化（Warehouse Slotting）

### 3.1 基础对照策略（8 种，`strategies::ALGORITHMS` 的一部分）

周转率分区、ABC 分类、关联性聚类、按巷道/层均摊、按拣选路径顺序、随机基线、当前布局保持、
距离最近优先——用于回答"相比经典做法改善了没有"（`comparison.baselines`）。

### 3.2 元启发式（必须有真搜索）

* **A. 邻域搜索**：ALNS（破坏-修复：随机移除 / 最差移除 / 关联簇移除 / Shaw 移除，
  贪心与 regret-2 修复）与 LNS；
* **B. 局部搜索**：禁忌搜索（带期约与频率惩罚）、模拟退火（温度与接受率记录）、
  爬山（用于基线对照）；
* **C. 多目标**：NSGA-II（快速非支配排序 + 拥挤度 + 精英保留），输出 Pareto 前沿；
* **D. 鲁棒优化**：多种子情景（需求扰动、设备降级、库位冻结）下的最坏情形目标与稳定性指标。

### 3.3 动态调整（需求变化 / 事件驱动）

按事件（需求突变、促销簇、库位冻结、取消订单、库存回收）触发**局部再优化**：
搬迁预算受 `migrationBudget` 约束（最大搬迁件数 / 最大设备秒数），
产出 `migrations`（from → to、原因、代价），并记录搬迁代价与长期收益的权衡。

### 3.4 目标与约束

多目标加权（可配置权重向量）：拣选/存取日运行时间（按真实设备运动学）、
巷道负载均衡（Gini）、关联簇相邻性、深位倒垛代价、搬迁代价、鲁棒最坏情形；
硬约束：库位容量、设备可达性（`can_serve_location`）、区域/温区兼容、冻结与封闭、
SKU 危险品隔离等（`hardConstraints` 显式列出，违反即 hard violation）。

### 3.5 输出

`assignment`（LU → 库位）、`unassigned`（附原因）、`migrations`、
`objectives`（逐目标值 + 方向）、`comparison`（当前布局 / 随机基线 / 优化方案，同口径）、
`explanation`（为什么放这里，引用真实计算证据）、`pareto`（多目标场景）、
`search`（迭代/重启/最优迭代/收敛轨迹/耗时/是否被取消）。

## 4. 域 B：密集立库联合调度（High-Density AS/RS）

### 4.1 任务与作业类型

`inbound`（入库）、`outbound`（出库）、`relocate`（移库/倒垛）、`count`（盘点）、`transfer`（移库跨区），
任务带 `priority / release_s / deadline_s / dependsOn / cancellable / dualCommandEligible`。

### 4.2 调度决策

1. **任务分配**：能力过滤（巷道 / 层 / 区域 / 载重 / 载荷数）+ 最早可用 + 空驶距离；
   策略可切换：`fifo / priority / priority-edd / nearest-device / dual-command / joint-alns`。
2. **任务排序**：按优先级、EDD（含延迟惩罚）、联合搜索（真实重演）。
3. **无冲突路径**：巷道层内互斥（`LANE:{aisle}:L{level}`）、井道互斥（`SHAFT:*`）、
   站台/缓存容量、走廊资源（同层横向通道按容量允许会车）；
   每段行程拆成"本巷道 → 走廊/竖井 → 目标巷道 → 货位"多条**各自带资源**的步骤，
   时间线里能逐段复核互斥（跨巷道一步到底无法精确复核，故拆分）。
4. **交叉口/设备间等待**：时空预约表给出"最早可开始时刻 + 阻塞者"，记录 `blockedMoves`、
   `conflicts`、`deadlocksPrevented`。
5. **交接**：站台与缓存位的占用、容量、停留时间（`bufferPeak / stationPeak`），
   人工区任务不得占用自动化设备。
6. **双指令**：出库与入库配对，记录 `dualCommandPairs` 与空驶节省。
7. **多深位倒垛**：目标深位被前排阻挡时先倒垛；落点选择同列最优、其次同层同面最近空位，
   倒垛作为**派生任务**单独统计（`derivedTasksDone`），不计入输入任务的完成数。
8. **动态事件与重调度**：紧急插单/抢占、任务取消、设备故障与恢复、降速、
   巷道封闭、库位冻结、缓冲位丢失、需求突变、订单取消回收；
   事件按时间顺序落到物理状态（`outages / speedFactor / closedAisles / frozenLocations`
   / `bufferCapacityOverride`），并在时间线里留痕。

### 4.3 时间与状态一致性（§6.4）

* 每条步骤声明 `start_s / end_s`，验证器按几何与设备运动学重算，
  声明时间明显短于物理需要 ⇒ hard `TIME_CONSISTENCY`；
* 同一设备步骤不得重叠；同资源上不同设备的时空区间重叠 ⇒ hard `LANE_MUTUAL_EXCLUSION` / `DEVICE_MUTUAL_EXCLUSION`；
* 故障窗口内不得有动作（`DEVICE_UNAVAILABLE`），冻结库位与封闭巷道不得有动作；
* 库存台账守恒（`INVENTORY_CONSERVATION`）：每次 load/unload 的 LU 流转可逐条对账；
* 深位规则：深位有货而浅位空置必须报 `DEEP_LANE_ORDER`（避免"悬浮"库存）。

### 4.4 指标（全部来自时间线重算）

`makespan_s / throughputPerHour / tasksTotal|Done|Unserved / derivedTasksDone / lateTasks /
maxLateness_s / meanCycle_s / meanWait_s / travelMeters / energyKwh / relocationTasks /
blockedMoves / conflicts / deadlocksPrevented / reservations / dualCommandPairs /
deviceUtilization / bufferPeak / stationPeak / locationsOccupied / searchedSimulations /
computeMs / scale`。

## 5. 域 C：联合优化（闭环）

1. 库位优化（可注入拥堵反馈系数 `congestion_scale`）→ 2. 用该库位方案驱动**真实**立库调度 →
3. 读取调度实测（完工时间、冲突、平均等待、倒垛次数）→ 4. 反馈回库位模型（EMA 平滑）→ 迭代。

* 联合目标可复算：`库位侧日运行时间 × w_travel + 调度完工时间 × 0.5 + (完工/任务数) × 60
  + 冲突 × 5 + 倒垛 × 30`；
* `rounds[]` 记录每一轮的算法、库位侧日运行时间、调度完工、冲突、等待、倒垛、联合目标、是否验证通过；
* `comparison` 在同一调度口径下比较：随机储位 / ABC 分区 / 库位优化（联合闭环）；
* `pareto`：权重网格采样 + **真实闭环评估** + 非支配筛选（不是穷举前沿，脚本内如实标注）；
* `explanation`：三条必答问题的自然语言 + 可复算依据。

## 6. 状态语义（不得合并）

| 状态 | 含义 |
| --- | --- |
| `OPTIMAL_PROVEN` | 只有精确求解（小规模精确/分支定界完成）才能声明 |
| `FEASIBLE_WITH_BOUND` | 有解，且有可复算界（联合场景常见） |
| `FEASIBLE` | 有解且独立核验通过 |
| `BUDGET_EXCEEDED` | 预算耗尽**且没有有效解**（有解时返回 FEASIBLE 族） |
| `NO_SOLUTION_FOUND` | 搜索结束仍无解，但未证明不可行 |
| `INFEASIBLE_PROVEN` | 只有给出证明才允许 |
| `CANCELLED` | 用户取消，已回收部分结果 |
| `INVALID_INPUT` | 契约错误，带字段路径 `issues[]` |
| `UNSUPPORTED` | 超出档位能力（`capabilities` 声明的上限） |
| `INTERNAL_ERROR` | 独立验证未通过（结果不可交付） |

## 7. 契约与可复现

* 输入/输出 JSON 契约：`warehouse/contracts/*.schema.json`（draft-07，由 `make_schemas.py` 生成并校验防漂移）；
* 结果信封：`engine / engineVersion / rulesetVersion / fingerprint / status / runtimeMs /
  issues / metrics / objective / result / comparison? / timeline? / verification`；
* `fingerprint` = SHA-256(引擎名 + 版本 + 规则集版本 + datasetVersion + 算法 + 种子 + 输入)；
* 同种子重跑目标值差 < 1e-9（验收的 reproducibility 判据）；
* CLI 退出码：`0` 有效 / `1` 用法或 IO / `2` INVALID_INPUT 或 UNSUPPORTED / `3` 未知错误、
  取消或验收失败；
* `timeline` 字段口径（实验室回放与倒垛图层直接依赖，改名前先读这段）：
  * `devices[].steps[]`：`kind`（travel/lift/load/unload/wait/handover/fault/charge/idle）、
    `start_s`/`end_s`、`from`/`to`（含 `x/y/z` 与 `locationId`/`nodeId`/`aisleId`）、
    `distanceM`、`energyKwh`、`delayedBy_s`、`resourceId`、`loaded`、`note`；
  * `tasks[]`：任务轨迹，设备/步骤 id 数组的键名是 **`devices` / `steps`**，
    `deadline_s` 序列化为**字符串**（历史形状，读取端必须显式转数）；
  * `bufferStates[]`：`{at_s, bufferId, occupancy, capacity, reason}`；
  * `locationStates[]`：`{at_s, locationId, loadUnitId, reason}` —— 库位占用变化。
    **倒垛约定**：一次深位让位会写成**同一时刻的两条**（挡住目标的格子被让空，
    reason 以 `倒垛：` 开头；同列空闲格接收，reason 以 `倒垛落位` 开头），
    两者按出现顺序配对成一次让位；普通出入库的状态迁移（如 `入库完成`）不在此列。

## 8. 规模与合成数据

* 生成器 `warehouse generate --scenario <id> --scale <tiny|small|medium|large|extreme|stress>`：
  SKU 8 / 60 / 400 / 8k / 60k / 150k，任务 12 / 120 / 900 / 6k / 20k / 20k，占用率 0.82（压力档 0.55，可配）；
  未知档位显式报 `VALUE_RANGE`（字段路径 `scale`），不静默回退；
* 压力档位 `stress`（X01 / X02）覆盖本节的 **150k SKU / 1.9M 库位**区间：
  90 巷道 × 12 层 × 220 列 × 4 深 × 2 侧 = 1 900 800 个库位；`X03` / `D17` 另按 `large` / `extreme` 验证
  满库与 20 000 任务级规模，全部**如实报告实际规模与资源占用**；
* 档位能力：native 2M SKU / 4M 库位 / 1M 任务 / 3600 s；wasm-light 60k SKU / 300k 库位 /
  120k 任务 / 20k 任务上限 / 120 s（超档 → `UNSUPPORTED`，不静默降级）。

## 9. 验收：86 个标准场景

族与数量：`S01–S24`（库位优化，24）· `D01–D24`（调度，24）· `E01–E14`（事件与异常，14）·
`J01–J12`（联合，12）· `X01–X12`（压力与边界，12）。

每族要点（完整清单与 `mustShow` 标签见 `warehouse/rust/src/scenario.rs`）：

* **S 系列**：策略对照、关联簇、动态重排、多目标、鲁棒、大规模目录、对照矩阵、解释；
* **D 系列**：单/双/多深位、四向车、多层、双指令、紧急插单、取消、故障、封闭、冻结、降级、
  空地混合、5k/20k 任务规模（如实报告完成数与内存）；
* **E 系列**：高峰、需求突变、促销、抢占、取消风暴、设备故障与恢复、缓冲丢失、降速、
  订单取消回收、盘点；
* **J 系列**：联合基线、热点集中/分散、关联簇 × 双指令、多深位倒垛代价、提升机瓶颈、
  抗拥堵、短期/长期权衡、鲁棒 × 故障、Pareto、闭环收敛、事件驱动联合、双指令联合；
* **X 系列**：150k SKU、2M 库位、99% 占用、零库存、单库位、全冻结、零设备、零任务、
  退化拓扑、重复 ID、非法参数、**验证器对抗（篡改方案必须报错）**。

验收判据（`warehouse acceptance`）：状态语义 · 解存在 · 独立验证 · 规模诚实 ·
可复现（同种子 Δ < 1e-9）· `shows:<tag>` 现象（timeline / comparison / explanation / pareto /
bound / stability / deviceUtilization / relocation / dualCommand / dynamic / scale / issues / violation）。

## 10. 实验室集成（Algorithm Lab）

两个新模块（`#slotting`、`#dense-asrs`）必须以**引擎真实输出**驱动：

* 场景选择（86 个场景 + 5 个规模档位）、参数（算法 / 种子 / 预算 / 双指令 / 核验开关）；
* 3D：库位热力图与关联簇叠加、巷道剖面、穿梭车/提升机/输送机的真实位置与状态、
  多深位剖面、倒垛动作、故障/封闭/冻结的局部高亮；
* 回放：时间轴（步骤级）、按设备筛选、速度 1/2/4/8、时间线 + 事件标记；
* 对比：运行历史（会话内 20 条）+ 逐指标差异表（方向语义），跨规模不可比时明确标出；
* 三条必答问题的面板呈现（库位解释 / 调度解释 / 改善幅度），全部引用引擎字段；
* 视觉连续：沿用既有工业科技美术语言（`lab/src/art`、`#art-lab` 模式 A/B/C），
  不新造一套颜色与灯光体系。

## 11. 交付物清单

| 交付物 | 位置 |
| --- | --- |
| 本需求规格 | `warehouse/WAREHOUSE-SRS.md` |
| Rust 核心（lib + CLI + wasm） | `warehouse/rust/src/**` |
| 契约 schema 与生成脚本 | `warehouse/contracts/**` |
| Mock（可直接求解的问题文档） | `warehouse/mock/*.json` |
| WASM 构建 / 冒烟 / 契约检查脚本 | `warehouse/rust/scripts/**` |
| Web Worker 胶水（浏览器与 Node 通用） | `warehouse/rust/web/warehouse-worker.js` |
| 引擎文档 | `warehouse/rust/docs/**` |
| 实验室模块 | `lab/src/modules/slotting/**`、`lab/src/modules/dense-asrs/**` |
| 模块说明与交接 | `warehouse/README.md`、`warehouse/rust/docs/DELIVERY.md` |

## 12. 非目标（明确不做）

* 不做仓储业务流程（收货/发运单据、WMS 单据流转）——本交付只解算法；
* 不做前端重算：实验室页面不重新实现任何指标；
* 不引入第三方求解器/几何库（零第三方依赖是硬约束，见 `docs/DEPENDENCIES.md`）；
* 不承诺硬件实时性：求解时间是软实时预算，超预算按状态语义如实上报。
