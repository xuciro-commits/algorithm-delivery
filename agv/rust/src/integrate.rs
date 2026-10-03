//! 实现层：把（车辆 → 任务序列）编译为**分段联合** MAPF 规划，并拼接为完整
//! 时空时间线（AGV-SRS §4.2）。
//!
//! 关键性质：
//! * 每一段（stage）的 MAPF 求解包含**全部**需移动的车辆（绝不是逐车逐段单独
//!   求解后拼接）；
//! * 驻留车辆（已到达待服务 / 服务中 / 完工 / 暂停 / 被仲裁 hold）在段地图中
//!   作为障碍——它们在本段内必然不动（下一动作只发生在下一 stage 之后）；
//! * 段间在“服务完成事件”处推进全局时钟：新段从各车当前位置出发联合重规划，
//!   边界步唯一属于新段 ⇒ 不存在跨段顶点/边交换冲突（AGV-SRS §4.2 论证）；
//! * 目标格唯一性 / 泊位互斥由段前仲裁保证；工作站容量在到达时刻簿记；
//! * 全时间线的最终正确性由 `verify.rs` 独立重演证明（不信任本模块）。

use std::collections::BTreeMap;
use std::collections::VecDeque;

use aps_engine::engine::CancelToken;
use aps_engine::json::Json;

use crate::capabilities::Profile;
use crate::problem::{Cell, Problem};

/// 航点（一段移动 + 服务）。
#[derive(Debug, Clone)]
pub struct Waypoint {
    pub cell: Cell,
    pub service: u32,
    pub release: u32,
    pub task: Option<usize>,
    pub kind: WpKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WpKind {
    ToPickup,
    ToDropoff,
    Relocating,
}

impl WpKind {
    pub fn phase_str(self) -> &'static str {
        match self {
            WpKind::ToPickup => "to_pickup",
            WpKind::ToDropoff => "to_dropoff",
            WpKind::Relocating => "relocating",
        }
    }
    pub fn service_str(self) -> &'static str {
        match self {
            WpKind::ToPickup => "servicing_pickup",
            WpKind::ToDropoff => "servicing_dropoff",
            WpKind::Relocating => "relocating",
        }
    }
}

/// 任务在解中的结局。
#[derive(Debug, Clone)]
pub struct TaskOutcome {
    pub status: &'static str, // completed | picked | unassigned | leg_infeasible | budget | cancelled
    pub vehicle: Option<usize>,
    pub pickup_dock: Option<Cell>,
    pub dropoff_dock: Option<Cell>,
    pub pickup_arrival: Option<u32>,
    pub pickup_done: Option<u32>,
    pub dropoff_arrival: Option<u32>,
    pub dropoff_done: Option<u32>,
    pub reason: Option<&'static str>,
}

impl TaskOutcome {
    fn new() -> TaskOutcome {
        TaskOutcome {
            status: "unassigned",
            vehicle: None,
            pickup_dock: None,
            dropoff_dock: None,
            pickup_arrival: None,
            pickup_done: None,
            dropoff_arrival: None,
            dropoff_done: None,
            reason: None,
        }
    }
    /// 动态重建用空结局（由 expand 填充历史）。
    pub fn default_seed() -> TaskOutcome {
        TaskOutcome::new()
    }
}

#[derive(Debug, Clone)]
pub struct Mission {
    pub task: Option<usize>,
    pub phase: &'static str,
    pub from: u32,
    pub to: u32,
    pub dock: Option<Cell>,
}

/// 实现层输入。
pub struct RealizeInput {
    pub start_time: u32,
    pub pos: Vec<Cell>,
    /// 已执行时间线（len = start_time+1；静态 = [起点]）。
    pub executed: Vec<Vec<Cell>>,
    /// 全局时域上界（绝对时刻）。
    pub horizon: u32,
    /// 动态障碍窗口 (cell, at, until)；绝对时刻。
    pub window_walls: Vec<(Cell, u32, Option<u32>)>,
    /// 已生效的障碍移除。
    pub removed_walls: Vec<Cell>,
    pub active: Vec<bool>,
    /// 停车格分配（车辆 idx → 格；None = 原地驻留）。
    pub parking: Vec<Option<Cell>>,
    pub deadline_ms: Option<f64>,
    /// 预置任务结局（动态：历史 done/picked 任务带历史时刻；长度须等于任务数）。
    pub seed_outcomes: Vec<TaskOutcome>,
}

/// 实现层输出。
pub struct Realized {
    pub timelines: Vec<Vec<Cell>>,
    pub horizon: u32,
    pub missions: Vec<Vec<Mission>>,
    pub tasks: Vec<TaskOutcome>,
    pub mapf_solves: usize,
    pub mapf_ms: f64,
    pub notes: Vec<String>,
    pub cancelled: bool,
    pub budget_exhausted: bool,
}

// ---------------------------------------------------------------------------

