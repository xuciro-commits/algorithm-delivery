/**
 * 密集立库模块的场景投影：把「调度问题（拓扑 + 设备 + 任务 + 事件）」
 * 与「引擎结果（时间线 + 指标）」拼成 3D 需要的图层。
 *
 * 分工（与库位模块一致）：
 *   * 几何 = 契约拓扑（货架/巷道/节点/站台）与时间线里的真实坐标；
 *   * 设备姿态 = 时间线步骤的起止点线性插值（`poseAt`），不猜测停机和路径外的动作；
 *   * 面板上的每个数字 = 引擎 metrics / verification；
 *   * 画布上的"巷道负载/站台压力"是**引擎数据（任务、时间线、缓冲状态）的现场聚合并明确标注**，
 *     不与引擎指标混用同一套说法。
 */

import type { WarehouseEnvelope, WarehouseStep } from '../../core/warehouse/types';
import type { RackSpec, TopologySpec, WarehouseProblemView } from '../warehouse-shared/geometry';
import { buildLocationIndex, deviceTracks, sceneBounds, topologyCounts, type DeviceTrack, type SceneBounds } from '../warehouse-shared/geometry';

export interface AsrsTaskMarker {
  taskId: string;
  kind: string;
  priority: number;
  status: string;
  from: [number, number, number] | null;
  to: [number, number, number] | null;
  release_s: number;
  deadline_s: number | null;
  deviceIds: string[];
}

export interface AsrsAisleView {
  aisleId: string;
  center: [number, number, number];
  length: number;
  /** 引擎时间线里经过该巷道的任务数（现场聚合，用于定位热点）。 */
  taskCount: number;
  /** 该巷道是否有设备在时间线里工作。 */
  served: boolean;
}

export interface AsrsStationView {
  stationId: string;
  name: string;
  direction: 'inbound' | 'outbound' | string;
  position: [number, number, number];
  bufferCapacity: number;
  /** 引擎时间线里的缓冲占用峰值与时长（来自 bufferStates）。 */
  peakOccupancy: number;
  busySeconds: number;
}

export interface AsrsDeviceView {
  deviceId: string;
  kind: string;
  color: string;
  track: DeviceTrack | null;
  /** 引擎 deviceUtilization 里的忙时（没有该条目时为 null，不补 0）。 */
  busySeconds: number | null;
  utilization: number | null;
}

/**
 * 倒垛（深位让位）事件：密集库的核心代价来源。
 *
 * 数据来自引擎时间线的 `locationStates`——引擎对"目标深位被挡"的处置会在同一时刻写下两条状态迁移：
 * 挡住的那格被让空（reason 以「倒垛：」开头）、同列空闲格接收货物（reason 以「倒垛落位」开头）。
 * 这里按出现顺序配对，不重算倒垛、也不猜同列关系。
 */
export interface AsrsRelocationMove {
  /** 被让出的深位（原本挡在目标前面）。 */
  vacatedLocationId: string;
  vacatedPosition: [number, number, number] | null;
  /** 倒垛落位（引擎在时间线里记录的接收格；缺失时为 null，不补造）。 */
  placedLocationId: string | null;
  placedPosition: [number, number, number] | null;
  at_s: number;
}

export interface AsrsScene {
  bounds: SceneBounds;
  counts: { aisles: number; locations: number; devices: number; racks: number };
  rackSpecs: RackSpec[];
  topology: TopologySpec;
  aisles: AsrsAisleView[];
  stations: AsrsStationView[];
  devices: AsrsDeviceView[];
  tasks: AsrsTaskMarker[];
  closedAisles: string[];
  /** 引擎记录过的深位让位事件（倒垛），按时间升序（画布只保留最近的一批）。 */
  relocations: AsrsRelocationMove[];
  /** 引擎时间线里的倒垛事件总数（用于文案如实说明"画的是最近 N 次"）。 */
  relocationEvents: number;
  outages: Array<{ deviceId: string; from: number; to: number; note: string }>;
  horizon: number;
  /** 选中设备的逐步轨迹（世界坐标序列）。 */
  stepPaths: Map<string, Array<{ points: Array<[number, number, number]>; steps: WarehouseStep[] }>>;
}

/** 倒垛叠加的显示上限（密集库大规模实例的倒垛可能上千次，画布只画最近的一批并如实标注）。 */
const MAX_RELOCATION_MARKERS = 400;

const DEVICE_COLORS = ['#7fd7ff', '#3fe0d4', '#a78bfa', '#ffb454', '#4fe3a7', '#f78fb3', '#67c2ff', '#ffd479', '#8ef0c6', '#c9a2ff'];

/** 设备类型 → 视觉形态标签（画布上按形态区分，不是颜色图例）。 */
export const DEVICE_KIND_LABEL: Record<string, string> = {
  'pallet-lift': '货物提升机',
  'aisle-lift': '巷道提升机',
  'shuttle': '多层穿梭车',
  'transfer': '交接/转运输送',
  'conveyor': '输送线',
  'forklift': '叉车/AGV',
  'stacker': '堆垛机',
};

