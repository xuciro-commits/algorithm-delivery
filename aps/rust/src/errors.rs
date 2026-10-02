//! 统一的错误 / 违约 / 状态模型。
//!
//! * `Issue`  —— 建模层问题（契约非法、引用缺失、语义冲突、时间不对齐……），
//!   对应状态 `MODEL_INVALID`，必须给出**字段级定位**（`$.orders[0].operations[1].alternatives[0]`）。
//! * `Violation` —— 方案核验层违约，对应 APS-SRS 的 H01–H08 约束与资源/时间定位。
//!
//! 状态名严格采用契约枚举（`plan-solution/1.0`），不得依赖引擎内部枚举。

use crate::json::Json;

pub const SCHEMA_VERSION_PROBLEM: &str = "plan-problem/1.0";
pub const SCHEMA_VERSION_SOLUTION: &str = "plan-solution/1.0";

/// 契约状态机（APS-SRS §4）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Optimal,
    Feasible,
    Infeasible,
    Unknown,
    ModelInvalid,
    NoSolutionFound,
    UnsupportedConstraint,
    Cancelled,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Optimal => "OPTIMAL",
            Status::Feasible => "FEASIBLE",
            Status::Infeasible => "INFEASIBLE",
            Status::Unknown => "UNKNOWN",
            Status::ModelInvalid => "MODEL_INVALID",
            Status::NoSolutionFound => "NO_SOLUTION_FOUND",
            Status::UnsupportedConstraint => "UNSUPPORTED_CONSTRAINT",
            Status::Cancelled => "CANCELLED",
        }
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

/// 建模/契约问题。
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

/// 方案违约（独立校验器输出；同时用于“无解证明”等诊断信息）。
#[derive(Debug, Clone, PartialEq)]
pub struct Violation {
    pub code: String,
    pub severity: Severity,
    /// 约束编号（`H01`..`H08`）或契约类（`CONTRACT` / `PROOF` / `ENGINE`）。
    pub constraint: Option<String>,
    pub message: String,
    pub order_id: Option<String>,
    pub operation_id: Option<String>,
    pub resource_id: Option<String>,
    /// 违约发生时刻（ISO 8601，按问题元数据偏移输出）。
    pub at: Option<String>,
    pub expected: Option<String>,
    pub actual: Option<String>,
    pub details: Vec<(String, Json)>,
}

impl Violation {
    pub fn new(code: &str, constraint: &str, message: impl Into<String>) -> Violation {
        Violation {
            code: code.to_string(),
            severity: Severity::Error,
            constraint: Some(constraint.to_string()),
            message: message.into(),
            order_id: None,
            operation_id: None,
            resource_id: None,
            at: None,
            expected: None,
            actual: None,
            details: Vec::new(),
        }
    }

    pub fn with_op(mut self, order_id: impl Into<String>, operation_id: impl Into<String>) -> Self {
        self.order_id = Some(order_id.into());
        self.operation_id = Some(operation_id.into());
        self
    }

    pub fn with_resource(mut self, resource_id: impl Into<String>) -> Self {
        self.resource_id = Some(resource_id.into());
        self
    }

    pub fn with_time(mut self, at_iso: impl Into<String>) -> Self {
        self.at = Some(at_iso.into());
        self
    }

    pub fn with_expected_actual(
        mut self,
        expected: impl Into<String>,
        actual: impl Into<String>,
    ) -> Self {
        self.expected = Some(expected.into());
        self.actual = Some(actual.into());
        self
    }

    pub fn with_detail(mut self, key: &str, value: Json) -> Self {
        self.details.push((key.to_string(), value));
        self
    }

    pub fn to_json(&self) -> Json {
        let details = if self.details.is_empty() {
            Json::Obj(Vec::new())
        } else {
            Json::Obj(self.details.clone())
        };
        Json::obj(vec![
            ("code", Json::str(self.code.clone())),
            ("severity", Json::str(self.severity.as_str())),
            ("constraint", Json::opt_str(self.constraint.clone())),
            ("message", Json::str(self.message.clone())),
            ("order_id", Json::opt_str(self.order_id.clone())),
            ("operation_id", Json::opt_str(self.operation_id.clone())),
            ("resource_id", Json::opt_str(self.resource_id.clone())),
            ("at", Json::opt_str(self.at.clone())),
            ("expected", Json::opt_str(self.expected.clone())),
            ("actual", Json::opt_str(self.actual.clone())),
            ("details", details),
        ])
    }
}

