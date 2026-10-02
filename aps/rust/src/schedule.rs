//! 排程状态：资源时间线 + 物料账本 + 可插入的最早可行落位。
//!
//! 这是求解器的“可变状态”层，对应 SRS §3 的数学变量：
//!
//! | 数学对象 | 本模块实现 |
//! |----------|------------|
//! | `x[o,m]`（机器选择） | `Assign.machine`，取值限于 `alternatives` 且能力匹配 |
//! | `y[o,w]`（人员选择） | `Assign.worker`，恰好一人且满足技能/资格 |
//! | `start[o] / end[o]` | `Assign.start / end`，`end = start + duration[o,m]` |
//! | 机器/人员/工装排他 | `mach_busy / work_busy / tool_busy` 有序区间不重叠 |
//! | 物料时序平衡（H07） | `cons` + `materials_ok()` 的后缀前缀和检查 |

use crate::calendar::{self, Interval};
use crate::compile::{Alt, Compiled, Min};
use crate::errors::codes;

/// 一道工序的完整资源映射。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Assign {
    pub machine: usize,
    pub worker: usize,
    pub start: Min,
    pub end: Min,
    pub dur: Min,
}

impl Assign {
    pub fn interval(&self) -> (Min, Min) {
        (self.start, self.end)
    }
}

/// 部分/完整排程。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Schedule {
    /// 按工序下标的分配（`None` 表示尚未排入）
    pub assign: Vec<Option<Assign>>,
    /// 每台机器的占用区间（按起点排序，两两不重叠）
    pub mach_busy: Vec<Vec<(Min, Min)>>,
    pub work_busy: Vec<Vec<(Min, Min)>>,
    pub tool_busy: Vec<Vec<(Min, Min)>>,
    /// 每物料：消耗事件 `(开始时刻, 数量)`，按时间排序（允许同刻多条）
    pub cons: Vec<Vec<(Min, i64)>>,
    pub scheduled_count: usize,
}

impl Schedule {
    pub fn new(c: &Compiled) -> Schedule {
        Schedule {
            assign: vec![None; c.ops.len()],
            mach_busy: vec![Vec::new(); c.machines.len()],
            work_busy: vec![Vec::new(); c.workers.len()],
            tool_busy: vec![Vec::new(); c.tools.len()],
            cons: vec![Vec::new(); c.materials.len()],
            scheduled_count: 0,
        }
    }

    pub fn is_complete(&self) -> bool {
        self.assign.iter().all(|a| a.is_some())
    }

    /// 工序的最早可开始时间：`max(订单投放, 全部前置工序结束, 0)`。
    /// 若有前置工序尚未排入则返回 `None`。
    pub fn op_ready(&self, c: &Compiled, op: usize) -> Option<Min> {
        let o = &c.ops[op];
        let mut est = o.release.max(0);
        for p in o.preds.iter() {
            let a = self.assign[*p]?;
            est = est.max(a.end);
        }
        Some(est)
    }

    /// 把分配写入时间线与物料账本（不做可行性检查，调用方需已确认可行）。
    pub fn place(&mut self, c: &Compiled, op: usize, a: Assign) {
        debug_assert!(self.assign[op].is_none(), "工序已排入");
        self.assign[op] = Some(a);
        self.scheduled_count += 1;
        calendar::insert_sorted(&mut self.mach_busy[a.machine], a.interval());
        calendar::insert_sorted(&mut self.work_busy[a.worker], a.interval());
        for t in c.ops[op].tools.iter() {
            calendar::insert_sorted(&mut self.tool_busy[*t], a.interval());
        }
        for (mi, qty) in c.ops[op].materials.iter() {
            calendar::insert_sorted(&mut self.cons[*mi], (a.start, *qty));
        }
    }

    /// 撤销分配。
    pub fn unplace(&mut self, c: &Compiled, op: usize) -> Option<Assign> {
        let a = self.assign[op]?;
        self.assign[op] = None;
        self.scheduled_count -= 1;
        calendar::remove_sorted(&mut self.mach_busy[a.machine], a.interval());
        calendar::remove_sorted(&mut self.work_busy[a.worker], a.interval());
        for t in c.ops[op].tools.iter() {
            calendar::remove_sorted(&mut self.tool_busy[*t], a.interval());
        }
        for (mi, qty) in c.ops[op].materials.iter() {
            calendar::remove_sorted(&mut self.cons[*mi], (a.start, *qty));
        }
        Some(a)
    }

