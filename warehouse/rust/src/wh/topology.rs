//! 仓储拓扑生成与库位派生（SRS §2.1 / §2.4）。
//!
//! 三条不可让步的规则（与需求强绑定，可在代码中逐条指认）：
//! 1. **库位由拓扑推导**：`racks × levels × bays × depths`；契约里不接受"直接给库位数"，
//!    也不允许生成与巷道/层/货架结构不一致的数据（SRS §8）；
//! 2. **不同拓扑 ≠ 同一模型**：多层穿梭车 + 货物提升机、四向穿梭车网格、单/双/多深位货架
//!    在设备能力（capability）与可达性上分开表达；
//! 3. **坐标与距离由几何推导**：巷道运行距离、层间提升距离、跨巷横移距离都来自真实尺度。
//!
//! 坐标约定（实验室三维场景直接使用）：
//! * `x` = 巷道长度方向（bay 递进方向）
//! * `y` = 竖直方向（层高递进方向）
//! * `z` = 巷道宽度方向（深度 depth 沿 ±z 递进）

use std::collections::{BTreeMap, BTreeSet};

use aps_engine::json::Json;

use crate::contract::{
    AisleSpec, AreaSpec, Availability, BufferSpec, DeviceCapability, DeviceKind, DeviceSpec,
    LevelSpec, LinkMode, LinkSpec, MotionProfile, NodeSpec, RackKind, RackSpec, StationDirection,
    StationSpec, Topology,
};

/// 拓扑模板：每个模板对应一种真实工业形态（不是"同一套结构换个数量参数"）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TopologyTemplate {
    /// 人工拣选 + 单层货架（对照形态：没有自动化设备）。
    ManualHybrid,
    /// 单深位立库：多层穿梭车 + 货物提升机。
    AsrsSingleDeep,
    /// 双深位立库：整列倒垛，前位遮挡。
    AsrsDoubleDeep,
    /// 多深位密集立库（3–4 深位）。
    AsrsMultiDeep,
    /// 双货架块 + 共享提升机（提升机不可互相穿越）。
    AsrsTwoBlock,
    /// 四向穿梭车网格（横巷交叉口、单车道互斥）。
    AsrsFourWay,
    /// 多区域混合仓（收货 / 拣选 / 立库 / 出库）。
    AsrsHybridMultiArea,
}

impl TopologyTemplate {
    pub fn as_str(self) -> &'static str {
        match self {
            TopologyTemplate::ManualHybrid => "manual-hybrid",
            TopologyTemplate::AsrsSingleDeep => "asrs-single-deep",
            TopologyTemplate::AsrsDoubleDeep => "asrs-double-deep",
            TopologyTemplate::AsrsMultiDeep => "asrs-multi-deep",
            TopologyTemplate::AsrsTwoBlock => "asrs-two-block",
            TopologyTemplate::AsrsFourWay => "asrs-four-way",
            TopologyTemplate::AsrsHybridMultiArea => "asrs-hybrid-multi-area",
        }
    }
    pub fn parse(s: &str) -> TopologyTemplate {
        match s {
            "manual-hybrid" => TopologyTemplate::ManualHybrid,
            "asrs-double-deep" => TopologyTemplate::AsrsDoubleDeep,
            "asrs-multi-deep" => TopologyTemplate::AsrsMultiDeep,
            "asrs-two-block" => TopologyTemplate::AsrsTwoBlock,
            "asrs-four-way" => TopologyTemplate::AsrsFourWay,
            "asrs-hybrid-multi-area" => TopologyTemplate::AsrsHybridMultiArea,
            _ => TopologyTemplate::AsrsSingleDeep,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            TopologyTemplate::ManualHybrid => "人工拣选 + 单层货架",
            TopologyTemplate::AsrsSingleDeep => "单深位立库（多层穿梭车 + 货物提升机）",
            TopologyTemplate::AsrsDoubleDeep => "双深位立库（含整列倒垛）",
            TopologyTemplate::AsrsMultiDeep => "多深位密集立库（3–4 深位，遮挡与临时搬迁）",
            TopologyTemplate::AsrsTwoBlock => "双货架块 + 共享提升机（不可互相穿越）",
            TopologyTemplate::AsrsFourWay => "四向穿梭车网格（横巷交叉口与单车道互斥）",
            TopologyTemplate::AsrsHybridMultiArea => "多区域混合仓（收货 / 拣选 / 立库 / 出库）",
        }
    }
    pub fn is_asrs(self) -> bool {
        !matches!(self, TopologyTemplate::ManualHybrid)
    }
}

/// 拓扑参数（场景生成器与实验室共用；所有尺寸都是真实米制）。
#[derive(Debug, Clone)]
pub struct TopologyParams {
    pub template: TopologyTemplate,
    pub aisles: i32,
    pub levels: i32,
    pub bays: i32,
    pub depths: i32,
    pub shuttles_per_aisle: i32,
    pub lift_mode: String,
    pub lifts_per_block: i32,
    pub include_manual_area: bool,
    pub manual_bays: i32,
    pub inbound_stations: i32,
    pub outbound_stations: i32,
    pub station_buffer: i32,
    pub buffer_capacity: i32,
    pub conveyor_speed_mps: f64,
    pub cross_aisle: bool,
    pub bay_width_m: f64,
    pub level_height_m: f64,
    pub depth_m: f64,
    pub location_width_m: f64,
    pub max_weight_kg: f64,
    pub max_volume_m3: f64,
    pub cross_aisle_width_m: f64,
    pub station_depth_m: f64,
    pub handover_s: f64,
    pub frozen_share: f64,
    pub reserved_share: f64,
}

impl Default for TopologyParams {
    fn default() -> Self {
        TopologyParams {
            template: TopologyTemplate::AsrsSingleDeep,
            aisles: 4,
            levels: 4,
            bays: 24,
            depths: 1,
            shuttles_per_aisle: 1,
            lift_mode: "pallet".to_string(),
            lifts_per_block: 1,
            include_manual_area: false,
            manual_bays: 12,
            inbound_stations: 2,
            outbound_stations: 2,
            station_buffer: 4,
            buffer_capacity: 8,
            conveyor_speed_mps: 0.8,
            cross_aisle: false,
            bay_width_m: 1.4,
            level_height_m: 1.8,
            depth_m: 1.1,
            location_width_m: 1.3,
            max_weight_kg: 1000.0,
            max_volume_m3: 1.6,
            cross_aisle_width_m: 3.2,
            station_depth_m: 6.0,
            handover_s: 12.0,
            frozen_share: 0.0,
            reserved_share: 0.0,
        }
    }
}

impl TopologyParams {
    /// 构造时做拓扑自洽修正（四向必须能走横巷；多深位必须允许整列倒垛）。
    pub fn normalized(mut self) -> TopologyParams {
        // 模板 → 结构参数（模板名字必须真的对应它承诺的结构，否则场景就名不副实）
        match self.template {
            TopologyTemplate::AsrsDoubleDeep => {
                self.depths = self.depths.max(2);
                if self.lift_mode == "pallet" {
                    self.lift_mode = "both".to_string();
                }
            }
            TopologyTemplate::AsrsMultiDeep => {
                self.depths = self.depths.max(3);
                self.lift_mode = "both".to_string();
            }
            TopologyTemplate::AsrsTwoBlock => {
                self.aisles = self.aisles.max(2);
                if self.lift_mode == "pallet" {
                    self.lift_mode = "both".to_string();
                }
            }
            TopologyTemplate::AsrsHybridMultiArea => {
                self.include_manual_area = true;
            }
            _ => {}
        }
        if self.template == TopologyTemplate::AsrsFourWay {
            self.cross_aisle = true;
        }
        if self.template == TopologyTemplate::AsrsTwoBlock && self.lift_mode == "pallet" {
            self.lift_mode = "both".to_string();
        }
        if self.depths >= 2 && self.lift_mode == "shuttle" {
            self.lift_mode = "both".to_string();
        }
        self.aisles = self.aisles.max(1);
        self.levels = self.levels.max(1);
        self.bays = self.bays.max(2);
        self.depths = self.depths.max(1);
        self.shuttles_per_aisle = self.shuttles_per_aisle.max(1);
        self.lifts_per_block = self.lifts_per_block.max(1);
        self
    }
}

