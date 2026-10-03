//! 引擎编排：解析 → 动态展开 → 调度（assign）→ 实现（integrate 分段联合
//! MAPF）→ 指标 → 独立核验 → 解 JSON（AGV-SRS §4 流水线）。
//!
//! 确定性：同输入 + 同参数 + 同版本 ⇒ 同输出（全枚举顺序固定，无 RNG，
//! 预算只影响“做多少”，不影响“怎么排”）。

use aps_engine::alloc;
use aps_engine::engine::CancelToken;
use aps_engine::hash;
use aps_engine::json::Json;

use crate::assign;
use crate::capabilities::{self, Limits, Profile};
use crate::dynamic;
use crate::errors::{codes, Issue, Status};
use crate::estimate::SchedInput;
use crate::integrate;
use crate::metrics;
use crate::problem::{parse_problem, Problem};
use crate::verify;

pub const SCHEMA_VERSION_SOLUTION: &str = "agv-dispatch-solution/1.0";

/// 求解选项（宿主级覆盖；未设置则用问题内 solver 块）。
#[derive(Debug, Clone)]
pub struct SolveOptions {
    pub profile: Profile,
    pub verify: bool,
    pub solution_id: Option<String>,
    pub time_limit_ms: Option<i64>,
    pub seed: Option<u64>,
    pub algorithm: Option<String>,
    pub mapf_planner: Option<String>,
    pub mapf_w: Option<f64>,
    pub mapf_time_limit_ms: Option<i64>,
    pub horizon: Option<u32>,
}

impl Default for SolveOptions {
    fn default() -> Self {
        SolveOptions {
            profile: Profile::Native,
            verify: true,
            solution_id: None,
            time_limit_ms: None,
            seed: None,
            algorithm: None,
            mapf_planner: None,
            mapf_w: None,
            mapf_time_limit_ms: None,
            horizon: None,
        }
    }
}

pub struct Outcome {
    pub status: Status,
    pub solution_json: String,
    pub solution: Json,
}

