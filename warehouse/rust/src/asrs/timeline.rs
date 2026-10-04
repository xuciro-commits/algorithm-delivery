//! 设备轨迹与时间线：实验室播放的**唯一**数据源。
//!
//! 时间线不是"给动画准备的假数据"，而是调度的逐步产物：
//! * 每个 `Step` 都来自一次真实的设备动作（行走 / 取货 / 交货 / 提升 / 倒垛 / 等待）；
//! * `reservation_id` 指向时空预约表的记录，因此"为什么这台车在这里等"可以追溯；
//! * 校验器重放时间线时不需要任何求解器中间状态 —— 只要问题和时间线。

use std::collections::BTreeMap;

use aps_engine::json::Json;

use crate::asrs::network::DevicePosition;
use crate::util::round;

/// 一个设备动作（时间线的原子单元）。
#[derive(Debug, Clone)]
pub struct Step {
    pub id: String,
    pub device_id: String,
    pub task_id: Option<String>,
    /// travel | lift | load | unload | wait | handover | relocate | fault | charge | idle
    pub kind: String,
    pub from: DevicePosition,
    pub to: DevicePosition,
    pub start_s: f64,
    pub end_s: f64,
    pub loaded: bool,
    pub distance_m: f64,
    pub energy_kwh: f64,
    pub note: String,
    /// 时空预约的资源（供验证器复核互斥）
    pub resource_id: Option<String>,
    /// 本步**实际占用**的全部资源（跨巷道/跨层移动会同时占用多条车道与竖井）；
    /// 验证器按这个集合复核互斥，并复核每条资源声明与几何是否自洽。
    pub resources: Vec<String>,
    /// 被推迟的秒数（>0 表示这次动作真的等了）
    pub delayed_by_s: f64,
}

impl Step {
    pub fn duration(&self) -> f64 {
        (self.end_s - self.start_s).max(0.0)
    }

    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("id", Json::str(self.id.clone())),
            ("deviceId", Json::str(self.device_id.clone())),
            ("taskId", Json::opt_str(self.task_id.clone())),
            ("kind", Json::str(self.kind.clone())),
            (
                "from",
                Json::obj(vec![
                    ("x", Json::Float(round(self.from.x, 4))),
                    ("y", Json::Float(round(self.from.y, 4))),
                    ("z", Json::Float(round(self.from.z, 4))),
                    ("level", Json::int(self.from.level as i64)),
                    ("aisleId", Json::opt_str(self.from.aisle_id.clone())),
                    ("nodeId", Json::opt_str(self.from.node_id.clone())),
                    ("locationId", Json::opt_str(self.from.location_id.clone())),
                ]),
            ),
            (
                "to",
                Json::obj(vec![
                    ("x", Json::Float(round(self.to.x, 4))),
                    ("y", Json::Float(round(self.to.y, 4))),
                    ("z", Json::Float(round(self.to.z, 4))),
                    ("level", Json::int(self.to.level as i64)),
                    ("aisleId", Json::opt_str(self.to.aisle_id.clone())),
                    ("nodeId", Json::opt_str(self.to.node_id.clone())),
                    ("locationId", Json::opt_str(self.to.location_id.clone())),
                ]),
            ),
            ("start_s", Json::Float(round(self.start_s, 3))),
            ("end_s", Json::Float(round(self.end_s, 3))),
            ("loaded", Json::Bool(self.loaded)),
            ("distanceM", Json::Float(round(self.distance_m, 3))),
            ("energyKwh", Json::Float(round(self.energy_kwh, 6))),
            ("note", Json::str(self.note.clone())),
            ("delayedBy_s", Json::Float(round(self.delayed_by_s, 3))),
            ("resourceId", Json::opt_str(self.resource_id.clone())),
            (
                "resources",
                Json::strings(if self.resources.is_empty() {
                    self.resource_id.clone().into_iter().collect()
                } else {
                    self.resources.clone()
                }),
            ),
        ])
    }
}

/// 任务在时间线上的执行摘要（面板"任务列表"直接读它）。
#[derive(Debug, Clone)]
pub struct TaskTrace {
    pub task_id: String,
    pub kind: String,
    pub priority: i64,
    pub release_s: f64,
    pub deadline_s: Option<f64>,
    pub start_s: f64,
    pub end_s: f64,
    pub device_ids: Vec<String>,
    pub step_ids: Vec<String>,
    pub dual_command: bool,
    pub status: String,
    pub lateness_s: f64,
    pub wait_s: f64,
    pub note: String,
}

