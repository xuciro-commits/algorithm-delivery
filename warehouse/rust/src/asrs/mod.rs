//! 密集立库（AS/RS）调度：网络 / 时间线 / 求解 / 独立验证。
//!
//! 模块职责与数据流：
//! ```text
//!   problem + events ──► World（物理世界，事件先落地）
//!                            │
//!                            ├─► solver（排序 + 指派 + 逐步推演 + 冲突推迟 + 倒垛 + 重排）
//!                            │        └─► Timeline（设备轨迹 / 任务轨迹 / 状态变化）
//!                            │                 └─► metrics（全部可由时间线重算）
//!                            └─► verify（只读问题 + 时间线，独立重放并复核硬约束）
//! ```
//! 关键立场：**指标与时间线只能来自真实推演** —— 不写"理论最短距离"，也不给动画喂假数据。

pub mod network;
pub mod solver;
pub mod timeline;
pub mod verify;

use aps_engine::json::Json;

use crate::asrs::solver::ScheduleMetrics;
use crate::contract::{AsrsProblem, DynamicEvent};
use crate::errors::{codes, constraints, Issues, Status};
use crate::util::round;
use std::collections::BTreeMap;

pub use network::RunNetwork;
pub use solver::{describe, simulate, AsrsOptions, POLICIES};
pub use timeline::Timeline;
pub use verify::{violation_json, AsrsVerification};

/// 求解结果信封（与库位优化同一形状，便于 CLI/实验室统一处理）。
#[derive(Debug, Clone)]
pub struct AsrsOutcome {
    pub status: Status,
    pub objective: f64,
    pub result: Json,
    pub metrics: Json,
    pub timeline: Option<Json>,
    pub verification: Option<Json>,
    pub report: Option<AsrsVerification>,
}

impl Default for AsrsOutcome {
    fn default() -> AsrsOutcome {
        AsrsOutcome {
            status: Status::Feasible,
            objective: 0.0,
            result: Json::Null,
            metrics: Json::Null,
            timeline: None,
            verification: None,
            report: None,
        }
    }
}

/// engine 层调用的入口（与 `solve_with_verification` 同义，保留短名）。
pub fn solve(
    problem: &AsrsProblem,
    events: &[DynamicEvent],
    options: &AsrsOptions,
    issues: &mut Issues,
) -> AsrsOutcome {
    solve_with_verification(problem, events, options, issues)
}

