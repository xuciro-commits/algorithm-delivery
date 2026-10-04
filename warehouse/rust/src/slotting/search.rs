//! 高级求解器：ALNS / 禁忌搜索 / 模拟退火 / 遗传算法 + 小规模精确解（用于"最优性可证明"）。
//!
//! ## 设计要点（SRS §3.2B / §6）
//! 1. **增量目标**：每次移动维护运行时间、巷道负载、提升机负载、迁移代价，评估代价 O(巷道数)。
//! 2. **预算与取消**：每轮检查 `budget_ms` 与取消标志；超时返回**当前最好可行解**，
//!    状态是 BUDGET_EXCEEDED —— 绝不把"超时"报成"无解"。
//! 3. **算子统计**：破坏/修复算子的使用次数与命中次数全部记录，面板能解释"搜索到底做了什么"。
//! 4. **不做假的收敛**：trace 记录真实的最优值轨迹；没有提升就是平的。

use std::collections::BTreeMap;

use crate::contract::SlottingProblem;
use crate::errors::{codes, Issue, Issues, Status};
use crate::slotting::multiobj;
use crate::slotting::strategies;
use aps_engine::json::Json;

use crate::slotting::{
    build_metrics, build_migrations, build_model, can_place, evaluate, explain,
    prove_infeasibility, risk_measure, seed_random_assignment, stability_of, validate_problem,
    CostConfig, ObjectiveValue, SearchSummary, SlottingModel, SlottingOutcome,
    SlottingSolveOptions, SlottingState,
};
use crate::util::{mean, percentile, round, seed_from, Rng};

/* ------------------------------------------------------------------ *
 * 目标权重（把契约里的多目标翻译成搜索可以直接用的加权形式）
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Default)]
pub struct Weights {
    pub time: f64,
    pub meters: f64,
    pub congestion: f64,
    pub balance: f64,
    pub relocation_count: f64,
    pub relocation_cost: f64,
    pub utilization: f64,
    pub timeliness: f64,
    pub energy: f64,
    pub unassigned: f64,
}

pub fn weights_of(problem: &SlottingProblem) -> Weights {
    let mut w = Weights {
        unassigned: 0.0,
        ..Default::default()
    };
    for objective in &problem.objectives {
        let reference = objective
            .normalizer
            .unwrap_or_else(|| crate::slotting::default_normalizer(&objective.id));
        let scale = if reference > 0.0 {
            1.0 / reference
        } else {
            1.0
        };
        let sign = if objective.direction == "min" {
            1.0
        } else {
            -1.0
        };
        let value = objective.weight * scale * sign;
        match objective.id.as_str() {
            "expected-travel-time" => w.time += value,
            "device-travel-distance" => w.meters += value,
            "congestion" => w.congestion += value,
            "load-balance" => w.balance += value,
            "relocation-count" => w.relocation_count += value,
            "relocation-cost" => w.relocation_cost += value,
            "space-utilization" => w.utilization += value,
            "delivery-timeliness" => w.timeliness += value,
            "energy" => w.energy += value,
            _ => {}
        }
    }
    // 未分配永远是硬惩罚：任何一个"降低代价"的解都不允许靠少放货来作弊
    w.unassigned = 1e3;
    w
}

/// 单条巷道的拥堵延误（秒/天）。与 `SlottingState::congestion_seconds` 同一公式。
pub fn aisle_congestion(flow: f64, capacity: f64, service_s: f64, scale: f64) -> f64 {
    if capacity <= 0.0 || flow <= 0.0 {
        return 0.0;
    }
    let demand = flow * service_s;
    let rho = (demand / capacity).clamp(0.0, 0.97);
    if rho <= 0.01 {
        return 0.0;
    }
    scale * (rho / (1.0 - rho)) * demand
}

/// 搜索用快速目标：只包含可增量维护的分量（O(巷道数 + 提升机数)）。
///
/// `delivery-timeliness` 与 `space-utilization` 的精确值在最终评估里给出：
/// 前者依赖全局拥堵系数（每步都在变），后者只取决于是否放完 —— 搜索里用未分配惩罚代替。
pub fn fast_scalar(model: &SlottingModel, state: &SlottingState, w: &Weights) -> f64 {
    let mut value = 0.0;
    if w.time != 0.0 {
        value += w.time * state.base_seconds * state.congestion_factor(model);
    }
    if w.meters != 0.0 {
        value += w.meters * state.base_meters;
    }
    if w.energy != 0.0 {
        value += w.energy * state.base_meters / 1000.0 * 0.0016;
    }
    if w.congestion != 0.0 {
        value += w.congestion * state.congestion_seconds(model);
    }
    if w.balance != 0.0 {
        value += w.balance * state.aisle_gini();
    }
    if w.relocation_count != 0.0 {
        value += w.relocation_count * state.relocation_count as f64;
    }
    if w.relocation_cost != 0.0 {
        value += w.relocation_cost * state.relocation_seconds;
    }
    if w.utilization != 0.0 {
        let assigned = model.lu_sku.len().saturating_sub(state.unassigned) as f64;
        value += w.utilization * (assigned / model.available.len().max(1) as f64);
    }
    value + w.unassigned * state.unassigned as f64
}

/// 入库/出库加权运行时间的增量（秒/件）。
pub fn weighted_seconds(model: &SlottingModel, loc: usize) -> f64 {
    model.cost_config.outbound_share * model.costs[loc].pick_seconds
        + (1.0 - model.cost_config.outbound_share) * model.costs[loc].put_seconds
}

/* ------------------------------------------------------------------ *
 * 移动算子
 * ------------------------------------------------------------------ */

/// 破坏算子（把货物单元从库里摘出来，形成"修复池"）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Destroy {
    Random,
    Worst,
    Related,
    Cluster,
    Aisle,
    Wasteful,
}

pub const DESTROY_OPS: &[(Destroy, &str)] = &[
    (Destroy::Random, "随机移除"),
    (Destroy::Worst, "最差移除（代价最高的库位）"),
    (Destroy::Related, "关联移除（同关联簇一起取出）"),
    (Destroy::Cluster, "整簇移除（同 SKU/关联簇全部取出）"),
    (Destroy::Aisle, "巷道移除（取出最忙巷道的一段）"),
    (Destroy::Wasteful, "低效移除（流量小却占好库位）"),
];

/// 修复算子。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Repair {
    Greedy,
    Regret2,
    Affinity,
    Sampled,
}

pub const REPAIR_OPS: &[(Repair, &str)] = &[
    (Repair::Greedy, "贪心最优插入"),
    (Repair::Regret2, "后悔值插入（regret-2）"),
    (Repair::Affinity, "关联插入（靠近已放好的搭档）"),
    (Repair::Sampled, "采样插入（大场景快速路径）"),
];

pub fn destroy_name(op: Destroy) -> &'static str {
    DESTROY_OPS
        .iter()
        .find(|(candidate, _)| *candidate == op)
        .map(|(_, name)| *name)
        .unwrap_or("未知破坏算子")
}

pub fn repair_name(op: Repair) -> &'static str {
    REPAIR_OPS
        .iter()
        .find(|(candidate, _)| *candidate == op)
        .map(|(_, name)| *name)
        .unwrap_or("未知修复算子")
}

/// 破坏：返回被摘出的货物单元列表（同时已从状态中摘除）。
fn destroy(
    model: &mut SlottingModel,
    state: &mut SlottingState,
    rng: &mut Rng,
    op: Destroy,
    degree: usize,
) -> Vec<usize> {
    let assigned: Vec<usize> = (0..state.loc_of_lu.len())
        .filter(|lu| state.loc_of_lu[*lu] >= 0)
        .collect();
    if assigned.is_empty() {
        return Vec::new();
    }
    let degree = degree.max(1).min(assigned.len());
    let mut pool: Vec<usize> = match op {
        Destroy::Random => {
            let mut list = assigned.clone();
            // Fisher–Yates（确定性种子，可复现）
            for i in (1..list.len()).rev() {
                let j = rng.below(i + 1);
                list.swap(i, j);
            }
            list.truncate(degree);
            list
        }
        Destroy::Worst => {
            let mut scored: Vec<(f64, usize)> = assigned
                .iter()
                .map(|lu| {
                    let loc = state.loc_of_lu[*lu] as usize;
                    // 移除收益 = 该库位对目标的贡献（越高越该重排）
                    (model.unit_flow[*lu] * weighted_seconds(model, loc), *lu)
                })
                .collect();
            scored.sort_by(|a, b| {
                b.0.partial_cmp(&a.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.1.cmp(&b.1))
            });
            scored.truncate(degree);
            scored.into_iter().map(|(_, lu)| lu).collect()
        }
        Destroy::Related => {
            let seed = assigned[rng.below(assigned.len())];
            let sku = model.lu_sku[seed];
            let partners: Vec<usize> = model.affinity.pairs[sku].iter().map(|p| p.0).collect();
            let mut list = vec![seed];
            for lu in assigned.iter() {
                if list.len() >= degree {
                    break;
                }
                if partners.contains(&model.lu_sku[*lu]) && *lu != seed {
                    list.push(*lu);
                }
            }
            list
        }
        Destroy::Cluster => {
            let seed = assigned[rng.below(assigned.len())];
            let cluster = model.affinity.cluster_of[model.lu_sku[seed]];
            let mut list = Vec::new();
            for lu in assigned.iter() {
                if list.len() >= degree.max(8) {
                    break;
                }
                let same = cluster >= 0 && model.affinity.cluster_of[model.lu_sku[*lu]] == cluster;
                if same {
                    list.push(*lu);
                }
            }
            if list.is_empty() {
                list.push(seed);
            }
            list
        }
        Destroy::Aisle => {
            let aisle = (0..state.aisle_flow.len())
                .max_by(|a, b| {
                    state.aisle_flow[*a]
                        .partial_cmp(&state.aisle_flow[*b])
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then_with(|| b.cmp(a))
                })
                .unwrap_or(0);
            let mut list: Vec<usize> = assigned
                .iter()
                .copied()
                .filter(|lu| model.costs[state.loc_of_lu[*lu] as usize].aisle_index == aisle)
                .collect();
            if list.is_empty() {
                list = assigned.clone();
            }
            if list.len() > degree {
                let mut picked: Vec<usize> = Vec::with_capacity(degree);
                for index in 0..degree {
                    let pick = rng.below(list.len() - index.min(list.len() - 1));
                    picked.push(list.swap_remove(pick));
                }
                list = picked;
            }
            list
        }
        Destroy::Wasteful => {
            let mut scored: Vec<f64> = Vec::with_capacity(assigned.len());
            for lu in assigned.iter() {
                let loc = state.loc_of_lu[*lu] as usize;
                let cost = weighted_seconds(model, loc).max(0.001);
                scored.push(model.unit_flow[*lu] / cost);
            }
            let cut = percentile(&scored, 0.25);
            let mut list: Vec<usize> = assigned
                .iter()
                .enumerate()
                .filter(|(index, _)| scored[*index] <= cut)
                .map(|(_, lu)| *lu)
                .collect();
            if list.len() > degree {
                list.truncate(degree);
            }
            list
        }
    };
    pool.sort_unstable();
    pool.dedup();
    for lu in pool.iter() {
        state.unplace(model, *lu);
    }
    pool
}

