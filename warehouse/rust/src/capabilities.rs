//! 能力清单：**诚实**地声明"能做什么、不能做什么"。
//!
//! 与 agv / mapf 的约定一致：宿主（CLI / 实验室 / 其他系统）先读能力清单再决定是否调用。
//! 关键字段：
//! * `canProveOptimal` —— 只有小规模精确分派可以声明；
//! * `canProveInfeasible` —— 只有容量下界 / 单件不可行这类可复述证明；
//! * `tiers` —— native 与 wasm-light 的规模上限（超限返回 UNSUPPORTED，不静默降级）；
//! * `statuses` —— 完整状态语义，避免调用方把"超时"当成"无解"。

use aps_engine::json::Json;

use crate::errors::{codes, constraints, Severity, Status};

/// wasm 轻量层的规模上限（浏览器单线程 + 2GB 内存下的现实边界）。
#[derive(Debug, Clone, Copy)]
pub struct TierLimits {
    pub name: &'static str,
    pub max_skus: usize,
    pub max_locations: usize,
    pub max_load_units: usize,
    pub max_tasks: usize,
    pub max_budget_ms: f64,
}

pub const NATIVE_TIER: TierLimits = TierLimits {
    name: "native",
    max_skus: 2_000_000,
    max_locations: 4_000_000,
    max_load_units: 2_000_000,
    max_tasks: 1_000_000,
    max_budget_ms: 3_600_000.0,
};

pub const WASM_LIGHT_TIER: TierLimits = TierLimits {
    name: "wasm-light",
    max_skus: 60_000,
    max_locations: 300_000,
    max_load_units: 120_000,
    max_tasks: 20_000,
    max_budget_ms: 120_000.0,
};

/// 检查规模是否超出档位；返回 `None` 表示可处理，否则给出可读的拒绝理由。
pub fn check_scale(
    tier: TierLimits,
    skus: usize,
    locations: usize,
    load_units: usize,
    tasks: usize,
    budget_ms: f64,
) -> Option<String> {
    if skus > tier.max_skus {
        return Some(format!(
            "SKU 数 {skus} 超过 {} 档位上限 {}",
            tier.name, tier.max_skus
        ));
    }
    if locations > tier.max_locations {
        return Some(format!(
            "库位数 {locations} 超过 {} 档位上限 {}",
            tier.name, tier.max_locations
        ));
    }
    if load_units > tier.max_load_units {
        return Some(format!(
            "货物单元数 {load_units} 超过 {} 档位上限 {}",
            tier.name, tier.max_load_units
        ));
    }
    if tasks > tier.max_tasks {
        return Some(format!(
            "任务数 {tasks} 超过 {} 档位上限 {}",
            tier.name, tier.max_tasks
        ));
    }
    if budget_ms > tier.max_budget_ms {
        return Some(format!(
            "预算 {budget_ms:.0}ms 超过 {} 档位上限 {:.0}ms",
            tier.name, tier.max_budget_ms
        ));
    }
    None
}

fn algorithm_json(
    id: &str,
    label: &str,
    kind: &str,
    can_prove_optimal: bool,
    can_prove_infeasible: bool,
    bound: &str,
    notes: &str,
) -> Json {
    Json::obj(vec![
        ("id", Json::str(id)),
        ("label", Json::str(label)),
        ("kind", Json::str(kind)),
        ("canProveOptimal", Json::Bool(can_prove_optimal)),
        ("canProveInfeasible", Json::Bool(can_prove_infeasible)),
        ("boundKind", Json::str(bound)),
        ("notes", Json::str(notes)),
    ])
}

