//! 端到端集成测试：生成 → 求解 → 独立核验 → 契约语义。
//!
//! 为什么要有这一层（而不是只靠 `acceptance` 的 86 个场景）：
//! `acceptance` 是"业务判据"（现象、规模、可复现），跑一次要分钟级；这里守的是
//! **接口契约本身**（状态语义、信封结构、核验入口、不支持取值的处理），几十毫秒就能跑完，
//! 适合放进 CI 的快速门。两者不重复：一个守业务，一个守接口。
//!
//! 全部断言都只用公开 API（CLI / wasm / 实验室共用同一批入口），
//! 不触碰求解器内部结构，避免"测试和实现一起改"导致契约漂移无人发现。

use aps_engine::json::Json;
use warehouse_engine::engine;
use warehouse_engine::errors::{Issues, Status};
use warehouse_engine::scenario;

fn build(scenario_id: &str, scale: &str) -> Json {
    let mut issues = Issues::new();
    let document = scenario::build(scenario_id, Some(scale), Some(7), &mut issues);
    assert!(
        !issues.has_errors(),
        "生成 {scenario_id}/{scale} 报出问题：{}",
        issues.to_json().canonical()
    );
    document
}

fn solve(document: &Json, options: Option<&str>) -> (Json, Status) {
    let text = document.canonical();
    let (envelope_text, status) = engine::solve_slotting(&text, options);
    let parsed = aps_engine::json::parse(&envelope_text).expect("求解输出必须是合法 JSON");
    (parsed, status)
}

fn field_str(value: &Json, key: &str) -> String {
    value
        .get(key)
        .and_then(|entry| entry.as_str())
        .unwrap_or("")
        .to_string()
}

fn field_f64(value: &Json, key: &str) -> Option<f64> {
    value.get(key).and_then(|entry| match entry {
        Json::Float(v) => Some(*v),
        Json::Int(v) => Some(*v as f64),
        _ => None,
    })
}

#[test]
fn status_codes_match_wasm_abi_and_docs() {
    // 状态码必须与 `web/warehouse-worker.js` 的 STATUS 表、契约枚举、`codes` 子命令一致。
    assert_eq!(Status::OptimalProven.code(), 1);
    assert_eq!(Status::FeasibleWithBound.code(), 2);
    assert_eq!(Status::Feasible.code(), 3);
    assert_eq!(Status::BudgetExceeded.code(), 4);
    assert_eq!(Status::NoSolutionFound.code(), 5);
    assert_eq!(Status::InfeasibleProven.code(), 6);
    assert_eq!(Status::Cancelled.code(), 7);
    assert_eq!(Status::InvalidInput.code(), 8);
    assert_eq!(Status::Unsupported.code(), 9);
    assert_eq!(Status::InternalError.code(), 10);
    assert_eq!(Status::Feasible.as_str(), "FEASIBLE");
    // “有解”状态族：预算耗尽且无解 / 未找到解 / 不可行 都不在内。
    assert!(Status::Feasible.has_solution());
    assert!(Status::Cancelled.has_solution());
    assert!(!Status::BudgetExceeded.has_solution());
    assert!(!Status::NoSolutionFound.has_solution());
    assert!(!Status::InfeasibleProven.has_solution());
}

#[test]
fn invalid_input_returns_structured_issues() {
    let (envelope, status) = engine::solve_slotting("{\"kind\":\"slotting\"}", None).pipe_parse();
    assert_eq!(status, Status::InvalidInput);
    assert_eq!(field_str(&envelope, "status"), "INVALID_INPUT");
    let issues = envelope
        .get("issues")
        .and_then(|value| match value {
            Json::Arr(list) => Some(list.len()),
            _ => None,
        })
        .unwrap_or(0);
    assert!(issues > 0, "缺必填字段必须给出字段级 issues[]");
}

