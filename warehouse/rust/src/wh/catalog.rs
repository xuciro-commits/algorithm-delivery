//! 商品目录、库存与订单流生成（SRS §2.2 / §2.3 / §8.1）。
//!
//! 生成的数据必须能表达工业现实，而不是均匀随机：
//! * 需求形态：`uniform` / `abc` / `zipf` / `long-tail` / `bimodal` / `seasonal`；
//! * 关联结构：同簇 SKU 被有意设计为共同出库（关联性库位优化的验证信号）；
//! * 尺寸 / 重量 / 温控 / 危险品 / 批次：带来真实的储存兼容性与承载约束；
//! * 库存不均衡：热门 SKU 多库位、慢销 SKU 单库位、退货与新货混入；
//! * 订单负载：高峰非均匀、多 SKU 订单、长尾商品、突发峰值与预约出库。
//!
//! 全部生成都是**确定性**的：同参数 + 同种子 → 完全一致的目录、库存与订单（SRS §6.3）。

use crate::contract::{CustomerOrder, DemandProfile, InventoryUnit, OrderLine, SkuSpec};
use crate::util::{round, seed_from, Rng};

/// 目录生成参数。
#[derive(Debug, Clone)]
pub struct CatalogParams {
    pub skus: usize,
    pub shape: String,
    /// 总库位数（库存规模的参照 —— 库存必须落在真实库位上）。
    pub locations: usize,
    /// 目标库位占用率（0–1）：用于"接近占满""只有少量空位"等场景。
    pub target_occupancy: f64,
    pub seed: u64,
    pub affinity_clusters: usize,
    pub affinity_cluster_size: usize,
    pub zipf_exponent: f64,
    pub tail_share: f64,
    pub chilled_share: f64,
    pub frozen_share: f64,
    pub hazmat_share: f64,
    pub batch_share: f64,
    pub returned_share: f64,
    pub demand_cv: f64,
    pub seasonal: bool,
    pub manual_capacity: usize,
    pub size_profile: String,
}

impl Default for CatalogParams {
    fn default() -> Self {
        CatalogParams {
            skus: 200,
            shape: "abc".to_string(),
            locations: 2000,
            target_occupancy: 0.8,
            seed: 1,
            affinity_clusters: 0,
            affinity_cluster_size: 10,
            zipf_exponent: 1.1,
            tail_share: 0.8,
            chilled_share: 0.0,
            frozen_share: 0.0,
            hazmat_share: 0.0,
            batch_share: 0.0,
            returned_share: 0.02,
            demand_cv: 0.4,
            seasonal: false,
            manual_capacity: 0,
            size_profile: "mixed".to_string(),
        }
    }
}

/// 尺寸族：不同场景下货品尺寸差异极大（S04 尺寸匹配 / S05 承载限制）。
fn size_family(profile: &str) -> Vec<[f64; 4]> {
    match profile {
        "uniform-small" => vec![[0.8, 0.6, 0.4, 12.0], [0.8, 0.6, 0.5, 18.0]],
        "heavy-bulk" => vec![
            [1.2, 1.0, 1.0, 620.0],
            [1.2, 1.1, 1.2, 880.0],
            [1.0, 0.9, 0.9, 320.0],
        ],
        "oversized-mix" => vec![
            [1.3, 1.2, 1.6, 260.0],
            [1.3, 1.2, 2.1, 380.0],
            [0.9, 0.7, 0.5, 22.0],
        ],
        _ => vec![
            [1.0, 0.8, 0.6, 25.0],
            [1.2, 0.9, 0.8, 60.0],
            [0.8, 0.6, 0.4, 10.0],
            [1.1, 1.0, 1.1, 140.0],
        ],
    }
}

/// 电商仓典型的小时到达曲线（双峰：上午 10–12 点、晚间 19–21 点）。
pub fn default_hourly_factor() -> Vec<f64> {
    vec![
        0.25, 0.18, 0.14, 0.12, 0.12, 0.20, 0.40, 0.72, 1.00, 1.25, 1.45, 1.40, 1.05, 1.00, 1.05,
        1.10, 1.20, 1.35, 1.50, 1.35, 1.00, 0.70, 0.45, 0.32,
    ]
}

