import type { PlanProblemLike, PlanSolutionLike } from '../../core/types';
import type { GanttDependency, GanttTask } from './types';

export interface ApsGanttData {
  tasks: GanttTask[];
  dependencies: GanttDependency[];
}

/**
 * 把 APS 求解前后的问题模型 (PlanProblem) 与方案结果 (PlanSolution)
 * 适配为商业级甘特图所需的任务树 (tasks) 与依赖关系网 (dependencies)。
 */
export function adaptApsToGantt(
  problem: PlanProblemLike,
  solution: PlanSolutionLike | null,
): ApsGanttData {
  if (!solution || !solution.operations || solution.operations.length === 0) {
    return { tasks: [], dependencies: [] };
  }

  const tasks: GanttTask[] = [];
  const dependencies: GanttDependency[] = [];
  const depKeys = new Set<string>();

  const addDep = (
    from: string,
    to: string,
    type: GanttDependency['type'] = 'FS',
    opts?: { resource?: boolean },
  ) => {
    const key = `${from}->${to}:${type}`;
    if (!depKeys.has(key)) {
      depKeys.add(key);
      dependencies.push({
        id: `dep-${key}`,
        from,
        to,
        type,
        resource: opts?.resource,
      });
    }
  };

  /** 沿已有边从 start 出发能否到达 goal（用于拒绝会成环的资源边）。 */
  const reaches = (start: string, goal: string) => {
    const seen = new Set<string>([start]);
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop() as string;
      for (const dep of dependencies) {
        if (dep.from !== cur) continue;
        if (dep.to === goal) return true;
        if (!seen.has(dep.to)) {
          seen.add(dep.to);
          stack.push(dep.to);
        }
      }
    }
    return false;
  };

  const at = (iso: string | undefined | null) => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : NaN;
  };

  const solvedOps = solution.operations;
  const opMap = new Map<string, (typeof solvedOps)[0]>();
  for (const op of solvedOps) {
    opMap.set(op.operation_id, op);
  }

  for (const order of problem.orders ?? []) {
    const orderOps = (order.operations ?? []).map((o) => opMap.get(o.id)).filter(Boolean) as typeof solvedOps;
    if (orderOps.length === 0) continue;

    const startTimes = orderOps.map((o) => new Date(o.start_at).getTime()).filter(Number.isFinite);
    const endTimes = orderOps.map((o) => new Date(o.end_at).getTime()).filter(Number.isFinite);
    const minStart = startTimes.length ? Math.min(...startTimes) : new Date(order.release_at ?? Date.now()).getTime();
    const maxEnd = endTimes.length ? Math.max(...endTimes) : new Date(order.due_at ?? Date.now()).getTime();

    const orderStartIso = new Date(minStart).toISOString();
    const orderEndIso = new Date(maxEnd).toISOString();

    // 1) 订单父任务
    tasks.push({
      id: order.id,
      title: `${order.id} (优先级 P${order.priority ?? 1})`,
      start: orderStartIso,
      end: orderEndIso,
      progress: 100,
      status: 'completed',
      baseline: order.due_at
        ? {
            start: order.release_at ?? orderStartIso,
            end: order.due_at,
          }
        : undefined,
    });

    // 2) 订单下属工序子任务
    const orderOpList = order.operations ?? [];
    for (let i = 0; i < orderOpList.length; i++) {
      const opDef = orderOpList[i];
      const solved = opMap.get(opDef.id);
      if (!solved) continue;

      tasks.push({
        id: solved.operation_id,
        parentId: order.id,
        title: `${solved.operation_id} (${opDef.skill ?? '工序'})`,
        start: solved.start_at,
        end: solved.end_at,
        progress: 100,
        status: 'completed',
        assignee: {
          name: `${solved.machine_id} / ${solved.worker_id}`,
        },
      });

      // 3) 订单内工序的前后顺序约束（H01 紧前工序依赖：FS 类型）
      if (i > 0) {
        const prevOp = orderOpList[i - 1];
        if (opMap.has(prevOp.id)) {
          addDep(prevOp.id, solved.operation_id, 'FS');
        }
      }

      // 如果算例定义了显式紧前 precedence
      const precedence = (opDef as unknown as { precedence?: string[] }).precedence;
      if (Array.isArray(precedence)) {
        for (const predId of precedence) {
          if (opMap.has(predId)) {
            addDep(predId, solved.operation_id, 'FS');
          }
        }
      }
    }
  }

  // 4) 跨订单的**资源顺序边**：同一台设备在解法里的占用先后。
  //
  // 为什么需要：订单内边只能沿“工序清单顺序”回溯，订单之间零依赖时，关键路径会在
  // 第一个订单前断掉，图上只亮一个订单（真实反馈：「关键路径只标出第一个工单」）。
  // 同一台机器被前后两道工序占用，是排程解法本身给出的真实先后关系，补上它，关键路径
  // 才能像产能链一样穿过订单边界。
  //
  // 保守三条（宁可少报，不可滥报）：
  //   a. 只有“问题里的工序与解法里的工序完全对齐”才连边——部分解/被截断的解不连；
  //   b. 只连时间上确实首尾相接（prev.end <= cur.start）的相邻工序；
  //   c. 连边前做可达性检查，拒绝会造环的边（解法已定序，理论上不该出现）。
  const problemOpIds = new Set<string>();
  for (const order of problem.orders ?? []) {
    for (const op of order.operations ?? []) problemOpIds.add(op.id);
  }
  const complete =
    problemOpIds.size > 0 &&
    solvedOps.length >= problemOpIds.size &&
    Array.from(problemOpIds).every((id) => opMap.has(id));

  if (complete) {
    const byMachine = new Map<string, typeof solvedOps>();
    for (const op of solvedOps) {
      if (!op.machine_id) continue;
      const list = byMachine.get(op.machine_id);
      if (list) list.push(op);
      else byMachine.set(op.machine_id, [op]);
    }
    for (const list of byMachine.values()) {
      const seq = [...list].sort((a, b) => {
        const d = at(a.start_at) - at(b.start_at);
        if (Number.isFinite(d) && d !== 0) return d;
        const e = at(a.end_at) - at(b.end_at);
        if (Number.isFinite(e) && e !== 0) return e;
        return a.operation_id.localeCompare(b.operation_id);
      });
      for (let i = 1; i < seq.length; i++) {
        const prev = seq[i - 1];
        const cur = seq[i];
        const prevEnd = at(prev.end_at);
        const curStart = at(cur.start_at);
        if (!Number.isFinite(prevEnd) || !Number.isFinite(curStart) || prevEnd > curStart) continue;
        if (reaches(cur.operation_id, prev.operation_id)) continue;
        addDep(prev.operation_id, cur.operation_id, 'FS', { resource: true });
      }
    }
  }

  return { tasks, dependencies };
}