/// 候选插入位置：从按代价排序的库位表里取前 `head` 个空闲候选 + 随机采样 `sample` 个。
fn candidate_locations(
    model: &SlottingModel,
    state: &SlottingState,
    rng: &mut Rng,
    head: usize,
    sample: usize,
) -> Vec<usize> {
    let mut candidates: Vec<usize> = Vec::with_capacity(head + sample);
    let mut taken = 0usize;
    for index in model.order_by_cost.iter().copied() {
        if state.lu_at_loc[index] >= 0 {
            continue;
        }
        candidates.push(index);
        taken += 1;
        if taken >= head {
            break;
        }
    }
    if sample > 0 && !model.placeable.is_empty() {
        for _ in 0..sample {
            let index = model.placeable[rng.below(model.placeable.len())];
            if state.lu_at_loc[index] >= 0 {
                continue;
            }
            candidates.push(index);
        }
    }
    candidates.sort_unstable();
    candidates.dedup();
    candidates
}

/// 插入代价（不含全局项）：流量 × 加权时间 + 该巷道的拥堵增量。
fn insertion_cost(model: &SlottingModel, state: &SlottingState, lu: usize, loc: usize) -> f64 {
    let flow = model.unit_flow[lu];
    let time = flow * weighted_seconds(model, loc);
    let cost = &model.costs[loc];
    let capacity = model
        .aisle_capacity
        .get(cost.aisle_index)
        .copied()
        .unwrap_or(0.0);
    let before = state.aisle_flow[cost.aisle_index];
    let after = before + flow;
    let delta = aisle_congestion(
        after,
        capacity,
        model.cost_config.aisle_service_seconds,
        model.cost_config.congestion_scale,
    ) - aisle_congestion(
        before,
        capacity,
        model.cost_config.aisle_service_seconds,
        model.cost_config.congestion_scale,
    );
    let mut value = time + delta;
    if cost.uses_lift {
        let lift_capacity = model.lift_capacity[cost.lift_group];
        let lift_before = state.lift_flow[cost.lift_group];
        let lift_delta = aisle_congestion(
            lift_before + flow,
            lift_capacity,
            model.cost_config.lift_service_seconds,
            model.cost_config.congestion_scale,
        ) - aisle_congestion(
            lift_before,
            lift_capacity,
            model.cost_config.lift_service_seconds,
            model.cost_config.congestion_scale,
        );
        value += lift_delta;
    }
    // 搬迁代价直接进入插入决策（不会出现"建议搬到更贵的位置"）
    let current = model.current_loc[lu];
    if current != loc as i64 {
        value += model.cost_config.relocation_overhead_s * 0.05;
    }
    value
}

/// 修复：把池子里的货物单元重新放回库位。返回实际放回数量。
fn repair(
    model: &mut SlottingModel,
    state: &mut SlottingState,
    pool: &[usize],
    rng: &mut Rng,
    op: Repair,
) -> usize {
    if pool.is_empty() {
        return 0;
    }
    let mut remaining: Vec<usize> = pool.to_vec();
    let (head, sample) = match op {
        Repair::Greedy => (24, 8),
        Repair::Regret2 => (16, 4),
        Repair::Affinity => (16, 6),
        Repair::Sampled => (6, 2),
    };
    let candidates = candidate_locations(model, state, rng, head, sample);
    let mut placed = 0usize;
    let mut guard = 0usize;
    while !remaining.is_empty() && guard < pool.len() * 8 {
        guard += 1;
        let pick_index = match op {
            Repair::Greedy | Repair::Sampled => {
                // 流量大的先放（先占好位置）
                let mut best = 0usize;
                for (index, lu) in remaining.iter().enumerate() {
                    if model.unit_flow[*lu] > model.unit_flow[remaining[best]] {
                        best = index;
                    }
                }
                best
            }
            Repair::Regret2 => {
                // 后悔值最大者优先：错过最优位置损失最大的那个
                let mut best = 0usize;
                let mut best_regret = f64::MIN;
                for (index, lu) in remaining.iter().enumerate() {
                    let mut first = f64::INFINITY;
                    let mut second = f64::INFINITY;
                    for loc in candidates.iter().copied() {
                        if state.lu_at_loc[loc] >= 0 || can_place(model, *lu, loc).is_err() {
                            continue;
                        }
                        let cost = insertion_cost(model, state, *lu, loc);
                        if cost < first {
                            second = first;
                            first = cost;
                        } else if cost < second {
                            second = cost;
                        }
                    }
                    let regret = if second.is_finite() {
                        second - first
                    } else {
                        1e9
                    };
                    if regret > best_regret {
                        best_regret = regret;
                        best = index;
                    }
                }
                best
            }
            Repair::Affinity => {
                // 优先处理"搭档已就位"的货物单元，让关联商品真正靠在一起
                let mut best = 0usize;
                let mut best_score = f64::MIN;
                for (index, lu) in remaining.iter().enumerate() {
                    let sku = model.lu_sku[*lu];
                    let mut score = 0.0;
                    for (mate, weight, _) in &model.affinity.pairs[sku] {
                        // 搭档是否已经放在库里？它离最近候选有多远？
                        let mut best_mate_bay = None;
                        for (other_lu, loc) in state.loc_of_lu.iter().enumerate() {
                            if *loc < 0 || model.lu_sku[other_lu] != *mate {
                                continue;
                            }
                            best_mate_bay =
                                Some((*loc as usize, model.locations[*loc as usize].bay));
                            break;
                        }
                        if let Some((mate_loc, mate_bay)) = best_mate_bay {
                            let same_aisle = model.costs[mate_loc].aisle_index;
                            let near = candidates
                                .iter()
                                .copied()
                                .filter(|loc| {
                                    state.lu_at_loc[*loc] < 0
                                        && can_place(model, *lu, *loc).is_ok()
                                        && model.costs[*loc].aisle_index == same_aisle
                                })
                                .map(|loc| (model.locations[loc].bay - mate_bay).abs() as f64)
                                .fold(f64::INFINITY, f64::min);
                            if near.is_finite() {
                                score += weight / (1.0 + near);
                            }
                        }
                    }
                    score += model.unit_flow[*lu] * 1e-6;
                    if score > best_score {
                        best_score = score;
                        best = index;
                    }
                }
                best
            }
        };
        let lu = remaining.swap_remove(pick_index);
        let mut chosen: Option<(f64, usize)> = None;
        for loc in candidates.iter().copied() {
            if state.lu_at_loc[loc] >= 0 || can_place(model, lu, loc).is_err() {
                continue;
            }
            let cost = insertion_cost(model, state, lu, loc);
            if chosen.map(|(best, _)| cost < best).unwrap_or(true) {
                chosen = Some((cost, loc));
            }
        }
        if chosen.is_none() {
            // 候选集里没有合法位置：退化为在整库范围内找第一个可行位置（保证不丢货）
            for loc in model.order_by_cost.iter().copied() {
                if state.lu_at_loc[loc] >= 0 || can_place(model, lu, loc).is_err() {
                    continue;
                }
                chosen = Some((insertion_cost(model, state, lu, loc), loc));
                break;
            }
        }
        if let Some((_, loc)) = chosen {
            state.place(model, lu, loc);
            placed += 1;
        } else {
            // 真的放不回去（容量/约束收紧）：保持未分配，由状态如实报告
            state.unassigned += 1;
        }
    }
    placed
}