/// 派生库位（由拓扑唯一确定，不手工编写）。
#[derive(Debug, Clone)]
pub struct LocationRecord {
    pub id: String,
    pub rack_id: String,
    pub area_id: String,
    pub aisle_id: String,
    pub bay: i32,
    pub level: i32,
    pub depth: i32,
    pub position: [f64; 3],
    pub size: [f64; 3],
    pub max_weight_kg: f64,
    pub max_volume_m3: f64,
    pub availability: Availability,
    pub zone: String,
}

#[derive(Debug, Clone, Default)]
pub struct TopologyStats {
    pub locations: usize,
    pub available_locations: usize,
    pub aisles: usize,
    pub levels: i32,
    pub bays: i32,
    pub depths: i32,
    pub devices: usize,
    pub stations: usize,
    pub footprint_m2: f64,
    pub asrs_volume_m3: f64,
    pub manual_locations: usize,
    pub nodes: usize,
    pub links: usize,
}

/// 拓扑生成结果：拓扑 + 派生库位 + 结构化统计（面板与实验室直接显示，避免前端重算）。
#[derive(Debug, Clone)]
pub struct TopologyBundle {
    pub topology: Topology,
    pub locations: Vec<LocationRecord>,
    pub stats: TopologyStats,
}

pub fn location_id(rack_id: &str, level: i32, bay: i32, depth: i32) -> String {
    format!("{rack_id}-{level}-{bay}-{depth}")
}

fn levels_of(count: i32, height: f64) -> Vec<LevelSpec> {
    (0..count)
        .map(|i| LevelSpec {
            level: i + 1,
            y_m: round4(height * i as f64),
        })
        .collect()
}

fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

