/**
 * Warehouse Optimization Suite · 版本化契约类型（`/1.0`）
 *
 * 这里定义两个算法模块**对外**的输入/输出形状，是整个交付的单一事实来源：
 *
 *   1. Warehouse Slotting Optimization：库位优化（问题 / 解 / 验证）
 *   2. High-Density AS/RS Scheduling：密集立库联合调度（问题 / 解 / 验证）
 *
 * 设计口径（与 SRS §11「对接与结果契约」一致）：
 *   - 两个模块共享同一套**仓储语义**（拓扑 / 库位 / SKU / 货物单元 / 订单 / 设备），
 *     但不共享求解器内部结构；契约可以独立版本化，字段只增不改语义；
 *   - 所有数量、时间、成本都带单位注释（米 / 秒 / 千克 / 立方米 / 元-秒）；
 *   - 结果里必须能回答"这个数字是怎么来的"：状态、目标分解、验证报告、时间线缺一不可；
 *   - 物理搬运任务（Task）与业务订单（Order）**严格分开**：一个订单可以对应多个任务，
 *     百万级订单不等于百万级提升机任务（SRS §8）。
 *
 * 本文件只有类型，不含任何计算逻辑，可被浏览器与 Node 同时引用。
 */

/* ------------------------------------------------------------------ *
 * 0. 版本与状态
 * ------------------------------------------------------------------ */

export const SLOTTING_PROBLEM_SCHEMA = 'warehouse-slotting-problem/1.0';
export const SLOTTING_SOLUTION_SCHEMA = 'warehouse-slotting-solution/1.0';
export const ASRS_PROBLEM_SCHEMA = 'warehouse-asrs-problem/1.0';
export const ASRS_SOLUTION_SCHEMA = 'warehouse-asrs-solution/1.0';
export const VERIFICATION_SCHEMA = 'warehouse-verification/1.0';
export const JOINT_SOLUTION_SCHEMA = 'warehouse-joint-solution/1.0';
export const CAPABILITIES_SCHEMA = 'warehouse-capabilities/1.0';
export const SCENARIO_SCHEMA = 'warehouse-scenario/1.0';

/**
 * 运行结果状态（SRS §6.2 的八种口径 —— 不允许合并）。
 *
 * 关键区分：
 *   - `FEASIBLE` + `budget_exceeded=true`：**超时但有有效解**；
 *   - `BUDGET_EXCEEDED`（无解）：超时且尚未找到有效解 —— 绝不等于"问题无解"；
 *   - `INFEASIBLE_PROVEN`：只有穷尽性论证（小规模精确求解或约束传播证明）才允许使用。
 */
export type SolveStatus =
  | 'OPTIMAL_PROVEN'
  | 'FEASIBLE_WITH_BOUND'
  | 'FEASIBLE'
  | 'BUDGET_EXCEEDED'
  | 'NO_SOLUTION_FOUND'
  | 'INFEASIBLE_PROVEN'
  | 'CANCELLED'
  | 'INVALID_INPUT'
  | 'INTERNAL_ERROR';

/** 硬约束 / 软约束 / 优化目标的显式分类（SRS §6.1）。 */
export type ConstraintClass = 'hard' | 'soft';

/** 约束种类（验证报告用同一套 code，保证"报告 ↔ 约束"可追溯）。 */
export type ConstraintCode =
  // —— 库位侧
  | 'LOCATION_CAPACITY'
  | 'LOCATION_WEIGHT_LIMIT'
  | 'LOCATION_VOLUME_LIMIT'
  | 'LOCATION_FOOTPRINT'
  | 'LOCATION_UNAVAILABLE'
  | 'LOCATION_FROZEN'
  | 'LOCATION_RESERVED'
  | 'ZONE_COMPATIBILITY'
  | 'INVENTORY_CONSERVATION'
  | 'SKU_DISPERSION_MIN'
  | 'SKU_DISPERSION_MAX'
  | 'DEEP_LANE_BLOCKING'
  | 'BATCH_ORDER'
  | 'FIFO_FEFO'
  | 'UNASSIGNED_INVENTORY'
  // —— 调度侧
  | 'DEVICE_UNAVAILABLE'
  | 'DEVICE_CAPABILITY'
  | 'DEVICE_MUTUAL_EXCLUSION'
  | 'LANE_MUTUAL_EXCLUSION'
  | 'NODE_MUTUAL_EXCLUSION'
  | 'LIFT_SHAFT_CAPACITY'
  | 'TRANSFER_HANDOVER'
  | 'TASK_PRECEDENCE'
  | 'TASK_SEQUENCE'
  | 'TASK_DEADLINE'
  | 'BUFFER_CAPACITY'
  | 'STATION_CAPACITY'
  | 'TIME_CONSISTENCY'
  | 'REACHABILITY'
  // —— 通用
  | 'METRIC_MISMATCH'
  | 'SCHEMA_INVALID';

/** 违规严重级别：error 会让结果不可用，warning 只是提示。 */
export type ViolationSeverity = 'error' | 'warning';

export interface Violation {
  code: ConstraintCode | string;
  severity: ViolationSeverity;
  constraintClass: ConstraintClass;
  /** 人可读说明：说清"谁、在哪里、违反了什么"。 */
  message: string;
  /** 相关主体（任务 / 设备 / 库位 / SKU / 货物单元），便于实验室高亮定位。 */
  subjects?: string[];
  locationId?: string | null;
  deviceId?: string | null;
  taskId?: string | null;
  /** 时间位置（秒，相对仿真起点）。 */
  at_s?: number | null;
  /** 适用情况下的空间位置（米，仓库坐标系）。 */
  position?: [number, number, number] | null;
  expected?: string;
  actual?: string;
}

/* ------------------------------------------------------------------ *
 * 1. 共同语义：仓储拓扑 / 库位 / SKU / 货物单元 / 订单 / 任务 / 设备
 * ------------------------------------------------------------------ */

