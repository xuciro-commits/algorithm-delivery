/**
 * 库位优化的**问题模型与增量评估内核**。
 *
 * 设计取舍（为什么不用"对每个候选方案重算一遍总目标"的朴素写法）：
 *   - 大场景的库位/货物单元数量在 10^5–10^6 量级，任何 O(n) 的评估都会把搜索预算吃光；
 *   - 因此把目标拆成**可增量维护的部分**：
 *       · 基础运行代价：逐货物单元可加（每个库位一条预算好的代价表）；
 *       · 拥堵代价：按巷道 / 提升机聚合的凸函数（交换两个货物单元只影响 2 条巷道）；
 *       · 迁移代价：与"当前布局"逐单元对比，可 O(1) 维护；
 *   - 硬约束在每次移动时 O(1) 判定（容量 / 分区 / 冻结 / 深位 / 分散度），
 *     不可行移动直接拒绝，不需要"事后修复"。
 *
 * 单位一律显式：秒/天、米/天、kWh/天、件、库位。禁止把不同量纲直接相加（SRS §6.1）。
 */

import type {
  ConstraintCode,
  DeviceSpec,
  InventoryUnit,
  LocationRecord,
  MotionProfile,
  SlottingProblem,
  SkuSpec,
  WarehouseTopology,
} from '../contract/types.ts';
import { clamp, gini, makeRng, round, seedFrom } from '../contract/util.ts';
import { buildRouteModel, routeBetweenLocations, secondsToStation, type RouteModel } from '../wh/routing.ts';
import { deriveLocations } from '../wh/topology.ts';

/** 成本模型的显式参数（每一项都要能在面板上解释"这个数字怎么来的"）。 */
export interface CostModelConfig {
  /** 出入库流量拆分：出库占比（典型电商仓 0.8）。 */
  outboundShare: number;
  /** 分拣/人工交接的固定时间（秒/件）。 */
  handling_s: number;
  /** 巷道可用工时占比（0–1，拥堵代理的分母）。 */
  aisleUtilizationTarget: number;
  /** 提升机可用工时占比。 */
  liftUtilizationTarget: number;
  /** 时延系数：拥堵指数 → 延误秒数。 */
  congestionScale: number;
  /** 时效阈值（秒）：库位到出库站台的运行时间超过它就不算"及时"。 */
  timelinessThreshold_s: number;
  /** 平均单件巷道占用（秒）与提升机占用（秒）：拥堵代理的"服务时间"。 */
  aisleServiceSeconds: number;
  liftServiceSeconds: number;
  /** 迁移（移库）的额外开销：取放 + 空跑（秒）。 */
  relocationOverhead_s: number;
}

export const DEFAULT_COST_CONFIG: CostModelConfig = {
  outboundShare: 0.8,
  handling_s: 6,
  aisleUtilizationTarget: 0.75,
  liftUtilizationTarget: 0.8,
  congestionScale: 1,
  timelinessThreshold_s: 180,
  aisleServiceSeconds: 12,
  liftServiceSeconds: 18,
  relocationOverhead_s: 25,
};

/** 代表设备的运动学：库位侧成本用"巷道穿梭车 + 货物提升机"的组合代表机型。 */
export function representativeDevice(topology: WarehouseTopology): { shuttle: MotionProfile; lift: MotionProfile } {
  const shuttleDevice: DeviceSpec | undefined = topology.devices.find(
    (d) => d.kind === 'layer-shuttle' || d.kind === 'aisle-shuttle' || d.kind === 'four-way-shuttle',
  );
  const liftDevice: DeviceSpec | undefined = topology.devices.find((d) => d.kind === 'pallet-lift');
  return {
    shuttle: shuttleDevice?.motion ?? { speed_mps: 2.6, accel_mps2: 1.3, transfer_s: 6, handover_s: 8 },
    lift: liftDevice?.motion ?? { speed_mps: 0.9, accel_mps2: 0.7, transfer_s: 8, handover_s: 12 },
  };
}