struct StationBook {
    svc: Vec<Vec<(u32, u32)>>,
}

impl StationBook {
    fn adjust(&self, st: Option<usize>, capacity: usize, earliest: u32, dur: u32) -> u32 {
        let Some(si) = st else { return earliest };
        let mut s = earliest;
        loop {
            let concurrent = self.svc[si]
                .iter()
                .filter(|(a, b)| *a <= s + dur && *b >= s)
                .count();
            if concurrent < capacity {
                return s;
            }
            s = self.svc[si]
                .iter()
                .filter(|(_, b)| *b >= s)
                .map(|(_, b)| b + 1)
                .min()
                .unwrap_or(s + 1);
        }
    }
    fn commit(&mut self, st: Option<usize>, start: u32, end: u32) {
        if let Some(si) = st {
            self.svc[si].push((start, end));
        }
    }
}

fn station_index(p: &Problem, cell: Cell) -> Option<usize> {
    p.stations.iter().position(|s| s.cells.contains(&cell))
}

/// 让路目标：从被堵格（驻留车所在）BFS 最近的可用格（非墙、无车占位、非任何
/// 航点目标、未保留）。
fn yield_target(
    p: &Problem,
    static_cells: &[bool],
    pos: &[Cell],
    wp: &[Option<Waypoint>],
    reserved: &[Cell],
    from: Cell,
) -> Option<Cell> {
    let mut visited = vec![false; p.map.n_cells()];
    let mut queue = VecDeque::new();
    visited[from as usize] = true;
    queue.push_back(from);
    let occupied: std::collections::BTreeSet<Cell> = pos.iter().copied().collect();
    let goals: std::collections::BTreeSet<Cell> = wp
        .iter()
        .filter_map(|w| w.as_ref().map(|w| w.cell))
        .collect();
    while let Some(c) = queue.pop_front() {
        for &n in &p.map.neighbors(c) {
            if n == u32::MAX || visited[n as usize] {
                continue;
            }
            visited[n as usize] = true;
            if static_cells[n as usize] {
                continue;
            }
            if !occupied.contains(&n) && !goals.contains(&n) && !reserved.contains(&n) {
                return Some(n);
            }
            queue.push_back(n);
        }
    }
    None
}

fn station_capacity_at(p: &Problem, cell: Cell) -> usize {
    match station_index(p, cell) {
        Some(i) => p.stations[i].capacity,
        None => 1,
    }
}