/** 区域类型（SRS §2.1）。 */
export type AreaKind =
  | 'receiving'
  | 'staging'
  | 'asrs'
  | 'picking'
  | 'shipping'
  | 'buffer'
  | 'charging'
  | 'maintenance'
  | 'unavailable';

/** 货架类型：单深位 / 双深位 / 多深位；单层与多层由 levels 决定。 */
export type RackKind = 'single-deep' | 'double-deep' | 'multi-deep' | 'shelving';

/** 载具类型。 */
export type LoadUnitKind = 'pallet' | 'tote' | 'carton' | 'case' | 'cage';

/** 设备类型（SRS §2.4：不同拓扑下同名设备行为不同，必须分别建模）。 */
export type DeviceKind =
  | 'aisle-shuttle'
  | 'layer-shuttle'
  | 'four-way-shuttle'
  | 'pallet-lift'
  | 'aisle-lift'
  | 'conveyor'
  | 'transfer-car';

export interface MotionProfile {
  /** 水平 / 竖直最高速度（m/s）。 */
  speed_mps: number;
  /** 加速度（m/s²）；用于梯形速度曲线的运行时间计算。 */
  accel_mps2: number;
  /** 取放一件货物所需时间（秒，不含行走）。 */
  transfer_s: number;
  /** 与站台/缓存做交接的时间（秒）。 */
  handover_s: number;
  /** 换层时间（秒）：仅对需要换层的设备有意义（穿梭车跨层转运）。 */
  change_level_s?: number;
  /** 载货时是否降速运行（工程上常见），默认不上浮。 */
  loaded_speed_factor?: number;
}

export interface DeviceCapability {
  /** 可服务的巷道 id；空数组表示任意。 */
  aisles?: string[];
  /** 可服务的层；空数组表示全部。 */
  levels?: number[];
  /** 可服务的区域。 */
  areas?: string[];
  /** 可搬运的载具类型。 */
  loadUnits?: LoadUnitKind[];
  /** 单次可载件数（多容量提升机 > 1）。 */
  capacity_loads: number;
  /** 载重上限（kg）。 */
  capacity_kg: number;
}

export interface DeviceStatus {
  state: 'up' | 'degraded' | 'down';
  /** 降级时的速度系数（0–1）。 */
  speedFactor?: number;
  /** 停机 / 降级生效时刻（秒）。 */
  since_s?: number;
  /** 预计恢复时刻（秒，可为空 = 未知）。 */
  until_s?: number | null;
  reason?: string;
}

export interface DeviceSpec {
  id: string;
  kind: DeviceKind;
  name?: string;
  /** 初始停靠节点。 */
  homeNodeId: string;
  capability: DeviceCapability;
  motion: MotionProfile;
  /**
   * 物理耦合：`cannot_pass` 表示同类设备共享升降/行驶空间且不可互相穿越
   * （此时调度必须使用单向扫描或显式避让，见 SRS §4.3）。
   */
  coupling?: {
    cannotPass?: string[];
    sharesSpaceWith?: string[];
    /** 互斥轴：同一时刻只能有一个设备占用该资源。 */
    exclusiveResources?: string[];
  };
  status?: DeviceStatus;
  /** 能源估算参数（kWh/次取放 + kWh/m 行走），用于能耗指标。 */
  energy?: { kwh_per_move: number; kwh_per_meter: number };
}

export interface StationSpec {
  id: string;
  name?: string;
  areaId: string;
  nodeId: string;
  /** 入库 / 出库 / 双向。 */
  direction: 'inbound' | 'outbound' | 'both';
  /** 站台缓存位数量（0 = 即时交接）。 */
  bufferCapacity: number;
  /** 交接时间（秒）：货物与输送/人工的交接。 */
  handover_s: number;
  /** 设计吞吐（件/小时），仅用于对照，不参与硬约束。 */
  designThroughputPerHour?: number;
  /** 服务该站台的主要设备（用于联合调度时定位瓶颈）。 */
  servedBy?: string[];
}

export interface BufferSpec {
  id: string;
  nodeId: string;
  areaId: string;
  /** 缓存位数量（可被动态事件改变）。 */
  capacity: number;
  /** 最长滞留时间（秒，0 = 不限）。 */
  dwellLimit_s?: number;
}

export interface WarehouseNode {
  id: string;
  /** 世界坐标（米）：x 沿巷道长度方向，y 竖直，z 沿巷道宽度方向。 */
  position: [number, number, number];
  kind: 'aisle-end' | 'aisle-rail' | 'crossing' | 'lift-shaft' | 'station' | 'buffer' | 'charger' | 'transfer';
  /** 归属区域 / 巷道 / 层，未归属为 null。 */
  areaId?: string | null;
  aisleId?: string | null;
  level?: number | null;
}

export interface WarehouseLink {
  id: string;
  from: string;
  to: string;
  /** 单向 / 双向。 */
  bidirectional: boolean;
  /** 通行方式：地面道路、巷道轨道、提升通道、输送机。 */
  mode: 'road' | 'rail' | 'lift-shaft' | 'conveyor';
  /** 通道长度（米，由拓扑推导，不由调用方随便填）。 */
  length_m: number;
  /** 可通行设备种类；空 = 不限。 */
  allowedDevices?: DeviceKind[];
  /** 通道容量（同时允许多少台设备进入；1 = 单车道互斥）。 */
  capacity: number;
  /** 是否允许在通道内会车（false 且 capacity=1 时为严格互斥段）。 */
  allowMeeting?: boolean;
}

export interface LevelSpec {
  /** 层号（1 = 最底层）。 */
  level: number;
  /** 层的轨道高度（米）。 */
  y_m: number;
}

