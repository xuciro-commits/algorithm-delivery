//! `mapf` CLI：solve / verify / bench / convert / capabilities / acceptance / version。
//!
//! 设计约定：
//! * 机器接口走 stdout（JSON），人类信息走 stderr —— `mapf solve a.json | jq` 永远安全；
//! * 退出码：0 = OPTIMAL/FEASIBLE/INFEASIBLE（都是“有效结论”）；2 = INVALID_INPUT/UNSUPPORTED；
//!   3 = UNKNOWN/CANCELLED；1 = 用法/IO 错误；`verify` 子命令 ok ⇒ 0、违规 ⇒ 1。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use aps_engine::engine::CancelToken;
use aps_engine::hash;

use mapf_engine::capabilities::Profile;
use mapf_engine::engine::{self, SolveOptions};
use mapf_engine::errors::Status;
use mapf_engine::movingai::{self, ConvertOptions};
use mapf_engine::problem::{Objective, PlannerKind};
use mapf_engine::verify;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(|s| s.as_str()).unwrap_or("help");
    let rest = &args[if args.is_empty() { 0 } else { 1 }..];
    let code = match cmd {
        "solve" => cmd_solve(rest),
        "verify" => cmd_verify(rest),
        "bench" => cmd_bench(rest),
        "convert" => cmd_convert(rest),
        "capabilities" => cmd_capabilities(rest),
        "acceptance" => cmd_acceptance(rest),
        "version" | "--version" | "-V" => {
            println!(
                "{} {} (compiler {} / ruleset {})",
                mapf_engine::ENGINE_NAME,
                mapf_engine::ENGINE_VERSION,
                mapf_engine::COMPILER_VERSION,
                mapf_engine::RULESET_VERSION
            );
            ExitCode::SUCCESS
        }
        "help" | "--help" | "-h" => {
            print_usage();
            ExitCode::SUCCESS
        }
        other => fail(&format!("未知子命令 `{other}`")),
    };
    code
}

fn fail(msg: &str) -> ExitCode {
    eprintln!("错误：{msg}");
    ExitCode::FAILURE
}

fn print_usage() {
    eprintln!(
        "用法：
  mapf solve <problem.json|-> [flags]      求解（stdout=MapfSolution JSON）
      --out <f> --pretty --profile native|wasm-light
      --budget <ms> --seed <n> --w <f> --objective soc|makespan
      --planner auto|ecbs|cbs|pp|prioritized --no-verify --solution-id <s>
  mapf verify <problem.json> <solution.json> [--strict] [--out report.json]
      独立轨迹核验（与求解器解耦；exit 0=通过 / 1=违规）
  mapf bench [flags]                       Moving AI 清单基准
      --manifest <f=mapf/bench/manifest.json> --only <name|family>
      --budgets <ms,ms,..> --objective <soc|makespan> --profile <p>
      --out <results.json> [--wasm <module_dir>] --verify-manifest
  mapf convert --map <x.map> --scen <x.scen> [flags]
      --agents <k> --horizon <h> --budget <ms> --objective <o> --w <f>
      --seed <n> --out <problem.json>       （benchmark → MapfProblem，含溯源块）
  mapf capabilities [--profile <p>]
  mapf acceptance [--report <docs/ACCEPTANCE.md>] [--json <out.json>]
  mapf version"
    );
}

// ---------------------------------------------------------------- flags