/* ------------------------------------------------------------------ *
 * 移动（局部搜索用）
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy)]
pub enum Move {
    /// 交换两个货物单元的位置（含与空位交换）。
    Swap(usize, usize),
    /// 把某个货物单元移到某库位（可能触发交换）。
    Relocate(usize, usize),
}

fn random_move(model: &SlottingModel, state: &SlottingState, rng: &mut Rng) -> Option<Move> {
    let assigned: Vec<usize> = (0..state.loc_of_lu.len())
        .filter(|lu| state.loc_of_lu[*lu] >= 0)
        .collect();
    if assigned.is_empty() {
        return None;
    }
    match rng.below(10) {
        0..=6 => {
            if assigned.len() < 2 {
                return None;
            }
            let a = assigned[rng.below(assigned.len())];
            let b = assigned[rng.below(assigned.len())];
            if a == b {
                return None;
            }
            Some(Move::Swap(a, b))
        }
        _ => {
            let a = assigned[rng.below(assigned.len())];
            let mut loc = model.placeable[rng.below(model.placeable.len())];
            let mut attempts = 0;
            while can_place(model, a, loc).is_err() && attempts < 16 {
                loc = model.placeable[rng.below(model.placeable.len())];
                attempts += 1;
            }
            if can_place(model, a, loc).is_err() {
                return None;
            }
            Some(Move::Relocate(a, loc))
        }
    }
}

fn apply_move(model: &mut SlottingModel, state: &mut SlottingState, mov: Move) {
    match mov {
        Move::Swap(a, b) => state.swap(model, a, b),
        Move::Relocate(lu, loc) => state.move_to(model, lu, loc),
    }
}

/// 移动是否合法（硬约束必须在移动前判定，绝不"先破坏再修"）。
fn legal_move(model: &SlottingModel, state: &SlottingState, mov: Move) -> bool {
    match mov {
        Move::Swap(a, b) => {
            let (la, lb) = (state.loc_of_lu[a], state.loc_of_lu[b]);
            if la < 0 || lb < 0 {
                return false;
            }
            can_place(model, a, lb as usize).is_ok() && can_place(model, b, la as usize).is_ok()
        }
        Move::Relocate(lu, loc) => {
            let occupant = state.lu_at_loc[loc];
            if occupant >= 0 && occupant as usize != lu {
                let from = state.loc_of_lu[lu];
                if from < 0 {
                    return false;
                }
                return can_place(model, lu, loc).is_ok()
                    && can_place(model, occupant as usize, from as usize).is_ok();
            }
            can_place(model, lu, loc).is_ok()
        }
    }
}

/* ------------------------------------------------------------------ *
 * 精确解：小规模线性分派（匈牙利算法 / JV）
 * ------------------------------------------------------------------ */

/// 小规模精确分派：行 = 货物单元，列 = 库位，代价 = 流量 × 入库/出库加权时间。
///
/// **可证明性边界**：这里证明的是"线性分派松弛"（每个库位最多放一个货物单元、
/// 忽略拥堵与搬迁项）的最优性。拥堵与搬迁属于非线性耦合项，本定理不覆盖 ——
/// 结果里如实标注 `bound` 与 `proofScope`。
pub fn exact_assignment(model: &SlottingModel, max_rows: usize) -> Option<(Vec<i64>, f64)> {
    let rows = model.lu_sku.len();
    if rows == 0 || rows > max_rows {
        return None;
    }
    let inf = 1e12f64;
    // 列 = 库位 + 每个货物单元一个"未分配"虚拟列（代价 = 硬惩罚）
    let cols = model.placeable.len() + rows;
    let mut matrix = vec![inf; rows * cols];
    for (row, lu) in (0..rows).enumerate() {
        for (column_index, loc) in model.placeable.iter().enumerate() {
            if can_place(model, lu, *loc).is_err() {
                continue;
            }
            matrix[row * cols + column_index] = model.unit_flow[lu] * weighted_seconds(model, *loc);
        }
        matrix[row * cols + model.placeable.len() + row] = 1e7; // 未分配惩罚
    }
    let assignment = jv_assignment(&matrix, rows, cols)?;
    let mut out = vec![-1i64; rows];
    let mut cost = 0.0;
    for (row, column) in assignment.iter().enumerate() {
        if *column < model.placeable.len() {
            out[row] = model.placeable[*column] as i64;
        }
        cost += matrix[row * cols + *column];
    }
    Some((out, cost))
}

