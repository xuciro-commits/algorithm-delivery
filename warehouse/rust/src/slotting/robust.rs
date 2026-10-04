//! 鲁棒优化：需求不确定 + 设备可用性不确定下的库位方案。
//!
//! 与"均值最优"的关键差别（SRS §3.2D）：
//! * 情景不是随机噪声摆设，而是**结构性**的：需求整体偏移、长尾放大、单巷道/单提升机失效；
//! * 评价口径同时给出 均值 / 最坏情景 / CVaR（尾部均值），并明确优化哪个度量；
//! * 鲁棒方案要能与均值最优方案在同一情景集上做对比 —— 面板能直接看到"多花了多少均值代价，
//!   换来了多少尾部改善"。

use crate::contract::DynamicEvent;
use crate::errors::Status;
use crate::slotting::search::{self, SearchOutcomeInternal, SearchStats, Weights};
use crate::slotting::{
    relocation_contribution, SlottingModel, SlottingSolveOptions, SlottingState,
};
use crate::util::{mean, round, seed_from, Rng};

/// 一个需求 / 能力情景。
#[derive(Debug, Clone)]
pub struct Scenario {
    pub name: String,
    /// 每个货物单元的流量乘子（结构性偏移，不是逐件独立噪声）。
    pub flow_mult: Vec<f64>,
    /// 每个巷道的可用能力乘子（1.0 = 正常；0.0 = 该巷道失效）。
    pub aisle_capacity: Vec<f64>,
    /// 每个提升机分组的可用能力乘子。
    pub lift_capacity: Vec<f64>,
    pub weight: f64,
    pub description: String,
}

