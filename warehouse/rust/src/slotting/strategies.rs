//! 基础储位策略：每一条都能与运筹学教材 / 行业实践对上，且都能作为高级算法的对照基线。
//!
//! 所有策略共享同一套落位原语（`place_sequence`），因此"基础策略 vs ALNS"的差异只来自
//! 决策规则本身，而不是实现细节 —— 这是做 A/B 对比的前提。
//!
//! 策略清单（SRS §3.2A）：
//! `random` 随机储位 · `fixed` 固定储位 · `nearest-available` 最近可用 ·
//! `abc-class` ABC 分区 · `turnover` 周转率排序 · `coi` COI 立方体排序 ·
//! `class-based` 分区容量分级 · `dispersion` 同 SKU 分散（抗巷道故障）

use std::collections::BTreeMap;

use crate::contract::SlottingProblem;
use crate::slotting::{
    build_model, can_place, evaluate, seed_random_assignment, CostConfig, SlottingModel,
};
use crate::util::mean;

/// 可用策略清单（`capabilities` 与 CLI 的 `--algorithm` 均引用它）。
pub const ALGORITHMS: &[&str] = &[
    "random",
    "fixed",
    "nearest-available",
    "abc-class",
    "turnover",
    "coi",
    "class-based",
    "dispersion",
    "affinity",
    "alns",
    "tabu",
    "sa",
    "ga",
    "nsga2",
    "robust",
    "dynamic",
];

pub fn is_basic(algorithm: &str) -> bool {
    matches!(
        algorithm,
        "random"
            | "fixed"
            | "nearest-available"
            | "abc-class"
            | "turnover"
            | "coi"
            | "class-based"
            | "dispersion"
    )
}

/// 基础策略的确定性描述（面板"算法说明"直接读它，避免前端重写文案）。
pub fn describe(algorithm: &str) -> &'static str {
    match algorithm {
        "random" => "随机储位：把货物单元随机塞进可用库位（对照组基线）",
        "fixed" => "固定储位：SKU 与库位一一绑定（按 SKU 顺序取位），可解释性最好、灵活性最差",
        "nearest-available" => "最近可用：每次挑运行时间最短的空库位（贪心，不看未来）",
        "abc-class" => "ABC 分区：A 类靠近出库口、B 类居中、C 类远置",
        "turnover" => "周转率排序：按日均出库量降序排位，量大者优先",
        "coi" => "COI（Cube-per-Order Index）：单位订单需求占用的体积越小越靠近出库口",
        "class-based" => "分区容量分级：先按 ABC 分区，再在分区内按周转率细分，并限制分区容量",
        "dispersion" => "同 SKU 分散：同一 SKU 的库存分散到不同巷道，降低单点故障风险",
        "affinity" => "关联性储位：把共同出库的 SKU 压到相邻库位（关联权重 + 共现收缩）",
        "alns" => "自适应大邻域搜索（ALNS）：破坏-修复 + 算子权重自适应（主算法）",
        "tabu" => "禁忌搜索：候选移动 + 禁忌表 + 特赦准则",
        "sa" => "模拟退火：温度递减 + Metropolis 接受准则",
        "ga" => "遗传算法：排列编码 + 顺序交叉 + 交换变异",
        "nsga2" => "NSGA-II 多目标：非支配排序 + 拥挤距离，输出 Pareto 前沿",
        "robust" => "鲁棒优化：在需求情景集（均值/波动/长尾/灾难情景）下优化最坏与 CVaR",
        "dynamic" => "动态重优化：把需求/订单/设备/库存/拓扑变化作为显式事件驱动增量调整",
        _ => "未知算法",
    }
}

/// 基础策略的统一求解入口（返回货物单元 → 库位下标）。
pub fn solve_basic<'a>(
    problem: &'a SlottingProblem,
    algorithm: &str,
    cost_config: CostConfig,
) -> (SlottingModel<'a>, Vec<i64>, u64) {
    let model = build_model(problem, cost_config);
    let seed = problem.algorithm.seed;
    let assignment = match algorithm {
        "random" => seed_random_assignment(&model, seed),
        "fixed" => fixed(&model),
        "nearest-available" => nearest_available(&model, false),
        "abc-class" => abc_class(&model),
        "turnover" => turnover(&model),
        "coi" => coi(&model),
        "class-based" => class_based(&model),
        "dispersion" => dispersion(&model, seed),
        _ => seed_random_assignment(&model, seed),
    };
    (model, assignment, seed)
}

