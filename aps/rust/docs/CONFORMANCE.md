# SRS 需求 → 实现/测试 对照（CONFORMANCE）

> 需求基线：`aps/APS-SRS.md` v1.0；契约：`aps/contracts/*.schema.json`。
> 本表用于验收时逐条定位证据；"证据"列中的命令均可直接运行。

## A. 引擎分离与状态协议（SRS §4）

| 需求 | 实现 | 证据 |
|------|------|------|
| 编译 / 求解 / 校验三者分离，校验器**不得复用**求解器的约束判断路径 | `src/compile.rs`、`src/solver/*`、`src/verify.rs`（`verify.rs` 不 import `solver`，物料账本另有 `src/ledger.rs` 独立实现） | `grep -n "solver" src/verify.rs`（无）；`src/verify.rs` 顶部注释 |
| 声明 SolverCapabilities，超范围必须显式拒绝 | `src/capabilities.rs`（native / wasm-light 两档）；`SCALE_EXCEEDED` 等结构化 issue | `aps capabilities --json`；`cargo test --test engine_integration wasm_light_refuses_scale` |
| `UNSUPPORTED_CONSTRAINT` 而非静默丢弃约束 | `src/engine.rs` 状态映射；`worker_count>1` → `MODEL_INVALID` | `aps accept` S08 |
| 状态枚举与语义（OPTIMAL/FEASIBLE/INFEASIBLE/UNKNOWN/MODEL_INVALID/NO_SOLUTION_FOUND/UNSUPPORTED_CONSTRAINT/CANCELLED） | `src/errors.rs::Status` + `src/engine.rs`；`INFEASIBLE` 必须带 `Certificate`，`OPTIMAL` 必须 `optimality_proven=true` | `docs/USAGE.md` §3.3；`src/engine.rs` 单元测试 |
| 不伪造 OPTIMAL / INFEASIBLE | 最优性判据 `solver::is_proven_optimal`；无解证书由编译期构造 | `cargo test --lib objective`；S04/S06 |
| 方案自检失败必须拒收 | 自检/独立复核不通过 → `status=UNKNOWN`、`verified=false` | `src/engine.rs`（§7–8 注释段落） |

## B. 约束 H01–H08（SRS §3）

| 约束 | 语义 | 实现（编译期静态检查 / 求解期 / 核验期） | 变异检出用例（S06） |
|------|------|------|------|
| H01 | 时长取所选备选；时间合法 | `compile.rs` / `objective.rs` | `H01_TIME_ORDER`、`H01_DURATION_MISMATCH` |
| H02 | 前驱先后、投放时间 | `dispatch.rs`（`op_ready`） | `H02_PRECEDENCE`、`H02_RELEASE` |
| H03 | 备选机器能力、同机不重叠 | `schedule.rs`（`placement_ok`/`overlap_violation`） | `H03_MACHINE_CAPABILITY`、`H03_MACHINE_OVERLAP` |
| H04 | 完整落入某个可用窗口（不可抢占、避 `blocked`） | `calendar.rs` | `H04_MACHINE_CALENDAR`、`H04_MACHINE_BLOCKED` |
| H05 | 技能+资格、人员不重叠 | `compile.rs`（`worker_eligible`） | `H05_WORKER_SKILL`、`H05_WORKER_OVERLAP` |
| H06 | 工装全区间独占、不得漏分配 | `schedule.rs`（`tool_busy`） | `H06_TOOL_ASSIGNMENT`、`H06_TOOL_OVERLAP` |
| H07 | 物料账本事件序非负（同刻先入库） | `ledger.rs` + `schedule.rs`（`ledger_violation`） | `H07_STOCK_NEGATIVE` |
| H08 | 全部工序落在时域内、不得缺漏 | `compile.rs` / `verify.rs` | `H08_OUT_OF_HORIZON`、`MISSING_OPERATION` |

补充契约级变异：`DUPLICATE_OPERATION`、`UNKNOWN_OPERATION`、`SNAPSHOT_MISMATCH`、`TENANT_MISMATCH`。

## C. 场景验收 S01–S08（SRS §7）

最近一次运行（2026-10-02，rustc 1.88.0，native）：`cd aps && aps accept` → **8 通过 / 0 失败**。