#[test]
fn slotting_tiny_end_to_end_and_independent_verification() {
    let document = build("S01", "tiny");
    let (envelope, status) = solve(&document, None);
    assert!(
        status.has_solution(),
        "S01/tiny 应产出可用方案，实际 {}",
        status.as_str()
    );
    assert_eq!(field_str(&envelope, "engine"), "rust-warehouse");
    assert_eq!(field_str(&envelope, "status"), status.as_str());
    assert!(
        !field_str(&envelope, "fingerprint").is_empty(),
        "结果必须带 fingerprint（可复现口径）"
    );

    let result = envelope.get("result").cloned().unwrap_or(Json::Null);
    assert_eq!(field_str(&result, "kind"), "slotting");
    assert!(
        result.get("assignment").is_some(),
        "库位优化结果必须带 assignment"
    );

    // 内嵌核验（默认开启）：只要是有解状态族，就必须给出 ok=true。
    let verification = envelope.get("verification").cloned().unwrap_or(Json::Null);
    assert_eq!(
        verification.get("ok").and_then(|value| value.as_bool()),
        Some(true),
        "有解时必须内嵌核验通过"
    );

    // 独立核验入口：只吃契约文档（问题 + 方案），不接受求解信封。
    let verify_document = Json::obj(vec![
        ("kind", Json::str("slotting")),
        (
            "problem",
            document.get("problem").cloned().unwrap_or(Json::Null),
        ),
        ("solution", result),
    ]);
    let (report_text, verify_status) = engine::verify(&verify_document.canonical(), None);
    assert_eq!(verify_status, Status::Feasible, "核验入口应报告可行");
    let report = aps_engine::json::parse(&report_text).expect("核验报告必须是合法 JSON");
    assert_eq!(
        report.get("ok").and_then(|value| value.as_bool()),
        Some(true),
        "干净方案的独立核验必须通过：{report_text}"
    );
}

#[test]
fn asrs_tiny_produces_replayable_timeline() {
    let document = build("D01", "tiny");
    let (envelope_text, status) = engine::solve_asrs(&document.canonical(), None);
    assert_eq!(status, Status::Feasible, "{envelope_text}");
    let envelope = aps_engine::json::parse(&envelope_text).expect("求解输出必须是合法 JSON");

    let result = envelope.get("result").cloned().unwrap_or(Json::Null);
    assert_eq!(field_str(&result, "kind"), "asrs");
    let devices = envelope
        .get("timeline")
        .and_then(|timeline| timeline.get("devices"))
        .and_then(|value| match value {
            Json::Arr(list) => Some(list.len()),
            _ => None,
        })
        .unwrap_or(0);
    assert!(devices > 0, "时间线必须含设备轨迹（回放与逐步核验的前提）");

    let verification = envelope.get("verification").cloned().unwrap_or(Json::Null);
    assert_eq!(
        verification.get("ok").and_then(|value| value.as_bool()),
        Some(true),
        "调度解必须通过独立核验"
    );

    // 方案里的 servicePlan 是逐设备汇总；明细只出现一次（timeline 里），避免两套数打架。
    let plan_devices = result
        .get("servicePlan")
        .and_then(|plan| plan.get("devices"))
        .and_then(|value| match value {
            Json::Arr(list) => Some(list.len()),
            _ => None,
        })
        .unwrap_or(0);
    assert!(
        plan_devices > 0,
        "servicePlan.devices 应给出每台设备的作业量"
    );
}

#[test]
fn unsupported_policy_values_are_rejected_not_ignored() {
    // 引擎只实现 reservation 时空预约；给出别的策略必须显式 UNSUPPORTED 并指出字段路径，
    // 不能静默按默认策略求解（否则“我配了 yield”就是一句空话）。
    let document = build("D01", "tiny");
    let (envelope_text, status) = engine::solve_asrs(
        &document.canonical(),
        Some("{\"conflictPolicy\":\"yield\"}"),
    );
    assert_eq!(status, Status::Unsupported);
    let envelope = aps_engine::json::parse(&envelope_text).expect("必须返回结构化信封");
    assert_eq!(field_str(&envelope, "status"), "UNSUPPORTED");
    let issues_text = envelope
        .get("issues")
        .map(|value| value.canonical())
        .unwrap_or_default();
    assert!(
        issues_text.contains("conflictPolicy"),
        "问题定位必须出现在 issues[]：{issues_text}"
    );
}

#[test]
fn same_seed_is_bit_reproducible() {
    let document = build("S01", "tiny");
    let (first, first_status) = solve(&document, Some("{\"seed\":7,\"budgetMs\":400}"));
    let (second, second_status) = solve(&document, Some("{\"seed\":7,\"budgetMs\":400}"));
    assert!(first_status.has_solution() && second_status.has_solution());
    assert_eq!(
        field_str(&first, "fingerprint"),
        field_str(&second, "fingerprint"),
        "同输入 + 同种子 + 同版本 ⇒ fingerprint 必须一致"
    );
    let a = field_f64(&first, "objective").unwrap_or(0.0);
    let b = field_f64(&second, "objective").unwrap_or(0.0);
    assert!(
        (a - b).abs() < 1e-9,
        "同种子重跑目标值差必须 < 1e-9（实际 {a} vs {b}）"
    );
}

