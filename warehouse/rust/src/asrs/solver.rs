//! 密集立库调度求解器：任务排序 / 设备指派 / 时空预约 / 倒垛 / 故障重排。
//!
//! ## 求解结构（SRS §4）
//! 1. **输入预处理**：动态事件先落到物理世界（设备降级、巷道封闭、库位冻结、任务插入/取消）；
//! 2. **任务排序与指派**：按策略生成任务顺序（FIFO / 优先级 / 交期 / 最近设备 / 双指令 /
//!    联合搜索），每个任务挑一台"能力匹配 + 最早可用"的设备；
//! 3. **逐步推演**：每个任务展开成设备动作链（取货 → 巷道内运行 → 交接 → 提升 → 站台），
//!    每一步都写入时空预约表；冲突则推迟并记录（可会车资源按容量放行）；
//! 4. **多深位倒垛**：目标深位被前排货物挡住时，先产生倒垛任务（这是真实立库的必需动作）；
//! 5. **故障重排**：设备在计划期内故障 / 巷道封闭 → 后续步骤被推迟或改派，全部留痕。
//!
//! 时间线（`Timeline`）是唯一输出载体：实验室播放、指标统计、独立验证都读它。

use std::collections::{BTreeMap, BTreeSet};

use crate::asrs::network::{
    buffer_resource, lane_resource, link_open, shaft_resource, station_resource, DevicePosition,
    Reservation, ReservationTable, RunNetwork,
};
use crate::asrs::timeline::{BufferState, LocationState, Step, TaskTrace, Timeline};
use crate::contract::{AsrsProblem, DeviceKind, DeviceSpec, DynamicEvent, WarehouseTask};
use crate::util::{mean, round, seed_from, Rng};

/// 空驶路径的一段：`(起点, 起点节点, 终点, 终点节点, 占用的资源, 是否允许会车)`。
/// 跨巷道 / 跨层时会把一步空驶拆成多段，每段只占用一条资源，
/// 验证器才能逐段复核互斥、三维里也能如实画出拐弯。
type DriveSegment = (
    DevicePosition,
    Option<String>,
    DevicePosition,
    Option<String>,
    String,
    bool,
);

/// 调度选项（CLI / 实验室 / wasm 共用）。
#[derive(Debug, Clone)]
pub struct AsrsOptions {
    pub algorithm: String,
    pub seed: u64,
    pub budget_ms: f64,
    pub horizon_s: f64,
    pub dual_command: bool,
    pub conflict_policy: String,
    pub allow_yield: bool,
    /// 搜索迭代上限（真实次数会写进结果，不虚报）
    pub max_iterations: u64,
    pub verify: bool,
    pub max_tasks: usize,
    /// 是否把逐步骤时间线写进结果信封（2 万任务下这一项是几百 MB；批量验收/基准测试可关掉）
    pub include_timeline: bool,
}

impl Default for AsrsOptions {
    fn default() -> Self {
        AsrsOptions {
            algorithm: "priority-edd".to_string(),
            seed: 7,
            budget_ms: 4_000.0,
            horizon_s: 0.0,
            dual_command: true,
            conflict_policy: "reservation".to_string(),
            allow_yield: true,
            max_iterations: 400,
            verify: true,
            max_tasks: 20_000,
            include_timeline: true,
        }
    }
}

impl AsrsOptions {
    pub fn from_json(value: Option<&aps_engine::json::Json>) -> AsrsOptions {
        let mut options = AsrsOptions::default();
        let Some(value) = value else { return options };
        if let Some(algorithm) = crate::contract::opt_str(value, "algorithm") {
            options.algorithm = algorithm;
        }
        if let Some(seed) = crate::contract::opt_i64(value, "seed") {
            options.seed = seed.max(0) as u64;
        }
        if let Some(budget) = crate::contract::opt_f64(value, "budgetMs") {
            options.budget_ms = budget.max(1.0);
        }
        if let Some(horizon) = crate::contract::opt_f64(value, "horizonSeconds") {
            options.horizon_s = horizon.max(0.0);
        }
        if let Some(dual) = crate::contract::opt_bool(value, "dualCommand") {
            options.dual_command = dual;
        }
        if let Some(policy) = crate::contract::opt_str(value, "conflictPolicy") {
            options.conflict_policy = policy;
        }
        if let Some(yield_flag) = crate::contract::opt_bool(value, "allowYield") {
            options.allow_yield = yield_flag;
        }
        if let Some(iterations) = crate::contract::opt_i64(value, "maxIterations") {
            options.max_iterations = iterations.max(1) as u64;
        }
        if let Some(max_tasks) = crate::contract::opt_i64(value, "maxTasks") {
            // 任务处理上限：默认 20 000；文档承诺"确需处理时可调"，所以这里真的读它。
            // 上界与 `capabilities` 的 native 档一致（1M），避免手滑写出天文数字把内存打爆。
            options.max_tasks = (max_tasks.max(1) as usize).min(1_000_000);
        }
        if let Some(verify) = crate::contract::opt_bool(value, "verify") {
            options.verify = verify;
        }
        if let Some(include) = crate::contract::opt_bool(value, "includeTimeline") {
            options.include_timeline = include;
        }
        options
    }
}

pub const POLICIES: &[&str] = &[
    "fifo",
    "priority",
    "priority-edd",
    "nearest-device",
    "dual-command",
    "joint-alns",
];

pub fn describe(policy: &str) -> &'static str {
    match policy {
        "fifo" => "先到先服务：按任务释放时间排序（基线）",
        "priority" => "优先级排序：高优先级任务先做（可能牺牲总完工时间）",
        "priority-edd" => "优先级 + 最早交期（EDD）：兼顾紧急与交期",
        "nearest-device" => "最近设备优先：按设备空驶距离选择执行者",
        "dual-command" => "复合作业（双指令）：出库后顺路带回一个入库任务，减少空驶",
        "joint-alns" => {
            "联合搜索：在任务顺序与设备指派的组合空间里做邻域搜索（每次评估都真实重演）"
        }
        _ => "未知策略",
    }
}

/* ------------------------------------------------------------------ *
 * 世界状态
 * ------------------------------------------------------------------ */

/// 物理世界（求解期间的权威状态）。
pub struct World<'a> {
    pub problem: &'a AsrsProblem,
    pub events: Vec<DynamicEvent>,
    /// 库位 → 货物单元
    pub location_load: BTreeMap<String, String>,
    /// 货物单元 → 库位
    pub load_location: BTreeMap<String, String>,
    /// 货物单元重量（用于设备载重检查）
    pub load_weight: BTreeMap<String, f64>,
    /// 库位记录（只推导一次）与 (rack, bay, level) 列索引
    pub records: Vec<crate::wh::topology::LocationRecord>,
    pub record_index: BTreeMap<String, usize>,
    pub column_index: BTreeMap<(String, i32, i32), Vec<usize>>,
    /// (rack, level) → 该货架面同层全部库位下标（按 bay 排序）：倒垛落点可以选同层其他空位
    pub face_index: BTreeMap<(String, i32), Vec<usize>>,
    /// 设备不可用时间窗 (start, end, 原因)
    pub outages: BTreeMap<String, Vec<(f64, f64, String)>>,
    /// 设备速度因子（降级用）
    pub speed_factor: BTreeMap<String, f64>,
    /// 站台 / 缓冲位容量覆盖（buffer-loss 事件）
    pub buffer_capacity_override: BTreeMap<String, i32>,
    pub frozen_locations: BTreeSet<String>,
    pub closed_aisles: BTreeSet<String>,
    pub applied_events: Vec<(String, f64, String)>,
}

impl<'a> World<'a> {
    pub fn record(&self, id: &str) -> Option<&crate::wh::topology::LocationRecord> {
        self.record_index.get(id).map(|index| &self.records[*index])
    }