/// 调度策略**支持矩阵**：契约里出现的旋钮必须真的起作用。
///
/// 立场（SRS §1.5）：引擎只实现了"时空预约 + 允许中途等待 + 动态事件先落地"这一套；
/// 契约里却带有 `conflictPolicy / allowYield / reschedulePolicy / crossLevelTransfer /
/// rollingHorizon_s / simulationHorizon_s` 这些策略位。给出**未实现的取值**时，
/// 引擎显式返回 `UNSUPPORTED` 并指出字段路径，而不是静默按默认策略求解——
/// 静默忽略会让"我配了 yield 策略"变成一句空话。
///
/// 返回被拒绝的字段数（>0 表示本次请求不可按声明语义执行）。
pub fn unsupported_policy_requests(
    problem: &AsrsProblem,
    options: &AsrsOptions,
    issues: &mut Issues,
) -> usize {
    const CONFLICT_POLICY: &str = "reservation";
    const RESCHEDULE_POLICY: &str = "preserve";
    const DEFAULT_ROLLING_HORIZON_S: f64 = 900.0;
    let mut bad = 0usize;
    let reject = |issues: &mut Issues, path: &str, value: String, supported: &str| {
        issues.error(
            codes::UNSUPPORTED_FEATURE,
            path,
            format!("引擎未实现该取值（{value}）；当前实现只支持 {supported}，请改用受支持取值或留空用默认值"),
        );
    };
    let dispatch = &problem.dispatch;
    if dispatch.conflict_policy != CONFLICT_POLICY {
        reject(
            issues,
            "problem.dispatch.conflictPolicy",
            format!("{:?}", dispatch.conflict_policy),
            CONFLICT_POLICY,
        );
        bad += 1;
    }
    if !dispatch.allow_yield {
        reject(
            issues,
            "problem.dispatch.allowYield",
            "false".to_string(),
            "true（允许设备在互斥资源前等待/让行）",
        );
        bad += 1;
    }
    if dispatch.reschedule_policy != RESCHEDULE_POLICY {
        reject(
            issues,
            "problem.dispatch.reschedulePolicy",
            format!("{:?}", dispatch.reschedule_policy),
            RESCHEDULE_POLICY,
        );
        bad += 1;
    }
    if !dispatch.cross_level_transfer {
        reject(
            issues,
            "problem.dispatch.crossLevelTransfer",
            "false".to_string(),
            "true（跨层搬运经提升井道，禁止会把多层拓扑变成不可达）",
        );
        bad += 1;
    }
    if (dispatch.rolling_horizon_s - DEFAULT_ROLLING_HORIZON_S).abs() > 1e-9 {
        let supported =
            format!("{DEFAULT_ROLLING_HORIZON_S}（当前是一次性全量推演，不做滚动时域重排）");
        reject(
            issues,
            "problem.dispatch.rollingHorizon_s",
            format!("{}", dispatch.rolling_horizon_s),
            &supported,
        );
        bad += 1;
    }
    if dispatch.simulation_horizon_s.abs() > 1e-9 {
        reject(
            issues,
            "problem.dispatch.simulationHorizon_s",
            format!("{}", dispatch.simulation_horizon_s),
            "0（不截断仿真时域；截断时域会让指标失去可比性）",
        );
        bad += 1;
    }
    // 求解选项侧的覆盖值（CLI `--options` / wasm `wh_solve_with_options` / 实验室）同口径处理。
    if options.horizon_s.abs() > 1e-9 {
        reject(
            issues,
            "options.horizonSeconds",
            format!("{}", options.horizon_s),
            "0（引擎总是把所有在册任务推演到结束；截断时域会让 makespan / 吞吐失去可比性）",
        );
        bad += 1;
    }
    if options.conflict_policy != CONFLICT_POLICY {
        reject(
            issues,
            "options.conflictPolicy",
            format!("{:?}", options.conflict_policy),
            CONFLICT_POLICY,
        );
        bad += 1;
    }
    if !options.allow_yield {
        reject(
            issues,
            "options.allowYield",
            "false".to_string(),
            "true（允许设备在互斥资源前等待/让行）",
        );
        bad += 1;
    }
    bad
}