/** 每个库位预计算好的代价（与 SKU 无关；SKU 只影响流量权重）。 */
export interface LocationCost {
  /** 出库：从库位到出库站台（含提升机与交接）的秒数。 */
  pickSeconds: number;
  /** 入库：从入库站台到库位的秒数。 */
  putSeconds: number;
  /** 运行距离（米，用于距离与能耗目标）。 */
  meters: number;
  /** 巷道下标。 */
  aisleIndex: number;
  /** 是否使用提升机（level > 1）。 */
  usesLift: boolean;
  /** 提升机分组下标（同一竖井的设备共享负载）。 */
  liftGroup: number;
  /** 深位造成的额外代价（秒）。 */
  depthPenaltySeconds: number;
}

export interface AffinitySummary {
  /** SKU 下标 → 关联对（稀疏）。 */
  pairs: Map<number, Array<{ sku: number; weight: number }>>;
  /** SKU → 关联簇下标（-1 = 无）。 */
  clusterOf: Int32Array;
  clusters: number;
}

export interface SlottingModel {
  problem: SlottingProblem;
  topology: WarehouseTopology;
  locations: LocationRecord[];
  routeModel: RouteModel;
  costConfig: CostModelConfig;
  skus: SkuSpec[];
  skuIndex: Map<string, number>;
  loadUnits: InventoryUnit[];
  luIndex: Map<string, number>;
  /** 货物单元 → SKU 下标。 */
  luSku: Int32Array;
  /** 货物单元 → 日流量（件/天，按载具件数分摊）。 */
  unitFlow: Float64Array;
  /** 库位下标 → 代价。 */
  locationCost: LocationCost[];
  /** 可选库位（未被冻结 / 预留 / 不可达）。 */
  availableLocations: number[];
  /** 合法库位（含预留；冻结与不可用已排除）——用于区分"可用"与"物理存在"。 */
  placeableLocations: number[];
  aisleIds: string[];
  aisleCapacitySecondsPerDay: Float64Array;
  liftGroupIds: string[];
  liftCapacitySecondsPerDay: Float64Array;
  zoneOfLocation: string[];
  locMaxWeight: Float64Array;
  locMaxVolume: Float64Array;
  skuWeight: Float64Array;
  skuVolume: Float64Array;
  skuDailyOut: Float64Array;
  skuDailyIn: Float64Array;
  hardConstraints: Set<ConstraintCode>;
  /** 当前布局（动态优化与迁移代价的基线）：货物单元 → 库位下标。 */
  currentLocationOfLu: Int32Array;
  affinity: AffinitySummary;
  /** 迁移代价缓存：起始库位下标 → 目标库位下标的时间（秒）。 */
  relocationCache: Map<number, Float64Array>;
  /** 候选放置位置的排序表（按巷道 + 层 + 深度指数排序，用于"最近可用"等策略）。 */
  locationOrderByCost: number[];
  rngSeed: number;
}

/* ------------------------------------------------------------------ *
 * 建模
 * ------------------------------------------------------------------ */

/**
 * 构建模型：从问题（拓扑 + 目录 + 库存 + 需求）推导出全部评估所需结构。
 * 只读问题、不做求解；保证"同一问题 → 同一模型"。
 */
