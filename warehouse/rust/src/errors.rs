//! 状态码、字段级问题与约束码。
//!
//! 全部与 `warehouse/contracts/*.schema.json` 的枚举、`docs/ERROR-CODES.md` 一一对应。
//! 与 aps/mapf/agv 的关键差别：本交付把 SRS §6.2 的九种结果状态**逐一**建模，
//! 尤其把"超时但已有有效解"（`FEASIBLE` + `budget_exceeded`）与
//! "预算耗尽且尚无有效解"（`BUDGET_EXCEEDED`）分开 —— 二者在工业项目里是完全不同的结论。

use aps_engine::json::Json;

/// 求解结局状态（写入解的 `status`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// 已证明最优（只有穷尽性方式允许使用：小规模精确枚举 / 约束传播证明）。
    OptimalProven,
    /// 带优化界的可行解（上下界均已知；启发式通常不使用）。
    FeasibleWithBound,
    /// 有效解（可通过独立验证）。
    Feasible,
    /// 预算耗尽且**尚无**有效解 —— 绝不等于"问题无解"。
    BudgetExceeded,
    /// 搜索结束仍未找到解（同样不等于无解）。
    NoSolutionFound,
    /// 已证明无解（容量下界、单件不可行等可复述的证明）。
    InfeasibleProven,
    /// 宿主取消（已找到的解仍会返回）。
    Cancelled,
    /// 输入违反契约（字段级定位）。
    InvalidInput,
    /// 请求了能力档位之外的功能（例如 wasm-light 的超大场景）。
    Unsupported,
    /// 内部错误（求解器自身异常；不掩盖、不伪装成"无解"）。
    InternalError,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::OptimalProven => "OPTIMAL_PROVEN",
            Status::FeasibleWithBound => "FEASIBLE_WITH_BOUND",
            Status::Feasible => "FEASIBLE",
            Status::BudgetExceeded => "BUDGET_EXCEEDED",
            Status::NoSolutionFound => "NO_SOLUTION_FOUND",
            Status::InfeasibleProven => "INFEASIBLE_PROVEN",
            Status::Cancelled => "CANCELLED",
            Status::InvalidInput => "INVALID_INPUT",
            Status::Unsupported => "UNSUPPORTED",
            Status::InternalError => "INTERNAL_ERROR",
        }
    }

    /// 是否为"有有效解"的状态族（实验室用它决定是否允许进入对比/回放）。
    pub fn has_solution(self) -> bool {
        matches!(
            self,
            Status::OptimalProven | Status::FeasibleWithBound | Status::Feasible | Status::Cancelled
        )
    }

    /// wasm ABI 状态码（与 `web/warehouse-worker.js` 的 STATUS 表一一对应）。
    pub fn code(self) -> i32 {
        match self {
            Status::OptimalProven => 1,
            Status::FeasibleWithBound => 2,
            Status::Feasible => 3,
            Status::BudgetExceeded => 4,
            Status::NoSolutionFound => 5,
            Status::InfeasibleProven => 6,
            Status::Cancelled => 7,
            Status::InvalidInput => 8,
            Status::Unsupported => 9,
            Status::InternalError => 10,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
    Info,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Info => "info",
            Severity::Error => "error",
            Severity::Warning => "warning",
        }
    }
}

/// 结构化问题（字段级定位，供 CLI / 实验室直接展示）。
#[derive(Debug, Clone)]
pub struct Issue {
    pub code: &'static str,
    pub severity: Severity,
    pub path: String,
    pub message: String,
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

    pub fn info(code: &'static str, path: impl Into<String>, message: impl Into<String>) -> Issue {
        Issue {
            severity: Severity::Info,
            code,
            path: path.into(),
            message: message.into(),
        }
    }

    pub fn warning(code: &'static str, path: impl Into<String>, message: impl Into<String>) -> Issue {
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
            ("severity", Json::str(self.severity.as_str())),
            ("path", Json::str(self.path.clone())),
            ("message", Json::str(self.message.clone())),
        ])
    }
}

/// 问题收集器：解析/校验过程中累积 Issues，最后统一判定 INVALID_INPUT。
#[derive(Debug, Default, Clone)]
pub struct Issues {
    pub items: Vec<Issue>,
}

