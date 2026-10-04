//! 契约层：`warehouse-slotting-problem/1.0`、`warehouse-asrs-problem/1.0` 的解析与语义校验。
//!
//! 设计口径：
//! * **字段级定位**：任何缺失/类型/范围/引用问题都会带 `path` 记录进 [`Issues`]，
//!   最终映射为 `INVALID_INPUT` + 目标路径，不抛异常、不静默兜底；
//! * **拓扑是共享语义**：库位优化与立库调度读同一个 [`Topology`]；
//!   两个模块因此天然共享仓库空间、货物、库存与任务语义（SRS §1.3）；
//! * **库位由拓扑推导**（[`wh::topology::derive_locations`]），契约里不接受"直接给库位数"。

use std::collections::{BTreeMap, BTreeSet};

use aps_engine::json::Json;

use crate::errors::{codes, Issues};
use crate::wh::topology;

/* ------------------------------------------------------------------ *
 * JSON 取值助手（严格：类型不符即记录问题）
 * ------------------------------------------------------------------ */

pub fn field<'a>(value: &'a Json, key: &str) -> Option<&'a Json> {
    match value {
        Json::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

pub fn as_str(value: &Json) -> Option<&str> {
    match value {
        Json::Str(s) => Some(s.as_str()),
        _ => None,
    }
}

pub fn as_f64(value: &Json) -> Option<f64> {
    match value {
        Json::Float(v) => Some(*v),
        Json::Int(v) => Some(*v as f64),
        _ => None,
    }
}

pub fn as_i64(value: &Json) -> Option<i64> {
    match value {
        Json::Int(v) => Some(*v),
        Json::Float(v) if v.fract() == 0.0 => Some(*v as i64),
        _ => None,
    }
}

pub fn as_bool(value: &Json) -> Option<bool> {
    match value {
        Json::Bool(v) => Some(*v),
        _ => None,
    }
}

pub fn as_arr(value: &Json) -> Option<&Vec<Json>> {
    match value {
        Json::Arr(items) => Some(items),
        _ => None,
    }
}

/// 读取字符串字段（缺失即记录 MISSING_FIELD；类型不符记录 TYPE_MISMATCH）。
pub fn req_str(obj: &Json, key: &str, path: &str, issues: &mut Issues) -> String {
    match field(obj, key) {
        Some(Json::Str(s)) => s.clone(),
        Some(_) => {
            issues.error(codes::TYPE_MISMATCH, format!("{path}.{key}"), "期望字符串");
            String::new()
        }
        None => {
            issues.error(codes::MISSING_FIELD, format!("{path}.{key}"), "缺少必填字段");
            String::new()
        }
    }
}

pub fn req_f64(obj: &Json, key: &str, path: &str, issues: &mut Issues) -> f64 {
    match field(obj, key).and_then(as_f64) {
        Some(v) => v,
        None => {
            issues.error(codes::MISSING_FIELD, format!("{path}.{key}"), "缺少数值字段或以非数值给出");
            0.0
        }
    }
}

pub fn req_i64(obj: &Json, key: &str, path: &str, issues: &mut Issues) -> i64 {
    match field(obj, key).and_then(as_i64) {
        Some(v) => v,
        None => {
            issues.error(codes::MISSING_FIELD, format!("{path}.{key}"), "缺少整数字段或以非整数给出");
            0
        }
    }
}

pub fn opt_f64(obj: &Json, key: &str) -> Option<f64> {
    field(obj, key).and_then(as_f64)
}

pub fn opt_i64(obj: &Json, key: &str) -> Option<i64> {
    field(obj, key).and_then(as_i64)
}

pub fn opt_str(obj: &Json, key: &str) -> Option<String> {
    field(obj, key).and_then(as_str).map(|s| s.to_string())
}

pub fn opt_bool(obj: &Json, key: &str) -> Option<bool> {
    field(obj, key).and_then(as_bool)
}

pub fn str_array(obj: &Json, key: &str) -> Vec<String> {
    field(obj, key)
        .and_then(as_arr)
        .map(|items| items.iter().filter_map(as_str).map(|s| s.to_string()).collect())
        .unwrap_or_default()
}

pub fn arr<'a>(obj: &'a Json, key: &str) -> &'a [Json] {
    match field(obj, key).and_then(as_arr) {
        Some(items) => items.as_slice(),
        None => &[],
    }
}

pub fn num_array(obj: &Json, key: &str) -> Vec<f64> {
    field(obj, key)
        .and_then(as_arr)
        .map(|items| items.iter().filter_map(as_f64).collect())
        .unwrap_or_default()
}

/// 三元组向量（坐标 / 尺寸）。
pub fn vec3(obj: &Json, key: &str) -> Option<[f64; 3]> {
    let items = field(obj, key).and_then(as_arr)?;
    if items.len() < 3 {
        return None;
    }
    Some([
        items[0].as_f64_value()?,
        items[1].as_f64_value()?,
        items[2].as_f64_value()?,
    ])
}

