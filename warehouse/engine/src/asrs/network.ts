/**
 * 立库运行网络：设备位置、巷道内运行、层间提升、**时空预约与冲突消解**（SRS §4.3 / §4.4）。
 *
 * 这一层只回答"物理上能不能这样动、要花多久"，不决定"该派谁做哪个任务"（那是 schedule.ts）。
 *
 * 三条物理红线（也是验证器会独立复核的内容）：
 *   1. **一台设备同一时刻只能在一个位置**，且步骤在时间轴上不能重叠；
 *   2. **单车道 / 单竖井互斥**：容量为 1 的通道同一时刻只允许一台设备占用；
 *      共享升降空间的提升机在同一竖井内不得互相穿越（用互斥 + 方向约束表达）；
 *   3. **不允许生成物理上不可能的移动**：跨层必须经由提升设备；穿梭车不得跨越层或巷道边界
 *      （四向穿梭车除外，它由 capability.aisles 表达可服务的巷道集合）。
 */

import type { DeviceSpec, MotionProfile, WarehouseTopology } from '../contract/types.ts';
import { round, travelTime } from '../contract/util.ts';

/** 设备在世界中的位置（库位用 locationId 表达，节点用 nodeId）。 */
export interface DevicePosition {
  x: number;
  y: number;
  z: number;
  level: number;
  /** 所在巷道（跨巷道设备在移动中可为 null）。 */
  aisleId: string | null;
  nodeId: string | null;
  locationId: string | null;
}

/** 一个时间区间内的资源占用（时空预约表的基本单元）。 */
export interface Reservation {
  resourceId: string;
  deviceId: string;
  from_s: number;
  to_s: number;
  /** 资源上的位置区间（用于单车道互斥判断）。 */
  fromPos: number;
  toPos: number;
  priority: number;
  taskId: string | null;
}

export interface ConflictResolution {
  resourceId: string;
  deviceId: string;
  /** 被推迟的设备与推迟时长。 */
  delayedBy_s: number;
  blockedByDeviceId: string | null;
  /** 是否触发了"循环等待"保护（死锁预防）。 */
  deadlockPrevented: boolean;
  at_s: number;
  note: string;
}

/** 巷道资源 id：单车道互斥的粒度（巷道 + 层）。 */
export function laneResource(aisleId: string, level: number): string {
  return `LANE:${aisleId}:L${level}`;
}

/** 竖井资源 id：提升机共享空间（不可互相穿越）。 */
export function shaftResource(device: DeviceSpec): string {
  return device.coupling?.exclusiveResources?.[0] ?? `SHAFT:${device.id}`;
}

/**
 * 时空预约表。
 *
 * 预约按资源聚合，插入时检查重叠；重叠则给出"推迟到何时"的建议。
 * 复杂度：每个资源的预约数与该资源上的设备数同阶（个位数到几十），因此线性扫描足够快。
 */
export class ReservationTable {
  private readonly byResource = new Map<string, Reservation[]>();
  readonly conflicts: ConflictResolution[] = [];
  private waitEdges = new Map<string, Set<string>>();
  deadlocksPrevented = 0;

  /** 查询在 [from, to] 时间内，资源上是否有其他设备的占用（同车道可会车的资源需另判）。 */
  overlap(
    resourceId: string,
    deviceId: string,
    from_s: number,
    to_s: number,
    opts: { fromPos: number; toPos: number; allowMeeting?: boolean } = { fromPos: 0, toPos: 0 },
  ): Reservation | null {
    const list = this.byResource.get(resourceId);
    if (!list || list.length === 0) return null;
    const lo = Math.min(opts.fromPos, opts.toPos);
    const hi = Math.max(opts.fromPos, opts.toPos);
    for (const entry of list) {
      if (entry.deviceId === deviceId) continue;
      if (entry.to_s <= from_s + 1e-9 || entry.from_s >= to_s - 1e-9) continue;
      if (opts.allowMeeting) continue; // 可会车资源（双车道 / 双向宽通道）不在此判定
      const elo = Math.min(entry.fromPos, entry.toPos);
      const ehi = Math.max(entry.fromPos, entry.toPos);
      if (ehi < lo - 1e-6 || elo > hi + 1e-6) continue; // 位置区间不重叠
      return entry;
    }
    return null;
  }

  /** 预约（不做重叠检查；调用方应先 overlap 或在无冲突时调用）。 */
  reserve(entry: Reservation): void {
    const list = this.byResource.get(entry.resourceId) ?? [];
    list.push(entry);
    list.sort((a, b) => a.from_s - b.from_s);
    this.byResource.set(entry.resourceId, list);
  }

  /** 释放某个设备在指定时间之后的预约（用于动态事件后的重排）。 */
  releaseAfter(deviceId: string, from_s: number): void {
    for (const [resourceId, list] of this.byResource) {
      const kept = list.filter((entry) => !(entry.deviceId === deviceId && entry.from_s >= from_s - 1e-9));
      this.byResource.set(resourceId, kept);
    }
  }

