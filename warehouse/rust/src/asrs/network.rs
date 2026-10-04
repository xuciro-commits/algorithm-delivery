//! 立库运行网络：设备位置、巷道内运行、层间提升、**时空预约与冲突消解**。
//!
//! 三层职责严格分开（SRS §4.3 / §4.4）：
//! 1. `network`：物理上"能不能这样动、要多久" —— 几何 + 运动学 + 资源互斥；
//! 2. `solver`：决定"谁在什么时候做哪个任务"，并把每一步写进预约表；
//! 3. `timeline`：把求解结果还原成**设备轨迹**（实验室播放的唯一数据源），
//!    以及 `verify`：只读地重放一遍，独立复核（绝不引用 solver 的中间量）。
//!
//! 三条物理红线（验证器会独立复核）：
//! * 一台设备同一时刻只能在一个位置，且步骤在时间轴上不能重叠；
//! * 容量为 1 的通道 / 竖井同一时刻只允许一台设备占用（`allow_meeting` 决定能否会车）；
//! * 不允许生成物理上不可能的移动：跨层必须经提升设备；巷道的服务范围由设备 capability 决定。

use std::collections::{BTreeMap, BTreeSet};

use crate::contract::{DeviceKind, DeviceSpec, LinkMode, MotionProfile, Topology};
use crate::wh::routing::{travel_time, RouteModel};

/// 设备在世界中的位置（库位用 locationId 表达，节点用 nodeId）。
#[derive(Debug, Clone, PartialEq)]
pub struct DevicePosition {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub level: i32,
    pub aisle_id: Option<String>,
    pub node_id: Option<String>,
    pub location_id: Option<String>,
}

impl Default for DevicePosition {
    fn default() -> Self {
        DevicePosition {
            x: 0.0,
            y: 0.0,
            z: 0.0,
            level: 1,
            aisle_id: None,
            node_id: None,
            location_id: None,
        }
    }
}

/// 一个时间区间内的资源占用（时空预约表的基本单元）。
#[derive(Debug, Clone)]
pub struct Reservation {
    pub resource_id: String,
    pub device_id: String,
    pub from_s: f64,
    pub to_s: f64,
    /// 资源上的位置区间（用于单车道互斥判断；沿巷道轴的米坐标）。
    pub from_pos: f64,
    pub to_pos: f64,
    pub priority: i64,
    pub task_id: Option<String>,
}

/// 冲突消解记录（推迟 / 等待 / 死锁预防），验证器与面板都会展示。
#[derive(Debug, Clone)]
pub struct ConflictResolution {
    pub resource_id: String,
    pub device_id: String,
    pub delayed_by_s: f64,
    pub blocked_by_device_id: Option<String>,
    pub deadlock_prevented: bool,
    pub at_s: f64,
    pub note: String,
}

pub fn lane_resource(aisle_id: &str, level: i32) -> String {
    format!("LANE:{aisle_id}:L{level}")
}

pub fn shaft_resource(device: &DeviceSpec) -> String {
    device
        .exclusive_resources
        .first()
        .cloned()
        .unwrap_or_else(|| format!("SHAFT:{}", device.id))
}

pub fn station_resource(station_id: &str) -> String {
    format!("STATION:{station_id}")
}

pub fn buffer_resource(buffer_id: &str) -> String {
    format!("BUFFER:{buffer_id}")
}

/// 位置桶宽度（米）：把"线段占用"离散成桶，用来把预约查询从
/// "扫描该资源全部历史预约" 降到 "只看覆盖到的几十个桶"。
/// D16（6000 任务）/D17（20000 任务）在此前是 O(步数 × 历史预约数) 的平方复杂度，直接卡死。
const POS_BUCKET_M: f64 = 0.25;

/// 桶内只保留"最晚释放时刻"与占用者，查询取区间内最大值即为最早可开始时刻。
#[derive(Debug, Clone)]
pub struct BucketEntry {
    pub to_s: f64,
    pub device: u32,
}

fn bucket_index(pos: f64) -> i64 {
    (pos / POS_BUCKET_M).floor() as i64
}