#[derive(Debug, Clone)]
pub struct CatalogStats {
    pub skus: usize,
    pub load_units: usize,
    pub total_pieces: f64,
    pub abc: [usize; 3],
    pub xyz: [usize; 3],
    pub affinity_edges: usize,
    pub hot_share: f64,
    pub avg_volume_m3: f64,
    pub avg_weight_kg: f64,
    pub heaviest_kg: f64,
}

#[derive(Debug, Clone)]
pub struct CatalogBundle {
    pub skus: Vec<SkuSpec>,
    pub inventory: Vec<InventoryUnit>,
    pub demand: DemandProfile,
    pub stats: CatalogStats,
}

/// 生成 SKU 目录与库存。
///
/// 需求权重按形态生成后归一化，再按权重切分总库存单元数，
/// 保证"库存数量与库位数一致"（不会出现 100 个库位放 5000 个托盘）。
pub fn generate_catalog(params: &CatalogParams) -> CatalogBundle {
    let mut rng = Rng::new(seed_from(&[
        "catalog",
        &params.seed.to_string(),
        &params.skus.to_string(),
        &params.shape,
    ]));
    let sizes = size_family(&params.size_profile);
    let n = params.skus.max(1);

    // ---- 需求权重 ----
    let mut weights: Vec<f64> = Vec::with_capacity(n);
    for i in 0..n {
        let rank = (i + 1) as f64;
        let w = match params.shape.as_str() {
            "uniform" => 1.0,
            "zipf" => 1.0 / rank.powf(params.zipf_exponent),
            "abc" => {
                let tier = rank / n as f64;
                if tier < 0.2 {
                    8.0
                } else if tier < 0.5 {
                    2.2
                } else {
                    0.35
                }
            }
            "long-tail" => {
                let head = ((n as f64) * (1.0 - params.tail_share)).max(1.0);
                if rank <= head {
                    1.0 / rank.powf(0.9)
                } else {
                    0.02 + rng.next_f64() * 0.02
                }
            }
            "bimodal" => {
                if rng.next_f64() < 0.25 {
                    6.0 + rng.next_f64() * 4.0
                } else {
                    0.15 + rng.next_f64() * 0.2
                }
            }
            "seasonal" => 1.0 / rank.powf(1.05),
            _ => 1.0,
        };
        weights.push(w.max(0.01));
    }
    let weight_sum: f64 = weights.iter().sum();
    let total_units =
        ((params.locations as f64) * params.target_occupancy.clamp(0.05, 0.995)).round() as usize;
    let total_units = total_units.max(1);

    let mut skus: Vec<SkuSpec> = Vec::with_capacity(n);
    let mut pieces = 0.0f64;
    for i in 0..n {
        let rank = i + 1;
        let share = weights[i] / weight_sum;
        let size = sizes[rng.below(sizes.len())];
        let cv_base = params.demand_cv * if params.shape == "uniform" { 0.6 } else { 1.0 };
        let cv = (cv_base * (0.6 + rng.next_f64() * 0.9)).max(0.05);
        let abc = if share * n as f64 > 4.0 {
            'A'
        } else if share * n as f64 > 1.0 {
            'B'
        } else {
            'C'
        };
        let xyz = if cv < 0.35 {
            'X'
        } else if cv < 0.75 {
            'Y'
        } else {
            'Z'
        };
        let chilled = rng.next_f64() < params.chilled_share;
        let frozen = !chilled && rng.next_f64() < params.frozen_share;
        let hazmat = rng.next_f64() < params.hazmat_share;
        let mut allowed_zones: Vec<String> = Vec::new();
        if frozen {
            allowed_zones.push("ASRS-COLD".to_string());
        } else if chilled {
            allowed_zones.push("ASRS".to_string());
        } else {
            allowed_zones.push("ASRS".to_string());
            allowed_zones.push("ASRS-HIGH".to_string());
            allowed_zones.push("RECV".to_string());
            allowed_zones.push("SHIP".to_string());
        }
        if params.manual_capacity > 0 && !chilled && !frozen && rng.next_f64() < 0.25 {
            allowed_zones.push("PICK".to_string());
        }
        let cluster = if params.affinity_clusters > 0
            && i < params.affinity_clusters * params.affinity_cluster_size.max(1)
        {
            Some(format!(
                "AF-{}",
                i / params.affinity_cluster_size.max(1) + 1
            ))
        } else {
            None
        };
        let mean_daily = ((share * total_units as f64 * 4.0) / 30.0).max(0.5);
        skus.push(SkuSpec {
            id: format!("SKU-{:06}", rank),
            name: format!("商品 {rank}"),
            category: if frozen {
                "冷冻".to_string()
            } else if chilled {
                "冷藏".to_string()
            } else if hazmat {
                "危险品".to_string()
            } else {
                "常温".to_string()
            },
            load_unit: if rng.next_f64() < 0.7 {
                "pallet".to_string()
            } else {
                "tote".to_string()
            },
            unit_weight_kg: round(size[3] * (0.85 + rng.next_f64() * 0.3), 2),
            unit_volume_m3: round(size[0] * size[1] * size[2], 4),
            abc,
            xyz,
            mean_daily_demand: round(mean_daily, 3),
            demand_cv: round(cv, 3),
            allowed_zones,
            temperature: if frozen {
                "frozen".to_string()
            } else if chilled {
                "chilled".to_string()
            } else {
                "ambient".to_string()
            },
            batch_policy: if rng.next_f64() < params.batch_share {
                if rng.next_f64() < 0.5 {
                    "fefo".to_string()
                } else {
                    "fifo".to_string()
                }
            } else {
                "none".to_string()
            },
            affinity_cluster: cluster,
        });
        pieces += mean_daily;
    }

    // ---- 库存单元：按需求权重分配（热门 SKU 多库位）----
    let sku_unit_targets: Vec<usize> = skus
        .iter()
        .map(|sku| {
            let share = (sku.mean_daily_demand
                * if sku.abc == 'A' {
                    1.4
                } else if sku.abc == 'B' {
                    1.0
                } else {
                    0.7
                })
                / pieces.max(1e-6);
            ((total_units as f64 * share * (0.8 + rng.next_f64() * 0.5)).round() as usize).max(1)
        })
        .collect();
    let allocated: usize = sku_unit_targets.iter().sum();
    let scale = if allocated > 0 {
        total_units as f64 / allocated as f64
    } else {
        1.0
    };
    let mut inventory: Vec<InventoryUnit> = Vec::with_capacity(total_units);
    let mut unit_seq = 0usize;
    for (index, sku) in skus.iter().enumerate() {
        let target = ((sku_unit_targets[index] as f64 * scale).round() as usize).max(1);
        for u in 0..target {
            unit_seq += 1;
            let returned = rng.next_f64() < params.returned_share;
            let age_days = rng.next_f64() * 45.0;
            let expires = if sku.temperature == "ambient" {
                None
            } else {
                Some(round((90.0 - age_days) * 86_400.0, 1))
            };
            inventory.push(InventoryUnit {
                id: format!("LU-{unit_seq:07}"),
                sku_id: sku.id.clone(),
                quantity: ((20.0f64 + rng.next_f64() * 80.0).round()),
                batch: format!(
                    "{}-{:02}",
                    &sku.id[sku.id.len().saturating_sub(4)..],
                    u % 3 + 1
                ),
                inbound_at_s: round(-age_days * 86_400.0, 1),
                expires_at_s: expires,
                location_id: None,
                status: if returned {
                    "quarantine".to_string()
                } else {
                    "stored".to_string()
                },
                returned,
            });
        }
    }

    let demand = DemandProfile {
        shape: params.shape.clone(),
        horizon_days: 7,
        hourly_factor: default_hourly_factor(),
        lines_per_order: if params.shape == "uniform" { 1.2 } else { 2.4 },
        lines_per_order_cv: 0.6,
        promo_factor: if params.seasonal { 2.6 } else { 1.0 },
        return_rate: params.returned_share,
    };

    let mut abc = [0usize; 3];
    let mut xyz = [0usize; 3];
    for sku in &skus {
        match sku.abc {
            'A' => abc[0] += 1,
            'B' => abc[1] += 1,
            _ => abc[2] += 1,
        }
        match sku.xyz {
            'X' => xyz[0] += 1,
            'Y' => xyz[1] += 1,
            _ => xyz[2] += 1,
        }
    }
    let affinity_edges =
        ((params.affinity_clusters * params.affinity_cluster_size) as f64 * 1.5) as usize;
    let hot = inventory
        .iter()
        .filter(|unit| {
            skus.iter()
                .find(|s| s.id == unit.sku_id)
                .map(|s| s.abc == 'A')
                .unwrap_or(false)
        })
        .count();
    let stats = CatalogStats {
        skus: skus.len(),
        load_units: inventory.len(),
        total_pieces: inventory.iter().map(|u| u.quantity).sum(),
        abc,
        xyz,
        affinity_edges,
        hot_share: round(hot as f64 / inventory.len().max(1) as f64, 4),
        avg_volume_m3: round(
            skus.iter().map(|s| s.unit_volume_m3).sum::<f64>() / skus.len().max(1) as f64,
            4,
        ),
        avg_weight_kg: round(
            skus.iter().map(|s| s.unit_weight_kg).sum::<f64>() / skus.len().max(1) as f64,
            2,
        ),
        heaviest_kg: skus
            .iter()
            .map(|s| s.unit_weight_kg)
            .fold(0.0f64, |a, b| a.max(b)),
    };

    CatalogBundle {
        skus,
        inventory,
        demand,
        stats,
    }
}

