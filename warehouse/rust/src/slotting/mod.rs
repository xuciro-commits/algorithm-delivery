//! 库位优化（Warehouse Slotting Optimization）：问题模型、状态、目标评估与求解入口。
//!
//! ## 增量评估为什么重要
//!
//! 大场景的货物单元在 10^5–10^6 量级，任何"换一次位置就重算全目标"的写法都会把预算吃光。
//! 因此把目标拆成可增量维护的部分（SRS §3.2C 的多目标能力建立在它之上）：
//! * 基础运行代价：逐货物单元可加（每个库位一条预算好的代价表）；
//! * 拥堵代价：按巷道 / 提升机聚合的排队代理（交换两个单元只影响 2 条巷道）；
//! * 迁移代价：与"当前布局"逐单元对比，可 O(1) 维护；
//! * 硬约束在每次移动时 O(1) 判定（容量 / 分区 / 冻结 / 深位），不可行移动直接拒绝。
//!
//! 单位一律显式：秒/天、米/天、kWh/天、件、库位。禁止把不同量纲直接相加（SRS §6.1）。

pub mod dynamic;
pub mod multiobj;
pub mod robust;
pub mod search;
pub mod strategies;
pub mod verify;

/// 缺省随机种子（所有结果都必须能凭 seed + 版本号复现）。
pub const ALGORITHM_DEFAULT_SEED: u64 = 20_250_901;

use std::collections::{BTreeMap, BTreeSet};

use aps_engine::json::Json;

use crate::contract::{SkuSpec, SlottingConstraints, SlottingProblem, Topology};
use crate::errors::{codes, Issues};
use crate::util::{cvar, gini, mean, round, seed_from, stddev, Rng};
use crate::wh::routing::{self, LocationCost, RouteModel};
use crate::wh::topology::LocationRecord;

/* ------------------------------------------------------------------ *
 * 成本模型与索引
 * ------------------------------------------------------------------ */

/// 成本模型的显式参数（每一项都能在面板上解释"这个数字怎么来的"）。
#[derive(Debug, Clone)]
pub struct CostConfig {
    pub outbound_share: f64,
    pub handling_s: f64,
    pub aisle_utilization_target: f64,
    pub lift_utilization_target: f64,
    pub congestion_scale: f64,
    pub timeliness_threshold_s: f64,
    pub aisle_service_seconds: f64,
    pub lift_service_seconds: f64,
    pub relocation_overhead_s: f64,
}

impl Default for CostConfig {
    fn default() -> Self {
        CostConfig {
            outbound_share: 0.8,
            handling_s: 6.0,
            aisle_utilization_target: 0.75,
            lift_utilization_target: 0.8,
            congestion_scale: 1.0,
            timeliness_threshold_s: 180.0,
            aisle_service_seconds: 12.0,
            lift_service_seconds: 18.0,
            relocation_overhead_s: 25.0,
        }
    }
}

/// 关联度（来自真实订单历史；没有历史就没有关联能力，如实反映为 0）。
#[derive(Debug, Clone, Default)]
pub struct Affinity {
    /// SKU 下标 → (关联 SKU 下标, 权重, 共出库次数)
    pub pairs: Vec<Vec<(usize, f64, usize)>>,
    pub cluster_of: Vec<i64>,
    pub clusters: usize,
    pub co_occurrence_rate: f64,
}

/// 库位优化模型：问题 → 可增量评估的结构。
pub struct SlottingModel<'a> {
    pub problem: &'a SlottingProblem,
    pub topology: &'a Topology,
    pub cost_config: CostConfig,
    pub locations: Vec<LocationRecord>,
    pub costs: Vec<LocationCost>,
    pub aisle_ids: Vec<String>,
    pub aisle_capacity: Vec<f64>,
    pub lift_ids: Vec<String>,
    pub lift_capacity: Vec<f64>,
    /// 可放置库位（未冻结/不可用，且可达）。
    pub placeable: Vec<usize>,
    /// 严格可用的库位（用于利用率分母）。
    pub available: Vec<usize>,
    pub loc_max_weight: Vec<f64>,
    pub loc_max_volume: Vec<f64>,
    pub loc_zone: Vec<String>,
    pub loc_index: BTreeMap<String, usize>,
    pub skus: Vec<SkuSpec>,
    pub sku_index: BTreeMap<String, usize>,
    /// 货物单元 → SKU 下标。
    pub lu_sku: Vec<usize>,
    /// 货物单元 → 日流量（件/天，按载具件数分摊）。
    pub unit_flow: Vec<f64>,
    pub sku_weight: Vec<f64>,
    pub sku_volume: Vec<f64>,
    pub sku_daily_out: Vec<f64>,
    /// 货物单元 → 当前库位下标（-1 = 未上架）。
    pub current_loc: Vec<i64>,
    pub affinity: Affinity,
    pub hard: BTreeSet<String>,
    pub constraints: SlottingConstraints,
    /// 迁移代价缓存：稀疏键 (起始库位, 目标库位) → 秒，按需生长（不预分配，避免大场景内存爆掉）。
    pub relocation_cache: BTreeMap<(usize, usize), f64>,
    /// 运行时间模型（含 Dijkstra 源缓存与站台缓存；移库代价复用它）。
    pub route_model: RouteModel,
    /// 可选库位按"出库+入库加权时间"排序（用于最远可用等策略与启发式初始解）。
    pub order_by_cost: Vec<usize>,
    pub rng_seed: u64,
}