/// 独立校验器使用的违约码（与 `aps/tests/verify_mock.py` 的语义一一对应，并细化为 H0x 前缀）。
pub mod codes {
    // 契约/结构
    pub const SNAPSHOT_MISMATCH: &str = "SNAPSHOT_MISMATCH";
    pub const TENANT_MISMATCH: &str = "TENANT_MISMATCH";
    pub const UNKNOWN_OPERATION: &str = "UNKNOWN_OPERATION";
    pub const DUPLICATE_OPERATION: &str = "DUPLICATE_OPERATION";
    pub const MISSING_OPERATION: &str = "MISSING_OPERATION";
    pub const ORDER_ID_MISMATCH: &str = "ORDER_ID_MISMATCH";
    pub const TIME_INVALID: &str = "TIME_INVALID";
    // H01 工序时长
    pub const H01_DURATION_MISMATCH: &str = "H01_DURATION_MISMATCH";
    pub const H01_TIME_ORDER: &str = "H01_TIME_ORDER";
    // H02 工艺依赖 / 投放时间
    pub const H02_PRECEDENCE: &str = "H02_PRECEDENCE";
    pub const H02_RELEASE: &str = "H02_RELEASE";
    pub const H02_MISSING_PREDECESSOR: &str = "H02_MISSING_PREDECESSOR";
    // H03 机器能力 / 机器排他
    pub const H03_MACHINE_NOT_ALLOWED: &str = "H03_MACHINE_NOT_ALLOWED";
    pub const H03_MACHINE_CAPABILITY: &str = "H03_MACHINE_CAPABILITY";
    pub const H03_MACHINE_OVERLAP: &str = "H03_MACHINE_OVERLAP";
    // H04 日历
    pub const H04_MACHINE_CALENDAR: &str = "H04_MACHINE_CALENDAR";
    pub const H04_MACHINE_BLOCKED: &str = "H04_MACHINE_BLOCKED";
    pub const H04_WORKER_CALENDAR: &str = "H04_WORKER_CALENDAR";
    pub const H04_WORKER_BLOCKED: &str = "H04_WORKER_BLOCKED";
    // H05 人员技能与排他
    pub const H05_WORKER_SKILL: &str = "H05_WORKER_SKILL";
    pub const H05_WORKER_QUALIFICATION: &str = "H05_WORKER_QUALIFICATION";
    pub const H05_WORKER_OVERLAP: &str = "H05_WORKER_OVERLAP";
    pub const H05_WORKER_UNKNOWN: &str = "H05_WORKER_UNKNOWN";
    pub const H05_WORKER_COUNT: &str = "H05_WORKER_COUNT";
    // H06 工装
    pub const H06_TOOL_ASSIGNMENT: &str = "H06_TOOL_ASSIGNMENT";
    pub const H06_UNKNOWN_TOOL: &str = "H06_UNKNOWN_TOOL";
    pub const H06_TOOL_OVERLAP: &str = "H06_TOOL_OVERLAP";
    // H07 物料
    pub const H07_STOCK_NEGATIVE: &str = "H07_STOCK_NEGATIVE";
    pub const H07_UNKNOWN_MATERIAL: &str = "H07_UNKNOWN_MATERIAL";
    // H08 时域
    pub const H08_OUT_OF_HORIZON: &str = "H08_OUT_OF_HORIZON";
    // 引擎自检
    pub const ENGINE_SELF_CHECK: &str = "ENGINE_SELF_CHECK";
    pub const CANCELLED_WITH_INCUMBENT: &str = "CANCELLED_WITH_INCUMBENT";
    pub const PROOF_INFEASIBLE: &str = "PROOF_INFEASIBLE";
    pub const UNSUPPORTED: &str = "UNSUPPORTED";
    pub const UNKNOWN_STATUS: &str = "UNKNOWN_STATUS";
}
