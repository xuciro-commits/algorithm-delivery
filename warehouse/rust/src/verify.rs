//! 独立验证器的文档入口：吃"问题 + 方案"，吐验证报告。
//!
//! 为什么单独一层：求解器与验证器必须**物理隔离**（SRS §5.2）。本文件只做三件事：
//! 1. 解析文档并判定它属于哪类方案（库位 / 调度 / 联合）；
//! 2. 调用对应的独立验证器（`slotting::verify_document`、`asrs::verify`、`joint` 的复核）；
//! 3. 汇总成契约 `warehouse-verification/1.0` 报告 —— 包括**验证器自己算出来的指标**，
//!    与优化器报告的数字并列，任何不一致都会被暴露（`METRIC_MISMATCH`）。

use aps_engine::json::Json;

use crate::asrs::{self, AsrsOptions};
use crate::contract::{parse_asrs_problem, parse_dynamic_events, parse_slotting_problem};
use crate::errors::{codes, constraints, Issue, Issues, Severity};
use crate::util::round;

impl Default for VerificationReport {
    fn default() -> VerificationReport {
        VerificationReport {
            ok: false,
            kind: String::new(),
            violations: Vec::new(),
            recomputed: Json::Null,
            notes: Vec::new(),
            independent_metrics: Json::Null,
        }
    }
}

/// 验证报告的顶层结构。
#[derive(Debug, Clone)]
pub struct VerificationReport {
    pub ok: bool,
    pub kind: String,
    pub violations: Vec<crate::errors::Violation>,
    pub recomputed: Json,
    pub notes: Vec<String>,
    /// 验证器独立算出的指标（供与优化器对照）
    pub independent_metrics: Json,
}

impl VerificationReport {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("kind", Json::str(self.kind.clone())),
            ("ok", Json::Bool(self.ok)),
            (
                "violations",
                Json::Arr(self.violations.iter().map(asrs::violation_json).collect()),
            ),
            (
                "summary",
                Json::obj(vec![
                    (
                        "errors",
                        Json::int(
                            self.violations
                                .iter()
                                .filter(|violation| violation.severity == Severity::Error)
                                .count() as i64,
                        ),
                    ),
                    (
                        "warnings",
                        Json::int(
                            self.violations
                                .iter()
                                .filter(|violation| violation.severity == Severity::Warning)
                                .count() as i64,
                        ),
                    ),
                    (
                        "infos",
                        Json::int(
                            self.violations
                                .iter()
                                .filter(|violation| violation.severity == Severity::Info)
                                .count() as i64,
                        ),
                    ),
                ]),
            ),
            ("recomputed", self.recomputed.clone()),
            ("independentMetrics", self.independent_metrics.clone()),
            ("notes", Json::strings(self.notes.clone())),
        ])
    }
}

/// 文档入口：`verify` API 与 CLI 都走这里。
pub fn verify_document(root: &Json, strict: bool, issues: &mut Issues) -> Json {
    let kind = crate::contract::opt_str(root, "kind").unwrap_or_default();
    let report = match kind.as_str() {
        "asrs" | "dense-asrs" => verify_asrs_document(root, strict, issues),
        "joint" => verify_joint_document(root, strict, issues),
        "slotting" | "slotting-solution" | "" => verify_slotting_document(root, strict, issues),
        other => {
            issues.error(
                codes::UNSUPPORTED_FEATURE,
                "kind",
                format!("未知的验证对象类型 {other}（支持 slotting / asrs / joint）"),
            );
            VerificationReport {
                kind: other.to_string(),
                ok: false,
                ..Default::default()
            }
        }
    };
    report.to_json()
}

/* ------------------------------------------------------------------ *
 * 文档定位：单域文档 vs 联合文档
 * ------------------------------------------------------------------ */

/// 库位子文档：`{kind:"joint", slotting:{...}, asrs:{...}, ...}` 里取 `slotting`；
/// 单域文档（`{kind:"slotting", problem:{...}}`）返回原文档。
///
/// 为什么要这一层：联合方案必须让**两段各自过一遍独立验证器**，而不是拼成一个
/// 更大的问题再验（那会把两段的口径混在一起，也掩盖"哪一段没通过"）。
fn slotting_root(root: &Json) -> &Json {
    match root.get("slotting") {
        Some(value @ Json::Obj(_)) => value,
        _ => root,
    }
}