/// 情景集构造：均值 + 波动放大 + 长尾 + 结构性事件（巷道/提升机失效、旺季整体上浮）。
pub fn build_scenarios(model: &SlottingModel, count: usize, seed: u64) -> Vec<Scenario> {
    let mut rng = Rng::new(seed_from(&["robust-scenarios", &seed.to_string()]));
    let count = count.max(3);
    let units = model.lu_sku.len();
    let mut scenarios: Vec<Scenario> = Vec::with_capacity(count);
    // 1) 基准（均值）
    scenarios.push(Scenario {
        name: "S-base".to_string(),
        flow_mult: vec![1.0; units],
        aisle_capacity: vec![1.0; model.aisle_ids.len()],
        lift_capacity: vec![1.0; model.lift_ids.len()],
        weight: 1.0,
        description: "需求均值情景（与确定性优化同一口径）".to_string(),
    });
    // 2) 旺季整体上浮 25%
    scenarios.push(Scenario {
        name: "S-peak".to_string(),
        flow_mult: vec![1.25; units],
        aisle_capacity: vec![1.0; model.aisle_ids.len()],
        lift_capacity: vec![1.0; model.lift_ids.len()],
        weight: 1.0,
        description: "峰值季：整体需求 +25%（对拥堵最敏感的情景）".to_string(),
    });
    // 3) 长尾放大：C 类商品需求显著上浮（长尾带来的意外热点）
    let mut long_tail = vec![1.0f64; units];
    for (lu, value) in long_tail.iter_mut().enumerate() {
        let sku = model.lu_sku[lu];
        *value = match model.skus[sku].abc {
            'C' => 2.0,
            'B' => 1.25,
            _ => 1.0,
        };
    }
    scenarios.push(Scenario {
        name: "S-long-tail".to_string(),
        flow_mult: long_tail,
        aisle_capacity: vec![1.0; model.aisle_ids.len()],
        lift_capacity: vec![1.0; model.lift_ids.len()],
        weight: 1.0,
        description: "长尾放大：C 类（慢流）需求翻倍，检验低位商品的位置是否仍合理".to_string(),
    });
    // 4) 结构性偏移：关联簇整体活跃（促销）
    if model.affinity.clusters > 0 {
        let hot = rng.below(model.affinity.clusters);
        let mut promotion = vec![1.0f64; units];
        for (lu, value) in promotion.iter_mut().enumerate() {
            if model.affinity.cluster_of[model.lu_sku[lu]] == hot as i64 {
                *value = 3.0;
            }
        }
        scenarios.push(Scenario {
            name: format!("S-promo-{hot}"),
            flow_mult: promotion,
            aisle_capacity: vec![1.0; model.aisle_ids.len()],
            lift_capacity: vec![1.0; model.lift_ids.len()],
            weight: 1.0,
            description: format!("促销情景：关联簇 #{hot} 需求 ×3（检验关联储位是否真的抗冲击）"),
        });
    }
    // 5) 单巷道失效（设备/通道故障）
    if model.aisle_ids.len() > 1 {
        let failed = rng.below(model.aisle_ids.len());
        let mut capacity = vec![1.0f64; model.aisle_ids.len()];
        capacity[failed] = 0.08; // 不是完全 0：保留应急人工能力
        scenarios.push(Scenario {
            name: format!("S-aisle-fail-{failed}"),
            flow_mult: vec![1.0; units],
            aisle_capacity: capacity,
            lift_capacity: vec![1.0; model.lift_ids.len()],
            weight: 1.0,
            description: format!(
                "巷道 {} 失效：该巷道能力降到 8%，需求必须由其它巷道承担",
                model.aisle_ids[failed]
            ),
        });
    }
    // 6) 提升机降速（立库最常见的退化场景）
    if model.lift_ids.len() > 0 {
        let degraded = rng.below(model.lift_ids.len());
        let mut capacity = vec![1.0f64; model.lift_ids.len()];
        capacity[degraded] = 0.5;
        scenarios.push(Scenario {
            name: format!("S-lift-degraded-{degraded}"),
            flow_mult: vec![1.0; units],
            aisle_capacity: vec![1.0; model.aisle_ids.len()],
            lift_capacity: capacity,
            weight: 1.0,
            description: format!(
                "提升机 {} 降速 50%：高层库位的真实代价上升",
                model.lift_ids[degraded]
            ),
        });
    }
    // 7..N) 结构化随机情景（逐 SKU 偏移，保持整簇相关性）
    while scenarios.len() < count {
        let sigma = 0.15 + rng.next_f64() * 0.15;
        let mut flow_mult = vec![1.0f64; units];
        for sku_index in 0..model.skus.len() {
            let shock = 1.0 + (rng.next_f64() * 2.0 - 1.0) * sigma * 3.0;
            for (lu, value) in flow_mult.iter_mut().enumerate() {
                if model.lu_sku[lu] == sku_index {
                    *value = shock.max(0.2);
                }
            }
        }
        // 长尾情景里偶尔让某条巷道更忙（热点漂移）
        let mut capacity = vec![1.0f64; model.aisle_ids.len()];
        if model.aisle_ids.len() > 1 && rng.next_f64() < 0.3 {
            let worse = rng.below(model.aisle_ids.len());
            capacity[worse] = 0.6;
        }
        scenarios.push(Scenario {
            name: format!("S-rand-{}", scenarios.len()),
            flow_mult,
            aisle_capacity: capacity,
            lift_capacity: vec![1.0; model.lift_ids.len()],
            weight: 1.0,
            description: format!(
                "结构性随机情景（σ={:.2}）：逐 SKU 相关偏移 + 可能的巷道降级",
                sigma
            ),
        });
    }
    scenarios
}

