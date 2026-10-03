//! 分配 + 排序调度器（AGV-SRS §3）。
//!
//! * `baseline`：确定性贪心（按 (release, −priority, id) 逐任务择优追加，全模拟评估）；
//! * `insertion-ls`：最省插入构造（局部曼哈顿估计）+ 确定性局部搜索
//!   （relocate / swap / 同车重排，首改进接受，全模拟代价评估）。
//!
//! 全部枚举顺序与平局裁决固定 ⇒ 同输入同参数同输出（语义指纹一致）。
//! 估计器见 `estimate.rs`；真实时间线见 `integrate.rs`。

use aps_engine::engine::CancelToken;

use crate::estimate::{capable, simulate, SchedInput};
use crate::problem::Problem;

#[derive(Debug, Clone)]
pub struct ScheduleResult {
    /// 每车**新分配**任务序列（下标 = 车辆 idx；picked 任务不在其中，见 SchedInput）。
    pub seq: Vec<Vec<usize>>,
    pub est: crate::estimate::EstPlan,
    pub algorithm: String,
    pub evaluations: u64,
    pub moves_accepted: u32,
    pub initial_cost: f64,
    pub final_cost: f64,
}

/// 搜索预算句柄（deadline 为绝对时刻 ms；cancel 为协作取消）。
pub struct Budget<'a> {
    pub deadline_ms: Option<f64>,
    pub cancel: Option<&'a CancelToken>,
    pub evaluations: u64,
}

impl<'a> Budget<'a> {
    fn stop(&self) -> bool {
        if let Some(c) = self.cancel {
            if c.is_cancelled() {
                return true;
            }
        }
        if let Some(d) = self.deadline_ms {
            if aps_engine::clock::now_ms() >= d {
                return true;
            }
        }
        false
    }
    fn tick(&mut self) -> bool {
        self.evaluations += 1;
        self.stop()
    }
}

/// 任务可调度性预检。返回 (可分配车辆列表, 是否结构性不可达)。
/// 结构性不可达 = 没有任何**有能力且可用**车辆可达任一取货泊位（BFS 证明，
/// 忽略其他车辆阻挡 —— 用于 INFEASIBLE 语义，见 engine.rs）。
pub fn feasible_vehicles(p: &Problem, ti: usize, input: &SchedInput) -> (Vec<usize>, bool) {
    let task = &p.tasks[ti];
    let pcands = task.pickup.dock_candidates(&p.stations);
    let dcands = task.dropoff.dock_candidates(&p.stations);
    let mut ok = Vec::new();
    for vi in 0..p.vehicles.len() {
        if !input.active[vi] || !capable(p, ti, vi) {
            continue;
        }
        let from = input.vehicles[vi].pos;
        let reach_pickup = pcands.iter().any(|&c| p.map.reachable(from, c));
        let reach_both = reach_pickup
            && pcands
                .iter()
                .any(|&c| dcands.iter().any(|&d| d == c || p.map.reachable(c, d)));
        if reach_both {
            ok.push(vi);
        }
    }
    let unreachable = ok.is_empty()
        && pcands.iter().all(|&c| {
            !p.vehicles.iter().enumerate().any(|(vi, _)| {
                input.active[vi] && capable(p, ti, vi) && p.map.reachable(input.vehicles[vi].pos, c)
            })
        });
    (ok, unreachable)
}

/// 确定性任务顺序：(release, −priority, id)。
fn task_order(p: &Problem, free: &[usize]) -> Vec<usize> {
    let mut order = free.to_vec();
    order.sort_by(|&a, &b| {
        let (ta, tb) = (&p.tasks[a], &p.tasks[b]);
        (
            ta.release_step,
            std::cmp::Reverse(ta.priority),
            ta.id.as_str(),
        )
            .cmp(&(
                tb.release_step,
                std::cmp::Reverse(tb.priority),
                tb.id.as_str(),
            ))
    });
    order
}

/// 入口：按 solver.algorithm 调度（auto → insertion-ls）。
pub fn schedule(
    p: &Problem,
    input: &SchedInput,
    algorithm: &str,
    deadline_ms: Option<f64>,
    cancel: Option<&CancelToken>,
) -> ScheduleResult {
    match algorithm {
        "baseline" => baseline(p, input, deadline_ms, cancel),
        _ => insertion_ls(p, input, deadline_ms, cancel),
    }
}

// ------------------------------------------------------------------ baseline

