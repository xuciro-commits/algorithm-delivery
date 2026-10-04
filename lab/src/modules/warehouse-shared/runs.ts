/**
 * 运行历史与对比（两个新模块共用）。
 *
 * 骨架来自 `core/runs`（上限、可比性、方向语义、格式化），这里只保留仓储自己的指标集：
 * 库位侧（日运行时间 / 搬迁 / Gini / 拥堵）与调度侧（完成数 / 完工 / 冲突 / 倒垛 / 核验）。
 * 只有同一问题（problem_hash 相同）的两次运行才允许比较——跨规模比较会被明确标注。
 */

import {
  MAX_RUNS,
  asNumber,
  fmtMB,
  fmtNum,
  fmtVerified,
  higherBetter,
  lowerBetter,
  row,
  sameWhenEqual,
  type RunDiffRow,
} from '../../core/runs';
import type { WarehouseEnvelope } from '../../core/warehouse/types';

export const WAREHOUSE_MAX_RUNS = MAX_RUNS;
export type WarehouseRunDiffRow = RunDiffRow;

export interface WarehouseRunRecord {
  id: string;
  seq: number;
  at: number;
  domain: 'slotting' | 'asrs' | 'joint';
  problemHash: string | null;
  paramSummary: string;
  status: string;
  fingerprint: string | null;
  verified: boolean | null;
  runtimeMs: number | null;
  peakMemoryBytes: number | null;
  // 共同
  tasksDone: number | null;
  tasksTotal: number | null;
  makespan: number | null;
  conflicts: number | null;
  // 库位侧
  dailyTravelSeconds: number | null;
  gini: number | null;
  relocationCount: number | null;
  congestion: number | null;
  // 调度侧
  relocationTasks: number | null;
  blockedMoves: number | null;
  derivedTasksDone: number | null;
  dualCommandPairs: number | null;
  lateTasks: number | null;
  travelMeters: number | null;
  // 联合
  jointObjective: number | null;
  paretoPoints: number | null;
  // 说明
  objectiveNote: string;
  problemText: string;
  envelopeText: string;
  envelope: WarehouseEnvelope;
  /** 联合优化：来自 `result.rounds[]` 的单轮快照（用于逐轮对比）。 */
  rounds?: Array<{
    round: number;
    algorithm?: string;
    tasksDone: number;
    makespan_s: number;
    conflicts: number;
    relocationTasks?: number;
    relocationCount?: number;
    jointObjective: number;
    verified: boolean;
  }>;
  /** 面板内部：把某轮指标覆盖到记录上时的标记。 */
  roundSnapshot?: WarehouseRunRecord['rounds'] extends Array<infer T> | undefined ? T : never;
  metricCards: Array<{ key: string; label: string; value: string; hint?: string; tone?: 'normal' | 'good' | 'warn' | 'bad' }>;
}

const num = asNumber;

/** 简单字符串哈希（仅用于"是不是同一个问题"的会话内判定，不用于指纹）。 */
export function problemHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function makeWarehouseRunRecord(
  seq: number,
  problemText: string,
  envelopeText: string,
  envelope: WarehouseEnvelope,
  params: string,
  peakMemoryBytes: number | null,
): WarehouseRunRecord {
  const domain = (envelope.result?.kind === 'asrs' ? 'asrs' : envelope.result?.kind === 'joint' ? 'joint' : 'slotting') as
    | 'slotting'
    | 'asrs'
    | 'joint';
  const metrics = envelope.metrics ?? {};
  const objective = num(envelope.objective);
  const relocationCount = num(metrics.relocationCount) ?? num(metrics.relocationTasks);
  return {
    id: `W${seq}`,
    seq,
    at: Date.now(),
    domain,
    problemHash: problemHash(problemText),
    paramSummary: params,
    status: envelope.status,
    fingerprint: envelope.fingerprint ?? null,
    verified: envelope.verification ? Boolean(envelope.verification.ok) : null,
    runtimeMs: num(envelope.runtimeMs),
    peakMemoryBytes,
    tasksDone: num(metrics.tasksDone),
    tasksTotal: num(metrics.tasksTotal),
    makespan: num(metrics.makespan_s),
    conflicts: num(metrics.conflicts),
    dailyTravelSeconds: num(metrics.dailyTravelSeconds) ?? null,
    gini: num(metrics.gini),
    relocationCount,
    congestion: num(metrics.congestion),
    relocationTasks: num(metrics.relocationTasks),
    blockedMoves: num(metrics.blockedMoves),
    derivedTasksDone: num(metrics.derivedTasksDone),
    dualCommandPairs: num(metrics.dualCommandPairs),
    lateTasks: num(metrics.lateTasks),
    travelMeters: num(metrics.travelMeters),
    jointObjective: domain === 'joint' ? objective : null,
    paretoPoints: Array.isArray((envelope.result as { pareto?: unknown[] }).pareto)
      ? ((envelope.result as { pareto?: unknown[] }).pareto ?? []).length
      : null,
    rounds: Array.isArray((envelope.result as { rounds?: unknown }).rounds)
      ? ((envelope.result as { rounds: WarehouseRunRecord['rounds'] }).rounds ?? [])
      : undefined,
    objectiveNote: envelope.objective == null ? '—' : String(envelope.objective),
    problemText,
    envelopeText,
    envelope,
    metricCards: [],
  };
}