export function buildSlottingModel(problem: SlottingProblem, costConfig: CostModelConfig = DEFAULT_COST_CONFIG): SlottingModel {
  const topology = problem.topology;
  const locations = deriveLocations(topology, {
    frozen: topology.frozenLocations,
    reserved: topology.reservedLocations,
  });
  const routeModel = buildRouteModel(topology, locations);
  const { shuttle } = representativeDevice(topology);

  const outStations = topology.stations.filter((s) => s.direction === 'outbound' || s.direction === 'both');
  const inStations = topology.stations.filter((s) => s.direction === 'inbound' || s.direction === 'both');
  const outNode = outStations[0]?.nodeId ?? topology.nodes[0]?.id ?? null;
  const inNode = inStations[0]?.nodeId ?? outNode;

  // ---- 巷道容量与提升机分组 ----
  const aisleIds = topology.aisles.map((a) => a.id);
  const aisleIndexById = new Map(aisleIds.map((id, i) => [id, i]));
  const shuttleCountPerAisle = new Float64Array(aisleIds.length);
  for (const device of topology.devices) {
    const isShuttle = device.kind === 'aisle-shuttle' || device.kind === 'layer-shuttle' || device.kind === 'four-way-shuttle';
    if (!isShuttle) continue;
    const covered = device.capability.aisles && device.capability.aisles.length > 0 ? device.capability.aisles : aisleIds;
    const share = device.capability.aisles && device.capability.aisles.length > 0 ? 1 : 1 / Math.max(1, aisleIds.length);
    for (const aisleId of covered) {
      const idx = aisleIndexById.get(aisleId);
      if (idx !== undefined) shuttleCountPerAisle[idx] += share;
    }
  }
  const aisleCapacitySecondsPerDay = new Float64Array(aisleIds.length);
  for (let i = 0; i < aisleIds.length; i += 1) {
    aisleCapacitySecondsPerDay[i] = Math.max(1, shuttleCountPerAisle[i]) * 86400 * costConfig.aisleUtilizationTarget;
  }

  // 提升机分组：由货物提升机的服务巷道推导（每个竖井服务一个货架块）。
  const aisleToLiftGroup = new Map<string, number>();
  const liftGroupIds: string[] = [];
  for (const device of topology.devices) {
    if (device.kind !== 'pallet-lift') continue;
    const groupIndex = liftGroupIds.length;
    liftGroupIds.push(device.id);
    for (const aisleId of device.capability.aisles ?? []) {
      if (!aisleToLiftGroup.has(aisleId)) aisleToLiftGroup.set(aisleId, groupIndex);
    }
  }
  if (liftGroupIds.length === 0) {
    liftGroupIds.push('LIFT-0');
    for (const aisleId of aisleIds) aisleToLiftGroup.set(aisleId, 0);
  }
  const liftCapacitySecondsPerDay = new Float64Array(liftGroupIds.length);
  const liftCountPerGroup = new Float64Array(liftGroupIds.length);
  for (const device of topology.devices) {
    if (device.kind !== 'pallet-lift') continue;
    const groupIndex = liftGroupIds.indexOf(device.id);
    if (groupIndex >= 0) liftCountPerGroup[groupIndex] += 1;
  }
  for (let g = 0; g < liftCapacitySecondsPerDay.length; g += 1) {
    liftCapacitySecondsPerDay[g] = Math.max(1, liftCountPerGroup[g]) * 86400 * costConfig.liftUtilizationTarget;
  }

  // ---- 库位代价表 ----
  const locationCost: LocationCost[] = new Array(locations.length);
  const availableLocations: number[] = [];
  const placeableLocations: number[] = [];
  const zoneOfLocation: string[] = new Array(locations.length);
  const locMaxWeight = new Float64Array(locations.length);
  const locMaxVolume = new Float64Array(locations.length);
  for (let i = 0; i < locations.length; i += 1) {
    const location = locations[i];
    zoneOfLocation[i] = location.zone;
    locMaxWeight[i] = location.maxWeight_kg;
    locMaxVolume[i] = location.maxVolume_m3;
    const aisleIndex = aisleIndexById.get(location.aisleId) ?? 0;
    const usesLift = location.level > 1;
    const liftGroup = usesLift ? aisleToLiftGroup.get(location.aisleId) ?? 0 : 0;
    if (location.availability === 'frozen' || location.availability === 'unavailable') {
      locationCost[i] = {
        pickSeconds: Number.POSITIVE_INFINITY,
        putSeconds: Number.POSITIVE_INFINITY,
        meters: Number.POSITIVE_INFINITY,
        aisleIndex,
        usesLift,
        liftGroup,
        depthPenaltySeconds: 0,
      };
      continue;
    }
    const pick = outNode ? secondsToStation(routeModel, location.id, outNode, shuttle, true) : 0;
    const put = inNode ? secondsToStation(routeModel, location.id, inNode, shuttle, true) : 0;
    if (!Number.isFinite(pick) || !Number.isFinite(put)) {
      locationCost[i] = {
        pickSeconds: Number.POSITIVE_INFINITY,
        putSeconds: Number.POSITIVE_INFINITY,
        meters: Number.POSITIVE_INFINITY,
        aisleIndex,
        usesLift,
        liftGroup,
        depthPenaltySeconds: 0,
      };
      continue;
    }
    const depthPenalty = Math.max(0, location.depth - 1) * (shuttle.transfer_s + 2);
    locationCost[i] = {
      pickSeconds: pick + costConfig.handling_s,
      putSeconds: put + costConfig.handling_s,
      meters: (pick - costConfig.handling_s) * shuttle.speed_mps * 0.9,
      aisleIndex,
      usesLift,
      liftGroup,
      depthPenaltySeconds: depthPenalty,
    };
    placeableLocations.push(i);
    if (location.availability === 'available') availableLocations.push(i);
  }

  // ---- SKU 与货物单元 ----
  const skus = problem.skus;
  const skuIndex = new Map(skus.map((s, i) => [s.id, i]));
  const loadUnits = problem.inventory;
  const luIndex = new Map(loadUnits.map((u, i) => [u.id, i]));
  const luSku = new Int32Array(loadUnits.length);
  const pieceTotal = new Float64Array(skus.length);
  for (const unit of loadUnits) {
    const s = skuIndex.get(unit.skuId);
    if (s !== undefined) pieceTotal[s] += unit.quantity;
  }
  const skuDailyOut = new Float64Array(skus.length);
  const skuDailyIn = new Float64Array(skus.length);
  const skuWeight = new Float64Array(skus.length);
  const skuVolume = new Float64Array(skus.length);
  for (let s = 0; s < skus.length; s += 1) {
    skuDailyOut[s] = skus[s].meanDailyDemand;
    skuDailyIn[s] = skus[s].meanDailyDemand * 0.92;
    skuWeight[s] = skus[s].unitWeight_kg;
    skuVolume[s] = skus[s].unitVolume_m3;
  }
  const unitFlow = new Float64Array(loadUnits.length);
  for (let i = 0; i < loadUnits.length; i += 1) {
    const s = skuIndex.get(loadUnits[i].skuId) ?? 0;
    luSku[i] = s;
    const share = pieceTotal[s] > 0 ? loadUnits[i].quantity / pieceTotal[s] : 1;
    unitFlow[i] = skuDailyOut[s] * share;
  }

  // ---- 当前布局 ----
  const currentLocationOfLu = new Int32Array(loadUnits.length).fill(-1);
  const locIndexById = new Map(locations.map((l, i) => [l.id, i]));
  if (problem.currentAssignment && problem.currentAssignment.length > 0) {
    for (const entry of problem.currentAssignment) {
      const lu = luIndex.get(entry.loadUnitId);
      const locIdx = locIndexById.get(entry.locationId);
      if (lu !== undefined && locIdx !== undefined) currentLocationOfLu[lu] = locIdx;
    }
  } else {
    for (const unit of loadUnits) {
      if (!unit.locationId) continue;
      const lu = luIndex.get(unit.id);
      const locIdx = locIndexById.get(unit.locationId);
      if (lu !== undefined && locIdx !== undefined) currentLocationOfLu[lu] = locIdx;
    }
  }

  // ---- 候选位置排序（按运行时间，用于"最近可用"与启发式初始解）----
  const locationOrderByCost = [...placeableLocations].sort((a, b) => {
    const ca = locationCost[a].pickSeconds * costConfig.outboundShare + locationCost[a].putSeconds * (1 - costConfig.outboundShare);
    const cb = locationCost[b].pickSeconds * costConfig.outboundShare + locationCost[b].putSeconds * (1 - costConfig.outboundShare);
    if (ca !== cb) return ca - cb;
    return a - b;
  });

  return {
    problem,
    topology,
    locations,
    routeModel,
    costConfig,
    skus,
    skuIndex,
    loadUnits,
    luIndex,
    luSku,
    unitFlow,
    locationCost,
    availableLocations,
    placeableLocations,
    aisleIds,
    aisleCapacitySecondsPerDay,
    liftGroupIds,
    liftCapacitySecondsPerDay,
    zoneOfLocation,
    locMaxWeight,
    locMaxVolume,
    skuWeight,
    skuVolume,
    skuDailyOut,
    skuDailyIn,
    hardConstraints: new Set(problem.hardConstraints),
    currentLocationOfLu,
    affinity: { pairs: new Map(), clusterOf: new Int32Array(skus.length).fill(-1), clusters: 0 },
    relocationCache: new Map(),
    locationOrderByCost,
    rngSeed: problem.algorithm.seed,
  };
}

