//! CLI：`warehouse`。与 aps / agv 的 CLI 约定一致（子命令 + `--flag value` + JSON 输出）。
//!
//! 退出码：
//! * `0` 正常（包括"结论是否定"的情形，例如 INFEASIBLE_PROVEN —— 那也是有效结论）；
//! * `2` 输入不合法 / 不支持；
//! * `3` 未得到有效结论（NO_SOLUTION_FOUND / BUDGET_EXCEEDED / CANCELLED）；
//! * `1` 用法或 IO 错误。

use std::io::Write;
use std::process::ExitCode;

use warehouse_engine::{
    acceptance, bench, capabilities, engine, scenario,
};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || matches!(args[0].as_str(), "-h" | "--help" | "help") {
        print_usage();
        return ExitCode::from(0);
    }
    let command = args[0].clone();
    let options = parse_options(&args[1..]);
    match command.as_str() {
        "solve" => cmd_solve(&options),
        "verify" => cmd_verify(&options),
        "generate" => cmd_generate(&options),
        "scenarios" => cmd_scenarios(&options),
        "acceptance" => cmd_acceptance(&options),
        "bench" => cmd_bench(&options),
        "diagnose" => cmd_diagnose(&options),
        "capabilities" => cmd_capabilities(),
        "codes" => cmd_codes(),
        "version" => {
            println!(
                "{} {} (compiler {} / ruleset {})",
                warehouse_engine::ENGINE_NAME,
                warehouse_engine::ENGINE_VERSION,
                warehouse_engine::COMPILER_VERSION,
                warehouse_engine::RULESET_VERSION
            );
            ExitCode::from(0)
        }
        other => {
            eprintln!("未知子命令：{other}");
            print_usage();
            ExitCode::from(1)
        }
    }
}

fn print_usage() {
    println!(
        r#"warehouse —— 仓储库位优化 + 密集立库联合调度（Rust 引擎）

用法：
  warehouse solve        --in <problem.json> [--options <options.json>] [--out <result.json>]
  warehouse verify       --in <doc.json>     [--out <report.json>] [--loose]
  warehouse generate     --scenario S01 [--scale small] [--seed 7] [--out <problem.json>]
  warehouse scenarios    [--family slotting|dispatch|event|joint|stress] [--out <catalog.json>]
  warehouse acceptance   [--family <f> | --ids S01,D04,J01] [--limit 5] [--out <report.json>]
  warehouse bench        [--case slotting-small,asrs-medium] [--tier native|wasm-light] [--out <bench.json>]
  warehouse diagnose     --in <problem.json> [--out <report.json>]   # 库位可达性/成本诊断
  warehouse capabilities [--out <capabilities.json>]
  warehouse codes        [--out <codes.json>]
  warehouse version

退出码：0 有效结论 / 2 输入不合法或不支持 / 3 未得到有效结论 / 1 用法或 IO 错误
"#
    );
}

#[derive(Debug, Default)]
struct Options {
    input: Option<String>,
    options: Option<String>,
    out: Option<String>,
    scenario: Option<String>,
    scale: Option<String>,
    seed: Option<u64>,
    family: Option<String>,
    ids: Vec<String>,
    limit: Option<usize>,
    cases: Vec<String>,
    tier: Option<String>,
    loose: bool,
}

fn parse_options(args: &[String]) -> Options {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let key = args[index].as_str();
        let value = args.get(index + 1).cloned();
        match key {
            "--in" | "-i" => options.input = value.clone(),
            "--options" | "-o" => options.options = value.clone(),
            "--out" => options.out = value.clone(),
            "--scenario" => options.scenario = value.clone(),
            "--scale" => options.scale = value.clone(),
            "--seed" => options.seed = value.as_deref().and_then(|text| text.parse().ok()),
            "--family" => options.family = value.clone(),
            "--ids" => {
                options.ids = value
                    .as_deref()
                    .map(|text| text.split(',').map(|item| item.trim().to_string()).collect())
                    .unwrap_or_default()
            }
            "--limit" => options.limit = value.as_deref().and_then(|text| text.parse().ok()),
            "--case" => {
                options.cases = value
                    .as_deref()
                    .map(|text| text.split(',').map(|item| item.trim().to_string()).collect())
                    .unwrap_or_default()
            }
            "--tier" => options.tier = value.clone(),
            "--loose" => {
                options.loose = true;
                index += 1;
                continue;
            }
            _ => {}
        }
        index += 2;
    }
    options
}

fn read_input(options: &Options) -> Result<String, String> {
    match &options.input {
        Some(path) => std::fs::read_to_string(path).map_err(|error| format!("读取 {path} 失败：{error}")),
        None => {
            let mut text = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut text)
                .map_err(|error| format!("读取标准输入失败：{error}"))?;
            Ok(text)
        }
    }
}

