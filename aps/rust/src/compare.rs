//! 方案比较（APS-SRS §5.4）：基准计划 vs 候选计划的**统一口径**指标。
//!
//! 口径定义（必须写在交付文档里，避免各方各算一套）：
//!
//! * 延期：`tardiness = max(0, completion - due_at)`，`completion` 取订单全部（终端）工序的最大完工时刻；
//! * 加权延期：`Σ priority × tardiness`；
//! * makespan：全部工序的最大完工时刻 − 规划起点（分钟）；
//! * 机器利用率：`Σ 占用分钟 / Σ 可用窗口分钟`，可用窗口 = `available` 合并后扣除 `blocked`
//!   （只在时域内计算）；人员利用率同口径；
//! * 变更次数：与基准相比，`(machine_id, worker_id, start_at)` 任一不同的工序数。

use std::collections::BTreeMap;

use crate::calendar;
use crate::json::Json;
use crate::model::RawProblem;
use crate::verify::RawSolution;

/// 单个计划的统一口径摘要。
#[derive(Debug, Clone, Default)]
pub struct Summary {
    pub id: String,
    pub engine: String,
    pub status: String,
    pub verified: bool,
    pub operations: usize,
    pub weighted_tardiness: i64,
    pub makespan: i64,
    pub late_orders: usize,
    pub machine_utilization: f64,
    pub worker_utilization: f64,
    pub violations: usize,
}

impl Summary {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("id", Json::str(self.id.clone())),
            ("engine", Json::str(self.engine.clone())),
            ("status", Json::str(self.status.clone())),
            ("verified", Json::Bool(self.verified)),
            ("operations", Json::int(self.operations as i64)),
            (
                "weighted_tardiness_minutes",
                Json::int(self.weighted_tardiness),
            ),
            ("makespan_minutes", Json::int(self.makespan)),
            ("late_orders", Json::int(self.late_orders as i64)),
            (
                "machine_utilization",
                Json::Float((self.machine_utilization * 10000.0).round() / 10000.0),
            ),
            (
                "worker_utilization",
                Json::Float((self.worker_utilization * 10000.0).round() / 10000.0),
            ),
            ("violations", Json::int(self.violations as i64)),
        ])
    }
}

/// 计算计划摘要（独立于求解器；直接读原始模型与方案文本）。
pub fn summarize(problem: &RawProblem, solution: &RawSolution) -> Summary {
    let t0 = problem.meta.horizon_start_min;
    let h = problem.meta.horizon_end_min - problem.meta.horizon_start_min;
    let res = problem.meta.resolution_min;

    // 订单完工 → 延期
    let mut completion: BTreeMap<&str, i64> = BTreeMap::new();
    for op in solution.operations.iter() {
        if let (Some(s), Some(e)) = (op.start_min, op.end_min) {
            let _ = s;
            let entry = completion.entry(op.order_id.as_str()).or_insert(i64::MIN);
            *entry = (*entry).max(e);
        }
    }
    let mut weighted = 0i64;
    let mut late = 0usize;
    for order in problem.orders.iter() {
        let fin = completion.get(order.id.as_str()).copied().unwrap_or(i64::MIN);
        if fin == i64::MIN {
            continue;
        }
        let tard = (fin - order.due_min).max(0);
        if tard > 0 {
            late += 1;
        }
        weighted += order.priority * tard;
    }
    let makespan = solution
        .operations
        .iter()
        .filter_map(|op| op.end_min)
        .max()
        .map(|e| e - t0)
        .unwrap_or(0);

    // 资源利用率
    let mut machine_busy: BTreeMap<&str, i64> = BTreeMap::new();
    let mut worker_busy: BTreeMap<&str, i64> = BTreeMap::new();
    for op in solution.operations.iter() {
        if let (Some(s), Some(e)) = (op.start_min, op.end_min) {
            let dur = (e - s).max(0);
            *machine_busy.entry(op.machine_id.as_str()).or_insert(0) += dur;
            *worker_busy.entry(op.worker_id.as_str()).or_insert(0) += dur;
        }
    }
    let mut machine_capacity = 0i64;
    for m in problem.machines.iter() {
        let windows = calendar::build_windows(&m.available, &m.blocked, t0, h, res);
        machine_capacity += windows.iter().map(|w| w.len()).sum::<i64>();
    }
    let mut worker_capacity = 0i64;
    for w in problem.workers.iter() {
        let windows = calendar::build_windows(&w.available, &w.blocked, t0, h, res);
        worker_capacity += windows.iter().map(|w| w.len()).sum::<i64>();
    }
    let machine_utilization = if machine_capacity > 0 {
        machine_busy.values().sum::<i64>() as f64 / machine_capacity as f64
    } else {
        0.0
    };
    let worker_utilization = if worker_capacity > 0 {
        worker_busy.values().sum::<i64>() as f64 / worker_capacity as f64
    } else {
        0.0
    };

    Summary {
        id: solution.id.clone().unwrap_or_default(),
        engine: solution.engine.clone().unwrap_or_default(),
        status: solution.status.clone(),
        verified: solution.verified.unwrap_or(false),
        operations: solution.operations.len(),
        weighted_tardiness: weighted,
        makespan,
        late_orders: late,
        machine_utilization,
        worker_utilization,
        violations: solution
            .violations
            .as_ref()
            .and_then(|v| v.as_arr())
            .map(|a| a.len())
            .unwrap_or(0),
    }
}