/* ------------------------------------------------------------------ *
 * 状态与增量评估
 * ------------------------------------------------------------------ */

export interface ObjectiveVector {
  /** 目标 id → 原始值（带单位）。 */
  values: Record<string, number>;
  /** 加权后的综合分（仅用于搜索，不对外宣称"综合最优"）。 */
  scalar: number;
  /** 未分配货物单元数（>0 表示解不完整；验证器会独立复核）。 */
  unassigned: number;
}

/**
 * 库位能否放下该货物单元（独立函数版本：与状态无关的**纯判定**）。
 *
 * 求解器与验证器各自调用同一个纯函数，但它们对结果的**使用方式**不同：
 * 求解器用它剪枝，验证器用它复核（SRS §6.4 的独立验证以"重新计算"为准）。
 */
export function canPlace(model: SlottingModel, lu: number, locIdx: number): { ok: boolean; code?: ConstraintCode; reason?: string } {
  const location = model.locations[locIdx];
  if (location.availability === 'frozen' || location.availability === 'unavailable') {
    return {
      ok: false,
      code: location.availability === 'frozen' ? 'LOCATION_FROZEN' : 'LOCATION_UNAVAILABLE',
      reason: `库位 ${location.id} 不可用（${location.availability}）`,
    };
  }
  const cost = model.locationCost[locIdx];
  if (!Number.isFinite(cost.pickSeconds)) {
    return { ok: false, code: 'LOCATION_UNAVAILABLE', reason: `库位 ${location.id} 不可达` };
  }
  const sku = model.luSku[lu];
  if (model.skuWeight[sku] > model.locMaxWeight[locIdx] + 1e-9) {
    return {
      ok: false,
      code: 'LOCATION_WEIGHT_LIMIT',
      reason: `SKU 单元重量 ${model.skuWeight[sku]}kg 超过库位 ${location.id} 上限 ${model.locMaxWeight[locIdx]}kg`,
    };
  }
  if (model.skuVolume[sku] > model.locMaxVolume[locIdx] + 1e-9) {
    return {
      ok: false,
      code: 'LOCATION_VOLUME_LIMIT',
      reason: `SKU 单元体积 ${model.skuVolume[sku]}m³ 超过库位 ${location.id} 容积 ${model.locMaxVolume[locIdx]}m³`,
    };
  }
  const allowed = model.skus[sku].allowedZones;
  if (allowed.length > 0) {
    const zone = model.zoneOfLocation[locIdx];
    const compatible = allowed.some((candidate) => zone === candidate || zone.startsWith(candidate));
    if (!compatible) {
      return {
        ok: false,
        code: 'ZONE_COMPATIBILITY',
        reason: `SKU 储存分区限制 ${allowed.join('/')} 与库位分区 ${zone} 不兼容`,
      };
    }
  }
  const deepPolicy = model.problem.constraints.deepLanePolicy ?? 'front-only';
  if (deepPolicy === 'front-only' && location.depth > 1 && model.skus[sku].abc === 'A') {
    return {
      ok: false,
      code: 'DEEP_LANE_BLOCKING',
      reason: `A 类商品 ${model.skus[sku].id} 不允许放在深位 ${location.id}（会遮挡后续取货）`,
    };
  }
  return { ok: true };
}

