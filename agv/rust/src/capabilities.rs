//! 能力档位（`agv-dispatch-capabilities/1.0`）：限额进 UI/CLI 边界，超限结构化拒绝。

use aps_engine::json::Json;

use crate::errors::{codes, Issue};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
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

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_vehicles: usize,
    pub max_tasks: usize,
    pub max_map_cells: usize,
    pub max_horizon: u32,
    pub max_budget_ms: i64,
    pub max_events: usize,
    pub max_input_bytes: usize,
}

impl Limits {
    pub fn for_profile(p: Profile) -> Limits {
        match p {
            Profile::Native => Limits {
                max_vehicles: 256,
                max_tasks: 512,
                max_map_cells: 1 << 20,
                max_horizon: 20000,
                max_budget_ms: 900_000,
                max_events: 64,
                max_input_bytes: 16 << 20,
            },
            Profile::WasmLight => Limits {
                max_vehicles: 64,
                max_tasks: 128,
                max_map_cells: 16384,
                max_horizon: 4000,
                max_budget_ms: 120_000,
                max_events: 32,
                max_input_bytes: 8 << 20,
            },
        }
    }
}

/// 入口门控：任何超限返回结构化 Issue（UNSUPPORTED），而不是崩溃或静默截断。
pub fn gate(
    profile: Profile,
    vehicles: usize,
    tasks: usize,
    map_cells: usize,
    horizon: u32,
    budget_ms: i64,
    events: usize,
) -> Result<(), (&'static str, String)> {
    let l = Limits::for_profile(profile);
    if vehicles > l.max_vehicles {
        return Err((
            codes::LIMIT_VEHICLES,
            format!(
                "车辆数 {vehicles} 超过 {}/{} 档位上限 {}",
                Profile::Native.as_str(),
                profile.as_str(),
                l.max_vehicles
            ),
        ));
    }
    if tasks > l.max_tasks {
        return Err((
            codes::LIMIT_TASKS,
            format!("任务数 {tasks} 超过档位上限 {}", l.max_tasks),
        ));
    }
    if map_cells > l.max_map_cells {
        return Err((
            codes::LIMIT_MAP,
            format!("地图格数 {map_cells} 超过档位上限 {}", l.max_map_cells),
        ));
    }
    if horizon > l.max_horizon {
        return Err((
            codes::LIMIT_HORIZON,
            format!("时域 {horizon} 超过档位上限 {}", l.max_horizon),
        ));
    }
    if budget_ms > l.max_budget_ms {
        return Err((
            codes::LIMIT_BUDGET,
            format!(
                "求解预算 {budget_ms} ms 超过档位上限 {} ms",
                l.max_budget_ms
            ),
        ));
    }
    if events > l.max_events {
        return Err((
            codes::LIMIT_EVENTS,
            format!("动态事件数 {events} 超过档位上限 {}", l.max_events),
        ));
    }
    Ok(())
}

/// 能力声明 JSON（符合 agv-dispatch-capabilities/1.0）。
pub fn report(profile: Profile) -> Json {
    let l = Limits::for_profile(profile);
    Json::obj(vec![
        ("schema_version", Json::str("agv-dispatch-capabilities/1.0")),
        ("engine", Json::str(crate::ENGINE_NAME)),
        ("version", Json::str(crate::ENGINE_VERSION)),
        ("profile", Json::str(profile.as_str())),
        (
            "limits",
            Json::obj(vec![
                ("max_vehicles", Json::int(l.max_vehicles as i64)),
                ("max_tasks", Json::int(l.max_tasks as i64)),
                ("max_map_cells", Json::int(l.max_map_cells as i64)),
                ("max_horizon", Json::int(l.max_horizon as i64)),
                ("max_budget_ms", Json::int(l.max_budget_ms)),
                ("max_events", Json::int(l.max_events as i64)),
                ("max_input_bytes", Json::int(l.max_input_bytes as i64)),
            ]),
        ),
        (
            "algorithms",
            Json::strings(["auto", "baseline", "insertion-ls"]),
        ),
        (
            "mapf",
            Json::obj(vec![
                ("engine", Json::str(mapf_engine::ENGINE_NAME)),
                ("version", Json::str(mapf_engine::ENGINE_VERSION)),
                (
                    "api",
                    Json::str("mapf_engine::engine::solve_json (mapf-problem/1.0)"),
                ),
            ]),
        ),
        (
            "unsupported_features",
            Json::strings([
                "continuous-motion",
                "vehicle-dynamics",
                "battery",
                "heterogeneous-speed",
                "multi-load",
                "task-splitting",
                "load-transfer",
                "optimal-proof",
            ]),
        ),
    ])
}

/// 门控失败 → Issues。
pub fn gate_issues(err: (&'static str, String)) -> Vec<Issue> {
    vec![Issue::error(err.0, "$", err.1)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_accepts_and_rejects() {
        assert!(gate(Profile::WasmLight, 64, 128, 16384, 4000, 120_000, 32).is_ok());
        assert!(gate(Profile::WasmLight, 65, 10, 100, 100, 1000, 0).is_err());
        assert!(gate(Profile::Native, 64, 128, 16384, 4000, 120_000, 32).is_ok());
    }

    #[test]
    fn report_shape() {
        let r = report(Profile::WasmLight);
        assert_eq!(
            r.get("schema_version").and_then(|j| j.as_str()),
            Some("agv-dispatch-capabilities/1.0")
        );
        assert_eq!(
            r.get("profile").and_then(|j| j.as_str()),
            Some("wasm-light")
        );
        assert!(
            r.get("limits")
                .and_then(|j| j.get("max_vehicles"))
                .and_then(|j| j.as_i64())
                .unwrap()
                > 0
        );
    }
}