/// 订单生成参数。
#[derive(Debug, Clone)]
pub struct OrderParams {
    pub orders: usize,
    pub seed: u64,
    pub history_days: f64,
    pub future_days: f64,
    pub start_s: f64,
    pub burst: Option<(f64, f64, f64)>,
    pub priority_share: f64,
    pub sla_standard_hours: f64,
    pub sla_express_hours: f64,
    pub appointments: bool,
}

impl Default for OrderParams {
    fn default() -> Self {
        OrderParams {
            orders: 5000,
            seed: 3,
            history_days: 14.0,
            future_days: 1.0,
            start_s: 0.0,
            burst: None,
            priority_share: 0.12,
            sla_standard_hours: 48.0,
            sla_express_hours: 6.0,
            appointments: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct OrderStats {
    pub orders: usize,
    pub lines: usize,
    pub multi_line_share: f64,
    pub express_share: f64,
    pub peak_hour_orders: usize,
    pub avg_lines_per_order: f64,
    pub skus_touched: usize,
}

#[derive(Debug, Clone)]
pub struct OrderBundle {
    pub orders: Vec<CustomerOrder>,
    pub stats: OrderStats,
}

/// 生成订单流（历史 + 未来）。到达强度按小时曲线铺开，保证高峰非均匀（SRS §8）。
pub fn generate_orders(
    params: &OrderParams,
    skus: &[SkuSpec],
    demand: &DemandProfile,
) -> OrderBundle {
    let mut rng = Rng::new(seed_from(&[
        "orders",
        &params.seed.to_string(),
        &params.orders.to_string(),
    ]));
    let total_days = (params.history_days + params.future_days).max(1.0);
    let hourly = if demand.hourly_factor.is_empty() {
        default_hourly_factor()
    } else {
        demand.hourly_factor.clone()
    };
    let weights: Vec<f64> = skus
        .iter()
        .map(|sku| {
            let base = if sku.mean_daily_demand > 0.0 {
                sku.mean_daily_demand
            } else {
                1.0
            };
            let abc_boost = if sku.abc == 'A' {
                3.2
            } else if sku.abc == 'B' {
                1.3
            } else {
                0.5
            };
            base * abc_boost
        })
        .collect();
    let weight_sum: f64 = weights.iter().sum::<f64>().max(1e-9);
    let per_day = params.orders as f64 / total_days;
    // 关联簇成员表（同簇共同出库的强先验，来自目录生成时的真实结构）
    let cluster_members: Vec<Vec<usize>> = {
        let mut clusters: std::collections::BTreeMap<String, Vec<usize>> =
            std::collections::BTreeMap::new();
        for (index, sku) in skus.iter().enumerate() {
            if let Some(cluster) = &sku.affinity_cluster {
                clusters.entry(cluster.clone()).or_default().push(index);
            }
        }
        clusters.into_values().collect()
    };
    let cluster_of: Vec<Option<usize>> = (0..skus.len())
        .map(|i| {
            let key = skus[i].affinity_cluster.clone();
            match key {
                Some(k) => cluster_members.iter().position(|members| {
                    members
                        .iter()
                        .any(|m| skus[*m].affinity_cluster.as_deref() == Some(k.as_str()))
                }),
                None => None,
            }
        })
        .collect();
    let mut orders: Vec<CustomerOrder> = Vec::with_capacity(params.orders);
    let mut seq = 0usize;
    let mut peak_by_hour: Vec<usize> = Vec::new();
    let days = total_days.ceil() as i64;

    for day in 0..days {
        let mut day_total = per_day;
        if demand.promo_factor > 1.0 && (day as f64) >= params.future_days {
            // 促销日：销量上浮（与需求形态一致，不是"凭空翻倍"）
            day_total *= demand.promo_factor.min(3.0);
        }
        if let Some((from, to, factor)) = params.burst {
            if (day as f64) >= from && (day as f64) <= to {
                day_total *= factor;
            }
        }
        let hour_weights: Vec<f64> = hourly
            .iter()
            .map(|f| f * (0.85 + rng.next_f64() * 0.3))
            .collect();
        let hour_sum: f64 = hour_weights.iter().sum::<f64>().max(1e-9);
        for hour in 0..24usize {
            let count = ((day_total * hour_weights[hour]) / hour_sum)
                .round()
                .max(0.0) as usize;
            peak_by_hour.push(count);
            for _ in 0..count {
                seq += 1;
                let express = rng.next_f64() < params.priority_share;
                let release_s = round(
                    params.start_s
                        + day as f64 * 86_400.0
                        + hour as f64 * 3_600.0
                        + rng.next_f64() * 3_600.0,
                    1,
                );
                let sla = if express {
                    params.sla_express_hours
                } else {
                    params.sla_standard_hours
                } * 3_600.0;
                let line_count = {
                    let raw = demand.lines_per_order
                        + rng.normal() * demand.lines_per_order * demand.lines_per_order_cv;
                    (raw.round() as i64).clamp(1, 12) as usize
                };
                let mut lines: Vec<OrderLine> = Vec::new();
                let mut used: Vec<usize> = Vec::new();
                for _ in 0..line_count {
                    if let Some(index) = pick_sku(&mut rng, &weights, weight_sum, &used) {
                        used.push(index);
                        let sku = &skus[index];
                        lines.push(OrderLine {
                            sku_id: sku.id.clone(),
                            quantity: (1.0f64
                                + rng.next_f64() * if sku.abc == 'A' { 6.0 } else { 3.0 })
                            .round()
                            .max(1.0),
                        });
                        // 关联性：同簇 SKU 有较大概率一起出库（关联库位优化的输入信号）
                        if let Some(cluster_index) = cluster_of[index] {
                            if rng.next_f64() < 0.45 {
                                if let Some(members) = cluster_members.get(cluster_index) {
                                    let candidates: Vec<usize> = members
                                        .iter()
                                        .copied()
                                        .filter(|m| !used.contains(m))
                                        .collect();
                                    if !candidates.is_empty() {
                                        let mate = candidates[rng.below(candidates.len())];
                                        used.push(mate);
                                        lines.push(OrderLine {
                                            sku_id: skus[mate].id.clone(),
                                            quantity: (1.0f64 + rng.next_f64() * 3.0)
                                                .round()
                                                .max(1.0),
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
                if lines.is_empty() {
                    continue;
                }
                let appointment = if params.appointments && rng.next_f64() < 0.35 {
                    Some([
                        release_s + 3_600.0,
                        release_s + 3_600.0 + (2.0 + rng.next_f64() * 3.0) * 3_600.0,
                    ])
                } else {
                    None
                };
                orders.push(CustomerOrder {
                    id: format!("SO-{seq:07}"),
                    release_s,
                    due_s: round(release_s + sla, 1),
                    priority: if express {
                        8 + (rng.next_f64() * 3.0) as i64
                    } else {
                        (4.0f64 + rng.normal() * 1.2).round().clamp(1.0, 8.0) as i64
                    },
                    channel: if express {
                        "express".to_string()
                    } else if rng.next_f64() < 0.2 {
                        "store-replenish".to_string()
                    } else {
                        "standard".to_string()
                    },
                    lines,
                    appointment,
                });
            }
        }
    }
    orders.sort_by(|a, b| {
        a.release_s
            .partial_cmp(&b.release_s)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.id.cmp(&b.id))
    });

    let line_count: usize = orders.iter().map(|o| o.lines.len()).sum();
    let multi = orders.iter().filter(|o| o.lines.len() > 1).count();
    let express = orders.iter().filter(|o| o.channel == "express").count();
    let mut touched: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    for order in &orders {
        for line in &order.lines {
            touched.insert(line.sku_id.as_str());
        }
    }
    let stats = OrderStats {
        orders: orders.len(),
        lines: line_count,
        multi_line_share: round(multi as f64 / orders.len().max(1) as f64, 4),
        express_share: round(express as f64 / orders.len().max(1) as f64, 4),
        peak_hour_orders: peak_by_hour.iter().copied().max().unwrap_or(0),
        avg_lines_per_order: round(line_count as f64 / orders.len().max(1) as f64, 3),
        skus_touched: touched.len(),
    };
    OrderBundle { orders, stats }
}

fn pick_sku(rng: &mut Rng, weights: &[f64], weight_sum: f64, used: &[usize]) -> Option<usize> {
    for _ in 0..4 {
        let mut target = rng.next_f64() * weight_sum;
        for (index, weight) in weights.iter().enumerate() {
            target -= weight;
            if target <= 0.0 {
                if used.contains(&index) {
                    break;
                }
                return Some(index);
            }
        }
    }
    None
}

/// 常见场景的目录预设（场景库与实验室共用，避免每个场景各写一遍数字）。
pub fn preset(name: &str) -> CatalogParams {
    let base = CatalogParams::default();
    match name {
        "uniform-small" => CatalogParams {
            shape: "uniform".to_string(),
            size_profile: "uniform-small".to_string(),
            seasonal: false,
            ..base
        },
        "abc-mixed" => CatalogParams {
            shape: "abc".to_string(),
            size_profile: "mixed".to_string(),
            ..base
        },
        "zipf-hot" => CatalogParams {
            shape: "zipf".to_string(),
            zipf_exponent: 1.15,
            size_profile: "mixed".to_string(),
            ..base
        },
        "affinity-clusters" => CatalogParams {
            shape: "zipf".to_string(),
            zipf_exponent: 0.95,
            affinity_clusters: 20,
            affinity_cluster_size: 12,
            size_profile: "mixed".to_string(),
            ..base
        },
        "heavy-oversized" => CatalogParams {
            shape: "abc".to_string(),
            size_profile: "heavy-bulk".to_string(),
            ..base
        },
        "oversized-mix" => CatalogParams {
            shape: "long-tail".to_string(),
            tail_share: 0.8,
            size_profile: "oversized-mix".to_string(),
            ..base
        },
        "seasonal-promo" => CatalogParams {
            shape: "seasonal".to_string(),
            seasonal: true,
            size_profile: "mixed".to_string(),
            ..base
        },
        "chilled-mix" => CatalogParams {
            shape: "abc".to_string(),
            chilled_share: 0.25,
            frozen_share: 0.1,
            size_profile: "mixed".to_string(),
            ..base
        },
        "hazmat-mix" => CatalogParams {
            shape: "abc".to_string(),
            hazmat_share: 0.12,
            size_profile: "heavy-bulk".to_string(),
            ..base
        },
        "batch-fefo" => CatalogParams {
            shape: "zipf".to_string(),
            batch_share: 0.9,
            chilled_share: 0.4,
            size_profile: "mixed".to_string(),
            ..base
        },
        "bimodal-peak" => CatalogParams {
            shape: "bimodal".to_string(),
            size_profile: "mixed".to_string(),
            ..base
        },
        name => {
            let _ = name;
            base
        }
    }
}