/// 生成拓扑（模板 → 区域 / 货架 / 巷道 / 节点 / 通道 / 站台 / 缓存 / 设备）。
///
/// 纯函数：同样的参数必然得到同样的拓扑与同样的库位 id（SRS §6.3 可复现性）。
pub fn build_topology(params: &TopologyParams) -> TopologyBundle {
    let p = params.clone().normalized();
    let mut nodes: Vec<NodeSpec> = Vec::new();
    let mut links: Vec<LinkSpec> = Vec::new();
    let mut racks: Vec<RackSpec> = Vec::new();
    let mut aisles: Vec<AisleSpec> = Vec::new();
    let mut areas: Vec<AreaSpec> = Vec::new();
    let mut stations: Vec<StationSpec> = Vec::new();
    let mut buffers: Vec<BufferSpec> = Vec::new();
    let mut devices: Vec<DeviceSpec> = Vec::new();

    let levels = levels_of(p.levels, p.level_height_m);
    let aisle_length = p.bays as f64 * p.bay_width_m;
    let block_depth = p.depths as f64 * p.depth_m;
    let aisle_pitch = block_depth * 2.0 + 2.0;
    let is_asrs = p.template.is_asrs();
    let has_cross = p.cross_aisle
        || matches!(
            p.template,
            TopologyTemplate::AsrsFourWay | TopologyTemplate::AsrsTwoBlock
        );
    let lanes = p.aisles;
    let total_z = ((lanes - 1) as f64) * aisle_pitch;

    /* ---------------- 区域 ---------------- */
    let asrs_area = AreaSpec {
        id: "AREA-ASRS".to_string(),
        name: "自动化立库区".to_string(),
        kind: "asrs".to_string(),
        center: [aisle_length / 2.0, total_z / 2.0],
        size: [
            aisle_length + p.cross_aisle_width_m * 2.0,
            lanes as f64 * aisle_pitch,
        ],
        height_m: p.levels as f64 * p.level_height_m + 1.2,
    };
    if is_asrs {
        areas.push(asrs_area.clone());
    }
    let inbound_area = AreaSpec {
        id: "AREA-IN".to_string(),
        name: "收货 / 入库区".to_string(),
        kind: "receiving".to_string(),
        center: [
            -(p.cross_aisle_width_m / 2.0 + p.station_depth_m / 2.0 + 1.0),
            asrs_area.center[1],
        ],
        size: [
            p.station_depth_m,
            (lanes as f64 * aisle_pitch * 0.6).max(6.0),
        ],
        height_m: 5.5,
    };
    let outbound_area = AreaSpec {
        id: "AREA-OUT".to_string(),
        name: "出库 / 发运区".to_string(),
        kind: "shipping".to_string(),
        center: [
            aisle_length + p.cross_aisle_width_m / 2.0 + p.station_depth_m / 2.0 + 1.0,
            asrs_area.center[1],
        ],
        size: [
            p.station_depth_m,
            (lanes as f64 * aisle_pitch * 0.6).max(6.0),
        ],
        height_m: 5.5,
    };
    areas.push(inbound_area.clone());
    areas.push(outbound_area.clone());

    let manual_area = if p.include_manual_area {
        let area = AreaSpec {
            id: "AREA-MANUAL".to_string(),
            name: "人工拣选区".to_string(),
            kind: "picking".to_string(),
            center: [
                aisle_length / 2.0,
                -(lanes as f64 * aisle_pitch) / 2.0 - 8.0,
            ],
            size: [aisle_length, 12.0],
            height_m: 3.6,
        };
        areas.push(area.clone());
        Some(area)
    } else {
        None
    };

    /* ---------------- 货架 + 巷道 ---------------- */
    let blocks = if p.template == TopologyTemplate::AsrsTwoBlock {
        2
    } else {
        ((p.aisles as f64) / 4.0).ceil().max(1.0) as i32
    };
    let aisles_per_block = ((p.aisles as f64) / blocks as f64).ceil().max(1.0) as i32;

    for a in 0..p.aisles {
        let aisle_id = format!("A{:02}", a + 1);
        let z_center = (a as f64) * aisle_pitch;
        for side in ["F", "B"] {
            let rack_id = format!("{aisle_id}{side}");
            let sign = if side == "F" { -1.0 } else { 1.0 };
            let z_first = z_center + sign * (1.0 + p.depth_m / 2.0);
            racks.push(RackSpec {
                id: rack_id,
                area_id: if is_asrs {
                    asrs_area.id.clone()
                } else {
                    manual_area
                        .clone()
                        .map(|m| m.id)
                        .unwrap_or_else(|| asrs_area.id.clone())
                },
                aisle_id: aisle_id.clone(),
                kind: if p.depths == 1 {
                    RackKind::SingleDeep
                } else if p.depths == 2 {
                    RackKind::DoubleDeep
                } else {
                    RackKind::MultiDeep
                },
                bays: p.bays,
                depths: p.depths,
                levels: levels.clone(),
                size: [p.location_width_m, p.level_height_m, p.depth_m],
                max_weight_kg: p.max_weight_kg,
                max_volume_m3: p.max_volume_m3,
                origin: [p.bay_width_m / 2.0, levels[0].y_m, round4(z_first)],
                bay_axis: [1.0, 0.0],
                depth_axis: [0.0, sign],
            });
        }
        aisles.push(AisleSpec {
            id: aisle_id.clone(),
            area_id: asrs_area.id.clone(),
            end_node_ids: [format!("N-{aisle_id}-L1-W"), format!("N-{aisle_id}-L1-E")],
            axis: [1.0, 0.0],
            length_m: aisle_length,
            bidirectional: true,
            level: 1,
            rack_ids: vec![format!("{aisle_id}F"), format!("{aisle_id}B")],
        });
    }

    if let Some(manual) = &manual_area {
        racks.push(RackSpec {
            id: "MP01".to_string(),
            area_id: manual.id.clone(),
            aisle_id: "A-MANUAL".to_string(),
            kind: RackKind::Shelving,
            bays: p.manual_bays,
            depths: 1,
            levels: vec![
                LevelSpec { level: 1, y_m: 0.0 },
                LevelSpec { level: 2, y_m: 1.6 },
            ],
            size: [0.8, 1.6, 0.6],
            max_weight_kg: 120.0,
            max_volume_m3: 0.25,
            origin: [
                manual.center[0] - manual.size[0] / 2.0 + 0.6,
                0.0,
                manual.center[1],
            ],
            bay_axis: [1.0, 0.0],
            depth_axis: [0.0, 1.0],
        });
        aisles.push(AisleSpec {
            id: "A-MANUAL".to_string(),
            area_id: manual.id.clone(),
            end_node_ids: ["N-MANUAL-W".to_string(), "N-MANUAL-E".to_string()],
            axis: [1.0, 0.0],
            length_m: p.manual_bays as f64 * 0.8,
            bidirectional: true,
            level: 1,
            rack_ids: vec!["MP01".to_string()],
        });
    }

    /* ---------------- 节点与通道 ---------------- */
    let block_left_x = -p.cross_aisle_width_m / 2.0;
    let block_right_x = aisle_length + p.cross_aisle_width_m / 2.0;

    let mut push_node = |node: NodeSpec| nodes.push(node);
    let node_positions: BTreeMap<String, [f64; 3]> = BTreeMap::new();
    let mut positions = node_positions;

    let mut add_link = |links: &mut Vec<LinkSpec>,
                        positions: &BTreeMap<String, [f64; 3]>,
                        id: String,
                        from: String,
                        to: String,
                        bidirectional: bool,
                        mode: LinkMode,
                        capacity: i32,
                        allow_meeting: bool| {
        let length = match (positions.get(&from), positions.get(&to)) {
            (Some(a), Some(b)) => {
                ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2) + (b[2] - a[2]).powi(2)).sqrt()
            }
            _ => 1.0,
        };
        links.push(LinkSpec {
            id,
            from,
            to,
            bidirectional,
            mode,
            length_m: round4(length.max(0.01)),
            capacity,
            allow_meeting,
        });
    };

    let served_levels: Vec<LevelSpec> = if is_asrs {
        levels.clone()
    } else {
        vec![LevelSpec { level: 1, y_m: 0.0 }]
    };

    for a in 0..p.aisles {
        let aisle_id = format!("A{:02}", a + 1);
        let z = (a as f64) * aisle_pitch;
        for lvl in &served_levels {
            for (suffix, x) in [("W", block_left_x), ("E", block_right_x)] {
                let id = format!("N-{aisle_id}-L{}-{suffix}", lvl.level);
                positions.insert(id.clone(), [round4(x), round4(lvl.y_m), round4(z)]);
                push_node(NodeSpec {
                    id,
                    position: [round4(x), round4(lvl.y_m), round4(z)],
                    kind: "aisle-end".to_string(),
                    area_id: Some(asrs_area.id.clone()),
                    aisle_id: Some(aisle_id.clone()),
                    level: Some(lvl.level),
                });
            }
            for b in (1..=p.bays).step_by(4) {
                let x = (b as f64 - 0.5) * p.bay_width_m;
                let id = format!("N-{aisle_id}-L{}-B{:03}", lvl.level, b);
                positions.insert(id.clone(), [round4(x), round4(lvl.y_m), round4(z)]);
                push_node(NodeSpec {
                    id,
                    position: [round4(x), round4(lvl.y_m), round4(z)],
                    kind: "aisle-rail".to_string(),
                    area_id: Some(asrs_area.id.clone()),
                    aisle_id: Some(aisle_id.clone()),
                    level: Some(lvl.level),
                });
            }
        }
    }
    if let Some(manual) = &manual_area {
        for (suffix, x) in [
            ("W", manual.center[0] - manual.size[0] / 2.0),
            ("E", manual.center[0] + manual.size[0] / 2.0),
        ] {
            let id = format!("N-MANUAL-{suffix}");
            positions.insert(id.clone(), [round4(x), 0.0, round4(manual.center[1])]);
            push_node(NodeSpec {
                id,
                position: [round4(x), 0.0, round4(manual.center[1])],
                kind: "aisle-end".to_string(),
                area_id: Some(manual.id.clone()),
                aisle_id: Some("A-MANUAL".to_string()),
                level: Some(1),
            });
        }
    }

    // 巷道内轨道（单车道互斥：capacity = 1 且不允许会车）
    for a in 0..p.aisles {
        let aisle_id = format!("A{:02}", a + 1);
        for lvl in &served_levels {
            let west = format!("N-{aisle_id}-L{}-W", lvl.level);
            let east = format!("N-{aisle_id}-L{}-E", lvl.level);
            let mut prev = west.clone();
            for b in (1..=p.bays).step_by(4) {
                let id = format!("N-{aisle_id}-L{}-B{:03}", lvl.level, b);
                add_link(
                    &mut links,
                    &positions,
                    format!("K-{aisle_id}-L{}-{prev}->{id}", lvl.level),
                    prev.clone(),
                    id.clone(),
                    true,
                    LinkMode::Rail,
                    1,
                    false,
                );
                prev = id;
            }
            add_link(
                &mut links,
                &positions,
                format!("K-{aisle_id}-L{}-{prev}->{east}", lvl.level),
                prev,
                east,
                true,
                LinkMode::Rail,
                1,
                false,
            );
        }
    }
    if manual_area.is_some() {
        for level in [1, 2] {
            // 人工区两层货架共享地面通道（拣选作业），时间成本由设备模型给出
            let w = "N-MANUAL-W".to_string();
            let e = "N-MANUAL-E".to_string();
            add_link(
                &mut links,
                &positions,
                format!("K-MANUAL-L{level}"),
                w,
                e,
                true,
                LinkMode::Road,
                2,
                true,
            );
        }
    }

    // 横巷：把同一层的所有巷道端点连起来（单车道互斥 → capacity 1 / 不允许会车）
    if has_cross {
        for lvl in 1..=if is_asrs { p.levels } else { 1 } {
            for suffix in ["W", "E"] {
                for a in 1..p.aisles {
                    let from = format!("N-A{a:02}-L{lvl}-{suffix}");
                    let to = format!("N-A{:02}-L{lvl}-{suffix}", a + 1);
                    add_link(
                        &mut links,
                        &positions,
                        format!("K-CROSS-L{lvl}-{suffix}-A{a}A{}", a + 1),
                        from,
                        to,
                        true,
                        if p.template == TopologyTemplate::AsrsFourWay {
                            LinkMode::Rail
                        } else {
                            LinkMode::Road
                        },
                        if p.template == TopologyTemplate::AsrsTwoBlock {
                            1
                        } else {
                            2
                        },
                        p.template != TopologyTemplate::AsrsTwoBlock,
                    );
                }
            }
            // 显式交叉口节点（四向穿梭车的争用点）
            for a in 1..=p.aisles {
                for suffix in ["W", "E"] {
                    let x = if suffix == "W" {
                        block_left_x - 1.6
                    } else {
                        block_right_x + 1.6
                    };
                    let y = levels
                        .get((lvl - 1).clamp(0, levels.len() as i32 - 1) as usize)
                        .map(|l| l.y_m)
                        .unwrap_or(0.0);
                    let id = format!("N-X{a:02}-L{lvl}-{suffix}");
                    positions.insert(
                        id.clone(),
                        [round4(x), round4(y), round4((a - 1) as f64 * aisle_pitch)],
                    );
                    push_node(NodeSpec {
                        id: id.clone(),
                        position: [round4(x), round4(y), round4((a - 1) as f64 * aisle_pitch)],
                        kind: "crossing".to_string(),
                        area_id: Some(asrs_area.id.clone()),
                        aisle_id: None,
                        level: Some(lvl),
                    });
                    add_link(
                        &mut links,
                        &positions,
                        format!("K-X{a:02}-L{lvl}-{suffix}"),
                        format!("N-A{a:02}-L{lvl}-{suffix}"),
                        id,
                        true,
                        LinkMode::Rail,
                        1,
                        false,
                    );
                }
            }
        }
    }

    // 巷道端到站台的输送/道路通道
    for a in 1..=p.aisles {
        for (suffix, sign) in [("W", -1.0), ("E", 1.0)] {
            let id = format!("N-A{a:02}-TRANSFER-{suffix}");
            let x = if sign < 0.0 {
                block_left_x - 8.2
            } else {
                block_right_x + 8.2
            };
            let z = (a - 1) as f64 * aisle_pitch;
            positions.insert(id.clone(), [round4(x), 0.0, round4(z)]);
            push_node(NodeSpec {
                id: id.clone(),
                position: [round4(x), 0.0, round4(z)],
                kind: "transfer".to_string(),
                area_id: Some(if sign < 0.0 {
                    inbound_area.id.clone()
                } else {
                    outbound_area.id.clone()
                }),
                aisle_id: Some(format!("A{a:02}")),
                level: Some(1),
            });
            add_link(
                &mut links,
                &positions,
                format!("K-A{a:02}-TRANSFER-{suffix}"),
                format!("N-A{a:02}-L1-{suffix}"),
                id,
                true,
                if p.conveyor_speed_mps > 0.0 {
                    LinkMode::Conveyor
                } else {
                    LinkMode::Road
                },
                if p.conveyor_speed_mps > 0.0 { 2 } else { 1 },
                p.conveyor_speed_mps > 0.0,
            );
        }
    }

    /* ---------------- 提升机（货物提升机 / 巷道提升机） ---------------- */
    let mut pallet_lift_ids: Vec<String> = Vec::new();
    let mut aisle_lift_ids: Vec<String> = Vec::new();
    let wants_pallet = is_asrs && (p.lift_mode == "pallet" || p.lift_mode == "both");
    let wants_shuttle_lift = is_asrs && (p.lift_mode == "shuttle" || p.lift_mode == "both");

    if wants_pallet || wants_shuttle_lift {
        for blk in 0..blocks {
            let block_aisles: Vec<String> = (blk * aisles_per_block..(blk + 1) * aisles_per_block)
                .filter(|a| *a < p.aisles)
                .map(|a| format!("A{:02}", a + 1))
                .collect();
            if block_aisles.is_empty() {
                continue;
            }
            let head_aisle = block_aisles[0].clone();
            let head_number: i32 = head_aisle[1..].parse().unwrap_or(1);
            let shaft_x = block_right_x + 1.6;
            let shaft_z = (head_number - 1) as f64 * aisle_pitch;
            for i in 0..p.lifts_per_block {
                let suffix = if i == 0 {
                    String::new()
                } else {
                    format!("{}", i + 1)
                };
                if wants_pallet {
                    let id = format!("PL-{:02}{suffix}", blk + 1);
                    pallet_lift_ids.push(id.clone());
                    for lvl in 1..=p.levels {
                        let node_id = format!("N-{id}-L{lvl}");
                        let position = [
                            round4(shaft_x + i as f64 * 2.2),
                            round4(levels[(lvl - 1) as usize].y_m),
                            round4(shaft_z),
                        ];
                        positions.insert(node_id.clone(), position);
                        push_node(NodeSpec {
                            id: node_id.clone(),
                            position,
                            kind: "lift-shaft".to_string(),
                            area_id: Some(asrs_area.id.clone()),
                            aisle_id: None,
                            level: Some(lvl),
                        });
                        // 竖井在每个楼层与块内所有巷道的层内通道相连：
                        // 只连首巷道会造成"其余巷道的高层货位在图上不可达"（真实仓库靠层内通道解决）。
                        for aisle in &block_aisles {
                            let head = aisle == &head_aisle;
                            add_link(
                                &mut links,
                                &positions,
                                format!("K-{id}-L{lvl}-{aisle}"),
                                format!("N-{aisle}-L{lvl}-E"),
                                node_id.clone(),
                                true,
                                if head {
                                    LinkMode::LiftShaft
                                } else if lvl >= 2 {
                                    LinkMode::Rail
                                } else {
                                    LinkMode::Conveyor
                                },
                                if head { 1 } else { 2 },
                                !head,
                            );
                        }
                    }
                    // 竖井内的垂直行程：提升机把各层节点连成一条可通行的链。
                    // 缺了这几条边，2 层以上的货位在图上就是孤岛（不可达），上层优化无从谈起。
                    for lvl in 1..p.levels {
                        add_link(
                            &mut links,
                            &positions,
                            format!("K-{id}-V{}-{}", lvl, lvl + 1),
                            format!("N-{id}-L{lvl}"),
                            format!("N-{id}-L{}", lvl + 1),
                            true,
                            LinkMode::LiftShaft,
                            1,
                            false,
                        );
                    }
                    devices.push(DeviceSpec {
                        id: id.clone(),
                        kind: DeviceKind::PalletLift,
                        name: format!("货物提升机 {id}"),
                        home_node_id: format!("N-{id}-L1"),
                        capability: DeviceCapability {
                            aisles: block_aisles.clone(),
                            levels: (1..=p.levels).collect(),
                            areas: vec![asrs_area.id.clone()],
                            capacity_loads: if p.template == TopologyTemplate::AsrsTwoBlock {
                                2
                            } else {
                                1
                            },
                            capacity_kg: 1200.0,
                        },
                        motion: MotionProfile {
                            speed_mps: 0.9,
                            accel_mps2: 0.7,
                            transfer_s: 8.0,
                            handover_s: p.handover_s,
                            change_level_s: 12.0,
                            loaded_speed_factor: 1.0,
                        },
                        exclusive_resources: vec![format!("SHAFT-{blk}")],
                        shares_space_with: if p.lifts_per_block > 1 {
                            vec![format!("PL-{:02}2", blk + 1)]
                        } else {
                            Vec::new()
                        },
                        energy_kwh_per_move: 0.02,
                        energy_kwh_per_meter: 0.004,
                        status_state: "up".to_string(),
                        speed_factor: 1.0,
                    });
                }
                if wants_shuttle_lift {
                    let id = format!("AL-{:02}{suffix}", blk + 1);
                    aisle_lift_ids.push(id.clone());
                    for lvl in 1..=p.levels {
                        let node_id = format!("N-{id}-L{lvl}");
                        let position = [
                            round4(shaft_x + 4.4 + i as f64 * 2.2),
                            round4(levels[(lvl - 1) as usize].y_m),
                            round4(shaft_z),
                        ];
                        positions.insert(node_id.clone(), position);
                        push_node(NodeSpec {
                            id: node_id.clone(),
                            position,
                            kind: "lift-shaft".to_string(),
                            area_id: Some(asrs_area.id.clone()),
                            aisle_id: None,
                            level: Some(lvl),
                        });
                        add_link(
                            &mut links,
                            &positions,
                            format!("K-{id}-L{lvl}"),
                            format!("N-{head_aisle}-L{lvl}-E"),
                            node_id,
                            true,
                            LinkMode::LiftShaft,
                            1,
                            false,
                        );
                    }
                    // 巷道提升机同样需要竖井垂直边（否则多层穿梭车跨层转运在图上断路）
                    for lvl in 1..p.levels {
                        add_link(
                            &mut links,
                            &positions,
                            format!("K-{id}-V{}-{}", lvl, lvl + 1),
                            format!("N-{id}-L{lvl}"),
                            format!("N-{id}-L{}", lvl + 1),
                            true,
                            LinkMode::LiftShaft,
                            1,
                            false,
                        );
                    }
                    devices.push(DeviceSpec {
                        id: id.clone(),
                        kind: DeviceKind::AisleLift,
                        name: format!("巷道提升机 {id}（穿梭车跨层转运）"),
                        home_node_id: format!("N-{id}-L1"),
                        capability: DeviceCapability {
                            aisles: block_aisles.clone(),
                            levels: (1..=p.levels).collect(),
                            areas: vec![asrs_area.id.clone()],
                            capacity_loads: 1,
                            capacity_kg: 1500.0,
                        },
                        motion: MotionProfile {
                            speed_mps: 1.1,
                            accel_mps2: 0.8,
                            transfer_s: 10.0,
                            handover_s: p.handover_s,
                            change_level_s: 8.0,
                            loaded_speed_factor: 1.0,
                        },
                        exclusive_resources: vec![format!("SHAFT-AL-{blk}")],
                        shares_space_with: Vec::new(),
                        energy_kwh_per_move: 0.03,
                        energy_kwh_per_meter: 0.005,
                        status_state: "up".to_string(),
                        speed_factor: 1.0,
                    });
                }
            }
        }
    }

    /* ---------------- 站台与缓存 ---------------- */
    let station_z = |count: i32, index: i32| -> f64 {
        total_z / 2.0 + (index as f64 - (count as f64 - 1.0) / 2.0) * 4.0
    };
    // 站台节点收集：地面通道必须把所有站台与**每一座提升机底座**连起来，
    // 否则跨提升机分组的任务在图上不可达（node_seconds 会给出 inf）。
    let mut station_node_ids: Vec<String> = Vec::new();
    for i in 0..p.inbound_stations {
        let id = format!("ST-IN-{:02}", i + 1);
        let node_id = format!("N-{id}");
        let z = station_z(p.inbound_stations, i);
        let position = [round4(inbound_area.center[0]), 0.0, round4(z)];
        positions.insert(node_id.clone(), position);
        push_node(NodeSpec {
            id: node_id.clone(),
            position,
            kind: "station".to_string(),
            area_id: Some(inbound_area.id.clone()),
            aisle_id: None,
            level: Some(1),
        });
        station_node_ids.push(node_id.clone());
        for a in 1..=p.aisles.min(4) {
            add_link(
                &mut links,
                &positions,
                format!("K-{id}-A{a:02}"),
                node_id.clone(),
                format!("N-A{a:02}-L1-W"),
                true,
                LinkMode::Road,
                2,
                true,
            );
        }
        stations.push(StationSpec {
            id: id.clone(),
            name: format!("入库站台 {}", i + 1),
            area_id: inbound_area.id.clone(),
            node_id,
            direction: StationDirection::Inbound,
            buffer_capacity: p.station_buffer,
            handover_s: p.handover_s,
            served_by: pallet_lift_ids.clone(),
        });
        buffers.push(BufferSpec {
            id: format!("BUF-{id}"),
            node_id: format!("N-{id}"),
            area_id: inbound_area.id.clone(),
            capacity: p.buffer_capacity,
            dwell_limit_s: 900.0,
        });
    }
    for i in 0..p.outbound_stations {
        let id = format!("ST-OUT-{:02}", i + 1);
        let node_id = format!("N-{id}");
        let z = station_z(p.outbound_stations, i);
        let position = [round4(outbound_area.center[0]), 0.0, round4(z)];
        positions.insert(node_id.clone(), position);
        push_node(NodeSpec {
            id: node_id.clone(),
            position,
            kind: "station".to_string(),
            area_id: Some(outbound_area.id.clone()),
            aisle_id: None,
            level: Some(1),
        });
        station_node_ids.push(node_id.clone());
        for a in 1..=p.aisles.min(4) {
            add_link(
                &mut links,
                &positions,
                format!("K-{id}-A{a:02}"),
                node_id.clone(),
                format!("N-A{a:02}-L1-E"),
                true,
                LinkMode::Road,
                2,
                true,
            );
        }
        stations.push(StationSpec {
            id: id.clone(),
            name: format!("出库站台 {}", i + 1),
            area_id: outbound_area.id.clone(),
            node_id,
            direction: StationDirection::Outbound,
            buffer_capacity: p.station_buffer,
            handover_s: p.handover_s,
            served_by: pallet_lift_ids.clone(),
        });
        buffers.push(BufferSpec {
            id: format!("BUF-{id}"),
            node_id: format!("N-{id}"),
            area_id: outbound_area.id.clone(),
            capacity: p.buffer_capacity,
            dwell_limit_s: 900.0,
        });
    }

    // 地面通道主干：站台 ↔ 每座货物提升机底座（同层、可会车）。
    // 单深库只有横巷时（template != four-way）没有连接各分组的横巷，
    // 靠这条主干才能让"入到 A15"这样的跨分组任务在图上可达。
    for node in &station_node_ids {
        for lift in &pallet_lift_ids {
            let base = format!("N-{lift}-L1");
            if !positions.contains_key(&base) {
                continue;
            }
            add_link(
                &mut links,
                &positions,
                format!("K-ROAD-{node}-{lift}"),
                node.clone(),
                base,
                true,
                LinkMode::Road,
                2,
                true,
            );
        }
    }

    /* ---------------- 穿梭车 ---------------- */
    if is_asrs {
        for a in 1..=p.aisles {
            let aisle_id = format!("A{a:02}");
            for s in 1..=p.shuttles_per_aisle {
                let shuttle_levels: Vec<i32> =
                    if p.lift_mode == "shuttle" || p.template == TopologyTemplate::AsrsFourWay {
                        (1..=p.levels).collect()
                    } else {
                        // 货物提升机形态：穿梭车只在底层服务，货物靠提升机上下（真实拓扑）
                        vec![1]
                    };
                for lvl in shuttle_levels {
                    let id = format!("SH-{aisle_id}-{s}-L{lvl}");
                    let four_way = p.template == TopologyTemplate::AsrsFourWay;
                    devices.push(DeviceSpec {
                        id: id.clone(),
                        kind: if four_way {
                            DeviceKind::FourWayShuttle
                        } else if p.levels > 1 {
                            DeviceKind::LayerShuttle
                        } else {
                            DeviceKind::AisleShuttle
                        },
                        name: if four_way {
                            format!("四向穿梭车 {id}")
                        } else {
                            format!("穿梭车 {id}")
                        },
                        home_node_id: format!("N-{aisle_id}-L{lvl}-W"),
                        capability: DeviceCapability {
                            aisles: if four_way {
                                Vec::new()
                            } else {
                                vec![aisle_id.clone()]
                            },
                            levels: vec![lvl],
                            areas: vec![asrs_area.id.clone()],
                            capacity_loads: 1,
                            capacity_kg: 1000.0,
                        },
                        motion: MotionProfile {
                            speed_mps: if four_way { 2.8 } else { 2.6 },
                            accel_mps2: 1.3,
                            transfer_s: 6.0,
                            handover_s: 8.0,
                            change_level_s: 10.0,
                            loaded_speed_factor: 0.92,
                        },
                        exclusive_resources: vec![format!("AISLE-{aisle_id}-L{lvl}")],
                        shares_space_with: (1..=p.shuttles_per_aisle)
                            .filter(|other| *other != s)
                            .map(|other| format!("SH-{aisle_id}-{other}-L{lvl}"))
                            .collect(),
                        energy_kwh_per_move: 0.008,
                        energy_kwh_per_meter: 0.0016,
                        status_state: "up".to_string(),
                        speed_factor: 1.0,
                    });
                }
            }
        }
    }
    if manual_area.is_some() {
        devices.push(DeviceSpec {
            id: "AMR-M01".to_string(),
            kind: DeviceKind::TransferCar,
            name: "人工区搬运机器人".to_string(),
            home_node_id: "N-MANUAL-W".to_string(),
            capability: DeviceCapability {
                aisles: Vec::new(),
                levels: vec![1],
                areas: vec!["AREA-MANUAL".to_string()],
                capacity_loads: 1,
                capacity_kg: 300.0,
            },
            motion: MotionProfile {
                speed_mps: 1.6,
                accel_mps2: 1.0,
                transfer_s: 5.0,
                handover_s: 6.0,
                change_level_s: 8.0,
                loaded_speed_factor: 1.0,
            },
            exclusive_resources: Vec::new(),
            shares_space_with: Vec::new(),
            energy_kwh_per_move: 0.006,
            energy_kwh_per_meter: 0.0012,
            status_state: "up".to_string(),
            speed_factor: 1.0,
        });
        add_link(
            &mut links,
            &positions,
            "K-MANUAL-ASRS".to_string(),
            "N-MANUAL-E".to_string(),
            "N-A01-L1-W".to_string(),
            true,
            LinkMode::Road,
            1,
            false,
        );
    }
    if p.conveyor_speed_mps > 0.0 && p.aisles > 0 {
        devices.push(DeviceSpec {
            id: "CV-01".to_string(),
            kind: DeviceKind::Conveyor,
            name: "巷道端输送机".to_string(),
            home_node_id: "N-A01-L1-E".to_string(),
            capability: DeviceCapability {
                aisles: Vec::new(),
                levels: vec![1],
                areas: vec![outbound_area.id.clone(), inbound_area.id.clone()],
                capacity_loads: 4,
                capacity_kg: 2000.0,
            },
            motion: MotionProfile {
                speed_mps: p.conveyor_speed_mps,
                accel_mps2: 0.4,
                transfer_s: 2.0,
                handover_s: 4.0,
                change_level_s: 6.0,
                loaded_speed_factor: 1.0,
            },
            exclusive_resources: Vec::new(),
            shares_space_with: Vec::new(),
            energy_kwh_per_move: 0.002,
            energy_kwh_per_meter: 0.0009,
            status_state: "up".to_string(),
            speed_factor: 1.0,
        });
    }

    let topology = Topology {
        id: format!(
            "WH-{}-A{}-L{}-B{}-D{}",
            p.template.as_str(),
            p.aisles,
            p.levels,
            p.bays,
            p.depths
        ),
        name: format!(
            "{} · {} 巷 × {} 层 × {} 列 × {} 深",
            p.template.label(),
            p.aisles,
            p.levels,
            p.bays,
            p.depths
        ),
        template_name: p.template.as_str().to_string(),
        areas,
        racks,
        aisles,
        nodes,
        links,
        stations,
        buffers,
        devices,
        closed_links: BTreeSet::new(),
        frozen_locations: BTreeSet::new(),
        reserved_locations: BTreeSet::new(),
    };

    let mut locations = derive_locations(&topology);
    apply_scarcity(&mut locations, p.frozen_share, p.reserved_share);

    let asrs_volume: f64 = topology
        .racks
        .iter()
        .filter(|r| r.kind != RackKind::Shelving)
        .map(|r| {
            r.bays as f64
                * r.depths as f64
                * r.levels.len() as f64
                * r.size[0]
                * r.size[1]
                * r.size[2]
        })
        .sum();
    let manual_locations: usize = topology
        .racks
        .iter()
        .filter(|r| r.kind == RackKind::Shelving)
        .map(|r| (r.bays * r.depths * r.levels.len() as i32).max(0) as usize)
        .sum();
    let stats = TopologyStats {
        locations: locations.len(),
        available_locations: locations
            .iter()
            .filter(|l| l.availability == Availability::Available)
            .count(),
        aisles: topology.aisles.len(),
        levels: p.levels,
        bays: p.bays,
        depths: p.depths,
        devices: topology.devices.len(),
        stations: topology.stations.len(),
        footprint_m2: (topology
            .areas
            .iter()
            .map(|a| a.size[0] * a.size[1])
            .sum::<f64>()
            * 10.0)
            .round()
            / 10.0,
        asrs_volume_m3: (asrs_volume * 100.0).round() / 100.0,
        manual_locations,
        nodes: topology.nodes.len(),
        links: topology.links.len(),
    };
    TopologyBundle {
        topology,
        locations,
        stats,
    }
}

