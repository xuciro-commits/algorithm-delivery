//! `SolverCapabilities v1`：引擎能力声明与“模型-引擎”匹配检查。
//!
//! 契约要求（APS-SRS §4）：
//! * 任何引擎必须先声明能力；不能求解的输入返回 `UNSUPPORTED_CONSTRAINT`，**不得擅自忽略约束**；
//! * 浏览器（WASM）不得声称能证明 `OPTIMAL` / `INFEASIBLE`。
//!
//! 本模块给出两个档位：
//!
//! | 档位 | 约束 | 规模上限 | 证明最优 | 证明无解 | 支持取消 |
//! |------|------|----------|----------|----------|----------|
//! | `native` | H01–H08 | 20,000 工序 | 仅当“加权延期=0 且 makespan 达到有效下界”时 | 是（仅可构造证明的类型） | 是 |
//! | `wasm-light` | H01–H08 | 600 工序 | 否（即使本轮达到下界也只报告 FEASIBLE） | 否 | 否（浏览器侧按 Worker 终止实现） |

use crate::errors::Severity;
use crate::json::Json;
use crate::model::RawProblem;
use crate::{ENGINE_NAME, ENGINE_VERSION};

/// 约束编号全集。
pub const ALL_CONSTRAINTS: &[&str] = &["H01", "H02", "H03", "H04", "H05", "H06", "H07", "H08"];

/// 引擎档位。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    /// 原生服务：完整约束 + 可构造无解证明 + 协作式取消。
    Native,
    /// 浏览器 WASM 轻量档：仅受支持规模内的启发式，不作任何最优/无解证明。
    WasmLight,
}

impl Profile {
    pub fn parse(s: &str) -> Option<Profile> {
        match s {
            "native" => Some(Profile::Native),
            "wasm-light" | "wasm" | "wasm_light" => Some(Profile::WasmLight),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Profile::Native => "native",
            Profile::WasmLight => "wasm-light",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SolverCapabilities {
    pub engine: String,
    pub version: String,
    pub constraints: Vec<&'static str>,
    pub max_operations: usize,
    pub can_prove_optimal: bool,
    pub can_prove_infeasible: bool,
    pub supports_cancel: bool,
    /// 备注（仅用于文本输出，不写入 JSON —— 契约 schema 为 additionalProperties: false）
    pub notes: Vec<String>,
    pub profile: Profile,
}

impl SolverCapabilities {
    pub fn supports(&self, constraint: &str) -> bool {
        self.constraints.iter().any(|c| *c == constraint)
    }

    /// 严格符合 `solver-capabilities.schema.json` 的 JSON。
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("engine", Json::str(self.engine.clone())),
            ("version", Json::str(self.version.clone())),
            ("constraints", Json::strings(self.constraints.iter().copied())),
            ("max_operations", Json::int(self.max_operations as i64)),
            ("can_prove_optimal", Json::Bool(self.can_prove_optimal)),
            ("can_prove_infeasible", Json::Bool(self.can_prove_infeasible)),
            ("supports_cancel", Json::Bool(self.supports_cancel)),
        ])
    }
}

