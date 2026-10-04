/**
 * 通行模型（routing）：把拓扑变成"设备真正要跑多久"的函数。
 *
 * 关键点（对应 SRS §1.3 与 §4.4）：
 *   - 距离不是欧氏距离，而是 **巷道内轨道距离 + 横巷距离 + 层间提升距离** 的组合；
 *   - 时间不是 `距离 / 速度`，而是**梯形速度曲线**（含加减速），并按载货/空载取不同速度；
 *   - 多深位库位有**额外的取放代价**：深度 d 需要在列内多走 (d−1) 次进深并额外取放；
 *   - 结构图（骨架）只含巷道端点 / 竖井 / 站台 / 交叉口，规模小、可反复求最短路；
 *     巷道内部用解析公式，避免为百万级库位建图。
 *
 * 这一层被库位优化的**成本模型**与立库调度的**路径规划**共同使用：
 * 两个模块因此共享同一份物理运动学，不会出现"库位优化以为 10 秒、调度实跑 40 秒"的错位。
 */

import type { DeviceSpec, LocationRecord, MotionProfile, WarehouseNode, WarehouseTopology } from '../contract/types.ts';
import { round, travelTime } from '../contract/util.ts';
import { indexLocations, type LocationIndex } from './topology.ts';

/** 路径端点：库位或结构节点。 */
export type RoutePoint = { kind: 'location'; locationId: string } | { kind: 'node'; nodeId: string };

export interface RouteResult {
  seconds: number;
  distance_m: number;
  /** 巷道内运行距离（用于设备利用率与能耗拆分）。 */
  inAisle_m: number;
  /** 横巷 / 地面运距。 */
  cross_m: number;
  /** 层间提升距离（竖直米数）。 */
  vertical_m: number;
  levelChanges: number;
  /** 经过的结构节点（用于三维回放与"为什么走这条路径"的解释）。 */
  path: string[];
  /** 从哪一端进入巷道。 */
  enterEnd: 'W' | 'E' | null;
  /** 深度带来的额外代价（秒）。 */
  depthPenalty_s: number;
}

export interface RouteModel {
  topology: WarehouseTopology;
  index: LocationIndex;
  nodeById: Map<string, WarehouseNode>;
  /** 骨架邻接表（有向，双向通道展开为两条）。 */
  adj: Map<string, Array<{ to: string; linkId: string; length_m: number; mode: string; capacity: number }>>;
  /** 单源最短路缓存：sourceNodeId → (targetNodeId → 秒)。按需计算（懒加载）。 */
  distCache: Map<string, { node: string; seconds: number; distance_m: number; vertical_m: number; hops: string[] }[]>;
  /** 巷道端点坐标（便于 O(1) 求巷道内解析距离）。 */
  aisleAxis: Map<string, { x0: number; x1: number; z: number; level: number }>;
  /** 站台 → 距离缓存（库位优化的热路径）。 */
  stationCache: Map<string, Map<string, number>>;
}

/** 由拓扑建路由模型（纯函数，不修改入参）。 */
export function buildRouteModel(topology: WarehouseTopology, locations: readonly LocationRecord[]): RouteModel {
  const index = indexLocations(locations);
  const nodeById = new Map<string, WarehouseNode>();
  for (const node of topology.nodes) nodeById.set(node.id, node);
  const adj = new Map<string, Array<{ to: string; linkId: string; length_m: number; mode: string; capacity: number }>>();
  const push = (from: string, entry: { to: string; linkId: string; length_m: number; mode: string; capacity: number }) => {
    const list = adj.get(from) ?? [];
    list.push(entry);
    adj.set(from, list);
  };
  const closed = new Set(topology.closedLinks ?? []);
  for (const link of topology.links) {
    if (closed.has(link.id)) continue;
    push(link.from, { to: link.to, linkId: link.id, length_m: link.length_m, mode: link.mode, capacity: link.capacity });
    if (link.bidirectional) {
      push(link.to, { to: link.from, linkId: link.id, length_m: link.length_m, mode: link.mode, capacity: link.capacity });
    }
  }
  const aisleAxis = new Map<string, { x0: number; x1: number; z: number; level: number }>();
  for (const aisle of topology.aisles) {
    const [a, b] = aisle.endNodeIds;
    const na = nodeById.get(a);
    const nb = nodeById.get(b);
    if (!na || !nb) continue;
    aisleAxis.set(`${aisle.id}|${aisle.level}`, {
      x0: Math.min(na.position[0], nb.position[0]),
      x1: Math.max(na.position[0], nb.position[0]),
      z: na.position[2],
      level: aisle.level,
    });
  }
  return { topology, index, nodeById, adj, distCache: new Map(), aisleAxis, stationCache: new Map() };
}