export interface RackSpec {
  id: string;
  areaId: string;
  aisleId: string;
  kind: RackKind;
  /** 货架排布：列数（bay）、层数、深度（1/2/3+）。 */
  bays: number;
  depths: number;
  levels: LevelSpec[];
  /** 单库位尺寸与承载（米 / 千克 / 立方米）。 */
  locationSize: { width_m: number; depth_m: number; height_m: number };
  /** 单个库位最大载重与容积。 */
  maxWeight_kg: number;
  maxVolume_m3: number;
  /** 库位起点世界坐标（bay=1, depth=1, level=1 的中心）。 */
  origin: [number, number, number];
  /** 沿 bay 方向的单位向量（世界 xz 平面）。 */
  bayAxis: [number, number];
  /** 沿 depth 方向的单位向量（深度 1 → 2 → …；朝向巷道内部为正）。 */
  depthAxis: [number, number];
  /** 是否支持双进深托盘的整列倒垛（用于多深位场景）。 */
  supportsRestack?: boolean;
}

export interface AisleSpec {
  id: string;
  areaId: string;
  /** 巷道两端节点。 */
  endNodeIds: [string, string];
  /** 沿巷道方向的单位向量。 */
  axis: [number, number];
  length_m: number;
  /** 是否允许双向行驶（穿梭车常见为双向，四向穿梭车巷道内亦然）。 */
  bidirectional: boolean;
  /** 巷道所属层（多层立库中每层一条巷道）。 */
  level: number;
  /** 该巷道服务的货架（左/右）。 */
  rackIds: string[];
}

export interface AreaSpec {
  id: string;
  name: string;
  kind: AreaKind;
  /** 区域外接矩形（米，xz 平面中心 + 尺寸）。 */
  center: [number, number];
  size: [number, number];
  height_m: number;
  /** 该区域的运输工具速度上限（m/s）。 */
  trafficSpeed_mps?: number;
}

/**
 * 仓储拓扑（`warehouse-topology/1.0`）。
 *
 * 硬性约定：**库位数量必须由拓扑推导**（`racks × levels × bays × depths`），
 * 不允许调用方随便给一个数字（SRS §8 明确禁止生成与结构不一致的数据）。
 */
export interface WarehouseTopology {
  id: string;
  name: string;
  /** 模板名，实验室用于显示"这是哪种工业形态"。 */
  template: string;
  areas: AreaSpec[];
  racks: RackSpec[];
  aisles: AisleSpec[];
  nodes: WarehouseNode[];
  links: WarehouseLink[];
  stations: StationSpec[];
  buffers: BufferSpec[];
  devices: DeviceSpec[];
  /** 全局禁行 / 封闭段落（动态事件可运行期追加）。 */
  closedLinks?: string[];
  /** 冻结库位 / 预留库位（动态事件可追加）。 */
  frozenLocations?: string[];
  reservedLocations?: string[];
  /** 单元：长度米、时间秒、重量千克、体积立方米。 */
  units?: { length: 'm'; time: 's'; mass: 'kg'; volume: 'm3' };
}

/** 派生库位：由拓扑唯一确定，不手工编写。 */
export interface LocationRecord {
  id: string;
  rackId: string;
  areaId: string;
  aisleId: string;
  bay: number;
  level: number;
  /** 深度：1 = 最靠近巷道（最先可取）。 */
  depth: number;
  /** 库位中心世界坐标。 */
  position: [number, number, number];
  size: { width_m: number; depth_m: number; height_m: number };
  maxWeight_kg: number;
  maxVolume_m3: number;
  /** 可用性状态（冻结/预留/不可用来自拓扑与动态事件）。 */
  availability: 'available' | 'frozen' | 'reserved' | 'unavailable';
  /** 所属储存分区（兼容性约束按分区判定）。 */
  zone: string;
}

/** 需求形态（SRS §8.1：不允许只用均匀随机）。 */
export type DemandShape = 'uniform' | 'abc' | 'zipf' | 'long-tail' | 'bimodal' | 'seasonal';

export type AbcClass = 'A' | 'B' | 'C';
export type XyzClass = 'X' | 'Y' | 'Z';

export interface SkuSpec {
  id: string;
  name: string;
  category: string;
  /** 载具类型与单位尺寸 / 重量 / 体积。 */
  loadUnit: LoadUnitKind;
  unitSize: { width_m: number; depth_m: number; height_m: number };
  unitWeight_kg: number;
  unitVolume_m3: number;
  /** 周转级别与需求参数。 */
  abc: AbcClass;
  xyz: XyzClass;
  /** 平均日出货量（件/天）与波动系数（CV）。 */
  meanDailyDemand: number;
  demandCv: number;
  /** 长尾 / Zipf 参数（仅用于数据生成与解释，不参与约束）。 */
  demandRank?: number;
  /** 储存兼容性：允许的分区。 */
  allowedZones: string[];
  /** 是否危险品 / 是否温控（联合约束）。 */
  hazmat?: boolean;
  temperature?: 'ambient' | 'chilled' | 'frozen';
  /** 批次管理：FIFO / FEFO / none。 */
  batchPolicy?: 'fifo' | 'fefo' | 'none';
  /** 需求季节因子（按周 0–51，可空）。 */
  seasonality?: number[];
  /** 促销窗口（秒，相对仿真起点）。 */
  promoWindows?: Array<{ from_s: number; to_s: number; factor: number }>;
  /** 关联簇 id（同簇 SKU 在生产数据中被有意设计为共同出库）。 */
  affinityCluster?: string | null;
}

export interface InventoryUnit {
  /** 货物单元 id（物理实体，一个 SKU 可以有多个单元）。 */
  id: string;
  skuId: string;
  /** 数量（一个载具上的件数）。 */
  quantity: number;
  batch: string;
  /** 生产 / 到期时间（FEFO 用；ISO 字符串仅用于展示，秒值用于计算）。 */
  producedAt_s?: number;
  expiresAt_s?: number | null;
  inboundAt_s?: number;
  /** 当前库位；null = 尚未上架（在收货区）。 */
  locationId: string | null;
  status: 'stored' | 'inbound' | 'outbound' | 'quarantine' | 'damaged';
  /** 是否退货 / 重新入库（影响动态库位优化）。 */
  returned?: boolean;
}

