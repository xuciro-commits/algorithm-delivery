//! 高层联合规划：CBS（w=1，可证明最优）/ 有界次优 ECBS（w>1）+ Prioritized Planning 首解。
//!
//! ## 算法路线（SRS §4“算法路线由开发方自主研究决定”的正式回答）
//!
//! * **高层**：Conflict-Based Search 家族。节点 = 每车约束集 + 各车在该约束下的
//!   最优（最早到达）路径；分支 = 对“最早冲突”分别向冲突双方各添加一条时空约束。
//!   节点代价按问题目标聚合：SOC ⇒ Σ 到达时刻；Makespan ⇒ max 到达时刻。
//!   添加约束只会抬升单车在约束下的最早到达时刻 ⇒ 节点代价沿树单调不减，
//!   且等于该子树的**有效下界**；据此：
//!   - open 穷尽且存在解 ⇒ `OPTIMAL`；
//!   - open.min ≥ UB（w=1）⇒ `OPTIMAL`；
//!   - open.min ≥ UB/w（w>1）⇒ 有界次优（gap ≤ w，如实报告，不宣称最优）；
//!   - open 穷尽且无解 ⇒ 声明时域内 `INFEASIBLE`（自动时域不享有该资格）。
//!   推导与完整证明骨架见 `docs/MODEL-MATH.md` §5–§6。
//! * **底层**：`(cell, t)` 时空图上的 A*（`planner.rs`），启发 = 曼哈顿距离（可采纳）；
//!   分支时只对“被加约束的那台车”做增量重规划。
//! * **首解**：Prioritized Planning（距离降序 + seed 打散的确定性优先序）给出可行
//!   上界与“首解时间”指标；失败不影响完备性（ECBS 兜底）。
//!
//! ## 冻结前缀
//!
//! 动态重规划时，每车的承诺前缀以**锁定/半锁定**方式进入实例：前缀覆盖全时域的
//! 车成为不可重规划的占用者；“自由车 × 锁定车”冲突只向自由车加约束（SRS §2.2
//! “已执行历史及明确承诺的冻结前缀不得改变”的实现机制）。
//!
//! ## 复杂度与主要失败模式（SRS §4 要求如实说明）
//!
//! 底层 A* 状态数 O(|V|·(T+1))；高层树在最坏情况下指数（SOC 与 Makespan 均
//! NP-hard：Yu & LaValle 2013；Banfi et al. 2012）。失败模式与对策：
//! 1. 高拥塞/窄瓶颈 ⇒ 冲突分支爆炸：PP 首解、w>1、预算内诚实返回 `FEASIBLE/UNKNOWN`；
//! 2. 不可行实例 ⇒ 穷尽慢：静态不可达在 engine 入口以 BFS 直判（与时域无关的证明）；
//! 3. 自动时域偏小 ⇒ “自动时域只升级、不宣告 INFEASIBLE”策略封堵误判。

use std::collections::{BinaryHeap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use aps_engine::clock;

use crate::planner::{self, AgentConstraints, LowCtx, LowStats};
use crate::problem::{Cell, Objective, PlannerKind};

/// 联合规划实例（由 `problem` + `dynamic` 编译得到；静态实例的前缀 = [start] 一格）。
pub struct Instance<'a> {
    pub map: &'a crate::problem::MapData,
    /// 动态障碍窗口（cell → 排序合并后的 (start,end)，end 开区间）。
    pub blocked: &'a [Vec<(u32, u32)>],
    /// `obstacle_remove` 的解禁窗口（仅对静态障碍格生效）。
    pub free_win: &'a [Vec<(u32, u32)>],
    pub n: usize,
    /// 每车承诺前缀（t=0..=f_end_i 的位置序列；静态实例 = [start]）。
    pub prefixes: Vec<Vec<Cell>>,
    /// 每车有效目标（goal_change 应用后）。
    pub goals: Vec<Cell>,
    pub horizon: u32,
    pub objective: Objective,
}