/// 统一落位原语：按给定顺序分配库位，库位由 `pick` 决定。
///
/// 返回 (assignment, 未落位数量)。硬约束不满足时回退到"可行的下一选择"，
/// 绝不为了完成分配而破坏硬约束（宁可如实报告未分配）。
pub fn place_sequence<F>(model: &SlottingModel, order: &[usize], mut pick: F) -> (Vec<i64>, usize)
where
    F: FnMut(&SlottingModel, usize, usize) -> Option<usize>, // (model, lu, attempt index) -> location
{
    let mut assignment = vec![-1i64; model.lu_sku.len()];
    let mut occupied = vec![false; model.locations.len()];
    let mut unassigned = 0usize;
    for (attempt, lu) in order.iter().enumerate() {
        let mut placed = false;
        for round in 0..model.placeable.len() {
            let Some(index) = pick(model, *lu, round) else {
                continue;
            };
            if occupied[index] || can_place(model, *lu, index).is_err() {
                continue;
            }
            assignment[*lu] = index as i64;
            occupied[index] = true;
            placed = true;
            break;
        }
        let _ = attempt;
        if !placed {
            unassigned += 1;
        }
    }
    (assignment, unassigned)
}

fn by_abc_then_flow(model: &SlottingModel) -> Vec<usize> {
    let mut order: Vec<usize> = (0..model.lu_sku.len()).collect();
    order.sort_by(|a, b| {
        let sa = &model.skus[model.lu_sku[*a]];
        let sb = &model.skus[model.lu_sku[*b]];
        sa.abc
            .cmp(&sb.abc)
            .then_with(|| {
                model.unit_flow[*b]
                    .partial_cmp(&model.unit_flow[*a])
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| sa.id.cmp(&sb.id))
    });
    order
}

/// 固定储位：SKU 顺序 ↔ 库位顺序的确定性绑定（同一 SKU 永远在同一区段）。
pub fn fixed(model: &SlottingModel) -> Vec<i64> {
    let order = by_abc_then_flow(model);
    let placeable: Vec<usize> = model.placeable.clone();
    let (assignment, _) = place_sequence(model, &order, |_m, _lu, round| {
        placeable.get(round).copied()
    });
    assignment
}

/// 最近可用：按库位代价升序取第一个空位（贪心）。
pub fn nearest_available(model: &SlottingModel, _reserved: bool) -> Vec<i64> {
    let order = by_abc_then_flow(model);
    let ranked: Vec<usize> = model.order_by_cost.clone();
    let (assignment, _) =
        place_sequence(model, &order, |_m, _lu, round| ranked.get(round).copied());
    assignment
}

/// ABC 分区：把可用库位按出库运行时间切成 3 段（A 段 50% 容量、B 30%、C 20%），
/// 每段长度按该段货物单元的**体积需求**自适应，避免"A 类商品挤爆近端库位"。
pub fn abc_class(model: &SlottingModel) -> Vec<i64> {
    let ranked = &model.order_by_cost;
    let mut assignment = vec![-1i64; model.lu_sku.len()];
    let mut occupied = vec![false; model.locations.len()];
    let mut classes: BTreeMap<char, Vec<usize>> = BTreeMap::new();
    for lu in by_abc_then_flow(model) {
        classes
            .entry(model.skus[model.lu_sku[lu]].abc)
            .or_default()
            .push(lu);
    }
    let shares = [('A', 0.5f64), ('B', 0.3), ('C', 0.2)];
    let mut cursor = 0usize;
    for (class, share) in shares {
        let Some(list) = classes.get(&class) else {
            continue;
        };
        let mut reserved = (ranked.len() as f64 * share).round() as usize;
        reserved = reserved.max(list.len().min(ranked.len().saturating_sub(cursor)));
        reserved = reserved.min(ranked.len().saturating_sub(cursor));
        let window = &ranked[cursor..(cursor + reserved)];
        cursor += reserved;
        let mut spill: Vec<usize> = ranked[cursor.min(ranked.len())..].to_vec();
        for lu in list {
            let mut placed = false;
            for index in window {
                if !occupied[*index] && can_place(model, *lu, *index).is_ok() {
                    assignment[*lu] = *index as i64;
                    occupied[*index] = true;
                    placed = true;
                    break;
                }
            }
            if !placed {
                for index in spill.iter() {
                    if !occupied[*index] && can_place(model, *lu, *index).is_ok() {
                        assignment[*lu] = *index as i64;
                        occupied[*index] = true;
                        placed = true;
                        break;
                    }
                }
            }
            if !placed {
                // 最后再退到整库范围（容量紧张时避免误报不可行）
                for index in ranked.iter() {
                    if !occupied[*index] && can_place(model, *lu, *index).is_ok() {
                        assignment[*lu] = *index as i64;
                        occupied[*index] = true;
                        placed = true;
                        break;
                    }
                }
            }
        }
        spill.clear();
    }
    assignment
}

/// 周转率排序：日均出库量（件/天）降序 → 越靠前放越近。
pub fn turnover(model: &SlottingModel) -> Vec<i64> {
    let mut order: Vec<usize> = (0..model.lu_sku.len()).collect();
    order.sort_by(|a, b| {
        model.unit_flow[*b]
            .partial_cmp(&model.unit_flow[*a])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                model.problem.inventory[*a]
                    .id
                    .cmp(&model.problem.inventory[*b].id)
            })
    });
    let ranked = model.order_by_cost.clone();
    let (assignment, _) =
        place_sequence(model, &order, |_m, _lu, round| ranked.get(round).copied());
    assignment
}