export interface DemandProfile {
  shape: DemandShape;
  /** 模拟天数与时间分辨率。 */
  horizonDays: number;
  /** 每小时订单数的基准（24 长度数组，未给则用默认时钟曲线）。 */
  hourlyFactor?: number[];
  /** 每单平均行数与波动。 */
  linesPerOrder: number;
  linesPerOrderCv: number;
  /** 促销窗口与突发峰值。 */
  promoWindows?: Array<{ fromDay: number; toDay: number; factor: number }>;
  /** 长尾参数（Zipf 指数）。 */
  zipfExponent?: number;
  /** 退货比例。 */
  returnRate?: number;
}

export interface OrderLine {
  skuId: string;
  quantity: number;
}

export interface CustomerOrder {
  id: string;
  /** 释放时刻（秒，仿真起点为 0）。 */
  release_s: number;
  /** 交付期限（秒）。 */
  due_s: number;
  priority: number;
  /** 渠道（电商 / 门店 / 紧急补货），用于解释优先级来源。 */
  channel?: string;
  lines: OrderLine[];
  /** 预约出库窗口（秒），可选。 */
  appointment?: [number, number] | null;
  status?: 'open' | 'consumed' | 'cancelled';
}

/** 物理搬运任务类型（与业务订单解耦）。 */
export type TaskKind = 'inbound' | 'outbound' | 'relocation' | 'restack' | 'transfer';

export interface WarehouseTask {
  id: string;
  kind: TaskKind;
  priority: number;
  /** 释放 / 创建时刻（秒）。 */
  release_s: number;
  /** 期限（秒，null = 无硬期限）。 */
  deadline_s?: number | null;
  /** 取货点：库位（出库 / 移库）或站台（入库）。 */
  fromLocationId?: string | null;
  fromNodeId?: string | null;
  /** 放置点：库位（入库 / 移库）或站台（出库）。 */
  toLocationId?: string | null;
  toNodeId?: string | null;
  loadUnitId: string;
  skuId: string;
  /** 依赖任务（必须先完成）。 */
  dependsOn?: string[];
  /** 来源业务订单（追溯用）。 */
  orderId?: string | null;
  /** 是否可与其他任务组成双指令循环。 */
  dualCommandEligible?: boolean;
  /** 任务是否可被取消 / 抢占（高优先级插入时的行为）。 */
  cancellable?: boolean;
}

/** 动态事件（SRS §4.7 与 E 组场景）。 */
export type DynamicEvent =
  | { kind: 'task-arrival'; at_s: number; tasks: WarehouseTask[] }
  | { kind: 'task-cancel'; at_s: number; taskIds: string[] }
  | { kind: 'task-priority'; at_s: number; taskIds: string[]; priority: number }
  | { kind: 'task-deadline'; at_s: number; taskIds: string[]; deadline_s: number }
  | { kind: 'device-down'; at_s: number; deviceIds: string[]; reason?: string; until_s?: number | null }
  | { kind: 'device-up'; at_s: number; deviceIds: string[] }
  | { kind: 'device-degrade'; at_s: number; deviceIds: string[]; speedFactor: number }
  | { kind: 'link-close'; at_s: number; linkIds: string[] }
  | { kind: 'link-open'; at_s: number; linkIds: string[] }
  | { kind: 'location-freeze'; at_s: number; locationIds: string[]; freeze: boolean }
  | { kind: 'buffer-capacity'; at_s: number; bufferId: string; capacity: number }
  | { kind: 'station-close'; at_s: number; stationIds: string[]; close: boolean }
  | { kind: 'demand-shift'; at_s: number; note: string; skuMultipliers?: Record<string, number> };

/* ------------------------------------------------------------------ *
 * 2. 库位优化：问题 / 解
 * ------------------------------------------------------------------ */

export type SlottingObjectiveId =
  | 'expected-travel-time'
  | 'device-travel-distance'
  | 'space-utilization'
  | 'relocation-count'
  | 'relocation-cost'
  | 'load-balance'
  | 'congestion'
  | 'delivery-timeliness'
  | 'energy';

export interface ObjectiveSpec {
  id: SlottingObjectiveId | string;
  /** 目标方向：min / max。 */
  direction: 'min' | 'max';
  /** 权重（无量纲，但必须与单位一起展示；权重和为 1 时是加权和，否则先归一化）。 */
  weight: number;
  /** 单位（必须显式声明，禁止"未经说明的简单相加"，SRS §6.1）。 */
  unit: string;
  /** 归一化参考值（用于把不同量纲的目标放到同一尺度；null = 不做归一化）。 */
  normalizer?: number | null;
  /** 说明该目标对业务意味着什么。 */
  note?: string;
}

export interface SlottingConstraintConfig {
  /** 每个 SKU 至少/最多占用的库位数（库存分散规则）。 */
  dispersion?: { minLocationsPerSku?: number; maxLocationsPerSku?: number; maxAisleSharePerSku?: number };
  /** 同一 SKU 的库存是否必须相邻（集中 vs 分散）。 */
  adjacencyPolicy?: 'free' | 'prefer-adjacent' | 'prefer-spread';
  /** 是否允许把同一货物单元拆分到多个库位（默认否）。 */
  allowSplitLoadUnit?: boolean;
  /** 深位策略：是否允许把慢周转放到深位。 */
  deepLanePolicy?: 'front-only' | 'fast-front';
  /** 是否启用 FIFO/FEFO 分配检查。 */
  batchPolicy?: 'fifo' | 'fefo' | 'none';
  /** 允许的未分配库存比例（容量不足场景下用于给出可行解）。 */
  maxUnassignedShare?: number;
}

