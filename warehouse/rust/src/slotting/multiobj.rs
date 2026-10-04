//! 多目标优化：NSGA-II（快速非支配排序 + 拥挤距离）与 Pareto 前沿导出。
//!
//! 决策变量：货物单元的落位顺序（排列编码）；评价向量只使用真实可计算的目标分量
//! （出库运行时间 / 拥堵延误 / 巷道负载基尼 / 搬迁代价 / 利用率），不做任何"评分公式"。
//! 前沿点会同时给出**每个目标的分量值**，面板可以直接画平行坐标图。

use std::collections::BTreeMap;

use crate::contract::SlottingProblem;
use crate::errors::Status;
use crate::slotting::search::{fast_scalar, weights_of, SearchStats, Weights};
use crate::slotting::{SlottingModel, SlottingSolveOptions, SlottingState};
use crate::util::{round, seed_from, Rng};

/// 参与多目标优化的目标分量（全部有单位、可独立复核）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    Time,
    Congestion,
    Balance,
    Relocation,
}

pub const AXES: &[Axis] = &[
    Axis::Time,
    Axis::Congestion,
    Axis::Balance,
    Axis::Relocation,
];

impl Axis {
    pub fn id(self) -> &'static str {
        match self {
            Axis::Time => "expected-travel-time",
            Axis::Congestion => "congestion",
            Axis::Balance => "load-balance",
            Axis::Relocation => "relocation-cost",
        }
    }

    pub fn unit(self) -> &'static str {
        match self {
            Axis::Time => "秒/天",
            Axis::Congestion => "秒/天",
            Axis::Balance => "基尼系数",
            Axis::Relocation => "秒",
        }
    }

    fn value(self, model: &SlottingModel, state: &SlottingState) -> f64 {
        match self {
            Axis::Time => state.base_seconds * state.congestion_factor(model),
            Axis::Congestion => state.congestion_seconds(model),
            Axis::Balance => state.aisle_gini(),
            Axis::Relocation => state.relocation_seconds,
        }
    }
}

/// 支配关系（最小化所有轴）。
fn dominates(a: &[f64], b: &[f64]) -> bool {
    let mut strictly_better = false;
    for (left, right) in a.iter().zip(b.iter()) {
        if left > right {
            return false;
        }
        if left < right {
            strictly_better = true;
        }
    }
    strictly_better
}

struct Individual {
    genome: Vec<usize>,
    values: Vec<f64>,
    rank: usize,
    crowding: f64,
}

/// Pareto 前沿上的一个解（只带证据，不带求解器内部状态）。
#[derive(Debug, Clone, Default)]
pub struct ParetoPoint {
    pub values: BTreeMap<String, f64>,
    pub objective: f64,
    pub digest: String,
}

