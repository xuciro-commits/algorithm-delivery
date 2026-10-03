//! 能力声明与档位（SRS §2.3：必须**明确声明**地图、机器人数、时域、目标、
//! 动态事件与 Native/WASM 的实际能力限制；不支持的功能必须显式拒绝）。
//!
//! 输入问题中任何触碰 `unsupported_features` 的字段都必须被 `gate` 拒绝为
//! `UNSUPPORTED`（错误码给出可操作信息），不允许静默降级。

use aps_engine::json::Json;

/// 运行档位。`Native` = CLI/服务端；`WasmLight` = 浏览器 Worker（更小的规模上限）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Profile {
    #[default]
    Native,
    WasmLight,
}

impl Profile {
    pub fn as_str(self) -> &'static str {
        match self {
            Profile::Native => "native",
            Profile::WasmLight => "wasm-light",
        }
    }
    pub fn parse(s: &str) -> Option<Profile> {
        match s {
            "native" => Some(Profile::Native),
            "wasm-light" | "wasm_light" | "wasm" => Some(Profile::WasmLight),
            _ => None,
        }
    }
}

/// 规模与预算上限（诚实声明：超限 = 拒绝并标注，而非“尽力而为不报错”）。
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_agents: usize,
    /// 栅格单元总数上限（宽×高）。
    pub max_cells: usize,
    /// 单边长上限。
    pub max_side: u32,
    /// 规划时域上限（离散步）。
    pub max_horizon: u32,
    /// 单次求解时间预算上限（毫秒）。
    pub max_budget_ms: i64,
    /// 高层节点扩展数上限（0 = 不限，按预算停止）。
    pub max_expansions_cap: usize,
    /// 动态事件数上限。
    pub max_events: usize,
    /// 语义核验（验证器）随求解自动执行时的输出规模上限（字节）。
    pub max_input_bytes: usize,
}

impl Limits {
    pub const fn native() -> Limits {
        Limits {
            max_agents: 256,
            max_cells: 256 * 256,
            max_side: 512,
            max_horizon: 4000,
            max_budget_ms: 1_800_000,
            max_expansions_cap: 4_000_000,
            max_events: 64,
            max_input_bytes: 64 * 1_048_576,
        }
    }
    pub const fn wasm_light() -> Limits {
        Limits {
            max_agents: 120,
            max_cells: 16_384, // 128×128
            max_side: 256,
            max_horizon: 1500,
            max_budget_ms: 120_000,
            max_expansions_cap: 800_000,
            max_events: 32,
            max_input_bytes: 8 * 1_048_576,
        }
    }
    pub fn for_profile(p: Profile) -> Limits {
        match p {
            Profile::Native => Limits::native(),
            Profile::WasmLight => Limits::wasm_light(),
        }
    }
}

/// 静态求解能力（是否可给出证明取决于算法穷尽，而非档位之外的承诺）。
pub const OBJECTIVES: [&str; 2] = ["soc", "makespan"];
pub const MOVEMENT: [&str; 3] = ["4-neighbor", "wait", "synchronous-discrete-time"];
pub const CONFLICT_RULES: [&str; 3] = ["vertex", "edge-swap", "stay-at-target"];
pub const DYNAMIC_EVENTS: [&str; 4] = [
    "obstacle_add",
    "obstacle_remove",
    "goal_change",
    "path_invalid",
];

/// 明确**不支持**的特性（出现即 `UNSUPPORTED`，SRS §2.3）。
pub const UNSUPPORTED_FEATURES: [&str; 12] = [
    "diagonal-moves",
    "variable-action-duration",
    "kinematic-constraints",
    "pickup-and-delivery",
    "corridor/traffic-priority-rules",
    "continuous-time-motion",
    "vehicle-routing/task-assignment",
    "charging-scheduling",
    "multi-story/3d-maps",
    "weighted-cell-costs",
    "collision-matrix-sizes",
    "real-vehicle-fault-detection",
];

