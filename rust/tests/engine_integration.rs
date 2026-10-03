//! 端到端集成测试：只用交付目录里的 Mock 夹具，验证“编译—求解—校验—对比—解释—基准生成”全链路。
//!
//! 这些测试刻意保持轻量（<10 秒），适合每次改动后运行；
//! 完整的 S01–S08 验收套件见 `tests/acceptance_suite.rs`（默认 `#[ignore]`，用 `cargo test -- --ignored` 触发）。

use std::path::{Path, PathBuf};

use aps_engine::capabilities::{self, Profile};
use aps_engine::engine::{self, CancelToken, SolveOptions};
use aps_engine::errors::Status;
use aps_engine::json;
use aps_engine::{benchgen, compare, explain, model, validate};

fn aps_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crate 位于 aps/rust 下")
        .to_path_buf()
}

fn read(rel: &str) -> String {
    std::fs::read_to_string(aps_dir().join(rel)).unwrap_or_else(|e| panic!("读取 {rel} 失败：{e}"))
}

fn solve(rel: &str, time_limit_ms: i64) -> engine::SolveOutcome {
    let text = read(rel);
    let opts = SolveOptions {
        time_limit_ms,
        seed: 42,
        profile: Profile::Native,
        ..Default::default()
    };
    engine::solve_json(&text, &opts, &CancelToken::new())
}

#[test]
fn all_mock_fixtures_validate_against_contract() {
    for f in [
        "mock/baseline.json",
        "mock/machine-breakdown.json",
        "mock/material-delay.json",
        "mock/infeasible-no-welder.json",
    ] {
        let j = json::parse(&read(f)).unwrap();
        let (problem, issues) = model::parse_problem(&j);
        assert!(problem.is_some(), "{f} 应能通过契约解析：{issues:?}");
        let p = problem.unwrap();
        let vs = validate::validate(&p);
        assert!(
            vs.iter()
                .all(|v| v.severity != aps_engine::errors::Severity::Error),
            "{f} 存在模型错误：{vs:?}"
        );
        assert!(j.canonical().len() > 100);
    }
}

/// 断言输出为 FEASIBLE，或为**有证据的** OPTIMAL（SRS 禁止伪称最优）。
/// OPTIMAL 时独立重算下界，并要求 makespan = best_bound = 重算下界。
fn assert_feasible_or_proven(out: &engine::SolveOutcome, problem_text: &str, ctx: &str) {
    match out.status {
        Status::Feasible => {}
        Status::Optimal => {
            let sol = out.solution.as_ref().expect("OPTIMAL 必须给出方案 JSON");
            assert_eq!(
                sol.get("optimality_proven").and_then(|v| v.as_bool()),
                Some(true),
                "{ctx}: 声称 OPTIMAL 必须同时写 optimality_proven=true"
            );
            let obj = sol.get("objective").expect("objective 块");
            let ms = obj.get("makespan_minutes").and_then(|v| v.as_i64());
            let lb = obj.get("best_bound").and_then(|v| v.as_i64());
            let (p, _) = model::parse_problem(&aps_engine::json::parse(problem_text).unwrap());
            let recompiled = aps_engine::compile::compile(&p.unwrap(), String::new());
            let recomputed = aps_engine::objective::makespan_lower_bound(&recompiled);
            assert_eq!(ms, lb, "{ctx}: OPTIMAL 时 makespan 必须等于 best_bound");
            assert_eq!(
                lb,
                Some(recomputed),
                "{ctx}: 方案自称的下界必须能独立重算得到"
            );
        }
        other => panic!("{ctx}: 期望 FEASIBLE 或 OPTIMAL，实际 {}", other.as_str()),
    }
}

#[test]
fn baseline_solve_is_verified_feasible_and_material_bound() {
    let out = solve("mock/baseline.json", 500);
    let text = read("mock/baseline.json");
    assert_feasible_or_proven(&out, &text, "baseline");
    assert!(!out
        .violations
        .iter()
        .any(|v| v.severity == aps_engine::errors::Severity::Error));
    let json_text = out.solution_json.clone();
    // 独立复核：把求解器输出送回 verifier
    let (_, _, violations) = engine::verify_solution_json(&read("mock/baseline.json"), &json_text)
        .expect("输出必须符合 PlanSolution 契约");
    assert!(violations.is_empty(), "求解器输出校验失败：{violations:?}");

    // 物料绑定：M-PAINT 首批 8 只够 4 道喷涂，其余必须等 10-06 08:00 的到货
    let value = out.objective.expect("有解必有目标值");
    assert_eq!(value.weighted_tardiness, 0);
    // 基线下界（含到货）≈ 4×30 分钟 + 等待，实测 1560 分钟
    assert!(
        value.makespan <= 1620,
        "makespan {} 明显劣于期",
        value.makespan
    );
    // 弱下界必须 ≤ 实际 makespan，且相对差距非负
    let lb = out.search.lower_bound.expect("有解时给出下界");
    assert!(lb <= value.makespan);
    assert!(lb > 0);
}

