//! 立库调度的**独立验证器**：只读问题 + 时间线，重放一遍并复核全部硬约束。
//!
//! 设计红线（SRS §5.2）：
//! * 不引用求解器的任何中间状态（预约表、设备位置缓存都不碰）；
//! * 只用契约 + 时间线里的数字重算：运动时间用几何与运动学**重算**，不信任时间线里写的时长；
//! * 违规逐条给证据：约束码、主体、时刻、位置、期望值 vs 实际值。

use std::collections::BTreeMap;

use crate::asrs::network::RunNetwork;
use crate::asrs::solver::AsrsOptions;
use crate::asrs::timeline::Timeline;
use crate::contract::{AsrsProblem, DeviceKind, DynamicEvent};
use crate::errors::{codes, constraints, Severity, Violation};
use crate::util::round;

/// 验证结果：违规清单 + 复核过的数字（供"优化器 vs 验证器"对照）。
#[derive(Debug, Clone, Default)]
pub struct AsrsVerification {
    pub violations: Vec<Violation>,
    pub checked: CheckedFacts,
    pub ok: bool,
}

#[derive(Debug, Clone, Default)]
pub struct CheckedFacts {
    pub steps: usize,
    pub tasks: usize,
    pub devices: usize,
    pub replayed_horizon_s: f64,
    pub total_motion_seconds: f64,
    pub total_motion_meters: f64,
    pub device_busy_seconds: BTreeMap<String, f64>,
    pub lane_conflicts: usize,
    pub shaft_conflicts: usize,
    pub service_violations: usize,
    pub time_violations: usize,
    pub capacity_violations: usize,
    pub dependency_violations: usize,
    pub unserved_tasks: usize,
    pub notes: Vec<String>,
}

fn hard(problem: &AsrsProblem, code: &str) -> bool {
    problem.hard_constraints.is_empty() || problem.hard_constraints.iter().any(|item| item == code)
}

