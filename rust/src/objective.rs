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
            (
                "relative_gap",
                match gap {
                    Some(g) => Json::Float(g),
                    None => Json::Null,
                },
            ),
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

/// makespan 的**有效下界**（用于报告 `best_bound` / `relative_gap`，并作为最优性证明的依据）。
///
/// 取以下三类放松下界的较大者，三者都必须各自有效（见各自函数文档与测试）：
///   1) [`path_lower_bound`]：拓扑路径递推，含 release、单机窗口与 blocked 空档；
///   2) [`capacity_lower_bound`]：按机器池产能分组，并纳入**物料到货门槛**的背包推理；
///   3) [`flow_lower_bound`]：按真实日历累加的“投放节奏 × 机器可用分钟”流量下界。
///
/// 不使用 horizon 截断。判定最优（`solver::is_proven_optimal`）要求可行解达到本下界。
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
    path_lower_bound(c)
        .max(capacity_lower_bound(c))
        .max(flow_lower_bound(c))
}

/// 仅使用“路径递推”的那部分下界（含 release、单机窗口与 blocked 空档）。
///
/// 见 [`makespan_lower_bound`] 的完整说明；单独暴露出来是为了让测试与验收脚本
/// 能逐项验证三类下界各自的有效性（分别不得高于任何可行解）。
pub fn path_lower_bound(c: &Compiled) -> i64 {
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
    // 路径递推本身即为有效下界（不截断到 horizon：结构性下界超过时域恰恰说明实例不可行）
    b.iter().copied().max().unwrap_or(0)
}

/// **资源产能下界（含物料到货门槛）**：把工序按“技能 + 资格要求 + 备选机器集合”分组，
/// 每组内所有工序共享同一机器池，于是可以在“只看机器、忽略人员/日历/前置”的放松下做产能推理。
///
/// ```text
/// 组 g：W = Σ min_duration(o)，M = |机器池(g)|
/// (1) 纯产能：            LB_g ≥ ⌈W / M⌉
/// (2) 物料到货门槛：对每个到货时刻 T（以及初始库存）
///       Avail(T) = 初始库存 + Σ{到货时刻 < T 的数量}
///       KnapMax(A) = 组内需料工序在“数量之和 ≤ A”下能取到的最大工时（0/1 背包）
///       LB_g ≥ T + ⌈(W − KnapMax(Avail(T))) / M⌉
/// ```
///
/// 正确性论证：
/// * 领料语义是**开工即领、不退回**（`ledger::replay_material` 按 `start` 记账），
///   因此任意时刻的累计领料量单调不减且不超过累计到货量；
/// * 于是在 `T` 之前开工的工序，其数量之和 ≤ `Avail(T)`（到货时刻严格早于 `T` 的部分），
///   故这些工序的工时之和 ≤ `KnapMax(Avail(T))`；
/// * 其余工序只能在 `≥ T` 开工；若该集合非空（即 `KnapMax < W`），则这些工序的工时
///   必须占用机器池 `M` 台机器在 `T` 之后的可用时间 → 从 `T` 到完工至少还需 `⌈剩余工时 / M⌉`；
///   反之若 `KnapMax = W`，则无法断定有工序在 `≥ T` 开工，此时**不使用**该 T（否则会得到无效下界）；
/// * 放松掉人员、日历、前置关系只会低估耗时，故结果是 makespan 的**有效下界**。
///
/// 该下界把“交期/物料到货/瓶颈产能”三类成因都纳入，明显强于纯路径递推。
pub fn capacity_lower_bound(c: &Compiled) -> i64 {
    use std::collections::BTreeMap;
    // 组键 = (技能, 资格, 备选机器集合) —— 同组共用机器池，故 M 取池大小是有效的
    let mut groups: BTreeMap<(String, Vec<String>, Vec<usize>), Vec<usize>> = BTreeMap::new();
    for (op_i, op) in c.ops.iter().enumerate() {
        let mut quals = op.quals.clone();
        quals.sort();
        let mut machines: Vec<usize> = op.alts.iter().map(|a| a.machine).collect();
        machines.sort_unstable();
        machines.dedup();
        groups
            .entry((op.skill.clone(), quals, machines))
            .or_default()
            .push(op_i);
    }

    let mut lb: i64 = 0;
    for ((_skill, _quals, machines), ops) in groups.iter() {
        let m = machines.len().max(1) as i64;
        let total_work: i64 = ops.iter().map(|&i| c.ops[i].min_dur).sum();
        let mut group_lb = div_ceil(total_work, m);

        // 本组涉及的物料 → 到货时刻
        let mut mats: BTreeMap<usize, Vec<(Min, i64)>> = BTreeMap::new();
        for &i in ops.iter() {
            for (mi, _qty) in c.ops[i].materials.iter() {
                mats.entry(*mi)
                    .or_insert_with(|| c.materials[*mi].receipts.clone());
            }
        }
        for (mi, _) in mats.iter() {
            let mat = &c.materials[*mi];
            // 该物料在各到货时刻的“严格早于 T 的累计可用量”
            let mut thresh: Vec<(Min, i64)> = Vec::new();
            let mut acc = mat.initial;
            for (at, qty) in mat.receipts.iter() {
                thresh.push((*at, acc)); // T = at 时，只有 at' < at 的到货可用
                acc += qty;
            }
            let _ = acc;
            for (t, avail) in thresh {
                if t <= 0 {
                    continue;
                }
                // 组内需料工序：0/1 背包（价值 = min_dur，重量 = 数量）
                let items: Vec<(i64, i64)> = ops
                    .iter()
                    .filter_map(|&i| {
                        c.ops[i]
                            .materials
                            .iter()
                            .find(|(k, _)| *k == *mi)
                            .map(|(_, q)| (c.ops[i].min_dur, *q))
                    })
                    .filter(|(_, q)| *q > 0)
                    .collect();
                if items.is_empty() {
                    continue;
                }
                let knap = knapsack_max_work(&items, avail.max(0));
                let remaining = (total_work - knap).max(0);
                // remaining == 0 时只能推出“所有工时都可能已开工”，推不出与 T 有关的结论；
                // 只有 remaining > 0 才能断定“至少有一道工序在 ≥ T 开工”，此时下界有效。
                if remaining > 0 {
                    group_lb = group_lb.max(t + div_ceil(remaining, m));
                }
            }
        }
        lb = lb.max(group_lb);
    }
    lb
}

