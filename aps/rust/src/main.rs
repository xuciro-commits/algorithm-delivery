//! `aps` 命令行：交付件的可复现运行入口（APS-SRS §8 “可复现 CLI”）。
//!
//! 所有子命令都支持 `--json` 输出契约 JSON，便于脚本/CI 直接断言。
//! 退出码：0 成功；2 用法错误；3 契约非法；4 无解（已证明）；5 未找到解/未知；
//! 6 能力不匹配；7 被取消；8 校验发现违约。

#[cfg(not(target_arch = "wasm32"))]
mod cli {
    use std::path::PathBuf;
    use std::process::ExitCode;

    use aps_engine::acceptance;
    use aps_engine::capabilities::{self, Profile};
    use aps_engine::engine::{self, CancelToken, SolveOptions};
    use aps_engine::errors::Status;
    use aps_engine::json::Json;
    use aps_engine::objective::Strategy;
    use aps_engine::solver::Rule;
    use aps_engine::{alloc, benchgen};

    const EXIT_OK: u8 = 0;
    const EXIT_USAGE: u8 = 2;
    const EXIT_MODEL_INVALID: u8 = 3;
    const EXIT_INFEASIBLE: u8 = 4;
    const EXIT_NO_SOLUTION: u8 = 5;
    const EXIT_UNSUPPORTED: u8 = 6;
    const EXIT_CANCELLED: u8 = 7;
    const EXIT_VIOLATIONS: u8 = 8;

