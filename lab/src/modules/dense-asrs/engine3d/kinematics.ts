import { WarehouseStep, LocationStateEvent, BufferStateEvent, StepKind } from './types';
import { SlotOccupancy } from './geometry';

/* ============================================================
 * 3.2 设备姿态插值（poseAt）
 *  fraction = (t - start_s) / max(1e-6, end_s - start_s)
 *  P(t) = Pfrom + (Pto - Pfrom)·fraction
 *  heading = atan2(dx, dz)（位移 > 0.01 时更新，否则保持上一朝向）
 * 严禁瞬移、严禁脱离 timeline 的自主动画。
 * ============================================================ */
export interface Pose {
  x: number; y: number; z: number;
  heading: number;
  loaded: boolean;
  kind: StepKind | 'idle';
  axis: 'x' | 'z' | null;      // 本步行走轴（四向车换向判定用）
  progress: number;
  stepId: string | null;
  taskId: string | null;
  skuId?: string;
  loadUnitId?: string;
  active: boolean;             // t 是否落在该设备的作业区间内
}

const AXIS_EPS = 0.01;

function stepAxis(s: WarehouseStep): 'x' | 'z' | null {
  const dx = Math.abs(s.to.x - s.from.x);
  const dz = Math.abs(s.to.z - s.from.z);
  if (Math.max(dx, dz) <= AXIS_EPS) return null;
  return dx >= dz ? 'x' : 'z';
}

