//! `agv` CLI：solve / verify / capabilities / acceptance / bench / version。
//!
//! 约定与 mapf 一致：
//! * 机器接口走 stdout（JSON），人类信息走 stderr；
//! * 退出码：0 = FEASIBLE/PARTIAL/INFEASIBLE（有效结论）；2 = INVALID_INPUT/
//!   UNSUPPORTED；3 = UNKNOWN/CANCELLED；1 = 用法/IO 错误；`verify` ok ⇒ 0、
//!   违规 ⇒ 1。

use std::io::Read;
use std::process::ExitCode;

use aps_engine::engine::CancelToken;

use agv_dispatch_engine::capabilities::Profile;
use agv_dispatch_engine::engine::{self, SolveOptions};
use agv_dispatch_engine::errors::Status;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(|s| s.as_str()).unwrap_or("help");
    let rest = &args[if args.is_empty() { 0 } else { 1 }..];
    match cmd {
        "solve" => cmd_solve(rest),
        "verify" => cmd_verify(rest),
        "capabilities" => cmd_capabilities(rest),
        "acceptance" => cmd_acceptance(rest),
        "bench" => cmd_bench(rest),
        "mocks" => cmd_mocks(rest),
        "version" | "--version" | "-V" => {
            println!(
                "{} {} (compiler {} / ruleset {} / mapf {})",
                agv_dispatch_engine::ENGINE_NAME,
                agv_dispatch_engine::ENGINE_VERSION,
                agv_dispatch_engine::COMPILER_VERSION,
                agv_dispatch_engine::RULESET_VERSION,
                mapf_engine::ENGINE_VERSION
            );
            ExitCode::SUCCESS
        }
        "help" | "--help" | "-h" => {
            print_usage();
            ExitCode::SUCCESS
        }
        other => fail(&format!("未知子命令 `{other}`")),
    }
}

fn fail(msg: &str) -> ExitCode {
    eprintln!("错误：{msg}");
    ExitCode::FAILURE
}

fn print_usage() {
    eprintln!(
        "用法：
  agv solve <problem.json|-> [flags]        求解（stdout=AgvDispatchSolution JSON）
      --out <f> --pretty --profile native|wasm-light --no-verify
      --budget <ms> --seed <n> --algorithm auto|baseline|insertion-ls
      --mapf-planner auto|ecbs|cbs|pp --mapf-w <f> --mapf-budget <ms>
      --horizon <n> --solution-id <s>
  agv verify <problem.json> <solution.json> [--strict] [--out report.json]
      独立核验（与求解器解耦；exit 0=通过 / 1=违规）
  agv capabilities [--profile <p>]
  agv acceptance [--json <out.json>] [--profile <p>]
  agv bench [--json <out.json>] [--profile <p>]
  agv mocks [--out <dir=../mock>]           导出固定演示/回归 Mock（SRS §6）
  agv version"
    );
}

