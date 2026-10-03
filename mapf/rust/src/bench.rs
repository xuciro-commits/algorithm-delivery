//! 固定基准批量测试（SRS §6）：读取 `mapf/bench/manifest.json`，逐实例转换 + 求解 +
//! 独立核验，产出完整逐实例结果与聚合统计。**所有**实例（含失败/超时）都进入报告。

use std::fs;
use std::path::{Path, PathBuf};

use aps_engine::engine::CancelToken;
use aps_engine::json::Json;
use aps_engine::{alloc, clock, hash};

use crate::capabilities::Profile;
use crate::engine::{self, SolveOptions};
use crate::errors::Status;
use crate::movingai;

#[derive(Debug)]
pub struct BenchEntry {
    pub name: String,
    pub family: String,
    pub map_file: String,
    pub map_sha256: String,
    pub scen_file: String,
    pub scen_sha256: String,
    pub agent_counts: Vec<usize>,
    pub note: String,
}

#[derive(Debug)]
pub struct Manifest {
    pub schema_version: String,
    pub entries: Vec<BenchEntry>,
    pub budgets_ms: Vec<i64>,
    pub objectives: Vec<String>,
    pub w: f64,
    pub seed: u64,
    pub horizon: String,
    pub upstream: Vec<(String, String)>,
    pub raw: Json,
}

pub fn load_manifest(path: &Path) -> Result<Manifest, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("读取清单失败 {path:?}: {e}"))?;
    let root = aps_engine::json::parse(&text).map_err(|e| format!("清单 JSON 非法: {e}"))?;
    let entries = root
        .get("entries")
        .and_then(|e| e.as_arr())
        .map(|a| a.to_vec())
        .unwrap_or_default();
    let mut out = Vec::new();
    for e in entries {
        let g = |k: &str| e.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let agent_counts = e
            .get("agent_counts")
            .and_then(|v| v.as_arr())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_i64())
                    .map(|x| x as usize)
                    .collect()
            })
            .unwrap_or_default();
        out.push(BenchEntry {
            name: g("name"),
            family: g("family"),
            map_file: g("map_file"),
            map_sha256: g("map_sha256"),
            scen_file: g("scen_file"),
            scen_sha256: g("scen_sha256"),
            agent_counts,
            note: g("note"),
        });
    }
    Ok(Manifest {
        schema_version: root
            .get("schema_version")
            .and_then(|v| v.as_str())
            .unwrap_or("mapf-bench-manifest/1.0")
            .to_string(),
        entries: out,
        budgets_ms: root
            .get("budgets_ms")
            .and_then(|v| v.as_arr())
            .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
            .unwrap_or_else(|| vec![1000, 10000, 60000]),
        objectives: root
            .get("objectives")
            .and_then(|v| v.as_arr())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_else(|| vec!["soc".into()]),
        w: root
            .get("suboptimality_factor")
            .and_then(|v| v.as_f64())
            .unwrap_or(1.0),
        seed: root.get("seed").and_then(|v| v.as_i64()).unwrap_or(42) as u64,
        horizon: root
            .get("horizon")
            .and_then(|v| v.as_str())
            .unwrap_or("auto")
            .to_string(),
        upstream: root
            .get("upstream")
            .and_then(|v| v.as_obj())
            .map(|o| {
                o.iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
                    .collect()
            })
            .unwrap_or_default(),
        raw: root,
    })
}

/// 校验清单中的文件哈希（CI 门：数据不可漂移）。
pub fn verify_manifest(manifest_path: &Path, m: &Manifest) -> Vec<Issue3> {
    let mut issues = Vec::new();
    let dir = manifest_path
        .parent()
        .unwrap_or(Path::new("."))
        .to_path_buf();
    for e in &m.entries {
        for (what, rel, sha) in [
            ("map", &e.map_file, &e.map_sha256),
            ("scen", &e.scen_file, &e.scen_sha256),
        ] {
            let path = dir.join(rel);
            match fs::read(&path) {
                Ok(bytes) => {
                    let digest = format!("sha256:{}", hash::sha256_hex(&bytes));
                    if !sha.is_empty() && digest != *sha {
                        issues.push(Issue3(format!(
                            "{}:{} 哈希漂移：清单 {sha}，实际 {digest}",
                            e.name, what
                        )));
                    }
                    // 地图可解析性
                    if what == "map" {
                        if let Err(err) = movingai::parse_map(&String::from_utf8_lossy(&bytes)) {
                            issues.push(Issue3(format!("{}:map 解析失败：{err}", e.name)));
                        }
                    }
                    if what == "scen" {
                        if let Err(err) = movingai::parse_scen(&String::from_utf8_lossy(&bytes)) {
                            issues.push(Issue3(format!("{}:scen 解析失败：{err}", e.name)));
                        }
                    }
                }
                Err(_) => issues.push(Issue3(format!(
                    "{}:{} 文件缺失 {}",
                    e.name,
                    what,
                    path.display()
                ))),
            }
        }
    }
    issues
}