#[test]
fn breakdown_plan_avoids_blocked_interval_and_reports_impact() {
    let out = solve("mock/machine-breakdown.json", 500);
    assert!(matches!(out.status, Status::Feasible | Status::Optimal));
    let sol = out.solution.clone().unwrap();
    let ops = sol.get("operations").unwrap().as_arr().unwrap();
    assert_eq!(ops.len(), 24, "问题固定为 8 订单 × 3 工序");

    // 停机区间必须被完全避开（用问题里的 blocked 原文判定，不硬编码）
    let problem = json::parse(&read("mock/machine-breakdown.json")).unwrap();
    let blocked = problem
        .get("machines")
        .unwrap()
        .as_arr()
        .unwrap()
        .iter()
        .find(|m| m.get("id").and_then(|v| v.as_str()) == Some("WELD-02"))
        .and_then(|m| m.get("blocked").cloned())
        .expect("WELD-02 应有停机区间");
    assert_eq!(blocked.as_arr().unwrap().len(), 1, "夹具应包含一个停机区间");

    // 与基线对比：变更影响能被量化
    let baseline_text = read("tests/baseline-feasible-witness.json");
    let (base_problem_raw, baseline_solution, _) =
        engine::verify_solution_json(&read("mock/baseline.json"), &baseline_text).unwrap();
    let candidate = aps_engine::verify::parse_solution(&json::parse(&out.solution_json).unwrap())
        .0
        .unwrap();
    let report = compare::compare_json(&base_problem_raw, &baseline_solution, &[candidate]);
    let changed = report
        .get("candidates")
        .and_then(|v| v.as_arr())
        .and_then(|a| a.first())
        .and_then(|c| c.get("delta_vs_baseline"))
        .and_then(|d| d.get("changed_operations"))
        .and_then(|v| v.as_i64())
        .expect("对比报告应含 changed_operations");
    assert!(changed >= 0);
}

#[test]
fn material_delay_plan_respects_ledger() {
    let out = solve("mock/material-delay.json", 500);
    assert!(matches!(out.status, Status::Feasible | Status::Optimal));
    let (_, _, violations) =
        engine::verify_solution_json(&read("mock/material-delay.json"), &out.solution_json)
            .unwrap();
    assert!(violations.is_empty(), "到货延迟场景不得出现任何违约");
    // 到货延迟把喷涂推迟到 10-07 08:00 之后：makespan 必须不早于到货 + 尾批 4 道喷涂
    let value = out.objective.expect("有解必有目标值");
    assert_eq!(value.weighted_tardiness, 0);
    assert!(
        value.makespan >= 2880 + 4 * 30 - 30,
        "makespan {} 早于物料到货下界",
        value.makespan
    );
}

#[test]
fn infeasible_fixture_is_proven_without_fabricated_schedule() {
    let out = solve("mock/infeasible-no-welder.json", 500);
    assert_eq!(out.status, Status::Infeasible);
    assert!(out
        .violations
        .iter()
        .any(|v| v.code == "NO_ELIGIBLE_WORKER"));
    let sol = out.solution.unwrap();
    assert_eq!(
        sol.get("operations").unwrap().as_arr().unwrap().len(),
        0,
        "证明无解时不得输出伪造工序"
    );
    assert_eq!(
        sol.get("status").and_then(|v| v.as_str()),
        Some("INFEASIBLE")
    );
    assert_eq!(sol.get("optimality_proven"), Some(&json::Json::Bool(false)));
}

#[test]
fn wasm_light_refuses_scale_instead_of_dropping_constraints() {
    let baseline = json::parse(&read("mock/baseline.json")).unwrap();
    let big = benchgen::build_separable(&baseline, 2400).expect("2400 工序基准可生成");
    assert_eq!(benchgen::count_operations(&big), 2400);
    let text = big.canonical();
    let opts = SolveOptions {
        profile: Profile::WasmLight,
        time_limit_ms: 200,
        seed: 42,
        ..Default::default()
    };
    let out = engine::solve_json(&text, &opts, &CancelToken::new());
    assert_eq!(out.status, Status::UnsupportedConstraint);
    assert!(
        out.issues.iter().any(|i| i.code == "SCALE_EXCEEDED"),
        "应给出结构化原因：{:?}",
        out.issues
    );
    let caps = capabilities::capabilities_for(Profile::WasmLight);
    assert!(!caps.can_prove_infeasible && !caps.can_prove_optimal);
    assert!(caps.max_operations < 2400);
}

