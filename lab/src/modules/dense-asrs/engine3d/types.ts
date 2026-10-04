/** ============================================================
 *  黑盒引擎接口契约（Interface & Protocol）
 *  本文件是前端与 Rust/WASM 求解核心之间唯一的类型边界。
 *  前端不得发明、不得修改引擎下发的任何指标数值。
 *  ============================================================ */

export type Vec3 = { x: number; y: number; z: number };
export type Vec2 = [number, number];
export type Triple = [number, number, number];

/* ---------- 1.2 求解状态码 ---------- */
export type WarehouseStatus =
  | 'OPTIMAL_PROVEN'
  | 'FEASIBLE'
  | 'NO_SOLUTION_FOUND'
  | 'INFEASIBLE_PROVEN'
  | 'INVALID_INPUT'
  | 'UNSUPPORTED';

/** 状态机语义：是否允许驱动 3D 动态回放 */
export const PLAYABLE: WarehouseStatus[] = ['OPTIMAL_PROVEN', 'FEASIBLE'];
export const isPlayable = (s?: WarehouseStatus) => !!s && PLAYABLE.includes(s);

/* ---------- 2.2 / 2.3 / 2.4 拓扑 ---------- */
export interface RackLevel {
  level: number;
  y_m: number;
  height_m?: number;
}

export interface RackSpec {
  id: string;
  aisleId: string;
  origin: Triple;
  bays: number;
  depths: number;
  bayAxis: Vec2;
  depthAxis: Vec2;
  levels: RackLevel[];
  locationSize: { width_m: number; depth_m: number; height_m: number };
}

export interface NodeSpec {
  id: string;
  kind?: string;
  position: Triple;
}

export interface AisleSpec {
  id: string;
  level: number;
  length_m: number;
  axis: Vec2;
  endNodeIds: string[];
  rackIds: string[];
  center?: Triple;
  isClosed?: boolean;
}

export interface StationSpec {
  id: string;
  name?: string;
  position: Triple;
  direction: 'inbound' | 'outbound';
  bufferCapacity: number;
  conveyor?: { length_m: number; axis: Vec2 };
}

export interface DeviceSpec {
  id: string;
  name: string;
  type: 'shuttle' | 'lift' | 'conveyor';
  level?: number;
  color?: string;
  basePosition?: Triple;
  dimensions?: { length_m?: number; width_m?: number; height_m?: number };
}

export interface TopologySpec {
  racks: RackSpec[];
  aisles: AisleSpec[];
  stations: StationSpec[];
  devices: DeviceSpec[];
  nodes?: NodeSpec[];
  closedAisles?: string[];
}

/* ---------- 问题视图附带的主数据 ---------- */
export interface SkuSpec {
  skuId: string;
  name: string;
  turnoverPerDay: number;
  color?: string;
}

export interface InventorySpec {
  mode: 'lane-back-filled' | 'none';
  seed: number;
  skuPool: string[];
  defaultFill: { emptyLaneRatio: number; fullLaneRatio: number };
  laneOverrides?: Array<{ rackId: string; bay: number; level: number; fillCount: number; skuId?: string }>;
  explicit?: Array<{ locationId: string; loadUnitId: string; skuId: string }>;
}

export interface ProblemEvent {
  at_s: number;
  kind: 'aisle_closed' | 'device_offline' | string;
  aisleId?: string;
  deviceId?: string;
  reason?: string;
}

export interface ProblemView {
  topology: TopologySpec;
  skus?: SkuSpec[];
  inventory?: InventorySpec;
  events?: ProblemEvent[];
}

/* ---------- 3.1 时间线 ---------- */
export type StepKind = 'travel' | 'lift' | 'load' | 'unload' | 'wait' | 'handover';

export interface WarehouseStep {
  id: string;
  deviceId: string;
  taskId?: string | null;
  kind: StepKind;
  loaded: boolean;
  start_s: number;
  end_s: number;
  from: Vec3;
  to: Vec3;
  loadUnitId?: string;
  skuId?: string;
}

export interface WarehouseTaskState {
  taskId: string;
  type: 'inbound' | 'outbound' | 'relocation';
  status: 'PENDING' | 'RUNNING' | 'COMPLETED';
  loadUnitId: string;
  locationId: string;
  toLocationId?: string;
  skuId?: string;
  assignedDeviceId?: string;
  start_s?: number;
  end_s?: number;
}

export interface LocationStateEvent {
  at_s: number;
  locationId: string;
  loadUnitId: string | null;
  reason: string;
  relatedLocationId?: string;
  skuId?: string;
  taskId?: string;
}

export interface BufferStateEvent {
  at_s: number;
  bufferId: string;
  occupancy: number;
}

export interface WarehouseTimeline {
  horizon_s: number;
  devices: Array<{ deviceId: string; steps: WarehouseStep[] }>;
  tasks: WarehouseTaskState[];
  locationStates?: LocationStateEvent[];
  bufferStates?: BufferStateEvent[];
}

/* ---------- 4 Slotting 结果 ---------- */
export interface WarehouseSlottingResult {
  assignment: Array<{ skuId: string; loadUnitId: string; locationId: string }>;
  migrations: Array<{ loadUnitId: string; fromLocationId: string; toLocationId: string; reason?: string }>;
  clusters?: { count: number; bySku: Record<string, number> };
}

export interface WarehouseAsrsResult {
  schedulingSummary?: string;
  completedTasksCount?: number;
  relocationBreakdown?: { total: number; locationsInvolved: string[] };
}

/* ---------- 1.1 统一信封 ---------- */
export interface WarehouseMetrics {
  makespan_s: number;
  relocationCount: number;
  totalTasks: number;
  turnoverPerHour?: number;
  energy_kwh?: number;
  waitTime_s?: number;
  travelSaving_pct?: number;
  inboundCompleted?: number;
  outboundCompleted?: number;
  deviceUtilization?: Record<string, number>;
}

export interface VerificationCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface WarehouseVerification {
  ok: boolean;
  errors?: string[];
  warnings?: string[];
  checks?: VerificationCheck[];
}

export interface WarehouseEnvelope {
  status: WarehouseStatus;
  statusMessage?: string;
  metrics: WarehouseMetrics;
  verification: WarehouseVerification;
  timeline?: WarehouseTimeline;
  result?: WarehouseAsrsResult | WarehouseSlottingResult;
  scene?: { closedAisles?: string[]; offlineDevices?: string[] };
}

/* ---------- 数据包（lab/public/mock/*.json） ---------- */
export interface DatasetMeta {
  id: string;
  name: string;
  domain: 'asrs' | 'slotting';
  extends?: string;
  note?: string;
}

export interface DatasetPackage {
  meta: DatasetMeta;
  problem: ProblemView;
  envelope: WarehouseEnvelope;
}

/** Worker 返回给 UI 的报文 */
export interface SolveResponse {
  status: WarehouseStatus;
  envelope: WarehouseEnvelope;
  problem: ProblemView;
  meta: DatasetMeta;
  source: 'fetch:mock' | 'bundled' | 'user-file';
  solveTime_ms: number;
}

export const isSlottingResult = (r?: WarehouseAsrsResult | WarehouseSlottingResult): r is WarehouseSlottingResult =>
  !!r && Array.isArray((r as WarehouseSlottingResult).assignment);