impl TaskTrace {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("taskId", Json::str(self.task_id.clone())),
            ("kind", Json::str(self.kind.clone())),
            ("priority", Json::int(self.priority)),
            ("release_s", Json::Float(round(self.release_s, 3))),
            (
                "deadline_s",
                Json::opt_str(self.deadline_s.map(|v| round(v, 3).to_string())),
            ),
            ("start_s", Json::Float(round(self.start_s, 3))),
            ("end_s", Json::Float(round(self.end_s, 3))),
            ("devices", Json::strings(self.device_ids.clone())),
            ("steps", Json::strings(self.step_ids.clone())),
            ("dualCommand", Json::Bool(self.dual_command)),
            ("status", Json::str(self.status.clone())),
            ("lateness_s", Json::Float(round(self.lateness_s, 3))),
            ("wait_s", Json::Float(round(self.wait_s, 3))),
            ("note", Json::str(self.note.clone())),
        ])
    }
}

/// 时间线：设备轨迹 + 任务轨迹 + 关键状态变化（供 3D 播放与指标复核）。
#[derive(Debug, Default, Clone)]
pub struct Timeline {
    pub steps: Vec<Step>,
    pub tasks: Vec<TaskTrace>,
    /// 缓冲位占用随时间的变化（时间线里的"状态变化点"）
    pub buffer_states: Vec<BufferState>,
    /// 库位占用变化（倒垛与出入库引起的状态迁移）
    pub location_states: Vec<LocationState>,
    pub horizon_s: f64,
}

#[derive(Debug, Clone)]
pub struct BufferState {
    pub at_s: f64,
    pub buffer_id: String,
    pub occupancy: i32,
    pub capacity: i32,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct LocationState {
    pub at_s: f64,
    pub location_id: String,
    pub load_unit_id: Option<String>,
    pub reason: String,
}

impl Timeline {
    pub fn push_step(&mut self, step: Step) {
        self.horizon_s = self.horizon_s.max(step.end_s);
        self.steps.push(step);
    }

    pub fn steps_of(&self, device_id: &str) -> Vec<&Step> {
        self.steps
            .iter()
            .filter(|step| step.device_id == device_id)
            .collect()
    }

    pub fn device_ids(&self) -> Vec<String> {
        let mut set: Vec<String> = Vec::new();
        for step in &self.steps {
            if !set.contains(&step.device_id) {
                set.push(step.device_id.clone());
            }
        }
        set.sort();
        set
    }

    /// 每个设备的忙/闲统计（利用率来自真实动作时间，不是估计值）。
    pub fn device_utilization(&self) -> BTreeMap<String, (f64, f64, f64)> {
        let mut out: BTreeMap<String, (f64, f64, f64)> = BTreeMap::new();
        for step in &self.steps {
            let entry = out.entry(step.device_id.clone()).or_insert((0.0, 0.0, 0.0));
            let busy = if step.kind == "wait" || step.kind == "idle" {
                0.0
            } else {
                step.duration()
            };
            entry.0 += busy;
            entry.1 += step.duration();
            entry.2 += step.distance_m;
        }
        out
    }

    pub fn to_json(&self) -> Json {
        let mut by_device: BTreeMap<String, Vec<Json>> = BTreeMap::new();
        for step in &self.steps {
            by_device
                .entry(step.device_id.clone())
                .or_default()
                .push(step.to_json());
        }
        Json::obj(vec![
            ("horizon_s", Json::Float(round(self.horizon_s, 3))),
            (
                "devices",
                Json::Arr(
                    by_device
                        .iter()
                        .map(|(device_id, steps)| {
                            Json::obj(vec![
                                ("deviceId", Json::str(device_id.clone())),
                                ("steps", Json::Arr(steps.clone())),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "tasks",
                Json::Arr(self.tasks.iter().map(|task| task.to_json()).collect()),
            ),
            (
                "bufferStates",
                Json::Arr(
                    self.buffer_states
                        .iter()
                        .map(|state| {
                            Json::obj(vec![
                                ("at_s", Json::Float(round(state.at_s, 3))),
                                ("bufferId", Json::str(state.buffer_id.clone())),
                                ("occupancy", Json::int(state.occupancy as i64)),
                                ("capacity", Json::int(state.capacity as i64)),
                                ("reason", Json::str(state.reason.clone())),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "locationStates",
                Json::Arr(
                    self.location_states
                        .iter()
                        .map(|state| {
                            Json::obj(vec![
                                ("at_s", Json::Float(round(state.at_s, 3))),
                                ("locationId", Json::str(state.location_id.clone())),
                                ("loadUnitId", Json::opt_str(state.load_unit_id.clone())),
                                ("reason", Json::str(state.reason.clone())),
                            ])
                        })
                        .collect(),
                ),
            ),
        ])
    }
}