/// 顶层入口：求解 + （可选）独立验证。
pub fn solve_with_verification(
    problem: &AsrsProblem,
    events: &[DynamicEvent],
    options: &AsrsOptions,
    issues: &mut Issues,
) -> AsrsOutcome {
    // 策略位不支持 → 直接 UNSUPPORTED（在花时间推演之前就拒绝，并带字段路径）
    if unsupported_policy_requests(problem, options, issues) > 0 {
        return AsrsOutcome {
            status: Status::Unsupported,
            ..Default::default()
        };
    }
    if problem.tasks.len() > options.max_tasks {
        issues.error(
            codes::SCALE_TOO_LARGE,
            "tasks",
            format!(
                "任务数 {} 超过本次调度的处理上限 {}（如确需处理请在 CLI 上调整上限，不要静默丢任务）",
                problem.tasks.len(),
                options.max_tasks
            ),
        );
        return AsrsOutcome {
            status: Status::Unsupported,
            ..Default::default()
        };
    }
    let mut network = RunNetwork::build(&problem.topology);
    let world = solver::World::build(problem, events);
    let prof_solver = crate::engine::prof_now();
    let schedule = solver::solve(&mut network, &world, options);
    if crate::engine::profile_enabled() {
        eprintln!(
            "[t] solver::solve {:?}",
            prof_solver.map(|clock| clock.elapsed())
        );
    }
    // 直接搬走（时间线在 2 万任务下是百万级步骤，clone 一次就是几百 MB 的复制）
    let solver::Schedule {
        metrics,
        timeline,
        status: solver_status,
        order_notes,
    } = schedule;

    // 内部自检：单车道互斥（求解器自己也要过一遍，早发现早暴露）
    let internal_conflicts = solver::lane_exclusivity_violations(&timeline);
    for conflict in internal_conflicts.iter().take(20) {
        issues.warn(
            constraints::LANE_MUTUAL_EXCLUSION,
            "schedule",
            format!("求解器自检发现潜在冲突：{conflict}"),
        );
    }
    if internal_conflicts.len() > 20 {
        issues.warn(
            constraints::LANE_MUTUAL_EXCLUSION,
            "schedule",
            format!(
                "求解器自检共发现 {} 处潜在冲突（仅列出前 20 条）",
                internal_conflicts.len()
            ),
        );
    }

    let prof_verify = crate::engine::prof_now();
    let verification = if options.verify {
        let report = verify::verify_schedule(problem, events, &timeline, options);
        if crate::engine::profile_enabled() {
            eprintln!("[t] verify {:?}", prof_verify.map(|clock| clock.elapsed()));
        }
        Some(report)
    } else {
        None
    };
    let mut status = solver_status;
    if let Some(report) = &verification {
        if !report.ok {
            let errors = report
                .violations
                .iter()
                .filter(|violation| violation.severity == crate::errors::Severity::Error)
                .count();
            issues.warn(
                constraints::DEVICE_MUTUAL_EXCLUSION,
                "verification",
                format!(
                    "独立验证发现 {errors} 条硬约束违规：结果**不可交付**，请查看 verification.violations"
                ),
            );
            status = Status::InternalError;
        } else if metrics.tasks_unserved > 0 {
            status = Status::FeasibleWithBound;
        }
    }

    let objective = round(metrics.makespan_s, 3);
    AsrsOutcome {
        status,
        objective,
        result: solution_json(&metrics, &timeline, &order_notes, options),
        metrics: metrics_json(&metrics),
        timeline: if options.include_timeline {
            Some(timeline.to_json())
        } else {
            None
        },
        verification: verification.as_ref().map(verification_json),
        report: verification,
    }
}

/// 每台设备的作业量汇总：步数 / 忙时 / 行驶米数 / 首末时刻（由同一条时间线推导）。
fn device_plan_summary(timeline: &Timeline) -> Vec<(String, usize, f64, f64, f64, f64)> {
    let mut table: BTreeMap<String, (usize, f64, f64, f64, f64)> = BTreeMap::new();
    for step in &timeline.steps {
        let entry =
            table
                .entry(step.device_id.clone())
                .or_insert((0, 0.0, 0.0, step.start_s, step.end_s));
        entry.0 += 1;
        entry.1 += (step.end_s - step.start_s).max(0.0);
        entry.2 += step.distance_m;
        entry.3 = entry.3.min(step.start_s);
        entry.4 = entry.4.max(step.end_s);
    }
    table
        .into_iter()
        .map(|(id, (steps, busy, meters, first, last))| (id, steps, busy, meters, first, last))
        .collect()
}