/// 主入口：stage loop。
pub fn realize(
    p: &Problem,
    input: &RealizeInput,
    mut queues: Vec<VecDeque<Waypoint>>,
    profile: Profile,
    cancel: &CancelToken,
) -> Realized {
    let nv = p.vehicles.len();
    let mut time = input.start_time;
    let mut timelines: Vec<Vec<Cell>> = input.executed.clone();
    let mut pos: Vec<Cell> = input.pos.clone();
    let mut wp: Vec<Option<Waypoint>> = vec![None; nv];
    let mut arrival: Vec<Option<u32>> = vec![None; nv];
    let mut svc_end: Vec<Option<u32>> = vec![None; nv];
    let mut mission_from: Vec<u32> = vec![input.start_time; nv];
    let mut missions: Vec<Vec<Mission>> = vec![vec![]; nv];
    let mut outcomes: Vec<TaskOutcome> = if input.seed_outcomes.len() == p.tasks.len() {
        input.seed_outcomes.clone()
    } else {
        p.tasks.iter().map(|_| TaskOutcome::new()).collect()
    };
    let mut parked: Vec<bool> = vec![false; nv];
    let mut dropped: Vec<bool> = vec![false; nv];
    let mut yielded: Vec<bool> = vec![false; nv]; // 让路过的车不再回停车格
    let mut book = StationBook {
        svc: vec![vec![]; p.stations.len()],
    };
    let mut mapf_solves = 0usize;
    let mut mapf_ms = 0f64;
    let mut notes: Vec<String> = Vec::new();
    let mut cancelled = false;
    let mut budget_exhausted = false;

    for v in 0..nv {
        if let Some(w) = queues[v].pop_front() {
            wp[v] = Some(w);
        }
    }

    let max_stages = 4 * (2 * p.tasks.len() + nv) + 64;
    let mut stages: usize = 0;

    loop {
        stages += 1;
        if stages > max_stages {
            notes.push("stage 数超上限（疑似活锁/超长计划）⇒ 剩余任务按预算耗尽处理".into());
            budget_exhausted = true;
            break;
        }
        if cancel.is_cancelled() {
            cancelled = true;
            break;
        }
        if input
            .deadline_ms
            .is_some_and(|d| aps_engine::clock::now_ms() >= d)
        {
            budget_exhausted = true;
            break;
        }

        // —— A. 已在目标格的车辆：视为到达（真实到达时刻从时间线回溯） ——
        for v in 0..nv {
            if parked[v] || dropped[v] || !input.active[v] || svc_end[v].is_some() {
                continue;
            }
            if wp[v].is_some() && pos[v] == wp[v].as_ref().unwrap().cell {
                let goal = pos[v];
                let mut t = time;
                while t > mission_from[v] && timelines[v][(t - 1) as usize] == goal {
                    t -= 1;
                }
                arrival[v] = Some(t); // 最后一次进入目标格的时刻
            } else {
                // 未在目标格：上一段的到达记录作废（本段将重规划）
                arrival[v] = None;
            }
        }

        // —— B. 需移动车辆（凡不在目标格者一律重规划，杜绝在途车携带陈旧计划） ——
        let mut movers: Vec<usize> = (0..nv)
            .filter(|&v| {
                input.active[v]
                    && !parked[v]
                    && !dropped[v]
                    && wp[v].is_some()
                    && svc_end[v].is_none()
                    && pos[v] != wp[v].as_ref().unwrap().cell
            })
            .collect();

        // —— B2. 让路：驻留车（无航点，含已完工驻留）占据移动车目标格 ⇒ 指派让路航点 ——
        //   暂停车（active=false）不可让路 ⇒ 目标被堵的任务如实失败。
        {
            let yieldable: Vec<usize> = (0..nv)
                .filter(|&u| input.active[u] && !dropped[u] && wp[u].is_none())
                .collect();
            if !yieldable.is_empty() {
                // 静态通行格（不含车辆占位；窗口障碍按当前时刻）
                let mut static_cells = p.map.blocked.to_vec();
                for &c in &input.removed_walls {
                    static_cells[c as usize] = false;
                }
                for &(cell, at, until) in &input.window_walls {
                    if at <= time && until.map_or(true, |u| u > time) {
                        static_cells[cell as usize] = true;
                    }
                }
                let mut reserved: Vec<Cell> = Vec::new();
                let mut idx = 0;
                while idx < movers.len() {
                    let v = movers[idx];
                    let goal = wp[v].as_ref().unwrap().cell;
                    if let Some(&u) = yieldable.iter().find(|&&u| pos[u] == goal) {
                        if let Some(y) = yield_target(p, &static_cells, &pos, &wp, &reserved, goal)
                        {
                            wp[u] = Some(Waypoint {
                                cell: y,
                                service: 0,
                                release: 0,
                                task: None,
                                kind: WpKind::Relocating,
                            });
                            yielded[u] = true;
                            parked[u] = false; // 让路车复活（任务链已空，仅挪位）
                            reserved.push(y);
                            movers.push(u);
                        }
                    }
                    idx += 1;
                }
                movers.sort_unstable(); // 确定性
            }
        }

        // —— C1. 基础墙：地图 + 移除 + 已生效障碍 + 非移动车驻留格 ——
        let mut cells = p.map.blocked.to_vec();
        for &c in &input.removed_walls {
            cells[c as usize] = false;
        }
        let mut windowed: Vec<(Cell, u32, Option<u32>)> = Vec::new();
        for &(cell, at, until) in &input.window_walls {
            let active_later = until.map_or(true, |u| u > time);
            if !active_later {
                continue; // 窗口已过期
            }
            if at <= time {
                cells[cell as usize] = true;
            } else {
                windowed.push((cell, at - time, until.map(|u| u.saturating_sub(time))));
            }
        }
        for v in 0..nv {
            if !movers.contains(&v) {
                cells[pos[v] as usize] = true; // 驻留车（到达/完工/暂停/作废）= 障碍
            }
        }

        // —— C2. 目标仲裁：目标格不得与其他移动车目标重复、不得在墙上 ——
        let mut goal_taken: BTreeMap<Cell, usize> = BTreeMap::new();
        let mut actual: Vec<usize> = Vec::new();
        let mut held: Vec<usize> = Vec::new();
        for &v in &movers {
            let goal = wp[v].as_ref().unwrap().cell;
            if goal_taken.contains_key(&goal) || cells[goal as usize] {
                held.push(v);
            } else {
                goal_taken.insert(goal, v);
                actual.push(v);
            }
        }
        // hold 的车本段原地等待 ⇒ 清空其陈旧计划尾部（否则时间线出现“折返跳变”）
        for &v in &held {
            cells[pos[v] as usize] = true;
            let mut t = time as usize + 1;
            while t < timelines[v].len() {
                timelines[v][t] = pos[v];
                t += 1;
            }
        }

        // —— D. 求解段 MAPF（联合：包含全部 actual 移动车） ——
        if !actual.is_empty() {
            let remaining = input.horizon.saturating_sub(time);
            if remaining == 0 {
                notes.push(format!("t={time} 达到时域上界，剩余任务按预算处理"));
                budget_exhausted = true;
                break;
            }
            let now = aps_engine::clock::now_ms();
            let stage_budget = input
                .deadline_ms
                .map(|d| ((d - now).max(1.0)) as i64)
                .unwrap_or(p.solver.mapf.time_limit_ms)
                .min(p.solver.mapf.time_limit_ms)
                .max(1);
            let goals: Vec<Cell> = actual
                .iter()
                .map(|&v| wp[v].as_ref().unwrap().cell)
                .collect();
            let (status, so) = solve_stage(
                p,
                &actual,
                &pos,
                &goals,
                &cells,
                &windowed,
                remaining,
                stage_budget,
                profile,
                cancel,
                &p.solver.mapf.planner,
            );
            mapf_solves += 1;
            mapf_ms += so.ms;
            let so = if matches!(status.as_str(), "OPTIMAL" | "FEASIBLE") {
                so
            } else {
                let (status2, so2) = solve_stage(
                    p,
                    &actual,
                    &pos,
                    &goals,
                    &cells,
                    &windowed,
                    remaining,
                    stage_budget,
                    profile,
                    cancel,
                    "pp",
                );
                mapf_solves += 1;
                mapf_ms += so2.ms;
                if !matches!(status2.as_str(), "OPTIMAL" | "FEASIBLE") {
                    if cancel.is_cancelled() {
                        cancelled = true;
                        break;
                    }
                    let reason = if status2 == "INFEASIBLE" {
                        crate::errors::codes::TASK_LEG_INFEASIBLE
                    } else {
                        crate::errors::codes::TASK_BUDGET
                    };
                    if status2 == "UNKNOWN" {
                        budget_exhausted = true;
                    }
                    notes.push(format!(
                        "t={time} 段规划失败（{status} → pp 重试 {status2}），参与车任务链作废"
                    ));
                    for &v in &actual {
                        drop_vehicle(v, &wp, &queues, &mut outcomes, reason);
                        dropped[v] = true;
                    }
                    continue;
                }
                so2
            };
            absorb_stage(
                p,
                &so,
                &actual,
                time,
                &mut timelines,
                &mut pos,
                &mut arrival,
            );
        }

        // —— D2. 到达确认处理（仅“此刻确在目标格”者）：簿记容量 + 记录 to_x 段 ——
        //   服务起点 = max(到达, 释放, 容量槽)；在途车（fresh arrival 在未来）只
        //   作为推进事件候选，不落任何持久状态（下一段会重规划）。
        let mut provisional_end: Vec<Option<u32>> = vec![None; nv];
        for v in 0..nv {
            if parked[v] || dropped[v] || !input.active[v] || svc_end[v].is_some() {
                continue;
            }
            let (Some(w), Some(a)) = (wp[v].clone(), arrival[v]) else {
                continue;
            };
            if pos[v] != w.cell {
                // 在途：本段解给出的到达仅用于计算推进事件
                provisional_end[v] = Some(a + w.service);
                continue;
            }
            let svc_start = if w.kind == WpKind::Relocating {
                a
            } else {
                let st = station_index(p, w.cell);
                let cap = station_capacity_at(p, w.cell);
                book.adjust(st, cap, a.max(w.release), w.service)
            };
            let end = svc_start + w.service;
            if w.kind != WpKind::Relocating {
                book.commit(station_index(p, w.cell), svc_start, end);
            }
            missions[v].push(Mission {
                task: w.task,
                phase: w.kind.phase_str(),
                from: mission_from[v],
                to: svc_start,
                dock: Some(w.cell),
            });
            mission_from[v] = svc_start;
            svc_end[v] = Some(end);
            if let Some(ti) = w.task {
                let o = &mut outcomes[ti];
                o.vehicle = Some(v);
                match w.kind {
                    WpKind::ToPickup => {
                        o.pickup_dock = Some(w.cell);
                        o.pickup_arrival = Some(a);
                        o.pickup_done = Some(end);
                        o.status = "picked";
                        o.reason = None;
                    }
                    WpKind::ToDropoff => {
                        o.dropoff_dock = Some(w.cell);
                        o.dropoff_arrival = Some(a);
                        o.dropoff_done = Some(end);
                        o.status = "completed";
                        o.reason = None;
                    }
                    WpKind::Relocating => {}
                }
            }
        }

        // —— E. 下一事件：已确认服务的最早完成 / 在途车段的最早完成 ——
        let mut next: Option<u32> = None;
        for v in 0..nv {
            if parked[v] || dropped[v] || !input.active[v] {
                continue;
            }
            let cand = svc_end[v].or(provisional_end[v]);
            if let Some(e) = cand {
                next = Some(next.map_or(e, |n| n.min(e)));
            }
        }
        let Some(next) = next else {
            let unfinished: Vec<usize> = (0..nv)
                .filter(|&v| input.active[v] && !parked[v] && !dropped[v])
                .collect();
            if unfinished.is_empty() {
                break; // 全部完成
            }
            // 纯停车（Relocating）车辆：放弃挪车，原地驻留（不影响任务结局）
            let mut task_holders = Vec::new();
            for &v in &unfinished {
                if wp[v].as_ref().is_some_and(|w| w.task.is_none()) {
                    wp[v] = None;
                    parked[v] = true;
                    let last = *timelines[v].last().unwrap_or(&pos[v]);
                    let mut t = time as usize + 1;
                    while t < timelines[v].len() {
                        timelines[v][t] = last;
                        t += 1;
                    }
                } else {
                    task_holders.push(v);
                }
            }
            if task_holders.is_empty() {
                continue;
            }
            notes.push(format!(
                "t={time} 无可推进事件且存在被 hold 的载货车 ⇒ 活锁保护触发"
            ));
            for &v in &task_holders {
                drop_vehicle(
                    v,
                    &wp,
                    &queues,
                    &mut outcomes,
                    crate::errors::codes::TASK_LEG_INFEASIBLE,
                );
                dropped[v] = true;
            }
            continue;
        };
        if next > input.horizon {
            notes.push(format!(
                "下一事件 t={next} 超出时域 {} ⇒ 剩余任务按预算处理",
                input.horizon
            ));
            budget_exhausted = true;
            break;
        }

        // —— F. 推进到 next；完成服务的车取下一航点 ——
        time = next;
        for v in 0..nv {
            if svc_end[v] == Some(next) {
                let w = wp[v].clone().unwrap();
                if w.kind != WpKind::Relocating {
                    missions[v].push(Mission {
                        task: w.task,
                        phase: w.kind.service_str(),
                        from: mission_from[v],
                        to: next,
                        dock: Some(w.cell),
                    });
                }
                mission_from[v] = next;
                if w.kind == WpKind::ToDropoff {
                    missions[v].push(Mission {
                        task: w.task,
                        phase: "done",
                        from: next,
                        to: next,
                        dock: Some(w.cell),
                    });
                }
                wp[v] = None;
                arrival[v] = None;
                svc_end[v] = None;
                if let Some(nx) = queues[v].pop_front() {
                    wp[v] = Some(nx);
                } else if !yielded[v] {
                    if let Some(c) = input.parking[v].filter(|&c| c != w.cell) {
                        wp[v] = Some(Waypoint {
                            cell: c,
                            service: 0,
                            release: 0,
                            task: None,
                            kind: WpKind::Relocating,
                        });
                    } else {
                        parked[v] = true;
                    }
                } else {
                    parked[v] = true; // 让路车原地驻留（不回停车格）
                }
            }
        }
        for v in 0..nv {
            while (timelines[v].len() as u32) <= time {
                let last = *timelines[v].last().unwrap_or(&pos[v]);
                timelines[v].push(last);
            }
            pos[v] = timelines[v][time as usize];
        }
    }

    // —— G. 收尾 ——
    let mut horizon = input.start_time;
    for tl in &timelines {
        horizon = horizon.max((tl.len() as u32).saturating_sub(1));
    }
    for v in 0..nv {
        let last_pos = *timelines[v].last().unwrap_or(&pos[v]);
        while (timelines[v].len() as u32) <= horizon {
            timelines[v].push(last_pos);
        }
        if input.active[v] && !dropped[v] && !parked[v] {
            drop_vehicle(
                v,
                &wp,
                &queues,
                &mut outcomes,
                if budget_exhausted {
                    crate::errors::codes::TASK_BUDGET
                } else {
                    crate::errors::codes::TASK_LEG_INFEASIBLE
                },
            );
        }
        if !input.active[v] {
            // 暂停车辆：未完成的 picked 任务如实标注
            if let Some(w) = wp[v].as_ref() {
                if let Some(ti) = w.task {
                    if outcomes[ti].status != "completed" {
                        outcomes[ti].status = "picked";
                        outcomes[ti].reason = Some(crate::errors::codes::TASK_VEHICLE_PAUSED);
                        if outcomes[ti].vehicle.is_none() {
                            outcomes[ti].vehicle = Some(v);
                        }
                    }
                }
            }
            for w in &queues[v] {
                if let Some(ti) = w.task {
                    if outcomes[ti].status != "completed" {
                        outcomes[ti].status = "picked";
                        outcomes[ti].reason = Some(crate::errors::codes::TASK_VEHICLE_PAUSED);
                        if outcomes[ti].vehicle.is_none() {
                            outcomes[ti].vehicle = Some(v);
                        }
                    }
                }
            }
        }
        let last = missions[v].last().map(|m| m.to).unwrap_or(input.start_time);
        missions[v].push(Mission {
            task: None,
            phase: "parked",
            from: last,
            to: horizon,
            dock: Some(last_pos),
        });
    }

    Realized {
        timelines,
        horizon,
        missions,
        tasks: outcomes,
        mapf_solves,
        mapf_ms,
        notes,
        cancelled,
        budget_exhausted,
    }
}

