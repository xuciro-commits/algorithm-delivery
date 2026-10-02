//! # APS 规划引擎（Rust 独立算法核心）
//!
//! 本 crate 是 APS-SRS v1.0 中“Rust 统一模型校验 / 候选方案核验 / 局部排程”的交付实现，
//! 同一份源码同时构建为：
//!
//! * **native 可执行程序** `aps`（CLI，见 `docs/USAGE.md`）；
//! * **wasm32-unknown-unknown 模块**（浏览器 Web Worker，见 `web/` 与 `src/wasm_api.rs`）。
//!
//! 三条与求解器解耦的职责：
//!
//! 1. `validate` / `compile`：`PlanProblem v1` 契约与语义校验，输出字段级定位的 `MODEL_INVALID`；
//! 2. `solver`：构造式排程启发式 + 局部修复（多起点、可复现、带时间预算与取消）；
//! 3. `verify`：**独立方案校验器**，不重用求解器内部的约束判断路径，逐条核验 H01–H08。
//!
//! ## 能力边界（必须诚实声明，见 `capabilities`）
//!
//! * `can_prove_optimal = false`：启发式不证明最优；
//! * `can_prove_infeasible = true`（native）：仅针对可构造证明的无解类型
//!   （资格死角 / 单工序在任何窗口都放不下 / 物料总供给不足），其余情况返回
//!   `NO_SOLUTION_FOUND` 或 `UNKNOWN`，绝不伪称 `INFEASIBLE`；
//! * WASM 轻量档 `can_prove_infeasible = false`，且超出规模上限时返回 `UNSUPPORTED_CONSTRAINT`。
//!
//! ## 最小用法
//!
//! ```no_run
//! use aps_engine::{engine, json};
//! let text = std::fs::read_to_string("mock/baseline.json").unwrap();
//! let problem = json::parse(&text).unwrap();
//! let opts = engine::SolveOptions::from_objective(problem.get("objective"));
//! let cancel = engine::CancelToken::new();
//! let outcome = engine::solve_json(&text, &opts, &cancel);
//! println!("{}", outcome.solution_json);
//! ```

pub mod acceptance;
pub mod alloc;
pub mod benchgen;
pub mod calendar;
pub mod capabilities;
pub mod clock;
pub mod compare;
pub mod compile;
pub mod datetime;
pub mod engine;
pub mod errors;
pub mod explain;
pub mod hash;
pub mod json;
pub mod ledger;
pub mod model;
pub mod objective;
pub mod schedule;
pub mod solver;
pub mod validate;
pub mod verify;

#[cfg(target_arch = "wasm32")]
pub mod wasm_api;

/// 引擎标识（写入 `PlanSolution.engine` 字段，便于审计）。
pub const ENGINE_NAME: &str = "rust-heuristic";
/// 引擎版本（写入 `PlanSolution.engine_version`）。
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
/// 编译层版本（写入 `PlanSolution.compiler_version`；契约要求记录以便追溯）。
pub const COMPILER_VERSION: &str = "plan-compiler-rust-1.0";

/// 峰值内存统计用全局分配器（契约要求“统计…峰值内存”，WASM 侧同样生效）。
///
/// 说明：本 crate 以**可执行交付件**形态交付（native CLI + wasm 模块），因此在此注册全局
/// 分配器。若下游把它作为普通 rlib 嵌入并自带全局分配器，请移除本属性（见 docs/USAGE.md）。
#[global_allocator]
static APS_ALLOC: crate::alloc::DefaultTrackingAllocator =
    crate::alloc::TrackingAllocator::new(std::alloc::System);