fn solution_json(
    metrics: &ScheduleMetrics,
    timeline: &Timeline,
    order_notes: &[String],
    options: &AsrsOptions,
) -> Json {
    Json::obj(vec![
        ("kind", Json::str("asrs")),
        ("algorithm", Json::str(options.algorithm.clone())),
        ("policy", Json::str(describe(&options.algorithm))),
        ("seed", Json::int(options.seed as i64)),
        (
            "taskStates",
            Json::Arr(
                timeline
                    .tasks
                    .iter()
                    .map(|trace| {
                        Json::obj(vec![
                            ("taskId", Json::str(trace.task_id.clone())),
                            ("kind", Json::str(trace.kind.clone())),
                            ("status", Json::str(trace.status.clone())),
                            ("start_s", Json::Float(trace.start_s)),
                            ("end_s", Json::Float(trace.end_s)),
                            ("devices", Json::strings(trace.device_ids.clone())),
                            ("lateness_s", Json::Float(trace.lateness_s)),
                            ("wait_s", Json::Float(trace.wait_s)),
                            ("note", Json::str(trace.note.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "servicePlan",
            Json::obj(vec![
                // 明细只在 timeline.devices[].steps 里出现一次；
                // 这里给每台设备的作业量汇总（同一条时间线推导，不是另算一套数）。
                (
                    "devices",
                    Json::Arr(
                        device_plan_summary(timeline)
                            .into_iter()
                            .map(|entry| {
                                Json::obj(vec![
                                    ("deviceId", Json::str(entry.0)),
                                    ("steps", Json::int(entry.1 as i64)),
                                    ("busySeconds", Json::Float(round(entry.2, 3))),
                                    ("travelMeters", Json::Float(round(entry.3, 3))),
                                    ("firstStart_s", Json::Float(round(entry.4, 3))),
                                    ("lastEnd_s", Json::Float(round(entry.5, 3))),
                                ])
                            })
                            .collect(),
                    ),
                ),
                ("stepCount", Json::int(timeline.steps.len() as i64)),
                (
                    "note",
                    Json::str("逐步骤明细见 timeline.devices[].steps（含资源占用与推迟原因）"),
                ),
            ]),
        ),
        (
            "conflicts",
            Json::Arr(
                order_notes
                    .iter()
                    .map(|note| Json::str(note.clone()))
                    .collect(),
            ),
        ),
        (
            "note",
            Json::str("完整逐步骤时间线见 envelope.timeline；此处只保留任务状态与设备作业汇总"),
        ),
        (
            // 三条必答问题里的"为什么设备按这个顺序运行"：与库位侧/联合侧同形状，
            // 面板因此能用同一个渲染分支（数值全部来自本次真实推演，不是模板话术）。
            "explanation",
            Json::obj(vec![
                (
                    "dispatch",
                    Json::str(format!(
                        "按 {} 策略生成任务顺序与设备指派：{} 个输入任务完成 {} 个，完工 {:.1}s、\
                     吞吐 {:.1} 件/小时；冲突推迟 {} 次、死锁预防 {} 次、倒垛派生任务 {} 件、\
                     双指令配对 {} 对；每一步都写了时空预约（共 {} 条），可在 \
                     timeline.devices[].steps 里逐段复核",
                        describe(&options.algorithm),
                        metrics.tasks_total,
                        metrics.tasks_done,
                        metrics.makespan_s,
                        metrics.throughput_per_hour,
                        metrics.conflicts,
                        metrics.deadlocks_prevented,
                        metrics.relocation_tasks,
                        metrics.dual_command_pairs,
                        metrics.reservations
                    )),
                ),
                (
                    "reasons",
                    Json::strings(order_notes.iter().take(6).cloned()),
                ),
                (
                    "note",
                    Json::str(
                        "完整冲突/推迟原因清单见 result.conflicts；指标口径与独立验证器重算一致",
                    ),
                ),
            ]),
        ),
    ])
}

pub fn metrics_json(metrics: &solver::ScheduleMetrics) -> Json {
    Json::obj(vec![
        ("tasksTotal", Json::int(metrics.tasks_total as i64)),
        ("tasksDone", Json::int(metrics.tasks_done as i64)),
        ("tasksUnserved", Json::int(metrics.tasks_unserved as i64)),
        ("makespan_s", Json::Float(round(metrics.makespan_s, 3))),
        (
            "throughputPerHour",
            Json::Float(round(metrics.throughput_per_hour, 3)),
        ),
        ("meanCycle_s", Json::Float(round(metrics.mean_cycle_s, 3))),
        ("meanWait_s", Json::Float(round(metrics.mean_wait_s, 3))),
        ("conflicts", Json::int(metrics.conflicts as i64)),
        (
            "deadlocksPrevented",
            Json::int(metrics.deadlocks_prevented as i64),
        ),
        ("reservations", Json::int(metrics.reservations as i64)),
        ("travelMeters", Json::Float(round(metrics.travel_meters, 3))),
        ("energyKwh", Json::Float(round(metrics.energy_kwh, 6))),
        (
            "relocationTasks",
            Json::int(metrics.relocation_tasks as i64),
        ),
        ("blockedMoves", Json::int(metrics.blocked_moves as i64)),
        ("lateTasks", Json::int(metrics.late_tasks as i64)),
        (
            "maxLateness_s",
            Json::Float(round(metrics.max_lateness_s, 3)),
        ),
        (
            "dualCommandPairs",
            Json::int(metrics.dual_command_pairs as i64),
        ),
        (
            "deviceUtilization",
            Json::Arr(
                metrics
                    .device_utilization
                    .iter()
                    .map(|(device_id, value)| {
                        Json::obj(vec![
                            ("deviceId", Json::str(device_id.clone())),
                            ("utilization", Json::Float(*value)),
                            (
                                "busySeconds",
                                Json::Float(
                                    metrics.device_busy.get(device_id).copied().unwrap_or(0.0),
                                ),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "bufferPeak",
            Json::Arr(
                metrics
                    .buffer_peak
                    .iter()
                    .map(|(buffer_id, value)| {
                        Json::obj(vec![
                            ("bufferId", Json::str(buffer_id.clone())),
                            ("peak", Json::int(*value as i64)),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "stationPeak",
            Json::Arr(
                metrics
                    .station_peak
                    .iter()
                    .map(|(station_id, value)| {
                        Json::obj(vec![
                            ("stationId", Json::str(station_id.clone())),
                            ("peak", Json::int(*value as i64)),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "derivedTasksDone",
            Json::int(metrics.derived_tasks_done as i64),
        ),
        (
            "locationsOccupied",
            Json::int(metrics.locations_occupied as i64),
        ),
        (
            "searchedSimulations",
            Json::int(metrics.sim_iterations as i64),
        ),
        ("computeMs", Json::Float(round(metrics.compute_ms, 3))),
        (
            "scale",
            crate::engine::scale_json(&crate::slotting::ScaleReport {
                skus: 0,
                locations: 0,
                load_units: 0,
                orders: 0,
                assignments: 0,
                tasks: metrics.tasks_total,
                devices: metrics.device_utilization.len(),
                events: 0,
                note: String::new(),
            }),
        ),
    ])
}

pub fn verification_json(report: &AsrsVerification) -> Json {
    Json::obj(vec![
        ("ok", Json::Bool(report.ok)),
        (
            "violations",
            Json::Arr(
                report
                    .violations
                    .iter()
                    .map(verify::violation_json)
                    .collect(),
            ),
        ),
        (
            "checked",
            Json::obj(vec![
                ("steps", Json::int(report.checked.steps as i64)),
                ("tasks", Json::int(report.checked.tasks as i64)),
                ("devices", Json::int(report.checked.devices as i64)),
                (
                    "replayedHorizon_s",
                    Json::Float(round(report.checked.replayed_horizon_s, 3)),
                ),
                (
                    "totalMotionSeconds",
                    Json::Float(round(report.checked.total_motion_seconds, 3)),
                ),
                (
                    "totalMotionMeters",
                    Json::Float(round(report.checked.total_motion_meters, 3)),
                ),
                (
                    "laneConflicts",
                    Json::int(report.checked.lane_conflicts as i64),
                ),
                (
                    "shaftConflicts",
                    Json::int(report.checked.shaft_conflicts as i64),
                ),
                (
                    "serviceViolations",
                    Json::int(report.checked.service_violations as i64),
                ),
                (
                    "timeViolations",
                    Json::int(report.checked.time_violations as i64),
                ),
                (
                    "capacityViolations",
                    Json::int(report.checked.capacity_violations as i64),
                ),
                (
                    "dependencyViolations",
                    Json::int(report.checked.dependency_violations as i64),
                ),
                (
                    "unservedTasks",
                    Json::int(report.checked.unserved_tasks as i64),
                ),
                ("notes", Json::strings(report.checked.notes.clone())),
            ]),
        ),
    ])
}

/// 设备能力清单（面板"谁能做这个活"与能力矩阵共用一个数据源）。
pub fn capability_matrix(network: &RunNetwork) -> Json {
    Json::Arr(
        solver::device_roles(network)
            .into_iter()
            .map(|(device_id, kind, roles)| {
                Json::obj(vec![
                    ("deviceId", Json::str(device_id)),
                    ("kind", Json::str(kind)),
                    ("tasks", Json::strings(roles)),
                ])
            })
            .collect(),
    )
}
