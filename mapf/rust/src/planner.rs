//! 底层规划器：单机器人在 (cell, t) 时空图上的 A*（联合求解的 low-level oracle）。
//!
//! 状态 = (单元, 时刻)；动作 = wait + 四邻域，单位代价；启发 = 曼哈顿距离
//! （对“到达终点所需最少步数”可采纳）。路径在**首次踏入终点**时终止
//! （stay-at-target 语义 ⇒ 到达后离开不可能是更优解）。
//!
//! 输入约束：
//! * `vertex`：`(cell, t)` 不可占据（t ≥ 到达时刻时隐含驻留，由调用方把目标格约束补齐）；
//! * `edge`：`(from, to, t)` 表示第 t→t+1 步不允许该移动（对向交换消解）；
//! * `blocked`：全局动态障碍窗口（cell → Vec<(start,end)>，end 开区间/`u32::MAX`=∞）；
//! * `free_win`：静态障碍被 `obstacle_remove` 事件解禁的窗口（仅对静态障碍格生效）。
//!
//! 本模块的判断逻辑与 `verify.rs` **互不复用**（SRS §4 独立性要求）。

use std::collections::{BinaryHeap, HashMap};

use crate::problem::{Cell, MapData};
use aps_engine::clock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// 单个机器人在分支上累积的约束集合。CBS 树节点 = 每车一组 `AgentConstraints`。
#[derive(Debug, Clone, Default)]
pub struct AgentConstraints {
    /// key = (t as u64) << 32 | cell
    pub vertex: Vec<u64>,
    /// key = (t as u64) * cells^2 + from*cells + to —— 编码见 encode_edge
    pub edge: Vec<u64>,
}

impl AgentConstraints {
    pub fn new() -> AgentConstraints {
        AgentConstraints::default()
    }
    pub fn vertex_key(t: u32, cell: Cell) -> u64 {
        ((t as u64) << 32) | cell as u64
    }
    pub fn encode_edge(t: u32, from: Cell, to: Cell, cells: u64) -> u64 {
        (t as u64) * cells * cells + (from as u64) * cells + to as u64
    }
    pub fn add_vertex(&mut self, t: u32, cell: Cell) {
        self.vertex.push(Self::vertex_key(t, cell));
    }
    pub fn add_edge(&mut self, t: u32, from: Cell, to: Cell, cells: u64) {
        self.edge.push(Self::encode_edge(t, from, to, cells));
    }
}

/// 规划出的单机器人路径：t=start_t..=arrival 的位置序列。
#[derive(Debug, Clone)]
pub struct LowPlan {
    pub positions: Vec<Cell>,
    pub start_t: u32,
    pub arrival: u32,
}

impl LowPlan {
    #[inline]
    pub fn pos_at(&self, t: u32) -> Cell {
        if t <= self.arrival {
            self.positions[(t - self.start_t) as usize]
        } else {
            *self.positions.last().expect("non-empty path")
        }
    }
}

/// 单次 low-level 搜索的统计（累计进高层统计）。
#[derive(Debug, Default, Clone, Copy)]
pub struct LowStats {
    pub expansions: u64,
    pub generated: u64,
}

#[derive(Debug)]
pub struct LowCtx<'a> {
    pub map: &'a MapData,
    pub blocked: &'a [Vec<(u32, u32)>],
    pub free_win: &'a [Vec<(u32, u32)>],
    pub horizon: u32,
    pub deadline_ms: f64,
    pub budget_enabled: bool,
    pub cancel: Option<Arc<AtomicBool>>,
    pub expansions_cap: usize,
}

impl<'a> LowCtx<'a> {
    #[inline]
    pub fn cell_blocked(&self, cell: Cell, t: u32) -> bool {
        // 静态障碍默认全时域封锁，除非被 obstacle_remove 窗口解禁。
        if self.map.is_blocked_static(cell) {
            let fw = match self.free_win.get(cell as usize) {
                Some(v) => v,
                None => return true, // 无解禁窗口声明 ⇒ 恒封锁
            };
            return !fw.iter().any(|&(a, b)| t >= a && t < b);
        }
        match self.blocked.get(cell as usize) {
            Some(v) => v.iter().any(|&(a, b)| t >= a && t < b),
            None => false,
        }
    }
}