impl<'a> Instance<'a> {
    pub fn new(
        map: &'a crate::problem::MapData,
        blocked: &'a [Vec<(u32, u32)>],
        free_win: &'a [Vec<(u32, u32)>],
        n: usize,
        prefixes: Vec<Vec<Cell>>,
        goals: Vec<Cell>,
        horizon: u32,
        objective: Objective,
    ) -> Instance<'a> {
        debug_assert_eq!(prefixes.len(), n);
        debug_assert_eq!(goals.len(), n);
        Instance {
            map,
            blocked,
            free_win,
            n,
            prefixes,
            goals,
            horizon,
            objective,
        }
    }
    #[inline]
    pub fn prefix_end(&self, i: usize) -> u32 {
        self.prefixes[i].len().saturating_sub(1) as u32
    }
    /// 该车是否已不可重规划（前缀覆盖整个时域）。
    #[inline]
    pub fn is_locked(&self, i: usize) -> bool {
        self.prefix_end(i) >= self.horizon
    }
    #[inline]
    pub fn start_cell(&self, i: usize) -> Cell {
        *self.prefixes[i].last().expect("prefix non-empty")
    }
}

/// 单条机器人完整时间线（前缀 ⊕ 后缀）。t ≥ cells.len() 视为驻留 `goal`。
#[derive(Debug, Clone)]
pub struct AgentPath {
    pub cells: Vec<Cell>,
    pub arrival: u32,
    pub goal: Cell,
    pub locked: bool,
}

impl AgentPath {
    #[inline]
    pub fn pos_at(&self, t: u32) -> Cell {
        if t < self.cells.len() as u32 {
            self.cells[t as usize]
        } else {
            self.goal
        }
    }
    pub fn end_time(&self) -> u32 {
        (self.cells.len() as u32 - 1).max(self.arrival)
    }
}

struct HlNode {
    cons: Vec<AgentConstraints>,
    paths: Vec<AgentPath>,
    cost: i64,
}

impl Clone for HlNode {
    fn clone(&self) -> HlNode {
        HlNode {
            cons: self.cons.clone(),
            paths: self.paths.clone(),
            cost: self.cost,
        }
    }
}

/// 搜索统计（写入 `MapfSolution.search`）。
#[derive(Debug, Default, Clone)]
pub struct SearchStats {
    pub hl_expansions: u64,
    pub hl_generated: u64,
    pub ll_expansions: u64,
    pub ll_generated: u64,
    pub conflicts_checked: u64,
    pub pp_succeeded: bool,
    pub pp_failed_at: Option<usize>,
}

/// 结束方式（决定状态资格）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finish {
    /// open 穷尽（树完整探索）：有解 ⇒ 最优；无解 ⇒ 时域内无解。
    Exhausted,
    /// 时间/扩展上限耗尽：只允许 FEASIBLE（含差距界）或 UNKNOWN。
    Budget,
    /// 底层出现过“预算内未穷尽而被丢弃的分支”：不得宣告穷尽。
    Pruned,
    Cancelled,
}