  /** 记录等待关系（用于循环等待检测）。 */
  addWait(fromDevice: string, onDevice: string): void {
    const set = this.waitEdges.get(fromDevice) ?? new Set<string>();
    set.add(onDevice);
    this.waitEdges.set(fromDevice, set);
  }

  clearWaits(): void {
    this.waitEdges.clear();
  }

  /**
   * 循环等待检测：如果加入 `from → on` 会形成环，则说明存在死锁风险，必须放弃这次等待
   * （改为让路 / 退避 / 由高优先级任务优先），**不允许**直接等待下去。
   */
  wouldDeadlock(fromDevice: string, onDevice: string): boolean {
    if (fromDevice === onDevice) return true;
    const stack = [onDevice];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === fromDevice) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of this.waitEdges.get(current) ?? []) stack.push(next);
    }
    return false;
  }

  /** 记录一次冲突消解（供指标与面板显示"等了多久、被谁挡的"）。 */
  recordConflict(resolution: ConflictResolution): void {
    this.conflicts.push(resolution);
    if (resolution.deadlockPrevented) this.deadlocksPrevented += 1;
  }

  /** 资源上的观测占用（用于拥堵证据）。 */
  loadWindow(resourceId: string, from_s: number, to_s: number): number {
    const list = this.byResource.get(resourceId) ?? [];
    let busy = 0;
    for (const entry of list) {
      const start = Math.max(entry.from_s, from_s);
      const end = Math.min(entry.to_s, to_s);
      if (end > start) busy += end - start;
    }
    return busy;
  }
}

/** 设备运行的时间与距离（水平 / 竖直分段）。 */
export interface TravelEstimate {
  seconds: number;
  distance_m: number;
  vertical_m: number;
  /** 是否使用了提升机（跨层）。 */
  usesLift: boolean;
}

/**
 * 计算一次移动：同一巷道同层 → 水平运行；跨层必须搭乘提升机（`liftMoves` 由调度给出）。
 * 设备不允许跨层自己跑（除非它是提升机）。
 */
export function estimateTravel(
  device: DeviceSpec,
  from: DevicePosition,
  to: { x: number; y: number; z: number; level: number; aisleId: string | null },
  opts: { loaded?: boolean; topological?: WarehouseTopology } = {},
): TravelEstimate {
  const motion: MotionProfile = device.motion;
  const loaded = opts.loaded ?? false;
  const isLift = device.kind === 'pallet-lift' || device.kind === 'aisle-lift';
  let seconds = 0;
  let distance = 0;
  let vertical = 0;

  if (isLift) {
    // 提升机：竖直为主，水平仅在站台允许的小范围横移
    vertical = Math.abs(to.y - from.y);
    const horizontal = Math.hypot(to.x - from.x, to.z - from.z);
    seconds += travelTime(vertical, motion.speed_mps, motion.accel_mps2);
    distance += vertical;
    if (horizontal > 0.05) {
      seconds += travelTime(horizontal, motion.speed_mps * 0.6, motion.accel_mps2);
      distance += horizontal;
    }
    return { seconds: round(seconds, 4), distance_m: round(distance, 4), vertical_m: round(vertical, 4), usesLift: true };
  }

  const horizontal = Math.hypot(to.x - from.x, to.z - from.z);
  const factor = loaded ? (motion.loaded_speed_factor ?? 1) : 1;
  seconds += travelTime(horizontal, motion.speed_mps * factor, motion.accel_mps2);
  distance += horizontal;
  if (Math.abs(to.level - from.level) > 0.01) {
    // 非提升机设备跨层：必须走巷道提升机，时间由调用方通过 transfer 步骤补足；
    // 这里给一个显式的竖直惩罚，避免调度器"忘记"换层代价。
    seconds += Math.abs(to.level - from.level) * (motion.change_level_s ?? 12);
  }
  return {
    seconds: round(seconds, 4),
    distance_m: round(distance, 4),
    vertical_m: 0,
    usesLift: !isLift && Math.abs(to.level - from.level) > 0.01,
  };
}

/** 该设备能否在某层作业（层固定型穿梭车不能自己换层）。 */
export function deviceServesLevel(device: DeviceSpec, level: number): boolean {
  const levels = device.capability.levels;
  if (!levels || levels.length === 0) return true;
  return levels.includes(level);
}

/** 设备能否自己跨层（只有提升机可以；其余需搭乘）。 */
export function deviceCanChangeLevel(device: DeviceSpec): boolean {
  return device.kind === 'pallet-lift' || device.kind === 'aisle-lift';
}

/** 设备是否服务于该巷道。 */
export function deviceServesAisle(device: DeviceSpec, aisleId: string): boolean {
  const aisles = device.capability.aisles;
  if (!aisles || aisles.length === 0) return true;
  return aisles.includes(aisleId);
}
