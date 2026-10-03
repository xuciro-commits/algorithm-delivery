//! `mapf-problem/1.0` 契约解析 + 语义校验（SRS §3）。
//!
//! 数学模型（详见 `docs/MODEL-MATH.md`）：有限二维栅格 G=(V,E)；机器人
//! r=(id, s, g)；离散同步时步；动作 = {wait, ↑, ↓, ←, →}；顶点冲突、对向边交换
//! 冲突、障碍、**stay-at-target**（到达后持续占用终点）与声明时域约束。
//!
//! 校验分层（先结构后语义，全部错误一次性收集、字段级定位）：
//! 1. JSON 可解析（`E-MAPF-BAD-JSON`）；
//! 2. 契约结构（`E-MAPF-SCHEMA` / `E-MAPF-MISSING-FIELD` / `E-MAPF-UNKNOWN-FIELD`(warning)）；
//! 3. 语义（重复起点/终点、非法坐标、越界、快照自洽性……SRS §2.1 要求必须作为输入错误处理）；
//! 4. 能力门控（请求了声明外特性 → `UNSUPPORTED`，不静默忽略）。

use aps_engine::json::Json;

use crate::capabilities::Profile;
use crate::errors::{codes, Issue, Severity};

/// 栅格单元编码：`cell = y * width + x`，`x` 向右、`y` 向下，`(0,0)` 为地图文本第一行第一列
/// （与 Moving AI `.map` 文件行序一致）。
pub type Cell = u32;

/// 静态栅格地图。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MapData {
    pub width: u32,
    pub height: u32,
    /// 行主序占用位（true = 障碍）。
    pub blocked: Vec<bool>,
}

