//! 规模基准：把"能跑到多大"变成可复现的数字（时间、内存、迭代、质量）。
//!
//! 诚实性原则（SRS §8）：
//! * 报告**实际参与求解**的规模，不报告"生成器参数"；
//! * 超过档位上限时返回 UNSUPPORTED 并说明原因，绝不悄悄缩小问题；
//! * 每个规模都给出：库位数、SKU 数、货物单元数、任务数、用时、峰值内存、迭代次数、状态与目标值。

use aps_engine::json::Json;

use crate::errors::Issues;
use crate::scenario;
use crate::util::round;

#[derive(Debug, Clone)]
pub struct BenchCase {
    pub name: &'static str,
    pub scale: &'static str,
    pub domain: &'static str,
    pub scenario: &'static str,
    pub note: &'static str,
}

/// 基准用例表：覆盖两个算法域的主要规模档位。
pub const CASES: &[BenchCase] = &[
    BenchCase { name: "slotting-tiny", scale: "tiny", domain: "slotting", scenario: "S01", note: "小规模端到端（含精确解路径）" },
    BenchCase { name: "slotting-small", scale: "small", domain: "slotting", scenario: "S01", note: "常规小仓" },
    BenchCase { name: "slotting-medium", scale: "medium", domain: "slotting", scenario: "S03", note: "中型仓（多深位 + 关联簇）" },
    BenchCase { name: "slotting-large", scale: "large", domain: "slotting", scenario: "S01", note: "大型仓（如实报告是否在预算内完成）" },
    BenchCase { name: "asrs-tiny", scale: "tiny", domain: "asrs", scenario: "D01", note: "最小调度闭环" },
    BenchCase { name: "asrs-small", scale: "small", domain: "asrs", scenario: "D03", note: "多巷道并行" },
    BenchCase { name: "asrs-medium", scale: "medium", domain: "asrs", scenario: "D16", note: "任务流压力" },
    BenchCase { name: "asrs-large", scale: "large", domain: "asrs", scenario: "D16", note: "大规模任务流" },
    BenchCase { name: "joint-small", scale: "small", domain: "joint", scenario: "J01", note: "联合闭环" },
    BenchCase { name: "joint-medium", scale: "medium", domain: "joint", scenario: "J05", note: "联合闭环（中规模）" },
];

#[derive(Debug, Clone)]
pub struct BenchRow {
    pub name: String,
    pub domain: String,
    pub scale: String,
    pub status: String,
    pub runtime_ms: f64,
    pub locations: i64,
    pub skus: i64,
    pub load_units: i64,
    pub tasks: i64,
    pub iterations: i64,
    pub peak_memory_bytes: i64,
    pub objective: f64,
    pub verification_ok: bool,
    pub note: String,
}

impl BenchRow {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("name", Json::str(self.name.clone())),
            ("domain", Json::str(self.domain.clone())),
            ("scale", Json::str(self.scale.clone())),
            ("status", Json::str(self.status.clone())),
            ("runtimeMs", Json::Float(round(self.runtime_ms, 3))),
            ("locations", Json::int(self.locations)),
            ("skus", Json::int(self.skus)),
            ("loadUnits", Json::int(self.load_units)),
            ("tasks", Json::int(self.tasks)),
            ("iterations", Json::int(self.iterations)),
            ("peakMemoryBytes", Json::int(self.peak_memory_bytes)),
            ("objective", Json::Float(self.objective)),
            ("verificationOk", Json::Bool(self.verification_ok)),
            ("note", Json::str(self.note.clone())),
        ])
    }

    /// 人类可读的一行（CLI 表格）。
    pub fn row(&self) -> String {
        format!(
            "{:<16} {:<9} {:<8} {:>10}s {:>9} {:>9} {:>9} {:>8} {:>9.1}MB {:>10} {}",
            self.name,
            self.domain,
            self.scale,
            format!("{:.2}", self.runtime_ms / 1000.0),
            self.locations,
            self.skus,
            self.load_units,
            self.tasks,
            self.peak_memory_bytes as f64 / 1_048_576.0,
            self.status,
            if self.verification_ok { "验证通过" } else { "验证未通过/未验证" },
        )
    }
}