impl Issues {
    pub fn new() -> Issues {
        Issues { items: Vec::new() }
    }

    pub fn error(&mut self, code: &'static str, path: impl Into<String>, message: impl Into<String>) {
        self.items.push(Issue::error(code, path, message));
    }

    /// 说明性信息（不构成问题，但需要在报告里留痕，例如"下界是多少"）。
    pub fn info(&mut self, code: &'static str, path: impl Into<String>, message: impl Into<String>) {
        self.items.push(Issue::info(code, path, message));
    }

    pub fn warn(&mut self, code: &'static str, path: impl Into<String>, message: impl Into<String>) {
        self.items.push(Issue::warning(code, path, message));
    }

    pub fn has_errors(&self) -> bool {
        self.items.iter().any(|i| i.severity == Severity::Error)
    }

    pub fn error_count(&self) -> usize {
        self.items.iter().filter(|i| i.severity == Severity::Error).count()
    }

    pub fn warning_count(&self) -> usize {
        self.items.iter().filter(|i| i.severity == Severity::Warning).count()
    }

    pub fn extend(&mut self, other: Issues) {
        self.items.extend(other.items);
    }

    pub fn to_json(&self) -> Json {
        Json::Arr(self.items.iter().map(|i| i.to_json()).collect())
    }
}

/// 错误码（解析/校验层；与契约 schema 的 `code` 枚举一致）。
pub mod codes {
    pub const SCHEMA_INVALID: &str = "SCHEMA_INVALID";
    pub const MISSING_FIELD: &str = "MISSING_FIELD";
    pub const TYPE_MISMATCH: &str = "TYPE_MISMATCH";
    pub const VALUE_RANGE: &str = "VALUE_RANGE";
    pub const DUPLICATE_ID: &str = "DUPLICATE_ID";
    pub const UNKNOWN_REFERENCE: &str = "UNKNOWN_REFERENCE";
    pub const TOPOLOGY_INVALID: &str = "TOPOLOGY_INVALID";
    pub const DEVICE_CAPABILITY: &str = "DEVICE_CAPABILITY";
    pub const UNREACHABLE: &str = "UNREACHABLE";
    pub const UNSUPPORTED_FEATURE: &str = "UNSUPPORTED_FEATURE";
    pub const LIMIT_EXCEEDED: &str = "LIMIT_EXCEEDED";
    pub const EMPTY_INPUT: &str = "EMPTY_INPUT";
    pub const SCALE_TOO_LARGE: &str = "SCALE_TOO_LARGE";
    pub const INFEASIBLE: &str = "INFEASIBLE";
    pub const NO_SOLUTION: &str = "NO_SOLUTION";
    pub const BOUND_AVAILABLE: &str = "BOUND_AVAILABLE";
    pub const BUDGET_EXHAUSTED: &str = "BUDGET_EXHAUSTED";
    pub const INTERNAL_INCONSISTENCY: &str = "INTERNAL_INCONSISTENCY";
}