/// 车辆任务链作废：当前 + 队列中的未完成任务标记失败（已完成不受影响）。
fn drop_vehicle(
    v: usize,
    wp: &[Option<Waypoint>],
    queues: &[VecDeque<Waypoint>],
    outcomes: &mut [TaskOutcome],
    reason: &'static str,
) {
    let mut mark = |ti: Option<usize>| {
        if let Some(ti) = ti {
            if outcomes[ti].status != "completed" {
                outcomes[ti].status = match reason {
                    crate::errors::codes::TASK_BUDGET => "budget",
                    crate::errors::codes::TASK_VEHICLE_PAUSED => "picked",
                    crate::errors::codes::TASK_UNASSIGNED => "unassigned",
                    _ => "leg_infeasible",
                };
                if outcomes[ti].vehicle.is_none() {
                    outcomes[ti].vehicle = Some(v);
                }
                outcomes[ti].reason = Some(reason);
            }
        }
    };
    mark(wp.get(v).and_then(|w| w.as_ref()).and_then(|w| w.task));
    for w in &queues[v] {
        mark(w.task);
    }
}

// ------------------------------------------------------------------ MAPF 段

struct StageOut {
    paths: BTreeMap<String, Vec<Cell>>,
    arrivals: BTreeMap<String, u32>,
    ms: f64,
}

