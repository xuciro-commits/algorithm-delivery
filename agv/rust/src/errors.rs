//! 状态码与错误码（与 `agv/contracts` 枚举、`docs/ERROR-CODES.md` 一一对应）。

use aps_engine::json::Json;

/// 求解结局状态（`AgvDispatchSolution.status`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// 全部任务完成且通过独立调度验证。
    Feasible,
    /// 部分任务完成（逐任务给出失败原因），已完成部分通过验证。
    Partial,
    /// 预算/时间耗尽且没有任何已验证的完成任务。
    Unknown,
    /// 结构性证明不可行（如任务取货点对全部有能力车辆不可达）。
    Infeasible,
    /// 输入违反契约。
    InvalidInput,
    /// 请求了能力外特性。
    Unsupported,
    /// 宿主取消。
    Cancelled,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Feasible => "FEASIBLE",
            Status::Partial => "PARTIAL",
            Status::Unknown => "UNKNOWN",
            Status::Infeasible => "INFEASIBLE",
            Status::InvalidInput => "INVALID_INPUT",
            Status::Unsupported => "UNSUPPORTED",
            Status::Cancelled => "CANCELLED",
        }
    }
    /// wasm ABI 状态码（与 mapf-worker 同风格）。
    pub fn code(self) -> i32 {
        match self {
            Status::Feasible => 1,
            Status::Partial => 2,
            Status::Unknown => 3,
            Status::Infeasible => 4,
            Status::InvalidInput => 5,
            Status::Unsupported => 6,
            Status::Cancelled => 7,
        }
    }
}

/// 结构化问题（字段级定位）。
#[derive(Debug, Clone)]
pub struct Issue {
    pub code: &'static str,
    pub severity: Severity,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

impl Issue {
    pub fn error(code: &'static str, path: impl Into<String>, message: impl Into<String>) -> Issue {
        Issue {
            code,
            severity: Severity::Error,
            path: path.into(),
            message: message.into(),
        }
    }
    pub fn warning(
        code: &'static str,
        path: impl Into<String>,
        message: impl Into<String>,
    ) -> Issue {
        Issue {
            code,
            severity: Severity::Warning,
            path: path.into(),
            message: message.into(),
        }
    }
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("code", Json::str(self.code)),
            (
                "severity",
                Json::str(match self.severity {
                    Severity::Error => "error",
                    Severity::Warning => "warning",
                }),
            ),
            ("path", Json::str(self.path.as_str())),
            ("message", Json::str(self.message.as_str())),
        ])
    }
}

/// 全量错误码（详见 docs/ERROR-CODES.md）。命名空间 `E-AGV-*` / `E-DISP-*`（调度验证）。
pub mod codes {
    // —— 契约结构 ——
    pub const BAD_JSON: &str = "E-AGV-BAD-JSON";
    pub const SCHEMA: &str = "E-AGV-SCHEMA";
    pub const MISSING_FIELD: &str = "E-AGV-MISSING-FIELD";
    pub const UNKNOWN_FIELD: &str = "E-AGV-UNKNOWN-FIELD";
    pub const MAP_SHAPE: &str = "E-AGV-MAP-SHAPE";
    pub const MAP_EMPTY: &str = "E-AGV-MAP-EMPTY";

    // —— 车辆/任务/工作站语义 ——
    pub const DUP_VEHICLE_ID: &str = "E-AGV-VEHICLE-DUP-ID";
    pub const DUP_TASK_ID: &str = "E-AGV-TASK-DUP-ID";
    pub const DUP_STATION_ID: &str = "E-AGV-STATION-DUP-ID";
    pub const DUP_START: &str = "E-AGV-VEHICLE-DUP-START";
    pub const COORD_RANGE: &str = "E-AGV-COORD-RANGE";
    pub const VEHICLE_START_BLOCKED: &str = "E-AGV-VEHICLE-START-BLOCKED";
    pub const LOC_BLOCKED: &str = "E-AGV-LOC-BLOCKED";
    pub const UNKNOWN_STATION: &str = "E-AGV-UNKNOWN-STATION";
    pub const STATION_DUP_CELL: &str = "E-AGV-STATION-DUP-CELL";
    pub const STATION_CAP: &str = "E-AGV-STATION-CAPACITY";
    pub const PICKUP_EQ_DROPOFF: &str = "E-AGV-PICKUP-EQ-DROPOFF";
    pub const PARKING_CONFLICT: &str = "E-AGV-PARKING-CONFLICT";
    pub const DUP_PARKING: &str = "E-AGV-PARKING-DUP";

