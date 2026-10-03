//! 求解器：构造式排程启发式（多规则）+ 局部修复（ruin & recreate / 左移紧致化）。
//!
//! ## 为什么不是“随机甘特图”
//!
//! 每一次落位都经过 H01–H07 的完整可行性检查（时长、依赖、机器能力与排他、日历窗口、
//! 人员技能与排他、工装排他、物料时序），因此产出的排程要么完全可行，要么不存在——
//! 绝不以“先排再祈祷”的方式生成计划。
//!
//! ## 可复现性
//!
//! 随机性只来自 `splitmix64` 伪随机数发生器（`seed` 决定），且所有遍历顺序均为
//! 确定性顺序（`Vec`/`BTreeMap`，不使用 `HashMap` 迭代），因此
//! **同一 `seed` + 同一时间预算下的规则边界 → 相同解**；时间预算耗尽点不同则解可能不同
//! （契约明确验收比对“合法性与目标”而非字节级一致，见 APS-SRS §4）。

pub mod dispatch;
pub mod repair;

use crate::compile::Compiled;
use crate::objective::{self, ObjectiveValue, Strategy};
use crate::schedule::{Budget, Schedule};

/// 派工规则（决定订单投放顺序；`Auto` 会依次尝试全部规则）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule {
    /// 依次尝试全部规则（默认）
    Auto,
    /// 交期优先 + 高优先级（EDD + priority）
    PriorityEdd,
    /// 加权最短加工时间优先（WSPT 近似：优先期内高优先级短订单）
    Wspt,
    /// 最短加工时间优先
    Spt,
    /// 最早可达完工优先
    MinEnd,
    /// 最小松弛优先（due - release - 关键链）
    MostSlack,
    /// 随机顺序（多起点重启使用，仍保证可行性）
    Random,
}

impl Rule {
    pub fn parse(s: &str) -> Option<Rule> {
        match s {
            "auto" => Some(Rule::Auto),
            "priority-edd" | "edd" => Some(Rule::PriorityEdd),
            "wspt" => Some(Rule::Wspt),
            "spt" => Some(Rule::Spt),
            "min-end" => Some(Rule::MinEnd),
            "most-slack" | "slack" => Some(Rule::MostSlack),
            "random" => Some(Rule::Random),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Rule::Auto => "auto",
            Rule::PriorityEdd => "priority-edd",
            Rule::Wspt => "wspt",
            Rule::Spt => "spt",
            Rule::MinEnd => "min-end",
            Rule::MostSlack => "most-slack",
            Rule::Random => "random",
        }
    }
    pub fn all() -> [Rule; 5] {
        [
            Rule::PriorityEdd,
            Rule::Wspt,
            Rule::MostSlack,
            Rule::Spt,
            Rule::MinEnd,
        ]
    }
}

/// splitmix64：小状态、可复现、无第三方依赖。
#[derive(Debug, Clone)]
pub struct Rng {
    state: u64,
}

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng {
            state: seed ^ 0x9E37_79B9_7F4A_7C15,
        }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// `[0, n)` 均匀取样（n = 0 时返回 0）。
    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next_u64() % n as u64) as usize
        }
    }

    pub fn shuffle<T>(&mut self, v: &mut [T]) {
        if v.len() < 2 {
            return;
        }
        for i in (1..v.len()).rev() {
            let j = self.below(i + 1);
            v.swap(i, j);
        }
    }
}

/// 求解配置。
#[derive(Debug, Clone)]
pub struct SearchConfig {
    pub strategy: Strategy,
    pub time_limit_ms: i64,
    pub seed: u64,
    pub rule: Rule,
    /// 是否启用局部修复（关闭则只做多规则构造，便于对照）
    pub repair: bool,
    /// 局部修复的最大迭代次数（0 表示只受时间预算限制）
    pub max_iterations: usize,
}