/// 时空预约表：按资源聚合，插入前检查重叠；冲突给出"推迟到何时"与阻塞者。
#[derive(Debug, Default)]
pub struct ReservationTable {
    pub by_resource: BTreeMap<String, Vec<Reservation>>,
    /// 资源 -> 位置桶 -> 桶内最晚释放。仅为查询加速，语义与 by_resource 一致。
    buckets: BTreeMap<String, BTreeMap<i64, BucketEntry>>,
    device_names: Vec<String>,
    device_slots: BTreeMap<String, u32>,
    pub conflicts: Vec<ConflictResolution>,
    pub wait_edges: BTreeMap<String, BTreeSet<String>>,
    pub deadlocks_prevented: u64,
    /// 资源容量（缺省 1 = 互斥）。
    pub capacities: BTreeMap<String, i32>,
}

impl ReservationTable {
    pub fn new() -> ReservationTable {
        ReservationTable::default()
    }

    pub fn set_capacity(&mut self, resource_id: impl Into<String>, capacity: i32) {
        self.capacities.insert(resource_id.into(), capacity.max(1));
    }

    pub fn capacity_of(&self, resource_id: &str) -> i32 {
        self.capacities.get(resource_id).copied().unwrap_or(1)
    }

    /// 查询 [from, to] 内该资源上是否有其他设备的占用；返回最早可开始的时刻与阻塞者。
    pub fn earliest(
        &self,
        resource_id: &str,
        device_id: &str,
        from_s: f64,
        from_pos: f64,
        to_pos: f64,
        allow_meeting: bool,
        duration_s: f64,
    ) -> (f64, Option<String>) {
        let Some(list) = self.by_resource.get(resource_id) else {
            return (from_s, None);
        };
        let capacity = self.capacity_of(resource_id);
        if allow_meeting && capacity > 1 {
            return (from_s, None);
        }
        // 区间**必须按 min/max 归一**：车可以朝任意方向走，直接用 (from_pos, to_pos)
        // 比较会把"从 15.3 开到 0.0"这种行程判成"完全在 11.4 的左边"，从而放过真实冲突。
        let low = from_pos.min(to_pos) - 1e-6;
        let high = from_pos.max(to_pos) + 1e-6;
        let mut start = from_s;
        let mut blocker: Option<String> = None;
        let Some(buckets) = self.buckets.get(resource_id) else {
            return (start, None);
        };
        // 桶区间可能比查询线段略宽（桶宽 0.25 m），因此只会"保守多等一点"，不会漏冲突。
        for (_, entry) in buckets.range(bucket_index(low)..=bucket_index(high)) {
            if entry.to_s > start + 1e-9 {
                let name = self
                    .device_names
                    .get(entry.device as usize)
                    .cloned()
                    .unwrap_or_default();
                if name != device_id {
                    start = entry.to_s;
                    blocker = Some(name);
                }
            }
        }
        let _ = (duration_s, list);
        (start, blocker)
    }

    fn device_slot(&mut self, device_id: &str) -> u32 {
        if let Some(slot) = self.device_slots.get(device_id) {
            return *slot;
        }
        let slot = self.device_names.len() as u32;
        self.device_names.push(device_id.to_string());
        self.device_slots.insert(device_id.to_string(), slot);
        slot
    }

    pub fn reserve(&mut self, entry: Reservation) {
        // by_resource 保留完整历史（可审计、可释放）；buckets 只做加速索引。
        let slot = self
            .by_resource
            .entry(entry.resource_id.clone())
            .or_default();
        slot.push(entry.clone());
        let device = self.device_slot(&entry.device_id);
        let low = bucket_index(entry.from_pos.min(entry.to_pos) - 1e-6);
        let high = bucket_index(entry.from_pos.max(entry.to_pos) + 1e-6);
        let buckets = self.buckets.entry(entry.resource_id.clone()).or_default();
        for index in low..=high {
            let replace = match buckets.get(&index) {
                Some(current) => entry.to_s > current.to_s,
                None => true,
            };
            if replace {
                buckets.insert(
                    index,
                    BucketEntry {
                        to_s: entry.to_s,
                        device,
                    },
                );
            }
        }
    }