/// 约束码（验证报告与解的 `hardConstraints` 共用同一套字符串，保证可追溯）。
pub mod constraints {
    // 库位侧
    pub const LOCATION_CAPACITY: &str = "LOCATION_CAPACITY";
    pub const LOCATION_WEIGHT_LIMIT: &str = "LOCATION_WEIGHT_LIMIT";
    pub const LOCATION_VOLUME_LIMIT: &str = "LOCATION_VOLUME_LIMIT";
    pub const LOCATION_UNAVAILABLE: &str = "LOCATION_UNAVAILABLE";
    pub const LOCATION_FROZEN: &str = "LOCATION_FROZEN";
    pub const LOCATION_RESERVED: &str = "LOCATION_RESERVED";
    pub const ZONE_COMPATIBILITY: &str = "ZONE_COMPATIBILITY";
    pub const INVENTORY_CONSERVATION: &str = "INVENTORY_CONSERVATION";
    pub const SKU_DISPERSION_MIN: &str = "SKU_DISPERSION_MIN";
    pub const SKU_DISPERSION_MAX: &str = "SKU_DISPERSION_MAX";
    pub const DEEP_LANE_BLOCKING: &str = "DEEP_LANE_BLOCKING";
    pub const FIFO_FEFO: &str = "FIFO_FEFO";
    pub const UNASSIGNED_INVENTORY: &str = "UNASSIGNED_INVENTORY";
    // 调度侧
    pub const DEVICE_UNAVAILABLE: &str = "DEVICE_UNAVAILABLE";
    pub const DEVICE_CAPABILITY_VIOLATION: &str = "DEVICE_CAPABILITY";
    pub const DEVICE_MUTUAL_EXCLUSION: &str = "DEVICE_MUTUAL_EXCLUSION";
    pub const LANE_MUTUAL_EXCLUSION: &str = "LANE_MUTUAL_EXCLUSION";
    pub const NODE_MUTUAL_EXCLUSION: &str = "NODE_MUTUAL_EXCLUSION";
    pub const LIFT_SHAFT_CAPACITY: &str = "LIFT_SHAFT_CAPACITY";
    pub const TRANSFER_HANDOVER: &str = "TRANSFER_HANDOVER";
    pub const TASK_PRECEDENCE: &str = "TASK_PRECEDENCE";
    pub const TASK_SEQUENCE: &str = "TASK_SEQUENCE";
    pub const TASK_DEADLINE: &str = "TASK_DEADLINE";
    pub const BUFFER_CAPACITY: &str = "BUFFER_CAPACITY";
    pub const STATION_CAPACITY: &str = "STATION_CAPACITY";
    pub const TIME_CONSISTENCY: &str = "TIME_CONSISTENCY";
    pub const REACHABILITY: &str = "REACHABILITY";
    // 结论性 / 过程性
    // 通用
    pub const METRIC_MISMATCH: &str = "METRIC_MISMATCH";
    pub const SCHEMA_INVALID: &str = "SCHEMA_INVALID";
}

/// 验证违规（与契约 `warehouse-verification/1.0` 的 violations 条目同形）。
#[derive(Debug, Clone)]
pub struct Violation {
    pub code: String,
    pub severity: Severity,
    pub constraint_class: &'static str,
    pub message: String,
    pub subjects: Vec<String>,
    pub location_id: Option<String>,
    pub device_id: Option<String>,
    pub task_id: Option<String>,
    pub at_s: Option<f64>,
    pub position: Option<[f64; 3]>,
    pub expected: Option<String>,
    pub actual: Option<String>,
}

impl Violation {
    pub fn new(code: &str, severity: Severity, message: impl Into<String>) -> Violation {
        Violation {
            code: code.to_string(),
            severity,
            constraint_class: "hard",
            message: message.into(),
            subjects: Vec::new(),
            location_id: None,
            device_id: None,
            task_id: None,
            at_s: None,
            position: None,
            expected: None,
            actual: None,
        }
    }

    pub fn soft(mut self) -> Violation {
        self.constraint_class = "soft";
        self
    }

    pub fn subjects<I, S>(mut self, items: I) -> Violation
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.subjects = items.into_iter().map(|s| s.into()).collect();
        self
    }

    pub fn location(mut self, id: impl Into<String>) -> Violation {
        self.location_id = Some(id.into());
        self
    }

    pub fn device(mut self, id: impl Into<String>) -> Violation {
        self.device_id = Some(id.into());
        self
    }

    pub fn task(mut self, id: impl Into<String>) -> Violation {
        self.task_id = Some(id.into());
        self
    }

    pub fn at(mut self, seconds: f64) -> Violation {
        self.at_s = Some(seconds);
        self
    }

    pub fn position(mut self, p: [f64; 3]) -> Violation {
        self.position = Some(p);
        self
    }

    pub fn expected_actual(mut self, expected: impl Into<String>, actual: impl Into<String>) -> Violation {
        self.expected = Some(expected.into());
        self.actual = Some(actual.into());
        self
    }

    pub fn to_json(&self) -> Json {
        let mut fields = vec![
            ("code", Json::str(self.code.clone())),
            ("severity", Json::str(self.severity.as_str())),
            ("constraintClass", Json::str(self.constraint_class)),
            ("message", Json::str(self.message.clone())),
        ];
        if !self.subjects.is_empty() {
            fields.push(("subjects", Json::strings(self.subjects.clone())));
        }
        if let Some(v) = &self.location_id {
            fields.push(("locationId", Json::str(v.clone())));
        }
        if let Some(v) = &self.device_id {
            fields.push(("deviceId", Json::str(v.clone())));
        }
        if let Some(v) = &self.task_id {
            fields.push(("taskId", Json::str(v.clone())));
        }
        if let Some(v) = self.at_s {
            fields.push(("at_s", Json::Float(v)));
        }
        if let Some(p) = self.position {
            fields.push((
                "position",
                Json::Arr(vec![Json::Float(p[0]), Json::Float(p[1]), Json::Float(p[2])]),
            ));
        }
        if let Some(v) = &self.expected {
            fields.push(("expected", Json::str(v.clone())));
        }
        if let Some(v) = &self.actual {
            fields.push(("actual", Json::str(v.clone())));
        }
        Json::Obj(fields.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }
}

