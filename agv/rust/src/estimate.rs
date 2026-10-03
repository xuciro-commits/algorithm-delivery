//! 时间线模拟估计器：给定（车辆序列 → 任务）的分配方案，用曼哈顿距离 + 泊位/
//! 容量簿记快速估计每任务的完成时刻与加权目标（AGV-SRS §3）。
//!
//! 估计器只用于**调度搜索的引导**；真实时间线由 `integrate.rs` 的 MAPF 段规划
//! 产生，指标以真实时间线为准（metrics.rs）。估计不访问 MAPF 引擎。

use std::collections::BTreeMap;

use crate::problem::{Cell, MapData, Problem, Station, TaskLoc, Weights};

/// 每任务估计结果。
#[derive(Debug, Clone, Default)]
pub struct TaskEst {
    pub vehicle: usize,
    pub pickup_dock: Cell,
    pub dropoff_dock: Cell,
    pub pickup_arrival: u32,
    /// 取货服务结束（含释放等待）。
    pub pickup_done: u32,
    pub dropoff_arrival: u32,
    pub dropoff_done: u32,
    pub flow: u32,
    pub lateness: u32,
    /// 空驶步数（上一位置 → 取货泊位）。
    pub empty_travel: u32,
    /// 载货步数（取货泊位 → 送达泊位）。
    pub loaded_travel: u32,
}

/// 整个方案的估计。
#[derive(Debug, Clone, Default)]
pub struct EstPlan {
    /// per task（已分配任务有估计；未分配为 None）。
    pub tasks: Vec<Option<TaskEst>>,
    pub vehicle_end_pos: Vec<Cell>,
    pub vehicle_end_time: Vec<u32>,
    /// 停车格分配（车 idx → 格；无停车声明时全 None）。
    pub parking_assign: Vec<Option<Cell>>,
    pub makespan: u32,
    /// Σ pᵢ·flowᵢ（优先级加权，与目标函数一致）。
    pub total_flow: u64,
    pub total_lateness: u64,
    pub total_empty: u64,
    pub cost: f64,
}

/// 调度输入：把静态问题与动态快照统一成一个形状（assign.rs / integrate.rs 共用）。
#[derive(Debug, Clone)]
pub struct VehicleInit {
    pub pos: Cell,
    pub time: u32,
    /// 已取货待送达的任务（按执行序；估算时只补送达段）。
    pub picked: Vec<usize>,
}

#[derive(Debug, Clone)]
pub struct SchedInput {
    pub vehicles: Vec<VehicleInit>, // 与 problem.vehicles 对齐
    pub active: Vec<bool>,
    /// 可（重）分配的任务下标。
    pub free: Vec<usize>,
}

impl SchedInput {
    pub fn static_new(p: &Problem) -> SchedInput {
        SchedInput {
            vehicles: p
                .vehicles
                .iter()
                .map(|v| VehicleInit {
                    pos: v.start,
                    time: 0,
                    picked: vec![],
                })
                .collect(),
            active: p.vehicles.iter().map(|v| !v.paused).collect(),
            free: (0..p.tasks.len()).collect(),
        }
    }
}

#[derive(Default)]
struct Bookings {
    /// 泊位格 → 最早可用时刻。
    dock_free: BTreeMap<Cell, u32>,
    /// 工作站 idx → 服务区间列表 (start, end)（含端点）。
    station_svc: Vec<Vec<(u32, u32)>>,
}

fn station_of(loc: &TaskLoc, _stations: &[Station]) -> Option<usize> {
    match loc {
        TaskLoc::Station(i) => Some(*i),
        TaskLoc::Cell(_) => None,
    }
}