/// 求解入口。
pub fn solve_json(problem_text: &str, opts: &SolveOptions, cancel: &CancelToken) -> Outcome {
    alloc::reset_peak();
    let t0 = aps_engine::clock::now_ms();
    let l = Limits::for_profile(opts.profile);

    if problem_text.len() > l.max_input_bytes {
        return error_outcome(
            t0,
            Status::Unsupported,
            None,
            vec![Issue::error(
                codes::LIMIT_MAP,
                "$",
                format!(
                    "问题输入 {} 字节超过档位上限 {} 字节",
                    problem_text.len(),
                    l.max_input_bytes
                ),
            )],
        );
    }
    if problem_text.trim().is_empty() {
        return error_outcome(
            t0,
            Status::InvalidInput,
            None,
            vec![Issue::error(codes::BAD_JSON, "$", "问题为空")],
        );
    }

    let problem_hash = aps_engine::json::parse(problem_text)
        .map(|j| hash::problem_hash_of_canonical(&j.canonical()))
        .unwrap_or_else(|_| "sha256:unparseable".to_string());

    let mut p = match parse_problem(problem_text, opts.profile) {
        Ok(p) => p,
        Err(issues) => {
            let status = if issues.iter().any(|i| i.code.starts_with("E-CAP-")) {
                Status::Unsupported
            } else {
                Status::InvalidInput
            };
            return error_outcome(t0, status, Some(problem_hash), issues);
        }
    };

    // 宿主覆盖（可复现性：覆盖后等同问题内声明）
    if let Some(tl) = opts.time_limit_ms {
        if tl >= 0 {
            p.solver.time_limit_ms = tl;
        }
    }
    if let Some(s) = opts.seed {
        p.solver.seed = s;
    }
    if let Some(a) = &opts.algorithm {
        p.solver.algorithm = a.clone();
    }
    if let Some(pl) = &opts.mapf_planner {
        p.solver.mapf.planner = pl.clone();
    }
    if let Some(w) = opts.mapf_w {
        if (1.0..=3.0).contains(&w) {
            p.solver.mapf.w = w;
        }
    }
    if let Some(tl) = opts.mapf_time_limit_ms {
        if tl >= 0 {
            p.solver.mapf.time_limit_ms = tl;
        }
    }
    if let Some(h) = opts.horizon {
        p.horizon = Some(h);
    }
    if p.solver.time_limit_ms > l.max_budget_ms {
        return error_outcome(
            t0,
            Status::Unsupported,
            Some(problem_hash),
            vec![Issue::error(
                codes::LIMIT_BUDGET,
                "$.solver.time_limit_ms",
                format!(
                    "预算 {} ms 超过档位上限 {} ms",
                    p.solver.time_limit_ms, l.max_budget_ms
                ),
            )],
        );
    }

    // —— 动态展开 ——
    let t_expand = aps_engine::clock::now_ms();
    let (p, dyn_ctx) = match &p.dynamic {
        Some(_) => match dynamic::expand(&p) {
            Ok(e) => {
                let ep = e.p.clone();
                (ep, Some(e))
            }
            Err(issues) => {
                return error_outcome(t0, Status::InvalidInput, Some(problem_hash), issues);
            }
        },
        None => (p, None),
    };
    let expand_ms = (aps_engine::clock::now_ms() - t_expand).max(0.0);

    // —— 调度输入 ——
    let sched_input = match &dyn_ctx {
        Some(e) => SchedInput {
            vehicles: (0..p.vehicles.len())
                .map(|vi| crate::estimate::VehicleInit {
                    pos: e.history[vi][e.time as usize],
                    time: e.time,
                    picked: e.picked[vi].clone(),
                })
                .collect(),
            active: e.active.clone(),
            free: e.free.clone(),
        },
        None => SchedInput::static_new(&p),
    };

    let deadline = if p.solver.time_limit_ms > 0 {
        Some(t0 + p.solver.time_limit_ms as f64)
    } else {
        None
    };

    // —— 调度 ——
    let t_disp0 = aps_engine::clock::now_ms();
    let sr = assign::schedule(
        &p,
        &sched_input,
        &p.solver.algorithm,
        deadline,
        Some(cancel),
    );
    let dispatch_ms = aps_engine::clock::now_ms() - t_disp0;

    // —— 时域 ——
    let mapf_limits = mapf_engine::capabilities::Limits::for_profile(match opts.profile {
        Profile::Native => mapf_engine::capabilities::Profile::Native,
        Profile::WasmLight => mapf_engine::capabilities::Profile::WasmLight,
    });
    let horizon_cap = l.max_horizon.min(mapf_limits.max_horizon);
    let auto_horizon = (sr.est.makespan.saturating_mul(2) + p.map.width + p.map.height + 10)
        .min(horizon_cap)
        .max(10);
    let horizon = match p.horizon {
        Some(h) => {
            if h > horizon_cap {
                return error_outcome(
                    t0,
                    Status::Unsupported,
                    Some(problem_hash),
                    vec![Issue::error(
                        codes::LIMIT_HORIZON,
                        "$.time_model.horizon",
                        format!("时域 {h} 超过档位上限 {horizon_cap}（含 MAPF 段约束）"),
                    )],
                );
            }
            h
        }
        None => auto_horizon,
    };

    // —— 实现（分段联合 MAPF） ——
    let start_time = dyn_ctx.as_ref().map(|e| e.time).unwrap_or(0);
    let queues = integrate::build_queues(&p, &sched_input, &sr.seq);
    let rinput = integrate::RealizeInput {
        start_time,
        pos: sched_input.vehicles.iter().map(|v| v.pos).collect(),
        executed: match &dyn_ctx {
            Some(e) => e.history.clone(),
            None => p.vehicles.iter().map(|v| vec![v.start]).collect(),
        },
        horizon,
        window_walls: dyn_ctx
            .as_ref()
            .map(|e| e.window_walls.clone())
            .unwrap_or_default(),
        removed_walls: dyn_ctx
            .as_ref()
            .map(|e| e.removed_walls.clone())
            .unwrap_or_default(),
        active: sched_input.active.clone(),
        parking: sr.est.parking_assign.clone(),
        deadline_ms: deadline,
        seed_outcomes: dyn_ctx.as_ref().map(|e| e.seed.clone()).unwrap_or_default(),
    };
    let mut r = integrate::realize(&p, &rinput, queues, opts.profile, cancel);
    if let Some(e) = &dyn_ctx {
        r.notes.extend(e.notes.iter().cloned());
    }

    // 未进任何车辆序列的任务如实标注：结构性不可达 > 预算 > 未分配
    let budget_late = deadline.is_some_and(|d| aps_engine::clock::now_ms() >= d);
    for ti in 0..p.tasks.len() {
        let structural = {
            let (cands, unreachable) = assign::feasible_vehicles(&p, ti, &sched_input);
            cands.is_empty() && unreachable
        };
        let o = &mut r.tasks[ti];
        if o.status == "unassigned" && o.reason.is_none() {
            if structural {
                o.status = "leg_infeasible";
                o.reason = Some(codes::TASK_LEG_INFEASIBLE);
            } else if r.budget_exhausted || budget_late {
                o.status = "budget";
                o.reason = Some(codes::TASK_BUDGET);
            } else {
                o.reason = Some(codes::TASK_UNASSIGNED);
            }
        }
    }

    // —— 指标 ——
    let m = metrics::compute(&p, &r);

    // —— 状态判定 ——
    let total = p.tasks.len();
    let completed = r.tasks.iter().filter(|o| o.status == "completed").count();
    let status = if r.cancelled {
        Status::Cancelled
    } else if completed == total {
        Status::Feasible
    } else if completed > 0 {
        Status::Partial
    } else if r
        .tasks
        .iter()
        .all(|o| o.status == "completed" || o.reason == Some(codes::TASK_LEG_INFEASIBLE))
    {
        Status::Infeasible
    } else {
        Status::Unknown
    };

    // —— 解 JSON ——（plan.horizon = 实际完工时刻，≤ 问题声明上界）
    let mut solution = build_solution(
        &p,
        &r,
        &m,
        status,
        &problem_hash,
        opts,
        &sr,
        dispatch_ms,
        start_time,
        r.horizon,
    );

    // —— 动态汇总块（AGV-SRS §4.5：diff 统计 + 展开后语义指纹）——
    if let Some(e) = &dyn_ctx {
        let t0i = e.time as usize;
        // T 之后的实际移动步数（时间线在 T 后逐格推进；驻留不计）
        let moves_after = |tl: &[crate::problem::Cell]| -> i64 {
            tl.iter()
                .skip(t0i + 1)
                .zip(tl.iter().skip(t0i))
                .filter(|(a, b)| a != b)
                .count() as i64
        };
        let planned_moves: i64 = r.timelines.iter().map(|tl| moves_after(tl)).sum();
        // 受影响车辆：T 后有移动 / 新分配任务 / 载货续运
        let affected: Vec<String> = p
            .vehicles
            .iter()
            .enumerate()
            .filter(|(vi, _)| {
                moves_after(&r.timelines[*vi]) > 0
                    || !sr.seq[*vi].is_empty()
                    || !e.picked[*vi].is_empty()
            })
            .map(|(_, v)| v.id.clone())
            .collect();
        let mut d = e.summary.clone();
        d.set("affected_vehicles", Json::strings(affected));
        d.set("planned_moves_after_snapshot", Json::int(planned_moves));
        d.set("semantic_digest", Json::str(expanded_semantic_digest(&p)));
        solution.set("dynamic", d);
        if let Some(m) = solution.get_mut("metrics") {
            m.set(
                "expand_ms",
                Json::Float((expand_ms * 1000.0).round() / 1000.0),
            );
        }
    }

    // —— 独立核验 ——
    let tv = aps_engine::clock::now_ms();
    let report = if opts.verify {
        let text = solution.to_compact();
        verify::verify_solution_json(problem_text, &text, false)
    } else {
        Json::Null
    };
    let verify_ms = aps_engine::clock::now_ms() - tv;
    let verified = opts.verify && verify::report_pass(&report);
    if let Some(m) = solution.get_mut("metrics") {
        m.set(
            "verify_ms",
            Json::Float((verify_ms * 1000.0).round() / 1000.0),
        );
    }
    if !opts.verify {
        solution.set(
            "notes",
            push_note(&solution, "verify=false：本解未运行独立核验"),
        );
    } else if !verified {
        solution.set(
            "notes",
            push_note(
                &solution,
                "独立核验未通过：方案存在违约项（见 verify.checks）",
            ),
        );
    }
    solution.set("verified", Json::Bool(verified));
    solution.set("verify", report);
    if let Some(m) = solution.get_mut("metrics") {
        m.set(
            "total_ms",
            Json::Float((aps_engine::clock::now_ms() - t0).max(0.0)),
        );
    }
    let fp = solution_fingerprint(&solution);
    solution.set("fingerprint", Json::str(fp));

    Outcome {
        status,
        solution_json: solution.to_compact(),
        solution,
    }
}

