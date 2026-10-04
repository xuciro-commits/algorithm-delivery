//! # Warehouse Optimization Suite（Rust 独立算法核心）
//!
//! `warehouse/WAREHOUSE-SRS.md`（需求规格）的交付实现。同一份源码同时构建为：
//!
//! * **native 可执行程序** `warehouse`（CLI：solve / verify / scenarios / generate /
//!   acceptance / bench / capabilities / version，见 `docs/USAGE.md`）；
//! * **wasm32-unknown-unknown 模块**（浏览器 Web Worker，见 `web/` 与 `src/wasm_api.rs`）。
//!
//! ## 两个算法域 + 一个联合域
//!
//! | 模块 | 内容 |
//! |------|------|
//! | [`slotting`] | 库位优化：基础对照策略（§3.1）+ ALNS/LNS/禁忌/SA（§3.2A/B）+ NSGA-II 与鲁棒优化（§3.2C/D）+ 动态库位调整 |
//! | [`asrs`] | 密集立库联合调度：任务分配/排序/无冲突路径/交接/缓存/多深位/动态事件与重调度（§4） |
//! | [`joint`] | 库位 × 调度联合优化：用真实设备仿真评价库位方案，并记录反馈回路（§5） |
//!
//! ## 三条不变式（与需求强绑定，代码里可以逐条指认）
//!
//! 1. **库位由拓扑推导**：`racks × levels × bays × depths`，不接受"任意给定一个库位数"（§8）。
//!    见 [`wh::topology`]。
//! 2. **成本来自设备物理模型**：距离是巷道轨道距离 + 横巷 + 层间提升，时间是梯形速度曲线；
//!    不允许用欧氏距离近似设备运行成本（§1.3 / §4.4）。见 [`wh::routing`]。
//! 3. **验证器独立**：验证器只吃契约 JSON，自行重演约束并**重新计算**主要指标，
//!    与解上报的数字逐项比对（§6.4）。见 [`verify`]。
//!
//! ## 状态语义（§6.2，绝不合并）
//!
//! `OPTIMAL_PROVEN`（仅精确求解可声明）/ `FEASIBLE_WITH_BOUND` / `FEASIBLE` /
//! `BUDGET_EXCEEDED`（预算耗尽**且无有效解**）/ `NO_SOLUTION_FOUND` /
//! `INFEASIBLE_PROVEN`（只有给出证明才允许）/ `CANCELLED` / `INVALID_INPUT` /
//! `INTERNAL_ERROR`，以及"超时但已有有效解"的显式标记 `budget_exceeded`。
//!
//! ## 最小用法
//!
//! ```no_run
//! use warehouse_engine::engine;
//!
//! // 问题文档由 `warehouse generate --scenario S01 --scale small --out ...` 生成，
//! // 或直接用仓库里的 `warehouse/mock/slotting-small.json`。
//! let text = std::fs::read_to_string("../mock/slotting-small.json").unwrap();
//! // 第二个参数是求解选项（JSON 文本）：None = 用默认值（默认内嵌独立核验）。
//! let (solution_json, status) = engine::solve_slotting(&text, None);
//! assert!(status.has_solution(), "求解未产出可用方案：{}", status.as_str());
//! println!("{}（{} 字符）", status.as_str(), solution_json.len());
//! ```

pub mod acceptance;
pub mod asrs;
pub mod bench;
pub mod capabilities;
pub mod contract;
pub mod engine;
pub mod errors;
pub mod joint;
pub mod scenario;
pub mod slotting;
pub mod util;
pub mod verify;
pub mod wasm_api;
pub mod wh;

/// 引擎标识（写入解的 `engine` 字段）。
pub const ENGINE_NAME: &str = "rust-warehouse";
/// 引擎版本（写入解的 `engine_version`）。
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
/// 契约编译层版本（解析/校验语义变更时升级）。
pub const COMPILER_VERSION: &str = "warehouse-compiler-rust-1.0";
/// 仓储规则版本（约束语义版本，验证器与之绑定）。
pub const RULESET_VERSION: &str = "warehouse-rules/1.0";

// 峰值内存统计复用 `aps_engine::alloc`（该 crate 已在依赖图中注册跟踪分配器；
// 本 crate 不重复注册全局分配器 —— 一个最终产物只能有一个 `#[global_allocator]`，
// 这也正是 agv / mapf 两个引擎复用 aps 基础设施的方式）。