fn has(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}
fn get(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn profile_of(args: &[String]) -> Result<Profile, String> {
    match get(args, "--profile") {
        None => Ok(Profile::Native),
        Some(s) => Profile::parse(&s).ok_or_else(|| format!("未知档位 `{s}`")),
    }
}

fn read_maybe_stdin(path: &str) -> std::io::Result<String> {
    if path == "-" {
        let mut buf = String::new();
        std::io::stdin().read_to_string(&mut buf)?;
        Ok(buf)
    } else {
        std::fs::read_to_string(path)
    }
}

fn write_out(args: &[String], text: &str) -> Result<(), String> {
    match get(args, "--out") {
        Some(p) => {
            std::fs::write(&p, format!("{text}\n")).map_err(|e| format!("写入 {p} 失败：{e}"))?;
            eprintln!("已写入 {p}");
            Ok(())
        }
        None => {
            println!("{text}");
            Ok(())
        }
    }
}

fn status_exit(status: Status) -> ExitCode {
    match status {
        Status::Optimal | Status::Feasible | Status::Infeasible => ExitCode::SUCCESS,
        Status::InvalidInput | Status::Unsupported => ExitCode::from(2),
        Status::Unknown | Status::Cancelled => ExitCode::from(3),
    }
}

// ---------------------------------------------------------------- solve

fn cmd_solve(args: &[String]) -> ExitCode {
    let input = match args.first() {
        Some(s) if !s.starts_with("--") => s.clone(),
        _ => "-".to_string(),
    };
    let text = match read_maybe_stdin(&input) {
        Ok(t) => t,
        Err(e) => return fail(&format!("读取 {input} 失败：{e}")),
    };
    let profile = match profile_of(args) {
        Ok(p) => p,
        Err(e) => return fail(&e),
    };
    let mut opts = SolveOptions {
        profile,
        verify: !has(args, "--no-verify"),
        ..Default::default()
    };
    if let Some(b) = get(args, "--budget") {
        match b.parse() {
            Ok(v) => opts.time_limit_ms = Some(v),
            Err(_) => return fail("--budget 需为整数毫秒"),
        }
    }
    if let Some(s) = get(args, "--seed") {
        match s.parse() {
            Ok(v) => opts.seed = Some(v),
            Err(_) => return fail("--seed 需为整数"),
        }
    }
    if let Some(w) = get(args, "--w") {
        match w.parse() {
            Ok(v) => opts.w = Some(v),
            Err(_) => return fail("--w 需为浮点数"),
        }
    }
    if let Some(o) = get(args, "--objective") {
        opts.objective = Some(match o.as_str() {
            "soc" => Objective::Soc,
            "makespan" => Objective::Makespan,
            x => return fail(&format!("未知目标 `{x}`")),
        });
    }
    if let Some(p) = get(args, "--planner") {
        opts.planner = Some(match p.as_str() {
            "auto" => PlannerKind::Auto,
            "ecbs" | "cbs" => PlannerKind::Ecbs,
            "pp" | "prioritized" => PlannerKind::Pp,
            x => return fail(&format!("未知规划器 `{x}`")),
        });
    }
    opts.solution_id = get(args, "--solution-id");

    let outcome = engine::solve_json(&text, &opts, &CancelToken::new());
    let json = if has(args, "--pretty") {
        outcome.solution.to_pretty()
    } else {
        outcome.solution_json.clone()
    };
    let _ = write_out(args, &json);
    eprintln!(
        "status={} verified={}",
        outcome.status.as_str(),
        outcome
            .solution
            .get("verified")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    );
    status_exit(outcome.status)
}

// ---------------------------------------------------------------- verify

fn cmd_verify(args: &[String]) -> ExitCode {
    let skip = args
        .iter()
        .position(|a| a.starts_with("--"))
        .unwrap_or(args.len());
    let pos: Vec<&String> = args[..skip].iter().collect();
    if pos.len() != 2 {
        return fail("用法：mapf verify <problem.json> <solution.json> [--strict] [--out r.json]");
    }
    let (problem, solution) = (pos[0], pos[1]);
    let pt = match read_maybe_stdin(problem) {
        Ok(t) => t,
        Err(e) => return fail(&format!("读取问题失败：{e}")),
    };
    let st = match read_maybe_stdin(solution) {
        Ok(t) => t,
        Err(e) => return fail(&format!("读取方案失败：{e}")),
    };
    let strict = has(args, "--strict");
    let report = verify::verify_texts(&pt, &st, strict);
    let ok = report.ok;
    let json = report.to_json(strict);
    let text = if has(args, "--pretty") {
        json.to_pretty()
    } else {
        json.to_compact()
    };
    let _ = write_out(args, &text);
    if ok {
        eprintln!(
            "核验通过（mode={}）",
            if strict { "full+strict" } else { "full" }
        );
        ExitCode::SUCCESS
    } else {
        eprintln!("核验拒绝：{} 条违规", report.violations.len());
        ExitCode::from(1)
    }
}

// ---------------------------------------------------------------- bench

fn cmd_bench(args: &[String]) -> ExitCode {
    let manifest =
        PathBuf::from(get(args, "--manifest").unwrap_or_else(|| "mapf/bench/manifest.json".into()));
    let only = get(args, "--only");
    let budgets: Option<Vec<i64>> = get(args, "--budgets")
        .map(|s| s.split(',').filter_map(|x| x.trim().parse().ok()).collect());
    let objective = get(args, "--objective");
    let profile = match profile_of(args) {
        Ok(p) => p,
        Err(e) => return fail(&e),
    };
    let out: Option<PathBuf> = get(args, "--out").map(PathBuf::from);
    let wasm = get(args, "--wasm").map(PathBuf::from);
    if has(args, "--verify-manifest") {
        let m = match mapf_engine::bench::load_manifest(&manifest) {
            Ok(m) => m,
            Err(e) => return fail(&e),
        };
        let issues = mapf_engine::bench::verify_manifest(&manifest, &m);
        if issues.is_empty() {
            println!(
                "清单校验通过：{} 个实例（sha256 全部吻合）",
                m.entries.len()
            );
            return ExitCode::SUCCESS;
        }
        for mapf_engine::bench::Issue3(msg) in issues {
            println!("✗ {msg}");
        }
        return ExitCode::from(1);
    }
    match mapf_engine::bench::run(
        &manifest,
        only.as_deref(),
        budgets.as_deref(),
        objective.as_deref(),
        profile,
        out.as_ref(),
        !has(args, "--no-progress"),
        wasm.as_deref(),
    ) {
        Ok(summary) => {
            let text = summary.to_pretty();
            let _ = write_out(args, &text);
            ExitCode::SUCCESS
        }
        Err(e) => fail(&e),
    }
}

// ---------------------------------------------------------------- convert

fn cmd_convert(args: &[String]) -> ExitCode {
    let (Some(map_path), Some(scen_path)) = (get(args, "--map"), get(args, "--scen")) else {
        return fail("用法：mapf convert --map <x.map> --scen <x.scen> [--agents k] ...");
    };
    let map_bytes = match std::fs::read(&map_path) {
        Ok(b) => b,
        Err(e) => return fail(&format!("读取 {map_path} 失败：{e}")),
    };
    let scen_bytes = match std::fs::read(&scen_path) {
        Ok(b) => b,
        Err(e) => return fail(&format!("读取 {scen_path} 失败：{e}")),
    };
    let map_file = match movingai::parse_map(&String::from_utf8_lossy(&map_bytes)) {
        Ok(m) => m,
        Err(e) => return fail(&format!("解析地图失败：{e}")),
    };
    let scen = match movingai::parse_scen(&String::from_utf8_lossy(&scen_bytes)) {
        Ok(s) => s,
        Err(e) => return fail(&format!("解析场景失败：{e}")),
    };
    let agents: usize = match get(args, "--agents") {
        Some(s) => match s.parse() {
            Ok(v) => v,
            Err(_) => return fail("--agents 需为整数"),
        },
        None => 10,
    };
    let objective_s = get(args, "--objective").unwrap_or_else(|| "soc".into());
    let horizon = match get(args, "--horizon") {
        Some(s) => match s.parse::<u32>() {
            Ok(h) => Some(h),
            Err(_) => return fail("--horizon 需为非负整数（0=auto）"),
        },
        None => None,
    };
    let opt = ConvertOptions {
        agents,
        horizon: if horizon == Some(0) { None } else { horizon },
        budget_ms: get(args, "--budget")
            .and_then(|s| s.parse().ok())
            .unwrap_or(60_000),
        objective: match objective_s.as_str() {
            "soc" => "soc",
            "makespan" => "makespan",
            _ => return fail("未知目标"),
        },
        w: get(args, "--w").and_then(|s| s.parse().ok()).unwrap_or(1.5),
        seed: get(args, "--seed")
            .and_then(|s| s.parse().ok())
            .unwrap_or(42),
        map_sha256: format!("sha256:{}", hash::sha256_hex(&map_bytes)),
        scen_sha256: format!("sha256:{}", hash::sha256_hex(&scen_bytes)),
        map_file: map_path.clone(),
        scen_file: scen_path.clone(),
    };
    match movingai::build_problem(&map_file, &scen, &opt) {
        Ok(j) => {
            let text = j.to_pretty();
            let _ = write_out(args, &text);
            ExitCode::SUCCESS
        }
        Err(e) => fail(&format!("转换失败：{e}")),
    }
}

// ---------------------------------------------------------------- capabilities

fn cmd_capabilities(args: &[String]) -> ExitCode {
    let profile = match profile_of(args) {
        Ok(p) => p,
        Err(e) => return fail(&e),
    };
    let _ = write_out(
        args,
        &mapf_engine::capabilities::report(profile).to_pretty(),
    );
    ExitCode::SUCCESS
}

// ---------------------------------------------------------------- acceptance

fn cmd_acceptance(args: &[String]) -> ExitCode {
    eprintln!("运行 M01–M12 验收（含 24 车实例两次完整求解，请稍候）…");
    let results = mapf_engine::acceptance::run_all();
    let table = mapf_engine::acceptance::markdown_table(&results);
    // stdout：仅结论表（可 `| tee`）；逐案例细节进报告文件。
    let header = table.lines().take(6).collect::<Vec<_>>().join("\n");
    println!("{header}");
    for r in &results {
        for mapf_engine::acceptance::Check(msg, ok) in &r.checks {
            if !*ok {
                eprintln!("✗ {} {}", r.id, msg);
            }
        }
    }
    if let Some(p) = get(args, "--report") {
        if let Err(e) = std::fs::write(&p, format!("{table}\n")) {
            eprintln!("写报告失败：{e}");
        } else {
            eprintln!("已写入 {p}");
        }
    }
    if let Some(p) = get(args, "--json") {
        let json = mapf_engine::acceptance::to_json(&results).to_pretty();
        if let Err(e) = std::fs::write(&p, format!("{json}\n")) {
            eprintln!("写 JSON 失败：{e}");
        } else {
            eprintln!("已写入 {p}");
        }
    }
    if results.iter().all(|r| r.ok()) {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

/// 保证 `Path` 导入不因条件编译分支而告警。
#[allow(dead_code)]
fn _unused(p: &Path) -> bool {
    p.exists()
}
