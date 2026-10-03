//! 独立核验器：仅凭（问题 JSON 文本, 解 JSON 文本）重演校验，不复用求解器
//! 内部结构（AGV-SRS §8）。
//!
//! 检查分三组，分别报告：
//! * `structure` —— 解文档形状与契约一致性；
//! * `timeline` —— MAPF 层路径合法性（连续性 / 墙 / 顶点 / 边冲突 / 历史前缀）；
//! * `dispatch` —— 调度层合法性（任务唯一 / 能力 / 泊位 / 释放 / 服务时长 /
//!   取送顺序 / 单载 / 工作站容量 / 结局一致 / 指标重算）。
//!
//! 报告符合 `agv-verification/1.0`（`ok` 当且仅当全部检查通过；失败项在 violations 逐条给出）。

use aps_engine::json::Json;

use crate::capabilities::Profile;
use crate::problem::{parse_problem, Cell, Event, Problem};

const KNOWN_TOP: &[&str] = &[
    "schema_version",
    "id",
    "problem_id",
    "problem_hash",
    "engine",
    "engine_version",
    "compiler_version",
    "mapf_engine_version",
    "ruleset_version",
    "capability_profile",
    "status",
    "verified",
    "plan",
    "metrics",
    "search",
    "verify",
    "errors",
    "notes",
    "fingerprint",
    "dynamic",
];
const KNOWN_PLAN: &[&str] = &["start_step", "horizon", "vehicles", "tasks"];
const KNOWN_VEHICLE: &[&str] = &["id", "timeline", "missions"];
const KNOWN_MISSION: &[&str] = &["task", "phase", "from", "to", "dock"];
const KNOWN_TASK: &[&str] = &[
    "id",
    "status",
    "vehicle",
    "pickup_dock",
    "dropoff_dock",
    "pickup_arrival",
    "pickup_done",
    "dropoff_arrival",
    "dropoff_done",
    "flow_time",
    "lateness",
    "reason",
];
const PHASES: &[&str] = &[
    "to_pickup",
    "servicing_pickup",
    "to_dropoff",
    "servicing_dropoff",
    "done",
    "relocating",
    "parked",
];

#[derive(Default)]
struct Checks {
    passed: usize,
    failed: usize,
    items: Vec<Json>,
    violations: Vec<Json>,
}

impl Checks {
    /// 契约检查项：`{name: "<group>/<name>", ok: bool}`；失败项同时产出一条
    /// violation（code 机器生成 `E-<GROUP>-<NAME>`，定位字段由调用方语义决定）。
    fn add(&mut self, group: &str, name: &str, ok: bool, msg: impl FnOnce() -> String) {
        let full = format!("{group}/{name}");
        if ok {
            self.passed += 1;
            self.items.push(Json::obj(vec![
                ("name", Json::str(full.clone())),
                ("ok", Json::Bool(true)),
            ]));
        } else {
            self.failed += 1;
            self.items.push(Json::obj(vec![
                ("name", Json::str(full.clone())),
                ("ok", Json::Bool(false)),
            ]));
            let code = format!(
                "E-{}-{}",
                group.to_uppercase(),
                name.to_uppercase().replace('_', "-")
            );
            self.violations.push(Json::obj(vec![
                ("code", Json::str(code)),
                ("constraint", Json::str(full)),
                ("severity", Json::str("error")),
                ("message", Json::str(msg())),
            ]));
        }
    }
}

struct VMission {
    task: Option<usize>,
    phase: String,
    from: u32,
    to: u32,
    dock: Option<Cell>,
}

struct VVehicle {
    vi: usize,
    timeline: Vec<Cell>,
    missions: Vec<VMission>,
}

struct VTask {
    ti: usize,
    status: String,
    vehicle: Option<usize>,
    pickup_dock: Option<Cell>,
    dropoff_dock: Option<Cell>,
    pickup_arrival: Option<u32>,
    pickup_done: Option<u32>,
    dropoff_arrival: Option<u32>,
    dropoff_done: Option<u32>,
    reason: Option<String>,
}

fn j_u32(j: &Json, k: &str) -> Option<u32> {
    j.get(k)
        .and_then(|x| x.as_i64())
        .and_then(|v| u32::try_from(v).ok())
}

fn j_cell(p: &Problem, j: &Json, k: &str) -> Option<Cell> {
    let a = j.get(k)?.as_arr()?;
    if a.len() != 2 {
        return None;
    }
    let (x, y) = (a[0].as_i64()?, a[1].as_i64()?);
    p.map.cell(x as u32, y as u32)
}

/// 某格在时刻 t 是否为障碍（基础图 + 动态障碍事件按序应用）。
fn blocked_at(p: &Problem, cell: Cell, t: u32) -> bool {
    let mut b = p.map.is_blocked(cell);
    if let Some(d) = &p.dynamic {
        for e in &d.events {
            match e {
                Event::ObstacleAdd { cell: c, at, until } if *c == cell => {
                    if *at <= t && until.map_or(true, |u| t < u) {
                        b = true;
                    }
                }
                Event::ObstacleRemove { cell: c, at } if *c == cell && *at <= t => {
                    b = false;
                }
                _ => {}
            }
        }
    }
    b
}

fn is_busy_phase(phase: &str) -> bool {
    matches!(
        phase,
        "to_pickup" | "servicing_pickup" | "to_dropoff" | "servicing_dropoff"
    )
}

