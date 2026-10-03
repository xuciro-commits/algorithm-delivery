# MAPF 多机器人路径规划引擎 — 软件需求说明书（SRS v1.0，交付对照版）

技术栈锁定：Rust（零第三方依赖 crate）→ native CLI `mapf` 与 `wasm32-unknown-unknown`
模块；浏览器 React 实验室（Web Worker 内计算）；契约 JSON Schema 2020-12。
本文件为交付验收口径：§9 追溯矩阵把每条需求钉到实现与可执行证据。

## 0. 架构决策与边界

1. **单一实现源**：native 与 wasm 同 crate 同源码，仅以 `--target` 区分产物；行为一致性由
   冒烟测试（Node 直接加载 wasm 产物跑真实求解）保证。
2. **求解与核验分离**：verifier 不复用求解器的冲突判断；引擎输出的可信度由独立复算定义。
3. **浏览器只承担交互式计算**：同步求解占用 Worker，取消=终止+重建；不引入
   SharedArrayBuffer/多线程（免 COOP/COEP 部署负担）。
4. **一切皆契约**：输入白名单校验（未知字段拒绝）、输出与错误路径共用同一 schema、
   能力档位显式声明；不做静默近似。

## 1. 目标、非目标与交付阶段

### P0（合同必验，本册全部已交付）
- 离散栅格 MAPF：顶点/边交换/目标占用三类冲突；SOC 与 Makespan 双目标；
- 有质量承诺的搜索：ECBS `w∈[1,3]` 有界次优 + 界证明语义（何时允许说 OPTIMAL 有形式规则）；
- 独立核验器 + 求解输出内嵌核验 + `mapf verify` 离线复核；
- 动态事件重规划：快照冻结前缀锁定、目标变更、时空障碍事件；保证 t≤快照时刻不撕裂；
- 浏览器 WASM 档位 + 实验室接入（数据选择/参数/时空回放/核验面板）；
- Moving AI 公开基准可复现运行 + 硬件/预算/成功率/未解决场景全披露；
- CI 质量门（fmt/clippy -D warnings/test/acceptance --json/契约/基准硬门/wasm 冒烟/取消回归）。

### P1（明确未实现，不得假装）
- 异质速度、动作时长、加权边、路径平滑与运动学可行性、任务分配耦合、多目标 Pareto。

### 明确排除
- 常驻服务/并发队列（CLI/库/浏览器均为进程内计算）；真实车队接入（数据全部 Mock）。

## 2. 领域输入（MapfProblem v1，摘要）

`{schema_version, id, map{width,height,cells}, robots[{id,start,goal}],
objective{kind}, time_model{horizon:int|"auto"}, solver{time_limit_ms,suboptimality_factor,seed,planner},
dynamic?{snapshot,events}, benchmark?, tags?}` — 完整约束以
`mapf/contracts/mapf-problem.schema.json` 为准（生成器：`make_schemas.py`；字段与
`src/problem.rs` 白名单同源）。坐标 `[x,y]`、行主序 cells、`#|T|S` 为障碍。

## 3. 数学问题定义

规范文本：`mapf/rust/docs/MODEL-MATH.md`（§1–§9：实例、冲突、目标占用与 goal-parking、
目标函数、算法族、证明语义、动态快照、确定性指纹、复杂度）。每条“允许宣告什么”的
规则同时实现于 `verify.rs` 并有回归测试（`E-PROOF-INVALID` 族）。

## 4. 求解与验证职责

- 引擎：解析→编译（能力/限额/事件）→PP 首解→ECBS 精化→自动核验→契约化输出；
- 集成方：下发前 `mapf verify --strict`（problem_hash 绑定）复核过期方案；
- 基准：以 `verification_failures = 0` 为硬门（CI 断言），非“尽量通过”。

## 5. 实验室（React 模块 `path-planning`）

- 数据集卡片来自 `mapf-manifest.json`（含每个 mock 的期望结论，源自 `tags.expect`）；
- 参数：目标 / 预算 / w / 规划器 / 种子（能力档位限额展示）；
- 可视化：栅格 + 计划轨迹淡线 + 逐步时空回放（起终点标记、锁定车虚线环）；
- 取消即时、Worker 自动重建、无引擎时不渲染假数据（tsc 零错误 + 渲染冒烟断言）；
- 指纹/复核使用引擎 `raw` 原文。

## 6. API / 返回合同

见 `mapf/contracts/` 五份 schema + `docs/USAGE.md`（CLI 面）+ `docs/INTEGRATION.md`
（Rust/JS API）。状态枚举与错误码全集：`docs/ERROR-CODES.md`。

## 7. Mock 场景与验收（M01–M12，14 案例）

| 案例 | 场景 | 必须成立 |
|---|---|---|
| M01 | 单车 5×5 | OPTIMAL，SOC=Makespan=6 |
| M02 | 交叉走廊 | 无顶点冲突，双方错峰 |
| M03 | 正面交换（1×6 走廊） | INFEASIBLE（显式 H 下证明） |
| M04 | 窄走廊对开 | 有序让路，交换冲突=0 |
| M05 | 4 车环路等待 | OPTIMAL 且含 wait 步 |
| M06 | 目标被占 | 等待或改道，绝不入他人 goal |
| M07 | 非法输入（重号/越界/起终同格） | INVALID_INPUT + 逐条 code/path |
| M07b | 能力外特性 | UNSUPPORTED（E-CAP-UNSUPPORTED-FEATURE） |
| M08a | 隔离目标 | INFEASIBLE 证明（声明 H） |
| M08b | 100 ms 紧预算 | UNKNOWN（不许硬撑出错解） |
| M09 | 24 车拥挤瓶颈 | 全解 + 自检通过（曾暴露 PP 预留缺陷） |
| M10 | 动态快照+4 事件 | 前缀零偏离 + dynamic 统计精确匹配 |
| M11 | 篡改方案 | verifier 检出 E-WALL-ENTRY/E-CONFLICT-VERTEX/E-OBJ-SOC |
| M12 | 取消后重投 | 同输入同指纹，恢复后结果一致 |

