//! 动态重优化：把"计划赶不上变化"变成显式事件驱动的增量调整（SRS §3.2E / §4.3）。
//!
//! 处理原则：
//! 1. **先应用事件、再求解**：需求/库存/可用性的变化先落到问题的显式字段上，
//!    这样结果里的每个数字都能追溯到某个事件；
//! 2. **热启动**：上一版方案里仍然合法且仍然便宜的库位保持不变 —— 动态优化的价值
//!    恰恰体现在"少搬"上，所以搬迁代价是硬性比较项；
//! 3. **事件留痕**：每条迁移建议都带 `trigger`（哪个事件、什么时刻、为什么）。

use std::collections::BTreeMap;

use aps_engine::json::Json;

use crate::contract::{DynamicEvent, SlottingProblem};
use crate::errors::Status;
use crate::slotting::search::{self, SearchOutcomeInternal, SearchStats, Weights};
use crate::slotting::{SlottingModel, SlottingSolveOptions, SlottingState};
use crate::util::{round, seed_from, Rng};

/// 已应用的事件记录（写入结果的 `events` 段，供时间线回放）。
#[derive(Debug, Clone)]
pub struct AppliedEvent {
    pub kind: String,
    pub at_s: f64,
    pub detail: String,
    pub affected: Vec<String>,
}

/// 把事件应用到问题上：需求偏移 / 促销 / 临时入库 / 出库取消 / 库位冻结 / 设备降级。
pub fn apply_events(problem: &mut SlottingProblem, events: &[DynamicEvent]) -> Vec<AppliedEvent> {
    let mut applied = Vec::new();
    for event in events {
        let mut affected: Vec<String> = Vec::new();
        let detail = match event.kind.as_str() {
            "demand-shift" | "seasonal-shift" | "forecast-update" => {
                let factor = if event.value > 0.0 { event.value } else { 1.0 };
                if event.task_ids.is_empty() && event.device_ids.is_empty() {
                    // 全局偏移
                    for sku in problem.skus.iter_mut() {
                        sku.mean_daily_demand = round(sku.mean_daily_demand * factor, 4);
                        affected.push(sku.id.clone());
                    }
                    format!("全品类日均需求 ×{factor:.2}")
                } else {
                    for sku in problem.skus.iter_mut() {
                        if event.task_ids.contains(&sku.id) {
                            sku.mean_daily_demand = round(sku.mean_daily_demand * factor, 4);
                            affected.push(sku.id.clone());
                        }
                    }
                    format!("{} 个 SKU 日均需求 ×{factor:.2}", affected.len())
                }
            }
            "urgent-inbound" | "inventory-arrival" => {
                // 新货物单元：按 payload 里声明的 SKU 追加（数量缺省 1）
                let sku_id = crate::contract::opt_str(&event.payload, "skuId")
                    .or_else(|| event.task_ids.first().cloned());
                match sku_id {
                    Some(sku_id) => {
                        let quantity =
                            crate::contract::opt_f64(&event.payload, "quantity").unwrap_or(1.0);
                        let id = format!("LU-DYN-{}", problem.inventory.len() + 1);
                        problem.inventory.push(crate::contract::InventoryUnit {
                            id: id.clone(),
                            sku_id: sku_id.clone(),
                            quantity,
                            batch: crate::contract::opt_str(&event.payload, "batch")
                                .unwrap_or_else(|| "DYN".to_string()),
                            inbound_at_s: event.at_s,
                            expires_at_s: None,
                            location_id: None,
                            status: "in-transit".to_string(),
                            returned: false,
                        });
                        affected.push(id);
                        format!("临时入库：SKU {sku_id} ×{quantity}")
                    }
                    None => "临时入库事件缺少 skuId，已忽略".to_string(),
                }
            }
            "inventory-removal" | "outbound-shipped" => {
                let before = problem.inventory.len();
                problem
                    .inventory
                    .retain(|unit| !event.task_ids.contains(&unit.id));
                format!("移除 {} 个已出库货物单元", before - problem.inventory.len())
            }
            "location-freeze" | "aisle-closure" | "maintenance" => {
                // 冻结语义直接落到拓扑上：被冻结的库位在建模阶段就不进入候选集
                let mut frozen: Vec<String> = event.location_ids.clone();
                if !event.link_ids.is_empty() {
                    let locations = crate::wh::topology::derive_locations(&problem.topology);
                    for location in locations {
                        if event.link_ids.contains(&location.aisle_id) {
                            frozen.push(location.id);
                        }
                    }
                }
                frozen.sort();
                frozen.dedup();
                for id in &frozen {
                    problem.topology.frozen_locations.insert(id.clone());
                }
                affected = frozen;
                format!(
                    "冻结 {} 个库位（含 {} 条巷道的全部库位）：这些位置不再参与优化",
                    affected.len(),
                    event.link_ids.len()
                )
            }
            "device-breakdown" | "speed-degradation" => {
                let factor = if event.value > 0.0 {
                    event.value.clamp(0.05, 1.0)
                } else {
                    0.5
                };
                let mut count = 0usize;
                for device in problem.topology.devices.iter_mut() {
                    if event.device_ids.is_empty() || event.device_ids.contains(&device.id) {
                        device.motion.speed_mps = round(device.motion.speed_mps * factor, 4);
                        count += 1;
                        affected.push(device.id.clone());
                    }
                }
                format!("{count} 台设备速度 ×{factor:.2}（调度时间随之上升）")
            }
            "order-cancel" | "task-cancel" => {
                let before = problem.history.len();
                problem
                    .history
                    .retain(|order| !event.task_ids.contains(&order.id));
                format!("取消 {} 张订单", before - problem.history.len())
            }
            other => format!("未识别的事件类型 {other}（已跳过，不会静默改变模型）"),
        };
        applied.push(AppliedEvent {
            kind: event.kind.clone(),
            at_s: round(event.at_s, 3),
            detail,
            affected,
        });
    }
    applied
}