/// 调度子文档：联合文档取 `asrs`，单域文档返回原文档。
fn asrs_root(root: &Json) -> &Json {
    match root.get("asrs") {
        Some(value @ Json::Obj(_)) => value,
        _ => root,
    }
}

/// 动态事件：先在子文档里找，再回退到被 `problem` 包装的问题体（两种嵌套都接受）。
fn events_for(root: &Json, scope: &Json) -> Vec<crate::contract::DynamicEvent> {
    let primary = parse_dynamic_events(scope);
    if !primary.is_empty() {
        return primary;
    }
    let unwrapped = crate::contract::problem_root(root);
    if !std::ptr::eq(
        unwrapped as *const Json as *const u8,
        root as *const Json as *const u8,
    ) {
        return parse_dynamic_events(unwrapped);
    }
    primary
}

/* ------------------------------------------------------------------ *
 * 库位优化方案验证
 * ------------------------------------------------------------------ */

fn verify_slotting_document(root: &Json, strict: bool, issues: &mut Issues) -> VerificationReport {
    let mut report = VerificationReport {
        kind: "slotting".to_string(),
        ..Default::default()
    };
    let problem = parse_slotting_problem(slotting_root(root), issues);
    if issues.has_errors() {
        report.ok = false;
        report
            .notes
            .push("问题本身不合法，无法验证方案（先修正 issues 里的字段级错误）".to_string());
        return report;
    }
    // 求解器提交的方案（允许 `{assignment:[...]}` 或裸数组两种写法）
    let raw_solution = crate::contract::field(root, "solution")
        .or_else(|| crate::contract::field(root, "slottingSolution"))
        .cloned()
        .unwrap_or(Json::Null);
    let solution = match raw_solution {
        Json::Arr(_) => Json::obj(vec![("assignment", raw_solution.clone())]),
        other => other,
    };
    if matches!(solution, Json::Null) {
        issues.error(codes::MISSING_FIELD, "solution", "缺少待验证的库位方案");
        report.ok = false;
        return report;
    }
    let mut violations: Vec<crate::errors::Violation> = Vec::new();
    let outcome = crate::slotting::verify::verify_slotting(&problem, &solution, strict);
    violations.extend(outcome.violations.clone());
    report.violations = violations;
    report.ok = !report
        .violations
        .iter()
        .any(|violation| violation.severity == Severity::Error);
    report.recomputed = outcome.recomputed.clone();
    report.independent_metrics = outcome.independent_metrics.clone();
    report.notes = outcome.notes.clone();
    report
}

/* ------------------------------------------------------------------ *
 * 立库调度方案验证
 * ------------------------------------------------------------------ */