执行：`mapf acceptance`（人读）与 `mapf acceptance --json`（机器读，CI 门禁）。

## 8. 交付物清单

`mock/` 14 文件 · `contracts/` 5 schema + 生成器 · `rust/src` 15 模块 + `web/` 胶水 ·
`rust/scripts`（build_wasm / smoke / cancel 回归 / check_contracts）· `rust/docs` 7 篇 ·
`bench/`（UPSTREAM 许可 + gen_manifest + 数据 + 全量原始结果）· `tests/acceptance.rs` ·
`lab/` 模块 + sync 链 + Pages 双引擎校验 · CI 3 个 workflow（mapf-quality / mapf-rust /
lab/release 接线）。

## 9. 需求追溯矩阵

| R | 需求 | 实现 | 证据（可执行） |
|---|---|---|---|
| R-01 | 输入契约与白名单拒绝 | `problem.rs` + schema | `check_contracts.py` [2][7]；`problem.rs` 单测（DUP/坐标独立注册） |
| R-02 | 三类冲突 + 目标占用语义 | `verify.rs`, `planner.rs`, `ecbs.rs` | M02–M06 验收；`find_conflict` 编码单测；M11 篡改必拒 |
| R-03 | 双目标（SOC/Makespan）与最优率差异如实呈现 | `engine.rs`, `ecbs.rs::aggregate_cost` | BENCHMARKS 表“预算×目标”；acceptance 各案例双值断言 |
| R-04 | 界证明语义（w>1 追平才算 OPTIMAL） | `ecbs.rs` UB-stop + `verify.rs` E-PROOF-INVALID | `engine.rs` 单测；verify 规则与 MODEL-MATH §6 对齐（本 PR 修复过误杀） |
| R-05 | FEASIBLE 必附下界与差距 ≤ w | `engine.rs::build_solution` | `check_contracts.py` [3]；基准 FEASIBLE gap≤1.24<1.5 |
| R-06 | INFEASIBLE 仅声明 H 下可证 | `ecbs.rs` Finish 语义 + auto-H 降级 notes | M03/M08a；`engine.rs` 单测（auto-H 不宣告） |
| R-07 | 确定性（输入+版本+种子+预算 ⇒ 同语义指纹） | 全链路 tie-break + 指纹 | wasm 冒烟“两次求解语义一致”；M12；指纹排除运行期块（单测） |
| R-08 | 动态快照冻结不撕裂 + 事件 | `dynamic.rs` | M10（动态统计逐项相等）；`dynamic.rs` parked/窗口单测 |
| R-09 | 独立核验与降级保护 | `verify.rs` + `engine.rs` 自检 | 基准 `verification_failures=0` 硬门；UNKNOWN 降级路径 |
| R-10 | 错误路径同契约（INVALID/UNSUPPORTED 输出可机读） | `errors.rs`, `engine.rs::error_outcome` | `check_contracts.py` [4] |
| R-11 | 能力档位声明与限额拒绝 | `capabilities.rs` | caps schema [5]；`E-CAP-LIMIT-*` 用例（M07b/单测） |
| R-12 | Moving AI 基准可复现 + 全披露 | `bench.rs`, `movingai.rs`, `bench/` | `mapf bench` 全量；`results/bench-2026-10-03.json`；BENCHMARKS.md（含 17 UNKNOWN 归因） |
| R-13 | 浏览器 wasm-light 可用（含取消） | `wasm_api.rs`, `web/mapf-worker.js` | `build_wasm.sh` 内嵌 smoke；`test_worker_cancel.mjs` 10/10 |
| R-14 | 实验室双引擎装配与 Pages 真实性 | `lab/src/{core,modules}/mapf`, sync/check-dist/check-pages | `npm run test:dist/test:pages`（页面字节实例化 MAPF 并解 m01 OPTIMAL） |
| R-15 | 构建免手工准备（clean checkout） | `package.json` sync 链 + workflow 产物 | `bash lab/scripts/build-all.sh` 全链；lab.yml 依赖 mapf-quality 产物 |
| R-16 | 质量门不退化（APS 不受影响） | lab.yml 双 needs；APS 路径零改动逻辑 | CI：aps-quality 与 mapf-quality 并行全绿；lab 测试套件含 APS 断言 |

## 10. 性能与基准口径

见 `mapf/rust/docs/BENCHMARKS.md`（硬件、预算矩阵、成功率、未解决场景、Top 耗时、
UNKNOWN 归因；原始结果入库）。承诺：解出率与核验结论可复现；耗时随机器缩放。

## 11. 风险与边界（乙方声明）

- 开放空间高密度（empty-8-8@32、empty-16-16@128）在小预算内不保证可行解——以
  UNKNOWN + 下界如实回报；改进方向（residual 复用/PIBT 兜底）已列入基准文档；
- 指纹跨大版本不承诺相等（语义变化必须可见）；
- 全部数据 Mock；真实场地接入需另行标定地图与代价语义。

## 12. 参考与许可

- Stern et al., *Multi-Agent Pathfinding: Definitions, Variants, and Benchmarks*, SoCS 2019；
- Moving AI 基准数据：Open Data Commons Attribution License（`bench/UPSTREAM.md`）；
- 引擎代码许可与 `aps/` 交付包一致（同仓库条款）。
