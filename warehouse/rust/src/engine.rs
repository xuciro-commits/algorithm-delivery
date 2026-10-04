//! 求解引擎的门面：时间/取消、指纹、结果与指标 JSON、顶层调度（CLI 与 wasm 共用）。
//!
//! 约定（与 aps / mapf / agv 一致）：
//! * 结果 JSON 一旦生成即**冻结**（同一输入 + 同一 seed + 同一版本 → 逐字节可比）；
//! * 所有时间来自 `aps_engine::clock::now_ms()`（wasm 下由宿主注入），不依赖 std::time；
//! * 取消是"协作式"的：搜索循环检查标志，返回**当前最好解**并把 violated 状态标为 CANCELLED。

use std::sync::atomic::{AtomicBool, Ordering};

use aps_engine::json::Json;

use crate::contract::{
    parse_asrs_problem, parse_dynamic_events, parse_slotting_problem, AsrsProblem, SlottingProblem,
};
use crate::errors::{codes, Issues, Status};
use crate::slotting::{search, SlottingOutcome, SlottingSolveOptions};

pub const ENGINE_NAME: &str = crate::ENGINE_NAME;
pub const ENGINE_VERSION: &str = crate::ENGINE_VERSION;

static CANCELLED: AtomicBool = AtomicBool::new(false);

pub fn now_ms() -> f64 {
    aps_engine::clock::now_ms()
}

pub fn cancel_requested() -> bool {
    CANCELLED.load(Ordering::Relaxed)
}

pub fn cancel() {
    CANCELLED.store(true, Ordering::Relaxed);
}

pub fn reset_cancel() {
    CANCELLED.store(false, Ordering::Relaxed);
}

/// 输入指纹：同一问题 + 同一选项 → 同一指纹（用于结果复现与缓存校验）。
pub fn fingerprint(parts: &[&str]) -> String {
    let mut buffer = Vec::new();
    for part in parts {
        buffer.extend_from_slice(part.as_bytes());
        buffer.push(0x1f);
    }
    aps_engine::hash::sha256_hex(&buffer)
}

pub fn short_hash(value: &str, length: usize) -> String {
    value.chars().take(length).collect()
}

/* ------------------------------------------------------------------ *
 * 结果 JSON
 * ------------------------------------------------------------------ */

/// 平台无关的"问题求解信封"：结果 + 指标 + 验证报告（由 engine 统一组装）。
#[derive(Debug, Clone)]
pub struct Envelope {
    pub result: Json,
    pub metrics: Json,
    pub timeline: Option<Json>,
    pub verification: Option<Json>,
    pub status: Status,
    pub objective: f64,
    pub issues: Issues,
    pub fingerprint: String,
    pub runtime_ms: f64,
}

impl Default for Envelope {
    fn default() -> Envelope {
        Envelope {
            result: Json::Null,
            metrics: Json::Null,
            timeline: None,
            verification: None,
            status: Status::Feasible,
            objective: 0.0,
            issues: Issues::new(),
            fingerprint: String::new(),
            runtime_ms: 0.0,
        }
    }
}

impl Envelope {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("status", Json::str(self.status.as_str())),
            ("engine", Json::str(ENGINE_NAME)),
            ("engineVersion", Json::str(ENGINE_VERSION)),
            ("rulesetVersion", Json::str(crate::RULESET_VERSION)),
            ("fingerprint", Json::str(self.fingerprint.clone())),
            ("runtimeMs", Json::Float(crate::util::round(self.runtime_ms, 3))),
            ("objective", Json::Float(crate::util::round(self.objective, 6))),
            ("result", self.result.clone()),
            ("metrics", self.metrics.clone()),
            (
                "timeline",
                self.timeline.clone().unwrap_or(Json::Null),
            ),
            (
                "verification",
                self.verification.clone().unwrap_or(Json::Null),
            ),
            ("issues", self.issues.to_json()),
        ])
    }
}

