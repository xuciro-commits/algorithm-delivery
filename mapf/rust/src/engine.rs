//! 求解流水线：`parse → gate(能力) → compile(动态) → ECBS → 融合 → 独立核验 → MapfSolution`。
//!
//! 状态映射（严格对齐 `docs/MODEL-MATH.md` §6 的资格规则）：
//!
//! | 情形 | 状态 | 备注 |
//! |------|------|------|
//! | JSON/契约/语义非法 | `INVALID_INPUT` | 字段级定位 |
//! | 触碰声明能力外特性 / 超规模 | `UNSUPPORTED` | 拒绝而非静默忽略 |
//! | 穷尽 + 有解 + 证明（LB ≥ UB） | `OPTIMAL` | `optimality_proven=true` |
//! | 穷尽 + 有解 + w>1（UB ≤ w·LB 但 LB < UB） | `FEASIBLE` | 报告 gap 上界 |
//! | 预算耗尽 + 有解 | `FEASIBLE` | 下界 = 当时 open.min |
//! | 声明时域内穷尽 + 无解 | `INFEASIBLE` | 证明仅覆盖声明时域 |
//! | 自动时域穷尽 + 无解（升级尝试后仍无） | `UNKNOWN` | 自动时域无 INFEASIBLE 资格 |
//! | 预算耗尽 + 无解 | `UNKNOWN` | **超时 ≠ 无解** |
//! | 主动取消 | `CANCELLED` | 在途方案一并返回并标注 |
//! | 引擎自检被独立核验器拒绝 | `UNKNOWN` + `verified=false` | 宁可拒收也不放行 |

use std::collections::VecDeque;

use aps_engine::engine::CancelToken;
use aps_engine::json::Json;
use aps_engine::{alloc, clock, hash};

use crate::capabilities::{self, Profile};
use crate::dynamic;
use crate::ecbs::{self, Finish, Instance};
use crate::errors::{codes, Issue, Status};
use crate::problem::{self, Objective, PlannerKind, Problem};
use crate::verify;

/// 宿主级求解选项（可覆盖问题内 `solver` 块，用于实验室参数面板 / CLI flag）。
#[derive(Debug, Clone, Default)]
pub struct SolveOptions {
    pub profile: Profile,
    /// 求解成功后自动跑独立核验器并内嵌报告（默认 true）。
    pub verify: bool,
    pub solution_id: Option<String>,
    pub time_limit_ms: Option<i64>,
    pub seed: Option<u64>,
    pub w: Option<f64>,
    pub planner: Option<PlannerKind>,
    pub objective: Option<Objective>,
}

/// 求解结局：状态 + 方案 JSON 文本 + 方案对象。
pub struct Outcome {
    pub status: Status,
    pub solution_json: String,
    pub solution: Json,
}

