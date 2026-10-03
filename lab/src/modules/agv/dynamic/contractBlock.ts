/**
 * AGV 动态事件 → 契约块（agv-dispatch-problem/1.0 的 dynamic 块）。
 *
 * 与 MAPF 的 dynamic/contractBlock.ts 同一方法论：
 *   - 前端只做「投影 + 提交前预检」，真正的重调度永远由 WASM 引擎完成；
 *   - 快照严格来自当前解的投影（pos/path/task/status…），不编造任何状态；
 *   - 预检镜像引擎已实现的拒绝语义（减少无效往返），引擎仍是最终裁决者。
 *
 * 引擎语义（agv/rust/src/dynamic.rs + problem.rs）：
 *   - snapshot.vehicles[id].path 必须覆盖 0..=time 且 path[time] == pos；
 *   - snapshot.tasks[id].status = "done" | "picked" 的任务被沿用，其余重试；
 *   - task_cancel 不能取消 done/picked；task_add 的 id 不得与既有任务/车辆冲突；
 *   - obstacle_add 的 at 缺省 = 快照时刻；落在已执行历史占用格上会被拒绝。
 */

import type { AgvTaskLoc } from '../../../core/agv/types';
import type { AgvSolution } from '../../../core/agv/types';
import { phaseAt, taskOfAt } from '../agvRender';
import type { AgvScene } from '../scene';

export type AgvDynamicEventInput =
  | {
      kind: 'task_add';
      taskId: string;
      pickup: AgvTaskLoc;
      dropoff: AgvTaskLoc;
      pickupService: number;
      dropoffService: number;
      releaseStep: number;
      priority: number;
      dueStep: number | null;
      requiredCapability: string | null;
    }
  | { kind: 'task_cancel'; task: string }
  | { kind: 'task_priority'; task: string; priority: number }
  | { kind: 'vehicle_pause'; vehicle: string }
  | { kind: 'vehicle_resume'; vehicle: string }
  | { kind: 'obstacle_add'; cell: [number, number]; until: number | null }
  | { kind: 'obstacle_remove'; cell: [number, number] };

export interface AgvDynamicBlockInput {
  scene: AgvScene;
  solution: AgvSolution;
  /** 快照时刻 T（回放当前步）。 */
  time: number;
  events: AgvDynamicEventInput[];
  maxEvents: number;
}

export interface BuiltAgvDynamic {
  snapshot: {
    time: number;
    vehicles: Record<string, { pos: [number, number]; phase: string; task: string | null; path: Array<[number, number]> }>;
    tasks: Record<string, Record<string, unknown>>;
  };
  events: Array<Record<string, unknown>>;
}

export interface AgvDynamicIssue {
  message: string;
  eventIndex?: number;
}

/** 前端相位 → 契约相位枚举（引擎不消费 phase，只为通过 schema 校验）。 */
function contractPhase(phase: string): string {
  // 契约枚举：idle|to_pickup|servicing_pickup|to_dropoff|servicing_dropoff|parking|paused
  return phase === 'relocating' ? 'parking' : phase;
}