/// Jonker–Volgenant 风格的 O(n·m²) 分派（矩形矩阵，允许 INF）。
fn jv_assignment(matrix: &[f64], rows: usize, cols: usize) -> Option<Vec<usize>> {
    let n = rows;
    let m = cols;
    let inf = 1e12f64;
    let mut u = vec![0.0; n + 1];
    let mut v = vec![0.0; m + 1];
    let mut p = vec![0usize; m + 1];
    let mut way = vec![0usize; m + 1];
    for i in 1..=n {
        p[0] = i;
        let mut j0 = 0usize;
        let mut minv = vec![inf; m + 1];
        let mut used = vec![false; m + 1];
        loop {
            used[j0] = true;
            let i0 = p[j0];
            let mut delta = inf;
            let mut j1 = 0usize;
            for j in 1..=m {
                if used[j] {
                    continue;
                }
                let cur = matrix[(i0 - 1) * m + (j - 1)] - u[i0] - v[j];
                if cur < minv[j] {
                    minv[j] = cur;
                    way[j] = j0;
                }
                if minv[j] < delta {
                    delta = minv[j];
                    j1 = j;
                }
            }
            if !delta.is_finite() || delta >= inf {
                return None;
            }
            for j in 0..=m {
                if used[j] {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else {
                    minv[j] -= delta;
                }
            }
            j0 = j1;
            if p[j0] == 0 {
                break;
            }
        }
        loop {
            let j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
            if j0 == 0 {
                break;
            }
        }
    }
    let mut result = vec![usize::MAX; n];
    for j in 1..=m {
        if p[j] != 0 && p[j] <= n {
            result[p[j] - 1] = j - 1;
        }
    }
    if result.iter().any(|value| *value == usize::MAX) {
        return None;
    }
    Some(result)
}

/* ------------------------------------------------------------------ *
 * 算法实现
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Default)]
pub struct SearchStats {
    pub iterations: u64,
    pub restarts: u64,
    pub best_iteration: u64,
    pub trace: Vec<f64>,
    pub operators: BTreeMap<String, u64>,
    pub operator_hits: BTreeMap<String, u64>,
    pub elapsed_ms: f64,
    pub cancelled: bool,
}

/// 搜索返回的中间结果（`run` 之外的多目标模块也复用它）。
pub struct SearchOutcomeInternal {
    pub state: SlottingState,
    pub stats: SearchStats,
    pub optimality: Option<OptimalityReport>,
    /// Pareto 前沿（仅多目标算法非空）。
    pub pareto: Vec<crate::slotting::multiobj::ParetoPoint>,
    pub status: Status,
}

#[derive(Debug, Clone, Default)]
pub struct OptimalityReport {
    pub proven: bool,
    pub scope: String,
    pub bound: Option<f64>,
    pub gap: Option<f64>,
    pub method: String,
}

/// 搜索预算（迭代数 + 自适应停止）。
struct Budget {
    max_iterations: u64,
    deadline_ms: f64,
    no_improve_limit: u64,
}

impl Budget {
    fn exhausted(&self, iteration: u64, best_iteration: u64) -> bool {
        crate::engine::now_ms() > self.deadline_ms
            || crate::engine::cancel_requested()
            || iteration >= self.max_iterations
            || iteration.saturating_sub(best_iteration) > self.no_improve_limit
    }
}

/// 主入口：按算法名执行求解，返回可以直接序列化的结果。
pub fn run(problem: &SlottingProblem, options: &SlottingSolveOptions) -> SlottingOutcome {
    let mut issues = Issues::new();
    // 动态事件必须先落到问题上（需求/库存/可用性变化），再求解 —— 顺序反了就是自欺。
    let mut owned_problem: Option<SlottingProblem> = None;
    let mut applied_events: Vec<crate::slotting::dynamic::AppliedEvent> = Vec::new();
    if !problem.events.is_empty() {
        let mut clone = problem.clone();
        applied_events = crate::slotting::dynamic::apply_events(&mut clone, &problem.events);
        owned_problem = Some(clone);
    }
    let problem: &SlottingProblem = owned_problem.as_ref().unwrap_or(problem);
    validate_problem(problem, &mut issues);
    // 兼容旧别名：历史上把"关联性储位 + ALNS"写成 affinity-lns
    let algorithm = match options
        .algorithm
        .clone()
        .unwrap_or_else(|| problem.algorithm.algorithm.clone())
        .as_str()
    {
        "affinity-lns" | "affinity" => "alns".to_string(),
        other => other.to_string(),
    };
    if !strategies::ALGORITHMS.contains(&algorithm.as_str()) {
        issues.error(
            codes::UNSUPPORTED_FEATURE,
            "algorithm",
            format!("不支持的算法：{algorithm}"),
        );
    }
    if issues.has_errors() {
        return failed_outcome(algorithm, Status::InvalidInput, issues);
    }

    let cost_config = cost_config_of(problem);
    let started = crate::engine::now_ms();
    let budget_ms = options
        .budget_ms
        .unwrap_or(problem.algorithm.budget_ms)
        .max(1.0);

    // 小规模实例：先算线性分派松弛的精确解（可证明的最优性 + 最强基线）
    let exact_probe: Option<(Vec<i64>, f64)> = if problem.algorithm.exact_when_small
        && algorithm != "nsga2"
        && !strategies::is_basic(&algorithm)
    {
        let probe = build_model(problem, cost_config.clone());
        exact_assignment(&probe, problem.algorithm.exact_max_units)
    } else {
        None
    };

    let seeds = if options.seeds.is_empty() {
        let declared = if problem.algorithm.seeds.is_empty() {
            Vec::new()
        } else {
            problem.algorithm.seeds.clone()
        };
        if declared.is_empty() {
            vec![options.seed.unwrap_or(problem.algorithm.seed).max(1)]
        } else {
            declared
        }
    } else {
        options.seeds.clone()
    };

    let weights = weights_of(problem);
    let mut best: Option<(SlottingModel, SearchOutcomeInternal, u64)> = None;
    let mut per_seed: Vec<(u64, f64)> = Vec::new();
    for seed in seeds.iter().copied() {
        let mut model = build_model(problem, cost_config.clone());
        model.rng_seed = seed;
        let result = if let Some((assignment, bound)) = exact_probe.clone() {
            exact_seeded(&mut model, assignment, bound, &weights, budget_ms)
        } else {
            match algorithm.as_str() {
                "alns" => alns(&mut model, problem, options, &weights, seed, budget_ms),
                "dynamic" => crate::slotting::dynamic::dynamic(
                    &mut model,
                    problem,
                    &problem.events,
                    options,
                    &weights,
                    seed,
                    budget_ms,
                ),
                "tabu" => tabu(&mut model, problem, options, &weights, seed, budget_ms),
                "sa" => {
                    simulated_annealing(&mut model, problem, options, &weights, seed, budget_ms)
                }
                "ga" => genetic(&mut model, problem, options, &weights, seed, budget_ms),
                "nsga2" => multiobj::nsga2(&mut model, problem, options, &weights, seed, budget_ms),
                "robust" => crate::slotting::robust::robust(
                    &mut model, problem, options, &weights, seed, budget_ms,
                ),
                other => {
                    // 基础策略：确定性构造（不做任何搜索，保证与教材口径一致）
                    let (basic_model, assignment, _) =
                        strategies::solve_basic(problem, other, cost_config.clone());
                    let mut basic_model = basic_model;
                    let state = SlottingState::rebuild(&mut basic_model, &assignment);
                    SearchOutcomeInternal {
                        state,
                        stats: SearchStats::default(),
                        optimality: Some(OptimalityReport {
                            proven: false,
                            scope: "构造式基础策略：不含最优性证明，仅作为对照基线".to_string(),
                            bound: None,
                            gap: None,
                            method: strategies::describe(other).to_string(),
                        }),
                        pareto: Vec::new(),
                        status: Status::Feasible,
                    }
                }
            }
        };
        let scalar = fast_scalar(&model, &result.state, &weights);
        per_seed.push((seed, round(scalar, 6)));
        let better = best
            .as_ref()
            .map(|(best_model, best_result, _)| {
                scalar < fast_scalar(best_model, &best_result.state, &weights)
            })
            .unwrap_or(true);
        if better {
            best = Some((model, result, seed));
        }
    }
    let Some((mut model, result, seed)) = best else {
        return failed_outcome(algorithm, Status::InternalError, issues);
    };
    let SearchOutcomeInternal {
        mut state,
        stats,
        optimality,
        pareto,
        status: _,
    } = result;

    // 增量维护的搬迁代价与全量重算做一次交叉校验（不一致就按全量结果修正并留痕）
    let (count, seconds) = state.recompute_relocation(&mut model);
    if count != state.relocation_count || (seconds - state.relocation_seconds).abs() > 1e-6 {
        state.relocation_count = count;
        state.relocation_seconds = seconds;
        issues.warn(
            codes::INTERNAL_INCONSISTENCY,
            "relocation",
            "增量搬迁代价与全量重算不一致，已按全量结果修正（该结果需要人工复核）",
        );
    }

    let elapsed = crate::engine::now_ms() - started;
    let objective = evaluate(&model, &state);
    let mut migrations = build_migrations(&mut model, &state);
    if !applied_events.is_empty() {
        // 每条搬迁都能回答"为什么现在要搬"：绑定触发事件
        let mut sku_of_unit: std::collections::BTreeMap<String, String> =
            std::collections::BTreeMap::new();
        for unit in &model.problem.inventory {
            sku_of_unit.insert(unit.id.clone(), unit.sku_id.clone());
        }
        crate::slotting::dynamic::bind_triggers(&applied_events, &mut migrations, &sku_of_unit);
        for action in migrations.iter_mut() {
            action.requires_dispatch = action.requires_dispatch && action.trigger.is_some();
        }
    }

    // 不可行性：只有能复述的证明才敢说 INFEASIBLE_PROVEN
    let infeasibility = if state.unassigned > 0 {
        prove_infeasibility(&model)
    } else {
        None
    };
    let budget_hit = crate::engine::now_ms() - started >= budget_ms * 0.98 || stats.cancelled;

    // 最优性声明必须与最终方案一致：只有"线性松弛值等于下界"时才算证明成立
    let mut optimality = optimality.unwrap_or_default();
    if optimality.proven {
        let linear = linear_relaxation_value(&model, &state);
        match optimality.bound {
            Some(bound) if (linear - bound).abs() <= 1e-6 * bound.abs().max(1.0) => {}
            Some(bound) => {
                optimality.proven = false;
                issues.info(
                    codes::BOUND_AVAILABLE,
                    "optimality",
                    format!(
                        "精确分派最优值 {:.3} 已获得，但报告的方案在线性松弛口径下为 {:.3}                         （为降低拥堵/搬迁代价做了调整），因此本方案不再声称最优；下界仍然有效",
                        bound, linear
                    ),
                );
            }
            None => optimality.proven = false,
        }
    }

    let status = if crate::engine::cancel_requested() {
        Status::Cancelled
    } else if infeasibility.is_some() {
        Status::InfeasibleProven
    } else if state.unassigned > 0 && budget_hit {
        Status::BudgetExceeded
    } else if state.unassigned > 0 {
        Status::NoSolutionFound
    } else if optimality.proven {
        Status::OptimalProven
    } else if optimality.bound.is_some() {
        Status::FeasibleWithBound
    } else {
        Status::Feasible
    };
    if state.unassigned > 0 {
        issues.warn(
            if infeasibility.is_some() {
                codes::INFEASIBLE
            } else {
                codes::NO_SOLUTION
            },
            "assignment",
            format!(
                "{} 个货物单元没有落位{}",
                state.unassigned,
                infeasibility
                    .as_ref()
                    .map(|reason| format!("（{reason}）"))
                    .unwrap_or_default()
            ),
        );
    }
    if !matches!(status, Status::OptimalProven | Status::InfeasibleProven) {
        if let Some(bound) = optimality.bound {
            let gap = if bound.abs() > 1e-9 {
                (linear_relaxation_value(&model, &state) - bound) / bound.abs()
            } else {
                0.0
            };
            issues.info(
                codes::BOUND_AVAILABLE,
                "bound",
                format!(
                    "下界 {:.3}（{}），相对差距 {:.2}%；下界口径：{}{}",
                    round(bound, 3),
                    optimality.method,
                    round(gap * 100.0, 2),
                    optimality.scope,
                    if budget_hit {
                        "；本次为预算受限结束"
                    } else {
                        ""
                    }
                ),
            );
        }
    } else if let Some(bound) = optimality.bound {
        issues.info(
            codes::BOUND_AVAILABLE,
            "bound",
            format!(
                "最优值 {:.3}（{}）：{}",
                round(bound, 3),
                optimality.method,
                optimality.scope
            ),
        );
    }
    if budget_hit && !crate::engine::cancel_requested() {
        issues.info(
            codes::BUDGET_EXHAUSTED,
            "budget",
            "搜索预算已耗尽：返回的是预算内最好的可行解（不是无解）".to_string(),
        );
    }

    let stability = stability_of(
        &per_seed
            .iter()
            .map(|(_, value)| *value)
            .collect::<Vec<f64>>(),
    );
    let explanations = explain(&model, &state, infeasibility.as_deref());
    // 对照矩阵：同一模型、同一口径下比较"当前布局 / 随机布局 / 本次方案"。
    let comparison = comparison_json(&mut model, &state, &weights);

    let mut metrics = build_metrics(
        &model,
        &state,
        &objective,
        round(elapsed, 3),
        stability,
        per_seed.clone(),
    );
    metrics.unmet_constraints = state.unassigned;
    metrics.scale.assignments = model.lu_sku.len().saturating_sub(state.unassigned);
    metrics.scale.note = if model.lu_sku.len() > 0 {
        format!(
            "本结果来自 {} 个货物单元 × {} 个库位的实例；拥堵为排队代理模型，搬迁代价按设备运行时间计算",
            model.lu_sku.len(),
            model.locations.len()
        )
    } else {
        String::new()
    };

    let assignment: Vec<(String, String, String, f64)> = (0..model.lu_sku.len())
        .filter(|lu| state.loc_of_lu[*lu] >= 0)
        .map(|lu| {
            (
                model.problem.inventory[lu].id.clone(),
                model.problem.inventory[lu].sku_id.clone(),
                model.locations[state.loc_of_lu[lu] as usize].id.clone(),
                model.problem.inventory[lu].quantity,
            )
        })
        .collect();
    let unassigned: Vec<(String, String, String)> = (0..model.lu_sku.len())
        .filter(|lu| state.loc_of_lu[*lu] < 0)
        .map(|lu| {
            (
                model.problem.inventory[lu].id.clone(),
                model.problem.inventory[lu].sku_id.clone(),
                infeasibility
                    .clone()
                    .unwrap_or_else(|| "预算内未找到可行位置".to_string()),
            )
        })
        .collect();

    let mut summary = SearchSummary {
        iterations: stats.iterations,
        restarts: stats.restarts,
        best_iteration: stats.best_iteration,
        trace: stats.trace.clone(),
        operators_used: stats.operators.clone(),
        elapsed_ms: round(elapsed, 3),
        cancelled: stats.cancelled || crate::engine::cancel_requested(),
        robust_mean: None,
        robust_worst: None,
        robust_cvar: None,
    };
    if algorithm == "robust" {
        summary.robust_mean = Some(round(
            objective
                .values
                .get("expected-travel-time")
                .copied()
                .unwrap_or(0.0),
            3,
        ));
        summary.robust_cvar = Some(round(cvar_of_state(&model, &state), 3));
        summary.robust_worst = Some(round(
            objective
                .values
                .get("expected-travel-time")
                .copied()
                .unwrap_or(0.0)
                * state.congestion_factor(&model),
            3,
        ));
    }
    let assignment_map = state.loc_of_lu.clone();
    // 关联簇归属（按 SKU 下标对齐；未成簇记 -1）——解释与三维叠加共用同一份口径。
    let cluster_of_sku: Vec<(String, i64)> = model
        .skus
        .iter()
        .enumerate()
        .map(|(index, sku)| {
            (
                sku.id.clone(),
                model.affinity.cluster_of.get(index).copied().unwrap_or(-1),
            )
        })
        .collect();
    SlottingOutcome {
        status,
        budget_exceeded: budget_hit,
        optimality_proven: optimality.proven,
        algorithm,
        seed,
        assignment,
        unassigned,
        migrations,
        metrics,
        objectives: objective_values(&model, &objective),
        explanations,
        pareto: pareto.into_iter().map(|point| point.values).collect(),
        search: summary,
        issues,
        comparison,
        assignment_map,
        cluster_of_sku,
    }
}

/// 线性分派松弛下的方案值（与精确解同口径：忽略互斥与拥堵，未分配按 1e7 罚）。
fn linear_relaxation_value(model: &SlottingModel, state: &SlottingState) -> f64 {
    let mut total = 0.0;
    for (lu, loc) in state.loc_of_lu.iter().enumerate() {
        if *loc < 0 {
            total += 1e7;
            continue;
        }
        total += model.unit_flow[lu] * weighted_seconds(model, *loc as usize);
    }
    total
}

fn cvar_of_state(model: &SlottingModel, state: &SlottingState) -> f64 {
    // 逐货物单元运行时间视为随机变量的经验分布（用于稳健目标的报告）
    let values: Vec<f64> = (0..state.loc_of_lu.len())
        .filter(|lu| state.loc_of_lu[*lu] >= 0)
        .map(|lu| model.unit_flow[lu] * weighted_seconds(model, state.loc_of_lu[lu] as usize))
        .collect();
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values;
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let cut = ((sorted.len() as f64) * 0.9) as usize;
    mean(&sorted[cut..])
}

fn objective_values(
    model: &SlottingModel,
    objective: &crate::slotting::ObjectiveVector,
) -> Vec<ObjectiveValue> {
    model
        .problem
        .objectives
        .iter()
        .map(|spec| {
            let raw = objective.values.get(&spec.id).copied().unwrap_or(0.0);
            let reference = spec
                .normalizer
                .unwrap_or_else(|| crate::slotting::default_normalizer(&spec.id));
            let ratio = if reference > 0.0 {
                raw / reference
            } else {
                raw
            };
            ObjectiveValue {
                id: spec.id.clone(),
                direction: spec.direction.clone(),
                unit: spec.unit.clone(),
                weight: spec.weight,
                raw: round(raw, 4),
                normalized: round(
                    if spec.direction == "min" {
                        1.0 - ratio.min(1.0)
                    } else {
                        ratio.min(1.0)
                    },
                    4,
                ),
                conflicts_with: Vec::new(),
                note: spec.note.clone(),
            }
        })
        .collect()
}

fn failed_outcome(algorithm: String, status: Status, issues: Issues) -> SlottingOutcome {
    SlottingOutcome {
        status,
        budget_exceeded: false,
        optimality_proven: false,
        algorithm,
        seed: 0,
        assignment: Vec::new(),
        unassigned: Vec::new(),
        migrations: Vec::new(),
        metrics: Default::default(),
        objectives: Vec::new(),
        explanations: Vec::new(),
        pareto: Vec::new(),
        search: SearchSummary::default(),
        issues,
        comparison: Json::Null,
        assignment_map: Vec::new(),
        cluster_of_sku: Vec::new(),
    }
}

/// 成本模型来自问题（未声明时使用显式默认值）。
pub fn cost_config_of(problem: &SlottingProblem) -> CostConfig {
    let mut config = CostConfig::default();
    if let Some(share) = problem.cost_model.outbound_share {
        config.outbound_share = share.clamp(0.0, 1.0);
    }
    if let Some(seconds) = problem.cost_model.handling_seconds {
        config.handling_s = seconds.max(0.0);
    }
    if let Some(target) = problem.cost_model.aisle_utilization_target {
        config.aisle_utilization_target = target.clamp(0.05, 1.0);
    }
    if let Some(target) = problem.cost_model.lift_utilization_target {
        config.lift_utilization_target = target.clamp(0.05, 1.0);
    }
    if let Some(scale) = problem.cost_model.congestion_scale {
        config.congestion_scale = scale.max(0.0);
    }
    if let Some(threshold) = problem.cost_model.timeliness_threshold_seconds {
        config.timeliness_threshold_s = threshold.max(1.0);
    }
    config
}

/* ------------------------------------------------------------------ *
 * ALNS
 * ------------------------------------------------------------------ */

fn alns(
    model: &mut SlottingModel,
    problem: &SlottingProblem,
    options: &SlottingSolveOptions,
    weights: &Weights,
    seed: u64,
    budget_ms: f64,
) -> SearchOutcomeInternal {
    let mut rng = Rng::new(seed_from(&[
        "alns",
        &seed.to_string(),
        &problem.algorithm.algorithm,
    ]));
    let initial = greedy_seed(model, seed);
    let mut state = SlottingState::rebuild(model, &initial);
    let mut current = fast_scalar(model, &state, weights);
    let mut best_state = state.clone_state();
    let mut best_scalar = current;
    let mut stats = SearchStats::default();
    let started = crate::engine::now_ms();
    let temperature0 = options.temperature.unwrap_or(0.02);
    let max_iterations = options
        .max_iterations
        .unwrap_or(problem.algorithm.max_iterations.max(1));
    let budget = Budget {
        max_iterations,
        deadline_ms: started + budget_ms * 0.97,
        no_improve_limit: (max_iterations / 3).max(200),
    };
    let mut destroy_weights = vec![1.0f64; DESTROY_OPS.len()];
    let mut repair_weights = vec![1.0f64; REPAIR_OPS.len()];
    let segment = 40u64;
    let mut segment_scores = vec![0.0f64; DESTROY_OPS.len() + REPAIR_OPS.len()];
    let mut segment_uses = vec![0u64; DESTROY_OPS.len() + REPAIR_OPS.len()];
    let mut iteration = 0u64;
    let mut best_iteration = 0u64;
    let degree_base = ((model.lu_sku.len() as f64).sqrt() * 0.35).round().max(4.0) as usize;
    let trace_every = (max_iterations / 96).max(1);
    while !budget.exhausted(iteration, best_iteration) {
        iteration += 1;
        stats.iterations = iteration;
        let d_index = roulette(&destroy_weights, &mut rng);
        let r_index = roulette(&repair_weights, &mut rng);
        let destroy_op = DESTROY_OPS[d_index].0;
        let repair_op = REPAIR_OPS[r_index].0;
        let snapshot = state.clone_state();
        let degree = (degree_base as f64 * (0.6 + rng.next_f64() * 0.8)).round() as usize;
        let pool = destroy(model, &mut state, &mut rng, destroy_op, degree.max(1));
        let placed = repair(model, &mut state, &pool, &mut rng, repair_op);
        let candidate = fast_scalar(model, &state, weights);
        let progress = iteration as f64 / max_iterations.max(1) as f64;
        let temperature = temperature0 * (1.0 - progress).max(1e-3) * best_scalar.abs().max(1.0);
        let accept = candidate <= current
            || rng.next_f64() < ((current - candidate) / temperature.max(1e-9)).exp();
        stats
            .operators
            .entry(format!("破坏：{}", destroy_name(destroy_op)))
            .and_modify(|value| *value += 1)
            .or_insert(1);
        stats
            .operators
            .entry(format!("修复：{}", repair_name(repair_op)))
            .and_modify(|value| *value += 1)
            .or_insert(1);
        if accept {
            current = candidate;
            if candidate < best_scalar - 1e-9 {
                best_scalar = candidate;
                best_state = state.clone_state();
                best_iteration = iteration;
                segment_scores[d_index] += 33.0;
                segment_scores[DESTROY_OPS.len() + r_index] += 33.0;
            } else {
                segment_scores[d_index] += 9.0;
                segment_scores[DESTROY_OPS.len() + r_index] += 9.0;
            }
            let _ = placed;
        } else {
            state = snapshot;
            segment_scores[d_index] += 1.0;
            segment_scores[DESTROY_OPS.len() + r_index] += 1.0;
        }
        segment_uses[d_index] += 1;
        segment_uses[DESTROY_OPS.len() + r_index] += 1;
        if iteration % segment == 0 {
            for index in 0..destroy_weights.len() {
                let score = segment_scores[index] / segment_uses[index].max(1) as f64;
                destroy_weights[index] =
                    (0.8 * destroy_weights[index] + 0.2 * score.max(0.1)).max(0.05);
            }
            for index in 0..repair_weights.len() {
                let score = segment_scores[DESTROY_OPS.len() + index]
                    / segment_uses[DESTROY_OPS.len() + index].max(1) as f64;
                repair_weights[index] =
                    (0.8 * repair_weights[index] + 0.2 * score.max(0.1)).max(0.05);
            }
            segment_scores.iter_mut().for_each(|value| *value = 0.0);
            segment_uses.iter_mut().for_each(|value| *value = 0);
        }
        if iteration % trace_every == 0 {
            stats.trace.push(round(best_scalar, 6));
            if stats.trace.len() > 256 {
                stats.trace.remove(0);
            }
        }
    }
    let elapsed = crate::engine::now_ms() - started;
    let optimality = OptimalityReport {
        proven: false,
        scope: "启发式（ALNS）：不提供最优性证明，只提供线性分派松弛下界".to_string(),
        bound: None,
        gap: None,
        method: "自适应大邻域搜索".to_string(),
    };
    stats.best_iteration = best_iteration;
    stats.elapsed_ms = round(elapsed, 3);
    stats.cancelled = crate::engine::cancel_requested();
    SearchOutcomeInternal {
        state: best_state,
        stats,
        pareto: Vec::new(),
        status: Status::FeasibleWithBound,
        optimality: Some(optimality),
    }
}

/// 对外暴露的邻域算子（`robust` / `dynamic` 与 ALNS 共用同一套语义，避免口径分叉）。
pub fn random_move_public(
    model: &SlottingModel,
    state: &SlottingState,
    rng: &mut Rng,
) -> Option<Move> {
    random_move(model, state, rng)
}

pub fn legal_move_public(model: &SlottingModel, state: &SlottingState, mov: Move) -> bool {
    legal_move(model, state, mov)
}

pub fn apply_move_public(model: &mut SlottingModel, state: &mut SlottingState, mov: Move) {
    apply_move(model, state, mov)
}

/// 贪心初始解（流量优先 + 巷道分散）。
pub fn greedy_initial(model: &mut SlottingModel, seed: u64) -> Vec<i64> {
    greedy_seed(model, seed)
}

/// 把外部给的（热启动）方案补全：未落位或已失效的货物单元按贪心/随机补齐。
pub fn fill_gaps(model: &mut SlottingModel, mut assignment: Vec<i64>, seed: u64) -> Vec<i64> {
    if assignment.len() < model.lu_sku.len() {
        assignment.resize(model.lu_sku.len(), -1);
    }
    let mut occupied = vec![false; model.locations.len()];
    for lu in 0..model.lu_sku.len() {
        let loc = assignment[lu];
        if loc >= 0 {
            if can_place(model, lu, loc as usize).is_err() || occupied[loc as usize] {
                assignment[lu] = -1;
            } else {
                occupied[loc as usize] = true;
            }
        }
    }
    let fallback = greedy_seed(model, seed);
    for (lu, loc) in assignment.iter_mut().enumerate() {
        if *loc < 0 {
            *loc = fallback[lu];
        }
    }
    assignment
}

fn greedy_seed(model: &mut SlottingModel, seed: u64) -> Vec<i64> {
    let mut assignment = strategies::greedy_flow_initial(model);
    // 若贪心无法完全落位（容量/约束紧张），用随机策略补齐剩余单元
    if assignment.iter().any(|loc| *loc < 0) {
        let fallback = seed_random_assignment(model, seed ^ 0x9e37_79b9);
        for (index, loc) in assignment.iter_mut().enumerate() {
            if *loc < 0 && fallback[index] >= 0 {
                *loc = fallback[index];
            }
        }
    }
    assignment
}

fn roulette(weights: &[f64], rng: &mut Rng) -> usize {
    let total: f64 = weights.iter().sum();
    if total <= 0.0 {
        return rng.below(weights.len());
    }
    let mut pick = rng.next_f64() * total;
    for (index, weight) in weights.iter().enumerate() {
        pick -= weight;
        if pick <= 0.0 {
            return index;
        }
    }
    weights.len() - 1
}

/* ------------------------------------------------------------------ *
 * 禁忌搜索
 * ------------------------------------------------------------------ */

fn tabu(
    model: &mut SlottingModel,
    problem: &SlottingProblem,
    options: &SlottingSolveOptions,
    weights: &Weights,
    seed: u64,
    budget_ms: f64,
) -> SearchOutcomeInternal {
    let mut rng = Rng::new(seed_from(&["tabu", &seed.to_string()]));
    let initial = greedy_seed(model, seed);
    let mut state = SlottingState::rebuild(model, &initial);
    let current = fast_scalar(model, &state, weights);
    let mut best_state = state.clone_state();
    let mut best_scalar = current;
    let mut tabu_until: BTreeMap<(usize, i64), u64> = BTreeMap::new();
    let tenure = options
        .tabu_tenure
        .unwrap_or((model.lu_sku.len() as f64).sqrt() as u64)
        .max(4);
    let max_iterations = options
        .max_iterations
        .unwrap_or(problem.algorithm.max_iterations.max(1))
        .min(60_000);
    let started = crate::engine::now_ms();
    let budget = Budget {
        max_iterations,
        deadline_ms: started + budget_ms * 0.97,
        no_improve_limit: (max_iterations / 3).max(300),
    };
    let mut stats = SearchStats::default();
    let mut iteration = 0u64;
    let mut best_iteration = 0u64;
    let trace_every = (max_iterations / 96).max(1);
    let neighborhood = 12usize;
    while !budget.exhausted(iteration, best_iteration) {
        iteration += 1;
        stats.iterations = iteration;
        let mut best_move: Option<(Move, f64)> = None;
        for _ in 0..neighborhood {
            let Some(candidate_move) = random_move(model, &state, &mut rng) else {
                continue;
            };
            if !legal_move(model, &state, candidate_move) {
                continue;
            }
            let key = move_key(&state, candidate_move);
            let tabu_active = tabu_until
                .get(&key)
                .map(|until| *until > iteration)
                .unwrap_or(false);
            let snapshot = state.clone_state();
            apply_move(model, &mut state, candidate_move);
            let value = fast_scalar(model, &state, weights);
            state = snapshot;
            if tabu_active && value >= best_scalar - 1e-9 {
                continue; // 禁忌且不能特赦
            }
            if best_move
                .map(|(_, current_best)| value < current_best)
                .unwrap_or(true)
            {
                best_move = Some((candidate_move, value));
            }
        }
        let Some((chosen, value)) = best_move else {
            continue;
        };
        apply_move(model, &mut state, chosen);
        let key = move_key(&state, chosen);
        tabu_until.insert(key, iteration + tenure);
        // 反向移动同样禁忌（近似对称禁忌），避免立刻换回来
        stats
            .operators
            .entry("邻域移动（交换/再定位）".to_string())
            .and_modify(|count| *count += 1)
            .or_insert(1);
        if value < best_scalar - 1e-9 {
            best_scalar = value;
            best_state = state.clone_state();
            best_iteration = iteration;
        }
        if iteration % trace_every == 0 {
            stats.trace.push(round(best_scalar, 6));
            if stats.trace.len() > 256 {
                stats.trace.remove(0);
            }
        }
    }
    stats.best_iteration = best_iteration;
    stats.elapsed_ms = round(crate::engine::now_ms() - started, 3);
    stats.cancelled = crate::engine::cancel_requested();
    SearchOutcomeInternal {
        state: best_state,
        stats,
        pareto: Vec::new(),
        status: Status::FeasibleWithBound,
        optimality: Some(OptimalityReport {
            proven: false,
            scope: "启发式（禁忌搜索）：不提供最优性证明".to_string(),
            bound: None,
            gap: None,
            method: "禁忌搜索".to_string(),
        }),
    }
}

fn move_key(state: &SlottingState, mov: Move) -> (usize, i64) {
    match mov {
        Move::Swap(a, _) => (a, state.loc_of_lu[a]),
        Move::Relocate(lu, _) => (lu, state.loc_of_lu[lu]),
    }
}

/* ------------------------------------------------------------------ *
 * 模拟退火
 * ------------------------------------------------------------------ */

fn simulated_annealing(
    model: &mut SlottingModel,
    problem: &SlottingProblem,
    options: &SlottingSolveOptions,
    weights: &Weights,
    seed: u64,
    budget_ms: f64,
) -> SearchOutcomeInternal {
    let mut rng = Rng::new(seed_from(&["sa", &seed.to_string()]));
    let initial = greedy_seed(model, seed);
    let mut state = SlottingState::rebuild(model, &initial);
    let mut current = fast_scalar(model, &state, weights);
    let mut best_state = state.clone_state();
    let mut best_scalar = current;
    let max_iterations = options
        .max_iterations
        .unwrap_or(problem.algorithm.max_iterations.max(1))
        .min(80_000);
    let started = crate::engine::now_ms();
    let budget = Budget {
        max_iterations,
        deadline_ms: started + budget_ms * 0.97,
        no_improve_limit: (max_iterations / 3).max(500),
    };
    let temperature0 = options.temperature.unwrap_or(0.05) * current.abs().max(1.0);
    let cooling = 0.9995f64;
    let mut temperature = temperature0;
    let mut stats = SearchStats::default();
    let mut iteration = 0u64;
    let mut best_iteration = 0u64;
    let trace_every = (max_iterations / 96).max(1);
    while !budget.exhausted(iteration, best_iteration) {
        iteration += 1;
        stats.iterations = iteration;
        let Some(candidate_move) = random_move(model, &state, &mut rng) else {
            continue;
        };
        if !legal_move(model, &state, candidate_move) {
            continue;
        }
        let snapshot = state.clone_state();
        apply_move(model, &mut state, candidate_move);
        let value = fast_scalar(model, &state, weights);
        let delta = value - current;
        if delta <= 0.0 || rng.next_f64() < (-delta / temperature.max(1e-9)).exp() {
            current = value;
            if value < best_scalar - 1e-9 {
                best_scalar = value;
                best_state = state.clone_state();
                best_iteration = iteration;
            }
            if delta <= 0.0 {
                stats
                    .operators
                    .entry("改进移动".to_string())
                    .and_modify(|count| *count += 1)
                    .or_insert(1);
            } else {
                stats
                    .operators
                    .entry("劣化接受（退火跳出）".to_string())
                    .and_modify(|count| *count += 1)
                    .or_insert(1);
            }
        } else {
            state = snapshot;
        }
        temperature *= cooling;
        if temperature < 1e-6 * temperature0.max(1.0) {
            temperature = temperature0 * 0.5;
        }
        if iteration % trace_every == 0 {
            stats.trace.push(round(best_scalar, 6));
            if stats.trace.len() > 256 {
                stats.trace.remove(0);
            }
        }
    }
    stats.best_iteration = best_iteration;
    stats.elapsed_ms = round(crate::engine::now_ms() - started, 3);
    stats.cancelled = crate::engine::cancel_requested();
    SearchOutcomeInternal {
        state: best_state,
        stats,
        pareto: Vec::new(),
        status: Status::FeasibleWithBound,
        optimality: Some(OptimalityReport {
            proven: false,
            scope: "启发式（模拟退火）：不提供最优性证明".to_string(),
            bound: None,
            gap: None,
            method: "模拟退火".to_string(),
        }),
    }
}

/* ------------------------------------------------------------------ *
 * 遗传算法（排列编码 + 顺序交叉）
 * ------------------------------------------------------------------ */

fn genetic(
    model: &mut SlottingModel,
    problem: &SlottingProblem,
    options: &SlottingSolveOptions,
    weights: &Weights,
    seed: u64,
    budget_ms: f64,
) -> SearchOutcomeInternal {
    let mut rng = Rng::new(seed_from(&["ga", &seed.to_string()]));
    let n = model.lu_sku.len();
    let population_size = (options.max_iterations.unwrap_or(0) as usize)
        .max(24)
        .min(60);
    let generations = problem.algorithm.max_iterations.clamp(20, 400);
    let mut population: Vec<Vec<usize>> = Vec::with_capacity(population_size);
    let base: Vec<usize> = {
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by(|a, b| {
            model.unit_flow[*b]
                .partial_cmp(&model.unit_flow[*a])
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.cmp(b))
        });
        order
    };
    population.push(base.clone());
    while population.len() < population_size {
        let mut genome = base.clone();
        for i in (1..n).rev() {
            let j = rng.below(i + 1);
            genome.swap(i, j);
        }
        population.push(genome);
    }

    let started = crate::engine::now_ms();
    let deadline = started + budget_ms * 0.97;
    let mut stats = SearchStats::default();
    let mut best_genome = population[0].clone();
    let mut best_scalar = f64::INFINITY;
    let mut best_iteration = 0u64;
    let trace_every = (generations / 64).max(1);

    for generation in 0..generations {
        let mut scored: Vec<(f64, Vec<usize>)> = Vec::with_capacity(population.len());
        for genome in population.iter() {
            let (state, scalar) = decode(model, genome, weights);
            let _ = state;
            scored.push((scalar, genome.clone()));
        }
        scored.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        if scored[0].0 < best_scalar - 1e-9 {
            best_scalar = scored[0].0;
            best_genome = scored[0].1.clone();
            best_iteration = generation as u64;
        }
        stats.iterations = generation as u64;
        if generation % trace_every == 0 {
            stats.trace.push(round(best_scalar, 6));
            if stats.trace.len() > 256 {
                stats.trace.remove(0);
            }
        }
        if crate::engine::now_ms() > deadline || crate::engine::cancel_requested() {
            stats.cancelled = crate::engine::cancel_requested();
            break;
        }
        // 精英保留
        let mut next: Vec<Vec<usize>> = scored.iter().take(2).map(|(_, g)| g.clone()).collect();
        while next.len() < population_size {
            let parent_a = tournament(&scored, &mut rng);
            let parent_b = tournament(&scored, &mut rng);
            let mut child = order_crossover(&parent_a, &parent_b, &mut rng);
            if rng.next_f64() < 0.35 {
                let i = rng.below(n.max(1));
                let j = rng.below(n.max(1));
                child.swap(i, j);
            }
            next.push(child);
        }
        population = next;
        stats
            .operators
            .entry("遗传代数".to_string())
            .and_modify(|count| *count += 1)
            .or_insert(1);
    }

    let assignment = decode_assignment(model, &best_genome);
    let state = SlottingState::rebuild(model, &assignment);
    stats.best_iteration = best_iteration;
    stats.elapsed_ms = round(crate::engine::now_ms() - started, 3);
    SearchOutcomeInternal {
        state,
        stats,
        pareto: Vec::new(),
        status: Status::FeasibleWithBound,
        optimality: Some(OptimalityReport {
            proven: false,
            scope: "启发式（遗传算法）：不提供最优性证明".to_string(),
            bound: None,
            gap: None,
            method: "遗传算法（排列编码 + 顺序交叉）".to_string(),
        }),
    }
}

