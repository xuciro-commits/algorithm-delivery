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

use crate::contract::{AsrsProblem, DynamicEvent};
use crate::errors::{codes, constraints, Issues, Status};
use crate::util::round;

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

/// 顶层入口：求解 + （可选）独立验证。
pub fn solve_with_verification(
    problem: &AsrsProblem,
    events: &[DynamicEvent],
    options: &AsrsOptions,
    issues: &mut Issues,
) -> AsrsOutcome {
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
    let schedule = solver::solve(&mut network, &world, options);
    let metrics = schedule.metrics.clone();
    let timeline = schedule.timeline.clone();

    // 内部自检：单车道互斥（求解器自己也要过一遍，早发现早暴露）
    let internal_conflicts = solver::lane_exclusivity_violations(&timeline);
    for conflict in &internal_conflicts {
        issues.warn(
            constraints::LANE_MUTUAL_EXCLUSION,
            "schedule",
            format!("求解器自检发现潜在冲突：{conflict}"),
        );
    }

    let verification = if options.verify {
        let report = verify::verify_schedule(problem, events, &timeline, options);
        Some(report)
    } else {
        None
    };
    let mut status = schedule.status;
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
        result: solution_json(&schedule, options),
        metrics: metrics_json(&metrics),
        timeline: Some(timeline.to_json()),
        verification: verification.as_ref().map(|report| verification_json(report)),
        report: verification,
    }
}

fn solution_json(schedule: &solver::Schedule, options: &AsrsOptions) -> Json {
    Json::obj(vec![
        ("kind", Json::str("asrs")),
        ("algorithm", Json::str(options.algorithm.clone())),
        ("policy", Json::str(describe(&options.algorithm))),
        ("seed", Json::int(options.seed as i64)),
        (
            "taskStates",
            Json::Arr(
                schedule
                    .timeline
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
                (
                    "steps",
                    Json::Arr(
                        schedule
                            .timeline
                            .steps
                            .iter()
                            .map(|step| step.to_json())
                            .collect(),
                    ),
                ),
                (
                    "stepCount",
                    Json::int(schedule.timeline.steps.len() as i64),
                ),
            ]),
        ),
        (
            "conflicts",
            Json::Arr(
                schedule
                    .order_notes
                    .iter()
                    .map(|note| Json::str(note.clone()))
                    .collect(),
            ),
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
        ("relocationTasks", Json::int(metrics.relocation_tasks as i64)),
        ("blockedMoves", Json::int(metrics.blocked_moves as i64)),
        ("lateTasks", Json::int(metrics.late_tasks as i64)),
        ("maxLateness_s", Json::Float(round(metrics.max_lateness_s, 3))),
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