/// NSGA-II 主流程。
#[allow(clippy::too_many_arguments)]
pub fn nsga2(
    model: &mut SlottingModel,
    problem: &SlottingProblem,
    _options: &SlottingSolveOptions,
    weights: &Weights,
    seed: u64,
    budget_ms: f64,
) -> crate::slotting::search::SearchOutcomeInternal {
    let mut rng = Rng::new(seed_from(&["nsga2", &seed.to_string()]));
    let n = model.lu_sku.len();
    let population_size = problem.algorithm.pareto_population.clamp(8, 64);
    let generations = problem.algorithm.pareto_generations.clamp(4, 200);
    let started = crate::engine::now_ms();
    let deadline = started + budget_ms.max(50.0) * 0.97;

    let mut population: Vec<Individual> = Vec::with_capacity(population_size);
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
    population.push(evaluate_individual(model, base.clone()));
    while population.len() < population_size {
        let mut genome = base.clone();
        for i in (1..n).rev() {
            let j = rng.below(i + 1);
            genome.swap(i, j);
        }
        population.push(evaluate_individual(model, genome));
    }
    let mut stats = SearchStats::default();
    let mut best_front: Vec<Individual> = Vec::new();
    for generation in 0..generations {
        assign_ranks(&mut population);
        let mut offspring: Vec<Individual> = Vec::with_capacity(population_size);
        while offspring.len() < population_size {
            let a = tournament(&population, &mut rng);
            let b = tournament(&population, &mut rng);
            let mut child = crossover(&a.genome, &b.genome, &mut rng);
            if rng.next_f64() < 0.4 && n > 1 {
                let i = rng.below(n);
                let j = rng.below(n);
                child.swap(i, j);
            }
            offspring.push(evaluate_individual(model, child));
        }
        let mut combined = population;
        combined.append(&mut offspring);
        assign_ranks(&mut combined);
        let front0: Vec<usize> = (0..combined.len())
            .filter(|index| combined[*index].rank == 0)
            .collect();
        best_front = front0
            .iter()
            .map(|index| clone_individual(&combined[*index]))
            .collect();
        // 环境选择：按 rank 升序 + 同 rank 内拥挤距离降序
        let mut order: Vec<usize> = (0..combined.len()).collect();
        order.sort_by(|a, b| {
            combined[*a].rank.cmp(&combined[*b].rank).then_with(|| {
                combined[*b]
                    .crowding
                    .partial_cmp(&combined[*a].crowding)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        });
        population = order
            .into_iter()
            .take(population_size)
            .map(|index| clone_individual(&combined[index]))
            .collect();
        stats.iterations = generation as u64 + 1;
        stats.trace.push(round(
            best_front
                .iter()
                .map(|individual| scalar_of(&individual.values, weights, model))
                .fold(f64::INFINITY, f64::min),
            6,
        ));
        if stats.trace.len() > 256 {
            stats.trace.remove(0);
        }
        stats
            .operators
            .entry("Pareto 前沿规模".to_string())
            .and_modify(|count| *count = best_front.len() as u64)
            .or_insert(best_front.len() as u64);
        if crate::engine::now_ms() > deadline || crate::engine::cancel_requested() {
            stats.cancelled = crate::engine::cancel_requested();
            break;
        }
    }
    if best_front.is_empty() {
        assign_ranks(&mut population);
        best_front = population
            .iter()
            .filter(|individual| individual.rank == 0)
            .map(clone_individual)
            .collect();
    }
    best_front.sort_by(|a, b| {
        scalar_of(&a.values, weights, model)
            .partial_cmp(&scalar_of(&b.values, weights, model))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let chosen = best_front
        .first()
        .map(clone_individual)
        .unwrap_or_else(|| clone_individual(&evaluate_individual(model, base)));
    let assignment = crate::slotting::search::decode_assignment(model, &chosen.genome);
    let state = SlottingState::rebuild(model, &assignment);
    stats.best_iteration = stats.iterations;
    stats.elapsed_ms = round(crate::engine::now_ms() - started, 3);
    let pareto: Vec<ParetoPoint> = best_front
        .iter()
        .map(|individual| ParetoPoint {
            values: AXES
                .iter()
                .map(|axis| {
                    (
                        axis.id().to_string(),
                        round(individual.values[axis_index(*axis)], 4),
                    )
                })
                .collect(),
            objective: scalar_of(&individual.values, weights, model),
            digest: crate::engine::short_hash(
                &crate::engine::fingerprint(&[
                    "pareto",
                    &individual
                        .genome
                        .iter()
                        .map(|value| value.to_string())
                        .collect::<Vec<String>>()
                        .join(","),
                ]),
                12,
            ),
        })
        .collect();
    crate::slotting::search::SearchOutcomeInternal {
        state,
        stats,
        pareto,
        optimality: Some(crate::slotting::search::OptimalityReport {
            proven: false,
            scope: "启发式（NSGA-II）：给出 Pareto 前沿，不声称任何单点最优".to_string(),
            bound: None,
            gap: None,
            method: "NSGA-II 多目标进化".to_string(),
        }),
        status: Status::FeasibleWithBound,
    }
}

fn axis_index(axis: Axis) -> usize {
    AXES.iter()
        .position(|candidate| *candidate == axis)
        .unwrap_or(0)
}

fn clone_individual(individual: &Individual) -> Individual {
    Individual {
        genome: individual.genome.clone(),
        values: individual.values.clone(),
        rank: individual.rank,
        crowding: individual.crowding,
    }
}

fn evaluate_individual(model: &mut SlottingModel, genome: Vec<usize>) -> Individual {
    // 解码 → 重建状态（搬迁代价与未分配都由同一套语义维护，口径与单目标求解完全一致）
    let assignment = crate::slotting::search::decode_assignment(model, &genome);
    let state = SlottingState::rebuild(model, &assignment);
    let values: Vec<f64> = AXES.iter().map(|axis| axis.value(model, &state)).collect();
    Individual {
        genome,
        values,
        rank: 0,
        crowding: 0.0,
    }
}

fn scalar_of(values: &[f64], weights: &Weights, model: &SlottingModel) -> f64 {
    let mut total = 0.0;
    for (index, axis) in AXES.iter().enumerate() {
        let weight = match axis {
            Axis::Time => weights.time,
            Axis::Congestion => weights.congestion,
            Axis::Balance => weights.balance,
            Axis::Relocation => weights.relocation_cost,
        };
        let reference = crate::slotting::default_normalizer(axis.id());
        total += weight * values[index] / if reference > 0.0 { reference } else { 1.0 };
    }
    let _ = model;
    total
}

/// 快速非支配排序 + 拥挤距离。
fn assign_ranks(population: &mut [Individual]) {
    let size = population.len();
    let mut dominated: Vec<Vec<usize>> = vec![Vec::new(); size];
    let mut domination_count = vec![0usize; size];
    let mut fronts: Vec<Vec<usize>> = vec![Vec::new()];
    for a in 0..size {
        for b in 0..size {
            if a == b {
                continue;
            }
            if dominates(&population[a].values, &population[b].values) {
                dominated[a].push(b);
            } else if dominates(&population[b].values, &population[a].values) {
                domination_count[a] += 1;
            }
        }
        if domination_count[a] == 0 {
            population[a].rank = 0;
            fronts[0].push(a);
        }
    }
    let mut index = 0usize;
    while index < fronts.len() && !fronts[index].is_empty() {
        let mut next: Vec<usize> = Vec::new();
        for a in fronts[index].clone() {
            for b in dominated[a].clone() {
                domination_count[b] -= 1;
                if domination_count[b] == 0 {
                    population[b].rank = index + 1;
                    next.push(b);
                }
            }
        }
        index += 1;
        if !next.is_empty() {
            fronts.push(next);
        }
    }
    // 拥挤距离（每个前沿内部）
    for front in fronts.iter() {
        if front.is_empty() {
            continue;
        }
        let dimensions = population[front[0]].values.len();
        for index in front.iter() {
            population[*index].crowding = 0.0;
        }
        for dimension in 0..dimensions {
            let mut sorted = front.clone();
            sorted.sort_by(|a, b| {
                population[*a].values[dimension]
                    .partial_cmp(&population[*b].values[dimension])
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            let first = sorted[0];
            let last = sorted[sorted.len() - 1];
            let span = population[last].values[dimension] - population[first].values[dimension];
            population[first].crowding = f64::INFINITY;
            population[last].crowding = f64::INFINITY;
            if span <= 1e-12 {
                continue;
            }
            for window in sorted.windows(3) {
                let previous = population[window[0]].values[dimension];
                let next = population[window[2]].values[dimension];
                population[window[1]].crowding += (next - previous) / span;
            }
        }
    }
}

fn tournament(population: &[Individual], rng: &mut Rng) -> Individual {
    let a = rng.below(population.len());
    let b = rng.below(population.len());
    let winner = if population[a].rank < population[b].rank
        || (population[a].rank == population[b].rank
            && population[a].crowding > population[b].crowding)
    {
        a
    } else {
        b
    };
    clone_individual(&population[winner])
}

fn crossover(a: &[usize], b: &[usize], rng: &mut Rng) -> Vec<usize> {
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
    let upper = hi.min(n - 1) + 1;
    child[lo..upper].copy_from_slice(&a[lo..upper]);
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

/// 供面板显示的目标轴元数据。
pub fn axis_catalog() -> Vec<(String, String)> {
    AXES.iter()
        .map(|axis| (axis.id().to_string(), axis.unit().to_string()))
        .collect()
}

/// 让多目标搜索也能被 `strategies::describe` 解释。
pub fn describe() -> &'static str {
    "NSGA-II：同时优化运行时间、拥堵、巷道负载与搬迁代价，输出 Pareto 前沿供决策者权衡"
}

/// 面板需要的"Pareto 前沿 → 权衡说明"：解释为什么会存在多个互不支配的解。
pub fn tradeoff_notes(points: &[ParetoPoint]) -> Vec<(String, String)> {
    if points.len() < 2 {
        return vec![(
            "Pareto".to_string(),
            "本次搜索只得到一个非支配解：在当前权重下其它目标已经没有改进空间".to_string(),
        )];
    }
    let time_best = points
        .iter()
        .min_by(|a, b| {
            a.values["expected-travel-time"]
                .partial_cmp(&b.values["expected-travel-time"])
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap();
    let relocation_best = points
        .iter()
        .min_by(|a, b| {
            a.values["relocation-cost"]
                .partial_cmp(&b.values["relocation-cost"])
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap();
    vec![
        (
            "运行时间最优解".to_string(),
            format!(
                "出库运行时间 {:.0} 秒/天，但搬迁代价 {:.0} 秒（搬得越多越省时间）",
                time_best.values["expected-travel-time"], time_best.values["relocation-cost"]
            ),
        ),
        (
            "搬迁代价最优解".to_string(),
            format!(
                "搬迁代价 {:.0} 秒（几乎不动库），出库运行时间 {:.0} 秒/天",
                relocation_best.values["relocation-cost"],
                relocation_best.values["expected-travel-time"]
            ),
        ),
    ]
}

/// 供联合优化复用：给定模型与基因组，返回 (状态, 目标标量)。
pub fn evaluate_genome(
    model: &mut SlottingModel,
    genome: &[usize],
    weights: &Weights,
) -> (SlottingState, f64) {
    let assignment = crate::slotting::search::decode_assignment(model, genome);
    let state = SlottingState::rebuild(model, &assignment);
    let scalar = fast_scalar(model, &state, weights);
    (state, scalar)
}

/// 权重解析（供 CLI / 面板展示"到底在权衡什么"）。
pub fn weights_of_public(problem: &SlottingProblem) -> Weights {
    weights_of(problem)
}