fn phase_at(missions: &[VMission], t: u32) -> Option<&str> {
    missions
        .iter()
        .find(|m| m.from <= t && t < m.to)
        .map(|m| m.phase.as_str())
}

/// 核验入口。返回 verification 报告 JSON。
pub fn verify_solution_json(problem_text: &str, solution_text: &str, strict: bool) -> Json {
    let mut c = Checks::default();

    let problem = parse_problem(problem_text, Profile::Native);
    let p = match problem {
        Ok(p) => Some(p),
        Err(issues) => {
            c.add("structure", "problem_parseable", false, || {
                format!("问题文本无法解析：{issues:?}")
            });
            None
        }
    };
    let sol = match aps_engine::json::parse(solution_text) {
        Ok(j) => j,
        Err(e) => {
            c.add("structure", "solution_json", false, || {
                format!("解不是合法 JSON：{e}")
            });
            return report(&c, "invalid", solution_text, strict);
        }
    };

    // ---------------- 结构 ----------------
    c.add(
        "structure",
        "schema_version",
        sol.get("schema_version").and_then(|j| j.as_str()) == Some("agv-dispatch-solution/1.0"),
        || "schema_version 必须是 agv-dispatch-solution/1.0".into(),
    );
    c.add(
        "structure",
        "engine",
        sol.get("engine").and_then(|j| j.as_str()) == Some("rust-agv-dispatch"),
        || "engine 必须是 rust-agv-dispatch".into(),
    );
    c.add(
        "structure",
        "ruleset_version",
        sol.get("ruleset_version").and_then(|j| j.as_str()) == Some("agv-rules/1.0"),
        || "ruleset_version 必须是 agv-rules/1.0".into(),
    );
    let status = sol
        .get("status")
        .and_then(|j| j.as_str())
        .unwrap_or("")
        .to_string();
    c.add(
        "structure",
        "status_enum",
        matches!(
            status.as_str(),
            "FEASIBLE"
                | "PARTIAL"
                | "UNKNOWN"
                | "INFEASIBLE"
                | "INVALID_INPUT"
                | "UNSUPPORTED"
                | "CANCELLED"
        ),
        || format!("未知状态 `{status}`"),
    );
    if strict {
        if let Some(obj) = sol.as_obj() {
            let unknown: Vec<String> = obj
                .iter()
                .filter(|(k, _)| !KNOWN_TOP.contains(&k.as_str()))
                .map(|(k, _)| k.clone())
                .collect();
            c.add("structure", "strict_top_fields", unknown.is_empty(), || {
                format!("严格模式：顶层出现未声明字段 {unknown:?}")
            });
        }
    }

    let Some(p) = p else {
        return report(&c, "fail", solution_text, strict);
    };

    // 动态问题：展开（任务表含 task_add 新增、事件应用），核验基于展开后的语义
    let p = if p.dynamic.is_some() {
        match crate::dynamic::expand(&p) {
            Ok(e) => e.p,
            Err(issues) => {
                c.add("structure", "dynamic_expansion", false, || {
                    format!("动态块语义展开失败：{issues:?}")
                });
                return report(&c, "fail", solution_text, strict);
            }
        }
    } else {
        p
    };

    // 错误类解：无 plan，只需结构正确
    if matches!(
        status.as_str(),
        "INVALID_INPUT" | "UNSUPPORTED" | "CANCELLED"
    ) {
        c.add(
            "structure",
            "errors_present",
            sol.get("errors")
                .and_then(|j| j.as_arr())
                .is_some_and(|a| !a.is_empty()),
            || "错误解必须给出 errors".into(),
        );
        return report(
            &c,
            if c.failed == 0 { "pass" } else { "fail" },
            solution_text,
            strict,
        );
    }

    let Some(plan) = sol.get("plan") else {
        c.add("structure", "plan_present", false, || "解缺少 plan".into());
        return report(&c, "fail", solution_text, strict);
    };
    if strict {
        if let Some(obj) = plan.as_obj() {
            let unknown: Vec<String> = obj
                .iter()
                .filter(|(k, _)| !KNOWN_PLAN.contains(&k.as_str()))
                .map(|(k, _)| k.clone())
                .collect();
            c.add(
                "structure",
                "strict_plan_fields",
                unknown.is_empty(),
                || format!("严格模式：plan 出现未声明字段 {unknown:?}"),
            );
        }
    }
    let horizon = j_u32(plan, "horizon");
    let start_step = plan
        .get("start_step")
        .and_then(|j| j.as_i64())
        .unwrap_or(0)
        .max(0) as u32;
    let Some(horizon) = horizon else {
        c.add("structure", "horizon", false, || {
            "plan.horizon 缺失或非法".into()
        });
        return report(&c, "fail", solution_text, strict);
    };

    // 车辆
    let mut vvehicles: Vec<VVehicle> = Vec::new();
    let mut vmap_ok = true;
    if let Some(vs) = plan.get("vehicles").and_then(|j| j.as_arr()) {
        for (i, vj) in vs.iter().enumerate() {
            let vid = vj.get("id").and_then(|j| j.as_str()).unwrap_or("");
            let Some(vi) = p.vehicles.iter().position(|v| v.id == vid) else {
                vmap_ok = false;
                c.add("structure", "vehicle_ids", false, || {
                    format!("plan.vehicles[{i}] 引用未声明车辆 `{vid}`")
                });
                continue;
            };
            let mut timeline = Vec::new();
            if let Some(tl) = vj.get("timeline").and_then(|j| j.as_arr()) {
                for cj in tl {
                    let Some(cell) = cj
                        .as_arr()
                        .filter(|a| a.len() == 2)
                        .and_then(|a| p.map.cell(a[0].as_i64()? as u32, a[1].as_i64()? as u32))
                    else {
                        vmap_ok = false;
                        c.add("structure", "timeline_cells", false, || {
                            format!("车辆 `{vid}` timeline 含非法坐标")
                        });
                        break;
                    };
                    timeline.push(cell);
                }
            }
            let mut missions = Vec::new();
            if let Some(ms) = vj.get("missions").and_then(|j| j.as_arr()) {
                for mj in ms {
                    let phase = mj
                        .get("phase")
                        .and_then(|j| j.as_str())
                        .unwrap_or("")
                        .to_string();
                    let task = mj
                        .get("task")
                        .and_then(|j| j.as_str())
                        .and_then(|t| p.tasks.iter().position(|x| x.id == t));
                    missions.push(VMission {
                        task,
                        phase,
                        from: j_u32(mj, "from").unwrap_or(0),
                        to: j_u32(mj, "to").unwrap_or(0),
                        dock: j_cell(&p, mj, "dock"),
                    });
                }
            }
            if strict {
                if let Some(obj) = vj.as_obj() {
                    let unknown: Vec<String> = obj
                        .iter()
                        .filter(|(k, _)| !KNOWN_VEHICLE.contains(&k.as_str()))
                        .map(|(k, _)| k.clone())
                        .collect();
                    c.add(
                        "structure",
                        "strict_vehicle_fields",
                        unknown.is_empty(),
                        || format!("严格模式：vehicle `{vid}` 出现未声明字段 {unknown:?}"),
                    );
                }
            }
            vvehicles.push(VVehicle {
                vi,
                timeline,
                missions,
            });
        }
    }
    c.add(
        "structure",
        "vehicle_bijection",
        vmap_ok && vvehicles.len() == p.vehicles.len(),
        || "plan.vehicles 必须与问题车辆一一对应".into(),
    );

    // 任务
    let mut vtasks: Vec<VTask> = Vec::new();
    let mut tmap_ok = true;
    if let Some(ts) = plan.get("tasks").and_then(|j| j.as_arr()) {
        for (i, tj) in ts.iter().enumerate() {
            let tid = tj.get("id").and_then(|j| j.as_str()).unwrap_or("");
            let Some(ti) = p.tasks.iter().position(|t| t.id == tid) else {
                tmap_ok = false;
                c.add("structure", "task_ids", false, || {
                    format!("plan.tasks[{i}] 引用未声明任务 `{tid}`")
                });
                continue;
            };
            vtasks.push(VTask {
                ti,
                status: tj
                    .get("status")
                    .and_then(|j| j.as_str())
                    .unwrap_or("")
                    .to_string(),
                vehicle: tj
                    .get("vehicle")
                    .and_then(|j| j.as_str())
                    .and_then(|v| p.vehicles.iter().position(|x| x.id == v)),
                pickup_dock: j_cell(&p, tj, "pickup_dock"),
                dropoff_dock: j_cell(&p, tj, "dropoff_dock"),
                pickup_arrival: j_u32(tj, "pickup_arrival"),
                pickup_done: j_u32(tj, "pickup_done"),
                dropoff_arrival: j_u32(tj, "dropoff_arrival"),
                dropoff_done: j_u32(tj, "dropoff_done"),
                reason: tj
                    .get("reason")
                    .and_then(|j| j.as_str())
                    .map(|s| s.to_string()),
            });
        }
    }
    c.add(
        "structure",
        "task_bijection",
        tmap_ok && vtasks.len() == p.tasks.len(),
        || "plan.tasks 必须与问题任务一一对应".into(),
    );

    // 任务段合法性 + 连续性
    let mut missions_ok = true;
    for vv in &vvehicles {
        let vid = &p.vehicles[vv.vi].id;
        for m in &vv.missions {
            if !PHASES.contains(&m.phase.as_str()) {
                missions_ok = false;
                c.add("structure", "mission_phase", false, || {
                    format!("车辆 `{vid}` 任务段相位非法 `{}`", m.phase)
                });
            }
            if m.from > m.to || m.to > horizon || m.from < start_step {
                missions_ok = false;
                c.add("structure", "mission_bounds", false, || {
                    format!("车辆 `{vid}` 任务段 [{}, {}] 越界（horizon={horizon}, start={start_step}）", m.from, m.to)
                });
            }
        }
        // 链式连续
        for w in vv.missions.windows(2) {
            if w[0].to != w[1].from {
                missions_ok = false;
                c.add("structure", "mission_chain", false, || {
                    format!(
                        "车辆 `{vid}` 任务段不连续：{} 结束于 {}，下一个始于 {}",
                        w[0].phase, w[0].to, w[1].from
                    )
                });
            }
        }
        // 起点衔接：首段 from == start_step（无任务段也允许）
        if let Some(first) = vv.missions.first() {
            if first.from != start_step {
                missions_ok = false;
                c.add("structure", "mission_chain", false, || {
                    format!(
                        "车辆 `{vid}` 首任务段始于 {}，应为 {start_step}",
                        first.from
                    )
                });
            }
        }
    }
    c.add("structure", "missions_well_formed", missions_ok, || {
        "任务段形状非法（见前述明细）".into()
    });

    // 严格模式：任务段 / 任务字段白名单
    if strict {
        let mut sf_ok = true;
        for vv in &vvehicles {
            if let Some(ms) = sol
                .get("plan")
                .and_then(|pl| pl.get("vehicles"))
                .and_then(|j| j.as_arr())
            {
                if let Some(vj) = ms.get(vv.vi) {
                    if let Some(missions) = vj.get("missions").and_then(|j| j.as_arr()) {
                        for mj in missions {
                            if let Some(obj) = mj.as_obj() {
                                let unknown: Vec<String> = obj
                                    .iter()
                                    .filter(|(k, _)| !KNOWN_MISSION.contains(&k.as_str()))
                                    .map(|(k, _)| k.clone())
                                    .collect();
                                if !unknown.is_empty() {
                                    sf_ok = false;
                                    c.add("structure", "strict_mission_fields", false, || {
                                        format!("严格模式：mission 出现未声明字段 {unknown:?}")
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        if let Some(ts) = sol
            .get("plan")
            .and_then(|pl| pl.get("tasks"))
            .and_then(|j| j.as_arr())
        {
            for tj in ts {
                if let Some(obj) = tj.as_obj() {
                    let unknown: Vec<String> = obj
                        .iter()
                        .filter(|(k, _)| !KNOWN_TASK.contains(&k.as_str()))
                        .map(|(k, _)| k.clone())
                        .collect();
                    if !unknown.is_empty() {
                        sf_ok = false;
                        c.add("structure", "strict_task_fields", false, || {
                            format!("严格模式：task 出现未声明字段 {unknown:?}")
                        });
                    }
                }
            }
        }
        c.add("structure", "strict_nested_fields", sf_ok, || {
            "嵌套对象存在白名单外字段".into()
        });
    }

    // ---------------- timeline（MAPF 层） ----------------
    let snap_time = p.dynamic.as_ref().map(|d| d.time);
    let mut len_ok = true;
    for vv in &vvehicles {
        if vv.timeline.len() as u32 != horizon + 1 {
            len_ok = false;
            c.add("timeline", "length", false, || {
                format!(
                    "车辆 `{}` timeline 长度 {} ≠ horizon+1 = {}",
                    p.vehicles[vv.vi].id,
                    vv.timeline.len(),
                    horizon + 1
                )
            });
        }
    }
    c.add("timeline", "length", len_ok, || {
        "timeline 长度不一致".into()
    });

    // 起点 / 历史前缀
    let mut start_ok = true;
    for vv in &vvehicles {
        let vid = &p.vehicles[vv.vi].id;
        match (&p.dynamic, snap_time) {
            (Some(d), Some(t)) => {
                let Some(Some(snap)) = d.vehicles.get(vv.vi) else {
                    continue; // 车辆在快照中缺失 → 起点即声明起点（或已由问题校验报错）
                };
                if vv.timeline.len() as u32 > t {
                    let mut prefix_ok = true;
                    for step in 0..=t as usize {
                        if vv.timeline.get(step) != snap.path.get(step) {
                            prefix_ok = false;
                            break;
                        }
                    }
                    if !prefix_ok || snap.path.len() as u32 <= t {
                        start_ok = false;
                        c.add("timeline", "history_prefix", false, || {
                            format!("车辆 `{vid}` 时间线前缀与快照执行路径不一致（0..={t}）")
                        });
                    }
                }
            }
            _ => {
                if vv.timeline.first() != Some(&p.vehicles[vv.vi].start) {
                    start_ok = false;
                    c.add("timeline", "start_position", false, || {
                        format!("车辆 `{vid}` 起点 ≠ 声明 start")
                    });
                }
            }
        }
    }
    c.add("timeline", "start_and_history", start_ok, || {
        "起点或历史前缀不一致".into()
    });

    // 连续性
    let mut cont_ok = true;
    for vv in &vvehicles {
        for t in 1..vv.timeline.len() {
            let (a, b) = (vv.timeline[t - 1], vv.timeline[t]);
            if a != b && p.map.manhattan(a, b) != 1 {
                cont_ok = false;
                c.add("timeline", "continuity", false, || {
                    format!("车辆 `{}` t={t} 非法移动", p.vehicles[vv.vi].id)
                });
            }
        }
    }
    c.add("timeline", "continuity", cont_ok, || "存在非法移动".into());

    // 墙（含动态障碍）
    let mut wall_ok = true;
    for vv in &vvehicles {
        for (t, &cell) in vv.timeline.iter().enumerate() {
            if blocked_at(&p, cell, t as u32) {
                wall_ok = false;
                c.add("timeline", "walls", false, || {
                    format!(
                        "车辆 `{}` t={t} 位于障碍格 {}",
                        p.vehicles[vv.vi].id,
                        crate::problem::fmt_cell(&p.map, cell)
                    )
                });
            }
        }
    }
    c.add("timeline", "walls", wall_ok, || "时间线穿越障碍".into());

    // 顶点 / 边冲突
    let mut vertex_ok = true;
    let mut edge_ok = true;
    for t in 0..=horizon as usize {
        for a in 0..vvehicles.len() {
            for b in (a + 1)..vvehicles.len() {
                let (ta, tb) = (
                    vvehicles[a].timeline.get(t).copied(),
                    vvehicles[b].timeline.get(t).copied(),
                );
                if let (Some(ca), Some(cb)) = (ta, tb) {
                    if ca == cb {
                        vertex_ok = false;
                        c.add("timeline", "vertex_conflicts", false, || {
                            format!(
                                "t={t} 车辆 `{}` 与 `{}` 同格",
                                p.vehicles[vvehicles[a].vi].id, p.vehicles[vvehicles[b].vi].id
                            )
                        });
                    }
                }
                if t < horizon as usize {
                    let (na, nb) = (
                        vvehicles[a].timeline.get(t + 1).copied(),
                        vvehicles[b].timeline.get(t + 1).copied(),
                    );
                    if let (Some(ca), Some(cb), Some(na), Some(nb)) = (ta, tb, na, nb) {
                        if ca == nb && cb == na && ca != cb {
                            edge_ok = false;
                            c.add("timeline", "edge_conflicts", false, || {
                                format!(
                                    "t={t} 车辆 `{}` 与 `{}` 交换位置",
                                    p.vehicles[vvehicles[a].vi].id, p.vehicles[vvehicles[b].vi].id
                                )
                            });
                        }
                    }
                }
            }
        }
    }
    c.add("timeline", "vertex_conflicts", vertex_ok, || {
        "存在顶点冲突".into()
    });
    c.add("timeline", "edge_conflicts", edge_ok, || {
        "存在边冲突".into()
    });

    // ---------------- dispatch（调度层） ----------------
    // 任务唯一性
    let mut uniq_ok = true;
    {
        let mut seen: Vec<(usize, usize)> = Vec::new(); // (task, vehicle)
        for vv in &vvehicles {
            for m in &vv.missions {
                if let Some(ti) = m.task {
                    if is_busy_phase(&m.phase) {
                        if let Some((_, prev)) = seen.iter().find(|(t, _)| *t == ti) {
                            if *prev != vv.vi {
                                uniq_ok = false;
                                c.add("dispatch", "task_uniqueness", false, || {
                                    format!(
                                        "任务 `{}` 同时出现在车辆 `{}` 与 `{}` 的任务段",
                                        p.tasks[ti].id, p.vehicles[*prev].id, p.vehicles[vv.vi].id
                                    )
                                });
                            }
                        } else {
                            seen.push((ti, vv.vi));
                        }
                    }
                }
            }
        }
    }
    c.add("dispatch", "task_uniqueness", uniq_ok, || {
        "任务被多车执行".into()
    });

    // 单载 + 取送顺序（每车任务段序列：同一任务的 pickup..dropoff 连续，不与他任务交错）
    // 动态解中历史已取货（pickup_done ≤ start_step）的任务只有送达段，视为已载。
    let mut hist_picked: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
    if start_step > 0 {
        if let Some(ts) = plan.get("tasks").and_then(|j| j.as_arr()) {
            for tj in ts {
                let Some(ti) = tj
                    .get("id")
                    .and_then(|j| j.as_str())
                    .and_then(|t| p.tasks.iter().position(|x| x.id == t))
                else {
                    continue;
                };
                if j_u32(tj, "pickup_done").is_some_and(|d| d <= start_step) {
                    hist_picked.insert(ti);
                }
            }
        }
    }
    let mut single_load_ok = true;
    for vv in &vvehicles {
        let mut stack: Vec<usize> = Vec::new();
        for m in &vv.missions {
            let Some(ti) = m.task else { continue };
            match m.phase.as_str() {
                "to_pickup" => {
                    if stack.last().is_some_and(|&top| top != ti) {
                        single_load_ok = false;
                        c.add("dispatch", "single_load", false, || {
                            format!(
                                "车辆 `{}` 在任务 `{}` 未送达前开始任务 `{}` 的取货（单载约束）",
                                p.vehicles[vv.vi].id,
                                p.tasks[*stack.last().unwrap()].id,
                                p.tasks[ti].id
                            )
                        });
                    }
                    stack.push(ti);
                }
                "servicing_pickup" | "to_dropoff" | "servicing_dropoff" => {
                    if stack.last() != Some(&ti) {
                        if (m.phase == "to_dropoff" || m.phase == "servicing_dropoff")
                            && hist_picked.contains(&ti)
                            && !stack.contains(&ti)
                        {
                            stack.push(ti); // 历史已取货：送达段合法
                        } else {
                            single_load_ok = false;
                            c.add("dispatch", "single_load", false, || {
                                format!(
                                    "车辆 `{}` 送达/服务 `{}` 时最后取货任务为 `{}`（顺序/单载违约）",
                                    p.vehicles[vv.vi].id,
                                    p.tasks[ti].id,
                                    stack.last().map(|s| p.tasks[*s].id.clone()).unwrap_or_default()
                                )
                            });
                        }
                    }
                }
                "done" => {
                    if stack.last() == Some(&ti) {
                        stack.pop();
                    } else if !hist_picked.contains(&ti) {
                        single_load_ok = false;
                        c.add("dispatch", "single_load", false, || {
                            format!(
                                "车辆 `{}` 出现无取货记录的完成标记 `{}`",
                                p.vehicles[vv.vi].id, p.tasks[ti].id
                            )
                        });
                    }
                }
                _ => {}
            }
        }
    }
    c.add("dispatch", "single_load_and_order", single_load_ok, || {
        "单载或取送顺序违约".into()
    });

    // 能力 / 泊位 / 释放 / 时长
    let mut capa_ok = true;
    let mut dock_ok = true;
    let mut rel_ok = true;
    let mut dur_ok = true;
    let mut svc_intervals: Vec<(usize, u32, u32)> = Vec::new(); // (station idx, from, to)
    for vv in &vvehicles {
        for m in &vv.missions {
            let Some(ti) = m.task else { continue };
            let task = &p.tasks[ti];
            match m.phase.as_str() {
                "to_pickup" => {
                    if !p.vehicles[vv.vi].capable(task.required_capability.as_deref()) {
                        capa_ok = false;
                        c.add("dispatch", "capability", false, || {
                            format!(
                                "任务 `{}` 需要 `{}`，车辆 `{}` 不具备",
                                task.id,
                                task.required_capability.clone().unwrap_or_default(),
                                p.vehicles[vv.vi].id
                            )
                        });
                    }
                    if let Some(d) = m.dock {
                        if !task.pickup.dock_candidates(&p.stations).contains(&d) {
                            dock_ok = false;
                            c.add("dispatch", "dock_validity", false, || {
                                format!("任务 `{}` 取货泊位非法", task.id)
                            });
                        }
                    }
                    if m.to < task.release_step {
                        rel_ok = false;
                        c.add("dispatch", "release_order", false, || {
                            format!(
                                "任务 `{}` 取货服务开始 {} 早于释放 {}",
                                task.id, m.to, task.release_step
                            )
                        });
                    }
                }
                "to_dropoff" => {
                    if let Some(d) = m.dock {
                        if !task.dropoff.dock_candidates(&p.stations).contains(&d) {
                            dock_ok = false;
                            c.add("dispatch", "dock_validity", false, || {
                                format!("任务 `{}` 送达泊位非法", task.id)
                            });
                        }
                    }
                }
                "servicing_pickup" => {
                    if m.to - m.from != task.pickup_service {
                        dur_ok = false;
                        c.add("dispatch", "service_duration", false, || {
                            format!(
                                "任务 `{}` 取货服务时长 {} ≠ {}",
                                task.id,
                                m.to - m.from,
                                task.pickup_service
                            )
                        });
                    }
                    if let Some(d) = m.dock {
                        if let Some(si) = p.stations.iter().position(|s| s.cells.contains(&d)) {
                            svc_intervals.push((si, m.from, m.to));
                        }
                    }
                }
                "servicing_dropoff" => {
                    if m.to - m.from != task.dropoff_service {
                        dur_ok = false;
                        c.add("dispatch", "service_duration", false, || {
                            format!(
                                "任务 `{}` 送达服务时长 {} ≠ {}",
                                task.id,
                                m.to - m.from,
                                task.dropoff_service
                            )
                        });
                    }
                    if let Some(d) = m.dock {
                        if let Some(si) = p.stations.iter().position(|s| s.cells.contains(&d)) {
                            svc_intervals.push((si, m.from, m.to));
                        }
                    }
                }
                _ => {}
            }
        }
    }
    c.add("dispatch", "capability", capa_ok, || "能力约束违约".into());
    c.add("dispatch", "dock_validity", dock_ok, || "泊位非法".into());
    c.add("dispatch", "release_order", rel_ok, || {
        "释放顺序违约".into()
    });
    c.add("dispatch", "service_duration", dur_ok, || {
        "服务时长不符".into()
    });

    // 工作站容量（同时刻先计开始后计结束；零长服务 [a,a] 计 1 并发）
    let mut cap_ok = true;
    for (si, station) in p.stations.iter().enumerate() {
        let mut times: Vec<(u32, i32)> = svc_intervals
            .iter()
            .filter(|(s, _, _)| *s == si)
            .flat_map(|&(_, f, t)| [(f, 1), (t, -1)])
            .collect();
        times.sort_by_key(|(t, d)| (*t, -*d));
        let mut cur = 0usize;
        let mut peak = 0usize;
        for (_, d) in times {
            cur = (cur as i64 + d as i64).max(0) as usize;
            peak = peak.max(cur);
        }
        if peak > station.capacity {
            cap_ok = false;
            c.add("dispatch", "station_capacity", false, || {
                format!(
                    "工作站 `{}` 并发服务 {peak} > 容量 {}",
                    station.id, station.capacity
                )
            });
        }
    }
    c.add("dispatch", "station_capacity", cap_ok, || {
        "工作站容量违约".into()
    });

    // 任务结局与任务段一致
    let mut outcome_ok = true;
    for vt in &vtasks {
        let task = &p.tasks[vt.ti];
        let owner: Option<usize> = vvehicles
            .iter()
            .find(|vv| {
                vv.missions
                    .iter()
                    .any(|m| m.task == Some(vt.ti) && is_busy_phase(&m.phase))
            })
            .map(|vv| vv.vi);
        if vt.status == "completed" {
            let missing = vt.pickup_done.is_none()
                || vt.dropoff_done.is_none()
                || vt.pickup_dock.is_none()
                || vt.dropoff_dock.is_none();
            if missing {
                outcome_ok = false;
                c.add("dispatch", "outcome_consistency", false, || {
                    format!("任务 `{}` completed 但缺少时刻/泊位", task.id)
                });
                continue;
            }
            if let Some(done) = vt.dropoff_done {
                if done > horizon {
                    outcome_ok = false;
                    c.add("dispatch", "outcome_consistency", false, || {
                        format!("任务 `{}` dropoff_done={done} 超出 horizon", task.id)
                    });
                }
            }
            // 时刻单调：pickup_arrival ≤ pickup_done ≤ dropoff_arrival ≤ dropoff_done
            let mono = [
                (vt.pickup_arrival, vt.pickup_done),
                (vt.pickup_done, vt.dropoff_arrival),
                (vt.dropoff_arrival, vt.dropoff_done),
            ]
            .iter()
            .all(|(a, b)| a.map_or(true, |x| b.map_or(true, |y| x <= y)));
            if !mono {
                outcome_ok = false;
                c.add("dispatch", "outcome_consistency", false, || {
                    format!("任务 `{}` 时刻非单调（取/送时间线倒置）", task.id)
                });
            }
            if owner != vt.vehicle {
                outcome_ok = false;
                c.add("dispatch", "outcome_consistency", false, || {
                    format!("任务 `{}` outcome.vehicle 与任务段执行车不一致", task.id)
                });
            }
        } else if vt.status == "picked" || vt.status == "assigned" {
            // 中间态只允许动态解
        } else if matches!(
            vt.status.as_str(),
            "unassigned" | "leg_infeasible" | "budget" | "cancelled"
        ) {
            if owner.is_some() {
                outcome_ok = false;
                c.add("dispatch", "outcome_consistency", false, || {
                    format!("任务 `{}` 标记 `{}` 但出现在任务段中", task.id, vt.status)
                });
            }
            if vt.reason.is_none() {
                outcome_ok = false;
                c.add("dispatch", "outcome_consistency", false, || {
                    format!(
                        "任务 `{}` 失败终态 `{}` 必须给出 reason",
                        task.id, vt.status
                    )
                });
            }
        } else {
            outcome_ok = false;
            c.add("dispatch", "outcome_consistency", false, || {
                format!("任务 `{}` 状态 `{}` 不在契约枚举内", task.id, vt.status)
            });
        }
    }
    c.add("dispatch", "outcome_consistency", outcome_ok, || {
        "任务结局与任务段不一致".into()
    });

    // 事件一致性（动态）
    if let Some(d) = &p.dynamic {
        let mut ev_ok = true;
        for e in &d.events {
            if let Event::TaskCancel { task } = e {
                if let Some(vt) = vtasks.iter().find(|vt| vt.ti == *task) {
                    if matches!(vt.status.as_str(), "completed" | "assigned" | "picked") {
                        ev_ok = false;
                        c.add("dispatch", "event_application", false, || {
                            format!(
                                "任务 `{}` 被取消但仍标记 `{}`",
                                p.tasks[*task].id, vt.status
                            )
                        });
                    }
                }
            }
        }
        // 历史完成任务时刻 ≤ 快照时刻
        for vt in &vtasks {
            if let (Some(done), Some(t)) = (vt.dropoff_done, snap_time) {
                if done > t && vt.ti < d.tasks.len() && d.tasks[vt.ti].status == "done" {
                    ev_ok = false;
                    c.add("dispatch", "event_application", false, || {
                        format!(
                            "任务 `{}` 在快照中已完成但 dropoff_done={done} > t={t}",
                            p.tasks[vt.ti].id
                        )
                    });
                }
            }
        }
        c.add("dispatch", "event_application", ev_ok, || {
            "事件未被正确应用".into()
        });
    }

    // 指标重算
    let mut m_completed = 0usize;
    let mut m_makespan = 0u32;
    let mut m_flow: u64 = 0;
    let mut m_late: u64 = 0;
    let mut m_viol = 0usize;
    for vt in &vtasks {
        if vt.status != "completed" {
            continue;
        }
        m_completed += 1;
        let task = &p.tasks[vt.ti];
        let done = vt.dropoff_done.unwrap_or(0);
        m_makespan = m_makespan.max(done);
        m_flow += (done.saturating_sub(task.release_step)) as u64;
        if let Some(due) = task.due_step {
            if done > due {
                m_viol += 1;
                m_late += (done - due) as u64;
            }
        }
    }
    let mut m_travel: u64 = 0;
    let mut m_loaded: u64 = 0;
    let mut m_wait: u64 = 0;
    let mut busy_total: u64 = 0;
    for vv in &vvehicles {
        for t in 0..horizon {
            let a = vv.timeline.get(t as usize).copied();
            let b = vv.timeline.get(t as usize + 1).copied();
            let (Some(a), Some(b)) = (a, b) else { break };
            let phase = phase_at(&vv.missions, t);
            if phase.is_some_and(is_busy_phase) {
                busy_total += 1;
            }
            if a != b {
                m_travel += 1;
                if phase == Some("to_dropoff") {
                    m_loaded += 1;
                }
            } else if phase.is_some_and(is_busy_phase) {
                m_wait += 1;
            }
        }
    }
    let avg_util = (busy_total as f64
        / (m_makespan.max(1) as f64 * p.vehicles.len().max(1) as f64)
        * 10_000.0)
        .round()
        / 10_000.0;

    if let Some(met) = sol.get("metrics") {
        let eq = |k: &str, want: i64| met.get(k).and_then(|j| j.as_i64()) == Some(want);
        let metrics_ok = eq("completed_tasks", m_completed as i64)
            && eq("total_tasks", p.tasks.len() as i64)
            && eq("makespan", m_makespan as i64)
            && eq("total_flow_time", m_flow as i64)
            && eq("total_lateness", m_late as i64)
            && eq("deadline_violations", m_viol as i64)
            && eq("total_travel_steps", m_travel as i64)
            && eq("loaded_travel_steps", m_loaded as i64)
            && eq("empty_travel_steps", (m_travel - m_loaded) as i64)
            && eq("total_wait_steps", m_wait as i64);
        let util_ok = met
            .get("avg_utilization")
            .and_then(|j| j.as_f64())
            .is_some_and(|u| (u - avg_util).abs() < 0.002);
        c.add("dispatch", "metrics_recomputed", metrics_ok, || {
            format!(
                "metrics 与重算不一致：completed={m_completed}, makespan={m_makespan}, flow={m_flow}, travel={m_travel}, loaded={m_loaded}, wait={m_wait}"
            )
        });
        c.add("dispatch", "metrics_utilization", util_ok, || {
            format!("avg_utilization 与重算不一致（期望 ≈ {avg_util}）")
        });
    } else {
        c.add("dispatch", "metrics_present", false, || {
            "解缺少 metrics".into()
        });
    }

    // 顶点冲突之外的兜底：车俩数（去重起点在静态问题已由解析保证）
    report(
        &c,
        if c.failed == 0 { "pass" } else { "fail" },
        solution_text,
        strict,
    )
}

fn report(c: &Checks, status: &str, solution_text: &str, strict: bool) -> Json {
    let ok = status == "pass";
    // 指标复算（SRS §5）：从 plan 原文重算三个标量，供报告消费方比对 metrics。
    let recomputed = aps_engine::json::parse(solution_text).ok().map(|sol| {
        let tasks = sol
            .get("plan")
            .and_then(|p| p.get("tasks"))
            .and_then(|j| j.as_arr());
        let mut completed = 0i64;
        let mut flow_total = 0i64;
        let mut makespan = 0i64;
        if let Some(ts) = tasks {
            for t in ts.iter() {
                if t.get("status").and_then(|j| j.as_str()) == Some("completed") {
                    completed += 1;
                }
                if let Some(ft) = t.get("flow_time").and_then(|j| j.as_i64()) {
                    flow_total += ft;
                }
                if let Some(dd) = t.get("dropoff_done").and_then(|j| j.as_i64()) {
                    makespan = makespan.max(dd);
                }
            }
        }
        Json::obj(vec![
            ("completed_tasks", Json::int(completed)),
            ("flow_time_total", Json::int(flow_total)),
            ("makespan", Json::int(makespan)),
        ])
    });
    Json::obj(vec![
        ("schema_version", Json::str("agv-dispatch-verification/1.0")),
        (
            "mode",
            Json::str(if strict { "full+strict" } else { "full" }),
        ),
        ("ruleset_version", Json::str(crate::RULESET_VERSION)),
        ("ok", Json::Bool(ok)),
        (
            "counts",
            Json::obj(vec![
                ("total", Json::int((c.passed + c.failed) as i64)),
                ("passed", Json::int(c.passed as i64)),
                ("failed", Json::int(c.failed as i64)),
            ]),
        ),
        ("checks", Json::Arr(c.items.clone())),
        ("violations", Json::Arr(c.violations.clone())),
        ("recomputed", recomputed.unwrap_or(Json::Null)),
    ])
}

/// 报告是否全过。
pub fn report_pass(report: &Json) -> bool {
    report.get("ok").and_then(|j| j.as_bool()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{solve_json, SolveOptions};

    fn text() -> String {
        r#"{
            "map": { "cells": ["......", "......", "......"] },
            "time_model": { "horizon": 60 },
            "vehicles": [ { "id": "V1", "start": [0,0] } ],
            "tasks": [ { "id": "T1", "pickup": [4,0], "dropoff": [1,2] } ]
        }"#
        .to_string()
    }

    fn opts() -> SolveOptions {
        SolveOptions {
            profile: Profile::Native,
            verify: true,
            ..Default::default()
        }
    }

    #[test]
    fn clean_solution_passes() {
        let cancel = aps_engine::engine::CancelToken::new();
        let out = solve_json(&text(), &opts(), &cancel);
        assert_eq!(
            out.status,
            crate::errors::Status::Feasible,
            "{}",
            out.solution_json
        );
        let report = verify_solution_json(&text(), &out.solution_json, true);
        assert_eq!(
            report.get("ok").and_then(|j| j.as_bool()),
            Some(true),
            "{}",
            report.to_pretty()
        );
        assert_eq!(
            out.solution
                .get("verify")
                .and_then(|j| j.get("ok"))
                .and_then(|j| j.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn tampered_timeline_is_rejected() {
        let cancel = aps_engine::engine::CancelToken::new();
        let out = solve_json(&text(), &opts(), &cancel);
        let mut sol = out.solution.clone();
        // 篡改：跳跃移动（连续性违约）
        if let Some(plan) = sol.get_mut("plan") {
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
        let report = verify_solution_json(&text(), &sol.to_compact(), false);
        assert_eq!(report.get("ok").and_then(|j| j.as_bool()), Some(false));
    }

    #[test]
    fn tampered_metrics_are_rejected() {
        let cancel = aps_engine::engine::CancelToken::new();
        let out = solve_json(&text(), &opts(), &cancel);
        let mut sol = out.solution.clone();
        if let Some(m) = sol.get_mut("metrics") {
            m.set("total_travel_steps", Json::int(999));
        }
        let report = verify_solution_json(&text(), &sol.to_compact(), false);
        assert_eq!(report.get("ok").and_then(|j| j.as_bool()), Some(false));
    }
}