fn tournament(scored: &[(f64, Vec<usize>)], rng: &mut Rng) -> Vec<usize> {
    let mut best = rng.below(scored.len());
    for _ in 0..2 {
        let challenger = rng.below(scored.len());
        if scored[challenger].0 < scored[best].0 {
            best = challenger;
        }
    }
    scored[best].1.clone()
}

fn order_crossover(a: &[usize], b: &[usize], rng: &mut Rng) -> Vec<usize> {
    let n = a.len();
    if n < 2 {
        return a.to_vec();
    }
    let mut cut_a = rng.below(n - 1);
    let mut cut_b = rng.below(n - 1);
    if cut_a > cut_b {
        std::mem::swap(&mut cut_a, &mut cut_b);
    }
    let (lo, hi) = (cut_a, cut_b + 1);
    let mut child = vec![usize::MAX; n];
    for index in lo..=hi.min(n - 1) {
        child[index] = a[index];
    }
    let mut cursor = (hi + 1) % n;
    for offset in 0..n {
        let gene = b[(hi + 1 + offset) % n];
        if !child.contains(&gene) {
            child[cursor] = gene;
            cursor = (cursor + 1) % n;
        }
    }
    child
}

/// 解码：按基因顺序贪心落位（顺序即决策变量：先放谁，谁就占更近的位置）。
pub fn decode_assignment(model: &SlottingModel, genome: &[usize]) -> Vec<i64> {
    let mut assignment = vec![-1i64; model.lu_sku.len()];
    let mut occupied = vec![false; model.locations.len()];
    for lu in genome.iter().copied() {
        for loc in model.order_by_cost.iter().copied() {
            if occupied[loc] || can_place(model, lu, loc).is_err() {
                continue;
            }
            assignment[lu] = loc as i64;
            occupied[loc] = true;
            break;
        }
    }
    assignment
}

