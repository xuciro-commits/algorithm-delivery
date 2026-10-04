//! 通行模型（routing）：把拓扑变成"设备真正要跑多久"的函数（SRS §1.3 / §4.4）。
//!
//! 关键点：
//! * 距离不是欧氏距离，而是 **巷道内轨道距离 + 横巷/地面距离 + 层间提升距离** 的组合；
//! * 时间不是 `距离 / 速度`，而是**梯形速度曲线**（含加减速），并按载货/空载取不同速度；
//! * 多深位库位有**额外取放代价**：深度 d 需要列内多走 (d−1) 次进深并额外取放；
//! * 结构图只含巷道端点 / 竖井 / 站台 / 交叉口（规模小、可反复求最短路），
//!   巷道内部用解析公式，避免为百万级库位建图。
//!
//! 这一层被**库位优化的成本模型**与**立库调度的路径规划**共同使用：
//! 两个模块因此共享同一份物理运动学，不会出现"库位优化以为 10 秒、调度实跑 40 秒"的错位。

use std::collections::BTreeMap;

use crate::contract::{DeviceSpec, MotionProfile, Topology};
use crate::wh::topology::{build_graph, dijkstra, LocationRecord, NodeGraph};

/// 梯形速度曲线的运行时间（秒）：两端各有加/减速段；距离不足以达到最高速时退化为三角曲线。
pub fn travel_time(distance: f64, speed_mps: f64, accel_mps2: f64) -> f64 {
    let d = distance.max(0.0);
    if d <= 0.0 {
        return 0.0;
    }
    let v = speed_mps.max(0.05);
    let a = accel_mps2.max(0.05);
    let accel_distance = v * v / a; // 加速段 + 减速段总距离
    if d <= accel_distance {
        2.0 * (d / a).sqrt()
    } else {
        d / v + v / a
    }
}

/// 一次移动的时间（含载货降速；竖直运动按 1.15 折算为等效水平时间，工程经验值，显式标注）。
pub fn move_seconds(distance_m: f64, motion: &MotionProfile, loaded: bool, vertical: bool) -> f64 {
    let factor = if loaded {
        motion.loaded_speed_factor.clamp(0.1, 1.5)
    } else {
        1.0
    };
    let base = travel_time(distance_m, motion.speed_mps * factor, motion.accel_mps2);
    base * if vertical { 1.15 } else { 1.0 }
}

/// 巷道中心线的几何（用于巷道内解析距离）。
#[derive(Debug, Clone, Copy)]
pub struct AisleAxis {
    pub x0: f64,
    pub x1: f64,
    pub z: f64,
    pub y_m: f64,
}

/// 路由模型：结构图 + 库位索引 + 巷道几何 + 站台缓存。
#[derive(Debug, Clone)]
pub struct RouteModel {
    pub graph: NodeGraph,
    pub locations: Vec<LocationRecord>,
    pub loc_index: BTreeMap<String, usize>,
    /// (aisle_id, level) → 巷道几何
    pub aisle_axis: BTreeMap<(String, i32), AisleAxis>,
    /// 站点节点 → (每个骨架节点的时间, 距离)；按需计算并缓存。
    pub sources: BTreeMap<String, (Vec<f64>, Vec<f64>)>,
    /// 库位 → 出库 / 入库站台的物理秒数缓存（不含交接）。
    pub station_seconds_cache: BTreeMap<String, BTreeMap<String, f64>>,
    /// 巷道 id → 下标（负载聚合）
    pub aisle_ids: Vec<String>,
}

impl RouteModel {
    pub fn build(topology: &Topology, locations: Vec<LocationRecord>) -> RouteModel {
        let graph = build_graph(topology);
        let mut aisle_axis: BTreeMap<(String, i32), AisleAxis> = BTreeMap::new();
        for aisle in &topology.aisles {
            let (a, b) = (
                topology.node(&aisle.end_node_ids[0]),
                topology.node(&aisle.end_node_ids[1]),
            );
            if let (Some(a), Some(b)) = (a, b) {
                aisle_axis.insert(
                    (aisle.id.clone(), aisle.level),
                    AisleAxis {
                        x0: a.position[0].min(b.position[0]),
                        x1: a.position[0].max(b.position[0]),
                        z: a.position[2],
                        y_m: a.position[1],
                    },
                );
            }
        }
        let loc_index = locations
            .iter()
            .enumerate()
            .map(|(i, l)| (l.id.clone(), i))
            .collect();
        RouteModel {
            graph,
            locations,
            loc_index,
            aisle_axis,
            sources: BTreeMap::new(),
            station_seconds_cache: BTreeMap::new(),
            aisle_ids: topology.aisles.iter().map(|a| a.id.clone()).collect(),
        }
    }