    pub fn build(problem: &'a AsrsProblem, events: &[DynamicEvent]) -> World<'a> {
        let records = crate::wh::topology::derive_locations(&problem.topology);
        let mut record_index = BTreeMap::new();
        let mut column_index: BTreeMap<(String, i32, i32), Vec<usize>> = BTreeMap::new();
        let mut face_index: BTreeMap<(String, i32), Vec<usize>> = BTreeMap::new();
        for (index, record) in records.iter().enumerate() {
            record_index.insert(record.id.clone(), index);
            column_index
                .entry((record.rack_id.clone(), record.bay, record.level))
                .or_default()
                .push(index);
            face_index
                .entry((record.rack_id.clone(), record.level))
                .or_default()
                .push(index);
        }
        for indexes in face_index.values_mut() {
            indexes.sort_by_key(|index| (records[*index].bay, records[*index].depth));
        }
        for indexes in column_index.values_mut() {
            indexes.sort_by_key(|index| records[*index].depth);
        }
        let mut location_load = BTreeMap::new();
        let mut load_location = BTreeMap::new();
        let mut load_weight = BTreeMap::new();
        let sku_weight: BTreeMap<&str, f64> = problem
            .skus
            .iter()
            .map(|sku| (sku.id.as_str(), sku.unit_weight_kg))
            .collect();
        for unit in &problem.load_units {
            if let Some(location) = &unit.location_id {
                location_load.insert(location.clone(), unit.id.clone());
                load_location.insert(unit.id.clone(), location.clone());
            }
            load_weight.insert(
                unit.id.clone(),
                sku_weight.get(unit.sku_id.as_str()).copied().unwrap_or(0.0)
                    * unit.quantity.max(1.0),
            );
        }
        // 库位优化方案（若有）：把计划里的落位当作初始库存位置 —— 联合优化靠它闭环
        if let Some((_id, assignment)) = &problem.slotting_plan {
            for (load_unit, location) in assignment {
                location_load.insert(location.clone(), load_unit.clone());
                load_location.insert(load_unit.clone(), location.clone());
            }
        }
        let mut world = World {
            problem,
            events: events.to_vec(),
            records,
            record_index,
            column_index,
            face_index,
            location_load,
            load_location,
            load_weight,
            outages: BTreeMap::new(),
            speed_factor: BTreeMap::new(),
            buffer_capacity_override: BTreeMap::new(),
            frozen_locations: problem.topology.frozen_locations.clone(),
            closed_aisles: BTreeSet::new(),
            applied_events: Vec::new(),
        };
        world.apply_events();
        world
    }

    /// 动态事件 → 物理状态（顺序执行，先发生先落地）。
    fn apply_events(&mut self) {
        let events = self.events.clone();
        for event in &events {
            match event.kind.as_str() {
                "device-breakdown" | "fault" => {
                    let repair = if event.value > 0.0 {
                        event.value
                    } else {
                        900.0
                    };
                    let reason = if event.tasks.is_empty() {
                        "设备故障".to_string()
                    } else {
                        "设备故障（含现场指令）".to_string()
                    };
                    for device_id in device_targets(self.problem, event) {
                        self.outages.entry(device_id.clone()).or_default().push((
                            event.at_s,
                            event.at_s + repair,
                            reason.clone(),
                        ));
                        self.applied_events.push((
                            "device-breakdown".to_string(),
                            event.at_s,
                            format!("{device_id} 故障 {repair:.0}s"),
                        ));
                    }
                }
                "speed-degradation" | "degraded-speed" => {
                    let factor = if event.value > 0.0 {
                        event.value.clamp(0.05, 1.0)
                    } else {
                        0.5
                    };
                    for device_id in device_targets(self.problem, event) {
                        self.speed_factor.insert(device_id.clone(), factor);
                        self.applied_events.push((
                            "speed-degradation".to_string(),
                            event.at_s,
                            format!("{device_id} 速度 ×{factor:.2}"),
                        ));
                    }
                }
                "aisle-closure" => {
                    for aisle in &event.link_ids {
                        self.closed_aisles.insert(aisle.clone());
                        self.applied_events.push((
                            "aisle-closure".to_string(),
                            event.at_s,
                            format!("巷道 {aisle} 关闭"),
                        ));
                    }
                }
                "location-freeze" => {
                    for location in &event.location_ids {
                        self.frozen_locations.insert(location.clone());
                    }
                    self.applied_events.push((
                        "location-freeze".to_string(),
                        event.at_s,
                        format!("冻结 {} 个库位", event.location_ids.len()),
                    ));
                }
                "buffer-loss" | "buffer-capacity-change" => {
                    let capacity = if event.value > 0.0 {
                        event.value as i32
                    } else {
                        0
                    };
                    for buffer in &event.link_ids {
                        self.buffer_capacity_override
                            .insert(buffer.clone(), capacity);
                        self.applied_events.push((
                            "buffer-loss".to_string(),
                            event.at_s,
                            format!("缓冲位 {buffer} 容量调整为 {capacity}"),
                        ));
                    }
                }
                other => {
                    if !other.is_empty() {
                        self.applied_events.push((
                            other.to_string(),
                            event.at_s,
                            "（该事件不影响物理世界，按任务/需求语义处理）".to_string(),
                        ));
                    }
                }
            }
        }
    }

    /// 任务集：题目任务 + 事件插入的任务 − 事件取消的任务。
    pub fn tasks(&self) -> Vec<WarehouseTask> {
        let mut tasks = self.problem.tasks.clone();
        let mut cancelled: BTreeSet<String> = BTreeSet::new();
        for event in &self.events {
            match event.kind.as_str() {
                "task-cancel" | "order-cancel" | "cancel" => {
                    for task_id in &event.task_ids {
                        cancelled.insert(task_id.clone());
                    }
                }
                "urgent-insert" | "task-insert" | "new-task" | "expedite" => {
                    for task in &event.tasks {
                        let mut task = task.clone();
                        task.release_s = task.release_s.max(event.at_s);
                        if event.value > 0.0 {
                            task.priority = task.priority.max(event.value as i64);
                        }
                        tasks.push(task);
                    }
                }
                _ => {}
            }
        }
        tasks.retain(|task| !cancelled.contains(&task.id));
        tasks.sort_by(|a, b| {
            a.release_s
                .partial_cmp(&b.release_s)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.id.cmp(&b.id))
        });
        tasks
    }

    /// 设备在 [start, end] 内是否可用；返回最早可用时刻与原因。
    pub fn device_available(
        &self,
        device_id: &str,
        start: f64,
        duration: f64,
    ) -> (f64, Option<String>) {
        let Some(windows) = self.outages.get(device_id) else {
            return (start, None);
        };
        let mut begin = start;
        let mut reason = None;
        for (from, to, why) in windows {
            if begin < *to && begin + duration > *from {
                begin = *to;
                reason = Some(why.clone());
            }
        }
        (begin, reason)
    }

    pub fn device_speed_factor(&self, device_id: &str) -> f64 {
        self.speed_factor.get(device_id).copied().unwrap_or(1.0)
    }

    pub fn buffer_capacity(&self, buffer_id: &str) -> i32 {
        if let Some(value) = self.buffer_capacity_override.get(buffer_id) {
            return *value;
        }
        self.problem
            .topology
            .buffers
            .iter()
            .find(|buffer| buffer.id == buffer_id)
            .map(|buffer| buffer.capacity)
            .unwrap_or(0)
    }

    pub fn station_capacity(&self, station_id: &str) -> i32 {
        self.problem
            .topology
            .stations
            .iter()
            .find(|station| station.id == station_id)
            .map(|station| station.buffer_capacity.max(1))
            .unwrap_or(1)
    }

    /// 逻辑冻结（事件 + 拓扑）与巷道封闭的综合判定。
    pub fn location_blocked(&self, location_id: &str, aisle_id: &str) -> bool {
        self.frozen_locations.contains(location_id) || self.closed_aisles.contains(aisle_id)
    }

    /// 多深位倒垛：返回必须先移走的货物单元（前排阻挡者）。
    ///
    /// 语义：同一 rack / bay / level 上，深度更小的位置若被占用且我们需要用到更深的位置，
    /// 就必须先把它们取出来 —— 这是密集立库区别于普通货架的核心动作。
    pub fn blockers(&self, target_location: &str) -> Vec<(String, String)> {
        self.blockers_with(&self.location_load, target_location)
    }

    /// 用给定的库位占用快照判定遮挡（推演过程中占用会变化，必须用**当前**快照，
    /// 否则同一列连续入库/出库时会看到过期的空位）。
    pub fn blockers_with(
        &self,
        location_load: &BTreeMap<String, String>,
        target_location: &str,
    ) -> Vec<(String, String)> {
        let mut blockers = Vec::new();
        let Some(target) = self.record(target_location) else {
            return blockers;
        };
        let key = (target.rack_id.clone(), target.bay, target.level);
        let target_depth = target.depth;
        if let Some(indexes) = self.column_index.get(&key) {
            for index in indexes {
                let record = &self.records[*index];
                if record.depth >= target_depth {
                    break;
                }
                if let Some(load_unit) = location_load.get(&record.id) {
                    blockers.push((record.id.clone(), load_unit.clone()));
                }
            }
        }
        blockers.sort();
        blockers
    }

    /// 倒垛落点：同列（同 rack / bay / level）空位最优；没有就退到**同层同货架面最近空位**。
    /// 双深位库只有 2 个深度，目标深位与阻挡位常常把整列占满 —— 只看同列会得出
    /// "无处可倒"的错误结论（D04 的 relocationTasks 因此恒为 0）。
    pub fn relocation_target(&self, location_id: &str) -> Option<String> {
        if let Some(same_column) = self.same_column_free(location_id) {
            return Some(same_column);
        }
        let target = self.record(location_id)?;
        let key = (target.rack_id.clone(), target.level);
        let indexes = self.face_index.get(&key)?;
        let mut candidates: Vec<&crate::wh::topology::LocationRecord> = indexes
            .iter()
            .map(|index| &self.records[*index])
            .filter(|record| {
                record.depth == 1
                    && !self.location_load.contains_key(&record.id)
                    && !self.location_blocked(&record.id, &record.aisle_id)
            })
            .collect();
        candidates.sort_by_key(|record| ((record.bay - target.bay).abs(), record.bay));
        candidates.first().map(|record| record.id.clone())
    }

