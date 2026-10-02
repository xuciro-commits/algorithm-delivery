//! **独立方案校验器**（APS-SRS §4）：
//!
//! > 独立校验器不得重用求解器内部的约束判断路径 …… 针对每种约束准备故意破坏的方案做反向测试。
//!
//! 因此本模块：
//! * 只依赖 `model`（原始领域模型）与 `datetime`（时间解析），**不引用** `compile` /
//!   `calendar` / `schedule` / `solver` 的任何函数——约束判断逻辑在此重新实现一遍；
//! * 全程使用**绝对分钟**（直接由 ISO 字符串解析），与求解器的“相对分钟”表示相互独立；
//! * 每条违约都带 `code`（H01–H08 前缀）、业务 ID 与时间/资源定位，可直接回给平台与前端。
//!
//! 覆盖面：H01–H08 全部硬约束 + 契约级一致性（快照、租户、重复/缺失工序）。

use std::collections::BTreeMap;

use crate::datetime::parse_iso8601;
use crate::errors::{codes, Issue, Violation};
use crate::json::Json;
use crate::model::{Ctx, RawProblem, RawInterval};

/// 方案中的一道工序分配。
#[derive(Debug, Clone, PartialEq)]
pub struct SolutionOp {
    pub order_id: String,
    pub operation_id: String,
    pub machine_id: String,
    pub worker_id: String,
    pub tool_ids: Vec<String>,
    pub start_at: String,
    pub end_at: String,
    /// 绝对分钟（由 ISO 解析；解析失败为 None）
    pub start_min: Option<i64>,
    pub end_min: Option<i64>,
}

/// 反序列化后的 `PlanSolution v1`。
#[derive(Debug, Clone, PartialEq)]
pub struct RawSolution {
    pub schema_version: String,
    pub id: Option<String>,
    pub tenant_id: Option<String>,
    pub snapshot_id: String,
    pub problem_hash: Option<String>,
    pub engine: Option<String>,
    pub engine_version: Option<String>,
    pub compiler_version: Option<String>,
    pub options: Option<Json>,
    pub status: String,
    pub optimality_proven: bool,
    pub verified: Option<bool>,
    pub violations: Option<Json>,
    pub objective: Option<Json>,
    pub metrics: Option<Json>,
    pub operations: Vec<SolutionOp>,
    pub source: Json,
}

/// 解析方案（严格契约检查）。返回 `(Some(solution), issues)`。
pub fn parse_solution(json: &Json) -> (Option<RawSolution>, Vec<Issue>) {
    let mut c = Ctx::new();
    let out = parse_solution_inner(&mut c, json);
    (out, c.issues)
}

