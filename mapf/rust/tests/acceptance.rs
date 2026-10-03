//! `cargo test --test acceptance`：M01–M12 端到端验收（与 CLI `mapf acceptance` 同源，
//! 逻辑在 `mapf_engine::acceptance`，本文件只负责“必须全绿”的 CI 断言）。

#[test]
fn m01_m12_all_pass() {
    let results = mapf_engine::acceptance::run_all();
    let mut failures = String::new();
    for r in &results {
        for mapf_engine::acceptance::Check(msg, ok) in &r.checks {
            if !*ok {
                failures.push_str(&format!("{}: {msg}\n", r.id));
            }
        }
    }
    assert_eq!(
        results.iter().filter(|r| !r.ok()).count(),
        0,
        "未通过的验收检查：\n{failures}"
    );
    assert_eq!(
        results.len(),
        14,
        "M01..M12（含 M07b/M08a/M08b）共 14 个案例"
    );
}

#[test]
fn report_generation_smoke() {
    let results = mapf_engine::acceptance::run_all();
    let md = mapf_engine::acceptance::markdown_table(&results);
    assert!(md.contains("| 案例 |"));
    let json = mapf_engine::acceptance::to_json(&results);
    assert!(json.to_compact().contains("\"M01\""));
}