export interface SlottingAlgorithmConfig {
  /** 算法族：基础对照 + 高级组合优化 + 多目标 + 鲁棒。 */
  algorithm:
    | 'random'
    | 'fixed'
    | 'nearest-available'
    | 'abc'
    | 'turnover'
    | 'coi'
    | 'capacity-class'
    | 'scatter'
    | 'affinity-lns'
    | 'tabu'
    | 'sa'
    | 'nsga2'
    | 'robust-lns'
    | 'dynamic-delta';
  /** 随机种子（可复现性，SRS §6.3）。 */
  seed: number;
  /** 求解预算（毫秒）。 */
  budget_ms: number;
  /** 迭代上限（与预算取先到者）。 */
  maxIterations: number;
  /** 邻域算子开关。 */
  operators?: Array<'swap' | 'move' | 'cluster-move' | 'block-relocate' | 'aisle-balance'>;
  /** 多目标配置（nsga2 / robust-lns 使用）。 */
  pareto?: { populationSize: number; generations: number };
  /** 鲁棒优化：需求场景数与风险度量。 */
  robust?: { scenarios: number; measure: 'mean' | 'cvar' | 'minimax'; cvarAlpha?: number };
  /** ALNS 接受准则初始温度（相对目标尺度）。 */
  temperature?: number;
  /** 是否启用多随机种子稳定性评价（SRS §6.3）。 */
  seeds?: number[];
  /** 动态优化：只允许在给定时间窗内执行的迁移预算（件数与设备工时）。 */
  migrationBudget?: { maxMoves: number; maxDeviceSeconds: number; window_s: number };
}

export interface SlottingProblem {
  schema_version: typeof SLOTTING_PROBLEM_SCHEMA;
  id: string;
  /** 场景 id（S01…X12），来自标准场景库；null = 自定义问题。 */
  scenarioId?: string | null;
  /** 数据版本与算法版本（可复现性）。 */
  versions: { dataset: string; engine: string; ruleset: string };
  topology: WarehouseTopology;
  skus: SkuSpec[];
  inventory: InventoryUnit[];
  /** 历史订单（用于关联度与周转统计）。 */
  history: CustomerOrder[];
  /** 未来需求（不确定需求优化的场景采样来源；SRS §3.2D）。 */
  demand: DemandProfile;
  /** 当前布局（动态优化与对比的基线；空 = 从未分配）。 */
  currentAssignment?: Array<{ loadUnitId: string; locationId: string }>;
  objectives: ObjectiveSpec[];
  constraints: SlottingConstraintConfig;
  algorithm: SlottingAlgorithmConfig;
  /** 硬约束声明（验证器按此判定 error；未声明的按软约束处理）。 */
  hardConstraints: ConstraintCode[];
  generatedAt?: string;
  generator?: { scale: string; seed: number; notes?: string };
}

export interface MigrationAction {
  loadUnitId: string;
  skuId: string;
  fromLocationId: string | null;
  toLocationId: string;
  /** 建议（仅规划）还是需要执行的搬迁任务（SRS §3.2B 明确区分）。 */
  mode: 'suggestion' | 'task';
  reason: string;
  /** 预估设备工时（秒）与能耗（kWh），由调度成本模型给出。 */
  estimatedDeviceSeconds: number;
  estimatedEnergyKwh: number;
  /** 若来自动态触发，触发原因与触发时刻。 */
  trigger?: { kind: string; at_s: number; detail: string } | null;
  /** 是否需要调度侧生成搬迁任务（联合优化使用）。 */
  requiresDispatch?: boolean;
}

export interface ObjectiveValue {
  id: string;
  direction: 'min' | 'max';
  unit: string;
  weight: number;
  /** 原始值（未归一化）。 */
  raw: number;
  /** 归一化值（0–1，1 = 最好；用于展示取舍，不隐藏单位）。 */
  normalized: number;
  /** 与其他目标的冲突方向说明（可空）。 */
  conflictsWith?: string[];
  note?: string;
}

export interface SlottingMetrics {
  /** 空间利用率 = 占用库位 / 可用库位。 */
  spaceUtilization: number;
  /** 有效库位利用率：只统计真正可服务（非冻结、未被完全遮挡）的库位。 */
  effectiveUtilization: number;
  /** 预计平均出库行走时间（秒/件，来自调度成本模型，不是欧氏距离）。 */
  expectedPickSeconds: number;
  /** 预计平均入库时间（秒/件）。 */
  expectedPutSeconds: number;
  /** 关联商品平均同批差异（越小 = 关联商品越接近）。 */
  affinityCoherence: number;
  /** 巷道负载基尼系数（0 = 完全均衡）。 */
  aisleLoadGini: number;
  /** 提升机 / 输送负载峰值比。 */
  liftPeakRatio: number;
  /** 预计拥堵指数（0–1，来自排队代理模型）。 */
  congestionIndex: number;
  /** 迁移 / 重新分配库位数与设备工时。 */
  relocationCount: number;
  relocationDeviceSeconds: number;
  /** 未满足业务约束数量（硬约束违规，来自独立验证器）。 */
  unmetConstraints: number;
  /** 目标函数分解（含单位与权重）。 */
  objectives: ObjectiveValue[];
  /** 计算耗时（毫秒）。 */
  computeMs: number;
  /** 结果稳定性：多种子目标值标准差 / 均值（0 = 完全稳定）。 */
  stability?: number | null;
  /** 实际参与计算的规模（必须如实报告，SRS §8）。 */
  computedScale: { skus: number; locations: number; loadUnits: number; orders: number; assignments: number };
}

export interface ParetoPoint {
  id: string;
  /** 目标 id → 原始值。 */
  values: Record<string, number>;
  /** 方案指纹（可复现）。 */
  fingerprint: string;
  /** 是否为选中方案（决策者在 UI 里挑一个）。 */
  selected?: boolean;
  algorithm: string;
}

