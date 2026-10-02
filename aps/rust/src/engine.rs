//! 求解流水线：`parse → validate → capabilities → compile → solve → verify → PlanSolution`。
//!
//! 状态映射严格遵循 APS-SRS §4：
//!
//! | 情形 | 状态 |
//! |------|------|
//! | JSON/契约/语义非法 | `MODEL_INVALID`（字段级定位） |
//! | 模型与引擎能力不匹配（规模超限、P1 约束） | `UNSUPPORTED_CONSTRAINT`（不静默降级） |
//! | 命中可构造的无解证明 | `INFEASIBLE`（`optimality_proven` 仅在证明成立时用于状态语义） |
//! | 找到可行解（未证明最优） | `FEASIBLE`（`optimality_proven=false`） |
//! | 时间预算耗尽仍未找到可行解 | `UNKNOWN` |
//! | 搜索穷尽仍未找到可行解 | `NO_SOLUTION_FOUND` |
//! | 被主动取消 | `CANCELLED`（若有在途可行解则一并返回，并标注） |
//! | 自检发现求解器自身产出违约 | `UNKNOWN` + `verified=false`（宁可拒收也不放行） |

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::capabilities::{self, Profile};
use crate::compile::{self, Certificate, Compiled};
use crate::errors::{codes, Issue, Severity, Status, Violation};
use crate::json::Json;
use crate::model::RawProblem;
use crate::objective::{ObjectiveValue, Strategy};
use crate::schedule::{self, Budget};
use crate::solver::{self, Rule, SearchConfig};
use crate::{alloc, clock, verify, COMPILER_VERSION, ENGINE_NAME, ENGINE_VERSION};

/// 取消信号（原生服务/CLI 通过共享 `AtomicBool` 支持协作式取消）。
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> CancelToken {
        CancelToken(Arc::new(AtomicBool::new(false)))
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
    pub fn raw(&self) -> Arc<AtomicBool> {
        self.0.clone()
    }
}

/// 求解选项。
#[derive(Debug, Clone)]
pub struct SolveOptions {
    pub profile: Profile,
    pub strategy: Strategy,
    pub time_limit_ms: i64,
    pub seed: u64,
    pub rule: Rule,
    pub repair: bool,
    pub max_iterations: usize,
    /// 是否在返回前运行独立校验器（默认 true，契约要求交叉验证）
    pub verify: bool,
    /// 可选的方案 ID（默认由 problem_hash + seed 派生，保证可复现）
    pub solution_id: Option<String>,
}

impl Default for SolveOptions {
    fn default() -> Self {
        SolveOptions {
            profile: Profile::Native,
            strategy: Strategy::Lexicographic,
            time_limit_ms: 30_000,
            seed: 42,
            rule: Rule::Auto,
            repair: true,
            max_iterations: 0,
            verify: true,
            solution_id: None,
        }
    }
}

impl SolveOptions {
    /// 以问题 `objective` 块为默认值（契约中 `objective` 携带 strategy / time_limit_ms / seed）。
    pub fn from_objective(objective: Option<&Json>) -> SolveOptions {
        let mut o = SolveOptions::default();
        if let Some(obj) = objective {
            if let Some(s) = obj.get("strategy").and_then(|v| v.as_str()) {
                if let Some(st) = Strategy::parse(s) {
                    o.strategy = st;
                }
            }
            if let Some(t) = obj.get("time_limit_ms").and_then(|v| v.as_i64()) {
                o.time_limit_ms = t;
            }
            if let Some(seed) = obj.get("seed").and_then(|v| v.as_i64()) {
                if seed >= 0 {
                    o.seed = seed as u64;
                }
            }
        }
        o
    }
}

/// 求解指标（契约要求：建模耗时、首解时间、总耗时、峰值内存、验证耗时）。
#[derive(Debug, Clone, Default)]
pub struct Metrics {
    pub compile_ms: Option<f64>,
    pub first_feasible_ms: Option<f64>,
    pub solve_ms: Option<f64>,
    pub verify_ms: Option<f64>,
    pub peak_memory_bytes: Option<u64>,
    pub total_ms: Option<f64>,
}