impl Default for SearchConfig {
    fn default() -> Self {
        SearchConfig {
            strategy: Strategy::Lexicographic,
            time_limit_ms: 10_000,
            seed: 42,
            rule: Rule::Auto,
            repair: true,
            max_iterations: 0,
        }
    }
}

/// 搜索结果与统计。
#[derive(Debug, Clone, Default)]
pub struct SearchOutcome {
    pub best: Option<(Schedule, ObjectiveValue)>,
    pub first_feasible_ms: Option<f64>,
    pub iterations: usize,
    pub restarts: usize,
    pub rules_tried: usize,
    pub timed_out: bool,
    pub cancelled: bool,
    /// makespan 有效下界（弱下界，见 `objective::makespan_lower_bound`）
    pub lower_bound: Option<i64>,
    /// 是否已证明最优（加权延期取 0 且 makespan 取到下界）
    pub proven_optimal: bool,
}

impl SearchOutcome {
    pub fn objective(&self) -> Option<ObjectiveValue> {
        self.best.as_ref().map(|(_, v)| *v)
    }
}

/// 判定“是否已证明最优”：加权延期取到理论下界 0，且 makespan 取到有效下界。
///
/// 该判据成立时两个目标分量同时取到各自下界（加权延期 ≥ 0；makespan ≥ LB），
/// 因此无论 `lexicographic` 还是 `makespan` 策略，该解都是**可证明的最优解**。
pub fn is_proven_optimal(value: &ObjectiveValue, lower_bound: i64) -> bool {
    value.weighted_tardiness == 0 && value.makespan <= lower_bound
}

/// 可复现性契约（务必按此口径对外承诺）：
///
/// * **确定性模式**：指定 `max_iterations = N`（> 0）且时间预算未耗尽时，结果与墙钟无关，
///   同一 `(输入, seed, 规则, N)` 产出**逐字节相同**的方案 JSON；
/// * **预算模式**：只给 `time_limit_ms` 时，执行到第几轮迭代取决于机器速度与调度，
///   因此**不承诺**跨运行/跨机器的字节级一致（只承诺合法性、可复现的随机种子序列与
///   目标值量级）。需要可复现请使用 `--max-iterations`（CLI）。
///
/// 主搜索流程。
pub fn search(c: &Compiled, cfg: &SearchConfig, budget: &Budget) -> SearchOutcome {
    let mut out = SearchOutcome::default();
    let mut rng = Rng::new(cfg.seed);
    let mut best: Option<(Schedule, ObjectiveValue)> = None;

    let prefer_workers: Vec<u32> = (0..c.workers.len() as u32).collect();
    // 下界只需计算一次（宽松放松，见 objective::makespan_lower_bound）
    let lower_bound = objective::makespan_lower_bound(c);
    out.lower_bound = Some(lower_bound);

    // ---- 1) 多规则构造 ----
    let rules: Vec<Rule> = match cfg.rule {
        Rule::Auto => Rule::all().to_vec(),
        r => vec![r],
    };
    for rule in rules {
        if budget.expired() {
            out.timed_out = !budget.cancelled();
            break;
        }
        out.rules_tried += 1;
        if let Some(s) = dispatch::dispatch(c, rule, &mut rng) {
            if let Some(v) = objective::evaluate(c, &s) {
                if out.first_feasible_ms.is_none() {
                    out.first_feasible_ms = Some(budget.elapsed_ms());
                }
                let better = best
                    .as_ref()
                    .map_or(true, |(_, bv)| v.is_better_than(bv, cfg.strategy));
                if better {
                    best = Some((s, v));
                }
            }
        }
        // 已达下界：无需继续搜索，可直接给出最优性证明
        if let Some((_, v)) = &best {
            if is_proven_optimal(v, lower_bound) {
                out.proven_optimal = true;
                break;
            }
        }
    }

    // ---- 2) 局部修复 ----
    if cfg.repair && !budget.expired() && !out.proven_optimal {
        if let Some((sched, value)) = best.take() {
            let state = (sched, value);
            let state = repair::improve(c, state, lower_bound, cfg, budget, &mut rng, &mut out);
            if is_proven_optimal(&state.1, lower_bound) {
                out.proven_optimal = true;
            }
            best = Some(state);
        } else {
            // 构造阶段未得到完整解：用 ruin&recreate 从零不可能改善，直接跳过
            budget.remaining_ms();
        }
    }

    out.timed_out = out.timed_out || budget.expired();
    out.cancelled = budget.cancelled();
    out.best = best;
    if out.best.is_none() {
        // 未求出解时不做任何“空排程”伪装
        out.lower_bound = None;
    }
    let _ = prefer_workers;
    out
}