/// 解码 + 评价（只读路径；搬迁代价在 `rebuild` 里由同一套语义维护）。
fn decode(model: &SlottingModel, genome: &[usize], weights: &Weights) -> (SlottingState, f64) {
    let assignment = decode_assignment(model, genome);
    // 解码阶段是只读的；搬迁代价用独立通道计算，避免为了评估而污染缓存
    let mut state = SlottingState::new(model);
    for (lu, loc) in assignment.iter().enumerate() {
        if *loc < 0 {
            continue;
        }
        let cost = &model.costs[*loc as usize];
        let flow = model.unit_flow[lu];
        state.base_seconds += flow
            * (model.cost_config.outbound_share * cost.pick_seconds
                + (1.0 - model.cost_config.outbound_share) * cost.put_seconds);
        state.base_meters += flow * cost.meters;
        state.aisle_flow[cost.aisle_index] += flow;
        if cost.uses_lift {
            state.lift_flow[cost.lift_group] += flow;
        }
        state.loc_of_lu[lu] = *loc;
        state.lu_at_loc[*loc as usize] = lu as i64;
        state.unassigned = state.unassigned.saturating_sub(1);
    }
    let scalar = fast_scalar(model, &state, weights);
    (state, scalar)
}

/* ------------------------------------------------------------------ *
 * 精确解种子：证明最优 + 保持可行
 * ------------------------------------------------------------------ */