/// 完整能力声明（与 `mapf-capabilities.schema.json` 对齐）。
pub fn report(profile: Profile) -> Json {
    let l = Limits::for_profile(profile);
    Json::obj(vec![
        ("schema_version", Json::str(SCHEMA)),
        ("engine", Json::str(crate::ENGINE_NAME)),
        ("version", Json::str(crate::ENGINE_VERSION)),
        ("profile", Json::str(profile.as_str())),
        (
            "semantics",
            Json::obj(vec![
                (
                    "time",
                    Json::strings(["discrete", "synchronous", "unit-timestep"]),
                ),
                ("movement", Json::strings(MOVEMENT)),
                ("conflicts", Json::strings(CONFLICT_RULES)),
                ("stay_at_target", Json::Bool(true)),
                ("ruleset_version", Json::str(crate::RULESET_VERSION)),
            ]),
        ),
        ("objectives", Json::strings(OBJECTIVES)),
        (
            "proofs",
            Json::obj(vec![
                ("can_prove_optimal_soc", Json::Bool(true)),
                ("can_prove_optimal_makespan", Json::Bool(true)),
                ("can_prove_infeasible", Json::Bool(true)),
                (
                    "proof_scope",
                    Json::str("horizon-bounded：证明仅覆盖声明时域内的该数学模型"),
                ),
                (
                    "bounded_suboptimality",
                    Json::str("ECBS w∈[1,3]：w>1 报告 SOC/下界差距，不声称最优"),
                ),
            ]),
        ),
        (
            "dynamic",
            Json::obj(vec![
                ("supported", Json::strings(DYNAMIC_EVENTS)),
                ("frozen_prefix", Json::Bool(true)),
                (
                    "replan_metrics",
                    Json::strings(["replan_ms", "affected_agents", "path_change_steps"]),
                ),
                (
                    "not_supported",
                    Json::strings([
                        "fault-detection",
                        "physical-safety",
                        "partial-execution-resume-kinematics",
                    ]),
                ),
            ]),
        ),
        (
            "limits",
            Json::obj(vec![
                ("max_agents", Json::int(l.max_agents as i64)),
                ("max_cells", Json::int(l.max_cells as i64)),
                ("max_side", Json::int(l.max_side as i64)),
                ("max_horizon", Json::int(l.max_horizon as i64)),
                ("max_budget_ms", Json::int(l.max_budget_ms)),
                ("max_expansions_cap", Json::int(l.max_expansions_cap as i64)),
                ("max_events", Json::int(l.max_events as i64)),
                ("max_input_bytes", Json::int(l.max_input_bytes as i64)),
            ]),
        ),
        ("unsupported_features", Json::strings(UNSUPPORTED_FEATURES)),
        (
            "verification",
            Json::str(
                "独立核验器（verify.rs）不复用求解器冲突判断；求解成功后自动交叉核验并内嵌报告",
            ),
        ),
        (
            "determinism",
            Json::str(
                "固定输入+版本+种子+预算 ⇒ 语义结果指纹一致（路径集合、SOC、Makespan、状态）",
            ),
        ),
        (
            "benchmark",
            Json::str("Moving AI .map/.scen（ODC-BY）；清单与哈希见 mapf/bench/manifest.json"),
        ),
    ])
}

const SCHEMA: &str = super::errors::SCHEMA_VERSION_CAPABILITIES;

/// 规模门控：超限 → `(false, 错误码, 提示)`。
#[allow(clippy::too_many_arguments)]
pub fn gate(
    profile: Profile,
    agents: usize,
    cells: usize,
    max_side: u32,
    horizon: u32,
    budget_ms: i64,
    events: usize,
) -> Result<(), (&'static str, String)> {
    let l = Limits::for_profile(profile);
    if agents > l.max_agents {
        return Err((
            super::errors::codes::LIMIT_AGENTS,
            format!(
                "机器人数量 {agents} 超过 {}/{} 档位上限 {}",
                profile.as_str(),
                crate::ENGINE_NAME,
                l.max_agents
            ),
        ));
    }
    if cells > l.max_cells || max_side > l.max_side {
        return Err((
            super::errors::codes::LIMIT_MAP,
            format!(
                "地图规模 {cells} 单元（边长上限 {max_side}）超过档位限制（cells≤{}, side≤{}）",
                l.max_cells, l.max_side
            ),
        ));
    }
    if horizon > l.max_horizon {
        return Err((
            super::errors::codes::LIMIT_HORIZON,
            format!("规划时域 {horizon} 超过档位上限 {}", l.max_horizon),
        ));
    }
    if budget_ms > l.max_budget_ms {
        return Err((
            super::errors::codes::LIMIT_BUDGET,
            format!(
                "求解时间预算 {budget_ms}ms 超过档位上限 {}ms",
                l.max_budget_ms
            ),
        ));
    }
    if events > l.max_events {
        return Err((
            super::errors::codes::UNSUPPORTED_FEATURE,
            format!("动态事件数 {events} 超过档位上限 {}", l.max_events),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_accepts_boundary_and_rejects_over() {
        let l = Limits::wasm_light();
        assert!(gate(
            Profile::WasmLight,
            l.max_agents,
            l.max_cells,
            l.max_side,
            l.max_horizon,
            l.max_budget_ms,
            l.max_events,
        )
        .is_ok());
        assert!(gate(Profile::WasmLight, l.max_agents + 1, 100, 8, 8, 1000, 0).is_err());
        let (code, _) = gate(Profile::WasmLight, 2, l.max_cells + 1, 4096, 8, 1000, 0).unwrap_err();
        assert_eq!(code, super::super::errors::codes::LIMIT_MAP);
    }

    #[test]
    fn report_shape() {
        let r = report(Profile::Native);
        let o = r.as_obj().expect("object");
        for key in [
            "schema_version",
            "engine",
            "version",
            "profile",
            "semantics",
            "objectives",
            "limits",
            "unsupported_features",
        ] {
            assert!(o.iter().any(|(k, _)| k == key), "缺少能力字段 {key}");
        }
        assert_eq!(r.get("profile").and_then(|v| v.as_str()), Some("native"));
    }
}