/**
 * 库位分配状态：SoA + TypedArray，交换/移动的增量维护 O(1)。
 */
export class SlottingState {
  readonly model: SlottingModel;
  /** 货物单元 → 库位下标（-1 = 未分配）。 */
  readonly locOfLu: Int32Array;
  /** 库位下标 → 货物单元（-1 = 空）。 */
  readonly luAtLoc: Int32Array;
  /** 每条巷道的日流量（件/天）。 */
  readonly aisleFlow: Float64Array;
  /** 每组提升机的日流量。 */
  readonly liftFlow: Float64Array;
  unassigned: number;
  baseSeconds = 0;
  baseMeters = 0;
  relocationCount = 0;
  relocationSeconds = 0;

  constructor(model: SlottingModel) {
    this.model = model;
    this.locOfLu = new Int32Array(model.loadUnits.length).fill(-1);
    this.luAtLoc = new Int32Array(model.locations.length).fill(-1);
    this.aisleFlow = new Float64Array(model.aisleIds.length);
    this.liftFlow = new Float64Array(model.liftGroupIds.length);
    this.unassigned = model.loadUnits.length;
  }

  clone(): SlottingState {
    const next = new SlottingState(this.model);
    next.locOfLu.set(this.locOfLu);
    next.luAtLoc.set(this.luAtLoc);
    next.aisleFlow.set(this.aisleFlow);
    next.liftFlow.set(this.liftFlow);
    next.unassigned = this.unassigned;
    next.baseSeconds = this.baseSeconds;
    next.baseMeters = this.baseMeters;
    next.relocationCount = this.relocationCount;
    next.relocationSeconds = this.relocationSeconds;
    return next;
  }