/// **日历产能流量下界**：把“订单投放节奏 + 机器日历可用性”一起纳入的更强下界。
///
/// ```text
/// 分组 g（技能 + 资格 + 机器池；与 capacity_lower_bound 相同的分组键）
/// 对每个候选投放时刻 R（各订单 release 去重，≥ 0）：
///   W_g(R) = 组内“订单投放时刻 ≥ R”的工序的 min_duration 之和
///   cap_g(t) = Σ_{机器 ∈ 池(g)} (该机器在 [R, t] 内可用分钟数)
///   LB_g(R) = min{ t ≥ R : cap_g(t) ≥ W_g(R) }
/// LB = max over g, R of LB_g(R)
/// ```
///
/// 正确性（**关键点：只能对“投放不早于 R”的工时收费**）：投放时刻 ≥ `R` 的工序在任意可行
/// 排程中都不可能早于 `R` 开工，因此它们的全部工时必须落在 `[R, makespan]` 内；这些工时只能占用
/// 机器池中各机器自己的可用窗口（`blocked` 已在编译期扣除），且每台机器同一时刻至多一道工序。
/// 于是一旦累计可用分钟数达到 `W_g(R)`，完工时刻就不可能更早。
/// 忽略人员、工装、物料、前置关系与时长选择只会**高估**可用产能 → 结果仍是有效下界。
///
/// 反例警示（本函数最初写错过）：若改用“投放 ≤ R 的工时之和”并把它全部计入 `[R, makespan]`，
/// 会**高估**下界（那些工序可能在 R 之前就已加工），甚至出现“下界 > 可行解”的无效结果。
///
/// 与 `capacity_lower_bound` 的关系：后者假设机器 7×24 可用，本函数按真实日历累加，
/// 因此在“每天仅两班 8 小时”的场景会显著抬高下界。
///
/// 边界：若窗口内累计产能不足以覆盖工时（模型内不可行或几乎不可行），返回最后一个窗口
/// 结束时刻——此时下界依然有效（完工不可能早于可用窗口的最后结束时刻）。
pub fn flow_lower_bound(c: &Compiled) -> i64 {
    use std::collections::BTreeMap;
    let mut groups: BTreeMap<(String, Vec<String>, Vec<usize>), Vec<usize>> = BTreeMap::new();
    for (op_i, op) in c.ops.iter().enumerate() {
        let mut quals = op.quals.clone();
        quals.sort();
        let mut machines: Vec<usize> = op.alts.iter().map(|a| a.machine).collect();
        machines.sort_unstable();
        machines.dedup();
        groups
            .entry((op.skill.clone(), quals, machines))
            .or_default()
            .push(op_i);
    }

    // 候选投放时刻（去重升序，≥ 0）
    let mut releases: Vec<Min> = c.orders.iter().map(|o| o.release.max(0)).collect();
    releases.sort_unstable();
    releases.dedup();

    let mut lb: i64 = 0;
    for ((_skill, _quals, machines), ops) in groups.iter() {
        let windows: Vec<&Vec<crate::calendar::Interval>> =
            machines.iter().map(|&m| &c.machines[m].windows).collect();
        for r in releases.iter() {
            let w: i64 = ops
                .iter()
                .filter(|&&i| c.orders[c.ops[i].order].release.max(0) >= *r)
                .map(|&i| c.ops[i].min_dur)
                .sum();
            if w <= 0 {
                continue;
            }
            lb = lb.max(earliest_capacity_completion(&windows, *r, w));
        }
    }
    lb
}