    pub fn location(&self, id: &str) -> Option<&LocationRecord> {
        self.loc_index.get(id).map(|i| &self.locations[*i])
    }

    /// 从某节点出发的最短路（秒, 米），带缓存。
    pub fn from_source(&mut self, node_id: &str) -> &(Vec<f64>, Vec<f64>) {
        if !self.sources.contains_key(node_id) {
            let result = dijkstra(&self.graph, node_id);
            self.sources.insert(node_id.to_string(), result);
        }
        self.sources.get(node_id).unwrap()
    }

    /// 节点 → 节点的时间（秒）。不可达返回 `f64::INFINITY`。
    pub fn node_seconds(&mut self, from: &str, to: &str) -> f64 {
        if from == to {
            return 0.0;
        }
        let Some(&target) = self.graph.index.get(to) else {
            return f64::INFINITY;
        };
        let (seconds, _) = self.from_source(from);
        seconds[target]
    }

    /// 节点 → 节点的距离（米）。
    pub fn node_meters(&mut self, from: &str, to: &str) -> f64 {
        if from == to {
            return 0.0;
        }
        let Some(&target) = self.graph.index.get(to) else {
            return f64::INFINITY;
        };
        let (_, meters) = self.from_source(from);
        meters[target]
    }

    /// 巷道内水平运行时间（解析式，梯形曲线）。
    pub fn in_aisle_seconds(
        &self,
        aisle_id: &str,
        level: i32,
        from_x: f64,
        to_x: f64,
        motion: &MotionProfile,
        loaded: bool,
    ) -> f64 {
        let span = self
            .aisle_axis
            .get(&(aisle_id.to_string(), level))
            .map(|axis| (axis.x1 - axis.x0).max(1.0))
            .unwrap_or(1.0);
        let distance = (to_x - from_x).abs().min(span * 1.5);
        let factor = if loaded {
            motion.loaded_speed_factor.clamp(0.1, 1.5)
        } else {
            1.0
        };
        travel_time(distance, motion.speed_mps * factor, motion.accel_mps2)
    }

    /// 库位的深度取放代价（秒）：列内进深移动 + 每深位一次取放。
    pub fn depth_penalty(&self, location: &LocationRecord, motion: &MotionProfile) -> f64 {
        if location.depth <= 1 {
            return 0.0;
        }
        let moves = (location.depth - 1) as f64;
        travel_time(moves * location.size[2], motion.speed_mps, motion.accel_mps2)
            + moves * motion.transfer_s
    }

    /// 从某节点到某个库位的**物理运行时间**（秒；不含交接时间与取放，它们由调用方按语义加）。
    ///
    /// 库位不可达（巷道端点缺失等）返回 `f64::INFINITY` —— 调用方必须显式处理，
    /// 绝不允许把"不可达"当成"很近"。
    pub fn seconds_to_location(
        &mut self,
        from_node: &str,
        location_id: &str,
        motion: &MotionProfile,
        loaded: bool,
    ) -> f64 {
        let Some(location) = self.location(location_id).cloned() else {
            return f64::INFINITY;
        };
        let mut best = f64::INFINITY;
        for end in ["W", "E"] {
            let end_node = format!("N-{}-L{}-{}", location.aisle_id, location.level, end);
            if !self.graph.index.contains_key(&end_node) {
                continue;
            }
            let skeleton = self.node_seconds(from_node, &end_node);
            if !skeleton.is_finite() {
                continue;
            }
            let end_x = self
                .graph
                .index
                .get(&end_node)
                .map(|i| self.graph.positions[*i][0])
                .unwrap_or(location.position[0]);
            let in_aisle = self.in_aisle_seconds(
                &location.aisle_id,
                location.level,
                end_x,
                location.position[0],
                motion,
                loaded,
            );
            let total = skeleton + in_aisle + self.depth_penalty(&location, motion);
            if total < best {
                best = total;
            }
        }
        best
    }