fn write_output(text: &str, out: Option<&str>) -> Result<(), String> {
    match out {
        Some(path) => std::fs::write(path, text).map_err(|error| format!("写入 {path} 失败：{error}")),
        None => {
            let mut stdout = std::io::stdout();
            stdout
                .write_all(text.as_bytes())
                .map_err(|error| format!("写标准输出失败：{error}"))?;
            writeln!(stdout).map_err(|error| format!("写标准输出失败：{error}"))
        }
    }
}

fn exit_for(status: warehouse_engine::errors::Status) -> ExitCode {
    use warehouse_engine::errors::Status;
    match status {
        Status::InvalidInput | Status::Unsupported => ExitCode::from(2),
        Status::NoSolutionFound | Status::BudgetExceeded | Status::Cancelled => ExitCode::from(3),
        _ => ExitCode::from(0),
    }
}

fn cmd_solve(options: &Options) -> ExitCode {
    let Ok(input) = read_input(options) else {
        eprintln!("{}", read_input(options).unwrap_err());
        return ExitCode::from(1);
    };
    let options_text = options
        .options
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok());
    let kind = aps_engine::json::parse(&input)
        .ok()
        .and_then(|value| warehouse_engine::contract::opt_str(&value, "kind"))
        .unwrap_or_else(|| "slotting".to_string());
    let (result, status) = match kind.as_str() {
        "asrs" | "dense-asrs" => engine::solve_asrs(&input, options_text.as_deref()),
        "joint" => engine::solve_joint(&input, options_text.as_deref()),
        _ => engine::solve_slotting(&input, options_text.as_deref()),
    };
    if let Err(error) = write_output(&result, options.out.as_deref()) {
        eprintln!("{error}");
        return ExitCode::from(1);
    }
    // 人类可读摘要写到 stderr，保持 stdout 是纯 JSON（便于管道）
    if options.out.is_none() {
        eprintln!("status={}", status.as_str());
    }
    exit_for(status)
}

fn cmd_verify(options: &Options) -> ExitCode {
    let Ok(input) = read_input(options) else {
        eprintln!("{}", read_input(options).unwrap_err());
        return ExitCode::from(1);
    };
    let options_text = if options.loose {
        Some("{\"strict\":false}".to_string())
    } else {
        None
    };
    let (report, status) = engine::verify(&input, options_text.as_deref());
    if let Err(error) = write_output(&report, options.out.as_deref()) {
        eprintln!("{error}");
        return ExitCode::from(1);
    }
    exit_for(status)
}

fn cmd_generate(options: &Options) -> ExitCode {
    let scenario_id = options.scenario.clone().unwrap_or_else(|| "S01".to_string());
    let mut issues = warehouse_engine::errors::Issues::new();
    let document = scenario::build(
        &scenario_id,
        options.scale.as_deref(),
        options.seed,
        &mut issues,
    );
    if issues.has_errors() {
        eprintln!("{}", issues.to_json().canonical());
        return ExitCode::from(2);
    }
    if let Err(error) = write_output(&document.canonical(), options.out.as_deref()) {
        eprintln!("{error}");
        return ExitCode::from(1);
    }
    ExitCode::from(0)
}

fn cmd_scenarios(options: &Options) -> ExitCode {
    let catalog = scenario::catalog_json();
    let text = match &options.family {
        Some(family) => {
            let family = family.to_ascii_lowercase();
            let filtered = catalog
                .get("families")
                .and_then(|value| match value {
                    aps_engine::json::Json::Arr(list) => Some(
                        list.iter()
                            .filter(|entry| {
                                entry
                                    .get("family")
                                    .and_then(|value| value.as_str())
                                    .map(|value| value == family)
                                    .unwrap_or(false)
                            })
                            .cloned()
                            .collect::<Vec<_>>(),
                    ),
                    _ => None,
                })
                .unwrap_or_default();
            aps_engine::json::Json::obj(vec![(
                "families",
                aps_engine::json::Json::Arr(filtered),
            )])
            .canonical()
        }
        None => catalog.canonical(),
    };
    if let Err(error) = write_output(&text, options.out.as_deref()) {
        eprintln!("{error}");
        return ExitCode::from(1);
    }
    ExitCode::from(0)
}

fn cmd_acceptance(options: &Options) -> ExitCode {
    let results = acceptance::run_selection(
        options.family.as_deref(),
        &options.ids,
        options.limit,
    );
    let summary = acceptance::summary_json(&results);
    let text = summary.canonical();
    if let Err(error) = write_output(&text, options.out.as_deref()) {
        eprintln!("{error}");
        return ExitCode::from(1);
    }
    if options.out.is_none() {
        for result in &results {
            let failed: Vec<String> = result
                .checks
                .iter()
                .filter(|(_, ok, _)| !ok)
                .map(|(name, _, _)| name.clone())
                .collect();
            eprintln!(
                "{:<4} {:<9} {:<18} {:>8.0}ms {}",
                result.scenario_id,
                result.family,
                result.status,
                result.runtime_ms,
                if result.ok {
                    "通过".to_string()
                } else {
                    format!("未通过：{}", failed.join(", "))
                }
            );
        }
    }
    let failed = results.iter().filter(|result| !result.ok).count();
    if failed > 0 {
        ExitCode::from(3)
    } else {
        ExitCode::from(0)
    }
}

