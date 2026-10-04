/**
 * 仓储几何投影（两个新模块共用）：把**契约里的拓扑**投影成 3D 场景几何。
 *
 * 纪律（与 lab/README §5 一致，也与 SRS §10 的红线一致）：
 *   * 几何全部来自问题文档的 `topology`（货架 origin / bays / depths / levels / locationSize、
 *     巷道端点节点坐标、站台节点、链路），不在前端推算任何算法量；
 *   * 颜色可以来自「问题数据 join 结果」（例如"某库位放了哪个 SKU 的货、周转率多少"），
 *     这是把已有数据摆到屏幕上，不是重新计算指标；
 *   * 任何**指标数字**都只能来自引擎信封（metrics / verification / result）。
 */

import type { WarehouseEnvelope, WarehouseStep, WarehouseTimeline } from '../../core/warehouse/types';

/* ------------------------------------------------------------------ 契约拓扑（只声明用到的字段） */

export interface TopologyNode {
  id: string;
  position: [number, number, number];
  kind?: string;
  level?: number;
  aisleId?: string | null;
  areaId?: string | null;
}

export interface TopologyLink {
  id: string;
  from: string;
  to: string;
  mode?: string;
  length_m?: number;
  capacity?: number;
}

export interface RackLevel {
  level: number;
  y_m: number;
  height_m?: number;
}

export interface RackSpec {
  id: string;
  aisleId: string;
  areaId?: string;
  kind?: string;
  origin: [number, number, number];
  bays: number;
  depths: number;
  bayAxis: [number, number];
  depthAxis: [number, number];
  levels: RackLevel[];
  locationSize: { width_m: number; depth_m: number; height_m: number };
}

export interface AisleSpec {
  id: string;
  level: number;
  length_m: number;
  axis: [number, number];
  endNodeIds: string[];
  rackIds: string[];
  areaId?: string;
}

export interface StationSpecLite {
  id: string;
  nodeId: string;
  name?: string;
  direction?: string;
  bufferCapacity?: number;
  servedBy?: string[];
}

export interface DeviceSpecLite {
  id: string;
  kind: string;
  homeNodeId?: string;
  motion?: Record<string, number>;
  capability?: { aisles?: string[]; levels?: number[]; areas?: string[]; capacity_kg?: number };
}

export interface TopologySpec {
  template?: string;
  name?: string;
  areas?: Array<{ id: string; name?: string; kind?: string; center?: [number, number]; size?: [number, number]; height_m?: number }>;
  aisles?: AisleSpec[];
  racks?: RackSpec[];
  nodes?: TopologyNode[];
  links?: TopologyLink[];
  devices?: DeviceSpecLite[];
  stations?: StationSpecLite[];
  buffers?: Array<{ id: string; nodeId: string; capacity?: number }>;
  frozenLocations?: string[];
  reservedLocations?: string[];
}