impl Bookings {
    /// 把服务 [start, start+dur] 放进工作站容量约束，返回合法的最早开始时刻。
    fn adjust_capacity(&self, st: Option<usize>, capacity: usize, start: u32, dur: u32) -> u32 {
        let Some(si) = st else { return start };
        let mut s = start;
        loop {
            let concurrent = self.station_svc[si]
                .iter()
                .filter(|(a, b)| *a <= s + dur && *b >= s)
                .count();
            if concurrent < capacity {
                return s;
            }
            s = self.station_svc[si]
                .iter()
                .filter(|(_, b)| *b >= s)
                .map(|(_, b)| b + 1)
                .min()
                .unwrap_or(s + 1);
        }
    }
    fn commit(&mut self, st: Option<usize>, dock: Cell, start: u32, dur: u32, hold_until: u32) {
        let e = self
            .dock_free
            .get(&dock)
            .copied()
            .unwrap_or(0)
            .max(hold_until);
        self.dock_free.insert(dock, e);
        if let Some(si) = st {
            self.station_svc[si].push((start, start + dur));
        }
    }
}

/// 选择泊位：最小化 max(出发+曼哈顿, 泊位空闲) —— 平局取格编号小者（确定性）。
/// 返回 (泊位, 到达时刻)。
fn pick_dock(
    map: &MapData,
    cands: &[Cell],
    from: Cell,
    depart: u32,
    dock_free: &BTreeMap<Cell, u32>,
) -> (Cell, u32) {
    let mut best: Option<(u32, Cell)> = None;
    for &d in cands {
        let arrival =
            (depart + map.manhattan(from, d)).max(dock_free.get(&d).copied().unwrap_or(0));
        match best {
            Some((bt, _)) if arrival >= bt => {}
            _ => best = Some((arrival, d)),
        }
    }
    match best {
        // 注意：Cell 是 u32 别名，此处必须显式换序（arrival, dock) → (dock, arrival)
        Some((arrival, d)) => (d, arrival),
        None => (cands[0], depart),
    }
}