/// 由拓扑派生库位（唯一来源）；冻结/预留按确定性规则切分。
pub fn derive_locations(topology: &Topology) -> Vec<LocationRecord> {
    let mut zone_by_area: BTreeMap<&str, &'static str> = BTreeMap::new();
    for area in &topology.areas {
        let zone = match area.kind.as_str() {
            "asrs" => "ASRS",
            "picking" => "PICK",
            "receiving" => "RECV",
            "shipping" => "SHIP",
            _ => "OTHER",
        };
        zone_by_area.insert(area.id.as_str(), zone);
    }
    let mut out = Vec::new();
    for rack in &topology.racks {
        for level in &rack.levels {
            for bay in 1..=rack.bays {
                for depth in 1..=rack.depths {
                    let along = (bay - 1) as f64 * rack.size[0];
                    let into = (depth - 1) as f64 * rack.size[2];
                    let x = rack.origin[0] + rack.bay_axis[0] * along + rack.depth_axis[0] * into;
                    let z = rack.origin[2] + rack.bay_axis[1] * along + rack.depth_axis[1] * into;
                    let id = location_id(&rack.id, level.level, bay, depth);
                    let base_zone = zone_by_area
                        .get(rack.area_id.as_str())
                        .copied()
                        .unwrap_or("ASRS");
                    // 高层分区：多层立库的高层不允许放温控货（真实工程约束）
                    let zone = if level.level >= 6 && base_zone == "ASRS" {
                        "ASRS-HIGH".to_string()
                    } else {
                        base_zone.to_string()
                    };
                    let availability = if topology.frozen_locations.contains(&id) {
                        Availability::Frozen
                    } else if topology.reserved_locations.contains(&id) {
                        Availability::Reserved
                    } else {
                        Availability::Available
                    };
                    out.push(LocationRecord {
                        id,
                        rack_id: rack.id.clone(),
                        area_id: rack.area_id.clone(),
                        aisle_id: rack.aisle_id.clone(),
                        bay,
                        level: level.level,
                        depth,
                        position: [round4(x), round4(level.y_m), round4(z)],
                        size: rack.size,
                        max_weight_kg: rack.max_weight_kg,
                        max_volume_m3: rack.max_volume_m3,
                        availability,
                        zone,
                    });
                }
            }
        }
    }
    out
}