/// 动态重优化入口：热启动 + 预算内的邻域改良，输出带事件留痕的调整方案。
pub fn dynamic(
    model: &mut SlottingModel,
    problem: &SlottingProblem,
    events: &[DynamicEvent],
    _options: &SlottingSolveOptions,
    weights: &Weights,
    seed: u64,
    budget_ms: f64,
) -> SearchOutcomeInternal {
    let started = crate::engine::now_ms();
    // 1) 热启动：把上一版方案映射到当前模型
    let warm = warm_start_assignment(model);
    let initial = if warm.iter().any(|loc| *loc >= 0) {
        search::fill_gaps(model, warm, seed)
    } else {
        search::greedy_initial(model, seed)
    };
    let mut state = SlottingState::rebuild(model, &initial);
    let mut stats = SearchStats::default();
    let mut rng = Rng::new(seed_from(&["dynamic", &seed.to_string()]));
    let deadline = started + budget_ms.max(50.0) * 0.9;
    let keep_ratio = problem.algorithm.migration_max_moves as f64;
    let mut iterations = 0u64;
    let mut improved = 0u64;
    let mut current = search::fast_scalar(model, &state, weights);
    let mut best = current;
    let mut best_state = state.clone_state();
    // 2) 局部改良：只接受"搬迁预算之内"的移动，避免动态调整把仓库搬空
    while crate::engine::now_ms() < deadline && !crate::engine::cancel_requested() {
        iterations += 1;
        let Some(candidate_move) = search::random_move_public(model, &state, &mut rng) else {
            break;
        };
        if !search::legal_move_public(model, &state, candidate_move) {
            continue;
        }
        let snapshot = state.clone_state();
        search::apply_move_public(model, &mut state, candidate_move);
        if state.relocation_count as f64 > keep_ratio
            && state.relocation_count > snapshot.relocation_count
        {
            state = snapshot;
            continue;
        }
        let value = search::fast_scalar(model, &state, weights);
        if value < current - 1e-9 {
            current = value;
            improved += 1;
            if value < best - 1e-9 {
                best = value;
                best_state = state.clone_state();
            }
        } else {
            state = snapshot;
        }
        if iterations % 2000 == 0 {
            stats.trace.push(round(best, 6));
            if stats.trace.len() > 256 {
                stats.trace.remove(0);
            }
        }
    }
    // 3) 事件留痕：把触发信息挂到搬迁动作上
    stats.iterations = iterations;
    stats.best_iteration = improved;
    stats.elapsed_ms = round(crate::engine::now_ms() - started, 3);
    stats
        .operators
        .entry("动态改良接受次数".to_string())
        .or_insert(improved);
    stats
        .operators
        .entry("事件数".to_string())
        .or_insert(events.len() as u64);
    SearchOutcomeInternal {
        state: best_state,
        stats,
        pareto: Vec::new(),
        status: Status::FeasibleWithBound,
        optimality: Some(search::OptimalityReport {
            proven: false,
            scope:
                "动态重优化（事件驱动 + 热启动）：不提供最优性证明；只保证结果满足搬迁预算与全部硬约束"
                    .to_string(),
            bound: None,
            gap: None,
            method: "事件驱动热启动 + 邻域改良".to_string(),
        }),
    }
}