/// 能力清单 JSON（`capabilities` 子命令 / `wh_capabilities` 导出）。
pub fn capabilities_json() -> Json {
    let slotting_basics: Vec<Json> = crate::slotting::strategies::ALGORITHMS
        .iter()
        .map(|algorithm| {
            algorithm_json(
                algorithm,
                crate::slotting::strategies::describe(algorithm),
                if crate::slotting::strategies::is_basic(algorithm) {
                    "baseline"
                } else {
                    "optimizer"
                },
                false,
                false,
                if crate::slotting::strategies::is_basic(algorithm) {
                    "none"
                } else {
                    "assignment-relaxation"
                },
                "基础策略是确定性构造规则；高级算法在小规模实例上会附带线性分派松弛下界",
            )
        })
        .collect();

    Json::obj(vec![
        ("engine", Json::str(crate::ENGINE_NAME)),
        ("engineVersion", Json::str(crate::ENGINE_VERSION)),
        // 档位：native 与 wasm-light 的规模上限不同，调用方（CLI / 实验室 / 业务系统）
        // 必须在生成实例前用它做拦截，而不是等到超限才报错。
        (
            "profile",
            Json::str(if cfg!(target_arch = "wasm32") {
                "wasm-light"
            } else {
                "native"
            }),
        ),
        ("compilerVersion", Json::str(crate::COMPILER_VERSION)),
        ("rulesetVersion", Json::str(crate::RULESET_VERSION)),
        (
            "domains",
            Json::Arr(vec![
                Json::obj(vec![
                    ("id", Json::str("slotting")),
                    ("label", Json::str("仓储库位优化（Warehouse Slotting Optimization）")),
                    (
                        "problem",
                        Json::str("把 N 个货物单元分配到 M 个拓扑派生库位上，满足承重/容积/分区/深位/分散/冻结等硬约束，优化多目标"),
                    ),
                    ("algorithms", Json::Arr(slotting_basics.clone())),
                    (
                        "objectives",
                        Json::strings(vec![
                            "expected-travel-time".to_string(),
                            "device-travel-distance".to_string(),
                            "space-utilization".to_string(),
                            "effective-utilization".to_string(),
                            "relocation-count".to_string(),
                            "relocation-cost".to_string(),
                            "congestion".to_string(),
                            "load-balance".to_string(),
                            "delivery-timeliness".to_string(),
                            "energy".to_string(),
                        ]),
                    ),
                    (
                        "notes",
                        Json::str(
                            "目标是可加/可增量维护的物理量；拥堵为巷道排队代理（M/M/c 型延误），迁移代价按两库位之间的真实设备运行时间计算",
                        ),
                    ),
                ]),
                Json::obj(vec![
                    ("id", Json::str("asrs")),
                    ("label", Json::str("密集立库调度（High-Density AS/RS Scheduling）")),
                    (
                        "problem",
                        Json::str("在单/双/多深位立库、多层、四向穿梭车、提升机、交接站与缓冲位约束下调度任务，输出可验证的设备时间线"),
                    ),
                    (
                        "algorithms",
                        Json::Arr(
                            crate::asrs::POLICIES
                                .iter()
                                .map(|policy| {
                                    algorithm_json(
                                        policy,
                                        crate::asrs::describe(policy),
                                        "调度策略",
                                        false,
                                        false,
                                        "none（用真实推演评价）",
                                        "全部策略都生成完整时间线并接受时空预约互斥检查；joint-alns 用真实重演做邻域搜索",
                                    )
                                })
                                .collect(),
                        ),
                    ),
                    (
                        "supports",
                        Json::strings(vec![
                            "single-command".to_string(),
                            "dual-command".to_string(),
                            "multi-deep-relocation".to_string(),
                            "reservation-based-collision-avoidance".to_string(),
                            "deadlock-prevention".to_string(),
                            "dynamic-events".to_string(),
                            "rescheduling".to_string(),
                            "handover-stations".to_string(),
                            "buffer-capacity".to_string(),
                        ]),
                    ),
                    (
                        "notes",
                        Json::str(
                            "调度器输出时间线（设备轨迹 + 任务轨迹 + 状态变化）；所有约束由独立验证器重放复核",
                        ),
                    ),
                ]),
                Json::obj(vec![
                    ("id", Json::str("joint")),
                    ("label", Json::str("库位 × 调度联合优化")),
                    (
                        "problem",
                        Json::str("用真实设备调度评价库位方案，并把调度暴露的拥堵反馈给库位模型，迭代出联合更优方案"),
                    ),
                    (
                        "answers",
                        Json::strings(vec![
                            "为什么货物放在这些库位（explanation.slotting + 证据）".to_string(),
                            "为什么设备按这个顺序运行（explanation.dispatch + 冲突留痕）".to_string(),
                            "联合方案是否真的更好（comparison 对比矩阵）".to_string(),
                        ]),
                    ),
                ]),
            ]),
        ),
        (
            "statuses",
            Json::Arr(
                [
                    Status::OptimalProven,
                    Status::FeasibleWithBound,
                    Status::Feasible,
                    Status::BudgetExceeded,
                    Status::NoSolutionFound,
                    Status::InfeasibleProven,
                    Status::Cancelled,
                    Status::InvalidInput,
                    Status::Unsupported,
                    Status::InternalError,
                ]
                .iter()
                .map(|status| {
                    Json::obj(vec![
                        ("status", Json::str(status.as_str())),
                        ("code", Json::int(status.code() as i64)),
                        ("hasSolution", Json::Bool(status.has_solution())),
                    ])
                })
                .collect(),
            ),
        ),
        (
            "verification",
            Json::obj(vec![
                (
                    "codes",
                    Json::strings(
                        [
                            constraints::LOCATION_CAPACITY,
                            constraints::LOCATION_WEIGHT_LIMIT,
                            constraints::LOCATION_VOLUME_LIMIT,
                            constraints::LOCATION_FROZEN,
                            constraints::LOCATION_UNAVAILABLE,
                            constraints::ZONE_COMPATIBILITY,
                            constraints::DEEP_LANE_BLOCKING,
                            constraints::SKU_DISPERSION_MAX,
                            constraints::UNASSIGNED_INVENTORY,
                            constraints::INVENTORY_CONSERVATION,
                            constraints::DEVICE_MUTUAL_EXCLUSION,
                            constraints::LANE_MUTUAL_EXCLUSION,
                            constraints::LIFT_SHAFT_CAPACITY,
                            constraints::TIME_CONSISTENCY,
                            constraints::TASK_PRECEDENCE,
                            constraints::TASK_DEADLINE,
                            constraints::BUFFER_CAPACITY,
                            constraints::STATION_CAPACITY,
                            constraints::DEVICE_CAPABILITY_VIOLATION,
                            constraints::DEVICE_UNAVAILABLE,
                            constraints::METRIC_MISMATCH,
                        ]
                        .iter()
                        .map(|code| code.to_string())
                        .collect::<Vec<String>>(),
                    ),
                ),
                (
                    "independence",
                    Json::str(
                        "验证器只读取问题与方案，独立重算时间/距离/容量与占用；不接受求解器的中间状态，并在优化器与验证器指标不一致时报 METRIC_MISMATCH",
                    ),
                ),
            ]),
        ),
        (
            "tiers",
            Json::Arr(vec![
                tier_json(NATIVE_TIER, "原生 CLI / 服务"),
                tier_json(WASM_LIGHT_TIER, "浏览器 wasm 轻量档"),
            ]),
        ),
        (
            "scenarios",
            Json::obj(vec![
                ("count", Json::int(crate::scenario::SCENARIOS.len() as i64)),
                (
                    "families",
                    Json::strings(vec![
                        "S01–S24 库位优化".to_string(),
                        "D01–D24 立库调度".to_string(),
                        "E01–E14 事件与异常".to_string(),
                        "J01–J12 联合优化".to_string(),
                        "X01–X12 压力与边界".to_string(),
                    ]),
                ),
            ]),
        ),
        (
            "reproducibility",
            Json::obj(vec![
                (
                    "fingerprint",
                    Json::str("sha256(engine, version, ruleset, datasetVersion, algorithm, seed, input)"),
                ),
                (
                    "determinism",
                    Json::str(
                        "同一输入 + 同一 seed + 同一版本 → 同一结果（时间字段除外；求解过程不使用系统随机源）",
                    ),
                ),
            ]),
        ),
        (
            "limits",
            Json::obj(vec![
                (
                    "noFalseOptimality",
                    Json::str("只有小规模精确分派（≤ exactMaxUnits）允许声明 OPTIMAL_PROVEN，且必须与下界一致"),
                ),
                (
                    "noFalseInfeasibility",
                    Json::str("只有当存在可复述的证明（容量下界 / 单件不可行）时才允许 INFEASIBLE_PROVEN"),
                ),
                (
                    "timeoutSemantics",
                    Json::str("预算耗尽但有解 → FEASIBLE(_WITH_BOUND) + budgetExceeded=true；无解才是 BUDGET_EXCEEDED"),
                ),
            ]),
        ),
    ])
}

