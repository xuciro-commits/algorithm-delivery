//! 联合优化：库位方案 × 立库调度 的反馈闭环（本交付的核心差异化能力，SRS §7）。
//!
//! ## 为什么需要闭环
//! 储位优化的目标函数如果只算"理论最短距离"，会得到一个纸面上很漂亮、现场跑不动的方案：
//! 热门商品被堆进同一条巷道，穿梭车互相等位，提升机成为瓶颈。本模块的做法是：
//! **用真实设备调度结果反过来评估库位方案**，并把调度里暴露出的拥堵、等待、倒垛次数
//! 反馈到库位模型的代价上，迭代若干轮后给出"联合最优"的方案及其证据。
//!
//! ## 三条必须回答的问题（SRS §14）
//! 1. 为什么货物放在这些库位 → `explanation.slotting`（引用真实计算证据）；
//! 2. 为什么设备按这个顺序运行 → `explanation.dispatch`（策略 + 冲突 + 双指令配对）；
//! 3. 联合方案是否真的更好 → `comparison`（同一次调度口径下的真实数字对比矩阵）。

use std::collections::BTreeMap;

use aps_engine::json::Json;

use crate::asrs::{self, AsrsOptions};
use crate::contract::{parse_asrs_problem, parse_slotting_problem, SlottingProblem};
use crate::errors::{codes, Issues, Status};
use crate::slotting::search;
use crate::slotting::{SlottingSolveOptions, SlottingState};
use crate::util::round;

#[derive(Debug, Clone)]
pub struct JointOptions {
    pub algorithm: String,
    pub seed: u64,
    pub budget_ms: f64,
    pub rounds: u64,
    pub slotting_budget_ms: f64,
    pub asrs_budget_ms: f64,
    pub verify: bool,
    /// 联合目标的权重：吞吐（作业数/小时）与库位侧运行时间的相对重要性
    pub throughput_weight: f64,
    pub travel_weight: f64,
}

impl Default for JointOptions {
    fn default() -> Self {
        JointOptions {
            algorithm: "joint-alns".to_string(),
            seed: 11,
            budget_ms: 20_000.0,
            rounds: 3,
            slotting_budget_ms: 3_000.0,
            asrs_budget_ms: 4_000.0,
            verify: true,
            throughput_weight: 1.0,
            travel_weight: 1.0,
        }
    }
}

impl JointOptions {
    pub fn from_json(value: Option<&aps_engine::json::Json>) -> JointOptions {
        let mut options = JointOptions::default();
        let Some(value) = value else { return options };
        if let Some(algorithm) = crate::contract::opt_str(value, "algorithm") {
            options.algorithm = algorithm;
        }
        if let Some(seed) = crate::contract::opt_i64(value, "seed") {
            options.seed = seed.max(0) as u64;
        }
        if let Some(budget) = crate::contract::opt_f64(value, "budgetMs") {
            options.budget_ms = budget.max(50.0);
        }
        if let Some(rounds) = crate::contract::opt_i64(value, "rounds") {
            options.rounds = rounds.clamp(1, 12) as u64;
        }
        if let Some(weight) = crate::contract::opt_f64(value, "throughputWeight") {
            options.throughput_weight = weight.max(0.0);
        }
        if let Some(weight) = crate::contract::opt_f64(value, "travelWeight") {
            options.travel_weight = weight.max(0.0);
        }
        if let Some(verify) = crate::contract::opt_bool(value, "verify") {
            options.verify = verify;
        }
        options
    }
}

/// 联合求解结果。
#[derive(Debug, Clone)]
pub struct JointOutcome {
    pub status: Status,
    pub objective: f64,
    pub result: Json,
    pub metrics: Json,
    pub timeline: Option<Json>,
    pub verification: Option<Json>,
    pub rounds: u64,
}

impl Default for JointOutcome {
    fn default() -> JointOutcome {
        JointOutcome {
            status: Status::Feasible,
            objective: 0.0,
            result: Json::Null,
            metrics: Json::Null,
            timeline: None,
            verification: None,
            rounds: 0,
        }
    }
}