fn exact_seeded(
    model: &mut SlottingModel,
    assignment: Vec<i64>,
    bound: f64,
    weights: &Weights,
    budget_ms: f64,
) -> SearchOutcomeInternal {
    let started = crate::engine::now_ms();
    let mut state = SlottingState::rebuild(model, &assignment);
    let mut stats = SearchStats::default();
    stats
        .operators
        .insert("精确分派（匈牙利算法）".to_string(), 1);
    // 预算内做一轮确定性邻域改良（不改变已证明的分派最优性结论，仅用于拥堵/搬迁项）
    let mut improved = 0u64;
    let deadline = started + budget_ms * 0.5;
    let mut rng = Rng::new(0x5eed_5eed);
    let mut current = fast_scalar(model, &state, weights);
    while crate::engine::now_ms() < deadline && improved < 20_000 {
        improved += 1;
        let Some(candidate_move) = random_move(model, &state, &mut rng) else {
            break;
        };
        if !legal_move(model, &state, candidate_move) {
            continue;
        }
        let snapshot = state.clone_state();
        apply_move(model, &mut state, candidate_move);
        let value = fast_scalar(model, &state, weights);
        if value < current - 1e-9 {
            current = value;
        } else {
            state = snapshot;
        }
    }
    stats.iterations = improved;
    stats.best_iteration = improved;
    stats.elapsed_ms = round(crate::engine::now_ms() - started, 3);
    stats.operators.insert("邻域改良迭代".to_string(), improved);
    SearchOutcomeInternal {
        state,
        stats,
        pareto: Vec::new(),
        status: Status::OptimalProven,
        optimality: Some(OptimalityReport {
            proven: true,
            scope: "线性分派松弛（库位互斥、忽略拥堵与搬迁耦合项）上已证明最优；\
                    拥挤度与搬迁代价在结果中单独报告，不包含在可证明范围内"
                .to_string(),
            bound: Some(bound),
            gap: Some(0.0),
            method: "匈牙利算法（JV）精确分派".to_string(),
        }),
    }
}