/// 按比例把库位切成"冻结 / 预留"（S10 场景与动态事件使用；确定性选择）。
fn apply_scarcity(locations: &mut [LocationRecord], frozen_share: f64, reserved_share: f64) {
    let n = locations.len();
    if n == 0 {
        return;
    }
    let frozen = ((n as f64) * frozen_share.clamp(0.0, 0.5)) as usize;
    let reserved = ((n as f64) * reserved_share.clamp(0.0, 0.5)) as usize;
    // 取靠后（远离出库口）的库位冻结/预留：与真实作业习惯一致
    for i in 0..frozen.min(n) {
        locations[n - 1 - i].availability = Availability::Frozen;
    }
    for i in 0..reserved.min(n.saturating_sub(frozen)) {
        locations[n - 1 - frozen - i].availability = Availability::Reserved;
    }
}

/* ------------------------------------------------------------------ *
 * 图：骨架最短路
 * ------------------------------------------------------------------ */

/// 拓扑骨架图（节点索引 + 邻接表），供路由与可达性判断使用。
#[derive(Debug, Clone)]
pub struct NodeGraph {
    pub index: BTreeMap<String, usize>,
    pub positions: Vec<[f64; 3]>,
    /// adj[i] = [(to_index, length_m, mode, link_index)]
    pub adj: Vec<Vec<(usize, f64, LinkMode, usize)>>,
    pub link_ids: Vec<String>,
}