    /// 工序完成时刻（未排入返回 `None`）。
    pub fn op_end(&self, op: usize) -> Option<Min> {
        self.assign[op].map(|a| a.end)
    }

    /// 订单完工：终端工序的最大结束时刻（未排完返回 `None`）。
    pub fn order_completion(&self, c: &Compiled, order: usize) -> Option<Min> {
        let terminals = c.terminal_ops(order);
        if terminals.is_empty() {
            return None;
        }
        let mut max_end: Option<Min> = None;
        for t in terminals {
            let e = self.op_end(t)?;
            max_end = Some(max_end.map_or(e, |m: Min| m.max(e)));
        }
        max_end
    }

    /// H07 后缀检查：在 `at` 时刻追加 `qty` 消耗后，从该时刻起的物料余额是否始终 ≥ 0。
    ///
    /// 事件顺序（与 `verify_mock.py` 一致）：**同一时刻先入库、后领料**。
    pub fn material_ok(&self, c: &Compiled, mi: usize, at: Min, qty: i64) -> bool {
        let mat = &c.materials[mi];
        // 前缀：截至 `at`（含）之前的余额
        let mut cur: i64 = mat.initial;
        for (t, q) in mat.receipts.iter() {
            if *t <= at {
                cur += *q;
            }
        }
        let mut cons_idx = 0usize;
        let cons = &self.cons[mi];
        while cons_idx < cons.len() && cons[cons_idx].0 <= at {
            cur -= cons[cons_idx].1;
            cons_idx += 1;
        }
        if cur < 0 {
            // 既有排程本身在该时刻之前已不可行（不应发生；保守返回 false）
            return false;
        }
        // 同一时刻：本次消耗 + 已排消耗（消耗之间顺序无关，整体不得透支）
        let mut at_qty = qty;
        while cons_idx < cons.len() && cons[cons_idx].0 == at {
            at_qty += cons[cons_idx].1;
            cons_idx += 1;
        }
        if cur - at_qty < 0 {
            return false;
        }
        cur -= at_qty;
        // 后续时刻：按时间推进，先入库后领料
        let mut rec_idx = mat.receipts.partition_point(|(t, _)| *t <= at);
        while cons_idx < cons.len() || rec_idx < mat.receipts.len() {
            let next_cons_t = cons.get(cons_idx).map(|(t, _)| *t);
            let next_rec_t = mat.receipts.get(rec_idx).map(|(t, _)| *t);
            let t = match (next_cons_t, next_rec_t) {
                (Some(a), Some(b)) => a.min(b),
                (Some(a), None) => a,
                (None, Some(b)) => b,
                (None, None) => break,
            };
            while rec_idx < mat.receipts.len() && mat.receipts[rec_idx].0 == t {
                cur += mat.receipts[rec_idx].1;
                rec_idx += 1;
            }
            while cons_idx < cons.len() && cons[cons_idx].0 == t {
                cur -= cons[cons_idx].1;
                cons_idx += 1;
            }
            if cur < 0 {
                return false;
            }
        }
        true
    }

    /// 组合检查：在 `s` 开始、时长 `dur`、机器 `machine`、人员 `worker` 是否完全可行。
    pub fn placement_ok(
        &self,
        c: &Compiled,
        op: usize,
        machine: usize,
        worker: usize,
        s: Min,
        dur: Min,
    ) -> bool {
        if s < 0 || s + dur > c.meta.horizon_len_min {
            return false;
        }
        let iv = (s, s + dur);
        if !fits(&c.machines[machine].windows, &self.mach_busy[machine], iv) {
            return false;
        }
        if !fits(&c.workers[worker].windows, &self.work_busy[worker], iv) {
            return false;
        }
        for t in c.ops[op].tools.iter() {
            if !fits(&[Interval::new(0, c.meta.horizon_len_min)], &self.tool_busy[*t], iv) {
                return false;
            }
        }
        for (mi, qty) in c.ops[op].materials.iter() {
            if !self.material_ok(c, *mi, s, *qty) {
                return false;
            }
        }
        true
    }