#[test]
fn scale_table_covers_srs_range_and_rejects_typos() {
    // 未知档位必须查不到：CLI 层据此报 VALUE_RANGE，而不是静默回退小规模。
    assert!(scenario::find_scale("sterss").is_none());
    assert!(scenario::find_scale("").is_none());
    assert!(scenario::scale_keys().contains(&"stress"));

    let stress = scenario::find_scale("stress").expect("压力档必须存在");
    assert_eq!(stress.skus, 150_000, "压力档要覆盖需求 §8 的 150k SKU 下界");
    // 90 巷道 × 12 层 × 220 列 × 4 深 × 2 侧 = 1 900 800 个库位（500k–2M 区间内）
    assert_eq!(
        stress.aisles * stress.levels * stress.bays * stress.depths * 2,
        1_900_800
    );
    assert_eq!(
        scenario::find_scale("extreme").map(|scale| scale.skus),
        Some(60_000)
    );
}

#[test]
fn slotting_result_carries_affinity_clusters() {
    // 三维的「关联簇叠加」与解释里的"N 个簇"必须读同一份引擎输出，
    // 因此库位解必须带 clusters 块（前端不做二次聚类）。
    let document = build("S01", "tiny");
    let (envelope, status) = solve(&document, None);
    assert!(status.has_solution(), "实际 {}", status.as_str());
    let result = envelope.get("result").cloned().unwrap_or(Json::Null);
    let clusters = result.get("clusters").cloned().unwrap_or(Json::Null);
    assert!(
        matches!(clusters, Json::Obj(_)),
        "库位解必须带 clusters 块：{clusters:?}"
    );
    let count = clusters
        .get("count")
        .and_then(|value| match value {
            Json::Int(v) => Some(*v),
            _ => None,
        })
        .unwrap_or(-1);
    assert!(count >= 0, "clusters.count 必须是非负整数，实际 {count}");
    assert!(
        matches!(clusters.get("bySku"), Some(Json::Obj(_))),
        "clusters.bySku 必须是对象（skuId → 簇号，-1 = 未成簇）"
    );
}

#[test]
fn joint_verification_covers_both_halves() {
    // 联合结论只有在"库位段 + 调度段都通过独立核验"时才允许为真，
    // 且信封里的报告形状与 CLI `verify` 的 joint 分支一致。
    let document = build("J01", "tiny");
    let (envelope_text, status) = engine::solve_joint(&document.canonical(), None);
    assert!(status.has_solution(), "{envelope_text}");
    let envelope = aps_engine::json::parse(&envelope_text).expect("求解输出必须是合法 JSON");
    let verification = envelope.get("verification").cloned().unwrap_or(Json::Null);
    assert_eq!(
        field_str(&verification, "kind"),
        "joint",
        "联合核验必须是 joint 报告（覆盖两段）：{verification:?}"
    );
    assert_eq!(
        verification.get("ok").and_then(|value| value.as_bool()),
        Some(true),
        "干净解的联合核验必须通过：{verification:?}"
    );
    // 两段的独立重算指标都要在报告里（没有独立指标的"核验"等于没核验）。
    let recomputed = verification
        .get("recomputed")
        .cloned()
        .unwrap_or(Json::Null);
    assert!(
        matches!(recomputed.get("slotting"), Some(Json::Obj(_)))
            && matches!(recomputed.get("asrs"), Some(Json::Obj(_))),
        "recomputed 必须分两段给出：{recomputed:?}"
    );
}

/// 小工具：把 `(String, Status)` 变成 `(Json, Status)`，避免每处都写解析样板。
trait PipeParse {
    fn pipe_parse(self) -> (Json, Status);
}

impl PipeParse for (String, Status) {
    fn pipe_parse(self) -> (Json, Status) {
        let (text, status) = self;
        let parsed = aps_engine::json::parse(&text).expect("引擎输出必须是合法 JSON");
        (parsed, status)
    }
}