  /** 库位能否放下该货物单元（容量 + 分区 + 状态 + 深位策略，O(1)）。 */
  canPlace(lu: number, locIdx: number): { ok: boolean; code?: ConstraintCode; reason?: string } {
    return canPlace(this.model, lu, locIdx);
  }

  /** 放置（调用方必须先 canPlace）。 */
  place(lu: number, locIdx: number): void {
    const model = this.model;
    if (this.locOfLu[lu] >= 0) this.unplace(lu);
    this.locOfLu[lu] = locIdx;
    this.luAtLoc[locIdx] = lu;
    const cost = model.locationCost[locIdx];
    const flow = model.unitFlow[lu];
    this.baseSeconds += flow * (model.costConfig.outboundShare * cost.pickSeconds + (1 - model.costConfig.outboundShare) * cost.putSeconds);
    this.baseMeters += flow * cost.meters;
    this.aisleFlow[cost.aisleIndex] += flow;
    if (cost.usesLift) this.liftFlow[cost.liftGroup] += flow;
    this.unassigned -= 1;
  }

  unplace(lu: number): void {
    const model = this.model;
    const locIdx = this.locOfLu[lu];
    if (locIdx < 0) return;
    const cost = model.locationCost[locIdx];
    const flow = model.unitFlow[lu];
    this.baseSeconds -= flow * (model.costConfig.outboundShare * cost.pickSeconds + (1 - model.costConfig.outboundShare) * cost.putSeconds);
    this.baseMeters -= flow * cost.meters;
    this.aisleFlow[cost.aisleIndex] -= flow;
    if (cost.usesLift) this.liftFlow[cost.liftGroup] -= flow;
    this.locOfLu[lu] = -1;
    this.luAtLoc[locIdx] = -1;
    this.unassigned += 1;
  }

  /** 交换两个货物单元的库位（允许其中一个未分配）。 */
  swap(luA: number, luB: number): void {
    const locA = this.locOfLu[luA];
    const locB = this.locOfLu[luB];
    this.unplace(luA);
    this.unplace(luB);
    if (locB >= 0) this.place(luA, locB);
    if (locA >= 0) this.place(luB, locA);
  }

  /** 把货物单元移到指定库位；目标被占用时与占用者交换。 */
  moveTo(lu: number, locIdx: number): void {
    const occupant = this.luAtLoc[locIdx];
    if (occupant >= 0 && occupant !== lu) {
      this.swap(lu, occupant);
      return;
    }
    this.unplace(lu);
    this.place(lu, locIdx);
  }

