//! 动态重调度重建：把（基础问题 + 快照 + 事件流）展开为一个**可调度的静态
//! 等价问题**与实现层输入（AGV-SRS §7）。
//!
//! 规则：
//! * 历史时间线（0..=T）逐格保留，作为实现层 `executed` 前缀；
//! * `done` 任务：预置 completed 结局（时刻来自快照），不再调度；
//! * `picked` 任务：固定原车，只补送达段；
//! * `pending/assigned`（含快照失败终态）：重新参与分配；
//! * `task_add` 追加任务；`task_cancel` 终止任务；`task_priority` 改优先级；
//! * `vehicle_pause/resume` 更新可用性（暂停车的 picked 任务如实标注）；
//! * `obstacle_add/remove` 映射为实现层窗口/移除墙。

use crate::errors::codes;
use crate::errors::Issue;
use crate::integrate::TaskOutcome;
use crate::problem::{Cell, Event, Problem};
use aps_engine::json::Json;

/// 展开结果。
pub struct Expanded {
    /// 静态等价问题：任务表含新增任务；车辆 start=快照位置；paused 已更新。
    pub p: Problem,
    pub time: u32,
    /// 每车已执行时间线（0..=T）。
    pub history: Vec<Vec<Cell>>,
    /// 预置任务结局（done 任务）。
    pub seed: Vec<TaskOutcome>,
    /// 可（重）分配任务（展开表下标）。
    pub free: Vec<usize>,
    /// 每车 picked 任务（展开表下标，按执行序）。
    pub picked: Vec<Vec<usize>>,
    pub window_walls: Vec<(Cell, u32, Option<u32>)>,
    pub removed_walls: Vec<Cell>,
    pub cancelled: Vec<usize>,
    pub active: Vec<bool>,
    pub notes: Vec<String>,
    /// 事件应用汇总（AGV-SRS §4.5：新旧时间线 diff 统计的展开侧数据）。
    pub summary: Json,
}

