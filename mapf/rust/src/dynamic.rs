//! 动态重规划（SRS §2.2）：快照 + 事件 → 带承诺前缀的联合规划实例编译；求解后再融合。
//!
//! 关键不变量：
//! * **已执行历史与冻结前缀不可变**：前缀位置序列原样进入最终方案（融合后独立核验器
//!   仍会对全时间线重演一遍，任何偏离都是阻断性缺陷）；
//! * 前缀之间不允许存在冲突（快照自洽性检查，输入层拒绝）；
//! * 前缀必须避开事件封锁的格（承诺时段内出现新障碍 = 承诺不可维持，拒绝输入）；
//! * 已“驻留终点且目标未变”的机器人被**锁定**（frozen 至时域末端），
//!   其它车在重规划时必须避让它的驻留占用；
//! * `path_invalid` 只收缩该车的承诺（不撤销已执行历史）：其重规划起点 = 快照时刻位置。

use crate::errors::{codes, Issue};
use crate::problem::{Cell, Event, Problem};

/// 承诺前缀编译结果（不含对 Problem 的借用；engine 据此构造 `ecbs::Instance`）。
pub struct DynamicCompiled {
    /// 每车承诺前缀（t=0..=frozen_end_i；锁定车覆盖至 horizon）。
    pub prefixes: Vec<Vec<Cell>>,
    /// 每车冻结结束时刻（= prefixes[i].len()-1）。
    pub frozen_end: Vec<u32>,
    /// 每车“被迫重规划”（path_invalid / goal_change）标记（仅用于统计呈现）。
    pub forced: Vec<bool>,
}

/// 编译动态实例；顺带完成全部快照自洽性检查（返回 Issue 即 INVALID_INPUT）。
pub fn compile(p: &Problem) -> Result<DynamicCompiled, Vec<Issue>> {
    let dyn_ = p
        .dynamic
        .as_ref()
        .expect("compile only called with dynamic block");
    let n = p.robots.len();
    let mut issues: Vec<Issue> = Vec::new();

    let blocked = p.blocked_windows();
    let free_win = p.free_windows_of_blocked();
    let goals = crate::problem::effective_goals(p);
    let horizon = p.horizon;
    let time = dyn_.time;

    let mut prefixes: Vec<Vec<Cell>> = Vec::with_capacity(n);
    let mut frozen_end: Vec<u32> = Vec::with_capacity(n);
    let mut forced: Vec<bool> = Vec::with_capacity(n);

    let goal_changed: Vec<bool> = (0..n)
        .map(|i| {
            dyn_.events.iter().any(
                |e| matches!(e, Event::GoalChange { robot, at, .. } if *robot == i && *at >= time),
            )
        })
        .collect();

    for i in 0..n {
        let prior = &dyn_.prior_paths[i];
        let orig_goal = p.robots[i].goal;
        let want_frozen = (time + dyn_.frozen_extra[i]).min(horizon);
        let mut cells: Vec<Cell> = prior.clone();
        let forced_here = goal_changed[i]
            || dyn_.events.iter().any(|e| matches!(e, Event::PathInvalid { robots, at, .. } if *at <= time && robots.contains(&i)));
        let at_goal_now = prior.get(time as usize).copied() == Some(orig_goal)
            && prior[..=(time as usize).min(prior.len() - 1)]
                .iter()
                .all(|&c| c == orig_goal);
        // “已驻留终点”锁定成立当且仅当：快照时刻人已在终点、目标未变、且没有被
        // path_invalid 作废（M10 反例：旧计划数组以终点收尾 ≠ 车辆已停下）。
        let parked = at_goal_now && goals[i] == orig_goal && !forced_here;
        let (f_end, locked_here) = if parked {
            // 已驻留终点且目标未变 ⇒ 锁定至时域末端
            (horizon, true)
        } else if (prior.len() as u32 - 1) >= want_frozen {
            (want_frozen, false)
        } else {
            issues.push(Issue::error(
                codes::SNAP_SHAPE,
                format!("$.dynamic.snapshot.paths.{}", p.robots[i].id),
                format!(
                    "冻结窗 [0, {want_frozen}] 超出既有路径覆盖范围（路径止于 {}）且未停在终点",
                    prior.len().saturating_sub(1)
                ),
            ));
            (want_frozen, false)
        };
        if locked_here {
            while (cells.len() as u32) <= horizon {
                cells.push(goals[i]);
            }
        } else {
            while (cells.len() as u32) <= f_end {
                let last = *cells.last().expect("prior non-empty");
                cells.push(last);
            }
            cells.truncate(f_end as usize + 1);
        }
        // 前缀逐步合法性（对地图与事件窗口重演）
        for t in 0..cells.len() as u32 {
            let c = cells[t as usize];
            if blocked_cell(&blocked, &free_win, p, c, t) {
                issues.push(Issue::error(
                    codes::SNAP_FROZEN_ILLEGAL,
                    format!("$.dynamic.snapshot.paths.{}", p.robots[i].id),
                    format!("承诺前缀第 {t} 步位于被障碍/事件封锁的单元"),
                ));
            }
            if t > 0 {
                let prev = cells[(t - 1) as usize];
                let d = p.map.manhattan(prev, c);
                if d > 1 {
                    issues.push(Issue::error(
                        codes::SNAP_FROZEN_ILLEGAL,
                        format!("$.dynamic.snapshot.paths.{}", p.robots[i].id),
                        format!("承诺前缀第 {t} 步不是 wait/四邻域移动（Δ={d}）"),
                    ));
                }
            }
        }
        prefixes.push(cells);
        frozen_end.push(f_end);
        forced.push(
            goal_changed[i]
                || dyn_
                    .events
                    .iter()
                    .any(|e| matches!(e, Event::PathInvalid { robots, .. } if robots.contains(&i))),
        );
    }

    // 前缀两两冲突（全冻结窗并集范围内；超出对方前缀的位置按“驻留终点”扩展）
    if issues.is_empty() {
        for a in 0..n {
            for b in (a + 1)..n {
                // 只比较双方承诺窗的交集：超出 f_end 的位置将被重规划，冲突与否
                // 此刻不可知（用“未来终点驻留”去虚构冲突会误杀合法快照）。
                let pair_end = frozen_end[a].min(frozen_end[b]);
                let mut reported = false;
                for t in 0..=pair_end {
                    let ca = cell_at(&prefixes[a], &goals, a, t);
                    let cb = cell_at(&prefixes[b], &goals, b, t);
                    if ca == cb {
                        issues.push(Issue::error(
                            codes::SNAP_FROZEN_CONFLICT,
                            "$.dynamic.snapshot",
                            format!(
                                "冻结前缀冲突：`{}` 与 `{}` 在 t={t} 占据同一单元",
                                p.robots[a].id, p.robots[b].id
                            ),
                        ));
                        reported = true;
                        break;
                    }
                    if t < pair_end {
                        let na = cell_at(&prefixes[a], &goals, a, t + 1);
                        let nb = cell_at(&prefixes[b], &goals, b, t + 1);
                        if ca == nb && cb == na && ca != na {
                            issues.push(Issue::error(
                                codes::SNAP_FROZEN_CONFLICT,
                                "$.dynamic.snapshot",
                                format!(
                                    "冻结前缀冲突：`{}` 与 `{}` 在 t={t}→{} 相向交换同一边",
                                    p.robots[a].id,
                                    p.robots[b].id,
                                    t + 1
                                ),
                            ));
                            reported = true;
                            break;
                        }
                    }
                }
                let _ = reported;
            }
        }
    }

    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(DynamicCompiled {
        prefixes,
        frozen_end,
        forced,
    })
}

