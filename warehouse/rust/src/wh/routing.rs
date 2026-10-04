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

/// 每个「(巷道, 层)」一行：两端头在图中的下标、巷道跨距、巷道下标。
///
/// 库位只存一个 `u32`（`RouteModel::loc_key`）指向这里，于是
/// 「库位 ↔ 库位」「站台 ↔ 库位」的热路径完全不碰字符串，
/// 也不再为每次查询构造 `N-{aisle}-L{level}-{W|E}` 这样的临时 id。
#[derive(Debug, Clone, Copy)]
pub struct LocaleRow {
    /// [西端头, 东端头] 在图中的下标；该端不存在时为 `None`。
    pub ends: [Option<usize>; 2],
    /// 巷道跨距（米，至少 1.0）——解析式列内行程用，语义与 `AisleAxis` 一致。
    pub span: f64,
    /// 巷道下标（负载聚合与设备分组用）。
    pub aisle: u32,
}

/// 骨架端头行：覆盖全部端头的（秒, 米）两个定长切片。
pub type EndRow = (Box<[f64]>, Box<[f64]>);

/// 骨架端头矩阵的行预算（秒/米各 `f64`）。
///
/// 一行 = 端头数 × 16 字节；行只在**该端头真的被当作源**时才建，建行 = 一次整图 Dijkstra。
/// 预算不是正确性开关：超预算就退回单点查询，取值相同，只是慢一点。
const END_ROW_BUDGET_BYTES: usize = 128 * 1024 * 1024;