/// 从 `t0` 起，按各机器自身可用窗口累计“机器分钟数”，求达到 `work` 的最早时刻。
fn earliest_capacity_completion(
    windows: &[&Vec<crate::calendar::Interval>],
    t0: Min,
    work: i64,
) -> Min {
    if work <= 0 {
        return t0;
    }
    // (时刻, 活跃机器数增量)：同一时刻先关闭再开启（-1 排在 +1 前）
    let mut points: Vec<(Min, i64)> = Vec::new();
    for ws in windows.iter() {
        for w in ws.iter() {
            let s = w.s.max(t0);
            if w.e <= s {
                continue;
            }
            points.push((s, 1));
            points.push((w.e, -1));
        }
    }
    points.sort_unstable();
    let mut active: i64 = 0;
    let mut acc: i64 = 0;
    let mut prev = t0;
    for (t, delta) in points {
        if active > 0 && t > prev {
            let cap = active * (t - prev);
            if acc + cap >= work {
                // 区间内达到目标：按连续速率插值（向下取整，保持保守）
                return prev + (work - acc) / active;
            }
            acc += cap;
        }
        active += delta;
        prev = prev.max(t);
    }
    // 产能不足以覆盖工时：完工不可能早于最后一个窗口结束
    prev
}

/// `Σ重量 ≤ cap` 约束下能取到的最大价值（0/1 背包；数量为整数）。
///
/// 重量（物料数量）可能很大，故对容量做截断：容量 ≤ 总重量时用 DP，否则全取。
fn knapsack_max_work(items: &[(i64, i64)], cap: i64) -> i64 {
    let total_w: i64 = items.iter().map(|(_, w)| *w).sum();
    if total_w <= cap {
        return items.iter().map(|(v, _)| *v).sum();
    }
    const LIMIT: i64 = 200_000;
    if cap > LIMIT {
        // 容量远超实际需要：用价值/重量比贪心的分数背包上界（≥ 整数最优，仍为有效上界）
        let mut ratio: Vec<(f64, i64, i64)> = items
            .iter()
            .map(|(v, w)| (*v as f64 / *w as f64, *v, *w))
            .collect();
        ratio.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let mut left = cap;
        let mut value = 0.0f64;
        for (r, _v, w) in ratio {
            if left <= 0 {
                break;
            }
            let take = w.min(left);
            value += r * take as f64;
            left -= take;
        }
        return value.ceil() as i64;
    }
    let cap = cap.max(0) as usize;
    let mut dp = vec![0i64; cap + 1];
    for (v, w) in items.iter() {
        let w = *w as usize;
        if w > cap {
            continue;
        }
        for j in (w..=cap).rev() {
            let cand = dp[j - w] + v;
            if cand > dp[j] {
                dp[j] = cand;
            }
        }
    }
    dp[cap]
}

