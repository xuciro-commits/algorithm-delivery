//! 性能冒烟（AGV-SRS §10 指标口径）：`agv bench` 运行，不进 cargo test。
//!
//! 全部用固定种子的确定性生成器构造（无 RNG 依赖，可复现）。

use aps_engine::engine::CancelToken;
use aps_engine::json::Json;

use crate::acceptance::{make_problem, snapshot_at, TaskSpec};
use crate::capabilities::Profile;
use crate::engine::{solve_json, Outcome, SolveOptions};
use crate::errors::Status;

/// 线性同余（确定性）。
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn bench_map(w: u32, h: u32, seed: u64, density: u64) -> Vec<(u32, u32)> {
    let mut r = Lcg(seed);
    let mut walls = Vec::new();
    for _ in 0..density {
        let x = (r.below(w as u64 - 2) + 1) as u32;
        let y = (r.below(h as u64 - 2) + 1) as u32;
        walls.push((x, y));
    }
    walls
}

/// 在非墙格上取一个确定性格子。
fn free_cell(r: &mut Lcg, walls: &[(u32, u32)], w: u32, h: u32) -> (u32, u32) {
    loop {
        let c = (r.below(w as u64) as u32, r.below(h as u64) as u32);
        if !walls.contains(&c) {
            return c;
        }
    }
}

fn run_bench(id: &str, name: &str, text: &str, profile: Profile, max_ms: f64) -> Json {
    let cancel = CancelToken::new();
    let t0 = aps_engine::clock::now_ms();
    let out = solve_json(
        text,
        &SolveOptions {
            profile,
            verify: true,
            ..Default::default()
        },
        &cancel,
    );
    let ms = aps_engine::clock::now_ms() - t0;
    let completed = out
        .solution
        .get("metrics")
        .and_then(|m| m.get("completed_tasks"))
        .and_then(|j| j.as_i64())
        .unwrap_or(-1);
    let total = out
        .solution
        .get("metrics")
        .and_then(|m| m.get("total_tasks"))
        .and_then(|j| j.as_i64())
        .unwrap_or(-1);
    let mapf_solves = out
        .solution
        .get("search")
        .and_then(|m| m.get("mapf_solves"))
        .and_then(|j| j.as_i64())
        .unwrap_or(-1);
    let within = ms <= max_ms;
    let ok = verified(&out) && completed == total && within;
    Json::obj(vec![
        ("id", Json::str(id)),
        ("name", Json::str(name)),
        ("status", Json::str(if ok { "pass" } else { "fail" })),
        ("solve_status", Json::str(out.status.as_str())),
        ("verified", Json::Bool(verified(&out))),
        ("completed_tasks", Json::int(completed)),
        ("total_tasks", Json::int(total)),
        ("mapf_solves", Json::int(mapf_solves)),
        ("duration_ms", Json::Float((ms * 1000.0).round() / 1000.0)),
        ("budget_ms", Json::Float(max_ms)),
        ("within_budget", Json::Bool(within)),
    ])
}

fn verified(out: &Outcome) -> bool {
    out.solution
        .get("verified")
        .and_then(|j| j.as_bool())
        .unwrap_or(false)
}

