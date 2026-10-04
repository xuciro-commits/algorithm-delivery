/**
 * 库位优化模块的场景投影：把「问题（拓扑 + 库存）」与「引擎结果（方案 + 指标）」拼成 3D 需要的图层。
 *
 * 分工（SRS §10）：
 *   * 几何 = 契约拓扑（货架 origin/bays/levels/locationSize、巷道、站台、链路）；
 *   * 颜色/高亮 = 问题数据与**引擎结果**的 join（哪个 SKU 在哪、引擎把哪件货搬到哪）；
 *   * 面板上出现的每个**数字**都来自 `envelope.metrics` / `result.*`，本文件不计算任何指标。
 */

import type { WarehouseEnvelope } from '../../core/warehouse/types';
import type { WarehouseProblemView } from '../warehouse-shared/geometry';
import {
  buildLocationIndex,
  classByLocation,
  clusterColor,
  heatColor,
  normalizeValues,
  parseLocationId,
  sceneBounds,
  topologyCounts,
  turnoverByLocation,
  type RackSpec,
  type SceneBounds,
} from '../warehouse-shared/geometry';

export interface SlottingHeatCell {
  locationId: string;
  position: [number, number, number];
  turnover: number;
  ratio: number;
  skuClass: string;
  /** 是否在本次运行中有货（引擎方案里的落位）。 */
  assigned: boolean;
}

export interface SlottingMigration {
  loadUnitId: string;
  from: [number, number, number] | null;
  to: [number, number, number] | null;
  reason: string;
}

export interface AisleLoad {
  aisleId: string;
  /** 问题数据里的周转量聚合（用于定位热点，不是引擎指标）。 */
  load: number;
  center: [number, number, number];
  length: number;
}

export interface SlottingScene {
  bounds: SceneBounds;
  counts: { aisles: number; locations: number; devices: number; racks: number };
  /** 原始货架契约（3D 结构层直接用，避免二次投影失真）。 */
  rackSpecs: RackSpec[];
  racks: Array<{
    id: string;
    origin: [number, number, number];
    bays: number;
    depths: number;
    levels: number;
    width: number;
    depth: number;
    height: number;
    bayAxis: [number, number];
    depthAxis: [number, number];
    levelY: number[];
  }>;
  heat: SlottingHeatCell[];
  /** 关联簇叠加（引擎 `result.clusters`；同簇同色）。 */
  clusterCells: SlottingClusterCell[];
  clusterCount: number;
  clusterNote: string;
  hot: SlottingHeatCell[];
  migrations: SlottingMigration[];
  aisles: AisleLoad[];
  stations: Array<{ id: string; position: [number, number, number]; capacity: number; direction: string }>;
  /** 引擎方案里落在每个库位的货物单元（用于点选查看）。 */
  occupant: Map<string, { loadUnitId: string; skuId: string }>;
  loadRatio: { min: number; max: number; assigned: number; total: number };
}

export interface SlottingClusterCell {
  locationId: string;
  position: [number, number, number];
  skuId: string;
  cluster: number;
  color: string;
}

const MAX_HEAT_POINTS = 1600;
const MAX_CLUSTER_POINTS = 4000;
const MAX_HOT_POINTS = 48;