/** 构造 dynamic 块（快照 = 当前解在 T 时刻的投影）。 */
export function buildAgvDynamic(input: AgvDynamicBlockInput): BuiltAgvDynamic {
  const T = Math.max(0, Math.floor(input.time));
  const plan = input.solution.plan;
  const vehicles: BuiltAgvDynamic['snapshot']['vehicles'] = {};

  (plan?.vehicles ?? []).forEach((v, i) => {
    const tl = v.timeline ?? [];
    if (tl.length === 0) return;
    const k = Math.min(T, tl.length - 1);
    const pos = tl[k];
    vehicles[v.id] = {
      pos: [pos[0], pos[1]],
      phase: contractPhase(phaseAt(input.solution, i, T)),
      task: taskOfAt(input.solution, i, T),
      path: tl.slice(0, k + 1).map(([x, y]) => [x, y] as [number, number]),
    };
  });

  const tasks: BuiltAgvDynamic['snapshot']['tasks'] = {};
  for (const tk of plan?.tasks ?? []) {
    const o: Record<string, unknown> = { status: tk.status };
    if (tk.vehicle != null) o.assignee = tk.vehicle;
    if (tk.pickup_dock) o.pickup_dock = [tk.pickup_dock[0], tk.pickup_dock[1]];
    if (tk.dropoff_dock) o.dropoff_dock = [tk.dropoff_dock[0], tk.dropoff_dock[1]];
    if (tk.pickup_arrival != null) o.pickup_arrival = tk.pickup_arrival;
    if (tk.pickup_done != null) o.pickup_done = tk.pickup_done;
    if (tk.dropoff_arrival != null) o.dropoff_arrival = tk.dropoff_arrival;
    if (tk.dropoff_done != null) o.dropoff_done = tk.dropoff_done;
    tasks[tk.id] = o;
  }

  const events = input.events.map((e) => {
    switch (e.kind) {
      case 'task_add':
        return {
          type: 'task_add',
          task_def: {
            id: e.taskId,
            pickup: e.pickup,
            dropoff: e.dropoff,
            pickup_service: Math.max(0, Math.floor(e.pickupService)),
            dropoff_service: Math.max(0, Math.floor(e.dropoffService)),
            release_step: Math.max(0, Math.floor(e.releaseStep)),
            priority: Math.max(1, Math.floor(e.priority)),
            ...(e.dueStep != null ? { due_step: Math.max(0, Math.floor(e.dueStep)) } : {}),
            ...(e.requiredCapability ? { required_capability: e.requiredCapability } : {}),
          },
        };
      case 'task_cancel':
        return { type: 'task_cancel', task: e.task };
      case 'task_priority':
        return { type: 'task_priority', task: e.task, priority: Math.max(1, Math.floor(e.priority)) };
      case 'vehicle_pause':
        return { type: 'vehicle_pause', vehicle: e.vehicle };
      case 'vehicle_resume':
        return { type: 'vehicle_resume', vehicle: e.vehicle };
      case 'obstacle_add':
        return { type: 'obstacle_add', cell: [e.cell[0], e.cell[1]], ...(e.until != null ? { until: Math.max(0, Math.floor(e.until)) } : {}) };
      case 'obstacle_remove':
        return { type: 'obstacle_remove', cell: [e.cell[0], e.cell[1]] };
    }
  });

  return { snapshot: { time: T, vehicles, tasks }, events };
}