/// 在时域/预算内为单机器人找最短（最早到达）路径；穷尽后返回 None。
///
/// `budget_expired` 输出参数：true ⇒ 因时间/取消/扩展上限提前退出，
/// 调用方**不得**据此宣告不可达（SRS：超时 ≠ 无解）。
pub fn plan(
    ctx: &LowCtx<'_>,
    start: Cell,
    start_t: u32,
    goal: Cell,
    cons: &AgentConstraints,
    budget_expired: &mut bool,
    stats: &mut LowStats,
) -> Option<LowPlan> {
    let n_cells = ctx.map.n_cells() as u64;
    let vertex: HashMap<u64, ()> = cons.vertex.iter().map(|k| (*k, ())).collect();
    let edge: HashMap<u64, ()> = if cons.edge.is_empty() {
        HashMap::new()
    } else {
        cons.edge.iter().map(|k| (*k, ())).collect()
    };

    // goal 上的顶点约束：stay-at-target 语义下，机器人到达后将驻留直至时域末，
    // 因此任何 (goal, t') 约束（t' ∈ [arrival, horizon]）都会违反。等价条件：
    // arrival > max_goal_cons。若不检查此处，CBS 对“驻留车与过路车”的冲突分支将
    // 产生永不生效的约束 ⇒ 树无限生长（正确性 + 终止性双缺陷）。
    let mut max_goal_cons: Option<u32> = None;
    for &k in &cons.vertex {
        if (k & 0xFFFF_FFFF) as u32 == goal {
            let ct = (k >> 32) as u32;
            max_goal_cons = Some(max_goal_cons.map_or(ct, |m| m.max(ct)));
        }
    }
    let goal_park_ok = |t: u32| max_goal_cons.map_or(true, |mc| t > mc);

    // 起点本身被约束封锁 ⇒ 无解（若时域内起点被占，等价于“该承诺不可维持”）。
    let blocked_now = ctx.cell_blocked(start, start_t)
        || vertex.contains_key(&AgentConstraints::vertex_key(start_t, start));
    if blocked_now {
        return None;
    }
    if start == goal {
        if goal_park_ok(start_t) {
            return Some(LowPlan {
                positions: vec![start],
                start_t,
                arrival: start_t,
            });
        }
        // 起点=终点但驻留被封锁：需先离开再回来（继续走通用搜索）。
    }

    let mut g_score: HashMap<u64, u32> = HashMap::new();
    let mut came: HashMap<u64, u64> = HashMap::new();
    let mut open: BinaryHeap<Node> = BinaryHeap::new();

    let start_key = ((start_t as u64) << 32) | start as u64;
    let h0 = ctx.map.manhattan(start, goal);
    g_score.insert(start_key, start_t);
    open.push(Node {
        f: start_t + h0,
        g: start_t,
        key: start_key,
    });
    *budget_expired = false;
    // 内部预算检查节拍（每次弹出检查时钟的成本可接受：pop 数 × ~50ns）
    let mut popped: u64 = 0;
    let mut out_of_budget = false;

    while let Some(cur) = open.pop() {
        popped += 1;
        if popped & 0x3FF == 0 {
            if ctx.expansions_cap != 0 && stats.expansions as usize >= ctx.expansions_cap {
                out_of_budget = true;
                break;
            }
            if ctx.budget_enabled && clock::now_ms() >= ctx.deadline_ms {
                out_of_budget = true;
                break;
            }
            if ctx
                .cancel
                .as_ref()
                .map(|c| c.load(Ordering::Relaxed))
                .unwrap_or(false)
            {
                out_of_budget = true;
                break;
            }
        }
        stats.expansions += 1;
        let cell = (cur.key & 0xFFFF_FFFF) as Cell;
        let t = (cur.key >> 32) as u32;
        if g_score.get(&cur.key).map(|g| *g != t).unwrap_or(true) {
            continue; // 陈旧堆项
        }
        let reentry = !(start == goal && t == start_t); // 起点即终点的初始态不算“到达”
        if cell == goal && reentry && goal_park_ok(t) {
            // 回溯路径（仅当到达后的全程驻留均合法时才接受）。
            let mut cells = vec![cell];
            let mut k = cur.key;
            while let Some(&p) = came.get(&k) {
                cells.push((p & 0xFFFF_FFFF) as Cell);
                k = p;
            }
            cells.reverse();
            let st = (k >> 32) as u32;
            return Some(LowPlan {
                positions: cells,
                start_t: st,
                arrival: t,
            });
        }
        let nt = t + 1;
        if nt > ctx.horizon
            || (nt as u64) + (ctx.map.manhattan(cell, goal) as u64) > ctx.horizon as u64
        {
            continue; // 时域剪枝：剩余距离已不可达
        }
        // 确定性动作序：wait, E, W, N, S
        let moves = ctx.map.neighbors(cell);
        for (mi, &m) in moves.iter().enumerate() {
            if m == u32::MAX {
                continue;
            }
            let to = if mi == 0 { cell } else { m };
            if ctx.cell_blocked(to, nt) {
                continue;
            }
            if vertex.contains_key(&AgentConstraints::vertex_key(nt, to)) {
                continue;
            }
            if mi != 0 && !edge.is_empty() {
                // 边约束是定向的“该机器人不得在 t→t+1 沿 u→v 移动”；wait 不构成边交换。
                let ek = AgentConstraints::encode_edge(t, cell, to, n_cells);
                if edge.contains_key(&ek) {
                    continue;
                }
            }
            let nkey = ((nt as u64) << 32) | to as u64;
            stats.generated += 1;
            if g_score.get(&nkey).map(|g| *g <= nt).unwrap_or(false) {
                continue;
            }
            g_score.insert(nkey, nt);
            came.insert(nkey, cur.key);
            let f = nt + ctx.map.manhattan(to, goal);
            open.push(Node {
                f,
                g: nt,
                key: nkey,
            });
        }
    }
    *budget_expired = out_of_budget;
    None
}

