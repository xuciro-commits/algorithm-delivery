import type { GanttTask } from "./types";

/**
 * 字段访问器（Accessor 模式，TanStack 风格）：
 * 业务数据字段名随意（order_no / planned_start / completion_rate…），
 * 只需提供一组取值函数即可被甘特图直接消费，组件内部统一归一化为 GanttTask。
 */
export interface GanttAccessors<T> {
  getTaskId: (d: T) => string;
  getTitle?: (d: T) => string;
  getStartTime: (d: T) => string;
  getEndTime: (d: T) => string;
  getProgress?: (d: T) => number | undefined;
  getStatus?: (d: T) => GanttTask["status"];
  getParentId?: (d: T) => string | undefined;
  getAssignee?: (d: T) => GanttTask["assignee"];
  getMilestone?: (d: T) => boolean | undefined;
  getBaseline?: (d: T) => GanttTask["baseline"];
}

/** 原生 GanttTask 的默认访问器（直接使用 tasks= 时无需传入） */
export const defaultGanttAccessors: GanttAccessors<GanttTask> = {
  getTaskId: (t) => t.id,
  getTitle: (t) => t.title,
  getStartTime: (t) => t.start,
  getEndTime: (t) => t.end,
  getProgress: (t) => t.progress,
  getStatus: (t) => t.status,
  getParentId: (t) => t.parentId,
  getAssignee: (t) => t.assignee,
  getMilestone: (t) => t.isMilestone,
  getBaseline: (t) => t.baseline,
};

/** 将任意业务行数据归一化为 GanttTask（无效时间戳行被过滤，绝不崩溃） */
export function normalizeTasks<T>(data: readonly T[], a: GanttAccessors<T>): GanttTask[] {
  const out: GanttTask[] = [];
  for (const d of data) {
    const id = a.getTaskId(d);
    const start = a.getStartTime(d);
    const end = a.getEndTime(d);
    if (!id) continue;
    if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) continue;
    out.push({
      id,
      title: a.getTitle?.(d) ?? id,
      start,
      end,
      progress: a.getProgress?.(d),
      status: a.getStatus?.(d),
      parentId: a.getParentId?.(d),
      assignee: a.getAssignee?.(d),
      isMilestone: a.getMilestone?.(d),
      baseline: a.getBaseline?.(d),
    });
  }
  return out;
}
