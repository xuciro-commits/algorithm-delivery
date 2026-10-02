# 平台级 APS 规划与优化引擎 — 软件需求说明书（SRS v1.0）

**交付对象**：乙方研发团队  
**目标场景**：离散制造车间（MES 参考应用），为平台能力提供真实可复现验证，而不是开发封闭的 MES APS 模块。  
**建议技术栈**：React + TypeScript，Go 平台 API，Rust 统一模型校验/候选方案核验/局部排程，Rust WASM（浏览器 Web Worker），OR-Tools CP-SAT 独立原生服务（建议首版 Python 原型、随后视部署要求使用 C++ 或官方 Go 建模接口）。

## 0. 架构决策与边界

1. **共享的是业务中立的规划契约**：`PlanProblem v1`、`PlanSolution v1`、`SolverCapabilities v1`；APS 是第一个垂直领域编译器，后续扩展人员排班、资源分配时不得强行继承制造工艺字段。
2. **Rust 不是必然更快的求解器**：Rust 负责可编译为 native/wasm 的纯算法核心（校验、快速插入、局部修复、有限规模启发式搜索）；复杂 CP-SAT 原生后端作为质量基准和复杂实例回退。乙方可申请 Rust 原生通用求解器作为第二期替换方案，但须用相同 Mock 和指标证明等价覆盖和性能。
3. **WASM 仅承担轻量浏览器端计算**：Worker 内运行，不阻塞 React 主线程；不要求将官方 OR-Tools 编译为浏览器 WASM，也不将 WASM 当作高并发服务器求解方案。涉及 SharedArrayBuffer/多线程，必须单独验证 COOP/COEP 等部署条件及 Safari/Chrome/Firefox 兼容性；一期先用单 Worker。
4. **不允许求解器直接修改业务状态**：只返回候选计划；Go 侧根据快照版本核验、授权、审批和发布，产生不可变审计事件。失效快照必须拒绝发布并触发重算或人工处理。
5. **未经验证的“智能”预测不进入 P0**：本期输入的设备故障、预计到货、工时是已给定数据，不要求 AI 推断。

## 1. 目标、非目标与交付阶段

### P0：最小可用平台能力（合同必验）
- React 工作台：数据检查、资源日历、甘特图、约束开关（仅已实现约束）、多目标策略选择、求解/取消/比较/待审批发布操作、无解/超时错误呈现。
- 生产计划编译：订单→工序 DAG、候选设备、技能人员、时间日历、物料到货与消耗、独占共享工装；所有建模有业务 ID ↔ 数学变量的追溯映射。
- 求解：后端 OR-Tools CP-SAT 处理 P0 约束；Rust native/wasm 共享纯校验与至少一个可运行的局部修复/插入启发式，不得用“随机甘特图”代替。
- 结果：标准化 `PlanSolution`、求解状态（区分可行/最优/无解/未知/模型非法）、所有工序的开始结束/机器/人员/工具、目标值及每条违约信息；同一 Rust 校验器独立校验 OR-Tools 输出。
- 可靠性：租户隔离、资源限制、取消、输入版本、可重现测试、审计追溯；复杂求解与 UI 隔离运行。

### P1：后续阶段（不得假装已实现）
- 依赖前序产品类型的换线时间（sequence-dependent setup）、多工序协同资源、多物料替代、分批与合批、有限在制品、多目标 Pareto 对比、部分不可行解释、求解进度/中间解、跨场地运输。
- 大规模横向扩容、增量计算复用和性能压测。

### 明确排除
- 完整 ERP / MES / 库存交易系统、真实物联网采集、AI 预测交期、商业级全功能 APS 的功能对等承诺。
- 浏览器内高性能 CP-SAT 的功能和最优性保证；允许 WASM 返回有独立校验的 `FEASIBLE` 或 `NO_SOLUTION_FOUND`，不能错误声称 `OPTIMAL/INFEASIBLE`。

## 2. 领域输入（Mock 模型）

以 `mock/baseline.json` 为唯一字段语义样本：