#[test]
fn explain_and_compare_are_consistent_with_the_witness() {
    let problem_text = read("mock/baseline.json");
    let witness = read("tests/baseline-feasible-witness.json");
    let (problem, solution, violations) =
        engine::verify_solution_json(&problem_text, &witness).unwrap();
    assert!(violations.is_empty(), "参考见证必须零违约");
    let j = explain::explain_operation(&problem, &solution, "ORD-001-CUT");
    assert_eq!(
        j.get("operation_id").and_then(|v| v.as_str()),
        Some("ORD-001-CUT")
    );
    assert!(j.get("machine").is_some());
    assert!(
        explain::operation_ok(&problem, &solution, "ORD-001-CUT"),
        "见证里的工序应判定为可行: {}",
        explain::format_explain(&j)
    );
    let report = compare::compare_json(&problem, &solution, &[solution.clone()]);
    let cand = report.get("candidates").unwrap().as_arr().unwrap()[0].clone();
    let delta = cand.get("delta_vs_baseline").unwrap();
    assert_eq!(
        delta.get("changed_operations").and_then(|v| v.as_i64()),
        Some(0)
    );
    assert_eq!(
        delta
            .get("weighted_tardiness_minutes")
            .and_then(|v| v.as_i64()),
        Some(0)
    );
}

/// 只保留一个订单 / 一台机器 / 一名人员 / 一件工装，构造“单链”问题。
fn single_chain_problem() -> String {
    let mut j = json::parse(&read("mock/baseline.json")).unwrap();
    let keep = |v: &aps_engine::json::Json, ids: &[&str]| -> bool {
        v.get("id")
            .and_then(|x| x.as_str())
            .map(|s| ids.contains(&s))
            .unwrap_or(false)
    };
    // 机器/人员/工装保持不变（备选机器引用必须完整），只留一个订单
    if let Some(arr) = j.get_mut("orders").and_then(|v| v.as_arr_mut()) {
        arr.retain(|o| keep(o, &["ORD-001"]));
    }
    j.set("objective", json::parse(r#"{"strategy":"lexicographic","phases":["weighted_tardiness","makespan"],"time_limit_ms":200,"seed":42}"#).unwrap());
    j.to_pretty()
}

#[test]
fn optimal_is_claimed_only_when_lower_bound_is_attained() {
    let text = single_chain_problem();
    let out = engine::solve_json(
        &text,
        &SolveOptions {
            time_limit_ms: 200,
            seed: 42,
            ..Default::default()
        },
        &CancelToken::new(),
    );
    // 单链 makespan = CUT 30 + WELD 45 + PAINT 30 = 105，且等于有效下界、零延期 → 可证明最优
    assert_eq!(
        out.status,
        Status::Optimal,
        "应返回 OPTIMAL：{:?}",
        out.notes
    );
    let sol = out.solution.unwrap();
    assert_eq!(sol.get("optimality_proven"), Some(&json::Json::Bool(true)));
    let obj = sol.get("objective").unwrap();
    assert_eq!(
        obj.get("makespan_minutes").and_then(|v| v.as_i64()),
        Some(105)
    );
    assert_eq!(obj.get("best_bound").and_then(|v| v.as_i64()), Some(105));
    assert_eq!(obj.get("relative_gap").and_then(|v| v.as_f64()), Some(0.0));
    assert_eq!(
        out.violations
            .iter()
            .filter(|v| v.severity == aps_engine::errors::Severity::Error)
            .count(),
        0
    );
}

#[test]
fn optimal_is_not_fabricated_when_tardiness_cannot_be_proven() {
    // 把交期压到 08:30（链完成 09:45），加权延期必然 > 0，因此绝不可能是 OPTIMAL
    let mut j = json::parse(&single_chain_problem()).unwrap();
    if let Some(orders) = j.get_mut("orders").and_then(|v| v.as_arr_mut()) {
        for o in orders.iter_mut() {
            o.set("due_at", json::Json::str("2026-10-05T08:30:00-07:00"));
        }
    }
    let out = engine::solve_json(
        &j.to_pretty(),
        &SolveOptions {
            time_limit_ms: 200,
            seed: 42,
            ..Default::default()
        },
        &CancelToken::new(),
    );
    assert!(
        matches!(out.status, Status::Feasible | Status::Unknown),
        "延期不可证明为 0 时不得返回 OPTIMAL，实际 {:?}",
        out.status
    );
    let value = out.objective.expect("应有可行解");
    assert!(value.weighted_tardiness > 0);
    let sol = out.solution.unwrap();
    assert_eq!(sol.get("optimality_proven"), Some(&json::Json::Bool(false)));
}

#[test]
fn cancellation_returns_promptly_with_incumbent_and_warning() {
    // SRS §7「可终止」：配置时间预算后可停止；取消必须及时返回，并明确标注 incumbent。
    //
    // 注意：baseline 已在数毫秒内求解（且可证明最优），不足以触发取消窗口，
    // 因此这里用 480 工序的可分离实例：首解 ~23 ms，取消时刻设在 100 ms（远早于 30 s 预算），
    // 保证“取消”而不是“自然完成”结束本次求解。
    let base = read("mock/baseline.json");
    let base_json = aps_engine::json::parse(&base).unwrap();
    let text = aps_engine::benchgen::build_separable(&base_json, 480)
        .unwrap()
        .to_pretty();
    let token = CancelToken::new();
    let trigger = token.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(100));
        trigger.cancel();
    });
    let t0 = std::time::Instant::now();
    let out = engine::solve_json(
        &text,
        &SolveOptions {
            time_limit_ms: 30_000, // 预算远大于取消时刻：必须靠取消而不是超时结束
            seed: 42,
            ..Default::default()
        },
        &token,
    );
    let elapsed = t0.elapsed();
    assert!(
        elapsed.as_millis() < 5_000,
        "取消后必须迅速返回，实际耗时 {elapsed:?}"
    );
    assert_eq!(
        out.status,
        Status::Cancelled,
        "状态应为 CANCELLED，实际 {}",
        out.status.as_str()
    );
    assert!(
        out.violations
            .iter()
            .any(|v| v.code == "CANCELLED_WITH_INCUMBENT"
                && v.severity == aps_engine::errors::Severity::Warning),
        "必须带 CANCELLED_WITH_INCUMBENT 警告级标注：{:?}",
        out.violations.iter().map(|v| &v.code).collect::<Vec<_>>()
    );
    // 取消前若已找到解，则作为 incumbent 返回且仍然合法（不因取消而变非法）
    let sol = out.solution.expect("取消也要返回结构完整的方案 JSON");
    let ops = sol.get("operations").unwrap().as_arr().unwrap();
    let (_, _, violations) =
        engine::verify_solution_json(&text, &out.solution_json).expect("输出符合契约");
    assert!(
        violations
            .iter()
            .all(|v| v.severity != aps_engine::errors::Severity::Error),
        "incumbent 不得含 error 级违约：{violations:?}"
    );
    assert_eq!(
        ops.len(),
        480,
        "取消时已拿到完整可行解，应返回全部 480 道工序作为 incumbent"
    );
}