fn cmd_bench(options: &Options) -> ExitCode {
    let tier = match options.tier.as_deref() {
        Some("wasm-light") | Some("wasm") => capabilities::WASM_LIGHT_TIER,
        _ => capabilities::NATIVE_TIER,
    };
    let rows = bench::run_all(&options.cases, tier);
    let summary = bench::summary_json(&rows, tier.name);
    let text = summary.canonical();
    if let Err(error) = write_output(&text, options.out.as_deref()) {
        eprintln!("{error}");
        return ExitCode::from(1);
    }
    if options.out.is_none() {
        eprintln!("{}", bench::header());
        for row in &rows {
            eprintln!("{}", row.row());
        }
    }
    ExitCode::from(0)
}

/// 诊断：逐库位给出可达性、出入库秒数、不可达原因（实验室"为什么这些库位用不了"面板直接读它）。
fn cmd_diagnose(options: &Options) -> ExitCode {
    use aps_engine::json::Json;
    let Ok(input) = read_input(options) else {
        eprintln!("{}", read_input(options).unwrap_err());
        return ExitCode::from(1);
    };
    let mut issues = warehouse_engine::errors::Issues::new();
    let root = match aps_engine::json::parse(&input) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("输入不是合法 JSON：{error:?}");
            return ExitCode::from(2);
        }
    };
    let problem = warehouse_engine::contract::parse_slotting_problem(&root, &mut issues);
    let topology = &problem.topology;
    let locations = warehouse_engine::wh::topology::derive_locations(topology);
    let mut model = warehouse_engine::wh::routing::RouteModel::build(topology, locations);
    let costs = warehouse_engine::wh::routing::location_costs(topology, &mut model, 6.0);
    let mut reachable = 0i64;
    let mut unreachable_by_reason: std::collections::BTreeMap<String, i64> =
        std::collections::BTreeMap::new();
    let mut rows: Vec<Json> = Vec::new();
    for (index, cost) in costs.iter().enumerate() {
        let location = &model.locations[index];
        if cost.pick_seconds.is_finite() && cost.put_seconds.is_finite() {
            reachable += 1;
        } else {
            let mut reason = "图上不可达（拓扑断路）".to_string();
            for device in &topology.devices {
                if let Err(error) =
                    warehouse_engine::wh::routing::can_serve_location(device, location)
                {
                    reason = error;
                    break;
                }
            }
            *unreachable_by_reason.entry(reason.clone()).or_insert(0) += 1;
        }
        if cost.unreachable || rows.len() < 64 {
            rows.push(Json::obj(vec![
                ("locationId", Json::str(location.id.clone())),
                ("rack", Json::str(location.rack_id.clone())),
                ("aisle", Json::str(location.aisle_id.clone())),
                ("zone", Json::str(location.zone.clone())),
                ("bay", Json::int(location.bay as i64)),
                ("level", Json::int(location.level as i64)),
                ("depth", Json::int(location.depth as i64)),
                ("pickSeconds", Json::Float(warehouse_engine::util::round(cost.pick_seconds, 3))),
                ("putSeconds", Json::Float(warehouse_engine::util::round(cost.put_seconds, 3))),
                ("meters", Json::Float(warehouse_engine::util::round(cost.meters, 3))),
                ("usesLift", Json::Bool(cost.uses_lift)),
                ("depthPenaltySeconds", Json::Float(warehouse_engine::util::round(cost.depth_penalty_s, 3))),
                ("availability", Json::str(format!("{:?}", location.availability))),
            ]));
        }
    }
    let report = Json::obj(vec![
        ("locations", Json::int(costs.len() as i64)),
        ("reachable", Json::int(reachable)),
        ("unreachable", Json::int(costs.len() as i64 - reachable)),
        (
            "unreachableByReason",
            Json::Obj(
                unreachable_by_reason
                    .into_iter()
                    .map(|(reason, count)| (reason, Json::int(count)))
                    .collect(),
            ),
        ),
        ("devices", Json::int(topology.devices.len() as i64)),
        ("rows", Json::Arr(rows)),
        ("issues", issues.to_json()),
    ]);
    if let Err(error) = write_output(&report.canonical(), options.out.as_deref()) {
        eprintln!("{error}");
        return ExitCode::from(1);
    }
    ExitCode::from(0)
}

fn cmd_capabilities() -> ExitCode {
    let text = capabilities::capabilities_json().canonical();
    match write_output(&text, None) {
        Ok(()) => ExitCode::from(0),
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}

fn cmd_codes() -> ExitCode {
    let text = capabilities::error_codes_json().canonical();
    match write_output(&text, None) {
        Ok(()) => ExitCode::from(0),
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}
