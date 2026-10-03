/**
 * AGV 模块的前端契约类型（与 agv/contracts/*.schema.json 对齐的宽松投影）。
 */

export interface AgvMockEntry {
  file: string;
  id?: string;
  name: string;
  description?: string;
  dynamic?: boolean;
  vehicles?: number;
  tasks?: number;
  width?: number;
  height?: number;
  sha256?: string;
}

export interface AgvManifest {
  schema_version: string;
  module: string;
  engine: string;
  version: string;
  profile: string;
  wasm: { file: string; bytes: number; sha256: string };
  worker: { file: string; sha256: string };
  source: string;
  builtAt: string;
  capabilities?: Record<string, unknown>;
  mocks: AgvMockEntry[];
}

/** 任务位置：显式格或工作站引用。 */
export type AgvTaskLoc = [number, number] | { station: string };

export interface AgvProblemLite {
  id?: string;
  map: { cells: string[] };
  time_model?: { timestep?: string; horizon?: number | 'auto' };
  vehicles: Array<{ id: string; start: [number, number]; capabilities?: string[]; paused?: boolean }>;
  tasks: Array<{
    id: string;
    pickup: AgvTaskLoc;
    dropoff: AgvTaskLoc;
    pickup_service?: number;
    dropoff_service?: number;
    release_step?: number;
    due_step?: number;
    priority?: number;
    required_capability?: string;
  }>;
  stations?: Array<{ id: string; cells: Array<[number, number]>; capacity: number }>;
  parking?: Array<[number, number]>;
  weights?: Record<string, number>;
  solver?: Record<string, unknown>;
  dynamic?: unknown;
  [k: string]: unknown;
}

export interface AgvMission {
  task: string | null;
  phase: string;
  from: number;
  to: number;
  dock: [number, number] | null;
}

export interface AgvVehicleSolution {
  id: string;
  /** timeline[t] = 第 t 步所在格 [x,y]。 */
  timeline: Array<[number, number]>;
  missions: AgvMission[];
}

export interface AgvTaskSolution {
  id: string;
  status: string;
  vehicle: string | null;
  pickup_dock: [number, number] | null;
  dropoff_dock: [number, number] | null;
  pickup_arrival: number | null;
  pickup_done: number | null;
  dropoff_arrival: number | null;
  dropoff_done: number | null;
  flow_time: number | null;
  lateness: number | null;
  reason: string | null;
}

export interface AgvIssue {
  code: string;
  severity?: string;
  path?: string;
  message: string;
}

export interface AgvSolution {
  schema_version?: string;
  id?: string;
  problem_hash?: string | null;
  fingerprint?: string | null;
  status: string;
  verified?: boolean;
  capability_profile?: string;
  plan?: {
    start_step?: number;
    horizon?: number;
    vehicles: AgvVehicleSolution[];
    tasks: AgvTaskSolution[];
  };
  metrics?: Record<string, number | boolean | string | null>;
  search?: Record<string, unknown> | null;
  dynamic?: {
    snapshot_time?: number;
    replan_from?: number;
    events?: Record<string, number>;
    tasks_added?: string[];
    tasks_cancelled?: string[];
    priorities_changed?: Array<{ task: string; priority: number }>;
    vehicles_paused?: string[];
    vehicles_resumed?: string[];
    obstacles_added?: Array<{ cell: [number, number]; at: number; until: number | null }>;
    obstacles_removed?: Array<[number, number]>;
    carried_tasks?: string[];
    completed_at_snapshot?: string[];
    affected_vehicles?: string[];
    planned_moves_after_snapshot?: number;
    semantic_digest?: string;
  } | null;
  verify?: Record<string, unknown> | null;
  errors?: AgvIssue[];
  notes?: string[];
}

/** agv-verification/1.0 violation 项（引擎独立核验器产出）。 */
export interface AgvViolation {
  code: string;
  constraint?: string;
  severity?: string;
  message: string;
  vehicles?: string[];
  tasks?: string[];
  at_step?: number | null;
  cell?: [number, number] | null;
}
