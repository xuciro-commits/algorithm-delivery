//! `agv-dispatch-problem/1.0` 契约解析 + 语义校验（AGV-SRS §2/§5）。
//!
//! 校验分层（先结构后语义，全部错误一次性收集、字段级定位）：
//! 1. JSON 可解析；2. 契约结构（白名单字段）；3. 语义（重复 id/坐标/工作站/
//!    泊位冲突……）；4. 能力门控（见 capabilities.rs）。
//!
//! 注意：本模块**独立实现**栅格地图结构（不导入 mapf_engine 内部类型）——
//! AGV 与 MAPF 之间只允许 JSON 契约形状的数据（AGV-SRS §5）。

use aps_engine::json::Json;

use crate::capabilities::Profile;
use crate::errors::{codes, Issue};

/// 栅格单元编码：`cell = y * width + x`（与 mapf 契约同约定）。
pub type Cell = u32;

/// 静态栅格地图（自有实现；语义与 mapf-problem/1.0 的地图一致）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MapData {
    pub width: u32,
    pub height: u32,
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
    pub fn is_blocked(&self, c: Cell) -> bool {
        self.blocked[c as usize]
    }
    pub fn manhattan(&self, a: Cell, b: Cell) -> u32 {
        self.x_of(a).abs_diff(self.x_of(b)) + self.y_of(a).abs_diff(self.y_of(b))
    }
    /// 可达性（BFS，用于结构性不可行证明与任务可达预检）。
    pub fn reachable(&self, from: Cell, to: Cell) -> bool {
        if from == to {
            return !self.is_blocked(from);
        }
        let n = self.n_cells();
        let mut seen = vec![false; n];
        let mut queue = std::collections::VecDeque::new();
        if self.is_blocked(from) || self.is_blocked(to) {
            return false;
        }
        seen[from as usize] = true;
        queue.push_back(from);
        while let Some(c) = queue.pop_front() {
            for nb in self.neighbors(c) {
                if nb != u32::MAX && !seen[nb as usize] && !self.is_blocked(nb) {
                    if nb == to {
                        return true;
                    }
                    seen[nb as usize] = true;
                    queue.push_back(nb);
                }
            }
        }
        false
    }
    /// 四邻域（含 wait 位）；越界 = u32::MAX。顺序固定：wait, E, W, N, S。
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
}

/// 任务位置：显式格或工作站引用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskLoc {
    Cell(Cell),
    Station(usize),
}

