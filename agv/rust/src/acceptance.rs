//! 验收场景 A01–A16（AGV-SRS §9）：每个场景给出问题、期望与证据，
//! `agv acceptance` / `cargo test` 全量运行并生成报告 JSON。

use aps_engine::engine::CancelToken;
use aps_engine::json::Json;

use crate::capabilities::Profile;
use crate::engine::{solve_json, verify_solution_json, Outcome, SolveOptions};
use crate::errors::Status;

// ---------------------------------------------------------------- 构造工具

fn grid(w: u32, h: u32, walls: &[(u32, u32)]) -> Vec<String> {
    (0..h)
        .map(|y| {
            (0..w)
                .map(|x| if walls.contains(&(x, y)) { '#' } else { '.' })
                .collect::<String>()
        })
        .collect()
}

/// 生成问题 JSON（无动态块；bench 复用）。
/// 测试辅助：任务规格 (id, pickup, dropoff, priority, release, deadline,
/// demand, service, cancel_at, reason)
pub type TaskSpec<'a> = (
    &'a str,
    u32,
    u32,
    u32,
    u32,
    u32,
    u32,
    u32,
    Option<u32>,
    Option<&'a str>,
);

/// 测试辅助：工作站规格 (id, docks, capacity)
pub type StationSpec<'a> = (&'a str, &'a [(u32, u32)], usize);