export interface SlottingSolution {
  schema_version: typeof SLOTTING_SOLUTION_SCHEMA;
  id: string;
  problemId: string;
  problemHash: string;
  scenarioId?: string | null;
  engine: string;
  engineVersion: string;
  rulesetVersion: string;
  datasetVersion: string;
  seed: number;
  algorithm: string;
  status: SolveStatus;
  /** 是否超时但有解（SRS §6.2）。 */
  budget_exceeded: boolean;
  /** 是否证明了最优（仅精确求解小规模时允许为 true）。 */
  optimality_proven: boolean;
  /** 有界的可行解：下界与上界（不可证明时为 null）。 */
  bound?: { lower: number | null; upper: number | null; gap?: number | null };
  assignment: Array<{ loadUnitId: string; skuId: string; locationId: string; quantity: number }>;
  unassigned?: Array<{ loadUnitId: string; skuId: string; reason: string }>;
  migrations: MigrationAction[];
  metrics: SlottingMetrics;
  paretoFront?: ParetoPoint[];
  /** 逐目标的解释（为什么这个方案是这样）——面向"为什么货物应该放在这些库位"。 */
  explanations: Array<{ subject: string; text: string; evidence?: Record<string, number | string> }>;
  search: {
    iterations: number;
    objectiveTrace: number[];
    restarts: number;
    operatorsUsed?: Record<string, number>;
    bestIteration: number;
    elapsedMs: number;
    /** 多随机种子结果（稳定性评价）。 */
    multiSeed?: Array<{ seed: number; objective: number; status: SolveStatus }>;
  };
  verify: {
    verified: boolean;
    summary: { errors: number; warnings: number };
    reportId: string;
  };
}

/* ------------------------------------------------------------------ *
 * 3. 密集立库调度：问题 / 解
 * ------------------------------------------------------------------ */

export type DispatchAlgorithm =
  | 'fifo'
  | 'priority'
  | 'nearest-device'
  | 'earliest-available'
  | 'earliest-handover'
  | 'greedy-path'
  | 'lift-round-robin'
  | 'joint-alns'
  | 'joint-lns'
  | 'rolling-horizon'
  | 'spacetime-reservation';

export interface DispatchConfig {
  algorithm: DispatchAlgorithm;
  seed: number;
  /** 求解预算（毫秒）。 */
  budget_ms: number;
  /** 滚动时域长度（秒）与重调度触发间隔。 */
  rollingHorizon_s?: number;
  /** 是否允许双指令（出库 + 入库合并）。 */
  dualCommand?: boolean;
  /** 是否允许跨层转运（穿梭车搭提升机换层）。 */
  crossLevelTransfer?: boolean;
  /** 冲突消解策略：优先级 / 先到先服务 / 时间窗预约。 */
  conflictPolicy?: 'priority' | 'fcfs' | 'reservation';
  /** 是否允许为避免死锁而主动等待（不允许则只能拒绝任务）。 */
  allowYield?: boolean;
  /** 目标权重（吞吐 / 时效 / 能耗 / 均衡），与库位侧同构。 */
  objectives?: ObjectiveSpec[];
  /** 仿真时长上限（秒，0 = 直到任务清空或预算耗尽）。 */
  simulationHorizon_s?: number;
  /** 设备故障等动态事件的处理方式：preserve = 保留已完成与不可中断操作（默认）。 */
  reschedulePolicy?: 'preserve' | 'restart';
}

export interface AsrsProblem {
  schema_version: typeof ASRS_PROBLEM_SCHEMA;
  id: string;
  scenarioId?: string | null;
  versions: { dataset: string; engine: string; ruleset: string };
  topology: WarehouseTopology;
  /** 参与调度的任务（由订单编译而来，或直接给定）。 */
  tasks: WarehouseTask[];
  /** 货物单元（任务引用的实体）。 */
  loadUnits: InventoryUnit[];
  skus: SkuSpec[];
  /** 库位（由拓扑派生，用于可达性校验）。 */
  locations?: LocationRecord[];
  dispatch: DispatchConfig;
  /** 动态事件序列（按 at_s 排序；调度器不得"事后修改历史"）。 */
  events: DynamicEvent[];
  /** 设备初始状态（可在 events 中被改变）。 */
  deviceStatus?: Record<string, DeviceStatus>;
  /** 硬约束声明。 */
  hardConstraints: ConstraintCode[];
  generatedAt?: string;
  generator?: { scale: string; seed: number; notes?: string };
  /** 来自库位优化的方案（联合优化时把库位方案交给调度评价，SRS §5）。 */
  slottingPlan?: { solutionId: string; assignment: Array<{ loadUnitId: string; locationId: string }> } | null;
}

export interface TaskStep {
  /** 步骤序号（0 开始）。 */
  seq: number;
  deviceId: string;
  action: 'travel-empty' | 'travel-loaded' | 'pick' | 'place' | 'handover' | 'lift' | 'wait' | 'relocate' | 'charge';
  /** 起点 / 终点节点；对 pick/place 表示所在节点。 */
  fromNodeId?: string | null;
  toNodeId?: string | null;
  locationId?: string | null;
  start_s: number;
  end_s: number;
  /** 距离（米），用于能耗与空载率统计。 */
  distance_m: number;
  /** 该步骤是否为等待（阻塞 / 避让）。 */
  blockedBy?: string | null;
  /** 相关任务（移库时的遮蔽任务）。 */
  causeTaskId?: string | null;
}

export interface TaskPlan {
  taskId: string;
  kind: TaskKind;
  status: 'planned' | 'executing' | 'done' | 'cancelled' | 'unassigned' | 'failed';
  priority: number;
  release_s: number;
  deadline_s?: number | null;
  shuttleId?: string | null;
  liftId?: string | null;
  /** 任务开始执行 / 完成时刻（秒）。 */
  start_s?: number | null;
  finish_s?: number | null;
  /** 若任务由双指令循环合并，记录同循环的任务 id。 */
  cycleWith?: string[];
  /** 是否因设备不可达 / 能力不足被放弃。 */
  unassignedReason?: string | null;
  /** 因为多深位遮挡而触发的临时搬迁任务（SRS §4.5）。 */
  relocationTaskIds?: string[];
  steps: TaskStep[];
}