fn parse_solution_inner(c: &mut Ctx, json: &Json) -> Option<RawSolution> {
    if c.expect_obj(json, "$").is_none() {
        return None;
    }
    c.check_keys(
        json,
        "$",
        &[
            "schema_version",
            "id",
            "tenant_id",
            "snapshot_id",
            "problem_hash",
            "engine",
            "engine_version",
            "compiler_version",
            "options",
            "status",
            "optimality_proven",
            "verified",
            "violations",
            "objective",
            "metrics",
            "operations",
        ],
    );
    let schema_version = c.req_str(json, "schema_version", "$");
    if let Some(v) = &schema_version {
        if v != crate::errors::SCHEMA_VERSION_SOLUTION {
            c.error(
                "CONST_MISMATCH",
                "$.schema_version",
                format!(
                    "schema_version 必须为 '{}'，实际为 '{}'",
                    crate::errors::SCHEMA_VERSION_SOLUTION,
                    v
                ),
            );
        }
    }
    let id = c.opt_str(json, "id", "$");
    let tenant_id = c.opt_str(json, "tenant_id", "$");
    let snapshot_id = c.req_str(json, "snapshot_id", "$");
    let problem_hash = c.opt_str(json, "problem_hash", "$");
    let engine = c.opt_str(json, "engine", "$");
    let engine_version = c.opt_str(json, "engine_version", "$");
    let compiler_version = c.opt_str(json, "compiler_version", "$");
    let options = json.get("options").cloned();
    let status = c.req_str(json, "status", "$");
    let optimality_proven = match json.get("optimality_proven") {
        Some(v) => match v.as_bool() {
            Some(b) => Some(b),
            None => {
                c.error(
                    "TYPE_MISMATCH",
                    "$.optimality_proven",
                    format!("期望 boolean，实际为 {}", v.type_name()),
                );
                None
            }
        },
        None => {
            c.error("MISSING_FIELD", "$.optimality_proven", "缺少必需字段");
            None
        }
    };
    if let Some(s) = &status {
        const ALLOWED: [&str; 8] = [
            "OPTIMAL",
            "FEASIBLE",
            "INFEASIBLE",
            "UNKNOWN",
            "MODEL_INVALID",
            "NO_SOLUTION_FOUND",
            "UNSUPPORTED_CONSTRAINT",
            "CANCELLED",
        ];
        if !ALLOWED.contains(&s.as_str()) {
            c.error(
                "INVALID_ENUM",
                "$.status",
                format!("未知状态 '{}'", s),
            );
        }
    }
    let verified = match json.get("verified") {
        None | Some(Json::Null) => None,
        Some(v) => match v.as_bool() {
            Some(b) => Some(b),
            None => {
                c.error(
                    "TYPE_MISMATCH",
                    "$.verified",
                    format!("期望 boolean，实际为 {}", v.type_name()),
                );
                None
            }
        },
    };
    let violations = json.get("violations").cloned();
    let objective = json.get("objective").cloned();
    let metrics = json.get("metrics").cloned();

    let mut operations = Vec::new();
    let mut ops_ok = true;
    match c.req_arr(json, "operations", "$", 0) {
        Some(items) => {
            for (i, item) in items.iter().enumerate() {
                let path = format!("$.operations[{}]", i);
                match parse_solution_op(c, item, &path) {
                    Some(op) => operations.push(op),
                    None => ops_ok = false,
                }
            }
        }
        None => ops_ok = false,
    }

    match (
        schema_version,
        snapshot_id,
        status,
        optimality_proven,
    ) {
        (Some(schema_version), Some(snapshot_id), Some(status), Some(optimality_proven)) if ops_ok => {
            Some(RawSolution {
                schema_version,
                id,
                tenant_id,
                snapshot_id,
                problem_hash,
                engine,
                engine_version,
                compiler_version,
                options,
                status,
                optimality_proven,
                verified,
                violations,
                objective,
                metrics,
                operations,
                source: json.clone(),
            })
        }
        _ => None,
    }
}

fn parse_solution_op(c: &mut Ctx, item: &Json, path: &str) -> Option<SolutionOp> {
    if c.expect_obj(item, path).is_none() {
        return None;
    }
    c.check_keys(
        item,
        path,
        &[
            "order_id",
            "operation_id",
            "machine_id",
            "worker_id",
            "tool_ids",
            "start_at",
            "end_at",
        ],
    );
    let order_id = c.req_str(item, "order_id", path);
    let operation_id = c.req_str(item, "operation_id", path);
    let machine_id = c.req_str(item, "machine_id", path);
    let worker_id = c.req_str(item, "worker_id", path);
    let tool_ids = c.str_list(item, "tool_ids", path, 0, false);
    let start = c.req_time(item, "start_at", path);
    let end = c.req_time(item, "end_at", path);
    match (order_id, operation_id, machine_id, worker_id, tool_ids, start, end) {
        (
            Some(order_id),
            Some(operation_id),
            Some(machine_id),
            Some(worker_id),
            Some(tool_ids),
            Some((start_at, start_min, _)),
            Some((end_at, end_min, _)),
        ) => Some(SolutionOp {
            order_id,
            operation_id,
            machine_id,
            worker_id,
            tool_ids,
            start_at,
            end_at,
            start_min: Some(start_min),
            end_min: Some(end_min),
        }),
        _ => None,
    }
}

/// 契约级快照绑定检查（S05 的 Rust 侧前置条件）：方案必须绑定到当前有效快照。
pub fn check_snapshot_binding(problem: &RawProblem, solution: &RawSolution) -> Vec<Violation> {
    let mut out = Vec::new();
    if problem.meta.snapshot_id != solution.snapshot_id {
        out.push(
            Violation::new(
                codes::SNAPSHOT_MISMATCH,
                "CONTRACT",
                "方案绑定的快照与当前问题快照不一致（旧快照方案不得发布）",
            )
            .with_expected_actual(
                problem.meta.snapshot_id.clone(),
                solution.snapshot_id.clone(),
            ),
        );
    }
    if let Some(t) = &solution.tenant_id {
        if t != &problem.meta.tenant_id {
            out.push(
                Violation::new(
                    codes::TENANT_MISMATCH,
                    "CONTRACT",
                    "方案租户与问题租户不一致",
                )
                .with_expected_actual(problem.meta.tenant_id.clone(), t.clone()),
            );
        }
    }
    out
}

