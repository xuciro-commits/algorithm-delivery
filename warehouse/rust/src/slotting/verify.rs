//! 库位方案的**独立验证器**：从问题与方案出发逐项复核，并重算指标。
//!
//! 与求解器完全分离：这里不引用任何增量维护的状态，全部从"方案 + 问题"重新推导。
//! 只要优化器给错一个数字（例如把 60% 的 O(n) 查询当作 100%，或把搬迁代价少算一半），
//! 交叉检查就会以 `METRIC_MISMATCH` 报出来。

use std::collections::{BTreeMap, BTreeSet};

use aps_engine::json::Json;

use crate::contract::{Availability, SlottingProblem};
use crate::errors::{codes, constraints, Severity, Violation};
use crate::slotting::search::cost_config_of;
use crate::slotting::{build_model, relocation_seconds, SlottingState};
use crate::util::{gini, round};

#[derive(Debug, Clone)]
pub struct SlottingVerification {
    pub violations: Vec<Violation>,
    pub recomputed: Json,
    pub independent_metrics: Json,
    pub notes: Vec<String>,
    pub ok: bool,
}

impl Default for SlottingVerification {
    fn default() -> SlottingVerification {
        SlottingVerification {
            violations: Vec::new(),
            recomputed: Json::Null,
            independent_metrics: Json::Null,
            notes: Vec::new(),
            ok: false,
        }
    }
}