/// 把库位优化结果序列化成契约形态（`warehouse-slotting-solution/1.0`）。
pub fn slotting_solution_json(outcome: &SlottingOutcome) -> Json {
    Json::obj(vec![
        ("status", Json::str(outcome.status.as_str())),
        ("algorithm", Json::str(outcome.algorithm.clone())),
        ("seed", Json::int(outcome.seed as i64)),
        ("optimalityProven", Json::Bool(outcome.optimality_proven)),
        (
            "assignment",
            Json::Arr(
                outcome
                    .assignment
                    .iter()
                    .map(|(unit, sku, location, quantity)| {
                        Json::obj(vec![
                            ("loadUnitId", Json::str(unit.clone())),
                            ("skuId", Json::str(sku.clone())),
                            ("locationId", Json::str(location.clone())),
                            ("quantity", Json::Float(*quantity)),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "unassigned",
            Json::Arr(
                outcome
                    .unassigned
                    .iter()
                    .map(|(unit, sku, reason)| {
                        Json::obj(vec![
                            ("loadUnitId", Json::str(unit.clone())),
                            ("skuId", Json::str(sku.clone())),
                            ("reason", Json::str(reason.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "migrationPlan",
            Json::obj(vec![
                (
                    "tasks",
                    Json::Arr(
                        outcome
                            .migrations
                            .iter()
                            .filter(|action| action.requires_dispatch)
                            .map(migration_json)
                            .collect(),
                    ),
                ),
                (
                    "suggestions",
                    Json::Arr(
                        outcome
                            .migrations
                            .iter()
                            .filter(|action| !action.requires_dispatch)
                            .map(migration_json)
                            .collect(),
                    ),
                ),
                (
                    "tasksTotal",
                    Json::int(
                        outcome
                            .migrations
                            .iter()
                            .filter(|action| action.requires_dispatch)
                            .count() as i64,
                    ),
                ),
                (
                    "suggestionsTotal",
                    Json::int(
                        outcome
                            .migrations
                            .iter()
                            .filter(|action| !action.requires_dispatch)
                            .count() as i64,
                    ),
                ),
            ]),
        ),
        ("comparison", outcome.comparison.clone()),
        (
            "search",
            Json::obj(vec![
                ("iterations", Json::int(outcome.search.iterations as i64)),
                ("restarts", Json::int(outcome.search.restarts as i64)),
                ("bestIteration", Json::int(outcome.search.best_iteration as i64)),
                (
                    "trace",
                    Json::Arr(outcome.search.trace.iter().map(|v| Json::Float(*v)).collect()),
                ),
                (
                    "operators",
                    Json::Arr(
                        outcome
                            .search
                            .operators_used
                            .iter()
                            .map(|(name, count)| {
                                Json::obj(vec![
                                    ("name", Json::str(name.clone())),
                                    ("count", Json::int(*count as i64)),
                                ])
                            })
                            .collect(),
                    ),
                ),
                ("elapsedMs", Json::Float(outcome.search.elapsed_ms)),
                ("cancelled", Json::Bool(outcome.search.cancelled)),
            ]),
        ),
        (
            "explanation",
            Json::Arr(
                outcome
                    .explanations
                    .iter()
                    .map(|(topic, text, facts)| {
                        Json::obj(vec![
                            ("topic", Json::str(topic.clone())),
                            ("text", Json::str(text.clone())),
                            (
                                "evidence",
                                Json::Obj(facts.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "pareto",
            Json::Arr(
                outcome
                    .pareto
                    .iter()
                    .map(|point| {
                        Json::Obj(
                            point
                                .iter()
                                .map(|(k, v)| (k.clone(), Json::Float(*v)))
                                .collect(),
                        )
                    })
                    .collect(),
            ),
        ),
        ("budgetExceeded", Json::Bool(outcome.budget_exceeded)),
    ])
}

fn migration_json(action: &crate::slotting::MigrationAction) -> Json {
    Json::obj(vec![
        ("loadUnitId", Json::str(action.load_unit_id.clone())),
        ("skuId", Json::str(action.sku_id.clone())),
        (
            "fromLocationId",
            Json::opt_str(action.from_location_id.clone()),
        ),
        ("toLocationId", Json::str(action.to_location_id.clone())),
        ("reason", Json::str(action.reason.clone())),
        (
            "estimatedDeviceSeconds",
            Json::Float(action.estimated_device_seconds),
        ),
        ("estimatedEnergyKwh", Json::Float(action.estimated_energy_kwh)),
        (
            "trigger",
            match &action.trigger {
                Some((kind, at_s, detail)) => Json::obj(vec![
                    ("kind", Json::str(kind.clone())),
                    ("at_s", Json::Float(*at_s)),
                    ("detail", Json::str(detail.clone())),
                ]),
                None => Json::Null,
            },
        ),
        ("mode", Json::str(action.mode.to_string())),
    ])
}

/// 指标 JSON（与结果分开发送：面板既显示总数也能逐项目悬停看口径）。
pub fn slotting_metrics_json(outcome: &SlottingOutcome) -> Json {
    let metrics = &outcome.metrics;
    Json::obj(vec![
        (
            "spaceUtilization",
            Json::Float(crate::util::round(metrics.space_utilization, 6)),
        ),
        (
            "effectiveUtilization",
            Json::Float(crate::util::round(metrics.effective_utilization, 6)),
        ),
        (
            "expectedPickSeconds",
            Json::Float(metrics.expected_pick_seconds),
        ),
        ("expectedPutSeconds", Json::Float(metrics.expected_put_seconds)),
        (
            "affinityCoherence",
            Json::Float(metrics.affinity_coherence),
        ),
        ("aisleLoadGini", Json::Float(metrics.aisle_load_gini)),
        ("liftPeakRatio", Json::Float(metrics.lift_peak_ratio)),
        ("congestionIndex", Json::Float(metrics.congestion_index)),
        ("relocationCount", Json::int(metrics.relocation_count as i64)),
        (
            "relocationDeviceSeconds",
            Json::Float(metrics.relocation_device_seconds),
        ),
        ("unmetConstraints", Json::int(metrics.unmet_constraints as i64)),
        ("computeMs", Json::Float(metrics.compute_ms)),
        (
            "stability",
            match metrics.stability {
                Some(value) => Json::Float(value),
                None => Json::Null,
            },
        ),
        (
            "stabilitySeeds",
            Json::Arr(
                metrics
                    .stability_seeds
                    .iter()
                    .map(|(seed, value)| {
                        Json::obj(vec![
                            ("seed", Json::int(*seed as i64)),
                            ("objective", Json::Float(*value)),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "objectives",
            Json::Arr(
                metrics
                    .objectives
                    .iter()
                    .map(|objective| {
                        Json::obj(vec![
                            ("id", Json::str(objective.id.clone())),
                            ("direction", Json::str(objective.direction.clone())),
                            ("unit", Json::str(objective.unit.clone())),
                            ("weight", Json::Float(objective.weight)),
                            ("raw", Json::Float(objective.raw)),
                            ("normalized", Json::Float(objective.normalized)),
                            (
                                "conflictsWith",
                                Json::strings(objective.conflicts_with.clone()),
                            ),
                            ("note", Json::str(objective.note.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("scale", scale_json(&metrics.scale)),
    ])
}

pub fn scale_json(scale: &crate::slotting::ScaleReport) -> Json {
    Json::obj(vec![
        ("skus", Json::int(scale.skus as i64)),
        ("locations", Json::int(scale.locations as i64)),
        ("loadUnits", Json::int(scale.load_units as i64)),
        ("orders", Json::int(scale.orders as i64)),
        ("assignments", Json::int(scale.assignments as i64)),
        ("tasks", Json::int(scale.tasks as i64)),
        ("devices", Json::int(scale.devices as i64)),
        ("events", Json::int(scale.events as i64)),
        ("note", Json::str(scale.note.clone())),
    ])
}

/* ------------------------------------------------------------------ *
 * 顶层 API（CLI / wasm 共用）
 * ------------------------------------------------------------------ */

/// 求解库位优化：输入是契约 JSON 字符串，输出是信封 JSON。
pub fn solve_slotting(input: &str, options_json: Option<&str>) -> (String, Status) {
    let mut issues = Issues::new();
    let root = match aps_engine::json::parse(input) {
        Ok(value) => value,
        Err(error) => {
            issues.error(
                codes::SCHEMA_INVALID,
                "$",
                format!("输入不是合法 JSON：{error:?}"),
            );
            let envelope = Envelope {
                status: Status::InvalidInput,
                issues,
                ..Default::default()
            };
            return (envelope.to_json().canonical(), Status::InvalidInput);
        }
    };
    let problem: SlottingProblem = parse_slotting_problem(&root, &mut issues);
    let options = options_json
        .and_then(|text| aps_engine::json::parse(text).ok())
        .map(|value| SlottingSolveOptions {
            algorithm: crate::contract::opt_str(&value, "algorithm"),
            seed: crate::contract::opt_i64(&value, "seed").map(|v| v.max(0) as u64),
            budget_ms: crate::contract::opt_f64(&value, "budgetMs")
                .or_else(|| crate::contract::opt_f64(&value, "budget_ms")),
            max_iterations: crate::contract::opt_i64(&value, "maxIterations")
                .map(|v| v.max(1) as u64),
            verify: crate::contract::opt_bool(&value, "verify").unwrap_or(true),
            temperature: crate::contract::opt_f64(&value, "temperature"),
            tabu_tenure: crate::contract::opt_i64(&value, "tabuTenure").map(|v| v.max(0) as u64),
            seeds: crate::contract::num_array(&value, "seeds")
                .into_iter()
                .map(|v| v.max(0.0) as u64)
                .collect(),
        })
        .unwrap_or_default();
    let started = now_ms();
    reset_cancel();
    let outcome = search::run(&problem, &options);
    let fingerprint = fingerprint(&[
        ENGINE_NAME,
        ENGINE_VERSION,
        crate::RULESET_VERSION,
        &problem.dataset_version,
        &outcome.algorithm,
        &outcome.seed.to_string(),
        input,
    ]);
    let mut issues = issues;
    for issue in outcome.issues.items.iter() {
        issues.items.push(issue.clone());
    }
    let envelope = Envelope {
        result: slotting_solution_json(&outcome),
        metrics: slotting_metrics_json(&outcome),
        timeline: None,
        verification: None,
        status: outcome.status,
        objective: outcome
            .metrics
            .objectives
            .first()
            .map(|objective| objective.raw)
            .unwrap_or(0.0),
        issues,
        fingerprint,
        runtime_ms: now_ms() - started,
    };
    let text = envelope.to_json().canonical();
    (text, outcome.status)
}

/// 事件模拟 + 立库调度 + 联合优化的统一入口（`asrs` / `joint` 模块实现）。
pub fn solve_asrs(input: &str, options_json: Option<&str>) -> (String, Status) {
    let mut issues = Issues::new();
    let root = match aps_engine::json::parse(input) {
        Ok(value) => value,
        Err(error) => {
            issues.error(codes::SCHEMA_INVALID, "$", format!("输入不是合法 JSON：{error:?}"));
            let envelope = Envelope {
                status: Status::InvalidInput,
                issues,
                ..Default::default()
            };
            return (
                envelope.to_json().canonical(),
                Status::InvalidInput,
            );
        }
    };
    let problem: AsrsProblem = parse_asrs_problem(&root, &mut issues);
    let events = parse_dynamic_events(&root);
    let options = crate::asrs::AsrsOptions::from_json(
        options_json
            .and_then(|text| aps_engine::json::parse(text).ok())
            .as_ref(),
    );
    let started = now_ms();
    reset_cancel();
    let outcome = crate::asrs::solve(&problem, &events, &options, &mut issues);
    let fingerprint = fingerprint(&[
        ENGINE_NAME,
        ENGINE_VERSION,
        crate::RULESET_VERSION,
        &problem.dataset_version,
        &options.algorithm,
        &options.seed.to_string(),
        input,
    ]);
    let envelope = Envelope {
        result: outcome.result.clone(),
        metrics: outcome.metrics.clone(),
        timeline: outcome.timeline.clone(),
        verification: outcome.verification.clone(),
        status: outcome.status,
        objective: outcome.objective,
        issues,
        fingerprint,
        runtime_ms: now_ms() - started,
    };
    let text = envelope.to_json().canonical();
    (text, outcome.status)
}

/// 联合优化：库位方案 × 设备调度（反馈闭环）。
pub fn solve_joint(input: &str, options_json: Option<&str>) -> (String, Status) {
    let mut issues = Issues::new();
    let root = match aps_engine::json::parse(input) {
        Ok(value) => value,
        Err(error) => {
            issues.error(codes::SCHEMA_INVALID, "$", format!("输入不是合法 JSON：{error:?}"));
            let envelope = Envelope {
                status: Status::InvalidInput,
                issues,
                ..Default::default()
            };
            return (
                envelope.to_json().canonical(),
                Status::InvalidInput,
            );
        }
    };
    let options = crate::joint::JointOptions::from_json(
        options_json
            .and_then(|text| aps_engine::json::parse(text).ok())
            .as_ref(),
    );
    let started = now_ms();
    reset_cancel();
    let outcome = crate::joint::solve(&root, &options, &mut issues);
    let fingerprint = fingerprint(&[
        ENGINE_NAME,
        ENGINE_VERSION,
        crate::RULESET_VERSION,
        &options.seed.to_string(),
        input,
    ]);
    let envelope = Envelope {
        result: outcome.result.clone(),
        metrics: outcome.metrics.clone(),
        timeline: outcome.timeline.clone(),
        verification: outcome.verification.clone(),
        status: outcome.status,
        objective: outcome.objective,
        issues,
        fingerprint,
        runtime_ms: now_ms() - started,
    };
    let text = envelope.to_json().canonical();
    (text, outcome.status)
}

/// 独立验证入口：只吃"问题 + 方案"，绝不引用求解器内部状态。
pub fn verify(input: &str, options_json: Option<&str>) -> (String, Status) {
    let mut issues = Issues::new();
    let root = match aps_engine::json::parse(input) {
        Ok(value) => value,
        Err(error) => {
            issues.error(codes::SCHEMA_INVALID, "$", format!("输入不是合法 JSON：{error:?}"));
            return (
                Json::obj(vec![
                    ("ok", Json::Bool(false)),
                    ("status", Json::str("INVALID_INPUT")),
                    ("issues", issues.to_json()),
                ])
                .canonical(),
                Status::InvalidInput,
            );
        }
    };
    let strict = options_json
        .and_then(|text| aps_engine::json::parse(text).ok())
        .and_then(|value| crate::contract::opt_bool(&value, "strict"))
        .unwrap_or(true);
    let report = crate::verify::verify_document(&root, strict, &mut issues);
    let text = report.canonical();
    let ok = matches!(report.get("ok"), Some(Json::Bool(true)));
    let status = if ok {
        Status::Feasible
    } else {
        Status::NoSolutionFound
    };
    (text, status)
}