/// 独立校验入口：返回全部违约（空 = 方案合法）。
pub fn verify(problem: &RawProblem, solution: &RawSolution) -> Vec<Violation> {
    let mut out: Vec<Violation> = Vec::new();
    out.extend(check_snapshot_binding(problem, solution));

    let t0 = problem.meta.horizon_start_min;
    let t_end = problem.meta.horizon_end_min;
    let h = problem.meta.horizon_end_min - problem.meta.horizon_start_min;

    // ---- 索引（独立于求解器的 trace 结构）----
    let machine_by_id: BTreeMap<&str, &crate::model::RawMachine> =
        problem.machines.iter().map(|m| (m.id.as_str(), m)).collect();
    let worker_by_id: BTreeMap<&str, &crate::model::RawWorker> =
        problem.workers.iter().map(|w| (w.id.as_str(), w)).collect();
    let tool_ids: Vec<&str> = problem.tools.iter().map(|t| t.id.as_str()).collect();
    let mat_by_id: BTreeMap<&str, &crate::model::RawMaterial> =
        problem.materials.iter().map(|m| (m.id.as_str(), m)).collect();
    let mut op_by_id: BTreeMap<&str, (&crate::model::RawOrder, &crate::model::RawOperation)> =
        BTreeMap::new();
    for order in problem.orders.iter() {
        for op in order.operations.iter() {
            op_by_id.insert(op.id.as_str(), (order, op));
        }
    }

    // ---- 逐条工序 ----
    struct Row<'a> {
        op: &'a SolutionOp,
        order: &'a crate::model::RawOrder,
        spec: &'a crate::model::RawOperation,
        start: i64,
        end: i64,
    }
    let mut rows: Vec<Row> = Vec::new();
    let mut seen: BTreeMap<&str, usize> = BTreeMap::new();

    for op in solution.operations.iter() {
        if let Some(first) = seen.get(op.operation_id.as_str()) {
            out.push(Violation::new(
                codes::DUPLICATE_OPERATION,
                "CONTRACT",
                format!("工序 '{}' 在方案中出现多次（首次下标 {}）", op.operation_id, first),
            )
            .with_op(op.order_id.clone(), op.operation_id.clone()));
            continue;
        }
        seen.insert(op.operation_id.as_str(), rows.len());
        let entry = match op_by_id.get(op.operation_id.as_str()) {
            Some(e) => *e,
            None => {
                out.push(
                    Violation::new(
                        codes::UNKNOWN_OPERATION,
                        "CONTRACT",
                        format!("方案包含问题中不存在的工序 '{}'", op.operation_id),
                    )
                    .with_op(op.order_id.clone(), op.operation_id.clone()),
                );
                continue;
            }
        };
        let (order, spec) = entry;
        let start = match op.start_min {
            Some(v) => v,
            None => {
                out.push(
                    Violation::new(
                        codes::TIME_INVALID,
                        "H01",
                        format!("工序 '{}' 的开始时间无法解析", op.operation_id),
                    )
                    .with_op(order.id.clone(), op.operation_id.clone())
                    .with_expected_actual("ISO 8601 含偏移", op.start_at.clone()),
                );
                continue;
            }
        };
        let end = match op.end_min {
            Some(v) => v,
            None => {
                out.push(
                    Violation::new(
                        codes::TIME_INVALID,
                        "H01",
                        format!("工序 '{}' 的结束时间无法解析", op.operation_id),
                    )
                    .with_op(order.id.clone(), op.operation_id.clone())
                    .with_expected_actual("ISO 8601 含偏移", op.end_at.clone()),
                );
                continue;
            }
        };
        rows.push(Row {
            op,
            order,
            spec,
            start,
            end,
        });
    }

    // 缺失工序（H08：不得静默删除）
    for order in problem.orders.iter() {
        for spec in order.operations.iter() {
            if !seen.contains_key(spec.id.as_str()) {
                out.push(
                    Violation::new(
                        codes::MISSING_OPERATION,
                        "H08",
                        format!("工序 '{}' 未出现在方案中", spec.id),
                    )
                    .with_op(order.id.clone(), spec.id.clone()),
                );
            }
        }
    }

    for row in rows.iter() {
        let op = row.op;
        let order = row.order;
        let spec = row.spec;

        // ---- H01 时长 / 时间顺序 ----
        if row.end <= row.start {
            out.push(
                Violation::new(
                    codes::H01_TIME_ORDER,
                    "H01",
                    format!("工序 '{}' 的结束时间不晚于开始时间", op.operation_id),
                )
                .with_op(order.id.clone(), op.operation_id.clone())
                .with_time(op.start_at.clone())
                .with_expected_actual("end > start", format!("{} ≤ {}", op.end_at, op.start_at)),
            );
        }
        let alt = spec
            .alternatives
            .iter()
            .find(|a| a.machine_id == op.machine_id);
        match alt {
            None => {
                out.push(
                    Violation::new(
                        codes::H03_MACHINE_NOT_ALLOWED,
                        "H03",
                        format!(
                            "工序 '{}' 使用了非备选机器 '{}'",
                            op.operation_id, op.machine_id
                        ),
                    )
                    .with_op(order.id.clone(), op.operation_id.clone())
                    .with_resource(op.machine_id.clone())
                    .with_expected_actual(
                        spec.alternatives
                            .iter()
                            .map(|a| a.machine_id.clone())
                            .collect::<Vec<_>>()
                            .join(","),
                        op.machine_id.clone(),
                    ),
                );
            }
            Some(a) => {
                if row.end - row.start != a.duration_min {
                    out.push(
                        Violation::new(
                            codes::H01_DURATION_MISMATCH,
                            "H01",
                            format!(
                                "工序 '{}' 在机器 '{}' 上的时长应为 {} 分钟",
                                op.operation_id, op.machine_id, a.duration_min
                            ),
                        )
                        .with_op(order.id.clone(), op.operation_id.clone())
                        .with_resource(op.machine_id.clone())
                        .with_expected_actual(
                            format!("{} 分钟", a.duration_min),
                            format!("{} 分钟", row.end - row.start),
                        ),
                    );
                }
            }
        }

        // ---- H08 时域 ----
        if row.start < t0 || row.end > t_end {
            out.push(
                Violation::new(
                    codes::H08_OUT_OF_HORIZON,
                    "H08",
                    format!("工序 '{}' 超出规划时域", op.operation_id),
                )
                .with_op(order.id.clone(), op.operation_id.clone())
                .with_time(op.start_at.clone())
                .with_expected_actual(
                    format!(
                        "落在 {} 至 {} 内",
                        problem.meta.horizon_start, problem.meta.horizon_end
                    ),
                    format!("{} 至 {}", op.start_at, op.end_at),
                ),
            );
        }

        // ---- H02 投放时间 ----
        if row.start < order.release_min {
            out.push(
                Violation::new(
                    codes::H02_RELEASE,
                    "H02",
                    format!(
                        "工序 '{}' 早于订单 '{}' 的投放时间开工",
                        op.operation_id, order.id
                    ),
                )
                .with_op(order.id.clone(), op.operation_id.clone())
                .with_time(op.start_at.clone())
                .with_expected_actual(
                    format!("≥ {}", order.release_at),
                    op.start_at.clone(),
                ),
            );
        }

        // ---- H03 能力 + H04 机器日历 ----
        if let Some(m) = machine_by_id.get(op.machine_id.as_str()) {
            if !m.capabilities.iter().any(|c| c == &spec.skill) {
                out.push(
                    Violation::new(
                        codes::H03_MACHINE_CAPABILITY,
                        "H03",
                        format!(
                            "机器 '{}' 的能力集不含工序所需能力 '{}'",
                            op.machine_id, spec.skill
                        ),
                    )
                    .with_op(order.id.clone(), op.operation_id.clone())
                    .with_resource(op.machine_id.clone()),
                );
            }
            check_calendar(
                &mut out,
                &m.available,
                &m.blocked,
                row.start,
                row.end,
                codes::H04_MACHINE_CALENDAR,
                codes::H04_MACHINE_BLOCKED,
                "H04",
                "机器",
                &op.machine_id,
                order,
                op,
            );
        } else {
            out.push(
                Violation::new(
                    codes::H03_MACHINE_NOT_ALLOWED,
                    "H03",
                    format!("方案引用了不存在的机器 '{}'", op.machine_id),
                )
                .with_op(order.id.clone(), op.operation_id.clone())
                .with_resource(op.machine_id.clone()),
            );
        }

        // ---- H05 人员 ----
        match worker_by_id.get(op.worker_id.as_str()) {
            None => {
                out.push(
                    Violation::new(
                        codes::H05_WORKER_UNKNOWN,
                        "H05",
                        format!("方案引用了不存在的人员 '{}'", op.worker_id),
                    )
                    .with_op(order.id.clone(), op.operation_id.clone())
                    .with_resource(op.worker_id.clone()),
                );
            }
            Some(w) => {
                if !w.skills.iter().any(|s| s == &spec.skill) {
                    out.push(
                        Violation::new(
                            codes::H05_WORKER_SKILL,
                            "H05",
                            format!(
                                "人员 '{}' 不具备工序所需技能 '{}'",
                                op.worker_id, spec.skill
                            ),
                        )
                        .with_op(order.id.clone(), op.operation_id.clone())
                        .with_resource(op.worker_id.clone())
                        .with_expected_actual(
                            format!("技能含 {}", spec.skill),
                            format!("技能集 {:?}", w.skills),
                        ),
                    );
                }
                let missing: Vec<String> = spec
                    .qualifications
                    .iter()
                    .filter(|q| !w.qualifications.iter().any(|wq| wq == *q))
                    .cloned()
                    .collect();
                if !missing.is_empty() {
                    out.push(
                        Violation::new(
                            codes::H05_WORKER_QUALIFICATION,
                            "H05",
                            format!(
                                "人员 '{}' 缺少工序所需资格 {:?}",
                                op.worker_id, missing
                            ),
                        )
                        .with_op(order.id.clone(), op.operation_id.clone())
                        .with_resource(op.worker_id.clone())
                        .with_detail("missing_qualifications", Json::strings(missing)),
                    );
                }
                check_calendar(
                    &mut out,
                    &w.available,
                    &w.blocked,
                    row.start,
                    row.end,
                    codes::H04_WORKER_CALENDAR,
                    codes::H04_WORKER_BLOCKED,
                    "H04",
                    "人员",
                    &op.worker_id,
                    order,
                    op,
                );
            }
        }

        // ---- H06 工装 ----
        let expect_tools: Vec<String> = {
            let mut v = spec.tools.clone();
            v.sort();
            v
        };
        let mut actual_tools = op.tool_ids.clone();
        actual_tools.sort();
        if expect_tools != actual_tools {
            out.push(
                Violation::new(
                    codes::H06_TOOL_ASSIGNMENT,
                    "H06",
                    format!(
                        "工序 '{}' 的工装分配与需求不一致",
                        op.operation_id
                    ),
                )
                .with_op(order.id.clone(), op.operation_id.clone())
                .with_expected_actual(
                    format!("{:?}", expect_tools),
                    format!("{:?}", actual_tools),
                ),
            );
        }
        for t in op.tool_ids.iter() {
            if !tool_ids.contains(&t.as_str()) {
                out.push(
                    Violation::new(
                        codes::H06_UNKNOWN_TOOL,
                        "H06",
                        format!("方案引用了不存在的工装 '{}'", t),
                    )
                    .with_op(order.id.clone(), op.operation_id.clone())
                    .with_resource(t.clone()),
                );
            }
        }

        // ---- H02 工艺依赖 ----
        for pred in spec.predecessors.iter() {
            match seen.get(pred.as_str()) {
                None => out.push(
                    Violation::new(
                        codes::H02_MISSING_PREDECESSOR,
                        "H02",
                        format!("工序 '{}' 的前置工序 '{}' 未排入方案", op.operation_id, pred),
                    )
                    .with_op(order.id.clone(), op.operation_id.clone()),
                ),
                Some(_) => {
                    if let Some(prow) = rows.iter().find(|r| &r.op.operation_id == pred) {
                        if row.start < prow.end {
                            out.push(
                                Violation::new(
                                    codes::H02_PRECEDENCE,
                                    "H02",
                                    format!(
                                        "工序 '{}' 早于前置工序 '{}' 完工（{} < {}）",
                                        op.operation_id, pred, op.start_at, prow.op.end_at
                                    ),
                                )
                                .with_op(order.id.clone(), op.operation_id.clone())
                                .with_time(op.start_at.clone())
                                .with_expected_actual(
                                    format!("≥ {}", prow.op.end_at),
                                    op.start_at.clone(),
                                ),
                            );
                        }
                    }
                }
            }
        }
    }

    // ---- 资源排他（机器 / 人员 / 工装）----
    {
        let machine_entries: Vec<(&str, i64, i64, &str, &str)> = rows
            .iter()
            .map(|r| {
                (
                    r.op.machine_id.as_str(),
                    r.start,
                    r.end,
                    r.op.operation_id.as_str(),
                    r.order.id.as_str(),
                )
            })
            .collect();
        overlap_scan(
            &mut out,
            machine_entries,
            codes::H03_MACHINE_OVERLAP,
            "H03",
            "机器",
        );
        let worker_entries: Vec<(&str, i64, i64, &str, &str)> = rows
            .iter()
            .map(|r| {
                (
                    r.op.worker_id.as_str(),
                    r.start,
                    r.end,
                    r.op.operation_id.as_str(),
                    r.order.id.as_str(),
                )
            })
            .collect();
        overlap_scan(
            &mut out,
            worker_entries,
            codes::H05_WORKER_OVERLAP,
            "H05",
            "人员",
        );
    }
    {
        // 工装：一件工装同一时间只允许分配给一道工序
        let mut by_tool: BTreeMap<&str, Vec<(i64, i64, &str, &str)>> = BTreeMap::new();
        for r in rows.iter() {
            for t in r.op.tool_ids.iter() {
                by_tool
                    .entry(t.as_str())
                    .or_default()
                    .push((r.start, r.end, r.op.operation_id.as_str(), r.op.order_id.as_str()));
            }
        }
        for (tool, mut list) in by_tool {
            list.sort_by_key(|x| (x.0, x.1));
            for i in 1..list.len() {
                if list[i].0 < list[i - 1].1 {
                    out.push(
                        Violation::new(
                            codes::H06_TOOL_OVERLAP,
                            "H06",
                            format!(
                                "工装 '{}' 被工序 '{}' 与 '{}' 同时占用",
                                tool, list[i - 1].2, list[i].2
                            ),
                        )
                        .with_op(list[i].3.to_string(), list[i].2.to_string())
                        .with_resource(tool.to_string())
                        .with_detail(
                            "conflict_with",
                            Json::str(list[i - 1].2.to_string()),
                        ),
                    );
                }
            }
        }
    }

    // ---- H07 物料时序平衡（独立实现：同一时刻先入库、后领料）----
    for mat in problem.materials.iter() {
        let mut events: Vec<(i64, u8, i64, Option<&str>)> = Vec::new();
        for r in mat.receipts.iter() {
            events.push((r.at_min, 0, r.quantity, None));
        }
        for row in rows.iter() {
            for (mid, qty) in row.spec.materials.iter() {
                if mid == &mat.id {
                    events.push((row.start, 1, *qty, Some(row.op.operation_id.as_str())));
                }
            }
        }
        events.sort_by_key(|e| (e.0, e.1));
        let mut stock = mat.initial_quantity;
        for (t, kind, qty, op_id) in events {
            if kind == 0 {
                stock += qty;
            } else {
                stock -= qty;
                if stock < 0 {
                    out.push(
                        Violation::new(
                            codes::H07_STOCK_NEGATIVE,
                            "H07",
                            format!(
                                "物料 '{}' 在工序 '{}' 开工时刻透支（余额 {}）",
                                mat.id,
                                op_id.unwrap_or("?"),
                                stock
                            ),
                        )
                        .with_op(
                            op_id
                                .and_then(|id| op_by_id.get(id))
                                .map(|(o, _)| o.id.clone())
                                .unwrap_or_default(),
                            op_id.unwrap_or("").to_string(),
                        )
                        .with_resource(mat.id.clone())
                        .with_time(crate::datetime::format_iso8601(
                            t,
                            problem.meta.offset_min,
                        ))
                        .with_expected_actual("余额 ≥ 0", format!("余额 {}", stock)),
                    );
                    break; // 每物料只报告首个透支点，避免噪声
                }
            }
        }
        let _ = h;
    }

    // ---- 物料引用存在性 ----
    for row in rows.iter() {
        for (mid, _) in row.spec.materials.iter() {
            if !mat_by_id.contains_key(mid.as_str()) {
                out.push(
                    Violation::new(
                        codes::H07_UNKNOWN_MATERIAL,
                        "H07",
                        format!("问题引用了不存在的物料 '{}'", mid),
                    )
                    .with_op(row.order.id.clone(), row.op.operation_id.clone())
                    .with_resource(mid.clone()),
                );
            }
        }
    }

    out
}