fn cell_at(prefix: &[Cell], goals: &[Cell], i: usize, t: u32) -> Cell {
    if (t as usize) < prefix.len() {
        prefix[t as usize]
    } else {
        goals[i]
    }
}

fn blocked_cell(
    blocked: &[Vec<(u32, u32)>],
    free_win: &[Vec<(u32, u32)>],
    p: &Problem,
    c: Cell,
    t: u32,
) -> bool {
    if p.map.is_blocked_static(c) {
        return !free_win[c as usize].iter().any(|&(a, b)| t >= a && t < b);
    }
    blocked[c as usize].iter().any(|&(a, b)| t >= a && t < b)
}

/// 动态指标：受影响机器人数与路径变动量（相对“快照既有路径 + 驻留扩展”的完整时间线）。
pub struct ReplanMetrics {
    pub affected_agents: usize,
    pub path_change_steps: u64,
    /// 全实例冻结窗覆盖到的最大时刻（供 UI 展示“承诺保持到 t=?”）。
    pub frozen_covered: u32,
}

impl ReplanMetrics {
    pub fn to_json(&self) -> aps_engine::json::Json {
        aps_engine::json::Json::obj(vec![
            (
                "affected_agents",
                aps_engine::json::Json::int(self.affected_agents as i64),
            ),
            (
                "path_change_steps",
                aps_engine::json::Json::int(self.path_change_steps as i64),
            ),
            (
                "frozen_covered",
                aps_engine::json::Json::int(self.frozen_covered as i64),
            ),
        ])
    }
}

pub fn diff_metrics(p: &Problem, final_cells: &[Vec<Cell>], frozen_end: &[u32]) -> ReplanMetrics {
    let Some(dyn_) = p.dynamic.as_ref() else {
        return ReplanMetrics {
            affected_agents: 0,
            path_change_steps: 0,
            frozen_covered: 0,
        };
    };
    let goals = crate::problem::effective_goals(p);
    let mut affected = 0usize;
    let mut steps = 0u64;
    let mut max_frozen = 0u32;
    for i in 0..p.robots.len() {
        let prior = &dyn_.prior_paths[i];
        max_frozen = max_frozen.max(frozen_end.get(i).copied().unwrap_or(0));
        let mut diff = false;
        for t in (dyn_.time + 1)..=p.horizon {
            let old = if (t as usize) < prior.len() {
                prior[t as usize]
            } else {
                // 快照方案到达终点后的驻留
                prior.last().copied().unwrap_or(goals[i])
            };
            let new = if (t as usize) < final_cells[i].len() {
                final_cells[i][t as usize]
            } else {
                goals[i]
            };
            if old != new {
                diff = true;
                steps += 1;
            }
        }
        if diff {
            affected += 1;
        }
    }
    ReplanMetrics {
        affected_agents: affected,
        path_change_steps: steps,
        frozen_covered: max_frozen,
    }
}
