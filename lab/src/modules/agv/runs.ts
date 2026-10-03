/**
 * AGV 运行历史与多策略对比（V2 §5-2 / COMPONENT-DESIGN-V2 §5）。
 * 与 MAPF 的 runs.ts 同构但独立实现（AGV 指标集不同）：
 *   RunRecord{algorithm, time_limit_ms, seed, status, metrics 子集, fingerprint,
 *   problem_hash, at}；只有同一问题（problem_hash 相同）的两次运行才可对比。
 * 纯 TS，Node 可直接测。
 */

import type { AgvSolution } from '../../core/agv/types';

export const AGV_MAX_RUNS = 20;

export interface AgvRunRecord {
  seq: number;
  at: number;
  problemHash: string | null;
  paramSummary: string;
  status: string;
  completedTasks: number | null;
  totalTasks: number | null;
  makespan: number | null;
  totalFlowTime: number | null;
  totalLateness: number | null;
  deadlineViolations: number | null;
  emptyTravelSteps: number | null;
  avgUtilization: number | null;
  solveMs: number | null;
  peakMemoryBytes: number | null;
  verified: boolean | null;
  fingerprint: string | null;
  dynamic: boolean;
  problemText: string;
  solutionText: string;
  solution: AgvSolution;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function makeAgvRunRecord(
  seq: number,
  problemText: string,
  solutionText: string,
  solution: AgvSolution,
  params: string,
): AgvRunRecord {
  const m = (solution.metrics ?? {}) as Record<string, unknown>;
  return {
    seq,
    at: Date.now(),
    problemHash: solution.problem_hash ?? null,
    paramSummary: params,
    status: solution.status ?? 'UNKNOWN',
    completedTasks: num(m.completed_tasks),
    totalTasks: num(m.total_tasks),
    makespan: num(m.makespan),
    totalFlowTime: num(m.total_flow_time),
    totalLateness: num(m.total_lateness),
    deadlineViolations: num(m.deadline_violations),
    emptyTravelSteps: num(m.empty_travel_steps),
    avgUtilization: num(m.avg_utilization),
    solveMs: num(m.total_ms) ?? num(m.dispatch_ms),
    peakMemoryBytes: num(m.peak_memory_bytes),
    verified: solution.verified ?? null,
    fingerprint: solution.fingerprint ?? null,
    dynamic: Boolean(solution.dynamic),
    problemText,
    solutionText,
    solution,
  };
}

/** 同一问题的两次运行才可对比（problem_hash 相同；null 视为不可比）。 */
export function agvRunsGroupable(a: AgvRunRecord, b: AgvRunRecord): boolean {
  return Boolean(a.problemHash && a.problemHash === b.problemHash);
}

export interface AgvRunDiffRow {
  label: string;
  a: string;
  b: string;
  verdict: '' | 'better' | 'worse' | 'same';
}

/**
 * 指标 diff（B 相对 A）：
 *   - 完成数 / 利用率：越大越好；makespan / 流时 / 延期 / 空驶 / 违约：越小越好；
 *   - 耗时与内存只展示，不给方向（硬件噪声）。
 */
export function diffAgvRuns(a: AgvRunRecord, b: AgvRunRecord): AgvRunDiffRow[] {
  const show = (x: number | null, digits = 0): string => (x == null ? '—' : digits ? x.toFixed(digits) : String(x));
  const lowerBetter = (x: number | null, y: number | null): AgvRunDiffRow['verdict'] => {
    if (x == null || y == null) return '';
    if (x === y) return 'same';
    return y < x ? 'better' : 'worse';
  };
  const higherBetter = (x: number | null, y: number | null): AgvRunDiffRow['verdict'] => {
    if (x == null || y == null) return '';
    if (x === y) return 'same';
    return y > x ? 'better' : 'worse';
  };
  return [
    { label: '参数', a: a.paramSummary, b: b.paramSummary, verdict: a.paramSummary === b.paramSummary ? 'same' : '' },
    { label: '状态', a: a.status, b: b.status, verdict: a.status === b.status ? 'same' : '' },
    { label: '完成/总任务', a: `${show(a.completedTasks)}/${show(a.totalTasks)}`, b: `${show(b.completedTasks)}/${show(b.totalTasks)}`, verdict: higherBetter(a.completedTasks, b.completedTasks) },
    { label: 'Makespan', a: show(a.makespan), b: show(b.makespan), verdict: lowerBetter(a.makespan, b.makespan) },
    { label: '总流时', a: show(a.totalFlowTime), b: show(b.totalFlowTime), verdict: lowerBetter(a.totalFlowTime, b.totalFlowTime) },
    { label: '总延期', a: show(a.totalLateness), b: show(b.totalLateness), verdict: lowerBetter(a.totalLateness, b.totalLateness) },
    { label: '交期违约', a: show(a.deadlineViolations), b: show(b.deadlineViolations), verdict: lowerBetter(a.deadlineViolations, b.deadlineViolations) },
    { label: '空驶步数', a: show(a.emptyTravelSteps), b: show(b.emptyTravelSteps), verdict: lowerBetter(a.emptyTravelSteps, b.emptyTravelSteps) },
    { label: '平均利用率', a: show(a.avgUtilization, 3), b: show(b.avgUtilization, 3), verdict: higherBetter(a.avgUtilization, b.avgUtilization) },
    { label: '求解 ms', a: show(a.solveMs), b: show(b.solveMs), verdict: '' },
    {
      label: '峰值内存 MB',
      a: a.peakMemoryBytes == null ? '—' : (a.peakMemoryBytes / 1048576).toFixed(1),
      b: b.peakMemoryBytes == null ? '—' : (b.peakMemoryBytes / 1048576).toFixed(1),
      verdict: '',
    },
    { label: '核验', a: a.verified == null ? '—' : a.verified ? '✓' : '✗', b: b.verified == null ? '—' : b.verified ? '✓' : '✗', verdict: a.verified === b.verified ? 'same' : '' },
    { label: '动态重调度', a: a.dynamic ? '是' : '否', b: b.dynamic ? '是' : '否', verdict: '' },
  ];
}
