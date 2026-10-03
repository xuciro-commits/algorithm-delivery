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

  const addDep = (from: string, to: string, type: GanttDependency['type'] = 'FS') => {
    const key = `${from}->${to}:${type}`;
    if (!depKeys.has(key)) {
      depKeys.add(key);
      dependencies.push({
        id: `dep-${key}`,
        from,
        to,
        type,
      });
    }
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

  return { tasks, dependencies };
}
