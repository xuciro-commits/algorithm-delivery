//! 目标函数（APS-SRS §3）：
//!
//! * `completion(order) = max(terminal op end)`
//! * `tardiness(order) = max(0, completion - due_at)`
//! * 第一阶段 `Σ priority · tardiness`（加权延期分钟）
//! * 第二阶段 `makespan = max(end[all])`（在不恶化第一阶段的前提下）
//!
//! `lexicographic` 策略按 (加权延期, makespan) 字典序比较；
//! `makespan` 策略按 (makespan, 加权延期) 比较（作为对照策略，SRS 要求乙方提供）。

use crate::compile::{Compiled, Min};
use crate::json::Json;
use crate::schedule::Schedule;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strategy {
    Lexicographic,
    Makespan,
}

impl Strategy {
    pub fn parse(s: &str) -> Option<Strategy> {
        match s {
            "lexicographic" => Some(Strategy::Lexicographic),
            "makespan" => Some(Strategy::Makespan),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Strategy::Lexicographic => "lexicographic",
            Strategy::Makespan => "makespan",
        }
    }
}

/// 目标值（同时报告全过程，便于方案比较与审计）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ObjectiveValue {
    pub weighted_tardiness: i64,
    pub makespan: i64,
    pub total_tardiness: i64,
    pub max_tardiness: i64,
    pub late_orders: usize,
}

impl ObjectiveValue {
    /// 字典序比较键（越小越好）。
    pub fn key(&self, strategy: Strategy) -> (i64, i64) {
        match strategy {
            Strategy::Lexicographic => (self.weighted_tardiness, self.makespan),
            Strategy::Makespan => (self.makespan, self.weighted_tardiness),
        }
    }

    pub fn is_better_than(&self, other: &ObjectiveValue, strategy: Strategy) -> bool {
        self.key(strategy) < other.key(strategy)
    }

    pub fn to_json(&self, strategy: Strategy, best_bound: Option<i64>, gap: Option<f64>) -> Json {
        Json::obj(vec![
            ("strategy", Json::str(strategy.as_str())),
            (
                "weighted_tardiness_minutes",
                Json::int(self.weighted_tardiness),
            ),
            ("makespan_minutes", Json::int(self.makespan)),
            ("total_tardiness_minutes", Json::int(self.total_tardiness)),
            ("max_tardiness_minutes", Json::int(self.max_tardiness)),
            ("late_orders", Json::int(self.late_orders as i64)),
            ("best_bound", Json::opt_int(best_bound)),
            ("relative_gap", match gap {
                Some(g) => Json::Float(g),
                None => Json::Null,
            }),
        ])
    }
}

/// 计算目标值；若有工序未排入则返回 `None`（不虚报完成）。
pub fn evaluate(c: &Compiled, s: &Schedule) -> Option<ObjectiveValue> {
    if !s.is_complete() {
        return None;
    }
    let mut weighted = 0i64;
    let mut total = 0i64;
    let mut max_tard = 0i64;
    let mut late_orders = 0usize;
    for (oi, order) in c.orders.iter().enumerate() {
        let completion = s.order_completion(c, oi)?;
        let tard = (completion - order.due).max(0);
        if tard > 0 {
            late_orders += 1;
        }
        weighted += order.priority * tard;
        total += tard;
        max_tard = max_tard.max(tard);
    }
    let makespan: Min = s
        .assign
        .iter()
        .filter_map(|a| a.map(|x| x.end))
        .max()
        .unwrap_or(0);
    Some(ObjectiveValue {
        weighted_tardiness: weighted,
        makespan,
        total_tardiness: total,
        max_tardiness: max_tard,
        late_orders,
    })
}