#[allow(clippy::too_many_arguments)]
fn solve_stage(
    p: &Problem,
    movers: &[usize],
    pos: &[Cell],
    goals: &[Cell],
    cells: &[bool],
    windowed: &[(Cell, u32, Option<u32>)],
    horizon: u32,
    budget_ms: i64,
    profile: Profile,
    cancel: &CancelToken,
    planner: &str,
) -> (String, StageOut) {
    let robots: Vec<Json> = movers
        .iter()
        .zip(goals)
        .map(|(&v, &g)| {
            Json::obj(vec![
                ("id", Json::str(p.vehicles[v].id.as_str())),
                ("start", cell_json(p, pos[v])),
                ("goal", cell_json(p, g)),
            ])
        })
        .collect();
    let mut fields: Vec<(&str, Json)> = vec![
        ("schema_version", Json::str("mapf-problem/1.0")),
        ("map", Json::obj(vec![("cells", cells_json(p, cells))])),
        (
            "time_model",
            Json::obj(vec![
                ("timestep", Json::str("discrete")),
                ("horizon", Json::int(horizon as i64)),
            ]),
        ),
        ("robots", Json::Arr(robots)),
        (
            "objective",
            Json::obj(vec![
                ("kind", Json::str("soc")),
                ("direction", Json::str("min")),
            ]),
        ),
        (
            "solver",
            Json::obj(vec![
                ("planner", Json::str(planner)),
                ("seed", Json::int(p.solver.seed as i64)),
                ("suboptimality_factor", Json::Float(p.solver.mapf.w)),
                ("time_limit_ms", Json::int(budget_ms.max(1))),
            ]),
        ),
    ];
    if !windowed.is_empty() {
        let paths: Vec<(&str, Json)> = movers
            .iter()
            .map(|&v| {
                (
                    p.vehicles[v].id.as_str(),
                    Json::Arr(vec![cell_json(p, pos[v])]),
                )
            })
            .collect();
        let events: Vec<Json> = windowed
            .iter()
            .map(|&(cell, at, until)| {
                Json::obj(vec![
                    ("type", Json::str("obstacle_add")),
                    ("cell", cell_json(p, cell)),
                    ("at", Json::int(at as i64)),
                    (
                        "until",
                        until.map(|u| Json::int(u as i64)).unwrap_or(Json::Null),
                    ),
                ])
            })
            .collect();
        fields.push((
            "dynamic",
            Json::obj(vec![
                (
                    "snapshot",
                    Json::obj(vec![
                        ("time", Json::int(0)),
                        ("frozen_steps", Json::int(0)),
                        ("paths", Json::obj(paths)),
                    ]),
                ),
                ("events", Json::Arr(events)),
            ]),
        ));
    }
    let text = Json::obj(fields).to_compact();
    let t0 = aps_engine::clock::now_ms();
    let opts = mapf_engine::engine::SolveOptions {
        profile: mapf_profile(profile),
        verify: false, // 全时间线由 verify.rs 独立重演（覆盖并强于逐段核验）
        solution_id: None,
        time_limit_ms: Some(budget_ms.max(1)),
        seed: Some(p.solver.seed),
        w: Some(p.solver.mapf.w),
        planner: mapf_planner(planner),
        objective: None,
    };
    let out = mapf_engine::engine::solve_json(&text, &opts, cancel);
    let ms = aps_engine::clock::now_ms() - t0;
    let status = out
        .solution
        .get("status")
        .and_then(|j| j.as_str())
        .unwrap_or("UNKNOWN")
        .to_string();
    let mut so = StageOut {
        paths: BTreeMap::new(),
        arrivals: BTreeMap::new(),
        ms,
    };
    if let Some(arr) = out.solution.get("robots").and_then(|j| j.as_arr()) {
        for r in arr {
            let id = r
                .get("id")
                .and_then(|j| j.as_str())
                .unwrap_or("")
                .to_string();
            let mut path = Vec::new();
            if let Some(pa) = r.get("path").and_then(|j| j.as_arr()) {
                for c in pa {
                    if let Some(cell) = json_cell(p, c) {
                        path.push(cell);
                    }
                }
            }
            let arr_t = r
                .get("arrival")
                .and_then(|j| j.as_i64())
                .unwrap_or(0)
                .max(0) as u32;
            so.paths.insert(id.clone(), path);
            so.arrivals.insert(id, arr_t);
        }
    }
    (status, so)
}