    /// 库位到站台的时间（带缓存；库位优化的热路径）。
    pub fn seconds_to_station(
        &mut self,
        location_id: &str,
        station_node: &str,
        motion: &MotionProfile,
        loaded: bool,
    ) -> f64 {
        let key = format!("{station_node}|{}", if loaded { "L" } else { "E" });
        if let Some(table) = self.station_seconds_cache.get(&key) {
            if let Some(value) = table.get(location_id) {
                return *value;
            }
        }
        let value = self.seconds_to_location(station_node, location_id, motion, loaded);
        self.station_seconds_cache
            .entry(key)
            .or_default()
            .insert(location_id.to_string(), value);
        value
    }

    /// 库位之间的运行时间（移库 / 倒垛）。
    ///
    /// 同一货架列内（同 rack、同层）走列内路径，代价显著低于跨巷道移动 ——
    /// 这正是多深位"整列倒垛"在真实设备上的便宜之处。
    pub fn seconds_between_locations(
        &mut self,
        from_id: &str,
        to_id: &str,
        motion: &MotionProfile,
    ) -> f64 {
        let (Some(from), Some(to)) = (self.location(from_id).cloned(), self.location(to_id).cloned())
        else {
            return f64::INFINITY;
        };
        if from.rack_id == to.rack_id && from.level == to.level {
            let distance = (from.depth - to.depth).unsigned_abs() as f64 * from.size[2];
            return travel_time(distance, motion.speed_mps, motion.accel_mps2) + motion.transfer_s * 2.0;
        }
        let mut best = f64::INFINITY;
        for end_a in ["W", "E"] {
            let node_a = format!("N-{}-L{}-{}", from.aisle_id, from.level, end_a);
            if !self.graph.index.contains_key(&node_a) {
                continue;
            }
            for end_b in ["W", "E"] {
                let node_b = format!("N-{}-L{}-{}", to.aisle_id, to.level, end_b);
                if !self.graph.index.contains_key(&node_b) {
                    continue;
                }
                let skeleton = self.node_seconds(&node_a, &node_b);
                if !skeleton.is_finite() {
                    continue;
                }
                let end_a_x = self
                    .graph
                    .index
                    .get(&node_a)
                    .map(|i| self.graph.positions[*i][0])
                    .unwrap_or(from.position[0]);
                let end_b_x = self
                    .graph
                    .index
                    .get(&node_b)
                    .map(|i| self.graph.positions[*i][0])
                    .unwrap_or(to.position[0]);
                let total = skeleton
                    + self.in_aisle_seconds(&from.aisle_id, from.level, end_a_x, from.position[0], motion, true)
                    + self.in_aisle_seconds(&to.aisle_id, to.level, end_b_x, to.position[0], motion, true)
                    + self.depth_penalty(&to, motion);
                if total < best {
                    best = total;
                }
            }
        }
        if best.is_finite() {
            best + motion.transfer_s * 2.0
        } else {
            f64::INFINITY
        }
    }

    /// 库位的三维回放入径点（从站台到库位）：只做投影，不改变任何时间。
    pub fn polyline_to_location(&mut self, from_node: &str, location_id: &str) -> Vec<[f64; 3]> {
        let Some(location) = self.location(location_id).cloned() else {
            return Vec::new();
        };
        let mut best: Option<(f64, Vec<[f64; 3]>)> = None;
        for end in ["W", "E"] {
            let end_node = format!("N-{}-L{}-{}", location.aisle_id, location.level, end);
            let Some(_end_index) = self.graph.index.get(&end_node) else {
                continue;
            };
            let seconds = self.node_seconds(from_node, &end_node);
            if !seconds.is_finite() {
                continue;
            }
            let path = polyline(&self.graph, from_node, &end_node);
            let mut points = path;
            points.push(location.position);
            if best.as_ref().map(|(s, _)| seconds < *s).unwrap_or(true) {
                best = Some((seconds, points));
            }
        }
        best.map(|(_, points)| points).unwrap_or_default()
    }
}