/** 二分查找命中 start_s <= t <= end_s 的步骤 */
function findStep(steps: WarehouseStep[], t: number): number {
  let lo = 0, hi = steps.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = steps[mid];
    if (t < s.start_s) hi = mid - 1;
    else if (t > s.end_s) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export function poseAt(steps: WarehouseStep[], t: number, prevHeading = 0): Pose {
  if (!steps.length) {
    return { x: 0, y: 0, z: 0, heading: prevHeading, loaded: false, kind: 'idle', axis: null, progress: 0, stepId: null, taskId: null, active: false };
  }

  const first = steps[0];
  const last = steps[steps.length - 1];

  if (t < first.start_s) {
    return { ...first.from, heading: prevHeading, loaded: false, kind: 'idle', axis: null, progress: 0, stepId: null, taskId: null, active: false };
  }
  if (t > last.end_s) {
    return { ...last.to, heading: prevHeading, loaded: last.loaded, kind: 'idle', axis: null, progress: 1, stepId: last.id, taskId: last.taskId ?? null, skuId: last.skuId, loadUnitId: last.loadUnitId, active: false };
  }

  let idx = findStep(steps, t);
  if (idx < 0) {
    // 落在两步之间的空隙：保持上一步终点姿态
    let prev = first;
    for (const s of steps) if (s.end_s <= t) prev = s;
    return { ...prev.to, heading: prevHeading, loaded: prev.loaded, kind: 'wait', axis: null, progress: 1, stepId: prev.id, taskId: prev.taskId ?? null, skuId: prev.skuId, loadUnitId: prev.loadUnitId, active: true };
  }

  const s = steps[idx];
  const fraction = Math.min(1, Math.max(0, (t - s.start_s) / Math.max(1e-6, s.end_s - s.start_s)));
  const x = s.from.x + (s.to.x - s.from.x) * fraction;
  const y = s.from.y + (s.to.y - s.from.y) * fraction;
  const z = s.from.z + (s.to.z - s.from.z) * fraction;

  const dx = s.to.x - s.from.x;
  const dz = s.to.z - s.from.z;
  const heading = Math.hypot(dx, dz) > AXIS_EPS ? Math.atan2(dx, dz) : prevHeading;

  return {
    x, y, z, heading,
    loaded: s.loaded,
    kind: s.kind,
    axis: stepAxis(s),
    progress: fraction,
    stepId: s.id,
    taskId: s.taskId ?? null,
    skuId: s.skuId,
    loadUnitId: s.loadUnitId,
    active: true,
  };
}

/** 四向车换向：在 wait 步内，从上一行走轴平滑过渡到下一行走轴 */
export function wheelAxisAt(steps: WarehouseStep[], t: number): { axis: 'x' | 'z'; blend: number } {
  let prevAxis: 'x' | 'z' = 'x';
  let nextAxis: 'x' | 'z' | null = null;
  let gapStart = 0, gapEnd = 0;
  let inGap = true;

  for (const s of steps) {
    const a = stepAxis(s);
    if (a) {
      if (s.start_s <= t && t <= s.end_s) return { axis: a, blend: 1 };
      if (s.end_s < t) { prevAxis = a; gapStart = s.end_s; inGap = true; }
      else if (inGap && nextAxis === null) { nextAxis = a; gapEnd = s.start_s; break; }
    }
  }
  if (!nextAxis || nextAxis === prevAxis) return { axis: prevAxis, blend: 1 };
  const span = Math.max(1e-6, gapEnd - gapStart);
  const k = Math.min(1, Math.max(0, (t - gapStart) / span));
  return { axis: k < 0.5 ? prevAxis : nextAxis, blend: Math.abs(k - 0.5) * 2 };
}

/* ============================================================
 * 3.3 倒垛联动：按物理时钟解算货位占用（支持任意方向拖拽）
 * ============================================================ */
export interface OccupancyDiff {
  changed: Array<{ locationId: string; occ: SlotOccupancy | null }>;
  appliedCount: number;
}

export function occupancyAt(
  base: Map<string, SlotOccupancy>,
  events: LocationStateEvent[],
  t: number,
  prev: Map<string, SlotOccupancy>,
): OccupancyDiff {
  const next = new Map(base);
  let applied = 0;
  for (const e of events) {
    if (e.at_s > t) continue;
    applied++;
    if (e.loadUnitId === null) next.delete(e.locationId);
    else next.set(e.locationId, { loadUnitId: e.loadUnitId, skuId: e.skuId ?? 'SKU-UNKNOWN' });
  }

  const changed: OccupancyDiff['changed'] = [];
  for (const [k, v] of next) {
    const p = prev.get(k);
    if (!p || p.loadUnitId !== v.loadUnitId) changed.push({ locationId: k, occ: v });
  }
  for (const k of prev.keys()) if (!next.has(k)) changed.push({ locationId: k, occ: null });

  prev.clear();
  for (const [k, v] of next) prev.set(k, v);
  return { changed, appliedCount: applied };
}

/** 站台缓冲水位（取 at_s <= t 的最后一条） */
export function bufferAt(events: BufferStateEvent[] | undefined, bufferId: string, t: number): number | null {
  if (!events) return null;
  let v: number | null = null;
  for (const e of events) if (e.bufferId === bufferId && e.at_s <= t) v = e.occupancy;
  return v;
}

/** 倒垛弧线窗口：源事件(取走) → 目标事件(落位) */
export interface RelocationArc {
  fromLocationId: string;
  toLocationId: string;
  start_s: number;
  end_s: number;
  taskId?: string;
  reason: string;
}

export function extractRelocationArcs(events: LocationStateEvent[] = []): RelocationArc[] {
  const arcs: RelocationArc[] = [];
  const picks = events.filter((e) => e.loadUnitId === null && !!e.relatedLocationId);
  for (const p of picks) {
    const drop = events.find(
      (e) => e.locationId === p.relatedLocationId && e.loadUnitId !== null && e.at_s >= p.at_s,
    );
    arcs.push({
      fromLocationId: p.locationId,
      toLocationId: p.relatedLocationId!,
      start_s: p.at_s,
      end_s: drop ? drop.at_s : p.at_s + 8,
      taskId: p.taskId,
      reason: p.reason,
    });
  }
  return arcs;
}

export const countRelocationsAt = (arcs: RelocationArc[], t: number) => arcs.filter((a) => a.end_s <= t).length;