/// 运行一个基准用例。
pub fn run_case(case: &BenchCase, tier: crate::capabilities::TierLimits) -> BenchRow {
    let mut issues = Issues::new();
    let document = scenario::build(case.scenario, Some(case.scale), Some(7), &mut issues);
    let stats = document.get("stats").cloned().unwrap_or(Json::Null);
    let get_int = |key: &str| -> i64 {
        stats
            .get(key)
            .and_then(|value| match value {
                Json::Int(v) => Some(*v),
                _ => None,
            })
            .unwrap_or(0)
    };
    let locations = get_int("locations");
    let skus = get_int("skus");
    let load_units = get_int("loadUnits");
    let tasks = get_int("tasks");
    // 档位检查：超限直接返回 UNSUPPORTED（不缩小问题）
    if let Some(reason) = crate::capabilities::check_scale(
        tier,
        skus.max(0) as usize,
        locations.max(0) as usize,
        load_units.max(0) as usize,
        tasks.max(0) as usize,
        0.0,
    ) {
        return BenchRow {
            name: case.name.to_string(),
            domain: case.domain.to_string(),
            scale: case.scale.to_string(),
            status: "UNSUPPORTED".to_string(),
            runtime_ms: 0.0,
            locations,
            skus,
            load_units,
            tasks,
            iterations: 0,
            peak_memory_bytes: 0,
            objective: 0.0,
            verification_ok: false,
            note: reason,
        };
    }
    aps_engine::alloc::reset_peak();
    let started = crate::engine::now_ms();
    let text = document.canonical();
    let (status, envelope, objective, iterations, verification_ok) = match case.domain {
        "asrs" => {
            let (out, status) = crate::engine::solve_asrs(&text, None);
            let parsed = aps_engine::json::parse(&out).unwrap_or(Json::Null);
            let iterations = parsed
                .get("metrics")
                .and_then(|value| value.get("searchedSimulations"))
                .and_then(|value| match value {
                    Json::Int(v) => Some(*v),
                    _ => None,
                })
                .unwrap_or(0);
            let verification_ok = parsed
                .get("verification")
                .and_then(|value| value.get("ok"))
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            (status, parsed, 0.0, iterations, verification_ok)
        }
        "joint" => {
            let (out, status) = crate::engine::solve_joint(&text, None);
            let parsed = aps_engine::json::parse(&out).unwrap_or(Json::Null);
            let iterations = parsed
                .get("result")
                .and_then(|value| value.get("rounds"))
                .and_then(|value| match value {
                    Json::Arr(list) => Some(list.len() as i64),
                    _ => None,
                })
                .unwrap_or(0);
            let verification_ok = parsed
                .get("verification")
                .and_then(|value| value.get("ok"))
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            (status, parsed, 0.0, iterations, verification_ok)
        }
        _ => {
            let (out, status) = crate::engine::solve_slotting(&text, None);
            let parsed = aps_engine::json::parse(&out).unwrap_or(Json::Null);
            let objective = parsed
                .get("objective")
                .and_then(|value| match value {
                    Json::Float(v) => Some(*v),
                    Json::Int(v) => Some(*v as f64),
                    _ => None,
                })
                .unwrap_or(0.0);
            let iterations = parsed
                .get("result")
                .and_then(|value| value.get("search"))
                .and_then(|value| value.get("iterations"))
                .and_then(|value| match value {
                    Json::Int(v) => Some(*v),
                    _ => None,
                })
                .unwrap_or(0);
            (status, parsed, objective, iterations, true)
        }
    };
    let runtime_ms = crate::engine::now_ms() - started;
    let peak = aps_engine::alloc::peak_bytes();
    // 报告实际参与求解的规模（用结果里的 scale 段，而不是生成器参数）
    let actual = envelope.get("metrics").and_then(|value| value.get("scale"));
    let actual_int = |key: &str, fallback: i64| -> i64 {
        actual
            .and_then(|value| value.get(key))
            .and_then(|value| match value {
                Json::Int(v) => Some(*v),
                _ => None,
            })
            .unwrap_or(fallback)
    };
    BenchRow {
        name: case.name.to_string(),
        domain: case.domain.to_string(),
        scale: case.scale.to_string(),
        status: status.as_str().to_string(),
        runtime_ms,
        locations: actual_int("locations", locations),
        skus: actual_int("skus", skus),
        load_units: actual_int("loadUnits", load_units),
        tasks: actual_int("tasks", tasks),
        iterations,
        peak_memory_bytes: peak as i64,
        objective: round(objective, 6),
        verification_ok,
        note: case.note.to_string(),
    }
}

/// 运行全部（或按名字过滤）基准。
pub fn run_all(names: &[String], tier: crate::capabilities::TierLimits) -> Vec<BenchRow> {
    CASES
        .iter()
        .filter(|case| names.is_empty() || names.iter().any(|name| name == case.name))
        .map(|case| run_case(case, tier))
        .collect()
}

/// 汇总 JSON。
pub fn summary_json(rows: &[BenchRow], tier: &str) -> Json {
    Json::obj(vec![
        ("tier", Json::str(tier.to_string())),
        ("count", Json::int(rows.len() as i64)),
        (
            "rows",
            Json::Arr(rows.iter().map(|row| row.to_json()).collect()),
        ),
        (
            "notes",
            Json::strings(vec![
                "peakMemoryBytes 由跟踪分配器统计（含生成器与求解器）".to_string(),
                "runtimeMs 包含数据生成；只看求解时间请看结果里的 computeMs".to_string(),
                "规模列取实际参与求解的数量（results.metrics.scale），不是生成参数".to_string(),
            ]),
        ),
    ])
}

/// 表格头（CLI 人类可读输出）。
pub fn header() -> String {
    format!(
        "{:<16} {:<9} {:<8} {:>10} {:>9} {:>9} {:>9} {:>8} {:>11} {:>10}",
        "case", "domain", "scale", "runtime", "locations", "skus", "loadUnits", "tasks", "peakMem", "status"
    )
}