/** 问题文档（契约）在实验室里的最小视图。 */
export interface WarehouseProblemView {
  kind: string;
  scenarioId?: string;
  name?: string;
  scale?: string;
  goal?: string;
  expect?: string;
  seed?: number;
  topology: TopologySpec;
  /** slotting：库存与 SKU 主数据（用于把"哪个 SKU 在哪个库位"画出来）。 */
  skus?: Array<{ id: string; abcClass?: string; turnoverPerDay?: number; unitWeight_kg?: number; family?: string }>;
  inventory?: Array<{ id: string; skuId?: string; quantity?: number; locationId?: string | null }>;
  /** asrs：设备与作业。 */
  devices?: DeviceSpecLite[];
  tasks?: Array<{ id: string; kind: string; priority?: number; fromLocationId?: string | null; toLocationId?: string | null; skuId?: string | null; loadUnitId?: string | null; release_s?: number; deadline_s?: number | null }>;
  events?: Array<{ type: string; at_s?: number; until_s?: number | null; targetId?: string | null; note?: string }>;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ 库位命名解析 */

export interface LocationKey {
  rackId: string;
  bay: number;
  level: number;
  depth: number;
}

/**
 * 解析库位 id（引擎的命名：`{rack}-{bay}-{level}-{depth}`，例如 `A01F-3-13-2`）。
 *
 * 用途仅限"把结果里出现的库位摆到货架的哪个格"，几何仍取拓扑；
 * 解析失败返回 null（调用方跳过该点，不猜测）。
 */
export function parseLocationId(locationId: string): LocationKey | null {
  const match = /^(.+)-(\d+)-(\d+)-(\d+)$/.exec(locationId);
  if (!match) return null;
  return {
    rackId: match[1],
    bay: Number(match[2]),
    level: Number(match[3]),
    depth: Number(match[4]),
  };
}

/** 库位世界坐标（与拓扑的 origin/axis/locationSize 一致）。 */
export function locationWorld(rack: RackSpec, key: LocationKey): [number, number, number] {
  const [bx, bz] = rack.bayAxis ?? [1, 0];
  const [dx, dz] = rack.depthAxis ?? [0, -1];
  const width = rack.locationSize?.width_m ?? 1.2;
  const depth = rack.locationSize?.depth_m ?? 1.1;
  const level = rack.levels.find((l) => l.level === key.level);
  const y = (level?.y_m ?? 0) + (rack.locationSize?.height_m ?? 1.8) * 0.45;
  const x = rack.origin[0] + bx * (key.bay - 0.5) * width + dx * (key.depth - 0.5) * depth;
  const z = rack.origin[2] + bz * (key.bay - 0.5) * width + dz * (key.depth - 0.5) * depth;
  return [x, y, z];
}

/** 库位索引：locationId → 世界坐标。 */
export function buildLocationIndex(topology: TopologySpec): Map<string, [number, number, number]> {
  const index = new Map<string, [number, number, number]>();
  for (const rack of topology.racks ?? []) {
    for (let bay = 1; bay <= rack.bays; bay += 1) {
      for (const level of rack.levels ?? []) {
        for (let depth = 1; depth <= rack.depths; depth += 1) {
          const id = `${rack.id}-${bay}-${level.level}-${depth}`;
          index.set(id, locationWorld(rack, { rackId: rack.id, bay, level: level.level, depth }));
        }
      }
    }
  }
  return index;
}

/** 拓扑规模（用于面板上的"这个实例有多大"提示，来自契约本身）。 */
export function topologyCounts(topology: TopologySpec): { aisles: number; locations: number; devices: number; racks: number } {
  const locations = (topology.racks ?? []).reduce(
    (sum, rack) => sum + (rack.bays ?? 0) * (rack.levels?.length ?? 0) * (rack.depths ?? 0),
    0,
  );
  return {
    aisles: (topology.aisles ?? []).length,
    locations,
    devices: (topology.devices ?? []).length,
    racks: (topology.racks ?? []).length,
  };
}

/* ------------------------------------------------------------------ 场景包围盒与取景 */

export interface SceneBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  centerX: number;
  centerZ: number;
  span: number;
}

export function sceneBounds(topology: TopologySpec): SceneBounds {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  const push = (x: number, z: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  };
  for (const node of topology.nodes ?? []) push(node.position[0], node.position[2]);
  for (const rack of topology.racks ?? []) {
    const half = Math.max(rack.bays * rack.locationSize.width_m, rack.depths * rack.locationSize.depth_m);
    push(rack.origin[0] - half, rack.origin[2] - half);
    push(rack.origin[0] + half, rack.origin[2] + half);
  }
  for (const area of topology.areas ?? []) {
    if (area.center && area.size) {
      push(area.center[0] - area.size[0] / 2, area.center[1] - area.size[1] / 2);
      push(area.center[0] + area.size[0] / 2, area.center[1] + area.size[1] / 2);
    }
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, maxX: 10, minZ: 0, maxZ: 10, centerX: 5, centerZ: 5, span: 10 };
  }
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    span: Math.max(maxX - minX, maxZ - minZ, 8),
  };
}

/* ------------------------------------------------------------------ 热点着色 */

/** 库位 → 该位货物的周转率（来自问题数据的 join；没有数据时为 null）。 */
export function turnoverByLocation(problem: WarehouseProblemView): Map<string, number> {
  const turnover = new Map<string, number>();
  const skuTurnover = new Map<string, number>();
  for (const sku of problem.skus ?? []) {
    skuTurnover.set(sku.id, sku.turnoverPerDay ?? 0);
  }
  for (const unit of problem.inventory ?? []) {
    if (!unit.locationId) continue;
    const value = skuTurnover.get(unit.skuId ?? '') ?? 0;
    turnover.set(unit.locationId, value);
  }
  return turnover;
}

/** 库位 → SKU 类别（ABC）。 */
export function classByLocation(problem: WarehouseProblemView): Map<string, string> {
  const classes = new Map<string, string>();
  const skuClass = new Map<string, string>();
  for (const sku of problem.skus ?? []) skuClass.set(sku.id, sku.abcClass ?? '');
  for (const unit of problem.inventory ?? []) {
    if (!unit.locationId) continue;
    classes.set(unit.locationId, skuClass.get(unit.skuId ?? '') ?? '');
  }
  return classes;
}