pub fn build_graph(topology: &Topology) -> NodeGraph {
    let mut index: BTreeMap<String, usize> = BTreeMap::new();
    let mut positions: Vec<[f64; 3]> = Vec::new();
    for node in &topology.nodes {
        index.insert(node.id.clone(), positions.len());
        positions.push(node.position);
    }
    let mut adj: Vec<Vec<(usize, f64, LinkMode, usize)>> = vec![Vec::new(); positions.len()];
    let mut link_ids: Vec<String> = Vec::new();
    for (li, link) in topology.links.iter().enumerate() {
        if topology.closed_links.contains(&link.id) {
            continue;
        }
        let (Some(&a), Some(&b)) = (index.get(&link.from), index.get(&link.to)) else {
            continue;
        };
        link_ids.push(link.id.clone());
        adj[a].push((b, link.length_m, link.mode, li));
        if link.bidirectional {
            adj[b].push((a, link.length_m, link.mode, li));
        }
    }
    NodeGraph {
        index,
        positions,
        adj,
        link_ids,
    }
}

/// 邻接表（兼容 `contract::validate_topology` 的可达性检查）。
pub fn adjacency(topology: &Topology) -> BTreeMap<String, Vec<String>> {
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for link in &topology.links {
        if topology.closed_links.contains(&link.id) {
            continue;
        }
        out.entry(link.from.clone())
            .or_default()
            .push(link.to.clone());
        if link.bidirectional {
            out.entry(link.to.clone())
                .or_default()
                .push(link.from.clone());
        }
    }
    out
}