/// 骨架路径（节点 id 列表 → 世界坐标）：直接按图重放 Dijkstra 的前驱。
pub fn polyline(graph: &NodeGraph, from: &str, to: &str) -> Vec<[f64; 3]> {
    let Some(&src) = graph.index.get(from) else {
        return Vec::new();
    };
    let Some(&dst) = graph.index.get(to) else {
        return Vec::new();
    };
    let (seconds, _) = dijkstra(graph, from);
    if !seconds[dst].is_finite() {
        return Vec::new();
    }
    // 反向回溯：每次选择"时间 = 当前 - 本体代价"的前驱（以 1e-6 容差匹配）
    let mut path = vec![dst];
    let mut current = dst;
    let mut guard = 0;
    while current != src && guard < graph.positions.len() + 4 {
        guard += 1;
        let mut next: Option<usize> = None;
        let mut best = f64::INFINITY;
        for &(v, length, mode, _) in &graph.adj[current] {
            let (speed, accel) = mode.default_motion();
            let dt = travel_time(length, speed, accel);
            let candidate = seconds[current] - dt;
            if (candidate - seconds[v]).abs() < 1e-6 && candidate < best {
                best = candidate;
                next = Some(v);
            }
        }
        match next {
            Some(v) => {
                path.push(v);
                current = v;
            }
            None => break,
        }
    }
    path.reverse();
    path.into_iter().map(|i| graph.positions[i]).collect()
}

/// 每个库位预计算好的代价（与 SKU 无关；SKU 只影响流量权重）。
#[derive(Debug, Clone)]
pub struct LocationCost {
    /// 出库：库位 → 出库站台（含提升机与交接）。
    pub pick_seconds: f64,
    /// 入库：入库站台 → 库位。
    pub put_seconds: f64,
    /// 运行距离（米，用于距离与能耗目标）。
    pub meters: f64,
    /// 巷道下标。
    pub aisle_index: usize,
    /// 是否使用提升机（level > 1）。
    pub uses_lift: bool,
    /// 提升机分组下标（同一竖井的设备共享负载）。
    pub lift_group: usize,
    /// 深位造成的额外代价（秒）。
    pub depth_penalty_s: f64,
    /// 是否曾不可达（数据质量问题，应在验证阶段暴露）。
    pub unreachable: bool,
}

/// 代表设备的运动学：库位侧成本用"巷道穿梭车 + 货物提升机"的组合代表机型。
pub fn representative_motion(topology: &Topology) -> (MotionProfile, MotionProfile) {
    let shuttle = topology
        .devices
        .iter()
        .find(|d| {
            matches!(
                d.kind,
                crate::contract::DeviceKind::LayerShuttle
                    | crate::contract::DeviceKind::AisleShuttle
                    | crate::contract::DeviceKind::FourWayShuttle
            )
        })
        .map(|d| d.motion.clone())
        .unwrap_or(MotionProfile {
            speed_mps: 2.6,
            accel_mps2: 1.3,
            transfer_s: 6.0,
            handover_s: 8.0,
            change_level_s: 12.0,
            loaded_speed_factor: 0.92,
        });
    let lift = topology
        .devices
        .iter()
        .find(|d| d.kind == crate::contract::DeviceKind::PalletLift)
        .map(|d| d.motion.clone())
        .unwrap_or(MotionProfile {
            speed_mps: 0.9,
            accel_mps2: 0.7,
            transfer_s: 8.0,
            handover_s: 12.0,
            change_level_s: 12.0,
            loaded_speed_factor: 1.0,
        });
    (shuttle, lift)
}

/// 提升机分组：把"层 > 1 且同一货架块"的库位归到同一条竖井（负载按竖井聚合）。
pub fn lift_groups(topology: &Topology) -> (Vec<String>, BTreeMap<String, usize>) {
    let mut ids: Vec<String> = Vec::new();
    let mut by_aisle: BTreeMap<String, usize> = BTreeMap::new();
    for device in &topology.devices {
        if device.kind != crate::contract::DeviceKind::PalletLift {
            continue;
        }
        let index = ids.len();
        ids.push(device.id.clone());
        for aisle in &device.capability.aisles {
            by_aisle.entry(aisle.clone()).or_insert(index);
        }
    }
    if ids.is_empty() {
        ids.push("LIFT-0".to_string());
        for aisle in &topology.aisles {
            by_aisle.insert(aisle.id.clone(), 0);
        }
    }
    (ids, by_aisle)
}