/** 单源最短路（Dijkstra），按需计算并缓存；返回距离与竖直米数。 */
function dijkstra(model: RouteModel, source: string): { node: string; seconds: number; distance_m: number; vertical_m: number; hops: string[] }[] {
  const cached = model.distCache.get(source);
  if (cached) return cached;
  const speedOf = (mode: string): { speed: number; accel: number } => {
    // 骨架上的默认运动学：轨道 2.6 m/s、地面 1.8 m/s、提升 0.9 m/s、输送机 0.8 m/s。
    // 真实设备的时间由调用方传入的 motion 覆盖（见 routeToLocation 的二次换算）。
    switch (mode) {
      case 'rail':
        return { speed: 2.6, accel: 1.3 };
      case 'conveyor':
        return { speed: 0.8, accel: 0.4 };
      case 'lift-shaft':
        return { speed: 0.9, accel: 0.7 };
      default:
        return { speed: 1.8, accel: 1.0 };
    }
  };
  const best = new Map<string, { seconds: number; distance_m: number; vertical_m: number }>();
  const hops = new Map<string, string[]>();
  best.set(source, { seconds: 0, distance_m: 0, vertical_m: 0 });
  hops.set(source, [source]);
  // 小图用数组选择最小（避免引入堆实现带来的复杂度与不稳定性）
  const visited = new Set<string>();
  for (;;) {
    let current: string | null = null;
    let currentSeconds = Infinity;
    for (const [node, value] of best) {
      if (visited.has(node)) continue;
      if (value.seconds < currentSeconds) {
        currentSeconds = value.seconds;
        current = node;
      }
    }
    if (current === null) break;
    visited.add(current);
    const cur = best.get(current) as { seconds: number; distance_m: number; vertical_m: number };
    for (const edge of model.adj.get(current) ?? []) {
      const motion = speedOf(edge.mode);
      const dt = travelTime(edge.length_m, motion.speed, motion.accel);
      const candidate = cur.seconds + dt;
      const prev = best.get(edge.to);
      if (!prev || candidate < prev.seconds - 1e-9) {
        const fromNode = model.nodeById.get(current);
        const toNode = model.nodeById.get(edge.to);
        const dy = Math.abs((toNode?.position[1] ?? 0) - (fromNode?.position[1] ?? 0));
        best.set(edge.to, {
          seconds: candidate,
          distance_m: cur.distance_m + edge.length_m,
          vertical_m: cur.vertical_m + (edge.mode === 'lift-shaft' ? dy : 0),
        });
        hops.set(edge.to, [...(hops.get(current) ?? []), edge.to]);
      }
    }
  }
  const out = [...best.entries()].map(([node, value]) => ({ node, ...value, hops: hops.get(node) ?? [] }));
  model.distCache.set(source, out);
  return out;
}

/** 结构节点之间的最短时间（秒）。同一节点返回 0。 */
export function nodeDistance(model: RouteModel, from: string, to: string): { seconds: number; distance_m: number; vertical_m: number; path: string[] } {
  if (from === to) return { seconds: 0, distance_m: 0, vertical_m: 0, path: [from] };
  const list = dijkstra(model, from);
  const hit = list.find((entry) => entry.node === to);
  if (!hit) {
    // 不可达：返回一个显式的"不可达"大值并保留空路径（调用方据此判定 REACHABILITY 违规）
    return { seconds: Number.POSITIVE_INFINITY, distance_m: Number.POSITIVE_INFINITY, vertical_m: 0, path: [] };
  }
  return { seconds: hit.seconds, distance_m: hit.distance_m, vertical_m: hit.vertical_m, path: hit.hops };
}