fn has(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}
fn get(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}
fn num<T: std::str::FromStr>(args: &[String], name: &str) -> Option<Result<T, String>> {
    get(args, name).map(|s| {
        s.parse::<T>()
            .map_err(|_| format!("--{name} 参数非法：{s}"))
    })
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

fn exit_code_of(status: Status) -> ExitCode {
    match status {
        Status::Feasible | Status::Partial | Status::Infeasible => ExitCode::SUCCESS,
        Status::InvalidInput | Status::Unsupported => ExitCode::from(2),
        Status::Unknown | Status::Cancelled => ExitCode::from(3),
    }
}

// ---------------------------------------------------------------- 子命令

fn cmd_solve(args: &[String]) -> ExitCode {
    let Some(path) = args.first().cloned() else {
        return fail("solve 需要问题文件路径（或 - 读 stdin）");
    };
    let text = match read_maybe_stdin(&path) {
        Ok(t) => t,
        Err(e) => return fail(&format!("读取 {path} 失败：{e}")),
    };
    let profile = match profile_of(args) {
        Ok(p) => p,
        Err(e) => return fail(&e),
    };
    let mut opts = SolveOptions {
        profile,
        ..Default::default()
    };
    if has(args, "--no-verify") {
        opts.verify = false;
    }
    if let Some(r) = num::<i64>(args, "budget") {
        match r {
            Ok(v) if v >= 0 => opts.time_limit_ms = Some(v),
            _ => return fail("--budget 需要非负整数（毫秒）"),
        }
    }
    if let Some(r) = num::<u64>(args, "seed") {
        match r {
            Ok(v) => opts.seed = Some(v),
            _ => return fail("--seed 需要非负整数"),
        }
    }
    if let Some(a) = get(args, "--algorithm") {
        if !matches!(a.as_str(), "auto" | "baseline" | "insertion-ls") {
            return fail(&format!("未知算法 `{a}`"));
        }
        opts.algorithm = Some(a);
    }
    if let Some(a) = get(args, "--mapf-planner") {
        opts.mapf_planner = Some(a);
    }
    if let Some(r) = num::<f64>(args, "mapf-w") {
        match r {
            Ok(v) if (1.0..=3.0).contains(&v) => opts.mapf_w = Some(v),
            _ => return fail("--mapf-w 需在 [1.0, 3.0]"),
        }
    }
    if let Some(r) = num::<i64>(args, "mapf-budget") {
        match r {
            Ok(v) if v >= 0 => opts.mapf_time_limit_ms = Some(v),
            _ => return fail("--mapf-budget 需要非负整数（毫秒）"),
        }
    }
    if let Some(r) = num::<u32>(args, "horizon") {
        match r {
            Ok(v) => opts.horizon = Some(v),
            _ => return fail("--horizon 需要非负整数"),
        }
    }
    if let Some(id) = get(args, "--solution-id") {
        opts.solution_id = Some(id);
    }
    let cancel = CancelToken::new();
    let out = engine::solve_json(&text, &opts, &cancel);
    eprintln!(
        "status={} verified={}（fingerprint={}）",
        out.status.as_str(),
        out.solution
            .get("verified")
            .and_then(|j| j.as_bool())
            .unwrap_or(false),
        out.solution
            .get("fingerprint")
            .and_then(|j| j.as_str())
            .unwrap_or("-")
    );
    let text = if has(args, "--pretty") {
        out.solution.to_pretty()
    } else {
        out.solution_json.clone()
    };
    if let Err(e) = write_out(args, &text) {
        return fail(&e);
    }
    exit_code_of(out.status)
}

fn cmd_verify(args: &[String]) -> ExitCode {
    let (Some(pp), Some(sp)) = (args.first().cloned(), args.get(1).cloned()) else {
        return fail("verify 需要 <problem.json> <solution.json>");
    };
    let (ptext, stext) = match (read_maybe_stdin(&pp), read_maybe_stdin(&sp)) {
        (Ok(a), Ok(b)) => (a, b),
        (Err(e), _) | (_, Err(e)) => return fail(&format!("读取失败：{e}")),
    };
    let strict = has(args, "--strict");
    let report = engine::verify_solution_json(&ptext, &stext, strict);
    let ok = report.get("ok").and_then(|j| j.as_bool()).unwrap_or(false);
    eprintln!(
        "核验：{}（{}/{} 通过）",
        if ok { "通过" } else { "未通过" },
        report
            .get("summary")
            .and_then(|s| s.get("passed"))
            .and_then(|j| j.as_i64())
            .unwrap_or(0),
        report
            .get("summary")
            .and_then(|s| s.get("total"))
            .and_then(|j| j.as_i64())
            .unwrap_or(0),
    );
    let text = if has(args, "--pretty") {
        report.to_pretty()
    } else {
        report.to_compact()
    };
    if let Err(e) = write_out(args, &text) {
        return fail(&e);
    }
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn cmd_capabilities(args: &[String]) -> ExitCode {
    let profile = match profile_of(args) {
        Ok(p) => p,
        Err(e) => return fail(&e),
    };
    let report = agv_dispatch_engine::capabilities::report(profile);
    let text = if has(args, "--pretty") {
        report.to_pretty()
    } else {
        report.to_compact()
    };
    if let Err(e) = write_out(args, &text) {
        return fail(&e);
    }
    ExitCode::SUCCESS
}

fn cmd_acceptance(args: &[String]) -> ExitCode {
    let profile = match profile_of(args) {
        Ok(p) => p,
        Err(e) => return fail(&e),
    };
    let report = agv_dispatch_engine::acceptance::run_all(profile);
    let failed = report
        .get("summary")
        .and_then(|s| s.get("failed"))
        .and_then(|j| j.as_i64())
        .unwrap_or(-1);
    let passed = report
        .get("summary")
        .and_then(|s| s.get("passed"))
        .and_then(|j| j.as_i64())
        .unwrap_or(-1);
    eprintln!("验收：{passed} 通过 / {failed} 失败");
    let text = if has(args, "--pretty") {
        report.to_pretty()
    } else {
        report.to_compact()
    };
    if let Some(p) = get(args, "--json") {
        if let Err(e) = std::fs::write(&p, format!("{text}\n")) {
            return fail(&format!("写入 {p} 失败：{e}"));
        }
        eprintln!("已写入 {p}");
    } else if let Err(e) = write_out(args, &text) {
        return fail(&e);
    }
    if failed == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn cmd_bench(args: &[String]) -> ExitCode {
    let profile = match profile_of(args) {
        Ok(p) => p,
        Err(e) => return fail(&e),
    };
    let report = agv_dispatch_engine::bench::run(profile);
    let failed = report
        .get("summary")
        .and_then(|s| s.get("failed"))
        .and_then(|j| j.as_i64())
        .unwrap_or(-1);
    let passed = report
        .get("summary")
        .and_then(|s| s.get("passed"))
        .and_then(|j| j.as_i64())
        .unwrap_or(-1);
    eprintln!("基准：{passed} 通过 / {failed} 失败");
    let text = if has(args, "--pretty") {
        report.to_pretty()
    } else {
        report.to_compact()
    };
    if let Some(p) = get(args, "--json") {
        if let Err(e) = std::fs::write(&p, format!("{text}\n")) {
            return fail(&format!("写入 {p} 失败：{e}"));
        }
        eprintln!("已写入 {p}");
    } else if let Err(e) = write_out(args, &text) {
        return fail(&e);
    }
    if failed == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// 导出固定 Mock（SRS §6）。默认写到 crate 相邻的 ../mock（即 agv/mock）。
fn cmd_mocks(args: &[String]) -> ExitCode {
    let dir = get(args, "--out").unwrap_or_else(|| "../mock".to_string());
    match agv_dispatch_engine::acceptance::export_mocks(&dir) {
        Ok(paths) => {
            eprintln!("已导出 {} 个 Mock 到 {dir}：", paths.len());
            for p in &paths {
                eprintln!("  {p}");
            }
            ExitCode::SUCCESS
        }
        Err(e) => fail(&e),
    }
}