/// 供 engine / joint 复用的风险度量包装（robust 模块与报告共用）。
pub fn risk(values: &[f64], measure: &str, alpha: f64) -> f64 {
    risk_measure(values, measure, alpha)
}

/// 供联合优化使用的公开入口：给定问题与选项，返回货物单元 → 库位下标。
pub fn assignment_map(problem: &SlottingProblem, options: &SlottingSolveOptions) -> Vec<i64> {
    run(problem, options).assignment_map
}

/// 收敛轨迹的统计描述（面板展示"提升幅度"用）。
pub fn trace_summary(trace: &[f64]) -> (f64, f64, f64) {
    if trace.is_empty() {
        return (0.0, 0.0, 0.0);
    }
    let first = trace[0];
    let last = trace[trace.len() - 1];
    let best = trace.iter().copied().fold(f64::MAX, f64::min);
    let improvement = if first.abs() > 1e-9 {
        (first - best) / first.abs()
    } else {
        0.0
    };
    (round(improvement, 4), round(last, 6), round(first, 6))
}

/// 契约声明但结果未使用的辅助：把算子说明导出给能力清单。
pub fn operator_catalog() -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = DESTROY_OPS
        .iter()
        .map(|(_, name)| ("destroy".to_string(), name.to_string()))
        .collect();
    out.extend(
        REPAIR_OPS
            .iter()
            .map(|(_, name)| ("repair".to_string(), name.to_string())),
    );
    out
}

/// 校验问题规模是否超出约定上限（供 wasm 轻量层返回 UNSUPPORTED）。
pub fn exceeds_light_limits(problem: &SlottingProblem, max_units: usize) -> Option<String> {
    if problem.inventory.len() > max_units {
        return Some(format!(
            "库存单元 {} 超过 wasm 轻量层上限 {}（请使用原生 CLI 或降低实例规模）",
            problem.inventory.len(),
            max_units
        ));
    }
    None
}

/// 供 CLI 打印用的一致性检查项（不参与求解）。
pub fn invariants(model: &SlottingModel, state: &SlottingState) -> Vec<Issue> {
    let mut issues = Vec::new();
    let assigned = state.loc_of_lu.iter().filter(|loc| **loc >= 0).count();
    let occupied = state.lu_at_loc.iter().filter(|lu| **lu >= 0).count();
    if assigned != occupied {
        issues.push(Issue::error(
            codes::INTERNAL_INCONSISTENCY,
            "state",
            format!("正向/反向索引不一致：分配 {assigned} 个，占用 {occupied} 个"),
        ));
    }
    let _ = model;
    issues
}

/* ------------------------------------------------------------------ *
 * 对照矩阵：当前布局 / 随机布局 / 本次方案
 * ------------------------------------------------------------------ */

fn comparison_point(
    model: &mut SlottingModel,
    state: &SlottingState,
    weights: &Weights,
) -> (String, Json) {
    let objective = evaluate(model, state);
    let travel = objective
        .values
        .get("expected-travel-time")
        .copied()
        .unwrap_or(0.0);
    let congestion = objective.values.get("congestion").copied().unwrap_or(0.0);
    let design = comparison_snapshot(state);
    (
        "point".to_string(),
        Json::obj(vec![
            (
                "weightedObjective",
                Json::Float(round(fast_scalar(model, state, weights), 4)),
            ),
            (
                "linearSecondsPerDay",
                Json::Float(round(linear_relaxation_value(model, state), 4)),
            ),
            ("travelSecondsPerDay", Json::Float(round(travel, 4))),
            ("congestionSecondsPerDay", Json::Float(round(congestion, 3))),
            ("relocationCount", Json::int(state.relocation_count as i64)),
            (
                "relocationDeviceSeconds",
                Json::Float(round(state.relocation_seconds, 3)),
            ),
            ("assignmentJson", design),
        ]),
    )
}

fn comparison_snapshot(state: &SlottingState) -> Json {
    // 设计态快照：只放可复算的事实（用于面板里横向比较，不放推导值）
    Json::obj(vec![
        ("unassigned", Json::int(state.unassigned as i64)),
        (
            "aisleLoads",
            Json::Arr(
                state
                    .aisle_flow
                    .iter()
                    .map(|value| Json::Float(round(*value, 3)))
                    .collect(),
            ),
        ),
    ])
}

/// 三方对照：当前布局（problem.currentAssignment）作为基线，随机布局作为下界参照，
/// 本次方案作为结果。全部用同一套目标函数与同一套库位成本重算，不用任何"历史报告值"。
fn comparison_json(model: &mut SlottingModel, state: &SlottingState, weights: &Weights) -> Json {
    let mut rows: Vec<(String, Json)> = Vec::new();
    // 1) 当前布局
    let current_assignment = model.current_loc.clone();
    let mut current_state = SlottingState::rebuild(model, &current_assignment);
    current_state.recompute_relocation(model);
    let (_, current_point) = comparison_point(model, &current_state, weights);
    rows.push(("currentLayout".to_string(), current_point));
    // 2) 随机布局（同种子固定，保证可比）
    let random_assignment = seed_random_assignment(model, 20_250_901);
    let mut random_state = SlottingState::rebuild(model, &random_assignment);
    random_state.recompute_relocation(model);
    let (_, random_point) = comparison_point(model, &random_state, weights);
    rows.push(("randomLayout".to_string(), random_point));
    // 3) 本次方案
    let (_, optimized_point) = comparison_point(model, state, weights);
    rows.push(("optimized".to_string(), optimized_point));
    let current_value = fast_scalar(model, &current_state, weights);
    let random_value = fast_scalar(model, &random_state, weights);
    let optimized_value = fast_scalar(model, state, weights);
    let improvement = |baseline: f64| -> f64 {
        if baseline.abs() < 1e-9 {
            0.0
        } else {
            round((baseline - optimized_value) / baseline.abs() * 100.0, 3)
        }
    };
    Json::obj(vec![
        ("baselines", Json::Obj(rows)),
        (
            "improvementPercent",
            Json::obj(vec![
                ("vsCurrentLayout", Json::Float(improvement(current_value))),
                ("vsRandomLayout", Json::Float(improvement(random_value))),
            ]),
        ),
        (
            "notes",
            Json::strings(vec![
                "三方对照使用同一目标函数与同一库位成本重算（当前布局取自问题里的 currentAssignment）".to_string(),
                "随机布局固定随机种子，保证不同算法可比；它不是下界，只是参照".to_string(),
                "搬迁代价按设备运行时间计算，已计入方案值".to_string(),
            ]),
        ),
    ])
}