- `meta`：模式版本、工厂、租户、快照 ID、时区、规划起止及时间分辨率（本版 15 min，所有持续时间及可用窗口对齐）；同租户必须使用不可变快照。
- `machines`：机器 ID、能力集、日历可用窗口、不可用窗口；一台机器同一时间只可执行一道工序。
- `workers`：人员 ID、技能与资格、日历；一人同一时间不得执行多道工序。
- `tools`：独占工装/模具，一件工具同一时间只允许分配给一道工序；没有工具需求的工序不占用工具。
- `materials`：初始库存、时点到货；工序开始时一次性扣除本工序 `materials` 数量（全部为整个订单批次数据）。物料不得出现负库存；P0 不实现物料释放和半成品返库。
- `orders`：订单 ID、批量 `quantity`（当前不拆批）、`release_at`、`due_at`、`priority`、一条由 `operations` 构成的工艺路线。
- `operations`：工序 ID、前置工序 ID、允许的 `alternatives`（机器 ID + 该机器上的整个批次工时分钟）、需要的人员技能、资格、人数（P0 固定 1）、所需工具、所需物料。所有工序不可抢占；可在日历空档内执行，不能穿越停工时间。
- `objective`：P0 首选字典序优化：第一阶段按订单权重最小化延期分钟，第二阶段在不恶化第一目标的前提下尽量缩短全部完工跨度；权重和目标值必须报告。乙方也须提供仅最小化 `makespan` 的策略作为对照。

**时间与精度**：内部以 `meta.horizon_start` 起算的非负整数分钟建模；输入/输出 ISO 8601 含偏移；所有持续时间、库存、权重必须为非负整数。跨夏令时不得使用“当地时钟直接相减”进行时间计算。本包样本故意选用固定 PDT 时间段。

## 3. 数学问题定义（必须写成代码及测试）

对每个工序 `o`，定义 `start[o]`、`end[o]`（整数分钟）；每个可选机器 `m`，定义是否选用的布尔值 `x[o,m]`，满足 `sum(x[o,m])=1`；为人员分配定义 `y[o,w]`，每工序恰好选用一名满足技能/资格与日历的员工；候选资源使用可选区间变量。

硬约束 H（一期全部实现）：

- H01 工序时长：选中机器后 `end[o]=start[o]+duration[o,m]`。
- H02 工艺依赖：每条依赖 `start[o] >= end[pred]`；`start[first] >= release_at(order)`。
- H03 机器能力：只能选择 `alternatives` 中存在且具备能力的机器；同一机器不重叠。
- H04 机器、人员日历：不可抢占工序占用区间必须完全处于某一条连续可用窗口内，并排除显式 `blocked`；与班次空档重叠即非法。
- H05 人员技能、资格和排他性：恰好一人，并且已满足工序的技能/资格；员工同时只能执行一道工序。
- H06 独占共享工装：标注工具的工序在完整加工区间独占该工具。
- H07 物料时序平衡：初始库存 + 截至时刻的有效到货 − 截至时刻开始的各工序用量 >= 0；同一时刻先入库再扣料，使用固定事件顺序，禁止消耗不存在的到货。
- H08 所有订单工序必须排入给定 horizon，不能静默删除订单或虚报完成。

软约束/目标：`completion(order) = max(end[terminal_operations])`；`tardiness(order)=max(0, completion(order)-due_at)`；第一阶段优化 `sum(priority * tardiness)`，第二阶段 `makespan=max(end[all])`。求解时间受限时允许返回已找到的可行解，并明确 `optimality_proven=false` 和 objective/gap（若有）。P0 不要求求得数学全局最优的大规模实例。

## 4. 求解服务与验证职责

```text
React UI
   │ 业务 CRUD / solve commands
Go Platform API ─────> Snapshot Store / Authorization / Journal
   │
   ├─ Rust Model Validator (native service or library)
   │
   ├─ Native OR-Tools CP-SAT Solver Adapter (worker/service)
   │        └─ PlanSolution
   │
   └─ React Web Worker ──> Rust WASM Heuristic/Local Repair
                              └─ PlanSolution

所有候选结果 ──> Rust Independent Plan Verifier ──> Compare / Approve / Publish
```