/** 提交前预检：镜像引擎已实现的拒绝语义。 */
export function precheckAgvDynamic(input: AgvDynamicBlockInput, built: BuiltAgvDynamic): AgvDynamicIssue[] {
  const issues: AgvDynamicIssue[] = [];
  const T = built.snapshot.time;
  const scene = input.scene;
  const plan = input.solution.plan;

  if (input.events.length === 0) {
    issues.push({ message: '还没有添加任何动态事件（至少添加一项再提交）' });
  }
  if (input.events.length > input.maxEvents) {
    issues.push({ message: `事件数 ${input.events.length} 超过档位上限 ${input.maxEvents}` });
  }

  // 1) 快照时刻必须被每辆车的时间线覆盖（path 需覆盖 0..=T）
  for (const v of plan?.vehicles ?? []) {
    const tl = v.timeline ?? [];
    if (tl.length === 0) continue;
    if (T >= tl.length) {
      issues.push({
        message: `车辆 ${v.id} 的时间线在 t=${tl.length - 1} 结束，快照时刻 T=${T} 超出其已执行范围（请把回放进度提前到 T≤${tl.length - 1}）`,
      });
    }
  }

  const taskById = new Map(scene.tasks.map((t) => [t.id, t]));
  const taskStatus = (id: string): string | null => {
    const s = (built.snapshot.tasks[id]?.status as string | undefined) ?? null;
    return s;
  };
  const seenIds = new Set<string>(taskById.keys());

  for (const [i, e] of input.events.entries()) {
    switch (e.kind) {
      case 'task_add': {
        if (!e.taskId.trim()) {
          issues.push({ message: `事件 #${i + 1}（新增任务）缺少任务 id`, eventIndex: i });
          break;
        }
        if (scene.vehicles.some((v) => v.id === e.taskId)) {
          issues.push({ message: `事件 #${i + 1}：任务 id \`${e.taskId}\` 与既有车辆冲突（E-EVENT-TARGET）`, eventIndex: i });
          break;
        }
        if (seenIds.has(e.taskId)) {
          issues.push({ message: `事件 #${i + 1}：任务 id \`${e.taskId}\` 与既有任务/本批新增冲突（E-EVENT-TARGET）`, eventIndex: i });
          break;
        }
        seenIds.add(e.taskId);
        const checkLoc = (label: string, loc: AgvTaskLoc) => {
          if (Array.isArray(loc)) {
            const [x, y] = loc;
            const row = scene.map.cells[y];
            if (!row || x < 0 || x >= row.length) {
              issues.push({ message: `事件 #${i + 1}：${label} (${x},${y}) 越界`, eventIndex: i });
            } else if (row[x] === '#' || row[x] === 'T' || row[x] === 'S') {
              issues.push({ message: `事件 #${i + 1}：${label} (${x},${y}) 在障碍格上`, eventIndex: i });
            }
          } else if (!scene.stations.some((s) => s.id === loc.station)) {
            issues.push({ message: `事件 #${i + 1}：${label} 引用了不存在的工作站 ${loc.station}`, eventIndex: i });
          }
        };
        checkLoc('取货点', e.pickup);
        checkLoc('送达点', e.dropoff);
        if (Array.isArray(e.pickup) && Array.isArray(e.dropoff) && e.pickup[0] === e.dropoff[0] && e.pickup[1] === e.dropoff[1]) {
          issues.push({ message: `事件 #${i + 1}：取货点与送达点相同（无运输量）`, eventIndex: i });
        }
        break;
      }
      case 'task_cancel': {
        const st = taskStatus(e.task);
        if (st === 'done' || st === 'picked') {
          issues.push({ message: `事件 #${i + 1}：任务 ${e.task} 状态为 \`${st}\`（已开始/完成，不可取消）（E-EVENT-TIME）`, eventIndex: i });
        }
        break;
      }
      case 'task_priority': {
        if (!taskById.has(e.task)) {
          issues.push({ message: `事件 #${i + 1}：任务 ${e.task} 不存在`, eventIndex: i });
        }
        if (e.priority < 1) {
          issues.push({ message: `事件 #${i + 1}：优先级必须 ≥ 1`, eventIndex: i });
        }
        break;
      }
      case 'vehicle_pause':
      case 'vehicle_resume': {
        if (!scene.vehicles.some((v) => v.id === e.vehicle)) {
          issues.push({ message: `事件 #${i + 1}：车辆 ${e.vehicle} 不存在`, eventIndex: i });
        }
        break;
      }
      case 'obstacle_add': {
        const [x, y] = e.cell;
        const row = scene.map.cells[y];
        if (!row || x < 0 || x >= row.length) {
          issues.push({ message: `事件 #${i + 1}：障碍格 (${x},${y}) 越界`, eventIndex: i });
          break;
        }
        if (row[x] === '#' || row[x] === 'T' || row[x] === 'S') {
          issues.push({ message: `事件 #${i + 1}：(${x},${y}) 已经是障碍`, eventIndex: i });
          break;
        }
        // 落在任一车已执行历史上（默认 at = T）→ 与历史矛盾
        for (const [vid, snap] of Object.entries(built.snapshot.vehicles)) {
          const path = snap.path;
          if (path[T] && path[T][0] === x && path[T][1] === y) {
            issues.push({
              message: `事件 #${i + 1}：(${x},${y}) 在 t=${T} 被车辆 ${vid} 占据（与已执行历史矛盾，请换格或把时刻后移）`,
              eventIndex: i,
            });
          }
        }
        if (e.until != null && e.until <= T) {
          issues.push({ message: `事件 #${i + 1}：until=${e.until} 必须晚于快照时刻 T=${T}`, eventIndex: i });
        }
        break;
      }
      case 'obstacle_remove': {
        const [x, y] = e.cell;
        const row = scene.map.cells[y];
        if (!row || x < 0 || x >= row.length) {
          issues.push({ message: `事件 #${i + 1}：障碍格 (${x},${y}) 越界`, eventIndex: i });
          break;
        }
        if (!(row[x] === '#' || row[x] === 'T' || row[x] === 'S')) {
          issues.push({ message: `事件 #${i + 1}：(${x},${y}) 当前不是障碍`, eventIndex: i });
        }
        break;
      }
    }
  }
  return issues;
}

/** 把 dynamic 块并入场景 JSON（导出即契约：引擎收到的是完整问题 + dynamic）。 */
export function withDynamicBlock(problemText: string, built: BuiltAgvDynamic): string {
  const doc = JSON.parse(problemText) as Record<string, unknown>;
  doc.dynamic = { snapshot: built.snapshot, events: built.events };
  return JSON.stringify(doc, null, 2);
}