/// 广度优先可达集合（节点 id）。
pub fn bfs(adjacency: &BTreeMap<String, Vec<String>>, start: &str) -> BTreeSet<String> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut stack = vec![start.to_string()];
    seen.insert(start.to_string());
    while let Some(current) = stack.pop() {
        if let Some(next) = adjacency.get(&current) {
            for id in next {
                if seen.insert(id.clone()) {
                    stack.push(id.clone());
                }
            }
        }
    }
    seen
}

/// Dijkstra（按时间的近似：`LinkMode::default_motion` 的梯形曲线）。
/// 返回每个节点的时间（秒）与距离（米）。不可达为 `f64::INFINITY`。
/// 二叉堆最小优先队列（`f64` 没有 `Ord`，按时间做惰性删除即可）。
#[derive(PartialEq)]
struct HeapItem {
    seconds: f64,
    index: usize,
}

impl Eq for HeapItem {}

impl Ord for HeapItem {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        other
            .seconds
            .partial_cmp(&self.seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    }
}

impl PartialOrd for HeapItem {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

fn relax(
    graph: &NodeGraph,
    seconds: &mut [f64],
    meters: &mut [f64],
    u: usize,
    heap: &mut std::collections::BinaryHeap<HeapItem>,
) {
    for &(v, length, mode, _) in &graph.adj[u] {
        let (speed, accel) = mode.default_motion();
        let dt = crate::wh::routing::travel_time(length, speed, accel);
        if seconds[u] + dt < seconds[v] - 1e-9 {
            seconds[v] = seconds[u] + dt;
            meters[v] = meters[u] + length;
            heap.push(HeapItem {
                seconds: seconds[v],
                index: v,
            });
        }
    }
}

/// 单源最短路（秒 / 米）。二叉堆 + 惰性删除：骨架节点数千、边数万，堆实现比 O(n²) 选择快两个数量级，
/// 也避免了旧实现在 2 万任务规模下的平方级退化。
pub fn dijkstra(graph: &NodeGraph, source: &str) -> (Vec<f64>, Vec<f64>) {
    use std::collections::BinaryHeap;
    let n = graph.positions.len();
    let mut seconds = vec![f64::INFINITY; n];
    let mut meters = vec![f64::INFINITY; n];
    let Some(&src) = graph.index.get(source) else {
        return (seconds, meters);
    };
    seconds[src] = 0.0;
    meters[src] = 0.0;
    let mut heap: BinaryHeap<HeapItem> = BinaryHeap::new();
    heap.push(HeapItem {
        seconds: 0.0,
        index: src,
    });
    while let Some(item) = heap.pop() {
        if item.seconds > seconds[item.index] + 1e-9 {
            continue;
        }
        relax(graph, &mut seconds, &mut meters, item.index, &mut heap);
    }
    (seconds, meters)
}

/// 单源单目标最短路：目标一确定就停，供热路径查询使用（无需预计算整张图）。
pub fn dijkstra_until(graph: &NodeGraph, source: &str, target: &str) -> (f64, f64) {
    use std::collections::BinaryHeap;
    if source == target {
        return (0.0, 0.0);
    }
    let n = graph.positions.len();
    let (Some(&src), Some(&dst)) = (graph.index.get(source), graph.index.get(target)) else {
        return (f64::INFINITY, f64::INFINITY);
    };
    let mut seconds = vec![f64::INFINITY; n];
    let mut meters = vec![f64::INFINITY; n];
    seconds[src] = 0.0;
    meters[src] = 0.0;
    let mut heap: BinaryHeap<HeapItem> = BinaryHeap::new();
    heap.push(HeapItem {
        seconds: 0.0,
        index: src,
    });
    while let Some(item) = heap.pop() {
        if item.index == dst {
            return (seconds[dst], meters[dst]);
        }
        if item.seconds > seconds[item.index] + 1e-9 {
            continue;
        }
        relax(graph, &mut seconds, &mut meters, item.index, &mut heap);
    }
    (seconds[dst], meters[dst])
}

/// 生成 JSON：拓扑（供实验室与契约示例使用）。
pub fn topology_to_json(bundle: &TopologyBundle) -> Json {
    let t = &bundle.topology;
    let areas: Vec<Json> = t
        .areas
        .iter()
        .map(|a| {
            Json::obj(vec![
                ("id", Json::str(a.id.clone())),
                ("name", Json::str(a.name.clone())),
                ("kind", Json::str(a.kind.clone())),
                (
                    "center",
                    Json::Arr(vec![Json::Float(a.center[0]), Json::Float(a.center[1])]),
                ),
                (
                    "size",
                    Json::Arr(vec![Json::Float(a.size[0]), Json::Float(a.size[1])]),
                ),
                ("height_m", Json::Float(a.height_m)),
            ])
        })
        .collect();
    let racks: Vec<Json> = t
        .racks
        .iter()
        .map(|r| {
            Json::obj(vec![
                ("id", Json::str(r.id.clone())),
                ("areaId", Json::str(r.area_id.clone())),
                ("aisleId", Json::str(r.aisle_id.clone())),
                ("kind", Json::str(r.kind.as_str())),
                ("bays", Json::int(r.bays as i64)),
                ("depths", Json::int(r.depths as i64)),
                (
                    "levels",
                    Json::Arr(
                        r.levels
                            .iter()
                            .map(|l| {
                                Json::obj(vec![
                                    ("level", Json::int(l.level as i64)),
                                    ("y_m", Json::Float(l.y_m)),
                                ])
                            })
                            .collect(),
                    ),
                ),
                (
                    "locationSize",
                    Json::obj(vec![
                        ("width_m", Json::Float(r.size[0])),
                        ("height_m", Json::Float(r.size[1])),
                        ("depth_m", Json::Float(r.size[2])),
                    ]),
                ),
                ("maxWeight_kg", Json::Float(r.max_weight_kg)),
                ("maxVolume_m3", Json::Float(r.max_volume_m3)),
                (
                    "origin",
                    Json::Arr(vec![
                        Json::Float(r.origin[0]),
                        Json::Float(r.origin[1]),
                        Json::Float(r.origin[2]),
                    ]),
                ),
                (
                    "bayAxis",
                    Json::Arr(vec![Json::Float(r.bay_axis[0]), Json::Float(r.bay_axis[1])]),
                ),
                (
                    "depthAxis",
                    Json::Arr(vec![
                        Json::Float(r.depth_axis[0]),
                        Json::Float(r.depth_axis[1]),
                    ]),
                ),
            ])
        })
        .collect();
    let aisles: Vec<Json> = t
        .aisles
        .iter()
        .map(|a| {
            Json::obj(vec![
                ("id", Json::str(a.id.clone())),
                ("areaId", Json::str(a.area_id.clone())),
                (
                    "endNodeIds",
                    Json::strings(vec![a.end_node_ids[0].clone(), a.end_node_ids[1].clone()]),
                ),
                (
                    "axis",
                    Json::Arr(vec![Json::Float(a.axis[0]), Json::Float(a.axis[1])]),
                ),
                ("length_m", Json::Float(a.length_m)),
                ("bidirectional", Json::Bool(a.bidirectional)),
                ("level", Json::int(a.level as i64)),
                ("rackIds", Json::strings(a.rack_ids.clone())),
            ])
        })
        .collect();
    let nodes: Vec<Json> = t
        .nodes
        .iter()
        .map(|n| {
            Json::obj(vec![
                ("id", Json::str(n.id.clone())),
                (
                    "position",
                    Json::Arr(vec![
                        Json::Float(n.position[0]),
                        Json::Float(n.position[1]),
                        Json::Float(n.position[2]),
                    ]),
                ),
                ("kind", Json::str(n.kind.clone())),
                ("areaId", Json::opt_str(n.area_id.clone())),
                ("aisleId", Json::opt_str(n.aisle_id.clone())),
                ("level", Json::opt_int(n.level.map(|v| v as i64))),
            ])
        })
        .collect();
    let links: Vec<Json> = t
        .links
        .iter()
        .map(|l| {
            Json::obj(vec![
                ("id", Json::str(l.id.clone())),
                ("from", Json::str(l.from.clone())),
                ("to", Json::str(l.to.clone())),
                ("bidirectional", Json::Bool(l.bidirectional)),
                ("mode", Json::str(l.mode.as_str())),
                ("length_m", Json::Float(l.length_m)),
                ("capacity", Json::int(l.capacity as i64)),
                ("allowMeeting", Json::Bool(l.allow_meeting)),
            ])
        })
        .collect();
    let stations: Vec<Json> = t
        .stations
        .iter()
        .map(|s| {
            Json::obj(vec![
                ("id", Json::str(s.id.clone())),
                ("name", Json::str(s.name.clone())),
                ("areaId", Json::str(s.area_id.clone())),
                ("nodeId", Json::str(s.node_id.clone())),
                ("direction", Json::str(s.direction.as_str())),
                ("bufferCapacity", Json::int(s.buffer_capacity as i64)),
                ("handover_s", Json::Float(s.handover_s)),
                ("servedBy", Json::strings(s.served_by.clone())),
            ])
        })
        .collect();
    let buffers: Vec<Json> = t
        .buffers
        .iter()
        .map(|b| {
            Json::obj(vec![
                ("id", Json::str(b.id.clone())),
                ("nodeId", Json::str(b.node_id.clone())),
                ("areaId", Json::str(b.area_id.clone())),
                ("capacity", Json::int(b.capacity as i64)),
                ("dwellLimit_s", Json::Float(b.dwell_limit_s)),
            ])
        })
        .collect();
    let devices: Vec<Json> = t
        .devices
        .iter()
        .map(|d| {
            Json::obj(vec![
                ("id", Json::str(d.id.clone())),
                ("kind", Json::str(d.kind.as_str())),
                ("name", Json::str(d.name.clone())),
                ("homeNodeId", Json::str(d.home_node_id.clone())),
                (
                    "capability",
                    Json::obj(vec![
                        ("aisles", Json::strings(d.capability.aisles.clone())),
                        (
                            "levels",
                            Json::Arr(
                                d.capability
                                    .levels
                                    .iter()
                                    .map(|l| Json::int(*l as i64))
                                    .collect(),
                            ),
                        ),
                        ("areas", Json::strings(d.capability.areas.clone())),
                        (
                            "capacity_loads",
                            Json::int(d.capability.capacity_loads as i64),
                        ),
                        ("capacity_kg", Json::Float(d.capability.capacity_kg)),
                    ]),
                ),
                (
                    "motion",
                    Json::obj(vec![
                        ("speed_mps", Json::Float(d.motion.speed_mps)),
                        ("accel_mps2", Json::Float(d.motion.accel_mps2)),
                        ("transfer_s", Json::Float(d.motion.transfer_s)),
                        ("handover_s", Json::Float(d.motion.handover_s)),
                        ("change_level_s", Json::Float(d.motion.change_level_s)),
                        (
                            "loaded_speed_factor",
                            Json::Float(d.motion.loaded_speed_factor),
                        ),
                    ]),
                ),
                (
                    "coupling",
                    Json::obj(vec![
                        (
                            "exclusiveResources",
                            Json::strings(d.exclusive_resources.clone()),
                        ),
                        (
                            "sharesSpaceWith",
                            Json::strings(d.shares_space_with.clone()),
                        ),
                    ]),
                ),
                (
                    "energy",
                    Json::obj(vec![
                        ("kwh_per_move", Json::Float(d.energy_kwh_per_move)),
                        ("kwh_per_meter", Json::Float(d.energy_kwh_per_meter)),
                    ]),
                ),
                (
                    "status",
                    Json::obj(vec![
                        ("state", Json::str(d.status_state.clone())),
                        ("speedFactor", Json::Float(d.speed_factor)),
                    ]),
                ),
            ])
        })
        .collect();
    Json::obj(vec![
        ("id", Json::str(t.id.clone())),
        ("name", Json::str(t.name.clone())),
        ("template", Json::str(t.template_name.clone())),
        ("areas", Json::Arr(areas)),
        ("racks", Json::Arr(racks)),
        ("aisles", Json::Arr(aisles)),
        ("nodes", Json::Arr(nodes)),
        ("links", Json::Arr(links)),
        ("stations", Json::Arr(stations)),
        ("buffers", Json::Arr(buffers)),
        ("devices", Json::Arr(devices)),
        (
            "frozenLocations",
            Json::strings(t.frozen_locations.iter().cloned().collect::<Vec<_>>()),
        ),
        (
            "reservedLocations",
            Json::strings(t.reserved_locations.iter().cloned().collect::<Vec<_>>()),
        ),
        (
            "units",
            Json::obj(vec![
                ("length", Json::str("m")),
                ("time", Json::str("s")),
                ("mass", Json::str("kg")),
                ("volume", Json::str("m3")),
            ]),
        ),
    ])
}