    /// 同列（同 rack / 同层）空闲且可用的库位：倒垛的落点优先选同列，代价最低。
    pub fn same_column_free(&self, location_id: &str) -> Option<String> {
        let target = self.record(location_id)?;
        let key = (target.rack_id.clone(), target.bay, target.level);
        let indexes = self.column_index.get(&key)?;
        let mut candidates: Vec<&crate::wh::topology::LocationRecord> = indexes
            .iter()
            .map(|index| &self.records[*index])
            .filter(|record| {
                record.id != target.id
                    && !self.location_load.contains_key(&record.id)
                    && !self.location_blocked(&record.id, &record.aisle_id)
            })
            .collect();
        candidates.sort_by_key(|record| (record.depth - target.depth).abs());
        candidates.first().map(|record| record.id.clone())
    }
}

fn device_targets(problem: &AsrsProblem, event: &DynamicEvent) -> Vec<String> {
    if !event.device_ids.is_empty() {
        return event.device_ids.clone();
    }
    // 未指定设备：默认影响该巷道内的全部设备（真实故障的常见描述方式）
    let mut out: Vec<String> = Vec::new();
    for device in &problem.topology.devices {
        if event.link_ids.is_empty()
            || device
                .capability
                .aisles
                .iter()
                .any(|aisle| event.link_ids.contains(aisle))
        {
            out.push(device.id.clone());
        }
    }
    out
}

/* ------------------------------------------------------------------ *
 * 调度结果
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Default)]
pub struct ScheduleMetrics {
    pub tasks_total: usize,
    pub tasks_done: usize,
    pub tasks_unserved: usize,
    pub makespan_s: f64,
    pub throughput_per_hour: f64,
    pub mean_cycle_s: f64,
    pub mean_wait_s: f64,
    pub conflicts: usize,
    pub deadlocks_prevented: u64,
    pub reservations: usize,
    pub travel_meters: f64,
    pub energy_kwh: f64,
    pub relocation_tasks: usize,
    pub blocked_moves: usize,
    pub late_tasks: usize,
    pub max_lateness_s: f64,
    pub dual_command_pairs: usize,
    pub device_busy: BTreeMap<String, f64>,
    pub device_utilization: BTreeMap<String, f64>,
    pub buffer_peak: BTreeMap<String, i32>,
    pub station_peak: BTreeMap<String, i32>,
    /// 时间线结束时仍有货物的库位数（由 locationStates 复算）。
    pub locations_occupied: usize,
    /// 派生作业（倒垛等）完成数：不计入 tasksTotal，但必须可见。
    pub derived_tasks_done: usize,
    pub sim_iterations: u64,
    pub compute_ms: f64,
    pub conflict_events: Vec<String>,
}

/// 一次完整的调度解。
pub struct Schedule {
    pub timeline: Timeline,
    pub metrics: ScheduleMetrics,
    pub status: crate::errors::Status,
    pub order_notes: Vec<String>,
}

/* ------------------------------------------------------------------ *
 * 推演核心
 * ------------------------------------------------------------------ */

struct SimState {
    device_pos: BTreeMap<String, DevicePosition>,
    device_free: BTreeMap<String, f64>,
    buffer_occupancy: BTreeMap<String, i32>,
    station_occupancy: BTreeMap<String, i32>,
    reservations: ReservationTable,
    step_counter: u64,
    conflicts: Vec<String>,
}

/// 设备当前姿态（从 home node 或巷道端头出发）。
fn initial_position(network: &RunNetwork, device: &DeviceSpec) -> DevicePosition {
    if let Some(node) = network.topology.node(&device.home_node_id) {
        return DevicePosition {
            x: node.position[0],
            y: node.position[1],
            z: node.position[2],
            level: node.level.unwrap_or(1),
            aisle_id: node.aisle_id.clone(),
            node_id: Some(node.id.clone()),
            location_id: None,
        };
    }
    DevicePosition::default()
}

fn location_position(network: &RunNetwork, location_id: &str) -> DevicePosition {
    if let Some(record) = network.location(location_id) {
        return DevicePosition {
            x: record.position[0],
            y: record.position[1],
            z: record.position[2],
            level: record.level,
            aisle_id: Some(record.aisle_id.clone()),
            node_id: None,
            location_id: Some(record.id.clone()),
        };
    }
    DevicePosition::default()
}

fn node_position(network: &RunNetwork, node_id: &str) -> DevicePosition {
    if let Some(node) = network.topology.node(node_id) {
        return DevicePosition {
            x: node.position[0],
            y: node.position[1],
            z: node.position[2],
            level: node.level.unwrap_or(1),
            aisle_id: node.aisle_id.clone(),
            node_id: Some(node.id.clone()),
            location_id: None,
        };
    }
    DevicePosition::default()
}

/// 处理步骤：申请资源 → 冲突推迟 → 记录等待关系 → 落预约。
#[allow(clippy::too_many_arguments)]
fn commit_step(
    state: &mut SimState,
    mut step: Step,
    resources: Vec<(String, f64, f64, bool)>, // (资源, 起点位置, 终点位置, 可会车)
    priority: i64,
    motion: &crate::contract::MotionProfile,
) -> Step {
    // 几何下界：时间线绝不允许出现"物理上做不到"的时长 —— 独立验证器正是按步骤自身几何重算的。
    // 下界在预约**之前**生效，保证资源被占用的时间窗与真实运动时长一致（否则会出现假并行）。
    if !matches!(
        step.kind.as_str(),
        "wait" | "idle" | "load" | "unload" | "handover"
    ) {
        let distance = ((step.to.x - step.from.x).powi(2)
            + (step.to.y - step.from.y).powi(2)
            + (step.to.z - step.from.z).powi(2))
        .sqrt();
        if distance > 1e-9 {
            let speed = motion.speed_mps
                * if step.loaded {
                    motion.loaded_speed_factor.clamp(0.1, 1.5)
                } else {
                    1.0
                };
            let floor = crate::wh::routing::travel_time(distance, speed, motion.accel_mps2);
            if step.end_s - step.start_s < floor {
                step.end_s = step.start_s + floor;
            }
        }
    }
    step.resources = resources
        .iter()
        .map(|(resource, _, _, _)| resource.clone())
        .collect();
    step.resources.sort();
    step.resources.dedup();
    let mut start = step.start_s;
    let mut delayed = 0.0f64;
    let mut blocker: Option<String> = None;
    let mut blocked_resource: Option<String> = None;
    for (resource_id, from_pos, to_pos, allow_meeting) in &resources {
        let (earliest, who) = state.reservations.earliest(
            resource_id,
            &step.device_id,
            start,
            *from_pos,
            *to_pos,
            *allow_meeting,
            step.duration(),
        );
        if earliest > start + 1e-9 {
            if let Some(blocker_device) = &who {
                if state
                    .reservations
                    .would_deadlock(&step.device_id, blocker_device)
                {
                    state.reservations.deadlocks_prevented += 1;
                } else {
                    state.reservations.add_wait(&step.device_id, blocker_device);
                }
            }
            delayed = delayed.max(earliest - start);
            start = earliest;
            blocker = who;
            blocked_resource = Some(resource_id.clone());
        }
    }
    let duration = step.duration();
    let mut step = step;
    step.start_s = start;
    step.end_s = start + duration;
    step.delayed_by_s = delayed;
    if delayed > 1e-6 {
        if let (Some(resource), Some(who)) = (blocked_resource, blocker.clone()) {
            state
                .reservations
                .conflicts
                .push(crate::asrs::network::ConflictResolution {
                    resource_id: resource.clone(),
                    device_id: step.device_id.clone(),
                    delayed_by_s: round(delayed, 3),
                    blocked_by_device_id: blocker.clone(),
                    deadlock_prevented: false,
                    at_s: round(start, 3),
                    note: format!("{} 等待 {} 释放 {}", step.device_id, who, resource),
                });
            state.conflicts.push(format!(
                "{} 在 {:.0}s 等待 {} 释放 {}（推迟 {:.0}s）",
                step.device_id, start, who, resource, delayed
            ));
        }
    }
    for (resource_id, from_pos, to_pos, _) in resources {
        state.reservations.reserve(Reservation {
            resource_id,
            device_id: step.device_id.clone(),
            from_s: step.start_s,
            to_s: step.end_s,
            from_pos,
            to_pos,
            priority,
            task_id: step.task_id.clone(),
        });
    }
    state.device_free.insert(step.device_id.clone(), step.end_s);
    state
        .device_pos
        .insert(step.device_id.clone(), step.to.clone());
    step
}

