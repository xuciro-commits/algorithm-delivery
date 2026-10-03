/**
 * 运行历史与对比（M0 §10）：RunRecord 会话内存保存（上限 20 条），
 * 按 problem_hash 分组——只有同一问题的两次运行才允许对比。
 * 纯 TS 可测。
 *
 * 与 AGV 的 runs.ts 共用 `core/runs` 的骨架（上限、可比性、方向语义、格式化），
 * 这里只保留 MAPF 自己的指标集。
 */

import type { MapfSolution } from '../../../core/mapf/types';
import {
  MAX_RUNS,
  fmtMB,
  fmtNum,
  fmtVerified,
  lowerBetter,
  row,
  sameProblem,
  sameWhenEqual,
  type RunDiffRow,
} from '../../../core/runs';

export { MAX_RUNS };
export type { RunDiffRow };

export interface RunRecord {
  seq: number;
  at: number; // Date.now()
  problemHash: string | null;
  paramSummary: string;
  status: string;
  soc: number | null;
  makespan: number | null;
  solveMs: number | null;
  firstFeasibleMs: number | null;
  peakMemoryBytes: number | null;
  verified: boolean | null;
  fingerprint: string | null;
  problemText: string;
  solutionText: string;
  solution: MapfSolution;
}

export function makeRunRecord(seq: number, problemText: string, solutionText: string, solution: MapfSolution, params: string): RunRecord {
  const m = (solution.metrics ?? {}) as Record<string, number | null>;
  return {
    seq,
    at: Date.now(),
    problemHash: solution.problem_hash ?? null,
    paramSummary: params,
    status: solution.status ?? 'UNKNOWN',
    soc: solution.soc ?? null,
    makespan: solution.makespan ?? null,
    solveMs: m.solve_ms ?? null,
    firstFeasibleMs: m.first_feasible_ms ?? null,
    peakMemoryBytes: m.peak_memory_bytes ?? null,
    verified: solution.verified ?? null,
    fingerprint: solution.fingerprint ?? null,
    problemText,
    solutionText,
    solution,
  };
}

export function runsGroupable(a: RunRecord, b: RunRecord): boolean {
  // 同一问题（同 problem_hash；均为 null 视为不可比——不同手写输入）
  return sameProblem(a, b);
}

export function diffRuns(a: RunRecord, b: RunRecord): { rows: RunDiffRow[]; robots: Array<{ id: string; steps: string; arrival: string; waits: string }> } {
  const rows: RunDiffRow[] = [
    row('状态', a.status, b.status, sameWhenEqual(a.status, b.status)),
    row('SOC', fmtNum(a.soc), fmtNum(b.soc), lowerBetter(a.soc, b.soc)),
    row('Makespan', fmtNum(a.makespan), fmtNum(b.makespan), lowerBetter(a.makespan, b.makespan)),
    row('求解耗时 ms', fmtNum(a.solveMs), fmtNum(b.solveMs)),
    row('首解 ms', fmtNum(a.firstFeasibleMs), fmtNum(b.firstFeasibleMs)),
    row('峰值内存 MB', fmtMB(a.peakMemoryBytes), fmtMB(b.peakMemoryBytes)),
    row('核验', fmtVerified(a.verified), fmtVerified(b.verified), sameWhenEqual(a.verified, b.verified)),
  ];
  const byId = (sol: MapfSolution) => new Map((sol.robots ?? []).map((r) => [r.id, r]));
  const ma = byId(a.solution);
  const mb = byId(b.solution);
  const robots: Array<{ id: string; steps: string; arrival: string; waits: string }> = [];
  for (const id of new Set([...ma.keys(), ...mb.keys()])) {
    const ra = ma.get(id);
    const rb = mb.get(id);
    const fmt = (r?: { steps?: number; path?: Array<[number, number]>; arrival?: number | null }) =>
      r ? `${r.steps ?? (r.path?.length ?? 1) - 1}` : '—';
    const fa = (r?: { arrival?: number | null }) => (r?.arrival == null ? '—' : String(r.arrival));
    robots.push({
      id,
      steps: `${fmt(ra)} → ${fmt(rb)}`,
      arrival: `${fa(ra)} → ${fa(rb)}`,
      waits: '',
    });
  }
  return { rows, robots };
}
