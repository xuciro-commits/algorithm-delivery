//! MAPF 契约的状态 / 错误 / 违规模型（`mapf-solution/1.0` 枚举的权威定义）。
//!
//! 状态语义（SRS §3“状态必须准确区分”，七态）：
//!
//! | 状态 | 含义 | 前置条件 |
//! |------|------|----------|
//! | `OPTIMAL` | 存在最优性证明（w=1 搜索穷尽，或 Makespan 探测证明） | 仅当证明成立 |
//! | `FEASIBLE` | 找到可行解但未证明最优（预算/上限耗尽或 w>1） | 全部路线通过独立核验 |
//! | `INFEASIBLE` | 在该时域内不存在任何无冲突方案（搜索树穷尽的证明） | 仅当证明成立 |
//! | `UNKNOWN` | 预算耗尽且没有可行解（**超时 ≠ 无解**） | —— |
//! | `INVALID_INPUT` | JSON/契约/语义非法（字段级定位） | —— |
//! | `UNSUPPORTED` | 请求超出声明能力（规模、特性），拒绝而非静默忽略 | —— |
//! | `CANCELLED` | 被宿主主动取消（在途可行解一并返回并标注） | —— |

use aps_engine::json::Json;

pub const SCHEMA_VERSION_PROBLEM: &str = "mapf-problem/1.0";
pub const SCHEMA_VERSION_SOLUTION: &str = "mapf-solution/1.0";
pub const SCHEMA_VERSION_VERIFY: &str = "mapf-verify/1.0";
pub const SCHEMA_VERSION_CAPABILITIES: &str = "mapf-capabilities/1.0";

/// 契约状态机。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Optimal,
    Feasible,
    Infeasible,
    Unknown,
    InvalidInput,
    Unsupported,
    Cancelled,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Optimal => "OPTIMAL",
            Status::Feasible => "FEASIBLE",
            Status::Infeasible => "INFEASIBLE",
            Status::Unknown => "UNKNOWN",
            Status::InvalidInput => "INVALID_INPUT",
            Status::Unsupported => "UNSUPPORTED",
            Status::Cancelled => "CANCELLED",
        }
    }

    /// WASM ABI 状态码（`mapf_solve` 返回值）；0 = ABI/参数错误。
    pub fn abi_code(self) -> i32 {
        match self {
            Status::Optimal => 1,
            Status::Feasible => 2,
            Status::Infeasible => 3,
            Status::Unknown => 4,
            Status::InvalidInput => 5,
            Status::Unsupported => 6,
            Status::Cancelled => 7,
        }
    }

    /// 该状态是否表示“存在可直接执行的方案”。
    pub fn has_plan(self) -> bool {
        matches!(self, Status::Optimal | Status::Feasible | Status::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
        }
    }
}

/// 建模/契约问题（字段级定位）。错误码登记见 `mapf/rust/docs/ERROR-CODES.md`。
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub code: String,
    pub severity: Severity,
    pub path: String,
    pub message: String,
}

impl Issue {
    pub fn error(code: &str, path: impl Into<String>, message: impl Into<String>) -> Issue {
        Issue {
            code: code.to_string(),
            severity: Severity::Error,
            path: path.into(),
            message: message.into(),
        }
    }
    pub fn warning(code: &str, path: impl Into<String>, message: impl Into<String>) -> Issue {
        Issue {
            code: code.to_string(),
            severity: Severity::Warning,
            path: path.into(),
            message: message.into(),
        }
    }
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("code", Json::str(self.code.clone())),
            ("severity", Json::str(self.severity.as_str())),
            ("path", Json::str(self.path.clone())),
            ("message", Json::str(self.message.clone())),
        ])
    }
}

/// 结构化错误码常量（输入契约层）。
pub mod codes {
    // —— JSON / 结构
    pub const BAD_JSON: &str = "E-MAPF-BAD-JSON";
    pub const SCHEMA: &str = "E-MAPF-SCHEMA";
    pub const UNKNOWN_FIELD: &str = "E-MAPF-UNKNOWN-FIELD";
    pub const MISSING_FIELD: &str = "E-MAPF-MISSING-FIELD";
    // —— 地图
    pub const MAP_SHAPE: &str = "E-MAP-MAP-SHAPE";
    pub const MAP_EMPTY: &str = "E-MAP-MAP-EMPTY";
    // —— 机器人
    pub const DUP_ROBOT_ID: &str = "E-ROBOT-DUP-ID";
    pub const DUP_START: &str = "E-ROBOT-DUP-START";
    pub const DUP_GOAL: &str = "E-ROBOT-DUP-GOAL";
    pub const START_BLOCKED: &str = "E-ROBOT-START-BLOCKED";
    pub const GOAL_BLOCKED: &str = "E-ROBOT-GOAL-BLOCKED";
    pub const COORD_RANGE: &str = "E-ROBOT-COORD-RANGE";
    pub const START_EQ_GOAL: &str = "E-ROBOT-START-EQ-GOAL";
    // —— 时间/目标
    pub const HORIZON: &str = "E-TIME-HORIZON";
    pub const OBJECTIVE: &str = "E-OBJ-KIND";
    // —— 能力
    pub const UNSUPPORTED_FEATURE: &str = "E-CAP-UNSUPPORTED-FEATURE";
    pub const LIMIT_AGENTS: &str = "E-CAP-LIMIT-AGENTS";
    pub const LIMIT_MAP: &str = "E-CAP-LIMIT-MAP";
    pub const LIMIT_HORIZON: &str = "E-CAP-LIMIT-HORIZON";
    pub const LIMIT_BUDGET: &str = "E-CAP-LIMIT-BUDGET";
    // —— 基准
    pub const BENCH_MAP_MISMATCH: &str = "E-BENCH-MAP-MISMATCH";
    pub const BENCH_HASH_MISMATCH: &str = "E-BENCH-HASH-MISMATCH";
    // —— 动态快照 / 事件
    pub const SNAP_SHAPE: &str = "E-SNAP-SHAPE";
    pub const SNAP_TIME: &str = "E-SNAP-TIME";
    pub const SNAP_PATH_MISMATCH: &str = "E-SNAP-PATH-MISMATCH";
    pub const SNAP_FROZEN_CONFLICT: &str = "E-SNAP-FROZEN-CONFLICT";
    pub const SNAP_FROZEN_ILLEGAL: &str = "E-SNAP-FROZEN-ILLEGAL";
    pub const EVENT_KIND: &str = "E-EVENT-KIND";
    pub const EVENT_TARGET: &str = "E-EVENT-TARGET";
    pub const EVENT_TIME: &str = "E-EVENT-TIME";
    // —— 求解输出（核验）
    pub const CONFLICT_VERTEX: &str = "E-CONFLICT-VERTEX";
    pub const CONFLICT_EDGE: &str = "E-CONFLICT-EDGE";
    pub const MOVE_ILLEGAL: &str = "E-MOVE-ILLEGAL";
    pub const WALL_ENTRY: &str = "E-WALL-ENTRY";
    pub const GOAL_UNREACHED: &str = "E-GOAL-UNREACHED";
    pub const GOAL_OCCUPY: &str = "E-GOAL-OCCUPY";
    pub const OBJ_SOC: &str = "E-OBJ-SOC";
    pub const OBJ_MAKESPAN: &str = "E-OBJ-MAKESPAN";
    pub const FROZEN_BROKEN: &str = "E-FREEZE-BROKEN";
    pub const PROOF_INVALID: &str = "E-PROOF-INVALID";
    pub const HASH_MISMATCH: &str = "E-HASH-MISMATCH";
    pub const INTERNAL: &str = "E-INTERNAL";
}