    // —— 动态快照 ——
    pub const SNAP_SHAPE: &str = "E-AGV-SNAP-SHAPE";
    pub const SNAP_TIME: &str = "E-AGV-SNAP-TIME";
    pub const SNAP_STATE: &str = "E-AGV-SNAP-STATE";
    pub const SNAP_PATH: &str = "E-AGV-SNAP-PATH";
    pub const EVENT_KIND: &str = "E-AGV-EVENT-KIND";
    pub const EVENT_TARGET: &str = "E-AGV-EVENT-TARGET";
    pub const EVENT_TIME: &str = "E-AGV-EVENT-TIME";

    // —— 能力 ——
    pub const UNSUPPORTED_FEATURE: &str = "E-CAP-UNSUPPORTED-FEATURE";
    pub const LIMIT_VEHICLES: &str = "E-CAP-LIMIT-VEHICLES";
    pub const LIMIT_TASKS: &str = "E-CAP-LIMIT-TASKS";
    pub const LIMIT_MAP: &str = "E-CAP-LIMIT-MAP";
    pub const LIMIT_HORIZON: &str = "E-CAP-LIMIT-HORIZON";
    pub const LIMIT_BUDGET: &str = "E-CAP-LIMIT-BUDGET";
    pub const LIMIT_EVENTS: &str = "E-CAP-LIMIT-EVENTS";

    // —— 任务失败原因（解内，非输入错误） ——
    pub const TASK_UNASSIGNED: &str = "E-AGV-TASK-UNASSIGNED";
    pub const TASK_LEG_INFEASIBLE: &str = "E-AGV-TASK-LEG-INFEASIBLE";
    pub const TASK_BUDGET: &str = "E-AGV-TASK-BUDGET";
    pub const TASK_CANCELLED: &str = "E-AGV-TASK-CANCELLED";
    pub const TASK_VEHICLE_PAUSED: &str = "E-AGV-TASK-VEHICLE-PAUSED";

    // —— 调度验证器（verify.rs） ——
    pub const DISP_ASSIGN_DUP: &str = "E-DISP-ASSIGN-DUP";
    pub const DISP_CAPABILITY: &str = "E-DISP-CAPABILITY";
    pub const DISP_ORDER: &str = "E-DISP-ORDER";
    pub const DISP_RELEASE: &str = "E-DISP-RELEASE";
    pub const DISP_SINGLE_LOAD: &str = "E-DISP-SINGLE-LOAD";
    pub const DISP_DOCK_INVALID: &str = "E-DISP-DOCK-INVALID";
    pub const DISP_DOCK_OCCUPY: &str = "E-DISP-DOCK-OCCUPY";
    pub const DISP_STATION_CAP: &str = "E-DISP-STATION-CAPACITY";
    pub const DISP_SERVICE_TIME: &str = "E-DISP-SERVICE-TIME";
    pub const DISP_TIMELINE_LEN: &str = "E-DISP-TIMELINE-LENGTH";
    pub const DISP_MOVE_ILLEGAL: &str = "E-DISP-MOVE-ILLEGAL";
    pub const DISP_WALL_ENTRY: &str = "E-DISP-WALL-ENTRY";
    pub const DISP_CONFLICT_VERTEX: &str = "E-DISP-CONFLICT-VERTEX";
    pub const DISP_CONFLICT_EDGE: &str = "E-DISP-CONFLICT-EDGE";
    pub const DISP_HISTORY: &str = "E-DISP-HISTORY";
    pub const DISP_METRICS: &str = "E-DISP-METRICS";
    pub const DISP_STATUS: &str = "E-DISP-STATUS";
}
