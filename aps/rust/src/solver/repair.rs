//! 局部修复（局部搜索）：
//!
//! * **ruin & recreate**：随机/按延期贡献挑选若干订单，整单移除后按最早可行落位重新插入，
//!   只有目标值严格变好才保留（否则完整回滚）；
//! * **左移紧致化**：把工序尽量提前（单调不恶化目标）；
//! * **随机重启**：停滞若干轮后用随机订单顺序重建整表，跳出局部最优。
//!
//! 所有随机性来自 `Rng`（`seed` 决定）；固定迭代次数时结果完全可复现。

use super::{dispatch, Rng, SearchConfig, SearchOutcome};
use crate::compile::Compiled;
use crate::objective::{self, ObjectiveValue};
use crate::schedule::{Assign, Budget, Schedule};

/// 停滞多少轮后触发整表随机重启。
const STALL_BEFORE_RESTART: usize = 60;
/// 每多少轮做一次左移紧致化。
const LEFT_SHIFT_PERIOD: usize = 12;

/// 在给定可行解上做局部修复，返回改进后的解。
pub fn improve(
    c: &Compiled,
    mut state: (Schedule, ObjectiveValue),
    lower_bound: i64,
    cfg: &SearchConfig,
    budget: &Budget,
    rng: &mut Rng,
    out: &mut SearchOutcome,
) -> (Schedule, ObjectiveValue) {
    if c.orders.is_empty() {
        return state;
    }
    let pref: Vec<u32> = (0..c.workers.len() as u32).collect();
    let mut since_improve = 0usize;
    let mut iter = 0usize;

    loop {
        if budget.expired() {
            break;
        }
        if cfg.max_iterations > 0 && iter >= cfg.max_iterations {
            break;
        }
        // 已证明最优（加权延期=0 且 makespan 达到下界）：立即停止，不浪费预算
        if super::is_proven_optimal(&state.1, lower_bound) {
            break;
        }
        iter += 1;
        out.iterations += 1;

        if since_improve >= STALL_BEFORE_RESTART {
            // 整表随机重启：换一个订单投放顺序重建
            let mut seq: Vec<usize> = (0..c.orders.len()).collect();
            rng.shuffle(&mut seq);
            if let Some(s) = dispatch::dispatch_with_sequence(c, &seq) {
                if let Some(v) = objective::evaluate(c, &s) {
                    out.restarts += 1;
                    if v.is_better_than(&state.1, cfg.strategy) {
                        state = (s, v);
                        since_improve = 0;
                        continue;
                    }
                }
            }
            since_improve = 0;
            continue;
        }

        if iter % LEFT_SHIFT_PERIOD == 0 {
            let improved = state.0.left_shift_all(c, &pref, budget);
            if improved {
                if let Some(v) = objective::evaluate(c, &state.0) {
                    if v.is_better_than(&state.1, cfg.strategy) {
                        state.1 = v;
                        since_improve = 0;
                        continue;
                    }
                    state.1 = v; // 目标不变或字典序相等也应刷新
                }
            }
        }

        // ---- ruin & recreate ----
        let victims = pick_victims(c, &state.0, rng);
        let mut saved: Vec<(usize, Option<Assign>)> = Vec::new();
        for oi in victims.iter() {
            for &op in c.orders[*oi].ops.iter() {
                saved.push((op, state.0.unplace(c, op)));
            }
        }
        // 按全局拓扑序重插（保证跨订单前置）
        let victim_set: Vec<bool> = {
            let mut v = vec![false; c.orders.len()];
            for oi in victims.iter() {
                v[*oi] = true;
            }
            v
        };
        let mut inserted_all = true;
        for &op in c.topo.iter() {
            if !victim_set[c.ops[op].order] {
                continue;
            }
            let est = match state.0.op_ready(c, op) {
                Some(e) => e,
                None => {
                    inserted_all = false;
                    break;
                }
            };
            match state.0.earliest_placement(c, op, est, &pref) {
                Some(a) => state.0.place(c, op, a),
                None => {
                    inserted_all = false;
                    break;
                }
            }
        }

        let mut accepted = false;
        if inserted_all {
            if let Some(v) = objective::evaluate(c, &state.0) {
                if v.is_better_than(&state.1, cfg.strategy) {
                    state.1 = v;
                    accepted = true;
                    since_improve = 0;
                }
            }
        }
        if !accepted {
            // 完整回滚
            for (op, a) in saved.iter() {
                if state.0.assign[*op].is_some() {
                    state.0.unplace(c, *op);
                }
                if let Some(assign) = a {
                    state.0.place(c, *op, *assign);
                }
            }
            since_improve += 1;
        }
    }
    state
}

