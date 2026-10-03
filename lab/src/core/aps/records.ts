/**
 * 实验室内部的运行记录模型（UI 与测试共用）。
 * 只依赖 `../types` 里的契约形状，不依赖 React/DOM。
 */

import type {
  CapabilitiesReport,
  FingerprintReport,
  PlanProblemLike,
  PlanSolutionLike,
  VerifyReport,
} from '../types';
import type { SolveParams } from './params';

export interface GanttBar {
  opId: string;
  orderId: string;
  machineId: string;
  workerId: string;
  toolIds: string[];
  startMs: number;
  endMs: number;
  durationMs: number;
  startIso: string;
  endIso: string;
  skill: string;
}

export interface GanttRow {
  orderId: string;
  priority: number;
  releaseMs: number;
  dueMs: number;
  startMs: number;
  endMs: number;
  tardinessMin: number;
  bars: GanttBar[];
}

export interface GanttModel {
  rows: GanttRow[];
  minMs: number;
  maxMs: number;
  dataMinMs: number;
  dataMaxMs: number;
  skills: string[];
  operationCount: number;
}

export interface ResourceUsage {
  id: string;
  kind: 'machine' | 'worker';
  capabilities: string[];
  busyMin: number;
  availableMin: number;
  utilization: number;
  operations: number;
}

export interface ResourceTimeline {
  id: string;
  kind: 'machine' | 'worker';
  label: string;
  bars: GanttBar[];
  minMs: number;
  maxMs: number;
}

export interface RunMetrics {
  firstFeasibleMs: number | null;
  totalMs: number | null;
  compileMs: number | null;
  solveMs: number | null;
  verifyMs: number | null;
  peakMemoryBytes: number | null;
  wallMs: number;
}

export interface RunRecord {
  id: string;
  label: string;
  createdAt: number;
  params: SolveParams;
  problemName: string;
  problemHash: string | null;
  snapshotId: string | null;
  status: string;
  statusCode: number;
  /** 引擎返回的完整 PlanSolution（可能为 null：ABI 参数错误时） */
  solution: PlanSolutionLike | null;
  raw: string;
  fingerprint: string | null;
  fingerprintReport: FingerprintReport | null;
  verify: VerifyReport | null;
  metrics: RunMetrics;
  gantt: GanttModel;
  resources: ResourceUsage[];
  timelines: ResourceTimeline[];
  engineVersion: string | null;
  error?: string;
  cancelled?: boolean;
  /** 求解期间是否发生过 Worker 终止/重建（诊断用） */
  workerRestarted?: boolean;
}

export interface RunComparison {
  baseId: string;
  otherId: string;
  changedOperations: number;
  comparedOperations: number;
  changed: Array<{ opId: string; from: string; to: string; worker: string }>;
  sameFingerprint: boolean;
  deltas: {
    weightedTardiness: number | null;
    makespan: number | null;
    firstFeasibleMs: number | null;
    totalMs: number | null;
    peakMemoryBytes: number | null;
  };
}

export interface RunnerResult {
  record: RunRecord;
  capabilities: CapabilitiesReport | null;
  problemText: string;
  problem: PlanProblemLike;
}
