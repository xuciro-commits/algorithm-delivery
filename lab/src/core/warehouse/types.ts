/**
 * Warehouse 引擎（库位优化 / 密集立库调度 / 联合优化）的契约类型。
 *
 * 这些类型只描述**引擎实际输出的字段**（见 warehouse/rust/src/engine.rs 的信封组装、
 * docs/USAGE.md §3），不做任何再解释；面板不允许自己发明指标。
 */

/* ------------------------------------------------------------------ 信封 */

export type WarehouseStatus =
  | 'OPTIMAL_PROVEN'
  | 'FEASIBLE_WITH_BOUND'
  | 'FEASIBLE'
  | 'BUDGET_EXCEEDED'
  | 'NO_SOLUTION_FOUND'
  | 'INFEASIBLE_PROVEN'
  | 'CANCELLED'
  | 'INVALID_INPUT'
  | 'UNSUPPORTED'
  | 'INTERNAL_ERROR'
  | 'ABI_ERROR'
  | string;

export interface WarehouseIssue {
  code: string;
  path: string;
  message: string;
  severity?: 'info' | 'warning' | 'error';
}

export interface WarehouseViolation {
  code: string;
  class?: 'hard' | 'soft' | string;
  severity?: 'info' | 'warning' | 'error' | string;
  message: string;
  at_s?: number | null;
  deviceId?: string | null;
  taskId?: string | null;
  locationId?: string | null;
  subjects?: string[];
}

/**
 * 独立核验报告（契约 `warehouse-verification/1.0`）。
 *
 * 两种形状都在用，且都合法：
 *   * 求解时报告（`asrs::verification_json`）：`ok` + `violations` + `checked`（验证器复核计数）；
 *   * 契约/CLI 形状（`verify` 子命令）：再加 `kind` / `recomputed` / `independentMetrics` / `notes`；
 *   * 联合解：`kind = "joint"`，`recomputed` 与 `independentMetrics` 都按 `{slotting, asrs}` 两段给出
 *     （调度段的数字来自求解时那份报告，由引擎归一成同一形状）。
 *
 * 面板据此把"验证器自己重算的数字"与优化器报告的指标并列展示 —— 缺哪一段就显式缺，
 * 不补 0、不猜。
 */
export interface WarehouseVerification {
  ok: boolean;
  kind?: string;
  checked?: Record<string, unknown>;
  recomputed?: Record<string, unknown> | null;
  independentMetrics?: Record<string, unknown> | null;
  notes?: string[];
  violations?: WarehouseViolation[];
}