/** 热力色（冷 → 热）：冰蓝 → 青 → 青绿 → 琥珀 → 珊瑚，与美术语言一致。 */
export function heatColor(ratio: number): string {
  const palette = ['#244a6b', '#2b7fa8', '#3fe0d4', '#4fe3a7', '#ffb454', '#ff6f6f'];
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const index = Math.min(palette.length - 1, Math.floor(clamped * palette.length));
  return palette[index];
}

/**
 * 关联簇配色：同簇同色、跨簇色相分散（黄金角步进，簇数变化时同一簇的颜色保持稳定）。
 *
 * 用途是"看出哪些货被算法归到一组"，因此刻意与热力色标错开（更饱和、偏紫青），
 * 避免和周转率热力混淆。簇号 -1（未成簇）由调用方过滤，不落到这里。
 */
export function clusterColor(cluster: number): string {
  const index = Math.max(0, Math.floor(cluster));
  const hue = (index * 137.508) % 360;
  const lightness = 58 + ((index % 3) - 1) * 6;
  return `hsl(${hue.toFixed(1)}, 68%, ${lightness}%)`;
}

/** 归一化：把一组值映射到 [0,1]（全相等时统一 0.5，避免除零）。 */
export function normalizeValues(values: number[]): (value: number) => number {
  if (values.length === 0) return () => 0.5;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max) || Math.abs(max - min) < 1e-9) return () => 0.5;
  return (value: number) => (value - min) / (max - min);
}

/* ------------------------------------------------------------------ 时间线投影 */

export interface DeviceTrack {
  deviceId: string;
  steps: WarehouseStep[];
  /** 该设备在时间线上的忙时（秒），来自时间线本身。 */
  busySeconds: number;
  firstStart: number;
  lastEnd: number;
}

/** 时间线 → 每台设备的轨迹（按设备聚合，去掉没有步骤的设备）。 */
export function deviceTracks(timeline: WarehouseTimeline | null | undefined): DeviceTrack[] {
  const tracks: DeviceTrack[] = [];
  for (const entry of timeline?.devices ?? []) {
    const steps = (entry.steps ?? []).slice().sort((a, b) => a.start_s - b.start_s);
    if (steps.length === 0) continue;
    let busy = 0;
    for (const step of steps) busy += Math.max(0, step.end_s - step.start_s);
    tracks.push({
      deviceId: entry.deviceId,
      steps,
      busySeconds: busy,
      firstStart: steps[0].start_s,
      lastEnd: steps[steps.length - 1].end_s,
    });
  }
  return tracks;
}

/** 取某设备在 `t` 秒时的姿态（步内线性插值；t 落在空档时停在上一段末端）。 */
export function poseAt(track: DeviceTrack, t: number): { x: number; y: number; z: number; stepIndex: number; phase: string } | null {
  if (track.steps.length === 0) return null;
  const steps = track.steps;
  if (t <= steps[0].start_s) {
    const step = steps[0];
    return { x: step.from.x, y: step.from.y, z: step.from.z, stepIndex: 0, phase: step.kind };
  }
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (t <= step.end_s) {
      const duration = Math.max(1e-6, step.end_s - step.start_s);
      const frac = Math.max(0, Math.min(1, (t - step.start_s) / duration));
      return {
        x: step.from.x + (step.to.x - step.from.x) * frac,
        y: step.from.y + (step.to.y - step.from.y) * frac,
        z: step.from.z + (step.to.z - step.from.z) * frac,
        stepIndex: i,
        phase: step.kind,
      };
    }
  }
  const last = steps[steps.length - 1];
  return { x: last.to.x, y: last.to.y, z: last.to.z, stepIndex: steps.length - 1, phase: last.kind };
}

/** 步骤类型 → 颜色（与 SB 相位色一致：取=冰蓝、放=琥珀、移动=青、提升=紫）。 */
export function stepColor(kind: string, loaded?: boolean): string {
  switch (kind) {
    case 'load':
      return loaded === false ? '#3fe0d4' : '#7fd7ff';
    case 'unload':
      return '#ffb454';
    case 'lift':
      return '#a78bfa';
    case 'handover':
      return '#4fe3a7';
    case 'travel':
      return '#7fd7ff';
    case 'wait':
      return '#5d6d84';
    default:
      return '#8fb8d8';
  }
}

/** 时间线长度（秒）：优先用引擎给的 horizon_s，否则取所有步骤的最大结束时间。 */
export function timelineHorizon(envelope: WarehouseEnvelope | null): number {
  if (!envelope) return 0;
  const declared = envelope.timeline?.horizon_s;
  if (typeof declared === 'number' && Number.isFinite(declared) && declared > 0) return declared;
  let max = 0;
  for (const device of envelope.timeline?.devices ?? []) {
    for (const step of device.steps ?? []) {
      if (Number.isFinite(step.end_s)) max = Math.max(max, step.end_s);
    }
  }
  return max;
}