impl Metrics {
    pub fn to_json(&self) -> Json {
        let f = |v: Option<f64>| match v {
            Some(x) => Json::Float((x * 1000.0).round() / 1000.0),
            None => Json::Null,
        };
        Json::obj(vec![
            ("compile_ms", f(self.compile_ms)),
            ("first_feasible_ms", f(self.first_feasible_ms)),
            ("solve_ms", f(self.solve_ms)),
            ("verify_ms", f(self.verify_ms)),
            (
                "peak_memory_bytes",
                match self.peak_memory_bytes {
                    Some(v) => Json::int(v as i64),
                    None => Json::Null,
                },
            ),
            ("total_ms", f(self.total_ms)),
            (
                "time_metrics_available",
                Json::Bool(clock::TIME_METRICS_AVAILABLE),
            ),
        ])
    }
}

/// 求解结果（对外结构）。
#[derive(Debug, Clone)]
pub struct SolveOutcome {
    pub status: Status,
    pub solution: Option<Json>,
    pub solution_json: String,
    /// `MODEL_INVALID` / `UNSUPPORTED_CONSTRAINT` 等结构化说明
    pub issues: Vec<Issue>,
    pub violations: Vec<Violation>,
    pub metrics: Metrics,
    pub objective: Option<ObjectiveValue>,
    pub problem_hash: Option<String>,
    pub search: SearchSummary,
    /// 可读的补充说明（CLI 文本模式）
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SearchSummary {
    pub iterations: usize,
    pub restarts: usize,
    pub rules_tried: usize,
    pub timed_out: bool,
    pub cancelled: bool,
    pub lower_bound: Option<i64>,
}

/// 便捷入口：从 JSON 文本求解。
pub fn solve_json(problem_text: &str, opts: &SolveOptions, cancel: &CancelToken) -> SolveOutcome {
    match crate::json::parse(problem_text) {
        Ok(json) => solve_problem_json(&json, opts, cancel),
        Err(e) => invalid_json_outcome(&e, opts),
    }
}

fn invalid_json_outcome(e: &crate::json::JsonError, opts: &SolveOptions) -> SolveOutcome {
    let issue = Issue::error(
        "JSON_SYNTAX",
        format!("line {}:{}", e.line, e.column),
        e.message.clone(),
    );
    let solution = base_solution_json(
        opts,
        Status::ModelInvalid,
        None,
        None,
        &[],
        &[],
        None,
        &Metrics::default(),
    );
    SolveOutcome {
        status: Status::ModelInvalid,
        solution_json: solution.to_pretty(),
        solution: Some(solution),
        issues: vec![issue],
        violations: vec![],
        metrics: Metrics::default(),
        objective: None,
        problem_hash: None,
        search: SearchSummary::default(),
        notes: vec![format!("输入不是合法 JSON：{}", e)],
    }
}

/// 主入口：对已解析的 JSON 求解。
pub fn solve_problem_json(problem: &Json, opts: &SolveOptions, cancel: &CancelToken) -> SolveOutcome {
    let t_start = clock::now_ms();
    alloc::reset_peak();
    let caps = capabilities::capabilities_for(opts.profile);

    // ---- 1) 契约解析 ----
    let (parsed, issues) = crate::model::parse_problem(problem);
    let parsed = match parsed {
        Some(p) => p,
        None => {
            let metrics = Metrics {
                total_ms: Some(clock::now_ms() - t_start),
                ..Default::default()
            };
            let violations: Vec<Violation> = issues.iter().map(issue_to_violation).collect();
            let solution = base_solution_json(
                opts,
                Status::ModelInvalid,
                None,
                None,
                &violations,
                &[],
                None,
                &metrics,
            );
            return SolveOutcome {
                status: Status::ModelInvalid,
                solution_json: solution.to_pretty(),
                solution: Some(solution),
                issues,
                violations,
                metrics,
                objective: None,
                problem_hash: None,
                search: SearchSummary::default(),
                notes: vec!["模型不符合 PlanProblem v1 契约，详见 issues/violations 的字段定位".into()],
            };
        }
    };

    let problem_hash = format!(
        "sha256:{}",
        crate::hash::sha256_hex(parsed.source.canonical().as_bytes())
    );

    // ---- 2) 语义校验 ----
    let semantic = crate::validate::validate(&parsed);
    if semantic.iter().any(|i| i.severity == Severity::Error) {
        let metrics = Metrics {
            total_ms: Some(clock::now_ms() - t_start),
            ..Default::default()
        };
        let violations: Vec<Violation> = semantic.iter().map(issue_to_violation).collect();
        let solution = base_solution_json(
            opts,
            Status::ModelInvalid,
            Some(&parsed),
            Some(&problem_hash),
            &violations,
            &[],
            None,
            &metrics,
        );
        return SolveOutcome {
            status: Status::ModelInvalid,
            solution_json: solution.to_pretty(),
            solution: Some(solution),
            issues: semantic,
            violations,
            metrics,
            objective: None,
            problem_hash: Some(problem_hash),
            search: SearchSummary::default(),
            notes: vec!["模型语义校验未通过（引用完整性 / DAG / 分辨率对齐 / 时域一致性）".into()],
        };
    }
    let warnings: Vec<Issue> = semantic
        .iter()
        .filter(|i| i.severity == Severity::Warning)
        .cloned()
        .collect();

    // ---- 3) 能力协商 ----
    if let Err(unsupported) = capabilities::check_support(&parsed, &caps) {
        let metrics = Metrics {
            total_ms: Some(clock::now_ms() - t_start),
            ..Default::default()
        };
        let violations: Vec<Violation> = unsupported
            .iter()
            .map(|u| {
                let mut v = Violation::new(codes::UNSUPPORTED, "CONTRACT", u.message.clone());
                v.details = u.details.clone();
                v.details.push(("path".into(), Json::str(u.path.clone())));
                v.details.push(("code".into(), Json::str(u.code.clone())));
                v
            })
            .collect();
        let solution = base_solution_json(
            opts,
            Status::UnsupportedConstraint,
            Some(&parsed),
            Some(&problem_hash),
            &violations,
            &[],
            None,
            &metrics,
        );
        return SolveOutcome {
            status: Status::UnsupportedConstraint,
            solution_json: solution.to_pretty(),
            solution: Some(solution),
            issues: unsupported
                .iter()
                .map(|u| Issue::error(&u.code, u.path.clone(), u.message.clone()))
                .collect(),
            violations,
            metrics,
            objective: None,
            problem_hash: Some(problem_hash),
            search: SearchSummary::default(),
            notes: vec![format!(
                "模型与引擎档位 '{}' 的能力不匹配：未静默删除任何约束，请切换服务器后端（native）",
                opts.profile.name()
            )],
        };
    }

    // ---- 4) 编译 ----
    let t_compile = clock::now_ms();
    let compiled: Compiled = compile::compile(&parsed, problem_hash.clone());
    let compile_ms = clock::now_ms() - t_compile;

    // ---- 5) 无解证明 ----
    if !compiled.certificates.is_empty() && caps.can_prove_infeasible {
        let metrics = Metrics {
            compile_ms: Some(compile_ms),
            total_ms: Some(clock::now_ms() - t_start),
            peak_memory_bytes: Some(alloc::peak_bytes() as u64),
            ..Default::default()
        };
        let violations: Vec<Violation> = compiled
            .certificates
            .iter()
            .map(certificate_to_violation)
            .collect();
        let solution = base_solution_json(
            opts,
            Status::Infeasible,
            Some(&parsed),
            Some(&problem_hash),
            &violations,
            &[],
            None,
            &metrics,
        );
        return SolveOutcome {
            status: Status::Infeasible,
            solution_json: solution.to_pretty(),
            solution: Some(solution),
            issues: vec![],
            violations,
            metrics,
            objective: None,
            problem_hash: Some(problem_hash),
            search: SearchSummary::default(),
            notes: vec![
                "命中可构造的无解证明（非“没搜到解”）：本引擎只在证明成立时返回 INFEASIBLE".into(),
            ],
        };
    }

    // ---- 6) 启发式求解 ----
    let budget = Budget::new(opts.time_limit_ms, cancel.raw());
    let cfg = SearchConfig {
        strategy: opts.strategy,
        time_limit_ms: opts.time_limit_ms,
        seed: opts.seed,
        rule: opts.rule,
        repair: opts.repair,
        max_iterations: opts.max_iterations,
    };
    let t_solve = clock::now_ms();
    let outcome = solver::search(&compiled, &cfg, &budget);
    let solve_ms = clock::now_ms() - t_solve;
    let solver_proven_optimal = outcome.proven_optimal;
    let solver_lower_bound = outcome.lower_bound;

    let mut notes: Vec<String> = Vec::new();
    notes.extend(
        compiled
            .warnings
            .iter()
            .map(|w| format!("[警告 {}] {} {}", w.code, w.path, w.message)),
    );
    for w in warnings.iter() {
        notes.push(format!("[警告 {}] {} {}", w.code, w.path, w.message));
    }

    let mut metrics = Metrics {
        compile_ms: Some(compile_ms),
        first_feasible_ms: outcome.first_feasible_ms,
        solve_ms: Some(solve_ms),
        peak_memory_bytes: Some(alloc::peak_bytes() as u64),
        ..Default::default()
    };
    let search_summary = SearchSummary {
        iterations: outcome.iterations,
        restarts: outcome.restarts,
        rules_tried: outcome.rules_tried,
        timed_out: outcome.timed_out,
        cancelled: outcome.cancelled,
        lower_bound: outcome.lower_bound,
    };

    // 无可解：区分 UNKNOWN（预算耗尽）与 NO_SOLUTION_FOUND（搜索穷尽）
    let Some((schedule, value)) = outcome.best else {
        let status = if outcome.cancelled {
            Status::Cancelled
        } else if budget.expired() {
            Status::Unknown
        } else {
            Status::NoSolutionFound
        };
        let diagnostics: Vec<Violation> = compiled
            .certificates
            .iter()
            .map(certificate_to_violation)
            .collect();
        for v in diagnostics.iter() {
            notes.push(format!(
                "[诊断 {}] {}（该证据未被声明为“已证明无解”，故状态为 {}）",
                v.code,
                v.message,
                status.as_str()
            ));
        }
        metrics.total_ms = Some(clock::now_ms() - t_start);
        let solution = base_solution_json(
            opts,
            status,
            Some(&parsed),
            Some(&problem_hash),
            &diagnostics,
            &[],
            None,
            &metrics,
        );
        return SolveOutcome {
            status,
            solution_json: solution.to_pretty(),
            solution: Some(solution),
            issues: vec![],
            violations: diagnostics,
            metrics,
            objective: None,
            problem_hash: Some(problem_hash),
            search: search_summary,
            notes,
        };
    };

    // ---- 7) 自检（求解器内部一致性）----
    let mut internal_problems: Vec<String> = Vec::new();
    if !schedule.is_complete() {
        internal_problems.push("求解器返回了不完整的排程".to_string());
    }
    if let Some(msg) = schedule::overlap_violation(&compiled, &schedule) {
        internal_problems.push(msg);
    }
    if let Some((mi, t, bal)) = schedule::ledger_violation(&compiled, &schedule) {
        internal_problems.push(format!(
            "物料 '{}' 在相对第 {} 分钟透支（余额 {}）",
            compiled.materials[mi].id, t, bal
        ));
    }

    // ---- 8) 组装 PlanSolution 并做独立校验 ----
    let operations_json = schedule_to_operations(&compiled, &schedule);
    // 档位一致性：能力声明 can_prove_optimal=false 的档位（wasm-light）不得返回 OPTIMAL，
    // 即使本轮恰好达到下界，也只报告 FEASIBLE（把最优性证据留给服务端 native 档位）。
    let caps = crate::capabilities::capabilities_for(opts.profile);
    let proven = solver_proven_optimal && caps.can_prove_optimal;
    let mut status = if outcome.cancelled {
        Status::Cancelled
    } else if proven {
        // 仅当加权延期=0 且 makespan 达到有效下界时才允许 OPTIMAL
        Status::Optimal
    } else {
        Status::Feasible
    };
    let mut violations: Vec<Violation> = Vec::new();
    let verified;
    let verify_ms;

    if opts.verify || !internal_problems.is_empty() {
        let solution = base_solution_json(
            opts,
            status,
            Some(&parsed),
            Some(&problem_hash),
            &[],
            &operations_json,
            Some(&value),
            &metrics,
        );
        let t_verify = clock::now_ms();
        let (raw_solution, parse_issues) = verify::parse_solution(&solution);
        match raw_solution {
            Some(rs) => {
                violations = verify::verify(&parsed, &rs);
            }
            None => {
                violations = parse_issues
                    .iter()
                    .map(|i| {
                        Violation::new(
                            codes::ENGINE_SELF_CHECK,
                            "ENGINE",
                            format!("{}（{}）", i.message, i.path),
                        )
                    })
                    .collect();
            }
        }
        verify_ms = Some(clock::now_ms() - t_verify);
        metrics.verify_ms = verify_ms;

        if !violations.is_empty() || !internal_problems.is_empty() {
            // 宁可拒收，也不放行：状态退化为 UNKNOWN，verified=false
            status = Status::Unknown;
            for msg in internal_problems.iter() {
                violations.insert(
                    0,
                    Violation::new(codes::ENGINE_SELF_CHECK, "ENGINE", msg.clone()),
                );
            }
            notes.push(
                "引擎自检未通过：本次结果被标记为 verified=false 且状态 UNKNOWN，平台应拒绝发布"
                    .to_string(),
            );
        }
        verified = violations.is_empty() && internal_problems.is_empty();
    } else {
        verified = internal_problems.is_empty();
    }

    metrics.total_ms = Some(clock::now_ms() - t_start);
    let _ = verify_ms; // 已写入 metrics.verify_ms；此处避免未使用告警
    if outcome.cancelled {
        let mut v = Violation::new(
            codes::CANCELLED_WITH_INCUMBENT,
            "ENGINE",
            "求解被主动取消；返回的是取消前已找到的可行解（incumbent）",
        );
        v.severity = Severity::Warning;
        violations.push(v);
    }
    notes.push(format!(
        "引擎 {} v{}：档位 {}，策略 {}，规则 {}，迭代 {}，重启 {}，用时 {:.0} ms",
        ENGINE_NAME,
        ENGINE_VERSION,
        opts.profile.name(),
        opts.strategy.as_str(),
        opts.rule.as_str(),
        search_summary.iterations,
        search_summary.restarts,
        metrics.total_ms.unwrap_or(0.0)
    ));
    if let Some(lb) = solver_lower_bound {
        notes.push(format!(
            "makespan 有效下界 {} 分钟（弱下界：仅放松机器/人员/工装/物料竞争与时长选择，含 blocked 空档）",
            lb
        ));
    }
    if status == Status::Optimal {
        notes.push(
            "最优性依据：加权延期为 0（理论下界）且 makespan 达到有效下界 → optimality_proven=true"
                .to_string(),
        );
    } else if solver_proven_optimal && !caps.can_prove_optimal {
        notes.push(format!(
            "本轮已证明最优（加权延期=0 且 makespan 达到下界），但档位 '{}' 的能力声明 can_prove_optimal=false，故按 FEASIBLE 报告；需要 OPTIMAL 请用 native 档位",
            opts.profile.name()
        ));
    }

    let solution = base_solution_json(
        opts,
        status,
        Some(&parsed),
        Some(&problem_hash),
        &violations,
        &operations_json,
        Some(&value),
        &metrics,
    );
    let gap = solver_lower_bound.and_then(|lb| {
        if opts.strategy == Strategy::Makespan || value.weighted_tardiness == 0 {
            Some(if lb > 0 {
                (value.makespan - lb) as f64 / lb as f64
            } else {
                0.0
            })
        } else {
            None
        }
    });
    let solution = apply_optimality(
        solution,
        proven,
        solver_lower_bound,
        gap,
    );
    let solution = set_verified(solution, verified);

    SolveOutcome {
        status,
        solution_json: solution.to_pretty(),
        solution: Some(solution),
        issues: vec![],
        violations,
        metrics,
        objective: Some(value),
        problem_hash: Some(problem_hash),
        search: search_summary,
        notes,
    }
}

/// 独立校验入口（CLI `aps verify` 使用）。
pub fn verify_solution_json(
    problem_text: &str,
    solution_text: &str,
) -> Result<(RawProblem, verify::RawSolution, Vec<Violation>), Vec<Issue>> {
    let pj = crate::json::parse(problem_text).map_err(|e| {
        vec![Issue::error(
            "JSON_SYNTAX",
            format!("line {}:{}", e.line, e.column),
            format!("问题 JSON 解析失败：{}", e.message),
        )]
    })?;
    let (problem, issues) = crate::model::parse_problem(&pj);
    let problem = problem.ok_or_else(|| {
        let mut v = issues.clone();
        v.push(Issue::error("PROBLEM_INVALID", "$", "问题模型不符合契约"));
        v
    })?;
    let sj = crate::json::parse(solution_text).map_err(|e| {
        vec![Issue::error(
            "JSON_SYNTAX",
            format!("line {}:{}", e.line, e.column),
            format!("方案 JSON 解析失败：{}", e.message),
        )]
    })?;
    let (solution, issues) = verify::parse_solution(&sj);
    let solution = solution.ok_or_else(|| {
        let mut v = issues.clone();
        v.push(Issue::error("SOLUTION_INVALID", "$", "方案不符合 PlanSolution 契约"));
        v
    })?;
    let violations = verify::verify(&problem, &solution);
    Ok((problem, solution, violations))
}

// ---------------------------------------------------------------------------
// JSON 组装
// ---------------------------------------------------------------------------

fn issue_to_violation(i: &Issue) -> Violation {
    let mut v = Violation::new(&i.code, "CONTRACT", i.message.clone());
    v.severity = i.severity;
    v.details.push(("path".into(), Json::str(i.path.clone())));
    v
}

fn certificate_to_violation(cert: &Certificate) -> Violation {
    let mut v = Violation::new(cert.code, "PROOF", cert.message.clone());
    v.order_id = cert.order_id.clone();
    v.operation_id = cert.operation_id.clone();
    for (k, val) in cert.details.iter() {
        v.details.push((k.clone(), val.clone()));
    }
    v
}

fn schedule_to_operations(c: &Compiled, s: &schedule::Schedule) -> Vec<Json> {
    let mut rows: Vec<(i64, &str, &str, Json)> = Vec::new();
    for (op, a) in s.assign.iter().enumerate() {
        let a = match a {
            Some(a) => *a,
            None => continue,
        };
        let (order_id, op_id) = c.trace_op(op);
        let tools: Vec<String> = c.ops[op]
            .tools
            .iter()
            .map(|t| c.tools[*t].id.clone())
            .collect();
        let v = Json::obj(vec![
            ("order_id", Json::str(order_id.to_string())),
            ("operation_id", Json::str(op_id.to_string())),
            ("machine_id", Json::str(c.machines[a.machine].id.clone())),
            ("worker_id", Json::str(c.workers[a.worker].id.clone())),
            ("tool_ids", Json::strings(tools)),
            ("start_at", Json::str(c.iso(a.start))),
            ("end_at", Json::str(c.iso(a.end))),
        ]);
        rows.push((a.start, order_id, op_id, v));
    }
    rows.sort_by(|x, y| (x.0, x.1, x.2).cmp(&(y.0, y.1, y.2)));
    rows.into_iter().map(|(_, _, _, v)| v).collect()
}

#[allow(clippy::too_many_arguments)]
fn base_solution_json(
    opts: &SolveOptions,
    status: Status,
    problem: Option<&RawProblem>,
    problem_hash: Option<&str>,
    violations: &[Violation],
    operations: &[Json],
    objective: Option<&ObjectiveValue>,
    metrics: &Metrics,
) -> Json {
    let (tenant_id, snapshot_id) = match problem {
        Some(p) => (
            Some(p.meta.tenant_id.clone()),
            p.meta.snapshot_id.clone(),
        ),
        None => (None, String::new()),
    };
    let id = opts.solution_id.clone().unwrap_or_else(|| {
        format!(
            "{}-{}-{}",
            ENGINE_NAME,
            opts.seed,
            problem_hash
                .map(|h| h.trim_start_matches("sha256:").chars().take(12).collect::<String>())
                .unwrap_or_else(|| "unknown".to_string())
        )
    });
    let objective_json = match objective {
        Some(v) => v.to_json(opts.strategy, None, None),
        None => Json::obj(vec![
            ("strategy", Json::str(opts.strategy.as_str())),
            ("weighted_tardiness_minutes", Json::Null),
            ("makespan_minutes", Json::Null),
            ("best_bound", Json::Null),
            ("relative_gap", Json::Null),
        ]),
    };
    Json::obj(vec![
        (
            "schema_version",
            Json::str(crate::errors::SCHEMA_VERSION_SOLUTION),
        ),
        ("id", Json::str(id)),
        ("tenant_id", Json::opt_str(tenant_id)),
        ("snapshot_id", Json::str(snapshot_id)),
        (
            "problem_hash",
            Json::opt_str(problem_hash.map(|s| s.to_string())),
        ),
        ("engine", Json::str(ENGINE_NAME)),
        ("engine_version", Json::str(ENGINE_VERSION)),
        ("compiler_version", Json::str(COMPILER_VERSION)),
        (
            "options",
            Json::obj(vec![
                ("strategy", Json::str(opts.strategy.as_str())),
                ("time_limit_ms", Json::int(opts.time_limit_ms)),
                ("seed", Json::int(opts.seed as i64)),
                ("profile", Json::str(opts.profile.name())),
                ("rule", Json::str(opts.rule.as_str())),
                ("repair", Json::Bool(opts.repair)),
            ]),
        ),
        ("status", Json::str(status.as_str())),
        ("optimality_proven", Json::Bool(false)),
        ("verified", Json::Bool(false)),
        (
            "violations",
            Json::Arr(violations.iter().map(|v| v.to_json()).collect()),
        ),
        ("objective", objective_json),
        ("metrics", metrics.to_json()),
        ("operations", Json::Arr(operations.to_vec())),
    ])
}

/// 写入 `optimality_proven` 与目标块中的 `best_bound` / `relative_gap`。
fn apply_optimality(mut solution: Json, proven: bool, bound: Option<i64>, gap: Option<f64>) -> Json {
    if let Json::Obj(fields) = &mut solution {
        for (k, v) in fields.iter_mut() {
            match k.as_str() {
                "optimality_proven" => *v = Json::Bool(proven),
                "objective" => {
                    if let Json::Obj(obj) = v {
                        for (ok, ov) in obj.iter_mut() {
                            match ok.as_str() {
                                "best_bound" => {
                                    *ov = match bound {
                                        Some(b) => Json::int(b),
                                        None => Json::Null,
                                    }
                                }
                                "relative_gap" => {
                                    *ov = match gap {
                                        Some(g) => Json::Float(g),
                                        None => Json::Null,
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    solution
}

fn set_verified(mut solution: Json, verified: bool) -> Json {
    if let Json::Obj(fields) = &mut solution {
        for (k, v) in fields.iter_mut() {
            if k == "verified" {
                *v = Json::Bool(verified);
            }
        }
    }
    solution
}

/// 可读报告（CLI 文本模式 / 演示）。
pub fn format_report(outcome: &SolveOutcome) -> String {
    let mut s = String::new();
    s.push_str(&format!("状态: {}\n", outcome.status.as_str()));
    if let Some(h) = &outcome.problem_hash {
        s.push_str(&format!("problem_hash: {}\n", h));
    }
    if let Some(v) = &outcome.objective {
        s.push_str(&format!(
            "目标: 加权延期 {} 分钟 / makespan {} 分钟（延期订单 {}，总延期 {}）\n",
            v.weighted_tardiness, v.makespan, v.late_orders, v.total_tardiness
        ));
    }
    let m = &outcome.metrics;
    s.push_str(&format!(
        "指标: 建模 {:.1} ms / 首解 {} / 求解 {:.1} ms / 校验 {} / 峰值内存 {} / 总计 {:.1} ms\n",
        m.compile_ms.unwrap_or(0.0),
        m.first_feasible_ms
            .map(|v| format!("{:.1} ms", v))
            .unwrap_or_else(|| "unavailable".to_string()),
        m.solve_ms.unwrap_or(0.0),
        m.verify_ms
            .map(|v| format!("{:.1} ms", v))
            .unwrap_or_else(|| "unavailable".to_string()),
        m.peak_memory_bytes
            .map(|v| format!("{:.1} MB", v as f64 / 1_048_576.0))
            .unwrap_or_else(|| "unavailable".to_string()),
        m.total_ms.unwrap_or(0.0),
    ));
    s.push_str(&format!(
        "搜索: 规则 {} 个 / 迭代 {} / 重启 {}{}\n",
        outcome.search.rules_tried,
        outcome.search.iterations,
        outcome.search.restarts,
        if outcome.search.timed_out {
            " / 时间预算耗尽"
        } else {
            ""
        }
    ));
    if !outcome.violations.is_empty() {
        s.push_str(&format!("违约/诊断 {} 条:\n", outcome.violations.len()));
        for v in outcome.violations.iter().take(20) {
            s.push_str(&format!(
                "  [{}] {}{}{}\n",
                v.code,
                v.message,
                v.operation_id
                    .as_ref()
                    .map(|o| format!("（工序 {}）", o))
                    .unwrap_or_default(),
                v.at.as_ref().map(|t| format!("（{}）", t)).unwrap_or_default()
            ));
        }
        if outcome.violations.len() > 20 {
            s.push_str(&format!("  … 其余 {} 条见 JSON\n", outcome.violations.len() - 20));
        }
    }
    for n in outcome.notes.iter() {
        s.push_str(&format!("说明: {}\n", n));
    }
    s
}