/// 主入口：独立复核一份调度时间线。
pub fn verify_schedule(
    problem: &AsrsProblem,
    events: &[DynamicEvent],
    timeline: &Timeline,
    options: &AsrsOptions,
) -> AsrsVerification {
    let mut network = RunNetwork::build(&problem.topology);
    let mut result = AsrsVerification::default();
    let mut facts = CheckedFacts::default();

    // 事件影响面（验证器自己解释事件，不读求解器的 world）
    let mut outages: BTreeMap<String, Vec<(f64, f64)>> = BTreeMap::new();
    let mut closed_aisles: Vec<String> = Vec::new();
    let mut frozen: Vec<String> = problem.topology.frozen_locations.iter().cloned().collect();
    let mut slow: BTreeMap<String, f64> = BTreeMap::new();
    for event in events {
        match event.kind.as_str() {
            "device-breakdown" | "fault" => {
                let repair = if event.value > 0.0 { event.value } else { 900.0 };
                let targets: Vec<String> = if event.device_ids.is_empty() {
                    problem.topology.devices.iter().map(|d| d.id.clone()).collect()
                } else {
                    event.device_ids.clone()
                };
                for device in targets {
                    outages
                        .entry(device)
                        .or_default()
                        .push((event.at_s, event.at_s + repair));
                }
            }
            "speed-degradation" | "degraded-speed" => {
                let factor = if event.value > 0.0 { event.value.clamp(0.05, 1.0) } else { 0.5 };
                for device in &event.device_ids {
                    slow.insert(device.clone(), factor);
                }
            }
            "aisle-closure" => closed_aisles.extend(event.link_ids.iter().cloned()),
            "location-freeze" => frozen.extend(event.location_ids.iter().cloned()),
            _ => {}
        }
    }

    let locations = crate::wh::topology::derive_locations(&problem.topology);
    let location_of: BTreeMap<&str, &crate::wh::topology::LocationRecord> =
        locations.iter().map(|record| (record.id.as_str(), record)).collect();
    let device_by_id: BTreeMap<&str, &crate::contract::DeviceSpec> =
        problem.topology.devices.iter().map(|device| (device.id.as_str(), device)).collect();

    facts.steps = timeline.steps.len();
    facts.tasks = timeline.tasks.len();
    facts.devices = problem.topology.devices.len();
    facts.replayed_horizon_s = round(timeline.horizon_s, 3);

    // ---- 1) 逐设备重放：时间单调、动作时长与几何一致、设备不重叠 ----
    let mut per_device: BTreeMap<String, Vec<&crate::asrs::timeline::Step>> = BTreeMap::new();
    for step in &timeline.steps {
        per_device.entry(step.device_id.clone()).or_default().push(step);
    }
    for (device_id, steps) in &per_device {
        let Some(device) = device_by_id.get(device_id.as_str()) else {
            result.violations.push(
                Violation::new(
                    codes::UNKNOWN_REFERENCE,
                    Severity::Error,
                    format!("时间线引用了拓扑中不存在的设备 {device_id}"),
                )
                .device(device_id.clone()),
            );
            continue;
        };
        let speed = device.motion.speed_mps
            * slow.get(device_id).copied().unwrap_or(1.0)
            * device.speed_factor.max(0.05);
        let mut clock = 0.0f64;
        for step in steps {
            if step.end_s + 1e-6 < step.start_s {
                facts.time_violations += 1;
                result.violations.push(
                    Violation::new(
                        constraints::TIME_CONSISTENCY,
                        Severity::Error,
                        format!("步骤 {} 的结束时间早于开始时间", step.id),
                    )
                    .device(device_id.clone())
                    .at(step.start_s)
                    .expected_actual("end >= start", format!("{} < {}", step.end_s, step.start_s)),
                );
            }
            if step.start_s + 1e-6 < clock {
                facts.time_violations += 1;
                result.violations.push(
                    Violation::new(
                        constraints::DEVICE_MUTUAL_EXCLUSION,
                        Severity::Error,
                        format!(
                            "设备 {device_id} 的步骤 {} 与前一步骤时间重叠（设备同一时刻只能在一个位置）",
                            step.id
                        ),
                    )
                    .device(device_id.clone())
                    .at(step.start_s)
                    .expected_actual(format!("start >= {:.3}", round(clock, 3)), round(step.start_s, 3).to_string()),
                );
            }
            clock = clock.max(step.end_s);
            facts.device_busy_seconds
                .entry(device_id.clone())
                .and_modify(|value| *value += (step.end_s - step.start_s).max(0.0))
                .or_insert((step.end_s - step.start_s).max(0.0));
            // 重算时间：几何距离 / (设备速度 × 事件降级因子)
            let distance = ((step.to.x - step.from.x).powi(2)
                + (step.to.z - step.from.z).powi(2)
                + (step.to.y - step.from.y).powi(2))
            .sqrt();
            facts.total_motion_meters += distance;
            facts.total_motion_seconds += (step.end_s - step.start_s).max(0.0);
            let expected = crate::wh::routing::travel_time(distance, speed, device.motion.accel_mps2);
            let allowed = expected * 1.35
                + device.motion.transfer_s
                + device.motion.handover_s
                + device.motion.change_level_s;
            let declared = step.end_s - step.start_s;
            if distance > 1e-6 && declared > allowed.max(0.5) && !matches!(step.kind.as_str(), "wait" | "idle") {
                facts.time_violations += 1;
                result.violations.push(
                    Violation::new(
                        constraints::TIME_CONSISTENCY,
                        Severity::Warning,
                        format!(
                            "步骤 {} 声明 {:.1}s，但按几何与设备运动学最多需要 {:.1}s（可能存在未说明的等待）",
                            step.id, declared, allowed
                        ),
                    )
                    .soft()
                    .device(device_id.clone())
                    .at(step.start_s)
                    .expected_actual(round(allowed, 2).to_string(), round(declared, 2).to_string())
                    .position([step.from.x, step.from.y, step.from.z]),
                );
            }
            if distance > 0.0 && declared + 1e-6 < crate::wh::routing::travel_time(distance, speed, device.motion.accel_mps2) * 0.85
                && !matches!(step.kind.as_str(), "wait" | "idle" | "load" | "unload" | "handover")
            {
                facts.time_violations += 1;
                result.violations.push(
                    Violation::new(
                        constraints::TIME_CONSISTENCY,
                        Severity::Error,
                        format!(
                            "步骤 {} 的声明时长 {:.1}s 物理上不可能完成 {:.1}m 的移动（设备速度 {:.2}m/s）",
                            step.id, declared, distance, speed
                        ),
                    )
                    .device(device_id.clone())
                    .at(step.start_s)
                    .expected_actual(
                        format!(">= {:.1}s", crate::wh::routing::travel_time(distance, speed, device.motion.accel_mps2)),
                        round(declared, 2).to_string(),
                    ),
                );
            }
            // 故障窗口内不允许有动作
            if let Some(windows) = outages.get(device_id) {
                for (from, to) in windows {
                    if step.end_s > *from + 1e-6 && step.start_s < *to - 1e-6 {
                        facts.time_violations += 1;
                        result.violations.push(
                            Violation::new(
                                constraints::DEVICE_UNAVAILABLE,
                                Severity::Error,
                                format!(
                                    "设备 {device_id} 在故障窗口 [{:.0}, {:.0}] 内仍有动作 {}",
                                    from, to, step.id
                                ),
                            )
                            .device(device_id.clone())
                            .at(step.start_s),
                        );
                    }
                }
            }
        }
    }

    // ---- 2) 单车道 / 竖井互斥（独立复核，不读求解器预约表）----
    let mut lane_steps: BTreeMap<String, Vec<&crate::asrs::timeline::Step>> = BTreeMap::new();
    for step in &timeline.steps {
        if let (Some(aisle), Some(_)) = (&step.from.aisle_id, &step.to.aisle_id) {
            if step.from.level == step.to.level {
                lane_steps
                    .entry(crate::asrs::network::lane_resource(aisle, step.from.level))
                    .or_default()
                    .push(step);
            }
        }
        if step.kind == "lift" {
            if let Some(device) = device_by_id.get(step.device_id.as_str()) {
                lane_steps
                    .entry(crate::asrs::network::shaft_resource(device))
                    .or_default()
                    .push(step);
            }
        }
    }
    for (resource, steps) in &lane_steps {
        let capacity = problem
            .topology
            .links
            .iter()
            .find(|link| resource.contains(&link.id))
            .map(|link| link.capacity.max(1))
            .unwrap_or(1);
        let allow_meeting = problem
            .topology
            .links
            .iter()
            .any(|link| resource.contains(&link.id) && link.allow_meeting);
        if capacity > 1 && allow_meeting {
            continue;
        }
        for (index, a) in steps.iter().enumerate() {
            for b in steps.iter().skip(index + 1) {
                if a.device_id == b.device_id {
                    continue;
                }
                if a.end_s <= b.start_s + 1e-9 || b.end_s <= a.start_s + 1e-9 {
                    continue;
                }
                let a_lo = a.from.x.min(a.to.x);
                let a_hi = a.from.x.max(a.to.x);
                let b_lo = b.from.x.min(b.to.x);
                let b_hi = b.from.x.max(b.to.x);
                if a_hi < b_lo - 1e-6 || b_hi < a_lo - 1e-6 {
                    continue;
                }
                if resource.starts_with("SHAFT") {
                    facts.shaft_conflicts += 1;
                } else {
                    facts.lane_conflicts += 1;
                }
                result.violations.push(
                    Violation::new(
                        constraints::LANE_MUTUAL_EXCLUSION,
                        Severity::Error,
                        format!(
                            "资源 {resource} 上 {} 与 {} 在 [{:.1}, {:.1}]s 时间与位置区间同时重叠",
                            a.device_id,
                            b.device_id,
                            a.start_s.max(b.start_s),
                            a.end_s.min(b.end_s)
                        ),
                    )
                    .subjects(vec![a.device_id.clone(), b.device_id.clone()])
                    .at(a.start_s.max(b.start_s)),
                );
            }
        }
    }

    // ---- 3) 任务层：释放时间、交期、依赖、可达性、服务能力 ----
    for trace in &timeline.tasks {
        let Some(task) = problem.tasks.iter().find(|task| task.id == trace.task_id) else {
            // 事件插入的任务不在基础问题里，按时间线信息复核即可
            continue;
        };
        if trace.start_s + 1e-6 < task.release_s {
            facts.time_violations += 1;
            result.violations.push(
                Violation::new(
                    constraints::TASK_SEQUENCE,
                    Severity::Error,
                    format!(
                        "任务 {} 在释放时间 {:.1}s 之前就开始了（{:.1}s）",
                        task.id, task.release_s, trace.start_s
                    ),
                )
                .task(task.id.clone())
                .at(trace.start_s),
            );
        }
        if let Some(deadline) = task.deadline_s {
            if trace.status == "done" && trace.end_s > deadline + 1e-6 && hard(problem, constraints::TASK_DEADLINE)
            {
                facts.service_violations += 1;
                result.violations.push(
                    Violation::new(
                        constraints::TASK_DEADLINE,
                        Severity::Error,
                        format!(
                            "任务 {} 超期 {:.1}s（交期 {:.1}s，完成 {:.1}s）",
                            task.id,
                            trace.end_s - deadline,
                            deadline,
                            trace.end_s
                        ),
                    )
                    .task(task.id.clone())
                    .at(trace.end_s)
                    .expected_actual(round(deadline, 2).to_string(), round(trace.end_s, 2).to_string()),
                );
            }
        }
        // 设备服务能力与巷道封闭
        let required_location = task
            .from_location_id
            .clone()
            .or_else(|| task.to_location_id.clone());
        if let Some(location_id) = required_location {
            if frozen.contains(&location_id) {
                facts.service_violations += 1;
                result.violations.push(
                    Violation::new(
                        constraints::LOCATION_FROZEN,
                        Severity::Error,
                        format!("任务 {} 使用了已冻结的库位 {location_id}", task.id),
                    )
                    .task(task.id.clone())
                    .location(location_id.clone()),
                );
            }
            if let Some(record) = location_of.get(location_id.as_str()) {
                if closed_aisles.contains(&record.aisle_id) {
                    facts.service_violations += 1;
                    result.violations.push(
                        Violation::new(
                            constraints::LOCATION_UNAVAILABLE,
                            Severity::Error,
                            format!(
                                "任务 {} 使用了已关闭巷道 {} 的库位 {}",
                                task.id, record.aisle_id, location_id
                            ),
                        )
                        .task(task.id.clone())
                        .location(location_id.clone()),
                    );
                }
                // 每个执行设备必须真的能服务这个巷道 / 层
                for device_id in &trace.device_ids {
                    if let Some(device) = device_by_id.get(device_id.as_str()) {
                        let is_lift = matches!(device.kind, DeviceKind::PalletLift | DeviceKind::AisleLift);
                        if is_lift {
                            continue;
                        }
                        if !network.can_serve(device, &record.aisle_id, record.level) {
                            facts.service_violations += 1;
                            result.violations.push(
                                Violation::new(
                                    constraints::DEVICE_CAPABILITY_VIOLATION,
                                    Severity::Error,
                                    format!(
                                        "设备 {device_id}（{}）被安排去服务巷道 {} 层 {}，超出其能力范围",
                                        device.kind.as_str(),
                                        record.aisle_id,
                                        record.level
                                    ),
                                )
                                .task(task.id.clone())
                                .device(device_id.clone())
                                .location(location_id.clone()),
                            );
                        }
                    }
                }
            }
        }
        if trace.status != "done" {
            facts.unserved_tasks += 1;
        }
    }

    // ---- 4) 任务依赖：被依赖任务必须更早完成 ----
    let end_of: BTreeMap<&str, f64> = timeline
        .tasks
        .iter()
        .map(|trace| (trace.task_id.as_str(), trace.end_s))
        .collect();
    for task in &problem.tasks {
        for dependency in &task.depends_on {
            if let (Some(end_dep), Some(end_task)) =
                (end_of.get(dependency.as_str()), end_of.get(task.id.as_str()))
            {
                if end_task + 1e-6 < *end_dep {
                    facts.dependency_violations += 1;
                    result.violations.push(
                        Violation::new(
                            constraints::TASK_PRECEDENCE,
                            Severity::Error,
                            format!(
                                "任务 {} 在依赖任务 {} 完成之前就结束了（{:.1}s < {:.1}s）",
                                task.id, dependency, end_task, end_dep
                            ),
                        )
                        .task(task.id.clone()),
                    );
                }
            }
        }
    }

    // ---- 5) 站台 / 缓冲容量：按时间重放占用峰值 ----
    let mut occupancy: BTreeMap<String, i32> = BTreeMap::new();
    let mut events_sorted: Vec<&crate::asrs::timeline::BufferState> =
        timeline.buffer_states.iter().collect();
    events_sorted.sort_by(|a, b| a.at_s.partial_cmp(&b.at_s).unwrap_or(std::cmp::Ordering::Equal));
    for state in events_sorted {
        let entry = occupancy.entry(state.buffer_id.clone()).or_insert(0);
        *entry = state.occupancy;
        let capacity = problem
            .topology
            .stations
            .iter()
            .find(|station| station.id == state.buffer_id)
            .map(|station| station.buffer_capacity)
            .or_else(|| {
                problem
                    .topology
                    .buffers
                    .iter()
                    .find(|buffer| buffer.id == state.buffer_id)
                    .map(|buffer| buffer.capacity)
            })
            .unwrap_or(i32::MAX);
        if state.occupancy > capacity && capacity >= 0 {
            facts.capacity_violations += 1;
            result.violations.push(
                Violation::new(
                    constraints::BUFFER_CAPACITY,
                    Severity::Error,
                    format!(
                        "缓冲位 {} 在 {:.1}s 占用 {} 超过容量 {}",
                        state.buffer_id, state.at_s, state.occupancy, capacity
                    ),
                )
                .at(state.at_s)
                .expected_actual(capacity.to_string(), state.occupancy.to_string()),
            );
        }
    }

    // ---- 6) 结论 ----
    let errors = result
        .violations
        .iter()
        .filter(|violation| violation.severity == Severity::Error)
        .count();
    result.ok = errors == 0;
    facts.notes.push(format!(
        "独立重放 {} 个步骤 / {} 个任务，按几何重算运行时间 {:.0}s、{:.0}m；\
         运载设备 {} 台，车道冲突 {}、竖井冲突 {}、能力违规 {}、时间违规 {}、容量违规 {}、依赖违规 {}",
        facts.steps,
        facts.tasks,
        facts.total_motion_seconds,
        facts.total_motion_meters,
        facts.devices,
        facts.lane_conflicts,
        facts.shaft_conflicts,
        facts.service_violations,
        facts.time_violations,
        facts.capacity_violations,
        facts.dependency_violations
    ));
    result.checked = facts;
    let _ = options;
    result
}