fn push_note(solution: &Json, note: &str) -> Json {
    let mut notes: Vec<Json> = solution
        .get("notes")
        .and_then(|j| j.as_arr())
        .map(|a| a.to_vec())
        .unwrap_or_default();
    notes.push(Json::str(note));
    Json::Arr(notes)
}

#[allow(clippy::too_many_arguments)]
fn build_solution(
    p: &Problem,
    r: &integrate::Realized,
    m: &metrics::Metrics,
    status: Status,
    problem_hash: &str,
    opts: &SolveOptions,
    sr: &assign::ScheduleResult,
    dispatch_ms: f64,
    start_time: u32,
    horizon: u32,
) -> Json {
    let vehicles: Vec<Json> = p
        .vehicles
        .iter()
        .enumerate()
        .map(|(vi, v)| {
            let timeline: Vec<Json> = r.timelines[vi]
                .iter()
                .map(|&c| {
                    Json::Arr(vec![
                        Json::int(p.map.x_of(c) as i64),
                        Json::int(p.map.y_of(c) as i64),
                    ])
                })
                .collect();
            let missions: Vec<Json> = r.missions[vi]
                .iter()
                .map(|ms| {
                    Json::obj(vec![
                        (
                            "task",
                            ms.task
                                .map(|ti| Json::str(p.tasks[ti].id.as_str()))
                                .unwrap_or(Json::Null),
                        ),
                        ("phase", Json::str(ms.phase)),
                        ("from", Json::int(ms.from as i64)),
                        ("to", Json::int(ms.to as i64)),
                        (
                            "dock",
                            ms.dock
                                .map(|c| {
                                    Json::Arr(vec![
                                        Json::int(p.map.x_of(c) as i64),
                                        Json::int(p.map.y_of(c) as i64),
                                    ])
                                })
                                .unwrap_or(Json::Null),
                        ),
                    ])
                })
                .collect();
            Json::obj(vec![
                ("id", Json::str(v.id.as_str())),
                ("timeline", Json::Arr(timeline)),
                ("missions", Json::Arr(missions)),
            ])
        })
        .collect();
    let tasks: Vec<Json> = p
        .tasks
        .iter()
        .enumerate()
        .map(|(ti, t)| {
            let o = &r.tasks[ti];
            let cell = |c: Option<crate::problem::Cell>| {
                c.map(|c| {
                    Json::Arr(vec![
                        Json::int(p.map.x_of(c) as i64),
                        Json::int(p.map.y_of(c) as i64),
                    ])
                })
                .unwrap_or(Json::Null)
            };
            let flow = o
                .dropoff_done
                .map(|d| (d.saturating_sub(t.release_step)) as i64);
            let lateness = match (o.dropoff_done, t.due_step) {
                (Some(d), Some(due)) => Some((d.saturating_sub(due)) as i64),
                _ => None,
            };
            Json::obj(vec![
                ("id", Json::str(t.id.as_str())),
                ("status", Json::str(o.status)),
                (
                    "vehicle",
                    o.vehicle
                        .map(|vi| Json::str(p.vehicles[vi].id.as_str()))
                        .unwrap_or(Json::Null),
                ),
                ("pickup_dock", cell(o.pickup_dock)),
                ("dropoff_dock", cell(o.dropoff_dock)),
                (
                    "pickup_arrival",
                    Json::opt_int(o.pickup_arrival.map(|x| x as i64)),
                ),
                (
                    "pickup_done",
                    Json::opt_int(o.pickup_done.map(|x| x as i64)),
                ),
                (
                    "dropoff_arrival",
                    Json::opt_int(o.dropoff_arrival.map(|x| x as i64)),
                ),
                (
                    "dropoff_done",
                    Json::opt_int(o.dropoff_done.map(|x| x as i64)),
                ),
                ("flow_time", Json::opt_int(flow)),
                ("lateness", Json::opt_int(lateness)),
                ("reason", Json::opt_str(o.reason)),
            ])
        })
        .collect();
    let plan = Json::obj(vec![
        ("start_step", Json::int(start_time as i64)),
        ("horizon", Json::int(horizon as i64)),
        ("vehicles", Json::Arr(vehicles)),
        ("tasks", Json::Arr(tasks)),
    ]);
    let search = Json::obj(vec![
        ("algorithm", Json::str(sr.algorithm.as_str())),
        ("evaluations", Json::int(sr.evaluations as i64)),
        ("moves_accepted", Json::int(sr.moves_accepted as i64)),
        (
            "initial_cost",
            Json::Float((sr.initial_cost * 1e6).round() / 1e6),
        ),
        (
            "final_cost",
            Json::Float((sr.final_cost * 1e6).round() / 1e6),
        ),
        ("mapf_solves", Json::int(r.mapf_solves as i64)),
        ("mapf_planner", Json::str(p.solver.mapf.planner.as_str())),
        ("suboptimality_factor", Json::Float(p.solver.mapf.w)),
        ("deterministic", Json::Bool(true)),
    ]);
    let id = opts.solution_id.clone().unwrap_or_else(|| {
        let core = problem_hash.strip_prefix("sha256:").unwrap_or("solution");
        let short: String = core.chars().take(12).collect();
        format!("agv-sol-{short}")
    });
    Json::obj(vec![
        ("schema_version", Json::str(SCHEMA_VERSION_SOLUTION)),
        ("id", Json::str(id)),
        ("problem_id", Json::opt_str(p.id.clone())),
        ("problem_hash", Json::str(problem_hash)),
        ("engine", Json::str(crate::ENGINE_NAME)),
        ("engine_version", Json::str(crate::ENGINE_VERSION)),
        ("compiler_version", Json::str(crate::COMPILER_VERSION)),
        (
            "mapf_engine_version",
            Json::str(mapf_engine::ENGINE_VERSION),
        ),
        ("ruleset_version", Json::str(crate::RULESET_VERSION)),
        ("capability_profile", Json::str(opts.profile.as_str())),
        ("status", Json::str(status.as_str())),
        ("verified", Json::Bool(false)), // 核验后回填
        ("plan", plan),
        (
            "metrics",
            metrics::to_json(m, dispatch_ms, r.mapf_ms, 0.0, 0.0),
        ),
        ("search", search),
        ("verify", Json::Null), // 核验后回填
        ("errors", Json::Arr(vec![])),
        ("notes", Json::strings(r.notes.iter().cloned())),
    ])
}