/// 从契约问题构建模型（纯函数；给定同一问题必然得到同一模型）。
pub fn build_model<'a>(problem: &'a SlottingProblem, cost_config: CostConfig) -> SlottingModel<'a> {
    let topology = &problem.topology;
    let locations = crate::wh::topology::derive_locations(topology);
    let mut route_model = RouteModel::build(topology, locations.clone());
    let costs = routing::location_costs(topology, &mut route_model, cost_config.handling_s);
    let route_model = route_model;
    let (lift_ids, _) = routing::lift_groups(topology);
    let aisle_ids: Vec<String> = topology.aisles.iter().map(|a| a.id.clone()).collect();

    // 巷道容量（秒/天）：穿梭车数 × 可用工时 × 目标利用率
    let mut shuttle_count = vec![0.0f64; aisle_ids.len()];
    for device in &topology.devices {
        if !device.kind.is_shuttle() {
            continue;
        }
        let covered: Vec<&String> = if device.capability.aisles.is_empty() {
            aisle_ids.iter().collect()
        } else {
            device.capability.aisles.iter().collect()
        };
        let share = if device.capability.aisles.is_empty() {
            1.0 / aisle_ids.len().max(1) as f64
        } else {
            1.0
        };
        for aisle in covered {
            if let Some(index) = aisle_ids.iter().position(|id| id == aisle) {
                shuttle_count[index] += share;
            }
        }
    }
    let aisle_capacity: Vec<f64> = shuttle_count
        .iter()
        .map(|count| count.max(1.0) * 86_400.0 * cost_config.aisle_utilization_target)
        .collect();

    // 提升机容量（秒/天）
    let mut lift_capacity = vec![0.0f64; lift_ids.len()];
    for device in &topology.devices {
        if device.kind != crate::contract::DeviceKind::PalletLift {
            continue;
        }
        if let Some(index) = lift_ids.iter().position(|id| id == &device.id) {
            lift_capacity[index] += 86_400.0 * cost_config.lift_utilization_target;
        }
    }
    for value in lift_capacity.iter_mut() {
        *value = value.max(86_400.0 * cost_config.lift_utilization_target);
    }

    let loc_index: BTreeMap<String, usize> = locations
        .iter()
        .enumerate()
        .map(|(i, l)| (l.id.clone(), i))
        .collect();
    let mut placeable = Vec::new();
    let mut available = Vec::new();
    for (index, cost) in costs.iter().enumerate() {
        if !cost.pick_seconds.is_finite() {
            continue;
        }
        placeable.push(index);
        if locations[index].availability == crate::contract::Availability::Available {
            available.push(index);
        }
    }
    let mut order_by_cost = placeable.clone();
    let outbound = cost_config.outbound_share;
    order_by_cost.sort_by(|a, b| {
        let ka = costs[*a].pick_seconds * outbound + costs[*a].put_seconds * (1.0 - outbound);
        let kb = costs[*b].pick_seconds * outbound + costs[*b].put_seconds * (1.0 - outbound);
        ka.partial_cmp(&kb)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.cmp(b))
    });

    // 货物单元 → SKU 与流量分摊
    let sku_index: BTreeMap<String, usize> = problem
        .skus
        .iter()
        .enumerate()
        .map(|(i, s)| (s.id.clone(), i))
        .collect();
    let mut pieces = vec![0.0f64; problem.skus.len()];
    let mut lu_sku = vec![0usize; problem.inventory.len()];
    for (i, unit) in problem.inventory.iter().enumerate() {
        let index = sku_index.get(&unit.sku_id).copied().unwrap_or(0);
        lu_sku[i] = index;
        pieces[index] += unit.quantity;
    }
    let sku_daily_out: Vec<f64> = problem.skus.iter().map(|s| s.mean_daily_demand).collect();
    let mut unit_flow = vec![0.0f64; problem.inventory.len()];
    for (i, unit) in problem.inventory.iter().enumerate() {
        let share = if pieces[lu_sku[i]] > 0.0 {
            unit.quantity / pieces[lu_sku[i]]
        } else {
            1.0
        };
        unit_flow[i] = sku_daily_out[lu_sku[i]] * share;
    }

    // 当前布局
    let mut current_loc = vec![-1i64; problem.inventory.len()];
    let lu_index: BTreeMap<&str, usize> = problem
        .inventory
        .iter()
        .enumerate()
        .map(|(i, u)| (u.id.as_str(), i))
        .collect();
    if !problem.current_assignment.is_empty() {
        for (unit_id, location_id) in &problem.current_assignment {
            if let (Some(&lu), Some(&loc)) =
                (lu_index.get(unit_id.as_str()), loc_index.get(location_id))
            {
                current_loc[lu] = loc as i64;
            }
        }
    } else {
        for (i, unit) in problem.inventory.iter().enumerate() {
            if let Some(location_id) = &unit.location_id {
                if let Some(&loc) = loc_index.get(location_id) {
                    current_loc[i] = loc as i64;
                }
            }
        }
    }

    let loc_max_weight = locations.iter().map(|l| l.max_weight_kg).collect();
    let loc_max_volume = locations.iter().map(|l| l.max_volume_m3).collect();
    let loc_zone = locations.iter().map(|l| l.zone.clone()).collect();
    let sku_weight = problem.skus.iter().map(|s| s.unit_weight_kg).collect();
    let sku_volume = problem.skus.iter().map(|s| s.unit_volume_m3).collect();

    SlottingModel {
        problem,
        topology,
        cost_config,
        locations,
        costs,
        aisle_ids,
        aisle_capacity,
        lift_ids,
        lift_capacity,
        placeable,
        available,
        loc_max_weight,
        loc_max_volume,
        loc_zone,
        loc_index,
        skus: problem.skus.clone(),
        sku_index,
        lu_sku,
        unit_flow,
        sku_weight,
        sku_volume,
        sku_daily_out,
        current_loc,
        affinity: compute_affinity(problem),
        hard: problem.hard_constraints.iter().cloned().collect(),
        constraints: problem.constraints.clone(),
        relocation_cache: BTreeMap::new(),
        route_model,
        order_by_cost,
        rng_seed: problem.algorithm.seed,
    }
}

/// 关联度：从订单历史计算（时间衰减 + 支持度收缩 + 稀疏化）。
pub fn compute_affinity(problem: &SlottingProblem) -> Affinity {
    let n = problem.skus.len();
    let index: BTreeMap<&str, usize> = problem
        .skus
        .iter()
        .enumerate()
        .map(|(i, s)| (s.id.as_str(), i))
        .collect();
    let mut pairs: BTreeMap<(usize, usize), (f64, usize)> = BTreeMap::new();
    let mut weighted_count = vec![0.0f64; n];
    let latest = problem
        .history
        .iter()
        .map(|o| o.release_s)
        .fold(0.0f64, |a, b| a.max(b));
    let half_life = 21.0 * 86_400.0;
    for order in &problem.history {
        let decay = 0.5f64.powf(((latest - order.release_s).max(0.0)) / half_life);
        let mut unique: Vec<usize> = Vec::new();
        for line in &order.lines {
            if let Some(&sku) = index.get(line.sku_id.as_str()) {
                if !unique.contains(&sku) {
                    unique.push(sku);
                    weighted_count[sku] += decay;
                }
            }
        }
        for i in 0..unique.len() {
            for j in (i + 1)..unique.len() {
                let key = (unique[i].min(unique[j]), unique[i].max(unique[j]));
                let entry = pairs.entry(key).or_insert((0.0, 0));
                entry.0 += decay;
                entry.1 += 1;
            }
        }
    }
    let mut list: Vec<((usize, usize), f64, usize)> = pairs
        .into_iter()
        .map(|(key, (weighted, count))| {
            let support = weighted_count[key.0].min(weighted_count[key.1]);
            (key, weighted / (support + 8.0), count)
        })
        .filter(|(_, weight, _)| *weight >= 0.02)
        .collect();
    list.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    let mut out: Vec<Vec<(usize, f64, usize)>> = vec![Vec::new(); n];
    let mut clusters = 0;
    let mut cluster_of = vec![-1i64; n];
    for (key, weight, count) in &list {
        if out[key.0].len() < 12 {
            out[key.0].push((key.1, *weight, *count));
        }
        if out[key.1].len() < 12 {
            out[key.1].push((key.0, *weight, *count));
        }
    }
    // 关联簇：按权重从高到低的确定性并查集（仅用于初始化与解释，不直接当目标）
    let target_clusters = ((n as f64).sqrt() / 4.0).round().clamp(0.0, 64.0) as usize;
    if target_clusters > 0 && n > target_clusters {
        let mut parent: Vec<usize> = (0..n).collect();
        fn find(parent: &mut [usize], mut x: usize) -> usize {
            while parent[x] != x {
                parent[x] = parent[parent[x]];
                x = parent[x];
            }
            x
        }
        let mut components = n;
        for (key, _, _) in &list {
            if components <= target_clusters {
                break;
            }
            let (ra, rb) = (find(&mut parent, key.0), find(&mut parent, key.1));
            if ra != rb {
                parent[rb] = ra;
                components -= 1;
            }
        }
        let mut labels: BTreeMap<usize, usize> = BTreeMap::new();
        for (index, label_slot) in cluster_of.iter_mut().enumerate() {
            let root = find(&mut parent, index);
            let next = labels.len();
            *label_slot = *labels.entry(root).or_insert(next) as i64;
        }
        clusters = labels.len();
    }
    let lines: f64 = problem.history.iter().map(|o| o.lines.len() as f64).sum();
    Affinity {
        pairs: out,
        cluster_of,
        clusters,
        co_occurrence_rate: round(list.len() as f64 / lines.max(1.0), 4),
    }
}