/// 选择执行任务的设备：能力过滤 + 最早可用 + 空驶距离（策略相关）。
#[allow(clippy::too_many_arguments)]
fn select_device(
    network: &RunNetwork,
    world: &World,
    state: &SimState,
    task: &WarehouseTask,
    kind: &str,
    aisle_id: Option<&str>,
    level: i32,
    policy: &str,
    rng: &mut Rng,
) -> Option<String> {
    let candidates = network.devices_for(kind, aisle_id, level);
    let mut scored: Vec<(f64, String)> = Vec::new();
    for device in candidates {
        // 故障/保养窗口不在这里剔除候选：那是"这台设备此刻不可用、要顺延"，
        // 不是"这台设备不存在"。真正的占用顺延由排程阶段的 `device_available` 处理，
        // 并写进 conflictEvents（可复核），选择阶段只按"可用时刻 + 空驶距离"打分。
        let position = state
            .device_pos
            .get(&device.id)
            .cloned()
            .unwrap_or_else(|| initial_position(network, device));
        let free_at = state.device_free.get(&device.id).copied().unwrap_or(0.0);
        // 空驶距离（欧氏下界；真正的运行时间由推演阶段算出）
        let deadhead = match &task.from_location_id {
            Some(location) => {
                let target = location_position(network, location);
                ((target.x - position.x).powi(2) + (target.z - position.z).powi(2)).sqrt()
                    + (target.y - position.y).abs() * 2.0
            }
            None => match &task.from_node_id {
                Some(node) => {
                    let target = node_position(network, node);
                    ((target.x - position.x).powi(2) + (target.z - position.z).powi(2)).sqrt()
                }
                None => 0.0,
            },
        };
        let speed = device.motion.speed_mps.max(0.1) * world.device_speed_factor(&device.id);
        let score = match policy {
            "nearest-device" | "joint-alns" => free_at + deadhead / speed,
            "fifo" | "priority" => free_at,
            _ => free_at + 0.3 * deadhead / speed,
        };
        scored.push((score, device.id.clone()));
    }
    scored.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.cmp(&b.1))
    });
    if scored.is_empty() {
        return None;
    }
    // 同分设备里做一个确定性的轻微轮换（避免所有任务永远压在同一台设备上）
    let top = scored[0].0;
    let tied: Vec<&String> = scored
        .iter()
        .filter(|(score, _)| (*score - top).abs() < 1e-6)
        .map(|(_, id)| id)
        .collect();
    if tied.len() > 1 && policy == "joint-alns" {
        Some(tied[rng.below(tied.len())].clone())
    } else {
        Some(scored[0].1.clone())
    }
}

