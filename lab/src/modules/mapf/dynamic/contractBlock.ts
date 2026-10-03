/**
 * 动态事件向导的契约块构造（M0 §9.2）：把「当前方案 + 用户事件列表」组装为
 * mapf-problem/1.0 的 dynamic 块（严格按 schema 字段），并做提交前预检（§9.3）。
 * 纯 TS 可测。
 */

import type { SceneDoc } from '../scene/SceneDoc';
import type { MapfSolution } from '../../../core/mapf/types';

export type DynamicEventInput =
  | { kind: 'obstacle_add'; cell: [number, number]; at: number; until?: number | null }
  | { kind: 'obstacle_remove'; cell: [number, number]; at: number }
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
        return { type: e.kind, cell: [e.cell[0], e.cell[1]], at: e.at, until: e.until ?? null };
      case 'obstacle_remove':
        return { type: e.kind, cell: [e.cell[0], e.cell[1]], at: e.at };
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

/**
 * 提交前预检（§9.3）：镜像引擎会拒绝的真实语义，减少无效往返。
 * The engine remains authoritative; these checks are deliberately limited to contract
 * invariants and never claim that a requested replan will be feasible.
 */
export function precheckDynamic(
  input: DynamicEventInput[],
  built: BuiltDynamic,
  scene: SceneDoc,
  maxEvents = 32,
  maxHorizon?: number,
): DynamicPrecheckIssue[] {
  const issues: DynamicPrecheckIssue[] = [];
  const T = built.snapshot.time;
  const k = built.snapshot.frozen_steps;
  const width = scene.map.cells[0]?.length ?? 0;
  const height = scene.map.cells.length;
  const horizon = maxHorizon ?? (typeof scene.time_model.horizon === 'number' ? scene.time_model.horizon : undefined);
  const inBounds = (x: number, y: number) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height;
  const hasWall = (x: number, y: number) => scene.map.cells[y]?.[x] === '#' || scene.map.cells[y]?.[x] === 'T' || scene.map.cells[y]?.[x] === 'S';
  const issue = (i: number, message: string) => issues.push({ message: `事件 #${i + 1}：${message}`, eventIndex: i });
  const goals = new Map(scene.robots.map((robot) => [robot.id, robot.goal]));

  if (input.length > maxEvents) {
    issues.push({ message: `事件总数 ${input.length} 超过档位上限 ${maxEvents}（E-CAP-LIMIT-EVENTS）` });
  }

  for (const [i, e] of input.entries()) {
    if (!Number.isInteger(e.at) || e.at < T) {
      issue(i, `生效时刻 at=${e.at} 早于快照时刻 T=${T} 或不是整数（E-EVENT-TIME）`);
    }
    if (horizon != null && e.at > horizon) issue(i, `生效时刻 at=${e.at} 超出时域 ${horizon}（E-EVENT-TIME）`);

    if (e.kind === 'obstacle_add' || e.kind === 'obstacle_remove') {
      const [x, y] = e.cell;
      if (!inBounds(x, y)) {
        issue(i, `障碍格 (${x},${y}) 越界或坐标不是整数（E-COORD-RANGE）`);
        continue;
      }
      if (e.kind === 'obstacle_remove') {
        const reAdded = input.some((candidate) =>
          candidate.kind === 'obstacle_add' && candidate.cell[0] === x && candidate.cell[1] === y && candidate.at <= e.at,
        );
        if (!hasWall(x, y) && !reAdded) issue(i, `(${x},${y}) 当前不是障碍，移除事件没有可观察的变化（E-EVENT-TARGET）`);
        continue;
      }
      if (e.until != null && (!Number.isInteger(e.until) || e.until <= e.at || (horizon != null && e.until > horizon))) {
        issue(i, `until=${e.until} 必须是大于 at=${e.at} 且不超出时域的整数（E-EVENT-TIME）`);
      }

      // 只在新增障碍真正生效的冻结时段检查承诺路径；有限 until 结束后的通行不冲突。
      const firstAffected = Math.max(T, e.at);
      const lastAffected = Math.min(T + k, horizon ?? Number.POSITIVE_INFINITY);
      if (firstAffected <= lastAffected) {
        for (const [rid, path] of Object.entries(built.snapshot.paths)) {
          for (let t = firstAffected; t <= Math.min(lastAffected, path.length - 1); t++) {
            if (e.until != null && t >= e.until) break;
            const [px, py] = path[t];
            if (px === x && py === y) {
              issue(i, `${rid} 已承诺在 t=${t} 经过 (${x},${y})，障碍在该时刻生效会破坏冻结路径（请调整生效/结束时刻或缩短冻结窗）`);
              break;
            }
          }
        }
      }
      continue;
    }

    if (e.kind === 'goal_change') {
      const oldGoal = goals.get(e.robot);
      if (!oldGoal) {
        issue(i, `引用了未知机器人 \`${e.robot}\`（E-EVENT-TARGET）`);
        continue;
      }
      const [x, y] = e.goal;
      if (!inBounds(x, y)) issue(i, `新目标 (${x},${y}) 越界或坐标不是整数（E-COORD-RANGE）`);
      else if (hasWall(x, y)) issue(i, `新目标 (${x},${y}) 是障碍格（E-ROBOT-GOAL-BLOCKED）`);
      if (e.at <= T && oldGoal[0] === x && oldGoal[1] === y) issue(i, `新目标与 ${e.robot} 当前目标相同，事件不产生变化（E-EVENT-TARGET）`);
      for (const [rid, goal] of goals) {
        if (rid !== e.robot && goal[0] === x && goal[1] === y) {
          issue(i, `新目标 (${x},${y}) 与 ${rid} 的目标重复（E-ROBOT-DUP-GOAL）`);
        }
      }
      goals.set(e.robot, [x, y]);
      continue;
    }

    if (!scene.robots.some((robot) => robot.id === e.robot)) {
      issue(i, `引用了未知机器人 \`${e.robot}\`（E-EVENT-TARGET）`);
    }
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