/* ------------------------------------------------------------------ *
 * 状态与增量评估
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone)]
pub struct SlottingState {
    /// 货物单元 → 库位下标（-1 = 未分配）。
    pub loc_of_lu: Vec<i64>,
    /// 库位下标 → 货物单元（-1 = 空）。
    pub lu_at_loc: Vec<i64>,
    pub aisle_flow: Vec<f64>,
    pub lift_flow: Vec<f64>,
    pub unassigned: usize,
    pub base_seconds: f64,
    pub base_meters: f64,
    pub relocation_count: usize,
    pub relocation_seconds: f64,
    /// 每个货物单元的搬迁贡献缓存 (是否需要搬迁, 设备秒)，用于增量更新。
    relocation_ledger: Vec<(bool, f64)>,
}

/// 单个货物单元相对"当前布局"的搬迁贡献：(是否需要搬迁, 设备秒)。
pub fn relocation_contribution(model: &mut SlottingModel, lu: usize, loc: i64) -> (bool, f64) {
    if loc < 0 {
        return (false, 0.0);
    }
    let current = model.current_loc[lu];
    if current == loc {
        return (false, 0.0);
    }
    let seconds = relocation_seconds(model, current, loc as usize);
    (true, seconds)
}

impl SlottingState {
    pub fn new(model: &SlottingModel) -> SlottingState {
        SlottingState {
            loc_of_lu: vec![-1; model.lu_sku.len()],
            lu_at_loc: vec![-1; model.locations.len()],
            aisle_flow: vec![0.0; model.aisle_ids.len()],
            lift_flow: vec![0.0; model.lift_ids.len()],
            unassigned: model.lu_sku.len(),
            base_seconds: 0.0,
            base_meters: 0.0,
            relocation_count: 0,
            relocation_seconds: 0.0,
            relocation_ledger: vec![(false, 0.0); model.lu_sku.len()],
        }
    }

    pub fn clone_state(&self) -> SlottingState {
        self.clone()
    }

    pub fn place(&mut self, model: &mut SlottingModel, lu: usize, loc: usize) {
        if self.loc_of_lu[lu] >= 0 {
            self.unplace(model, lu);
        }
        self.loc_of_lu[lu] = loc as i64;
        self.lu_at_loc[loc] = lu as i64;
        let cost = &model.costs[loc];
        let flow = model.unit_flow[lu];
        self.base_seconds += flow
            * (model.cost_config.outbound_share * cost.pick_seconds
                + (1.0 - model.cost_config.outbound_share) * cost.put_seconds);
        self.base_meters += flow * cost.meters;
        self.aisle_flow[cost.aisle_index] += flow;
        if cost.uses_lift {
            self.lift_flow[cost.lift_group] += flow;
        }
        self.unassigned = self.unassigned.saturating_sub(1);
        self.track_relocation(model, lu);
    }

    pub fn unplace(&mut self, model: &mut SlottingModel, lu: usize) {
        let loc = self.loc_of_lu[lu];
        if loc < 0 {
            return;
        }
        let loc = loc as usize;
        let cost = &model.costs[loc];
        let flow = model.unit_flow[lu];
        self.base_seconds -= flow
            * (model.cost_config.outbound_share * cost.pick_seconds
                + (1.0 - model.cost_config.outbound_share) * cost.put_seconds);
        self.base_meters -= flow * cost.meters;
        self.aisle_flow[cost.aisle_index] -= flow;
        if cost.uses_lift {
            self.lift_flow[cost.lift_group] -= flow;
        }
        self.loc_of_lu[lu] = -1;
        self.lu_at_loc[loc] = -1;
        self.unassigned += 1;
        self.track_relocation(model, lu);
    }

    /// 增量维护"相对当前布局的迁移代价"：只对受影响的货物单元做 O(1)（含缓存）重算。
    ///
    /// 这一步必须在移动时做，否则目标函数里的搬迁项会与实际方案不一致（相当于自欺）。
    fn track_relocation(&mut self, model: &mut SlottingModel, lu: usize) {
        let contribution = relocation_contribution(model, lu, self.loc_of_lu[lu]);
        let previous = self.relocation_ledger[lu];
        self.relocation_seconds += contribution.1 - previous.1;
        if contribution.0 != previous.0 {
            self.relocation_count = if contribution.0 {
                self.relocation_count + 1
            } else {
                self.relocation_count.saturating_sub(1)
            };
        }
        self.relocation_ledger[lu] = contribution;
    }

    /// 交换两个货物单元的库位（允许其中一个未分配）。
    pub fn swap(&mut self, model: &mut SlottingModel, a: usize, b: usize) {
        let loc_a = self.loc_of_lu[a];
        let loc_b = self.loc_of_lu[b];
        self.unplace(model, a);
        self.unplace(model, b);
        if loc_b >= 0 {
            self.place(model, a, loc_b as usize);
        }
        if loc_a >= 0 {
            self.place(model, b, loc_a as usize);
        }
    }

    /// 把货物单元移到指定库位；目标被占用时与占用者交换。
    pub fn move_to(&mut self, model: &mut SlottingModel, lu: usize, loc: usize) {
        let occupant = self.lu_at_loc[loc];
        if occupant >= 0 && occupant as usize != lu {
            self.swap(model, lu, occupant as usize);
            return;
        }
        self.unplace(model, lu);
        self.place(model, lu, loc);
    }

    /// 拥堵代理：ρ/(1−ρ) 型排队延误（秒/天），ρ 截断在 0.97 以内避免发散。
    pub fn congestion_seconds(&self, model: &SlottingModel) -> f64 {
        let mut total = 0.0;
        for (index, flow) in self.aisle_flow.iter().enumerate() {
            let capacity = model.aisle_capacity[index];
            if capacity <= 0.0 || *flow <= 0.0 {
                continue;
            }
            let demand = flow * model.cost_config.aisle_service_seconds;
            let rho = (demand / capacity).clamp(0.0, 0.97);
            if rho <= 0.01 {
                continue;
            }
            total += model.cost_config.congestion_scale * (rho / (1.0 - rho)) * demand;
        }
        for (index, flow) in self.lift_flow.iter().enumerate() {
            let capacity = model.lift_capacity[index];
            if capacity <= 0.0 || *flow <= 0.0 {
                continue;
            }
            let demand = flow * model.cost_config.lift_service_seconds;
            let rho = (demand / capacity).clamp(0.0, 0.97);
            if rho <= 0.01 {
                continue;
            }
            total += model.cost_config.congestion_scale * (rho / (1.0 - rho)) * demand;
        }
        total
    }

    pub fn aisle_gini(&self) -> f64 {
        gini(&self.aisle_flow)
    }

    /// 拥堵对单件运行时间的乘数（把排队延误摊到每件上）。
    pub fn congestion_factor(&self, model: &SlottingModel) -> f64 {
        let total: f64 = self.aisle_flow.iter().sum();
        if total <= 0.0 {
            return 1.0;
        }
        1.0 + self.congestion_seconds(model) / (total * model.cost_config.aisle_service_seconds)
    }

    /// 时效：拥堵调整后运行时间不超过阈值的流量占比。
    pub fn timeliness(&self, model: &SlottingModel) -> f64 {
        let factor = self.congestion_factor(model);
        let mut in_time = 0.0;
        let mut total = 0.0;
        for (lu, loc) in self.loc_of_lu.iter().enumerate() {
            if *loc < 0 {
                continue;
            }
            let flow = model.unit_flow[lu];
            total += flow;
            if model.costs[*loc as usize].pick_seconds * factor
                <= model.cost_config.timeliness_threshold_s
            {
                in_time += flow;
            }
        }
        if total > 0.0 {
            in_time / total
        } else {
            1.0
        }
    }

    /// 全量重新推导迁移代价（用于增量维护正确性的交叉校验，不参与搜索热路径）。
    pub fn recompute_relocation(&mut self, model: &mut SlottingModel) -> (usize, f64) {
        let mut count = 0usize;
        let mut seconds = 0.0;
        for lu in 0..self.loc_of_lu.len() {
            let (moved, secs) = relocation_contribution(model, lu, self.loc_of_lu[lu]);
            self.relocation_ledger[lu] = (moved, secs);
            if moved {
                count += 1;
                seconds += secs;
            }
        }
        (count, seconds)
    }

    /// 全量重建（构建初始状态或校验增量维护的正确性）。
    pub fn rebuild(model: &mut SlottingModel, assignment: &[i64]) -> SlottingState {
        let mut state = SlottingState::new(model);
        for (lu, loc) in assignment.iter().enumerate() {
            if *loc >= 0 {
                state.place(model, lu, *loc as usize);
            }
        }
        state
    }
}

/// 单次迁移的设备秒数（两两库位运行时间按需计算并缓存）。
///
/// 真实设备语义：同一货架列内的整列倒垛远便宜于跨巷道搬运 —— 这一点由 `RouteModel`
/// 保证，不是人为折扣。
pub fn relocation_seconds(model: &mut SlottingModel, from: i64, to: usize) -> f64 {
    if from < 0 {
        return model.costs[to].put_seconds + model.cost_config.relocation_overhead_s;
    }
    let from = from as usize;
    if let Some(value) = model.relocation_cache.get(&(from, to)) {
        return *value;
    }
    let (shuttle, _) = routing::representative_motion(model.topology);
    let seconds = model.route_model.seconds_between_locations(
        &model.locations[from].id,
        &model.locations[to].id,
        &shuttle,
    );
    let value = if seconds.is_finite() {
        seconds + model.cost_config.relocation_overhead_s
    } else {
        // 不可达（数据问题）：按 10 分钟计，并在验证阶段以不可达告警暴露
        600.0
    };
    model.relocation_cache.insert((from, to), value);
    value
}

/// 硬约束判定（独立函数：求解器用它剪枝，验证器用同一语义复核）。
pub fn can_place(model: &SlottingModel, lu: usize, loc: usize) -> Result<(), (String, String)> {
    let location = &model.locations[loc];
    match location.availability {
        crate::contract::Availability::Frozen => {
            return Err((
                crate::errors::constraints::LOCATION_FROZEN.to_string(),
                format!("库位 {} 处于冻结状态", location.id),
            ))
        }
        crate::contract::Availability::Unavailable => {
            return Err((
                crate::errors::constraints::LOCATION_UNAVAILABLE.to_string(),
                format!("库位 {} 不可用", location.id),
            ))
        }
        _ => {}
    }
    let cost = &model.costs[loc];
    if !cost.pick_seconds.is_finite() {
        return Err((
            crate::errors::constraints::LOCATION_UNAVAILABLE.to_string(),
            format!("库位 {} 不可达", location.id),
        ));
    }
    let sku = model.lu_sku[lu];
    if model.sku_weight[sku] > model.loc_max_weight[loc] + 1e-9 {
        return Err((
            crate::errors::constraints::LOCATION_WEIGHT_LIMIT.to_string(),
            format!(
                "SKU 单元重量 {}kg 超过库位 {} 上限 {}kg",
                model.sku_weight[sku], location.id, model.loc_max_weight[loc]
            ),
        ));
    }
    if model.sku_volume[sku] > model.loc_max_volume[loc] + 1e-9 {
        return Err((
            crate::errors::constraints::LOCATION_VOLUME_LIMIT.to_string(),
            format!(
                "SKU 单元体积 {}m³ 超过库位 {} 容积 {}m³",
                model.sku_volume[sku], location.id, model.loc_max_volume[loc]
            ),
        ));
    }
    let allowed = &model.skus[sku].allowed_zones;
    if !allowed.is_empty() && !routing::zone_compatible(allowed, &model.loc_zone[loc]) {
        return Err((
            crate::errors::constraints::ZONE_COMPATIBILITY.to_string(),
            format!(
                "SKU {} 的储存分区限制 {:?} 与库位分区 {} 不兼容",
                model.skus[sku].id, allowed, model.loc_zone[loc]
            ),
        ));
    }
    if model.constraints.deep_lane_policy == "front-only"
        && location.depth > 1
        && model.skus[sku].abc == 'A'
    {
        return Err((
            crate::errors::constraints::DEEP_LANE_BLOCKING.to_string(),
            format!(
                "A 类商品 {} 不允许放在深位 {}（会遮挡后续取货）",
                model.skus[sku].id, location.id
            ),
        ));
    }
    Ok(())
}

/* ------------------------------------------------------------------ *
 * 目标评估
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone)]
pub struct ObjectiveVector {
    pub values: BTreeMap<String, f64>,
    pub scalar: f64,
    pub unassigned: usize,
}

/// 目标聚合：把状态 + 模型翻译成带单位的指标与目标向量。
pub fn evaluate(model: &SlottingModel, state: &SlottingState) -> ObjectiveVector {
    let factor = state.congestion_factor(model);
    let assigned = model.lu_sku.len().saturating_sub(state.unassigned);
    let mut values: BTreeMap<String, f64> = BTreeMap::new();
    values.insert(
        "expected-travel-time".to_string(),
        round(state.base_seconds * factor, 3),
    );
    values.insert(
        "device-travel-distance".to_string(),
        round(state.base_meters, 3),
    );
    values.insert(
        "space-utilization".to_string(),
        round(assigned as f64 / model.available.len().max(1) as f64, 6),
    );
    values.insert(
        "relocation-count".to_string(),
        state.relocation_count as f64,
    );
    values.insert(
        "relocation-cost".to_string(),
        round(state.relocation_seconds, 3),
    );
    values.insert(
        "congestion".to_string(),
        round(state.congestion_seconds(model), 3),
    );
    values.insert("load-balance".to_string(), round(state.aisle_gini(), 6));
    values.insert(
        "delivery-timeliness".to_string(),
        round(state.timeliness(model), 6),
    );
    values.insert(
        "energy".to_string(),
        round((state.base_meters / 1000.0) * 0.0016, 3),
    );

    let mut scalar = 0.0;
    for objective in &model.problem.objectives {
        let raw = values.get(&objective.id).copied().unwrap_or(0.0);
        let reference = objective
            .normalizer
            .unwrap_or_else(|| default_normalizer(&objective.id));
        let normalized = if reference > 0.0 {
            raw / reference
        } else {
            raw
        };
        let signed = if objective.direction == "min" {
            normalized
        } else {
            -normalized
        };
        scalar += objective.weight * signed;
    }
    // 未分配库存是硬惩罚（不允许"靠不分配来降低运行代价"）
    scalar += state.unassigned as f64 * 1e3;
    ObjectiveVector {
        values,
        scalar,
        unassigned: state.unassigned,
    }
}

/// 各目标的默认归一化尺度（保证不同量纲的加权有意义；面板会如实展示）。
pub fn default_normalizer(id: &str) -> f64 {
    match id {
        "expected-travel-time" => 100_000.0,
        "device-travel-distance" => 500_000.0,
        "relocation-count" => 1_000.0,
        "relocation-cost" => 100_000.0,
        "congestion" => 10_000.0,
        "load-balance" => 0.5,
        "delivery-timeliness" => 1.0,
        "energy" => 2_000.0,
        _ => 1.0,
    }
}

/* ------------------------------------------------------------------ *
 * 指标 / 迁移 / 解释
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Default)]
pub struct SlottingMetrics {
    pub space_utilization: f64,
    pub effective_utilization: f64,
    pub expected_pick_seconds: f64,
    pub expected_put_seconds: f64,
    pub affinity_coherence: f64,
    pub aisle_load_gini: f64,
    pub lift_peak_ratio: f64,
    pub congestion_index: f64,
    pub relocation_count: usize,
    pub relocation_device_seconds: f64,
    pub unmet_constraints: usize,
    pub objectives: Vec<ObjectiveValue>,
    pub compute_ms: f64,
    pub stability: Option<f64>,
    pub stability_seeds: Vec<(u64, f64)>,
    pub scale: ScaleReport,
}

#[derive(Debug, Clone, Default)]
pub struct ObjectiveValue {
    pub id: String,
    pub direction: String,
    pub unit: String,
    pub weight: f64,
    pub raw: f64,
    pub normalized: f64,
    pub conflicts_with: Vec<String>,
    pub note: String,
}

/// 实际参与计算的规模（必须如实报告，SRS §8）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScaleReport {
    pub skus: usize,
    pub locations: usize,
    pub load_units: usize,
    pub orders: usize,
    pub assignments: usize,
    pub tasks: usize,
    pub devices: usize,
    pub events: usize,
    pub note: String,
}

fn conflict_partners(id: &str) -> Vec<String> {
    let list: Vec<&str> = match id {
        "expected-travel-time" => vec!["relocation-cost", "congestion"],
        "space-utilization" => vec!["expected-travel-time", "delivery-timeliness"],
        "relocation-count" => vec!["expected-travel-time", "load-balance"],
        "congestion" => vec!["expected-travel-time", "space-utilization"],
        "load-balance" => vec!["expected-travel-time"],
        "delivery-timeliness" => vec!["relocation-count"],
        "energy" => vec!["expected-travel-time"],
        _ => vec![],
    };
    list.into_iter().map(|s| s.to_string()).collect()
}

pub fn build_metrics(
    model: &SlottingModel,
    state: &SlottingState,
    objective: &ObjectiveVector,
    compute_ms: f64,
    stability: Option<f64>,
    stability_seeds: Vec<(u64, f64)>,
) -> SlottingMetrics {
    // 有效利用率：只统计真正可服务（前排深度）的库位
    let effective: Vec<usize> = model
        .placeable
        .iter()
        .copied()
        .filter(|index| model.locations[*index].depth == 1)
        .collect();
    let effective_used = effective
        .iter()
        .filter(|index| state.lu_at_loc[**index] >= 0)
        .count();

    // 关联效果：SKU → 巷道 / 列
    let mut aisle_of_sku = vec![-1i64; model.skus.len()];
    let mut bay_of_sku = vec![0i64; model.skus.len()];
    for (lu, loc) in state.loc_of_lu.iter().enumerate() {
        if *loc < 0 {
            continue;
        }
        let sku = model.lu_sku[lu];
        if aisle_of_sku[sku] < 0 {
            aisle_of_sku[sku] = model.costs[*loc as usize].aisle_index as i64;
            bay_of_sku[sku] = model.locations[*loc as usize].bay as i64;
        }
    }
    let mut coherent = 0.0;
    let mut weight_sum = 0.0;
    for (sku, pairs) in model.affinity.pairs.iter().enumerate() {
        for (other, weight, _) in pairs {
            if *other <= sku {
                continue;
            }
            let distance = if aisle_of_sku[sku] == aisle_of_sku[*other] {
                (bay_of_sku[sku] - bay_of_sku[*other]).abs() as f64
            } else {
                40.0
            };
            coherent += weight * distance;
            weight_sum += weight;
        }
    }
    let affinity_coherence = if weight_sum > 0.0 {
        round(coherent / weight_sum, 4)
    } else {
        0.0
    };

    let lift_values: Vec<f64> = state
        .lift_flow
        .iter()
        .copied()
        .filter(|v| *v > 0.0)
        .collect();
    let lift_peak_ratio = if lift_values.len() > 1 {
        round(
            lift_values.iter().copied().fold(0.0f64, f64::max) / mean(&lift_values).max(1e-6),
            4,
        )
    } else {
        1.0
    };

    let flow_sum: f64 = model.unit_flow.iter().sum();
    let mut out_weighted = 0.0;
    let mut in_weighted = 0.0;
    for (lu, loc) in state.loc_of_lu.iter().enumerate() {
        if *loc < 0 {
            continue;
        }
        let flow = model.unit_flow[lu];
        out_weighted += flow * model.costs[*loc as usize].pick_seconds;
        in_weighted += flow * model.costs[*loc as usize].put_seconds;
    }

    let objectives: Vec<ObjectiveValue> = model
        .problem
        .objectives
        .iter()
        .map(|spec| {
            let raw = objective.values.get(&spec.id).copied().unwrap_or(0.0);
            let reference = spec
                .normalizer
                .unwrap_or_else(|| default_normalizer(&spec.id));
            let ratio = if reference > 0.0 {
                raw / reference
            } else {
                raw
            };
            let normalized = if spec.direction == "min" {
                1.0 - ratio.min(1.0)
            } else {
                ratio.min(1.0)
            };
            ObjectiveValue {
                id: spec.id.clone(),
                direction: spec.direction.clone(),
                unit: spec.unit.clone(),
                weight: spec.weight,
                raw: round(raw, 4),
                normalized: round(normalized, 4),
                conflicts_with: conflict_partners(&spec.id),
                note: spec.note.clone(),
            }
        })
        .collect();

    let assigned = model.lu_sku.len().saturating_sub(state.unassigned);
    SlottingMetrics {
        space_utilization: objective
            .values
            .get("space-utilization")
            .copied()
            .unwrap_or(0.0),
        effective_utilization: round(effective_used as f64 / effective.len().max(1) as f64, 6),
        expected_pick_seconds: round(
            if flow_sum > 0.0 {
                out_weighted / flow_sum
            } else {
                0.0
            },
            3,
        ),
        expected_put_seconds: round(
            if flow_sum > 0.0 {
                in_weighted / flow_sum
            } else {
                0.0
            },
            3,
        ),
        affinity_coherence,
        aisle_load_gini: objective.values.get("load-balance").copied().unwrap_or(0.0),
        lift_peak_ratio,
        congestion_index: round(
            (state.congestion_seconds(model)
                / (flow_sum * model.cost_config.aisle_service_seconds).max(1.0))
            .min(1.0),
            4,
        ),
        relocation_count: state.relocation_count,
        relocation_device_seconds: round(state.relocation_seconds, 2),
        unmet_constraints: 0,
        objectives,
        compute_ms,
        stability,
        stability_seeds,
        scale: ScaleReport {
            skus: model.skus.len(),
            locations: model.locations.len(),
            load_units: model.lu_sku.len(),
            orders: model.problem.history.len(),
            assignments: assigned,
            tasks: 0,
            devices: model.topology.devices.len(),
            events: 0,
            note: String::new(),
        },
    }
}

/// 迁移动作（建议 vs 需要执行的任务，SRS §3.2B 明确区分）。
#[derive(Debug, Clone)]
pub struct MigrationAction {
    pub load_unit_id: String,
    pub sku_id: String,
    pub from_location_id: Option<String>,
    pub to_location_id: String,
    pub mode: &'static str,
    pub reason: String,
    pub estimated_device_seconds: f64,
    pub estimated_energy_kwh: f64,
    pub trigger: Option<(String, f64, String)>,
    pub requires_dispatch: bool,
}

pub fn build_migrations(model: &mut SlottingModel, state: &SlottingState) -> Vec<MigrationAction> {
    let budget_moves = model.problem.algorithm.migration_max_moves;
    let budget_seconds = model.problem.algorithm.migration_max_seconds;
    let mut actions = Vec::new();
    let mut used_seconds = 0.0;
    for (lu, target) in state.loc_of_lu.iter().enumerate() {
        if *target < 0 {
            continue;
        }
        let target = *target as usize;
        let current = model.current_loc[lu];
        if current == target as i64 {
            continue;
        }
        let seconds = relocation_seconds(model, current, target);
        let within_budget =
            actions.len() < budget_moves && used_seconds + seconds <= budget_seconds;
        let from_cost = if current >= 0 {
            model.costs[current as usize].pick_seconds
        } else {
            0.0
        };
        actions.push(MigrationAction {
            load_unit_id: model.problem.inventory[lu].id.clone(),
            sku_id: model.problem.inventory[lu].sku_id.clone(),
            from_location_id: if current >= 0 {
                Some(model.locations[current as usize].id.clone())
            } else {
                None
            },
            to_location_id: model.locations[target].id.clone(),
            mode: if within_budget { "task" } else { "suggestion" },
            reason: if current < 0 {
                "尚未上架：直接按最新布局入库".to_string()
            } else {
                format!(
                    "出库运行时间 {}s → {}s",
                    round(from_cost, 1),
                    round(model.costs[target].pick_seconds, 1)
                )
            },
            estimated_device_seconds: round(seconds, 2),
            estimated_energy_kwh: round((seconds / 3600.0) * 0.08, 4),
            trigger: None,
            requires_dispatch: within_budget,
        });
        if within_budget {
            used_seconds += seconds;
        }
    }
    actions.sort_by(|a, b| {
        a.estimated_device_seconds
            .partial_cmp(&b.estimated_device_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.load_unit_id.cmp(&b.load_unit_id))
    });
    actions
}

/// 一条解释：`(主题, 结论, 证据清单)`。CLI 报告、面板与三维高亮都按这三段渲染，
/// 确定性 / 鲁棒 / 动态三条求解路径共用同一种形状。
pub type Explanation = (String, String, Vec<(String, Json)>);

/// 解释"为什么货物应该放在这些库位"（SRS §14 问题 1）——必须引用真实计算证据。
pub fn explain(
    model: &SlottingModel,
    state: &SlottingState,
    infeasibility: Option<&str>,
) -> Vec<Explanation> {
    let mut out: Vec<Explanation> = Vec::new();
    let mut a_seconds = 0.0;
    let mut a_count = 0usize;
    let mut c_seconds = 0.0;
    let mut c_count = 0usize;
    for (lu, loc) in state.loc_of_lu.iter().enumerate() {
        if *loc < 0 {
            continue;
        }
        match model.skus[model.lu_sku[lu]].abc {
            'A' => {
                a_seconds += model.costs[*loc as usize].pick_seconds;
                a_count += 1;
            }
            'C' => {
                c_seconds += model.costs[*loc as usize].pick_seconds;
                c_count += 1;
            }
            _ => {}
        }
    }
    if a_count > 0 && c_count > 0 {
        let a_avg = a_seconds / a_count as f64;
        let c_avg = c_seconds / c_count as f64;
        out.push((
            "ABC 分区（出库时间）".to_string(),
            format!(
                "A 类商品平均出库运行时间 {}s，C 类 {}s（差 {}s）：这是\"高频商品靠近出库口\"的直接证据",
                round(a_avg, 1),
                round(c_avg, 1),
                round(c_avg - a_avg, 1)
            ),
            vec![
                ("aAverageSeconds".to_string(), Json::Float(round(a_avg, 2))),
                ("cAverageSeconds".to_string(), Json::Float(round(c_avg, 2))),
            ],
        ));
    }
    let pair_count: usize = model.affinity.pairs.iter().map(|p| p.len()).sum();
    out.push((
        "关联性库位".to_string(),
        if pair_count > 0 {
            format!(
                "基于 {} 条订单历史关联边（平均共出库率 {}）把共同出库商品尽量压到同一巷道，减少跨巷道往返",
                pair_count / 2,
                model.affinity.co_occurrence_rate
            )
        } else {
            "本问题的订单历史没有形成显著关联对，因此关联性优化只做了容量与运行时间层面的事"
                .to_string()
        },
        vec![
            ("affinityPairs".to_string(), Json::int((pair_count / 2) as i64)),
            ("clusters".to_string(), Json::int(model.affinity.clusters as i64)),
        ],
    ));
    out.push((
        "拥堵与负载".to_string(),
        format!(
            "巷道负载基尼系数 {}，拥堵代理延误 {} 秒/天；算法在\"就近存放\"与\"热点分散\"之间做了显式取舍（不是把所有热门商品塞进同一条巷道）",
            round(state.aisle_gini(), 3),
            round(state.congestion_seconds(model), 1)
        ),
        vec![
            ("gini".to_string(), Json::Float(round(state.aisle_gini(), 4))),
            (
                "congestionSecondsPerDay".to_string(),
                Json::Float(round(state.congestion_seconds(model), 2)),
            ),
        ],
    ));
    out.push((
        "搬迁代价".to_string(),
        format!(
            "本次调整涉及 {} 个货物单元、约 {} 小时设备工时；建议库位与需要执行的搬迁任务在结果里分开列出",
            state.relocation_count,
            round(state.relocation_seconds / 3600.0, 2)
        ),
        vec![
            ("relocationCount".to_string(), Json::int(state.relocation_count as i64)),
            (
                "relocationDeviceSeconds".to_string(),
                Json::Float(round(state.relocation_seconds, 1)),
            ),
        ],
    ));
    if let Some(reason) = infeasibility {
        out.push((
            "容量与不可行性".to_string(),
            reason.to_string(),
            vec![
                (
                    "locations".to_string(),
                    Json::int(model.placeable.len() as i64),
                ),
                (
                    "loadUnits".to_string(),
                    Json::int(model.lu_sku.len() as i64),
                ),
            ],
        ));
    }
    out
}

/// 不可行性证明：只承认可复述的数学事实（容量下界 / 单件不可行）。
pub fn prove_infeasibility(model: &SlottingModel) -> Option<String> {
    if model.placeable.len() < model.lu_sku.len() {
        return Some(format!(
            "可用库位 {} 个 < 货物单元 {} 个（容量下界证明）",
            model.placeable.len(),
            model.lu_sku.len()
        ));
    }
    for lu in 0..model.lu_sku.len() {
        let mut any = false;
        let step = (model.placeable.len() / 2000).max(1);
        for index in model.placeable.iter().step_by(step) {
            let sku = model.lu_sku[lu];
            if model.sku_weight[sku] > model.loc_max_weight[*index] + 1e-9 {
                continue;
            }
            if model.sku_volume[sku] > model.loc_max_volume[*index] + 1e-9 {
                continue;
            }
            any = true;
            break;
        }
        if !any {
            return Some(format!(
                "货物单元 {}（SKU {}）在全库找不到满足重量/体积限制的库位（单件不可行证明）",
                model.problem.inventory[lu].id, model.problem.inventory[lu].sku_id
            ));
        }
    }
    None
}

/// 求解选项（CLI / 实验室的共同入口）。
#[derive(Debug, Clone)]
pub struct SlottingSolveOptions {
    pub algorithm: Option<String>,
    pub seed: Option<u64>,
    pub budget_ms: Option<f64>,
    pub max_iterations: Option<u64>,
    pub verify: bool,
    /// 覆盖算法参数时的额外覆盖（实验室滑杆）。
    pub temperature: Option<f64>,
    pub tabu_tenure: Option<u64>,
    pub seeds: Vec<u64>,
}

/// 默认值：**核验默认开启**（"交付一个没人复核过的方案"不是默认行为）。
impl Default for SlottingSolveOptions {
    fn default() -> SlottingSolveOptions {
        SlottingSolveOptions {
            algorithm: None,
            seed: None,
            budget_ms: None,
            max_iterations: None,
            verify: true,
            temperature: None,
            tabu_tenure: None,
            seeds: Vec::new(),
        }
    }
}

pub fn options_from_json(root: &Json) -> SlottingSolveOptions {
    SlottingSolveOptions {
        algorithm: crate::contract::opt_str(root, "algorithm"),
        seed: crate::contract::opt_i64(root, "seed").map(|v| v.max(0) as u64),
        budget_ms: crate::contract::opt_f64(root, "budget_ms"),
        max_iterations: crate::contract::opt_i64(root, "maxIterations").map(|v| v.max(1) as u64),
        verify: crate::contract::opt_bool(root, "verify").unwrap_or(true),
        temperature: crate::contract::opt_f64(root, "temperature"),
        tabu_tenure: crate::contract::opt_i64(root, "tabuTenure").map(|v| v.max(0) as u64),
        seeds: crate::contract::num_array(root, "seeds")
            .into_iter()
            .map(|v| v.max(0.0) as u64)
            .collect(),
    }
}

/// 求解结果（保持纯数据，序列化由 `engine` 负责）。
#[derive(Debug, Clone)]
pub struct SlottingOutcome {
    pub status: crate::errors::Status,
    pub budget_exceeded: bool,
    pub optimality_proven: bool,
    pub algorithm: String,
    pub seed: u64,
    pub assignment: Vec<(String, String, String, f64)>, // (loadUnitId, skuId, locationId, quantity)
    pub unassigned: Vec<(String, String, String)>,
    pub migrations: Vec<MigrationAction>,
    pub metrics: SlottingMetrics,
    pub objectives: Vec<ObjectiveValue>,
    pub explanations: Vec<Explanation>,
    pub pareto: Vec<BTreeMap<String, f64>>,
    pub search: SearchSummary,
    pub issues: Issues,
    /// 与"当前布局 / 随机布局"的对照矩阵（实验室与报告都靠它回答"到底改进了多少"）。
    pub comparison: Json,
    /// 供联合优化直接复用（避免重复建模型）。
    pub assignment_map: Vec<i64>,
    /// SKU → 关联簇编号（-1 = 未成簇）。三维里的"关联簇叠加"直接读它，
    /// 而不是让前端自己按订单再聚一次类（聚类口径必须只有一个来源）。
    pub cluster_of_sku: Vec<(String, i64)>,
}

#[derive(Debug, Clone, Default)]
pub struct SearchSummary {
    pub iterations: u64,
    pub restarts: u64,
    pub best_iteration: u64,
    pub trace: Vec<f64>,
    pub operators_used: BTreeMap<String, u64>,
    pub elapsed_ms: f64,
    pub cancelled: bool,
    pub robust_mean: Option<f64>,
    pub robust_worst: Option<f64>,
    pub robust_cvar: Option<f64>,
}

/// 生成随机初始解（随机储位策略的真实实现；也是所有高级算法的对照基线之一）。
pub fn seed_random_assignment(model: &SlottingModel, seed: u64) -> Vec<i64> {
    let mut rng = Rng::new(seed_from(&["seed-assignment", &seed.to_string()]));
    let mut assignment = vec![-1i64; model.lu_sku.len()];
    let mut occupied = vec![false; model.locations.len()];
    let mut order: Vec<usize> = (0..model.lu_sku.len()).collect();
    // A 类优先取位（热门商品先入场，符合随机策略的真实语义）
    order.sort_by_key(|lu| {
        if model.skus[model.lu_sku[*lu]].abc == 'A' {
            0
        } else {
            1
        }
    });
    for lu in order {
        for _ in 0..12 {
            if model.placeable.is_empty() {
                break;
            }
            let index = model.placeable[rng.below(model.placeable.len())];
            if occupied[index] {
                continue;
            }
            if can_place(model, lu, index).is_err() {
                continue;
            }
            assignment[lu] = index as i64;
            occupied[index] = true;
            break;
        }
    }
    assignment
}

/// 汇总一句话（CLI / 面板共用）。
pub fn summarize(outcome: &SlottingOutcome) -> String {
    let tasks = outcome
        .migrations
        .iter()
        .filter(|m| m.mode == "task")
        .count();
    format!(
        "{} · {} · 利用率 {:.1}% · 出库均时 {:.1}s · 搬迁 {} 件 · 耗时 {:.0}ms",
        outcome.algorithm,
        outcome.status.as_str(),
        outcome.metrics.space_utilization * 100.0,
        outcome.metrics.expected_pick_seconds,
        tasks,
        outcome.metrics.compute_ms
    )
}

/// 预算 / 取消检查的统一助手（所有搜索循环共用）。
pub fn budget_exceeded(started_ms: f64, budget_ms: f64) -> bool {
    crate::engine::now_ms() - started_ms >= budget_ms * 0.98
}

/// 多随机种子稳定性评价（SRS §6.3）。
pub fn stability_of(values: &[f64]) -> Option<f64> {
    if values.len() < 2 {
        return None;
    }
    let m = mean(values);
    if m.abs() < 1e-9 {
        return Some(0.0);
    }
    Some(round(stddev(values) / m.abs(), 4))
}

/// 极差（用于面板展示"不同种子下方案的波动区间"）。
pub fn spread(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let max = values.iter().copied().fold(f64::MIN, f64::max);
    let min = values.iter().copied().fold(f64::MAX, f64::min);
    round(max - min, 4)
}

/// 供 robust 优化使用的风险度量包装。
pub fn risk_measure(values: &[f64], measure: &str, alpha: f64) -> f64 {
    match measure {
        "minimax" => values.iter().copied().fold(f64::MIN, f64::max),
        "cvar" => cvar(values, alpha),
        _ => mean(values),
    }
}

/// 契约语义校验（求解前调用；失败即 INVALID_INPUT，绝不带坏数据继续算）。
pub fn validate_problem(problem: &SlottingProblem, issues: &mut Issues) {
    crate::contract::validate_topology(&problem.topology, "problem.topology", issues);
    if problem.inventory.is_empty() && problem.skus.is_empty() {
        issues.error(
            codes::EMPTY_INPUT,
            "problem.inventory",
            "问题既没有商品也没有库存",
        );
    }
    if problem.objectives.is_empty() {
        issues.error(
            codes::MISSING_FIELD,
            "problem.objectives",
            "至少需要一个优化目标",
        );
    }
    for objective in &problem.objectives {
        if objective.weight < 0.0 {
            issues.error(
                codes::VALUE_RANGE,
                format!("problem.objectives.{}", objective.id),
                "权重不能为负",
            );
        }
        if !matches!(objective.direction.as_str(), "min" | "max") {
            issues.error(
                codes::VALUE_RANGE,
                format!("problem.objectives.{}.direction", objective.id),
                "direction 只能是 min / max",
            );
        }
        if objective.unit.is_empty() {
            issues.warn(
                codes::SCHEMA_INVALID,
                format!("problem.objectives.{}", objective.id),
                "未声明单位：不同量纲的目标相加会让结果失去意义（建议显式声明 unit）",
            );
        }
    }
    if problem.constraints.max_aisle_share_per_sku > 1.0
        || problem.constraints.max_aisle_share_per_sku <= 0.0
    {
        issues.error(
            codes::VALUE_RANGE,
            "problem.constraints.dispersion.maxAisleSharePerSku",
            "必须是 (0,1] 之间的比例",
        );
    }
}

/// 未使用但保留给联合优化的辅助：把解展开成 (loadUnitId → locationId)。
pub fn assignment_map(model: &SlottingModel, state: &SlottingState) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (lu, loc) in state.loc_of_lu.iter().enumerate() {
        if *loc < 0 {
            continue;
        }
        out.insert(
            model.problem.inventory[lu].id.clone(),
            model.locations[*loc as usize].id.clone(),
        );
    }
    out
}