/// 构造档位能力声明。
pub fn capabilities_for(profile: Profile) -> SolverCapabilities {
    match profile {
        Profile::Native => SolverCapabilities {
            engine: ENGINE_NAME.to_string(),
            version: ENGINE_VERSION.to_string(),
            constraints: ALL_CONSTRAINTS.to_vec(),
            max_operations: 20_000,
            can_prove_optimal: true,
            can_prove_infeasible: true,
            supports_cancel: true,
            notes: vec![
                "启发式 + 局部修复：仅当解满足“加权延期=0 且 makespan 达到有效下界”时才返回 OPTIMAL（optimality_proven=true）；否则一律 FEASIBLE 并给出 best_bound / relative_gap"
                    .to_string(),
                "可构造无解证明的类型：资格死角 / 单工序无可用窗口 / 物料总供给不足 / 关键链超出时域"
                    .to_string(),
                "其余无解情形的状态为 NO_SOLUTION_FOUND 或 UNKNOWN，绝不伪称 INFEASIBLE".to_string(),
            ],
            profile,
        },
        Profile::WasmLight => SolverCapabilities {
            engine: ENGINE_NAME.to_string(),
            version: ENGINE_VERSION.to_string(),
            constraints: ALL_CONSTRAINTS.to_vec(),
            max_operations: 600,
            can_prove_optimal: false,
            can_prove_infeasible: false,
            supports_cancel: false,
            notes: vec![
                "浏览器 Worker 内运行；不阻塞 React 主线程".to_string(),
                "不作最优/无解证明；超出规模上限返回 UNSUPPORTED_CONSTRAINT，前端应切换服务器后端"
                    .to_string(),
                "取消由主线程终止 Worker 实现（引擎内不支持协作式取消）".to_string(),
            ],
            profile,
        },
    }
}

/// 模型与能力不匹配的说明（映射为 `UNSUPPORTED_CONSTRAINT`）。
#[derive(Debug, Clone, PartialEq)]
pub struct Unsupported {
    pub code: String,
    pub path: String,
    pub message: String,
    pub details: Vec<(String, Json)>,
}

/// 检查“本模型是否落在该引擎能力范围内”；不匹配时返回全部原因（不擅自降级删约束）。
pub fn check_support(problem: &RawProblem, caps: &SolverCapabilities) -> Result<(), Vec<Unsupported>> {
    let mut out: Vec<Unsupported> = Vec::new();
    let total_ops: usize = problem.orders.iter().map(|o| o.operations.len()).sum();
    if total_ops > caps.max_operations {
        out.push(Unsupported {
            code: "SCALE_EXCEEDED".to_string(),
            path: "$.orders".to_string(),
            message: format!(
                "工序总数 {} 超出引擎 '{}' 的 max_operations={}；请改用服务器后端（native）",
                total_ops, caps.engine, caps.max_operations
            ),
            details: vec![
                ("operations".to_string(), Json::int(total_ops as i64)),
                (
                    "max_operations".to_string(),
                    Json::int(caps.max_operations as i64),
                ),
            ],
        });
    }

    if !caps.supports("H05") {
        out.push(Unsupported {
            code: "WORKER_CONSTRAINTS_UNSUPPORTED".to_string(),
            path: "$.workers".to_string(),
            message: "该引擎未声明支持 H05（人员技能/资格/排他）".to_string(),
            details: vec![],
        });
    }

    for (oi, order) in problem.orders.iter().enumerate() {
        for (pi, op) in order.operations.iter().enumerate() {
            let path = format!("$.orders[{}].operations[{}]", oi, pi);
            if op.worker_count != 1 {
                out.push(Unsupported {
                    code: "MULTI_WORKER_OPERATION".to_string(),
                    path: format!("{}.worker_count", path),
                    message: "多人员协同工序（worker_count>1）属于 P1，本引擎不静默忽略".to_string(),
                    details: vec![(
                        "operation_id".to_string(),
                        Json::str(op.id.clone()),
                    )],
                });
            }
            if !caps.supports("H06") && !op.tools.is_empty() {
                out.push(Unsupported {
                    code: "TOOL_CONSTRAINTS_UNSUPPORTED".to_string(),
                    path: format!("{}.tools", path),
                    message: "该引擎未声明支持 H06（独占共享工装）".to_string(),
                    details: vec![("operation_id".to_string(), Json::str(op.id.clone()))],
                });
            }
            if !caps.supports("H07") && !op.materials.is_empty() {
                out.push(Unsupported {
                    code: "MATERIAL_CONSTRAINTS_UNSUPPORTED".to_string(),
                    path: format!("{}.materials", path),
                    message: "该引擎未声明支持 H07（物料时序平衡）".to_string(),
                    details: vec![("operation_id".to_string(), Json::str(op.id.clone()))],
                });
            }
            if !caps.supports("H04")
                && op
                    .alternatives
                    .iter()
                    .all(|a| a.duration_min > 0)
                && (problem
                    .machines
                    .iter()
                    .any(|m| m.blocked.len() > 0)
                    || problem.workers.iter().any(|w| w.blocked.len() > 0))
            {
                out.push(Unsupported {
                    code: "CALENDAR_CONSTRAINTS_UNSUPPORTED".to_string(),
                    path: format!("{}.alternatives", path),
                    message: "该引擎未声明支持 H04（机器/人员日历与停工窗口）".to_string(),
                    details: vec![("operation_id".to_string(), Json::str(op.id.clone()))],
                });
            }
            if out.len() > 32 {
                return Err(out);
            }
        }
    }

    if out.is_empty() {
        Ok(())
    } else {
        Err(out)
    }
}

