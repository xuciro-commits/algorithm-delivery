/**
 * 运行历史与对比（M0 §10）：RunRecord 会话内存保存（上限 20 条），
 * 按 problem_hash 分组——只有同一问题的两次运行才允许对比。
 * 纯 TS 可测。
 */

import type { MapfSolution } from '../../../core/mapf/types';

export const MAX_RUNS = 20;

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
  return Boolean(a.problemHash && a.problemHash === b.problemHash);
}

export interface RunDiffRow {
  label: string;
  a: string;
  b: string;
  /** 'better' | 'worse' | 'same' | ''（无从比较）。 */
  verdict: '' | 'better' | 'worse' | 'same';
}

export function diffRuns(a: RunRecord, b: RunRecord): { rows: RunDiffRow[]; robots: Array<{ id: string; steps: string; arrival: string; waits: string }> } {
  const num = (x: number | null) => (x == null ? '—' : String(x));
  /** verdict 描述 B 列相对 A 列（越小越好型指标）。 */
  const lowerBetter = (a: number | null, b: number | null): RunDiffRow['verdict'] => {
    if (a == null || b == null) return '';
    if (a === b) return 'same';
    return b < a ? 'better' : 'worse';
  };
  const rows: RunDiffRow[] = [
    { label: '状态', a: a.status, b: b.status, verdict: a.status === b.status ? 'same' : '' },
    { label: 'SOC', a: num(a.soc), b: num(b.soc), verdict: lowerBetter(a.soc, b.soc) },
    { label: 'Makespan', a: num(a.makespan), b: num(b.makespan), verdict: lowerBetter(a.makespan, b.makespan) },
    { label: '求解耗时 ms', a: num(a.solveMs), b: num(b.solveMs), verdict: '' },
    { label: '首解 ms', a: num(a.firstFeasibleMs), b: num(b.firstFeasibleMs), verdict: '' },
    { label: '峰值内存 MB', a: a.peakMemoryBytes == null ? '—' : (a.peakMemoryBytes / 1048576).toFixed(1), b: b.peakMemoryBytes == null ? '—' : (b.peakMemoryBytes / 1048576).toFixed(1), verdict: '' },
    { label: '核验', a: a.verified == null ? '—' : a.verified ? '✓' : '✗', b: b.verified == null ? '—' : b.verified ? '✓' : '✗', verdict: a.verified === b.verified ? 'same' : '' },
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