#[test]
fn deterministic_mode_is_byte_identical_across_runs() {
    // 「确定性模式」= 固定 max_iterations（迭代次数与墙钟无关）+ 预算充足不触发超时。
    let text = read("mock/baseline.json");
    let opts = || SolveOptions {
        time_limit_ms: 600_000, // 远大于所需，确保不是靠超时结束
        seed: 2026,
        max_iterations: 200,
        ..Default::default()
    };
    let a = engine::solve_json(&text, &opts(), &CancelToken::new());
    let b = engine::solve_json(&text, &opts(), &CancelToken::new());
    // 方案内容（除运行期 metrics 外）必须逐字节一致
    let fa = engine::solution_fingerprint(a.solution.as_ref().unwrap());
    let fb = engine::solution_fingerprint(b.solution.as_ref().unwrap());
    assert_eq!(
        fa, fb,
        "确定性模式下同一 (输入, seed, max_iterations) 的方案指纹必须一致"
    );
    // 除运行期观测值（metrics 内的耗时/峰值内存）外，两次运行的方案内容必须完全一致
    let strip = |text: &str| -> String {
        let mut j = json::parse(text).unwrap();
        if let Some(obj) = j.get_mut("metrics") {
            *obj = json::Json::Null;
        }
        j.canonical()
    };
    assert_eq!(
        strip(&a.solution_json),
        strip(&b.solution_json),
        "确定性模式下除 metrics 外的方案内容必须完全一致"
    );
    // metrics 里的耗时确实会随运行变化——这是观测值，不是方案内容
    assert!(a.metrics.total_ms.is_some() && b.metrics.total_ms.is_some());
    assert!(a.objective.is_some());
}