export interface DeviceTimeline {
  deviceId: string;
  kind: DeviceKind;
  /** 设备按时间的状态片段（互不重叠，由仿真保证）。 */
  segments: Array<{
    start_s: number;
    end_s: number;
    state: 'idle' | 'travel-empty' | 'travel-loaded' | 'pick' | 'place' | 'handover' | 'wait' | 'down' | 'charge';
    taskId?: string | null;
    /** 位置（节点 + 世界坐标），用于三维回放。 */
    nodeId?: string | null;
    position?: [number, number, number] | null;
    reason?: string | null;
  }>;
  /** 统计：行走距离、空载距离、等待时间、能耗。 */
  stats: {
    distanceLoaded_m: number;
    distanceEmpty_m: number;
    wait_s: number;
    blocked_s: number;
    moves: number;
    energyKwh: number;
    utilization: number;
  };
}

export interface BufferState {
  bufferId: string;
  /** 时间序列的占用量（时间一致性校验用）。 */
  occupancy: Array<{ t_s: number; count: number }>;
  peak: number;
  capacity: number;
  overflowPrevented: number;
}

export interface DispatchMetrics {
  tasksTotal: number;
  tasksDone: number;
  tasksUnassigned: number;
  throughputPerHour: number;
  makespan_s: number;
  avgWait_s: number;
  avgCycle_s: number;
  highPriorityDelay_s: number;
  deadlineMisses: number;
  relocationCount: number;
  dualCommandCycles: number;
  shuttleUtilization: number;
  liftUtilization: number;
  emptyTravelShare: number;
  blocking_s: number;
  conflictsResolved: number;
  deadlocksPrevented: number;
  energyKwh: number;
  computeMs: number;
  /** 动态重调度耗时（毫秒，多次事件取合计）。 */
  rescheduleMs: number;
  /** 实际参与计算的任务/设备规模（如实报告）。 */
  computedScale: { tasks: number; devices: number; locations: number; events: number };
}

export interface RescheduleRecord {
  /** 触发事件描述（不得事后修改历史）。 */
  event: { kind: string; at_s: number; detail: string };
  /** 重调度时刻与耗时。 */
  rescheduledAt_s: number;
  computeMs: number;
  /** 保留的已完成 / 不可中断操作数量（SRS §4.7）。 */
  preservedOperations: number;
  /** 前后指标（真实计算，不是估算）。 */
  before: Pick<DispatchMetrics, 'tasksDone' | 'avgWait_s' | 'throughputPerHour' | 'makespan_s' | 'deadlineMisses'>;
  after: Pick<DispatchMetrics, 'tasksDone' | 'avgWait_s' | 'throughputPerHour' | 'makespan_s' | 'deadlineMisses'>;
  /** 任务/设备分配的变化明细（实验室对比视图使用）。 */
  changes: Array<{ taskId: string; field: string; from: string | null; to: string | null; reason: string }>;
}

export interface AsrsSolution {
  schema_version: typeof ASRS_SOLUTION_SCHEMA;
  id: string;
  problemId: string;
  problemHash: string;
  scenarioId?: string | null;
  engine: string;
  engineVersion: string;
  rulesetVersion: string;
  datasetVersion: string;
  seed: number;
  algorithm: DispatchAlgorithm;
  status: SolveStatus;
  budget_exceeded: boolean;
  plans: TaskPlan[];
  timelines: DeviceTimeline[];
  buffers: BufferState[];
  metrics: DispatchMetrics;
  reschedules: RescheduleRecord[];
  /** 热点 / 拥堵证据（哪台设备、哪个时段、等了多久）。 */
  congestion: Array<{ subject: string; kind: 'lane' | 'lift-shaft' | 'station' | 'buffer'; window_s: [number, number]; value: number; note: string }>;
  explanations: Array<{ subject: string; text: string; evidence?: Record<string, number | string> }>;
  verify: { verified: boolean; summary: { errors: number; warnings: number }; reportId: string };
  /** 若来自联合优化，记录用的是哪一份库位方案。 */
  slottingPlanRef?: { solutionId: string; dispatchCostMeasured: boolean } | null;
}

/* ------------------------------------------------------------------ *
 * 4. 独立验证报告（两个模块共用形状）
 * ------------------------------------------------------------------ */

export interface VerificationCheck {
  group: string;
  name: string;
  ok: boolean;
  /** 统计信息（检查了多少个对象、命中多少违规）。 */
  detail?: string;
}

export interface VerificationReport {
  schema_version: typeof VERIFICATION_SCHEMA;
  id: string;
  target: 'slotting' | 'asrs' | 'joint';
  subjectId: string;
  problemHash: string;
  solutionHash: string;
  /** 验证器自身的版本（与求解器分离，SRS §6.4）。 */
  verifier: string;
  verifierVersion: string;
  ok: boolean;
  counts: { errors: number; warnings: number; checks: number };
  checks: VerificationCheck[];
  violations: Violation[];
  /** 由验证器**重新计算**的主要指标（不信任优化器报告的数字）。 */
  recomputed: Record<string, number | string | boolean | null>;
  /** 与求解器报告值的偏差（超过容差即为 METRIC_MISMATCH）。 */
  mismatches: Array<{ metric: string; reported: number; recomputed: number; tolerance: number; relative: number }>;
  elapsedMs: number;
}

/* ------------------------------------------------------------------ *
 * 5. 联合优化（SRS §5）
 * ------------------------------------------------------------------ */