/// 模拟整个分配方案（两遍：先任务段得终位，再确定性分配停车格）。
/// `seq` = 每车**新分配**任务序列（picked 已并入 VehicleInit）。
pub fn simulate(p: &Problem, input: &SchedInput, seq: &[Vec<usize>]) -> EstPlan {
    let mut plan = EstPlan {
        tasks: vec![None; p.tasks.len()],
        vehicle_end_pos: p.vehicles.iter().map(|v| v.start).collect(),
        vehicle_end_time: vec![0; p.vehicles.len()],
        parking_assign: vec![None; p.vehicles.len()],
        ..Default::default()
    };
    let mut bk = Bookings {
        dock_free: BTreeMap::new(),
        station_svc: vec![vec![]; p.stations.len()],
    };
    let mut parking_empty: u64 = 0;
    let mut makespan: u32 = 0;
    for (vi, _) in p.vehicles.iter().enumerate() {
        let init = &input.vehicles[vi];
        let mut pos = init.pos;
        let mut t = init.time;
        // 1) 已取货任务：只补送达段
        for &ti in &init.picked {
            let task = &p.tasks[ti];
            let cands = task.dropoff.dock_candidates(&p.stations);
            let (dock, arrival) = pick_dock(&p.map, &cands, pos, t, &bk.dock_free);
            let cap = station_capacity(p, &task.dropoff);
            let svc_start = bk.adjust_capacity(
                station_of(&task.dropoff, &p.stations),
                cap,
                arrival,
                task.dropoff_service,
            );
            let done = svc_start + task.dropoff_service;
            bk.commit(
                station_of(&task.dropoff, &p.stations),
                dock,
                svc_start,
                task.dropoff_service,
                done + 1,
            );
            plan.tasks[ti] = Some(TaskEst {
                vehicle: vi,
                pickup_dock: pos,
                dropoff_dock: dock,
                pickup_arrival: 0,
                pickup_done: 0,
                dropoff_arrival: arrival,
                dropoff_done: done,
                flow: done.saturating_sub(task.release_step),
                lateness: task.due_step.map_or(0, |d| done.saturating_sub(d)),
                empty_travel: 0,
                loaded_travel: p.map.manhattan(pos, dock),
            });
            pos = dock;
            t = done;
        }
        // 2) 新分配任务（按序列序）
        for &ti in &seq[vi] {
            let task = &p.tasks[ti];
            let pcands = task.pickup.dock_candidates(&p.stations);
            let (pdock, parr) = pick_dock(&p.map, &pcands, pos, t, &bk.dock_free);
            let cap_p = station_capacity(p, &task.pickup);
            let psvc = bk.adjust_capacity(
                station_of(&task.pickup, &p.stations),
                cap_p,
                parr.max(task.release_step),
                task.pickup_service,
            );
            let pdone = psvc + task.pickup_service;
            let dcands = task.dropoff.dock_candidates(&p.stations);
            let (ddock, darr) = pick_dock(&p.map, &dcands, pdock, pdone, &bk.dock_free);
            let cap_d = station_capacity(p, &task.dropoff);
            let dsvc = bk.adjust_capacity(
                station_of(&task.dropoff, &p.stations),
                cap_d,
                darr,
                task.dropoff_service,
            );
            let ddone = dsvc + task.dropoff_service;
            // 泊位占用 [svc_start, end]；end+1 起可被他车进入（本车随即离场）
            bk.commit(
                station_of(&task.pickup, &p.stations),
                pdock,
                psvc,
                task.pickup_service,
                pdone + 1,
            );
            bk.commit(
                station_of(&task.dropoff, &p.stations),
                ddock,
                dsvc,
                task.dropoff_service,
                ddone + 1,
            );
            let est = TaskEst {
                vehicle: vi,
                pickup_dock: pdock,
                dropoff_dock: ddock,
                pickup_arrival: parr,
                pickup_done: pdone,
                dropoff_arrival: darr,
                dropoff_done: ddone,
                flow: ddone.saturating_sub(task.release_step),
                lateness: task.due_step.map_or(0, |d| ddone.saturating_sub(d)),
                empty_travel: p.map.manhattan(pos, pdock),
                loaded_travel: p.map.manhattan(pdock, ddock),
            };
            plan.tasks[ti] = Some(est);
            pos = ddock;
            t = ddone;
        }
        plan.vehicle_end_pos[vi] = pos;
        plan.vehicle_end_time[vi] = t;
        makespan = makespan.max(t);
    }
    // 3) 停车分配（确定性：车辆 idx 序，各取离终位最近的空闲停车格）
    if !p.parking.is_empty() {
        let mut taken = vec![false; p.parking.len()];
        for vi in 0..p.vehicles.len() {
            if !input.active[vi] {
                continue; // 暂停车辆不占停车格（原地驻留）
            }
            let mut best: Option<(u32, usize)> = None;
            for (pi, &cell) in p.parking.iter().enumerate() {
                if taken[pi] {
                    continue;
                }
                let d = p.map.manhattan(plan.vehicle_end_pos[vi], cell);
                match best {
                    Some((bd, _)) if d >= bd => {}
                    _ => best = Some((d, pi)),
                }
            }
            if let Some((d, pi)) = best {
                taken[pi] = true;
                plan.parking_assign[vi] = Some(p.parking[pi]);
                plan.vehicle_end_time[vi] += d;
                plan.vehicle_end_pos[vi] = p.parking[pi];
                parking_empty += d as u64;
                makespan = makespan.max(plan.vehicle_end_time[vi]);
            }
        }
    }
    // 4) 汇总（优先级加权 flow / lateness；停车空驶计入 empty）
    let mut flow = 0u64;
    let mut late = 0u64;
    let mut empty = parking_empty;
    for (ti, e) in plan.tasks.iter().enumerate() {
        if let Some(e) = e {
            let pr = p.tasks[ti].priority as u64;
            flow += pr * e.flow as u64;
            late += pr * e.lateness as u64;
            empty += e.empty_travel as u64;
        }
    }
    plan.makespan = makespan;
    plan.total_flow = flow;
    plan.total_lateness = late;
    plan.total_empty = empty;
    plan.cost = weighted_cost(&p.weights, makespan, flow, empty, late);
    plan
}

fn station_capacity(p: &Problem, loc: &TaskLoc) -> usize {
    match loc {
        TaskLoc::Station(i) => p.stations[*i].capacity,
        TaskLoc::Cell(_) => 1,
    }
}

/// 加权目标（AGV-SRS §2.7：全部项以时间步为单位；flow/lateness 按任务优先级加权）。
pub fn weighted_cost(w: &Weights, makespan: u32, flow: u64, empty: u64, lateness: u64) -> f64 {
    w.makespan * makespan as f64
        + w.flow_time * flow as f64
        + w.empty_travel * empty as f64
        + w.lateness * lateness as f64
}