/// 路由模型：结构图 + 库位索引 + 巷道几何 + 端头行缓存。
#[derive(Debug, Clone)]
pub struct RouteModel {
    pub graph: NodeGraph,
    pub locations: Vec<LocationRecord>,
    pub loc_index: BTreeMap<String, usize>,
    /// (aisle_id, level) → 巷道几何
    pub aisle_axis: BTreeMap<(String, i32), AisleAxis>,
    /// 站点节点 → (每个骨架节点的时间, 距离)；按需计算并缓存。
    pub sources: BTreeMap<String, (Vec<f64>, Vec<f64>)>,
    /// 点对缓存：(from, to) → (秒, 米)。任务循环里反复查的是同一批端点，
    /// 逐对缓存比"每次重新 Dijkstra"便宜得多。**只服务通用节点对**
    /// （例如 AS/RS 的 `LOC:` 位置点）；巷道端头之间走 `end_rows` 的稠密行。
    pub pair_cache: BTreeMap<(String, String), (f64, f64)>,
    /// 巷道 id → 下标（负载聚合）
    pub aisle_ids: Vec<String>,
    /// 库位下标 → `end_table` 的行号（每个库位 4 字节）。
    pub loc_key: Vec<u32>,
    /// 「(巷道, 层)」→ 端头/跨距/巷道下标（去重后约 巷道数 × 层数 行）。
    pub end_table: Vec<LocaleRow>,
    /// 端头在图中的下标清单（去重升序），即端头行的列序。
    pub end_order: Vec<usize>,
    /// 端头在图中的下标 → 行内列号。
    pub end_pos: BTreeMap<usize, usize>,
    /// 端头/站台源 → 覆盖全部端头的一行（秒 / 米），按需建立。
    ///
    /// 这是压力档的关键：150k SKU / 95 万库位下，初始落位要对**上百万个库位对**
    /// 求跨巷道距离，逐对跑 Dijkstra（外加每次两个 `O(|V|)` 的向量分配）会把
    /// 30 s 预算的求解拖成小时级；有了行缓存，每次查询退化成几个浮点读取。
    pub end_rows: BTreeMap<usize, EndRow>,
    /// `end_rows` 已占字节数（按行预算约束）。
    pub end_row_bytes: usize,
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
        // ---- 「(巷道, 层)」行表：热路径去字符串化 + 端头行缓存的前提 ----
        // 端头 id 的构造方式与 `seconds_to_location` 原实现完全一致（`N-{aisle}-L{level}-{W|E}`），
        // 因此取值逐位不变；只是把「每次查询现造 id + 查图」提前成一次性建表。
        let aisle_pos: BTreeMap<String, u32> =
            topology
                .aisles
                .iter()
                .enumerate()
                .fold(BTreeMap::new(), |mut acc, (i, aisle)| {
                    acc.entry(aisle.id.clone()).or_insert(i as u32);
                    acc
                });
        let mut row_of: BTreeMap<(String, i32), u32> = BTreeMap::new();
        let mut end_table: Vec<LocaleRow> = Vec::new();
        let mut loc_key: Vec<u32> = Vec::with_capacity(locations.len());
        for location in &locations {
            let key = (location.aisle_id.clone(), location.level);
            let row = match row_of.get(&key) {
                Some(&value) => value,
                None => {
                    let west = format!("N-{}-L{}-W", location.aisle_id, location.level);
                    let east = format!("N-{}-L{}-E", location.aisle_id, location.level);
                    let span = aisle_axis
                        .get(&key)
                        .map(|axis| (axis.x1 - axis.x0).max(1.0))
                        .unwrap_or(1.0);
                    let aisle = aisle_pos.get(&location.aisle_id).copied().unwrap_or(0);
                    end_table.push(LocaleRow {
                        ends: [
                            graph.index.get(&west).copied(),
                            graph.index.get(&east).copied(),
                        ],
                        span,
                        aisle,
                    });
                    let value = (end_table.len() - 1) as u32;
                    row_of.insert(key, value);
                    value
                }
            };
            loc_key.push(row);
        }
        let mut end_order: Vec<usize> = end_table
            .iter()
            .flat_map(|row| row.ends.iter().flatten().copied())
            .collect();
        end_order.sort_unstable();
        end_order.dedup();
        let end_pos: BTreeMap<usize, usize> = end_order
            .iter()
            .enumerate()
            .map(|(p, &node)| (node, p))
            .collect();
        RouteModel {
            graph,
            locations,
            loc_index,
            aisle_axis,
            sources: BTreeMap::new(),
            pair_cache: BTreeMap::new(),
            aisle_ids: topology.aisles.iter().map(|a| a.id.clone()).collect(),
            loc_key,
            end_table,
            end_order,
            end_pos,
            end_rows: BTreeMap::new(),
            end_row_bytes: 0,
        }
    }

    /// 端头行（覆盖全部端头的最短路），按需建立。
    ///
    /// 返回 `false` 表示该源的行不可用（超出行预算）——调用方退回单点查询，
    /// 取值不变，只是慢一点。
    fn ensure_end_row(&mut self, source: usize) -> bool {
        if self.end_rows.contains_key(&source) {
            return true;
        }
        let row_bytes = self.end_order.len().saturating_mul(16);
        if self.end_row_bytes + row_bytes > END_ROW_BUDGET_BYTES {
            return false;
        }
        let (seconds, meters) = crate::wh::topology::dijkstra_from_index(&self.graph, source);
        let mut row_seconds = Vec::with_capacity(self.end_order.len());
        let mut row_meters = Vec::with_capacity(self.end_order.len());
        for &node in &self.end_order {
            row_seconds.push(seconds[node]);
            row_meters.push(meters[node]);
        }
        self.end_rows.insert(
            source,
            (
                row_seconds.into_boxed_slice(),
                row_meters.into_boxed_slice(),
            ),
        );
        self.end_row_bytes += row_bytes;
        true
    }

    /// 端头 → 端头（按**图下标**）。与 `node_pair` 取值逐位一致：
    /// 整图 Dijkstra 的每一个标号都是最终值，提前退出只是少算不相干的点。
    fn end_pair_by_index(&mut self, from: usize, to: usize) -> (f64, f64) {
        if from == to {
            return (0.0, 0.0);
        }
        let Some(&column) = self.end_pos.get(&to) else {
            return crate::wh::topology::dijkstra_until_index(&self.graph, from, to);
        };
        if !self.ensure_end_row(from) {
            return crate::wh::topology::dijkstra_until_index(&self.graph, from, to);
        }
        match self.end_rows.get(&from) {
            Some((seconds, meters)) => (seconds[column], meters[column]),
            None => crate::wh::topology::dijkstra_until_index(&self.graph, from, to),
        }
    }

    pub fn location(&self, id: &str) -> Option<&LocationRecord> {
        self.loc_index.get(id).map(|i| &self.locations[*i])
    }

    /// 从某节点出发的最短路（秒, 米），带缓存。
    pub fn from_source(&mut self, node_id: &str) -> &(Vec<f64>, Vec<f64>) {
        // 缓存上限：任务循环里起点会随设备位置不断变化，不能无限增长
        if self.sources.len() > 64 && !self.sources.contains_key(node_id) {
            self.sources.clear();
        }
        if !self.sources.contains_key(node_id) {
            let result = dijkstra(&self.graph, node_id);
            self.sources.insert(node_id.to_string(), result);
        }
        self.sources.get(node_id).unwrap()
    }

    /// 点对最短路（秒, 米），带缓存 + 目标确定即停。
    pub fn node_pair(&mut self, from: &str, to: &str) -> (f64, f64) {
        if from == to {
            return (0.0, 0.0);
        }
        let key = (from.to_string(), to.to_string());
        if let Some(hit) = self.pair_cache.get(&key) {
            return *hit;
        }
        let value = crate::wh::topology::dijkstra_until(&self.graph, from, to);
        if self.pair_cache.len() > 200_000 {
            self.pair_cache.clear();
        }
        self.pair_cache.insert(key, value);
        value
    }

    /// 节点 → 节点的时间（秒）。不可达返回 `f64::INFINITY`。
    pub fn node_seconds(&mut self, from: &str, to: &str) -> f64 {
        self.node_pair(from, to).0
    }

    /// 节点 → 节点的距离（米）。
    pub fn node_meters(&mut self, from: &str, to: &str) -> f64 {
        self.node_pair(from, to).1
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
        self.in_aisle_seconds_span(span, from_x, to_x, motion, loaded)
    }

    /// 巷道内水平运行时间（跨距已由行表给出，热路径用；算式与上式逐位相同）。
    pub fn in_aisle_seconds_span(
        &self,
        span: f64,
        from_x: f64,
        to_x: f64,
        motion: &MotionProfile,
        loaded: bool,
    ) -> f64 {
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
        self.depth_penalty_of(location.depth, location.size[2], motion)
    }

    /// 深度取放代价（按字段给出；算式与上式逐位相同）。
    pub fn depth_penalty_of(&self, depth: i32, size_z: f64, motion: &MotionProfile) -> f64 {
        if depth <= 1 {
            return 0.0;
        }
        let moves = (depth - 1) as f64;
        travel_time(moves * size_z, motion.speed_mps, motion.accel_mps2) + moves * motion.transfer_s
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
        let (Some(&source), Some(&index)) = (
            self.graph.index.get(from_node),
            self.loc_index.get(location_id),
        ) else {
            return f64::INFINITY;
        };
        self.seconds_from_source_to_location(source, index, motion, loaded)
    }

    /// **热路径**：图下标源点 → 库位下标的物理运行时间。
    ///
    /// 与 `seconds_to_location` 的算式/求和顺序逐位一致（端头枚举顺序也是 西→东），
    /// 区别只是端头、跨距、深度惩罚全部走行表，不构造任何字符串、不跑 Dijkstra。
    pub fn seconds_from_source_to_location(
        &mut self,
        source_node: usize,
        location_index: usize,
        motion: &MotionProfile,
        loaded: bool,
    ) -> f64 {
        let row = match self.loc_key.get(location_index) {
            Some(&key) => match self.end_table.get(key as usize) {
                Some(row) => *row,
                None => return f64::INFINITY,
            },
            None => return f64::INFINITY,
        };
        let (depth, size_z, position_x) = {
            let location = &self.locations[location_index];
            (location.depth, location.size[2], location.position[0])
        };
        let mut best = f64::INFINITY;
        for end in row.ends.into_iter().flatten() {
            let (skeleton, _) = self.end_pair_by_index(source_node, end);
            if !skeleton.is_finite() {
                continue;
            }
            let end_x = self.graph.positions[end][0];
            let in_aisle = self.in_aisle_seconds_span(row.span, end_x, position_x, motion, loaded);
            let total = skeleton + in_aisle + self.depth_penalty_of(depth, size_z, motion);
            if total < best {
                best = total;
            }
        }
        best
    }

    /// 库位到站台的时间（走行表；库位优化的热路径）。
    ///
    /// 旧实现为每个 (站台, 库位) 记一份字符串键缓存（压力档 = 数百万条），
    /// 既是内存大头、又要为每次查询构造键；现在行表本身就是 O(1) 命中，
    /// 缓存没有必要，已删除。
    pub fn seconds_to_station(
        &mut self,
        location_id: &str,
        station_node: &str,
        motion: &MotionProfile,
        loaded: bool,
    ) -> f64 {
        self.seconds_to_location(station_node, location_id, motion, loaded)
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
        let (Some(&from), Some(&to)) = (self.loc_index.get(from_id), self.loc_index.get(to_id))
        else {
            return f64::INFINITY;
        };
        self.seconds_between_location_indices(from, to, motion)
    }

    /// **热路径**：库位下标 → 库位下标（移库 / 倒垛）。
    ///
    /// 与字符串入口的算式、求和顺序、端头枚举顺序（西→东）逐位一致；
    /// 差别是端头、跨距、深度惩罚全部走行表，且端头之间是一行稠密缓存里的浮点读取，
    /// 不再为每次查询构造临时节点 id、也不再逐对跑 Dijkstra。
    /// 压力档（150k SKU / 95 万库位）的初始落位要对上百万个库位对求值，
    /// 这里省下的就是小时级与秒级的差距。
    pub fn seconds_between_location_indices(
        &mut self,
        from: usize,
        to: usize,
        motion: &MotionProfile,
    ) -> f64 {
        let same_rack = {
            let (a, b) = (&self.locations[from], &self.locations[to]);
            a.rack_id == b.rack_id && a.level == b.level
        };
        if same_rack {
            let distance = {
                let (a, b) = (&self.locations[from], &self.locations[to]);
                (a.depth - b.depth).unsigned_abs() as f64 * a.size[2]
            };
            return travel_time(distance, motion.speed_mps, motion.accel_mps2)
                + motion.transfer_s * 2.0;
        }
        let row_a = match self
            .loc_key
            .get(from)
            .and_then(|&key| self.end_table.get(key as usize))
        {
            Some(row) => *row,
            None => return f64::INFINITY,
        };
        let row_b = match self
            .loc_key
            .get(to)
            .and_then(|&key| self.end_table.get(key as usize))
        {
            Some(row) => *row,
            None => return f64::INFINITY,
        };
        let (from_x, to_x, to_depth, to_size_z) = {
            let a = &self.locations[from];
            let b = &self.locations[to];
            (a.position[0], b.position[0], b.depth, b.size[2])
        };
        let mut best = f64::INFINITY;
        for end_a in row_a.ends.into_iter().flatten() {
            for end_b in row_b.ends.into_iter().flatten() {
                let (skeleton, _) = self.end_pair_by_index(end_a, end_b);
                if !skeleton.is_finite() {
                    continue;
                }
                let end_a_x = self.graph.positions[end_a][0];
                let end_b_x = self.graph.positions[end_b][0];
                let total = skeleton
                    + self.in_aisle_seconds_span(row_a.span, end_a_x, from_x, motion, true)
                    + self.in_aisle_seconds_span(row_b.span, end_b_x, to_x, motion, true)
                    + self.depth_penalty_of(to_depth, to_size_z, motion);
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
    // 设备分组按巷道下标预表（原来每个库位都要拿 aisle_id 去 BTreeMap 里查一次字符串）。
    let lift_group_of_aisle: Vec<usize> = aisle_ids
        .iter()
        .map(|id| *lift_by_aisle.get(id).unwrap_or(&0))
        .collect();
    // 两个站台的图下标：整个建表过程只解析一次节点 id，库位循环里不再出现字符串。
    let out_source = model.graph.index.get(&out_node).copied();
    let in_source = model.graph.index.get(&in_node).copied();
    let mut out = Vec::with_capacity(model.locations.len());
    // 注意：这里**不再**克隆整个 `locations`（压力档下那是几百万个含字符串的记录，
    // 单次克隆就要几百 MB、几秒），也不再把 (站台, 库位) 结果写进字符串键缓存。
    for index in 0..model.locations.len() {
        let (row, uses_lift, placeable, depth_i, size_z, height_m_raw) = {
            let location = &model.locations[index];
            let row = model
                .loc_key
                .get(index)
                .and_then(|&key| model.end_table.get(key as usize))
                .copied();
            (
                row,
                location.level > 1,
                location.availability.placeable(),
                location.depth,
                location.size[2],
                location.position[1],
            )
        };
        let aisle_index = row.map(|r| r.aisle as usize).unwrap_or(0);
        let lift_group = if uses_lift {
            *lift_group_of_aisle.get(aisle_index).unwrap_or(&0)
        } else {
            0
        };
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
        let pick_raw = match out_source {
            Some(source) => model.seconds_from_source_to_location(source, index, &shuttle, true),
            None => f64::INFINITY,
        };
        let put_raw = match in_source {
            Some(source) => model.seconds_from_source_to_location(source, index, &shuttle, true),
            None => f64::INFINITY,
        };
        let unreachable = !pick_raw.is_finite() || !put_raw.is_finite();
        let depth = model.depth_penalty_of(depth_i, size_z, &shuttle);
        // 竖直行程：货位在 2 层以上时，每一次出入库都要付一次提升机换层时间 + 竖井升降时间。
        // 这是真实设备时间的一部分（不是距离折算），必须计入，否则高层货位的代价被系统性低估。
        let height_m = height_m_raw.max(0.0);
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
    if !device.capability.aisles.is_empty()
        && !device.capability.aisles.contains(&location.aisle_id)
    {
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
        return Err(format!(
            "设备 {} 不在区域 {} 作业",
            device.id, location.area_id
        ));
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