fn cells_json(p: &Problem, cells: &[bool]) -> Json {
    let mut rows: Vec<String> = Vec::with_capacity(p.map.height as usize);
    for y in 0..p.map.height {
        let mut row = String::with_capacity(p.map.width as usize);
        for x in 0..p.map.width {
            let c = y * p.map.width + x;
            row.push(if cells[c as usize] { '#' } else { '.' });
        }
        rows.push(row);
    }
    Json::strings(rows)
}

fn cell_json(p: &Problem, c: Cell) -> Json {
    Json::Arr(vec![
        Json::int(p.map.x_of(c) as i64),
        Json::int(p.map.y_of(c) as i64),
    ])
}

fn json_cell(p: &Problem, j: &Json) -> Option<Cell> {
    let a = j.as_arr()?;
    if a.len() != 2 {
        return None;
    }
    let x = a[0].as_i64()? as u32;
    let y = a[1].as_i64()? as u32;
    p.map.cell(x, y)
}

fn mapf_profile(profile: Profile) -> mapf_engine::capabilities::Profile {
    match profile {
        Profile::Native => mapf_engine::capabilities::Profile::Native,
        Profile::WasmLight => mapf_engine::capabilities::Profile::WasmLight,
    }
}

fn mapf_planner(s: &str) -> Option<mapf_engine::problem::PlannerKind> {
    match s {
        "ecbs" | "cbs" => Some(mapf_engine::problem::PlannerKind::Ecbs),
        "pp" => Some(mapf_engine::problem::PlannerKind::Pp),
        _ => Some(mapf_engine::problem::PlannerKind::Auto),
    }
}