export function buildSlottingScene(
  problem: WarehouseProblemView,
  envelope: WarehouseEnvelope | null,
): SlottingScene {
  const topology = problem.topology ?? {};
  const bounds = sceneBounds(topology);
  const counts = topologyCounts(topology);
  const index = buildLocationIndex(topology);
  const turnover = turnoverByLocation(problem);
  const classes = classByLocation(problem);

  // 引擎方案（有解时）：loadUnitId → locationId
  const occupant = new Map<string, { loadUnitId: string; skuId: string }>();
  // 落位来源：库位解在 `result.assignment`，联合解在 `result.slottingAssignment`——
  // 两者都是引擎（同一份库位求解器）给出的同一种行，画布只看一处，不做转换。
  const assignment = (envelope?.result as
    | {
        assignment?: Array<{ loadUnitId: string; skuId: string; locationId: string }>;
        slottingAssignment?: Array<{ loadUnitId: string; skuId: string; locationId: string }>;
      }
    | undefined)?.assignment
    ?? (envelope?.result as { slottingAssignment?: Array<{ loadUnitId: string; skuId: string; locationId: string }> } | undefined)
      ?.slottingAssignment;
  if (Array.isArray(assignment)) {
    for (const row of assignment) {
      occupant.set(row.locationId, { loadUnitId: row.loadUnitId, skuId: row.skuId });
    }
  }

  const values = [...turnover.values()].filter((value) => Number.isFinite(value));
  const normalize = normalizeValues(values);

  const heat: SlottingHeatCell[] = [];
  for (const [locationId, value] of turnover) {
    const position = index.get(locationId);
    if (!position) continue;
    heat.push({
      locationId,
      position,
      turnover: value,
      ratio: normalize(value),
      skuClass: classes.get(locationId) ?? '',
      assigned: occupant.has(locationId),
    });
    if (heat.length >= MAX_HEAT_POINTS) break;
  }
  heat.sort((a, b) => b.turnover - a.turnover);

  // 关联簇叠加：SKU → 簇号来自引擎（`result.clusters.bySku`），这里只做"落到库位坐标"的投影。
  const clusterMap = (envelope?.result as { clusters?: { count?: number; bySku?: Record<string, number>; note?: string } } | undefined)
    ?.clusters;
  const bySku: Record<string, number> = clusterMap?.bySku ?? {};
  const clusterCells: SlottingClusterCell[] = [];
  if (Array.isArray(assignment) && Object.keys(bySku).length > 0) {
    for (const row of assignment) {
      const cluster = bySku[row.skuId];
      if (typeof cluster !== 'number' || cluster < 0) continue;
      const position = index.get(row.locationId);
      if (!position) continue;
      clusterCells.push({
        locationId: row.locationId,
        position,
        skuId: row.skuId,
        cluster,
        color: clusterColor(cluster),
      });
      if (clusterCells.length >= MAX_CLUSTER_POINTS) break;
    }
  }

  const migrations: SlottingMigration[] = [];
  const rawMigrations = (envelope?.result as { migrations?: Array<{ loadUnitId: string; fromLocationId: string; toLocationId: string; reason?: string }> } | undefined)
    ?.migrations;
  if (Array.isArray(rawMigrations)) {
    for (const move of rawMigrations) {
      migrations.push({
        loadUnitId: move.loadUnitId,
        from: index.get(move.fromLocationId) ?? null,
        to: index.get(move.toLocationId) ?? null,
        reason: move.reason ?? '搬迁',
      });
    }
  }

  // 巷道热点：把问题数据里的周转量按巷道聚合（仅用于"热点在哪"的视觉引导）
  const aisles: AisleLoad[] = [];
  const aisleLoad = new Map<string, number>();
  for (const [locationId, value] of turnover) {
    const key = parseLocationId(locationId);
    if (!key) continue;
    const rack = (topology.racks ?? []).find((item) => item.id === key.rackId);
    if (!rack) continue;
    aisleLoad.set(rack.aisleId, (aisleLoad.get(rack.aisleId) ?? 0) + value);
  }
  for (const aisle of topology.aisles ?? []) {
    const nodes = aisle.endNodeIds
      .map((id) => (topology.nodes ?? []).find((node) => node.id === id))
      .filter((node): node is NonNullable<typeof node> => Boolean(node));
    if (nodes.length < 2) continue;
    const [a, b] = nodes;
    aisles.push({
      aisleId: aisle.id,
      load: aisleLoad.get(aisle.id) ?? 0,
      center: [(a.position[0] + b.position[0]) / 2, 0.05, (a.position[2] + b.position[2]) / 2],
      length: aisle.length_m ?? Math.hypot(b.position[0] - a.position[0], b.position[2] - a.position[2]),
    });
  }

  const stations = (topology.stations ?? []).map((station) => {
    const node = (topology.nodes ?? []).find((item) => item.id === station.nodeId);
    return {
      id: station.id,
      position: (node?.position ?? [0, 0, 0]) as [number, number, number],
      capacity: station.bufferCapacity ?? 1,
      direction: station.direction ?? 'inbound',
    };
  });

  const assignedCount = [...occupant.keys()].filter((id) => index.has(id)).length;

  return {
    bounds,
    counts,
    heat,
    clusterCells,
    clusterCount: typeof clusterMap?.count === 'number' ? clusterMap.count : 0,
    clusterNote: clusterMap?.note ?? '',
    rackSpecs: topology.racks ?? [],
    racks: (topology.racks ?? []).map((rack) => ({
      id: rack.id,
      origin: rack.origin,
      bays: rack.bays,
      depths: rack.depths,
      levels: (rack.levels ?? []).length,
      width: rack.locationSize?.width_m ?? 1.2,
      depth: rack.locationSize?.depth_m ?? 1.1,
      height: rack.locationSize?.height_m ?? 1.8,
      bayAxis: rack.bayAxis ?? [1, 0],
      depthAxis: rack.depthAxis ?? [0, -1],
      levelY: (rack.levels ?? []).map((level) => level.y_m),
    })),
    hot: heat.slice(0, MAX_HOT_POINTS),
    migrations,
    aisles,
    stations,
    occupant,
    loadRatio: {
      min: values.length ? Math.min(...values) : 0,
      max: values.length ? Math.max(...values) : 0,
      assigned: assignedCount,
      total: index.size,
    },
  };
}

/** 热力色（同一套色标，图例与 3D 共用）。 */
export function heatLegend(): Array<{ label: string; color: string }> {
  return [
    { label: '低', color: heatColor(0.05) },
    { label: '中低', color: heatColor(0.35) },
    { label: '中', color: heatColor(0.55) },
    { label: '高', color: heatColor(0.8) },
    { label: '极高', color: heatColor(0.98) },
  ];
}

/** 库位 id → 是否属于人工区（人工区的库位不在自动化方案的目标里）。 */
export function isManualLocation(problem: WarehouseProblemView, locationId: string): boolean {
  const key = parseLocationId(locationId);
  if (!key) return false;
  const rack = (problem.topology.racks ?? []).find((item) => item.id === key.rackId);
  if (!rack) return false;
  const area = (problem.topology.areas ?? []).find((item) => item.id === rack.areaId);
  return area?.kind === 'manual' || area?.kind === 'pick';
}