#[derive(PartialEq, Eq)]
struct Node {
    f: u32,
    g: u32,
    key: u64,
}

impl Ord for Node {
    fn cmp(&self, other: &Node) -> std::cmp::Ordering {
        // 小顶堆：f 优先，其次 g 大者先（深度优先倾向，标准 A* 技巧），最后 key。
        other
            .f
            .cmp(&self.f)
            .then(other.g.cmp(&self.g))
            .then(other.key.cmp(&self.key))
    }
}
impl PartialOrd for Node {
    fn partial_cmp(&self, other: &Node) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty3() -> (MapData, Vec<Vec<(u32, u32)>>, Vec<Vec<(u32, u32)>>) {
        let m = MapData {
            width: 3,
            height: 3,
            blocked: vec![false; 9],
        };
        (m, Vec::new(), Vec::new())
    }

    #[test]
    fn straight_line_and_wait_constraint() {
        let (m, b, f) = empty3();
        let ctx = LowCtx {
            map: &m,
            blocked: &b,
            free_win: &f,
            horizon: 10,
            deadline_ms: f64::INFINITY,
            budget_enabled: false,
            cancel: None,
            expansions_cap: 0,
        };
        let mut expired = false;
        let p = plan(
            &ctx,
            0,
            0,
            2,
            &AgentConstraints::new(),
            &mut expired,
            &mut LowStats::default(),
        )
        .unwrap();
        assert_eq!(p.arrival, 2);
        assert_eq!(p.positions, vec![0, 1, 2]);
        // 禁止 t=1 时处于 (1,0)：需绕一行
        let mut c = AgentConstraints::new();
        c.add_vertex(1, 1);
        let p = plan(&ctx, 0, 0, 2, &c, &mut expired, &mut LowStats::default()).unwrap();
        assert!(p.arrival > 2, "{:?}", p.positions);
        // 禁止 t=1,2 的 (1,0),(1,1)... 逐步封锁直至不可达
        let mut c2 = AgentConstraints::new();
        for t in 1..=3 {
            c2.add_vertex(t, 1);
            c2.add_vertex(t, 4);
        }
        // 封锁收窄时域：h=3 内不存在绕 (1,0)/(1,1) 到达 (2,0) 的路径 ⇒ 穷尽 None。
        let ctx3 = LowCtx {
            map: &m,
            blocked: &b,
            free_win: &f,
            horizon: 3,
            deadline_ms: f64::INFINITY,
            budget_enabled: false,
            cancel: None,
            expansions_cap: 0,
        };
        let none = plan(&ctx3, 0, 0, 2, &c2, &mut expired, &mut LowStats::default());
        assert!(
            none.is_none() && !expired,
            "穷尽（h=3 无解）不应被标记为超预算"
        );
    }

    #[test]
    fn horizon_pruning_reports_exhausted_not_budget() {
        let (m, b, f) = empty3();
        let ctx = LowCtx {
            map: &m,
            blocked: &b,
            free_win: &f,
            horizon: 1,
            deadline_ms: f64::INFINITY,
            budget_enabled: false,
            cancel: None,
            expansions_cap: 0,
        };
        let mut expired = true;
        assert!(plan(
            &ctx,
            0,
            0,
            2,
            &AgentConstraints::new(),
            &mut expired,
            &mut LowStats::default()
        )
        .is_none());
        assert!(!expired, "穷尽不是超预算：不得标记 budget_expired");
    }
}