/// 吸收段解：写入时间线（含停留尾部）、记录到达。
fn absorb_stage(
    p: &Problem,
    so: &StageOut,
    movers: &[usize],
    time: u32,
    timelines: &mut [Vec<Cell>],
    pos: &mut [Cell],
    arrival: &mut [Option<u32>],
) {
    // 段视野 = 最长路径
    let mut max_len: usize = 0;
    for &v in movers {
        if let Some(path) = so.paths.get(&p.vehicles[v].id) {
            max_len = max_len.max(path.len().saturating_sub(1));
        }
    }
    let end = time + max_len as u32;
    for v in 0..pos.len() {
        // 各车以“自身时间线末格”外推（驻留车=所在格；在途车=其既有计划末格），
        // 绝不用段起点位置覆盖未来计划
        let last = *timelines[v].last().unwrap_or(&pos[v]);
        while (timelines[v].len() as u32) <= end {
            timelines[v].push(last);
        }
    }
    for &v in movers {
        if let Some(path) = so.paths.get(&p.vehicles[v].id) {
            for (i, &c) in path.iter().enumerate().skip(1) {
                let t = time as usize + i;
                if t < timelines[v].len() {
                    timelines[v][t] = c;
                }
            }
            // 停留尾部：从路径末端补到段末（stay-at-target 语义）
            if let Some(&last) = path.last() {
                let mut t = time as usize + path.len().saturating_sub(1);
                while t < timelines[v].len() {
                    timelines[v][t] = last;
                    t += 1;
                }
            }
            if let Some(a) = so.arrivals.get(&p.vehicles[v].id) {
                arrival[v] = Some(time + *a);
            }
        }
    }
}