/// makespan 的**有效下界**（弱下界，用于报告 `best_bound`、`relative_gap` 与最优性证明）。
///
/// 定义（按拓扑序递推，作用于每道工序的“任何可行排程下的最早完工下界”）：
///
/// ```text
/// alone_start(o) = min over 备选机器 a ∈ alternatives(o):
///                     在该机器 available 扣除 blocked 后的窗口上、以 min duration
///                     单独占机时的最早可开工时刻（≥ release(order)）
/// b(o) = max( release(order), max_{p ∈ preds(o)} b(p), alone_start(o) ) + min_duration(o)
/// LB   = min( max_o b(o), 计划时域长度 )
/// ```
///
/// 正确性：H02 要求 `start ≥ release` 且 `start ≥ end(pred)`；H01/H03/H04 要求所选时长
/// 不短于 `min_duration` 且完整落在某机器的可用窗口内，因此任何可行排程中
/// `start(o) ≥ alone_start(o)`、`end(o) ≥ b(o)`，故 `makespan ≥ max_o b(o) = LB`。
/// 推导只做**放松**：忽略机器/人员/工装/物料竞争与时长选择的耦合，故 LB 是弱下界（≤ 真最优）。
///
/// 最优性判据（`solver::is_proven_optimal`）：当解满足“加权延期 = 0 且 makespan = LB”时，
/// 两个目标分量同时取到各自下界，该解可**证明**最优，引擎此时才返回 `OPTIMAL`。
pub fn makespan_lower_bound(c: &Compiled) -> i64 {
    let mut b: Vec<i64> = vec![0; c.ops.len()];
    for &op in c.topo.iter() {
        let o = &c.ops[op];
        let mut alone_start = i64::MAX;
        for alt in o.alts.iter() {
            if alt.duration < o.min_dur {
                continue;
            }
            let windows = &c.machines[alt.machine].windows;
            if let Some(s) =
                crate::calendar::earliest_slot(windows, &[], alt.duration, o.release.max(0))
            {
                alone_start = alone_start.min(s);
            }
        }
        if alone_start == i64::MAX {
            // 无任何单独可落位的备选（由编译期证书处理）：不使用该工序抬升下界，避免夸大
            b[op] = o.preds.iter().map(|p| b[*p]).max().unwrap_or(0);
            continue;
        }
        let preds_max = o.preds.iter().map(|p| b[*p]).max().unwrap_or(0);
        let start_lb = o.release.max(0).max(preds_max).max(alone_start);
        b[op] = start_lb + o.min_dur;
    }
    b.iter().copied().max().unwrap_or(0).min(c.meta.horizon_len_min)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;
    use crate::schedule::Schedule;

    fn load(rel: &str) -> Compiled {
        let text =
            std::fs::read_to_string(format!("{}/../{}", env!("CARGO_MANIFEST_DIR"), rel)).unwrap();
        let j = json::parse(&text).unwrap();
        let p = crate::model::parse_problem(&j).0.unwrap();
        crate::compile::compile(&p, "h".to_string())
    }

    #[test]
    fn incomplete_schedule_has_no_objective() {
        let c = load("mock/baseline.json");
        let s = Schedule::new(&c);
        assert_eq!(evaluate(&c, &s), None);
    }

    #[test]
    fn strategy_keys_are_lexicographic() {
        let a = ObjectiveValue {
            weighted_tardiness: 10,
            makespan: 100,
            ..Default::default()
        };
        let b = ObjectiveValue {
            weighted_tardiness: 10,
            makespan: 90,
            ..Default::default()
        };
        let c_val = ObjectiveValue {
            weighted_tardiness: 11,
            makespan: 10,
            ..Default::default()
        };
        assert!(b.is_better_than(&a, Strategy::Lexicographic));
        assert!(!c_val.is_better_than(&a, Strategy::Lexicographic));
        assert!(c_val.is_better_than(&a, Strategy::Makespan));
    }

    #[test]
    fn lower_bound_is_valid_on_baseline() {
        let c = load("mock/baseline.json");
        let lb = makespan_lower_bound(&c);
        // 关键链：CUT 30 + WELD 45 + PAINT 30 = 105（订单内串行下界，忽略产能竞争）
        assert!(lb >= 105, "下界 {} 应至少覆盖单订单关键链", lb);
        assert!(lb <= c.meta.horizon_len_min);
    }
}