/// 上一版方案 → 当前模型的库位映射（库位不存在或已冻结则为 -1）。
pub fn warm_start_assignment(model: &SlottingModel) -> Vec<i64> {
    let mut assignment = vec![-1i64; model.lu_sku.len()];
    for (lu, unit) in model.problem.inventory.iter().enumerate() {
        let Some(location_id) = &unit.location_id else {
            continue;
        };
        if let Some(index) = model.loc_index.get(location_id) {
            if crate::slotting::can_place(model, lu, *index).is_ok() {
                assignment[lu] = *index as i64;
            }
        }
    }
    assignment
}

/// 事件时间线（供实验室播放：事件 → 决策 → 结果）。
pub fn event_timeline(
    applied: &[AppliedEvent],
    migrations: &[crate::slotting::MigrationAction],
) -> Json {
    let mut items: Vec<Json> = applied
        .iter()
        .map(|event| {
            Json::obj(vec![
                ("at_s", Json::Float(event.at_s)),
                ("kind", Json::str(event.kind.clone())),
                ("detail", Json::str(event.detail.clone())),
                ("affected", Json::strings(event.affected.clone())),
                ("type", Json::str("event")),
            ])
        })
        .collect();
    for action in migrations.iter().filter(|action| action.requires_dispatch) {
        items.push(Json::obj(vec![
            (
                "at_s",
                Json::Float(action.trigger.as_ref().map(|t| t.1).unwrap_or(0.0)),
            ),
            ("kind", Json::str("migration")),
            (
                "detail",
                Json::str(format!(
                    "{} → {}：{}",
                    action
                        .from_location_id
                        .clone()
                        .unwrap_or_else(|| "未上架".to_string()),
                    action.to_location_id,
                    action.reason
                )),
            ),
            ("loadUnitId", Json::str(action.load_unit_id.clone())),
            (
                "estimatedDeviceSeconds",
                Json::Float(action.estimated_device_seconds),
            ),
            (
                "trigger",
                match &action.trigger {
                    Some((kind, at_s, detail)) => Json::obj(vec![
                        ("kind", Json::str(kind.clone())),
                        ("at_s", Json::Float(*at_s)),
                        ("detail", Json::str(detail.clone())),
                    ]),
                    None => Json::Null,
                },
            ),
            ("type", Json::str("task")),
        ]));
    }
    Json::obj(vec![
        ("items", Json::Arr(items)),
        ("eventCount", Json::int(applied.len() as i64)),
    ])
}

/// 触发原因 → 迁移动作的绑定（结果里每条搬迁都能回答"为什么发生"）。
pub fn bind_triggers(
    applied: &[AppliedEvent],
    migrations: &mut [crate::slotting::MigrationAction],
    sku_of_unit: &BTreeMap<String, String>,
) {
    if applied.is_empty() {
        return;
    }
    for action in migrations.iter_mut() {
        // 优先绑定"与同一 SKU 相关"的事件，其次绑定时间最早的事件
        let sku = sku_of_unit
            .get(&action.load_unit_id)
            .cloned()
            .unwrap_or_default();
        let matched = applied
            .iter()
            .find(|event| event.affected.contains(&sku))
            .or_else(|| applied.first());
        if let Some(event) = matched {
            action.trigger = Some((event.kind.clone(), event.at_s, event.detail.clone()));
        }
    }
}