/// 入口：问题 JSON 文本 → 方案 JSON 文本。
pub fn solve_json(problem_text: &str, opts: &SolveOptions, cancel: &CancelToken) -> Outcome {
    alloc::reset_peak();
    let t0 = clock::now_ms();
    let l = capabilities::Limits::for_profile(opts.profile);
    if problem_text.len() > l.max_input_bytes {
        return error_outcome(
            t0,
            Status::Unsupported,
            opts,
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
    let root: Json = match aps_engine::json::parse(problem_text) {
        Ok(j) => j,
        Err(e) => {
            return error_outcome(
                t0,
                Status::InvalidInput,
                opts,
                None,
                vec![Issue::error(codes::BAD_JSON, "$", e.to_string())],
            )
        }
    };
    let problem_hash = hash::problem_hash_of_canonical(&root.canonical());
    match problem::parse_problem(problem_text, opts.profile) {
        Ok(mut p) => {
            apply_overrides(&mut p, opts);
            if let Err(v) = gate(&p, opts.profile) {
                return error_outcome(t0, Status::Unsupported, opts, Some(problem_hash), v);
            }
            run_pipeline(p, opts, cancel, &root, problem_hash, t0)
        }
        Err(f) => error_outcome(
            t0,
            if f.unsupported {
                Status::Unsupported
            } else {
                Status::InvalidInput
            },
            opts,
            Some(problem_hash),
            f.issues,
        ),
    }
}

fn apply_overrides(p: &mut Problem, opts: &SolveOptions) {
    if let Some(t) = opts.time_limit_ms {
        p.solver.time_limit_ms = t;
    }
    if let Some(s) = opts.seed {
        p.solver.seed = s;
    }
    if let Some(w) = opts.w {
        p.solver.w = w;
    }
    if let Some(pl) = opts.planner {
        p.solver.planner = pl;
    }
    if let Some(o) = opts.objective {
        p.objective = o;
    }
}

fn gate(p: &Problem, profile: Profile) -> Result<(), Vec<Issue>> {
    let res = capabilities::gate(
        profile,
        p.robots.len(),
        p.map.n_cells(),
        p.map.width.max(p.map.height),
        p.horizon,
        p.solver.time_limit_ms,
        p.dynamic.as_ref().map(|d| d.events.len()).unwrap_or(0),
    );
    res.map_err(|(code, msg)| vec![Issue::error(code, "$", msg)])
}

#[allow(clippy::too_many_arguments)]
fn run_pipeline(
    mut p: Problem,
    opts: &SolveOptions,
    cancel: &CancelToken,
    root: &Json,
    problem_hash: String,
    t0: f64,
) -> Outcome {
    let is_dynamic = p.dynamic.is_some();
    let mut notes: Vec<String> = Vec::new();
    let mut errors: Vec<Issue> = Vec::new();

    let compiled = if is_dynamic {
        match dynamic::compile(&p) {
            Ok(c) => Some(c),
            Err(mut iss) => {
                errors.append(&mut iss);
                return error_outcome(t0, Status::InvalidInput, opts, Some(problem_hash), errors);
            }
        }
    } else {
        None
    };
    let compile_ms = clock::now_ms() - t0;

    // 静态不可达直判（无动态块时与时域无关；对动态场景跳过，交由时域语义处理）
    let mut static_infeasible = false;
    if !is_dynamic {
        for i in 0..p.robots.len() {
            if !bfs_reachable(&p, p.robots[i].start, p.robots[i].goal) {
                static_infeasible = true;
                notes.push(format!(
                    "机器人 `{}` 起点到终点在地图连通性上不连通（与时域无关的不可行证明）",
                    p.robots[i].id
                ));
                break;
            }
        }
    }

    let start_solve = clock::now_ms();
    let deadline = start_solve + p.solver.time_limit_ms.max(1) as f64;
    let blocked = p.blocked_windows();
    let free_win = p.free_windows_of_blocked();
    let goals = problem::effective_goals(&p);
    let prefixes: Vec<Vec<u32>> = match &compiled {
        Some(c) => c.prefixes.clone(),
        None => p.robots.iter().map(|r| vec![r.start]).collect(),
    };

    let mut attempt = 0usize;
    let mut horizon_used = p.horizon;
    let last: ecbs::EcbsResult;
    loop {
        attempt += 1;
        let inst = Instance::new(
            &p.map,
            &blocked,
            &free_win,
            p.robots.len(),
            prefixes.clone(),
            goals.clone(),
            horizon_used,
            p.objective,
        );
        let r = ecbs::solve(
            &inst,
            p.solver.w,
            deadline,
            p.solver.max_expansions,
            &Some(cancel.raw()),
            p.solver.seed,
            p.solver.warm_start,
            p.solver.planner,
        );
        let exhausted_no_solution = r.solution.is_none() && matches!(r.finish, Finish::Exhausted);
        if exhausted_no_solution && p.solver.horizon_auto && attempt < 3 {
            let next = (horizon_used.saturating_mul(2))
                .min(capabilities::Limits::for_profile(opts.profile).max_horizon);
            if next > horizon_used && clock::now_ms() < deadline {
                notes.push(format!(
                    "自动时域 {horizon_used} 内穷尽无解 ⇒ 升级至 {next} 重试（升级次数上限 3）"
                ));
                horizon_used = next;
                // 循环继续前 r 被丢弃
                let _ = r;
                continue;
            }
        }
        last = r;
        break;
    }
    let solve_end = clock::now_ms();

    // —— 状态与目标值 ——
    let mut status = match &last.solution {
        Some(_) => {
            if last.proven_optimal {
                Status::Optimal
            } else {
                Status::Feasible
            }
        }
        None => {
            if static_infeasible {
                Status::Infeasible
            } else if matches!(last.finish, Finish::Exhausted) {
                if p.solver.horizon_auto {
                    notes.push("自动时域内穷尽：不宣告 INFEASIBLE（缺时域证明资格）。请显式声明更大时域重试".to_string());
                    Status::Unknown
                } else {
                    Status::Infeasible
                }
            } else if matches!(last.finish, Finish::Cancelled) {
                Status::Cancelled
            } else {
                Status::Unknown
            }
        }
    };
    // 取消：即使带回在途方案也保持 CANCELLED（不冒领正式可行状态）
    if matches!(last.finish, Finish::Cancelled) {
        if last.solution.is_some() {
            notes
                .push("取消时携带在途方案：已通过核验可执行，但状态如实标记 CANCELLED".to_string());
        }
        status = Status::Cancelled;
    }

    let (soc, makespan, paths_json) = match &last.solution {
        Some(paths) => {
            let mut soc = 0i64;
            let mut mk = 0u32;
            let mut pj: Vec<Json> = Vec::with_capacity(paths.len());
            for (i, ap) in paths.iter().enumerate() {
                soc += ap.arrival as i64;
                mk = mk.max(ap.arrival);
                let cells: Vec<Json> = ap
                    .cells
                    .iter()
                    .take(ap.arrival as usize + 1)
                    .map(|&c| coord(p.map.x_of(c), p.map.y_of(c)))
                    .collect();
                pj.push(Json::obj(vec![
                    ("id", Json::str(p.robots[i].id.clone())),
                    (
                        "start",
                        coord(p.map.x_of(p.robots[i].start), p.map.y_of(p.robots[i].start)),
                    ),
                    ("goal", coord(p.map.x_of(ap.goal), p.map.y_of(ap.goal))),
                    ("arrival", Json::int(ap.arrival as i64)),
                    ("steps", Json::int(ap.arrival as i64)),
                    ("path", Json::Arr(cells)),
                    ("locked", Json::Bool(ap.locked)),
                ]));
            }
            (soc, mk, Json::Arr(pj))
        }
        None => (0, 0, Json::Arr(Vec::new())),
    };

    // —— 动态指标 ——
    let dyn_metrics_json = compiled.as_ref().map(|c| {
        let cells_only: Vec<Vec<u32>> = match &last.solution {
            Some(paths) => paths.iter().map(|ap| ap.cells.clone()).collect(),
            None => Vec::new(),
        };
        let mut m = if cells_only.is_empty() {
            dynamic::ReplanMetrics {
                affected_agents: 0,
                path_change_steps: 0,
                frozen_covered: *c.frozen_end.iter().max().unwrap_or(&0),
            }
        } else {
            dynamic::diff_metrics(&p, &cells_only, &c.frozen_end)
        };
        if m.frozen_covered == 0 {
            m.frozen_covered = *c.frozen_end.iter().max().unwrap_or(&0);
        }
        let evs: Vec<Json> = p
            .dynamic
            .as_ref()
            .map(|d| d.events.iter().map(|e| event_json(e, &p.map)).collect())
            .unwrap_or_default();
        Json::obj(vec![
            (
                "snapshot_time",
                Json::int(p.dynamic.as_ref().map(|d| d.time as i64).unwrap_or(0)),
            ),
            ("events_applied", Json::Arr(evs)),
            ("frozen_prefix_covered", Json::int(m.frozen_covered as i64)),
            ("affected_agents", Json::int(m.affected_agents as i64)),
            ("path_change_steps", Json::int(m.path_change_steps as i64)),
            (
                "forced_agents",
                Json::int(c.forced.iter().filter(|x| **x).count() as i64),
            ),
            (
                "replan_ms",
                Json::Float(((solve_end - start_solve).max(0.0) * 1000.0).round() / 1000.0),
            ),
            ("replan", Json::Bool(true)),
        ])
    });

    let mut solution = build_solution(
        &p,
        opts,
        &problem_hash,
        status,
        (soc, makespan as i64),
        &paths_json,
        &last,
        horizon_used,
        &mut notes,
        &errors,
        dyn_metrics_json,
        (
            compile_ms,
            solve_end - start_solve,
            last.first_solution_ms,
            t0,
        ),
    );

    // —— 独立核验（与求解器解耦的 verify.rs；成功方案必检） ——
    if status.has_plan() {
        let tv = clock::now_ms();
        let report = if opts.verify {
            let solution_parsed =
                aps_engine::json::parse(&solution.to_compact()).unwrap_or(Json::Null);
            Some(verify::verify_json(root, &solution_parsed, false))
        } else {
            None
        };
        let verify_ms = (clock::now_ms() - tv).max(0.0);
        match &report {
            Some(rep) => {
                solution.set(
                    "verify",
                    Json::obj(vec![
                        ("ok", Json::Bool(rep.ok)),
                        ("violations_total", Json::int(rep.violations.len() as i64)),
                        (
                            "violations_sample",
                            Json::Arr(
                                rep.violations
                                    .iter()
                                    .take(12)
                                    .map(|v| v.to_json())
                                    .collect(),
                            ),
                        ),
                        (
                            "checks",
                            Json::Arr(
                                rep.checks
                                    .iter()
                                    .map(|(n, ok)| {
                                        Json::obj(vec![
                                            ("name", Json::str(*n)),
                                            ("ok", Json::Bool(*ok)),
                                        ])
                                    })
                                    .collect(),
                            ),
                        ),
                    ]),
                );
                solution.set("verified", Json::Bool(rep.ok));
                if !rep.ok {
                    // 阻断性缺陷防线：宁可降级也不放行碰撞方案
                    status = Status::Unknown;
                    notes.push(format!(
                        "引擎自检发现输出未通过独立核验（{} 条违规），状态降级为 UNKNOWN",
                        rep.violations.len()
                    ));
                    solution.set("status", Json::str(status.as_str()));
                    solution.set("optimality_proven", Json::Bool(false));
                    solution.set("soc", Json::Null);
                    solution.set("makespan", Json::Null);
                    if let Some(Json::Obj(o)) = solution.get_mut("objective") {
                        o.retain(|(k, _)| k != "value");
                        o.push(("note".to_string(), Json::str("因自检失败移除目标声明值")));
                    }
                }
            }
            None => {
                solution.set("verified", Json::Bool(false));
                solution.set("verify", Json::Null);
            }
        }
        set_metric(&mut solution, "verify_ms", verify_ms);
    } else {
        solution.set("verified", Json::Bool(false));
        if let Some(Json::Obj(fields)) = solution.get_mut("metrics") {
            fields.retain(|(k, _)| k != "verify_ms");
        }
        solution.set("verify", Json::Null);
    }

    // —— 语义结果指纹（与运行期 metrics/search/notes 无关的规范化核心摘要） ——
    set_metric_f64(&mut solution, "total_ms", (clock::now_ms() - t0).max(0.0));
    let fp = semantic_digest(&solution);
    solution.set("semantic_digest", Json::str(fp));

    Outcome {
        status,
        solution_json: solution.to_compact(),
        solution,
    }
}

fn set_metric(solution: &mut Json, key: &str, ms_value: f64) {
    if let Some(Json::Obj(fields)) = solution.get_mut("metrics") {
        fields.retain(|(k, _)| k != key);
        if let Some(pos) = fields
            .iter()
            .position(|(k, _)| k == "time_metrics_available")
        {
            fields.insert(
                pos,
                (
                    key.to_string(),
                    Json::Float((ms_value * 1000.0).round() / 1000.0),
                ),
            );
        } else {
            fields.push((
                key.to_string(),
                Json::Float((ms_value * 1000.0).round() / 1000.0),
            ));
        }
    }
}

fn set_metric_f64(solution: &mut Json, key: &str, v: f64) {
    set_metric(solution, key, v);
}

#[allow(clippy::too_many_arguments)]
fn build_solution(
    p: &Problem,
    opts: &SolveOptions,
    problem_hash: &str,
    status: Status,
    (soc, makespan): (i64, i64),
    paths_json: &Json,
    last: &ecbs::EcbsResult,
    horizon_used: u32,
    notes: &mut Vec<String>,
    errors: &[Issue],
    dyn_json: Option<Json>,
    timings: (f64, f64, Option<f64>, f64),
) -> Json {
    let (compile_ms, solve_ms, first_ms, t0) = timings;
    let solved = status.has_plan();
    let objective_value = match p.objective {
        Objective::Soc => soc,
        Objective::Makespan => makespan,
    };
    // 下界：有解时不得超过解值；无解时为搜索给出的最好下界。
    let lb = if solved {
        last.lower_bound.min(objective_value).max(0)
    } else {
        last.lower_bound.max(0)
    };
    let gap = if solved && lb > 0 {
        (objective_value as f64) / (lb as f64)
    } else if solved {
        1.0
    } else {
        f64::NAN
    };
    let solution_id = opts
        .solution_id
        .clone()
        .unwrap_or_else(|| format!("mapf-sol-{}-{}", &problem_hash[7..23], p.solver.seed));
    let metrics = Json::obj(vec![
        ("compile_ms", ms(compile_ms)),
        (
            "first_feasible_ms",
            match first_ms {
                Some(f) => ms(f),
                None => Json::Null,
            },
        ),
        ("solve_ms", ms(solve_ms)),
        ("verify_ms", Json::Null),
        ("total_ms", ms((clock::now_ms() - t0).max(0.0))),
        ("peak_memory_bytes", Json::int(alloc::peak_bytes() as i64)),
        (
            "time_metrics_available",
            Json::Bool(clock::TIME_METRICS_AVAILABLE),
        ),
    ]);
    let search = Json::obj(vec![
        ("hl_expansions", Json::int(last.stats.hl_expansions as i64)),
        ("hl_generated", Json::int(last.stats.hl_generated as i64)),
        ("ll_expansions", Json::int(last.stats.ll_expansions as i64)),
        ("ll_generated", Json::int(last.stats.ll_generated as i64)),
        (
            "conflicts_checked",
            Json::int(last.stats.conflicts_checked as i64),
        ),
        (
            "finish",
            Json::str(match last.finish {
                Finish::Exhausted => "exhausted",
                Finish::Budget => "budget",
                Finish::Pruned => "pruned-lowlevel",
                Finish::Cancelled => "cancelled",
            }),
        ),
        (
            "warm_start",
            Json::str(if p.solver.warm_start {
                if last.stats.pp_succeeded {
                    "pp"
                } else {
                    "pp-failed"
                }
            } else {
                "none"
            }),
        ),
        ("horizon_used", Json::int(horizon_used as i64)),
        (
            "horizon_source",
            Json::str(if p.solver.horizon_auto {
                "auto"
            } else {
                "declared"
            }),
        ),
        ("root_lower_bound", Json::int(last.root_lb.max(0))),
        ("search_lower_bound", Json::int(lb)),
        ("bound_w", Json::Float(p.solver.w)),
        (
            "planner",
            Json::str(match p.solver.planner {
                PlannerKind::Auto => "auto",
                PlannerKind::Ecbs => "ecbs",
                PlannerKind::Pp => "pp",
            }),
        ),
    ]);
    let mut obj: Vec<(String, Json)> = Vec::new();
    let mut add = |k: &str, v: Json, obj: &mut Vec<(String, Json)>| obj.push((k.to_string(), v));
    add(
        "schema_version",
        Json::str(crate::errors::SCHEMA_VERSION_SOLUTION),
        &mut obj,
    );
    add("id", Json::str(solution_id), &mut obj);
    add("problem_hash", Json::str(problem_hash), &mut obj);
    add("engine", Json::str(crate::ENGINE_NAME), &mut obj);
    add("engine_version", Json::str(crate::ENGINE_VERSION), &mut obj);
    add(
        "compiler_version",
        Json::str(crate::COMPILER_VERSION),
        &mut obj,
    );
    add(
        "ruleset_version",
        Json::str(crate::RULESET_VERSION),
        &mut obj,
    );
    add(
        "capability_profile",
        Json::str(opts.profile.as_str()),
        &mut obj,
    );
    add("problem_id", Json::str(p.id.clone()), &mut obj);
    add("status", Json::str(status.as_str()), &mut obj);
    add(
        "optimality_proven",
        Json::Bool(last.proven_optimal && solved),
        &mut obj,
    );
    add("verified", Json::Bool(false), &mut obj); // 由 run_pipeline 覆盖
    add(
        "objective",
        Json::obj(vec![
            ("kind", Json::str(p.objective.as_str())),
            ("direction", Json::str("min")),
            (
                "value",
                if solved {
                    Json::int(objective_value)
                } else {
                    Json::Null
                },
            ),
            ("lower_bound", Json::int(lb)),
            (
                "gap",
                if solved && gap.is_finite() {
                    Json::Float((gap * 1e6).round() / 1e6)
                } else {
                    Json::Null
                },
            ),
            ("suboptimality_factor", Json::Float(p.solver.w)),
            (
                "bound_note",
                Json::str(if !solved {
                    "无可行解：不声明目标值"
                } else if last.proven_optimal {
                    "LB 追平 UB：已证明最优"
                } else if p.solver.w > 1.0 {
                    "有界次优：value / lower_bound ≤ w"
                } else {
                    "预算/扩展上限内未证明最优"
                }),
            ),
        ]),
        &mut obj,
    );
    add(
        "soc",
        if solved { Json::int(soc) } else { Json::Null },
        &mut obj,
    );
    add(
        "makespan",
        if solved {
            Json::int(makespan)
        } else {
            Json::Null
        },
        &mut obj,
    );
    add("horizon", Json::int(horizon_used as i64), &mut obj);
    add(
        "time_model",
        Json::obj(vec![
            ("timestep", Json::str("discrete")),
            ("sync", Json::str("synchronous")),
            (
                "horizon_declared",
                if p.solver.horizon_auto {
                    Json::Null
                } else {
                    Json::int(p.horizon as i64)
                },
            ),
            ("horizon_used", Json::int(horizon_used as i64)),
            ("stay_at_target", Json::Bool(true)),
        ]),
        &mut obj,
    );
    add(
        "coordinate_convention",
        Json::str(p.coordinate_convention.clone()),
        &mut obj,
    );
    add("robots", paths_json.clone(), &mut obj);
    add("search", search, &mut obj);
    add("metrics", metrics, &mut obj);
    if let Some(bm) = &p.bench {
        add(
            "benchmark",
            Json::obj(vec![
                ("source", Json::str(bm.source.clone())),
                ("map_file", Json::str(bm.map_file.clone())),
                ("scen_file", Json::str(bm.scen_file.clone())),
                ("map_sha256", Json::str(bm.map_sha256.clone())),
                ("scen_sha256", Json::str(bm.scen_sha256.clone())),
                ("instance_id", Json::int(bm.instance_id)),
                ("agents", Json::int(bm.agents)),
                ("converter_version", Json::str(bm.converter_version.clone())),
            ]),
            &mut obj,
        );
    } else {
        add("benchmark", Json::Null, &mut obj);
    }
    add("dynamic", dyn_json.unwrap_or(Json::Null), &mut obj);
    add("errors", problem::issues_to_json(errors), &mut obj);
    add("notes", Json::strings(notes.clone()), &mut obj);
    Json::Obj(obj)
}

fn ms(v: f64) -> Json {
    if v.is_finite() && v >= 0.0 {
        Json::Float((v * 1000.0).round() / 1000.0)
    } else {
        Json::Null
    }
}

fn coord(x: u32, y: u32) -> Json {
    Json::Arr(vec![Json::int(x as i64), Json::int(y as i64)])
}

fn event_json(e: &problem::Event, map: &problem::MapData) -> Json {
    use problem::Event;
    match e {
        Event::ObstacleAdd { cell, at, until } => Json::obj(vec![
            ("type", Json::str("obstacle_add")),
            ("cell", coord(map.x_of(*cell), map.y_of(*cell))),
            ("at", Json::int(*at as i64)),
            ("until", Json::opt_int(until.map(|u| u as i64))),
        ]),
        Event::ObstacleRemove { cell, at } => Json::obj(vec![
            ("type", Json::str("obstacle_remove")),
            ("cell", coord(map.x_of(*cell), map.y_of(*cell))),
            ("at", Json::int(*at as i64)),
        ]),
        Event::GoalChange { robot, goal, at } => Json::obj(vec![
            ("type", Json::str("goal_change")),
            ("robot", Json::str(map_id_hint(*robot))),
            ("robot_index", Json::int(*robot as i64)),
            ("goal", coord(map.x_of(*goal), map.y_of(*goal))),
            ("at", Json::int(*at as i64)),
        ]),
        Event::PathInvalid { robots, at } => Json::obj(vec![
            ("type", Json::str("path_invalid")),
            (
                "robots_indices",
                Json::Arr(robots.iter().map(|r| Json::int(*r as i64)).collect()),
            ),
            ("at", Json::int(*at as i64)),
        ]),
    }
}

fn map_id_hint(i: usize) -> String {
    format!("#{i}")
}

/// 语义摘要：sha256(canonical(status, objective.kind/value, soc, makespan, horizon, robots 路径,
/// ruleset, problem_hash))。同引擎同输入同设置 ⇒ 恒定。
fn semantic_digest(solution: &Json) -> String {
    let mut core: Vec<(String, Json)> = Vec::new();
    for k in [
        "status",
        "objective",
        "soc",
        "makespan",
        "horizon",
        "robots",
        "ruleset_version",
        "problem_hash",
    ] {
        if let Some(v) = solution.get(k) {
            core.push((k.to_string(), v.clone()));
        }
    }
    if let Some(Json::Obj(o)) = core
        .iter_mut()
        .find(|(k, _)| k == "objective")
        .map(|(_, v)| v)
    {
        o.retain(|(k, _)| k == "kind" || k == "value");
    }
    let canonical = Json::Obj(core).canonical();
    format!("sha256:{}", hash::sha256_hex(canonical.as_bytes()))
}

/// 方案指纹（CLI / wasm `mapf_fingerprint`）：去运行期字段后的规范化 sha256。
pub fn solution_fingerprint(solution: &Json) -> String {
    let mut cloned = solution.clone();
    if let Json::Obj(fields) = &mut cloned {
        fields.retain(|(k, _)| {
            !matches!(
                k.as_str(),
                "metrics" | "search" | "id" | "semantic_digest" | "verify" | "notes" | "engine"
            )
        });
    }
    format!("sha256:{}", hash::sha256_hex(cloned.canonical().as_bytes()))
}

fn error_outcome(
    t0: f64,
    status: Status,
    opts: &SolveOptions,
    problem_hash: Option<String>,
    issues: Vec<Issue>,
) -> Outcome {
    let mut v: Vec<(String, Json)> = Vec::new();
    {
        let mut add =
            |k: &str, val: Json, v: &mut Vec<(String, Json)>| v.push((k.to_string(), val));
        add(
            "schema_version",
            Json::str(crate::errors::SCHEMA_VERSION_SOLUTION),
            &mut v,
        );
        add("id", Json::str("mapf-sol-error"), &mut v);
        add("problem_hash", Json::opt_str(problem_hash), &mut v);
        add("engine", Json::str(crate::ENGINE_NAME), &mut v);
        add("engine_version", Json::str(crate::ENGINE_VERSION), &mut v);
        add(
            "capability_profile",
            Json::str(opts.profile.as_str()),
            &mut v,
        );
        add("status", Json::str(status.as_str()), &mut v);
        add("optimality_proven", Json::Bool(false), &mut v);
        add("verified", Json::Bool(false), &mut v);
        add("errors", problem::issues_to_json(&issues), &mut v);
        add("notes", Json::Arr(vec![]), &mut v);
        add("robots", Json::Arr(vec![]), &mut v);
        add(
            "metrics",
            Json::obj(vec![
                (
                    "total_ms",
                    Json::Float(((clock::now_ms() - t0) * 1000.0).max(0.0).round() / 1000.0),
                ),
                (
                    "time_metrics_available",
                    Json::Bool(clock::TIME_METRICS_AVAILABLE),
                ),
            ]),
            &mut v,
        );
    }
    let solution = Json::Obj(v);
    Outcome {
        status,
        solution_json: solution.to_compact(),
        solution,
    }
}

/// 独立核验包装（CLI `mapf verify` 与 wasm 导出共用）。
pub fn verify_solution_json(problem_text: &str, solution_text: &str, strict: bool) -> Json {
    verify::verify_report_json(problem_text, solution_text, strict)
}

/// BFS 连通性（静态地图上的可达性，与时域无关 ⇒ INFEASIBLE 证明）。
pub(crate) fn bfs_reachable(p: &Problem, from: u32, to: u32) -> bool {
    if from == to {
        return true;
    }
    let n = p.map.n_cells();
    let mut seen = vec![false; n];
    let mut q = VecDeque::new();
    seen[from as usize] = true;
    q.push_back(from);
    while let Some(c) = q.pop_front() {
        for nb in p.map.neighbors(c) {
            if nb == u32::MAX || p.map.is_blocked_static(nb) || seen[nb as usize] {
                continue;
            }
            if nb == to {
                return true;
            }
            seen[nb as usize] = true;
            q.push_back(nb);
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solve_text(text: &str) -> Outcome {
        let opts = SolveOptions {
            profile: Profile::Native,
            verify: true,
            ..Default::default()
        };
        let cancel = CancelToken::new();
        solve_json(text, &opts, &cancel)
    }

    #[test]
    fn two_agents_soc_optimal() {
        let text = r#"{
          "schema_version":"mapf-problem/1.0",
          "id":"t",
          "map":{"cells":["....","...."]},
          "robots":[
            {"id":"A","start":[0,0],"goal":[3,0]},
            {"id":"B","start":[3,1],"goal":[0,1]}
          ],
          "time_model":{"horizon":8},
          "objective":{"kind":"soc"},
          "solver":{"time_limit_ms":5000,"suboptimality_factor":1.0}
        }"#;
        let o = solve_text(text);
        assert_eq!(o.status, Status::Optimal, "{}", o.solution_json);
        assert_eq!(o.solution.get("soc").and_then(|v| v.as_i64()), Some(6));
        assert_eq!(o.solution.get("makespan").and_then(|v| v.as_i64()), Some(3));
        let ver = o
            .solution
            .get("verify")
            .and_then(|v| v.get("ok"))
            .and_then(|v| v.as_bool());
        assert_eq!(ver, Some(true), "{}", o.solution_json);
    }

    #[test]
    fn infeasible_isolated_region() {
        let text = r#"{
          "id":"t3",
          "map":{"cells":[".....",".***.",".*.*.",".***.","....."]},
          "robots":[{"id":"A","start":[0,0],"goal":[2,2]}],
          "time_model":{"horizon":20},
          "objective":{"kind":"soc"}
        }"#;
        let o = solve_text(text);
        assert_eq!(o.status, Status::Infeasible, "{}", o.solution_json);
        assert_eq!(
            o.solution
                .get("optimality_proven")
                .and_then(|v| v.as_bool()),
            Some(false)
        );
    }

    #[test]
    fn single_agent_makespan_optimal() {
        let text = r#"{
          "id":"t4",
          "map":{"cells":["....","...."]},
          "robots":[{"id":"A","start":[0,0],"goal":[3,1]}],
          "time_model":{"horizon":10},
          "objective":{"kind":"makespan"}
        }"#;
        let o = solve_text(text);
        assert_eq!(o.status, Status::Optimal);
        assert_eq!(o.solution.get("makespan").and_then(|v| v.as_i64()), Some(4));
    }

    #[test]
    fn invalid_input_reports_field_paths() {
        let text = r#"{ "id":"x", "map":{"cells":[".."]}, "robots":[] }"#;
        let o = solve_text(text);
        assert_eq!(o.status, Status::InvalidInput);
        assert!(o
            .solution
            .get("errors")
            .and_then(|e| e.as_arr())
            .map(|a| !a.is_empty())
            .unwrap_or(false));
    }

    #[test]
    fn deterministic_same_input_twice() {
        let text = r#"{
          "id":"det",
          "map":{"cells":["......","......","......"]},
          "robots":[
            {"id":"A","start":[0,0],"goal":[5,2]},
            {"id":"B","start":[5,0],"goal":[0,2]},
            {"id":"C","start":[2,2],"goal":[3,0]}
          ],
          "time_model":{"horizon":16},
          "objective":{"kind":"soc"},
          "solver":{"seed":7,"time_limit_ms":4000}
        }"#;
        let a = solve_text(text);
        let b = solve_text(text);
        // 计时/内存指标允许有毫秒抖动；语义核心（状态、目标值、路径、指纹）必须逐字节一致。
        assert_eq!(a.solution.get("status"), b.solution.get("status"));
        assert_eq!(
            a.solution.get("robots"),
            b.solution.get("robots"),
            "同输入路径必须确定"
        );
        assert_eq!(a.solution.get("objective"), b.solution.get("objective"));
        assert_eq!(
            a.solution.get("semantic_digest"),
            b.solution.get("semantic_digest")
        );
    }
}