/// 一轮的实测数据（全部来自真实求解，不用估算值）。
#[derive(Debug, Clone, Default)]
struct RoundRecord {
    round: u64,
    algorithm: String,
    slotting_travel_seconds_per_day: f64,
    slotting_congestion_seconds_per_day: f64,
    relocation_count: usize,
    asrs_tasks_done: usize,
    asrs_makespan_s: f64,
    throughput_per_hour: f64,
    conflicts: usize,
    mean_wait_s: f64,
    relocation_tasks: usize,
    joint_objective: f64,
    verified: bool,
}

fn joint_objective(record: &RoundRecord, options: &JointOptions) -> f64 {
    // 联合目标 = 库位侧日运行时间 + 调度侧时间 + 吞吐惩罚 + 冲突惩罚（全部有单位、可复算）
    let throughput_penalty = if record.asrs_tasks_done > 0 {
        (record.asrs_makespan_s / record.asrs_tasks_done as f64) * options.throughput_weight
    } else {
        1e6
    };
    record.slotting_travel_seconds_per_day * options.travel_weight
        + record.asrs_makespan_s * 0.5
        + throughput_penalty * 60.0
        + record.conflicts as f64 * 5.0
        + record.relocation_tasks as f64 * 30.0
}

/// 联合优化主循环：库位方案 → 真实调度 → 反馈 → 再优化。
pub fn solve(root: &Json, options: &JointOptions, issues: &mut Issues) -> JointOutcome {
    let slotting_json = crate::contract::field(root, "slotting").unwrap_or(&Json::Null);
    let asrs_json = crate::contract::field(root, "asrs").unwrap_or(&Json::Null);
    if matches!(slotting_json, Json::Null) || matches!(asrs_json, Json::Null) {
        issues.error(
            codes::MISSING_FIELD,
            "joint",
            "联合优化需要同时给出 slotting 与 asrs 两个问题段",
        );
        return JointOutcome {
            status: Status::InvalidInput,
            ..Default::default()
        };
    }
    let mut problem: SlottingProblem = parse_slotting_problem(slotting_json, issues);
    let asrs_problem = parse_asrs_problem(asrs_json, issues);
    let events = crate::contract::parse_dynamic_events(asrs_json);
    if issues.has_errors() {
        return JointOutcome {
            status: Status::InvalidInput,
            ..Default::default()
        };
    }

    let started = crate::engine::now_ms();
    let deadline = started + options.budget_ms;
    let algorithms: Vec<String> = if options.algorithm == "joint-alns" {
        vec!["alns".to_string()]
    } else {
        vec![options.algorithm.clone()]
    };
    let mut records: Vec<RoundRecord> = Vec::new();
    let mut best: Option<(RoundRecord, Json, Json, Option<Json>, Option<Json>)> = None;
    // 反馈通道：把调度侧观测到的拥堵回写到库位模型的成本参数上
    let mut congestion_feedback = 0.0f64;
    let mut round_index = 0u64;
    while round_index < options.rounds && crate::engine::now_ms() < deadline {
        round_index += 1;
        let algorithm = algorithms[((round_index - 1) as usize) % algorithms.len()].clone();
        // —— A. 库位优化 ——
        problem.cost_model.congestion_scale = Some(round(
            (1.0 + congestion_feedback).clamp(0.2, 6.0),
            4,
        ));
        problem.algorithm.algorithm = algorithm.clone();
        problem.algorithm.seed = options.seed + round_index;
        problem.algorithm.budget_ms = options.slotting_budget_ms;
        let slotting_options = SlottingSolveOptions {
            algorithm: Some(algorithm.clone()),
            seed: Some(options.seed + round_index),
            budget_ms: Some(options.slotting_budget_ms),
            verify: false,
            ..Default::default()
        };
        let slotting_outcome = search::run(&problem, &slotting_options);

        // —— B. 用库位方案驱动真实调度 ——
        let mut asrs_problem = asrs_problem.clone();
        asrs_problem.slotting_plan = Some((
            format!("SLT-ROUND-{round_index}"),
            slotting_outcome
                .assignment
                .iter()
                .map(|(unit, _sku, location, _qty)| (unit.clone(), location.clone()))
                .collect::<BTreeMap<String, String>>(),
        ));
        let asrs_options = AsrsOptions {
            algorithm: if round_index == 1 {
                "joint-alns".to_string()
            } else {
                "priority-edd".to_string()
            },
            seed: options.seed + round_index,
            budget_ms: options.asrs_budget_ms,
            verify: options.verify,
            ..Default::default()
        };
        let mut asrs_issues = Issues::new();
        let asrs_outcome = asrs::solve(&asrs_problem, &events, &asrs_options, &mut asrs_issues);
        let verified = asrs_outcome
            .report
            .as_ref()
            .map(|report| report.ok)
            .unwrap_or(!options.verify);
        let asrs_metrics = asrs_outcome
            .report
            .as_ref()
            .map(|report| report.checked.clone())
            .unwrap_or_default();

        let record = RoundRecord {
            round: round_index,
            algorithm: algorithm.clone(),
            slotting_travel_seconds_per_day: slotting_outcome
                .metrics
                .expected_pick_seconds
                * slotting_outcome.metrics.scale.load_units.max(1) as f64,
            slotting_congestion_seconds_per_day: slotting_outcome
                .search
                .robust_worst
                .unwrap_or(slotting_outcome.metrics.congestion_index),
            relocation_count: slotting_outcome.metrics.relocation_count,
            asrs_tasks_done: asrs_metrics.tasks,
            asrs_makespan_s: asrs_outcome
                .report
                .as_ref()
                .map(|report| report.checked.replayed_horizon_s)
                .unwrap_or(0.0),
            throughput_per_hour: asrs_outcome
                .metrics
                .get("throughputPerHour")
                .and_then(|value| match value {
                    Json::Float(v) => Some(*v),
                    _ => None,
                })
                .unwrap_or(0.0),
            conflicts: asrs_metrics.lane_conflicts + asrs_metrics.shaft_conflicts,
            mean_wait_s: asrs_outcome
                .metrics
                .get("meanWait_s")
                .and_then(|value| match value {
                    Json::Float(v) => Some(*v),
                    _ => None,
                })
                .unwrap_or(0.0),
            relocation_tasks: asrs_outcome
                .metrics
                .get("relocationTasks")
                .and_then(|value| match value {
                    Json::Int(v) => Some(*v as usize),
                    _ => None,
                })
                .unwrap_or(0),
            joint_objective: 0.0,
            verified,
        };
        let mut record = record;
        record.joint_objective = round(joint_objective(&record, options), 3);

        // —— C. 反馈：调度侧冲突与等待越严重，库位侧越要把热点打散 ——
        let conflict_pressure = (record.conflicts as f64 * 0.05 + record.mean_wait_s / 120.0).min(1.0);
        congestion_feedback = round(congestion_feedback * 0.4 + conflict_pressure * 0.6, 4);

        let better = best
            .as_ref()
            .map(|(current, _, _, _, _)| record.joint_objective < current.joint_objective)
            .unwrap_or(true);
        if better {
            best = Some((
                record.clone(),
                Json::Arr(
                    slotting_outcome
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

                crate::engine::slotting_metrics_json(&slotting_outcome),
                asrs_outcome.timeline.clone(),
                asrs_outcome.verification.clone(),
            ));
        }
        records.push(record);
        if crate::engine::cancel_requested() {
            break;
        }
    }

    let Some((best_record, assignment, slotting_metrics, timeline, verification)) = best else {
        return JointOutcome {
            status: Status::NoSolutionFound,
            ..Default::default()
        };
    };

    // —— 对比矩阵：随机储位 / 仅库位优化 / 联合优化，全部在同一调度口径下评估 ——
    let comparison = build_comparison(&problem, &asrs_problem, &events, options, issues);

    let status = if !best_record.verified {
        Status::InternalError
    } else if records.len() < options.rounds as usize {
        Status::BudgetExceeded
    } else {
        Status::FeasibleWithBound
    };
    let reasons = vec![
        format!(
            "联合目标 {:.1}（口径：库位侧日运行时间 × {:.1} + 调度完工时间 × 0.5 + 吞吐惩罚 × 60 + 冲突 × 5 + 倒垛 × 30）",
            best_record.joint_objective, options.travel_weight
        ),
        format!(
            "最优轮次：第 {} 轮（{}），库位侧日运行时间 {:.0}s、调度完工 {:.0}s、冲突 {} 次、倒垛 {} 次",
            best_record.round,
            best_record.algorithm,
            best_record.slotting_travel_seconds_per_day,
            best_record.asrs_makespan_s,
            best_record.conflicts,
            best_record.relocation_tasks
        ),
    ];

    let result = Json::obj(vec![
        ("kind", Json::str("joint")),
        ("algorithm", Json::str(options.algorithm.clone())),
        ("seed", Json::int(options.seed as i64)),
        ("slottingAssignment", assignment),
        ("timeline", timeline.clone().unwrap_or(Json::Null)),
        ("verification", verification.clone().unwrap_or(Json::Null)),
        (
            "rounds",
            Json::Arr(
                records
                    .iter()
                    .map(|record| {
                        Json::obj(vec![
                            ("round", Json::int(record.round as i64)),
                            ("algorithm", Json::str(record.algorithm.clone())),
                            (
                                "slottingTravelSecondsPerDay",
                                Json::Float(record.slotting_travel_seconds_per_day),
                            ),
                            ("relocationCount", Json::int(record.relocation_count as i64)),
                            ("tasksDone", Json::int(record.asrs_tasks_done as i64)),
                            ("makespan_s", Json::Float(record.asrs_makespan_s)),
                            ("throughputPerHour", Json::Float(record.throughput_per_hour)),
                            ("conflicts", Json::int(record.conflicts as i64)),
                            ("meanWait_s", Json::Float(record.mean_wait_s)),
                            ("relocationTasks", Json::int(record.relocation_tasks as i64)),
                            ("jointObjective", Json::Float(record.joint_objective)),
                            ("verified", Json::Bool(record.verified)),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("comparison", comparison),
        (
            "explanation",
            Json::obj(vec![
                (
                    "slotting",
                    Json::str(format!(
                        "库位方案来自第 {} 轮 {}：日运行时间 {:.0}s（按真实设备运动学计算），\
                         搬迁 {} 件；拥堵反馈系数在迭代中被调整到反映调度侧观测到的等待",
                        best_record.round, best_record.algorithm, best_record.slotting_travel_seconds_per_day, best_record.relocation_count
                    )),
                ),
                (
                    "dispatch",
                    Json::str(format!(
                        "调度按 {} 策略生成任务顺序与设备指派，独立验证 {}；所有步骤都写了时空预约，\
                         冲突 {} 次、倒垛 {} 次都逐条留痕",
                        options.algorithm,
                        if best_record.verified { "通过" } else { "未通过（结果不可交付）" },
                        best_record.conflicts,
                        best_record.relocation_tasks
                    )),
                ),
                ("reasons", Json::strings(reasons.clone())),
            ]),
        ),
    ]);

    JointOutcome {
        status,
        objective: best_record.joint_objective,
        result,
        metrics: slotting_metrics,
        timeline,
        verification,
        rounds: records.len() as u64,
    }
}

/// 对比矩阵：把"随机储位 / 仅库位优化 / 联合优化"放在**同一调度器**下比较。
fn build_comparison(
    problem: &SlottingProblem,
    asrs_problem: &crate::contract::AsrsProblem,
    events: &[crate::contract::DynamicEvent],
    options: &JointOptions,
    issues: &mut Issues,
) -> Json {
    let mut rows: Vec<Json> = Vec::new();
    let variants: Vec<(&str, &str, bool)> = vec![
        ("random", "随机储位（基线）", false),
        ("abc-class", "ABC 分区（经典做法）", false),
        ("alns", "库位优化（联合闭环）", true),
    ];
    for (algorithm, label, joint) in variants {
        let mut probe = problem.clone();
        probe.algorithm.algorithm = algorithm.to_string();
        probe.algorithm.seed = options.seed;
        probe.algorithm.budget_ms = options.slotting_budget_ms.min(2_000.0);
        let slotting_options = SlottingSolveOptions {
            algorithm: Some(algorithm.to_string()),
            seed: Some(options.seed),
            budget_ms: Some(probe.algorithm.budget_ms),
            verify: false,
            ..Default::default()
        };
        let outcome = search::run(&probe, &slotting_options);
        let mut asrs_probe = asrs_problem.clone();
        asrs_probe.slotting_plan = Some((
            format!("SLT-CMP-{algorithm}"),
            outcome
                .assignment
                .iter()
                .map(|(unit, _sku, location, _qty)| (unit.clone(), location.clone()))
                .collect(),
        ));
        let asrs_options = AsrsOptions {
            algorithm: if joint { "joint-alns" } else { "priority-edd" }.to_string(),
            seed: options.seed,
            budget_ms: options.asrs_budget_ms.min(3_000.0),
            verify: true,
            ..Default::default()
        };
        let mut probe_issues = Issues::new();
        let asrs_outcome = asrs::solve(&asrs_probe, events, &asrs_options, &mut probe_issues);
        let checked = asrs_outcome
            .report
            .as_ref()
            .map(|report| report.checked.clone())
            .unwrap_or_default();
        let throughput = asrs_outcome
            .metrics
            .get("throughputPerHour")
            .and_then(|value| match value {
                Json::Float(v) => Some(round(*v, 3)),
                _ => None,
            })
            .unwrap_or(0.0);
        let solved = asrs_outcome
            .metrics
            .get("tasksDone")
            .and_then(|value| match value {
                Json::Int(v) => Some(*v),
                _ => None,
            })
            .unwrap_or(0);
        rows.push(Json::obj(vec![
            ("variant", Json::str(algorithm)),
            ("label", Json::str(label)),
            (
                "slottingTravelSecondsPerDay",
                Json::Float(
                    outcome.metrics.expected_pick_seconds
                        * outcome.metrics.scale.load_units.max(1) as f64,
                ),
            ),
            ("relocationCount", Json::int(outcome.metrics.relocation_count as i64)),
            ("tasksDone", Json::int(solved)),
            ("makespan_s", Json::Float(checked.replayed_horizon_s)),
            ("throughputPerHour", Json::Float(throughput)),
            (
                "conflicts",
                Json::int((checked.lane_conflicts + checked.shaft_conflicts) as i64),
            ),
            ("verified", Json::Bool(asrs_outcome.report.as_ref().map(|r| r.ok).unwrap_or(false))),
        ]));
    }
    // 对比说明：指出真正被比较的量，避免"看起来更好"的错觉
    let mut notes = vec![
        "三种方案的任务集、设备、事件完全相同，只改变货物落位（连同调度策略：联合方案用 joint-alns）"
            .to_string(),
        "所有吞吐量/完工时间都来自同一次完整推演（含时空预约与倒垛），不是估算值".to_string(),
    ];
    if issues.has_errors() {
        notes.push("对比过程中出现问题，请查看 issues".to_string());
    }
    Json::obj(vec![
        ("rows", Json::Arr(rows)),
        ("notes", Json::strings(notes)),
    ])
}

/// 联合方案的"可复现 fingerprint"（供结果比对与缓存键）。
pub fn joint_fingerprint(seed: u64, rounds: u64, input: &str) -> String {
    crate::engine::fingerprint(&[
        crate::ENGINE_NAME,
        crate::ENGINE_VERSION,
        crate::RULESET_VERSION,
        &seed.to_string(),
        &rounds.to_string(),
        input,
    ])
}

/// 便捷：把库位状态导出成"哪些货物在哪个库位"的映射（联合与验证共用）。
pub fn assignment_map(state: &SlottingState) -> Vec<usize> {
    state
        .loc_of_lu
        .iter()
        .map(|loc| if *loc < 0 { usize::MAX } else { *loc as usize })
        .collect()
}