    /// 释放某设备在 from_s 之后的预约（动态事件触发重排时使用）。
    pub fn release_after(&mut self, device_id: &str, from_s: f64) {
        let mut touched: Vec<String> = Vec::new();
        for (resource_id, list) in self.by_resource.iter_mut() {
            let before = list.len();
            list.retain(|entry| !(entry.device_id == device_id && entry.from_s >= from_s - 1e-9));
            if list.len() != before {
                touched.push(resource_id.clone());
            }
        }
        // 索引按剩余历史重建（释放是低频操作）
        for resource_id in touched {
            let entries = self
                .by_resource
                .get(&resource_id)
                .cloned()
                .unwrap_or_default();
            self.buckets.remove(&resource_id);
            for entry in entries {
                let device = self.device_slot(&entry.device_id);
                let low = bucket_index(entry.from_pos.min(entry.to_pos) - 1e-6);
                let high = bucket_index(entry.from_pos.max(entry.to_pos) + 1e-6);
                let buckets = self.buckets.entry(entry.resource_id.clone()).or_default();
                for index in low..=high {
                    let replace = match buckets.get(&index) {
                        Some(current) => entry.to_s > current.to_s,
                        None => true,
                    };
                    if replace {
                        buckets.insert(
                            index,
                            BucketEntry {
                                to_s: entry.to_s,
                                device,
                            },
                        );
                    }
                }
            }
        }
    }

    pub fn add_wait(&mut self, from_device: &str, on_device: &str) {
        self.wait_edges
            .entry(from_device.to_string())
            .or_default()
            .insert(on_device.to_string());
    }

    /// 循环等待检测：若加入 (from → on) 后形成环，则拒绝该等待（死锁预防）。
    pub fn would_deadlock(&self, from_device: &str, on_device: &str) -> bool {
        // 从 on_device 出发能否回到 from_device
        let mut stack = vec![on_device.to_string()];
        let mut seen: BTreeSet<String> = BTreeSet::new();
        while let Some(node) = stack.pop() {
            if node == from_device {
                return true;
            }
            if !seen.insert(node.clone()) {
                continue;
            }
            if let Some(next) = self.wait_edges.get(&node) {
                stack.extend(next.iter().cloned());
            }
        }
        false
    }

    pub fn resources_used(&self) -> usize {
        self.by_resource.len()
    }

    pub fn reservations(&self) -> usize {
        self.by_resource.values().map(|list| list.len()).sum()
    }
}

/* ------------------------------------------------------------------ *
 * 运动学与几何
 * ------------------------------------------------------------------ */

/// 巷道轴的几何：用于把"库位深度/贝位"换算成沿巷道的米坐标。
#[derive(Debug, Clone)]
pub struct AisleAxis {
    pub aisle_id: String,
    pub level: i32,
    /// 巷道起点（x, z）
    pub origin: [f64; 2],
    pub axis: [f64; 2],
    pub length_m: f64,
    /// 两端节点（W / E）
    pub ends: [Option<String>; 2],
}

/// 立库运行网络：几何 + 图 + 设备能力的只读视图。
pub struct RunNetwork<'a> {
    pub topology: &'a Topology,
    pub route: RouteModel,
    pub aisle_axis: BTreeMap<(String, i32), AisleAxis>,
    pub level_y: BTreeMap<(String, i32), f64>,
    /// 设备 → 可服务巷道集合
    pub device_aisles: BTreeMap<String, BTreeSet<String>>,
    /// 巷道 → 可用提升设备
    pub aisle_lifts: BTreeMap<String, Vec<String>>,
    /// 库位记录只推导一次（D16/D17 的卡死根因就是在任务循环里反复 derive_locations）
    pub locations: Vec<crate::wh::topology::LocationRecord>,
    pub location_index: BTreeMap<String, usize>,
    /// (rack, bay, level) → 按 depth 升序的库位下标，用于密集立库遮挡判定
    pub column_index: BTreeMap<(String, i32, i32), Vec<usize>>,
    /// 各层的"横向通道"容量（地面主通道 / 横巷）：决定走廊资源是单车道互斥还是会车放行
    pub corridor_capacity: BTreeMap<i32, i32>,
}

