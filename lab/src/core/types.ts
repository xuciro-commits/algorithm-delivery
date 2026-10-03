/**
 * 实验室的公共类型：算法模块注册表 + APS 运行记录。
 *
 * 设计原则（对应需求“各算法保留独立的问题结构、计算引擎和可视化方式”）：
 * 注册表只约定**元数据与挂载点**，不约定任何统一的数学模型；
 * 每个模块自带问题输入、参数、结果视图与可视化组件。
 */

import type { ComponentType } from 'react';

export type ModuleStatus = 'ready' | 'planned';

export interface AlgorithmModuleMeta {
  /** 稳定 id（URL 片段、持久化键、CI 断言都用它） */
  id: string;
  name: string;
  /** 一句话说明这个算法解决什么问题 */
  tagline: string;
  /** 归类，用于实验室首页分组（排程 / 路径规划 / 仓储 …） */
  category: string;
  status: ModuleStatus;
  /** 该模块的问题输入格式（无则为自定义格式） */
  problemKind?: string;
  /** 计算引擎（浏览器端跑什么） */
  engine?: string;
  /** planned 模块的说明：后续计划接入什么 */
  plannedNote?: string;
}

export interface AlgorithmModule extends AlgorithmModuleMeta {
  /**
   * ready 模块的主界面；planned 模块可以没有。
   *
   * 各算法模块的 props 形态**互不相同**（这正是“各算法保留独立实现”的体现）：
   * 外壳只按模块 id 注入对应的运行时上下文，因此这里用宽松类型，
   * 由各模块在自己的 index.ts 里声明具体 props（见 `ApsPanelProps`）。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Panel?: ComponentType<any>;
}

/** 求解结果里由引擎写入的 `metrics` 块（契约字段）。 */
export interface SolutionMetricsRaw {
  compile_ms?: number | null;
  first_feasible_ms?: number | null;
  solve_ms?: number | null;
  verify_ms?: number | null;
  peak_memory_bytes?: number | null;
  total_ms?: number | null;
  time_metrics_available?: boolean;
}

export interface PlanSolutionLike {
  schema_version?: string;
  id?: string;
  tenant_id?: string;
  snapshot_id?: string;
  problem_hash?: string;
  engine?: string;
  engine_version?: string;
  status?: string;
  optimality_proven?: boolean;
  verified?: boolean;
  violations?: RawViolation[];
  options?: Record<string, unknown>;
  objective?: Record<string, unknown> | null;
  metrics?: SolutionMetricsRaw;
  search?: Record<string, unknown> | null;
  operations?: RawOperation[];
}

export interface RawOperation {
  order_id: string;
  operation_id: string;
  machine_id: string;
  worker_id: string;
  tool_ids?: string[];
  start_at: string;
  end_at: string;
}

export interface RawViolation {
  code: string;
  severity: string;
  constraint?: string;
  message: string;
  operation_id?: string;
  resource_id?: string;
  at?: string;
}

export interface PlanProblemLike {
  meta?: {
    schema_version?: string;
    tenant_id?: string;
    site_id?: string;
    snapshot_id?: string;
    timezone?: string;
    horizon_start?: string;
    horizon_end?: string;
    resolution_min?: number;
  };
  machines?: Array<{ id: string; capabilities?: string[]; available?: unknown[] }>;
  workers?: Array<{ id: string; skills?: string[]; qualifications?: string[] }>;
  tools?: Array<{ id: string; capacity?: number }>;
  materials?: Array<{ id: string; initial_quantity?: number }>;
  orders?: Array<{
    id: string;
    priority?: number;
    release_at?: string;
    due_at?: string;
    quantity?: number;
    operations?: Array<{
      id: string;
      skill?: string;
      alternatives?: Array<{ machine_id: string; duration_min: number }>;
      predecessors?: string[];
      qualifications?: string[];
      tool_ids?: string[];
      tools?: string[];
      materials?: Record<string, number>;
    }>;
  }>;
  objective?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface VerifyReport {
  schema_version?: string;
  mode?: string;
  parsed?: boolean;
  ok?: boolean;
  counts?: { violations?: number; errors?: number; warnings?: number; issues?: number };
  violations?: Array<{
    code: string;
    severity: string;
    constraint?: string;
    message: string;
    operation_id?: string;
    resource_id?: string;
    at?: string;
    expected?: string;
    actual?: string;
  }>;
  issues?: Array<{ code: string; severity: string; path: string; message: string }>;
}

export interface FingerprintReport {
  schema_version?: string;
  fingerprint?: string;
  status?: string;
  excludes?: string[];
}

export interface CapabilitiesReport {
  engine?: string;
  version?: string;
  constraints?: string[];
  max_operations?: number;
  can_prove_optimal?: boolean;
  can_prove_infeasible?: boolean;
  supports_cancel?: boolean;
}

/** 引擎清单：构建时由 `scripts/sync-engine.mjs` 生成，页面显示“当前使用的引擎版本”。 */
export interface EngineManifest {
  schema_version: string;
  engine: string;
  version: string;
  /** 实验室运行的档位（浏览器固定 wasm-light） */
  profile: string;
  wasm: { file: string; bytes: number; sha256: string };
  worker: { file: string; sha256: string };
  /** `source` = 从本仓库源码构建；`release:<tag>` = 取自某个正式 Release */
  source: string;
  gitCommit?: string;
  gitTag?: string;
  builtAt: string;
  mocks?: MockCatalogEntry[];
  /** 契约声明的能力（与运行时 aps_capabilities() 交叉校验） */
  capabilities?: CapabilitiesReport;
}

export interface MockCatalogEntry {
  file: string;
  name: string;
  description: string;
  kind: 'baseline' | 'scenario' | 'benchmark';
  operations: number;
  orders: number;
  machines: number;
  /** 期望的求解结局，用于实验室给出“本例看点”提示 */
  expect?: string;
  sha256?: string;
}
