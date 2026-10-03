/**
 * PlanProblem / PlanSolution → 可视化模型的纯函数。
 *
 * 这里**不重算业务判断**（不重新校验约束、不重算目标值）：
 * 约束结论一律采用引擎返回的 `violations` 与独立核验报告 `VerifyReport`，
 * 前端只做“呈现 + 便于人眼比较”的整理（甘特条、资源占用、指标卡片、两次运行的差异）。
 * 这条边界很重要：实验室是评测入口，不是第二套算法实现。
 */

import type { PlanProblemLike, PlanSolutionLike, VerifyReport } from '../types';
import type {
  GanttBar,
  GanttModel,
  ResourceTimeline,
  ResourceUsage,
  RunRecord,
  RunComparison,
} from './records';

const MS_PER_MIN = 60_000;

export function parseIsoMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

export function minutesBetween(aIso: string, bIso: string): number {
  return Math.round((parseIsoMs(bIso) - parseIsoMs(aIso)) / MS_PER_MIN);
}

/** 工序技能索引：problem 里 `operations[].skill`，solution 里没有 skill，需要按 op id 查。 */
function buildSkillIndex(problem: PlanProblemLike): Map<string, string> {
  const index = new Map<string, string>();
  for (const order of problem.orders ?? []) {
    for (const op of order.operations ?? []) {
      index.set(op.id, op.skill ?? 'unknown');
    }
  }
  return index;
}

function buildOpIndex(problem: PlanProblemLike) {
  const map = new Map<
    string,
    {
      skill: string;
      durationMin: number;
      orderId: string;
      tools: string[];
    }
  >();
  for (const order of problem.orders ?? []) {
    for (const op of order.operations ?? []) {
      const durations = (op.alternatives ?? []).map((alt) => alt.duration_min);
      const duration = durations.length ? Math.min(...durations.filter((d) => Number.isFinite(d))) : NaN;
      map.set(op.id, {
        skill: op.skill ?? 'unknown',
        durationMin: Number.isFinite(duration) ? duration : NaN,
        orderId: order.id,
        tools: op.tool_ids ?? op.tools ?? [],
      });
    }
  }
  return map;
}

export interface GanttBuildResult {
  model: GanttModel;
  resources: ResourceUsage[];
  timelines: ResourceTimeline[];
}

/** 由 problem + solution 构建甘特模型、资源利用率与资源时间线。 */
export function buildVisualization(
  problem: PlanProblemLike,
  solution: PlanSolutionLike,
): GanttBuildResult {
  const skillIndex = buildSkillIndex(problem);
  const opIndex = buildOpIndex(problem);
  const ops = solution.operations ?? [];

  const bars: GanttBar[] = ops.map((op) => {
    const info = opIndex.get(op.operation_id);
    const startMs = parseIsoMs(op.start_at);
    const endMs = parseIsoMs(op.end_at);
    return {
      opId: op.operation_id,
      orderId: op.order_id,
      machineId: op.machine_id,
      workerId: op.worker_id,
      toolIds: op.tool_ids ?? [],
      startMs,
      endMs,
      durationMs: endMs - startMs,
      startIso: op.start_at,
      endIso: op.end_at,
      skill: info?.skill ?? skillIndex.get(op.operation_id) ?? 'unknown',
    };
  });

  const horizonStartMs = problem.meta?.horizon_start
    ? parseIsoMs(problem.meta.horizon_start)
    : Math.min(...bars.map((b) => b.startMs));
  const horizonEndMs = problem.meta?.horizon_end
    ? parseIsoMs(problem.meta.horizon_end)
    : Math.max(...bars.map((b) => b.endMs));

  const orderRows = (problem.orders ?? []).map((order) => {
    const orderBars = bars
      .filter((b) => b.orderId === order.id)
      .sort((a, b) => a.startMs - b.startMs);
    const dueMs = order.due_at ? parseIsoMs(order.due_at) : NaN;
    const endMs = orderBars.length ? Math.max(...orderBars.map((b) => b.endMs)) : NaN;
    return {
      orderId: order.id,
      priority: order.priority ?? 1,
      releaseMs: order.release_at ? parseIsoMs(order.release_at) : horizonStartMs,
      dueMs,
      startMs: orderBars.length ? Math.min(...orderBars.map((b) => b.startMs)) : NaN,
      endMs,
      tardinessMin: Number.isFinite(dueMs) && Number.isFinite(endMs) ? Math.max(0, Math.round((endMs - dueMs) / MS_PER_MIN)) : 0,
      bars: orderBars,
    };
  });

  const skills = [...new Set(bars.map((b) => b.skill))].sort();
  const model: GanttModel = {
    rows: orderRows,
    minMs: horizonStartMs,
    maxMs: horizonEndMs,
    dataMinMs: Math.min(...bars.map((b) => b.startMs)),
    dataMaxMs: Math.max(...bars.map((b) => b.endMs)),
    skills,
    operationCount: bars.length,
  };

  const resources = buildResourceUsage(problem, bars);
  const timelines = buildResourceTimelines(problem, bars, horizonStartMs, horizonEndMs);
  return { model, resources, timelines };
}

