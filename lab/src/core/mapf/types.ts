/**
 * MAPF 模块的前端契约类型（与 mapf/contracts/*.schema.json 对齐的**宽松**投影：
 * 视图只依赖这些字段；引擎输出的其余字段原样保留在 `raw` 文本里）。
 */

export interface MapfMockEntry {
  file: string;
  name: string;
  description?: string;
  expect?: string;
  kind?: string;
  sha256?: string;
  robots?: number;
  width?: number;
  height?: number;
}

export interface MapfManifest {
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
  mocks: MapfMockEntry[];
}

export interface MapfRobotSolution {
  id: string;
  start: [number, number];
  goal: [number, number];
  /** path[t] = 第 t 步结束时所在格；path[0] = start */
  path: Array<[number, number]>;
  arrival?: number | null;
  steps?: number;
  locked?: boolean;
}

export interface MapfIssue {
  code: string;
  severity?: string;
  path?: string;
  message: string;
}

export interface MapfSolution {
  schema_version?: string;
  id?: string;
  status: 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN' | 'INVALID_INPUT' | 'UNSUPPORTED' | 'CANCELLED' | string;
  optimality_proven?: boolean;
  verified?: boolean;
  horizon?: number | null;
  soc?: number | null;
  makespan?: number | null;
  time_model?: Record<string, unknown>;
  objective?: {
    kind?: string;
    value?: number | null;
    lower_bound?: number | null;
    suboptimality_factor?: number;
    direction?: string;
  } | null;
  errors?: MapfIssue[];
  robots: MapfRobotSolution[];
  metrics?: Record<string, number | boolean | null>;
  search?: Record<string, unknown> | null;
  dynamic?: Record<string, unknown> | null;
  verify?: Record<string, unknown> | null;
}

export interface MapfProblemLite {
  id?: string;
  map: { width: number; height: number; cells: string[]; start?: string; goal?: string };
  robots: Array<{ id: string; start: [number, number]; goal: [number, number] }>;
  time_model?: Record<string, unknown>;
  solver?: Record<string, unknown>;
}
