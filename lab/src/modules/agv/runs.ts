/**
 * AGV 运行历史与多策略对比（设计蓝本 §5-2）。
 *
 * 与 MAPF 的 runs.ts 共用 `core/runs` 的骨架（上限、可比性、方向语义、格式化），
 * 这里只保留 AGV 自己的指标集：
 *   RunRecord{algorithm, time_limit_ms, seed, status, metrics 子集, fingerprint,
 *   problem_hash, at}；只有同一问题（problem_hash 相同）的两次运行才可对比。
 * 纯 TS，Node 可直接测。
 */

import type { AgvSolution } from '../../core/agv/types';
import {
  MAX_RUNS,
  asNumber,
  fmtMB,
  fmtNum,
  fmtVerified,
  higherBetter,
  lowerBetter,
  row,
  sameProblem,
  sameWhenEqual,
  type RunDiffRow,
} from '../../core/runs';

/** 会话内保留的运行上限（与 MAPF/APS 同一个骨架）。 */
export const AGV_MAX_RUNS = MAX_RUNS;
export type AgvRunDiffRow = RunDiffRow;

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

const num = asNumber;

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
  return sameProblem(a, b);
}

/**
 * 指标 diff（B 相对 A）：
 *   - 完成数 / 利用率：越大越好；makespan / 流时 / 延期 / 空驶 / 违约：越小越好；
 *   - 耗时与内存只展示，不给方向（硬件噪声）。
 */
export function diffAgvRuns(a: AgvRunRecord, b: AgvRunRecord): AgvRunDiffRow[] {
  const show = fmtNum;
  return [
    row('参数', a.paramSummary, b.paramSummary, sameWhenEqual(a.paramSummary, b.paramSummary)),
    row('状态', a.status, b.status, sameWhenEqual(a.status, b.status)),
    row('完成/总任务', `${show(a.completedTasks)}/${show(a.totalTasks)}`, `${show(b.completedTasks)}/${show(b.totalTasks)}`, higherBetter(a.completedTasks, b.completedTasks)),
    row('Makespan', show(a.makespan), show(b.makespan), lowerBetter(a.makespan, b.makespan)),
    row('总流时', show(a.totalFlowTime), show(b.totalFlowTime), lowerBetter(a.totalFlowTime, b.totalFlowTime)),
    row('总延期', show(a.totalLateness), show(b.totalLateness), lowerBetter(a.totalLateness, b.totalLateness)),
    row('交期违约', show(a.deadlineViolations), show(b.deadlineViolations), lowerBetter(a.deadlineViolations, b.deadlineViolations)),
    row('空驶步数', show(a.emptyTravelSteps), show(b.emptyTravelSteps), lowerBetter(a.emptyTravelSteps, b.emptyTravelSteps)),
    row('平均利用率', show(a.avgUtilization, 3), show(b.avgUtilization, 3), higherBetter(a.avgUtilization, b.avgUtilization)),
    row('求解 ms', show(a.solveMs), show(b.solveMs)),
    row('峰值内存 MB', fmtMB(a.peakMemoryBytes), fmtMB(b.peakMemoryBytes)),
    row('核验', fmtVerified(a.verified), fmtVerified(b.verified), sameWhenEqual(a.verified, b.verified)),
    row('动态重调度', a.dynamic ? '是' : '否', b.dynamic ? '是' : '否'),
  ];
}