/// COI = 单位时间的立方体需求 / 单位库位地面面积；越小越靠近出库口。
/// 本实现用 SKU 单元体积 / 单元重量近似"立方体需求"，并把日均出库量作为频率因子。
pub fn coi(model: &SlottingModel) -> Vec<i64> {
    let mut scores: Vec<(usize, f64)> = (0..model.lu_sku.len())
        .map(|lu| {
            let sku = model.lu_sku[lu];
            let cube = model.sku_volume[sku].max(1e-6);
            let frequency = model.unit_flow[lu].max(0.01);
            (lu, cube / frequency)
        })
        .collect();
    scores.sort_by(|a, b| {
        a.1.partial_cmp(&b.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                model.problem.inventory[a.0]
                    .id
                    .cmp(&model.problem.inventory[b.0].id)
            })
    });
    let order: Vec<usize> = scores.into_iter().map(|(lu, _)| lu).collect();
    let ranked = model.order_by_cost.clone();
    let (assignment, _) =
        place_sequence(model, &order, |_m, _lu, round| ranked.get(round).copied());
    assignment
}

/// 分区容量分级：ABC 分区 + 分区内按周转率排序 + 分区容量上限（超限者向外溢）。
pub fn class_based(model: &SlottingModel) -> Vec<i64> {
    let ranked = &model.order_by_cost;
    let mut assignment = vec![-1i64; model.lu_sku.len()];
    let mut occupied = vec![false; model.locations.len()];
    let mut classes: BTreeMap<char, Vec<usize>> = BTreeMap::new();
    for lu in by_abc_then_flow(model) {
        classes
            .entry(model.skus[model.lu_sku[lu]].abc)
            .or_default()
            .push(lu);
    }
    let zones = ["A", "B", "C"];
    let share = 1.0 / zones.len() as f64;
    let mut cursor = 0usize;
    for zone in zones {
        let Some(list) = classes.get(&zone.chars().next().unwrap()) else {
            continue;
        };
        let window_end =
            ((cursor as f64 + ranked.len() as f64 * share).round() as usize).min(ranked.len());
        // 分区容量 = 窗口内可放置且满足体积限制的库位数量
        let capacity: usize = ranked[cursor..window_end]
            .iter()
            .filter(|index| {
                model.locations[**index].availability == crate::contract::Availability::Available
            })
            .count();
        for (slot, lu) in list.iter().enumerate() {
            let index = if slot < capacity {
                ranked[cursor..window_end]
                    .iter()
                    .copied()
                    .find(|i| !occupied[*i] && can_place(model, *lu, *i).is_ok())
            } else {
                None
            };
            let index = index.or_else(|| {
                ranked[cursor..]
                    .iter()
                    .copied()
                    .find(|i| !occupied[*i] && can_place(model, *lu, *i).is_ok())
            });
            if let Some(index) = index {
                assignment[*lu] = index as i64;
                occupied[index] = true;
            }
        }
        cursor = window_end;
    }
    assignment
}

/// 同 SKU 分散：同一 SKU 的库存单元按巷道轮转分配，尽量不在同一巷道堆叠。
pub fn dispersion(model: &SlottingModel, _seed: u64) -> Vec<i64> {
    let mut assignment = vec![-1i64; model.lu_sku.len()];
    let mut occupied = vec![false; model.locations.len()];
    let mut last_aisle: BTreeMap<usize, usize> = BTreeMap::new();
    let mut order: Vec<usize> = (0..model.lu_sku.len()).collect();
    order.sort_by(|a, b| {
        model.unit_flow[*b]
            .partial_cmp(&model.unit_flow[*a])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                model.problem.inventory[*a]
                    .id
                    .cmp(&model.problem.inventory[*b].id)
            })
    });
    let ranked: Vec<usize> = model.order_by_cost.clone();
    for lu in order {
        let sku = model.lu_sku[lu];
        let previous = last_aisle.get(&sku).copied();
        // 第一轮：只接受"与同一 SKU 上一次落位不同巷道"的候选（抗巷道故障）；
        // 第二轮：容量紧张时退回全局代价最优候选，保证不会因分散规则而漏放。
        let mut chosen = ranked.iter().copied().find(|index| {
            !occupied[*index]
                && can_place(model, lu, *index).is_ok()
                && previous != Some(model.costs[*index].aisle_index)
        });
        if chosen.is_none() {
            chosen = ranked
                .iter()
                .copied()
                .find(|index| !occupied[*index] && can_place(model, lu, *index).is_ok());
        }
        if let Some(index) = chosen {
            assignment[lu] = index as i64;
            occupied[index] = true;
            last_aisle.insert(sku, model.costs[index].aisle_index);
        }
    }
    assignment
}