/* ------------------------------------------------------------------ *
 * 拓扑结构
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RackKind {
    SingleDeep,
    DoubleDeep,
    MultiDeep,
    Shelving,
}

impl RackKind {
    pub fn parse(s: &str) -> RackKind {
        match s {
            "double-deep" => RackKind::DoubleDeep,
            "multi-deep" => RackKind::MultiDeep,
            "shelving" => RackKind::Shelving,
            _ => RackKind::SingleDeep,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            RackKind::SingleDeep => "single-deep",
            RackKind::DoubleDeep => "double-deep",
            RackKind::MultiDeep => "multi-deep",
            RackKind::Shelving => "shelving",
        }
    }
    pub fn is_deep(self) -> bool {
        matches!(self, RackKind::DoubleDeep | RackKind::MultiDeep)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Availability {
    Available,
    Frozen,
    Reserved,
    Unavailable,
}

impl Availability {
    pub fn as_str(self) -> &'static str {
        match self {
            Availability::Available => "available",
            Availability::Frozen => "frozen",
            Availability::Reserved => "reserved",
            Availability::Unavailable => "unavailable",
        }
    }
    pub fn placeable(self) -> bool {
        matches!(self, Availability::Available | Availability::Reserved)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceKind {
    AisleShuttle,
    LayerShuttle,
    FourWayShuttle,
    PalletLift,
    AisleLift,
    Conveyor,
    TransferCar,
}

impl DeviceKind {
    pub fn parse(s: &str) -> DeviceKind {
        match s {
            "layer-shuttle" => DeviceKind::LayerShuttle,
            "four-way-shuttle" => DeviceKind::FourWayShuttle,
            "pallet-lift" => DeviceKind::PalletLift,
            "aisle-lift" => DeviceKind::AisleLift,
            "conveyor" => DeviceKind::Conveyor,
            "transfer-car" => DeviceKind::TransferCar,
            _ => DeviceKind::AisleShuttle,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            DeviceKind::AisleShuttle => "aisle-shuttle",
            DeviceKind::LayerShuttle => "layer-shuttle",
            DeviceKind::FourWayShuttle => "four-way-shuttle",
            DeviceKind::PalletLift => "pallet-lift",
            DeviceKind::AisleLift => "aisle-lift",
            DeviceKind::Conveyor => "conveyor",
            DeviceKind::TransferCar => "transfer-car",
        }
    }
    pub fn is_shuttle(self) -> bool {
        matches!(
            self,
            DeviceKind::AisleShuttle | DeviceKind::LayerShuttle | DeviceKind::FourWayShuttle
        )
    }
    pub fn is_lift(self) -> bool {
        matches!(self, DeviceKind::PalletLift | DeviceKind::AisleLift)
    }
}

#[derive(Debug, Clone)]
pub struct LevelSpec {
    pub level: i32,
    pub y_m: f64,
}

#[derive(Debug, Clone)]
pub struct RackSpec {
    pub id: String,
    pub area_id: String,
    pub aisle_id: String,
    pub kind: RackKind,
    pub bays: i32,
    pub depths: i32,
    pub levels: Vec<LevelSpec>,
    pub size: [f64; 3],
    pub max_weight_kg: f64,
    pub max_volume_m3: f64,
    pub origin: [f64; 3],
    pub bay_axis: [f64; 2],
    pub depth_axis: [f64; 2],
}

#[derive(Debug, Clone)]
pub struct AisleSpec {
    pub id: String,
    pub area_id: String,
    pub end_node_ids: [String; 2],
    pub axis: [f64; 2],
    pub length_m: f64,
    pub bidirectional: bool,
    pub level: i32,
    pub rack_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct NodeSpec {
    pub id: String,
    pub position: [f64; 3],
    pub kind: String,
    pub area_id: Option<String>,
    pub aisle_id: Option<String>,
    pub level: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkMode {
    Road,
    Rail,
    LiftShaft,
    Conveyor,
}

impl LinkMode {
    pub fn parse(s: &str) -> LinkMode {
        match s {
            "rail" => LinkMode::Rail,
            "lift-shaft" => LinkMode::LiftShaft,
            "conveyor" => LinkMode::Conveyor,
            _ => LinkMode::Road,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            LinkMode::Road => "road",
            LinkMode::Rail => "rail",
            LinkMode::LiftShaft => "lift-shaft",
            LinkMode::Conveyor => "conveyor",
        }
    }
    /// 骨架上的默认运动学（真实设备时间由 `MotionProfile` 覆盖）。
    pub fn default_motion(self) -> (f64, f64) {
        match self {
            LinkMode::Rail => (2.6, 1.3),
            LinkMode::Conveyor => (0.8, 0.4),
            LinkMode::LiftShaft => (0.9, 0.7),
            LinkMode::Road => (1.8, 1.0),
        }
    }
}

#[derive(Debug, Clone)]
pub struct LinkSpec {
    pub id: String,
    pub from: String,
    pub to: String,
    pub bidirectional: bool,
    pub mode: LinkMode,
    pub length_m: f64,
    pub capacity: i32,
    pub allow_meeting: bool,
}

#[derive(Debug, Clone)]
pub struct AreaSpec {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub center: [f64; 2],
    pub size: [f64; 2],
    pub height_m: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StationDirection {
    Inbound,
    Outbound,
    Both,
}

impl StationDirection {
    pub fn parse(s: &str) -> StationDirection {
        match s {
            "inbound" => StationDirection::Inbound,
            "both" => StationDirection::Both,
            _ => StationDirection::Outbound,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            StationDirection::Inbound => "inbound",
            StationDirection::Outbound => "outbound",
            StationDirection::Both => "both",
        }
    }
    pub fn outbound(self) -> bool {
        matches!(self, StationDirection::Outbound | StationDirection::Both)
    }
    pub fn inbound(self) -> bool {
        matches!(self, StationDirection::Inbound | StationDirection::Both)
    }
}

#[derive(Debug, Clone)]
pub struct StationSpec {
    pub id: String,
    pub name: String,
    pub area_id: String,
    pub node_id: String,
    pub direction: StationDirection,
    pub buffer_capacity: i32,
    pub handover_s: f64,
    pub served_by: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct BufferSpec {
    pub id: String,
    pub node_id: String,
    pub area_id: String,
    pub capacity: i32,
    pub dwell_limit_s: f64,
}

#[derive(Debug, Clone)]
pub struct MotionProfile {
    pub speed_mps: f64,
    pub accel_mps2: f64,
    pub transfer_s: f64,
    pub handover_s: f64,
    pub change_level_s: f64,
    pub loaded_speed_factor: f64,
}

impl MotionProfile {
    pub fn parse(obj: &Json, path: &str, issues: &mut Issues) -> MotionProfile {
        let profile = MotionProfile {
            speed_mps: opt_f64(obj, "speed_mps").unwrap_or_else(|| {
                issues.error(codes::MISSING_FIELD, format!("{path}.speed_mps"), "缺少速度");
                1.0
            }),
            accel_mps2: opt_f64(obj, "accel_mps2").unwrap_or(0.8),
            transfer_s: opt_f64(obj, "transfer_s").unwrap_or(6.0),
            handover_s: opt_f64(obj, "handover_s").unwrap_or(8.0),
            change_level_s: opt_f64(obj, "change_level_s").unwrap_or(12.0),
            loaded_speed_factor: opt_f64(obj, "loaded_speed_factor").unwrap_or(1.0),
        };
        if profile.speed_mps <= 0.0 {
            issues.error(codes::VALUE_RANGE, format!("{path}.speed_mps"), "速度必须为正");
        }
        if profile.accel_mps2 <= 0.0 {
            issues.error(codes::VALUE_RANGE, format!("{path}.accel_mps2"), "加速度必须为正");
        }
        profile
    }
}

#[derive(Debug, Clone)]
pub struct DeviceCapability {
    pub aisles: Vec<String>,
    pub levels: Vec<i32>,
    pub areas: Vec<String>,
    pub capacity_loads: i32,
    pub capacity_kg: f64,
}

#[derive(Debug, Clone)]
pub struct DeviceSpec {
    pub id: String,
    pub kind: DeviceKind,
    pub name: String,
    pub home_node_id: String,
    pub capability: DeviceCapability,
    pub motion: MotionProfile,
    pub exclusive_resources: Vec<String>,
    pub shares_space_with: Vec<String>,
    pub energy_kwh_per_move: f64,
    pub energy_kwh_per_meter: f64,
    pub status_state: String,
    pub speed_factor: f64,
}

/// 仓储拓扑（两个算法模块共享的语义）。
#[derive(Debug, Clone)]
pub struct Topology {
    pub id: String,
    pub name: String,
    pub template_name: String,
    pub areas: Vec<AreaSpec>,
    pub racks: Vec<RackSpec>,
    pub aisles: Vec<AisleSpec>,
    pub nodes: Vec<NodeSpec>,
    pub links: Vec<LinkSpec>,
    pub stations: Vec<StationSpec>,
    pub buffers: Vec<BufferSpec>,
    pub devices: Vec<DeviceSpec>,
    pub closed_links: BTreeSet<String>,
    pub frozen_locations: BTreeSet<String>,
    pub reserved_locations: BTreeSet<String>,
}

impl Topology {
    pub fn node(&self, id: &str) -> Option<&NodeSpec> {
        self.nodes.iter().find(|n| n.id == id)
    }
    pub fn device(&self, id: &str) -> Option<&DeviceSpec> {
        self.devices.iter().find(|d| d.id == id)
    }
    pub fn station(&self, id: &str) -> Option<&StationSpec> {
        self.stations.iter().find(|s| s.id == id)
    }
    pub fn rack(&self, id: &str) -> Option<&RackSpec> {
        self.racks.iter().find(|r| r.id == id)
    }
    pub fn outbound_stations(&self) -> Vec<&StationSpec> {
        self.stations.iter().filter(|s| s.direction.outbound()).collect()
    }
    pub fn inbound_stations(&self) -> Vec<&StationSpec> {
        self.stations.iter().filter(|s| s.direction.inbound()).collect()
    }
}

pub fn parse_topology(obj: &Json, path: &str, issues: &mut Issues) -> Topology {
    let mut topology = Topology {
        id: opt_str(obj, "id").unwrap_or_else(|| "WH-UNKNOWN".to_string()),
        name: opt_str(obj, "name").unwrap_or_default(),
        template_name: opt_str(obj, "template").unwrap_or_else(|| "custom".to_string()),
        areas: Vec::new(),
        racks: Vec::new(),
        aisles: Vec::new(),
        nodes: Vec::new(),
        links: Vec::new(),
        stations: Vec::new(),
        buffers: Vec::new(),
        devices: Vec::new(),
        closed_links: str_array(obj, "closedLinks").into_iter().collect(),
        frozen_locations: str_array(obj, "frozenLocations").into_iter().collect(),
        reserved_locations: str_array(obj, "reservedLocations").into_iter().collect(),
    };

    for (i, area) in arr(obj, "areas").iter().enumerate() {
        let p = format!("{path}.areas[{i}]");
        topology.areas.push(AreaSpec {
            id: req_str(area, "id", &p, issues),
            name: opt_str(area, "name").unwrap_or_default(),
            kind: opt_str(area, "kind").unwrap_or_else(|| "asrs".to_string()),
            center: {
                let v = num_array(area, "center");
                [*v.first().unwrap_or(&0.0), *v.get(1).unwrap_or(&0.0)]
            },
            size: {
                let v = num_array(area, "size");
                [*v.first().unwrap_or(&0.0), *v.get(1).unwrap_or(&0.0)]
            },
            height_m: opt_f64(area, "height_m").unwrap_or(6.0),
        });
    }

    for (i, rack) in arr(obj, "racks").iter().enumerate() {
        let p = format!("{path}.racks[{i}]");
        let levels: Vec<LevelSpec> = arr(rack, "levels")
            .iter()
            .enumerate()
            .map(|(j, level)| LevelSpec {
                level: opt_i64(level, "level").unwrap_or((j + 1) as i64) as i32,
                y_m: opt_f64(level, "y_m").unwrap_or(j as f64 * 1.8),
            })
            .collect();
        if levels.is_empty() {
            issues.error(codes::MISSING_FIELD, format!("{p}.levels"), "货架必须至少有一层");
        }
        let size = vec3(rack, "locationSize").unwrap_or([1.3, 1.1, 1.8]);
        // 契约里 locationSize 的字段名是 width/depth/height 语义：x=宽度、y=高度、z=深度
        let size = [
            field(rack, "locationSize").and_then(|s| opt_f64(s, "width_m")).unwrap_or(size[0]),
            field(rack, "locationSize").and_then(|s| opt_f64(s, "height_m")).unwrap_or(size[2]),
            field(rack, "locationSize").and_then(|s| opt_f64(s, "depth_m")).unwrap_or(size[1]),
        ];
        topology.racks.push(RackSpec {
            id: req_str(rack, "id", &p, issues),
            area_id: opt_str(rack, "areaId").unwrap_or_default(),
            aisle_id: req_str(rack, "aisleId", &p, issues),
            kind: RackKind::parse(&opt_str(rack, "kind").unwrap_or_else(|| "single-deep".to_string())),
            bays: req_i64(rack, "bays", &p, issues) as i32,
            depths: req_i64(rack, "depths", &p, issues) as i32,
            levels,
            size,
            max_weight_kg: opt_f64(rack, "maxWeight_kg").unwrap_or(1000.0),
            max_volume_m3: opt_f64(rack, "maxVolume_m3").unwrap_or(1.6),
            origin: vec3(rack, "origin").unwrap_or([0.0, 0.0, 0.0]),
            bay_axis: {
                let v = num_array(rack, "bayAxis");
                [*v.first().unwrap_or(&1.0), *v.get(1).unwrap_or(&0.0)]
            },
            depth_axis: {
                let v = num_array(rack, "depthAxis");
                [*v.first().unwrap_or(&0.0), *v.get(1).unwrap_or(&1.0)]
            },
        });
    }

    for (i, aisle) in arr(obj, "aisles").iter().enumerate() {
        let p = format!("{path}.aisles[{i}]");
        let ends = str_array(aisle, "endNodeIds");
        topology.aisles.push(AisleSpec {
            id: req_str(aisle, "id", &p, issues),
            area_id: opt_str(aisle, "areaId").unwrap_or_default(),
            end_node_ids: [
                ends.first().cloned().unwrap_or_default(),
                ends.get(1).cloned().unwrap_or_default(),
            ],
            axis: {
                let v = num_array(aisle, "axis");
                [*v.first().unwrap_or(&1.0), *v.get(1).unwrap_or(&0.0)]
            },
            length_m: opt_f64(aisle, "length_m").unwrap_or(0.0),
            bidirectional: opt_bool(aisle, "bidirectional").unwrap_or(true),
            level: opt_i64(aisle, "level").unwrap_or(1) as i32,
            rack_ids: str_array(aisle, "rackIds"),
        });
    }

    for (i, node) in arr(obj, "nodes").iter().enumerate() {
        let p = format!("{path}.nodes[{i}]");
        topology.nodes.push(NodeSpec {
            id: req_str(node, "id", &p, issues),
            position: vec3(node, "position").unwrap_or([0.0, 0.0, 0.0]),
            kind: opt_str(node, "kind").unwrap_or_else(|| "aisle-end".to_string()),
            area_id: opt_str(node, "areaId"),
            aisle_id: opt_str(node, "aisleId"),
            level: opt_i64(node, "level").map(|v| v as i32),
        });
    }

    for (i, link) in arr(obj, "links").iter().enumerate() {
        let p = format!("{path}.links[{i}]");
        topology.links.push(LinkSpec {
            id: req_str(link, "id", &p, issues),
            from: req_str(link, "from", &p, issues),
            to: req_str(link, "to", &p, issues),
            bidirectional: opt_bool(link, "bidirectional").unwrap_or(true),
            mode: LinkMode::parse(&opt_str(link, "mode").unwrap_or_else(|| "road".to_string())),
            length_m: opt_f64(link, "length_m").unwrap_or(0.0),
            capacity: opt_i64(link, "capacity").unwrap_or(2) as i32,
            allow_meeting: opt_bool(link, "allowMeeting").unwrap_or(true),
        });
    }

    for (i, station) in arr(obj, "stations").iter().enumerate() {
        let p = format!("{path}.stations[{i}]");
        topology.stations.push(StationSpec {
            id: req_str(station, "id", &p, issues),
            name: opt_str(station, "name").unwrap_or_default(),
            area_id: opt_str(station, "areaId").unwrap_or_default(),
            node_id: req_str(station, "nodeId", &p, issues),
            direction: StationDirection::parse(
                &opt_str(station, "direction").unwrap_or_else(|| "both".to_string()),
            ),
            buffer_capacity: opt_i64(station, "bufferCapacity").unwrap_or(0) as i32,
            handover_s: opt_f64(station, "handover_s").unwrap_or(8.0),
            served_by: str_array(station, "servedBy"),
        });
    }

    for (i, buffer) in arr(obj, "buffers").iter().enumerate() {
        let p = format!("{path}.buffers[{i}]");
        topology.buffers.push(BufferSpec {
            id: req_str(buffer, "id", &p, issues),
            node_id: req_str(buffer, "nodeId", &p, issues),
            area_id: opt_str(buffer, "areaId").unwrap_or_default(),
            capacity: opt_i64(buffer, "capacity").unwrap_or(0) as i32,
            dwell_limit_s: opt_f64(buffer, "dwellLimit_s").unwrap_or(0.0),
        });
    }

    for (i, device) in arr(obj, "devices").iter().enumerate() {
        let p = format!("{path}.devices[{i}]");
        let motion_json = field(device, "motion").unwrap_or(&Json::Null);
        let motion = MotionProfile::parse(
            if matches!(motion_json, Json::Null) { device } else { motion_json },
            &p,
            issues,
        );
        let capability_json = field(device, "capability").unwrap_or(&Json::Null);
        let status_json = field(device, "status").unwrap_or(&Json::Null);
        let energy_json = field(device, "energy").unwrap_or(&Json::Null);
        topology.devices.push(DeviceSpec {
            id: req_str(device, "id", &p, issues),
            kind: DeviceKind::parse(&opt_str(device, "kind").unwrap_or_else(|| "aisle-shuttle".to_string())),
            name: opt_str(device, "name").unwrap_or_default(),
            home_node_id: req_str(device, "homeNodeId", &p, issues),
            capability: DeviceCapability {
                aisles: str_array(capability_json, "aisles"),
                levels: num_array(capability_json, "levels")
                    .into_iter()
                    .map(|v| v as i32)
                    .collect(),
                areas: str_array(capability_json, "areas"),
                capacity_loads: opt_i64(capability_json, "capacity_loads").unwrap_or(1) as i32,
                capacity_kg: opt_f64(capability_json, "capacity_kg").unwrap_or(1000.0),
            },
            motion,
            exclusive_resources: {
                let coupling = field(device, "coupling").unwrap_or(&Json::Null);
                str_array(coupling, "exclusiveResources")
            },
            shares_space_with: {
                let coupling = field(device, "coupling").unwrap_or(&Json::Null);
                str_array(coupling, "sharesSpaceWith")
            },
            energy_kwh_per_move: opt_f64(energy_json, "kwh_per_move").unwrap_or(0.01),
            energy_kwh_per_meter: opt_f64(energy_json, "kwh_per_meter").unwrap_or(0.002),
            status_state: opt_str(status_json, "state").unwrap_or_else(|| "up".to_string()),
            speed_factor: opt_f64(status_json, "speedFactor").unwrap_or(1.0),
        });
    }

    validate_topology(&topology, path, issues);
    topology
}

/// 拓扑自洽性校验（"不许生成与结构不一致的数据"的第一道闸门）。
pub fn validate_topology(topology: &Topology, path: &str, issues: &mut Issues) {
    let node_ids: BTreeSet<&str> = topology.nodes.iter().map(|n| n.id.as_str()).collect();
    let aisle_ids: BTreeSet<&str> = topology.aisles.iter().map(|a| a.id.as_str()).collect();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for rack in &topology.racks {
        if !seen.insert(rack.id.as_str()) {
            issues.error(codes::DUPLICATE_ID, format!("{path}.racks.{}.id", rack.id), "货架 id 重复");
        }
        if !aisle_ids.contains(rack.aisle_id.as_str()) {
            issues.error(
                codes::UNKNOWN_REFERENCE,
                format!("{path}.racks.{}", rack.id),
                format!("巷道不存在：{}", rack.aisle_id),
            );
        }
        if rack.bays < 1 || rack.depths < 1 || rack.levels.is_empty() {
            issues.error(
                codes::VALUE_RANGE,
                format!("{path}.racks.{}", rack.id),
                "bays / depths / levels 必须 ≥ 1",
            );
        }
        if rack.kind.is_deep() && rack.depths < 2 {
            issues.error(
                codes::VALUE_RANGE,
                format!("{path}.racks.{}.depths", rack.id),
                format!("{} 的深度必须 ≥ 2", rack.kind.as_str()),
            );
        }
    }
    for aisle in &topology.aisles {
        for end in &aisle.end_node_ids {
            if end.is_empty() || !node_ids.contains(end.as_str()) {
                issues.error(
                    codes::UNKNOWN_REFERENCE,
                    format!("{path}.aisles.{}.endNodeIds", aisle.id),
                    format!("端点节点不存在：{end}"),
                );
            }
        }
        if aisle.rack_ids.is_empty() {
            issues.error(
                codes::TOPOLOGY_INVALID,
                format!("{path}.aisles.{}", aisle.id),
                "巷道未挂接任何货架",
            );
        }
    }
    for device in &topology.devices {
        if !node_ids.contains(device.home_node_id.as_str()) {
            issues.error(
                codes::UNKNOWN_REFERENCE,
                format!("{path}.devices.{}.homeNodeId", device.id),
                format!("初始节点不存在：{}", device.home_node_id),
            );
        }
        if device.capability.capacity_loads < 1 {
            issues.error(
                codes::VALUE_RANGE,
                format!("{path}.devices.{}.capability.capacity_loads", device.id),
                "载具容量必须 ≥ 1",
            );
        }
    }
    for link in &topology.links {
        if !node_ids.contains(link.from.as_str()) || !node_ids.contains(link.to.as_str()) {
            issues.error(
                codes::UNKNOWN_REFERENCE,
                format!("{path}.links.{}", link.id),
                "通道端点节点不存在",
            );
        }
        if link.length_m <= 0.0 {
            issues.error(
                codes::VALUE_RANGE,
                format!("{path}.links.{}.length_m", link.id),
                "通道长度必须为正（由几何推导）",
            );
        }
    }
    for station in &topology.stations {
        if !node_ids.contains(station.node_id.as_str()) {
            issues.error(
                codes::UNKNOWN_REFERENCE,
                format!("{path}.stations.{}.nodeId", station.id),
                format!("站点节点不存在：{}", station.node_id),
            );
        }
        if station.buffer_capacity < 0 {
            issues.error(
                codes::VALUE_RANGE,
                format!("{path}.stations.{}.bufferCapacity", station.id),
                "缓存位不能为负",
            );
        }
    }
    for buffer in &topology.buffers {
        if !node_ids.contains(buffer.node_id.as_str()) {
            issues.error(
                codes::UNKNOWN_REFERENCE,
                format!("{path}.buffers.{}.nodeId", buffer.id),
                format!("缓存节点不存在：{}", buffer.node_id),
            );
        }
    }
    // 可达性：每台设备必须能从初始节点走到至少一条巷道端点或站台
    let adjacency = topology::adjacency(topology);
    for device in &topology.devices {
        let reachable = topology::bfs(&adjacency, &device.home_node_id);
        let has_work = reachable
            .iter()
            .any(|id| id.starts_with("N-A") || id.starts_with("N-ST"));
        if !has_work {
            issues.error(
                codes::UNREACHABLE,
                format!("{path}.devices.{}", device.id),
                "设备从其初始节点无法到达任何巷道 / 站台（不可用配置）",
            );
        }
    }
}

/* ------------------------------------------------------------------ *
 * 商品 / 库存 / 订单
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone)]
pub struct SkuSpec {
    pub id: String,
    pub name: String,
    pub category: String,
    pub load_unit: String,
    pub unit_weight_kg: f64,
    pub unit_volume_m3: f64,
    pub abc: char,
    pub xyz: char,
    pub mean_daily_demand: f64,
    pub demand_cv: f64,
    pub allowed_zones: Vec<String>,
    pub temperature: String,
    pub batch_policy: String,
    pub affinity_cluster: Option<String>,
}

#[derive(Debug, Clone)]
pub struct InventoryUnit {
    pub id: String,
    pub sku_id: String,
    pub quantity: f64,
    pub batch: String,
    pub inbound_at_s: f64,
    pub expires_at_s: Option<f64>,
    pub location_id: Option<String>,
    pub status: String,
    pub returned: bool,
}

#[derive(Debug, Clone)]
pub struct OrderLine {
    pub sku_id: String,
    pub quantity: f64,
}

#[derive(Debug, Clone)]
pub struct CustomerOrder {
    pub id: String,
    pub release_s: f64,
    pub due_s: f64,
    pub priority: i64,
    pub channel: String,
    pub lines: Vec<OrderLine>,
    pub appointment: Option<[f64; 2]>,
}

#[derive(Debug, Clone)]
pub struct DemandProfile {
    pub shape: String,
    pub horizon_days: i64,
    pub hourly_factor: Vec<f64>,
    pub lines_per_order: f64,
    pub lines_per_order_cv: f64,
    pub promo_factor: f64,
    pub return_rate: f64,
}

impl Default for DemandProfile {
    fn default() -> Self {
        DemandProfile {
            shape: "abc".to_string(),
            horizon_days: 7,
            hourly_factor: Vec::new(),
            lines_per_order: 2.0,
            lines_per_order_cv: 0.6,
            promo_factor: 1.0,
            return_rate: 0.02,
        }
    }
}

pub fn parse_skus(obj: &Json, path: &str, issues: &mut Issues) -> Vec<SkuSpec> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut out = Vec::new();
    for (i, sku) in arr(obj, "skus").iter().enumerate() {
        let p = format!("{path}.skus[{i}]");
        let id = req_str(sku, "id", &p, issues);
        if !seen.insert(id.clone()) {
            issues.error(codes::DUPLICATE_ID, format!("{p}.id"), format!("SKU id 重复：{id}"));
        }
        let unit_size = field(sku, "unitSize").unwrap_or(&Json::Null);
        let volume = opt_f64(unit_size, "unitVolume_m3").or_else(|| opt_f64(sku, "unitVolume_m3"));
        let volume = volume.unwrap_or_else(|| {
            let w = opt_f64(unit_size, "width_m").unwrap_or(0.8);
            let d = opt_f64(unit_size, "depth_m").unwrap_or(0.6);
            let h = opt_f64(unit_size, "height_m").unwrap_or(0.4);
            w * d * h
        });
        out.push(SkuSpec {
            id,
            name: opt_str(sku, "name").unwrap_or_default(),
            category: opt_str(sku, "category").unwrap_or_else(|| "常温".to_string()),
            load_unit: opt_str(sku, "loadUnit").unwrap_or_else(|| "pallet".to_string()),
            unit_weight_kg: opt_f64(sku, "unitWeight_kg").unwrap_or(20.0),
            unit_volume_m3: volume,
            abc: opt_str(sku, "abc").and_then(|s| s.chars().next()).unwrap_or('C'),
            xyz: opt_str(sku, "xyz").and_then(|s| s.chars().next()).unwrap_or('Y'),
            mean_daily_demand: opt_f64(sku, "meanDailyDemand").unwrap_or(1.0),
            demand_cv: opt_f64(sku, "demandCv").unwrap_or(0.4),
            allowed_zones: str_array(sku, "allowedZones"),
            temperature: opt_str(sku, "temperature").unwrap_or_else(|| "ambient".to_string()),
            batch_policy: opt_str(sku, "batchPolicy").unwrap_or_else(|| "none".to_string()),
            affinity_cluster: opt_str(sku, "affinityCluster"),
        });
    }
    out
}

pub fn parse_inventory(obj: &Json, path: &str, issues: &mut Issues) -> Vec<InventoryUnit> {
    let mut out = Vec::new();
    let loc_key = {
        // 兼容 `locationId` 与 `location`（生成器只用前者）
        "locationId"
    };
    // 数组键名：库位优化文档用 `inventory`，调度文档用 `loadUnits`（两者都是货物单元集合）
    let units = {
        let primary = arr(obj, "inventory");
        if primary.is_empty() {
            arr(obj, "loadUnits")
        } else {
            primary
        }
    };
    for (i, unit) in units.iter().enumerate() {
        let p = format!("{path}.inventory[{i}]");
        out.push(InventoryUnit {
            id: req_str(unit, "id", &p, issues),
            sku_id: req_str(unit, "skuId", &p, issues),
            quantity: opt_f64(unit, "quantity").unwrap_or(1.0),
            batch: opt_str(unit, "batch").unwrap_or_else(|| "B01".to_string()),
            inbound_at_s: opt_f64(unit, "inboundAt_s")
                .or_else(|| opt_f64(unit, "inbound_at_s"))
                .unwrap_or(0.0),
            expires_at_s: opt_f64(unit, "expiresAt_s").or_else(|| opt_f64(unit, "expires_at_s")),
            location_id: opt_str(unit, loc_key),
            status: opt_str(unit, "status").unwrap_or_else(|| "stored".to_string()),
            returned: opt_bool(unit, "returned").unwrap_or(false),
        });
    }
    out
}

pub fn parse_orders(obj: &Json, path: &str) -> Vec<CustomerOrder> {
    let mut out = Vec::new();
    for order in arr(obj, "history") {
        let lines: Vec<OrderLine> = arr(order, "lines")
            .iter()
            .map(|line| OrderLine {
                sku_id: opt_str(line, "skuId").unwrap_or_default(),
                quantity: opt_f64(line, "quantity").unwrap_or(1.0),
            })
            .collect();
        out.push(CustomerOrder {
            id: opt_str(order, "id").unwrap_or_else(|| format!("SO-{}", out.len() + 1)),
            release_s: opt_f64(order, "release_s").unwrap_or(0.0),
            due_s: opt_f64(order, "due_s").unwrap_or(0.0),
            priority: opt_i64(order, "priority").unwrap_or(5),
            channel: opt_str(order, "channel").unwrap_or_else(|| "standard".to_string()),
            lines,
            appointment: {
                let v = num_array(order, "appointment");
                if v.len() >= 2 {
                    Some([v[0], v[1]])
                } else {
                    None
                }
            },
        });
    }
    let _ = path;
    out
}

pub fn parse_demand(obj: &Json) -> DemandProfile {
    let Some(demand) = field(obj, "demand") else {
        return DemandProfile::default();
    };
    DemandProfile {
        shape: opt_str(demand, "shape").unwrap_or_else(|| "abc".to_string()),
        horizon_days: opt_i64(demand, "horizonDays").unwrap_or(7),
        hourly_factor: num_array(demand, "hourlyFactor"),
        lines_per_order: opt_f64(demand, "linesPerOrder").unwrap_or(2.0),
        lines_per_order_cv: opt_f64(demand, "linesPerOrderCv").unwrap_or(0.6),
        promo_factor: 1.0,
        return_rate: opt_f64(demand, "returnRate").unwrap_or(0.02),
    }
}

/* ------------------------------------------------------------------ *
 * 目标 / 约束 / 算法配置
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone)]
pub struct ObjectiveSpec {
    pub id: String,
    pub direction: String,
    pub weight: f64,
    pub unit: String,
    pub normalizer: Option<f64>,
    pub note: String,
}

pub fn parse_objectives(obj: &Json, key: &str) -> Vec<ObjectiveSpec> {
    arr(obj, key)
        .iter()
        .map(|o| ObjectiveSpec {
            id: opt_str(o, "id").unwrap_or_default(),
            direction: opt_str(o, "direction").unwrap_or_else(|| "min".to_string()),
            weight: opt_f64(o, "weight").unwrap_or(1.0),
            unit: opt_str(o, "unit").unwrap_or_default(),
            normalizer: opt_f64(o, "normalizer"),
            note: opt_str(o, "note").unwrap_or_default(),
        })
        .collect()
}

#[derive(Debug, Clone, Default)]
pub struct SlottingConstraints {
    pub min_locations_per_sku: i32,
    pub max_locations_per_sku: i32,
    pub max_aisle_share_per_sku: f64,
    pub allow_split_load_unit: bool,
    pub deep_lane_policy: String,
    pub batch_policy: String,
    pub max_unassigned_share: f64,
}

impl SlottingConstraints {
    pub fn parse(obj: &Json) -> SlottingConstraints {
        let constraints = field(obj, "constraints").unwrap_or(&Json::Null);
        let dispersion = field(constraints, "dispersion").unwrap_or(&Json::Null);
        SlottingConstraints {
            min_locations_per_sku: opt_i64(dispersion, "minLocationsPerSku").unwrap_or(0) as i32,
            max_locations_per_sku: opt_i64(dispersion, "maxLocationsPerSku").unwrap_or(0) as i32,
            max_aisle_share_per_sku: opt_f64(dispersion, "maxAisleSharePerSku").unwrap_or(1.0),
            allow_split_load_unit: opt_bool(constraints, "allowSplitLoadUnit").unwrap_or(false),
            deep_lane_policy: opt_str(constraints, "deepLanePolicy")
                .unwrap_or_else(|| "front-only".to_string()),
            batch_policy: opt_str(constraints, "batchPolicy").unwrap_or_else(|| "none".to_string()),
            max_unassigned_share: opt_f64(constraints, "maxUnassignedShare").unwrap_or(0.0),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SlottingAlgorithmConfig {
    pub algorithm: String,
    pub seed: u64,
    pub budget_ms: f64,
    pub max_iterations: u64,
    pub operators: Vec<String>,
    pub temperature: f64,
    pub tabu_tenure: u64,
    pub destroy_share: f64,
    pub pareto_population: usize,
    pub pareto_generations: usize,
    pub robust_scenarios: usize,
    pub robust_measure: String,
    pub robust_cvar_alpha: f64,
    pub migration_max_moves: usize,
    pub migration_max_seconds: f64,
    pub seeds: Vec<u64>,
    /// 小规模实例上直接跑精确分派并把线性松弛的最优性结论写进报告。
    pub exact_when_small: bool,
    pub exact_max_units: usize,
}

impl Default for SlottingAlgorithmConfig {
    fn default() -> Self {
        SlottingAlgorithmConfig {
            algorithm: "affinity-lns".to_string(),
            seed: 1,
            budget_ms: 3000.0,
            max_iterations: 4000,
            operators: vec![
                "worst-removal".to_string(),
                "related-removal".to_string(),
                "cluster-move".to_string(),
                "aisle-balance".to_string(),
            ],
            temperature: 0.01,
            tabu_tenure: 0,
            destroy_share: 0.08,
            pareto_population: 24,
            pareto_generations: 12,
            robust_scenarios: 8,
            robust_measure: "cvar".to_string(),
            robust_cvar_alpha: 0.25,
            migration_max_moves: 300,
            migration_max_seconds: 14400.0,
            seeds: Vec::new(),
            exact_when_small: true,
            exact_max_units: 48,
        }
    }
}

impl SlottingAlgorithmConfig {
    pub fn parse(obj: &Json) -> SlottingAlgorithmConfig {
        let algorithm = field(obj, "algorithm").unwrap_or(&Json::Null);
        let pareto = field(algorithm, "pareto").unwrap_or(&Json::Null);
        let robust = field(algorithm, "robust").unwrap_or(&Json::Null);
        let migration = field(algorithm, "migrationBudget").unwrap_or(&Json::Null);
        let mut config = SlottingAlgorithmConfig::default();
        config.algorithm = opt_str(algorithm, "algorithm").unwrap_or(config.algorithm);
        config.seed = opt_i64(algorithm, "seed").unwrap_or(1).max(0) as u64;
        config.budget_ms = opt_f64(algorithm, "budget_ms").unwrap_or(3000.0);
        config.max_iterations = opt_i64(algorithm, "maxIterations").unwrap_or(4000).max(1) as u64;
        let operators = str_array(algorithm, "operators");
        if !operators.is_empty() {
            config.operators = operators;
        }
        config.temperature = opt_f64(algorithm, "temperature").unwrap_or(0.01);
        config.pareto_population = opt_i64(pareto, "populationSize").unwrap_or(24) as usize;
        config.pareto_generations = opt_i64(pareto, "generations").unwrap_or(12) as usize;
        config.robust_scenarios = opt_i64(robust, "scenarios").unwrap_or(8).max(1) as usize;
        config.robust_measure = opt_str(robust, "measure").unwrap_or_else(|| "cvar".to_string());
        config.robust_cvar_alpha = opt_f64(robust, "cvarAlpha").unwrap_or(0.25);
        config.migration_max_moves = opt_i64(migration, "maxMoves").unwrap_or(300).max(0) as usize;
        config.migration_max_seconds = opt_f64(migration, "maxDeviceSeconds").unwrap_or(14400.0);
        config.seeds = num_array(algorithm, "seeds")
            .into_iter()
            .map(|v| v.max(0.0) as u64)
            .collect();
        config.exact_when_small = opt_bool(algorithm, "exactWhenSmall").unwrap_or(true);
        config.exact_max_units = opt_i64(algorithm, "exactMaxUnits").unwrap_or(48).clamp(1, 400) as usize;
        config
    }
}

/* ------------------------------------------------------------------ *
 * 问题：库位优化
 * ------------------------------------------------------------------ */