pub struct Issue3(pub String);

#[allow(clippy::too_many_arguments)]
pub fn run(
    manifest_path: &Path,
    only: Option<&str>,
    budgets: Option<&[i64]>,
    objective: Option<&str>,
    profile: Profile,
    out: Option<&PathBuf>,
    progress: bool,
    wasm_module: Option<&Path>,
) -> Result<Json, String> {
    let m = load_manifest(manifest_path)?;
    let dir = manifest_path
        .parent()
        .unwrap_or(Path::new("."))
        .to_path_buf();
    let budgets: Vec<i64> = match budgets {
        Some(b) => b.to_vec(),
        None => m.budgets_ms.clone(),
    };
    let objectives: Vec<String> = match objective {
        Some(o) => vec![o.to_string()],
        None => m.objectives.clone(),
    };
    if objectives.is_empty() {
        return Err("清单未声明 objectives".into());
    }

    // WASM 模式：把每个问题交给 dist wasm（node 侧脚本负责；这里仅 native 分支）。
    let _ = wasm_module;

    let mut rows: Vec<Json> = Vec::new();
    let t_all = clock::now_ms();
    for e in &m.entries {
        if let Some(o) = only {
            if !e.name.contains(o) && !e.family.contains(o) {
                continue;
            }
        }
        let map_bytes = fs::read(dir.join(&e.map_file))
            .map_err(|err| format!("{} map 读取失败: {err}", e.name))?;
        let scen_bytes = fs::read(dir.join(&e.scen_file))
            .map_err(|err| format!("{} scen 读取失败: {err}", e.name))?;
        let map = movingai::parse_map(&String::from_utf8_lossy(&map_bytes))?;
        let scen = movingai::parse_scen(&String::from_utf8_lossy(&scen_bytes))?;
        for &agents in &e.agent_counts {
            for obj in &objectives {
                for &budget in &budgets {
                    let conv = movingai::ConvertOptions {
                        agents,
                        horizon: if m.horizon == "auto" {
                            None
                        } else {
                            m.horizon.parse().ok()
                        },
                        budget_ms: budget,
                        objective: if obj == "makespan" { "makespan" } else { "soc" },
                        w: m.w,
                        seed: m.seed,
                        map_sha256: e.map_sha256.clone(),
                        scen_sha256: e.scen_sha256.clone(),
                        map_file: e.map_file.clone(),
                        scen_file: e.scen_file.clone(),
                    };
                    let problem = movingai::build_problem(&map, &scen, &conv)?;
                    let problem_text = problem.to_compact();
                    let opts = SolveOptions {
                        profile,
                        verify: true,
                        ..Default::default()
                    };
                    alloc::reset_peak();
                    let t = clock::now_ms();
                    let outcome = engine::solve_json(&problem_text, &opts, &CancelToken::new());
                    let wall_ms = clock::now_ms() - t;
                    let sol = &outcome.solution;
                    let verified = sol
                        .get("verified")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let mut row: Vec<(&str, Json)> = vec![
                        ("instance", Json::str(format!("{}:{}", e.name, agents))),
                        ("family", Json::str(e.family.clone())),
                        ("agents", Json::int(agents as i64)),
                        ("objective", Json::str(obj.clone())),
                        ("budget_ms", Json::int(budget)),
                        ("status", Json::str(outcome.status.as_str())),
                        ("verified", Json::Bool(verified)),
                        ("soc", sol.get("soc").cloned().unwrap_or(Json::Null)),
                        (
                            "makespan",
                            sol.get("makespan").cloned().unwrap_or(Json::Null),
                        ),
                        (
                            "lower_bound",
                            sol.get("objective")
                                .and_then(|o| o.get("lower_bound"))
                                .cloned()
                                .unwrap_or(Json::Null),
                        ),
                        (
                            "gap",
                            sol.get("objective")
                                .and_then(|o| o.get("gap"))
                                .cloned()
                                .unwrap_or(Json::Null),
                        ),
                        ("wall_ms", Json::Float((wall_ms * 1000.0).round() / 1000.0)),
                        (
                            "compile_ms",
                            sol.get("metrics")
                                .and_then(|x| x.get("compile_ms"))
                                .cloned()
                                .unwrap_or(Json::Null),
                        ),
                        (
                            "first_feasible_ms",
                            sol.get("metrics")
                                .and_then(|x| x.get("first_feasible_ms"))
                                .cloned()
                                .unwrap_or(Json::Null),
                        ),
                        (
                            "solve_ms",
                            sol.get("metrics")
                                .and_then(|x| x.get("solve_ms"))
                                .cloned()
                                .unwrap_or(Json::Null),
                        ),
                        (
                            "verify_ms",
                            sol.get("metrics")
                                .and_then(|x| x.get("verify_ms"))
                                .cloned()
                                .unwrap_or(Json::Null),
                        ),
                        ("peak_memory_bytes", Json::int(alloc::peak_bytes() as i64)),
                        (
                            "hl_expansions",
                            sol.get("search")
                                .and_then(|x| x.get("hl_expansions"))
                                .cloned()
                                .unwrap_or(Json::Null),
                        ),
                        (
                            "ll_expansions",
                            sol.get("search")
                                .and_then(|x| x.get("ll_expansions"))
                                .cloned()
                                .unwrap_or(Json::Null),
                        ),
                        ("seed", Json::int(m.seed as i64)),
                        ("suboptimality_factor", Json::Float(m.w)),
                        (
                            "semantic_digest",
                            sol.get("semantic_digest").cloned().unwrap_or(Json::Null),
                        ),
                        (
                            "problem_hash",
                            sol.get("problem_hash").cloned().unwrap_or(Json::Null),
                        ),
                        (
                            "horizon_used",
                            sol.get("horizon").cloned().unwrap_or(Json::Null),
                        ),
                    ];
                    if outcome.status != Status::Optimal && outcome.status != Status::Feasible {
                        row.push((
                            "errors",
                            sol.get("errors").cloned().unwrap_or(Json::Arr(vec![])),
                        ));
                    }
                    rows.push(Json::obj(row.clone()));
                    if progress {
                        let summary: Vec<&str> = vec![];
                        let _ = summary;
                        println!(
                            "· {:>28} {:>8} {:>8} t={:>5}ms {}",
                            format!("{}:{}", e.name, agents),
                            obj,
                            format!("{budget}ms"),
                            wall_ms.round() as i64,
                            outcome.status.as_str(),
                        );
                    }
                }
            }
        }
    }
    let summary = summarize(&rows);
    let report = Json::obj(vec![
        ("schema_version", Json::str("mapf-bench-results/1.0")),
        (
            "manifest_schema_version",
            Json::str(m.schema_version.clone()),
        ),
        (
            "manifest",
            Json::obj(
                m.upstream
                    .iter()
                    .map(|(k, v)| (k.as_str(), Json::str(v.clone())))
                    .collect::<Vec<(&str, Json)>>()
                    .into_iter()
                    .chain(std::iter::once((
                        "manifest_sha256",
                        Json::str(format!(
                            "sha256:{}",
                            hash::sha256_hex(&fs::read(manifest_path).map_err(|e| e.to_string())?)
                        )),
                    )))
                    .collect::<Vec<(&str, Json)>>(),
            ),
        ),
        ("profile", Json::str(profile.as_str())),
        (
            "total_wall_ms",
            Json::Float(((clock::now_ms() - t_all) * 1000.0).round() / 1000.0),
        ),
        ("rows", Json::Arr(rows)),
        ("summary", summary),
    ]);
    if let Some(p) = out {
        if let Some(parent) = p.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(p, report.to_pretty()).map_err(|e| format!("写出失败: {e}"))?;
    }
    Ok(report)
}