/// 展开后问题的语义指纹：动态块事件**应用后**的静态等价语义（地图 + 车辆
/// 状态 + 任务表 + 工作站 + 停车 + 目标权重）规范化 sha256。
///
/// 用途：实验室比较两次动态重调度是否面对同一有效问题（与原始输入的
/// `problem_hash` 互补：后者标识「基础问题 + 事件流」的书写形式）。
/// 不含 id/tags/solver 参数（运行选项，非语义）。
pub fn expanded_semantic_digest(p: &Problem) -> String {
    let blocked: Vec<Json> = (0..p.map.n_cells())
        .filter(|&i| p.map.blocked[i])
        .map(|i| Json::int(i as i64))
        .collect();
    let loc = |l: &crate::problem::TaskLoc| match l {
        crate::problem::TaskLoc::Cell(c) => Json::int(*c as i64),
        crate::problem::TaskLoc::Station(i) => Json::str(format!("station:{}", p.stations[*i].id)),
    };
    let vehicles: Vec<Json> = p
        .vehicles
        .iter()
        .map(|v| {
            let mut caps = v.capabilities.clone();
            caps.sort();
            Json::obj(vec![
                ("id", Json::str(v.id.as_str())),
                ("start", Json::int(v.start as i64)),
                ("paused", Json::Bool(v.paused)),
                ("capabilities", Json::strings(caps)),
            ])
        })
        .collect();
    let tasks: Vec<Json> = p
        .tasks
        .iter()
        .map(|t| {
            Json::obj(vec![
                ("id", Json::str(t.id.as_str())),
                ("pickup", loc(&t.pickup)),
                ("dropoff", loc(&t.dropoff)),
                ("priority", Json::int(t.priority as i64)),
                ("release", Json::int(t.release_step as i64)),
                ("due", Json::opt_int(t.due_step.map(|x| x as i64))),
                ("pickup_service", Json::int(t.pickup_service as i64)),
                ("dropoff_service", Json::int(t.dropoff_service as i64)),
                (
                    "required_capability",
                    Json::opt_str(t.required_capability.clone()),
                ),
            ])
        })
        .collect();
    let stations: Vec<Json> = p
        .stations
        .iter()
        .map(|s| {
            Json::obj(vec![
                ("id", Json::str(s.id.as_str())),
                (
                    "cells",
                    Json::Arr(s.cells.iter().map(|&c| Json::int(c as i64)).collect()),
                ),
                ("capacity", Json::int(s.capacity as i64)),
            ])
        })
        .collect();
    let mut parking: Vec<i64> = p.parking.iter().map(|&c| c as i64).collect();
    parking.sort();
    let j = Json::obj(vec![
        (
            "map",
            Json::obj(vec![
                ("width", Json::int(p.map.width as i64)),
                ("height", Json::int(p.map.height as i64)),
                ("walls", Json::Arr(blocked)),
            ]),
        ),
        ("horizon", Json::opt_int(p.horizon.map(|x| x as i64))),
        ("vehicles", Json::Arr(vehicles)),
        ("tasks", Json::Arr(tasks)),
        ("stations", Json::Arr(stations)),
        (
            "parking",
            Json::Arr(parking.into_iter().map(Json::int).collect()),
        ),
        (
            "weights",
            Json::obj(vec![
                ("makespan", Json::Float(p.weights.makespan)),
                ("flow_time", Json::Float(p.weights.flow_time)),
                ("empty_travel", Json::Float(p.weights.empty_travel)),
                ("lateness", Json::Float(p.weights.lateness)),
            ]),
        ),
    ]);
    hash::problem_hash_of_canonical(&j.canonical())
}