/// 联合规划结果。
pub struct EcbsResult {
    pub solution: Option<Vec<AgentPath>>,
    pub best_cost: i64,
    /// 有效下界：UB 存在时为“可证明不会比它更优的最小值”；否则为根/当前 open.min。
    pub lower_bound: i64,
    /// 是否可宣告最优（穷尽，或 w=1 且 LB ≥ UB，或 w>1 但 LB 追平 UB）。
    pub proven_optimal: bool,
    pub finish: Finish,
    pub stats: SearchStats,
    pub first_solution_ms: Option<f64>,
    /// 单车根下界（用于报告 individual bound，即 Σ/max 曼哈顿）。
    pub root_lb: i64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ConflictKind {
    Vertex,
    EdgeSwap,
}

/// 执行联合搜索。`deadline_ms` 为单调时钟绝对毫秒。
pub fn solve(
    inst: &Instance<'_>,
    w: f64,
    deadline_ms: f64,
    max_expansions: usize,
    cancel: &Option<Arc<AtomicBool>>,
    seed: u64,
    warm_start: bool,
    planner_kind: PlannerKind,
) -> EcbsResult {
    let started = clock::now_ms();
    let mut stats = SearchStats::default();
    let ctx = LowCtx {
        map: inst.map,
        blocked: inst.blocked,
        free_win: inst.free_win,
        horizon: inst.horizon,
        deadline_ms,
        budget_enabled: true,
        cancel: cancel.clone(),
        expansions_cap: 0,
    };
    let mut root_lb = 0i64;
    {
        let mut sum = 0i64;
        let mut mx = 0i64;
        for i in 0..inst.n {
            let d = inst.map.manhattan(inst.start_cell(i), inst.goals[i]) as i64;
            sum += d;
            mx = mx.max(d);
        }
        root_lb = match inst.objective {
            Objective::Soc => sum,
            Objective::Makespan => mx,
        };
    }

    macro_rules! out {
        ($solution:expr, $best_cost:expr, $lower_bound:expr, $proven_optimal:expr, $finish:expr, $fsm:expr $(,)?) => {
            EcbsResult {
                solution: $solution,
                best_cost: $best_cost,
                lower_bound: $lower_bound,
                proven_optimal: $proven_optimal,
                finish: $finish,
                stats,
                first_solution_ms: $fsm,
                root_lb,
            }
        };
    }

    // —— 根节点：各车单独最早到达 ——
    let cons = vec![AgentConstraints::new(); inst.n];
    let mut root_paths: Vec<AgentPath> = Vec::with_capacity(inst.n);
    for i in 0..inst.n {
        let mut expired = false;
        let mut ls = LowStats::default();
        let Some(s) = planner::plan(
            &ctx,
            inst.start_cell(i),
            inst.prefix_end(i),
            inst.goals[i],
            &cons[i],
            &mut expired,
            &mut ls,
        ) else {
            stats.ll_expansions += ls.expansions;
            stats.ll_generated += ls.generated;
            // 单车根不可达：底层穷尽 ⇒ 时域内证明无解（引擎再结合静态 BFS 收紧证明）；
            // 底层超预算 ⇒ UNKNOWN。
            let finish = if expired {
                Finish::Budget
            } else {
                Finish::Exhausted
            };
            return out!(None, -1, root_lb, false, finish, None);
        };
        stats.ll_expansions += ls.expansions;
        stats.ll_generated += ls.generated;
        root_paths.push(merge_path(inst, i, &s.positions, s.arrival));
    }
    let root_cost = aggregate_cost(inst.objective, &root_paths);

    let mut nodes: Vec<HlNode> = vec![HlNode {
        cons,
        paths: root_paths,
        cost: root_cost,
    }];
    let mut open: BinaryHeap<OrdNode> = BinaryHeap::new();
    let mut seq: u64 = 0;
    open.push(OrdNode {
        cost: root_cost,
        seq,
        node: 0,
    });
    seq += 1;

    let mut best: Option<(i64, usize)> = None;
    let mut first_solution_ms: Option<f64> = None;
    let mut pruned = false;

    // —— PP 首解 ——
    if warm_start && planner_kind != PlannerKind::Ecbs {
        match prioritized_planning(inst, &ctx, seed, &mut stats, deadline_ms, cancel) {
            Some(pp) => {
                let c = aggregate_cost(inst.objective, &pp);
                nodes.push(HlNode {
                    cons: Vec::new(),
                    paths: pp,
                    cost: c,
                });
                best = Some((c, nodes.len() - 1));
                first_solution_ms = Some(clock::now_ms() - started);
                stats.pp_succeeded = true;
            }
            None => stats.pp_succeeded = false,
        }
    }

    if planner_kind == PlannerKind::Pp {
        // 纯贪心档：有解 FEASIBLE（无证明资格）；无解 UNKNOWN。
        let (s, c) = match best {
            Some((c, idx)) => (Some(nodes[idx].paths.clone()), c),
            None => (None, -1),
        };
        return out!(s, c, root_lb, false, Finish::Pruned, first_solution_ms);
    }

    loop {
        let open_min = match open.peek() {
            Some(n) => n.cost,
            None => {
                // open 穷尽且无预算内丢弃分支 ⇒ 完整探索（有解 ⇒ 最优；无解 ⇒
                // 时域内无解，INFEASIBLE 资格由 engine 结合时域声明方式判定）。
                let sol = best.map(|(_, idx)| nodes[idx].paths.clone());
                let bc = best.map(|(c, _)| c).unwrap_or(-1);
                if pruned {
                    return out!(
                        sol,
                        bc,
                        match best {
                            Some((c, _)) => c,
                            None => root_lb,
                        },
                        false,
                        Finish::Pruned,
                        first_solution_ms,
                    );
                }
                let lb = match best {
                    Some((c, _)) => c,
                    None => root_lb,
                };
                let proven = best.is_some();
                return out!(sol, bc, lb, proven, Finish::Exhausted, first_solution_ms);
            }
        };
        if let Some((bc, _)) = best {
            let accept = if w <= 1.0 {
                bc <= open_min
            } else {
                (bc as f64) <= (open_min as f64) * w
            };
            if accept {
                // UB ≤ LB 才是“最优证明”；仅满足 UB ≤ w·LB 时是有界次优（不宣称最优）。
                let proven = bc <= open_min;
                return out!(
                    best.map(|(_, idx)| nodes[idx].paths.clone()),
                    bc,
                    open_min,
                    proven,
                    if pruned {
                        Finish::Pruned
                    } else {
                        Finish::Budget
                    },
                    first_solution_ms,
                );
            }
        }
        if clock::now_ms() >= deadline_ms {
            break;
        }
        if cancel
            .as_ref()
            .map(|c| c.load(Ordering::Relaxed))
            .unwrap_or(false)
        {
            return out!(
                best.map(|(_, idx)| nodes[idx].paths.clone()),
                best.map(|(c, _)| c).unwrap_or(-1),
                open_min,
                false,
                Finish::Cancelled,
                first_solution_ms,
            );
        }
        if max_expansions != 0 && (stats.hl_expansions as usize) >= max_expansions {
            break;
        }

        let OrdNode { node: ni, .. } = open.pop().expect("open non-empty");
        stats.hl_expansions += 1;
        let conflict = find_conflict(inst, &nodes[ni].paths, &mut stats);
        let Some((ta, tb, t, kind)) = conflict else {
            let c = nodes[ni].cost;
            if best.map(|(bc, _)| c < bc).unwrap_or(true) {
                best = Some((c, ni));
                first_solution_ms.get_or_insert_with(|| clock::now_ms() - started);
            }
            continue;
        };
        // 分支：只向“可重规划的一方”加约束；双锁定冲突在输入层已排除。
        let branchable: Vec<usize> = match (nodes[ni].paths[ta].locked, nodes[ni].paths[tb].locked)
        {
            (true, true) => Vec::new(),
            (false, true) => vec![ta],
            (true, false) => vec![tb],
            _ => vec![ta, tb],
        };
        for ai in branchable {
            let mut child = nodes[ni].clone();
            match kind {
                ConflictKind::Vertex => {
                    let cell = child.paths[ai].pos_at(t);
                    child.cons[ai].add_vertex(t, cell);
                }
                ConflictKind::EdgeSwap => {
                    let from = child.paths[ai].pos_at(t);
                    let to = child.paths[ai].pos_at(t + 1);
                    let n_cells = inst.map.n_cells() as u64;
                    child.cons[ai].add_edge(t, from, to, n_cells);
                }
            }
            let mut expired = false;
            let mut ls = LowStats::default();
            let r = planner::plan(
                &ctx,
                inst.start_cell(ai),
                inst.prefix_end(ai),
                inst.goals[ai],
                &child.cons[ai],
                &mut expired,
                &mut ls,
            );
            stats.ll_expansions += ls.expansions;
            stats.ll_generated += ls.generated;
            match r {
                Some(suffix) => {
                    let p = merge_path(inst, ai, &suffix.positions, suffix.arrival);
                    child.paths[ai] = p;
                    child.cost = aggregate_cost(inst.objective, &child.paths);
                    let cc = child.cost;
                    nodes.push(child);
                    open.push(OrdNode {
                        cost: cc,
                        seq,
                        node: nodes.len() - 1,
                    });
                    seq += 1;
                    stats.hl_generated += 1;
                }
                None if expired => {
                    // 底层未穷尽（预算内剪枝）：不能宣告穷尽
                    pruned = true;
                }
                None => {
                    // 底层穷尽且单车不可满足：该分支自然封闭（无需入队）
                }
            }
        }
    }
    // 走到这里 = 预算耗尽 / 扩展上限
    // 注意：`Pruned` 分支的存在同样否定“穷尽”资格。
    out!(
        best.map(|(_, idx)| nodes[idx].paths.clone()),
        best.map(|(c, _)| c).unwrap_or(-1),
        open.peek().map(|n| n.cost).unwrap_or(i64::MAX),
        false,
        if pruned {
            Finish::Pruned
        } else {
            Finish::Budget
        },
        first_solution_ms,
    )
}

/// 合并前缀与后缀为完整时间线，并确定“首次永久驻留”时刻（= 到达时刻）。
fn merge_path(inst: &Instance<'_>, i: usize, suffix: &[Cell], suffix_arrival: u32) -> AgentPath {
    let prefix = &inst.prefixes[i];
    let goal = inst.goals[i];
    let mut cells = prefix.clone();
    for &c in suffix.iter().skip(1) {
        cells.push(c);
    }
    let f_end = (prefix.len() - 1) as u32;
    let arrival = if prefix.last().copied() == Some(goal) {
        // 前缀尾部已在目标上：回溯连续段起点即“首次到达”。
        let mut t = f_end;
        while t > 0 && prefix[(t - 1) as usize] == goal {
            t -= 1;
        }
        t
    } else {
        suffix_arrival
    };
    AgentPath {
        cells,
        arrival,
        goal,
        locked: inst.is_locked(i),
    }
}

fn aggregate_cost(objective: Objective, paths: &[AgentPath]) -> i64 {
    match objective {
        Objective::Soc => paths.iter().map(|p| p.arrival as i64).sum(),
        Objective::Makespan => paths.iter().map(|p| p.arrival).max().unwrap_or(0) as i64,
    }
}

/// 首个冲突（(i, j, t, kind)）。扫描到最大到达时刻为止：此后全员驻留于互异终点，
/// 不可能产生新冲突。该实现与 `verify.rs` 的逐对扫描**相互独立**（SRS §4）。
fn find_conflict(
    inst: &Instance<'_>,
    paths: &[AgentPath],
    stats: &mut SearchStats,
) -> Option<(usize, usize, u32, ConflictKind)> {
    let _ = inst;
    // 扫描上界取“最后一条路径发生位置变化的时刻”：锁定前缀可能在其它车到达之后仍在移动。
    let m = paths.iter().map(|p| p.end_time()).max().unwrap_or(0);
    let n = paths.len();
    if n < 2 {
        return None;
    }
    let mut occ: HashMap<Cell, usize> = HashMap::with_capacity(n * 2);
    let mut edges: HashMap<(Cell, Cell), usize> = HashMap::with_capacity(n * 2);
    for t in 0..=m {
        occ.clear();
        for i in 0..n {
            let c = paths[i].pos_at(t);
            if let Some(&j) = occ.get(&c) {
                stats.conflicts_checked += 1;
                return Some((j, i, t, ConflictKind::Vertex));
            }
            occ.insert(c, i);
        }
        if t < m {
            edges.clear();
            for i in 0..n {
                let a = paths[i].pos_at(t);
                let b = paths[i].pos_at(t + 1);
                if a == b {
                    continue;
                }
                if let Some(&j) = edges.get(&(b, a)) {
                    stats.conflicts_checked += 1;
                    return Some((j, i, t, ConflictKind::EdgeSwap));
                }
                edges.insert((a, b), i);
            }
        }
    }
    None
}

#[derive(PartialEq, Eq)]
struct OrdNode {
    cost: i64,
    seq: u64,
    node: usize,
}

impl Ord for OrdNode {
    fn cmp(&self, other: &OrdNode) -> std::cmp::Ordering {
        // 小顶堆；tie 按生成序（确定性）。
        other
            .cost
            .cmp(&self.cost)
            .then_with(|| other.seq.cmp(&self.seq))
    }
}
impl PartialOrd for OrdNode {
    fn partial_cmp(&self, other: &OrdNode) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

// ---------------------------------------------------------------- PP 首解

/// Prioritized Planning：逐车按优先序规划并预约时空占用（顶点 + 边交换 + 终点驻留）。
pub fn prioritized_planning(
    inst: &Instance<'_>,
    ctx: &LowCtx<'_>,
    seed: u64,
    stats: &mut SearchStats,
    deadline_ms: f64,
    cancel: &Option<Arc<AtomicBool>>,
) -> Option<Vec<AgentPath>> {
    // 优先序：距离降序，tie 索引升序；seed ≠ 0 时做确定性 Fisher–Yates 打散。
    let mut dist: Vec<(u32, usize)> = (0..inst.n)
        .map(|i| (inst.map.manhattan(inst.start_cell(i), inst.goals[i]), i))
        .collect();
    dist.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let mut order: Vec<usize> = dist.iter().map(|&(_, i)| i).collect();
    if seed != 0 && inst.n > 1 {
        let mut st = seed | 1;
        let mut k = inst.n - 1;
        while k > 0 {
            st ^= st << 13;
            st ^= st >> 7;
            st ^= st << 17;
            let j = (st % (k as u64 + 1)) as usize;
            order.swap(k, j);
            k -= 1;
        }
    }

    let n_cells = inst.map.n_cells() as u64;
    let mut vertex_keys: Vec<HashSet<u64>> = vec![Default::default(); inst.n];
    let mut edge_keys: Vec<HashSet<u64>> = vec![Default::default(); inst.n];
    let mut paths: Vec<Option<AgentPath>> = vec![None; inst.n];

    // 锁定车先占用时空
    for i in 0..inst.n {
        if !inst.is_locked(i) {
            continue;
        }
        let pfx = &inst.prefixes[i];
        let goal = inst.goals[i];
        for t in 0..=inst.horizon {
            let cell = if (t as usize) < pfx.len() {
                pfx[t as usize]
            } else {
                goal
            };
            let is_goal_park = (t as usize) >= pfx.len();
            for j in 0..inst.n {
                if j != i && !(is_goal_park && j == i) {
                    vertex_keys[j].insert(AgentConstraints::vertex_key(t, cell));
                }
            }
        }
        let arrival = first_permanent(pfx, goal, inst.horizon);
        paths[i] = Some(AgentPath {
            cells: pfx.clone(),
            arrival,
            goal,
            locked: true,
        });
    }

    for &i in &order {
        if paths[i].is_some() {
            continue;
        }
        if cancel
            .as_ref()
            .map(|c| c.load(Ordering::Relaxed))
            .unwrap_or(false)
        {
            stats.pp_failed_at = Some(i);
            return None;
        }
        if clock::now_ms() >= deadline_ms {
            stats.pp_failed_at = Some(i);
            return None;
        }
        let mut cons = AgentConstraints::new();
        cons.vertex = vertex_keys[i].iter().copied().collect();
        cons.vertex.sort_unstable();
        cons.edge = edge_keys[i].iter().copied().collect();
        cons.edge.sort_unstable();
        let mut expired = false;
        let mut ls = LowStats::default();
        let Some(suffix) = planner::plan(
            ctx,
            inst.start_cell(i),
            inst.prefix_end(i),
            inst.goals[i],
            &cons,
            &mut expired,
            &mut ls,
        ) else {
            stats.ll_expansions += ls.expansions;
            stats.ll_generated += ls.generated;
            stats.pp_failed_at = Some(i);
            return None;
        };
        stats.ll_expansions += ls.expansions;
        stats.ll_generated += ls.generated;
        let p = merge_path(inst, i, &suffix.positions, suffix.arrival);
        // 预约该车占用：t=0..=arrival 的格、t>arrival 的终点驻留、以及边对。
        // 注意：驻留段必须一直预约到 horizon —— 漏掉它会让后优先级车与“停在目标
        // 的前车”相撞（M09 自检拒收的根因）。
        for t in 0..=inst.horizon {
            let c = p.pos_at(t);
            for j in 0..inst.n {
                if j != i {
                    vertex_keys[j].insert(AgentConstraints::vertex_key(t, c));
                }
            }
        }
        for t in 0..p.arrival {
            let a = p.pos_at(t);
            let b = p.pos_at(t + 1);
            if a != b {
                for j in 0..inst.n {
                    if j != i {
                        edge_keys[j].insert(AgentConstraints::encode_edge(t, a, b, n_cells));
                        edge_keys[j].insert(AgentConstraints::encode_edge(t, b, a, n_cells));
                    }
                }
            }
        }
        for t in p.arrival + 1..=inst.horizon {
            for j in 0..inst.n {
                if j != i {
                    vertex_keys[j].insert(AgentConstraints::vertex_key(t, p.goal));
                }
            }
        }
        paths[i] = Some(p);
    }
    paths.into_iter().collect()
}

fn first_permanent(cells: &[Cell], goal: Cell, horizon: u32) -> u32 {
    // 前缀覆盖全时域 ⇒ cells[t] 对 t ≤ horizon 都有定义（不足部分为驻留）。
    let mut t = 0u32;
    while t <= horizon {
        let c = if (t as usize) < cells.len() {
            cells[t as usize]
        } else {
            goal
        };
        if c == goal {
            return t;
        }
        t += 1;
    }
    horizon
}