  /** 拥堵代理：ρ/(1−ρ) 型排队延误（秒/天），ρ 截断在 0.97 以内避免发散。 */
  congestionSeconds(): number {
    const model = this.model;
    let total = 0;
    for (let i = 0; i < this.aisleFlow.length; i += 1) {
      const capacity = model.aisleCapacitySecondsPerDay[i];
      const flow = this.aisleFlow[i];
      if (capacity <= 0 || flow <= 0) continue;
      const demandSeconds = flow * model.costConfig.aisleServiceSeconds;
      const rho = clamp(demandSeconds / capacity, 0, 0.97);
      if (rho <= 0.01) continue;
      total += model.costConfig.congestionScale * (rho / (1 - rho)) * demandSeconds;
    }
    for (let g = 0; g < this.liftFlow.length; g += 1) {
      const capacity = model.liftCapacitySecondsPerDay[g];
      const flow = this.liftFlow[g];
      if (capacity <= 0 || flow <= 0) continue;
      const demandSeconds = flow * model.costConfig.liftServiceSeconds;
      const rho = clamp(demandSeconds / capacity, 0, 0.97);
      if (rho <= 0.01) continue;
      total += model.costConfig.congestionScale * (rho / (1 - rho)) * demandSeconds;
    }
    return total;
  }

  /** 巷道负载基尼系数（0 = 完全均衡）。 */
  aisleLoadGini(): number {
    return gini(Array.from(this.aisleFlow));
  }

  /** 拥堵对单件运行时间的乘数。 */
  effectiveCongestionFactor(): number {
    let totalFlow = 0;
    for (const flow of this.aisleFlow) totalFlow += flow;
    if (totalFlow <= 0) return 1;
    const congestion = this.congestionSeconds();
    return 1 + congestion / (totalFlow * this.model.costConfig.aisleServiceSeconds);
  }

  /** 时效：拥堵调整后运行时间不超过阈值的流量占比。 */
  timeliness(): number {
    const model = this.model;
    const factor = this.effectiveCongestionFactor();
    let inTime = 0;
    let total = 0;
    for (let lu = 0; lu < this.locOfLu.length; lu += 1) {
      const locIdx = this.locOfLu[lu];
      if (locIdx < 0) continue;
      const flow = model.unitFlow[lu];
      total += flow;
      if (model.locationCost[locIdx].pickSeconds * factor <= model.costConfig.timelinessThreshold_s) inTime += flow;
    }
    return total > 0 ? inTime / total : 1;
  }

  /** 相对"当前布局"的迁移代价（件数 + 设备秒）。 */
  recomputeRelocation(): void {
    const model = this.model;
    let count = 0;
    let seconds = 0;
    for (let lu = 0; lu < this.locOfLu.length; lu += 1) {
      const target = this.locOfLu[lu];
      if (target < 0) continue;
      const current = model.currentLocationOfLu[lu];
      if (current === target) continue;
      count += 1;
      seconds += this.relocationSecondsFor(current, target);
    }
    this.relocationCount = count;
    this.relocationSeconds = seconds;
  }

  /** 单次迁移的设备秒数（两两库位运行时间按需计算并缓存）。 */
  relocationSecondsFor(fromLoc: number, toLoc: number): number {
    const model = this.model;
    if (fromLoc < 0) {
      return model.locationCost[toLoc].putSeconds + model.costConfig.relocationOverhead_s;
    }
    let row = model.relocationCache.get(fromLoc);
    if (!row) {
      row = new Float64Array(model.locations.length).fill(Number.NaN);
      model.relocationCache.set(fromLoc, row);
    }
    let value = row[toLoc];
    if (Number.isNaN(value)) {
      const { shuttle } = representativeDevice(model.topology);
      const route = routeBetweenLocations(model.routeModel, model.locations[fromLoc].id, model.locations[toLoc].id, shuttle);
      value = Number.isFinite(route.seconds) ? route.seconds + model.costConfig.relocationOverhead_s : 600;
      row[toLoc] = value;
    }
    return value;
  }