impl MapData {
    pub fn n_cells(&self) -> usize {
        (self.width * self.height) as usize
    }
    #[inline]
    pub fn cell(&self, x: u32, y: u32) -> Option<Cell> {
        if x < self.width && y < self.height {
            Some(y * self.width + x)
        } else {
            None
        }
    }
    #[inline]
    pub fn x_of(&self, c: Cell) -> u32 {
        c % self.width
    }
    #[inline]
    pub fn y_of(&self, c: Cell) -> u32 {
        c / self.width
    }
    #[inline]
    pub fn is_blocked_static(&self, c: Cell) -> bool {
        self.blocked[c as usize]
    }
    /// 四邻域（含越界/障碍过滤）。顺序固定：wait, E, W, N, S —— 求解器与测试共享该确定性约定，
    /// 但**独立验证器不使用本方法**（verify.rs 自带一份实现，见 SRS §4 独立性要求）。
    pub fn neighbors(&self, c: Cell) -> [Cell; 5] {
        let x = self.x_of(c);
        let y = self.y_of(c);
        let w = self.width;
        [
            c,
            if x + 1 < w { c + 1 } else { u32::MAX },
            if x > 0 { c - 1 } else { u32::MAX },
            if y > 0 { c - w } else { u32::MAX },
            if y + 1 < self.height { c + w } else { u32::MAX },
        ]
    }
    #[inline]
    pub fn manhattan(&self, a: Cell, b: Cell) -> u32 {
        let ax = self.x_of(a);
        let ay = self.y_of(a);
        let bx = self.x_of(b);
        let by = self.y_of(b);
        ax.abs_diff(bx) + ay.abs_diff(by)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Objective {
    Soc,
    Makespan,
}

impl Objective {
    pub fn as_str(self) -> &'static str {
        match self {
            Objective::Soc => "soc",
            Objective::Makespan => "makespan",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlannerKind {
    /// PP 首解 + ECBS/CBS 改进（默认）。
    Auto,
    /// 仅联合搜索（ECBS/CBS）。
    Ecbs,
    /// 仅分优先级贪心（快速可行解，不证明最优，w 无意义）。
    Pp,
}

/// 求解器参数（`solver` 块；全部可复现：固定 seed + 预算 + 版本 ⇒ 同一语义结果）。
#[derive(Debug, Clone)]
pub struct SolverCfg {
    pub planner: PlannerKind,
    pub time_limit_ms: i64,
    pub seed: u64,
    /// ECBS 次优因子 w ∈ [1.0, 3.0]；1.0 = 最优搜索（CBS 语义）。
    pub w: f64,
    /// 高层节点扩展上限（0 = 仅受预算约束）。
    pub max_expansions: usize,
    pub warm_start: bool,
    /// 时域来源标记：true = 引擎自动推导（影响 INFEASIBLE 证明资格，见 docs/MODEL-MATH.md §4）。
    pub horizon_auto: bool,
}

impl Default for SolverCfg {
    fn default() -> Self {
        SolverCfg {
            planner: PlannerKind::Auto,
            time_limit_ms: 10_000,
            seed: 42,
            w: 1.0,
            max_expansions: 0,
            warm_start: true,
            horizon_auto: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Robot {
    pub id: String,
    pub start: Cell,
    pub goal: Cell,
}

/// 公开基准溯源（SRS §3：可选；固定基准清单的字段镜像，便于逐实例审计）。
#[derive(Debug, Clone, Default)]
pub struct BenchMeta {
    pub source: String,
    pub map_file: String,
    pub scen_file: String,
    pub map_sha256: String,
    pub scen_sha256: String,
    pub instance_id: i64,
    pub agents: i64,
    pub converter_version: String,
}

/// 动态事件（SRS §2.2 三类变化的封闭枚举）。
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    ObstacleAdd {
        cell: Cell,
        at: u32,
        until: Option<u32>,
    },
    ObstacleRemove {
        cell: Cell,
        at: u32,
    },
    GoalChange {
        robot: usize,
        goal: Cell,
        at: u32,
    },
    PathInvalid {
        robots: Vec<usize>,
        at: u32,
    },
}

/// 动态重规划输入：执行快照 + 事件（SRS §2.2）。
#[derive(Debug, Clone)]
pub struct DynamicInput {
    /// 快照时刻 t₀（已执行到 t₀；0 ≤ t₀ ≤ horizon）。
    pub time: u32,
    /// 每车额外冻结的**未来**步数 fᵢ ≥ 0（承诺前缀 = t₀..=t₀+fᵢ，t₀ 本身总被冻结）。
    pub frozen_extra: Vec<u32>,
    /// 每车既有完整时间线（位置序列，t=0..；到达终点后可截断，视为驻留）。
    pub prior_paths: Vec<Vec<Cell>>,
    pub events: Vec<Event>,
}

/// 校验完成的实例（引擎的权威内部表示；validate→compile 之后不再回读原始 JSON）。
#[derive(Debug, Clone)]
pub struct Problem {
    pub id: String,
    pub map: MapData,
    pub robots: Vec<Robot>,
    pub horizon: u32,
    pub objective: Objective,
    pub solver: SolverCfg,
    pub bench: Option<BenchMeta>,
    pub dynamic: Option<DynamicInput>,
    /// 输入中声明的坐标约定原文（未声明时为标准约定）。
    pub coordinate_convention: String,
}

impl Problem {
    /// 静态占用：把动态障碍窗口压缩成“时域内某点是否可进入”的判定闭包。
    /// 返回 (cell → 有序窗口 Vec<(start,end)>，end 为开区间，u32::MAX=∞)。
    pub fn blocked_windows(&self) -> Vec<Vec<(u32, u32)>> {
        let mut win: Vec<Vec<(u32, u32)>> = vec![Vec::new(); self.map.n_cells()];
        for c in 0..self.map.n_cells() as u32 {
            if self.map.is_blocked_static(c) {
                win[c as usize].push((0, u32::MAX));
            }
        }
        if let Some(dyn_) = &self.dynamic {
            for ev in &dyn_.events {
                if let Event::ObstacleAdd { cell, at, until } = ev {
                    win[*cell as usize].push((*at, until.unwrap_or(u32::MAX)));
                }
            }
        }
        for wv in win.iter_mut() {
            if wv.len() > 1 {
                wv.sort_unstable();
                let mut merged: Vec<(u32, u32)> = Vec::with_capacity(wv.len());
                for &(a, b) in wv.iter() {
                    match merged.last_mut() {
                        Some(last) if a <= last.1 => {
                            if b > last.1 {
                                last.1 = b;
                            }
                        }
                        _ => merged.push((a, b)),
                    }
                }
                *wv = merged;
            }
        }
        win
    }

    /// `obstacle_remove` 生效后的“解禁”窗口（静态障碍被移除的时段可用）。
    pub fn free_windows_of_blocked(&self) -> Vec<Vec<(u32, u32)>> {
        let mut win: Vec<Vec<(u32, u32)>> = vec![Vec::new(); self.map.n_cells()];
        if let Some(dyn_) = &self.dynamic {
            for ev in &dyn_.events {
                if let Event::ObstacleRemove { cell, at } = ev {
                    win[*cell as usize].push((*at, u32::MAX));
                }
            }
        }
        win
    }
}

// ---------------------------------------------------------------- 解析入口

/// 解析失败分类：结构/语义错误（`INVALID_INPUT`）与能力拒绝（`UNSUPPORTED`）。
#[derive(Debug)]
pub struct ParseFailure {
    pub issues: Vec<Issue>,
    /// true ⇒ 引擎状态为 `UNSUPPORTED`，否则 `INVALID_INPUT`。
    pub unsupported: bool,
}

impl ParseFailure {
    fn invalid(issues: Vec<Issue>) -> ParseFailure {
        ParseFailure {
            issues,
            unsupported: false,
        }
    }
    fn unsupported(issues: Vec<Issue>) -> ParseFailure {
        ParseFailure {
            issues,
            unsupported: true,
        }
    }
}

/// 解析并校验 `MapfProblem` 文本。
pub fn parse_problem(text: &str, profile: Profile) -> Result<Problem, ParseFailure> {
    let root = match aps_engine::json::parse(text) {
        Ok(j) => j,
        Err(e) => {
            return Err(ParseFailure::invalid(vec![Issue::error(
                codes::BAD_JSON,
                "$",
                e.to_string(),
            )]))
        }
    };
    let mut v = Validator::new();
    let p = build_problem(&root, profile, &mut v);
    let issues = std::mem::take(&mut v.issues);
    let unsup = v.unsupported;
    // 结构问题优先于语义结果：只要存在 error 级 Issue 就拒绝。
    if issues.iter().any(|i| i.severity == Severity::Error) || unsup {
        return Err(if unsup {
            ParseFailure::unsupported(issues)
        } else {
            ParseFailure::invalid(issues)
        });
    }
    let p = p.ok_or_else(|| ParseFailure::invalid(issues))?;
    Ok(p)
}

struct Validator {
    issues: Vec<Issue>,
    unsupported: bool,
}

impl Validator {
    fn new() -> Validator {
        Validator {
            issues: Vec::new(),
            unsupported: false,
        }
    }
    fn err(&mut self, code: &str, path: impl Into<String>, msg: impl Into<String>) {
        self.issues.push(Issue::error(code, path, msg));
    }
    fn warn(&mut self, code: &str, path: impl Into<String>, msg: impl Into<String>) {
        self.issues.push(Issue::warning(code, path, msg));
    }
    fn unsupported(&mut self, path: impl Into<String>, msg: impl Into<String>) {
        self.unsupported = true;
        self.issues
            .push(Issue::error(codes::UNSUPPORTED_FEATURE, path, msg));
    }
    /// 检查对象未知字段（未知 = warning 标注；命中声明外特性键名 = UNSUPPORTED）。
    fn check_unknown(&mut self, obj: &Json, known: &[&str], path: &str) {
        if let Some(fields) = obj.as_obj() {
            for (k, _) in fields {
                if !known.contains(&k.as_str()) {
                    if is_feature_request(k) {
                        self.unsupported(format!("{path}.{k}"), format!("字段 `{k}` 声明了引擎能力之外的特性（见 mapf-capabilities.unsupported_features）"));
                    } else {
                        self.warn(
                            codes::UNKNOWN_FIELD,
                            format!("{path}.{k}"),
                            "契约未定义此字段：已标注但不影响求解",
                        );
                    }
                }
            }
        }
    }
}

/// 声明外特性字段名（SRS §2.3：不得静默忽略）。
fn is_feature_request(key: &str) -> bool {
    matches!(
        key,
        "diagonal"
            | "diagonal_moves"
            | "allow_diagonal"
            | "action_duration"
            | "action_durations"
            | "kinematics"
            | "pickup_delivery"
            | "pud"
            | "collision_matrix"
            | "priority_rules"
            | "traffic_rules"
            | "task_assignment"
            | "orders"
            | "charging"
            | "multi_floor"
            | "cell_costs"
            | "weighted"
    )
}

fn expect_obj<'a>(v: &mut Validator, j: &'a Json, path: &str) -> Option<&'a Json> {
    if j.as_obj().is_some() {
        Some(j)
    } else {
        v.err(
            codes::SCHEMA,
            path.to_string(),
            format!("应为 object，实际为 {}", j.type_name()),
        );
        None
    }
}

fn take_str(
    v: &mut Validator,
    obj: &Json,
    key: &str,
    path: &str,
    required: bool,
) -> Option<String> {
    match obj.get(key) {
        None | Some(Json::Null) => {
            if required {
                v.err(
                    codes::MISSING_FIELD,
                    format!("{path}.{key}"),
                    "缺少必填字符串字段",
                );
            }
            None
        }
        Some(Json::Str(s)) => Some(s.clone()),
        Some(other) => {
            v.err(
                codes::SCHEMA,
                format!("{path}.{key}"),
                format!("应为 string，实际为 {}", other.type_name()),
            );
            None
        }
    }
}

fn take_int(v: &mut Validator, obj: &Json, key: &str, path: &str, required: bool) -> Option<i64> {
    match obj.get(key) {
        None | Some(Json::Null) => {
            if required {
                v.err(
                    codes::MISSING_FIELD,
                    format!("{path}.{key}"),
                    "缺少必填整数字段",
                );
            }
            None
        }
        Some(Json::Int(i)) => Some(*i),
        Some(Json::Float(f)) if f.fract() == 0.0 && f.abs() < 9.2e18 => Some(*f as i64),
        Some(other) => {
            v.err(
                codes::SCHEMA,
                format!("{path}.{key}"),
                format!("应为整数，实际为 {}", other.type_name()),
            );
            None
        }
    }
}

fn take_float(v: &mut Validator, obj: &Json, key: &str, path: &str, default: f64) -> f64 {
    match obj.get(key) {
        None | Some(Json::Null) => default,
        Some(Json::Int(i)) => *i as f64,
        Some(Json::Float(f)) => *f,
        Some(other) => {
            v.err(
                codes::SCHEMA,
                format!("{path}.{key}"),
                format!("应为数值，实际为 {}", other.type_name()),
            );
            default
        }
    }
}

fn take_bool(v: &mut Validator, obj: &Json, key: &str, path: &str, default: bool) -> bool {
    match obj.get(key) {
        None | Some(Json::Null) => default,
        Some(Json::Bool(b)) => *b,
        Some(other) => {
            v.err(
                codes::SCHEMA,
                format!("{path}.{key}"),
                format!("应为 boolean，实际为 {}", other.type_name()),
            );
            default
        }
    }
}

/// 坐标对 `[x, y]` → Cell（越界记 error 返回 None）。
fn take_coord(
    v: &mut Validator,
    j: &Json,
    path: &str,
    map: &MapData,
    required: bool,
) -> Option<Cell> {
    if j.is_null() {
        if required {
            v.err(codes::MISSING_FIELD, path.to_string(), "缺少坐标 [x, y]");
        }
        return None;
    }
    let arr = match j.as_arr() {
        Some(a) if a.len() == 2 => a,
        Some(_) => {
            v.err(
                codes::SCHEMA,
                path.to_string(),
                "坐标必须是 [x, y] 两元数组",
            );
            return None;
        }
        None => {
            v.err(
                codes::SCHEMA,
                path.to_string(),
                format!("坐标应为数组，实际为 {}", j.type_name()),
            );
            return None;
        }
    };
    let xi = arr[0].as_i64();
    let yi = arr[1].as_i64();
    match (xi, yi) {
        (Some(x), Some(y)) if x >= 0 && y >= 0 => match map.cell(x as u32, y as u32) {
            Some(c) => Some(c),
            None => {
                v.err(
                    codes::COORD_RANGE,
                    path.to_string(),
                    format!(
                        "坐标 ({x},{y}) 越界：地图有效范围 x∈[0,{}), y∈[0,{})",
                        map.width, map.height
                    ),
                );
                None
            }
        },
        _ => {
            v.err(codes::SCHEMA, path.to_string(), "坐标必须是非负整数");
            None
        }
    }
}

fn build_problem(root: &Json, profile: Profile, v: &mut Validator) -> Option<Problem> {
    let root = expect_obj(v, root, "$")?;

    v.check_unknown(
        root,
        &[
            "schema_version",
            "id",
            "created_at",
            "map",
            "time_model",
            "movement",
            "robots",
            "objective",
            "solver",
            "benchmark",
            "dynamic",
            "tags",
            "notes",
        ],
        "$",
    );

    // schema_version：缺省按 1.0 处理但给 warning；未知版本直接拒绝。
    match root.get("schema_version").and_then(|s| s.as_str()) {
        None => v.warn(
            codes::SCHEMA,
            "$.schema_version",
            "未声明 schema_version，按 mapf-problem/1.0 解析",
        ),
        Some(crate::errors::SCHEMA_VERSION_PROBLEM) => {}
        Some(other) => {
            v.err(
                codes::SCHEMA,
                "$.schema_version",
                format!(
                    "不支持的问题契约版本 `{other}`（本引擎：{}）",
                    crate::errors::SCHEMA_VERSION_PROBLEM
                ),
            );
        }
    }
    let id = take_str(v, root, "id", "$", false).unwrap_or_else(|| "mapf-instance".to_string());

    // ---------------- 地图 ----------------
    let map = parse_map(root.get("map"), v).ok()?;
    let robots = parse_robots(root.get("robots"), v, &map).ok()?;

    // ---------------- 时间模型 / 目标 ----------------
    let (horizon, horizon_auto) =
        parse_time_model(root.get("time_model"), v, &robots, &map, profile);

    if let Some(mv) = root.get("movement") {
        if !mv.is_null() {
            let mv = expect_obj(v, mv, "$.movement")?;
            v.check_unknown(mv, &["neighbors", "sync", "wait_action"], "$.movement");
            let nb = take_str(v, mv, "neighbors", "$.movement", false);
            if let Some(nb) = nb {
                if nb != "4+wait" && nb != "4+wait+sync" {
                    v.unsupported(
                        "$.movement.neighbors",
                        format!("移动方式 `{nb}` 不在能力声明内（仅支持 4-neighbor + wait）"),
                    );
                }
            }
            if take_bool(v, mv, "diagonal", "$.movement", false) {
                v.unsupported("$.movement.diagonal", "对角移动不在本期能力声明内");
            }
        }
    }

    let objective = parse_objective(root.get("objective"), v).ok()?;
    let solver = parse_solver(root.get("solver"), v, profile, horizon_auto).ok()?;
    let bench = parse_bench(root.get("benchmark"), v, &robots);
    let coordinate_convention = root
        .get("map")
        .and_then(|m| m.get("coordinates"))
        .and_then(|c| c.as_str())
        .unwrap_or("x-right-y-down-origin-topleft")
        .to_string();

    if robots.is_empty() {
        v.err(codes::SCHEMA, "$.robots", "机器人列表不能为空");
    }
    if v.issues.iter().any(|i| i.severity == Severity::Error) || v.unsupported {
        return None;
    }

    let dynamic = match parse_dynamic(root.get("dynamic"), v, &map, &robots, horizon) {
        Ok(d) => d,
        Err(()) => return None,
    };

    Some(Problem {
        id,
        map,
        robots,
        horizon,
        objective,
        solver,
        bench,
        dynamic,
        coordinate_convention,
    })
}

fn parse_map(j: Option<&Json>, v: &mut Validator) -> Result<MapData, ()> {
    let empty = MapData {
        width: 0,
        height: 0,
        blocked: Vec::new(),
    };
    let Some(obj) = j else {
        v.err(codes::MISSING_FIELD, "$.map", "缺少 map 块");
        return Err(());
    };
    let obj = match expect_obj(v, obj, "$.map") {
        Some(o) => o,
        None => return Err(()),
    };
    v.check_unknown(
        obj,
        &[
            "width",
            "height",
            "cells",
            "blocked",
            "coordinates",
            "legend",
        ],
        "$.map",
    );

    let mut w = take_int(v, obj, "width", "$.map", false).map(|x| x.max(0));
    let mut h = take_int(v, obj, "height", "$.map", false).map(|x| x.max(0));

    // coordinates：只接受标准约定，未知约定 = UNSUPPORTED（不得静默按自己的约定解析）。
    if let Some(c) = obj.get("coordinates").and_then(|s| s.as_str()) {
        if c != "x-right-y-down-origin-topleft" {
            v.unsupported(
                "$.map.coordinates",
                format!("坐标约定 `{c}` 未实现；本引擎固定使用 x-right / y-down / 左上原点"),
            );
        }
    }

    let mut blocked: Vec<bool>;
    if let Some(cells) = obj.get("cells") {
        if !cells.is_null() {
            let rows = match cells.as_arr() {
                Some(r) if !r.is_empty() => r,
                _ => {
                    v.err(
                        codes::MAP_SHAPE,
                        "$.map.cells",
                        "cells 必须是非空字符串数组",
                    );
                    return Err(());
                }
            };
            if let Some(hh) = h {
                if hh as usize != rows.len() {
                    v.err(
                        codes::MAP_SHAPE,
                        "$.map.cells",
                        format!("height={hh} 与 cells 行数 {} 不一致", rows.len()),
                    );
                    return Err(());
                }
            }
            h = Some(rows.len() as i64);
            let mut width = 0usize;
            let mut strs: Vec<String> = Vec::with_capacity(rows.len());
            for (ri, r) in rows.iter().enumerate() {
                let s = match r.as_str() {
                    Some(s) => s,
                    None => {
                        v.err(
                            codes::MAP_SHAPE,
                            format!("$.map.cells[{ri}]"),
                            "地图行必须是字符串",
                        );
                        return Err(());
                    }
                };
                width = width.max(s.chars().count());
                strs.push(s.to_string());
            }
            if let Some(ww) = w {
                if ww as usize != width {
                    v.err(
                        codes::MAP_SHAPE,
                        "$.map.cells",
                        format!("width={ww} 与 cells 最大行宽 {width} 不一致"),
                    );
                    return Err(());
                }
            }
            w = Some(width as i64);
            let wu = width;
            let hu = strs.len();
            if wu == 0 || hu == 0 || wu > 4096 || hu > 4096 {
                v.err(
                    codes::MAP_SHAPE,
                    "$.map.cells",
                    format!("地图尺寸非法或过大（{wu}×{hu}）"),
                );
                return Err(());
            }
            blocked = vec![false; wu * hu];
            for (ri, s) in strs.iter().enumerate() {
                for (ci, ch) in s.chars().enumerate() {
                    let b = match ch {
                        '.' | ' ' => false,
                        '*' | '#' | 'X' | '@' => true,
                        other => {
                            v.err(
                                codes::MAP_SHAPE,
                                format!("$.map.cells[{ri}][{ci}]"),
                                format!("未知地图字符 `{other}`（支持 . * @ # X 空格）"),
                            );
                            return Err(());
                        }
                    };
                    blocked[ri * wu + ci] = b;
                }
                for ci in s.chars().count()..wu {
                    blocked[ri * wu + ci] = true; // 短行按障碍补齐（非规则地图）
                }
            }
        } else if let Some(bl) = obj.get("blocked") {
            (blocked, w, h) = match blocked_list(bl, w, h, v, obj, "$.map") {
                Ok(t) => t,
                Err(()) => return Err(()),
            };
        } else {
            v.err(
                codes::MISSING_FIELD,
                "$.map",
                "map.cells 或 map.blocked 至少提供一个",
            );
            return Err(());
        }
    } else if let Some(bl) = obj.get("blocked") {
        (blocked, w, h) = match blocked_list(bl, w, h, v, obj, "$.map") {
            Ok(t) => t,
            Err(()) => return Err(()),
        };
    } else {
        v.err(
            codes::MISSING_FIELD,
            "$.map",
            "map.cells 或 map.blocked 至少提供一个",
        );
        return Err(());
    }

    let (Some(wu), Some(hu)) = (w, h) else {
        v.err(
            codes::MISSING_FIELD,
            "$.map",
            "无法确定地图尺寸（cells 或 width/height）",
        );
        return Err(());
    };
    if wu <= 0 || hu <= 0 || wu as usize * hu as usize != blocked.len() {
        v.err(codes::MAP_SHAPE, "$.map", "width/height 与障碍数据不一致");
        return Err(());
    }
    let map = MapData {
        width: wu as u32,
        height: hu as u32,
        blocked,
    };
    let free = map.blocked.iter().filter(|b| !**b).count();
    if free < 2 {
        v.err(codes::MAP_EMPTY, "$.map", "可用单元少于 2，无合法实例可言");
        return Err(());
    }
    let _ = empty;
    Ok(map)
}

/// `blocked: [[x,y], ...]` + width/height。
/// `blocked_list` 输出：障碍位图 + 归一化后的宽高 + 校验出的单元格数（可空）。
type DimsOut = (Vec<bool>, Option<i64>, Option<i64>);

fn blocked_list(
    bl: &Json,
    mut w: Option<i64>,
    mut h: Option<i64>,
    v: &mut Validator,
    obj: &Json,
    path: &str,
) -> Result<DimsOut, ()> {
    if w.is_none() || h.is_none() {
        v.err(
            codes::MISSING_FIELD,
            format!("{path}.width"),
            "使用 blocked 列表时必须声明 width 与 height",
        );
        return Err(());
    }
    let (wu, hu) = (w.unwrap(), h.unwrap());
    if wu <= 0 || hu <= 0 || wu > 4096 || hu > 4096 {
        v.err(
            codes::MAP_SHAPE,
            path.to_string(),
            format!("地图尺寸非法（{wu}×{hu}）"),
        );
        return Err(());
    }
    let mut blocked = vec![false; (wu * hu) as usize];
    let arr = bl.as_arr().map(|a| a.to_vec()).unwrap_or_default();
    for (i, item) in arr.iter().enumerate() {
        let pair = match item.as_arr() {
            Some(a) if a.len() == 2 => a,
            _ => {
                v.err(
                    codes::SCHEMA,
                    format!("{path}.blocked[{i}]"),
                    "障碍项必须是 [x, y]",
                );
                continue;
            }
        };
        match (pair[0].as_i64(), pair[1].as_i64()) {
            (Some(x), Some(y)) if x >= 0 && y >= 0 && x < wu && y < hu => {
                blocked[(y * wu + x) as usize] = true;
            }
            (Some(x), Some(y)) => {
                v.err(
                    codes::COORD_RANGE,
                    format!("{path}.blocked[{i}]"),
                    format!("障碍坐标 ({x},{y}) 越界"),
                );
            }
            _ => v.err(
                codes::SCHEMA,
                format!("{path}.blocked[{i}]"),
                "坐标必须是非负整数",
            ),
        }
    }
    // 保持签名对称（w/h 未被修改）
    let _ = (&mut w, &mut h, obj);
    Ok((blocked, Some(wu), Some(hu)))
}

fn parse_robots(j: Option<&Json>, v: &mut Validator, map: &MapData) -> Result<Vec<Robot>, ()> {
    let Some(list) = j else {
        v.err(codes::MISSING_FIELD, "$.robots", "缺少 robots 数组");
        return Err(());
    };
    let arr = match list.as_arr() {
        Some(a) if !a.is_empty() => a.to_vec(),
        Some(_) => {
            v.err(codes::SCHEMA, "$.robots", "robots 不能为空数组");
            return Err(());
        }
        None => {
            v.err(
                codes::SCHEMA,
                "$.robots",
                format!("robots 应为数组，实际为 {}", list.type_name()),
            );
            return Err(());
        }
    };
    let mut out: Vec<Robot> = Vec::with_capacity(arr.len());
    let mut seen_ids = std::collections::HashSet::new();
    let mut seen_starts = std::collections::HashSet::new();
    let mut seen_goals = std::collections::HashSet::new();
    for (i, rj) in arr.iter().enumerate() {
        let path = format!("$.robots[{i}]");
        let Some(ro) = expect_obj(v, rj, &path) else {
            continue;
        };
        v.check_unknown(ro, &["id", "start", "goal", "label"], &path);
        let rid = take_str(v, ro, "id", &path, true).unwrap_or_default();
        if rid.is_empty() && ro.get("id").is_some() {
            // take_str 已报告类型错误
        }
        if rid.is_empty() {
            v.err(codes::SCHEMA, format!("{path}.id"), "机器人 id 不能为空");
        } else if !seen_ids.insert(rid.clone()) {
            v.err(
                codes::DUP_ROBOT_ID,
                format!("{path}.id"),
                format!("机器人 id `{rid}` 重复（SRS §2.1：唯一标识）"),
            );
        }
        let start = take_coord(
            v,
            ro.get("start").unwrap_or(&Json::Null),
            &format!("{path}.start"),
            map,
            true,
        );
        let goal = take_coord(
            v,
            ro.get("goal").unwrap_or(&Json::Null),
            &format!("{path}.goal"),
            map,
            true,
        );
        // 注册与逐项校验按“每坐标独立”执行：goal 非法（越界等）时 start 仍须参与
        // 重复起点判定（M07：一台车既有 DUP_START 又有 COORD_RANGE，两个错误都要报）。
        if let Some(s) = start {
            if map.is_blocked_static(s) {
                v.err(
                    codes::START_BLOCKED,
                    format!("{path}.start"),
                    format!("起点位于障碍 ({},{})", map.x_of(s), map.y_of(s)),
                );
            }
            if !seen_starts.insert(s) {
                v.err(
                    codes::DUP_START,
                    format!("{path}.start"),
                    "重复起点：两台机器人不能共享同一出发位置",
                );
            }
        }
        if let Some(g) = goal {
            if map.is_blocked_static(g) {
                v.err(
                    codes::GOAL_BLOCKED,
                    format!("{path}.goal"),
                    format!("终点位于障碍 ({},{})", map.x_of(g), map.y_of(g)),
                );
            }
            if !seen_goals.insert(g) {
                v.err(
                    codes::DUP_GOAL,
                    format!("{path}.goal"),
                    "重复终点：stay-at-target 语义下目标格互斥",
                );
            }
        }
        let (Some(s), Some(g)) = (start, goal) else {
            continue;
        };
        if s == g {
            v.err(codes::START_EQ_GOAL, format!("{path}.start"), format!("机器人 `{rid}` 起点与终点相同（应直接以 0 成本建模，本期契约拒绝该退化输入并给出提示）"));
        }
        out.push(Robot {
            id: rid,
            start: s,
            goal: g,
        });
    }
    if out.is_empty() {
        v.err(codes::SCHEMA, "$.robots", "没有可用的合法机器人定义");
        return Err(());
    }
    Ok(out)
}

fn parse_time_model(
    j: Option<&Json>,
    v: &mut Validator,
    robots: &[Robot],
    map: &MapData,
    _profile: Profile,
) -> (u32, bool) {
    let mut horizon: Option<i64> = None;
    if let Some(tm) = j {
        if !tm.is_null() {
            let Some(tm) = expect_obj(v, tm, "$.time_model") else {
                return (0, true);
            };
            v.check_unknown(
                tm,
                &["timestep", "start", "horizon", "sync"],
                "$.time_model",
            );
            if let Some(ts) = tm.get("timestep").and_then(|s| s.as_str()) {
                if ts != "discrete" {
                    v.unsupported(
                        "$.time_model.timestep",
                        format!("时间模型 `{ts}` 未实现（仅支持离散同步时步）"),
                    );
                }
            }
            if let Some(st) = take_int(v, tm, "start", "$.time_model", false) {
                if st != 0 {
                    v.err(
                        codes::SCHEMA,
                        "$.time_model.start",
                        "本契约固定从 t=0 开始（执行偏移请在 dynamic.snapshot.time 表达）",
                    );
                }
            }
            match tm.get("horizon") {
                None | Some(Json::Null) => {}
                Some(Json::Str(s)) if s == "auto" => {}
                Some(other) => {
                    if let Some(i) = other.as_i64() {
                        if i <= 0 {
                            v.err(
                                codes::HORIZON,
                                "$.time_model.horizon",
                                "horizon 必须是正整数或 \"auto\"",
                            );
                        } else {
                            horizon = Some(i);
                        }
                    } else {
                        v.err(
                            codes::SCHEMA,
                            "$.time_model.horizon",
                            "horizon 应为正整数或字符串 \"auto\"",
                        );
                    }
                }
            }
        }
    }
    let max_d = robots
        .iter()
        .map(|r| map.manhattan(r.start, r.goal))
        .max()
        .unwrap_or(1);
    match horizon {
        Some(h) => {
            let h = h.min(u32::MAX as i64 - 1) as u32;
            if (h as u64) < max_d as u64 {
                // 不是求解错误：时域短于最短可行路径 ⇒ 数学上不可能达成；
                // 由求解器给出“声明时域内不可行”的证明，但输入层先行拦截给出更直白的错误。
                v.err(
                    codes::HORIZON,
                    "$.time_model.horizon",
                    format!("时域 {h} 小于最大曼哈顿距离 {max_d}，该实例在此时域内必然不可行"),
                );
                return (h, false);
            }
            (h, false)
        }
        None => {
            // 自动时域：3×最大距离 + 4n 缓冲（详见 MODEL-MATH.md §4；影响 INFEASIBLE 证明资格）
            let auto = (3 * max_d + 4 * robots.len() as u32 + 8).clamp(max_d + 1, 1500);
            (auto, true)
        }
    }
}

fn parse_objective(j: Option<&Json>, v: &mut Validator) -> Result<Objective, ()> {
    let default = Objective::Soc;
    let Some(obj) = j else {
        v.warn(
            codes::OBJECTIVE,
            "$.objective",
            "未声明 objective.kind，按默认目标 soc 处理（结果将如实报告所用目标）",
        );
        return Ok(default);
    };
    if obj.is_null() {
        v.warn(
            codes::OBJECTIVE,
            "$.objective",
            "objective 为 null，按默认目标 soc 处理",
        );
        return Ok(default);
    }
    let Some(obj) = expect_obj(v, obj, "$.objective") else {
        return Err(());
    };
    v.check_unknown(obj, &["kind", "direction", "weights"], "$.objective");
    if obj.get("weights").map(|w| !w.is_null()).unwrap_or(false) {
        v.unsupported(
            "$.objective.weights",
            "加权组合目标不在本期能力声明内（SOC 与 Makespan 必须分别优化）",
        );
    }
    let kind = match obj.get("kind").and_then(|k| k.as_str()) {
        Some("soc") | Some("sum_of_costs") | Some("SOC") => Objective::Soc,
        Some("makespan") => Objective::Makespan,
        Some(other) => {
            v.err(
                codes::OBJECTIVE,
                "$.objective.kind",
                format!("未知目标 `{other}`（支持 soc | makespan）"),
            );
            return Err(());
        }
        None => {
            v.err(
                codes::MISSING_FIELD,
                "$.objective.kind",
                "objective.kind 必填（soc | makespan）",
            );
            return Err(());
        }
    };
    if let Some(d) = obj.get("direction").and_then(|s| s.as_str()) {
        if d != "min" {
            v.unsupported("$.objective.direction", "仅支持最小化目标");
        }
    }
    Ok(kind)
}

fn parse_solver(
    j: Option<&Json>,
    v: &mut Validator,
    profile: Profile,
    horizon_auto: bool,
) -> Result<SolverCfg, ()> {
    let mut cfg = SolverCfg {
        horizon_auto,
        ..SolverCfg::default()
    };
    let Some(obj) = j else { return Ok(cfg) };
    if obj.is_null() {
        return Ok(cfg);
    }
    let Some(obj) = expect_obj(v, obj, "$.solver") else {
        return Err(());
    };
    v.check_unknown(
        obj,
        &[
            "planner",
            "time_limit_ms",
            "seed",
            "suboptimality_factor",
            "max_expansions",
            "warm_start",
            "restarts",
        ],
        "$.solver",
    );
    if let Some(p) = obj.get("planner").and_then(|s| s.as_str()) {
        cfg.planner = match p {
            "auto" => PlannerKind::Auto,
            "ecbs" | "cbs" => PlannerKind::Ecbs,
            "pp" | "prioritized" => PlannerKind::Pp,
            other => {
                v.err(
                    codes::SCHEMA,
                    "$.solver.planner",
                    format!("未知规划器 `{other}`（auto|ecbs|pp）"),
                );
                return Err(());
            }
        };
    }
    if let Some(t) = take_int(v, obj, "time_limit_ms", "$.solver", false) {
        if t <= 0 || t > crate::capabilities::Limits::for_profile(profile).max_budget_ms {
            v.err(
                codes::SCHEMA,
                "$.solver.time_limit_ms",
                format!(
                    "time_limit_ms 必须在 (0, {}] 内（档位 {}）",
                    crate::capabilities::Limits::for_profile(profile).max_budget_ms,
                    profile.as_str()
                ),
            );
            return Err(());
        }
        cfg.time_limit_ms = t;
    }
    if let Some(s) = take_int(v, obj, "seed", "$.solver", false) {
        if s < 0 {
            v.err(codes::SCHEMA, "$.solver.seed", "seed 必须为非负整数");
            return Err(());
        }
        cfg.seed = s as u64;
    }
    cfg.w = take_float(v, obj, "suboptimality_factor", "$.solver", 1.0);
    if !(1.0..=3.0).contains(&cfg.w) {
        v.err(
            codes::SCHEMA,
            "$.solver.suboptimality_factor",
            "w 必须在 [1.0, 3.0] 区间（1.0 = 最优搜索）",
        );
        return Err(());
    }
    if let Some(m) = take_int(v, obj, "max_expansions", "$.solver", false) {
        if m < 0 {
            v.err(
                codes::SCHEMA,
                "$.solver.max_expansions",
                "max_expansions 必须 ≥ 0",
            );
            return Err(());
        }
        let cap = crate::capabilities::Limits::for_profile(profile).max_expansions_cap;
        if m as usize > cap {
            v.err(
                codes::SCHEMA,
                "$.solver.max_expansions",
                format!("max_expansions 超过档位上限 {cap}"),
            );
            return Err(());
        }
        cfg.max_expansions = m as usize;
    }
    cfg.warm_start = take_bool(v, obj, "warm_start", "$.solver", true);
    if obj.get("restarts").map(|r| !r.is_null()).unwrap_or(false) {
        v.unsupported(
            "$.solver.restarts",
            "随机重启策略不在本期实现范围（可复现性优先）",
        );
    }
    Ok(cfg)
}

fn parse_bench(j: Option<&Json>, v: &mut Validator, robots: &[Robot]) -> Option<BenchMeta> {
    let obj = j?;
    if obj.is_null() {
        return None;
    }
    let obj = expect_obj(v, obj, "$.benchmark")?;
    v.check_unknown(
        obj,
        &[
            "source",
            "map_file",
            "scen_file",
            "map_sha256",
            "scen_sha256",
            "instance_id",
            "agents",
            "converter_version",
            "cite",
            "conversion",
        ],
        "$.benchmark",
    );
    let meta = BenchMeta {
        source: take_str(v, obj, "source", "$.benchmark", false)
            .unwrap_or_else(|| "movingai".into()),
        map_file: take_str(v, obj, "map_file", "$.benchmark", false).unwrap_or_default(),
        scen_file: take_str(v, obj, "scen_file", "$.benchmark", false).unwrap_or_default(),
        map_sha256: take_str(v, obj, "map_sha256", "$.benchmark", false).unwrap_or_default(),
        scen_sha256: take_str(v, obj, "scen_sha256", "$.benchmark", false).unwrap_or_default(),
        instance_id: take_int(v, obj, "instance_id", "$.benchmark", false).unwrap_or(-1),
        agents: take_int(v, obj, "agents", "$.benchmark", false).unwrap_or(robots.len() as i64),
        converter_version: take_str(v, obj, "converter_version", "$.benchmark", false)
            .unwrap_or_default(),
    };
    if meta.agents >= 0 && meta.agents as usize != robots.len() {
        v.err(
            codes::BENCH_MAP_MISMATCH,
            "$.benchmark.agents",
            format!(
                "基准声明机器人 {n} 台，实际 {m} 台",
                n = meta.agents,
                m = robots.len()
            ),
        );
    }
    for (k, field) in [
        ("map_sha256", &meta.map_sha256),
        ("scen_sha256", &meta.scen_sha256),
    ] {
        if (!field.is_empty() && !field.starts_with("sha256:") || field.len() != 71)
            && !field.is_empty()
        {
            v.err(
                codes::BENCH_HASH_MISMATCH,
                format!("$.benchmark.{k}"),
                "哈希必须使用 `sha256:<64hex>` 形式",
            );
        }
    }
    Some(meta)
}

// ---------------------------------------------------------------- 动态块

fn parse_dynamic(
    j: Option<&Json>,
    v: &mut Validator,
    map: &MapData,
    robots: &[Robot],
    horizon: u32,
) -> Result<Option<DynamicInput>, ()> {
    let Some(dyn_) = j else { return Ok(None) };
    if dyn_.is_null() {
        return Ok(None);
    }
    let Some(dyn_) = expect_obj(v, dyn_, "$.dynamic") else {
        return Err(());
    };
    v.check_unknown(dyn_, &["snapshot", "events"], "$.dynamic");

    let snap = dyn_
        .get("snapshot")
        .and_then(|s| expect_obj(v, s, "$.dynamic.snapshot"));
    let Some(snap) = snap else {
        v.err(
            codes::MISSING_FIELD,
            "$.dynamic.snapshot",
            "dynamic 块必须携带 snapshot（执行快照）",
        );
        return Err(());
    };
    v.check_unknown(
        snap,
        &[
            "time",
            "frozen_steps",
            "frozen",
            "paths",
            "prior_solution_hash",
            "actual_positions",
        ],
        "$.dynamic.snapshot",
    );

    let time = take_int(v, snap, "time", "$.dynamic.snapshot", true).unwrap_or(0);
    if time < 0 || time as u64 > horizon as u64 {
        v.err(
            codes::SNAP_TIME,
            "$.dynamic.snapshot.time",
            format!("snapshot.time 必须在 [0, horizon={horizon}] 内"),
        );
        return Err(());
    }
    let time = time as u32;

    let g_frozen = take_int(v, snap, "frozen_steps", "$.dynamic.snapshot", false).unwrap_or(0);
    if g_frozen < 0 {
        v.err(
            codes::SNAP_TIME,
            "$.dynamic.snapshot.frozen_steps",
            "frozen_steps 必须 ≥ 0",
        );
        return Err(());
    }

    // per-robot 冻结覆盖
    let mut frozen_extra = vec![g_frozen as u32; robots.len()];
    let mut given_paths: Vec<Vec<Cell>> = vec![Vec::new(); robots.len()];
    if let Some(fz) = snap.get("frozen") {
        if !fz.is_null() {
            let fields = expect_obj(v, fz, "$.dynamic.snapshot.frozen")
                .and_then(|o| o.as_obj())
                .map(|f| f.to_vec());
            for (rid, val) in fields.unwrap_or_default() {
                let Some(idx) = robots.iter().position(|r| r.id == rid) else {
                    v.err(
                        codes::SNAP_SHAPE,
                        format!("$.dynamic.snapshot.frozen.{rid}"),
                        "引用了未知机器人",
                    );
                    continue;
                };
                match val.as_i64() {
                    Some(n) if n >= 0 => frozen_extra[idx] = n as u32,
                    _ => v.err(
                        codes::SNAP_SHAPE,
                        format!("$.dynamic.snapshot.frozen.{rid}"),
                        "冻结步数必须是非负整数",
                    ),
                }
            }
        }
    }
    // 既有路径
    if let Some(ps) = snap.get("paths") {
        if !ps.is_null() {
            let fields = expect_obj(v, ps, "$.dynamic.snapshot.paths")
                .and_then(|o| o.as_obj())
                .map(|f| f.to_vec());
            for (rid, arr) in fields.unwrap_or_default() {
                let Some(idx) = robots.iter().position(|r| r.id == rid) else {
                    v.err(
                        codes::SNAP_SHAPE,
                        format!("$.dynamic.snapshot.paths.{rid}"),
                        "引用了未知机器人",
                    );
                    continue;
                };
                let Some(items) = arr.as_arr() else {
                    v.err(
                        codes::SNAP_SHAPE,
                        format!("$.dynamic.snapshot.paths.{rid}"),
                        "路径必须是坐标数组",
                    );
                    continue;
                };
                let mut path: Vec<Cell> = Vec::with_capacity(items.len());
                for (t, item) in items.iter().enumerate() {
                    match take_coord(
                        v,
                        item,
                        &format!("$.dynamic.snapshot.paths.{rid}[{t}]"),
                        map,
                        true,
                    ) {
                        Some(c) => path.push(c),
                        None => break,
                    }
                }
                given_paths[idx] = path;
            }
        }
    }
    // paths 必须覆盖所有机器人
    for (i, r) in robots.iter().enumerate() {
        if given_paths[i].is_empty() {
            // 缺省：执行历史按“直线不可得”处理 → 直接拒绝（快照必须完整描述现状）。
            v.err(
                codes::SNAP_SHAPE,
                format!("$.dynamic.snapshot.paths.{}", r.id),
                "缺少该机器人的既有路径（快照必须覆盖全部机器人）",
            );
            return Err(());
        }
        if (given_paths[i].len() as u32) < time + 1 {
            v.err(
                codes::SNAP_SHAPE,
                format!("$.dynamic.snapshot.paths.{}", r.id),
                format!(
                    "既有路径长度 {} 小于 snapshot.time+1 = {}",
                    given_paths[i].len(),
                    time + 1
                ),
            );
            return Err(());
        }
    }

    // 事件
    let mut events: Vec<Event> = Vec::new();
    if let Some(ev) = dyn_.get("events") {
        if !ev.is_null() {
            let items = ev.as_arr().map(|a| a.to_vec()).unwrap_or_default();
            for (i, item) in items.iter().enumerate() {
                let path = format!("$.dynamic.events[{i}]");
                let Some(eo) = expect_obj(v, item, &path) else {
                    continue;
                };
                let kind = take_str(v, eo, "type", &path, true).unwrap_or_default();
                let at = take_int(v, eo, "at", &path, false).unwrap_or(time as i64);
                if at < 0 || (at as u64) > horizon as u64 {
                    v.err(
                        codes::EVENT_TIME,
                        format!("{path}.at"),
                        format!("事件时间必须落在 [0, {horizon}]"),
                    );
                    continue;
                }
                let at = at as u32;
                match kind.as_str() {
                    "obstacle_add" | "add_obstacle" | "obstacle" => {
                        let cell = take_coord(
                            v,
                            eo.get("cell").unwrap_or(&Json::Null),
                            &format!("{path}.cell"),
                            map,
                            true,
                        );
                        let until = match eo.get("until") {
                            None | Some(Json::Null) => None,
                            Some(u) => match u.as_i64() {
                                Some(x) if x >= 0 && x <= horizon as i64 => Some(x as u32),
                                _ => {
                                    v.err(
                                        codes::EVENT_TIME,
                                        format!("{path}.until"),
                                        "until 必须是 [0, horizon] 整数",
                                    );
                                    None
                                }
                            },
                        };
                        if let Some(c) = cell {
                            events.push(Event::ObstacleAdd { cell: c, at, until });
                        }
                    }
                    "obstacle_remove" | "remove_obstacle" => {
                        let cell = take_coord(
                            v,
                            eo.get("cell").unwrap_or(&Json::Null),
                            &format!("{path}.cell"),
                            map,
                            true,
                        );
                        if let Some(c) = cell {
                            events.push(Event::ObstacleRemove { cell: c, at });
                        }
                    }
                    "goal_change" => {
                        let rid = take_str(v, eo, "robot", &path, true).unwrap_or_default();
                        let goal = take_coord(
                            v,
                            eo.get("goal").unwrap_or(&Json::Null),
                            &format!("{path}.goal"),
                            map,
                            true,
                        );
                        match robots.iter().position(|r| r.id == rid) {
                            Some(idx) if goal.is_some() => {
                                if goal == Some(robots[idx].goal) && at <= time {
                                    v.err(
                                        codes::EVENT_TARGET,
                                        format!("{path}.goal"),
                                        "goal_change 到同一终点没有意义",
                                    );
                                }
                                events.push(Event::GoalChange {
                                    robot: idx,
                                    goal: goal.unwrap(),
                                    at,
                                });
                            }
                            None => v.err(
                                codes::EVENT_TARGET,
                                format!("{path}.robot"),
                                format!("引用了未知机器人 `{rid}`"),
                            ),
                            _ => {}
                        }
                    }
                    "path_invalid" | "path_blocked" | "reroute" => {
                        let list = eo
                            .get("robots")
                            .and_then(|r| r.as_arr())
                            .map(|a| a.to_vec())
                            .unwrap_or_default();
                        let mut idxs = Vec::new();
                        if list.is_empty() {
                            v.err(
                                codes::EVENT_TARGET,
                                format!("{path}.robots"),
                                "path_invalid 必须列出受影响机器人",
                            );
                        }
                        for (k, it) in list.iter().enumerate() {
                            let rid = it.as_str().unwrap_or_default();
                            match robots.iter().position(|r| r.id == rid) {
                                Some(idx) => idxs.push(idx),
                                None => v.err(
                                    codes::EVENT_TARGET,
                                    format!("{path}.robots[{k}]"),
                                    format!("引用了未知机器人 `{rid}`"),
                                ),
                            }
                        }
                        if !idxs.is_empty() {
                            events.push(Event::PathInvalid { robots: idxs, at });
                        }
                    }
                    "" => {
                        v.err(codes::EVENT_KIND, format!("{path}.type"), "事件缺少 type");
                    }
                    other => {
                        v.err(codes::EVENT_KIND, format!("{path}.type"), format!("未知事件类型 `{other}`（支持 obstacle_add | obstacle_remove | goal_change | path_invalid）"));
                    }
                }
            }
        }
    }

    // 事件语义交叉检查 + 时间有序化
    let mut dyn_ = DynamicInput {
        time,
        frozen_extra,
        prior_paths: given_paths,
        events,
    };
    dyn_.events.sort_by_key(event_time);
    finalize_dynamic(&mut dyn_, map, robots, horizon, v)?;
    Ok(Some(dyn_))
}

pub fn event_time(e: &Event) -> u32 {
    match e {
        Event::ObstacleAdd { at, .. }
        | Event::ObstacleRemove { at, .. }
        | Event::GoalChange { at, .. }
        | Event::PathInvalid { at, .. } => *at,
    }
}

/// 交叉校验事件与快照的相容性，并把语义回写到 frozen_extra。
fn finalize_dynamic(
    d: &mut DynamicInput,
    map: &MapData,
    robots: &[Robot],
    horizon: u32,
    v: &mut Validator,
) -> Result<(), ()> {
    let n = robots.len();
    // 1) path_invalid：把受影响机器人的冻结窗收缩到 at（at 之前必须已执行）。
    for ev in &d.events {
        if let Event::PathInvalid { robots: idxs, at } = ev {
            if *at < d.time {
                v.err(
                    codes::EVENT_TIME,
                    "$.dynamic.events",
                    format!(
                        "path_invalid.at={at} 早于快照时刻 {}，已执行历史不可撤销",
                        d.time
                    ),
                );
                return Err(());
            }
            for &i in idxs {
                let budget = at.saturating_sub(d.time);
                d.frozen_extra[i] = d.frozen_extra[i].min(budget);
            }
        }
    }
    // 2) goal_change：目标必须合法且相互不冲突（与“当前有效目标”集比较）。
    let mut goals: Vec<Cell> = robots.iter().map(|r| r.goal).collect();
    for ev in &d.events {
        if let Event::GoalChange { robot, goal, at } = ev {
            if *at < d.time {
                v.err(
                    codes::EVENT_TIME,
                    "$.dynamic.events",
                    "goal_change.at 不能早于快照时刻（历史承诺不可追溯修改）",
                );
                return Err(());
            }
            if map.is_blocked_static(*goal) {
                v.err(
                    codes::GOAL_BLOCKED,
                    "$.dynamic.events",
                    format!("新终点 ({},{}) 位于障碍", map.x_of(*goal), map.y_of(*goal)),
                );
                return Err(());
            }
            if goals[*robot] != *goal {
                let dup = (0..n).any(|j| j != *robot && goals[j] == *goal);
                if dup {
                    v.err(
                        codes::DUP_GOAL,
                        "$.dynamic.events",
                        "新终点与另一台机器人的有效目标重复".to_string(),
                    );
                    return Err(());
                }
                goals[*robot] = *goal;
                // 目标改变 ⇒ 旧的“驻留终点”承诺失效 ⇒ 冻结窗至少收缩到 at
                let budget = at.saturating_sub(d.time);
                d.frozen_extra[*robot] = d.frozen_extra[*robot].min(budget);
            }
        }
    }
    // 3) 冻结窗 ≤ 剩余时域
    for i in 0..n {
        if d.time + d.frozen_extra[i] > horizon {
            d.frozen_extra[i] = horizon.saturating_sub(d.time);
        }
    }
    // 4) 障碍事件相容性
    for ev in &d.events {
        match ev {
            Event::ObstacleAdd { cell, at, until } => {
                if *at > horizon {
                    v.err(
                        codes::EVENT_TIME,
                        "$.dynamic.events",
                        "obstacle_add.at 超出时域",
                    );
                    return Err(());
                }
                if let Some(u) = until {
                    if u <= at {
                        v.err(
                            codes::EVENT_TIME,
                            "$.dynamic.events",
                            "obstacle_add.until 必须大于 at",
                        );
                        return Err(());
                    }
                }
                let _ = cell;
            }
            Event::ObstacleRemove { cell, at } => {
                if *at > horizon {
                    v.err(
                        codes::EVENT_TIME,
                        "$.dynamic.events",
                        "obstacle_remove.at 超出时域",
                    );
                    return Err(());
                }
                if !map.is_blocked_static(*cell) {
                    // 重复 remove 或 remove 未封锁格：事件必须是“可观察到的变化”，拒绝之。
                    let re_added = d.events.iter().any(|e| matches!(e, Event::ObstacleAdd{cell: c, ..} if *c == *cell && e_at(e) <= at));
                    if !re_added {
                        v.err(
                            codes::EVENT_TARGET,
                            "$.dynamic.events",
                            "obstacle_remove 指向一个当前并非障碍的单元",
                        );
                        return Err(());
                    }
                }
            }
            _ => {}
        }
    }
    let _ = n;
    Ok(())
}

fn e_at(e: &Event) -> &u32 {
    match e {
        Event::ObstacleAdd { at, .. }
        | Event::ObstacleRemove { at, .. }
        | Event::GoalChange { at, .. }
        | Event::PathInvalid { at, .. } => at,
    }
}

/// 收集 Issue 序列化为 `MapfSolution.errors`。
pub fn issues_to_json(issues: &[Issue]) -> Json {
    Json::Arr(issues.iter().map(|i| i.to_json()).collect())
}

/// 有效目标（应用 goal_change 事件之后）——动态重规划内部与 engine 共用。
pub fn effective_goals(p: &Problem) -> Vec<Cell> {
    let mut goals: Vec<Cell> = p.robots.iter().map(|r| r.goal).collect();
    if let Some(d) = &p.dynamic {
        for ev in &d.events {
            if let Event::GoalChange { robot, goal, .. } = ev {
                goals[*robot] = *goal;
            }
        }
    }
    goals
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal() -> Json {
        Json::obj(vec![
            (
                "schema_version",
                Json::str(crate::errors::SCHEMA_VERSION_PROBLEM),
            ),
            ("id", Json::str("t")),
            (
                "map",
                Json::obj(vec![
                    ("width", Json::int(3)),
                    ("height", Json::int(3)),
                    (
                        "blocked",
                        Json::Arr(vec![Json::Arr(vec![Json::int(2), Json::int(2)])]),
                    ),
                ]),
            ),
            (
                "robots",
                Json::Arr(vec![Json::obj(vec![
                    ("id", Json::str("A")),
                    ("start", Json::Arr(vec![Json::int(0), Json::int(1)])),
                    ("goal", Json::Arr(vec![Json::int(2), Json::int(1)])),
                ])]),
            ),
            ("objective", Json::obj(vec![("kind", Json::str("soc"))])),
            ("time_model", Json::obj(vec![("horizon", Json::int(8))])),
        ])
    }

    #[test]
    fn accepts_minimal() {
        let text = minimal().to_compact();
        let p = parse_problem(&text, Profile::Native).expect("ok");
        assert_eq!(p.map.n_cells(), 9);
        assert_eq!(p.robots.len(), 1);
        assert_eq!(p.horizon, 8);
        assert!(!p.solver.horizon_auto);
    }

    #[test]
    fn rejects_dup_starts_and_oob() {
        let mut j = minimal();
        j.set(
            "robots",
            Json::Arr(vec![
                Json::obj(vec![
                    ("id", Json::str("A")),
                    ("start", Json::Arr(vec![Json::int(0), Json::int(0)])),
                    ("goal", Json::Arr(vec![Json::int(2), Json::int(0)])),
                ]),
                Json::obj(vec![
                    ("id", Json::str("B")),
                    ("start", Json::Arr(vec![Json::int(0), Json::int(0)])),
                    ("goal", Json::Arr(vec![Json::int(2), Json::int(1)])),
                ]),
                Json::obj(vec![
                    ("id", Json::str("C")),
                    ("start", Json::Arr(vec![Json::int(9), Json::int(0)])),
                    ("goal", Json::Arr(vec![Json::int(2), Json::int(2)])),
                ]),
            ]),
        );
        let f = parse_problem(&j.to_compact(), Profile::Native).unwrap_err();
        let codes: Vec<&str> = f.issues.iter().map(|i| i.code.as_str()).collect();
        assert!(
            codes.contains(&crate::errors::codes::DUP_START),
            "{codes:?}"
        );
        assert!(
            codes.contains(&crate::errors::codes::COORD_RANGE),
            "{codes:?}"
        );
    }

    #[test]
    fn unsupported_feature_fields_are_flagged() {
        let mut j = minimal();
        j.set("movement", Json::obj(vec![("diagonal", Json::Bool(true))]));
        let f = parse_problem(&j.to_compact(), Profile::Native).unwrap_err();
        assert!(f.unsupported, "{:?}", f.issues);
    }

    #[test]
    fn cells_map_and_coordinate_check() {
        let mut j = minimal();
        j.set(
            "map",
            Json::obj(vec![
                (
                    "cells",
                    Json::Arr(vec![Json::str("***"), Json::str("..."), Json::str(".*.")]),
                ),
                ("coordinates", Json::str("center-origin")),
            ]),
        );
        let f = parse_problem(&j.to_compact(), Profile::Native).unwrap_err();
        assert!(
            f.unsupported,
            "未知坐标约定必须 UNSUPPORTED: {:?}",
            f.issues
        );
        j.set(
            "map",
            Json::obj(vec![(
                "cells",
                Json::Arr(vec![Json::str("***"), Json::str("..."), Json::str(".*.")]),
            )]),
        );
        let p = parse_problem(&j.to_compact(), Profile::Native).unwrap();
        assert_eq!(p.map.width, 3);
    }

    #[test]
    fn blocked_windows_merge() {
        let mut j = minimal();
        j.set("time_model", Json::obj(vec![("horizon", Json::int(20))]));
        j.set(
            "dynamic",
            Json::obj(vec![
                (
                    "snapshot",
                    Json::obj(vec![
                        ("time", Json::int(1)),
                        (
                            "paths",
                            Json::obj(vec![(
                                "A",
                                Json::Arr(vec![
                                    Json::Arr(vec![Json::int(0), Json::int(1)]),
                                    Json::Arr(vec![Json::int(1), Json::int(1)]),
                                ]),
                            )]),
                        ),
                    ]),
                ),
                (
                    "events",
                    Json::Arr(vec![
                        Json::obj(vec![
                            ("type", Json::str("obstacle_add")),
                            ("cell", Json::Arr(vec![Json::int(1), Json::int(0)])),
                            ("at", Json::int(2)),
                            ("until", Json::int(5)),
                        ]),
                        Json::obj(vec![
                            ("type", Json::str("obstacle_add")),
                            ("cell", Json::Arr(vec![Json::int(1), Json::int(0)])),
                            ("at", Json::int(4)),
                        ]),
                    ]),
                ),
            ]),
        );
        let p = parse_problem(&j.to_compact(), Profile::Native).unwrap();
        let w = p.blocked_windows();
        // 静态障碍 (2,2) = cell 8 全程封锁
        assert_eq!(w[8], vec![(0, u32::MAX)]);
        // (1,0) = cell 1：两个窗口 [2,5) 与 [4,∞) 合并为 [2,∞)
        assert_eq!(w[1], vec![(2, u32::MAX)]);
    }
}
