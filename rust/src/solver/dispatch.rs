//! 构造式排程（串行调度生成 + 空档插入）。
//!
//! 流程：按派工规则排出**订单投放顺序** → 依次把每个订单的工序按工艺拓扑序
//! 插入到“最早可行落位”（可插入已有排程的时间空档，而不是简单追加到末尾）。
//! 每一步落位都完整检查 H01–H07；跨订单前置（装配场景）通过“就绪轮询”保证先后关系。

use super::{Rng, Rule};
use crate::compile::Compiled;
use crate::schedule::Schedule;

/// 由规则生成订单顺序（确定性；仅 `Random` 使用 `rng`）。
pub fn order_sequence(c: &Compiled, rule: Rule, rng: &mut Rng) -> Vec<usize> {
    let n = c.orders.len();
    let mut seq: Vec<usize> = (0..n).collect();
    if rule == Rule::Random {
        rng.shuffle(&mut seq);
        return seq;
    }
    let work = |oi: usize| -> i64 {
        c.orders[oi]
            .ops
            .iter()
            .map(|op| c.ops[*op].min_dur)
            .sum::<i64>()
    };
    let key = |oi: usize| -> (i64, i64, i64) {
        let o = &c.orders[oi];
        match rule {
            // 交期优先；同交期时高优先级在前
            Rule::PriorityEdd | Rule::Auto => (o.due, -o.priority, o.release),
            // 加权最短加工时间：优先期内“工作量/优先级”小者优先
            Rule::Wspt => (o.release, work(oi) * 1000 / o.priority.max(1), o.due),
            Rule::Spt => (work(oi), o.due, o.release),
            Rule::MinEnd => (o.release, work(oi), o.due),
            // 最小松弛：due - release - 关键链工作量
            Rule::MostSlack => (o.due - o.release - work(oi), o.due, -o.priority),
            Rule::Random => (0, 0, 0),
        }
    };
    seq.sort_by_key(|oi| (key(*oi), *oi));
    seq
}

/// 按给定订单顺序构造完整排程；任一步无法落位则返回 `None`（调用方换规则/重启）。
///
/// **就绪判定是“工序级”而非“整单级”**：每轮只安排“全部前置已排入”的工序，
/// 其余留到下一轮。这样合法的跨订单工艺依赖（例如 `A1 → B1 → A2`，整体无环）
/// 不会被“订单 A 等 B、订单 B 等 A”式的整单门控永久卡死 —— 见回归测试
/// `cross_order_dependency_chain_is_schedulable`。
///
/// 对没有跨订单依赖的常见情形，首轮即可完成整单（与原行为逐字节一致）。
pub fn dispatch_with_sequence(c: &Compiled, sequence: &[usize]) -> Option<Schedule> {
    let mut s = Schedule::new(c);
    let pref: Vec<u32> = (0..c.workers.len() as u32).collect();

    let mut pending: Vec<usize> = sequence.to_vec();
    pending.dedup();
    let mut progress = true;
    while !s.is_complete() && !pending.is_empty() && progress {
        progress = false;
        // 本轮各订单的“已就绪工序”按全局拓扑序落位（保证同订单内工艺顺序）
        for oi in pending.clone() {
            for &op in c.topo.iter() {
                if c.ops[op].order != oi || s.assign[op].is_some() {
                    continue;
                }
                if !c.ops[op].preds.iter().all(|p| s.assign[*p].is_some()) {
                    continue; // 前置未就绪：留给后续轮次
                }
                let est = s.op_ready(c, op)?;
                let assign = s.earliest_placement(c, op, est, &pref)?;
                s.place(c, op, assign);
                progress = true;
            }
        }
        // 已全部落位的订单出队，避免空转
        pending.retain(|oi| c.orders[*oi].ops.iter().any(|op| s.assign[*op].is_none()));
    }
    if pending.is_empty() && s.is_complete() {
        Some(s)
    } else {
        None
    }
}