    /// 生成候选开始时刻（“事件锚点”）：
    /// 最早可开始时间、机器/人员/工装的占用区间端点与窗口端点、物料到货与消耗时刻、
    /// 以及各窗口“最晚可开始”位置。最早可行解必然落在这些锚点上（启发式取最早锚点）。
    pub fn anchors(
        &self,
        c: &Compiled,
        op: usize,
        machine: usize,
        worker: usize,
        est: Min,
        dur: Min,
    ) -> Vec<Min> {
        let mut out: Vec<Min> = Vec::with_capacity(32);
        out.push(est);
        let add = |v: Min, out: &mut Vec<Min>| {
            if v >= est {
                out.push(v);
            }
        };
        for w in c.machines[machine].windows.iter() {
            add(w.s, &mut out);
            add(w.e - dur, &mut out);
        }
        for w in c.workers[worker].windows.iter() {
            add(w.s, &mut out);
            add(w.e - dur, &mut out);
        }
        for (bs, be) in self.mach_busy[machine].iter() {
            add(*be, &mut out);
            add(*bs, &mut out);
        }
        for (bs, be) in self.work_busy[worker].iter() {
            add(*be, &mut out);
            add(*bs, &mut out);
        }
        for t in c.ops[op].tools.iter() {
            for (bs, be) in self.tool_busy[*t].iter() {
                add(*be, &mut out);
                add(*bs, &mut out);
            }
        }
        for (mi, _) in c.ops[op].materials.iter() {
            for (t, _) in c.materials[*mi].receipts.iter() {
                if *t >= est {
                    out.push(*t);
                }
            }
            for (t, _) in self.cons[*mi].iter() {
                if *t >= est {
                    out.push(*t);
                }
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// 为工序寻找“最早可行落位”（含机器与人员选择）。
    ///
    /// `worker_pref`：人员优先顺序（长度 = 人员数，越小越优先），用于负载均衡等策略；
    /// 选择依据依次为：开始时刻最早 → 时长最短 → 机器下标 → 人员优先级。
    pub fn earliest_placement(
        &self,
        c: &Compiled,
        op: usize,
        est: Min,
        worker_pref: &[u32],
    ) -> Option<Assign> {
        let cands = c.machine_candidates(op);
        if cands.is_empty() {
            return None;
        }
        let mut best: Option<(Assign, (i64, i64, usize, u32))> = None;
        for Alt { machine, duration } in cands.iter().copied() {
            for w in 0..c.workers.len() {
                if !c.worker_eligible(op, w) {
                    continue;
                }
                if !c.workers[w].windows.iter().any(|win| win.len() >= duration) {
                    continue;
                }
                let anchors = self.anchors(c, op, machine, w, est, duration);
                let mut found: Option<Min> = None;
                for s in anchors.iter().copied() {
                    if self.placement_ok(c, op, machine, w, s, duration) {
                        found = Some(s);
                        break;
                    }
                }
                if let Some(s) = found {
                    let key = (s, duration, machine, worker_pref.get(w).copied().unwrap_or(u32::MAX));
                    let assign = Assign {
                        machine,
                        worker: w,
                        start: s,
                        end: s + duration,
                        dur: duration,
                    };
                    if best.as_ref().map_or(true, |(_, bk)| key < *bk) {
                        best = Some((assign, key));
                    }
                }
            }
        }
        best.map(|(a, _)| a)
    }

    /// 左移紧致化：把所有工序尽量提前（不改变机器/人员选择，除非更早）。
    /// 提前只会降低完工时间，因此目标值单调不变差。
    pub fn left_shift_all(&mut self, c: &Compiled, worker_pref: &[u32], budget: &Budget) -> bool {
        let mut improved = false;
        let mut order: Vec<usize> = (0..c.ops.len()).filter(|i| self.assign[*i].is_some()).collect();
        order.sort_by_key(|op| self.assign[*op].map(|a| (a.start, *op)).unwrap());
        for op in order {
            if budget.expired() {
                break;
            }
            let cur = match self.assign[op] {
                Some(a) => a,
                None => continue,
            };
            // 仅当前置全部就绪时才可能提前
            let est = match self.op_ready(c, op) {
                Some(e) => e,
                None => continue,
            };
            if est >= cur.start {
                continue;
            }
            self.unplace(c, op);
            match self.earliest_placement(c, op, est, worker_pref) {
                Some(a) if a.start < cur.start => {
                    self.place(c, op, a);
                    improved = true;
                }
                _ => {
                    self.place(c, op, cur);
                }
            }
        }
        improved
    }
}

/// 区间 `[s, e)` 是否完整落在某个可用窗口内，且不与 `busy` 重叠。
pub fn fits(windows: &[Interval], busy: &[(Min, Min)], iv: (Min, Min)) -> bool {
    let inside = windows.iter().any(|w| w.s <= iv.0 && iv.1 <= w.e);
    if !inside {
        return false;
    }
    !busy.iter().any(|b| calendar::overlaps(*b, iv))
}

/// 预算 / 取消控制（可复现的时间预算 + 外部取消信号）。
#[derive(Debug)]
pub struct Budget {
    pub time_limit_ms: i64,
    pub cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    started_ms: f64,
}

impl Budget {
    pub fn new(time_limit_ms: i64, cancel: std::sync::Arc<std::sync::atomic::AtomicBool>) -> Budget {
        Budget {
            time_limit_ms,
            cancel,
            started_ms: crate::clock::now_ms(),
        }
    }

    pub fn elapsed_ms(&self) -> f64 {
        crate::clock::now_ms() - self.started_ms
    }

    pub fn expired(&self) -> bool {
        self.cancelled() || self.elapsed_ms() >= self.time_limit_ms as f64
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// 剩余时间（毫秒，负数表示已超时）
    pub fn remaining_ms(&self) -> f64 {
        self.time_limit_ms as f64 - self.elapsed_ms()
    }
}

/// 物料账本全量核验（求解器自检用；**独立校验器不调用此函数**）。
pub fn ledger_violation(c: &Compiled, s: &Schedule) -> Option<(usize, Min, i64)> {
    for (mi, mat) in c.materials.iter().enumerate() {
        let cons = &s.cons[mi];
        let mut ci = 0usize;
        let mut ri = 0usize;
        let mut cur = mat.initial;
        while ci < cons.len() || ri < mat.receipts.len() {
            let tc = cons.get(ci).map(|(t, _)| *t);
            let tr = mat.receipts.get(ri).map(|(t, _)| *t);
            let t = match (tc, tr) {
                (Some(a), Some(b)) => a.min(b),
                (Some(a), None) => a,
                (None, Some(b)) => b,
                (None, None) => break,
            };
            while ri < mat.receipts.len() && mat.receipts[ri].0 == t {
                cur += mat.receipts[ri].1;
                ri += 1;
            }
            while ci < cons.len() && cons[ci].0 == t {
                cur -= cons[ci].1;
                ci += 1;
            }
            if cur < 0 {
                return Some((mi, t, cur));
            }
        }
    }
    None
}

/// 资源排他性全量核验（求解器自检用）。
pub fn overlap_violation(c: &Compiled, s: &Schedule) -> Option<String> {
    for (mi, list) in s.mach_busy.iter().enumerate() {
        for pair in list.windows(2) {
            if calendar::overlaps(pair[0], pair[1]) {
                return Some(format!(
                    "{} 机器 '{}' 存在重叠占用 {:?} / {:?}",
                    codes::H03_MACHINE_OVERLAP,
                    c.machines[mi].id,
                    pair[0],
                    pair[1]
                ));
            }
        }
    }
    for (wi, list) in s.work_busy.iter().enumerate() {
        for pair in list.windows(2) {
            if calendar::overlaps(pair[0], pair[1]) {
                return Some(format!(
                    "{} 人员 '{}' 存在重叠占用",
                    codes::H05_WORKER_OVERLAP,
                    c.workers[wi].id
                ));
            }
        }
    }
    for (ti, list) in s.tool_busy.iter().enumerate() {
        for pair in list.windows(2) {
            if calendar::overlaps(pair[0], pair[1]) {
                return Some(format!(
                    "{} 工装 '{}' 存在重叠占用",
                    codes::H06_TOOL_OVERLAP,
                    c.tools[ti].id
                ));
            }
        }
    }
    None
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
        crate::compile::compile(&p, "test-hash".to_string())
    }

    #[test]
    fn place_and_unplace_roundtrip() {
        let c = load("mock/baseline.json");
        let mut s = Schedule::new(&c);
        let est = s.op_ready(&c, 0).unwrap();
        let a = s.earliest_placement(&c, 0, est, &vec![0; c.workers.len()]).unwrap();
        s.place(&c, 0, a);
        assert_eq!(s.scheduled_count, 1);
        assert!(s.assign[0].is_some());
        assert_eq!(overlap_violation(&c, &s), None);
        s.unplace(&c, 0);
        assert_eq!(s.scheduled_count, 0);
        assert!(s.mach_busy[a.machine].is_empty());
        assert!(s.cons.iter().all(|v| v.is_empty()));
    }

    #[test]
    fn placement_respects_calendar_gaps() {
        let c = load("mock/baseline.json");
        let mut s = Schedule::new(&c);
        // 8 个订单各有一道 CUT 工序（下标 0,3,6,...）：全部排入，验证不得跨越班次空档
        let cut_ops: Vec<usize> = (0..c.orders.len()).map(|oi| c.orders[oi].ops[0]).collect();
        let pref: Vec<u32> = (0..c.workers.len() as u32).collect();
        for op in cut_ops.iter() {
            let est = s.op_ready(&c, *op).unwrap();
            let a = s
                .earliest_placement(&c, *op, est, &pref)
                .expect("切割工序必须能找到落位");
            s.place(&c, *op, a);
        }
        assert_eq!(s.scheduled_count, 8);
        for (mi, m) in c.machines.iter().enumerate() {
            for (bs, be) in s.mach_busy[mi].iter() {
                assert!(
                    m.windows.iter().any(|w| w.s <= *bs && *be <= w.e),
                    "机器 {} 的占用 [{}, {}) 跨越了班次空档",
                    m.id,
                    bs,
                    be
                );
            }
        }
        assert_eq!(crate::schedule::overlap_violation(&c, &s), None);
        assert_eq!(crate::schedule::ledger_violation(&c, &s), None);
    }

    #[test]
    fn material_suffix_check_matches_full_ledger() {
        let c = load("mock/material-delay.json");
        let mut s = Schedule::new(&c);
        // 喷涂工序：M-PAINT 初始 8，10-07T08:00 到货 10（相对第 2880 分钟），每道耗 2
        let paint_ops: Vec<usize> = c
            .ops
            .iter()
            .enumerate()
            .filter(|(_, o)| o.materials.iter().any(|(mi, _)| c.materials[*mi].id == "M-PAINT"))
            .map(|(i, _)| i)
            .collect();
        assert_eq!(paint_ops.len(), 8);
        let receipt_rel = 2 * 1440;
        // 前 4 道耗掉初始库存 8
        for (k, op) in paint_ops.iter().take(4).enumerate() {
            let start = k as i64 * 30;
            s.place(
                &c,
                *op,
                Assign {
                    machine: 4,
                    worker: 6,
                    start,
                    end: start + 30,
                    dur: 30,
                },
            );
        }
        assert_eq!(crate::schedule::ledger_violation(&c, &s), None);
        // 第 5 道在到货前领料 → 透支
        assert!(!s.material_ok(&c, 2, 120, 2), "初始库存已耗尽，到货前不得领料");
        assert!(!s.material_ok(&c, 2, receipt_rel - 15, 2));
        // 到货后（同一时刻先入库再领料）→ 可行
        assert!(s.material_ok(&c, 2, receipt_rel, 2));
    }

    #[test]
    fn anchors_include_calendar_and_material_events() {
        let c = load("mock/baseline.json");
        let s = Schedule::new(&c);
        let anchors = s.anchors(&c, 0, 0, 0, 0, 30);
        assert!(anchors.contains(&0));
        // 第二段窗口起点 13:00 (相对 300 分钟) 应作为候选
        assert!(anchors.contains(&300));
    }
}