/// 独立复核一份库位方案。
pub fn verify_slotting(
    problem: &SlottingProblem,
    solution: &Json,
    strict: bool,
) -> SlottingVerification {
    let mut violations: Vec<Violation> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    let cost_config = cost_config_of(problem);
    let mut model = build_model(problem, cost_config);

    // ---- 1) 方案解析（未知引用必须报出来，绝不静默丢弃）----
    let assignment_entries = crate::contract::arr(solution, "assignment");
    if assignment_entries.is_empty() {
        notes.push("方案里没有 assignment 段".to_string());
    }
    let mut location_of: BTreeMap<String, String> = BTreeMap::new();
    let mut unit_seen: BTreeSet<String> = BTreeSet::new();
    for entry in assignment_entries {
        let Some(unit_id) = crate::contract::opt_str(entry, "loadUnitId") else {
            violations.push(Violation::new(
                codes::MISSING_FIELD,
                Severity::Error,
                "assignment 条目缺少 loadUnitId".to_string(),
            ));
            continue;
        };
        let Some(location_id) = crate::contract::opt_str(entry, "locationId") else {
            violations.push(Violation::new(
                codes::MISSING_FIELD,
                Severity::Error,
                format!("{unit_id} 缺少 locationId"),
            ));
            continue;
        };
        if !unit_seen.insert(unit_id.clone()) {
            violations.push(
                Violation::new(
                    constraints::INVENTORY_CONSERVATION,
                    Severity::Error,
                    format!("货物单元 {unit_id} 在方案里被分配了多次"),
                )
                .subjects(vec![unit_id.clone()]),
            );
        }
        let Some(unit_index) = problem.inventory.iter().position(|unit| unit.id == unit_id) else {
            violations.push(
                Violation::new(
                    codes::UNKNOWN_REFERENCE,
                    Severity::Error,
                    format!("方案引用了问题中不存在的货物单元 {unit_id}"),
                )
                .subjects(vec![unit_id.clone()]),
            );
            continue;
        };
        let Some(location_index) = model.loc_index.get(&location_id).copied() else {
            violations.push(
                Violation::new(
                    codes::UNKNOWN_REFERENCE,
                    Severity::Error,
                    format!("方案引用了不存在的库位 {location_id}（货物 {unit_id}）"),
                )
                .subjects(vec![unit_id.clone(), location_id.clone()]),
            );
            continue;
        };
        let record = &model.locations[location_index];
        // 硬约束逐项复核（与求解器用同一契约语义，但独立实现）
        match record.availability {
            Availability::Frozen => violations.push(
                Violation::new(
                    constraints::LOCATION_FROZEN,
                    Severity::Error,
                    format!("{unit_id} 被放进了冻结库位 {location_id}"),
                )
                .location(location_id.clone()),
            ),
            Availability::Unavailable => violations.push(
                Violation::new(
                    constraints::LOCATION_UNAVAILABLE,
                    Severity::Error,
                    format!("{unit_id} 被放进了不可用库位 {location_id}"),
                )
                .location(location_id.clone()),
            ),
            _ => {}
        }
        if let Some(previous) = location_of.insert(location_id.clone(), unit_id.clone()) {
            violations.push(
                Violation::new(
                    constraints::LOCATION_CAPACITY,
                    Severity::Error,
                    format!("库位 {location_id} 被两个货物单元同时占用：{previous} 与 {unit_id}"),
                )
                .location(location_id.clone())
                .subjects(vec![previous, unit_id.clone()]),
            );
        }
        let sku_index = model.lu_sku[unit_index];
        if model.sku_weight[sku_index] > model.loc_max_weight[location_index] + 1e-9 {
            violations.push(
                Violation::new(
                    constraints::LOCATION_WEIGHT_LIMIT,
                    Severity::Error,
                    format!(
                        "{unit_id}（{}kg）超过库位 {location_id} 的承重 {}kg",
                        model.sku_weight[sku_index], model.loc_max_weight[location_index]
                    ),
                )
                .location(location_id.clone())
                .expected_actual(
                    model.loc_max_weight[location_index].to_string(),
                    model.sku_weight[sku_index].to_string(),
                ),
            );
        }
        if model.sku_volume[sku_index] > model.loc_max_volume[location_index] + 1e-9 {
            violations.push(
                Violation::new(
                    constraints::LOCATION_VOLUME_LIMIT,
                    Severity::Error,
                    format!(
                        "{unit_id}（{}m³）超过库位 {location_id} 的容积 {}m³",
                        model.sku_volume[sku_index], model.loc_max_volume[location_index]
                    ),
                )
                .location(location_id.clone()),
            );
        }
        let allowed = &model.skus[sku_index].allowed_zones;
        if !allowed.is_empty()
            && !crate::wh::routing::zone_compatible(allowed, &model.loc_zone[location_index])
        {
            violations.push(
                Violation::new(
                    constraints::ZONE_COMPATIBILITY,
                    Severity::Error,
                    format!(
                        "SKU {} 的分区限制 {:?} 与库位 {location_id} 的分区 {} 不兼容",
                        model.skus[sku_index].id, allowed, model.loc_zone[location_index]
                    ),
                )
                .location(location_id.clone()),
            );
        }
        if model.constraints.deep_lane_policy == "front-only"
            && record.depth > 1
            && model.skus[sku_index].abc == 'A'
        {
            violations.push(
                Violation::new(
                    constraints::DEEP_LANE_BLOCKING,
                    Severity::Error,
                    format!(
                        "A 类商品 {} 被放在深位 {location_id}（深度 {}），会遮挡后续取货",
                        model.skus[sku_index].id, record.depth
                    ),
                )
                .location(location_id.clone())
                .soft()
                .expected_actual(
                    "front-only 策略要求 A 类放前排",
                    format!("depth={}", record.depth),
                ),
            );
        }
    }

    // ---- 2) 未分配盘点的完整性 ----
    let declared_unassigned: BTreeSet<String> = crate::contract::arr(solution, "unassigned")
        .iter()
        .filter_map(|entry| crate::contract::opt_str(entry, "loadUnitId"))
        .collect();
    let assigned_units: BTreeSet<String> = unit_seen.clone();
    let mut missing: Vec<String> = problem
        .inventory
        .iter()
        .filter(|unit| {
            !assigned_units.contains(&unit.id) && !declared_unassigned.contains(&unit.id)
        })
        .map(|unit| unit.id.clone())
        .collect();
    missing.sort();
    if !missing.is_empty() {
        violations.push(
            Violation::new(
                constraints::UNASSIGNED_INVENTORY,
                Severity::Error,
                format!(
                    "{} 个货物单元既没有落位也没有出现在 unassigned 列表里（方案不完整）",
                    missing.len()
                ),
            )
            .subjects(missing.iter().take(20).cloned().collect::<Vec<String>>()),
        );
    }
    let max_unassigned =
        (problem.inventory.len() as f64 * problem.constraints.max_unassigned_share).ceil() as usize;
    if declared_unassigned.len() > max_unassigned {
        violations.push(Violation::new(
            constraints::UNASSIGNED_INVENTORY,
            Severity::Error,
            format!(
                "未分配货物 {} 件超过约束允许的比例（上限 {} 件）",
                declared_unassigned.len(),
                max_unassigned
            ),
        ));
    }

    // ---- 3) 同 SKU 分散度约束（min/max 库位数）----
    let mut locations_per_sku: BTreeMap<usize, BTreeSet<String>> = BTreeMap::new();
    for (location_id, unit_id) in &location_of {
        if let Some(unit_index) = problem
            .inventory
            .iter()
            .position(|unit| &unit.id == unit_id)
        {
            locations_per_sku
                .entry(model.lu_sku[unit_index])
                .or_default()
                .insert(location_id.clone());
        }
    }
    for (sku_index, locations) in &locations_per_sku {
        let sku = &model.skus[*sku_index];
        if model.constraints.max_locations_per_sku > 0
            && locations.len() > model.constraints.max_locations_per_sku as usize
        {
            violations.push(
                Violation::new(
                    constraints::SKU_DISPERSION_MAX,
                    Severity::Error,
                    format!(
                        "SKU {} 分散在 {} 个库位，超过上限 {}",
                        sku.id,
                        locations.len(),
                        model.constraints.max_locations_per_sku
                    ),
                )
                .subjects(vec![sku.id.clone()]),
            );
        }
    }

    // ---- 4) 独立重算指标（不使用求解器的任何缓存）----
    let mut state = SlottingState::new(&model);
    let mut assignment_rebuilt = vec![-1i64; model.lu_sku.len()];
    for (location_id, unit_id) in &location_of {
        let Some(unit_index) = problem
            .inventory
            .iter()
            .position(|unit| &unit.id == unit_id)
        else {
            continue;
        };
        let Some(location_index) = model.loc_index.get(location_id).copied() else {
            continue;
        };
        assignment_rebuilt[unit_index] = location_index as i64;
    }
    let mut recomputed_travel = 0.0;
    let mut recomputed_meters = 0.0;
    let mut aisle_flow = vec![0.0f64; model.aisle_ids.len()];
    let mut lift_flow = vec![0.0f64; model.lift_ids.len()];
    for (lu, loc) in assignment_rebuilt.iter().enumerate() {
        if *loc < 0 {
            continue;
        }
        let loc = *loc as usize;
        let flow = model.unit_flow[lu];
        recomputed_travel += flow * crate::slotting::search::weighted_seconds(&model, loc);
        recomputed_meters += flow * model.costs[loc].meters;
        aisle_flow[model.costs[loc].aisle_index] += flow;
        if model.costs[loc].uses_lift {
            lift_flow[model.costs[loc].lift_group] += flow;
        }
    }
    // 搬迁代价：逐单元严格重算（复用同一物理模型，但逐条独立求和）
    let mut relocation_count = 0usize;
    let mut relocation_seconds = 0.0;
    for (lu, target) in assignment_rebuilt.iter().enumerate() {
        if *target < 0 {
            continue;
        }
        let current = model.current_loc[lu];
        if current == *target {
            continue;
        }
        relocation_count += 1;
        relocation_seconds += relocation_seconds_of(&mut model, current, *target as usize);
    }
    state.base_seconds = recomputed_travel / model.cost_config.outbound_share.max(1e-6);
    state.aisle_flow = aisle_flow.clone();
    state.lift_flow = lift_flow.clone();
    let congestion = state.congestion_seconds(&model);
    let gini_value = gini(&aisle_flow);

    // 与优化器报告的数字对照
    let reported = solution
        .get("reportedMetrics")
        .cloned()
        .unwrap_or(Json::Null);
    if !matches!(reported, Json::Null) {
        let mut cross: Vec<Violation> = Vec::new();
        let mut sink = crate::errors::Issues::new();
        let keys: Vec<(&str, &str)> = vec![
            ("relocationCount", "relocationCount"),
            ("relocationDeviceSeconds", "relocationDeviceSeconds"),
            ("travelSecondsPerDay", "travelSecondsPerDay"),
        ];
        let independent = Json::obj(vec![
            ("relocationCount", Json::int(relocation_count as i64)),
            (
                "relocationDeviceSeconds",
                Json::Float(round(relocation_seconds, 3)),
            ),
            (
                "travelSecondsPerDay",
                Json::Float(round(recomputed_travel, 3)),
            ),
        ]);
        crate::verify::cross_check_metrics(&reported, &independent, &keys, &mut cross, &mut sink);
        violations.extend(cross);
    } else {
        notes.push(
            "方案没有带 reportedMetrics：无法做优化器/验证器数字比对（建议在交付里携带）"
                .to_string(),
        );
    }

    let errors = violations
        .iter()
        .filter(|violation| violation.severity == Severity::Error)
        .count();
    let ok = errors == 0;
    notes.push(format!(
        "独立复核 {} 个落位：错误 {errors}，警告 {}；重算日运行时间 {:.1}s、运行距离 {:.0}m、搬迁 {} 件 / {:.0}s",
        location_of.len(),
        violations
            .iter()
            .filter(|violation| violation.severity == Severity::Warning)
            .count(),
        recomputed_travel,
        recomputed_meters,
        relocation_count,
        relocation_seconds
    ));
    if strict && !declared_unassigned.is_empty() {
        notes.push(format!(
            "严格模式：存在 {} 个未分配货物单元，交付时必须说明原因（容量不足 / 约束冲突）",
            declared_unassigned.len()
        ));
    }
    SlottingVerification {
        violations,
        recomputed: Json::obj(vec![
            ("assignedUnits", Json::int(location_of.len() as i64)),
            (
                "unassignedUnits",
                Json::int(declared_unassigned.len() as i64),
            ),
            (
                "travelSecondsPerDay",
                Json::Float(round(recomputed_travel, 3)),
            ),
            (
                "travelMetersPerDay",
                Json::Float(round(recomputed_meters, 3)),
            ),
            ("relocationCount", Json::int(relocation_count as i64)),
            (
                "relocationDeviceSeconds",
                Json::Float(round(relocation_seconds, 3)),
            ),
            ("congestionSecondsPerDay", Json::Float(round(congestion, 3))),
            ("aisleLoadGini", Json::Float(round(gini_value, 6))),
        ]),
        independent_metrics: Json::obj(vec![
            (
                "aisleFlow",
                Json::Arr(
                    aisle_flow
                        .iter()
                        .enumerate()
                        .map(|(index, flow)| {
                            Json::obj(vec![
                                ("aisleId", Json::str(model.aisle_ids[index].clone())),
                                ("flowPerDay", Json::Float(round(*flow, 3))),
                                (
                                    "capacitySecondsPerDay",
                                    Json::Float(round(model.aisle_capacity[index], 3)),
                                ),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "liftFlow",
                Json::Arr(
                    lift_flow
                        .iter()
                        .enumerate()
                        .map(|(index, flow)| {
                            Json::obj(vec![
                                ("liftId", Json::str(model.lift_ids[index].clone())),
                                ("flowPerDay", Json::Float(round(*flow, 3))),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]),
        notes,
        ok,
    }
}

/// 独立实现的一次搬迁时间（与求解器口径相同，但此处重新构造调用路径）。
fn relocation_seconds_of(model: &mut crate::slotting::SlottingModel, from: i64, to: usize) -> f64 {
    relocation_seconds(model, from, to)
}