/// 按规则构造完整排程。
pub fn dispatch(c: &Compiled, rule: Rule, rng: &mut Rng) -> Option<Schedule> {
    let seq = order_sequence(c, rule, rng);
    dispatch_with_sequence(c, &seq)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;
    use crate::objective;

    fn load(rel: &str) -> Compiled {
        let text =
            std::fs::read_to_string(format!("{}/../{}", env!("CARGO_MANIFEST_DIR"), rel)).unwrap();
        let j = json::parse(&text).unwrap();
        let p = crate::model::parse_problem(&j).0.unwrap();
        crate::compile::compile(&p, "h".to_string())
    }

    #[test]
    fn every_rule_produces_feasible_schedule_on_baseline() {
        let c = load("mock/baseline.json");
        for rule in Rule::all() {
            let mut rng = Rng::new(42);
            let s = dispatch(&c, rule, &mut rng)
                .unwrap_or_else(|| panic!("规则 {} 未能排出完整计划", rule.as_str()));
            assert!(s.is_complete());
            assert_eq!(crate::schedule::overlap_violation(&c, &s), None);
            assert_eq!(crate::schedule::ledger_violation(&c, &s), None);
            let v = objective::evaluate(&c, &s).expect("完整排程必须有目标值");
            assert!(v.makespan > 0);
        }
    }

    /// 构造“A1 → B1 → A2”的合法跨订单 DAG（无环，但按整单就绪判定会永久卡死）。
    ///
    /// 订单 A = ORD-001：A1 = CUT，A2 = WELD（依赖 B1）
    /// 订单 B = ORD-002：B1 = CUT（依赖 A1）
    fn cross_order_chain_problem() -> Compiled {
        let text = std::fs::read_to_string(format!(
            "{}/../mock/baseline.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let mut j = json::parse(&text).unwrap();
        let mut set_preds = |op_id: &str, preds: Vec<&str>| {
            let orders = j.get_mut("orders").and_then(|v| v.as_arr_mut()).unwrap();
            for o in orders.iter_mut() {
                let Some(ops) = o.get_mut("operations").and_then(|v| v.as_arr_mut()) else {
                    continue;
                };
                for op in ops.iter_mut() {
                    if op.get("id").and_then(|v| v.as_str()) == Some(op_id) {
                        op.set(
                            "predecessors",
                            crate::json::Json::strings(preds.iter().copied()),
                        );
                        return;
                    }
                }
            }
            panic!("未找到工序 {op_id}");
        };
        set_preds("ORD-002-CUT", vec!["ORD-001-CUT"]); // B1 依赖 A1
        set_preds("ORD-001-WELD", vec!["ORD-001-CUT", "ORD-002-CUT"]); // A2 依赖 B1
        let p = crate::model::parse_problem(&j).0.unwrap();
        crate::compile::compile(&p, "h".to_string())
    }

    #[test]
    fn cross_order_dependency_chain_is_schedulable() {
        let c = cross_order_chain_problem();
        assert_eq!(c.topo.len(), 24, "跨订单依赖不应破坏拓扑完整性");
        for rule in Rule::all() {
            let mut rng = Rng::new(42);
            let s = dispatch(&c, rule, &mut rng)
                .unwrap_or_else(|| panic!("规则 {} 未能排出合法的跨订单依赖链", rule.as_str()));
            assert!(s.is_complete(), "规则 {} 排程不完整", rule.as_str());
            assert_eq!(crate::schedule::overlap_violation(&c, &s), None);
            assert_eq!(crate::schedule::ledger_violation(&c, &s), None);
            // 所有前置（含跨订单）必须真的满足
            for op in 0..c.ops.len() {
                let a = s.assign[op].expect("完整排程");
                for p in c.ops[op].preds.iter() {
                    let pa = s.assign[*p].expect("前置必须已排入");
                    assert!(
                        pa.end <= a.start,
                        "工序 {} 早于其前置 {}",
                        c.ops[op].id,
                        c.ops[*p].id
                    );
                }
            }
            objective::evaluate(&c, &s).expect("完整排程必须有目标值");
        }
    }

    #[test]
    fn respects_machine_breakdown_window() {
        let c = load("mock/machine-breakdown.json");
        let mut rng = Rng::new(7);
        let s = dispatch(&c, Rule::Auto, &mut rng).expect("故障场景仍应可排");
        // WELD-02 在 10-05 13:00-17:00 停机：该区间内不得有任何占用
        let weld2 = c.machines.iter().position(|m| m.id == "WELD-02").unwrap();
        let blocked = (300i64, 540i64); // 13:00 - 17:00 相对 08:00
        for (bs, be) in s.mach_busy[weld2].iter() {
            assert!(
                *be <= blocked.0 || *bs >= blocked.1,
                "占用 [{bs}, {be}) 落入 WELD-02 停机区间"
            );
        }
    }

    #[test]
    fn infeasible_fixture_yields_no_schedule() {
        let c = load("mock/infeasible-no-welder.json");
        let mut rng = Rng::new(1);
        // 焊工资格被移除：不存在可行排程
        assert!(dispatch(&c, Rule::Auto, &mut rng).is_none());
    }
}