fn baseline(
    p: &Problem,
    input: &SchedInput,
    deadline_ms: Option<f64>,
    cancel: Option<&CancelToken>,
) -> ScheduleResult {
    let mut seq: Vec<Vec<usize>> = p.vehicles.iter().map(|_| vec![]).collect();
    let mut budget = Budget {
        deadline_ms,
        cancel,
        evaluations: 0,
    };
    for ti in task_order(p, &input.free) {
        if budget.tick() {
            break; // 预算尽：剩余任务不进序列（engine 层如实标注 unassigned/budget）
        }
        let mut best: Option<(f64, usize)> = None;
        for vi in 0..p.vehicles.len() {
            if !input.active[vi] || !capable(p, ti, vi) {
                continue;
            }
            seq[vi].push(ti);
            let est = simulate(p, input, &seq);
            seq[vi].pop();
            let c = est.cost;
            match best {
                Some((bc, _)) if c >= bc => {}
                _ => best = Some((c, vi)),
            }
        }
        if let Some((_, vi)) = best {
            seq[vi].push(ti);
        }
    }
    let est = simulate(p, input, &seq);
    ScheduleResult {
        algorithm: "baseline".into(),
        evaluations: budget.evaluations,
        moves_accepted: 0,
        initial_cost: est.cost,
        final_cost: est.cost,
        seq,
        est,
    }
}

// ------------------------------------------------------------- insertion-ls

/// 局部插入代价（O(1) 曼哈顿估计，构造阶段引导用；LS 用全模拟）。
fn local_insert_cost(
    p: &Problem,
    input: &SchedInput,
    vi: usize,
    route: &[usize],
    at: usize,
    ti: usize,
) -> f64 {
    let task = &p.tasks[ti];
    let pdock = task.pickup.dock_candidates(&p.stations)[0];
    let ddock = task.dropoff.dock_candidates(&p.stations)[0];
    let prev_pos = if at == 0 {
        input.vehicles[vi].pos
    } else {
        let prev = &p.tasks[route[at - 1]];
        prev.dropoff.dock_candidates(&p.stations)[0]
    };
    let next_pos = if at < route.len() {
        let next = &p.tasks[route[at]];
        next.pickup.dock_candidates(&p.stations)[0]
    } else {
        prev_pos
    };
    let direct = p.map.manhattan(prev_pos, next_pos) as f64;
    let via = p.map.manhattan(prev_pos, pdock) as f64
        + task.pickup_service as f64
        + p.map.manhattan(pdock, ddock) as f64
        + task.dropoff_service as f64
        + p.map.manhattan(ddock, next_pos) as f64;
    let lateness_hint = task.due_step.map_or(0.0, |d| {
        (task.release_step as f64 + via - d as f64).max(0.0)
    });
    (via - direct) * task.priority as f64 + lateness_hint
}

fn construction(p: &Problem, input: &SchedInput, budget: &mut Budget) -> Vec<Vec<usize>> {
    let mut seq: Vec<Vec<usize>> = p.vehicles.iter().map(|_| vec![]).collect();
    for ti in task_order(p, &input.free) {
        if budget.tick() {
            break;
        }
        let (cands, _) = feasible_vehicles(p, ti, input);
        if cands.is_empty() {
            continue;
        }
        let mut best: Option<(f64, (usize, usize))> = None;
        for &vi in &cands {
            for k in 0..=seq[vi].len() {
                let c = local_insert_cost(p, input, vi, &seq[vi], k, ti) + 1e-3 * vi as f64;
                match best {
                    Some((bc, _)) if c >= bc => {}
                    _ => best = Some((c, (vi, k))),
                }
            }
        }
        if let Some((_, (vi, k))) = best {
            seq[vi].insert(k, ti);
        }
    }
    seq
}

/// 当前 (车, 位)。
fn locate(seq: &[Vec<usize>], ti: usize) -> Option<(usize, usize)> {
    seq.iter()
        .enumerate()
        .find_map(|(vi, s)| s.iter().position(|&x| x == ti).map(|k| (vi, k)))
}