- 模型编译与引擎分离：`compile(problem, capabilities)->internal_model`，`solve(model, options)->solution`，`verify(problem, solution)->violations`。
- 任何引擎必须先声明 `SolverCapabilities`（支持的约束、规模上限、是否能证明最优/无解、是否支持中断）；不能求解的输入返回 `UNSUPPORTED_CONSTRAINT`，不能擅自忽略。
- 输入建模失败返回 `MODEL_INVALID`（给字段定位）；超时未找到解返回 `UNKNOWN`；可行但未证明最优返回 `FEASIBLE`；仅在求解器已证明时返回 `OPTIMAL` 或 `INFEASIBLE`。状态名按统一协议规范，而非依赖各引擎内部枚举。
- 采用幂等 `solveRequestId`，支持指定 `seed`、`time_limit_ms`、取消、任务状态查询、最大并发数及内存/CPU 限额。统计建模耗时、首个可行解耗时、总求解耗时、峰值内存、目标值、界限/差距及验证耗时。
- 后端与浏览器端的 `problem_hash`、编译器版本、引擎版本、求解选项记录在结果，保持可审计；即使相同种子，并行搜索未必字节级确定，验收比对方案合法性和目标，不要求完全相同时间表。
- Rust 独立校验器必须不重用求解器内部的约束判断路径，避免同一编译错误同时污染求解与验证；针对每种约束准备故意破坏的方案做反向测试。

## 5. React 用户界面

仅使用共享 UI 组件库，不为 APS 复制一套按钮、表单、抽屉等基础组件。功能页面：

1. **数据概览**：订单/工序、机器/人员/工具、库存/到货、日历；显示快照版本和字段校验错误。
2. **计划工作台**：设备和人员甘特图（可切换）、订单表、交期风险、缩放/拖动/资源分组、选中工序查看其全部约束依据。
3. **求解控制**：目标策略、后端选择（WASM 仅对声明支持的实例开放）、时间限制、运行/取消、进度与求解状态。
4. **方案比较**：基准计划与候选计划并排比较，包括延期加权分钟、最大完工时间、变更次数、机器利用率（统一口径）、不合法项。
5. **发布回程**：候选→独立校验→授权审批→检查快照是否过期→发布；前端必须展示失败、冲突、过期以及发布后的最终版本号，不允许只显示“提交成功”。

交互要求：WASM 必须在 Web Worker 内执行；浏览器关闭页面不应中断已经提交服务器的求解；长任务必须可取消；非受支持模型禁止显示浏览器端可求解选项。移动端仅需只读查看基本计划，不要求完整甘特图编辑。

## 6. 标准 API / 返回合同

首版提供版本化 API（与现有平台路由和多租户鉴权方式集成，非强制独立公开服务）：

- `POST /api/optimization/v1/problems/validate`：校验输入、引用、可用引擎能力；输出结构化错误。
- `POST /api/optimization/v1/solve-jobs`：提交不可变快照引用、策略、时间预算、引擎、seed、幂等键；返回 job ID。
- `GET /api/optimization/v1/solve-jobs/{id}`：查询 queued/running/completed/failed/cancelled；返回指标和结果引用。
- `POST /api/optimization/v1/solve-jobs/{id}:cancel`：取消；明确超时、主动取消和失败是不同状态。
- `POST /api/optimization/v1/solutions/verify`：返回结构化违约及资源/时间定位。
- `POST /api/optimization/v1/solutions/{id}:propose`：创建待审批计划（无业务落地副作用）。
- `POST /api/optimization/v1/plans/{id}:publish`：授权并以快照版本条件发布；过期返回冲突与受影响的资源/订单；生成 journal 事件。

统一返回字段参见 `contracts/plan-result.example.json`。`UNSUPPORTED_CONSTRAINT` 是模型与引擎能力不匹配的错误码；未求得解不应伪造空排程。

## 7. Mock 场景与必须通过的验收

- **S01 基础车间**：`mock/baseline.json`，至少返回一份经独立校验的可行计划，每个工序恰好一次分配且有完整资源映射。
- **S02 设备故障**：`mock/machine-breakdown.json`，W2 在指定时间禁用，禁止任何排程进入禁用区间；原计划比较要显示变更影响。
- **S03 到货延迟**：`mock/material-delay.json`，M-PAINT 晚到，相关喷涂工序不得消耗尚未到货的物料。
- **S04 证明无解**：`mock/infeasible-no-welder.json`，移除全体焊工资格，CP-SAT 在完整模型下证明无解并返回 `INFEASIBLE`；WASM 不得伪称已证明，允许返回 `NO_SOLUTION_FOUND/UNSUPPORTED_CONSTRAINT`。
- **S05 失效快照**：旧 `snapshotId` 提交的方案在设备事件改变后发布，服务器必须拒绝，返回 `STALE_SNAPSHOT`，不写入新计划。
- **S06 对抗错误方案**：将正确方案改造成重叠占机、错用无技能员工、缺料提前开工、独占工具重叠、工序逆序、班次跨越；独立 verifier 对每项准确报错。
- **S07 多租户**：租户 T1 查询/发布租户 T2 的任务或方案必须拒绝，不能泄漏任务存在与数据。
- **S08 能力协商**：WASM 不支持复杂场景时明确返回 `UNSUPPORTED_CONSTRAINT`，前端允许切换服务器后端；不得自行降级删约束。