/// 某情景下的日运行时间（秒/天）：加权运行时间 + 该情景能力下的拥堵延误。
pub fn scenario_seconds(model: &SlottingModel, state: &SlottingState, scenario: &Scenario) -> f64 {
    let mut time = 0.0;
    let mut aisle_demand = vec![0.0f64; model.aisle_ids.len()];
    let mut lift_demand = vec![0.0f64; model.lift_ids.len()];
    for (lu, loc) in state.loc_of_lu.iter().enumerate() {
        if *loc < 0 {
            continue;
        }
        let loc = *loc as usize;
        let flow = model.unit_flow[lu] * scenario.flow_mult.get(lu).copied().unwrap_or(1.0);
        time += flow
            * (model.cost_config.outbound_share * model.costs[loc].pick_seconds
                + (1.0 - model.cost_config.outbound_share) * model.costs[loc].put_seconds);
        aisle_demand[model.costs[loc].aisle_index] += flow;
        if model.costs[loc].uses_lift {
            lift_demand[model.costs[loc].lift_group] += flow;
        }
    }
    let mut congestion = 0.0;
    for (index, demand_flow) in aisle_demand.iter().enumerate() {
        let capacity = model.aisle_capacity[index]
            * scenario.aisle_capacity.get(index).copied().unwrap_or(1.0);
        congestion += search::aisle_congestion(
            *demand_flow,
            capacity,
            model.cost_config.aisle_service_seconds,
            model.cost_config.congestion_scale,
        );
    }
    for (index, demand_flow) in lift_demand.iter().enumerate() {
        let capacity =
            model.lift_capacity[index] * scenario.lift_capacity.get(index).copied().unwrap_or(1.0);
        congestion += search::aisle_congestion(
            *demand_flow,
            capacity,
            model.cost_config.lift_service_seconds,
            model.cost_config.congestion_scale,
        );
    }
    time + congestion
}

#[derive(Debug, Clone, Default)]
pub struct RobustReport {
    pub mean: f64,
    pub worst: f64,
    pub cvar: f64,
    pub score: f64,
    pub per_scenario: Vec<(String, f64, String)>,
    pub measure: String,
    pub alpha: f64,
}

/// 稳健评价：同时给出三种度量，只对声明的那一种做优化。
pub fn evaluate_robust(
    model: &SlottingModel,
    state: &SlottingState,
    scenarios: &[Scenario],
    measure: &str,
    alpha: f64,
) -> RobustReport {
    let mut values: Vec<f64> = Vec::with_capacity(scenarios.len());
    let mut per_scenario = Vec::with_capacity(scenarios.len());
    for scenario in scenarios {
        let value = scenario_seconds(model, state, scenario);
        values.push(value);
        per_scenario.push((
            scenario.name.clone(),
            round(value, 3),
            scenario.description.clone(),
        ));
    }
    let mean_value = mean(&values);
    let worst = values.iter().copied().fold(f64::MIN, f64::max);
    let cvar = cvar(&values, alpha);
    let score = match measure {
        "minimax" => worst,
        "mean" => mean_value,
        _ => 0.5 * mean_value + 0.5 * cvar,
    };
    RobustReport {
        mean: round(mean_value, 3),
        worst: round(worst, 3),
        cvar: round(cvar, 3),
        score: round(score, 3),
        per_scenario,
        measure: measure.to_string(),
        alpha,
    }
}

fn cvar(values: &[f64], alpha: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let cut = ((sorted.len() as f64) * (1.0 - alpha.clamp(0.01, 0.99))) as usize;
    mean(&sorted[cut.min(sorted.len() - 1)..])
}