/// 计算全部库位代价（供库位优化的成本模型与面板解释共同使用）。
pub fn location_costs(
    topology: &Topology,
    model: &mut RouteModel,
    handling_s: f64,
) -> Vec<LocationCost> {
    let (shuttle, lift) = representative_motion(topology);
    let out_node = topology
        .outbound_stations()
        .first()
        .map(|s| s.node_id.clone())
        .or_else(|| topology.nodes.first().map(|n| n.id.clone()))
        .unwrap_or_default();
    let in_node = topology
        .inbound_stations()
        .first()
        .map(|s| s.node_id.clone())
        .unwrap_or_else(|| out_node.clone());
    let (lift_ids, lift_by_aisle) = lift_groups(topology);
    let aisle_ids: Vec<String> = topology.aisles.iter().map(|a| a.id.clone()).collect();
    let mut out = Vec::with_capacity(model.locations.len());
    for location in model.locations.clone() {
        let aisle_index = aisle_ids
            .iter()
            .position(|id| id == &location.aisle_id)
            .unwrap_or(0);
        let uses_lift = location.level > 1;
        let lift_group = if uses_lift {
            *lift_by_aisle.get(&location.aisle_id).unwrap_or(&0)
        } else {
            0
        };
        let placeable = location.availability.placeable();
        if !placeable {
            out.push(LocationCost {
                pick_seconds: f64::INFINITY,
                put_seconds: f64::INFINITY,
                meters: f64::INFINITY,
                aisle_index,
                uses_lift,
                lift_group,
                depth_penalty_s: 0.0,
                unreachable: false,
            });
            continue;
        }
        let pick_raw = model.seconds_to_station(&location.id, &out_node, &shuttle, true);
        let put_raw = model.seconds_to_station(&location.id, &in_node, &shuttle, true);
        let unreachable = !pick_raw.is_finite() || !put_raw.is_finite();
        let depth = model.depth_penalty(&location, &shuttle);
        // 竖直行程：货位在 2 层以上时，每一次出入库都要付一次提升机换层时间 + 竖井升降时间。
        // 这是真实设备时间的一部分（不是距离折算），必须计入，否则高层货位的代价被系统性低估。
        let height_m = location.position[1].max(0.0);
        let vertical = if uses_lift {
            lift.change_level_s + travel_time(height_m, lift.speed_mps, lift.accel_mps2)
        } else {
            0.0
        };
        out.push(LocationCost {
            pick_seconds: if unreachable {
                f64::INFINITY
            } else {
                pick_raw + handling_s + vertical
            },
            put_seconds: if unreachable {
                f64::INFINITY
            } else {
                put_raw + handling_s + vertical
            },
            meters: if unreachable {
                f64::INFINITY
            } else {
                (pick_raw - handling_s.min(pick_raw)) * shuttle.speed_mps * 0.9 + height_m
            },
            aisle_index,
            uses_lift,
            lift_group,
            depth_penalty_s: depth,
            unreachable,
        });
    }
    let _ = lift_ids;
    out
}

/// 设备能力 → 是否可服务该库位（可达性 + 能力判定；调度与验证共用同一规则）。
pub fn can_serve_location(device: &DeviceSpec, location: &LocationRecord) -> Result<(), String> {
    if !device.capability.aisles.is_empty() && !device.capability.aisles.contains(&location.aisle_id) {
        return Err(format!(
            "设备 {} 的服务范围不含巷道 {}",
            device.id, location.aisle_id
        ));
    }
    if !device.capability.levels.is_empty() && !device.capability.levels.contains(&location.level) {
        return Err(format!(
            "设备 {} 只服务层 {:?}，库位在第 {} 层",
            device.id, device.capability.levels, location.level
        ));
    }
    if !device.capability.areas.is_empty() && !device.capability.areas.contains(&location.area_id) {
        return Err(format!("设备 {} 不在区域 {} 作业", device.id, location.area_id));
    }
    Ok(())
}

/// 分区兼容性（SKU 允许分区 ∩ 库位分区）。
pub fn zone_compatible(allowed: &[String], location_zone: &str) -> bool {
    if allowed.is_empty() {
        return true;
    }
    allowed
        .iter()
        .any(|zone| location_zone == zone || location_zone.starts_with(zone.as_str()))
}
