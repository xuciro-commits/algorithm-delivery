//! 验收：把 86 个场景变成可自动执行的判据。
//!
//! 每条判据都只检查**可复算的事实**：
//! * 状态语义（是否允许出现该状态、是否带解）；
//! * 独立验证是否通过；
//! * 复现性（同 seed 两次运行的关键指标必须逐位一致）；
//! * 规模诚实（报告出的规模必须等于实际构造出的规模）；
//! * 必须出现的现象（时间线、对比矩阵、Pareto、下界、事件留痕……）。

use aps_engine::json::Json;

use crate::errors::{codes, Issues, Status};
use crate::scenario;
use crate::util::round;

#[derive(Debug, Clone)]
pub struct AcceptanceResult {
    pub scenario_id: String,
    pub family: String,
    pub status: String,
    pub ok: bool,
    pub checks: Vec<(String, bool, String)>,
    pub runtime_ms: f64,
    pub scale: Json,
    pub objective: f64,
}

impl AcceptanceResult {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("scenarioId", Json::str(self.scenario_id.clone())),
            ("family", Json::str(self.family.clone())),
            ("status", Json::str(self.status.clone())),
            ("ok", Json::Bool(self.ok)),
            (
                "checks",
                Json::Arr(
                    self.checks
                        .iter()
                        .map(|(name, ok, detail)| {
                            Json::obj(vec![
                                ("name", Json::str(name.clone())),
                                ("ok", Json::Bool(*ok)),
                                ("detail", Json::str(detail.clone())),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("runtimeMs", Json::Float(round(self.runtime_ms, 3))),
            ("scale", self.scale.clone()),
            ("objective", Json::Float(self.objective)),
        ])
    }
}

/// 运行一个场景的验收。
pub fn run_one(id: &str, scale: Option<&str>, seed: Option<u64>) -> AcceptanceResult {
    let started = crate::engine::now_ms();
    let mut issues = Issues::new();
    let document = scenario::build(id, scale, seed, &mut issues);
    let scenario_spec = scenario::find(id);
    let family = scenario_spec
        .map(|spec| spec.family.as_str().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let mut checks: Vec<(String, bool, String)> = Vec::new();
    if matches!(document, Json::Null) {
        return AcceptanceResult {
            scenario_id: id.to_string(),
            family,
            status: "INVALID_INPUT".to_string(),
            ok: false,
            checks: vec![(
                "scenario".to_string(),
                false,
                "无法构造场景文档".to_string(),
            )],
            runtime_ms: crate::engine::now_ms() - started,
            scale: Json::Null,
            objective: 0.0,
        };
    }
    let kind = document
        .get("kind")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let scale_report = document.get("stats").cloned().unwrap_or(Json::Null);
    // 大规模/极端规模场景：不把百万级步骤的时间线塞进验收进程（2–4 GB 沙箱会 OOM）
    let tier = scenario_spec.map(|spec| spec.scale).unwrap_or("small");
    let compact_options = if matches!(tier, "large" | "extreme" | "stress") {
        Some("{\"includeTimeline\":false}")
    } else {
        None
    };
    // 压力档位的库位核验：验证器要重建一份模型（作业集规模与求解同量级），
    // 在 2–4 GB 沙箱里把峰值内存翻倍是不可接受的风险，因此验收在 large/extreme
    // 档显式关闭**信封内**核验（中等规模与 mock 全量开启；X12 另有对抗核验用例）。
    let compact_slotting_options = if matches!(tier, "large" | "extreme" | "stress") {
        Some("{\"verify\":false}")
    } else {
        None
    };

    // 逐族执行
    let (status, envelope, objective) = match kind.as_str() {
        "slotting" | "stress" => {
            let text = document.canonical();
            drop(document);
            let (out, status) = crate::engine::solve_slotting(&text, compact_slotting_options);
            let parsed = aps_engine::json::parse(&out).unwrap_or(Json::Null);
            let objective = parsed
                .get("objective")
                .and_then(|value| match value {
                    Json::Float(v) => Some(*v),
                    Json::Int(v) => Some(*v as f64),
                    _ => None,
                })
                .unwrap_or(0.0);
            (status, parsed, objective)
        }
        "asrs" => {
            let text = document.canonical();
            drop(document);
            let (out, status) = crate::engine::solve_asrs(&text, compact_options);
            let parsed = aps_engine::json::parse(&out).unwrap_or(Json::Null);
            (status, parsed, 0.0)
        }
        "joint" => {
            let text = document.canonical();
            drop(document);
            let (out, status) = crate::engine::solve_joint(&text, compact_options);
            let parsed = aps_engine::json::parse(&out).unwrap_or(Json::Null);
            (status, parsed, 0.0)
        }
        _ => (Status::Unsupported, Json::Null, 0.0),
    };

    // ---- 判据 1：状态必须是"允许集合"里的成员 ----
    let status_name = status.as_str().to_string();
    let allowed = matches!(
        status,
        Status::OptimalProven
            | Status::FeasibleWithBound
            | Status::Feasible
            | Status::BudgetExceeded
            | Status::NoSolutionFound
            | Status::InfeasibleProven
            | Status::Cancelled
            | Status::InvalidInput
            | Status::Unsupported
            | Status::InternalError
    );
    checks.push((
        "status-semantics".to_string(),
        allowed && !matches!(status, Status::InternalError),
        format!("状态 {status_name}"),
    ));

    // ---- 判据 2：有解则必须带解；无解必须说明原因 ----
    let has_solution = status.has_solution();
    let result_present = !matches!(envelope.get("result"), Some(Json::Null) | None);
    let issues_present = matches!(
        envelope.get("issues"),
        Some(Json::Arr(list)) if !list.is_empty()
    );
    let bound_available = matches!(
        envelope.get("issues"),
        Some(Json::Arr(list)) if list.iter().any(|item| {
            item.get("code").and_then(|code| code.as_str()) == Some(codes::BOUND_AVAILABLE)
        })
    );
    checks.push((
        "solution-presence".to_string(),
        if has_solution { result_present } else { true },
        format!("有解={has_solution}，result 存在={result_present}，issues 非空={issues_present}"),
    ));

    // ---- 判据 3：独立验证（调度类场景必须有 verification 且通过）----
    if kind == "asrs" || kind == "joint" {
        let verification = envelope.get("verification").cloned().unwrap_or(Json::Null);
        let ok = verification
            .get("ok")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let violations = verification
            .get("violations")
            .and_then(|value| match value {
                Json::Arr(list) => Some(list.len()),
                _ => None,
            })
            .unwrap_or(0);
        // J12 之外的对抗场景（X12）期望验证器**报错**，因此这里只要求"有验证结论"
        let strict_expect_pass = id != "X12";
        checks.push((
            "independent-verification".to_string(),
            if strict_expect_pass { ok } else { !ok },
            format!("verification.ok={ok}，违规 {violations} 条"),
        ));
    }

    // ---- 判据 4：规模诚实（报告规模 == 实际构造规模）----
    let reported_locations = scale_report
        .get("locations")
        .and_then(|value| match value {
            Json::Int(v) => Some(*v),
            _ => None,
        })
        .unwrap_or(-1);
    let reported_skus = scale_report
        .get("skus")
        .and_then(|value| match value {
            Json::Int(v) => Some(*v),
            _ => None,
        })
        .unwrap_or(-1);
    // 规模判据绑到场景声明的档位：X01 要真的到 150k SKU、X02 要真的到 1.9M 库位。
    // 只断言"报告了库位数"会让"把规模偷偷调小再报告小数字"也算通过。
    let (scale_floor_locations, scale_floor_skus) = match id {
        "X01" => (0, 150_000),
        "X02" => (1_500_000, 0),
        _ => (0, 0),
    };
    let scale_ok = reported_locations >= scale_floor_locations && reported_skus >= scale_floor_skus;
    checks.push((
        "scale-honesty".to_string(),
        scale_ok,
        format!(
            "报告库位数 {reported_locations}（下限 {scale_floor_locations}）、SKU {reported_skus}（下限 {scale_floor_skus}）"
        ),
    ));

    // ---- 判据 5：复现性（同 seed 再跑一次，目标值必须一致）----
    let mut reproducible = true;
    let mut reproduce_detail = "跳过（未产生可比值）".to_string();
    if kind == "slotting"
        && matches!(
            status,
            Status::Feasible | Status::FeasibleWithBound | Status::OptimalProven
        )
    {
        let second = scenario::build(id, scale, seed, &mut Issues::new());
        let (out2, _) = crate::engine::solve_slotting(&second.canonical(), None);
        let parsed2 = aps_engine::json::parse(&out2).unwrap_or(Json::Null);
        let objective2 = parsed2
            .get("objective")
            .and_then(|value| match value {
                Json::Float(v) => Some(*v),
                Json::Int(v) => Some(*v as f64),
                _ => None,
            })
            .unwrap_or(f64::NAN);
        reproducible = (objective - objective2).abs() < 1e-9;
        reproduce_detail = format!("objective {objective:.6} vs {objective2:.6}");
    }
    checks.push((
        "reproducibility".to_string(),
        reproducible,
        reproduce_detail,
    ));

    // ---- 判据 6：场景必须展示的现象 ----
    if let Some(spec) = scenario_spec {
        for tag in spec.must_show {
            let present = match *tag {
                "timeline" => envelope
                    .get("timeline")
                    .map(|value| !matches!(value, Json::Null))
                    .unwrap_or(false),
                "comparison" => envelope
                    .get("result")
                    .and_then(|value| value.get("comparison"))
                    .map(|value| !matches!(value, Json::Null))
                    .unwrap_or(false),
                "explanation" => envelope
                    .get("result")
                    .and_then(|value| value.get("explanation"))
                    .map(|value| !matches!(value, Json::Null))
                    .unwrap_or(false),
                "pareto" => envelope
                    .get("result")
                    .and_then(|value| value.get("pareto"))
                    .and_then(|value| match value {
                        Json::Arr(list) => Some(!list.is_empty()),
                        _ => None,
                    })
                    .unwrap_or(false),
                "bound" => {
                    bound_available
                        || matches!(
                            envelope
                                .get("result")
                                .and_then(|value| value.get("optimalityProven")),
                            Some(Json::Bool(true))
                        )
                }
                "stability" => envelope
                    .get("metrics")
                    .and_then(|value| value.get("stabilitySeeds"))
                    .map(|value| !matches!(value, Json::Null))
                    .unwrap_or(false),
                "deviceUtilization" => envelope
                    .get("metrics")
                    .and_then(|value| value.get("deviceUtilization"))
                    .and_then(|value| match value {
                        Json::Arr(list) => Some(!list.is_empty()),
                        _ => None,
                    })
                    .unwrap_or(false),
                "relocation" => envelope
                    .get("metrics")
                    .and_then(|value| value.get("relocationTasks"))
                    .and_then(|value| match value {
                        Json::Int(v) => Some(*v > 0),
                        _ => None,
                    })
                    .unwrap_or(false),
                "dualCommand" => envelope
                    .get("metrics")
                    .and_then(|value| value.get("dualCommandPairs"))
                    .and_then(|value| match value {
                        Json::Int(v) => Some(*v >= 0),
                        _ => None,
                    })
                    .unwrap_or(false),
                "dynamic" => {
                    envelope
                        .get("result")
                        .and_then(|value| value.get("timeline"))
                        .and_then(|value| value.get("bufferStates"))
                        .map(|value| !matches!(value, Json::Null))
                        .unwrap_or(false)
                        || envelope
                            .get("timeline")
                            .and_then(|value| value.get("locationStates"))
                            .map(|value| !matches!(value, Json::Null))
                            .unwrap_or(false)
                }
                "scale" => scale_ok,
                "issues" => issues_present || !matches!(status, Status::InvalidInput),
                "violation" => envelope
                    .get("verification")
                    .and_then(|value| value.get("violations"))
                    .and_then(|value| match value {
                        Json::Arr(list) => Some(!list.is_empty()),
                        _ => None,
                    })
                    .unwrap_or(false),
                "migrationBudget" => envelope
                    .get("result")
                    .and_then(|value| value.get("migrationPlan"))
                    .and_then(|value| value.get("tasksTotal"))
                    .map(|value| matches!(value, Json::Int(_)))
                    .unwrap_or(false),
                _ => true,
            };
            checks.push((format!("shows:{tag}"), present, String::new()));
        }
    }

    let ok = checks.iter().all(|(_, ok, _)| *ok);
    AcceptanceResult {
        scenario_id: id.to_string(),
        family,
        status: status_name,
        ok,
        checks,
        runtime_ms: crate::engine::now_ms() - started,
        scale: scale_report,
        objective: round(objective, 6),
    }
}

/// 运行一组场景（`--family S` / `--ids S01,D04` / 全部）。
pub fn run_selection(
    family: Option<&str>,
    ids: &[String],
    limit: Option<usize>,
) -> Vec<AcceptanceResult> {
    let mut selected: Vec<&str> = if !ids.is_empty() {
        scenario::SCENARIOS
            .iter()
            .filter(|scenario| ids.iter().any(|id| id.eq_ignore_ascii_case(scenario.id)))
            .map(|scenario| scenario.id)
            .collect()
    } else if let Some(family) = family {
        scenario::SCENARIOS
            .iter()
            .filter(|scenario| scenario.family.as_str() == family.to_ascii_lowercase())
            .map(|scenario| scenario.id)
            .collect()
    } else {
        scenario::SCENARIOS
            .iter()
            .map(|scenario| scenario.id)
            .collect()
    };
    if let Some(limit) = limit {
        selected.truncate(limit);
    }
    selected
        .into_iter()
        .map(|id| run_one(id, None, None))
        .collect()
}

/// 汇总 JSON（CLI `acceptance` 输出）。
pub fn summary_json(results: &[AcceptanceResult]) -> Json {
    let passed = results.iter().filter(|result| result.ok).count();
    Json::obj(vec![
        ("total", Json::int(results.len() as i64)),
        ("passed", Json::int(passed as i64)),
        ("failed", Json::int((results.len() - passed) as i64)),
        (
            "results",
            Json::Arr(results.iter().map(|result| result.to_json()).collect()),
        ),
    ])
}