/// 展开（解析层已校验过形状；这里做语义应用）。
pub fn expand(p: &Problem) -> Result<Expanded, Vec<Issue>> {
    let Some(d) = &p.dynamic else {
        return Err(vec![Issue::error(
            codes::SCHEMA,
            "$.dynamic",
            "内部错误：无动态块",
        )]);
    };
    let t = d.time;
    let mut issues: Vec<Issue> = Vec::new();
    let mut q = p.clone();

    // 车辆：位置 / 历史 / picked
    let nv = q.vehicles.len();
    let mut history: Vec<Vec<Cell>> = Vec::with_capacity(nv);
    let mut pos: Vec<Cell> = Vec::with_capacity(nv);
    let mut picked: Vec<Vec<usize>> = vec![vec![]; nv];
    let mut active: Vec<bool> = Vec::with_capacity(nv);
    for (vi, v) in q.vehicles.iter_mut().enumerate() {
        match d.vehicles.get(vi).and_then(|s| s.as_ref()) {
            Some(snap) => {
                let mut hist = snap.path.clone();
                hist.truncate((t + 1) as usize);
                while hist.len() < (t + 1) as usize {
                    hist.push(snap.pos);
                }
                v.start = snap.pos;
                pos.push(snap.pos);
                history.push(hist);
            }
            None => {
                // 快照未覆盖该车：视为从未移动（起点驻留）
                v.start = p.vehicles[vi].start;
                pos.push(p.vehicles[vi].start);
                history.push(vec![p.vehicles[vi].start; (t + 1) as usize]);
            }
        }
        active.push(!v.paused);
    }

    // 事件应用（按声明顺序）
    let mut cancelled: Vec<usize> = Vec::new();
    let mut window_walls: Vec<(Cell, u32, Option<u32>)> = Vec::new();
    let mut removed_walls: Vec<Cell> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    // —— 汇总数据（solution.dynamic 块；SRS §4.5 diff 统计的展开侧）——
    let mut s_added: Vec<String> = Vec::new();
    let mut s_cancelled: Vec<String> = Vec::new();
    let mut s_priority: Vec<Json> = Vec::new();
    let mut s_paused: Vec<String> = Vec::new();
    let mut s_resumed: Vec<String> = Vec::new();
    let mut s_obs_add: Vec<Json> = Vec::new();
    let mut s_obs_rm: Vec<Json> = Vec::new();
    let cell_j = |map: &crate::problem::MapData, c: Cell| {
        Json::Arr(vec![
            Json::int(map.x_of(c) as i64),
            Json::int(map.y_of(c) as i64),
        ])
    };
    for (i, e) in d.events.iter().enumerate() {
        match e {
            Event::TaskAdd { task } => {
                if q.tasks.iter().any(|x| x.id == task.id)
                    || q.vehicles.iter().any(|x| x.id == task.id)
                {
                    issues.push(Issue::error(
                        codes::EVENT_TARGET,
                        format!("$.dynamic.events[{i}]"),
                        format!("task_add 任务 id `{}` 与既有任务/车辆冲突", task.id),
                    ));
                    continue;
                }
                let mut t2 = task.clone();
                t2.idx = q.tasks.len();
                q.tasks.push(t2);
                s_added.push(task.id.clone());
            }
            Event::TaskCancel { task } => {
                if *task < p.tasks.len() {
                    let st = &d.tasks[*task].status;
                    if st == "done" || st == "picked" {
                        issues.push(Issue::error(
                            codes::EVENT_TIME,
                            format!("$.dynamic.events[{i}]"),
                            format!("task_cancel 目标任务状态为 `{st}`（已开始/完成，不可取消）"),
                        ));
                        continue;
                    }
                }
                if !cancelled.contains(task) {
                    cancelled.push(*task);
                    if let Some(t) = p.tasks.get(*task) {
                        s_cancelled.push(t.id.clone());
                    }
                }
            }
            Event::TaskPriority { task, priority } => {
                q.tasks[*task].priority = *priority;
                if let Some(t) = p.tasks.get(*task) {
                    s_priority.push(Json::obj(vec![
                        ("task", Json::str(t.id.as_str())),
                        ("priority", Json::int(*priority as i64)),
                    ]));
                }
            }
            Event::VehiclePause { vehicle } => {
                q.vehicles[*vehicle].paused = true;
                active[*vehicle] = false;
                if let Some(v) = q.vehicles.get(*vehicle) {
                    s_paused.push(v.id.clone());
                }
            }
            Event::VehicleResume { vehicle } => {
                q.vehicles[*vehicle].paused = false;
                active[*vehicle] = true;
                if let Some(v) = q.vehicles.get(*vehicle) {
                    s_resumed.push(v.id.clone());
                }
            }
            Event::ObstacleAdd { cell, at, until } => {
                // 语义校验：障碍生效时刻不得压在已执行历史上任何车辆身上
                if *at <= t {
                    for (vi, hist) in history.iter().enumerate() {
                        if hist.get(*at as usize) == Some(cell) {
                            issues.push(Issue::error(
                                codes::EVENT_TIME,
                                format!("$.dynamic.events[{i}]"),
                                format!(
                                    "obstacle_add 格 {} 在 t={at} 被车辆 `{}` 占据（与已执行历史矛盾）",
                                    crate::problem::fmt_cell(&p.map, *cell),
                                    p.vehicles[vi].id
                                ),
                            ));
                        }
                    }
                }
                window_walls.push((*cell, *at, *until));
                s_obs_add.push(Json::obj(vec![
                    ("cell", cell_j(&q.map, *cell)),
                    ("at", Json::int(*at as i64)),
                    (
                        "until",
                        until.map(|u| Json::int(u as i64)).unwrap_or(Json::Null),
                    ),
                ]));
            }
            Event::ObstacleRemove { cell, at } => {
                if *at <= t {
                    if p.map.is_blocked(*cell) {
                        removed_walls.push(*cell);
                        s_obs_rm.push(cell_j(&q.map, *cell));
                    }
                } else {
                    // 未来移除：保守做法 —— 该格按基础墙保留，另注说明
                    notes.push(format!(
                        "obstacle_remove 在 t={at} 生效（晚于重调度时刻 {t}）：本解仍按原障碍处理",
                    ));
                }
            }
        }
    }
    if !issues.is_empty() {
        return Err(issues);
    }

    // 任务分类
    let mut seed: Vec<TaskOutcome> = q
        .tasks
        .iter()
        .map(|_| TaskOutcome::default_seed())
        .collect();
    let mut free: Vec<usize> = Vec::new();
    let mut s_carried: Vec<String> = Vec::new();
    let mut s_completed: Vec<String> = Vec::new();
    for (ti, so) in seed.iter_mut().enumerate() {
        if cancelled.contains(&ti) {
            so.status = "cancelled";
            so.reason = Some(crate::errors::codes::TASK_CANCELLED);
            continue;
        }
        if ti < p.tasks.len() {
            let snap = &d.tasks[ti];
            match snap.status.as_str() {
                "done" => {
                    so.status = "completed";
                    so.vehicle = snap.assignee;
                    so.pickup_dock = snap.pickup_dock;
                    so.dropoff_dock = snap.dropoff_dock;
                    so.pickup_arrival = snap.pickup_arrival;
                    so.pickup_done = snap.pickup_done;
                    so.dropoff_arrival = snap.dropoff_arrival;
                    so.dropoff_done = snap.dropoff_done;
                    if let Some(t) = p.tasks.get(ti) {
                        s_completed.push(t.id.clone());
                    }
                    continue;
                }
                "picked" => {
                    let vi = snap.assignee.unwrap_or(usize::MAX);
                    if vi == usize::MAX {
                        issues.push(Issue::error(
                            codes::SNAP_STATE,
                            "$.dynamic.snapshot.tasks".to_string(),
                            format!("任务 `{}` 状态为 picked 但缺少 assignee", p.tasks[ti].id),
                        ));
                        continue;
                    }
                    so.status = "picked";
                    so.vehicle = Some(vi);
                    so.pickup_dock = snap.pickup_dock;
                    so.pickup_arrival = snap.pickup_arrival;
                    so.pickup_done = snap.pickup_done;
                    picked[vi].push(ti);
                    if let Some(t) = p.tasks.get(ti) {
                        s_carried.push(t.id.clone());
                    }
                    continue;
                }
                _ => {} // pending / assigned / 失败终态 → 重试
            }
        }
        free.push(ti);
    }
    if !issues.is_empty() {
        return Err(issues);
    }

    // —— 汇总块（确定性字段；运行耗时在 metrics，不在此处）——
    s_carried.sort();
    s_completed.sort();
    let summary = Json::obj(vec![
        ("snapshot_time", Json::int(t as i64)),
        ("replan_from", Json::int(t as i64)),
        (
            "events",
            Json::obj(vec![
                ("total", Json::int(d.events.len() as i64)),
                ("task_add", Json::int(s_added.len() as i64)),
                ("task_cancel", Json::int(s_cancelled.len() as i64)),
                ("task_priority", Json::int(s_priority.len() as i64)),
                ("vehicle_pause", Json::int(s_paused.len() as i64)),
                ("vehicle_resume", Json::int(s_resumed.len() as i64)),
                ("obstacle_add", Json::int(s_obs_add.len() as i64)),
                ("obstacle_remove", Json::int(s_obs_rm.len() as i64)),
            ]),
        ),
        ("tasks_added", Json::strings(s_added)),
        ("tasks_cancelled", Json::strings(s_cancelled)),
        ("priorities_changed", Json::Arr(s_priority)),
        ("vehicles_paused", Json::strings(s_paused)),
        ("vehicles_resumed", Json::strings(s_resumed)),
        ("obstacles_added", Json::Arr(s_obs_add)),
        ("obstacles_removed", Json::Arr(s_obs_rm)),
        ("carried_tasks", Json::strings(s_carried)),
        ("completed_at_snapshot", Json::strings(s_completed)),
    ]);

    Ok(Expanded {
        p: q,
        time: t,
        history,
        seed,
        free,
        picked,
        window_walls,
        removed_walls,
        cancelled,
        active,
        notes,
        summary,
    })
}