export interface JointStrategyCombination {
  slottingAlgorithm: string;
  dispatchAlgorithm: string;
  /** 该组合下真实跑出来的调度指标（不是估算）。 */
  dispatch: Pick<
    DispatchMetrics,
    'tasksDone' | 'tasksUnassigned' | 'throughputPerHour' | 'makespan_s' | 'avgWait_s' | 'deadlineMisses' | 'energyKwh' | 'relocationCount' | 'liftUtilization' | 'shuttleUtilization'
  >;
  slottingMetrics: Pick<
    SlottingMetrics,
    'spaceUtilization' | 'expectedPickSeconds' | 'aisleLoadGini' | 'congestionIndex' | 'relocationDeviceSeconds'
  >;
  /** 与理论最短距离方案的差异（用来回答 SRS §5 的反例）。 */
  vsShortestDistance: { secondsPerTaskDelta: number; note: string };
  /** 是否通过独立验证。 */
  verified: boolean;
  computeMs: number;
}

export interface JointSolution {
  schema_version: typeof JOINT_SOLUTION_SCHEMA;
  id: string;
  problemId: string;
  scenarioId?: string | null;
  engine: string;
  engineVersion: string;
  status: SolveStatus;
  /** 实际跑过的组合（真实结果，不是模拟示意）。 */
  combinations: JointStrategyCombination[];
  /** 反馈回路记录：库位方案 → 调度成本 → 修正后的库位方案。 */
  feedbackLoop: Array<{
    iteration: number;
    slottingObjective: number;
    measuredDispatchSecondsPerTask: number;
    surrogateSecondsPerTask: number;
    /** 代理模型与真实调度的偏差（诚实标出模型的局限）。 */
    surrogateError: number;
    changesToPlan: number;
  }>;
  conclusion: { bestCombination: string; text: string };
  metrics: { computeMs: number; dispatchEvaluations: number; scaleNote: string };
}

/* ------------------------------------------------------------------ *
 * 6. 标准场景与求解能力
 * ------------------------------------------------------------------ */

export type ScenarioGroup = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'X';

export interface ScenarioScale {
  /** 档位名（small / medium / large / extreme）。 */
  tier: 'small' | 'medium' | 'large' | 'extreme';
  /** 由拓扑推导的库位数（不是任意给定值）。 */
  locations: number;
  skus: number;
  orders: number;
  tasks: number;
  devices: number;
  /** 实验室默认是否在线求解（大场景允许离线/抽样，但必须如实说明）。 */
  labRunnable: boolean;
  /** 如实说明本档位的取舍（例如"可视化按抽样显示 5% 货位"）。 */
  note: string;
}

export interface ScenarioDefinition {
  id: string;
  group: ScenarioGroup;
  name: string;
  /** 场景要点：为什么这个场景值得单独测试。 */
  intent: string;
  /** 仓储语义：拓扑形态 + 业务约束 + 需求结构。 */
  semantics: {
    topology: string;
    storage: string;
    demand: string;
    equipment: string;
    constraints: string[];
  };
  /** 观察项：运行后界面上必须能看到什么。 */
  observables: string[];
  /** 与之对照的场景（比较才有意义）。 */
  comparesWith: string[];
  /** 主算法与对照算法。 */
  algorithms: string[];
  /** 规模档位（默认）。 */
  scale: ScenarioScale;
  /** 期望的算法行为（用于验收，不作为"必然结果"承诺）。 */
  expected: {
    /** 主算法相对对照应改善的指标（可能为空，例如无解场景）。 */
    improve?: string[];
    /** 状态语义上的期望（例如 X11 期望 INFEASIBLE_PROVEN 或明确的未满足约束）。 */
    status?: SolveStatus;
    /** 观察要点。 */
    note: string;
  };
  /** 是否为对抗性 / 无解场景。 */
  adversarial?: boolean;
  /** 动态事件（E 组 / 部分 F 组）。 */
  events?: DynamicEvent[];
}

export interface ScenarioInstance {
  definition: ScenarioDefinition;
  /** 该实例是库位问题、调度问题还是两者（联合）。 */
  kind: 'slotting' | 'asrs' | 'joint' | 'both';
  slotting?: SlottingProblem;
  asrs?: AsrsProblem;
  /** 实际生成规模（与 definition.scale 对照，必须一致或有说明）。 */
  actual: ScenarioScale;
}

export interface Capabilities {
  schema_version: typeof CAPABILITIES_SCHEMA;
  engine: string;
  version: string;
  rulesetVersion: string;
  contractVersions: Record<string, string>;
  algorithms: {
    slotting: Array<{ id: string; family: string; description: string; applicableWhen: string; limits: string }>;
    dispatch: Array<{ id: string; family: string; description: string; applicableWhen: string; limits: string }>;
  };
  statuses: SolveStatus[];
  constraints: Record<'slotting' | 'asrs', ConstraintCode[]>;
  scale: { upTo: { skus: number; locations: number; tasks: number }; notes: string };
  supports: {
    multiObjective: boolean;
    pareto: boolean;
    robust: boolean;
    dynamicEvents: boolean;
    rescheduling: boolean;
    multiDeep: boolean;
    dualCommand: boolean;
    crossLevelTransfer: boolean;
    independentVerification: boolean;
    jointOptimization: boolean;
    cancel: boolean;
  };
}

/* ------------------------------------------------------------------ *
 * 7. 求解入口参数
 * ------------------------------------------------------------------ */

export interface SolveOptions {
  /** 覆盖问题里的算法选择与预算（实验室调参入口）。 */
  algorithm?: string;
  seed?: number;
  budget_ms?: number;
  maxIterations?: number;
  /** 进度回调（Worker → 主线程）。 */
  onProgress?: (progress: { phase: string; done: number; total: number; note?: string }) => void;
  /** 取消令牌（同步求解中周期性检查）。 */
  isCancelled?: () => boolean;
  /** 是否在求解后立即做独立验证（默认 true）。 */
  verify?: boolean;
  /** 相对任务规模缩放（实验室小屏快速预览用；不影响结果语义，但必须如实显示）。 */
  sizeOverride?: Partial<ScenarioScale>;
}
