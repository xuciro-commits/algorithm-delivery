//! # MAPF 多机器人路径规划引擎（Rust 独立算法核心）
//!
//! 本 crate 是 `mapf/MAPF-SRS.md`（Algorithm Delivery 第二阶段）的交付实现：
//! 在二维离散栅格地图上为多台 AGV 规划**无顶点冲突、无对向边交换冲突**的
//! 同步离散时间路径，支持 stay-at-target 语义、SOC / Makespan 双目标、
//! 动态障碍 / 目标变更 / 冻结前缀重规划。同一份源码同时构建为：
//!
//! * **native 可执行程序** `mapf`（CLI，见 `docs/USAGE.md`）；
//! * **wasm32-unknown-unknown 模块**（浏览器 Web Worker，见 `web/` 与 `src/wasm_api.rs`）。
//!
//! 三条与求解器解耦的职责（对应 SRS §3/§4 的“求解器与独立验证器”）：
//!
//! 1. `problem`：`mapf-problem/1.0` 契约与语义校验，字段级定位的 `INVALID_INPUT`；
//! 2. `ecbs` + `planner`：**联合规划**——高层 ECBS/CBS 冲突分支树 + 底层时空 A*，
//!    Prioritized Planning 快速首解；SOC 与 Makespan 两个目标分别聚合、分别证明；
//! 3. `verify`：**独立轨迹核验器**（`verify.rs`），直接以 JSON 文本为输入、自行
//!    重解析地图并推导占用，不复用 `planner/ecbs` 的任何冲突判断代码路径。
//!
//! 诚实性约定（SRS §4/§13 阻断性缺陷清单的反例控制）：
//!
//! * `OPTIMAL` / `INFEASIBLE` 只在搜索**穷尽并给出证明**时返回；
//! * 预算耗尽一律 `UNKNOWN`（若有可行解则 `FEASIBLE` + 报告差距界），绝不伪称；
//! * 引擎自检发现自家输出被核验器拒绝时降级为 `UNKNOWN + verified=false`；
//! * 暂不支持的能力（对角移动、动作时长、任务分配…）返回 `UNSUPPORTED` 而非静默忽略。

pub mod acceptance;
pub mod bench;
pub mod capabilities;
pub mod dynamic;
pub mod ecbs;
pub mod engine;
pub mod errors;
pub mod movingai;
pub mod planner;
pub mod problem;
pub mod verify;

// WASM ABI 层：只做“指针/缓冲区 ↔ 引擎 JSON API”的薄封装，native 也一起编译，
// 因此同一份导出代码可被 `cargo test` 直接单测（与 aps/rust 的做法一致）。
pub mod wasm_api;

/// 引擎标识（写入 `MapfSolution.engine` 字段，便于审计）。
pub const ENGINE_NAME: &str = "rust-ecbs-cbs";
/// 引擎版本（写入 `MapfSolution.engine_version`）。
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
/// 契约编译层版本（问题解析/校验的语义版本；冻结前缀/事件语义变更时必须升级）。
pub const COMPILER_VERSION: &str = "mapf-compiler-rust-1.0";
/// 冲突语义版本（vertex/edge-swap/stay-at-target 规则的语义编号，验证器与之绑定）。
pub const RULESET_VERSION: &str = "mapf-rules/1.0";