/** 库位在巷道内的位置（x 坐标）与深度代价。 */
function locationAccess(model: RouteModel, location: LocationRecord): { x: number; endW: string; endE: string; depthMoves: number; depthDistance_m: number } {
  const endW = `N-${location.aisleId}-L${location.level}-W`;
  const endE = `N-${location.aisleId}-L${location.level}-E`;
  const depthMoves = Math.max(0, location.depth - 1);
  return { x: location.position[0], endW, endE, depthMoves, depthDistance_m: depthMoves * location.size.depth_m };
}

/** 巷道内解析运行时间（米 → 秒，梯形曲线；设备运动学由 motion 给出）。 */
function inAisleSeconds(model: RouteModel, aisleId: string, level: number, fromX: number, toX: number, motion: MotionProfile, loaded = false): number {
  const axis = model.aisleAxis.get(`${aisleId}|${level}`);
  const span = axis ? axis.x1 - axis.x0 : Math.abs(toX - fromX);
  const distance = Math.min(Math.abs(toX - fromX), Math.max(span, 1e-6) * 1.5);
  const factor = loaded ? (motion.loaded_speed_factor ?? 1) : 1;
  return travelTime(distance, motion.speed_mps * factor, motion.accel_mps2);
}

/**
 * 从一个结构节点走到一个库位（取货方向）。
 *
 * 返回的时间包含：骨架最短路 + 巷道内运行 + 深度取放代价 + 一次取放动作。
 * 库位不可达（如巷道端点缺失）时 `seconds = Infinity`，调用方必须显式处理。
 */
export function routeToLocation(
  model: RouteModel,
  fromNodeId: string,
  locationId: string,
  motion: MotionProfile,
  opts: { loaded?: boolean; includeTransfer?: boolean } = {},
): RouteResult {
  const location = model.index.byId.get(locationId);
  if (!location) {
    return {
      seconds: Number.POSITIVE_INFINITY,
      distance_m: Number.POSITIVE_INFINITY,
      inAisle_m: 0,
      cross_m: Number.POSITIVE_INFINITY,
      vertical_m: 0,
      levelChanges: 0,
      path: [],
      enterEnd: null,
      depthPenalty_s: 0,
    };
  }
  const access = locationAccess(model, location);
  const candidates: Array<{ end: 'W' | 'E'; total: number; cross: number; vertical: number; path: string[]; inAisle: number }> = [];
  for (const end of ['W', 'E'] as const) {
    const endNode = end === 'W' ? access.endW : access.endE;
    if (!model.nodeById.has(endNode)) continue;
    const skeleton = nodeDistance(model, fromNodeId, endNode);
    if (!Number.isFinite(skeleton.seconds)) continue;
    const endX = model.nodeById.get(endNode)?.position[0] ?? access.x;
    const inAisle = inAisleSeconds(model, location.aisleId, location.level, endX, access.x, motion, opts.loaded ?? false);
    candidates.push({
      end,
      total: skeleton.seconds + inAisle,
      cross: skeleton.distance_m,
      vertical: skeleton.vertical_m,
      path: [...skeleton.path],
      inAisle: Math.abs(endX - access.x),
    });
  }
  if (candidates.length === 0) {
    return {
      seconds: Number.POSITIVE_INFINITY,
      distance_m: Number.POSITIVE_INFINITY,
      inAisle_m: 0,
      cross_m: Number.POSITIVE_INFINITY,
      vertical_m: 0,
      levelChanges: 0,
      path: [],
      enterEnd: null,
      depthPenalty_s: 0,
    };
  }
  candidates.sort((a, b) => a.total - b.total);
  const best = candidates[0];
  // 深度代价：列内额外进深移动 + 每深位一次取放动作（多深位货架的物理事实）
  const depthTravel = travelTime(access.depthDistance_m, motion.speed_mps, motion.accel_mps2);
  const depthPenalty = depthTravel + access.depthMoves * motion.transfer_s;
  const transfer = opts.includeTransfer === false ? 0 : motion.transfer_s;
  return {
    seconds: round(best.total + depthPenalty + transfer, 4),
    distance_m: round(best.cross + best.inAisle + access.depthDistance_m, 4),
    inAisle_m: round(best.inAisle, 4),
    cross_m: round(best.cross, 4),
    vertical_m: round(best.vertical, 4),
    levelChanges: Math.round(best.vertical / 1.8),
    path: [...best.path, locationId],
    enterEnd: best.end,
    depthPenalty_s: round(depthPenalty, 4),
  };
}