impl<'a> RunNetwork<'a> {
    pub fn build(topology: &'a Topology) -> RunNetwork<'a> {
        let locations = crate::wh::topology::derive_locations(topology);
        let mut location_index = BTreeMap::new();
        let mut column_index: BTreeMap<(String, i32, i32), Vec<usize>> = BTreeMap::new();
        for (index, record) in locations.iter().enumerate() {
            location_index.insert(record.id.clone(), index);
            column_index
                .entry((record.rack_id.clone(), record.bay, record.level))
                .or_default()
                .push(index);
        }
        for indexes in column_index.values_mut() {
            indexes.sort_by_key(|index| locations[*index].depth);
        }
        // 横向通道容量：按从属节点的层号统计（提升井除外，井道是设备专用资源）
        let node_level: BTreeMap<&str, i32> = topology
            .nodes
            .iter()
            .map(|node| (node.id.as_str(), node.level.unwrap_or(1)))
            .collect();
        let mut corridor_capacity: BTreeMap<i32, i32> = BTreeMap::new();
        for link in &topology.links {
            if matches!(link.mode, crate::contract::LinkMode::LiftShaft) {
                continue;
            }
            let level = node_level.get(link.from.as_str()).copied().unwrap_or(1);
            let entry = corridor_capacity.entry(level).or_insert(1);
            *entry = (*entry).max(link.capacity.max(1));
        }
        let route = RouteModel::build(topology, locations.clone());
        // 巷道轴：由 topology.aisles + 节点位置推导
        let mut aisle_axis: BTreeMap<(String, i32), AisleAxis> = BTreeMap::new();
        let mut level_y: BTreeMap<(String, i32), f64> = BTreeMap::new();
        for rack in &topology.racks {
            for level in &rack.levels {
                level_y.insert((rack.aisle_id.clone(), level.level), level.y_m);
            }
        }
        for aisle in &topology.aisles {
            let (Some(from), Some(to)) = (
                topology.node(&aisle.end_node_ids[0]),
                topology.node(&aisle.end_node_ids[1]),
            ) else {
                continue;
            };
            let dx = to.position[0] - from.position[0];
            let dz = to.position[2] - from.position[2];
            let length = (dx * dx + dz * dz).sqrt();
            let axis = if length > 1e-9 {
                [dx / length, dz / length]
            } else {
                [1.0, 0.0]
            };
            let levels: Vec<i32> = topology
                .racks
                .iter()
                .filter(|rack| rack.aisle_id == aisle.id)
                .flat_map(|rack| rack.levels.iter().map(|level| level.level))
                .collect();
            let levels: BTreeSet<i32> = levels.into_iter().collect();
            for level in levels {
                aisle_axis.insert(
                    (aisle.id.clone(), level),
                    AisleAxis {
                        aisle_id: aisle.id.clone(),
                        level,
                        origin: [from.position[0], from.position[2]],
                        axis,
                        length_m: length,
                        ends: [
                            Some(aisle.end_node_ids[0].clone()),
                            Some(aisle.end_node_ids[1].clone()),
                        ],
                    },
                );
            }
        }
        // 设备能力
        let mut device_aisles: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        let all_aisles: BTreeSet<String> = topology.aisles.iter().map(|a| a.id.clone()).collect();
        for device in &topology.devices {
            let set: BTreeSet<String> = if device.capability.aisles.is_empty() {
                all_aisles.clone()
            } else {
                device.capability.aisles.iter().cloned().collect()
            };
            device_aisles.insert(device.id.clone(), set);
        }
        // 巷道 → 提升设备（按设备的 capability.levels 与巷道层数匹配）
        let mut aisle_lifts: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for aisle in &topology.aisles {
            let mut lifts = Vec::new();
            for device in &topology.devices {
                if device.kind != DeviceKind::PalletLift && device.kind != DeviceKind::AisleLift {
                    continue;
                }
                let serves = device_aisles
                    .get(&device.id)
                    .map(|set| set.contains(&aisle.id))
                    .unwrap_or(false);
                if serves {
                    lifts.push(device.id.clone());
                }
            }
            lifts.sort();
            aisle_lifts.insert(aisle.id.clone(), lifts);
        }
        RunNetwork {
            topology,
            route,
            aisle_axis,
            level_y,
            device_aisles,
            aisle_lifts,
            locations,
            location_index,
            column_index,
            corridor_capacity,
        }
    }

    pub fn device(&self, id: &str) -> Option<&DeviceSpec> {
        self.topology.device(id)
    }

    /// 库位记录（O(log n) 查表，不重新推导拓扑）
    pub fn location(&self, id: &str) -> Option<&crate::wh::topology::LocationRecord> {
        self.location_index
            .get(id)
            .map(|index| &self.locations[*index])
    }

    /// 沿巷道轴的米坐标（用于单车道互斥判定）。
    pub fn along(&self, aisle_id: &str, level: i32, x: f64, z: f64) -> f64 {
        match self.aisle_axis.get(&(aisle_id.to_string(), level)) {
            Some(axis) => (x - axis.origin[0]) * axis.axis[0] + (z - axis.origin[1]) * axis.axis[1],
            None => 0.0,
        }
    }

    /// 巷道内运行时间（梯形速度曲线；载荷影响速度）。
    pub fn in_aisle_seconds(
        &self,
        aisle_id: &str,
        level: i32,
        from_x: f64,
        from_z: f64,
        to_x: f64,
        to_z: f64,
        motion: &MotionProfile,
        loaded: bool,
    ) -> (f64, f64) {
        let distance = ((to_x - from_x).powi(2) + (to_z - from_z).powi(2)).sqrt();
        let speed = motion.speed_mps
            * if loaded {
                motion.loaded_speed_factor.max(0.1)
            } else {
                1.0
            };
        let _ = (aisle_id, level);
        (travel_time(distance, speed, motion.accel_mps2), distance)
    }

    /// 层间提升时间（提升机）。跨层必须经提升设备 —— 这里只算时间，合法性由调度层保证。
    pub fn level_seconds(
        &self,
        from_level: i32,
        to_level: i32,
        motion: &MotionProfile,
    ) -> (f64, f64) {
        let y_from = self
            .level_y
            .iter()
            .find(|((_, level), _)| *level == from_level)
            .map(|(_, y)| *y)
            .unwrap_or(0.0);
        let y_to = self
            .level_y
            .iter()
            .find(|((_, level), _)| *level == to_level)
            .map(|(_, y)| *y)
            .unwrap_or(0.0);
        let distance = (y_to - y_from).abs();
        let speed = motion.speed_mps.max(0.1);
        (
            travel_time(distance, speed, motion.accel_mps2) + motion.change_level_s,
            distance,
        )
    }

    /// 节点之间的运行时间与距离。
    ///
    /// 路径在"代表运动"下求最短路（与库位代价表同一口径），再按**实际设备**的
    /// 速度/加速度重算时间 —— 不同设备做同一段路会得到不同时间，这正是真实差别。
    pub fn node_seconds(
        &mut self,
        from_node: &str,
        to_node: &str,
        motion: &MotionProfile,
    ) -> (f64, f64) {
        if from_node == to_node {
            return (0.0, 0.0);
        }
        let Some(&target) = self.route.graph.index.get(to_node) else {
            return (f64::INFINITY, f64::INFINITY);
        };
        let (_, meters) = self.route.from_source(from_node);
        let distance = meters[target];
        if !distance.is_finite() {
            return (f64::INFINITY, f64::INFINITY);
        }
        (
            travel_time(distance, motion.speed_mps, motion.accel_mps2),
            distance,
        )
    }

    /// 库位之间的运行时间（移库 / 倒垛；同列内便宜，跨巷道贵）—— 与库位优化同一口径。
    pub fn location_seconds(
        &mut self,
        from_id: &str,
        to_id: &str,
        motion: &MotionProfile,
    ) -> (f64, f64) {
        let seconds = self.route.seconds_between_locations(from_id, to_id, motion);
        let meters = if from_id == to_id {
            0.0
        } else {
            self.route
                .node_meters(&format!("LOC:{from_id}"), &format!("LOC:{to_id}"))
        };
        (seconds, meters)
    }

    /// 设备能否直接服务某库位（巷道 + 层 + 深度限制）。
    pub fn can_serve(&self, device: &DeviceSpec, aisle_id: &str, level: i32) -> bool {
        let aisle_ok = self
            .device_aisles
            .get(&device.id)
            .map(|set| set.contains(aisle_id))
            .unwrap_or(false);
        if !aisle_ok {
            return false;
        }
        if device.capability.levels.is_empty() {
            return device.kind != DeviceKind::LayerShuttle;
        }
        if device.capability.levels.contains(&level) {
            return true;
        }
        // 只有提升类设备能跨层：四向穿梭车在"某一层的网格"里跑，跨层要靠提升机搬运
        // （早期实现把四向车当成可跨层，导致同一车道资源被不同层的车同时占用 —— 那是假的"无冲突"）。
        matches!(
            device.kind,
            DeviceKind::PalletLift | DeviceKind::AisleLift | DeviceKind::TransferCar
        )
    }

    /// 适合执行某种任务的设备（按能力过滤）。
    pub fn devices_for(&self, kind: &str, aisle_id: Option<&str>, level: i32) -> Vec<&DeviceSpec> {
        // 巷道设备优先；若没有任何巷道设备能服务该 (巷道, 层)，则由货物提升机/巷道提升机
        // 直接服务货位面 —— 这是"提升机 + 底层穿梭车"形态立库的真实作业方式（上层靠提升台/货叉）。
        if matches!(kind, "inbound" | "outbound" | "relocate") {
            let shuttles: Vec<&DeviceSpec> = self
                .topology
                .devices
                .iter()
                .filter(|device| {
                    !matches!(
                        device.kind,
                        DeviceKind::PalletLift | DeviceKind::AisleLift | DeviceKind::Conveyor
                    ) && match aisle_id {
                        Some(aisle) => self.can_serve(device, aisle, level),
                        None => true,
                    }
                })
                .collect();
            if !shuttles.is_empty() {
                return shuttles;
            }
            return self
                .topology
                .devices
                .iter()
                .filter(|device| {
                    matches!(device.kind, DeviceKind::PalletLift | DeviceKind::AisleLift)
                        && match aisle_id {
                            Some(aisle) => self.can_serve(device, aisle, level),
                            None => true,
                        }
                })
                .collect();
        }
        self.topology
            .devices
            .iter()
            .filter(|device| match kind {
                "inbound" | "outbound" | "relocate" => match device.kind {
                    DeviceKind::PalletLift | DeviceKind::AisleLift | DeviceKind::Conveyor => false,
                    _ => match aisle_id {
                        Some(aisle) => self.can_serve(device, aisle, level),
                        None => true,
                    },
                },
                "transfer" | "cross-level" => matches!(
                    device.kind,
                    DeviceKind::PalletLift | DeviceKind::AisleLift | DeviceKind::TransferCar
                ),
                _ => true,
            })
            .collect()
    }
}

/// 链接资源 id（输送线 / 单车道通道）。
pub fn link_resource(link_id: &str) -> String {
    format!("LINK:{link_id}")
}

/// 关闭的链接 / 冻结的库位是否影响某次移动（动态事件后的可达性检查）。
pub fn link_open(topology: &Topology, link_id: &str) -> bool {
    !topology.closed_links.contains(link_id)
}

/// 输送线通行时间（按长度与模式；仅供交接段使用）。
pub fn link_seconds(link: &crate::contract::LinkSpec, motion: &MotionProfile) -> f64 {
    let speed = match link.mode {
        LinkMode::Conveyor => motion.speed_mps.max(0.5) * 1.5,
        LinkMode::LiftShaft => motion.speed_mps.max(0.3),
        _ => motion.speed_mps.max(0.8),
    };
    travel_time(link.length_m, speed, motion.accel_mps2)
}

/// 载重体积 / 重量是否超出设备能力（硬约束，验证器也会独立复核）。
pub fn device_can_carry(device: &DeviceSpec, weight_kg: f64, _volume_m3: f64) -> bool {
    device.capability.capacity_kg <= 0.0 || weight_kg <= device.capability.capacity_kg + 1e-9
}

/// 组合键：设备当前的"占用结束时刻"（调度器用它做单调推演）。
pub fn device_busy_until(state: &BTreeMap<String, f64>, device_id: &str) -> f64 {
    state.get(device_id).copied().unwrap_or(0.0)
}