/// 成本模型参数（每一项都能在报告里解释；未声明时使用引擎的显式默认值）。
#[derive(Debug, Clone, Default)]
pub struct CostModelSpec {
    pub outbound_share: Option<f64>,
    pub handling_seconds: Option<f64>,
    pub aisle_utilization_target: Option<f64>,
    pub lift_utilization_target: Option<f64>,
    pub congestion_scale: Option<f64>,
    pub timeliness_threshold_seconds: Option<f64>,
}

impl CostModelSpec {
    pub fn parse(obj: &Json) -> CostModelSpec {
        CostModelSpec {
            outbound_share: opt_f64(obj, "outboundShare"),
            handling_seconds: opt_f64(obj, "handlingSeconds"),
            aisle_utilization_target: opt_f64(obj, "aisleUtilizationTarget"),
            lift_utilization_target: opt_f64(obj, "liftUtilizationTarget"),
            congestion_scale: opt_f64(obj, "congestionScale"),
            timeliness_threshold_seconds: opt_f64(obj, "timelinessThresholdSeconds"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SlottingProblem {
    pub id: String,
    pub scenario_id: Option<String>,
    pub dataset_version: String,
    pub topology: Topology,
    pub skus: Vec<SkuSpec>,
    pub inventory: Vec<InventoryUnit>,
    pub history: Vec<CustomerOrder>,
    pub demand: DemandProfile,
    pub current_assignment: BTreeMap<String, String>,
    pub objectives: Vec<ObjectiveSpec>,
    pub constraints: SlottingConstraints,
    pub algorithm: SlottingAlgorithmConfig,
    pub cost_model: CostModelSpec,
    pub events: Vec<DynamicEvent>,
    pub hard_constraints: Vec<String>,
}

impl SlottingProblem {
    pub fn sku_index(&self) -> BTreeMap<&str, usize> {
        self.skus
            .iter()
            .enumerate()
            .map(|(i, s)| (s.id.as_str(), i))
            .collect()
    }
}

/// 求解入口的输入可能是裸问题文档，也可能是 `{"kind":..., "problem":{...}}` 信封。
/// 这里统一取到真正的问题对象；两种形状都合法，避免实验室与 CLI 出现两套约定。
pub fn problem_root(root: &Json) -> &Json {
    match root.get("problem") {
        Some(Json::Obj(_)) => root.get("problem").unwrap_or(root),
        _ => root,
    }
}

pub fn parse_slotting_problem(root: &Json, issues: &mut Issues) -> SlottingProblem {
    let root = problem_root(root);
    let path = "problem";
    let topology_json = field(root, "topology").unwrap_or(&Json::Null);
    if matches!(topology_json, Json::Null) {
        issues.error(codes::MISSING_FIELD, "problem.topology", "缺少仓储拓扑");
    }
    let topology = parse_topology(topology_json, "problem.topology", issues);
    let skus = parse_skus(root, path, issues);
    if skus.is_empty() {
        issues.warn(codes::EMPTY_INPUT, "problem.skus", "商品目录为空（库位优化将没有可选对象）");
    }
    let inventory = parse_inventory(root, path, issues);
    for unit in &inventory {
        if !skus.iter().any(|s| s.id == unit.sku_id) {
            issues.error(
                codes::UNKNOWN_REFERENCE,
                format!("problem.inventory.{}", unit.id),
                format!("货物单元引用了不存在的 SKU：{}", unit.sku_id),
            );
        }
    }
    let objectives = {
        let list = parse_objectives(root, "objectives");
        if list.is_empty() {
            issues.error(codes::MISSING_FIELD, "problem.objectives", "至少需要一个优化目标");
        }
        list
    };
    let hard_constraints = str_array(root, "hardConstraints");
    if hard_constraints.is_empty() {
        issues.warn(
            codes::SCHEMA_INVALID,
            "problem.hardConstraints",
            "未声明硬约束：验证器将按软约束处理（建议显式声明）",
        );
    }
    SlottingProblem {
        id: opt_str(root, "id").unwrap_or_else(|| "SLT-UNKNOWN".to_string()),
        scenario_id: opt_str(root, "scenarioId"),
        dataset_version: {
            let versions = field(root, "versions").unwrap_or(&Json::Null);
            opt_str(versions, "dataset").unwrap_or_else(|| "unknown".to_string())
        },
        topology,
        skus,
        inventory,
        history: parse_orders(root, path),
        demand: parse_demand(root),
        current_assignment: arr(root, "currentAssignment")
            .iter()
            .filter_map(|entry| {
                Some((opt_str(entry, "loadUnitId")?, opt_str(entry, "locationId")?))
            })
            .collect(),
        objectives,
        constraints: SlottingConstraints::parse(root),
        algorithm: SlottingAlgorithmConfig::parse(root),
        cost_model: CostModelSpec::parse(field(root, "costModel").unwrap_or(&Json::Null)),
        events: parse_dynamic_events(root),
        hard_constraints,
    }
}

/* ------------------------------------------------------------------ *
 * 问题：密集立库调度
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone)]
pub struct WarehouseTask {
    pub id: String,
    pub kind: String,
    pub priority: i64,
    pub release_s: f64,
    pub deadline_s: Option<f64>,
    pub from_location_id: Option<String>,
    pub from_node_id: Option<String>,
    pub to_location_id: Option<String>,
    pub to_node_id: Option<String>,
    pub load_unit_id: String,
    pub sku_id: String,
    pub depends_on: Vec<String>,
    pub order_id: Option<String>,
    pub dual_command_eligible: bool,
    pub cancellable: bool,
}

#[derive(Debug, Clone)]
pub struct DynamicEvent {
    pub kind: String,
    pub at_s: f64,
    pub payload: Json,
    /// 便捷字段（避免每次下游都去 payload 里翻）。
    pub device_ids: Vec<String>,
    pub task_ids: Vec<String>,
    pub location_ids: Vec<String>,
    pub link_ids: Vec<String>,
    pub tasks: Vec<WarehouseTask>,
    pub value: f64,
}

pub fn parse_task(obj: &Json, path: &str, issues: &mut Issues) -> WarehouseTask {
    WarehouseTask {
        id: req_str(obj, "id", path, issues),
        kind: opt_str(obj, "kind").unwrap_or_else(|| "outbound".to_string()),
        priority: opt_i64(obj, "priority").unwrap_or(5),
        release_s: opt_f64(obj, "release_s").unwrap_or(0.0),
        deadline_s: opt_f64(obj, "deadline_s"),
        from_location_id: opt_str(obj, "fromLocationId"),
        from_node_id: opt_str(obj, "fromNodeId"),
        to_location_id: opt_str(obj, "toLocationId"),
        to_node_id: opt_str(obj, "toNodeId"),
        load_unit_id: opt_str(obj, "loadUnitId").unwrap_or_default(),
        sku_id: opt_str(obj, "skuId").unwrap_or_default(),
        depends_on: str_array(obj, "dependsOn"),
        order_id: opt_str(obj, "orderId"),
        dual_command_eligible: opt_bool(obj, "dualCommandEligible").unwrap_or(true),
        cancellable: opt_bool(obj, "cancellable").unwrap_or(true),
    }
}

pub fn parse_dynamic_events(obj: &Json) -> Vec<DynamicEvent> {
    let mut events: Vec<DynamicEvent> = arr(obj, "events")
        .iter()
        .map(|event| {
            let kind = opt_str(event, "kind").unwrap_or_default();
            let mut parsed = DynamicEvent {
                kind: kind.clone(),
                at_s: opt_f64(event, "at_s").unwrap_or(0.0),
                payload: event.clone(),
                device_ids: str_array(event, "deviceIds"),
                task_ids: str_array(event, "taskIds"),
                location_ids: str_array(event, "locationIds"),
                link_ids: str_array(event, "linkIds"),
                tasks: Vec::new(),
                value: opt_f64(event, "priority")
                    .or_else(|| opt_f64(event, "deadline_s"))
                    .or_else(|| opt_f64(event, "speedFactor"))
                    .or_else(|| opt_f64(event, "capacity"))
                    .unwrap_or(0.0),
            };
            let mut sink = Issues::new();
            for task in arr(event, "tasks") {
                parsed.tasks.push(parse_task(task, "event.tasks[]", &mut sink));
            }
            parsed
        })
        .collect();
    events.sort_by(|a, b| a.at_s.partial_cmp(&b.at_s).unwrap_or(std::cmp::Ordering::Equal));
    events
}

#[derive(Debug, Clone)]
pub struct DispatchConfig {
    pub algorithm: String,
    pub seed: u64,
    pub budget_ms: f64,
    pub rolling_horizon_s: f64,
    pub dual_command: bool,
    pub cross_level_transfer: bool,
    pub conflict_policy: String,
    pub allow_yield: bool,
    pub simulation_horizon_s: f64,
    pub reschedule_policy: String,
    pub objectives: Vec<ObjectiveSpec>,
}

impl Default for DispatchConfig {
    fn default() -> Self {
        DispatchConfig {
            algorithm: "joint-alns".to_string(),
            seed: 7,
            budget_ms: 4000.0,
            rolling_horizon_s: 900.0,
            dual_command: true,
            cross_level_transfer: true,
            conflict_policy: "reservation".to_string(),
            allow_yield: true,
            simulation_horizon_s: 0.0,
            reschedule_policy: "preserve".to_string(),
            objectives: Vec::new(),
        }
    }
}

impl DispatchConfig {
    pub fn parse(obj: &Json) -> DispatchConfig {
        let dispatch = field(obj, "dispatch").unwrap_or(&Json::Null);
        let mut config = DispatchConfig::default();
        config.algorithm = opt_str(dispatch, "algorithm").unwrap_or(config.algorithm);
        config.seed = opt_i64(dispatch, "seed").unwrap_or(7).max(0) as u64;
        config.budget_ms = opt_f64(dispatch, "budget_ms").unwrap_or(4000.0);
        config.rolling_horizon_s = opt_f64(dispatch, "rollingHorizon_s").unwrap_or(900.0);
        config.dual_command = opt_bool(dispatch, "dualCommand").unwrap_or(true);
        config.cross_level_transfer = opt_bool(dispatch, "crossLevelTransfer").unwrap_or(true);
        config.conflict_policy =
            opt_str(dispatch, "conflictPolicy").unwrap_or_else(|| "reservation".to_string());
        config.allow_yield = opt_bool(dispatch, "allowYield").unwrap_or(true);
        config.simulation_horizon_s = opt_f64(dispatch, "simulationHorizon_s").unwrap_or(0.0);
        config.reschedule_policy =
            opt_str(dispatch, "reschedulePolicy").unwrap_or_else(|| "preserve".to_string());
        config.objectives = parse_objectives(dispatch, "objectives");
        config
    }
}

#[derive(Debug, Clone)]
pub struct AsrsProblem {
    pub id: String,
    pub scenario_id: Option<String>,
    pub dataset_version: String,
    pub topology: Topology,
    pub tasks: Vec<WarehouseTask>,
    pub load_units: Vec<InventoryUnit>,
    pub skus: Vec<SkuSpec>,
    pub dispatch: DispatchConfig,
    pub events: Vec<DynamicEvent>,
    pub hard_constraints: Vec<String>,
    pub slotting_plan: Option<(String, BTreeMap<String, String>)>,
}

pub fn parse_asrs_problem(root: &Json, issues: &mut Issues) -> AsrsProblem {
    let root = problem_root(root);
    let path = "problem";
    let topology_json = field(root, "topology").unwrap_or(&Json::Null);
    if matches!(topology_json, Json::Null) {
        issues.error(codes::MISSING_FIELD, "problem.topology", "缺少仓储拓扑");
    }
    let topology = parse_topology(topology_json, "problem.topology", issues);
    let skus = parse_skus(root, path, issues);
    let load_units = parse_inventory(root, path, issues);
    let mut tasks = Vec::new();
    for (i, task) in arr(root, "tasks").iter().enumerate() {
        tasks.push(parse_task(task, &format!("{path}.tasks[{i}]"), issues));
    }
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for task in &tasks {
        if !seen.insert(task.id.clone()) {
            issues.error(codes::DUPLICATE_ID, format!("{path}.tasks.{}", task.id), "任务 id 重复");
        }
        for dep in &task.depends_on {
            if !tasks.iter().any(|t| &t.id == dep) {
                issues.error(
                    codes::UNKNOWN_REFERENCE,
                    format!("{path}.tasks.{}.dependsOn", task.id),
                    format!("依赖任务不存在：{dep}"),
                );
            }
        }
    }
    let events = parse_dynamic_events(root);
    let slotting_plan = {
        let plan = field(root, "slottingPlan").unwrap_or(&Json::Null);
        let solution_id = opt_str(plan, "solutionId");
        match solution_id {
            Some(id) => {
                let map: BTreeMap<String, String> = arr(plan, "assignment")
                    .iter()
                    .filter_map(|entry| Some((opt_str(entry, "loadUnitId")?, opt_str(entry, "locationId")?)))
                    .collect();
                Some((id, map))
            }
            None => None,
        }
    };
    AsrsProblem {
        id: opt_str(root, "id").unwrap_or_else(|| "ASRS-UNKNOWN".to_string()),
        scenario_id: opt_str(root, "scenarioId"),
        dataset_version: {
            let versions = field(root, "versions").unwrap_or(&Json::Null);
            opt_str(versions, "dataset").unwrap_or_else(|| "unknown".to_string())
        },
        topology,
        tasks,
        load_units,
        skus,
        dispatch: DispatchConfig::parse(root),
        events,
        hard_constraints: str_array(root, "hardConstraints"),
        slotting_plan,
    }
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

trait JsonNumber {
    fn as_f64_value(&self) -> Option<f64>;
}

impl JsonNumber for Json {
    fn as_f64_value(&self) -> Option<f64> {
        as_f64(self)
    }
}

/// 结果的规范化 JSON（键排序 + 定点浮点）用于指纹与哈希。
pub fn canonical(value: &Json) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Json, out: &mut String) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Int(i) => out.push_str(&i.to_string()),
        Json::Float(f) => {
            if f.is_finite() {
                let rounded = (f * 1_000_000.0).round() / 1_000_000.0;
                if rounded.fract() == 0.0 && rounded.abs() < 1e15 {
                    out.push_str(&format!("{:.1}", rounded));
                } else {
                    out.push_str(&format!("{}", rounded));
                }
            } else {
                out.push_str("null");
            }
        }
        Json::Str(s) => {
            out.push('"');
            aps_engine::json::write_escaped(out, s);
            out.push('"');
        }
        Json::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Json::Obj(fields) => {
            let mut sorted: Vec<&(String, Json)> = fields.iter().collect();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            out.push('{');
            for (i, (key, item)) in sorted.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push('"');
                aps_engine::json::write_escaped(out, key);
                out.push_str("\":");
                write_canonical(item, out);
            }
            out.push('}');
        }
    }
}