impl TaskLoc {
    /// 候选泊位格（确定性顺序：工作站声明序）。
    pub fn dock_candidates(&self, stations: &[Station]) -> Vec<Cell> {
        match self {
            TaskLoc::Cell(c) => vec![*c],
            TaskLoc::Station(i) => stations[*i].cells.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Vehicle {
    pub idx: usize,
    pub id: String,
    pub start: Cell,
    pub capabilities: Vec<String>,
    pub paused: bool,
}

impl Vehicle {
    pub fn capable(&self, required: Option<&str>) -> bool {
        match required {
            None => true,
            Some(r) => self.capabilities.iter().any(|c| c == r),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Task {
    pub idx: usize,
    pub id: String,
    pub pickup: TaskLoc,
    pub dropoff: TaskLoc,
    pub release_step: u32,
    pub priority: u32,
    pub pickup_service: u32,
    pub dropoff_service: u32,
    pub due_step: Option<u32>,
    pub required_capability: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Station {
    pub idx: usize,
    pub id: String,
    pub cells: Vec<Cell>,
    pub capacity: usize,
}

#[derive(Debug, Clone, Copy)]
pub struct Weights {
    pub makespan: f64,
    pub flow_time: f64,
    pub empty_travel: f64,
    pub lateness: f64,
}

impl Default for Weights {
    fn default() -> Self {
        Weights {
            makespan: 1.0,
            flow_time: 1.0,
            empty_travel: 1.0,
            lateness: 1.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct MapfOpts {
    pub planner: String,
    pub w: f64,
    pub time_limit_ms: i64,
}

impl Default for MapfOpts {
    fn default() -> Self {
        MapfOpts {
            planner: "auto".into(),
            w: 1.5,
            time_limit_ms: 2000,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SolverOpts {
    pub algorithm: String, // auto | baseline | insertion-ls
    pub time_limit_ms: i64,
    pub seed: u64,
    pub frozen_steps: u32,
    pub mapf: MapfOpts,
}

impl Default for SolverOpts {
    fn default() -> Self {
        SolverOpts {
            algorithm: "auto".into(),
            time_limit_ms: 10_000,
            seed: 42,
            frozen_steps: 0,
            mapf: MapfOpts::default(),
        }
    }
}

// —— 动态块 ——
#[derive(Debug, Clone)]
pub enum Event {
    TaskAdd {
        task: Task,
    },
    TaskCancel {
        task: usize,
    },
    TaskPriority {
        task: usize,
        priority: u32,
    },
    VehiclePause {
        vehicle: usize,
    },
    VehicleResume {
        vehicle: usize,
    },
    ObstacleAdd {
        cell: Cell,
        at: u32,
        until: Option<u32>,
    },
    ObstacleRemove {
        cell: Cell,
        at: u32,
    },
}

#[derive(Debug, Clone)]
pub struct VehicleSnap {
    pub pos: Cell,
    pub phase: String, // idle|to_pickup|servicing_pickup|to_dropoff|servicing_dropoff|parking|paused
    pub task: Option<usize>,
    pub path: Vec<Cell>, // 已执行时间线 0..=time（至少 1 项）
}

#[derive(Debug, Clone)]
pub struct TaskSnap {
    pub status: String, // pending|assigned|picked|done|<failed 终态>
    pub assignee: Option<usize>,
    /// 历史时刻（done/picked 任务可选；重调度解沿用）。
    pub pickup_dock: Option<Cell>,
    pub dropoff_dock: Option<Cell>,
    pub pickup_arrival: Option<u32>,
    pub pickup_done: Option<u32>,
    pub dropoff_arrival: Option<u32>,
    pub dropoff_done: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct DynamicInput {
    pub time: u32,
    pub vehicles: Vec<Option<VehicleSnap>>, // 按车辆 idx
    pub tasks: Vec<TaskSnap>,               // 按任务 idx
    pub events: Vec<Event>,
}

#[derive(Debug, Clone)]
pub struct Problem {
    pub id: Option<String>,
    pub map: MapData,
    pub horizon: Option<u32>, // None = auto
    pub vehicles: Vec<Vehicle>,
    pub tasks: Vec<Task>,
    pub stations: Vec<Station>,
    pub parking: Vec<Cell>,
    pub weights: Weights,
    pub solver: SolverOpts,
    pub dynamic: Option<DynamicInput>,
    pub tags: Option<Json>,
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

struct Ctx<'a> {
    v: &'a mut Vec<Issue>,
    path: String,
}

impl<'a> Ctx<'a> {
    fn new(v: &'a mut Vec<Issue>) -> Ctx<'a> {
        Ctx {
            v,
            path: String::new(),
        }
    }
    fn err(&mut self, code: &'static str, msg: impl Into<String>) {
        self.v
            .push(Issue::error(code, self.path.clone(), msg.into()));
    }
    fn field<'b>(&'b mut self, name: &str) -> Ctx<'b> {
        let mut path = self.path.clone();
        if !path.is_empty() {
            path.push('.');
        }
        path.push_str(name);
        Ctx {
            v: &mut *self.v,
            path,
        }
    }
    fn idx<'b>(&'b mut self, i: usize) -> Ctx<'b> {
        let mut path = self.path.clone();
        path.push('[');
        path.push_str(&i.to_string());
        path.push(']');
        Ctx {
            v: &mut *self.v,
            path,
        }
    }
}

fn as_str(j: &Json) -> Option<&str> {
    j.as_str()
}
fn as_u32(j: &Json) -> Option<u32> {
    j.as_i64().and_then(|v| u32::try_from(v).ok())
}

fn cell_of_xy(map: &MapData, x: u32, y: u32) -> Option<Cell> {
    map.cell(x, y)
}

fn parse_cell(c: &mut Ctx, j: Option<&Json>, map: &MapData) -> Option<Cell> {
    let j = j?;
    let arr = j.as_arr()?;
    if arr.len() != 2 {
        c.err(codes::SCHEMA, "坐标必须是 [x, y] 两元数组");
        return None;
    }
    let (x, y) = (as_u32(&arr[0])?, as_u32(&arr[1])?);
    match cell_of_xy(map, x, y) {
        Some(cell) => Some(cell),
        None => {
            c.err(
                codes::COORD_RANGE,
                format!(
                    "坐标 ({x},{y}) 越界（地图 {w}×{h}）",
                    w = map.width,
                    h = map.height
                ),
            );
            None
        }
    }
}

fn known_fields(j: &Json, allowed: &[&str], c: &mut Ctx) {
    if let Some(obj) = j.as_obj() {
        for (k, _) in obj {
            if !allowed.contains(&k.as_str()) {
                let mut path = c.path.clone();
                if !path.is_empty() {
                    path.push('.');
                }
                path.push_str(k);
                c.v.push(Issue::warning(
                    codes::UNKNOWN_FIELD,
                    path,
                    format!("未声明字段 `{k}`（契约白名单外，忽略）"),
                ));
            }
        }
    }
}

/// 解析并校验问题。返回全部问题（空 = 合法）。
pub fn parse_problem(text: &str, profile: Profile) -> Result<Problem, Vec<Issue>> {
    let mut issues: Vec<Issue> = Vec::new();
    let root: Json = match aps_engine::json::parse(text) {
        Ok(j) => j,
        Err(e) => {
            return Err(vec![Issue::error(
                codes::BAD_JSON,
                "$",
                format!("JSON 解析失败：{e}"),
            )]);
        }
    };
    let mut c = Ctx::new(&mut issues);
    known_fields(
        &root,
        &[
            "schema_version",
            "id",
            "map",
            "time_model",
            "vehicles",
            "tasks",
            "stations",
            "parking",
            "objective",
            "solver",
            "dynamic",
            "tags",
        ],
        &mut c,
    );

    // —— 地图 ——
    let map = {
        let mut mc = c.field("map");
        let mj = root.get("map");
        let cells: Vec<String> = match mj.and_then(|m| m.get("cells")).and_then(|x| x.as_arr()) {
            Some(rows) => {
                let mut out = Vec::with_capacity(rows.len());
                for (i, r) in rows.iter().enumerate() {
                    match r.as_str() {
                        Some(s) => out.push(s.to_string()),
                        None => {
                            mc.idx(i).err(codes::MAP_SHAPE, "地图行必须是字符串");
                        }
                    }
                }
                out
            }
            None => {
                mc.err(codes::MISSING_FIELD, "缺少 map.cells");
                vec![]
            }
        };
        if cells.is_empty() {
            if mc
                .v
                .iter()
                .any(|i| i.severity == crate::errors::Severity::Error)
            {
                return Err(issues);
            }
            mc.err(codes::MAP_SHAPE, "地图不能为空");
            return Err(issues);
        }
        let width = cells[0].len() as u32;
        if width == 0 || cells.iter().any(|r| r.len() as u32 != width) {
            mc.err(codes::MAP_SHAPE, "地图各行宽度必须一致");
            return Err(issues);
        }
        let height = cells.len() as u32;
        let mut blocked = vec![false; (width * height) as usize];
        for (y, row) in cells.iter().enumerate() {
            for (x, ch) in row.char_indices() {
                if matches!(ch, '#' | 'T' | 'S') {
                    blocked[y * width as usize + x] = true;
                }
            }
        }
        let m = MapData {
            width,
            height,
            blocked,
        };
        if !m.blocked.iter().any(|b| !b) {
            mc.err(codes::MAP_EMPTY, "地图没有可通行格");
        }
        m
    };

    // —— 时域 ——
    let horizon = match root.get("time_model").and_then(|t| t.get("horizon")) {
        None => None,
        Some(h) => {
            let mut h1 = c.field("time_model");
            let mut hc = h1.field("horizon");
            if let Some(s) = h.as_str() {
                if s == "auto" {
                    None
                } else {
                    hc.err(codes::SCHEMA, "时域必须是正整数或 \"auto\"");
                    None
                }
            } else {
                match h.as_i64().and_then(|v| u32::try_from(v).ok()) {
                    Some(v) if v >= 1 => Some(v),
                    _ => {
                        hc.err(codes::SCHEMA, "时域必须是正整数或 \"auto\"");
                        None
                    }
                }
            }
        }
    };

    // —— 车辆 ——
    let mut vehicles = Vec::new();
    {
        let mut vc = c.field("vehicles");
        match root.get("vehicles").and_then(|x| x.as_arr()) {
            None => vc.err(codes::MISSING_FIELD, "缺少 vehicles（至少 1 台）"),
            Some([]) => vc.err(codes::MISSING_FIELD, "vehicles 不能为空"),
            Some(list) => {
                let mut seen_id = std::collections::BTreeSet::new();
                let mut seen_start = std::collections::BTreeMap::new();
                for (i, vj) in list.iter().enumerate() {
                    let mut fc = vc.idx(i);
                    known_fields(vj, &["id", "start", "capabilities", "status"], &mut fc);
                    let id = match vj.get("id").and_then(as_str) {
                        Some(s) => s.to_string(),
                        None => {
                            fc.err(codes::MISSING_FIELD, "缺少 id");
                            continue;
                        }
                    };
                    if !seen_id.insert(id.clone()) {
                        fc.err(codes::DUP_VEHICLE_ID, format!("车辆 id `{id}` 重复"));
                    }
                    let start = match parse_cell(&mut fc, vj.get("start"), &map) {
                        Some(s) => Some(s),
                        None => continue,
                    };
                    let start = match start {
                        Some(s) => s,
                        None => continue,
                    };
                    if map.is_blocked(start) {
                        fc.err(
                            codes::VEHICLE_START_BLOCKED,
                            format!("车辆 `{id}` 起点在障碍格 {c}", c = fmt_cell(&map, start)),
                        );
                    }
                    if let Some(prev) = seen_start.insert(start, id.clone()) {
                        fc.err(
                            codes::DUP_START,
                            format!(
                                "车辆 `{id}` 与 `{prev}` 起点重复 {c}",
                                c = fmt_cell(&map, start)
                            ),
                        );
                    }
                    let capabilities = vj
                        .get("capabilities")
                        .and_then(|x| x.as_arr())
                        .map(|a| a.iter().filter_map(as_str).map(str::to_string).collect())
                        .unwrap_or_else(|| vec!["general".to_string()]);
                    let paused = vj.get("status").and_then(|x| x.as_str()) == Some("paused");
                    vehicles.push(Vehicle {
                        idx: vehicles.len(),
                        id,
                        start,
                        capabilities,
                        paused,
                    });
                }
            }
        }
    }

    // —— 工作站 ——
    let mut stations = Vec::new();
    {
        let mut sc = c.field("stations");
        if let Some(list) = root.get("stations").and_then(|x| x.as_arr()) {
            let mut seen_id = std::collections::BTreeSet::new();
            let mut seen_cell = std::collections::BTreeMap::new();
            for (i, sj) in list.iter().enumerate() {
                let mut fc = sc.idx(i);
                known_fields(sj, &["id", "cells", "capacity"], &mut fc);
                let id = match sj.get("id").and_then(as_str) {
                    Some(s) => s.to_string(),
                    None => {
                        fc.err(codes::MISSING_FIELD, "缺少 id");
                        continue;
                    }
                };
                if !seen_id.insert(id.clone()) {
                    fc.err(codes::DUP_STATION_ID, format!("工作站 id `{id}` 重复"));
                }
                let mut cells = Vec::new();
                if let Some(arr) = sj.get("cells").and_then(|x| x.as_arr()) {
                    for cj in arr.iter() {
                        if let Some(cell) = parse_cell(&mut fc, Some(cj), &map) {
                            if map.is_blocked(cell) {
                                fc.err(
                                    codes::LOC_BLOCKED,
                                    format!(
                                        "工作站 `{id}` 泊位 {c} 在障碍格",
                                        c = fmt_cell(&map, cell)
                                    ),
                                );
                            }
                            if let Some(prev) = seen_cell.insert(cell, id.clone()) {
                                fc.err(
                                    codes::STATION_DUP_CELL,
                                    format!(
                                        "泊位 {c} 同时属于 `{prev}` 与 `{id}`",
                                        c = fmt_cell(&map, cell)
                                    ),
                                );
                            }
                            cells.push(cell);
                        }
                    }
                }
                if cells.is_empty() {
                    fc.err(codes::MISSING_FIELD, "工作站缺少泊位格");
                    continue;
                }
                let capacity = sj
                    .get("capacity")
                    .and_then(|x| x.as_i64())
                    .map_or(cells.len(), |v| v.max(0) as usize);
                if capacity == 0 || capacity > cells.len() {
                    fc.err(
                        codes::STATION_CAP,
                        format!(
                            "工作站 `{id}` 容量 {capacity} 必须在 1..={n}（泊位数）",
                            n = cells.len()
                        ),
                    );
                }
                stations.push(Station {
                    idx: stations.len(),
                    id,
                    cells,
                    capacity,
                });
            }
        }
    }

    // —— 任务 ——
    let mut tasks = Vec::new();
    {
        let mut tc = c.field("tasks");
        match root.get("tasks").and_then(|x| x.as_arr()) {
            Some(list) => {
                let mut seen_id = std::collections::BTreeSet::new();
                for (i, tj) in list.iter().enumerate() {
                    let mut fc = tc.idx(i);
                    known_fields(
                        tj,
                        &[
                            "id",
                            "pickup",
                            "dropoff",
                            "release_step",
                            "priority",
                            "pickup_service",
                            "dropoff_service",
                            "due_step",
                            "required_capability",
                        ],
                        &mut fc,
                    );
                    let id = match tj.get("id").and_then(as_str) {
                        Some(s) => s.to_string(),
                        None => {
                            fc.err(codes::MISSING_FIELD, "缺少 id");
                            continue;
                        }
                    };
                    if !seen_id.insert(id.clone()) {
                        fc.err(codes::DUP_TASK_ID, format!("任务 id `{id}` 重复"));
                    }
                    let pickup = parse_loc(&mut fc, tj.get("pickup"), &map, &stations);
                    let dropoff = parse_loc(&mut fc, tj.get("dropoff"), &map, &stations);
                    let (pickup, dropoff) = match (pickup, dropoff) {
                        (Some(p), Some(d)) => (p, d),
                        _ => continue,
                    };
                    if let (TaskLoc::Cell(p), TaskLoc::Cell(d)) = (&pickup, &dropoff) {
                        if p == d {
                            fc.err(
                                codes::PICKUP_EQ_DROPOFF,
                                format!("任务 `{id}` 取货与送达格相同（退化输入，契约拒绝）"),
                            );
                        }
                    }
                    let release_step = tj.get("release_step").and_then(as_u32).unwrap_or(0);
                    let priority = tj.get("priority").and_then(as_u32).unwrap_or(1).max(1);
                    let pickup_service = tj.get("pickup_service").and_then(as_u32).unwrap_or(0);
                    let dropoff_service = tj.get("dropoff_service").and_then(as_u32).unwrap_or(0);
                    let due_step = match tj.get("due_step") {
                        Some(Json::Null) | None => None,
                        Some(j) => as_u32(j),
                    };
                    let required_capability = match tj.get("required_capability") {
                        Some(Json::Null) | None => None,
                        Some(j) => j.as_str().map(str::to_string),
                    };
                    tasks.push(Task {
                        idx: tasks.len(),
                        id,
                        pickup,
                        dropoff,
                        release_step,
                        priority,
                        pickup_service,
                        dropoff_service,
                        due_step,
                        required_capability,
                    });
                }
            }
            None => tc.err(
                codes::MISSING_FIELD,
                "缺少 tasks（可为空数组，但字段必须存在）",
            ),
        }
    }

    // —— 停车 ——
    let mut parking = Vec::new();
    {
        let mut pc = c.field("parking");
        if let Some(list) = root.get("parking").and_then(|x| x.as_arr()) {
            let mut seen = std::collections::BTreeSet::new();
            let station_cells: std::collections::BTreeSet<Cell> = stations
                .iter()
                .flat_map(|s| s.cells.iter().copied())
                .collect();
            for (i, cj) in list.iter().enumerate() {
                let mut fc = pc.idx(i);
                if let Some(cell) = parse_cell(&mut fc, Some(cj), &map) {
                    if map.is_blocked(cell) {
                        fc.err(
                            codes::LOC_BLOCKED,
                            format!("停车格 {c} 在障碍格", c = fmt_cell(&map, cell)),
                        );
                    }
                    if !seen.insert(cell) {
                        fc.err(
                            codes::DUP_PARKING,
                            format!("停车格 {c} 重复", c = fmt_cell(&map, cell)),
                        );
                    }
                    if station_cells.contains(&cell) {
                        fc.err(
                            codes::PARKING_CONFLICT,
                            format!(
                                "停车格 {c} 与工作站泊位重叠（会永久占用泊位）",
                                c = fmt_cell(&map, cell)
                            ),
                        );
                    }
                    parking.push(cell);
                }
            }
        }
    }

    // —— 目标权重 ——
    let weights = {
        let mut w = Weights::default();
        if let Some(o) = root.get("objective") {
            if let Some(ws) = o.get("weights") {
                if let Some(x) = ws.get("makespan").and_then(|j| j.as_f64()) {
                    w.makespan = x;
                }
                if let Some(x) = ws.get("flow_time").and_then(|j| j.as_f64()) {
                    w.flow_time = x;
                }
                if let Some(x) = ws.get("empty_travel").and_then(|j| j.as_f64()) {
                    w.empty_travel = x;
                }
                if let Some(x) = ws.get("lateness").and_then(|j| j.as_f64()) {
                    w.lateness = x;
                }
            }
        }
        w
    };

    // —— 求解参数 ——
    let solver = {
        let mut s = SolverOpts::default();
        if let Some(sj) = root.get("solver") {
            if let Some(a) = sj.get("algorithm").and_then(as_str) {
                if matches!(a, "auto" | "baseline" | "insertion-ls") {
                    s.algorithm = a.to_string();
                } else {
                    issues.push(Issue::error(
                        codes::SCHEMA,
                        "solver.algorithm",
                        format!("未知算法 `{a}`"),
                    ));
                }
            }
            if let Some(t) = sj.get("time_limit_ms").and_then(|j| j.as_i64()) {
                s.time_limit_ms = t.max(1);
            }
            if let Some(sd) = sj.get("seed").and_then(|j| j.as_i64()) {
                s.seed = sd.max(0) as u64;
            }
            if let Some(f) = sj.get("frozen_steps").and_then(as_u32) {
                s.frozen_steps = f;
            }
            if let Some(m) = sj.get("mapf") {
                if let Some(p) = m.get("planner").and_then(as_str) {
                    s.mapf.planner = p.to_string();
                }
                if let Some(x) = m.get("suboptimality_factor").and_then(|j| j.as_f64()) {
                    s.mapf.w = x.clamp(1.0, 3.0);
                }
                if let Some(t) = m.get("time_limit_ms").and_then(|j| j.as_i64()) {
                    s.mapf.time_limit_ms = t.max(1);
                }
            }
        }
        s
    };

    // —— 动态块 ——
    let dynamic = parse_dynamic(&root, &map, &stations, &vehicles, &tasks, &mut issues);

    if issues
        .iter()
        .any(|i| i.severity == crate::errors::Severity::Error)
    {
        return Err(issues);
    }

    // —— 能力门控 ——
    let resolved_horizon = horizon.unwrap_or(u32::MAX);
    if let Err((code, msg)) = crate::capabilities::gate(
        profile,
        vehicles.len(),
        tasks.len(),
        map.n_cells(),
        resolved_horizon.min(crate::capabilities::Limits::for_profile(profile).max_horizon),
        solver.time_limit_ms,
        dynamic.as_ref().map(|d| d.events.len()).unwrap_or(0),
    ) {
        issues.extend(crate::capabilities::gate_issues((code, msg)));
        return Err(issues);
    }

    Ok(Problem {
        id: root.get("id").and_then(as_str).map(str::to_string),
        map,
        horizon,
        vehicles,
        tasks,
        stations,
        parking,
        weights,
        solver,
        dynamic,
        tags: root.get("tags").cloned(),
    })
}

fn parse_loc(
    c: &mut Ctx,
    j: Option<&Json>,
    map: &MapData,
    stations: &[Station],
) -> Option<TaskLoc> {
    let j = j?;
    if let Some(cellj) = j.as_arr() {
        if cellj.len() == 2 {
            return parse_cell(c, Some(j), map).map(TaskLoc::Cell);
        }
    }
    if let Some(sid) = j.get("station").and_then(as_str) {
        match stations.iter().position(|s| s.id == sid) {
            Some(i) => return Some(TaskLoc::Station(i)),
            None => {
                c.err(
                    codes::UNKNOWN_STATION,
                    format!("引用了未声明的工作站 `{sid}`"),
                );
                return None;
            }
        }
    }
    c.err(codes::SCHEMA, "位置必须是 [x,y] 或 {\"station\": id}");
    None
}

fn parse_dynamic(
    root: &Json,
    map: &MapData,
    stations: &[Station],
    vehicles: &[Vehicle],
    tasks: &[Task],
    issues: &mut Vec<Issue>,
) -> Option<DynamicInput> {
    let d = root.get("dynamic")?;
    let mut c = Ctx::new(issues);
    let mut c = c.field("dynamic");
    known_fields(d, &["snapshot", "events"], &mut c);
    let snap = d.get("snapshot")?;
    let time = snap.get("time").and_then(as_u32).unwrap_or(0);
    if time == 0 && snap.get("time").is_none() {
        c.field("snapshot")
            .err(codes::MISSING_FIELD, "缺少 snapshot.time");
    }
    let mut vsnaps: Vec<Option<VehicleSnap>> = vehicles.iter().map(|_| None).collect();
    if let Some(vmap) = snap.get("vehicles").and_then(|x| x.as_obj()) {
        for (vid, vj) in vmap {
            let vi = vehicles.iter().position(|v| &v.id == vid);
            let mut s1 = c.field("snapshot");
            let mut s2 = s1.field("vehicles");
            let mut fc = s2.field(vid);
            let vi = match vi {
                Some(i) => i,
                None => {
                    fc.err(codes::EVENT_TARGET, format!("快照引用了未声明车辆 `{vid}`"));
                    continue;
                }
            };
            let pos = match parse_cell(&mut fc, vj.get("pos"), map) {
                Some(p) => p,
                None => continue,
            };
            let phase = vj
                .get("phase")
                .and_then(as_str)
                .unwrap_or("idle")
                .to_string();
            let task = vj
                .get("task")
                .and_then(as_str)
                .and_then(|t| tasks.iter().position(|x| x.id == t));
            let path = vj
                .get("path")
                .and_then(|x| x.as_arr())
                .map(|a| {
                    a.iter()
                        .filter_map(|cj| {
                            let arr = cj.as_arr()?;
                            if arr.len() != 2 {
                                return None;
                            }
                            let (x, y) = (as_u32(&arr[0])?, as_u32(&arr[1])?);
                            map.cell(x, y)
                        })
                        .collect::<Vec<Cell>>()
                })
                .unwrap_or_default();
            if path.is_empty() {
                fc.err(
                    codes::SNAP_PATH,
                    format!("车辆 `{vid}` 缺少已执行路径（至少 [pos] 一项）"),
                );
                continue;
            }
            if path.len() as u32 <= time {
                fc.err(
                    codes::SNAP_PATH,
                    format!(
                        "车辆 `{vid}` 执行路径止于 t={}，不足以覆盖快照时刻 t={time}",
                        path.len() - 1
                    ),
                );
                continue;
            }
            if path[time as usize] != pos {
                fc.err(
                    codes::SNAP_PATH,
                    format!("车辆 `{vid}` 快照位置与路径在 t={time} 不一致"),
                );
                continue;
            }
            vsnaps[vi] = Some(VehicleSnap {
                pos,
                phase,
                task,
                path,
            });
        }
    }
    let mut tsnaps: Vec<TaskSnap> = tasks
        .iter()
        .map(|_| TaskSnap {
            status: "pending".into(),
            assignee: None,
            pickup_dock: None,
            dropoff_dock: None,
            pickup_arrival: None,
            pickup_done: None,
            dropoff_arrival: None,
            dropoff_done: None,
        })
        .collect();
    if let Some(tmap) = snap.get("tasks").and_then(|x| x.as_obj()) {
        for (tid, tj) in tmap {
            let mut s1 = c.field("snapshot");
            let mut s2 = s1.field("tasks");
            let mut fc = s2.field(tid);
            let ti = tasks.iter().position(|t| &t.id == tid);
            let ti = match ti {
                Some(i) => i,
                None => {
                    fc.err(codes::EVENT_TARGET, format!("快照引用了未声明任务 `{tid}`"));
                    continue;
                }
            };
            let status = tj
                .get("status")
                .and_then(as_str)
                .unwrap_or("pending")
                .to_string();
            let assignee = tj
                .get("assignee")
                .and_then(as_str)
                .and_then(|v| vehicles.iter().position(|x| x.id == v));
            let snap_cell = |key: &str| -> Option<Cell> {
                let arr = tj.get(key).and_then(|x| x.as_arr())?;
                if arr.len() != 2 {
                    return None;
                }
                map.cell(arr[0].as_i64()? as u32, arr[1].as_i64()? as u32)
            };
            let snap_u32 = |key: &str| {
                tj.get(key)
                    .and_then(|x| x.as_i64())
                    .and_then(|v| u32::try_from(v).ok())
            };
            tsnaps[ti] = TaskSnap {
                status,
                assignee,
                pickup_dock: snap_cell("pickup_dock"),
                dropoff_dock: snap_cell("dropoff_dock"),
                pickup_arrival: snap_u32("pickup_arrival"),
                pickup_done: snap_u32("pickup_done"),
                dropoff_arrival: snap_u32("dropoff_arrival"),
                dropoff_done: snap_u32("dropoff_done"),
            };
        }
    }
    let mut events = Vec::new();
    if let Some(list) = d.get("events").and_then(|x| x.as_arr()) {
        for (i, ej) in list.iter().enumerate() {
            let mut e1 = c.field("events");
            let mut fc = e1.idx(i);
            let kind = ej.get("type").and_then(as_str).unwrap_or("");
            let task_ref = |fc: &mut Ctx| -> Option<usize> {
                let tid = match ej.get("task").and_then(as_str) {
                    Some(t) => t,
                    None => {
                        fc.err(codes::MISSING_FIELD, "事件缺少 task 引用");
                        return None;
                    }
                };
                if let Some(i) = tasks.iter().position(|x| x.id == tid) {
                    return Some(i);
                }
                // 同批次 task_add 新增任务：下标 = 基础任务数 + 此前新增序号
                let mut extra = 0usize;
                for e in &events {
                    if let Event::TaskAdd { task } = e {
                        if task.id == tid {
                            return Some(tasks.len() + extra);
                        }
                        extra += 1;
                    }
                }
                fc.err(codes::EVENT_TARGET, "事件引用了未声明任务");
                None
            };
            let veh_ref = |fc: &mut Ctx| -> Option<usize> {
                ej.get("vehicle")
                    .and_then(as_str)
                    .and_then(|v| vehicles.iter().position(|x| x.id == v))
                    .or_else(|| {
                        fc.err(codes::EVENT_TARGET, "事件引用了未声明车辆");
                        None
                    })
            };
            match kind {
                "task_add" => {
                    if let Some(def) = ej.get("task_def") {
                        let pickup = parse_loc(&mut fc, def.get("pickup"), map, stations);
                        let dropoff = parse_loc(&mut fc, def.get("dropoff"), map, stations);
                        if let (Some(pickup), Some(dropoff)) = (pickup, dropoff) {
                            events.push(Event::TaskAdd {
                                task: Task {
                                    idx: tasks.len() + events.len(), // 引擎层重排（dynamic.rs）
                                    id: def
                                        .get("id")
                                        .and_then(as_str)
                                        .unwrap_or("T-new")
                                        .to_string(),
                                    pickup,
                                    dropoff,
                                    release_step: def
                                        .get("release_step")
                                        .and_then(as_u32)
                                        .unwrap_or(0),
                                    priority: def
                                        .get("priority")
                                        .and_then(as_u32)
                                        .unwrap_or(1)
                                        .max(1),
                                    pickup_service: def
                                        .get("pickup_service")
                                        .and_then(as_u32)
                                        .unwrap_or(0),
                                    dropoff_service: def
                                        .get("dropoff_service")
                                        .and_then(as_u32)
                                        .unwrap_or(0),
                                    due_step: match def.get("due_step") {
                                        Some(Json::Null) | None => None,
                                        Some(j) => as_u32(j),
                                    },
                                    required_capability: def
                                        .get("required_capability")
                                        .and_then(as_str)
                                        .map(str::to_string),
                                },
                            });
                        }
                    } else {
                        fc.err(codes::MISSING_FIELD, "task_add 需要 task_def");
                    }
                }
                "task_cancel" => {
                    if let Some(t) = task_ref(&mut fc) {
                        events.push(Event::TaskCancel { task: t });
                    }
                }
                "task_priority" => {
                    if let Some(t) = task_ref(&mut fc) {
                        events.push(Event::TaskPriority {
                            task: t,
                            priority: ej.get("priority").and_then(as_u32).unwrap_or(1).max(1),
                        });
                    }
                }
                "vehicle_pause" => {
                    if let Some(v) = veh_ref(&mut fc) {
                        events.push(Event::VehiclePause { vehicle: v });
                    }
                }
                "vehicle_resume" => {
                    if let Some(v) = veh_ref(&mut fc) {
                        events.push(Event::VehicleResume { vehicle: v });
                    }
                }
                "obstacle_add" | "obstacle_remove" => {
                    if let Some(cell) = parse_cell(&mut fc, ej.get("cell"), map) {
                        let at = ej.get("at").and_then(as_u32).unwrap_or(time);
                        if at < time {
                            fc.err(
                                codes::EVENT_TIME,
                                format!("障碍事件 at={at} 早于快照时刻 {time}"),
                            );
                        }
                        if kind == "obstacle_add" {
                            let until = ej.get("until").and_then(|x| {
                                if x.is_null() {
                                    None
                                } else {
                                    as_u32(x)
                                }
                            });
                            events.push(Event::ObstacleAdd { cell, at, until });
                        } else {
                            events.push(Event::ObstacleRemove { cell, at });
                        }
                    }
                }
                other => {
                    fc.err(codes::EVENT_KIND, format!("未知事件类型 `{other}`"));
                }
            }
        }
    }
    Some(DynamicInput {
        time,
        vehicles: vsnaps,
        tasks: tsnaps,
        events,
    })
}

pub fn fmt_cell(map: &MapData, c: Cell) -> String {
    format!("({},{})", map.x_of(c), map.y_of(c))
}

/// 地图 → mapf-problem/1.0 的 map.cells 文本（'.'/'#'）。
pub fn map_cells_text(map: &MapData, extra_walls: &[Cell]) -> String {
    let mut walls = vec![false; map.n_cells()];
    for &c in extra_walls {
        walls[c as usize] = true;
    }
    let mut out = String::new();
    for y in 0..map.height {
        for x in 0..map.width {
            let c = y * map.width + x;
            out.push(if map.is_blocked(c) || walls[c as usize] {
                '#'
            } else {
                '.'
            });
        }
        if y + 1 < map.height {
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn problem_text() -> String {
        r#"{
            "schema_version": "agv-dispatch-problem/1.0",
            "id": "t1",
            "map": { "cells": ["....", "....", "...."] },
            "time_model": { "timestep": "discrete", "horizon": 50 },
            "vehicles": [ { "id": "V1", "start": [0,0] }, { "id": "V2", "start": [3,2] } ],
            "tasks": [ { "id": "T1", "pickup": [1,0], "dropoff": [2,2], "release_step": 2 } ],
            "objective": { "kind": "lexicographic-weighted" }
        }"#
        .to_string()
    }

    #[test]
    fn accepts_minimal() {
        let p = parse_problem(&problem_text(), Profile::Native).expect("ok");
        assert_eq!(p.vehicles.len(), 2);
        assert_eq!(p.tasks.len(), 1);
        assert_eq!(p.tasks[0].release_step, 2);
        assert_eq!(p.horizon, Some(50));
        assert_eq!(p.vehicles[0].capabilities, vec!["general".to_string()]);
    }

    #[test]
    fn rejects_dup_starts_and_bad_station() {
        let bad = r#"{
            "map": { "cells": ["...","..."] },
            "time_model": { "horizon": 10 },
            "vehicles": [ { "id": "V1", "start": [0,0] }, { "id": "V2", "start": [0,0] } ],
            "tasks": [],
            "stations": [ { "id": "S1", "cells": [[9,9]] } ],
            "objective": { "kind": "lexicographic-weighted" }
        }"#;
        let issues = parse_problem(bad, Profile::Native).unwrap_err();
        assert!(issues.iter().any(|i| i.code == codes::DUP_START));
        assert!(issues.iter().any(|i| i.code == codes::COORD_RANGE));
    }

    #[test]
    fn station_ref_and_capacity() {
        let text = r#"{
            "map": { "cells": [".....","....."] },
            "time_model": { "horizon": "auto" },
            "vehicles": [ { "id": "V1", "start": [0,0] } ],
            "tasks": [ { "id": "T1", "pickup": {"station": "ST"}, "dropoff": [4,1] } ],
            "stations": [ { "id": "ST", "cells": [[2,0],[3,0]], "capacity": 1 } ],
            "objective": { "kind": "lexicographic-weighted" }
        }"#;
        let p = parse_problem(text, Profile::Native).expect("ok");
        assert_eq!(p.tasks[0].pickup, TaskLoc::Station(0));
        assert_eq!(p.stations[0].capacity, 1);
        assert_eq!(p.horizon, None);
        assert_eq!(p.tasks[0].pickup.dock_candidates(&p.stations).len(), 2);
    }

    #[test]
    fn reachable_bfs() {
        let text = r##"{
            "map": { "cells": ["..#..", "..#..", "..#.."] },
            "time_model": { "horizon": "auto" },
            "vehicles": [ { "id": "V1", "start": [0,0] } ],
            "tasks": [ { "id": "T1", "pickup": [1,0], "dropoff": [1,2] } ],
            "objective": { "kind": "lexicographic-weighted" }
        }"##;
        let p = parse_problem(text, Profile::Native).expect("ok");
        let c = |x: u32, y: u32| p.map.cell(x, y).unwrap();
        assert!(p.map.reachable(c(0, 0), c(1, 2)), "同侧可达");
        assert!(!p.map.reachable(c(0, 0), c(3, 0)), "整列墙隔离 ⇒ 不可达");
        assert!(!p.map.reachable(c(0, 0), c(2, 1)), "目标是障碍格 ⇒ 不可达");
    }
}
