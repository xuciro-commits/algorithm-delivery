//! 独立轨迹核验器（SRS §4：验证器与求解器**不共用冲突判断代码**）。
//!
//! 设计：
//! * 输入是两段 **JSON 文本**（问题 + 方案）。不复用 `problem.rs` 的解析管线——本文件
//!   自行遍历 JSON、自行重建坐标/地图/事件窗口（仅有的共享是底层 JSON 词法，属于
//!   仓库公共契约层，与判断逻辑无关）。
//! * 全部机器人时间线**展开到核验时域**（到达后按 stay-at-target 驻留终点），然后：
//!   1. `map-obstacles`：每位置界内且非障碍（含 obstacle_add/remove 时间窗）；
//!   2. `step-legality`：每步 = 原地等待或四邻域移动；
//!   3. `vertex-conflict`：同刻同格（逐对独立扫描，非求解器的占用表法）；
//!   4. `edge-swap-conflict`：同一边相向交换（逐对独立扫描）；
//!   5. `goal-reach`：所有车在核验时域内到达各自目标并驻留；
//!   6. `goal-stay`：到达后必须永久驻留（首次到达后不得离开）；
//!   7. `objective-math`：SOC/Makespan 重算并与方案声明值比对；
//!   8. `status-integrity`：OPTIMAL 声明必须伴随 optimality_proven + 下界 ≥ 值；
//!      INFEASIBLE 声明不允许同时带方案；
//!   9. `frozen-prefix`（动态）：快照承诺前缀必须原样保留。
//!
//! `mapf verify` CLI 与浏览器 `mapf_verify` 导出都调用本模块。

use aps_engine::json::{parse, Json};

use crate::errors::{codes, SCHEMA_VERSION_SOLUTION};

#[derive(Debug, Clone)]
pub struct Violation {
    pub code: String,
    pub constraint: String,
    pub message: String,
    pub robots: Vec<String>,
    pub at_time: Option<u32>,
    pub cell: Option<(u32, u32)>,
    pub expected: Option<String>,
    pub actual: Option<String>,
}

impl Violation {
    fn new(code: &str, constraint: &str, message: impl Into<String>) -> Violation {
        Violation {
            code: code.to_string(),
            constraint: constraint.to_string(),
            message: message.into(),
            robots: Vec::new(),
            at_time: None,
            cell: None,
            expected: None,
            actual: None,
        }
    }
    fn at(mut self, t: u32) -> Violation {
        self.at_time = Some(t);
        self
    }
    fn cell_at(mut self, x: u32, y: u32) -> Violation {
        self.cell = Some((x, y));
        self
    }
    fn of(mut self, robots: &[&str]) -> Violation {
        self.robots = robots.iter().map(|r| r.to_string()).collect();
        self
    }
    fn cmp_vals(
        mut self,
        expected: impl std::fmt::Display,
        actual: impl std::fmt::Display,
    ) -> Violation {
        self.expected = Some(expected.to_string());
        self.actual = Some(actual.to_string());
        self
    }
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("code", Json::str(self.code.clone())),
            ("constraint", Json::str(self.constraint.clone())),
            ("severity", Json::str("error")),
            ("message", Json::str(self.message.clone())),
            ("robots", Json::strings(self.robots.clone())),
            ("at_time", Json::opt_int(self.at_time.map(|t| t as i64))),
            (
                "cell",
                match self.cell {
                    Some((x, y)) => Json::Arr(vec![Json::int(x as i64), Json::int(y as i64)]),
                    None => Json::Null,
                },
            ),
            ("expected", Json::opt_str(self.expected.clone())),
            ("actual", Json::opt_str(self.actual.clone())),
        ])
    }
}