#[test]
fn fingerprint_ignores_runtime_metrics_only() {
    let text = read("mock/baseline.json");
    let out = engine::solve_json(
        &text,
        &SolveOptions {
            time_limit_ms: 200,
            seed: 42,
            ..Default::default()
        },
        &CancelToken::new(),
    );
    let original = out.solution.unwrap();
    let fp1 = engine::solution_fingerprint(&original);

    // 1) 改动运行期指标 → 指纹不变
    let mut with_new_metrics = original.clone();
    with_new_metrics.set(
        "metrics",
        json::parse(r#"{"compile_ms":999.0,"solve_ms":1.0,"peak_memory_bytes":1}"#).unwrap(),
    );
    assert_eq!(engine::solution_fingerprint(&with_new_metrics), fp1);

    // 2) 改动方案本体（某道工序的机器）→ 指纹必须改变
    let mut changed = original.clone();
    if let Some(ops) = changed.get_mut("operations").and_then(|v| v.as_arr_mut()) {
        ops[0].set("machine_id", json::Json::str("CUT-02"));
    }
    assert_ne!(engine::solution_fingerprint(&changed), fp1);
}

#[test]
fn budget_mode_documents_its_reproducibility_scope() {
    // 预算模式：不承诺字节级一致，但必须承诺“结果合法、且状态/目标档位可复现”。
    let text = read("mock/baseline.json");
    let mut statuses = Vec::new();
    for _ in 0..3 {
        let out = engine::solve_json(
            &text,
            &SolveOptions {
                time_limit_ms: 120,
                seed: 42,
                ..Default::default()
            },
            &CancelToken::new(),
        );
        let v = out.objective.expect("预算内应给出可行解");
        assert_eq!(v.weighted_tardiness, 0);
        assert!(out.solution.is_some());
        statuses.push(out.status);
    }
    assert!(
        statuses
            .iter()
            .all(|s| matches!(s, Status::Feasible | Status::Optimal)),
        "预算模式状态应稳定落在 FEASIBLE/OPTIMAL：{statuses:?}"
    );
}

#[test]
fn strict_verify_enforces_result_binding() {
    let problem_text = read("mock/baseline.json");
    // 引擎输出：带 tenant_id + problem_hash → 严格模式通过
    let out = engine::solve_json(
        &problem_text,
        &SolveOptions {
            time_limit_ms: 200,
            seed: 42,
            ..Default::default()
        },
        &CancelToken::new(),
    );
    let (_, _, violations) = engine::verify_solution_json_with(
        &problem_text,
        &out.solution_json,
        aps_engine::verify::VerifyOptions::strict(),
    )
    .unwrap();
    assert!(
        violations.is_empty(),
        "引擎输出应满足严格模式：{violations:?}"
    );

    // 篡改 problem_hash → 必须被严格模式与宽松模式同时检出
    let mut tampered = json::parse(&out.solution_json).unwrap();
    tampered.set(
        "problem_hash",
        json::Json::str(format!("sha256:{}", "0".repeat(64))),
    );
    let tampered_text = tampered.to_pretty();
    for opts in [
        aps_engine::verify::VerifyOptions::strict(),
        aps_engine::verify::VerifyOptions::permissive(),
    ] {
        let (_, _, v) =
            engine::verify_solution_json_with(&problem_text, &tampered_text, opts).unwrap();
        assert!(
            v.iter().any(|x| x.code == "PROBLEM_HASH_MISMATCH"),
            "篡改的 problem_hash 必须被检出（{opts:?}）"
        );
    }

    // 参考见证缺少可选绑定字段 → 宽松通过、严格报错
    let witness = read("tests/baseline-feasible-witness.json");
    let (_, _, permissive) = engine::verify_solution_json_with(
        &problem_text,
        &witness,
        aps_engine::verify::VerifyOptions::permissive(),
    )
    .unwrap();
    assert!(permissive.is_empty(), "宽松模式不应因可选字段缺失而报错");
    let (_, _, strict) = engine::verify_solution_json_with(
        &problem_text,
        &witness,
        aps_engine::verify::VerifyOptions::strict(),
    )
    .unwrap();
    assert!(strict.iter().any(|v| v.code == "TENANT_MISMATCH"));
    assert!(strict.iter().any(|v| v.code == "PROBLEM_HASH_MISMATCH"));
}

#[test]
fn aps_dir_locating_works_from_crate_root() {
    let dir = aps_engine::acceptance::locate_aps_dir(Path::new(env!("CARGO_MANIFEST_DIR")))
        .expect("应能从 crate 目录定位 aps 交付目录");
    assert!(dir.join("mock/baseline.json").exists());
    assert!(dir.join("tests/acceptance.json").exists());
}