/// B01 问题文本（40×25、8 车 20 任务、固定种子确定性墙）——bench 与 mock 导出共用。
pub fn b01_problem() -> String {
    let (w, h) = (40u32, 25u32);
    let walls = bench_map(w, h, 7, 60);
    let mut r = Lcg(99);
    let mut vehicles = Vec::new();
    let mut vcells = Vec::new();
    for i in 0..8 {
        let c = loop {
            let c = free_cell(&mut r, &walls, w, h);
            if !vcells.contains(&c) {
                break c;
            }
        };
        vcells.push(c);
        vehicles.push((format!("V{i}").leak() as &str, c.0, c.1, &[] as &[&str]));
    }
    let mut tasks = Vec::new();
    for i in 0..20 {
        let (px, py) = free_cell(&mut r, &walls, w, h);
        let (dx, dy) = loop {
            let c = free_cell(&mut r, &walls, w, h);
            if c != (px, py) {
                break c;
            }
        };
        let ps = r.below(3) as u32;
        let ds = r.below(3) as u32;
        tasks.push((
            format!("T{i}").leak() as &str,
            px,
            py,
            dx,
            dy,
            ps,
            ds,
            0,
            None::<u32>,
            None::<&str>,
        ));
    }
    make_problem(
        w,
        h,
        &walls,
        &vehicles,
        &tasks,
        400,
        &[],
        &[],
        Some(r#"{ "time_limit_ms": 30000 }"#),
    )
}

pub fn run(profile: Profile) -> Json {
    // B01：8 车 20 任务仓库规模
    let b01 = b01_problem();
    let c1 = run_bench("B01", "8 车 20 任务（40×25）", &b01, profile, 60_000.0);

    // B02：动态重调度延迟（在 B01 基础上取小规模）
    let (w2, h2) = (20u32, 12u32);
    let walls2 = bench_map(w2, h2, 11, 20);
    let v2: Vec<(&str, u32, u32, &[&str])> =
        vec![("A", 0, 0, &[]), ("B", 19, 11, &[]), ("C", 0, 11, &[])];
    let t2: Vec<TaskSpec<'_>> = vec![
        ("S1", 10, 1, 19, 5, 1, 1, 0, None, None),
        ("S2", 5, 6, 10, 11, 0, 1, 0, None, None),
        ("S3", 15, 10, 1, 3, 1, 0, 0, None, None),
        ("S4", 8, 4, 12, 8, 0, 0, 0, None, None),
    ];
    let base = make_problem(w2, h2, &walls2, &v2, &t2, 200, &[], &[], None);
    let cancel = CancelToken::new();
    let first = solve_json(
        &base,
        &SolveOptions {
            profile,
            verify: true,
            ..Default::default()
        },
        &cancel,
    );
    let c2 = if first.status == Status::Feasible {
        let events = vec![Json::obj(vec![
            ("type", Json::str("task_add")),
            (
                "task_def",
                Json::obj(vec![
                    ("id", Json::str("S5-new")),
                    ("pickup", Json::Arr(vec![Json::int(3), Json::int(7)])),
                    ("dropoff", Json::Arr(vec![Json::int(18), Json::int(2)])),
                ]),
            ),
        ])];
        let dyn_p = snapshot_at(&base, &first.solution, 4, events);
        run_bench(
            "B02",
            "动态重调度延迟（3 车 5 任务）",
            &dyn_p,
            profile,
            30_000.0,
        )
    } else {
        Json::obj(vec![
            ("id", Json::str("B02")),
            ("name", Json::str("动态重调度延迟")),
            ("status", Json::str("fail")),
            (
                "message",
                Json::str(format!("基础解失败：{}", first.status.as_str())),
            ),
        ])
    };

    // B03：单站容量压力（6 车，站 2 泊位容量 2）
    let t3: Vec<TaskSpec<'_>> = (0..6)
        .map(|i| {
            (
                format!("P{i}").leak() as &str,
                10,
                if i % 2 == 0 { 2 } else { 3 },
                2 + 2 * i,
                8,
                2,
                2,
                0,
                None::<u32>,
                None::<&str>,
            )
        })
        .collect();
    let v3: Vec<(&str, u32, u32, &[&str])> = (0..6)
        .map(|i| (format!("W{i}").leak() as &str, i * 3, 0, &[] as &[&str]))
        .collect();
    let b03 = make_problem(
        20,
        12,
        &[],
        &v3,
        &t3,
        300,
        &[("HUB", &[(10, 2), (10, 3)], 2)],
        &[],
        Some(r#"{ "time_limit_ms": 20000 }"#),
    );
    // pickup 改为工作站引用：6 任务共享 HUB（2 泊位、容量 2）→ 真正的容量压力
    let b03 = aps_engine::json::parse(&b03)
        .map(|mut j| {
            if let Some(ts) = j.get_mut("tasks").and_then(|t| t.as_arr_mut()) {
                for t in ts.iter_mut() {
                    t.set("pickup", Json::obj(vec![("station", Json::str("HUB"))]));
                }
            }
            j.to_compact()
        })
        .unwrap_or(b03);
    let c3 = run_bench(
        "B03",
        "单站容量压力（6 车 2 泊位）",
        &b03,
        profile,
        60_000.0,
    );

    let cases = vec![c1, c2, c3];
    let passed = cases
        .iter()
        .filter(|c| c.get("status").and_then(|j| j.as_str()) == Some("pass"))
        .count();
    Json::obj(vec![
        ("schema_version", Json::str("agv-bench/1.0")),
        ("engine", Json::str(crate::ENGINE_NAME)),
        ("engine_version", Json::str(crate::ENGINE_VERSION)),
        ("capability_profile", Json::str(profile.as_str())),
        ("cases", Json::Arr(cases)),
        (
            "summary",
            Json::obj(vec![
                ("total", Json::int(3)),
                ("passed", Json::int(passed as i64)),
                ("failed", Json::int((3 - passed) as i64)),
            ]),
        ),
    ])
}