/// 任务能否由某车执行（能力）。
pub fn capable(p: &Problem, ti: usize, vi: usize) -> bool {
    p.vehicles[vi].capable(p.tasks[ti].required_capability.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capabilities::Profile;
    use crate::problem::parse_problem;

    fn text() -> String {
        r#"{
            "map": { "cells": ["....","....","...."] },
            "time_model": { "horizon": 60 },
            "vehicles": [ { "id": "V1", "start": [0,0] }, { "id": "V2", "start": [3,2] } ],
            "tasks": [
                { "id": "T1", "pickup": [1,0], "dropoff": [2,2] },
                { "id": "T2", "pickup": [3,0], "dropoff": [0,2], "release_step": 4 }
            ],
            "objective": { "kind": "lexicographic-weighted" }
        }"#
        .to_string()
    }

    #[test]
    fn simulate_basic_times() {
        let p = parse_problem(&text(), Profile::Native).unwrap();
        let input = SchedInput::static_new(&p);
        let seq = vec![vec![0], vec![1]];
        let est = simulate(&p, &input, &seq);
        let t1 = est.tasks[0].as_ref().unwrap();
        assert_eq!(
            (t1.pickup_arrival, t1.dropoff_arrival, t1.dropoff_done),
            (1, 4, 4)
        );
        let t2 = est.tasks[1].as_ref().unwrap();
        // V2 (3,2)→(3,0)=2 步，但 release=4 ⇒ 取货服务 4 结束；(3,0)→(0,2)=5 ⇒ 送达 9
        assert_eq!((t2.pickup_done, t2.dropoff_done), (4, 9));
        assert!(est.cost > 0.0);
    }

    #[test]
    fn station_capacity_delays_service() {
        let body = r#"{
            "map": { "cells": [".....",".....","....."] },
            "time_model": { "horizon": 60 },
            "vehicles": [ { "id": "V1", "start": [0,0] }, { "id": "V2", "start": [0,2] } ],
            "tasks": [
                { "id": "T1", "pickup": {"station": "ST"}, "dropoff": [4,0], "pickup_service": 3 },
                { "id": "T2", "pickup": {"station": "ST"}, "dropoff": [4,2], "pickup_service": 3 }
            ],
            "stations": [ { "id": "ST", "cells": [[2,0],[2,1]], "capacity": 1 } ],
            "objective": { "kind": "lexicographic-weighted" }
        }"#
        .to_string();
        let p = parse_problem(&body, Profile::Native).unwrap();
        let input = SchedInput::static_new(&p);
        let est = simulate(&p, &input, &[vec![0], vec![1]]);
        let a = est.tasks[0].as_ref().unwrap();
        let b = est.tasks[1].as_ref().unwrap();
        // 两车同时到站（各 2 步），容量 1 ⇒ 服务错开 3 步；泊位互斥
        assert_eq!(a.pickup_done, 5);
        assert!(b.pickup_done >= 8, "b.pickup_done = {}", b.pickup_done);
        assert_ne!(a.pickup_dock, b.pickup_dock);
    }

    #[test]
    fn parking_exclusive_assignment() {
        let body = r#"{
            "map": { "cells": [".....","....."] },
            "time_model": { "horizon": 60 },
            "vehicles": [ { "id": "V1", "start": [0,0] }, { "id": "V2", "start": [4,0] } ],
            "tasks": [],
            "parking": [[0,1],[4,1]],
            "objective": { "kind": "lexicographic-weighted" }
        }"#
        .to_string();
        let p = parse_problem(&body, Profile::Native).unwrap();
        let est = simulate(&p, &SchedInput::static_new(&p), &[vec![], vec![]]);
        assert_eq!(est.parking_assign[0], Some(p.map.cell(0, 1).unwrap()));
        assert_eq!(est.parking_assign[1], Some(p.map.cell(4, 1).unwrap()));
        assert_ne!(est.parking_assign[0], est.parking_assign[1]);
    }
}