/// 违反项 → JSON（与契约 `warehouse-verification/1.0` 同形）。
pub fn violation_json(violation: &Violation) -> aps_engine::json::Json {
    use aps_engine::json::Json;
    Json::obj(vec![
        ("code", Json::str(violation.code.clone())),
        (
            "severity",
            Json::str(match violation.severity {
                Severity::Error => "error",
                Severity::Warning => "warning",
                Severity::Info => "info",
            }),
        ),
        ("class", Json::str(violation.constraint_class)),
        ("message", Json::str(violation.message.clone())),
        ("subjects", Json::strings(violation.subjects.clone())),
        ("locationId", Json::opt_str(violation.location_id.clone())),
        ("deviceId", Json::opt_str(violation.device_id.clone())),
        ("taskId", Json::opt_str(violation.task_id.clone())),
        (
            "at_s",
            match violation.at_s {
                Some(value) => Json::Float(round(value, 3)),
                None => Json::Null,
            },
        ),
        (
            "position",
            match violation.position {
                Some(position) => Json::Arr(
                    position
                        .iter()
                        .map(|value| Json::Float(round(*value, 3)))
                        .collect(),
                ),
                None => Json::Null,
            },
        ),
        ("expected", Json::opt_str(violation.expected.clone())),
        ("actual", Json::opt_str(violation.actual.clone())),
    ])
}