/// 计算相对差距（仅当存在有效下界且目标值 > 0）。
pub fn relative_gap(c: &Compiled, cfg: &SearchConfig, value: &ObjectiveValue) -> Option<f64> {
    let lb = objective::makespan_lower_bound(c);
    // best_bound 仅对 makespan 分量有效，因此只在 makespan 策略下报告差距，
    // 避免对“字典序目标”给出误导性的差距。
    if cfg.strategy != Strategy::Makespan || lb <= 0 {
        return None;
    }
    let obj = value.makespan as f64;
    Some(((obj - lb as f64) / lb as f64).max(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;

    fn load(rel: &str) -> Compiled {
        let text =
            std::fs::read_to_string(format!("{}/../{}", env!("CARGO_MANIFEST_DIR"), rel)).unwrap();
        let j = json::parse(&text).unwrap();
        let p = crate::model::parse_problem(&j).0.unwrap();
        crate::compile::compile(&p, "h".to_string())
    }

    #[test]
    fn rng_is_reproducible() {
        let mut a = Rng::new(42);
        let mut b = Rng::new(42);
        for _ in 0..100 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
        let mut v1: Vec<u32> = (0..20).collect();
        let mut v2 = v1.clone();
        Rng::new(7).shuffle(&mut v1);
        Rng::new(7).shuffle(&mut v2);
        assert_eq!(v1, v2);
        assert_ne!(v1, (0..20).collect::<Vec<u32>>());
    }

    #[test]
    fn dispatches_baseline_completely() {
        let c = load("mock/baseline.json");
        let mut rng = Rng::new(1);
        let s = dispatch::dispatch(&c, Rule::Auto, &mut rng).expect("基线场景必须能排出完整计划");
        assert!(s.is_complete());
        assert!(objective::evaluate(&c, &s).is_some());
        assert_eq!(crate::schedule::overlap_violation(&c, &s), None);
        assert_eq!(crate::schedule::ledger_violation(&c, &s), None);
    }

    #[test]
    fn search_returns_feasible_within_budget() {
        let c = load("mock/baseline.json");
        let cfg = SearchConfig {
            time_limit_ms: 300,
            seed: 42,
            ..Default::default()
        };
        let budget = Budget::new(cfg.time_limit_ms, Default::default());
        let out = search(&c, &cfg, &budget);
        let (sched, value) = out.best.expect("应求出可行解");
        assert!(sched.is_complete());
        assert!(value.makespan > 0);
        assert!(out.first_feasible_ms.is_some());
    }

    #[test]
    fn search_is_deterministic_for_same_seed() {
        let c = load("mock/baseline.json");
        let cfg = SearchConfig {
            time_limit_ms: 1_000_000,
            seed: 2026,
            max_iterations: 50, // 固定迭代次数 → 与墙钟无关，保证可复现
            ..Default::default()
        };
        let a = search(
            &c,
            &cfg,
            &Budget::new(cfg.time_limit_ms, Default::default()),
        );
        let b = search(
            &c,
            &cfg,
            &Budget::new(cfg.time_limit_ms, Default::default()),
        );
        assert_eq!(a.objective(), b.objective());
        let sa = a.best.unwrap().0;
        let sb = b.best.unwrap().0;
        assert_eq!(sa.assign, sb.assign);
    }
}