#[allow(clippy::too_many_arguments)]
fn check_calendar(
    out: &mut Vec<Violation>,
    available: &[RawInterval],
    blocked: &[RawInterval],
    start: i64,
    end: i64,
    code_calendar: &str,
    code_blocked: &str,
    constraint: &str,
    kind: &str,
    resource_id: &str,
    order: &crate::model::RawOrder,
    op: &SolutionOp,
) {
    let inside = available
        .iter()
        .any(|w| w.start_min <= start && end <= w.end_min);
    if !inside {
        out.push(
            Violation::new(
                code_calendar,
                constraint,
                format!(
                    "工序 '{}' 的占用区间未完整落在{} '{}' 的任何一条连续可用窗口内（不可抢占 / 不得跨越班次空档）",
                    op.operation_id, kind, resource_id
                ),
            )
            .with_op(order.id.clone(), op.operation_id.clone())
            .with_resource(resource_id.to_string())
            .with_time(op.start_at.clone())
            .with_expected_actual("完整落在一条 available 窗口内", format!("{} 至 {}", op.start_at, op.end_at)),
        );
    }
    for b in blocked.iter() {
        if start < b.end_min && b.start_min < end {
            out.push(
                Violation::new(
                    code_blocked,
                    constraint,
                    format!(
                        "工序 '{}' 与{} '{}' 的停工区间重叠{}",
                        op.operation_id,
                        kind,
                        resource_id,
                        b.reason
                            .as_ref()
                            .map(|r| format!("（原因：{}）", r))
                            .unwrap_or_default()
                    ),
                )
                .with_op(order.id.clone(), op.operation_id.clone())
                .with_resource(resource_id.to_string())
                .with_time(op.start_at.clone())
                .with_detail(
                    "blocked",
                    Json::obj(vec![
                        ("start", Json::str(b.start.clone())),
                        ("end", Json::str(b.end.clone())),
                    ]),
                ),
            );
        }
    }
}