/// 分区占用统计（供面板展示"分区容量分级到底把哪些 SKU 放在哪个分区"）。
pub fn zone_summary(
    model: &SlottingModel,
    assignment: &[i64],
) -> BTreeMap<String, (usize, usize, f64)> {
    let mut out: BTreeMap<String, (usize, usize, f64)> = BTreeMap::new();
    for (lu, loc) in assignment.iter().enumerate() {
        if *loc < 0 {
            continue;
        }
        let sku = model.lu_sku[lu];
        let key = format!(
            "{}-{}",
            model.skus[sku].abc, model.locations[*loc as usize].zone
        );
        let entry = out.entry(key).or_insert((0, 0, 0.0));
        entry.0 += 1;
        entry.2 += model.unit_flow[lu];
    }
    for (index, loc) in model.locations.iter().enumerate() {
        if model.placeable.contains(&index) {
            let key = format!("{}-{}", "·", loc.zone);
            let entry = out.entry(key).or_insert((0, 0, 0.0));
            entry.1 += 1;
        }
    }
    out
}

/// 平均出库运行时间（基础策略对比用的核心指标，单位秒）。
pub fn average_pick_seconds(model: &SlottingModel, assignment: &[i64]) -> f64 {
    let mut total = 0.0;
    let mut flow = 0.0;
    for (lu, loc) in assignment.iter().enumerate() {
        if *loc < 0 {
            continue;
        }
        total += model.unit_flow[lu] * model.costs[*loc as usize].pick_seconds;
        flow += model.unit_flow[lu];
    }
    if flow > 0.0 {
        total / flow
    } else {
        0.0
    }
}

/// 基础策略横向对比（面板"策略对比"表的数据源）。
pub fn compare_basics(
    problem: &SlottingProblem,
    cost_config: CostConfig,
) -> Vec<(String, f64, f64, f64, usize)> {
    let mut rows = Vec::new();
    for algorithm in [
        "random",
        "fixed",
        "nearest-available",
        "abc-class",
        "turnover",
        "coi",
        "class-based",
        "dispersion",
    ] {
        let (mut model, assignment, seed) = solve_basic(problem, algorithm, cost_config.clone());
        let state = crate::slotting::SlottingState::rebuild(&mut model, &assignment);
        let objective = evaluate(&model, &state);
        let _ = seed;
        rows.push((
            algorithm.to_string(),
            objective
                .values
                .get("expected-travel-time")
                .copied()
                .unwrap_or(0.0),
            average_pick_seconds(&model, &assignment),
            mean(&state.aisle_flow),
            state.unassigned,
        ));
    }
    rows
}

/// 便捷：随机初始化 + 落位（供 ALNS 等复用的初始解构造）。
pub fn greedy_flow_initial(model: &SlottingModel) -> Vec<i64> {
    let mut order: Vec<usize> = (0..model.lu_sku.len()).collect();
    order.sort_by(|a, b| {
        model.unit_flow[*b]
            .partial_cmp(&model.unit_flow[*a])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                model.problem.inventory[*a]
                    .id
                    .cmp(&model.problem.inventory[*b].id)
            })
    });
    let ranked: Vec<usize> = model.order_by_cost.clone();
    let mut assignment = vec![-1i64; model.lu_sku.len()];
    let mut occupied = vec![false; model.locations.len()];
    let mut last_aisle: Option<usize> = None;
    let mut same_aisle_streak = 0usize;
    for lu in order {
        // 连续 2 件落同一巷道后强制换巷道，避免初始解把热点堆在一条巷道里
        let avoid = if same_aisle_streak >= 2 {
            last_aisle
        } else {
            None
        };
        let mut chosen = ranked.iter().copied().find(|index| {
            !occupied[*index]
                && can_place(model, lu, *index).is_ok()
                && avoid != Some(model.costs[*index].aisle_index)
        });
        if chosen.is_none() {
            chosen = ranked
                .iter()
                .copied()
                .find(|index| !occupied[*index] && can_place(model, lu, *index).is_ok());
        }
        if let Some(index) = chosen {
            assignment[lu] = index as i64;
            occupied[index] = true;
            let aisle = model.costs[index].aisle_index;
            if last_aisle == Some(aisle) {
                same_aisle_streak += 1;
            } else {
                same_aisle_streak = 1;
                last_aisle = Some(aisle);
            }
        }
    }
    assignment
}