/// 由调度结果构造每车航点队列（picked 任务先送达；新任务逐个 取货→送达）。
pub fn build_queues(
    p: &Problem,
    input: &crate::estimate::SchedInput,
    seq: &[Vec<usize>],
) -> Vec<VecDeque<Waypoint>> {
    let mut queues: Vec<VecDeque<Waypoint>> = p.vehicles.iter().map(|_| VecDeque::new()).collect();
    for v in 0..p.vehicles.len() {
        for &ti in &input.vehicles[v].picked {
            let t = &p.tasks[ti];
            queues[v].push_back(Waypoint {
                cell: t.dropoff.dock_candidates(&p.stations)[0],
                service: t.dropoff_service,
                release: 0,
                task: Some(ti),
                kind: WpKind::ToDropoff,
            });
        }
        for &ti in &seq[v] {
            let t = &p.tasks[ti];
            queues[v].push_back(Waypoint {
                cell: t.pickup.dock_candidates(&p.stations)[0],
                service: t.pickup_service,
                release: t.release_step,
                task: Some(ti),
                kind: WpKind::ToPickup,
            });
            queues[v].push_back(Waypoint {
                cell: t.dropoff.dock_candidates(&p.stations)[0],
                service: t.dropoff_service,
                release: 0,
                task: Some(ti),
                kind: WpKind::ToDropoff,
            });
        }
    }
    queues
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capabilities::Profile;
    use crate::estimate::SchedInput;
    use crate::problem::parse_problem;

    fn cancel() -> aps_engine::engine::CancelToken {
        aps_engine::engine::CancelToken::new()
    }

    fn realize_input(p: &Problem, horizon: u32) -> RealizeInput {
        RealizeInput {
            start_time: 0,
            pos: p.vehicles.iter().map(|v| v.start).collect(),
            executed: p.vehicles.iter().map(|v| vec![v.start]).collect(),
            horizon,
            window_walls: vec![],
            removed_walls: vec![],
            active: vec![true; p.vehicles.len()],
            parking: vec![None; p.vehicles.len()],
            deadline_ms: None,
            seed_outcomes: vec![],
        }
    }

    fn text() -> String {
        r#"{
            "map": { "cells": ["......", "......", "......"] },
            "time_model": { "horizon": 60 },
            "vehicles": [ { "id": "V1", "start": [0,0] }, { "id": "V2", "start": [5,2] } ],
            "tasks": [ { "id": "T1", "pickup": [4,0], "dropoff": [1,2], "pickup_service": 1, "dropoff_service": 1 } ],
            "objective": { "kind": "lexicographic-weighted" }
        }"#
        .to_string()
    }

    #[test]
    fn single_task_single_vehicle_completes() {
        let p = parse_problem(&text(), Profile::Native).unwrap();
        let input = SchedInput::static_new(&p);
        let queues = build_queues(&p, &input, &[vec![0], vec![]]);
        let r = realize(
            &p,
            &realize_input(&p, 60),
            queues,
            Profile::Native,
            &cancel(),
        );
        assert_eq!(r.tasks[0].status, "completed");
        assert_eq!(r.tasks[0].vehicle, Some(0));
        // 位置语义：(0,0)→(4,0) 4 步 + 服务 1 + (4,0)→(1,2) 5 步 + 服务 1
        assert_eq!(r.tasks[0].pickup_done, Some(5));
        assert_eq!(r.tasks[0].dropoff_done, Some(11));
        assert_eq!(r.timelines[0][11], p.map.cell(1, 2).unwrap());
        assert!(r.mapf_solves >= 1);
    }

    #[test]
    fn timeline_is_contiguous_and_complete() {
        let p = parse_problem(&text(), Profile::Native).unwrap();
        let input = SchedInput::static_new(&p);
        let queues = build_queues(&p, &input, &[vec![0], vec![]]);
        let r = realize(
            &p,
            &realize_input(&p, 60),
            queues,
            Profile::Native,
            &cancel(),
        );
        for tl in &r.timelines {
            assert_eq!(tl.len() as u32, r.horizon + 1);
            for t in 1..tl.len() {
                let (a, b) = (tl[t - 1], tl[t]);
                assert!(
                    a == b || p.map.manhattan(a, b) == 1,
                    "t={t} 非法移动 {a}→{b}"
                );
            }
        }
    }

    #[test]
    fn two_vehicles_no_vertex_conflict() {
        let swap = r#"{
            "map": { "cells": ["........", "........", "........"] },
            "time_model": { "horizon": 80 },
            "vehicles": [ { "id": "A", "start": [0,1] }, { "id": "B", "start": [7,1] } ],
            "tasks": [
                { "id": "T1", "pickup": [7,1], "dropoff": [0,1] },
                { "id": "T2", "pickup": [0,1], "dropoff": [7,1] }
            ],
            "objective": { "kind": "lexicographic-weighted" }
        }"#
        .to_string();
        let p = parse_problem(&swap, Profile::Native).unwrap();
        let input = SchedInput::static_new(&p);
        // 对开交换：A 去取 B 的起点，B 去取 A 的起点（取货点=对方起点）
        let queues = build_queues(&p, &input, &[vec![0], vec![1]]);
        let r = realize(
            &p,
            &realize_input(&p, 80),
            queues,
            Profile::Native,
            &cancel(),
        );
        assert_eq!(r.tasks[0].status, "completed");
        assert_eq!(r.tasks[1].status, "completed");
        for t in 0..=r.horizon as usize {
            let cells: Vec<Cell> = r
                .timelines
                .iter()
                .map(|tl| tl[t.min(tl.len() - 1)])
                .collect();
            let mut uniq = cells.clone();
            uniq.sort_unstable();
            uniq.dedup();
            assert_eq!(uniq.len(), cells.len(), "t={t} 顶点冲突");
        }
    }
}