/// 把不支持项转成结构化 JSON（写入 `PlanSolution.violations`）。
pub fn unsupported_to_json(items: &[Unsupported]) -> Vec<Json> {
    items
        .iter()
        .map(|u| {
            Json::obj(vec![
                ("code", Json::str(u.code.clone())),
                ("severity", Json::str(Severity::Error.as_str())),
                ("constraint", Json::Null),
                ("message", Json::str(u.message.clone())),
                ("path", Json::str(u.path.clone())),
                (
                    "details",
                    Json::Obj(u.details.clone()),
                ),
            ])
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;

    fn load(rel: &str) -> RawProblem {
        let text =
            std::fs::read_to_string(format!("{}/../{}", env!("CARGO_MANIFEST_DIR"), rel)).unwrap();
        let j = json::parse(&text).unwrap();
        crate::model::parse_problem(&j).0.unwrap()
    }

    #[test]
    fn native_capabilities_shape() {
        let caps = capabilities_for(Profile::Native);
        let json = caps.to_json();
        let fields: Vec<&str> = json.as_obj().unwrap().iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            fields,
            vec![
                "engine",
                "version",
                "constraints",
                "max_operations",
                "can_prove_optimal",
                "can_prove_infeasible",
                "supports_cancel"
            ]
        );
        assert_eq!(json.get("engine").unwrap().as_str(), Some(ENGINE_NAME));
        // native 仅在达到有效下界时证明最优（声明为 true，但必须由引擎在达到下界时才写 OPTIMAL）
        assert!(caps.can_prove_optimal);
        assert!(caps.can_prove_infeasible);
        assert!(caps.notes.iter().any(|n| n.contains("makespan 达到有效下界")));
    }

    #[test]
    fn baseline_supported_by_both_profiles() {
        let p = load("mock/baseline.json");
        assert!(check_support(&p, &capabilities_for(Profile::Native)).is_ok());
        assert!(check_support(&p, &capabilities_for(Profile::WasmLight)).is_ok());
    }

    #[test]
    fn scale_exceeded_is_unsupported() {
        let p = load("mock/baseline.json");
        let mut caps = capabilities_for(Profile::WasmLight);
        caps.max_operations = 10; // 24 工序 > 10
        let err = check_support(&p, &caps).unwrap_err();
        assert_eq!(err[0].code, "SCALE_EXCEEDED");
        assert!(err[0].message.contains("UNSUPPORTED") || err[0].message.contains("服务器后端"));
    }

    #[test]
    fn missing_constraint_declaration_is_unsupported() {
        let p = load("mock/baseline.json");
        let mut caps = capabilities_for(Profile::Native);
        caps.constraints = vec!["H01", "H02", "H03", "H04", "H05", "H08"];
        let err = check_support(&p, &caps).unwrap_err();
        assert!(err.iter().any(|u| u.code == "TOOL_CONSTRAINTS_UNSUPPORTED"));
        assert!(err.iter().any(|u| u.code == "MATERIAL_CONSTRAINTS_UNSUPPORTED"));
    }
}