/** 库位 → 库位（移库任务：先取后放，两段行程）。 */
export function routeBetweenLocations(model: RouteModel, fromLocationId: string, toLocationId: string, motion: MotionProfile): RouteResult {
  const from = model.index.byId.get(fromLocationId);
  const to = model.index.byId.get(toLocationId);
  if (!from || !to) {
    return {
      seconds: Number.POSITIVE_INFINITY,
      distance_m: Number.POSITIVE_INFINITY,
      inAisle_m: 0,
      cross_m: Number.POSITIVE_INFINITY,
      vertical_m: 0,
      levelChanges: 0,
      path: [],
      enterEnd: null,
      depthPenalty_s: 0,
    };
  }
  // 同一货架列内的重排（倒垛）走列内路径，代价显著低于跨巷道
  if (from.rackId === to.rackId && from.level === to.level) {
    const depthTravel = travelTime(Math.abs(from.depth - to.depth) * from.size.depth_m, motion.speed_mps, motion.accel_mps2);
    return {
      seconds: round(depthTravel + motion.transfer_s * 2, 4),
      distance_m: round(Math.abs(from.depth - to.depth) * from.size.depth_m, 4),
      inAisle_m: round(Math.abs(from.position[0] - to.position[0]), 4),
      cross_m: 0,
      vertical_m: 0,
      levelChanges: 0,
      path: [fromLocationId, toLocationId],
      enterEnd: null,
      depthPenalty_s: round(depthTravel, 4),
    };
  }
  const accessFrom = locationAccess(model, from);
  const accessTo = locationAccess(model, to);
  let best = Number.POSITIVE_INFINITY;
  let bestPath: string[] = [];
  let bestCross = 0;
  let bestVertical = 0;
  let bestInAisle = 0;
  for (const endA of ['W', 'E'] as const) {
    const nodeA = endA === 'W' ? accessFrom.endW : accessFrom.endE;
    if (!model.nodeById.has(nodeA)) continue;
    for (const endB of ['W', 'E'] as const) {
      const nodeB = endB === 'W' ? accessTo.endW : accessTo.endE;
      if (!model.nodeById.has(nodeB)) continue;
      const skeleton = nodeDistance(model, nodeA, nodeB);
      if (!Number.isFinite(skeleton.seconds)) continue;
      const inA = inAisleSeconds(model, from.aisleId, from.level, model.nodeById.get(nodeA)?.position[0] ?? from.position[0], from.position[0], motion, true);
      const inB = inAisleSeconds(model, to.aisleId, to.level, model.nodeById.get(nodeB)?.position[0] ?? to.position[0], to.position[0], motion, true);
      const total = skeleton.seconds + inA + inB;
      if (total < best) {
        best = total;
        bestPath = [fromLocationId, ...skeleton.path, toLocationId];
        bestCross = skeleton.distance_m;
        bestVertical = skeleton.vertical_m;
        bestInAisle = Math.abs((model.nodeById.get(nodeA)?.position[0] ?? from.position[0]) - from.position[0]) + Math.abs((model.nodeById.get(nodeB)?.position[0] ?? to.position[0]) - to.position[0]);
      }
    }
  }
  const depthTravel = travelTime(accessTo.depthDistance_m, motion.speed_mps, motion.accel_mps2);
  return {
    seconds: Number.isFinite(best) ? round(best + depthTravel + motion.transfer_s * 2, 4) : Number.POSITIVE_INFINITY,
    distance_m: Number.isFinite(best) ? round(bestCross + bestInAisle + accessTo.depthDistance_m, 4) : Number.POSITIVE_INFINITY,
    inAisle_m: round(bestInAisle, 4),
    cross_m: round(bestCross, 4),
    vertical_m: round(bestVertical, 4),
    levelChanges: Math.round(bestVertical / 1.8),
    path: bestPath,
    enterEnd: null,
    depthPenalty_s: round(depthTravel, 4),
  };
}