/// 独立验证报告（`warehouse-verification/1.0` 的构造器）。
#[derive(Debug, Clone)]
pub struct VerificationReport {
    pub id: String,
    pub target: &'static str,
    pub subject_id: String,
    pub problem_hash: String,
    pub solution_hash: String,
    pub verifier: &'static str,
    pub verifier_version: &'static str,
    pub checks: Vec<Check>,
    pub violations: Vec<Violation>,
    pub recomputed: Vec<(String, Json)>,
    pub mismatches: Vec<Mismatch>,
    pub elapsed_ms: f64,
}

#[derive(Debug, Clone)]
pub struct Check {
    pub group: &'static str,
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

impl Check {
    pub fn new(group: &'static str, name: impl Into<String>, ok: bool, detail: impl Into<String>) -> Check {
        Check {
            group,
            name: name.into(),
            ok,
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Mismatch {
    pub metric: String,
    pub reported: f64,
    pub recomputed: f64,
    pub tolerance: f64,
    pub relative: f64,
}

impl VerificationReport {
    pub fn errors(&self) -> usize {
        self.violations
            .iter()
            .filter(|v| v.severity == Severity::Error)
            .count()
    }

    pub fn warnings(&self) -> usize {
        self.violations
            .iter()
            .filter(|v| v.severity == Severity::Warning)
            .count()
    }

    pub fn ok(&self) -> bool {
        self.errors() == 0
    }

    pub fn to_json(&self) -> Json {
        let checks: Vec<Json> = self
            .checks
            .iter()
            .map(|c| {
                Json::obj(vec![
                    ("group", Json::str(c.group)),
                    ("name", Json::str(c.name.clone())),
                    ("ok", Json::Bool(c.ok)),
                    ("detail", Json::str(c.detail.clone())),
                ])
            })
            .collect();
        let violations: Vec<Json> = self.violations.iter().map(|v| v.to_json()).collect();
        let mismatches: Vec<Json> = self
            .mismatches
            .iter()
            .map(|m| {
                Json::obj(vec![
                    ("metric", Json::str(m.metric.clone())),
                    ("reported", Json::Float(m.reported)),
                    ("recomputed", Json::Float(m.recomputed)),
                    ("tolerance", Json::Float(m.tolerance)),
                    ("relative", Json::Float(m.relative)),
                ])
            })
            .collect();
        Json::obj(vec![
            ("schema_version", Json::str("warehouse-verification/1.0")),
            ("id", Json::str(self.id.clone())),
            ("target", Json::str(self.target)),
            ("subjectId", Json::str(self.subject_id.clone())),
            ("problemHash", Json::str(self.problem_hash.clone())),
            ("solutionHash", Json::str(self.solution_hash.clone())),
            ("verifier", Json::str(self.verifier)),
            ("verifierVersion", Json::str(self.verifier_version)),
            ("ok", Json::Bool(self.ok())),
            (
                "counts",
                Json::obj(vec![
                    ("errors", Json::int(self.errors() as i64)),
                    ("warnings", Json::int(self.warnings() as i64)),
                    ("checks", Json::int(self.checks.len() as i64)),
                ]),
            ),
            ("checks", Json::Arr(checks)),
            ("violations", Json::Arr(violations)),
            (
                "recomputed",
                Json::Obj(
                    self.recomputed
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect(),
                ),
            ),
            ("mismatches", Json::Arr(mismatches)),
            ("elapsedMs", Json::Float(round6(self.elapsed_ms))),
        ])
    }
}

fn round6(v: f64) -> f64 {
    let f = 1_000_000.0;
    (v * f).round() / f
}