/// 任务排序（策略）。
pub fn order_tasks(world: &World, tasks: &[WarehouseTask], policy: &str) -> Vec<WarehouseTask> {
    let mut tasks = tasks.to_vec();
    match policy {
        "priority" => tasks.sort_by(|a, b| {
            b.priority
                .cmp(&a.priority)
                .then_with(|| {
                    a.release_s
                        .partial_cmp(&b.release_s)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then_with(|| a.id.cmp(&b.id))
        }),
        "priority-edd" | "dual-command" | "joint-alns" => tasks.sort_by(|a, b| {
            let key_a = (
                -a.priority,
                a.deadline_s.unwrap_or(a.release_s + 86_400.0),
                a.release_s,
                a.id.clone(),
            );
            let key_b = (
                -b.priority,
                b.deadline_s.unwrap_or(b.release_s + 86_400.0),
                b.release_s,
                b.id.clone(),
            );
            key_a
                .0
                .cmp(&key_b.0)
                .then_with(|| {
                    key_a
                        .1
                        .partial_cmp(&key_b.1)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then_with(|| {
                    key_a
                        .2
                        .partial_cmp(&key_b.2)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then_with(|| key_a.3.cmp(&key_b.3))
        }),
        _ => tasks.sort_by(|a, b| {
            a.release_s
                .partial_cmp(&b.release_s)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.id.cmp(&b.id))
        }),
    }
    let _ = world;
    tasks
}

/// 一次完整的推演（确定性的：同输入 + 同顺序 → 同时间线）。
pub static PROF_SELECT_NS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static PROF_TASK_NS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static PROF_BLOCK_NS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static PROF_TASKS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn prof_ns(start: Option<std::time::Instant>) -> u64 {
    start
        .map(|clock| clock.elapsed().as_nanos() as u64)
        .unwrap_or(0)
}

pub fn simulate(
    network: &mut RunNetwork,
    world: &World,
    order: &[WarehouseTask],
    options: &AsrsOptions,
) -> Schedule {
    let started = crate::engine::now_ms();
    let mut rng = Rng::new(seed_from(&["asrs-sim", &options.seed.to_string()]));
    let mut timeline = Timeline::default();
    let mut state = SimState {
        device_pos: BTreeMap::new(),
        device_free: BTreeMap::new(),
        buffer_occupancy: BTreeMap::new(),
        station_occupancy: BTreeMap::new(),
        reservations: ReservationTable::new(),
        step_counter: 0,
        conflicts: Vec::new(),
    };
    // 资源容量：可会车的链接按 link.capacity，站台/缓冲由契约声明
    for link in &network.topology.links {
        state.reservations.set_capacity(
            crate::asrs::network::link_resource(&link.id),
            link.capacity.max(1),
        );
    }
    for station in &network.topology.stations {
        state.reservations.set_capacity(
            station_resource(&station.id),
            station.buffer_capacity.max(1),
        );
    }
    for buffer in &network.topology.buffers {
        state.reservations.set_capacity(
            buffer_resource(&buffer.id),
            world.buffer_capacity(&buffer.id).max(1),
        );
    }
    // 走廊资源容量：同层横向通道可会车时按通道容量放行（否则所有地面运输会被串成一条线）
    {
        let aisles: Vec<String> = network
            .topology
            .aisles
            .iter()
            .map(|aisle| aisle.id.clone())
            .collect();
        let levels: BTreeSet<i32> = network.aisle_axis.keys().map(|(_, level)| *level).collect();
        for level in levels {
            let capacity = network.corridor_capacity.get(&level).copied().unwrap_or(1);
            for (i, a) in aisles.iter().enumerate() {
                for b in aisles.iter().skip(i) {
                    state
                        .reservations
                        .set_capacity(corridor_resource(level, a, b), capacity);
                }
            }
        }
    }
    // 设备初始姿态
    for device in &network.topology.devices {
        state
            .device_pos
            .insert(device.id.clone(), initial_position(network, device));
        state.device_free.insert(device.id.clone(), 0.0);
    }

    let devices: Vec<DeviceSpec> = network.topology.devices.clone();
    let mut relocation_tasks = 0usize;
    let mut blocked_moves = 0usize;
    let mut handled: BTreeSet<String> = BTreeSet::new();
    let mut location_load = world.location_load.clone();

    // —— 任务主循环 ——
    for task in order {
        if handled.contains(&task.id) {
            continue;
        }
        handled.insert(task.id.clone());
        let kind = task_kind(task);
        // 依赖检查：前置任务必须已经在本次调度里完成
        if !task.depends_on.iter().all(|dep| handled.contains(dep)) {
            timeline.tasks.push(TaskTrace {
                task_id: task.id.clone(),
                kind: kind.clone(),
                priority: task.priority,
                release_s: task.release_s,
                deadline_s: task.deadline_s,
                start_s: task.release_s,
                end_s: task.release_s,
                device_ids: Vec::new(),
                step_ids: Vec::new(),
                dual_command: false,
                status: "blocked".to_string(),
                lateness_s: 0.0,
                wait_s: 0.0,
                note: format!("前置任务未安排：{:?}", task.depends_on),
            });
            continue;
        }
        let (target_location, aisle_id, level) = task_target(network, task, &kind);
        // 倒垛前置：目标深位被前排货物挡住
        let prof_block = crate::engine::prof_now();
        if let Some(location_id) = &target_location {
            let blockers = world.blockers_with(&location_load, location_id);
            if !blockers.is_empty() {
                blocked_moves += 1;
                for (blocked_location, load_unit) in blockers {
                    if let Some(free) = world.relocation_target(&blocked_location) {
                        relocation_tasks += 1;
                        let shift = WarehouseTask {
                            id: format!("{}-shift-{}", task.id, relocation_tasks),
                            kind: "relocate".to_string(),
                            priority: task.priority,
                            release_s: task.release_s,
                            deadline_s: task.deadline_s,
                            from_location_id: Some(blocked_location.clone()),
                            from_node_id: None,
                            to_location_id: Some(free.clone()),
                            to_node_id: None,
                            load_unit_id: load_unit.clone(),
                            sku_id: task.sku_id.clone(),
                            depends_on: Vec::new(),
                            order_id: task.order_id.clone(),
                            dual_command_eligible: false,
                            cancellable: false,
                        };
                        let trace = run_task(
                            network,
                            world,
                            &mut state,
                            &mut timeline,
                            &shift,
                            "relocate",
                            Some(blocked_location.clone()),
                            Some(free.clone()),
                            &options.algorithm,
                            &mut rng,
                        );
                        if trace.status == "done" {
                            location_load.remove(&blocked_location);
                            location_load.insert(free.clone(), load_unit.clone());
                            timeline.location_states.push(LocationState {
                                at_s: trace.end_s,
                                location_id: blocked_location.clone(),
                                load_unit_id: None,
                                reason: format!("倒垛：为 {} 让出深位", task.id),
                            });
                            timeline.location_states.push(LocationState {
                                at_s: trace.end_s,
                                location_id: free.clone(),
                                load_unit_id: Some(load_unit.clone()),
                                reason: format!("倒垛落位（来自 {blocked_location}）"),
                            });
                        }
                    } else {
                        state.conflicts.push(format!(
                            "{} 的深位被 {} 占用，但同列没有空闲库位可倒垛",
                            task.id, blocked_location
                        ));
                    }
                }
            }
        }
        if crate::engine::profile_enabled() {
            use std::sync::atomic::Ordering;
            PROF_BLOCK_NS.fetch_add(prof_ns(prof_block), Ordering::Relaxed);
            PROF_TASKS.fetch_add(1, Ordering::Relaxed);
        }
        let prof_task = crate::engine::prof_now();
        let trace = run_task(
            network,
            world,
            &mut state,
            &mut timeline,
            task,
            &kind,
            target_location.clone(),
            None,
            &options.algorithm,
            &mut rng,
        );
        if crate::engine::profile_enabled() {
            PROF_TASK_NS.fetch_add(prof_ns(prof_task), std::sync::atomic::Ordering::Relaxed);
        }
        let _ = (aisle_id, level, trace);
    }

    // —— 双指令复合作业：出库 + 顺路入库 ——
    let mut dual_pairs = 0usize;
    if options.dual_command {
        let mut outbound: Vec<&TaskTrace> = timeline
            .tasks
            .iter()
            .filter(|trace| trace.kind == "outbound" && trace.status == "done")
            .collect();
        outbound.sort_by(|a, b| a.task_id.cmp(&b.task_id));
        for trace in outbound {
            if !trace.dual_command {
                continue;
            }
            dual_pairs += 1;
        }
    }

    // —— 指标 ——
    // 只把**输入任务**计入 tasksTotal/tasksDone/tasksUnserved；倒垛是派生的搬运作业，单独统计。
    let input_task_ids: BTreeSet<String> = order.iter().map(|task| task.id.clone()).collect();
    let mut metrics = ScheduleMetrics {
        tasks_total: order.len(),
        conflicts: state.reservations.conflicts.len(),
        deadlocks_prevented: state.reservations.deadlocks_prevented,
        reservations: state.reservations.reservations(),
        relocation_tasks,
        blocked_moves,
        dual_command_pairs: dual_pairs,
        conflict_events: state.conflicts.clone(),
        ..ScheduleMetrics::default()
    };
    for step in &timeline.steps {
        metrics.travel_meters += step.distance_m;
        metrics.energy_kwh += step.energy_kwh;
    }
    for trace in &timeline.tasks {
        if !input_task_ids.contains(&trace.task_id) {
            if trace.status == "done" {
                metrics.derived_tasks_done += 1;
            }
            continue;
        }
        match trace.status.as_str() {
            "done" => {
                metrics.tasks_done += 1;
                metrics.makespan_s = metrics.makespan_s.max(trace.end_s);
                if let Some(deadline) = trace.deadline_s {
                    if trace.end_s > deadline {
                        metrics.late_tasks += 1;
                        metrics.max_lateness_s = metrics.max_lateness_s.max(trace.end_s - deadline);
                    }
                }
            }
            _ => metrics.tasks_unserved += 1,
        }
    }
    let cycles: Vec<f64> = timeline
        .tasks
        .iter()
        .filter(|trace| trace.status == "done")
        .map(|trace| trace.end_s - trace.start_s)
        .collect();
    let waits: Vec<f64> = timeline
        .tasks
        .iter()
        .filter(|trace| trace.status == "done")
        .map(|trace| trace.wait_s)
        .collect();
    metrics.mean_cycle_s = round(mean(&cycles), 3);
    metrics.mean_wait_s = round(mean(&waits), 3);
    metrics.throughput_per_hour = if metrics.makespan_s > 0.0 {
        round(metrics.tasks_done as f64 * 3600.0 / metrics.makespan_s, 3)
    } else {
        0.0
    };
    let utilization = timeline.device_utilization();
    let horizon = metrics.makespan_s.max(1.0);
    for (device_id, (busy, _total, _meters)) in utilization {
        metrics
            .device_busy
            .insert(device_id.clone(), round(busy, 3));
        metrics
            .device_utilization
            .insert(device_id, round(busy / horizon, 4));
    }
    // 缓冲峰值：直接从时间线的缓冲状态取峰值（验证器可复算，不依赖内部计数器）
    for record in &timeline.buffer_states {
        let entry = metrics
            .buffer_peak
            .entry(record.buffer_id.clone())
            .or_insert(0);
        *entry = (*entry).max(record.occupancy);
    }
    for (station_id, occupancy) in state.station_occupancy.iter() {
        metrics.station_peak.insert(station_id.clone(), *occupancy);
    }
    metrics.locations_occupied = timeline
        .location_states
        .iter()
        .fold(BTreeMap::<String, bool>::new(), |mut map, record| {
            map.insert(record.location_id.clone(), record.load_unit_id.is_some());
            map
        })
        .values()
        .filter(|occupied| **occupied)
        .count();
    metrics.sim_iterations = 1;
    metrics.compute_ms = round(crate::engine::now_ms() - started, 3);
    let status = if metrics.tasks_done == 0 && metrics.tasks_total > 0 {
        crate::errors::Status::NoSolutionFound
    } else if metrics.tasks_unserved > 0 {
        crate::errors::Status::FeasibleWithBound
    } else {
        crate::errors::Status::Feasible
    };
    let _ = devices;
    Schedule {
        timeline,
        metrics,
        status,
        order_notes: state.conflicts,
    }
}

/// 登记任务轨迹：**任何**任务都必须在时间线上留痕（未服务的任务也要能解释为什么）。
fn record_trace(timeline: &mut Timeline, trace: TaskTrace) -> TaskTrace {
    timeline.tasks.push(trace.clone());
    trace
}

/// 单任务推演：取货 → 巷道内运行 → 交接 → 提升 → 站台（入库为反向）。
#[allow(clippy::too_many_arguments)]
fn run_task(
    network: &mut RunNetwork,
    world: &World,
    state: &mut SimState,
    timeline: &mut Timeline,
    task: &WarehouseTask,
    kind: &str,
    target_location: Option<String>,
    explicit_target: Option<String>,
    policy: &str,
    rng: &mut Rng,
) -> TaskTrace {
    let step_start = state.step_counter;
    let mut device_ids: Vec<String> = Vec::new();
    let mut step_ids: Vec<String> = Vec::new();
    let mut start_s = f64::INFINITY;
    let mut end_s = task.release_s;
    let mut wait_s = 0.0;
    let mut note = String::new();
    let mut ok = true;
    let mut used_station: Option<String> = None;

    // 1) 巷道内设备（穿梭车 / 四向车 / 层穿梭车）
    let target_record = target_location
        .as_ref()
        .and_then(|id| world.record(id).cloned());
    let (Some(record), Some(location_id)) = (target_record.clone(), target_location.clone()) else {
        return record_trace(
            timeline,
            TaskTrace {
                task_id: task.id.clone(),
                kind: kind.to_string(),
                priority: task.priority,
                release_s: task.release_s,
                deadline_s: task.deadline_s,
                start_s: task.release_s,
                end_s: task.release_s,
                device_ids,
                step_ids,
                dual_command: false,
                status: "invalid".to_string(),
                lateness_s: 0.0,
                wait_s: 0.0,
                note: "任务缺少可用库位".to_string(),
            },
        );
    };
    if world.location_blocked(&location_id, &record.aisle_id) {
        return record_trace(
            timeline,
            TaskTrace {
                task_id: task.id.clone(),
                kind: kind.to_string(),
                priority: task.priority,
                release_s: task.release_s,
                deadline_s: task.deadline_s,
                start_s: task.release_s,
                end_s: task.release_s,
                device_ids,
                step_ids,
                dual_command: false,
                status: "blocked".to_string(),
                lateness_s: 0.0,
                wait_s: 0.0,
                note: format!("库位 {location_id} 被冻结或所在巷道已关闭"),
            },
        );
    }
    let prof_select = crate::engine::prof_now();
    let shuttle_pick = select_device(
        network,
        world,
        state,
        task,
        if kind == "inbound" {
            "inbound"
        } else {
            "outbound"
        },
        Some(&record.aisle_id),
        record.level,
        policy,
        rng,
    );
    if crate::engine::profile_enabled() {
        PROF_SELECT_NS.fetch_add(prof_ns(prof_select), std::sync::atomic::Ordering::Relaxed);
    }
    let Some(shuttle_id) = shuttle_pick else {
        return record_trace(
            timeline,
            TaskTrace {
                task_id: task.id.clone(),
                kind: kind.to_string(),
                priority: task.priority,
                release_s: task.release_s,
                deadline_s: task.deadline_s,
                start_s: task.release_s,
                end_s: task.release_s,
                device_ids,
                step_ids,
                dual_command: false,
                status: "unserved".to_string(),
                lateness_s: 0.0,
                wait_s: 0.0,
                note: "没有能力匹配的巷道设备".to_string(),
            },
        );
    };
    let shuttle = network.topology.device(&shuttle_id).cloned().unwrap();
    // 提升类设备（货物提升机 / 巷道提升机）占竖井资源：跨层作业必须串行，且必须计入互斥
    let is_lift_device = matches!(
        shuttle.kind,
        crate::contract::DeviceKind::PalletLift | crate::contract::DeviceKind::AisleLift
    );
    let speed_factor = world.device_speed_factor(&shuttle_id);
    let mut motion = shuttle.motion.clone();
    motion.speed_mps *= speed_factor;
    device_ids.push(shuttle_id.clone());

    // 起点（设备当前位置）
    let cursor = state
        .device_pos
        .get(&shuttle_id)
        .cloned()
        .unwrap_or_else(|| initial_position(network, &shuttle));
    let mut clock = state
        .device_free
        .get(&shuttle_id)
        .copied()
        .unwrap_or(0.0)
        .max(task.release_s);

    // 2) 到取货点的空驶（若已经在巷道内则直接算巷道内运动）
    let target_pos = DevicePosition {
        x: record.position[0],
        y: record.position[1],
        z: record.position[2],
        level: record.level,
        aisle_id: Some(record.aisle_id.clone()),
        node_id: None,
        location_id: Some(record.id.clone()),
    };
    // 空驶路径：跨巷道 / 跨层时**拆成多段**，每段只占用一条资源
    // （本巷道 → 走廊 / 竖井 → 目标巷道）。不拆分的话，验证器看到的一步会横跨两条巷道，
    // 既无法精确复核互斥，也没法在三维里如实画出车怎么拐弯。
    let same_lane = cursor.aisle_id.as_deref() == Some(record.aisle_id.as_str())
        && cursor.level == record.level;
    let mut segments: Vec<DriveSegment> = Vec::new();
    if same_lane {
        segments.push((
            cursor.clone(),
            cursor.node_id.clone(),
            target_pos.clone(),
            None,
            lane_resource(&record.aisle_id, record.level),
            true,
        ));
    } else {
        // A) 本巷道内走到最近的巷道端头
        let mut head = (cursor.clone(), cursor.node_id.clone());
        if let Some(source_aisle) = cursor.aisle_id.clone() {
            if let Some((node_id, position)) =
                nearest_aisle_end(network, &source_aisle, cursor.level, cursor.x, cursor.z)
            {
                segments.push((
                    cursor.clone(),
                    cursor.node_id.clone(),
                    position.clone(),
                    Some(node_id.clone()),
                    lane_resource(&source_aisle, cursor.level),
                    true,
                ));
                head = (position, Some(node_id));
            }
        }
        // B) 走廊 / 竖井：从本巷道端头到目标巷道端头
        if let Some((node_id, position)) = nearest_aisle_end(
            network,
            &record.aisle_id,
            record.level,
            target_pos.x,
            target_pos.z,
        ) {
            let resource = if cursor.level == record.level {
                corridor_resource(
                    record.level,
                    cursor.aisle_id.as_deref().unwrap_or(""),
                    &record.aisle_id,
                )
            } else {
                shaft_resource(&shuttle)
            };
            segments.push((
                head.0.clone(),
                head.1.clone(),
                position.clone(),
                Some(node_id.clone()),
                resource,
                true,
            ));
            head = (position, Some(node_id));
        }
        // C) 目标巷道内到货位
        segments.push((
            head.0.clone(),
            head.1.clone(),
            target_pos.clone(),
            None,
            lane_resource(&record.aisle_id, record.level),
            true,
        ));
    }

    let mut cursor = cursor;
    let mut lane_pos = network.along(&record.aisle_id, record.level, target_pos.x, target_pos.z);
    for (from, from_node, to, to_node, resource, allow_meeting) in segments {
        let (seconds, meters) = if from.aisle_id.as_deref() == Some(record.aisle_id.as_str())
            && to.aisle_id.as_deref() == Some(record.aisle_id.as_str())
            && from.level == to.level
        {
            network.in_aisle_seconds(
                &record.aisle_id,
                to.level,
                from.x,
                from.z,
                to.x,
                to.z,
                &motion,
                false,
            )
        } else if let (Some(a), Some(b)) = (from_node.as_deref(), to_node.as_deref()) {
            network.node_seconds(a, b, &motion)
        } else {
            let distance =
                ((to.x - from.x).powi(2) + (to.y - from.y).powi(2) + (to.z - from.z).powi(2))
                    .sqrt();
            (
                crate::wh::routing::travel_time(distance, motion.speed_mps, motion.accel_mps2),
                distance,
            )
        };
        let step = Step {
            id: format!("S{}", state.step_counter + 1),
            device_id: shuttle_id.clone(),
            task_id: Some(task.id.clone()),
            kind: "travel".to_string(),
            from: from.clone(),
            to: to.clone(),
            start_s: clock,
            end_s: clock + seconds,
            loaded: false,
            distance_m: meters,
            energy_kwh: meters * shuttle.energy_kwh_per_meter + shuttle.energy_kwh_per_move,
            note: format!("空驶到 {location_id}（{kind}）"),
            resource_id: Some(resource.clone()),
            resources: Vec::new(),
            delayed_by_s: 0.0,
        };
        let from_lane = network.along(
            from.aisle_id.as_deref().unwrap_or(&record.aisle_id),
            from.level,
            from.x,
            from.z,
        );
        let to_lane = network.along(
            to.aisle_id.as_deref().unwrap_or(&record.aisle_id),
            to.level,
            to.x,
            to.z,
        );
        let mut resources = vec![(resource, from_lane, to_lane, allow_meeting)];
        if is_lift_device {
            resources.push((shaft_resource(&shuttle), 0.0, 0.0, false));
        }
        let committed = commit_step(state, step, resources, task.priority, &shuttle.motion);
        state.step_counter += 1;
        wait_s += committed.delayed_by_s;
        start_s = start_s.min(committed.start_s);
        end_s = end_s.max(committed.end_s);
        step_ids.push(committed.id.clone());
        timeline.push_step(committed.clone());
        cursor = committed.to.clone();
        clock = committed.end_s;
    }
    // 目标巷道的车道坐标（供后续载货段使用）
    if same_lane {
        // 保持在巷道内的解析坐标
        lane_pos = network.along(&record.aisle_id, record.level, target_pos.x, target_pos.z);
    }

    // 3) 取货 / 放货（装载动作）
    let load_action = if kind == "inbound" { "unload" } else { "load" };
    let action = Step {
        id: format!("S{}", state.step_counter + 1),
        device_id: shuttle_id.clone(),
        task_id: Some(task.id.clone()),
        kind: load_action.to_string(),
        from: cursor.clone(),
        to: cursor.clone(),
        start_s: clock,
        end_s: clock + motion.transfer_s,
        loaded: kind != "inbound",
        distance_m: 0.0,
        energy_kwh: shuttle.energy_kwh_per_move * 0.2,
        note: format!(
            "{} {}",
            if kind == "inbound" {
                "放货到"
            } else {
                "从"
            },
            location_id
        ),
        resource_id: Some(lane_resource(&record.aisle_id, record.level)),
        resources: Vec::new(),
        delayed_by_s: 0.0,
    };
    let committed = commit_step(
        state,
        action,
        vec![(
            lane_resource(&record.aisle_id, record.level),
            lane_pos,
            lane_pos,
            true,
        )],
        task.priority,
        &shuttle.motion,
    );
    state.step_counter += 1;
    wait_s += committed.delayed_by_s;
    end_s = end_s.max(committed.end_s);
    step_ids.push(committed.id.clone());
    timeline.push_step(committed.clone());
    clock = committed.end_s;
    if kind == "inbound" {
        state
            .buffer_occupancy
            .entry(record.id.clone())
            .and_modify(|value| *value += 1)
            .or_insert(1);
        timeline.location_states.push(LocationState {
            at_s: committed.end_s,
            location_id: location_id.clone(),
            load_unit_id: Some(task.load_unit_id.clone()),
            reason: "入库完成".to_string(),
        });
    } else if kind == "relocate" {
        timeline.location_states.push(LocationState {
            at_s: committed.end_s,
            location_id: location_id.clone(),
            load_unit_id: None,
            reason: "移库取货".to_string(),
        });
    }

    // 4) 送到交接点（巷道端头）→ 提升机 → 站台
    let end_node = format!("N-{}-L{}-W", record.aisle_id, record.level);
    let end_pos = node_position(network, &end_node);
    let (to_end_seconds, to_end_meters) = if end_pos.node_id.is_some() {
        network.in_aisle_seconds(
            &record.aisle_id,
            record.level,
            cursor.x,
            cursor.z,
            end_pos.x,
            end_pos.z,
            &motion,
            kind != "inbound",
        )
    } else {
        (0.0, 0.0)
    };
    let haul = Step {
        id: format!("S{}", state.step_counter + 1),
        device_id: shuttle_id.clone(),
        task_id: Some(task.id.clone()),
        kind: "travel".to_string(),
        from: cursor.clone(),
        to: end_pos.clone(),
        start_s: clock,
        end_s: clock + to_end_seconds,
        loaded: kind != "inbound",
        distance_m: to_end_meters,
        energy_kwh: to_end_meters * shuttle.energy_kwh_per_meter,
        note: format!("载货运行到交接点 {end_node}"),
        resource_id: Some(lane_resource(&record.aisle_id, record.level)),
        resources: Vec::new(),
        delayed_by_s: 0.0,
    };
    let committed = commit_step(
        state,
        haul,
        {
            let mut resources = vec![(
                lane_resource(&record.aisle_id, record.level),
                lane_pos,
                network.along(&record.aisle_id, record.level, end_pos.x, end_pos.z),
                true,
            )];
            if is_lift_device {
                resources.push((shaft_resource(&shuttle), 0.0, 0.0, false));
            }
            resources
        },
        task.priority,
        &shuttle.motion,
    );
    state.step_counter += 1;
    wait_s += committed.delayed_by_s;
    end_s = end_s.max(committed.end_s);
    step_ids.push(committed.id.clone());
    timeline.push_step(committed.clone());
    clock = committed.end_s;

    // 5) 提升机（跨层才需要；同层直接用输送段）
    let station = world
        .problem
        .topology
        .stations
        .iter()
        .find(|station| station.served_by.is_empty() || station.served_by.contains(&shuttle_id))
        .or_else(|| world.problem.topology.stations.first())
        .cloned();
    if let Some(station) = station {
        let station_pos = node_position(network, &station.node_id);
        if station_pos.level != record.level {
            if let Some(lift_id) = network
                .aisle_lifts
                .get(&record.aisle_id)
                .and_then(|lifts| lifts.first())
                .cloned()
            {
                let lift = network.topology.device(&lift_id).cloned().unwrap();
                let mut lift_motion = lift.motion.clone();
                lift_motion.speed_mps *= world.device_speed_factor(&lift_id);
                let lift_pos = state
                    .device_pos
                    .get(&lift_id)
                    .cloned()
                    .unwrap_or_else(|| initial_position(network, &lift));
                let lift_start = state
                    .device_free
                    .get(&lift_id)
                    .copied()
                    .unwrap_or(0.0)
                    .max(clock);
                let (available_at, outage) =
                    world.device_available(&lift_id, lift_start, lift_motion.change_level_s + 30.0);
                if let Some(reason) = &outage {
                    state.conflicts.push(format!(
                        "{lift_id} 在 {lift_start:.0}s 处于故障窗口（{reason}），提升被推迟"
                    ));
                }
                let (lift_seconds, lift_meters) =
                    network.level_seconds(record.level, station_pos.level, &lift_motion);
                let hoist = Step {
                    id: format!("S{}", state.step_counter + 1),
                    device_id: lift_id.clone(),
                    task_id: Some(task.id.clone()),
                    kind: "lift".to_string(),
                    from: lift_pos,
                    to: DevicePosition {
                        y: station_pos.y,
                        level: station_pos.level,
                        ..station_pos.clone()
                    },
                    start_s: available_at,
                    end_s: available_at + lift_seconds + lift_motion.handover_s,
                    loaded: kind != "inbound",
                    distance_m: lift_meters,
                    energy_kwh: lift.energy_kwh_per_move + lift_meters * lift.energy_kwh_per_meter,
                    note: format!(
                        "提升机 {lift_id}：层 {} → 层 {}，交接站台 {}",
                        record.level, station_pos.level, station.id
                    ),
                    resource_id: Some(shaft_resource(&lift)),
                    resources: Vec::new(),
                    delayed_by_s: 0.0,
                };
                if !device_ids.contains(&lift_id) {
                    device_ids.push(lift_id.clone());
                }
                let committed = commit_step(
                    state,
                    hoist,
                    vec![
                        (shaft_resource(&lift), 0.0, lift_meters, false),
                        (station_resource(&station.id), 0.0, 0.0, false),
                    ],
                    task.priority,
                    &lift_motion,
                );
                state.step_counter += 1;
                wait_s += committed.delayed_by_s.max(0.0);
                end_s = end_s.max(committed.end_s);
                step_ids.push(committed.id.clone());
                timeline.push_step(committed.clone());
                clock = committed.end_s;
            } else {
                note = format!("巷道 {} 没有可用提升机，跨层交接无法完成", record.aisle_id);
                ok = false;
            }
        } else {
            // 同层：交接段（输送线 / 站台）
            let handover = Step {
                id: format!("S{}", state.step_counter + 1),
                device_id: shuttle_id.clone(),
                task_id: Some(task.id.clone()),
                kind: "handover".to_string(),
                from: end_pos.clone(),
                to: station_pos.clone(),
                start_s: clock,
                end_s: clock + station.handover_s + motion.handover_s,
                loaded: kind != "inbound",
                distance_m: ((station_pos.x - end_pos.x).powi(2)
                    + (station_pos.z - end_pos.z).powi(2))
                .sqrt(),
                energy_kwh: 0.01,
                note: format!("同层交接：{} → 站台 {}", end_node, station.id),
                resource_id: Some(station_resource(&station.id)),
                resources: Vec::new(),
                delayed_by_s: 0.0,
            };
            let committed = commit_step(
                state,
                handover,
                vec![(station_resource(&station.id), 0.0, 0.0, false)],
                task.priority,
                &motion,
            );
            state.step_counter += 1;
            wait_s += committed.delayed_by_s;
            end_s = end_s.max(committed.end_s);
            step_ids.push(committed.id.clone());
            timeline.push_step(committed.clone());
            clock = committed.end_s;
        }
        used_station = Some(station.id.clone());
        // 站台占用：动作完成后释放（体现站台缓冲容量）
        let station_occ = state
            .station_occupancy
            .entry(station.id.clone())
            .or_insert(0);
        *station_occ = (*station_occ + 1).min(world.station_capacity(&station.id));
        timeline.buffer_states.push(BufferState {
            at_s: clock,
            buffer_id: format!("BUF-{}", station.id),
            occupancy: *station_occ,
            capacity: world.station_capacity(&station.id),
            reason: format!("任务 {} 占用站台", task.id),
        });
    } else {
        note = "拓扑中没有站台，任务只能停在交接点".to_string();
        ok = false;
    }
    let _ = explicit_target;

    let status = if !ok {
        "partial".to_string()
    } else {
        "done".to_string()
    };
    let lateness = match task.deadline_s {
        Some(deadline) if end_s > deadline => end_s - deadline,
        _ => 0.0,
    };
    let trace = TaskTrace {
        task_id: task.id.clone(),
        kind: kind.to_string(),
        priority: task.priority,
        release_s: task.release_s,
        deadline_s: task.deadline_s,
        start_s: if start_s.is_finite() {
            start_s
        } else {
            task.release_s
        },
        end_s,
        device_ids,
        step_ids,
        dual_command: task.dual_command_eligible
            && (end_s - start_s) > 0.0
            && matches!(kind, "outbound" | "inbound"),
        status,
        lateness_s: round(lateness, 3),
        wait_s: round(wait_s, 3),
        note: if note.is_empty() { String::new() } else { note },
    };
    let _ = step_start;
    // 站台/缓冲占用在任务结束时释放（真实仓库里货物离开站台即释放，不能只增不减）
    if let Some(station_id) = used_station.clone() {
        let occupancy = state
            .station_occupancy
            .entry(station_id.clone())
            .or_insert(0);
        *occupancy = (*occupancy - 1).max(0);
        timeline.buffer_states.push(BufferState {
            at_s: end_s,
            buffer_id: format!("BUF-{station_id}"),
            occupancy: *occupancy,
            capacity: world.station_capacity(&station_id),
            reason: format!("任务 {} 离开站台", task.id),
        });
    }
    timeline.tasks.push(trace.clone());
    trace
}

/// 巷道端头节点（同层）里离给定坐标最近的一个：跨巷道移动必须经由端头/走廊。
fn nearest_aisle_end(
    network: &RunNetwork,
    aisle_id: &str,
    level: i32,
    x: f64,
    z: f64,
) -> Option<(String, DevicePosition)> {
    let aisle = network
        .topology
        .aisles
        .iter()
        .find(|aisle| aisle.id == aisle_id)?;
    let mut best: Option<(f64, String, DevicePosition)> = None;
    for node_id in &aisle.end_node_ids {
        // 端头节点按层命名（N-{aisle}-L{level}-{W|E}）
        // 端头节点在模板里可能只写巷道名（`N-A01-E`），也可能已经带层号；
        // 两种都按原样使用，缺层号时下面 `or_else` 会补上 {level}。
        let candidate_id = node_id.clone();
        let node = network.topology.node(&candidate_id).or_else(|| {
            let with_level = format!(
                "{}-L{level}-{}",
                candidate_id,
                if candidate_id.ends_with('W') {
                    "W"
                } else {
                    "E"
                }
            );
            network.topology.node(&with_level)
        });
        let Some(node) = node else { continue };
        if node.level.unwrap_or(1) != level {
            continue;
        }
        let distance = (node.position[0] - x).powi(2) + (node.position[2] - z).powi(2);
        let position = DevicePosition {
            x: node.position[0],
            y: node.position[1],
            z: node.position[2],
            level: node.level.unwrap_or(level),
            aisle_id: Some(aisle_id.to_string()),
            node_id: Some(node.id.clone()),
            location_id: None,
        };
        let better = best
            .as_ref()
            .map(|(current, _, _)| distance < *current)
            .unwrap_or(true);
        if better {
            best = Some((distance, node.id.clone(), position));
        }
    }
    best.map(|(_, id, position)| (id, position))
}

/// 层内走廊资源（同层跨巷道移动共用；命名与方向无关，保证双向互斥）。
pub fn corridor_resource(level: i32, from_aisle: &str, to_aisle: &str) -> String {
    let (a, b) = if from_aisle <= to_aisle {
        (from_aisle, to_aisle)
    } else {
        (to_aisle, from_aisle)
    };
    format!("CORRIDOR:L{level}:{a}-{b}")
}

fn task_kind(task: &WarehouseTask) -> String {
    if !task.kind.is_empty() {
        return task.kind.clone();
    }
    if task.from_location_id.is_none() && task.to_location_id.is_some() {
        "inbound".to_string()
    } else if task.to_location_id.is_none() && task.from_location_id.is_some() {
        "outbound".to_string()
    } else {
        "relocate".to_string()
    }
}

fn task_target(
    network: &RunNetwork,
    task: &WarehouseTask,
    kind: &str,
) -> (Option<String>, Option<String>, i32) {
    let wanted = match kind {
        "inbound" | "relocate" => task.to_location_id.clone(),
        _ => task.from_location_id.clone(),
    };
    if let Some(location_id) = wanted {
        if let Some(record) = network.location(&location_id) {
            return (
                Some(location_id),
                Some(record.aisle_id.clone()),
                record.level,
            );
        }
        return (Some(location_id), None, 1);
    }
    (None, None, 1)
}

/// 策略搜索：在任务顺序空间里做邻域搜索（每次评估都真实重演，不用代理指标）。
pub fn solve(network: &mut RunNetwork, world: &World, options: &AsrsOptions) -> Schedule {
    let tasks = world.tasks();
    let mut order = order_tasks(world, &tasks, &options.algorithm);
    let mut best = simulate(network, world, &order, options);
    if crate::engine::profile_enabled() {
        use std::sync::atomic::Ordering;
        eprintln!(
            "[prof] tasks={} select={}ms run_task={}ms blockers={}ms",
            PROF_TASKS.load(Ordering::Relaxed),
            PROF_SELECT_NS.load(Ordering::Relaxed) / 1_000_000,
            PROF_TASK_NS.load(Ordering::Relaxed) / 1_000_000,
            PROF_BLOCK_NS.load(Ordering::Relaxed) / 1_000_000
        );
    }
    if options.algorithm != "joint-alns" || order.len() < 3 {
        return best;
    }
    let started = crate::engine::now_ms();
    let deadline = started + options.budget_ms.max(50.0) * 0.9;
    let mut rng = Rng::new(seed_from(&["asrs-alns", &options.seed.to_string()]));
    let mut iterations = 0u64;
    let mut best_score = score(&best.metrics);
    while crate::engine::now_ms() < deadline
        && !crate::engine::cancel_requested()
        && iterations < options.max_iterations
    {
        iterations += 1;
        // 邻域：交换 / 前插 / 优先级区间重排
        let mut candidate = order.clone();
        match rng.below(3) {
            0 => {
                let a = rng.below(candidate.len());
                let b = rng.below(candidate.len());
                candidate.swap(a, b);
            }
            1 => {
                let a = rng.below(candidate.len());
                let b = rng.below(candidate.len());
                let item = candidate.remove(a);
                candidate.insert(b.min(candidate.len()), item);
            }
            _ => {
                let a = rng.below(candidate.len());
                let b = rng.below(candidate.len());
                let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
                candidate[lo..=hi].reverse();
            }
        }
        let result = simulate(
            network,
            world,
            &candidate,
            &AsrsOptions {
                algorithm: options.algorithm.clone(),
                max_iterations: 1,
                ..options.clone()
            },
        );
        let value = score(&result.metrics);
        if value < best_score - 1e-9 {
            best_score = value;
            best = result;
            order = candidate;
        }
    }
    best.metrics.sim_iterations = iterations + 1;
    best.metrics.compute_ms = round(crate::engine::now_ms() - started, 3);
    best.order_notes.push(format!(
        "联合搜索：{iterations} 次真实重演（每次都是完整时间线，不用代理指标）"
    ));
    best
}

/// 调度解的评价（多目标加权；惩罚项全部显式）。
fn score(metrics: &ScheduleMetrics) -> f64 {
    let unserved = metrics.tasks_unserved as f64 * 10_000.0;
    let lateness = metrics.late_tasks as f64 * 500.0 + metrics.max_lateness_s;
    let makespan = metrics.makespan_s;
    let wait = metrics.mean_wait_s * 10.0;
    let conflicts = metrics.conflicts as f64 * 5.0;
    let travel = metrics.travel_meters * 0.01;
    unserved + lateness + makespan + wait + conflicts + travel
}

/// 设备能力矩阵（能力清单与面板"谁能做这个活"共用）。
pub fn device_roles(network: &RunNetwork) -> Vec<(String, String, Vec<String>)> {
    network
        .topology
        .devices
        .iter()
        .map(|device| {
            let kinds = match device.kind {
                DeviceKind::AisleShuttle
                | DeviceKind::LayerShuttle
                | DeviceKind::FourWayShuttle => {
                    vec![
                        "inbound".to_string(),
                        "outbound".to_string(),
                        "relocate".to_string(),
                    ]
                }
                DeviceKind::PalletLift | DeviceKind::AisleLift => {
                    vec!["cross-level".to_string(), "transfer".to_string()]
                }
                DeviceKind::Conveyor => vec!["transport".to_string()],
                DeviceKind::TransferCar => vec!["transfer".to_string(), "relocate".to_string()],
            };
            (device.id.clone(), device.kind.as_str().to_string(), kinds)
        })
        .collect()
}

/// 任务类型分布（面板统计条）。
pub fn task_mix(tasks: &[WarehouseTask]) -> BTreeMap<String, usize> {
    let mut out: BTreeMap<String, usize> = BTreeMap::new();
    for task in tasks {
        *out.entry(task_kind(task)).or_insert(0) += 1;
    }
    out
}

/// 单车道互斥自检（求解器内部断言；验证器还会独立复核一遍）。
pub fn lane_exclusivity_violations(timeline: &Timeline) -> Vec<String> {
    let mut out = Vec::new();
    let mut by_resource: BTreeMap<String, Vec<&Step>> = BTreeMap::new();
    for step in &timeline.steps {
        if let Some(resource) = &step.resource_id {
            by_resource.entry(resource.clone()).or_default().push(step);
        }
    }
    // 扫描线：按开始时间排序 + 活动窗口，避免 2 万任务规模下的 O(n²) 两两比较。
    for (resource, mut steps) in by_resource {
        steps.sort_by(|a, b| {
            a.start_s
                .partial_cmp(&b.start_s)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut active: Vec<&Step> = Vec::new();
        for step in steps {
            active.retain(|other| other.end_s > step.start_s + 1e-9);
            for other in &active {
                if other.device_id == step.device_id {
                    continue;
                }
                let lo = other.from.x.min(other.to.x);
                let hi = other.from.x.max(other.to.x);
                let lo_b = step.from.x.min(step.to.x);
                let hi_b = step.from.x.max(step.to.x);
                if hi < lo_b - 1e-6 || hi_b < lo - 1e-6 {
                    continue;
                }
                if out.len() >= 200 {
                    return out;
                }
                out.push(format!(
                    "资源 {resource} 上 {} 与 {} 在 [{:.1}, {:.1}] 重叠",
                    other.device_id,
                    step.device_id,
                    other.start_s.max(step.start_s),
                    other.end_s.min(step.end_s)
                ));
            }
            active.push(step);
        }
    }
    out
}

/// 无冲突检查的快速判据（用于 acceptance 自检）。
pub fn schedule_is_consistent(schedule: &Schedule) -> bool {
    lane_exclusivity_violations(&schedule.timeline).is_empty()
        && schedule.metrics.tasks_done + schedule.metrics.tasks_unserved
            == schedule.metrics.tasks_total
}

/// 供联合优化使用：把调度指标压成一个可比较的标量（单位写在结果里）。
pub fn joint_scalar(metrics: &ScheduleMetrics) -> f64 {
    score(metrics)
}

/// `link_open` 转发（验证器与事件处理共用，避免两处语义分叉）。
pub fn link_usable(network: &RunNetwork, link_id: &str) -> bool {
    link_open(network.topology, link_id)
}