fn summarize(rows: &[Json]) -> Json {
    struct Agg {
        n: usize,
        ok: usize,
        optimal: usize,
        feasible: usize,
        unknown: usize,
        infeasible: usize,
        invalid: usize,
        verified_fail: usize,
        soc_sum: i64,
        mk_sum: i64,
        time_sum_ms: f64,
        time_max_ms: f64,
        first_sum: f64,
        first_n: usize,
        gap_sum: f64,
        gap_n: usize,
    }
    use std::collections::BTreeMap;
    let mut by: BTreeMap<(String, i64, String, i64), Agg> = BTreeMap::new();
    for r in rows {
        let fam = r
            .get("family")
            .and_then(|v| v.as_str())
            .unwrap_or("?")
            .to_string();
        let agents = r.get("agents").and_then(|v| v.as_i64()).unwrap_or(0);
        let obj = r
            .get("objective")
            .and_then(|v| v.as_str())
            .unwrap_or("soc")
            .to_string();
        let budget = r.get("budget_ms").and_then(|v| v.as_i64()).unwrap_or(0);
        let a = by.entry((fam, agents, obj, budget)).or_insert(Agg {
            n: 0,
            ok: 0,
            optimal: 0,
            feasible: 0,
            unknown: 0,
            infeasible: 0,
            invalid: 0,
            verified_fail: 0,
            soc_sum: 0,
            mk_sum: 0,
            time_sum_ms: 0.0,
            time_max_ms: 0.0,
            first_sum: 0.0,
            first_n: 0,
            gap_sum: 0.0,
            gap_n: 0,
        });
        a.n += 1;
        match r.get("status").and_then(|v| v.as_str()).unwrap_or("") {
            "OPTIMAL" => {
                a.optimal += 1;
                a.ok += 1;
            }
            "FEASIBLE" => {
                a.feasible += 1;
                a.ok += 1;
            }
            "UNKNOWN" | "CANCELLED" => a.unknown += 1,
            "INFEASIBLE" => a.infeasible += 1,
            _ => a.invalid += 1,
        }
        if a.ok > 0 || true {
            if let Some(false) = r.get("verified").and_then(|v| v.as_bool()) {
                let st = r.get("status").and_then(|v| v.as_str()).unwrap_or("");
                if st == "OPTIMAL" || st == "FEASIBLE" {
                    a.verified_fail += 1;
                }
            }
        }
        if let Some(s) = r.get("soc").and_then(|v| v.as_i64()) {
            a.soc_sum += s;
        }
        if let Some(s) = r.get("makespan").and_then(|v| v.as_i64()) {
            a.mk_sum += s;
        }
        let t = r.get("wall_ms").and_then(|v| v.as_f64()).unwrap_or(0.0);
        a.time_sum_ms += t;
        a.time_max_ms = a.time_max_ms.max(t);
        if let Some(f) = r.get("first_feasible_ms").and_then(|v| v.as_f64()) {
            a.first_sum += f;
            a.first_n += 1;
        }
        if let Some(g) = r.get("gap").and_then(|v| v.as_f64()) {
            if g.is_finite() {
                a.gap_sum += g;
                a.gap_n += 1;
            }
        }
    }
    let items: Vec<Json> = by
        .into_iter()
        .map(|((fam, agents, obj, budget), a)| {
            Json::obj(vec![
                ("family", Json::str(fam)),
                ("agents", Json::int(agents)),
                ("objective", Json::str(obj)),
                ("budget_ms", Json::int(budget)),
                ("instances", Json::int(a.n as i64)),
                ("solved", Json::int(a.ok as i64)),
                ("optimal", Json::int(a.optimal as i64)),
                ("feasible", Json::int(a.feasible as i64)),
                ("unknown", Json::int(a.unknown as i64)),
                ("infeasible_proven", Json::int(a.infeasible as i64)),
                ("invalid_or_unsupported", Json::int(a.invalid as i64)),
                ("verification_failures", Json::int(a.verified_fail as i64)),
                (
                    "solve_rate",
                    Json::Float(((a.ok as f64) / (a.n.max(1)) as f64 * 1e4).round() / 1e4),
                ),
                (
                    "mean_soc",
                    Json::Float((a.soc_sum as f64 / a.n.max(1) as f64 * 100.0).round() / 100.0),
                ),
                (
                    "mean_makespan",
                    Json::Float((a.mk_sum as f64 / a.n.max(1) as f64 * 100.0).round() / 100.0),
                ),
                (
                    "mean_wall_ms",
                    Json::Float((a.time_sum_ms / a.n.max(1) as f64 * 10.0).round() / 10.0),
                ),
                (
                    "max_wall_ms",
                    Json::Float((a.time_max_ms * 10.0).round() / 10.0),
                ),
                (
                    "mean_first_feasible_ms",
                    if a.first_n > 0 {
                        Json::Float((a.first_sum / a.first_n as f64 * 10.0).round() / 10.0)
                    } else {
                        Json::Null
                    },
                ),
                (
                    "mean_gap",
                    if a.gap_n > 0 {
                        Json::Float((a.gap_sum / a.gap_n as f64 * 1e4).round() / 1e4)
                    } else {
                        Json::Null
                    },
                ),
            ])
        })
        .collect();
    Json::Arr(items)
}

/// `mapf bench --wasm path` 使用的说明位（避免 dead_code 警告）。
pub fn wasm_note() -> &'static str {
    "WASM 基准由 scripts/bench_wasm.mjs 使用 node + dist wasm 运行（同一核心、同一规则集），\n\
     结果并入 mapf/bench/results/ 报告中，标签 profile=wasm-light。"
}

pub const DEFAULT_MANIFEST: &str = "mapf/bench/manifest.json";