/** 资源利用率：占用分钟 / 可用分钟（可用窗口按 `available` 合并，扣除 `blocked` 的近似）。 */
export function buildResourceUsage(problem: PlanProblemLike, bars: GanttBar[]): ResourceUsage[] {
  const usage: ResourceUsage[] = [];

  const windowMinutes = (entry: { available?: unknown[] }): number => {
    const list = (entry.available ?? []) as Array<{ start?: string; end?: string }>;
    let total = 0;
    for (const w of list) {
      if (!w.start || !w.end) continue;
      const s = parseIsoMs(w.start);
      const e = parseIsoMs(w.end);
      if (Number.isFinite(s) && Number.isFinite(e) && e > s) total += (e - s) / MS_PER_MIN;
    }
    return Math.round(total);
  };

  for (const machine of problem.machines ?? []) {
    const mine = bars.filter((b) => b.machineId === machine.id);
    const busyMin = Math.round(mine.reduce((acc, b) => acc + b.durationMs, 0) / MS_PER_MIN);
    const availableMin = windowMinutes(machine);
    usage.push({
      id: machine.id,
      kind: 'machine',
      capabilities: machine.capabilities ?? [],
      busyMin,
      availableMin,
      utilization: availableMin > 0 ? busyMin / availableMin : 0,
      operations: mine.length,
    });
  }
  for (const worker of problem.workers ?? []) {
    const mine = bars.filter((b) => b.workerId === worker.id);
    const busyMin = Math.round(mine.reduce((acc, b) => acc + b.durationMs, 0) / MS_PER_MIN);
    const availableMin = windowMinutes(worker as { available?: unknown[] });
    usage.push({
      id: worker.id,
      kind: 'worker',
      capabilities: worker.skills ?? [],
      busyMin,
      availableMin,
      utilization: availableMin > 0 ? busyMin / availableMin : 0,
      operations: mine.length,
    });
  }
  return usage;
}

/** 按资源分组的甘特时间线（机器/人员各一条泳道，看“谁被占满了”）。 */
export function buildResourceTimelines(
  problem: PlanProblemLike,
  bars: GanttBar[],
  minMs: number,
  maxMs: number,
): ResourceTimeline[] {
  const lanes: ResourceTimeline[] = [];
  for (const machine of problem.machines ?? []) {
    lanes.push({
      id: machine.id,
      kind: 'machine',
      label: `${machine.id}（${(machine.capabilities ?? []).join('/') || '—'}）`,
      bars: bars.filter((b) => b.machineId === machine.id),
      minMs,
      maxMs,
    });
  }
  for (const worker of problem.workers ?? []) {
    lanes.push({
      id: worker.id,
      kind: 'worker',
      label: `${worker.id}（${(worker.skills ?? []).join('/') || '—'}）`,
      bars: bars.filter((b) => b.workerId === worker.id),
      minMs,
      maxMs,
    });
  }
  return lanes;
}

export interface MetricCard {
  key: string;
  label: string;
  value: string;
  hint?: string;
  tone?: 'normal' | 'good' | 'warn';
}