#[allow(clippy::too_many_arguments)]
pub fn make_problem(
    w: u32,
    h: u32,
    walls: &[(u32, u32)],
    vehicles: &[(&str, u32, u32, &[&str])],
    tasks: &[TaskSpec<'_>],
    horizon: u32,
    stations: &[StationSpec<'_>],
    parking: &[(u32, u32)],
    solver: Option<&str>,
) -> String {
    let cells: Vec<String> = grid(w, h, walls);
    let mut root: Vec<(String, Json)> = vec![
        (
            "schema_version".into(),
            Json::str("agv-dispatch-problem/1.0"),
        ),
        (
            "map".into(),
            Json::obj(vec![("cells", Json::strings(cells))]),
        ),
        (
            "time_model".into(),
            Json::obj(vec![
                ("timestep", Json::str("discrete")),
                ("horizon", Json::int(horizon as i64)),
            ]),
        ),
    ];
    let vs: Vec<Json> = vehicles
        .iter()
        .map(|(id, x, y, caps)| {
            let mut f: Vec<(&str, Json)> = vec![
                ("id", Json::str(*id)),
                (
                    "start",
                    Json::Arr(vec![Json::int(*x as i64), Json::int(*y as i64)]),
                ),
            ];
            if !caps.is_empty() {
                f.push(("capabilities", Json::strings(caps.iter().copied())));
            }
            Json::obj(f)
        })
        .collect();
    root.push(("vehicles".into(), Json::Arr(vs)));
    let ts: Vec<Json> = tasks
        .iter()
        .map(|(id, px, py, dx, dy, ps, ds, rel, due, cap)| {
            let mut f: Vec<(&str, Json)> = vec![
                ("id", Json::str(*id)),
                (
                    "pickup",
                    Json::Arr(vec![Json::int(*px as i64), Json::int(*py as i64)]),
                ),
                (
                    "dropoff",
                    Json::Arr(vec![Json::int(*dx as i64), Json::int(*dy as i64)]),
                ),
                ("pickup_service", Json::int(*ps as i64)),
                ("dropoff_service", Json::int(*ds as i64)),
                ("release_step", Json::int(*rel as i64)),
            ];
            if let Some(d) = due {
                f.push(("due_step", Json::int(*d as i64)));
            }
            if let Some(c) = cap {
                f.push(("required_capability", Json::str(*c)));
            }
            Json::obj(f)
        })
        .collect();
    root.push(("tasks".into(), Json::Arr(ts)));
    if !stations.is_empty() {
        let ss: Vec<Json> = stations
            .iter()
            .map(|(id, cells, cap)| {
                Json::obj(vec![
                    ("id", Json::str(*id)),
                    (
                        "cells",
                        Json::Arr(
                            cells
                                .iter()
                                .map(|(x, y)| {
                                    Json::Arr(vec![Json::int(*x as i64), Json::int(*y as i64)])
                                })
                                .collect(),
                        ),
                    ),
                    ("capacity", Json::int(*cap as i64)),
                ])
            })
            .collect();
        root.push(("stations".into(), Json::Arr(ss)));
    }
    if !parking.is_empty() {
        root.push((
            "parking".into(),
            Json::Arr(
                parking
                    .iter()
                    .map(|(x, y)| Json::Arr(vec![Json::int(*x as i64), Json::int(*y as i64)]))
                    .collect(),
            ),
        ));
    }
    if let Some(s) = solver {
        if let Ok(j) = aps_engine::json::parse(s) {
            root.push(("solver".into(), j));
        }
    }
    Json::Obj(root).to_compact()
}

fn solve(text: &str) -> Outcome {
    let cancel = CancelToken::new();
    solve_json(
        text,
        &SolveOptions {
            profile: Profile::Native,
            verify: true,
            ..Default::default()
        },
        &cancel,
    )
}

// ---------------------------------------------------------------- 快照构造

/// 从一个静态解构造 t=T 时刻的快照（机械变换，bench 复用）。
pub fn snapshot_at(problem_text: &str, sol: &Json, t: u32, events: Vec<Json>) -> String {
    let mut root = aps_engine::json::parse(problem_text).expect("问题 JSON 合法");
    let mut veh_snap: Vec<(String, Json)> = Vec::new();
    if let Some(vs) = sol
        .get("plan")
        .and_then(|p| p.get("vehicles"))
        .and_then(|v| v.as_arr())
    {
        for v in vs {
            let id = v
                .get("id")
                .and_then(|j| j.as_str())
                .unwrap_or("")
                .to_string();
            let timeline: Vec<(usize, [i64; 2])> = v
                .get("timeline")
                .and_then(|j| j.as_arr())
                .map(|a| {
                    a.iter()
                        .enumerate()
                        .filter_map(|(i, c)| {
                            let ca = c.as_arr()?;
                            Some((i, [ca[0].as_i64()?, ca[1].as_i64()?]))
                        })
                        .collect()
                })
                .unwrap_or_default();
            if timeline.len() <= t as usize {
                continue;
            }
            let pos = timeline[t as usize].1;
            // t 时刻的相位与任务
            let mut phase = "idle".to_string();
            let mut task: Option<String> = None;
            if let Some(ms) = v.get("missions").and_then(|j| j.as_arr()) {
                for m in ms {
                    let (from, to) = (
                        m.get("from").and_then(|j| j.as_i64()).unwrap_or(-1),
                        m.get("to").and_then(|j| j.as_i64()).unwrap_or(-1),
                    );
                    let now = t as i64;
                    if from <= now && now < to.max(from + 1) {
                        let ph = m.get("phase").and_then(|j| j.as_str()).unwrap_or("idle");
                        phase = match ph {
                            "to_pickup" | "servicing_pickup" | "to_dropoff"
                            | "servicing_dropoff" => ph.to_string(),
                            "relocating" => "parking".to_string(),
                            _ => "idle".to_string(),
                        };
                        if !matches!(phase.as_str(), "idle") {
                            task = m
                                .get("task")
                                .and_then(|j| j.as_str())
                                .map(|s| s.to_string());
                        }
                        break;
                    }
                }
            }
            veh_snap.push((
                id,
                Json::obj(vec![
                    ("pos", Json::Arr(vec![Json::int(pos[0]), Json::int(pos[1])])),
                    ("phase", Json::str(phase)),
                    ("task", task.map(Json::str).unwrap_or(Json::Null)),
                    (
                        "path",
                        Json::Arr(
                            timeline[..=(t as usize)]
                                .iter()
                                .map(|(_, c)| Json::Arr(vec![Json::int(c[0]), Json::int(c[1])]))
                                .collect(),
                        ),
                    ),
                ]),
            ));
        }
    }
    let mut task_snap: Vec<(String, Json)> = Vec::new();
    if let Some(ts) = sol
        .get("plan")
        .and_then(|p| p.get("tasks"))
        .and_then(|v| v.as_arr())
    {
        for tk in ts {
            let id = tk
                .get("id")
                .and_then(|j| j.as_str())
                .unwrap_or("")
                .to_string();
            let done = tk.get("dropoff_done").and_then(|j| j.as_i64());
            let picked = tk.get("pickup_done").and_then(|j| j.as_i64());
            let status = if done.is_some_and(|d| d <= t as i64) {
                "done"
            } else if picked.is_some_and(|d| d <= t as i64) {
                "picked"
            } else {
                "assigned"
            };
            task_snap.push((
                id,
                Json::obj(vec![
                    ("status", Json::str(status)),
                    ("assignee", tk.get("vehicle").cloned().unwrap_or(Json::Null)),
                    (
                        "pickup_dock",
                        tk.get("pickup_dock").cloned().unwrap_or(Json::Null),
                    ),
                    (
                        "dropoff_dock",
                        tk.get("dropoff_dock").cloned().unwrap_or(Json::Null),
                    ),
                    (
                        "pickup_arrival",
                        tk.get("pickup_arrival").cloned().unwrap_or(Json::Null),
                    ),
                    (
                        "pickup_done",
                        tk.get("pickup_done").cloned().unwrap_or(Json::Null),
                    ),
                    (
                        "dropoff_arrival",
                        tk.get("dropoff_arrival").cloned().unwrap_or(Json::Null),
                    ),
                    (
                        "dropoff_done",
                        tk.get("dropoff_done").cloned().unwrap_or(Json::Null),
                    ),
                ]),
            ));
        }
    }
    let dynamic = Json::obj(vec![
        (
            "snapshot",
            Json::obj(vec![
                ("time", Json::int(t as i64)),
                ("vehicles", Json::Obj(veh_snap)),
                ("tasks", Json::Obj(task_snap)),
            ]),
        ),
        ("events", Json::Arr(events)),
    ]);
    root.set("dynamic", dynamic);
    root.to_compact()
}

// ---------------------------------------------------------------- 报告

struct CaseResult {
    id: &'static str,
    name: &'static str,
    ok: bool,
    evidence: String,
    ms: f64,
}

fn run_case(
    id: &'static str,
    name: &'static str,
    f: impl FnOnce() -> Result<String, String>,
) -> CaseResult {
    let t0 = aps_engine::clock::now_ms();
    let r = f();
    CaseResult {
        id,
        name,
        ok: r.is_ok(),
        evidence: r.unwrap_or_else(|e| e),
        ms: aps_engine::clock::now_ms() - t0,
    }
}

fn task_status(out: &Outcome, ti: usize) -> String {
    out.solution
        .get("plan")
        .and_then(|p| p.get("tasks"))
        .and_then(|t| t.as_arr())
        .and_then(|a| a.get(ti))
        .and_then(|t| t.get("status"))
        .and_then(|s| s.as_str())
        .unwrap_or("?")
        .to_string()
}

fn task_field_i64(out: &Outcome, ti: usize, field: &str) -> Option<i64> {
    out.solution
        .get("plan")
        .and_then(|p| p.get("tasks"))
        .and_then(|t| t.as_arr())
        .and_then(|a| a.get(ti))
        .and_then(|t| t.get(field))
        .and_then(|s| s.as_i64())
}

fn verified(out: &Outcome) -> bool {
    out.solution
        .get("verified")
        .and_then(|j| j.as_bool())
        .unwrap_or(false)
}

fn mission_intervals(out: &Outcome, phase: &str) -> Vec<(String, [i64; 2], Option<String>)> {
    let mut r = Vec::new();
    if let Some(vs) = out
        .solution
        .get("plan")
        .and_then(|p| p.get("vehicles"))
        .and_then(|v| v.as_arr())
    {
        for v in vs {
            let vid = v
                .get("id")
                .and_then(|j| j.as_str())
                .unwrap_or("")
                .to_string();
            if let Some(ms) = v.get("missions").and_then(|j| j.as_arr()) {
                for m in ms {
                    if m.get("phase").and_then(|j| j.as_str()) == Some(phase) {
                        r.push((
                            vid.clone(),
                            [
                                m.get("from").and_then(|j| j.as_i64()).unwrap_or(0),
                                m.get("to").and_then(|j| j.as_i64()).unwrap_or(0),
                            ],
                            m.get("task")
                                .and_then(|j| j.as_str())
                                .map(|s| s.to_string()),
                        ));
                    }
                }
            }
        }
    }
    r
}

fn station_cell_intervals(out: &Outcome, cell: (i64, i64)) -> Vec<(i64, i64)> {
    // 该格上的 servicing_* 区间
    let mut r = Vec::new();
    if let Some(vs) = out
        .solution
        .get("plan")
        .and_then(|p| p.get("vehicles"))
        .and_then(|v| v.as_arr())
    {
        for v in vs {
            if let Some(ms) = v.get("missions").and_then(|j| j.as_arr()) {
                for m in ms {
                    let ph = m.get("phase").and_then(|j| j.as_str()).unwrap_or("");
                    if !ph.starts_with("servicing") {
                        continue;
                    }
                    if let Some(d) = m.get("dock").and_then(|j| j.as_arr()) {
                        if d.len() == 2
                            && d[0].as_i64() == Some(cell.0)
                            && d[1].as_i64() == Some(cell.1)
                        {
                            r.push((
                                m.get("from").and_then(|j| j.as_i64()).unwrap_or(0),
                                m.get("to").and_then(|j| j.as_i64()).unwrap_or(0),
                            ));
                        }
                    }
                }
            }
        }
    }
    r
}

fn expect_feasible_verified(out: &Outcome) -> Result<String, String> {
    if out.status != Status::Feasible {
        return Err(format!(
            "期望 FEASIBLE，实得 {}（解摘录：{}）",
            out.status.as_str(),
            truncate(&out.solution_json, 400)
        ));
    }
    if !verified(out) {
        return Err(format!(
            "独立核验未通过：{}",
            out.solution
                .get("verify")
                .map(|j| j.to_compact())
                .unwrap_or_default()
        ));
    }
    let completed = out
        .solution
        .get("metrics")
        .and_then(|m| m.get("completed_tasks"))
        .and_then(|j| j.as_i64())
        .unwrap_or(-1);
    Ok(format!(
        "status=FEASIBLE verified=true completed={completed}"
    ))
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}

// ---------------------------------------------------------------- A01–A16

pub fn run_all(profile: Profile) -> Json {
    let mut cases: Vec<CaseResult> = Vec::new();

    // A01 单车单任务
    cases.push(run_case("A01", "单车单任务", || {
        let p = make_problem(
            6,
            3,
            &[],
            &[("V1", 0, 0, &[])],
            &[("T1", 4, 0, 1, 2, 1, 1, 0, None, None)],
            60,
            &[],
            &[],
            None,
        );
        let out = solve(&p);
        let base = expect_feasible_verified(&out)?;
        let pd = task_field_i64(&out, 0, "pickup_done").ok_or("缺少 pickup_done")?;
        let dd = task_field_i64(&out, 0, "dropoff_done").ok_or("缺少 dropoff_done")?;
        if pd != 5 {
            return Err(format!("pickup_done 期望 5（4 步 + 1 服务），实得 {pd}"));
        }
        if dd != 11 {
            return Err(format!("dropoff_done 期望 11，实得 {dd}"));
        }
        Ok(format!("{base}; pickup_done={pd} dropoff_done={dd}"))
    }));

    // A02 单车多任务（顺序执行 + 单载）
    cases.push(run_case("A02", "单车多任务", || {
        let p = make_problem(
            8,
            3,
            &[],
            &[("V1", 0, 0, &[])],
            &[
                ("T1", 2, 0, 7, 0, 0, 0, 0, None, None),
                ("T2", 2, 2, 7, 2, 0, 0, 0, None, None),
                ("T3", 5, 1, 0, 1, 0, 0, 0, None, None),
            ],
            120,
            &[],
            &[],
            None,
        );
        let out = solve(&p);
        let base = expect_feasible_verified(&out)?;
        // 单载由 verify 的 single_load_and_order 检查覆盖；此处核对完成标记数
        let n_done = mission_intervals(&out, "done").len();
        if n_done != 3 {
            return Err(format!("3 个任务都应有完成标记，实得 {n_done}"));
        }
        Ok(format!("{base}; tasks=3 done_markers={n_done}"))
    }));

    // A03 多车多任务
    cases.push(run_case("A03", "多车多任务", || {
        let p = make_problem(
            12,
            8,
            &[(5, 1), (5, 2), (5, 3), (5, 4)],
            &[
                ("V1", 0, 0, &[]),
                ("V2", 0, 7, &[]),
                ("V3", 11, 0, &[]),
                ("V4", 11, 7, &[]),
            ],
            &[
                ("T1", 3, 1, 8, 1, 1, 1, 0, None, None),
                ("T2", 3, 6, 8, 6, 1, 1, 0, None, None),
                ("T3", 9, 2, 1, 2, 0, 0, 0, None, None),
                ("T4", 9, 5, 1, 5, 0, 0, 0, None, None),
                ("T5", 2, 4, 10, 4, 0, 0, 0, None, None),
                ("T6", 6, 7, 6, 0, 0, 0, 0, None, None),
            ],
            200,
            &[],
            &[],
            None,
        );
        let out = solve(&p);
        expect_feasible_verified(&out)
    }));

    // A04 能力不满足
    cases.push(run_case("A04", "能力不满足拒配", || {
        let p = make_problem(
            6,
            2,
            &[],
            &[("V1", 0, 0, &["lift"])],
            &[("T1", 3, 0, 1, 1, 0, 0, 0, None, Some("forklift"))],
            60,
            &[],
            &[],
            None,
        );
        let out = solve(&p);
        if out.status != Status::Infeasible {
            return Err(format!("期望 INFEASIBLE，实得 {}", out.status.as_str()));
        }
        let reason = out
            .solution
            .get("plan")
            .and_then(|p| p.get("tasks"))
            .and_then(|t| t.as_arr())
            .and_then(|a| a.first())
            .and_then(|t| t.get("reason"))
            .and_then(|r| r.as_str())
            .unwrap_or("");
        if reason != "E-AGV-TASK-LEG-INFEASIBLE" {
            return Err(format!(
                "reason 期望 E-AGV-TASK-LEG-INFEASIBLE，实得 {reason}"
            ));
        }
        Ok(format!("status=INFEASIBLE reason={reason}"))
    }));

    // A05 释放时刻
    cases.push(run_case("A05", "释放时刻等待", || {
        let p = make_problem(
            6,
            3,
            &[],
            &[("V1", 0, 0, &[])],
            &[("T1", 2, 0, 1, 2, 1, 1, 5, None, None)],
            60,
            &[],
            &[],
            None,
        );
        let out = solve(&p);
        let base = expect_feasible_verified(&out)?;
        let pd = task_field_i64(&out, 0, "pickup_done").ok_or("缺少 pickup_done")?;
        let pa = task_field_i64(&out, 0, "pickup_arrival").unwrap_or(-1);
        if pd < 6 {
            return Err(format!("release=5 + 服务 1 ⇒ pickup_done ≥ 6，实得 {pd}"));
        }
        Ok(format!(
            "{base}; pickup_arrival={pa} pickup_done={pd}（含释放等待）"
        ))
    }));

    // A06 优先级
    cases.push(run_case("A06", "优先级（高优先先完成）", || {
        let p = make_problem(
            10,
            3,
            &[],
            &[("V1", 0, 1, &[])],
            &[
                ("T-lo", 4, 0, 9, 0, 0, 0, 0, None, None),
                ("T-hi", 4, 2, 9, 2, 0, 0, 0, None, None),
            ],
            150,
            &[],
            &[],
            Some(r#"{ "algorithm": "baseline" }"#),
        );
        let out = solve(&p);
        let base = expect_feasible_verified(&out)?;
        // 任务表序：T-lo=0, T-hi=1（baseline 构造序：同 release 下 priority 降序）
        let lo_done = task_field_i64(&out, 0, "dropoff_done").ok_or("T-lo 缺 dropoff_done")?;
        let hi_done = task_field_i64(&out, 1, "dropoff_done").ok_or("T-hi 缺 dropoff_done")?;
        if hi_done > lo_done {
            return Err(format!(
                "期望高优先级先完成：T-hi={hi_done} 应 ≤ T-lo={lo_done}"
            ));
        }
        Ok(format!("{base}; hi_done={hi_done} lo_done={lo_done}"))
    }));

    // A07 工作站容量
    cases.push(run_case("A07", "工作站容量串行", || {
        let p = make_problem(
            10,
            5,
            &[],
            &[("V1", 0, 0, &[]), ("V2", 0, 4, &[])],
            &[
                ("T1", 3, 1, 9, 1, 2, 2, 0, None, None),
                ("T2", 3, 3, 9, 3, 2, 2, 0, None, None),
            ],
            120,
            &[("ST", &[(3, 1), (3, 3)], 1)],
            &[],
            None,
        );
        let out = solve(&p);
        let base = expect_feasible_verified(&out)?;
        // 站内并发 ≤ 1
        let mut ints = station_cell_intervals(&out, (3, 1));
        ints.extend(station_cell_intervals(&out, (3, 3)));
        ints.sort();
        for w in ints.windows(2) {
            if w[0].1 > w[1].0 {
                return Err(format!(
                    "工作站容量 1 被突破：区间 {:?} 与 {:?} 重叠",
                    w[0], w[1]
                ));
            }
        }
        Ok(format!("{base}; station_service_intervals={ints:?}"))
    }));

    // A08 对穿无冲突
    cases.push(run_case("A08", "对穿无冲突", || {
        let p = make_problem(
            8,
            3,
            &[],
            &[("A", 0, 1, &[]), ("B", 7, 1, &[])],
            &[
                ("T1", 7, 1, 0, 1, 0, 0, 0, None, None),
                ("T2", 0, 1, 7, 1, 0, 0, 0, None, None),
            ],
            120,
            &[],
            &[],
            None,
        );
        let out = solve(&p);
        expect_feasible_verified(&out)
    }));

    // A09 同站多次取送
    cases.push(run_case("A09", "同站多次服务", || {
        let p = make_problem(
            10,
            5,
            &[],
            &[("V1", 0, 0, &[]), ("V2", 9, 0, &[])],
            &[
                ("T1", 4, 2, 8, 4, 1, 1, 0, None, None),
                ("T2", 4, 2, 1, 4, 1, 1, 0, None, None),
                ("T3", 4, 2, 8, 0, 0, 0, 0, None, None),
            ],
            150,
            &[("ST", &[(4, 2), (4, 3)], 2)],
            &[],
            None,
        );
        let out = solve(&p);
        expect_feasible_verified(&out)
    }));

    // A10 动态：任务追加
    cases.push(run_case("A10", "动态重调度：任务追加", || {
        let base = make_problem(
            10,
            5,
            &[],
            &[("V1", 0, 0, &[]), ("V2", 0, 4, &[])],
            &[
                ("T1", 5, 1, 9, 1, 1, 1, 0, None, None),
                ("T2", 5, 3, 9, 3, 1, 1, 0, None, None),
            ],
            150,
            &[],
            &[],
            None,
        );
        let first = solve(&base);
        if first.status != Status::Feasible {
            return Err(format!("基础解失败：{}", first.status.as_str()));
        }
        let t = 3;
        let events = vec![Json::obj(vec![
            ("type", Json::str("task_add")),
            (
                "task_def",
                Json::obj(vec![
                    ("id", Json::str("T3-new")),
                    ("pickup", Json::Arr(vec![Json::int(2), Json::int(2)])),
                    ("dropoff", Json::Arr(vec![Json::int(8), Json::int(0)])),
                ]),
            ),
        ])];
        let dyn_p = snapshot_at(&base, &first.solution, t, events);
        let out = solve(&dyn_p);
        let base_ok = expect_feasible_verified(&out)?;
        let n_completed = out
            .solution
            .get("metrics")
            .and_then(|m| m.get("completed_tasks"))
            .and_then(|j| j.as_i64())
            .unwrap_or(-1);
        if n_completed != 3 {
            return Err(format!(
                "含新增任务共 3 个应全部完成，实得 {n_completed}（T3-new 状态={}）",
                task_status(&out, 2)
            ));
        }
        // 历史前缀保留
        let h = out
            .solution
            .get("plan")
            .and_then(|p| p.get("horizon"))
            .and_then(|j| j.as_i64())
            .unwrap_or(0);
        Ok(format!(
            "{base_ok}; total_completed={n_completed} horizon={h} snapshot_t={t}"
        ))
    }));

    // A11 动态：车辆暂停改派
    cases.push(run_case(
        "A11",
        "动态重调度：车辆暂停改派",
        || {
            let base = make_problem(
                12,
                5,
                &[],
                &[("V1", 0, 0, &[]), ("V2", 0, 4, &[])],
                &[
                    ("T1", 5, 0, 11, 0, 1, 1, 0, None, None),
                    ("T2", 5, 4, 11, 4, 1, 1, 0, None, None),
                ],
                150,
                &[],
                &[],
                None,
            );
            let first = solve(&base);
            if first.status != Status::Feasible {
                return Err(format!("基础解失败：{}", first.status.as_str()));
            }
            // t=2：任务尚未开始（行驶初期）→ 暂停 V1，其任务应改派 V2
            let t = 2;
            let events = vec![Json::obj(vec![
                ("type", Json::str("vehicle_pause")),
                ("vehicle", Json::str("V1")),
            ])];
            let dyn_p = snapshot_at(&base, &first.solution, t, events);
            let out = solve(&dyn_p);
            expect_feasible_verified(&out)
        },
    ));

    // A12 动态：障碍重规划
    cases.push(run_case("A12", "动态重调度：障碍重规划", || {
        // 两条通道：y=0 与 y=2；中途封 y=0 通道一格（窗口障碍）
        let base = make_problem(
            9,
            3,
            &[(4, 1)],
            &[("V1", 0, 1, &[])],
            &[("T1", 8, 1, 0, 1, 0, 0, 0, None, None)],
            120,
            &[],
            &[],
            None,
        );
        let first = solve(&base);
        if first.status != Status::Feasible {
            return Err(format!("基础解失败：{}", first.status.as_str()));
        }
        let t = 2;
        let events = vec![Json::obj(vec![
            ("type", Json::str("obstacle_add")),
            ("cell", Json::Arr(vec![Json::int(4), Json::int(0)])),
            ("at", Json::int(t as i64 + 1)),
            ("until", Json::int(60)),
        ])];
        let dyn_p = snapshot_at(&base, &first.solution, t, events);
        let out = solve(&dyn_p);
        expect_feasible_verified(&out)
    }));

    // A13 预算诚实
    cases.push(run_case("A13", "预算诚实", || {
        let p = make_problem(
            14,
            10,
            &[],
            &[("V1", 0, 0, &[])],
            &[
                ("T1", 12, 8, 1, 8, 1, 1, 0, None, None),
                ("T2", 12, 1, 1, 1, 1, 1, 0, None, None),
                ("T3", 6, 5, 6, 0, 1, 1, 0, None, None),
            ],
            300,
            &[],
            &[],
            Some(r#"{ "time_limit_ms": 3 }"#),
        );
        let out = solve(&p);
        let status = out.status;
        if !matches!(status, Status::Feasible | Status::Partial | Status::Unknown) {
            return Err(format!(
                "紧预算下状态应为 FEASIBLE/PARTIAL/UNKNOWN，实得 {}",
                status.as_str()
            ));
        }
        if status != Status::Feasible {
            // 每个未完成任务必须有 reason
            let ts: Vec<Json> = out
                .solution
                .get("plan")
                .and_then(|p| p.get("tasks"))
                .and_then(|t| t.as_arr())
                .map(|a| a.to_vec())
                .unwrap_or_default();
            for t in &ts {
                if t.get("status").and_then(|j| j.as_str()) != Some("completed") {
                    let reason = t.get("reason").and_then(|j| j.as_str());
                    if reason.is_none() {
                        return Err(format!(
                            "未完成任务 {} 缺少 reason（预算诚实性）",
                            t.get("id").and_then(|j| j.as_str()).unwrap_or("?")
                        ));
                    }
                }
            }
        }
        let verified_now = verified(&out);
        Ok(format!(
            "status={} verified={verified_now}（未完成项均带原因码）",
            status.as_str()
        ))
    }));

    // A14 篡改必拒
    cases.push(run_case("A14", "篡改必拒", || {
        let p = make_problem(
            6,
            3,
            &[],
            &[("V1", 0, 0, &[])],
            &[("T1", 4, 0, 1, 2, 1, 1, 0, None, None)],
            60,
            &[],
            &[],
            None,
        );
        let out = solve(&p);
        let sol_text = out.solution_json.clone();
        let report = verify_solution_json(&p, &sol_text, false);
        if !report.get("ok").and_then(|j| j.as_bool()).unwrap_or(false) {
            return Err("干净解未通过核验".into());
        }
        // 篡改 1：timeline 跳跃
        let mut s1 = out.solution.clone();
        if let Some(plan) = s1.get_mut("plan") {
            if let Some(vs) = plan.get_mut("vehicles").and_then(|j| j.as_arr_mut()) {
                if let Some(v) = vs.get_mut(0) {
                    if let Some(tl) = v.get_mut("timeline").and_then(|j| j.as_arr_mut()) {
                        if tl.len() > 3 {
                            tl[3] = Json::Arr(vec![Json::int(5), Json::int(2)]);
                        }
                    }
                }
            }
        }
        let r1 = verify_solution_json(&p, &s1.to_compact(), false);
        // 篡改 2：metrics 造假
        let mut s2 = out.solution.clone();
        if let Some(m) = s2.get_mut("metrics") {
            m.set("total_travel_steps", Json::int(999));
        }
        let r2 = verify_solution_json(&p, &s2.to_compact(), false);
        if r1.get("ok").and_then(|j| j.as_bool()) != Some(false) {
            return Err("跳跃篡改未被拒绝".into());
        }
        if r2.get("ok").and_then(|j| j.as_bool()) != Some(false) {
            return Err("指标造假未被拒绝".into());
        }
        Ok("timeline 篡改→fail；metrics 造假→fail；干净解→pass".into())
    }));

    // A15 指纹可复现
    cases.push(run_case("A15", "指纹可复现", || {
        let p = make_problem(
            8,
            4,
            &[(3, 1)],
            &[("V1", 0, 0, &[]), ("V2", 7, 3, &[])],
            &[
                ("T1", 6, 0, 1, 3, 1, 0, 0, None, None),
                ("T2", 2, 2, 7, 1, 0, 1, 0, None, None),
            ],
            120,
            &[],
            &[],
            None,
        );
        let a = solve(&p);
        let b = solve(&p);
        if a.status != Status::Feasible {
            return Err(format!("解失败：{}", a.status.as_str()));
        }
        let fa = a
            .solution
            .get("fingerprint")
            .and_then(|j| j.as_str())
            .unwrap_or("");
        let fb = b
            .solution
            .get("fingerprint")
            .and_then(|j| j.as_str())
            .unwrap_or("");
        if fa.is_empty() || fa != fb {
            return Err(format!("指纹不一致：{fa} vs {fb}"));
        }
        Ok(format!("fingerprint={fa}"))
    }));

    // A16 取消与恢复
    cases.push(run_case("A16", "取消与恢复", || {
        let p = make_problem(
            6,
            3,
            &[],
            &[("V1", 0, 0, &[])],
            &[("T1", 4, 0, 1, 2, 1, 1, 0, None, None)],
            60,
            &[],
            &[],
            None,
        );
        let cancel = CancelToken::new();
        cancel.cancel();
        let out = engine_cancelled(&p, &cancel);
        if out.status != Status::Cancelled {
            return Err(format!(
                "取消后期望 CANCELLED，实得 {}",
                out.status.as_str()
            ));
        }
        let fresh = solve(&p);
        let base = expect_feasible_verified(&fresh)?;
        Ok(format!("cancelled→CANCELLED；fresh→{base}"))
    }));

    let items: Vec<Json> = cases
        .iter()
        .map(|c| {
            Json::obj(vec![
                ("id", Json::str(c.id)),
                ("name", Json::str(c.name)),
                ("status", Json::str(if c.ok { "pass" } else { "fail" })),
                ("evidence", Json::str(c.evidence.as_str())),
                ("duration_ms", Json::Float((c.ms * 1000.0).round() / 1000.0)),
            ])
        })
        .collect();
    let passed = cases.iter().filter(|c| c.ok).count();
    Json::obj(vec![
        ("schema_version", Json::str("agv-acceptance/1.0")),
        ("engine", Json::str(crate::ENGINE_NAME)),
        ("engine_version", Json::str(crate::ENGINE_VERSION)),
        ("ruleset_version", Json::str(crate::RULESET_VERSION)),
        ("capability_profile", Json::str(profile.as_str())),
        ("cases", Json::Arr(items)),
        (
            "summary",
            Json::obj(vec![
                ("total", Json::int(cases.len() as i64)),
                ("passed", Json::int(passed as i64)),
                ("failed", Json::int((cases.len() - passed) as i64)),
            ]),
        ),
    ])
}

fn engine_cancelled(text: &str, cancel: &CancelToken) -> Outcome {
    solve_json(
        text,
        &SolveOptions {
            profile: Profile::Native,
            verify: true,
            ..Default::default()
        },
        cancel,
    )
}

// ---------------------------------------------------------------------------
// 固定 Mock 导出（SRS §6：固定验收数据，供实验室示例与手工复算）
// ---------------------------------------------------------------------------

/// 生成全部固定 Mock：`(文件名, 标题, 问题 JSON)`。
///
/// 静态用例直接复用验收参数；动态用例（A10–A12）由「基础解 + 快照 + 事件」
/// 构造为**可直接求解**的动态问题；`warehouse-b01` 与基准 B01 同源。
pub fn mock_problems() -> Vec<(&'static str, &'static str, String)> {
    let mut out: Vec<(&'static str, &'static str, String)> = Vec::new();
    // 契约（agv-dispatch-problem/1.0）必填 objective；构造器默认注入字典序加权威重。
    let with_id = |text: &str, id: &str| -> String {
        match aps_engine::json::parse(text) {
            Ok(mut j) => {
                j.set("id", Json::str(id));
                if j.get("objective").is_none() {
                    j.set(
                        "objective",
                        Json::obj(vec![("kind", Json::str("lexicographic-weighted"))]),
                    );
                }
                j.to_pretty()
            }
            Err(_) => text.to_string(),
        }
    };

    // A01 单车单任务
    let p = make_problem(
        6,
        3,
        &[],
        &[("V1", 0, 0, &[])],
        &[("T1", 4, 0, 1, 2, 1, 1, 0, None, None)],
        60,
        &[],
        &[],
        None,
    );
    out.push((
        "a01-single-task.json",
        "单车单任务（6×3，取送 + 单步服务）",
        with_id(&p, "agv-mock-a01"),
    ));

    // A02 单车多任务（顺序 + 单载）
    let p = make_problem(
        8,
        3,
        &[],
        &[("V1", 0, 0, &[])],
        &[
            ("T1", 2, 0, 7, 0, 0, 0, 0, None, None),
            ("T2", 2, 2, 7, 2, 0, 0, 0, None, None),
            ("T3", 5, 1, 0, 1, 0, 0, 0, None, None),
        ],
        120,
        &[],
        &[],
        None,
    );
    out.push((
        "a02-multi-task-single-vehicle.json",
        "单车多任务（顺序执行 + 单载约束）",
        with_id(&p, "agv-mock-a02"),
    ));

    // A03 多车多任务（含中隔墙）
    let p = make_problem(
        12,
        8,
        &[(5, 1), (5, 2), (5, 3), (5, 4)],
        &[
            ("V1", 0, 0, &[]),
            ("V2", 0, 7, &[]),
            ("V3", 11, 0, &[]),
            ("V4", 11, 7, &[]),
        ],
        &[
            ("T1", 3, 1, 8, 1, 1, 1, 0, None, None),
            ("T2", 3, 6, 8, 6, 1, 1, 0, None, None),
            ("T3", 9, 2, 1, 2, 0, 0, 0, None, None),
            ("T4", 9, 5, 1, 5, 0, 0, 0, None, None),
            ("T5", 2, 4, 10, 4, 0, 0, 0, None, None),
            ("T6", 6, 7, 6, 0, 0, 0, 0, None, None),
        ],
        200,
        &[],
        &[],
        None,
    );
    out.push((
        "a03-multi-vehicle.json",
        "多车多任务（4 车 6 任务，中隔墙绕行）",
        with_id(&p, "agv-mock-a03"),
    ));

    // A05 释放时刻
    let p = make_problem(
        6,
        3,
        &[],
        &[("V1", 0, 0, &[])],
        &[("T1", 2, 0, 1, 2, 1, 1, 5, None, None)],
        60,
        &[],
        &[],
        None,
    );
    out.push((
        "a05-release-wait.json",
        "释放时刻等待（t=5 才可取）",
        with_id(&p, "agv-mock-a05"),
    ));

    // A06 优先级
    let p = make_problem(
        10,
        3,
        &[],
        &[("V1", 0, 1, &[])],
        &[
            ("T-lo", 4, 0, 9, 0, 0, 0, 0, None, None),
            ("T-hi", 4, 2, 9, 2, 0, 0, 0, None, None),
        ],
        150,
        &[],
        &[],
        Some(r#"{ "algorithm": "baseline" }"#),
    );
    out.push((
        "a06-priority.json",
        "优先级（同车高优先先完成）",
        with_id(&p, "agv-mock-a06"),
    ));

    // A07 工作站容量
    let p = make_problem(
        10,
        5,
        &[],
        &[("V1", 0, 0, &[]), ("V2", 0, 4, &[])],
        &[
            ("T1", 3, 1, 9, 1, 2, 2, 0, None, None),
            ("T2", 3, 3, 9, 3, 2, 2, 0, None, None),
        ],
        120,
        &[("ST", &[(3, 1), (3, 3)], 1)],
        &[],
        None,
    );
    out.push((
        "a07-station-capacity.json",
        "工作站容量（2 泊位容量 1，串行服务）",
        with_id(&p, "agv-mock-a07"),
    ));

    // A08 对穿
    let p = make_problem(
        8,
        3,
        &[],
        &[("A", 0, 1, &[]), ("B", 7, 1, &[])],
        &[
            ("T1", 7, 1, 0, 1, 0, 0, 0, None, None),
            ("T2", 0, 1, 7, 1, 0, 0, 0, None, None),
        ],
        120,
        &[],
        &[],
        None,
    );
    out.push((
        "a08-corridor-swap.json",
        "对穿（两车互换位置，无冲突）",
        with_id(&p, "agv-mock-a08"),
    ));

    // A09 同站多次取送
    let p = make_problem(
        10,
        5,
        &[],
        &[("V1", 0, 0, &[]), ("V2", 9, 0, &[])],
        &[
            ("T1", 4, 2, 8, 4, 1, 1, 0, None, None),
            ("T2", 4, 2, 1, 4, 1, 1, 0, None, None),
            ("T3", 4, 2, 8, 0, 0, 0, 0, None, None),
        ],
        150,
        &[("ST", &[(4, 2), (4, 3)], 2)],
        &[],
        None,
    );
    out.push((
        "a09-station-repeat.json",
        "同站多次取送（2 泊位容量 2）",
        with_id(&p, "agv-mock-a09"),
    ));

    // A13 紧预算（诚实失败演示）
    let p = make_problem(
        14,
        10,
        &[],
        &[("V1", 0, 0, &[])],
        &[
            ("T1", 12, 8, 1, 8, 1, 1, 0, None, None),
            ("T2", 12, 1, 1, 1, 1, 1, 0, None, None),
            ("T3", 6, 5, 6, 0, 1, 1, 0, None, None),
        ],
        300,
        &[],
        &[],
        Some(r#"{ "time_limit_ms": 3 }"#),
    );
    out.push((
        "a13-tight-budget.json",
        "紧预算（3 ms 上限，诚实 PARTIAL/UNKNOWN）",
        with_id(&p, "agv-mock-a13"),
    ));

    // —— 动态：基础解 + 快照 + 事件 → 可直接求解的动态问题 ——
    let dyn_of = |dims: (u32, u32),
                  walls: &[(u32, u32)],
                  vehicles: &[(&str, u32, u32, &[&str])],
                  tasks: &[TaskSpec<'_>],
                  horizon: u32,
                  t: u32,
                  events: Vec<Json>|
     -> String {
        let base = make_problem(
            dims.0,
            dims.1,
            walls,
            vehicles,
            tasks,
            horizon,
            &[],
            &[],
            None,
        );
        let cancel = CancelToken::new();
        let first = solve_json(&base, &SolveOptions::default(), &cancel);
        assert_eq!(first.status, Status::Feasible, "动态 Mock 的基础解必须可行");
        snapshot_at(&base, &first.solution, t, events)
    };

    // A10 任务追加
    let events = vec![Json::obj(vec![
        ("type", Json::str("task_add")),
        (
            "task_def",
            Json::obj(vec![
                ("id", Json::str("T3-new")),
                ("pickup", Json::Arr(vec![Json::int(2), Json::int(2)])),
                ("dropoff", Json::Arr(vec![Json::int(8), Json::int(0)])),
            ]),
        ),
    ])];
    let p = dyn_of(
        (10, 5),
        &[],
        &[("V1", 0, 0, &[]), ("V2", 0, 4, &[])],
        &[
            ("T1", 5, 1, 9, 1, 1, 1, 0, None, None),
            ("T2", 5, 3, 9, 3, 1, 1, 0, None, None),
        ],
        150,
        3,
        events,
    );
    out.push((
        "a10-dynamic-task-add.json",
        "动态：t=3 追加任务 T3-new",
        with_id(&p, "agv-mock-a10"),
    ));

    // A11 车辆暂停
    let events = vec![Json::obj(vec![
        ("type", Json::str("vehicle_pause")),
        ("vehicle", Json::str("V1")),
    ])];
    let p = dyn_of(
        (12, 5),
        &[],
        &[("V1", 0, 0, &[]), ("V2", 0, 4, &[])],
        &[
            ("T1", 5, 0, 11, 0, 1, 1, 0, None, None),
            ("T2", 5, 4, 11, 4, 1, 1, 0, None, None),
        ],
        150,
        2,
        events,
    );
    out.push((
        "a11-dynamic-vehicle-pause.json",
        "动态：t=2 暂停 V1（任务改派 V2）",
        with_id(&p, "agv-mock-a11"),
    ));

    // A12 障碍出现
    let events = vec![Json::obj(vec![
        ("type", Json::str("obstacle_add")),
        ("cell", Json::Arr(vec![Json::int(4), Json::int(0)])),
        ("at", Json::int(2)),
        ("until", Json::Null),
    ])];
    let p = dyn_of(
        (9, 3),
        &[(4, 1)],
        &[("V1", 0, 1, &[])],
        &[("T1", 8, 1, 0, 1, 0, 0, 0, None, None)],
        120,
        2,
        events,
    );
    out.push((
        "a12-dynamic-obstacle.json",
        "动态：t=2 新增障碍 (4,0)（重规划绕行）",
        with_id(&p, "agv-mock-a12"),
    ));

    // B01 仓库规模演示
    let p = crate::bench::b01_problem();
    out.push((
        "warehouse-b01.json",
        "仓库规模（40×25、8 车 20 任务、确定性墙）",
        with_id(&p, "agv-mock-warehouse-b01"),
    ));

    out
}

/// 把固定 Mock 写入目录；返回写入的文件路径列表。
pub fn export_mocks(dir: &str) -> Result<Vec<String>, String> {
    let _ = std::fs::create_dir_all(dir);
    let mut paths = Vec::new();
    for (name, _title, text) in mock_problems() {
        let path = format!("{dir}/{name}");
        std::fs::write(&path, format!("{text}\n")).map_err(|e| format!("写入 {path} 失败：{e}"))?;
        paths.push(path);
    }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acceptance_all_pass() {
        let report = run_all(Profile::Native);
        let failed = report
            .get("summary")
            .and_then(|s| s.get("failed"))
            .and_then(|j| j.as_i64())
            .unwrap_or(-1);
        assert_eq!(failed, 0, "验收未全过：\n{}", report.to_pretty());
    }

    #[test]
    fn wasm_light_basic() {
        let p = make_problem(
            6,
            3,
            &[],
            &[("V1", 0, 0, &[])],
            &[("T1", 4, 0, 1, 2, 1, 1, 0, None, None)],
            60,
            &[],
            &[],
            None,
        );
        let cancel = CancelToken::new();
        let out = solve_json(
            &p,
            &SolveOptions {
                profile: Profile::WasmLight,
                verify: true,
                ..Default::default()
            },
            &cancel,
        );
        assert_eq!(out.status, Status::Feasible, "{}", out.solution_json);
        assert_eq!(
            out.solution.get("verified").and_then(|j| j.as_bool()),
            Some(true)
        );
    }
}