/// 核验结果。
pub struct VerifyReport {
    pub ok: bool,
    pub violations: Vec<Violation>,
    /// 独立重算值（成功解析时给出）。
    pub recomputed: Option<(i64, i64, u32, bool)>, // soc, makespan, horizon, all_reached
    pub checks: Vec<(&'static str, bool)>,
}

impl VerifyReport {
    pub fn to_json(&self, strict: bool) -> Json {
        let counts = Json::obj(vec![(
            "violations",
            Json::int(self.violations.len() as i64),
        )]);
        let mut fields: Vec<(&str, Json)> = vec![
            (
                "schema_version",
                Json::str(crate::errors::SCHEMA_VERSION_VERIFY),
            ),
            (
                "mode",
                Json::str(if strict { "full+strict" } else { "full" }),
            ),
            ("ruleset_version", Json::str(crate::RULESET_VERSION)),
            ("ok", Json::Bool(self.ok)),
            ("counts", counts),
            (
                "checks",
                Json::Arr(
                    self.checks
                        .iter()
                        .map(|(n, ok)| {
                            Json::obj(vec![("name", Json::str(*n)), ("ok", Json::Bool(*ok))])
                        })
                        .collect(),
                ),
            ),
            (
                "violations",
                Json::Arr(self.violations.iter().map(|v| v.to_json()).collect()),
            ),
        ];
        if let Some((soc, mk, h, reached)) = self.recomputed {
            fields.push((
                "recomputed",
                Json::obj(vec![
                    ("soc", Json::int(soc)),
                    ("makespan", Json::int(mk)),
                    ("horizon", Json::int(h as i64)),
                    ("all_reached", Json::Bool(reached)),
                ]),
            ));
        } else {
            fields.push(("recomputed", Json::Null));
        }
        Json::obj(fields)
    }
}

/// 从问题 JSON 文本独立重建核验所需事实（自带一套解析，不走 problem.rs）。
struct Facts {
    width: u64,
    height: u64,
    /// 静态障碍（行主序）。
    blocked: Vec<bool>,
    robots: Vec<RobotSpec>,
    declared_horizon: Option<u64>,
    /// (cell_index, from, until_opt)
    obs_add: Vec<(u64, u64, Option<u64>)>,
    obs_remove: Vec<(u64, u64)>,
    goal_change: Vec<(String, (u64, u64), u64)>,
    /// 动态快照（冻结前缀核验）
    frozen: Option<FrozenSnapshot>,
    errors: Vec<Violation>,
}

struct FrozenRobot {
    id: String,
    path: Vec<(u64, u64)>,
    frozen_end: u64,
}
/// 机器人静态定义在核验期的紧凑形态：id / 起点 / 终点（栅格坐标）。
type RobotSpec = (String, (u64, u64), (u64, u64));

struct FrozenSnapshot {
    /// 快照时刻（解析期已校验取值域；核验逻辑经由各车 `frozen_end` 间接使用）
    #[allow(dead_code)]
    time: u64,
    robots: Vec<FrozenRobot>,
}

fn idx(f: &Facts, x: u64, y: u64) -> Option<u64> {
    if x < f.width && y < f.height {
        Some(y * f.width + x)
    } else {
        None
    }
}

fn parse_coord(j: &Json) -> Option<(u64, u64)> {
    let a = j.as_arr()?;
    if a.len() != 2 {
        return None;
    }
    let x = a[0].as_i64()?;
    let y = a[1].as_i64()?;
    if x < 0 || y < 0 {
        return None;
    }
    Some((x as u64, y as u64))
}

fn extract_facts(problem: &Json) -> Facts {
    let mut f = Facts {
        width: 0,
        height: 0,
        blocked: Vec::new(),
        robots: Vec::new(),
        declared_horizon: None,
        obs_add: Vec::new(),
        obs_remove: Vec::new(),
        goal_change: Vec::new(),
        frozen: None,
        errors: Vec::new(),
    };
    let push = |f: &mut Facts, v: Violation| f.errors.push(v);

    // —— map ——
    let Some(map) = problem.get("map").and_then(|m| m.as_obj()) else {
        push(
            &mut f,
            Violation::new(codes::SCHEMA, "map", "缺少 map 对象"),
        );
        return f;
    };
    let mut cells_rows: Vec<String> = Vec::new();
    let mut w: Option<u64> = None;
    let mut h: Option<u64> = None;
    for (k, v) in map {
        match k.as_str() {
            "width" => w = v.as_i64().map(|x| x.max(0) as u64),
            "height" => h = v.as_i64().map(|x| x.max(0) as u64),
            "cells" => {
                if let Some(items) = v.as_arr() {
                    for it in items {
                        match it.as_str() {
                            Some(s) => cells_rows.push(s.to_string()),
                            None => push(
                                &mut f,
                                Violation::new(codes::MAP_SHAPE, "map", "cells 行必须是字符串"),
                            ),
                        }
                    }
                }
            }
            "coordinates" => {
                if let Some(s) = v.as_str() {
                    if s != "x-right-y-down-origin-topleft" {
                        push(
                            &mut f,
                            Violation::new(
                                codes::SCHEMA,
                                "map",
                                format!("未知坐标约定 `{s}`（验证器只支持标准约定）"),
                            ),
                        );
                    }
                }
            }
            _ => {}
        }
    }
    if !cells_rows.is_empty() {
        f.width = cells_rows
            .iter()
            .map(|r| r.chars().count() as u64)
            .max()
            .unwrap_or(0);
        f.height = cells_rows.len() as u64;
        f.blocked = vec![true; (f.width * f.height) as usize];
        for (y, row) in cells_rows.iter().enumerate() {
            for (x, ch) in row.chars().enumerate() {
                f.blocked[y * (f.width as usize) + x] = !matches!(ch, '.' | ' ');
            }
        }
        if let Some(ww) = w {
            if ww != f.width {
                push(
                    &mut f,
                    Violation::new(codes::MAP_SHAPE, "map.width", "width 与 cells 行宽不一致"),
                );
            }
        }
        if let Some(hh) = h {
            if hh != f.height {
                push(
                    &mut f,
                    Violation::new(codes::MAP_SHAPE, "map.height", "height 与 cells 行数不一致"),
                );
            }
        }
    } else {
        let (Some(ww), Some(hh)) = (w, h) else {
            push(
                &mut f,
                Violation::new(
                    codes::SCHEMA,
                    "map",
                    "既无 cells 也无 width/height，无法重建地图",
                ),
            );
            return f;
        };
        f.width = ww;
        f.height = hh;
        f.blocked = vec![false; (ww * hh) as usize];
        if let Some(bl) = map.iter().find(|(k, _)| k == "blocked").map(|(_, v)| v) {
            if let Some(items) = bl.as_arr() {
                for it in items {
                    if let Some((x, y)) = parse_coord(it) {
                        match idx(&f, x, y) {
                            Some(i) => f.blocked[i as usize] = true,
                            None => push(
                                &mut f,
                                Violation::new(
                                    codes::COORD_RANGE,
                                    "map.blocked",
                                    format!("障碍坐标 ({x},{y}) 越界"),
                                ),
                            ),
                        }
                    } else {
                        push(
                            &mut f,
                            Violation::new(codes::SCHEMA, "map.blocked", "障碍项必须是 [x,y]"),
                        );
                    }
                }
            }
        }
    }
    if f.width == 0 || f.height == 0 {
        push(
            &mut f,
            Violation::new(codes::MAP_SHAPE, "map", "地图尺寸无效"),
        );
        return f;
    }

    // —— horizon ——
    if let Some(tm) = problem.get("time_model").and_then(|t| t.as_obj()) {
        for (k, v) in tm {
            if k == "horizon" {
                match v {
                    Json::Int(i) if *i > 0 => f.declared_horizon = Some(*i as u64),
                    Json::Float(x) if *x > 0.0 && x.fract() == 0.0 => {
                        f.declared_horizon = Some(*x as u64)
                    }
                    Json::Str(s) if s == "auto" => f.declared_horizon = None,
                    _ => push(
                        &mut f,
                        Violation::new(codes::HORIZON, "time_model.horizon", "horizon 非法"),
                    ),
                }
            }
        }
    }

    // —— robots ——
    let Some(items) = problem
        .get("robots")
        .and_then(|r| r.as_arr())
        .map(|a| a.to_vec())
    else {
        push(
            &mut f,
            Violation::new(codes::SCHEMA, "robots", "缺少 robots 数组"),
        );
        return f;
    };
    let mut seen_start: Vec<(u64, u64)> = Vec::new();
    let mut seen_goal: Vec<(u64, u64)> = Vec::new();
    for rj in &items {
        let Some(fields) = rj.as_obj() else {
            push(
                &mut f,
                Violation::new(codes::SCHEMA, "robots", "机器人项必须是对象"),
            );
            continue;
        };
        let mut id = String::new();
        let mut start = None;
        let mut goal = None;
        for (k, v) in fields {
            match k.as_str() {
                "id" => id = v.as_str().unwrap_or_default().to_string(),
                "start" => start = parse_coord(v),
                "goal" => goal = parse_coord(v),
                _ => {}
            }
        }
        let (Some(s), Some(g)) = (start, goal) else {
            push(
                &mut f,
                Violation::new(
                    codes::SCHEMA,
                    "robots",
                    format!("机器人 `{id}` 缺少 start/goal"),
                ),
            );
            continue;
        };
        for (p, what) in [(s, "起点"), (g, "终点")] {
            match idx(&f, p.0, p.1) {
                None => push(
                    &mut f,
                    Violation::new(
                        codes::COORD_RANGE,
                        "robots",
                        format!("机器人 `{id}` {what}越界"),
                    )
                    .cell_at(p.0 as u32, p.1 as u32),
                ),
                Some(ci) => {
                    if f.blocked[ci as usize] {
                        push(
                            &mut f,
                            Violation::new(
                                codes::SCHEMA,
                                "robots",
                                format!("机器人 `{id}` 的{what}位于障碍"),
                            )
                            .cell_at(p.0 as u32, p.1 as u32),
                        );
                    }
                }
            }
        }
        if seen_start.contains(&s) {
            push(
                &mut f,
                Violation::new(
                    codes::DUP_START,
                    "robots",
                    format!("重复起点：机器人 `{id}`"),
                ),
            );
        }
        if seen_goal.contains(&g) {
            push(
                &mut f,
                Violation::new(
                    codes::DUP_GOAL,
                    "robots",
                    format!("重复终点：机器人 `{id}`"),
                ),
            );
        }
        seen_start.push(s);
        seen_goal.push(g);
        f.robots.push((id, s, g));
    }

    // —— 动态块（自行重放事件语义）——
    if let Some(dyn_) = problem
        .get("dynamic")
        .and_then(|d| d.as_obj())
        .map(|kv| kv.to_vec())
    {
        let snap = dyn_.iter().find(|(k, _)| k == "snapshot").map(|(_, v)| v);
        if let Some(snap_obj) = snap.and_then(|s| s.as_obj()).map(|kv| kv.to_vec()) {
            let time = snap_obj
                .iter()
                .find(|(k, _)| k == "time")
                .and_then(|(_, v)| v.as_i64())
                .unwrap_or(0) as u64;
            let g_frozen = snap_obj
                .iter()
                .find(|(k, _)| k == "frozen_steps")
                .and_then(|(_, v)| v.as_i64())
                .unwrap_or(0)
                .max(0) as u64;
            let mut frozen = Vec::new();
            let mut path_map: Vec<(String, Vec<(u64, u64)>)> = Vec::new();
            let mut frozen_map: Vec<(String, u64)> = Vec::new();
            if let Some(ps) = snap_obj.iter().find(|(k, _)| k == "paths").map(|(_, v)| v) {
                if let Some(fields) = ps.as_obj() {
                    for (rid, arr) in fields {
                        if let Some(items) = arr.as_arr() {
                            let path: Vec<(u64, u64)> =
                                items.iter().filter_map(parse_coord).collect();
                            path_map.push((rid.clone(), path));
                        }
                    }
                }
            }
            if let Some(fz) = snap_obj.iter().find(|(k, _)| k == "frozen").map(|(_, v)| v) {
                if let Some(fields) = fz.as_obj() {
                    for (rid, v) in fields {
                        if let Some(n) = v.as_i64() {
                            frozen_map.push((rid.clone(), n.max(0) as u64));
                        }
                    }
                }
            }
            // 先收集事件（path_invalid/goal_change 会收缩/改写冻结窗）
            if let Some(evs) = dyn_
                .iter()
                .find(|(k, _)| k == "events")
                .map(|(_, v)| v)
                .and_then(|e| e.as_arr())
                .map(|a| a.to_vec())
            {
                for ev in &evs {
                    let Some(fields) = ev.as_obj() else { continue };
                    let kind = fields
                        .iter()
                        .find(|(k, _)| k == "type")
                        .and_then(|(_, v)| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let at = fields
                        .iter()
                        .find(|(k, _)| k == "at")
                        .and_then(|(_, v)| v.as_i64())
                        .unwrap_or(0)
                        .max(0) as u64;
                    match kind.as_str() {
                        "obstacle_add" | "add_obstacle" | "obstacle" => {
                            if let Some(c) = fields
                                .iter()
                                .find(|(k, _)| k == "cell")
                                .and_then(|(_, v)| parse_coord(v))
                            {
                                let until = fields
                                    .iter()
                                    .find(|(k, _)| k == "until")
                                    .and_then(|(_, v)| v.as_i64())
                                    .filter(|x| *x >= 0)
                                    .map(|x| x as u64);
                                f.obs_add.push((c.1 * f.width + c.0, at, until));
                            }
                        }
                        "obstacle_remove" | "remove_obstacle" => {
                            if let Some(c) = fields
                                .iter()
                                .find(|(k, _)| k == "cell")
                                .and_then(|(_, v)| parse_coord(v))
                            {
                                f.obs_remove.push((c.1 * f.width + c.0, at));
                            }
                        }
                        "goal_change" => {
                            let rid = fields
                                .iter()
                                .find(|(k, _)| k == "robot")
                                .and_then(|(_, v)| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            if let Some(g) = fields
                                .iter()
                                .find(|(k, _)| k == "goal")
                                .and_then(|(_, v)| parse_coord(v))
                            {
                                f.goal_change.push((rid, g, at));
                            }
                        }
                        "path_invalid" | "path_blocked" | "reroute" => {
                            if let Some(list) = fields
                                .iter()
                                .find(|(k, _)| k == "robots")
                                .and_then(|(_, v)| v.as_arr())
                            {
                                for it in list {
                                    if let Some(rid) = it.as_str() {
                                        frozen_map.push((rid.to_string(), at.saturating_sub(time)));
                                    }
                                }
                            }
                        }
                        _ => push(
                            &mut f,
                            Violation::new(
                                codes::EVENT_KIND,
                                "dynamic.events",
                                format!("未知事件类型 `{kind}`（验证器拒绝核验）"),
                            ),
                        ),
                    }
                }
            }
            for (id, _s, g) in &f.robots.clone() {
                let path = path_map
                    .iter()
                    .find(|(pid, _)| pid == id)
                    .map(|(_, p)| p.clone());
                let Some(path) = path else {
                    push(
                        &mut f,
                        Violation::new(
                            codes::SNAP_SHAPE,
                            "dynamic.snapshot.paths",
                            format!("机器人 `{id}` 缺少既有路径（无法核验冻结前缀）"),
                        ),
                    );
                    continue;
                };
                if path.len() as u64 <= time {
                    push(
                        &mut f,
                        Violation::new(
                            codes::SNAP_SHAPE,
                            "dynamic.snapshot.paths",
                            format!("机器人 `{id}` 路径未覆盖快照时刻"),
                        ),
                    );
                    continue;
                }
                let extra = frozen_map
                    .iter()
                    .filter(|(pid, _)| pid == id)
                    .map(|(_, n)| *n)
                    .min()
                    .unwrap_or(g_frozen);
                let goal = goal_for(&f, id, *g);
                let mut frozen_end = (time + extra).min(path.len() as u64 - 1);
                // 目标未变且快照路径已驻留终点 ⇒ 冻结至核验时域
                if goal_is_unchanged(&f, id, *g) && path.last().copied() == Some(goal) {
                    // 前缀尾已停在（未变更的）目标上：冻结延伸至整个已提供路径
                    frozen_end = frozen_end.max(path.len() as u64 - 1);
                }
                frozen.push(FrozenRobot {
                    id: id.clone(),
                    path: path.clone(),
                    frozen_end,
                });
            }
            f.frozen = Some(FrozenSnapshot {
                time,
                robots: frozen,
            });
        } else {
            push(
                &mut f,
                Violation::new(codes::SNAP_SHAPE, "dynamic.snapshot", "缺少 snapshot 对象"),
            );
        }
    }
    f
}

fn goal_for(f: &Facts, id: &str, original: (u64, u64)) -> (u64, u64) {
    f.goal_change
        .iter()
        .filter(|(rid, _, _)| rid == id)
        .next_back()
        .map(|(_, g, _)| *g)
        .unwrap_or(original)
}
fn goal_is_unchanged(f: &Facts, id: &str, original: (u64, u64)) -> bool {
    !f.goal_change
        .iter()
        .any(|(rid, g, _)| rid == id && *g != original)
}

fn blocked_at(f: &Facts, ci: u64, t: u64) -> bool {
    // 独立的时间重放：静态初始占用 → 按 (at, is_add) 排序的事件序列推进状态。
    let mut state = f.blocked.get(ci as usize).copied().unwrap_or(true);
    let mut evs: Vec<(u64, bool)> = Vec::new();
    for &(c, a, until) in &f.obs_add {
        if c == ci {
            evs.push((a, true));
            if let Some(u) = until {
                evs.push((u, false));
            }
        }
    }
    for &(c, a) in &f.obs_remove {
        if c == ci {
            evs.push((a, false));
        }
    }
    // 同时刻 tie：先 remove/失效（false）后 add（true）⇒ add 生效（保守封锁）。
    evs.sort_unstable();
    for (at, is_add) in evs {
        if at <= t {
            state = is_add;
        } else {
            break;
        }
    }
    state
}

/// 核验入口。`problem_text`/`solution_text` 为引擎契约的原始 JSON 文本。
pub fn verify_texts(problem_text: &str, solution_text: &str, strict: bool) -> VerifyReport {
    let Ok(problem) = parse(problem_text) else {
        return failed_report(vec![Violation::new(
            codes::BAD_JSON,
            "problem",
            "问题 JSON 无法解析",
        )]);
    };
    let Ok(solution) = parse(solution_text) else {
        return failed_report(vec![Violation::new(
            codes::BAD_JSON,
            "solution",
            "方案 JSON 无法解析",
        )]);
    };
    verify_json(&problem, &solution, strict)
}

pub fn verify_json(problem: &Json, solution: &Json, strict: bool) -> VerifyReport {
    let mut violations: Vec<Violation> = Vec::new();
    let mut checks: Vec<(&'static str, bool)> = Vec::new();
    let mut check = |name: &'static str, ok: bool| {
        checks.push((name, ok));
    };

    let mut facts = extract_facts(problem);
    violations.append(&mut facts.errors);
    let map_ok = violations.is_empty();
    check("map-obstacles", map_ok);
    if !map_ok {
        return VerifyReport {
            ok: false,
            violations,
            recomputed: None,
            checks,
        };
    }

    // —— 方案结构 ——
    let sv = solution
        .get("schema_version")
        .and_then(|s| s.as_str())
        .unwrap_or("");
    if sv != SCHEMA_VERSION_SOLUTION {
        violations.push(Violation::new(
            codes::SCHEMA,
            "contract",
            format!("方案 schema_version `{sv}` 不受支持"),
        ));
    }
    if strict {
        if let (Some(ph), Some(expect)) = (
            solution.get("problem_hash").and_then(|v| v.as_str()),
            problem_hash_of(problem),
        ) {
            if ph != expect {
                violations.push(
                    Violation::new(
                        codes::HASH_MISMATCH,
                        "contract",
                        "problem_hash 与问题不一致",
                    )
                    .cmp_vals(expect, ph.to_string()),
                );
            }
        } else {
            violations.push(Violation::new(
                codes::HASH_MISMATCH,
                "contract",
                "strict 模式要求方案携带 problem_hash",
            ));
        }
    }
    let status = solution
        .get("status")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let has_paths = solution
        .get("robots")
        .and_then(|r| r.as_arr())
        .map(|a| {
            a.iter().any(|it| {
                !it.get("path")
                    .and_then(|p| p.as_arr())
                    .unwrap_or(&[])
                    .is_empty()
            })
        })
        .unwrap_or(false);
    if !has_paths {
        // 无方案可核验：只回答“状态与路径自洽”。INFEASIBLE/UNKNOWN 等空方案 = 通过（无碰撞可言），
        // 而 OPTIMAL/FEASIBLE 空方案在下面 status-integrity 也会被拒。
        checks.push(("plan-consistency", true));
        return VerifyReport {
            ok: true,
            violations,
            recomputed: Some((0, 0, 0, false)),
            checks,
        };
    }

    // —— 展开时间线 ——
    let horizon_sol = solution
        .get("horizon")
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
        .max(0) as u64;
    let horizon_declared = facts.declared_horizon.unwrap_or(horizon_sol);
    let horizon = horizon_sol.max(horizon_declared);
    let robots_sol: Vec<&Json> = solution
        .get("robots")
        .and_then(|r| r.as_arr())
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    if robots_sol.len() != facts.robots.len() {
        violations.push(Violation::new(
            codes::SCHEMA,
            "robots",
            format!(
                "方案机器人数量 {} ≠ 问题 {}",
                robots_sol.len(),
                facts.robots.len()
            ),
        ));
        return finish_fail(violations, checks);
    }
    let n = robots_sol.len();
    let mut lines: Vec<Vec<(u64, u64)>> = Vec::with_capacity(n); // expanded: t in 0..=horizon
    let mut arrivals: Vec<u64> = vec![0; n];
    let mut goals: Vec<(u64, u64)> = Vec::with_capacity(n);
    let mut ids: Vec<String> = Vec::with_capacity(n);
    let mut goal_ok = true;
    let mut step_ok = true;
    for (i, rj) in robots_sol.iter().enumerate() {
        let id = rj
            .get("id")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        let (fid, fstart, fgoal_orig) = facts
            .robots
            .iter()
            .find(|(rid, _, _)| *rid == id)
            .cloned()
            .unwrap_or_else(|| (id.clone(), (u64::MAX, u64::MAX), (0, 0)));
        if fid != id {
            violations.push(Violation::new(
                codes::SCHEMA,
                "robots",
                format!("方案机器人 `{id}` 不在问题机器人集合中"),
            ));
            goal_ok = false;
        }
        let goal = goal_for(&facts, &id, fgoal_orig);
        let path_json: Vec<(u64, u64)> = match rj.get("path").and_then(|p| p.as_arr()) {
            Some(items) => items.iter().filter_map(parse_coord).collect(),
            None => {
                violations.push(Violation::new(
                    codes::SCHEMA,
                    "robots",
                    format!("机器人 `{id}` 缺少 path 数组"),
                ));
                Vec::new()
            }
        };
        if path_json.is_empty() {
            violations.push(
                Violation::new(codes::SCHEMA, "robots", format!("机器人 `{id}` path 为空"))
                    .of(&[id.as_str()]),
            );
            lines.push(vec![(u64::MAX, u64::MAX); horizon as usize + 1]);
            ids.push(id);
            goals.push(goal);
            goal_ok = false;
            continue;
        }
        if path_json[0] != fstart {
            violations.push(
                Violation::new(
                    codes::SCHEMA,
                    "robots",
                    format!("机器人 `{id}` 路径起点与问题 start 不一致"),
                )
                .of(&[id.as_str()])
                .cmp_vals(format!("{fstart:?}"), format!("{:?}", path_json[0])),
            );
        }
        // 每步合法性 + 障碍
        for t in 0..path_json.len() {
            let (x, y) = path_json[t];
            let Some(ci) = idx(&facts, x, y) else {
                violations.push(
                    Violation::new(
                        codes::WALL_ENTRY,
                        "step-legality",
                        format!("机器人 `{id}` 越界坐标"),
                    )
                    .at(t as u32)
                    .cell_at(x as u32, y as u32),
                );
                step_ok = false;
                break;
            };
            if blocked_at(&facts, ci, t as u64) {
                violations.push(
                    Violation::new(
                        codes::WALL_ENTRY,
                        "map-obstacles",
                        format!("机器人 `{id}` 进入障碍/封锁格"),
                    )
                    .at(t as u32)
                    .cell_at(x as u32, y as u32),
                );
                step_ok = false;
                break;
            }
            if t > 0 {
                let (px, py) = path_json[t - 1];
                let d = x.abs_diff(px) + y.abs_diff(py);
                if d != 0 && d != 1 {
                    violations.push(
                        Violation::new(
                            codes::MOVE_ILLEGAL,
                            "step-legality",
                            format!("机器人 `{id}` 第 {t} 步非法（非 wait/四邻域）"),
                        )
                        .at(t as u32 - 1),
                    );
                    step_ok = false;
                }
            }
        }
        let last = *path_json.last().unwrap();
        if last != goal {
            violations.push(
                Violation::new(
                    codes::GOAL_UNREACHED,
                    "goal-reach",
                    format!("机器人 `{id}` 路径终止单元不是其目标"),
                )
                .of(&[id.as_str()])
                .cell_at(goal.0 as u32, goal.1 as u32)
                .cmp_vals(
                    format!("({},{})", goal.0, goal.1),
                    format!("({},{})", last.0, last.1),
                ),
            );
            goal_ok = false;
        }
        let claimed_arrival = rj
            .get("arrival")
            .and_then(|v| v.as_i64())
            .map(|a| a.max(0) as u64);
        if let Some(a) = claimed_arrival {
            if a != path_json.len() as u64 - 1 {
                violations.push(
                    Violation::new(
                        codes::SCHEMA,
                        "robots",
                        format!("机器人 `{id}` arrival 与 path 长度不一致"),
                    )
                    .cmp_vals((path_json.len() - 1) as i64, a as i64),
                );
            }
        }
        let mut line = path_json.clone();
        while (line.len() as u64) <= horizon {
            line.push(goal);
        }
        // 契约规定 path 截断于首次到达（到达即终止）⇒ arrival = len(path)-1
        arrivals[i] = path_json.len() as u64 - 1;
        lines.push(line);
        ids.push(id);
        goals.push(goal);
    }
    check("goal-reach", goal_ok);
    check("step-legality", step_ok);

    // —— 顶点 / 边交换冲突（逐对独立扫描；与求解器的占用表实现不同）——
    let mut vertex_ok = true;
    let mut edge_ok = true;
    'pair: for a in 0..n {
        for b in a + 1..n {
            for t in 0..=horizon {
                if lines[a][t as usize] == lines[b][t as usize] {
                    violations.push(
                        Violation::new(
                            codes::CONFLICT_VERTEX,
                            "vertex-conflict",
                            "两台机器人在同一时刻占据同一单元",
                        )
                        .of(&[ids[a].as_str(), ids[b].as_str()])
                        .at(t as u32)
                        .cell_at(lines[a][t as usize].0 as u32, lines[a][t as usize].1 as u32),
                    );
                    vertex_ok = false;
                    break 'pair;
                }
            }
            for t in 0..horizon {
                let a0 = lines[a][t as usize];
                let a1 = lines[a][t as usize + 1];
                let b0 = lines[b][t as usize];
                let b1 = lines[b][t as usize + 1];
                if a1 == b0 && b1 == a0 && a0 != a1 {
                    violations.push(
                        Violation::new(
                            codes::CONFLICT_EDGE,
                            "edge-swap-conflict",
                            "同一时步沿同一条边相向交换",
                        )
                        .of(&[ids[a].as_str(), ids[b].as_str()])
                        .at(t as u32),
                    );
                    edge_ok = false;
                    break;
                }
            }
        }
    }
    check("vertex-conflict", vertex_ok);
    check("edge-swap-conflict", edge_ok);

    // —— goal-stay：到达后直到 horizon 恒为目标（展开时按驻留构造；核验 arrival 语义）——
    let mut stay_ok = true;
    for i in 0..n {
        let a = arrivals[i];
        for t in a..=horizon {
            if lines[i][t as usize] != goals[i] {
                violations.push(
                    Violation::new(
                        codes::GOAL_OCCUPY,
                        "goal-stay",
                        format!("机器人 `{}` 到达后离开了终点（stay-at-target）", ids[i]),
                    )
                    .of(&[ids[i].as_str()])
                    .at(t as u32),
                );
                stay_ok = false;
                break;
            }
        }
    }
    check("goal-stay", stay_ok);

    // —— objective 重算 ——
    let soc: i64 = arrivals.iter().map(|a| *a as i64).sum();
    let makespan: i64 = arrivals.iter().copied().max().unwrap_or(0) as i64;
    let obj_kind = solution
        .get("objective")
        .and_then(|o| o.get("kind"))
        .and_then(|k| k.as_str())
        .unwrap_or("soc")
        .to_string();
    let reported = solution
        .get("objective")
        .and_then(|o| o.get("value"))
        .and_then(|v| v.as_i64());
    let mut obj_ok = true;
    match reported {
        Some(rv) => {
            let expected = if obj_kind == "makespan" {
                makespan
            } else {
                soc
            };
            if rv != expected {
                let code = if obj_kind == "makespan" {
                    codes::OBJ_MAKESPAN
                } else {
                    codes::OBJ_SOC
                };
                violations.push(
                    Violation::new(code, "objective-math", "目标函数值与独立重算不一致")
                        .cmp_vals(expected, rv),
                );
                obj_ok = false;
            }
        }
        None => {
            violations.push(Violation::new(
                codes::SCHEMA,
                "objective-math",
                "成功状态缺少 objective.value",
            ));
            obj_ok = false;
        }
    }
    // SOC 与 Makespan 同时报告（契约字段），一并核对
    let soc_rep = solution.get("soc").and_then(|v| v.as_i64());
    if let Some(x) = soc_rep {
        if x != soc {
            violations.push(
                Violation::new(codes::OBJ_SOC, "objective-math", "顶层 soc 与重算不一致")
                    .cmp_vals(soc, x),
            );
            obj_ok = false;
        }
    }
    let mk_rep = solution.get("makespan").and_then(|v| v.as_i64());
    if let Some(x) = mk_rep {
        if x != makespan {
            violations.push(
                Violation::new(
                    codes::OBJ_MAKESPAN,
                    "objective-math",
                    "顶层 makespan 与重算不一致",
                )
                .cmp_vals(makespan, x),
            );
            obj_ok = false;
        }
    }
    check("objective-math", obj_ok);

    // —— 冻结前缀 ——
    let mut frozen_ok = true;
    if let Some(fs) = &facts.frozen {
        for fr in &fs.robots {
            if let Some(i) = (0..n).find(|&i| ids[i] == fr.id) {
                for (t, (x, y)) in fr.path.iter().take(fr.frozen_end as usize + 1).enumerate() {
                    if (t as u64) > horizon {
                        break;
                    }
                    if lines[i][t] != (*x, *y) {
                        violations.push(
                            Violation::new(
                                codes::FROZEN_BROKEN,
                                "frozen-prefix",
                                format!("机器人 `{}` 第 {t} 步偏离冻结前缀", fr.id),
                            )
                            .of(&[fr.id.as_str()])
                            .at(t as u32)
                            .cmp_vals(
                                format!("({x},{y})"),
                                format!("({},{})", lines[i][t].0, lines[i][t].1),
                            ),
                        );
                        frozen_ok = false;
                        break;
                    }
                }
            }
        }
    }
    check("frozen-prefix", frozen_ok);

    // —— 状态自洽 ——
    let mut status_ok = true;
    if status == "OPTIMAL" {
        let proven = solution
            .get("optimality_proven")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let w = solution
            .get("objective")
            .and_then(|o| o.get("suboptimality_factor"))
            .and_then(|v| v.as_f64())
            .unwrap_or(1.0);
        let lb_opt = solution
            .get("objective")
            .and_then(|o| o.get("lower_bound"))
            .and_then(|v| v.as_i64());
        let expected = if obj_kind == "makespan" {
            makespan
        } else {
            soc
        };
        if !proven {
            violations.push(Violation::new(
                codes::PROOF_INVALID,
                "status-integrity",
                "OPTIMAL 缺少 optimality_proven 证明标记",
            ));
            status_ok = false;
        } else if w > 1.0 && lb_opt != Some(expected) {
            // 有界次优搜索（w>1）也可“追平下界”而证明最优；只有未追平时才不得宣称 OPTIMAL。
            violations.push(Violation::new(
                codes::PROOF_INVALID,
                "status-integrity",
                "w>1 且下界未追平解值：只能声明 FEASIBLE（附差距界）",
            ));
            status_ok = false;
        }
        if let Some(lb) = lb_opt {
            if lb > expected {
                violations.push(
                    Violation::new(
                        codes::PROOF_INVALID,
                        "status-integrity",
                        "下界大于解值：下界无效",
                    )
                    .cmp_vals(format!("≤ {expected}"), lb.to_string()),
                );
                status_ok = false;
            }
        }
    }
    if status == "INFEASIBLE" {
        let has_plan = robots_sol.iter().any(|r| {
            r.get("path")
                .map(|p| !p.as_arr().map(|a| a.is_empty()).unwrap_or(true))
                .unwrap_or(false)
        });
        if has_plan {
            violations.push(Violation::new(
                codes::PROOF_INVALID,
                "status-integrity",
                "INFEASIBLE 状态不得携带方案路径",
            ));
            status_ok = false;
        }
    }
    check("status-integrity", status_ok);

    VerifyReport {
        ok: violations.is_empty(),
        violations,
        recomputed: Some((soc, makespan, horizon as u32, goal_ok)),
        checks,
    }
}

fn finish_fail(violations: Vec<Violation>, checks: Vec<(&'static str, bool)>) -> VerifyReport {
    VerifyReport {
        ok: false,
        violations,
        recomputed: None,
        checks,
    }
}

fn failed_report(v: Vec<Violation>) -> VerifyReport {
    VerifyReport {
        ok: false,
        violations: v,
        recomputed: None,
        checks: vec![("parse", false)],
    }
}

/// 计算问题哈希（canonical → sha256），供 strict 核验使用。
fn problem_hash_of(problem: &Json) -> Option<String> {
    Some(aps_engine::hash::problem_hash_of_canonical(
        &problem.canonical(),
    ))
}

/// 独立复算入口（供 bench 与测试使用）：给定问题与方案文本，返回报告 JSON。
pub fn verify_report_json(problem_text: &str, solution_text: &str, strict: bool) -> Json {
    verify_texts(problem_text, solution_text, strict).to_json(strict)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aps_engine::json::Json;

    fn tiny_problem() -> Json {
        Json::obj(vec![
            (
                "schema_version",
                Json::str(crate::errors::SCHEMA_VERSION_PROBLEM),
            ),
            ("id", Json::str("verify-tiny")),
            (
                "map",
                Json::obj(vec![(
                    "cells",
                    Json::Arr(vec![Json::str("...."), Json::str("....")]),
                )]),
            ),
            (
                "robots",
                Json::Arr(vec![
                    Json::obj(vec![
                        ("id", Json::str("A")),
                        ("start", Json::Arr(vec![Json::int(0), Json::int(0)])),
                        ("goal", Json::Arr(vec![Json::int(3), Json::int(0)])),
                    ]),
                    Json::obj(vec![
                        ("id", Json::str("B")),
                        ("start", Json::Arr(vec![Json::int(3), Json::int(1)])),
                        ("goal", Json::Arr(vec![Json::int(0), Json::int(1)])),
                    ]),
                ]),
            ),
            ("time_model", Json::obj(vec![("horizon", Json::int(6))])),
            ("objective", Json::obj(vec![("kind", Json::str("soc"))])),
        ])
    }

    fn solution(paths: Vec<(&str, Vec<[i64; 2]>)>, soc: i64, makespan: i64) -> Json {
        let robots: Vec<Json> = paths
            .into_iter()
            .map(|(id, p)| {
                Json::obj(vec![
                    ("id", Json::str(id)),
                    ("arrival", Json::int(p.len() as i64 - 1)),
                    (
                        "path",
                        Json::Arr(
                            p.into_iter()
                                .map(|[x, y]| Json::Arr(vec![Json::int(x), Json::int(y)]))
                                .collect(),
                        ),
                    ),
                ])
            })
            .collect();
        Json::obj(vec![
            ("schema_version", Json::str(SCHEMA_VERSION_SOLUTION)),
            ("status", Json::str("FEASIBLE")),
            ("horizon", Json::int(6)),
            ("soc", Json::int(soc)),
            ("makespan", Json::int(makespan)),
            (
                "objective",
                Json::obj(vec![("kind", Json::str("soc")), ("value", Json::int(soc))]),
            ),
            ("robots", Json::Arr(robots)),
        ])
    }

    #[test]
    fn accepts_valid_plan() {
        let prob = tiny_problem().to_compact();
        let sol = solution(
            vec![
                ("A", vec![[0, 0], [1, 0], [2, 0], [3, 0]]),
                ("B", vec![[3, 1], [2, 1], [1, 1], [0, 1]]),
            ],
            6,
            3,
        )
        .to_compact();
        let rep = verify_texts(&prob, &sol, false);
        assert!(
            rep.ok,
            "{:?}",
            rep.violations
                .iter()
                .map(|v| &v.message)
                .collect::<Vec<_>>()
        );
        assert_eq!(rep.recomputed, Some((6, 3, 6, true)));
    }

    #[test]
    fn catches_vertex_and_edge_conflicts() {
        // 顶点冲突：A、B 同时到达 (2,0)/(1,1)? 构造同格
        let prob = tiny_problem().to_compact();
        let sol = solution(
            vec![
                ("A", vec![[0, 0], [1, 0], [2, 0], [3, 0]]),
                ("B", vec![[3, 1], [2, 1], [2, 0], [3, 0]]), // t=2 与 A 同格，且 B 未到目标
            ],
            6,
            3,
        )
        .to_compact();
        let rep = verify_texts(&prob, &sol, false);
        assert!(!rep.ok);
        assert!(rep
            .violations
            .iter()
            .any(|v| v.code == codes::CONFLICT_VERTEX));
    }

    #[test]
    fn catches_wall_and_illegal_step_and_wrong_objective() {
        let mut prob = tiny_problem();
        prob.get_mut("map").unwrap().set(
            "cells",
            Json::Arr(vec![Json::str("..*."), Json::str("....")]),
        );
        let prob = prob.to_compact();
        let sol = solution(
            vec![
                ("A", vec![[0, 0], [1, 0], [2, 0], [3, 0]]), // 穿墙
                ("B", vec![[3, 1], [1, 1], [0, 1]]),         // 跳跃
            ],
            10, // 故意报错的 SOC
            3,
        )
        .to_compact();
        let rep = verify_texts(&prob, &sol, false);
        assert!(rep.violations.iter().any(|v| v.code == codes::WALL_ENTRY));
        assert!(rep.violations.iter().any(|v| v.code == codes::MOVE_ILLEGAL));
        assert!(rep.violations.iter().any(|v| v.code == codes::OBJ_SOC));
    }
}