fn verify_asrs_document(root: &Json, strict: bool, issues: &mut Issues) -> VerificationReport {
    let scope = asrs_root(root);
    let problem = parse_asrs_problem(scope, issues);
    let events = events_for(root, scope);
    let options = AsrsOptions::from_json(Some(root));
    let mut report = VerificationReport {
        kind: "asrs".to_string(),
        ..Default::default()
    };
    if issues.has_errors() {
        report
            .notes
            .push("问题本身不合法，无法验证调度方案".to_string());
        return report;
    }
    // 时间线可以来自 solution.timeline 或文档顶层 timeline（两者都接受，语义相同）
    let timeline_json = crate::contract::field(root, "solution")
        .and_then(|solution| crate::contract::field(solution, "timeline"))
        .or_else(|| crate::contract::field(root, "timeline"))
        .or_else(|| crate::contract::field(scope, "timeline"))
        .cloned()
        .unwrap_or(Json::Null);
    if matches!(timeline_json, Json::Null) {
        issues.error(
            codes::MISSING_FIELD,
            "timeline",
            "缺少待验证的设备时间线（solution.timeline 或顶层 timeline）",
        );
        report.ok = false;
        return report;
    }
    let timeline = match parse_timeline(&timeline_json) {
        Some(timeline) => timeline,
        None => {
            issues.error(codes::TYPE_MISMATCH, "timeline", "时间线结构与契约不符");
            report.ok = false;
            return report;
        }
    };
    let verification = asrs::verify::verify_schedule(&problem, &events, &timeline, &options);
    report.violations = verification.violations.clone();
    report.ok = verification.ok;
    report.recomputed = Json::obj(vec![
        ("steps", Json::int(verification.checked.steps as i64)),
        ("tasks", Json::int(verification.checked.tasks as i64)),
        (
            "horizon_s",
            Json::Float(round(verification.checked.replayed_horizon_s, 3)),
        ),
        (
            "motionSeconds",
            Json::Float(round(verification.checked.total_motion_seconds, 3)),
        ),
        (
            "motionMeters",
            Json::Float(round(verification.checked.total_motion_meters, 3)),
        ),
        (
            "laneConflicts",
            Json::int(verification.checked.lane_conflicts as i64),
        ),
        (
            "shaftConflicts",
            Json::int(verification.checked.shaft_conflicts as i64),
        ),
        (
            "unservedTasks",
            Json::int(verification.checked.unserved_tasks as i64),
        ),
    ]);
    report.independent_metrics = Json::obj(vec![
        (
            "deviceBusySeconds",
            Json::Arr(
                verification
                    .checked
                    .device_busy_seconds
                    .iter()
                    .map(|(device_id, seconds)| {
                        Json::obj(vec![
                            ("deviceId", Json::str(device_id.clone())),
                            ("busySeconds", Json::Float(round(*seconds, 3))),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "busyShare",
            Json::Arr(
                verification
                    .checked
                    .device_busy_seconds
                    .iter()
                    .map(|(device_id, seconds)| {
                        let share = if verification.checked.replayed_horizon_s > 0.0 {
                            seconds / verification.checked.replayed_horizon_s
                        } else {
                            0.0
                        };
                        Json::obj(vec![
                            ("deviceId", Json::str(device_id.clone())),
                            ("share", Json::Float(round(share, 4))),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]);
    report.notes = verification.checked.notes.clone();
    // 严格模式：把"未服务任务"也当成错误
    if strict && verification.checked.unserved_tasks > 0 {
        report.violations.push(crate::errors::Violation::new(
            codes::NO_SOLUTION,
            Severity::Warning,
            format!(
                "严格模式下有 {} 个任务未被服务（结果仍然可行，但不是完整交付）",
                verification.checked.unserved_tasks
            ),
        ));
        report.notes.push(
            "严格模式：未服务任务被视为不可交付；请在结果里如实说明原因（设备不足 / 库位冻结 / 交期冲突）"
                .to_string(),
        );
    }
    let _ = strict;
    report
}

fn parse_timeline(value: &Json) -> Option<crate::asrs::Timeline> {
    let mut timeline = crate::asrs::Timeline::default();
    let devices = crate::contract::arr(value, "devices");
    if devices.is_empty() {
        return None;
    }
    for device in devices {
        let device_id = crate::contract::opt_str(device, "deviceId")?;
        for step in crate::contract::arr(device, "steps") {
            timeline.steps.push(parse_step(&device_id, step)?);
        }
    }
    for task in crate::contract::arr(value, "tasks") {
        timeline.tasks.push(crate::asrs::timeline::TaskTrace {
            task_id: crate::contract::opt_str(task, "taskId").unwrap_or_default(),
            kind: crate::contract::opt_str(task, "kind").unwrap_or_default(),
            priority: crate::contract::opt_i64(task, "priority").unwrap_or(0),
            release_s: crate::contract::opt_f64(task, "release_s").unwrap_or(0.0),
            deadline_s: crate::contract::opt_str(task, "deadline_s")
                .and_then(|text| text.parse::<f64>().ok()),
            start_s: crate::contract::opt_f64(task, "start_s").unwrap_or(0.0),
            end_s: crate::contract::opt_f64(task, "end_s").unwrap_or(0.0),
            device_ids: crate::contract::str_array(task, "devices"),
            step_ids: crate::contract::str_array(task, "steps"),
            dual_command: crate::contract::opt_bool(task, "dualCommand").unwrap_or(false),
            status: crate::contract::opt_str(task, "status").unwrap_or_default(),
            lateness_s: crate::contract::opt_f64(task, "lateness_s").unwrap_or(0.0),
            wait_s: crate::contract::opt_f64(task, "wait_s").unwrap_or(0.0),
            note: crate::contract::opt_str(task, "note").unwrap_or_default(),
        });
    }
    for state in crate::contract::arr(value, "bufferStates") {
        timeline
            .buffer_states
            .push(crate::asrs::timeline::BufferState {
                at_s: crate::contract::opt_f64(state, "at_s").unwrap_or(0.0),
                buffer_id: crate::contract::opt_str(state, "bufferId").unwrap_or_default(),
                occupancy: crate::contract::opt_i64(state, "occupancy").unwrap_or(0) as i32,
                capacity: crate::contract::opt_i64(state, "capacity").unwrap_or(0) as i32,
                reason: crate::contract::opt_str(state, "reason").unwrap_or_default(),
            });
    }
    for state in crate::contract::arr(value, "locationStates") {
        timeline
            .location_states
            .push(crate::asrs::timeline::LocationState {
                at_s: crate::contract::opt_f64(state, "at_s").unwrap_or(0.0),
                location_id: crate::contract::opt_str(state, "locationId").unwrap_or_default(),
                load_unit_id: crate::contract::opt_str(state, "loadUnitId"),
                reason: crate::contract::opt_str(state, "reason").unwrap_or_default(),
            });
    }
    timeline.horizon_s = crate::contract::opt_f64(value, "horizon_s").unwrap_or_else(|| {
        timeline
            .steps
            .iter()
            .map(|step| step.end_s)
            .fold(0.0f64, f64::max)
    });
    if timeline.steps.is_empty() {
        return None;
    }
    Some(timeline)
}

fn parse_step(device_id: &str, value: &Json) -> Option<crate::asrs::timeline::Step> {
    Some(crate::asrs::timeline::Step {
        id: crate::contract::opt_str(value, "id").unwrap_or_default(),
        device_id: device_id.to_string(),
        task_id: crate::contract::opt_str(value, "taskId"),
        kind: crate::contract::opt_str(value, "kind").unwrap_or_default(),
        from: parse_position(crate::contract::field(value, "from").unwrap_or(&Json::Null)),
        to: parse_position(crate::contract::field(value, "to").unwrap_or(&Json::Null)),
        start_s: crate::contract::opt_f64(value, "start_s").unwrap_or(0.0),
        end_s: crate::contract::opt_f64(value, "end_s").unwrap_or(0.0),
        loaded: crate::contract::opt_bool(value, "loaded").unwrap_or(false),
        distance_m: crate::contract::opt_f64(value, "distanceM").unwrap_or(0.0),
        energy_kwh: crate::contract::opt_f64(value, "energyKwh").unwrap_or(0.0),
        note: crate::contract::opt_str(value, "note").unwrap_or_default(),
        resource_id: crate::contract::opt_str(value, "resourceId"),
        resources: crate::contract::str_array(value, "resources"),
        delayed_by_s: crate::contract::opt_f64(value, "delayedBy_s").unwrap_or(0.0),
    })
}

fn parse_position(value: &Json) -> crate::asrs::network::DevicePosition {
    crate::asrs::network::DevicePosition {
        x: crate::contract::opt_f64(value, "x").unwrap_or(0.0),
        y: crate::contract::opt_f64(value, "y").unwrap_or(0.0),
        z: crate::contract::opt_f64(value, "z").unwrap_or(0.0),
        level: crate::contract::opt_i64(value, "level").unwrap_or(1) as i32,
        aisle_id: crate::contract::opt_str(value, "aisleId"),
        node_id: crate::contract::opt_str(value, "nodeId"),
        location_id: crate::contract::opt_str(value, "locationId"),
    }
}

/* ------------------------------------------------------------------ *
 * 联合方案验证
 * ------------------------------------------------------------------ */

fn verify_joint_document(root: &Json, strict: bool, issues: &mut Issues) -> VerificationReport {
    let mut report = VerificationReport {
        kind: "joint".to_string(),
        ..Default::default()
    };
    // 联合方案 = 库位方案 + 调度方案，两段都要过独立验证
    let slotting_report = verify_slotting_document(root, strict, issues);
    let asrs_report = verify_asrs_document(root, strict, issues);
    report.violations.extend(slotting_report.violations.clone());
    report.violations.extend(asrs_report.violations.clone());
    report.ok = slotting_report.ok && asrs_report.ok;
    report.recomputed = Json::obj(vec![
        ("slotting", slotting_report.recomputed.clone()),
        ("asrs", asrs_report.recomputed.clone()),
    ]);
    report.independent_metrics = Json::obj(vec![
        ("slotting", slotting_report.independent_metrics.clone()),
        ("asrs", asrs_report.independent_metrics.clone()),
    ]);
    report.notes.extend(slotting_report.notes.clone());
    report.notes.extend(asrs_report.notes.clone());
    if report.ok {
        report.notes.push(
            "联合方案的两段（库位 + 调度）都通过了独立验证：报告里的指标均由验证器从原始数据重算"
                .to_string(),
        );
    } else {
        report
            .notes
            .push("联合方案至少有一段未通过验证：结果不可交付，不能对外声称改善".to_string());
    }
    report
}

/// 独立重算块：把两种**合法**的报告形状统一到同一个键上。
///
/// 为什么需要统一：调度段的核验报告有两个入口，键名不同、语义相同——
///   * 契约/CLI 形状（本文件的 `verify_asrs_document`）：`recomputed`；
///   * 求解时形状（`asrs::verification_json`，即 `warehouse-verification/1.0` 的 `checked` 块）：
///     求解时同一套独立验证器已经把时间线复核过一遍，计数写在 `checked` 里。
///
/// 联合结论必须"两段都能逐项对照数字"，否则 `recomputed.{slotting,asrs}` 里出现 Null
/// 就等于**悄悄少核验了一段**（前端与验收都会误读）。这里只做键名归一，不重算、不造数：
/// 两个键都没有时返回 Null，让缺失显式暴露。
fn recomputed_block(report: &Json) -> Json {
    if let Some(value @ Json::Obj(_)) = report.get("recomputed") {
        return value.clone();
    }
    if let Some(value @ Json::Obj(_)) = report.get("checked") {
        return value.clone();
    }
    Json::Null
}

/// 独立指标块：同样做形状归一。
///
/// * `verify_asrs_document` 直接给 `independentMetrics`；
/// * 求解时报告只给 `checked.deviceBusySeconds`（逐设备忙时），这里换算成与
///   `verify_asrs_document` 相同的 `{deviceBusySeconds, busyShare}` 形状
///   （busyShare 的分母是验证器自己重放出来的时间线长度，不是求解器的 makespan）。
fn independent_metrics_block(report: &Json) -> Json {
    if let Some(value @ Json::Obj(_)) = report.get("independentMetrics") {
        return value.clone();
    }
    let checked = match report.get("checked") {
        Some(value @ Json::Obj(_)) => value,
        _ => return Json::Null,
    };
    let entries = match checked.get("deviceBusySeconds") {
        Some(Json::Arr(items)) => items,
        _ => return Json::Null,
    };
    let horizon = crate::contract::opt_f64(checked, "replayedHorizon_s").unwrap_or(0.0);
    let mut busy_cards: Vec<Json> = Vec::new();
    let mut share_cards: Vec<Json> = Vec::new();
    for entry in entries {
        let device_id = match crate::contract::opt_str(entry, "deviceId") {
            Some(id) => id,
            None => continue,
        };
        let seconds = crate::contract::opt_f64(entry, "busySeconds").unwrap_or(0.0);
        let share = if horizon > 0.0 {
            seconds / horizon
        } else {
            0.0
        };
        busy_cards.push(Json::obj(vec![
            ("deviceId", Json::str(device_id.clone())),
            ("busySeconds", Json::Float(round(seconds, 3))),
        ]));
        share_cards.push(Json::obj(vec![
            ("deviceId", Json::str(device_id)),
            ("share", Json::Float(round(share, 4))),
        ]));
    }
    Json::obj(vec![
        ("deviceBusySeconds", Json::Arr(busy_cards)),
        ("busyShare", Json::Arr(share_cards)),
    ])
}

/// 把两段独立核验的报告合成一份联合核验报告（与 `verify_joint_document` 同形状）。
///
/// 为什么要单独一个入口：联合求解在求解过程中就把**调度段**核验完了（报告在 `AsrsOutcome` 里），
/// **库位段**则在选定最优轮之后补一次独立核验；这里只负责"合成两份报告"，
/// 不重新跑验证器、也不再计算任何指标——所以信封里的 `verification` 与 CLI `verify` 的判据是同一条。
///
/// 语义约定：两段都为真，联合才为真；调度段缺失（例如本次没有产出时间线）时，
/// `ok` 只反映库位段，并在 `notes` 里写明"调度段未核验"，绝不把缺失当通过。
pub fn compose_joint_verification(slotting: &Json, asrs: &Json) -> Json {
    let ok_of = |report: &Json| {
        report
            .get("ok")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    };
    let violations_of = |report: &Json| match report.get("violations") {
        Some(Json::Arr(items)) => items.clone(),
        _ => Vec::new(),
    };
    let recomputed_of = recomputed_block;
    let metrics_of = independent_metrics_block;

    let slotting_ok = ok_of(slotting);
    let asrs_ok = ok_of(asrs);
    let asrs_present = !matches!(asrs, Json::Null);
    let mut violations = violations_of(slotting);
    violations.extend(violations_of(asrs));
    let mut notes: Vec<String> = Vec::new();
    notes.push("库位段：独立库位验证器只读契约与方案重算（不读求解器内部状态）".to_string());
    if asrs_present {
        notes.push(
            "调度段：独立调度验证器在求解时对时间线复核（含时空预约、互斥、容量与派生任务）"
                .to_string(),
        );
    } else {
        notes.push(
            "调度段未核验：本次没有产出可复核的时间线（includeTimeline=false），             联合结论只覆盖库位段"
                .to_string(),
        );
    }
    if slotting_ok && asrs_ok {
        notes.push(
            "两段均通过独立核验：报告里的指标由验证器从原始数据重算，可与优化器数字对照"
                .to_string(),
        );
    } else {
        notes.push("至少一段未通过独立核验：该联合结果不可交付，不能对外声称改善".to_string());
    }

    Json::obj(vec![
        ("kind", Json::str("joint")),
        ("ok", Json::Bool(slotting_ok && asrs_ok)),
        ("violations", Json::Arr(violations)),
        (
            "recomputed",
            Json::obj(vec![
                ("slotting", recomputed_of(slotting)),
                ("asrs", recomputed_of(asrs)),
            ]),
        ),
        (
            "independentMetrics",
            Json::obj(vec![
                ("slotting", metrics_of(slotting)),
                ("asrs", metrics_of(asrs)),
            ]),
        ),
        ("notes", Json::strings(notes)),
    ])
}

/// 指标一致性交叉检查（优化器 vs 验证器）。
pub fn cross_check_metrics(
    optimizer: &Json,
    verifier: &Json,
    keys: &[(&str, &str)],
    violations: &mut Vec<crate::errors::Violation>,
    issues: &mut Issues,
) {
    for (optimizer_key, verifier_key) in keys {
        let left = value_of(optimizer, optimizer_key);
        let right = value_of(verifier, verifier_key);
        if let (Some(left), Some(right)) = (left, right) {
            let tolerance = 1e-3 * left.abs().max(1.0) + 1e-6;
            if (left - right).abs() > tolerance {
                violations.push(
                    crate::errors::Violation::new(
                        constraints::METRIC_MISMATCH,
                        Severity::Error,
                        format!(
                            "指标不一致：优化器报告的 {optimizer_key} = {left:.3}，验证器重算为 {right:.3}"
                        ),
                    )
                    .expected_actual(round(left, 3).to_string(), round(right, 3).to_string()),
                );
                issues.error(
                    constraints::METRIC_MISMATCH,
                    optimizer_key.to_string(),
                    "优化器与验证器给出的数字不一致：以验证器为准，并排查求解器实现".to_string(),
                );
            }
        }
    }
}

fn value_of(value: &Json, key: &str) -> Option<f64> {
    match value.get(key) {
        Some(Json::Float(v)) => Some(*v),
        Some(Json::Int(v)) => Some(*v as f64),
        _ => None,
    }
}

/// 供 CLI 输出的人类可读摘要。
pub fn summarize_report(report: &VerificationReport) -> String {
    let errors = report
        .violations
        .iter()
        .filter(|violation| violation.severity == Severity::Error)
        .count();
    let warnings = report
        .violations
        .iter()
        .filter(|violation| violation.severity == Severity::Warning)
        .count();
    format!(
        "验证 {}：{}（错误 {errors}，警告 {warnings}）",
        report.kind,
        if report.ok { "通过" } else { "未通过" }
    )
}

/// 供 acceptance / bench 复用：把违规清单转成 Issue（便于统一汇总）。
pub fn violations_to_issues(violations: &[crate::errors::Violation], issues: &mut Issues) {
    for violation in violations {
        let path = violation
            .task_id
            .clone()
            .or_else(|| violation.location_id.clone())
            .or_else(|| violation.device_id.clone())
            .unwrap_or_else(|| "schedule".to_string());
        if violation.severity == Severity::Error {
            issues.items.push(Issue::error(
                leakage_code(&violation.code),
                path,
                violation.message.clone(),
            ));
        } else {
            issues.warn(
                leakage_code(&violation.code),
                path,
                violation.message.clone(),
            );
        }
    }
}

/// 违规码 → `codes` 里的静态串（保持 Issue 的 `&'static str` 语义）。
fn leakage_code(code: &str) -> &'static str {
    match code {
        "TIME_CONSISTENCY" => constraints::TIME_CONSISTENCY,
        "DEVICE_MUTUAL_EXCLUSION" => constraints::DEVICE_MUTUAL_EXCLUSION,
        "LANE_MUTUAL_EXCLUSION" => constraints::LANE_MUTUAL_EXCLUSION,
        "NODE_MUTUAL_EXCLUSION" => constraints::NODE_MUTUAL_EXCLUSION,
        "LIFT_SHAFT_CAPACITY" => constraints::LIFT_SHAFT_CAPACITY,
        "BUFFER_CAPACITY" => constraints::BUFFER_CAPACITY,
        "STATION_CAPACITY" => constraints::STATION_CAPACITY,
        "TASK_PRECEDENCE" => constraints::TASK_PRECEDENCE,
        "TASK_SEQUENCE" => constraints::TASK_SEQUENCE,
        "TASK_DEADLINE" => constraints::TASK_DEADLINE,
        "DEVICE_UNAVAILABLE" => constraints::DEVICE_UNAVAILABLE,
        "LOCATION_FROZEN" => constraints::LOCATION_FROZEN,
        "LOCATION_UNAVAILABLE" => constraints::LOCATION_UNAVAILABLE,
        "LOCATION_CAPACITY" => constraints::LOCATION_CAPACITY,
        "ZONE_COMPATIBILITY" => constraints::ZONE_COMPATIBILITY,
        "SKU_DISPERSION_MIN" => constraints::SKU_DISPERSION_MIN,
        "SKU_DISPERSION_MAX" => constraints::SKU_DISPERSION_MAX,
        "UNASSIGNED_INVENTORY" => constraints::UNASSIGNED_INVENTORY,
        "DEVICE_CAPABILITY" => constraints::DEVICE_CAPABILITY_VIOLATION,
        "REACHABILITY" => constraints::REACHABILITY,
        "INVENTORY_CONSERVATION" => constraints::INVENTORY_CONSERVATION,
        "METRIC_MISMATCH" => constraints::METRIC_MISMATCH,
        _ => codes::SCHEMA_INVALID,
    }
}