指标（合同明确测试环境与数据生成种子后验收）：

- 正确性：以上功能断言通过率 100%；交叉验证输出所有资源和库存约束零违规；非法解检出率 100%。
- UI 响应：WASM 求解期间 UI 交互保持可用，无主线程同步长任务（采用浏览器 Performance 长任务采样和自动化 e2e 证明）。
- 可观测：每次求解必须包含建模耗时、首解时间（如有）、总耗时、峰值内存（WASM 若浏览器无法精确采集，明确 `unavailable`）、状态、解质量。
- 可终止：配置时间预算后任务可停止；服务端任务取消有状态回执，超时不得一直停留运行态。
- 性能基线：提供 24、240、2,400 工序的固定种子生成器并提交不同机器/运行时的实测报告；**不以未经测量的秒数强制验收**，后续在目标服务器与真实约束集上商定 p95/SLA。
- 不以浏览器端与 CP-SAT 求解出的完整排程字节完全一致为验收标准；同场景必须共用数据语义、独立验解结果、客观对比目标值。

## 8. 研发里程碑及交付门槛

- **M0 合同与样本门**：冻结 v1 字段语义、基准数据和不可行场景；提交 API schema、能力矩阵、建模数学说明；评审通过后开始实施。
- **M1 求解可信性门**：原生 CP-SAT 完成 H01–H08、目标策略、状态映射、可复现 CLI；Rust 独立 verifier 对 S01–S04/S06 验收通过。
- **M2 WASM 与 UX 门**：Rust native/wasm 共用基础算法；在 Web Worker 完成受支持子集的局部修复；React 可展示、修改、对比、取消；S08 通过。
- **M3 平台集成门**：Go API 与权限、快照、审批、发布、journal、错误回程、租户隔离接通；S05/S07 通过。
- **M4 交付门**：性能报告、基准包、容器部署、日志指标、操作手册、接口与 ADR 文档、全部自动化测试及 CI 验证通过。

## 9. 乙方必须交付的文件与知识产权

- React/TypeScript 源码；Rust native 和 WASM 可复现构建源码；OR-Tools Adapter 完整源码及依赖锁定；Go API/契约/迁移代码。
- PlanProblem、PlanSolution、SolverCapabilities 的 JSON Schema/OpenAPI；约束编译器设计和数学约束逐条单测；模型追溯关系设计。
- 所有 Mock、数据生成器、反向破坏数据和预期断言；自动化 E2E、跨引擎差异测试、性能基线脚本。
- 构建指令、Docker/本地启动方法、许可证清单、SBOM、升级和故障回退方法、演示录屏。
- 第三方依赖许可：Google OR-Tools 使用 Apache-2.0，按实际构建的所有依赖分别核查及履行许可证义务。

## 10. 关键风险与需要乙方明确报价的选项

- **A（建议合同基线）**：OR-Tools CP-SAT 原生求解 + Rust/WASM 局部算法。低于自研通用求解器的技术风险，最容易形成可靠平台能力。
- **B（可选 R&D）**：Rust 从零开发完整全局求解器，与原生 CP-SAT 对标，包括布尔/整数约束传播、搜索、剪枝、可选区间、资源约束、证明无解、最优界和取消；该研发难度显著高于排程启发式，不应混进 A 的固定交付价。
- **C（探索性，不作主线）**：尝试将原生通用求解器编译为 WASM；必须单列体积、启动时间、线程条件、内存以及许可证评审与跨浏览器测试，不能先承诺可行性。

## 11. 官方技术参考（以合同签订时锁定版本为准）

- Google OR-Tools 主仓库与许可证：https://github.com/google/or-tools
- CP-SAT 整数求解模型：https://developers.google.com/optimization/cp/cp_solver
- OR-Tools CP-SAT Go 建模包：https://github.com/google/or-tools/tree/stable/ortools/sat/go/cpmodel （需核查目标版本、原生依赖及其部署支持）
- 可选区间及资源调度建模：https://github.com/google/or-tools/blob/stable/ortools/sat/docs/scheduling.md
- Rust wasm-bindgen Worker 和线程限制：https://rustwasm.github.io/docs/wasm-bindgen/
