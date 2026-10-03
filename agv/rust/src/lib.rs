//! # AGV Dispatch 多车任务分配与调度引擎（Rust 独立算法核心）
//!
//! `agv/AGV-SRS.md`（M2 数学模型）的实现。核心问题：**在有限车辆、共享地图与
//! 不断变化的运输任务条件下，决定任务由谁执行、按什么顺序执行、何时执行，并经
//! MAPF 引擎生成全局无冲突的时空时间线。**
//!
//! 三层决策（AGV-SRS §1）：
//!
//! 1. `problem`：`agv-dispatch-problem/1.0` 契约解析与语义校验（车辆/任务/工作站/
//!    停车/动态快照），字段级定位的 `INVALID_INPUT`；
//! 2. `assign`：分配 + 排序——确定性基线 `baseline` 与正式算法 `insertion-ls`
//!    （遗憾值贪心插入 + 确定性局部搜索），代价由 `estimate` 的时间线模拟估计器给出；
//! 3. `integrate`：实现层——分段联合 MAPF 规划（stage loop，每次求解包含**全部**
//!    需移动车辆）+ 时间线拼接 + 泊位/容量仲裁；
//!
//! 两条独立保证：
//!
//! * `verify`：**独立调度验证器**——以 JSON 文本为输入、自行重演全部约束与指标，
//!   不复用调度器/实现层的任何判断代码路径（总 SRS §19）；
//! * `engine`：状态语义严格——`FEASIBLE / PARTIAL / UNKNOWN / INFEASIBLE /
//!   INVALID_INPUT / UNSUPPORTED / CANCELLED` 区分规划失败、预算耗尽与确不可行，
//!   永不伪称 OPTIMAL（启发式调度器，SRS §19 口径）。
//!
//! 与 MAPF 的关系（AGV-SRS §4/§5）：仅通过 `mapf_engine::engine::solve_json`
//! （契约级公共 API）调用，段请求为 `mapf-problem/1.0` 形状；MAPF 验证通过
//! **不等于** AGV 验证通过，两层分别报告。

pub mod acceptance;
pub mod assign;
pub mod bench;
pub mod capabilities;
pub mod dynamic;
pub mod engine;
pub mod errors;
pub mod estimate;
pub mod integrate;
pub mod metrics;
pub mod problem;
pub mod verify;
pub mod wasm_api;

/// 引擎标识（写入 `AgvDispatchSolution.engine`）。
pub const ENGINE_NAME: &str = "rust-agv-dispatch";
/// 引擎版本。
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
/// 契约编译层版本（解析/校验语义变更时升级）。
pub const COMPILER_VERSION: &str = "agv-compiler-rust-1.0";
/// 调度约束语义版本（分配/容量/时间线规则，验证器与之绑定）。
pub const RULESET_VERSION: &str = "agv-rules/1.0";