/// 变更次数（相对基准）。
pub fn changed_operations(baseline: &RawSolution, candidate: &RawSolution) -> usize {
    let index: BTreeMap<&str, &crate::verify::SolutionOp> = baseline
        .operations
        .iter()
        .map(|o| (o.operation_id.as_str(), o))
        .collect();
    let mut changed = 0usize;
    for op in candidate.operations.iter() {
        match index.get(op.operation_id.as_str()) {
            Some(base) => {
                if base.machine_id != op.machine_id
                    || base.worker_id != op.worker_id
                    || base.start_at != op.start_at
                {
                    changed += 1;
                }
            }
            None => changed += 1,
        }
    }
    changed
}

/// 比较报告的 JSON。
pub fn compare_json(
    problem: &RawProblem,
    baseline: &RawSolution,
    candidates: &[RawSolution],
) -> Json {
    let base_summary = summarize(problem, baseline);
    let mut items: Vec<Json> = Vec::new();
    for cand in candidates {
        let s = summarize(problem, cand);
        items.push(Json::obj(vec![
            ("summary", s.to_json()),
            (
                "delta_vs_baseline",
                Json::obj(vec![
                    (
                        "weighted_tardiness_minutes",
                        Json::int(s.weighted_tardiness - base_summary.weighted_tardiness),
                    ),
                    (
                        "makespan_minutes",
                        Json::int(s.makespan - base_summary.makespan),
                    ),
                    (
                        "late_orders",
                        Json::int(s.late_orders as i64 - base_summary.late_orders as i64),
                    ),
                    (
                        "changed_operations",
                        Json::int(changed_operations(baseline, cand) as i64),
                    ),
                    (
                        "machine_utilization",
                        Json::Float(
                            ((s.machine_utilization - base_summary.machine_utilization) * 10000.0)
                                .round()
                                / 10000.0,
                        ),
                    ),
                ]),
            ),
        ]));
    }
    Json::obj(vec![
        ("baseline", base_summary.to_json()),
        ("candidates", Json::Arr(items)),
        (
            "utilization_definition",
            Json::str("机器/人员利用率 = Σ占用分钟 / Σ(available 合并后扣除 blocked 的窗口分钟，仅时域内)"),
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;

    fn problem(rel: &str) -> RawProblem {
        let text =
            std::fs::read_to_string(format!("{}/../{}", env!("CARGO_MANIFEST_DIR"), rel)).unwrap();
        let j = json::parse(&text).unwrap();
        crate::model::parse_problem(&j).0.unwrap()
    }

    fn solution(rel: &str) -> RawSolution {
        let text =
            std::fs::read_to_string(format!("{}/../{}", env!("CARGO_MANIFEST_DIR"), rel)).unwrap();
        let j = json::parse(&text).unwrap();
        crate::verify::parse_solution(&j).0.unwrap()
    }

    #[test]
    fn witness_summary_is_consistent() {
        let p = problem("mock/baseline.json");
        let wit = solution("tests/baseline-feasible-witness.json");
        let s = summarize(&p, &wit);
        assert_eq!(s.operations, 24);
        assert_eq!(s.status, "FEASIBLE");
        assert!(s.makespan > 0);
        assert!(s.weighted_tardiness >= 0);
        assert!(s.machine_utilization > 0.0 && s.machine_utilization <= 1.0);
        assert!(s.worker_utilization > 0.0 && s.worker_utilization <= 1.0);
    }

    #[test]
    fn changed_operations_zero_for_same_solution() {
        let wit = solution("tests/baseline-feasible-witness.json");
        assert_eq!(changed_operations(&wit, &wit), 0);
    }
}