/** 逐指标差异表（方向语义由 core/runs 提供，缺数据时不做判定）。 */
export function compareWarehouseRuns(a: WarehouseRunRecord, b: WarehouseRunRecord): WarehouseRunDiffRow[] {
  const rows: WarehouseRunDiffRow[] = [];
  rows.push(row('状态', a.status, b.status, sameWhenEqual(a.status, b.status)));
  rows.push(row('问题编号', a.problemHash ?? '—', b.problemHash ?? '—', sameWhenEqual(a.problemHash, b.problemHash)));
  rows.push(row('参数', a.paramSummary, b.paramSummary));
  rows.push(row('完成/总任务', `${fmtNum(a.tasksDone)}/${fmtNum(a.tasksTotal)}`, `${fmtNum(b.tasksDone)}/${fmtNum(b.tasksTotal)}`, higherBetter(a.tasksDone, b.tasksDone)));
  rows.push(row('完工时间 (s)', fmtNum(a.makespan, 1), fmtNum(b.makespan, 1), lowerBetter(a.makespan, b.makespan)));
  rows.push(row('冲突次数', fmtNum(a.conflicts), fmtNum(b.conflicts), lowerBetter(a.conflicts, b.conflicts)));
  rows.push(row('倒垛/搬迁', fmtNum(a.relocationCount), fmtNum(b.relocationCount), lowerBetter(a.relocationCount, b.relocationCount)));
  rows.push(row('受堵移动', fmtNum(a.blockedMoves), fmtNum(b.blockedMoves), lowerBetter(a.blockedMoves, b.blockedMoves)));
  rows.push(row('双指令配对', fmtNum(a.dualCommandPairs), fmtNum(b.dualCommandPairs), higherBetter(a.dualCommandPairs, b.dualCommandPairs)));
  rows.push(row('行驶里程 (m)', fmtNum(a.travelMeters, 1), fmtNum(b.travelMeters, 1), lowerBetter(a.travelMeters, b.travelMeters)));
  rows.push(row('巷道负载 Gini', fmtNum(a.gini, 3), fmtNum(b.gini, 3), lowerBetter(a.gini, b.gini)));
  rows.push(row('联合目标', fmtNum(a.jointObjective, 1), fmtNum(b.jointObjective, 1), lowerBetter(a.jointObjective, b.jointObjective)));
  rows.push(row('Pareto 点', fmtNum(a.paretoPoints), fmtNum(b.paretoPoints), higherBetter(a.paretoPoints, b.paretoPoints)));
  rows.push(row('核验', fmtVerified(a.verified), fmtVerified(b.verified)));
  rows.push(row('指纹', a.fingerprint?.slice(0, 10) ?? '—', b.fingerprint?.slice(0, 10) ?? '—', sameWhenEqual(a.fingerprint, b.fingerprint)));
  rows.push(row('峰值内存 (MB)', fmtMB(a.peakMemoryBytes), fmtMB(b.peakMemoryBytes)));
  return rows;
}

export function sameWarehouseProblem(a: WarehouseRunRecord, b: WarehouseRunRecord): boolean {
  return Boolean(a.problemHash && a.problemHash === b.problemHash);
}