/**
 * 库位 → 站台的热路径（库位优化的核心成本项）。
 *
 * 以站台节点为源做一次 Dijkstra 并缓存 `locationId → 秒`，
 * 使 500k 库位 × 数万 SKU 的成本评估变成两次哈希查表 + 一次解析计算。
 */
export function buildStationCostTable(
  model: RouteModel,
  stationNodeIds: readonly string[],
  motion: MotionProfile,
  opts: { loaded?: boolean } = {},
): Map<string, Map<string, number>> {
  for (const nodeId of stationNodeIds) {
    let table = model.stationCache.get(nodeId);
    if (table) continue;
    table = new Map<string, number>();
    for (const location of model.index.locations) {
      const result = routeToLocation(model, nodeId, location.id, motion, { loaded: opts.loaded ?? true, includeTransfer: true });
      table.set(location.id, result.seconds);
    }
    model.stationCache.set(nodeId, table);
  }
  return model.stationCache;
}

/** 库位 → 站台的秒数（走缓存；无缓存时现场算一次并写入）。 */
export function secondsToStation(model: RouteModel, locationId: string, stationNodeId: string, motion: MotionProfile, loaded = true): number {
  const table = model.stationCache.get(stationNodeId);
  if (table) {
    const hit = table.get(locationId);
    if (hit !== undefined) return hit;
  }
  const result = routeToLocation(model, stationNodeId, locationId, motion, { loaded, includeTransfer: true });
  if (Number.isFinite(result.seconds)) {
    const target = table ?? new Map<string, number>();
    target.set(locationId, result.seconds);
    model.stationCache.set(stationNodeId, target);
  }
  return result.seconds;
}

/**
 * 为三维回放生成路径的世界坐标序列（在巷道内按实际位置插值）。
 * 只做投影，不改变任何时间——时间轴来自调度结果。
 */
export function pathPositions(model: RouteModel, path: readonly string[], locationId?: string): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const id of path) {
    if (id === locationId) {
      const loc = model.index.byId.get(locationId);
      if (loc) out.push(loc.position);
      continue;
    }
    const node = model.nodeById.get(id);
    if (node) out.push(node.position);
  }
  return out;
}

/** 设备能力 → 是否可服务该库位（可达性 + 能力判定，调度与验证共用同一规则）。 */
export function canServeLocation(device: DeviceSpec, location: LocationRecord): { ok: boolean; reason?: string } {
  const cap = device.capability;
  if (cap.aisles && cap.aisles.length > 0 && !cap.aisles.includes(location.aisleId)) {
    return { ok: false, reason: `设备 ${device.id} 的服务范围不含巷道 ${location.aisleId}` };
  }
  if (cap.levels && cap.levels.length > 0 && !cap.levels.includes(location.level)) {
    return { ok: false, reason: `设备 ${device.id} 只服务层 ${cap.levels.join('/')}，库位在第 ${location.level} 层` };
  }
  if (cap.areas && cap.areas.length > 0 && !cap.areas.includes(location.areaId)) {
    return { ok: false, reason: `设备 ${device.id} 不在区域 ${location.areaId} 作业` };
  }
  return { ok: true };
}

/** 库位分区的储存兼容性（SKU 允许区域 ∩ 库位分区）。 */
export function zoneCompatible(skuZones: readonly string[], locationZone: string): boolean {
  if (skuZones.length === 0) return true;
  if (skuZones.includes(locationZone)) return true;
  // 高层分区沿用主分区前缀（例如 ASRS-HIGH 属于 ASRS 类）
  return skuZones.some((zone) => locationZone.startsWith(zone));
}