| 用例 | 判据 | 结果 | 证据位置 |
|------|------|------|----------|
| S01 基础车间 | FEASIBLE + 24 工序 + 独立校验 0 违约 | ✓ | `src/acceptance.rs` `s01` |
| S02 设备故障 | 不进入 `WELD-02` 停机区间；给出变更工序数 | ✓ | `s02` |
| S03 到货延迟 | 事件序账本非负 | ✓ | `s03` + `src/ledger.rs` |
| S04 证明无解 | native `INFEASIBLE` + `NO_ELIGIBLE_WORKER` + `operations=[]`；wasm-light 不伪称 | ✓ | `s04` |
| S05 失效快照 | 旧快照 → `SNAPSHOT_MISMATCH`（权威拒绝在 Go 层） | ✓ | `s05` |
| S06 对抗错误方案 | 18 组变异逐一检出（H01–H08 + 契约级，含 `ORDER_ID_MISMATCH`） | ✓ | `s06` + `mutations()` |
| S07 多租户 | 租户 A 方案 vs 租户 B 问题 → `TENANT_MISMATCH` | ✓ | `s07` |
| S08 能力协商 | 2400 工序 → `UNSUPPORTED_CONSTRAINT`/`SCALE_EXCEEDED`；`worker_count=2` → `MODEL_INVALID` | ✓ | `s08` |

基准规模与种子：`24 / 240 / 2400` × `42 / 73 / 2026`，实测见 `docs/BENCHMARKS.md`。

## D. 本期交付清单（SRS §9）

| 交付项 | 位置 | 状态 |
|--------|------|------|
| Rust 原生算法核心（编译/求解/校验/对比/解释） | `aps/rust/src/` | ✅ 零第三方依赖，57 个单元测试 + 11 个集成测试 |
| WASM 可复现构建（浏览器可用） | `src/wasm_api.rs`、`scripts/build_wasm.sh`、`web/aps-worker.js`、`scripts/smoke_wasm.mjs` | ✅ 577 KiB 产物，Node 冒烟通过（24 工序零违约） |
| 约束编译器单元测试（含负例） | `src/compile.rs`、`src/validate.rs`、`src/verify.rs` 内 `#[cfg(test)]` | ✅ |
| 负例/变异数据 | `src/acceptance.rs::mutations()`（17 例）+ `aps/tests/verify_mock.py`（7 例交叉验证） | ✅ |
| 基准生成与脚本 | `src/benchgen.rs`（与 Python 生成器逐字节一致）、`scripts/run_benchmarks.sh` | ✅ |
| 构建/运行说明与文档 | `README.md`、`docs/USAGE.md`、`docs/MODEL-MATH.md`、`docs/INTEGRATION.md`、`docs/BENCHMARKS.md`、本文；`toolchain/setup_rust.sh` | ✅ |
| 约束编译器设计与数学约束逐条对照 | `docs/MODEL-MATH.md`（编译流水线 + H01–H08 数学↔代码↔测试 + 追溯设计） | ✅ |
| 契约符合性（PlanProblem/PlanSolution/SolverCapabilities） | `scripts/check_contracts.py`（零依赖 JSON Schema 子集校验，30 项） | ✅ 30/30 |
| 依赖清单 / 许可证 / SBOM | `docs/DEPENDENCIES.md`（零第三方 crate；`cargo tree` 仅本 crate） | ✅ |
| 容器与部署 / 升级回退 | `docs/DEPENDENCIES.md` §5–6（Dockerfile 片段、升级/回退流程） | ✅ |
| CI 自动化（SRS §8 M4） | `.github/workflows/aps-rust.yml`（依赖审计→测试→S01–S08→契约→WASM 冒烟→产物） | ✅ |
| 可终止性（时间预算 + 取消回执） | 集成测试 `cancellation_returns_promptly_with_incumbent_and_warning`；CLI `--cancel-after-ms` | ✅ |
| 可复现 CLI（`--json` 契约输出、退出码语义） | `src/main.rs`（validate/solve/verify/compare/explain/benchmark/bench/accept/capabilities） | ✅ |

## E. 明确不在本 crate 范围（SRS §0/§5/§6/§10）

| 项 | 归属 |
|----|------|
| React 工作台 / 甘特图 / 交互式调整 | 前端团队 |
| Go 平台 API、任务状态机、租户鉴权、快照生命周期与 `STALE_SNAPSHOT` 权威拒绝、RBAC | 平台团队 |
| OR-Tools CP-SAT 全局求解基线（作为质量对照/回退） | 本交付包未包含；`aps/README.md` 建议先取得可信基线 |
| 全局限界最优证明 | 本引擎用启发式 + 诚实弱下界；只有达到下界时才宣称 OPTIMAL |
