/**
 * 动态事件向导的契约块构造（M0 §9.2）：把「当前方案 + 用户事件列表」组装为
 * mapf-problem/1.0 的 dynamic 块（严格按 schema 字段），并做提交前预检（§9.3）。
 * 纯 TS 可测。
 */

import type { SceneDoc } from '../scene/SceneDoc';
import { isBlockedCell } from '../scene/SceneDoc';
import type { MapfSolution } from '../../../core/mapf/types';

export type DynamicEventInput =
  | { kind: 'obstacle_add'; cell: [number, number]; at: number; until?: number | null }
  | { kind: 'obstacle_remove'; cell: [number, number]; at: number; until?: number | null }
  | { kind: 'goal_change'; robot: string; goal: [number, number]; at: number }
  | { kind: 'path_invalid'; robot: string; at: number };

export interface DynamicBlockInput {
  scene: SceneDoc;
  solution: MapfSolution;
  /** 快照时刻 T。 */
  time: number;
  frozenSteps: number;
  events: DynamicEventInput[];
  maxEvents: number;
}

export interface BuiltDynamic {
  snapshot: {
    time: number;
    frozen_steps: number;
    paths: Record<string, Array<[number, number]>>;
    prior_solution_hash?: string;
  };
  events: Array<Record<string, unknown>>;
}

export interface DynamicPrecheckIssue {
  message: string;
  eventIndex?: number;
}

/** 构造 dynamic 块（不预检；调用方先 buildDynamic 再 precheckDynamic 或反之皆可）。 */
export function buildDynamic(input: DynamicBlockInput): BuiltDynamic {
  const paths: Record<string, Array<[number, number]>> = {};
  for (const r of input.solution.robots ?? []) {
    if (r.path?.length) paths[r.id] = r.path.map(([x, y]) => [x, y] as [number, number]);
  }
  const events = input.events.map((e) => {
    switch (e.kind) {
      case 'obstacle_add':
      case 'obstacle_remove':
        return {
          type: e.kind,
          cell: [e.cell[0], e.cell[1]],
          at: e.at,
          until: e.until ?? null,
        };
      case 'goal_change':
        return { type: 'goal_change', robot: e.robot, goal: [e.goal[0], e.goal[1]], at: e.at };
      case 'path_invalid':
        return { type: 'path_invalid', robots: [e.robot], at: e.at };
    }
  });
  const snapshot: BuiltDynamic['snapshot'] = {
    time: input.time,
    frozen_steps: input.frozenSteps,
    paths,
  };
  if (input.solution.fingerprint) snapshot.prior_solution_hash = input.solution.fingerprint;
  return { snapshot, events };
}

/** 提交前预检（§9.3）：镜像引擎会拒绝的真实语义，减少无效往返。 */
export function precheckDynamic(input: DynamicEventInput[], built: BuiltDynamic, scene: SceneDoc): DynamicPrecheckIssue[] {
  const issues: DynamicPrecheckIssue[] = [];
  const T = built.snapshot.time;
  const k = built.snapshot.frozen_steps;
  for (const [i, e] of input.entries()) {
    if (e.at < T) {
      issues.push({ message: `事件 #${i + 1}（${e.kind}）生效时刻 at=${e.at} 早于快照时刻 T=${T}（E-EVENT-TIME）`, eventIndex: i });
    }
    if ((e.kind === 'obstacle_add' || e.kind === 'obstacle_remove') && e.at <= T + k) {
      // 冻结窗 [T, T+k] 内出现障碍：任一车冻结前缀此刻占用该格 → 承诺不可维持
      const [ex, ey] = e.cell;
      for (const [rid, path] of Object.entries(built.snapshot.paths)) {
        for (let t = T; t <= Math.min(T + k, path.length - 1); t++) {
          const [x, y] = path[t];
          if (x === ex && y === ey) {
            issues.push({
              message: `${rid} 已承诺在 t=${t} 经过 (${ex},${ey})：承诺时段内出现新障碍 = 承诺不可维持（请把生效时刻后移或缩短冻结窗）`,
              eventIndex: i,
            });
            break;
          }
        }
      }
    }
    if (e.kind === 'goal_change') {
      const goals = new Set(
        (scene.robots ?? []).map((r) => `${r.goal?.[0] ?? -9},${r.goal?.[1] ?? -9}`),
      );
      const k2 = `${e.goal[0]},${e.goal[1]}`;
      for (const r of scene.robots) {
        if (r.id !== e.robot && r.goal && r.goal[0] === e.goal[0] && r.goal[1] === e.goal[1]) {
          issues.push({ message: `新目标 (${e.goal[0]},${e.goal[1]}) 与 ${r.id} 的目标重复（E-ROBOT-DUP-GOAL）`, eventIndex: i });
        }
      }
      if (goals.has(k2)) {
        // 上面已报，不重复
      }
      if (isBlockedCell(scene, e.goal[0], e.goal[1])) {
        issues.push({ message: `新目标 (${e.goal[0]},${e.goal[1]}) 是障碍格（E-ROBOT-GOAL-BLOCKED）`, eventIndex: i });
      }
    }
  }
  if (input.length > 32) {
    issues.push({ message: `事件总数 ${input.length} 超过 wasm-light 上限 32（E-CAP-LIMIT-EVENTS）` });
  }
  return issues;
}

/** 场景 + dynamic 块 → 可提交的问题文本。 */
export function composeProblemWithDynamic(scene: SceneDoc, dynamic: BuiltDynamic): string {
  const problem: Record<string, unknown> = JSON.parse(JSON.stringify({
    schema_version: scene.schema_version,
    id: `${scene.id}-dyn`,
    map: { cells: scene.map.cells },
    time_model: scene.time_model,
    objective: scene.objective,
    robots: scene.robots,
    solver: scene.solver,
  }));
  problem.dynamic = dynamic;
  return JSON.stringify(problem);
}