/// 方案指纹：去运行期字段后的规范化 sha256（同输入同参数同版本 ⇒ 恒定）。
pub fn solution_fingerprint(solution: &Json) -> String {
    let mut cloned = solution.clone();
    if let Json::Obj(fields) = &mut cloned {
        fields.retain(|(k, _)| {
            !matches!(
                k.as_str(),
                "metrics"
                    | "search"
                    | "id"
                    | "verify"
                    | "notes"
                    | "engine"
                    | "engine_version"
                    | "compiler_version"
                    | "mapf_engine_version"
                    | "verified"
            )
        });
    }
    format!("sha256:{}", hash::sha256_hex(cloned.canonical().as_bytes()))
}

fn error_outcome(
    t0: f64,
    status: Status,
    problem_hash: Option<String>,
    issues: Vec<Issue>,
) -> Outcome {
    let _ = t0;
    let empty_plan = Json::obj(vec![
        ("start_step", Json::int(0)),
        ("horizon", Json::int(0)),
        ("vehicles", Json::Arr(vec![])),
        ("tasks", Json::Arr(vec![])),
    ]);
    let solution = Json::obj(vec![
        ("schema_version", Json::str(SCHEMA_VERSION_SOLUTION)),
        ("id", Json::str("agv-sol-error")),
        ("problem_hash", Json::opt_str(problem_hash)),
        ("engine", Json::str(crate::ENGINE_NAME)),
        ("engine_version", Json::str(crate::ENGINE_VERSION)),
        ("compiler_version", Json::str(crate::COMPILER_VERSION)),
        (
            "mapf_engine_version",
            Json::str(mapf_engine::ENGINE_VERSION),
        ),
        ("ruleset_version", Json::str(crate::RULESET_VERSION)),
        ("status", Json::str(status.as_str())),
        ("verified", Json::Bool(false)),
        ("plan", empty_plan),
        (
            "errors",
            Json::Arr(issues.iter().map(|i| i.to_json()).collect()),
        ),
        ("notes", Json::Arr(vec![])),
    ]);
    Outcome {
        status,
        solution_json: solution.to_compact(),
        solution,
    }
}