    pub fn main() -> ExitCode {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if args.is_empty() || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
            print_help();
            return ExitCode::from(EXIT_OK);
        }
        let cmd = args[0].clone();
        let rest = &args[1..];
        let result = match cmd.as_str() {
            "version" | "--version" | "-V" => {
                println!(
                    "aps {} (engine {} v{})",
                    aps_engine::ENGINE_VERSION,
                    aps_engine::ENGINE_NAME,
                    aps_engine::ENGINE_VERSION
                );
                println!("compiler: {}", aps_engine::COMPILER_VERSION);
                println!("零第三方依赖；native + wasm32-unknown-unknown 同源构建");
                return ExitCode::from(EXIT_OK);
            }
            "capabilities" => cmd_capabilities(rest),
            "validate" => cmd_validate(rest),
            "solve" => cmd_solve(rest),
            "verify" => cmd_verify(rest),
            "compare" => cmd_compare(rest),
            "explain" => cmd_explain(rest),
            "benchmark" => cmd_benchmark(rest),
            "bench" => cmd_bench(rest),
            "accept" => cmd_accept(rest),
            other => {
                eprintln!("未知子命令 '{other}'（用 --help 查看用法）");
                return ExitCode::from(EXIT_USAGE);
            }
        };
        match result {
            Ok(code) => ExitCode::from(code),
            Err(msg) => {
                eprintln!("错误：{msg}");
                ExitCode::from(EXIT_USAGE)
            }
        }
    }

    fn print_help() {
        println!(
            r#"aps — APS 计划排程引擎（PlanProblem v1 / PlanSolution v1）

用法:
  aps validate      --problem <file> [--json]
  aps capabilities  [--profile native|wasm-light] [--json]
  aps solve         --problem <file> [--out <file>] [--json]
                    [--profile native|wasm-light] [--strategy lexicographic|makespan]
                    [--time-limit-ms N] [--seed N] [--rule auto|priority-edd|wspt|spt|min-end|most-slack|random]
                    [--no-repair] [--max-iterations N] [--cancel-after-ms N]
  aps verify        --problem <file> --solution <file> [--json]
  aps compare       --problem <file> --baseline <file> --solution <file> [--solution <file>...] [--json]
  aps explain       --problem <file> --solution <file> --operation <op_id> [--json]
  aps benchmark     --baseline <file> --operations <24|240|2400> [--out <file>]
  aps bench         --problem <file> [--runs N] [--time-limit-ms N] [--seed N] [--json]
  aps accept        [--dir <aps 目录>] [--json]
  aps version

退出码: 0 成功 / 2 用法错误 / 3 契约非法 / 4 已证明无解 / 5 未找到解 / 6 能力不匹配 /
        7 已取消 / 8 校验发现违约

示例:
  aps solve --problem mock/baseline.json --out /tmp/plan.json --time-limit-ms 2000
  aps verify --problem mock/baseline.json --solution /tmp/plan.json
  aps explain --problem mock/baseline.json --solution /tmp/plan.json --operation ORD-001-CUT
  aps accept --dir .
"#
        );
    }

    // ---------------- 参数解析 ----------------
    struct Args {
        flags: Vec<(String, Option<String>)>,
    }

    impl Args {
        fn parse(args: &[String]) -> Result<Args, String> {
            let mut flags = Vec::new();
            let mut i = 0;
            while i < args.len() {
                let a = &args[i];
                if !a.starts_with("--") {
                    return Err(format!("意外的参数 '{a}'"));
                }
                let name = a.trim_start_matches("--").to_string();
                // 支持 --flag=value 与 --flag value 两种写法
                if let Some(eq) = name.find('=') {
                    flags.push((name[..eq].to_string(), Some(name[eq + 1..].to_string())));
                    i += 1;
                    continue;
                }
                let takes_value = !matches!(
                    name.as_str(),
                    "json" | "no-repair" | "help" | "list" | "quiet"
                );
                if takes_value && i + 1 < args.len() && !args[i + 1].starts_with("--") {
                    flags.push((name, Some(args[i + 1].clone())));
                    i += 2;
                } else {
                    flags.push((name, None));
                    i += 1;
                }
            }
            Ok(Args { flags })
        }

        fn get(&self, name: &str) -> Option<&str> {
            self.flags
                .iter()
                .find(|(k, _)| k == name)
                .and_then(|(_, v)| v.as_deref())
        }

        fn require(&self, name: &str) -> Result<&str, String> {
            self.get(name)
                .ok_or_else(|| format!("缺少必需参数 --{name}"))
        }

        fn has(&self, name: &str) -> bool {
            self.flags.iter().any(|(k, _)| k == name)
        }

        fn get_all(&self, name: &str) -> Vec<String> {
            self.flags
                .iter()
                .filter(|(k, _)| k == name)
                .filter_map(|(_, v)| v.clone())
                .collect()
        }
    }

    fn read(path: &str) -> Result<String, String> {
        std::fs::read_to_string(path).map_err(|e| format!("读取 {path} 失败：{e}"))
    }

    fn write(path: &str, content: &str) -> Result<(), String> {
        std::fs::write(path, content).map_err(|e| format!("写入 {path} 失败：{e}"))
    }

    fn print_json(j: &Json) {
        println!("{}", j.to_pretty());
    }

    // ---------------- capabilities ----------------
    fn cmd_capabilities(args: &[String]) -> Result<u8, String> {
        let a = Args::parse(args)?;
        let profile = match a.get("profile") {
            Some(p) => Profile::parse(p).ok_or_else(|| format!("未知档位 '{p}'"))?,
            None => Profile::Native,
        };
        let caps = capabilities::capabilities_for(profile);
        if a.has("json") {
            print_json(&caps.to_json());
        } else {
            println!("引擎: {} v{}", caps.engine, caps.version);
            println!("档位: {}", caps.profile.name());
            println!("约束: {}", caps.constraints.join(", "));
            println!("工序规模上限: {}", caps.max_operations);
            println!(
                "证明最优: {} / 证明无解: {} / 支持取消: {}",
                caps.can_prove_optimal, caps.can_prove_infeasible, caps.supports_cancel
            );
            for n in caps.notes.iter() {
                println!("· {n}");
            }
        }
        Ok(EXIT_OK)
    }

    // ---------------- validate ----------------
    fn cmd_validate(args: &[String]) -> Result<u8, String> {
        let a = Args::parse(args)?;
        let text = read(a.require("problem")?)?;
        let json = match aps_engine::json::parse(&text) {
            Ok(j) => j,
            Err(e) => {
                let issue = Json::obj(vec![
                    ("code", Json::str("JSON_SYNTAX")),
                    ("severity", Json::str("error")),
                    ("path", Json::str(format!("line {}:{}", e.line, e.column))),
                    ("message", Json::str(e.message.clone())),
                ]);
                if a.has("json") {
                    print_json(&Json::obj(vec![
                        ("valid", Json::Bool(false)),
                        ("issues", Json::Arr(vec![issue])),
                    ]));
                } else {
                    eprintln!("✗ JSON 解析失败：{e}");
                }
                return Ok(EXIT_MODEL_INVALID);
            }
        };
        let (problem, issues) = aps_engine::model::parse_problem(&json);
        let mut all = issues.clone();
        if let Some(p) = &problem {
            all.extend(aps_engine::validate::validate(p));
        }
        let errors: Vec<&aps_engine::errors::Issue> = all
            .iter()
            .filter(|i| i.severity == aps_engine::errors::Severity::Error)
            .collect();
        let valid = errors.is_empty() && problem.is_some();
        if a.has("json") {
            print_json(&Json::obj(vec![
                ("valid", Json::Bool(valid)),
                (
                    "issues",
                    Json::Arr(all.iter().map(|i| i.to_json()).collect()),
                ),
                (
                    "summary",
                    Json::obj(vec![
                        (
                            "orders",
                            Json::int(problem.as_ref().map(|p| p.orders.len()).unwrap_or(0) as i64),
                        ),
                        (
                            "operations",
                            Json::int(
                                problem
                                    .as_ref()
                                    .map(|p| {
                                        p.orders.iter().map(|o| o.operations.len()).sum::<usize>()
                                    })
                                    .unwrap_or(0) as i64,
                            ),
                        ),
                        ("errors", Json::int(errors.len() as i64)),
                        ("warnings", Json::int((all.len() - errors.len()) as i64)),
                    ]),
                ),
            ]));
        } else if valid {
            println!(
                "✓ 模型合法：{} 订单 / {} 工序（{} 条警告）",
                problem.as_ref().map(|p| p.orders.len()).unwrap_or(0),
                problem
                    .as_ref()
                    .map(|p| p.orders.iter().map(|o| o.operations.len()).sum::<usize>())
                    .unwrap_or(0),
                all.len() - errors.len()
            );
            for w in all.iter() {
                println!("  警告 [{}] {} {}", w.code, w.path, w.message);
            }
        } else {
            println!("✗ 模型非法：{} 条错误", errors.len());
            for i in all.iter() {
                println!("  [{}] {} {}", i.code, i.path, i.message);
            }
        }
        Ok(if valid { EXIT_OK } else { EXIT_MODEL_INVALID })
    }

    // ---------------- solve ----------------
    fn cmd_solve(args: &[String]) -> Result<u8, String> {
        let a = Args::parse(args)?;
        let problem_path = a.require("problem")?;
        let text = read(problem_path)?;
        let mut opts = SolveOptions::default();
        // 以问题 objective 块为默认（策略/时限/种子），再被命令行覆盖
        if let Ok(j) = aps_engine::json::parse(&text) {
            let defaults = SolveOptions::from_objective(j.get("objective"));
            opts.strategy = defaults.strategy;
            opts.time_limit_ms = defaults.time_limit_ms;
            opts.seed = defaults.seed;
        }
        if let Some(p) = a.get("profile") {
            opts.profile = Profile::parse(p).ok_or_else(|| format!("未知档位 '{p}'"))?;
        }
        if let Some(s) = a.get("strategy") {
            opts.strategy = Strategy::parse(s).ok_or_else(|| format!("未知策略 '{s}'"))?;
        }
        if let Some(t) = a.get("time-limit-ms") {
            opts.time_limit_ms = t
                .parse()
                .map_err(|_| "time-limit-ms 必须是整数".to_string())?;
        }
        if let Some(s) = a.get("seed") {
            opts.seed = s.parse().map_err(|_| "seed 必须是非负整数".to_string())?;
        }
        if let Some(r) = a.get("rule") {
            opts.rule = Rule::parse(r).ok_or_else(|| format!("未知规则 '{r}'"))?;
        }
        if a.has("no-repair") {
            opts.repair = false;
        }
        if let Some(n) = a.get("max-iterations") {
            opts.max_iterations = n
                .parse()
                .map_err(|_| "max-iterations 必须是整数".to_string())?;
        }

        let cancel = CancelToken::new();
        // 取消演示：--cancel-after-ms 触发协作式取消（用于验收“可终止”）
        if let Some(ms) = a.get("cancel-after-ms") {
            let ms: u64 = ms
                .parse()
                .map_err(|_| "cancel-after-ms 必须是整数".to_string())?;
            let token = cancel.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(ms));
                token.cancel();
            });
        }

        let outcome = engine::solve_json(&text, &opts, &cancel);
        if let Some(out_path) = a.get("out") {
            write(out_path, &outcome.solution_json)?;
        }
        if a.has("json") {
            if let Some(sol) = &outcome.solution {
                print_json(sol);
            } else {
                println!("{}", outcome.solution_json);
            }
        } else {
            print!("{}", engine::format_report(&outcome));
            if let Some(out_path) = a.get("out") {
                println!("方案已写入: {out_path}");
            }
        }
        Ok(match outcome.status {
            Status::Optimal | Status::Feasible => EXIT_OK,
            Status::ModelInvalid => EXIT_MODEL_INVALID,
            Status::Infeasible => EXIT_INFEASIBLE,
            Status::UnsupportedConstraint => EXIT_UNSUPPORTED,
            Status::Cancelled => EXIT_CANCELLED,
            Status::NoSolutionFound | Status::Unknown => EXIT_NO_SOLUTION,
        })
    }

    // ---------------- verify ----------------
    fn cmd_verify(args: &[String]) -> Result<u8, String> {
        let a = Args::parse(args)?;
        let problem = read(a.require("problem")?)?;
        let solution = read(a.require("solution")?)?;
        match engine::verify_solution_json(&problem, &solution) {
            Ok((_, _, violations)) => {
                if a.has("json") {
                    print_json(&Json::obj(vec![
                        ("valid", Json::Bool(violations.is_empty())),
                        (
                            "violations",
                            Json::Arr(violations.iter().map(|v| v.to_json()).collect()),
                        ),
                        ("count", Json::int(violations.len() as i64)),
                    ]));
                } else if violations.is_empty() {
                    println!("✓ 方案合法：独立校验器未发现任何违约（H01–H08 全部通过）");
                } else {
                    println!("✗ 发现 {} 条违约：", violations.len());
                    for v in violations.iter() {
                        println!(
                            "  [{}] {}{}{}{}",
                            v.code,
                            v.message,
                            v.operation_id
                                .as_ref()
                                .map(|o| format!("（工序 {o}）"))
                                .unwrap_or_default(),
                            v.resource_id
                                .as_ref()
                                .map(|r| format!("（资源 {r}）"))
                                .unwrap_or_default(),
                            v.at.as_ref()
                                .map(|t| format!("（{t}）"))
                                .unwrap_or_default(),
                        );
                    }
                }
                Ok(if violations.is_empty() {
                    EXIT_OK
                } else {
                    EXIT_VIOLATIONS
                })
            }
            Err(issues) => {
                for i in issues.iter() {
                    eprintln!("[{}] {} {}", i.code, i.path, i.message);
                }
                Ok(EXIT_MODEL_INVALID)
            }
        }
    }

    // ---------------- compare ----------------
    fn cmd_compare(args: &[String]) -> Result<u8, String> {
        let a = Args::parse(args)?;
        let problem_text = read(a.require("problem")?)?;
        let pj = aps_engine::json::parse(&problem_text).map_err(|e| e.to_string())?;
        let problem = aps_engine::model::parse_problem(&pj)
            .0
            .ok_or_else(|| "问题模型不符合契约".to_string())?;
        let baseline_text = read(a.require("baseline")?)?;
        let baseline = aps_engine::verify::parse_solution(
            &aps_engine::json::parse(&baseline_text).map_err(|e| e.to_string())?,
        )
        .0
        .ok_or_else(|| "基准方案不符合 PlanSolution 契约".to_string())?;
        let mut candidates = Vec::new();
        for path in a.get_all("solution") {
            let text = read(&path)?;
            let sol = aps_engine::verify::parse_solution(
                &aps_engine::json::parse(&text).map_err(|e| e.to_string())?,
            )
            .0
            .ok_or_else(|| format!("候选方案 {path} 不符合契约"))?;
            candidates.push(sol);
        }
        if candidates.is_empty() {
            return Err("至少需要一个 --solution".to_string());
        }
        let report = aps_engine::compare::compare_json(&problem, &baseline, &candidates);
        if a.has("json") {
            print_json(&report);
        } else {
            println!("基准: {}", serde_like_summary(report.get("baseline")));
            if let Some(list) = report.get("candidates").and_then(|v| v.as_arr()) {
                for (i, c) in list.iter().enumerate() {
                    println!("候选 {}: {}", i + 1, serde_like_summary(c.get("summary")));
                    if let Some(d) = c.get("delta_vs_baseline") {
                        println!(
                            "   Δ加权延期 {} 分钟 / Δmakespan {} 分钟 / Δ如期 {} / 变更工序 {} / Δ利用率 {:.2}%",
                            d.get("weighted_tardiness_minutes").and_then(|v| v.as_i64()).unwrap_or(0),
                            d.get("makespan_minutes").and_then(|v| v.as_i64()).unwrap_or(0),
                            d.get("late_orders").and_then(|v| v.as_i64()).unwrap_or(0),
                            d.get("changed_operations").and_then(|v| v.as_i64()).unwrap_or(0),
                            d.get("machine_utilization").and_then(|v| v.as_f64()).unwrap_or(0.0) * 100.0,
                        );
                    }
                }
            }
            println!(
                "口径: 机器/人员利用率 = Σ占用分钟 / Σ可用窗口分钟（available 合并后扣除 blocked）"
            );
        }
        Ok(EXIT_OK)
    }

    fn serde_like_summary(v: Option<&Json>) -> String {
        match v {
            None => "—".to_string(),
            Some(j) => format!(
                "{}（status={}，加权延期 {}，makespan {}，利用率 {:.2}%，违约 {}）",
                j.get("id").and_then(|x| x.as_str()).unwrap_or("-"),
                j.get("status").and_then(|x| x.as_str()).unwrap_or("-"),
                j.get("weighted_tardiness_minutes")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0),
                j.get("makespan_minutes")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0),
                j.get("machine_utilization")
                    .and_then(|x| x.as_f64())
                    .unwrap_or(0.0)
                    * 100.0,
                j.get("violations").and_then(|x| x.as_i64()).unwrap_or(0),
            ),
        }
    }

    // ---------------- explain ----------------
    fn cmd_explain(args: &[String]) -> Result<u8, String> {
        let a = Args::parse(args)?;
        let problem_text = read(a.require("problem")?)?;
        let solution_text = read(a.require("solution")?)?;
        let op = a.require("operation")?.to_string();
        let (problem, solution, _) = engine::verify_solution_json(&problem_text, &solution_text)
            .map_err(|issues| {
                issues
                    .iter()
                    .map(|i| format!("[{}] {} {}", i.code, i.path, i.message))
                    .collect::<Vec<_>>()
                    .join("; ")
            })?;
        let j = aps_engine::explain::explain_operation(&problem, &solution, &op);
        if a.has("json") {
            print_json(&j);
        } else {
            print!("{}", aps_engine::explain::format_explain(&j));
            let blocking = aps_engine::explain::blocking_resources(&problem, &solution, &op);
            if let Some(list) = blocking.as_arr() {
                if !list.is_empty() {
                    println!("  该工序之前占用相关资源的工序（“为什么不能更早”）:");
                    for b in list.iter().take(5) {
                        println!(
                            "    {} ← {}",
                            b.get("resource").and_then(|v| v.as_str()).unwrap_or("-"),
                            b.get("occupied")
                                .and_then(|v| v.as_arr())
                                .map(|a| a
                                    .iter()
                                    .map(|x| format!(
                                        "{}[{}~{}]",
                                        x.get("operation_id")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("?"),
                                        x.get("start").and_then(|v| v.as_str()).unwrap_or(""),
                                        x.get("end").and_then(|v| v.as_str()).unwrap_or("")
                                    ))
                                    .collect::<Vec<_>>()
                                    .join(", "))
                                .unwrap_or_default()
                        );
                    }
                }
            }
        }
        Ok(EXIT_OK)
    }

    // ---------------- benchmark 生成 ----------------
    fn cmd_benchmark(args: &[String]) -> Result<u8, String> {
        let a = Args::parse(args)?;
        let baseline_text = read(a.require("baseline")?)?;
        let baseline = aps_engine::json::parse(&baseline_text).map_err(|e| e.to_string())?;
        let n: usize = a
            .require("operations")?
            .parse()
            .map_err(|_| "operations 必须是整数".to_string())?;
        let built = benchgen::build_separable(&baseline, n)?;
        let ops = benchgen::count_operations(&built);
        let text = built.to_pretty();
        match a.get("out") {
            Some(path) => {
                write(path, &text)?;
                println!("已写入 {path}（{ops} 工序）");
            }
            None => println!("{text}"),
        }
        Ok(EXIT_OK)
    }

    // ---------------- bench 计时 ----------------
    fn cmd_bench(args: &[String]) -> Result<u8, String> {
        let a = Args::parse(args)?;
        let text = read(a.require("problem")?)?;
        let runs: usize = a.get("runs").map(|v| v.parse().unwrap_or(3)).unwrap_or(3);
        let mut opts = SolveOptions::from_objective(
            aps_engine::json::parse(&text)
                .ok()
                .and_then(|j| j.get("objective").cloned())
                .as_ref(),
        );
        if let Some(t) = a.get("time-limit-ms") {
            opts.time_limit_ms = t
                .parse()
                .map_err(|_| "time-limit-ms 必须是整数".to_string())?;
        }
        if let Some(s) = a.get("seed") {
            opts.seed = s.parse().map_err(|_| "seed 必须是整数".to_string())?;
        }
        let ops = aps_engine::json::parse(&text)
            .ok()
            .map(|j| benchgen::count_operations(&j))
            .unwrap_or(0);
        let mut rows: Vec<Json> = Vec::new();
        let mut compile: Vec<f64> = Vec::new();
        let mut solve: Vec<f64> = Vec::new();
        let mut total: Vec<f64> = Vec::new();
        let mut peaks: Vec<i64> = Vec::new();
        let mut statuses: Vec<String> = Vec::new();
        for i in 0..runs {
            alloc::reset_peak();
            let out = engine::solve_json(&text, &opts, &CancelToken::new());
            compile.push(out.metrics.compile_ms.unwrap_or(0.0));
            solve.push(out.metrics.solve_ms.unwrap_or(0.0));
            total.push(out.metrics.total_ms.unwrap_or(0.0));
            peaks.push(out.metrics.peak_memory_bytes.unwrap_or(0) as i64);
            statuses.push(out.status.as_str().to_string());
            rows.push(Json::obj(vec![
                ("run", Json::int((i + 1) as i64)),
                ("status", Json::str(out.status.as_str())),
                (
                    "objective",
                    out.objective
                        .map(|v| {
                            let lb = out.search.lower_bound;
                            let gap = lb.and_then(|b| {
                                if opts.strategy == Strategy::Makespan || v.weighted_tardiness == 0
                                {
                                    Some(if b > 0 {
                                        (v.makespan - b) as f64 / b as f64
                                    } else {
                                        0.0
                                    })
                                } else {
                                    None
                                }
                            });
                            v.to_json(opts.strategy, lb, gap)
                        })
                        .unwrap_or(Json::Null),
                ),
                ("metrics", out.metrics.to_json()),
            ]));
        }
        let stats = |v: &Vec<f64>| -> Json {
            if v.is_empty() {
                return Json::Null;
            }
            let mut s = v.clone();
            s.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let sum: f64 = s.iter().sum();
            Json::obj(vec![
                ("min_ms", Json::Float(s[0])),
                ("median_ms", Json::Float(s[s.len() / 2])),
                ("max_ms", Json::Float(s[s.len() - 1])),
                ("mean_ms", Json::Float(sum / s.len() as f64)),
            ])
        };
        let report = Json::obj(vec![
            ("runs", Json::int(runs as i64)),
            ("operations", Json::int(ops as i64)),
            ("time_limit_ms", Json::int(opts.time_limit_ms)),
            ("seed", Json::int(opts.seed as i64)),
            ("profile", Json::str(opts.profile.name())),
            ("compile", stats(&compile)),
            ("solve", stats(&solve)),
            ("total", stats(&total)),
            (
                "peak_memory_bytes_max",
                Json::int(peaks.iter().copied().max().unwrap_or(0)),
            ),
            ("statuses", Json::strings(statuses)),
            ("detail", Json::Arr(rows)),
        ]);
        if a.has("json") {
            print_json(&report);
        } else {
            println!(
                "规模: {} 工序 / 运行 {} 次 / 时限 {} ms / seed {}",
                ops, runs, opts.time_limit_ms, opts.seed
            );
            for (name, s) in [
                ("编译 compile", report.get("compile").unwrap()),
                ("求解 solve", report.get("solve").unwrap()),
                ("总计 total", report.get("total").unwrap()),
            ] {
                println!(
                    "{}: min {:.1} / 中位 {:.1} / max {:.1} ms",
                    name,
                    s.get("min_ms").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    s.get("median_ms").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    s.get("max_ms").and_then(|v| v.as_f64()).unwrap_or(0.0),
                );
            }
            println!(
                "峰值内存: {:.2} MB",
                peaks.iter().copied().max().unwrap_or(0) as f64 / 1_048_576.0
            );
        }
        Ok(EXIT_OK)
    }

    // ---------------- accept ----------------
    fn cmd_accept(args: &[String]) -> Result<u8, String> {
        let a = Args::parse(args)?;
        let start: PathBuf = a
            .get("dir")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let dir = acceptance::locate_aps_dir(&start).ok_or_else(|| {
            format!(
                "在 {} 附近找不到包含 mock/baseline.json 的交付目录",
                start.display()
            )
        })?;
        let report = acceptance::run(&dir);
        if a.has("json") {
            print_json(&report.to_json());
        } else {
            println!("APS P0 验收套件（目录 {}）\n", dir.display());
            for case in report.cases.iter() {
                println!(
                    "[{}] {} — {}",
                    case.id,
                    case.name,
                    if case.passed {
                        "通过 ✓"
                    } else {
                        "失败 ✗"
                    }
                );
                for d in case.details.iter() {
                    println!("    {d}");
                }
            }
            println!(
                "\n汇总: {} 通过 / {} 失败",
                report.passed(),
                report.failed()
            );
        }
        Ok(if report.all_passed() {
            EXIT_OK
        } else {
            EXIT_VIOLATIONS
        })
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn main() -> std::process::ExitCode {
    cli::main()
}

#[cfg(target_arch = "wasm32")]
fn main() {
    // wasm 目标只构建库（cdylib）；可执行入口不使用。
}