/** 三个域共用的指标块（字段随域不同，未出现的键表示该域不产出）。 */
export interface WarehouseMetrics {
  // 调度
  tasksTotal?: number;
  tasksDone?: number;
  tasksUnserved?: number;
  derivedTasksDone?: number;
  makespan_s?: number | null;
  throughputPerHour?: number;
  meanCycle_s?: number | null;
  meanWait_s?: number | null;
  lateTasks?: number;
  maxLateness_s?: number | null;
  travelMeters?: number | null;
  energyKwh?: number | null;
  relocationTasks?: number;
  blockedMoves?: number;
  conflicts?: number;
  deadlocksPrevented?: number;
  reservations?: number;
  dualCommandPairs?: number;
  deviceUtilization?: Array<{ deviceId: string; busySeconds: number; utilization: number }>;
  bufferPeak?: Array<{ bufferId: string; peak: number }>;
  stationPeak?: Array<{ stationId: string; peak: number }>;
  locationsOccupied?: number;
  conflictEvents?: string[];
  searchedSimulations?: number;
  computeMs?: number;
  // 库位
  objectives?: Array<{ id: string; value: number; direction?: string; weight?: number }>;
  stability?: number | null;
  stabilitySeeds?: number[];
  utilization?: number | null;
  affinity?: number | null;
  gini?: number | null;
  congestion?: number | null;
  liftPeakRatio?: number | null;
  relocationCount?: number;
  relocationCost?: number | null;
  // 规模
  scale?: {
    skus?: number;
    locations?: number;
    loadUnits?: number;
    orders?: number;
    tasks?: number;
    devices?: number;
    assignments?: number;
    events?: number;
    note?: string;
  };
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ 时间线 */

/**
 * 时间线步骤（引擎 `Timeline::steps[].to_json` 的逐字段对应）。
 *
 * 字段名以引擎输出为准（`distanceM`/`energyKwh`/`delayedBy_s`/`resourceId`）——
 * 契约是引擎说了算，前端不重命名、也不补造缺省的数值。
 */
export interface WarehouseStep {
  id: string;
  deviceId: string;
  taskId?: string | null;
  /** travel | lift | load | unload | wait | handover | fault | charge | idle */
  kind: string;
  loaded?: boolean;
  start_s: number;
  end_s: number;
  distanceM?: number;
  energyKwh?: number;
  note?: string;
  /** 主资源（用于互斥检查与着色）。 */
  resourceId?: string | null;
  from: WarehousePosition;
  to: WarehousePosition;
}

export interface WarehousePosition {
  x: number;
  y: number;
  z: number;
  level: number;
  aisleId?: string | null;
  nodeId?: string | null;
  locationId?: string | null;
}

/**
 * 任务轨迹（引擎 `TaskTrace::to_json`）。
 *
 * 注意两处与直觉不同的引擎口径：
 *   * 设备/步骤 id 的键名是 `devices` / `steps`（不是 `deviceIds` / `stepIds`）；
 *   * `deadline_s` 序列化成字符串（`Json::opt_str`），读取时要显式转数。
 */
export interface WarehouseTaskState {
  taskId: string;
  kind: string;
  status: string;
  priority?: number;
  devices?: string[];
  steps?: string[];
  /** @deprecated 引擎从不产出这两个键名，仅为读旧导出数据保留（新代码用 `devices`/`steps`）。 */
  deviceIds?: string[];
  stepIds?: string[];
  start_s?: number;
  end_s?: number;
  release_s?: number;
  deadline_s?: number | string | null;
  lateness_s?: number;
  wait_s?: number;
  dualCommand?: boolean;
  note?: string;
}

export interface WarehouseDeviceSteps {
  deviceId: string;
  steps: WarehouseStep[];
}

export interface WarehouseBufferState {
  at_s: number;
  bufferId: string;
  occupancy: number;
  /** 引擎的 buffer_states 给出的是 `capacity` + `reason`。 */
  capacity?: number;
  reason?: string;
}

export interface WarehouseLocationState {
  at_s: number;
  locationId: string;
  loadUnitId?: string | null;
  reason?: string;
}

export interface WarehouseTimeline {
  devices: WarehouseDeviceSteps[];
  tasks: WarehouseTaskState[];
  bufferStates?: WarehouseBufferState[];
  locationStates?: WarehouseLocationState[];
  horizon_s?: number;
}

/* ------------------------------------------------------------------ 结果 */

export interface WarehouseSlottingObjective {
  id: string;
  value: number;
  direction?: string;
  weight?: number;
  note?: string;
}

export interface WarehouseSlottingResult {
  kind: 'slotting' | string;
  algorithm?: string;
  seed?: number;
  optimalityProven?: boolean;
  assignment?: Array<{ loadUnitId: string; skuId: string; locationId: string; quantity?: number }>;
  unassigned?: Array<{ loadUnitId?: string; skuId?: string; reason?: string }>;
  migrations?: Array<{ loadUnitId: string; fromLocationId: string; toLocationId: string; reason?: string }>;
  objectives?: WarehouseSlottingObjective[];
  comparison?: WarehouseComparison;
  /** 库位侧给数组（topic/text/evidence），联合侧给对象（slotting/dispatch/reasons）。 */
  explanation?:
    | Array<{ topic?: string; text?: string; evidence?: Record<string, unknown> }>
    | { slotting?: string; dispatch?: string; reasons?: string[] };
  pareto?: Array<Record<string, unknown>>;
  /** 关联簇（引擎聚类结果，见 `WarehouseClusterMap`）。 */
  clusters?: WarehouseClusterMap | null;
  search?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WarehouseComparison {
  /** 库位侧：`currentLayout / randomLayout / optimized`。 */
  baselines?: Record<string, Record<string, number | null> | null>;
  /** 联合侧：同一调度口径下的三种落位（random / abc-class / 联合闭环）。 */
  rows?: Array<Record<string, unknown>>;
  improvementPercent?: Record<string, number | null>;
  notes?: string[];
}

export interface WarehouseAsrsResult {
  kind: 'asrs' | string;
  algorithm?: string;
  policy?: string;
  seed?: number;
  servicePlan?: {
    devices?: Array<{
      deviceId: string;
      steps: number;
      busySeconds: number;
      travelMeters: number;
      firstStart_s: number;
      lastEnd_s: number;
    }>;
    stepCount?: number;
    note?: string;
  };
  taskStates?: WarehouseTaskState[];
  conflicts?: string[];
  /** 三条必答问题的自然语言解释（引擎按本次真实指标生成；形状与联合结果一致）。 */
  explanation?: WarehouseExplanation | null;
  [key: string]: unknown;
}

/**
 * 关联簇归属（引擎按订单共出库权重聚类；`bySku[skuId] = cluster`，-1 = 未成簇）。
 * 三维的"关联簇叠加"与解释面板都读它——聚类口径只有一个来源，前端不做二次聚类。
 */
export interface WarehouseClusterMap {
  count?: number;
  bySku?: Record<string, number>;
  note?: string;
}

/** 三条必答问题的自然语言解释（库位 / 调度 / 联合三个域共用同一形状）。 */
export interface WarehouseExplanation {
  slotting?: string;
  dispatch?: string;
  reasons?: string[];
  note?: string;
}

export interface WarehouseJointResult {
  kind: 'joint' | string;
  algorithm?: string;
  seed?: number;
  slottingAssignment?: Array<{ loadUnitId: string; skuId: string; locationId: string; quantity?: number }>;
  rounds?: Array<{
    round: number;
    algorithm: string;
    slottingTravelSecondsPerDay: number;
    relocationCount: number;
    tasksDone: number;
    makespan_s: number;
    throughputPerHour: number;
    conflicts: number;
    meanWait_s: number;
    relocationTasks: number;
    jointObjective: number;
    verified: boolean;
  }>;
  comparison?: WarehouseComparison;
  pareto?: Array<{
    round?: number;
    chosen?: boolean;
    jointObjective?: number;
    weights?: Record<string, number>;
    metrics?: Record<string, number>;
  }>;
  paretoNote?: string;
  /** 最优轮的关联簇（与库位侧同一份口径）。 */
  clusters?: WarehouseClusterMap | null;
  explanation?: WarehouseExplanation;
  [key: string]: unknown;
}

export interface WarehouseEnvelope {
  engine: string;
  engineVersion: string;
  rulesetVersion: string;
  fingerprint: string;
  status: WarehouseStatus;
  runtimeMs: number;
  objective?: number | null;
  issues: WarehouseIssue[];
  metrics: WarehouseMetrics;
  result: WarehouseSlottingResult | WarehouseAsrsResult | WarehouseJointResult;
  comparison?: WarehouseComparison | null;
  timeline?: WarehouseTimeline | null;
  verification?: WarehouseVerification | null;
}

/* ------------------------------------------------------------------ 场景 / 能力 / 清单 */

export interface WarehouseScenario {
  id: string;
  family?: string;
  name: string;
  goal: string;
  topology?: string;
  catalog?: string;
  algorithm?: string;
  scale: string;
  expect: string;
  mustShow?: string[];
}

/** 场景清单（引擎 `wh_scenarios` 的顶层结构：按族分组）。 */
export interface WarehouseScenarioCatalog {
  count: number;
  scales?: Array<{ key: string; skus: number; aisles: number; levels: number; bays: number; depths: number; tasks: number; orders: number }>;
  families?: Array<{ family: string; label: string; scenarios: WarehouseScenario[] }>;
}

export interface WarehouseDomainCapability {
  id: 'slotting' | 'asrs' | 'joint' | string;
  label: string;
  problem?: string;
  algorithms?: Array<{
    id: string;
    kind?: string;
    label?: string;
    notes?: string;
    boundKind?: string;
    canProveOptimal?: boolean;
    canProveInfeasible?: boolean;
  }>;
  objectives?: string[];
  supports?: string[];
  notes?: string;
}

/** 引擎档位能力声明（`wh_capabilities`）。 */
export interface WarehouseCapabilities {
  engine: string;
  engineVersion: string;
  compilerVersion?: string;
  rulesetVersion: string;
  profile: 'native' | 'wasm-light' | string;
  domains: WarehouseDomainCapability[];
  limits?: Record<string, string>;
  statuses: Array<{ code: number; status: string; hasSolution: boolean }>;
  tiers: Array<{
    name: string;
    label?: string;
    maxSkus: number;
    maxLocations: number;
    maxLoadUnits: number;
    maxTasks: number;
    maxBudgetMs: number;
  }>;
  scenarios: { count: number; families: string[] };
  reproducibility?: Record<string, unknown>;
  verification?: Record<string, unknown>;
}

/** 把按族分组的场景清单摊平成列表（面板与测试都用这一处）。 */
export function flattenScenarios(catalog: WarehouseScenarioCatalog | null | undefined): WarehouseScenario[] {
  if (!catalog) return [];
  const rows: WarehouseScenario[] = [];
  for (const family of catalog.families ?? []) {
    for (const scenario of family.scenarios ?? []) {
      rows.push({ ...scenario, family: family.family });
    }
  }
  return rows;
}

export interface WarehouseManifestMock {
  file: string;
  id: string;
  name: string;
  kind: string;
  goal: string;
  expect: string;
  scale: string;
  description: string;
  sha256: string;
}

export interface WarehouseManifest {
  schema_version: string;
  module: string;
  engine: string;
  version: string;
  profile: string;
  wasm: { file: string; bytes: number; sha256: string };
  worker: { file: string; sha256: string };
  source: string;
  gitCommit?: string;
  gitTag?: string;
  builtAt: string;
  capabilities?: WarehouseCapabilities | null;
  selfCheck?: Record<string, unknown>;
  mocks?: WarehouseManifestMock[];
}

/** 三个域的公共判定：是否属于"有解"状态族（与引擎 errors.rs::Status::has_solution 一致）。 */
export const SOLUTION_STATUSES: WarehouseStatus[] = ['OPTIMAL_PROVEN', 'FEASIBLE_WITH_BOUND', 'FEASIBLE', 'CANCELLED'];

export function hasSolution(status: WarehouseStatus | undefined): boolean {
  return Boolean(status && SOLUTION_STATUSES.includes(status));
}

export function domainOf(kind: string | undefined): 'slotting' | 'asrs' | 'joint' {
  if (kind === 'asrs' || kind === 'dense-asrs') return 'asrs';
  if (kind === 'joint') return 'joint';
  return 'slotting';
}