/// 鲁棒求解：先由确定性目标得到可行解，再用"情景折叠"目标做邻域改良。
pub fn robust(
    model: &mut SlottingModel,
    problem: &crate::contract::SlottingProblem,
    _options: &SlottingSolveOptions,
    weights: &Weights,
    seed: u64,
    budget_ms: f64,
) -> SearchOutcomeInternal {
    let started = crate::engine::now_ms();
    let scenarios = build_scenarios(
        model,
        problem.algorithm.robust_scenarios,
        seed ^ 0x5bf0_3635,
    );
    let measure = problem.algorithm.robust_measure.clone();
    let alpha = problem.algorithm.robust_cvar_alpha;

    // 可行解初值：使用确定性目标的最优可行解（搬迁/拥堵口径一致）
    let initial = search::greedy_initial(model, seed);
    let mut state = SlottingState::rebuild(model, &initial);
    let mut report = evaluate_robust(model, &state, &scenarios, &measure, alpha);
    let mut best_state = state.clone_state();
    let mut best_report = report.clone();
    let mut rng = Rng::new(seed_from(&["robust", &seed.to_string()]));
    let mut stats = SearchStats::default();
    let deadline = started + budget_ms.max(50.0) * 0.9;
    let mut iterations = 0u64;
    let trace_every = 25u64;
    while crate::engine::now_ms() < deadline
        && !crate::engine::cancel_requested()
        && iterations < 2_000_000
    {
        iterations += 1;
        stats.iterations = iterations;
        let Some(candidate_move) = search::random_move_public(model, &state, &mut rng) else {
            break;
        };
        if !search::legal_move_public(model, &state, candidate_move) {
            continue;
        }
        let snapshot = state.clone_state();
        search::apply_move_public(model, &mut state, candidate_move);
        let candidate = evaluate_robust(model, &state, &scenarios, &measure, alpha);
        if candidate.score < best_report.score - 1e-9 {
            best_report = candidate.clone();
            best_state = state.clone_state();
            stats
                .operators
                .entry("鲁棒改良移动".to_string())
                .and_modify(|count| *count += 1)
                .or_insert(1);
        } else if candidate.score < report.score - 1e-9 {
            report = candidate;
        } else {
            state = snapshot;
        }
        if iterations % trace_every == 0 {
            stats.trace.push(round(best_report.score, 6));
            if stats.trace.len() > 256 {
                stats.trace.remove(0);
            }
        }
    }
    let _ = weights;
    let final_report = evaluate_robust(model, &best_state, &scenarios, &measure, alpha);
    stats.best_iteration = stats.iterations;
    stats.elapsed_ms = round(crate::engine::now_ms() - started, 3);
    stats
        .operators
        .entry("情景数".to_string())
        .or_insert(scenarios.len() as u64);
    // 把最终鲁棒报告以 info 形式写进指标通道（面板直接可读）
    SearchOutcomeInternal {
        state: best_state,
        stats,
        pareto: Vec::new(),
        status: Status::FeasibleWithBound,
        optimality: Some(search::OptimalityReport {
            proven: false,
            scope: format!(
                "鲁棒优化（度量={}，情景数={}）：{}；均值 {:.1} 秒/天，最坏 {:.1}，CVaR(α={}) {:.1}",
                final_report.measure,
                scenarios.len(),
                "不含最优性证明，只保证方案在声明情景集下被评价过",
                final_report.mean,
                final_report.worst,
                final_report.alpha,
                final_report.cvar,
            ),
            bound: None,
            gap: None,
            method: "情景集内的邻域改良（鲁棒目标）".to_string(),
        }),
    }
}

/// 动态事件对库位方案的影响（供 `dynamic` 模块与面板共用）。
pub fn event_impact(_model: &SlottingModel, events: &[DynamicEvent]) -> Vec<(String, String, f64)> {
    events
        .iter()
        .map(|event| {
            let detail = match event.kind.as_str() {
                "demand-shift" => format!("需求整体偏移 {:.0}%", (event.value - 1.0) * 100.0),
                "urgent-inbound" => format!("{} 个货物单元临时入库", event.tasks.len().max(1)),
                "aisle-closure" | "location-freeze" => format!(
                    "冻结/关闭 {} 个库位或巷道",
                    event.location_ids.len().max(event.link_ids.len())
                ),
                "device-breakdown" => format!("设备故障：{}", event.device_ids.join(",")),
                other => format!("事件 {other}"),
            };
            (event.kind.clone(), detail, round(event.at_s, 1))
        })
        .collect()
}

/// 供报告使用：把"当前布局 vs 鲁棒方案"的迁移代价单独算清楚。
pub fn relocation_of(model: &mut SlottingModel, state: &SlottingState) -> (usize, f64) {
    let mut count = 0usize;
    let mut seconds = 0.0;
    for lu in 0..state.loc_of_lu.len() {
        let (moved, secs) = relocation_contribution(model, lu, state.loc_of_lu[lu]);
        if moved {
            count += 1;
            seconds += secs;
        }
    }
    (count, seconds)
}