export function deviceKindLabel(kind: string): string {
  return DEVICE_KIND_LABEL[kind] ?? kind;
}

export function buildAsrsScene(problem: WarehouseProblemView, envelope: WarehouseEnvelope | null): AsrsScene {
  const topology = problem.topology ?? {};
  const bounds = sceneBounds(topology);
  const counts = topologyCounts(topology);
  const index = buildLocationIndex(topology);
  const tracks = new Map(deviceTracks(envelope?.timeline).map((track) => [track.deviceId, track]));

  const timeline = envelope?.timeline;
  const taskStates = new Map((timeline?.tasks ?? []).map((state) => [state.taskId, state]));

  // 任务标记：位置优先取时间线步骤端点（真实坐标），缺失时用库位索引回退。
  const tasks: AsrsTaskMarker[] = [];
  for (const task of problem.tasks ?? []) {
    const timelineTask = taskStates.get(task.id);
    // 引擎的任务轨迹里设备 id 数组叫 `devices`（见 `WarehouseTaskState` 注释）；
    // 同时容忍老写法 `deviceIds`，两者都没有时才退回库位索引。
    const deviceIds = timelineTask?.devices ?? timelineTask?.deviceIds ?? [];
    let from: [number, number, number] | null = null;
    let to: [number, number, number] | null = null;
    for (const deviceId of deviceIds) {
      const track = tracks.get(deviceId);
      if (!track) continue;
      for (const step of track.steps) {
        if (step.taskId !== task.id) continue;
        from = from ?? [step.from.x, step.from.y, step.from.z];
        to = [step.to.x, step.to.y, step.to.z];
      }
    }
    from = from ?? (task.fromLocationId ? index.get(task.fromLocationId) ?? null : null);
    to = to ?? (task.toLocationId ? index.get(task.toLocationId) ?? null : null);
    tasks.push({
      taskId: task.id,
      kind: task.kind,
      priority: task.priority ?? 0,
      status: timelineTask?.status ?? 'pending',
      from,
      to,
      release_s: timelineTask?.release_s ?? task.release_s ?? 0,
      deadline_s: timelineTask?.deadline_s != null ? Number(timelineTask.deadline_s) : (task.deadline_s ?? null),
      deviceIds,
    });
    if (tasks.length >= 1200) break;
  }

  // 巷道视图：任务触达次数（现场聚合，用于在画布上定位"忙在哪儿"）
  const aisleByLocation = new Map<string, string>();
  for (const rack of topology.racks ?? []) {
    for (let bay = 1; bay <= rack.bays; bay += 1) {
      for (const level of rack.levels ?? []) {
        for (let depth = 1; depth <= rack.depths; depth += 1) {
          aisleByLocation.set(`${rack.id}-${bay}-${level.level}-${depth}`, rack.aisleId);
        }
      }
    }
  }
  const aisleTaskCount = new Map<string, number>();
  for (const task of problem.tasks ?? []) {
    for (const locationId of [task.fromLocationId, task.toLocationId]) {
      if (!locationId) continue;
      const aisleId = aisleByLocation.get(locationId);
      if (aisleId) aisleTaskCount.set(aisleId, (aisleTaskCount.get(aisleId) ?? 0) + 1);
    }
  }

  const aisles: AsrsAisleView[] = [];
  for (const aisle of topology.aisles ?? []) {
    const nodes = aisle.endNodeIds
      .map((id) => (topology.nodes ?? []).find((node) => node.id === id))
      .filter((node): node is NonNullable<typeof node> => Boolean(node));
    if (nodes.length < 2) continue;
    const [a, b] = nodes;
    const served = [...tracks.keys()].some((deviceId) => deviceId.includes(`-${aisle.id}-`));
    aisles.push({
      aisleId: aisle.id,
      center: [(a.position[0] + b.position[0]) / 2, 0, (a.position[2] + b.position[2]) / 2],
      length: aisle.length_m ?? Math.hypot(b.position[0] - a.position[0], b.position[2] - a.position[2]),
      taskCount: aisleTaskCount.get(aisle.id) ?? 0,
      served,
    });
  }

  // 站台：缓冲占用来自时间线 bufferStates（引擎数据）
  const bufferStates = timeline?.bufferStates ?? [];
  const stations: AsrsStationView[] = (topology.stations ?? []).map((station) => {
    const node = (topology.nodes ?? []).find((item) => item.id === station.nodeId);
    let peak = 0;
    let busy = 0;
    for (let i = 0; i < bufferStates.length; i += 1) {
      const state = bufferStates[i];
      if (state.bufferId && station.id && !state.bufferId.includes(station.id)) continue;
      peak = Math.max(peak, state.occupancy);
      const next = bufferStates[i + 1];
      if (state.occupancy > 0 && next) busy += Math.max(0, next.at_s - state.at_s);
    }
    return {
      stationId: station.id,
      name: station.name ?? station.id,
      direction: station.direction ?? 'inbound',
      position: (node?.position ?? [0, 0, 0]) as [number, number, number],
      bufferCapacity: station.bufferCapacity ?? 1,
      peakOccupancy: peak,
      busySeconds: busy,
    };
  });

  // 倒垛：按时间线 `locationStates` 的成对记录配对（让空 → 落位）。
  // 只认引擎给出的 reason 前缀；没有配对上的"落位"也不编造来源格，只记 vacated 那一格。
  const relocations: AsrsRelocationMove[] = [];
  {
    let pending: AsrsRelocationMove | null = null;
    const ordered = [...(timeline?.locationStates ?? [])].sort((a, b) => a.at_s - b.at_s);
    for (const state of ordered) {
      const reason = state.reason ?? '';
      const position = index.get(state.locationId) ?? null;
      if (reason.startsWith('倒垛：')) {
        if (pending) relocations.push(pending);
        pending = {
          vacatedLocationId: state.locationId,
          vacatedPosition: position,
          placedLocationId: null,
          placedPosition: null,
          at_s: state.at_s,
        };
        continue;
      }
      if (reason.startsWith('倒垛落位') && pending) {
        pending.placedLocationId = state.locationId;
        pending.placedPosition = position;
        pending.at_s = Math.max(pending.at_s, state.at_s);
        relocations.push(pending);
        pending = null;
      }
    }
    if (pending) relocations.push(pending);
  }
  const shownRelocations = relocations.slice(-MAX_RELOCATION_MARKERS);

  // 设备：颜色 + 时间线轨迹 + 引擎利用率（未出现在 utilization 里的设备为 null）
  const utilization = new Map<string, { busySeconds: number; utilization: number }>();
  for (const entry of envelope?.metrics?.deviceUtilization ?? []) {
    utilization.set(entry.deviceId, { busySeconds: entry.busySeconds, utilization: entry.utilization });
  }
  const deviceSpecs = topology.devices ?? problem.devices ?? [];
  const devices: AsrsDeviceView[] = deviceSpecs.map((device, index_) => ({
    deviceId: device.id,
    kind: device.kind,
    color: DEVICE_COLORS[index_ % DEVICE_COLORS.length],
    track: tracks.get(device.id) ?? null,
    busySeconds: utilization.get(device.id)?.busySeconds ?? null,
    utilization: utilization.get(device.id)?.utilization ?? null,
  }));

  // 事件：封闭巷道与设备停机（用于画布上明确标注"为什么这里没动作"）
  const closedAisles: string[] = [];
  const outages: Array<{ deviceId: string; from: number; to: number; note: string }> = [];
  for (const event of problem.events ?? []) {
    const at = event.at_s ?? 0;
    const until = event.until_s ?? null;
    if (event.type === 'aisle-closure') {
      const target = event.targetId ?? '';
      if (target) closedAisles.push(target);
    }
    if (event.type === 'device-breakdown' || event.type === 'fault') {
      outages.push({
        deviceId: event.targetId ?? '—',
        from: at,
        to: until ?? at + 900,
        note: event.note ?? '设备故障',
      });
    }
  }

  const stepPaths = new Map<string, Array<{ points: Array<[number, number, number]>; steps: WarehouseStep[] }>>();
  for (const device of devices) {
    if (!device.track) continue;
    stepPaths.set(
      device.deviceId,
      device.track.steps.map((step) => ({
        points: [
          [step.from.x, step.from.y + 0.35, step.from.z],
          [step.to.x, step.to.y + 0.35, step.to.z],
        ],
        steps: [step],
      })),
    );
  }

  const horizon = Math.max(
    envelope?.timeline?.horizon_s ?? 0,
    ...devices.map((device) => device.track?.lastEnd ?? 0),
    ...tasks.map((task) => task.release_s),
    1,
  );

  return {
    bounds,
    counts,
    rackSpecs: topology.racks ?? [],
    topology,
    aisles,
    stations,
    devices,
    tasks,
    closedAisles,
    outages,
    relocations: shownRelocations,
    relocationEvents: relocations.length,
    horizon: Number.isFinite(horizon) ? horizon : 1,
    stepPaths,
  };
}

/** 任务状态语义（与引擎 `taskStates[].status` 一致：done / blocked / invalid / unserved / partial）。 */
export function taskStatusColor(status: string): string {
  switch (status) {
    case 'done':
      return '#4fe3a7';
    case 'partial':
      return '#7fd7ff';
    case 'blocked':
      return '#ffb454';
    case 'unserved':
      return '#ff6f6f';
    case 'invalid':
      return '#a78bfa';
    default:
      return '#5d6d84';
  }
}

export function taskStatusLabel(status: string): string {
  const map: Record<string, string> = {
    done: '已完成',
    partial: '部分完成',
    blocked: '受堵',
    unserved: '未服务',
    invalid: '不合法',
    pending: '待执行',
  };
  return map[status] ?? status;
}