fn tier_json(tier: TierLimits, label: &str) -> Json {
    Json::obj(vec![
        ("name", Json::str(tier.name)),
        ("label", Json::str(label)),
        ("maxSkus", Json::int(tier.max_skus as i64)),
        ("maxLocations", Json::int(tier.max_locations as i64)),
        ("maxLoadUnits", Json::int(tier.max_load_units as i64)),
        ("maxTasks", Json::int(tier.max_tasks as i64)),
        ("maxBudgetMs", Json::Float(tier.max_budget_ms)),
    ])
}

/// 代码清单（`codes` 子命令：把字段级问题码与约束码列出来，便于宿主做映射）。
pub fn error_codes_json() -> Json {
    Json::obj(vec![
        (
            "issueCodes",
            Json::strings(vec![
                codes::SCHEMA_INVALID.to_string(),
                codes::MISSING_FIELD.to_string(),
                codes::TYPE_MISMATCH.to_string(),
                codes::VALUE_RANGE.to_string(),
                codes::DUPLICATE_ID.to_string(),
                codes::UNKNOWN_REFERENCE.to_string(),
                codes::TOPOLOGY_INVALID.to_string(),
                codes::DEVICE_CAPABILITY.to_string(),
                codes::UNREACHABLE.to_string(),
                codes::UNSUPPORTED_FEATURE.to_string(),
                codes::LIMIT_EXCEEDED.to_string(),
                codes::EMPTY_INPUT.to_string(),
                codes::SCALE_TOO_LARGE.to_string(),
                codes::INFEASIBLE.to_string(),
                codes::NO_SOLUTION.to_string(),
                codes::BOUND_AVAILABLE.to_string(),
                codes::BUDGET_EXHAUSTED.to_string(),
                codes::INTERNAL_INCONSISTENCY.to_string(),
            ]),
        ),
        (
            "severities",
            Json::strings(vec![
                Severity::Error.as_str().to_string(),
                Severity::Warning.as_str().to_string(),
                Severity::Info.as_str().to_string(),
            ]),
        ),
        (
            "constraintClass",
            Json::strings(vec!["hard".to_string(), "soft".to_string()]),
        ),
    ])
}