/// 独立核验（CLI / wasm 共用）。
pub fn verify_solution_json(problem_text: &str, solution_text: &str, strict: bool) -> Json {
    verify::verify_solution_json(problem_text, solution_text, strict)
}

/// 能力报告。
pub fn capabilities_report(profile: Profile) -> Json {
    capabilities::report(profile)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solve(text: &str) -> Outcome {
        let cancel = CancelToken::new();
        solve_json(text, &SolveOptions::default(), &cancel)
    }

    #[test]
    fn single_task_solves_and_verifies() {
        let text = r#"{
            "map": { "cells": ["......", "......", "......"] },
            "time_model": { "horizon": 60 },
            "vehicles": [ { "id": "V1", "start": [0,0] } ],
            "tasks": [ { "id": "T1", "pickup": [4,0], "dropoff": [1,2] } ]
        }"#;
        let out = solve(text);
        assert_eq!(out.status, Status::Feasible, "{}", out.solution_json);
        assert_eq!(
            out.solution.get("verified").and_then(|j| j.as_bool()),
            Some(true),
            "{}",
            out.solution_json
        );
        assert_eq!(
            out.solution
                .get("plan")
                .and_then(|p| p.get("tasks"))
                .and_then(|t| t.as_arr())
                .and_then(|a| a.first())
                .and_then(|t| t.get("status"))
                .and_then(|s| s.as_str()),
            Some("completed")
        );
    }

    #[test]
    fn determinism_same_fingerprint() {
        let text = r#"{
            "map": { "cells": ["........", "........", "........"] },
            "time_model": { "horizon": 80 },
            "vehicles": [ { "id": "A", "start": [0,0] }, { "id": "B", "start": [7,2] } ],
            "tasks": [
                { "id": "T1", "pickup": [6,0], "dropoff": [1,2] },
                { "id": "T2", "pickup": [2,0], "dropoff": [7,1] }
            ]
        }"#;
        let a = solve(text);
        let b = solve(text);
        assert_eq!(a.status, Status::Feasible, "{}", a.solution_json);
        let fa = a.solution.get("fingerprint").and_then(|j| j.as_str());
        let fb = b.solution.get("fingerprint").and_then(|j| j.as_str());
        assert_eq!(fa, fb, "同输入必须同指纹");
    }

    #[test]
    fn invalid_input_reports_issues() {
        let text = r#"{ "map": { "cells": ["..."] }, "vehicles": [], "tasks": [] }"#;
        let out = solve(text);
        assert_eq!(out.status, Status::InvalidInput);
        assert!(out
            .solution
            .get("errors")
            .and_then(|j| j.as_arr())
            .is_some_and(|a| !a.is_empty()));
    }

    #[test]
    fn capability_mismatch_is_partial() {
        let text = r#"{
            "map": { "cells": ["......", "......"] },
            "time_model": { "horizon": 60 },
            "vehicles": [ { "id": "V1", "start": [0,0], "capabilities": ["lift"] } ],
            "tasks": [ { "id": "T1", "pickup": [3,0], "dropoff": [1,1], "required_capability": "forklift" } ]
        }"#;
        let out = solve(text);
        assert_eq!(out.status, Status::Infeasible, "{}", out.solution_json);
        let reason = out
            .solution
            .get("plan")
            .and_then(|p| p.get("tasks"))
            .and_then(|t| t.as_arr())
            .and_then(|a| a.first())
            .and_then(|t| t.get("reason"))
            .and_then(|r| r.as_str())
            .unwrap_or("");
        assert_eq!(reason, "E-AGV-TASK-LEG-INFEASIBLE");
    }

    #[test]
    fn tight_budget_is_honest() {
        let text = r#"{
            "map": { "cells": ["............", "............", "............", "............"] },
            "time_model": { "horizon": 200 },
            "vehicles": [ { "id": "V1", "start": [0,0] } ],
            "tasks": [ { "id": "T1", "pickup": [11,3], "dropoff": [0,3] } ],
            "solver": { "time_limit_ms": 1 }
        }"#;
        let out = solve(text);
        // 1ms 也可能足够；诚实性要求：状态不得谎报 FEASIBLE 而未完成
        if out.status != Status::Feasible {
            assert!(matches!(out.status, Status::Unknown | Status::Partial));
        }
    }

    #[test]
    fn dynamic_summary_block_and_semantic_digest() {
        let base = crate::acceptance::make_problem(
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
        assert_eq!(first.status, Status::Feasible, "{}", first.solution_json);
        // 静态解不带 dynamic 汇总块
        assert!(first
            .solution
            .get("dynamic")
            .map(|j| j.is_null())
            .unwrap_or(true));

        // t=3 追加 T3-new
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
        let dyn_p = crate::acceptance::snapshot_at(&base, &first.solution, 3, events);
        let a = solve(&dyn_p);
        assert_eq!(a.status, Status::Feasible, "{}", a.solution_json);

        let d = a.solution.get("dynamic").expect("dynamic 汇总块");
        assert_eq!(d.get("snapshot_time").and_then(|j| j.as_i64()), Some(3));
        assert_eq!(d.get("replan_from").and_then(|j| j.as_i64()), Some(3));
        let ev = d.get("events").expect("events 统计");
        assert_eq!(ev.get("total").and_then(|j| j.as_i64()), Some(1));
        assert_eq!(ev.get("task_add").and_then(|j| j.as_i64()), Some(1));
        assert_eq!(
            d.get("tasks_added")
                .and_then(|j| j.as_arr())
                .and_then(|a| a.first())
                .and_then(|j| j.as_str()),
            Some("T3-new")
        );
        assert_eq!(
            d.get("completed_at_snapshot")
                .and_then(|j| j.as_arr())
                .map(|a| a.len()),
            Some(0)
        );
        let digest = d
            .get("semantic_digest")
            .and_then(|j| j.as_str())
            .expect("semantic_digest")
            .to_string();
        assert!(digest.starts_with("sha256:"), "{digest}");
        assert!(
            !d.get("affected_vehicles")
                .and_then(|j| j.as_arr())
                .map(|a| a.is_empty())
                .unwrap_or(true),
            "重调度后应有受影响车辆"
        );
        assert!(
            d.get("planned_moves_after_snapshot")
                .and_then(|j| j.as_i64())
                .unwrap_or(0)
                > 0,
            "T 之后应有计划移动"
        );
        assert!(a
            .solution
            .get("metrics")
            .and_then(|m| m.get("expand_ms"))
            .is_some());

        // 确定性：两次求解 → digest 与方案指纹恒定
        let b = solve(&dyn_p);
        let d2 = b.solution.get("dynamic").expect("dynamic 汇总块");
        assert_eq!(
            d2.get("semantic_digest").and_then(|j| j.as_str()),
            Some(digest.as_str()),
            "同输入展开后语义指纹应一致"
        );
        assert_eq!(
            a.solution.get("fingerprint").and_then(|j| j.as_str()),
            b.solution.get("fingerprint").and_then(|j| j.as_str()),
            "动态解方案指纹应确定"
        );
    }
}