/** 指标卡片：直接取引擎 `metrics`，缺失时显示 unavailable（不猜、不算）。 */
export function metricCards(solution: PlanSolutionLike, wallMs: number): MetricCard[] {
  const m = solution.metrics ?? {};
  const objective = solution.objective ?? {};
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const ms = (v: unknown) => {
    const n = num(v);
    return n === null ? 'unavailable' : `${n.toFixed(1)} ms`;
  };
  const mem = num(m.peak_memory_bytes);

  const cards: MetricCard[] = [
    {
      key: 'status',
      label: '状态',
      value: String(solution.status ?? '—'),
      tone: solution.status === 'OPTIMAL' ? 'good' : solution.status === 'FEASIBLE' ? 'normal' : 'warn',
      hint: solution.optimality_proven ? 'optimality_proven=true' : '未证明最优',
    },
    { key: 'first', label: '首解时间', value: ms(m.first_feasible_ms), hint: 'first_feasible_ms' },
    { key: 'total', label: '总耗时', value: ms(m.total_ms), hint: 'total_ms（含建模与校验）' },
    { key: 'wall', label: '端到端墙钟', value: `${wallMs.toFixed(0)} ms`, hint: '主线程等待时间（含 Worker 通信）' },
    { key: 'compile', label: '建模耗时', value: ms(m.compile_ms), hint: 'compile_ms' },
    { key: 'verify', label: '校验耗时', value: ms(m.verify_ms), hint: 'verify_ms' },
    {
      key: 'memory',
      label: '峰值内存',
      value: mem === null ? 'unavailable' : `${(mem / 1048576).toFixed(2)} MB`,
      hint: 'peak_memory_bytes（wasm 侧真实统计）',
    },
  ];

  const wt = num(objective.weighted_tardiness_minutes);
  const makespan = num(objective.makespan_minutes);
  const bound = num(objective.best_bound);
  const gap = num(objective.relative_gap);
  cards.push(
    {
      key: 'wt',
      label: '加权延期',
      value: wt === null ? '—' : `${wt} min`,
      tone: wt === 0 ? 'good' : 'warn',
      hint: 'objective.weighted_tardiness_minutes',
    },
    {
      key: 'makespan',
      label: 'makespan',
      value: makespan === null ? '—' : `${makespan} min`,
      hint: 'objective.makespan_minutes',
    },
    {
      key: 'bound',
      label: '下界 / 差距',
      value: bound === null ? '—' : `${bound} min · ${gap === null ? '—' : gap.toFixed(4)}`,
      hint: 'best_bound（有效下界）与 relative_gap',
    },
    {
      key: 'late',
      label: '延期订单',
      value: num(objective.late_orders) === null ? '—' : String(objective.late_orders),
      tone: num(objective.late_orders) === 0 ? 'good' : 'warn',
      hint: 'objective.late_orders',
    },
  );
  return cards;
}

export interface ViolationDigest {
  ok: boolean;
  errors: number;
  warnings: number;
  issues: number;
  byCode: Array<{ code: string; severity: string; count: number; sample: string }>;
}

/** 汇总核验报告（严格模式会额外要求租户/问题哈希绑定）。 */
export function digestVerify(report: VerifyReport | undefined): ViolationDigest {
  if (!report) return { ok: false, errors: 0, warnings: 0, issues: 0, byCode: [] };
  const items = [...(report.violations ?? []), ...(report.issues ?? [])];
  const byCode = new Map<string, { code: string; severity: string; count: number; sample: string }>();
  for (const v of items) {
    const key = `${v.severity}:${v.code}`;
    const entry = byCode.get(key) ?? {
      code: v.code,
      severity: v.severity,
      count: 0,
      sample: v.message,
    };
    entry.count += 1;
    byCode.set(key, entry);
  }
  return {
    ok: Boolean(report.ok),
    errors: report.counts?.errors ?? 0,
    warnings: report.counts?.warnings ?? 0,
    issues: report.counts?.issues ?? 0,
    byCode: [...byCode.values()].sort((a, b) => b.count - a.count),
  };
}

/**
 * 两次运行的差异：同一问题下方案变了多少。
 * `changedOperations` 用 (machine, worker, start) 三元组判定，与 CLI `compare` 同口径。
 */
export function compareRuns(base: RunRecord, other: RunRecord): RunComparison {
  const key = (r: RunRecord) =>
    new Map(
      (r.solution?.operations ?? []).map((op) => [
        op.operation_id,
        `${op.machine_id}|${op.worker_id}|${op.start_at}`,
      ]),
    );
  const a = key(base);
  const b = key(other);
  const changed: RunComparison['changed'] = [];
  for (const [opId, triple] of b) {
    const before = a.get(opId);
    if (before !== undefined && before !== triple) {
      const [machine, worker, start] = triple.split('|');
      const [pMachine, , pStart] = before.split('|');
      changed.push({ opId, from: `${pMachine}@${pStart}`, to: `${machine}@${start}`, worker });
    }
  }
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const delta = (x: unknown, y: unknown): number | null => {
    const a1 = num(x);
    const b1 = num(y);
    return a1 === null || b1 === null ? null : Math.round((b1 - a1) * 1000) / 1000;
  };
  return {
    baseId: base.id,
    otherId: other.id,
    changedOperations: changed.length,
    comparedOperations: Math.min(a.size, b.size),
    changed,
    sameFingerprint: Boolean(base.fingerprint && other.fingerprint && base.fingerprint === other.fingerprint),
    deltas: {
      weightedTardiness: delta(
        base.solution?.objective?.weighted_tardiness_minutes,
        other.solution?.objective?.weighted_tardiness_minutes,
      ),
      makespan: delta(
        base.solution?.objective?.makespan_minutes,
        other.solution?.objective?.makespan_minutes,
      ),
      firstFeasibleMs: delta(base.metrics.firstFeasibleMs, other.metrics.firstFeasibleMs),
      totalMs: delta(base.metrics.totalMs, other.metrics.totalMs),
      peakMemoryBytes: delta(base.metrics.peakMemoryBytes, other.metrics.peakMemoryBytes),
    },
  };
}