fn div_ceil(a: i64, b: i64) -> i64 {
    if b <= 0 {
        a
    } else {
        (a + b - 1) / b
    }
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
    fn capacity_bound_is_valid_and_tighter_on_contention() {
        use crate::benchgen;
        let text = std::fs::read_to_string(format!(
            "{}/../mock/baseline.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let base = json::parse(&text).unwrap();
        // 竞争型：8 个订单共用同一套资源（喷涂只有 1 台机器）
        let coupled = benchgen::build_coupled(&base, 8, 42).unwrap();
        let p = crate::model::parse_problem(&coupled).0.unwrap();
        let c = crate::compile::compile(&p, "h".to_string());
        let cap = capacity_lower_bound(&c);
        let path = makespan_lower_bound(&c);
        // 喷涂：8 道 × 30 分钟 / 1 台机器 = 240 分钟（产能下界）
        assert!(cap >= 240, "产能下界 {cap} 应至少覆盖单机瓶颈 240 分钟");
        assert!(path >= cap, "makespan_lower_bound 应取两者较大者");
        // 有效性：任何可行解的 makespan 必须 ≥ 下界
        let mut rng = crate::solver::Rng::new(42);
        let s = crate::solver::dispatch::dispatch(&c, crate::solver::Rule::PriorityEdd, &mut rng)
            .expect("竞争型小实例应可排程");
        let v = evaluate(&c, &s).unwrap();
        assert!(
            v.makespan >= cap,
            "下界 {} 超过实际可行 makespan {}，说明下界无效",
            cap,
            v.makespan
        );
    }

    /// **下界有效性对抗测试**（单机 + 单人员 + 物料到货门槛 + 多订单不同投放时刻）。
    ///
    /// 在单机下最优解必为某个“订单间交错顺序”，因此用 DFS 枚举全部交错、按 ASAP 求完工时刻，
    /// 即得到**真实最优** makespan；再要求
    ///   (1) 下界 ≤ 真实最优，
    ///   (2) 引擎自己排出的解 ≥ 真实最优（模型语义一致），且 ≥ 下界。
    /// 实例由 `mock/baseline.json` 克隆改写（保证契约字段齐全），机器/人员窗口连续覆盖全时域。
    #[test]
    fn material_bound_never_exceeds_brute_force_optimum() {
        let base_text = std::fs::read_to_string(format!(
            "{}/../mock/baseline.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let base = json::parse(&base_text).unwrap();
        let tpl_op = base
            .get("orders")
            .and_then(|v| v.as_arr())
            .and_then(|o| o.first())
            .and_then(|o| o.get("operations"))
            .and_then(|v| v.as_arr())
            .and_then(|o| o.first())
            .cloned()
            .expect("基线工序模板");

        let mut checked = 0;
        let mut engine_checked = 0;
        for seed in 0..80u64 {
            let mut st = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
            let mut rnd = move |n: u64| -> u64 {
                st ^= st << 13;
                st ^= st >> 7;
                st ^= st << 17;
                st % n
            };

            // ---- 随机实例：1..3 个订单，每单 1..2 道链式工序（单机单人员） ----
            let n_orders = 1 + rnd(3) as usize;
            let mut per_order: Vec<Vec<(i64, i64)>> = Vec::new(); // (数量, 时长)
            let mut release: Vec<i64> = Vec::new();
            for k in 0..n_orders {
                let n_ops = 1 + rnd(2) as usize;
                per_order.push(
                    (0..n_ops)
                        .map(|_| (1 + rnd(3) as i64, 15 * (1 + rnd(4) as i64)))
                        .collect(),
                );
                release.push(if k == 0 {
                    0
                } else {
                    120 * k as i64 + 15 * rnd(5) as i64
                });
            }
            let initial = rnd(3) as i64; // 初始库存 0..2
            let mut receipts: Vec<(i64, i64)> = (0..1 + rnd(3))
                .map(|i| ((i as i64 + 2) * 120, 1 + rnd(4) as i64))
                .collect();
            receipts.sort_unstable();
            let demand: i64 = per_order
                .iter()
                .flat_map(|v| v.iter().map(|(q, _)| *q))
                .sum();
            let supply: i64 = initial + receipts.iter().map(|(_, q)| *q).sum::<i64>();
            if supply < demand {
                let at = receipts.last().map(|(t, _)| *t + 120).unwrap_or(120);
                receipts.push((at, demand - supply));
            }

            // ---- 构造问题 JSON ----
            let zero = crate::datetime::parse_to_epoch_min("2026-10-05T08:00:00-07:00").unwrap();
            let horizon = 1440 * 6;
            let iso = |m: i64| Json::str(crate::datetime::format_iso8601(zero + m, -420));
            let avail = Json::Arr(vec![Json::obj(vec![
                ("start", iso(0)),
                ("end", iso(horizon)),
            ])]);
            let mut orders_json: Vec<Json> = Vec::new();
            for (k, ops) in per_order.iter().enumerate() {
                let ops_json: Vec<Json> = ops
                    .iter()
                    .enumerate()
                    .map(|(i, (q, d))| {
                        let mut op = tpl_op.clone();
                        op.set("id", Json::str(format!("OP{k}_{i}")));
                        op.set("skill", Json::str("cut"));
                        op.set(
                            "predecessors",
                            Json::Arr(if i == 0 {
                                vec![]
                            } else {
                                vec![Json::str(format!("OP{k}_{}", i - 1))]
                            }),
                        );
                        op.set("qualifications", Json::Arr(vec![]));
                        op.set("worker_count", Json::int(1));
                        op.set("tools", Json::Arr(vec![]));
                        op.set(
                            "alternatives",
                            Json::Arr(vec![Json::obj(vec![
                                ("machine_id", Json::str("M1")),
                                ("duration_min", Json::int(*d)),
                            ])]),
                        );
                        op.set("materials", Json::obj(vec![("MAT", Json::int(*q))]));
                        op
                    })
                    .collect();
                orders_json.push(Json::obj(vec![
                    ("id", Json::str(format!("O{k}"))),
                    ("quantity", Json::int(1)),
                    ("priority", Json::int(1)),
                    ("release_at", iso(release[k])),
                    ("due_at", iso(horizon)),
                    ("operations", Json::Arr(ops_json)),
                ]));
            }

            let mut prob = base.clone();
            if let Some(meta) = prob.get_mut("meta") {
                meta.set("horizon_start", iso(0));
                meta.set("horizon_end", iso(horizon));
            }
            prob.set(
                "machines",
                Json::Arr(vec![Json::obj(vec![
                    ("id", Json::str("M1")),
                    ("capabilities", Json::Arr(vec![Json::str("cut")])),
                    ("available", avail.clone()),
                    ("blocked", Json::Arr(vec![])),
                ])]),
            );
            prob.set(
                "workers",
                Json::Arr(vec![Json::obj(vec![
                    ("id", Json::str("W1")),
                    ("skills", Json::Arr(vec![Json::str("cut")])),
                    ("qualifications", Json::Arr(vec![])),
                    ("available", avail.clone()),
                    ("blocked", Json::Arr(vec![])),
                ])]),
            );
            prob.set("tools", Json::Arr(vec![]));
            prob.set(
                "materials",
                Json::Arr(vec![Json::obj(vec![
                    ("id", Json::str("MAT")),
                    ("initial_quantity", Json::int(initial)),
                    (
                        "receipts",
                        Json::Arr(
                            receipts
                                .iter()
                                .map(|(at, q)| {
                                    Json::obj(vec![("at", iso(*at)), ("quantity", Json::int(*q))])
                                })
                                .collect(),
                        ),
                    ),
                ])]),
            );
            prob.set("orders", Json::Arr(orders_json));

            let p = match crate::model::parse_problem(&prob).0 {
                Some(p) => p,
                None => continue,
            };
            let c = crate::compile::compile(&p, "h".to_string());
            let lb = makespan_lower_bound(&c);

            // ---- 暴力 DFS：枚举订单间交错顺序（单机 → 交错顺序即最优解） ----
            let best = brute_force_single_machine(&per_order, &release, initial, &receipts);
            let Some(best) = best else { continue };
            assert!(
                lb <= best,
                "seed {seed}：下界 {lb} 高于暴力最优 {best}\
                 （每单工序={per_order:?}, 投放={release:?}, 初始={initial}, 到货={receipts:?}, \
                 flow={}, capacity={}）",
                flow_lower_bound(&c),
                capacity_lower_bound(&c)
            );
            checked += 1;

            // 交叉验证：引擎排程不得优于暴力最优（否则模型语义不一致），且不得低于下界
            let mut rng = crate::solver::Rng::new(seed);
            if let Some(sol) =
                crate::solver::dispatch::dispatch(&c, crate::solver::Rule::PriorityEdd, &mut rng)
            {
                if let Some(v) = evaluate(&c, &sol) {
                    assert!(
                        v.makespan >= best,
                        "seed {seed}：引擎 makespan {} 小于暴力最优 {best}，说明暴力模型或引擎语义有偏差",
                        v.makespan
                    );
                    assert!(
                        v.makespan >= lb,
                        "seed {seed}：引擎 makespan {} 低于下界 {lb}",
                        v.makespan
                    );
                    engine_checked += 1;
                }
            }
        }
        assert!(checked >= 70, "有效样本过少（{checked}，期望 ≥70）");
        assert!(
            engine_checked >= 70,
            "引擎交叉验证样本过少（{engine_checked}，期望 ≥70）"
        );
    }

    /// 单机 + 单人员的精确最优 makespan：DFS 枚举“订单间交错顺序”，每步按 ASAP 放置。
    /// 返回 None 表示不存在可行排程（物料总供给不足）。
    fn brute_force_single_machine(
        per_order: &[Vec<(i64, i64)>],
        release: &[i64],
        initial: i64,
        receipts: &[(i64, i64)],
    ) -> Option<i64> {
        struct St<'a> {
            per_order: &'a [Vec<(i64, i64)>],
            release: &'a [i64],
            receipts: &'a [(i64, i64)],
            best: i64,
        }
        impl St<'_> {
            fn dfs(
                &mut self,
                next: &mut Vec<usize>,
                balance: i64,
                ri: usize,
                t_mat: i64,
                end_prev: i64,
            ) {
                let total: usize = self.per_order.iter().map(|v| v.len()).sum();
                let done: usize = next.iter().sum();
                if done == total {
                    self.best = self.best.min(end_prev);
                    return;
                }
                // 剪枝：当前完工时刻已不优于已知最优
                if end_prev >= self.best {
                    return;
                }
                for k in 0..self.per_order.len() {
                    let i = next[k];
                    if i >= self.per_order[k].len() {
                        continue;
                    }
                    let (q, d) = self.per_order[k][i];
                    // 领料：必要时等到后续到货
                    let mut bal = balance;
                    let mut r = ri;
                    let mut tm = t_mat;
                    while bal < q && r < self.receipts.len() {
                        tm = tm.max(self.receipts[r].0);
                        bal += self.receipts[r].1;
                        r += 1;
                    }
                    if bal < q {
                        continue; // 该分支不可行
                    }
                    bal -= q;
                    let start = end_prev.max(self.release[k]).max(tm);
                    next[k] += 1;
                    self.dfs(next, bal, r, tm, start + d);
                    next[k] -= 1;
                }
            }
        }
        let mut st = St {
            per_order,
            release,
            receipts,
            best: i64::MAX,
        };
        let mut next = vec![0usize; per_order.len()];
        st.dfs(&mut next, initial, 0, 0, 0);
        if st.best == i64::MAX {
            None
        } else {
            Some(st.best)
        }
    }

    #[test]
    fn lower_bound_is_valid_on_baseline() {
        let c = load("mock/baseline.json");
        let lb = makespan_lower_bound(&c);
        // 关键链：CUT 30 + WELD 45 + PAINT 30 = 105（订单内串行下界，忽略产能竞争）
        assert!(lb >= 105, "下界 {lb} 应至少覆盖单订单关键链");
        assert!(lb <= c.meta.horizon_len_min);
    }
}