/// 选出被移除的订单：一半概率按加权延期贡献选（针对性修复），一半随机（多样性）。
fn pick_victims(c: &Compiled, s: &Schedule, rng: &mut Rng) -> Vec<usize> {
    let n = c.orders.len();
    let k = 1 + rng.below(3.min(n));
    let mut victims: Vec<usize> = Vec::with_capacity(k);
    let by_urgency = rng.below(2) == 0;
    if by_urgency {
        let mut scored: Vec<(i64, usize)> = (0..n)
            .map(|oi| {
                let late = s
                    .order_completion(c, oi)
                    .map(|fin| (fin - c.orders[oi].due).max(0))
                    .unwrap_or(0);
                (c.orders[oi].priority * (late + 1), oi)
            })
            .collect();
        scored.sort_by(|a, b| b.cmp(a));
        for (_, oi) in scored.into_iter().take(k) {
            victims.push(oi);
        }
    } else {
        while victims.len() < k {
            let oi = rng.below(n);
            if !victims.contains(&oi) {
                victims.push(oi);
            }
        }
    }
    victims
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;
    use crate::solver::{search, Rule, SearchConfig};

    fn load(rel: &str) -> Compiled {
        let text =
            std::fs::read_to_string(format!("{}/../{}", env!("CARGO_MANIFEST_DIR"), rel)).unwrap();
        let j = json::parse(&text).unwrap();
        let p = crate::model::parse_problem(&j).0.unwrap();
        crate::compile::compile(&p, "h".to_string())
    }

    #[test]
    fn repair_never_worsens_objective() {
        let c = load("mock/baseline.json");
        let mut rng = Rng::new(11);
        let s = dispatch::dispatch(&c, Rule::PriorityEdd, &mut rng).unwrap();
        let v = objective::evaluate(&c, &s).unwrap();
        let cfg = SearchConfig {
            time_limit_ms: 1_000_000,
            seed: 11,
            max_iterations: 120,
            ..Default::default()
        };
        let budget = Budget::new(cfg.time_limit_ms, Default::default());
        let mut out = SearchOutcome::default();
        let lb = objective::makespan_lower_bound(&c);
        let (s2, v2) = improve(&c, (s, v), lb, &cfg, &budget, &mut rng, &mut out);
        assert!(s2.is_complete());
        assert!(
            v2.is_better_than(&v, cfg.strategy) || v2 == v,
            "局部修复不得恶化目标：{:?} → {:?}",
            v,
            v2
        );
        // 修复后仍然完全可行
        assert_eq!(crate::schedule::overlap_violation(&c, &s2), None);
        assert_eq!(crate::schedule::ledger_violation(&c, &s2), None);
        assert!(out.iterations > 0);
    }

    #[test]
    fn repair_improves_or_keeps_on_material_delay() {
        let c = load("mock/material-delay.json");
        let cfg = SearchConfig {
            time_limit_ms: 2_000,
            seed: 5,
            ..Default::default()
        };
        let out = search(&c, &cfg, &Budget::new(cfg.time_limit_ms, Default::default()));
        let (s, v) = out.best.expect("缺料场景应在 2 秒内找到可行解");
        assert!(s.is_complete());
        assert!(v.weighted_tardiness >= 0);
        assert_eq!(crate::schedule::ledger_violation(&c, &s), None);
    }
}