/// 资源排他扫描：同一资源上的占用区间两两不重叠。
fn overlap_scan(
    out: &mut Vec<Violation>,
    entries: Vec<(&str, i64, i64, &str, &str)>,
    code: &str,
    constraint: &str,
    kind_cn: &str,
) {
    let mut by_res: BTreeMap<&str, Vec<(i64, i64, &str, &str)>> = BTreeMap::new();
    for (res, s, e, op_id, order_id) in entries {
        by_res.entry(res).or_default().push((s, e, op_id, order_id));
    }
    for (res, mut list) in by_res {
        list.sort_by_key(|x| (x.0, x.1));
        for i in 1..list.len() {
            if list[i].0 < list[i - 1].1 {
                out.push(
                    Violation::new(
                        code,
                        constraint,
                        format!(
                            "{} '{}' 被工序 '{}' 与 '{}' 同时占用（重叠至 {}）",
                            kind_cn, res, list[i - 1].2, list[i].2, list[i - 1].1
                        ),
                    )
                    .with_op(list[i].3.to_string(), list[i].2.to_string())
                    .with_resource(res.to_string())
                    .with_detail("conflict_with", Json::str(list[i - 1].2.to_string())),
                );
            }
        }
    }
}

/// 时间解析辅助：字符串 → 绝对分钟。
pub fn parse_minutes(text: &str) -> Option<i64> {
    parse_iso8601(text).ok().map(|d| d.epoch_min)
}