  /** 全量重算（构建初始状态，或校验增量维护的正确性）。 */
  static rebuild(model: SlottingModel, assignment?: Int32Array): SlottingState {
    const state = new SlottingState(model);
    if (assignment) {
      for (let lu = 0; lu < assignment.length; lu += 1) {
        const locIdx = assignment[lu];
        if (locIdx >= 0) state.place(lu, locIdx);
      }
    }
    state.recomputeRelocation();
    return state;
  }
}

/** 目标值聚合：把状态 + 模型翻译成带单位的指标与目标向量。 */
export function evaluateObjectives(model: SlottingModel, state: SlottingState): ObjectiveVector {
  const congestion = state.congestionSeconds();
  const congestionFactor = state.effectiveCongestionFactor();
  const assigned = model.loadUnits.length - state.unassigned;
  const availableCount = Math.max(1, model.availableLocations.length);
  const values: Record<string, number> = {
    'expected-travel-time': round(state.baseSeconds * congestionFactor, 3),
    'device-travel-distance': round(state.baseMeters, 3),
    'space-utilization': round(assigned / availableCount, 6),
    'relocation-count': state.relocationCount,
    'relocation-cost': round(state.relocationSeconds, 3),
    congestion: round(congestion, 3),
    'load-balance': round(state.aisleLoadGini(), 6),
    'delivery-timeliness': round(state.timeliness(), 6),
    energy: round((state.baseMeters / 1000) * 0.0016, 3),
  };
  let scalar = 0;
  for (const objective of model.problem.objectives) {
    const raw = values[objective.id] ?? 0;
    const reference = objective.normalizer ?? defaultNormalizer(objective.id);
    const normalized = reference > 0 ? raw / reference : raw;
    scalar += objective.weight * (objective.direction === 'min' ? normalized : -normalized);
  }
  // 未分配库存是硬惩罚（不允许"靠不分配来降低运行代价"）
  scalar += state.unassigned * 1e3;
  return { values, scalar, unassigned: state.unassigned };
}

/** 各目标的默认归一化尺度（保证不同量纲的加权有意义；面板会如实展示）。 */
export function defaultNormalizer(id: string): number {
  switch (id) {
    case 'expected-travel-time':
      return 100000;
    case 'device-travel-distance':
      return 500000;
    case 'relocation-count':
      return 1000;
    case 'relocation-cost':
      return 100000;
    case 'congestion':
      return 10000;
    case 'load-balance':
      return 0.5;
    case 'delivery-timeliness':
      return 1;
    case 'energy':
      return 2000;
    default:
      return 1;
  }
}

/**
 * 随机初始解：把货物单元随机放到合法库位（放不下的计入未分配）。
 * 这是"随机储位分配"策略的真实实现，也是所有高级算法的对照基线之一。
 */
export function seedRandomAssignment(model: SlottingModel, seed: number): Int32Array {
  const rng = makeRng(seedFrom('seed-assignment', seed, model.loadUnits.length));
  const assignment = new Int32Array(model.loadUnits.length).fill(-1);
  const occupancy = new Uint8Array(model.locations.length);
  const order = Array.from({ length: model.loadUnits.length }, (_, i) => i);
  // A 类优先取位（热门商品先入场，符合随机策略的真实语义）
  order.sort((a, b) => {
    const sa = model.skus[model.luSku[a]].abc === 'A' ? 0 : 1;
    const sb = model.skus[model.luSku[b]].abc === 'A' ? 0 : 1;
    return sa - sb;
  });
  const candidates = model.placeableLocations;
  for (const lu of order) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (candidates.length === 0) break;
      const locIdx = candidates[rng.int(0, candidates.length)];
      if (occupancy[locIdx] === 1) continue;
      if (!canPlace(model, lu, locIdx).ok) continue;
      assignment[lu] = locIdx;
      occupancy[locIdx] = 1;
      break;
    }
  }
  return assignment;
}