fn insertion_ls(
    p: &Problem,
    input: &SchedInput,
    deadline_ms: Option<f64>,
    cancel: Option<&CancelToken>,
) -> ScheduleResult {
    let mut budget = Budget {
        deadline_ms,
        cancel,
        evaluations: 0,
    };
    // 起点 = 插入构造 与 基线贪心 中较优者（保证不差于基线；两者皆确定性）
    let mut seq = construction(p, input, &mut budget);
    let mut est = simulate(p, input, &seq);
    if budget.tick() {
        return ScheduleResult {
            seq,
            est: est.clone(),
            algorithm: "insertion-ls".into(),
            evaluations: budget.evaluations,
            moves_accepted: 0,
            initial_cost: est.cost,
            final_cost: est.cost,
        };
    }
    {
        let b = baseline(p, input, deadline_ms, cancel);
        budget.evaluations += b.evaluations;
        if b.final_cost < est.cost - 1e-9 {
            seq = b.seq;
            est = b.est;
        }
    }
    let initial = est.cost;
    let mut accepted: u32 = 0;

    // —— 局部搜索：relocate（含同车重排）+ swap，首改进，确定性枚举 ——
    let snapshot_assigned: Vec<usize> = seq.iter().flat_map(|s| s.iter().copied()).collect();
    'outer: for &ti in &snapshot_assigned {
        let Some(cur) = locate(&seq, ti) else {
            continue;
        };
        // relocate / reorder
        for vi in 0..p.vehicles.len() {
            if !input.active[vi] || !capable(p, ti, vi) {
                continue;
            }
            for k in 0..=seq[vi].len() {
                if vi == cur.0 && (k == cur.1 || k == cur.1 + 1) {
                    continue; // 原位（移除后同位）
                }
                if budget.tick() {
                    break 'outer;
                }
                let mut cand = seq.clone();
                cand[cur.0].remove(cur.1);
                let kk = if vi == cur.0 && k > cur.1 { k - 1 } else { k };
                let pos = kk.min(cand[vi].len());
                cand[vi].insert(pos, ti);
                let e2 = simulate(p, input, &cand);
                if e2.cost < est.cost - 1e-9 {
                    seq = cand;
                    est = e2;
                    accepted += 1;
                    continue 'outer;
                }
            }
        }
        // swap（跨车互换）
        for &tj in &snapshot_assigned {
            if tj == ti {
                continue;
            }
            let Some(other) = locate(&seq, tj) else {
                continue;
            };
            if other.0 == cur.0 {
                continue;
            }
            if !capable(p, ti, other.0) || !capable(p, tj, cur.0) {
                continue;
            }
            if budget.tick() {
                break 'outer;
            }
            let mut cand = seq.clone();
            cand[cur.0][cur.1] = tj;
            cand[other.0][other.1] = ti;
            let e2 = simulate(p, input, &cand);
            if e2.cost < est.cost - 1e-9 {
                seq = cand;
                est = e2;
                accepted += 1;
                continue 'outer;
            }
        }
    }
    ScheduleResult {
        algorithm: "insertion-ls".into(),
        evaluations: budget.evaluations,
        moves_accepted: accepted,
        initial_cost: initial,
        final_cost: est.cost,
        seq,
        est,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capabilities::Profile;
    use crate::estimate::SchedInput;
    use crate::problem::parse_problem;

    fn text() -> String {
        r#"{
            "map": { "cells": ["......", "......", "......"] },
            "time_model": { "horizon": 80 },
            "vehicles": [ { "id": "V1", "start": [0,0] }, { "id": "V2", "start": [5,2] } ],
            "tasks": [
                { "id": "T1", "pickup": [4,0], "dropoff": [1,2] },
                { "id": "T2", "pickup": [1,0], "dropoff": [4,2] },
                { "id": "T3", "pickup": [2,1], "dropoff": [3,1] }
            ],
            "objective": { "kind": "lexicographic-weighted" }
        }"#
        .to_string()
    }

    #[test]
    fn baseline_assigns_all_deterministically() {
        let p = parse_problem(&text(), Profile::Native).unwrap();
        let input = SchedInput::static_new(&p);
        let r1 = baseline(&p, &input, None, None);
        let r2 = baseline(&p, &input, None, None);
        assert_eq!(r1.seq, r2.seq);
        assert_eq!(r1.seq.iter().map(Vec::len).sum::<usize>(), 3);
        assert!(r1.final_cost > 0.0);
    }

    #[test]
    fn ls_not_worse_than_baseline() {
        let p = parse_problem(&text(), Profile::Native).unwrap();
        let input = SchedInput::static_new(&p);
        let b = baseline(&p, &input, None, None);
        let l = insertion_ls(&p, &input, None, None);
        assert!(
            l.final_cost <= b.final_cost + 1e-9,
            "ls {} > baseline {}",
            l.final_cost,
            b.final_cost
        );
        assert_eq!(l.seq.iter().map(Vec::len).sum::<usize>(), 3);
    }

    #[test]
    fn capability_filtering() {
        let body = r#"{
            "map": { "cells": ["...","..."] },
            "time_model": { "horizon": 30 },
            "vehicles": [
                { "id": "V1", "start": [0,0], "capabilities": ["general"] },
                { "id": "V2", "start": [2,0], "capabilities": ["heavy", "general"] }
            ],
            "tasks": [ { "id": "T1", "pickup": [1,0], "dropoff": [1,1], "required_capability": "heavy" } ],
            "objective": { "kind": "lexicographic-weighted" }
        }"#
        .to_string();
        let p = parse_problem(&body, Profile::Native).unwrap();
        let input = SchedInput::static_new(&p);
        let r = baseline(&p, &input, None, None);
        assert_eq!(r.seq[0].len(), 0);
        assert_eq!(r.seq[1].len(), 1);
        let (cands, _) = feasible_vehicles(&p, 0, &input);
        assert_eq!(cands, vec![1]);
    }

    #[test]
    fn structurally_unreachable_detected() {
        let body = r##"{
            "map": { "cells": ["..#..", "..#.."] },
            "time_model": { "horizon": 30 },
            "vehicles": [ { "id": "V1", "start": [0,0] } ],
            "tasks": [ { "id": "T1", "pickup": [3,0], "dropoff": [1,1] } ],
            "objective": { "kind": "lexicographic-weighted" }
        }"##;
        let p = parse_problem(body, Profile::Native).unwrap();
        let input = SchedInput::static_new(&p);
        let (cands, unreachable) = feasible_vehicles(&p, 0, &input);
        assert!(cands.is_empty());
        assert!(unreachable, "(3,0) 被整列墙隔离 ⇒ BFS 证明结构性不可达");
    }
}
